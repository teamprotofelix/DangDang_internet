// ============================================================
// content.js — 웹페이지 플로팅 AI + 페이지 콘텐츠 추출
// Shadow DOM으로 스타일 완전 격리
// ============================================================

class FloatingAvatarController {
  constructor() {
    this.destroyed = false;
    this.lifecycle = new AbortController();
    this.timers = new Set();
    this.intervals = new Set();
    this.pendingFrames = new Set();
    this.behavior = 'idle';
    this.movementGeneration = 0;
    this.actionGeneration = 0;
    this.approachLastTime = null;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.host = null;
    this.shadow = null;
    this.wrapper = null;
    this.avatarTarget = null;
    this.bubble = null;
    this.tooltip = null;
    this.bubbleTimer = null;

    this.isDragging = false;
    this.isPointerDown = false;
    this.dragMoved = false;
    this.dragStart = { x: 0, y: 0 };
    this.position = { x: 20, y: 20 }; // 우측 하단 기준 오프셋
    this.currentMood = 'default';
    this.focusMode=false;this.movementLevel='normal';this.reactionGate=new CompanionPolicy.ReactionGate();
    this.bubbleVisible = false;
    this.moodAnimTimer = null;
    this.clickTimer = null;
    // 배포 기본값은 전부 OFF — 설정 메시지가 도착하면 그 값으로 갱신 (config.js와 동일)
    this.floatingAvatarEnabled = false;
    this.speechBubblesEnabled = false;
    this.contentAwarenessEnabled = false; // 웹 인식 ON/OFF — OFF면 수집·전송 안 함 (P0-1)
    this.wanderIntervalMin = 60;
    this.wanderIntervalMax = 180;
    this.lastUserActivity = 0;
    this.theme = 'auto';

    // 다가가기 애니메이션 상태
    this.approachCommandToken = null;
    this.approachTarget = null;       // { x, y } — 다가갈 목표 위치
    this.approachAnimId = null;       // requestAnimationFrame ID
    this.isApproaching = false;       // 애니메이션 진행 중 여부
    this.approachEnabled = false;     // 설정에서 로드 (기본값 OFF)
    this.approachOnComplete = null;   // 다가가기 완료 콜백

    // 혼자 구경하기(방랑) 상태
    this.wanderEnabled = false;       // 설정에서 로드 (기본값 OFF)
    this.wanderTimer = null;          // 다음 방랑 타이머
    this.wanderBusy = false;          // 방랑+모놀로그 진행 중

    // 초기화
    this.init();
  }

  async init() {
    await this.loadPosition();
    if (this.destroyed) return;
    await this.loadFeatureSettings();
    if (this.destroyed) return;
    this.createShadowDOM();
    this.animationView = new CompanionAnimation.View(this.avatarTarget, {visible:this.floatingAvatarEnabled});
    this.behaviorController=new CompanionBehavior.Controller(this.animationView,{
      visible:this.floatingAvatarEnabled,
      onReaction:packet=>this.showBubble(packet),
      onCancelMove:()=>{this.cancelApproach();this.cancelWander();this.avatarTarget?.classList.remove('ha-attention');},
      onCommandStart:command=>this.startPlayCommand(command),
      onCommandEnd:()=>{this.playBall?.destroy();this.playBall=null;this.cancelApproach();this.hideBubble(false);},
      onState:state=>{
        this.playControls?.update(state);
        const commandToken=state.command?.token??null;
        if(commandToken!==this.lastCommandToken){this.lastCommandToken=commandToken;this.announcePlay(state.command?CompanionBehavior.COMMANDS[state.command.name].label+' 동작 중':state.kind==='paused'?'잠깐 쉬고 있어요.':'동작을 마쳤어요.');}
        if(state.command||state.kind==='paused'||state.kind==='dragging')this.closePlayMenu();
        const previous=this.lastCompanionKind;this.lastCompanionKind=state.kind;
        if(['busy','pet','command'].includes(previous)&&!['busy','pet','command'].includes(state.kind)){this.scheduleWander();this.scheduleRandomPop();}
      }
    });
    this.behaviorController.configure({movementLevel:this.movementLevel,focusMode:this.focusMode});
    if(typeof PlayMemoryClient!=='undefined')this.playMemoryClient=new PlayMemoryClient.Client({controller:this.behaviorController,settings:()=>this,controls:this.playControls,reaction:p=>this.showBubble(p),clear:()=>this.hideBubble(false)});
    this.listen(document, 'visibilitychange', () => this.syncActivity());
    this.listen(this.reducedMotion, 'change', () => this.syncActivity());
    this.listen(window, 'resize', () => { this.behaviorController?.cancelCommand('resize');this.closePlayMenu();this.clampPosition();this.placeBubble(); });
    if(window.visualViewport){this.listen(window.visualViewport,'resize',()=>{this.behaviorController?.cancelCommand('viewport');this.closePlayMenu();this.placeBubble();});this.listen(window.visualViewport,'scroll',()=>{this.behaviorController?.cancelCommand('viewport');this.closePlayMenu();this.placeBubble();});}
    this.listen(window, 'pagehide', e => {
      if (e.persisted) this.syncActivity(true); else this.destroy();
    });
    this.listen(window, 'pageshow', () => this.syncActivity());
    this.applyVisibility();
    this.clampPosition();
    this.setupDragHandling();
    this.setupMessageListener();
    this.sendPageContent();

    // SPA 페이지 변경 감지
    this.observePageChanges();

    // 랜덤 관심 끌기 — 5~15분 간격으로 심심할 때 꼬물거림
    this.scheduleRandomPop();

    // 설정 로드 후 기능 활성화
    await this.loadSettingsAndStart();
    this.syncActivity();
    await this.playMemoryClient?.ready();

    console.log('[반려AI] 🎀 플로팅 AI 생성됨');
  }

  // ============================================================
  // Shadow DOM 생성
  // ============================================================

  createShadowDOM() {
    // 호스트 엘리먼트
    this.host = document.createElement('div');
    this.host.id = 'haru-avatar-host';
    document.body.appendChild(this.host);

    // Shadow Root
    this.shadow = this.host.attachShadow({ mode: 'open' });

    // 스타일 주입
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = chrome.runtime.getURL('content.css');
    this.shadow.appendChild(styleLink);

    // 래퍼
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'ha-wrapper';
    this.updateWrapperPosition();
    this.shadow.appendChild(this.wrapper);

    // 툴팁
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'ha-tooltip';
    this.tooltip.textContent = '클릭: 대화 열기 · 더블클릭: 말 걸기';
    this.wrapper.appendChild(this.tooltip);

    // Stable input target: the renderer owns the only visual child (one Canvas).
    this.avatarTarget = document.createElement('div');
    this.avatarTarget.className = 'ha-avatar companion-viewport';
    this.avatarTarget.setAttribute('role','button');
    this.avatarTarget.setAttribute('aria-label','댕댕이. 클릭하면 대화 열기, 더블클릭하면 말 걸기');
    this.listen(this.avatarTarget, 'click', e => this.onAvatarClick(e));
    this.listen(this.avatarTarget, 'dblclick', e => this.onAvatarDoubleClick(e));
    this.wrapper.appendChild(this.avatarTarget);
    this.petBtn=document.createElement('button');this.petBtn.type='button';this.petBtn.className='ha-pet';
    this.petBtn.textContent='🐾';this.petBtn.title='쓰다듬기 · 3초에 한 번';this.petBtn.setAttribute('aria-label','댕댕이 쓰다듬기');
    this.listen(this.petBtn,'click',event=>{event.stopPropagation();if(!this.dragMoved||event.detail===0)this.behaviorController?.pet();});
    this.listen(this.petBtn,'mousedown',event=>{event.stopPropagation();this.dragMoved=false;});
    this.listen(this.petBtn,'touchstart',event=>{event.stopPropagation();this.dragMoved=false;},{passive:true});
    this.listen(this.petBtn,'dblclick',event=>event.stopPropagation());this.wrapper.appendChild(this.petBtn);
    this.playToggle=document.createElement('button');this.playToggle.type='button';this.playToggle.className='ha-play-toggle';this.playToggle.textContent='⋯';this.playToggle.setAttribute('aria-label','교감과 재롱 메뉴');this.playToggle.setAttribute('aria-expanded','false');this.playToggle.setAttribute('aria-controls','companion-play-menu');
    const row=document.createElement('div');row.className='ha-interact-actions';row.append(this.petBtn,this.playToggle);this.wrapper.appendChild(row);
    this.playControls=CompanionControls.create(name=>this.behaviorController?.perform(name));
    this.playMenu=document.createElement('div');this.playMenu.id='companion-play-menu';this.playMenu.className='ha-play-menu';this.playMenu.hidden=true;this.playMenu.appendChild(this.playControls.element);this.shadow.appendChild(this.playMenu);
    this.playAnnounce=document.createElement('span');this.playAnnounce.className='ha-command-announce';this.playAnnounce.setAttribute('role','status');this.playAnnounce.setAttribute('aria-live','polite');this.shadow.appendChild(this.playAnnounce);
    this.listen(this.playToggle,'click',e=>{e.stopPropagation();this.togglePlayMenu();if(e.detail===0&&!this.playMenu.hidden)this.playMenu.querySelector('button:not(:disabled)')?.focus();});
    this.listen(document,'pointerdown',e=>{if(e.target!==this.host)this.closePlayMenu();},{capture:true});
    for(const type of ['mousedown','touchstart','dblclick'])this.listen(this.playToggle,type,e=>e.stopPropagation());
    this.listen(this.playMenu,'keydown',e=>{if(e.key==='Escape'){e.stopPropagation();this.closePlayMenu();this.playToggle.focus();}});

    // 숨기기 버튼
    this.hideBtn = document.createElement('button');
    this.hideBtn.className = 'ha-hide';
    this.hideBtn.type = 'button';
    this.hideBtn.setAttribute('aria-label', '플로팅 아바타 숨기기');
    this.hideBtn.title = '아바타 숨기기 (설정에서 다시 켤 수 있어요)';
    this.hideBtn.textContent = '✕';
    this.listen(this.hideBtn, 'click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.hideSelf();
    });
    this.wrapper.appendChild(this.hideBtn);
  }

  updateWrapperPosition() {
    if (!this.wrapper) return;
    this.wrapper.style.right = `${this.position.x}px`;
    this.wrapper.style.bottom = `${this.position.y}px`;
  }

  announcePlay(text){this.playControls?.announce(text);if(this.playAnnounce)this.playAnnounce.textContent=text;if(this.playToggle)this.playToggle.title=text;}
  closePlayMenu(){if(this.playMenu)this.playMenu.hidden=true;this.playToggle?.setAttribute('aria-expanded','false');}
  togglePlayMenu(){
    if(!this.playMenu)return;if(!this.playMenu.hidden){this.closePlayMenu();return;}
    this.hideBubble(false);this.playMenu.hidden=false;
    const v=window.visualViewport,position=CompanionPolicy.chooseBubble(this.wrapper.getBoundingClientRect(),this.playMenu.getBoundingClientRect(),{left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight},8);
    if(!position){this.closePlayMenu();this.playToggle.setAttribute('aria-label','교감 메뉴: 창을 조금 넓혀 주세요');this.announcePlay('창을 조금 넓혀 주세요.');return;}
    this.playMenu.style.left=position.x+'px';this.playMenu.style.top=position.y+'px';this.playToggle.setAttribute('aria-label','교감과 재롱 메뉴');this.playToggle.setAttribute('aria-expanded','true');
  }
  commandObstacles(){
    const elements=document.querySelectorAll('input,textarea,select,button,[contenteditable],iframe,[role="textbox"]');
    if(elements.length>512)return [{left:0,top:0,right:innerWidth,bottom:innerHeight}];
    return [...elements].map(e=>e.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0);
  }
  startPlayCommand({name,token,reduced,level}){
    this.closePlayMenu();if(name!=='come'&&name!=='play')return;
    const v=window.visualViewport,left=v?.offsetLeft||0,top=v?.offsetTop||0;
    const viewport={left,top,right:left+(v?.width||innerWidth),bottom:top+(v?.height||innerHeight)};
    const plan=CompanionControls.plan(this.wrapper.getBoundingClientRect(),viewport,name,level,this.commandObstacles());
    if(!plan){this.announcePlay('공간이 작아서 제자리에서 반응해요.');this.behaviorController.commandLater(token,()=>this.behaviorController.finishCommand(token),reduced?1200:1900);return;}
    const current=()=>this.behaviorController.activeCommand?.token===token;
    const move=after=>{
      if(!current()||!this.canMove(true))return;
      this.approachTarget={x:innerWidth-plan.target.right,y:innerHeight-plan.target.bottom};
      this.approachOnComplete=()=>{if(current())after();};this.behaviorController.commandPhase(token,'moving');this.beginApproach({commandToken:token});
    };
    if(name==='come'){
      if(reduced){this.announcePlay('제자리에서 반갑게 인사해요.');return;}
      this.announcePlay('화면 안 안전한 곳으로 다가가요.');move(()=>this.behaviorController.finishCommand(token));return;
    }
    this.playBall=new CompanionControls.Ball(this.shadow,{fixed:true,size:18,onError:()=>this.behaviorController.failCommand(token)});
    this.playBall.roll(plan.ball.start,reduced?plan.ball.start:plan.ball.end,{motion:!reduced,duration:{calm:900,normal:700,lively:500}[level],done:()=>{
      if(!current())return;move(()=>{this.behaviorController.commandPhase(token,'pose');this.behaviorController.commandLater(token,()=>this.behaviorController.finishCommand(token),1900);});
    }});
  }

  // ============================================================
  // 드래그 핸들링
  // ============================================================

  setupDragHandling() {
    this.listen(this.avatarTarget, 'mousedown', (e) => {
      if (e.button !== 0) return; // 좌클릭만
      this.isPointerDown = true;
      this.dragMoved = false;
      this.dragStart.x = e.clientX;
      this.dragStart.y = e.clientY;
      e.preventDefault();
    });

    this.listen(document, 'mousemove', (e) => {
      if (!this.isPointerDown) return;
      const moved = Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y);
      if (!this.isDragging && moved > 5) {
        this.isDragging = true;
        this.dragMoved = true;
        this.cancelApproach();
        this.cancelWander();
        this.setBehavior('dragging');
        this.clearTimer(this.clickTimer);
      }
      if (!this.isDragging) return;

      const dx = this.dragStart.x - e.clientX;
      const dy = e.clientY - this.dragStart.y;

      this.position.x += dx;
      this.position.y -= dy;
      this.clampPosition();

      this.dragStart.x = e.clientX;
      this.dragStart.y = e.clientY;
    });

    this.listen(document, 'mouseup', () => {
      if (this.isDragging) {
        chrome.runtime.sendMessage({
          type: MSG_AVATAR_DRAGGED,
          data: { x: this.position.x, y: this.position.y }
        }).catch(() => {});
      }
      if (!this.isPointerDown) return;
      this.isDragging = false;
      this.isPointerDown = false;
      this.setBehavior(this.isApproaching ? 'walk' : 'idle');
      this.scheduleWander();
    });

    // 터치 지원
    this.listen(this.avatarTarget, 'touchstart', (e) => {
      if (e.touches.length !== 1) return;
      this.isPointerDown = true;
      this.dragMoved = false;
      this.dragStart.x = e.touches[0].clientX;
      this.dragStart.y = e.touches[0].clientY;
      e.preventDefault();
    }, { passive: false });

    this.listen(document, 'touchmove', (e) => {
      if (!this.isPointerDown || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const moved = Math.hypot(touch.clientX - this.dragStart.x, touch.clientY - this.dragStart.y);
      if (!this.isDragging && moved > 5) {
        this.isDragging = true;
        this.dragMoved = true;
        this.cancelApproach();
        this.cancelWander();
        this.setBehavior('dragging');
        this.clearTimer(this.clickTimer);
      }
      if (!this.isDragging) return;

      const dx = this.dragStart.x - touch.clientX;
      const dy = touch.clientY - this.dragStart.y;

      this.position.x += dx;
      this.position.y -= dy;
      this.clampPosition();

      this.dragStart.x = touch.clientX;
      this.dragStart.y = touch.clientY;
    }, { passive: false });

    this.listen(document, 'touchend', () => {
      if (this.isDragging) {
        chrome.runtime.sendMessage({
          type: MSG_AVATAR_DRAGGED,
          data: { x: this.position.x, y: this.position.y }
        }).catch(() => {});
      }
      if (!this.isPointerDown) return;
      this.isDragging = false;
      this.isPointerDown = false;
      this.setBehavior(this.isApproaching ? 'walk' : 'idle');
      this.scheduleWander();
    });
  }

  // ============================================================
  // 설정 로드 & 기능 시작
  // ============================================================

  async loadSettingsAndStart() {
    await this.loadFeatureSettings();

    if (this.destroyed) return;
    // 기능 시작
    this.setupApproachListener();
    this.applyTheme(this.theme);
    this.listen(document, 'mousedown', () => {
      this.lastUserActivity = Date.now();
    }, { capture: true });
    this.listen(window, 'resize', () => this.placeBubble());
    if (window.matchMedia) {
      this.listen(window.matchMedia('(prefers-color-scheme: dark)'), 'change', () => {
        if (this.theme === 'auto') this.applyTheme('auto');
      });
    }
    if (this.wanderEnabled && this.floatingAvatarEnabled) this.scheduleWander();
  }

  /**
   * 비민감 설정 적용 (P0 리뷰: storage.local은 신뢰 컨텍스트 전용 —
   * 콘텐츠 스크립트는 메시지로 전달받은 설정만 사용)
   */
  applySettingsMap(s) {
    if (!s) return;
    const companionSettings=CompanionPolicy.settings({...this,...s});
    this.movementLevel=companionSettings.movementLevel;this.focusMode=companionSettings.focusMode;
    this.behaviorController?.configure(companionSettings);
    if(this.focusMode){this.cancelWander();if(!this.behaviorController?.activeCommand)this.cancelApproach();this.hideBubble(false);this.clearTimer(this.randomPopTimer);this.randomPopTimer=null;}

    if (typeof s.contentAwarenessEnabled === 'boolean') {
      const was = this.contentAwarenessEnabled;
      this.contentAwarenessEnabled = s.contentAwarenessEnabled;
      // OFF → ON 전환 시 현재 페이지 1회 전송 (배경이 갱신하도록)
      if (!was && this.contentAwarenessEnabled) {
        this.sendPageContent();
      }
    }
    if (typeof s.approachEnabled === 'boolean') {
      this.approachEnabled = s.approachEnabled;
      if (!this.approachEnabled && !this.wanderBusy) this.cancelApproach();
    }
    if (typeof s.wanderEnabled === 'boolean') {
      this.wanderEnabled = s.wanderEnabled;
      if (this.wanderEnabled && this.floatingAvatarEnabled) this.scheduleWander();
      else { this.cancelWander(); this.cancelApproach(); }
    }
    if (typeof s.speechBubblesEnabled === 'boolean') {
      this.speechBubblesEnabled = s.speechBubblesEnabled;
      if (!this.speechBubblesEnabled) this.hideBubble(false);
    }
    if (typeof s.floatingAvatarEnabled === 'boolean') {
      this.setVisible(s.floatingAvatarEnabled);
    }
    if (typeof s.wanderIntervalMin === 'number') this.wanderIntervalMin = s.wanderIntervalMin;
    if (typeof s.wanderIntervalMax === 'number') this.wanderIntervalMax = s.wanderIntervalMax;
    if (s.theme) this.applyTheme(s.theme);
    if(typeof s.proactiveEnabled==='boolean')this.proactiveEnabled=s.proactiveEnabled;
    this.playMemoryClient?.updatePolicy();
  }

  applyTheme(theme) {
    this.theme = theme || 'auto';
    const dark = this.theme === 'dark' || (
      this.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    );
    if (this.wrapper) this.wrapper.classList.toggle('ha-theme-dark', dark);
  }

  applyVisibility() {
    if (this.host) {
      this.host.style.display = this.floatingAvatarEnabled ? '' : 'none';
    }
  }

  setVisible(visible) {
    this.visibilityGeneration = (this.visibilityGeneration || 0) + 1;
    this.floatingAvatarEnabled = !!visible;
    this.applyVisibility();
    if (!this.floatingAvatarEnabled) {
      this.cancelWander();
      this.cancelApproach();
      this.hideBubble(false);
    }
    this.syncActivity();
  }

  hideSelf() {
    this.behaviorController?.cancelCommand('hide');this.closePlayMenu();
    const generation = this.visibilityGeneration;
    this.showBubble(CompanionPolicy.reaction('greeting','hide-'+Date.now()));
    this.later(() => {
      if (generation !== this.visibilityGeneration) return;
      this.setVisible(false);
      chrome.runtime.sendMessage({
        type: MSG_UPDATE_SETTINGS,
        data: { floatingAvatarEnabled: false }
      }).catch(() => {});
    }, 1400);
  }

  async loadFeatureSettings() {
    try {
      // P0 리뷰: storage.local은 신뢰 컨텍스트 전용 — 배경에 비민감 설정을 요청
      const response = await chrome.runtime.sendMessage({ type: MSG_GET_SETTINGS });
      const s = response?.data?.settings;
      if (s) {
        this.theme = s.theme || this.theme;
        this.applySettingsMap(s);
      }
    } catch (_) {
      // 기본값 유지 (true)
    }
  }

  // ============================================================
  // 다가가기 — 사용자가 페이지를 클릭하면 아바타가 천천히 다가감
  // ============================================================

  setupApproachListener() {
    // mousedown — capture phase로 어떤 요소든 감지
    this.listen(document, 'mousedown', (e) => {
      if (!this.floatingAvatarEnabled) return;
      if (!this.approachEnabled) return;
      // Explicit user targets supersede automatic wandering.
      if (e.button !== 0) return;
      try {
        if (e.target === this.host) return;
        if (e.target instanceof Element &&
            e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      } catch (_) { /* 계속 진행 */ }

      this.startApproach(e.clientX, e.clientY);
    }, { capture: true });

    // 드래그 중 목표 실시간 업데이트
    this.listen(document, 'mousemove', (e) => {
      if (!this.floatingAvatarEnabled) return;
      if (!this.approachEnabled) return;

      if (e.buttons !== 1) return;
      if (this.isDragging) return;
      try {
        if (this.host && e.target instanceof Node && this.host.contains(e.target)) return;
        if (e.target instanceof Element &&
            e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      } catch (_) { /* 무시 */ }

      this.startApproach(e.clientX, e.clientY);
    }, { capture: true });
  }

  canMove(explicit=false) {
    return !this.destroyed && this.floatingAvatarEnabled && !document.hidden && !this.reducedMotion.matches && (explicit?!!this.behaviorController?.activeCommand:!this.focusMode&&!['pet','busy','command'].includes(this.behaviorController?.state?.kind));
  }

  setBehavior(behavior) {
    this.behavior = behavior;
    if(['walk','dragging','paused'].includes(behavior))this.hideBubble(false);
    if(this.behaviorController)this.behaviorController.setBehavior(behavior);else this.animationView?.update(this.currentMood, behavior);
  }

  clampPosition() {
    const maxX = Math.max(0, window.innerWidth - 70);
    const maxY = Math.max(0, window.innerHeight - 110);
    const clamp = p => ({x: Math.max(0, Math.min(maxX, Number.isFinite(p.x) ? p.x : 20)),
      y: Math.max(0, Math.min(maxY, Number.isFinite(p.y) ? p.y : 20))});
    this.position = clamp(this.position);
    if (this.approachTarget) this.approachTarget = clamp(this.approachTarget);
    this.updateWrapperPosition();
  }

  startApproach(clientX, clientY) {
    if (this.isDragging || !this.canMove()) return;
    this.cancelWander();
    this.cancelApproach();
    const dirX = clientX < window.innerWidth / 2 ? 1 : -1;
    const dirY = clientY < window.innerHeight / 2 ? 1 : -1;
    this.approachTarget = {x: window.innerWidth-clientX + dirX*(60+Math.random()*40),
      y: window.innerHeight-clientY + dirY*(60+Math.random()*40)};
    this.clampPosition();
    this.beginApproach();
  }

  beginApproach({commandToken=null}={}) {
    this.approachCommandToken=commandToken;
    this.isApproaching = true;
    this.approachLastTime = null;
    this.setBehavior('walk');
    this.animationView?.player.setRate(1); // 90 CSS px/s at the reviewed 840 ms stride cycle.
    const generation = this.movementGeneration;
    if(this.approachTarget&&Math.hypot(this.approachTarget.x-this.position.x,this.approachTarget.y-this.position.y)<.5){const cb=this.approachOnComplete;this._finishApproach();if(cb)cb();return;}
    this.approachAnimId = requestAnimationFrame(t => this.animateApproach(t, generation));
  }

  animateApproach(timestamp, generation = this.movementGeneration) {
    if (generation !== this.movementGeneration || this.destroyed) return;
    this.approachAnimId = null;
    if (!this.approachTarget || this.isDragging || !this.canMove(this.approachCommandToken!==null) || (this.approachCommandToken!==null&&this.behaviorController?.activeCommand?.token!==this.approachCommandToken)) {
      this.cancelApproach(); return;
    }
    const delta = this.approachLastTime === null ? 0 : timestamp - this.approachLastTime;
    this.approachLastTime = timestamp;
    const facing = this.approachTarget.x > this.position.x ? 'left' : 'right';
    this.animationView?.player.setFacing(facing);
    const next = CompanionAnimation.advancePosition(this.position, this.approachTarget, delta);
    this.position = {x:next.x, y:next.y};
    this.updateWrapperPosition();
    if (next.done) {
      const cb = this.approachOnComplete,commandToken=this.approachCommandToken;
      this._finishApproach();
      if (cb && !this.isDragging && this.canMove(commandToken!==null)&&(commandToken===null||this.behaviorController?.activeCommand?.token===commandToken)) cb();
      else this.scheduleWander();
      return;
    }
    this.approachAnimId = requestAnimationFrame(t => this.animateApproach(t, generation));
  }

  _finishApproach() {
    this.movementGeneration++;
    if (this.approachAnimId !== null) cancelAnimationFrame(this.approachAnimId);
    this.approachAnimId = null;
    this.approachLastTime = null;
    this.isApproaching = false;
    this.approachTarget = null;
    this.approachCommandToken = null;
    this.approachOnComplete = null;
    this.clearTimer(this.wanderSafetyTimer);
    this.setBehavior('idle');
  }

  cancelApproach() { this._finishApproach(); }

  syncActivity(forceHidden = false) {
    if (this.destroyed) return;
    const active = this.floatingAvatarEnabled && !document.hidden && !forceHidden;
    if(this.behaviorController)this.behaviorController.setVisible(active);else this.animationView?.setVisible(active);
    if (!active || this.reducedMotion.matches || this.focusMode) {
      this.cancelWander(); if(!active||this.reducedMotion.matches||!this.behaviorController?.activeCommand)this.cancelApproach();
      this.clearTimer(this.randomPopTimer); this.randomPopTimer = null;
      this.clearTimer(this.clickTimer); this.clickTimer = null;
      this.isDragging = this.isPointerDown = false;
      this.hideBubble(false);
      if(!active||this.reducedMotion.matches||!this.behaviorController?.activeCommand)this.setBehavior(active ? 'idle' : 'paused');
    } else {
      if (this.behavior === 'paused') this.setBehavior('idle');
      this.scheduleWander(); this.scheduleRandomPop();
    }
  }

  listen(target, type, callback, options = {}) {
    target.addEventListener(type, callback, {...options, signal:this.lifecycle.signal});
  }
  later(callback, delay) {
    const id = setTimeout(() => { this.timers.delete(id); if (!this.destroyed) callback(); }, delay);
    this.timers.add(id); return id;
  }
  clearTimer(id) { clearTimeout(id); this.timers.delete(id); }
  onceFrame(callback) {
    const id = requestAnimationFrame(() => { this.pendingFrames.delete(id); if (!this.destroyed) callback(); });
    this.pendingFrames.add(id); return id;
  }
  every(callback, delay) {
    const id = setInterval(callback, delay); this.intervals.add(id); return id;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.cancelWander(); this.cancelApproach();
    this.playMemoryClient?.destroy();this.behaviorController?.destroy();this.playControls?.destroy();this.closePlayMenu();this.animationView?.destroy(); this.lifecycle.abort();
    this.timers.forEach(clearTimeout); this.intervals.forEach(clearInterval);
    this.pendingFrames.forEach(cancelAnimationFrame); this.pendingFrames.clear();
    this.timers.clear(); this.intervals.clear();
    this.pageObserver?.disconnect();
    if (this.messageListener) chrome.runtime.onMessage.removeListener(this.messageListener);
    this.host?.remove();
  }

  // ============================================================
  // 혼자 구경하기 (Wander) — 아바타가 스스로 웹페이지를 돌아다님
  // ============================================================

  /**
   * 다음 방랑 일정 예약
   */
  scheduleWander() {
    if (this.wanderTimer) this.clearTimer(this.wanderTimer);
    if (!this.wanderEnabled || !this.canMove() || this.isDragging || this.wanderBusy || this.isApproaching) return;

    let min = this.wanderIntervalMin || CONFIG.wander?.minIntervalSec || 60;
    let max = this.wanderIntervalMax || CONFIG.wander?.maxIntervalSec || 180;
    if (max <= min) max = min + 60;

    // 텍스트가 거의 없는 페이지는 더 조용히
    const bodyLen = (document.body?.innerText || '').trim().length;
    if (bodyLen < 500) {
      min = Math.round(min * 1.8);
      max = Math.round(max * 1.8);
    }
    // 사용자가 방금 클릭 중이면 조금 더 기다림
    if (Date.now() - this.lastUserActivity < 25000) {
      min += 40;
      max += 50;
    }

    const delay = randomInt(min, max) * 1000 * CompanionPolicy.LEVELS[this.movementLevel].wanderFactor;
    this.wanderTimer = this.later(() => this.wanderStep(), delay);
  }

  cancelWander() {
    if (this.wanderTimer) {
      this.clearTimer(this.wanderTimer);
      this.wanderTimer = null;
    }
    this.wanderBusy = false;
    this.behaviorController?.cancelAutomatic();
    this.actionGeneration++;
    this.clearTimer(this.wanderSafetyTimer);
  }

  /**
   * 한 번의 방랑 스텝: 랜덤 위치로 이동 → 도착 → 주변 탐색 → 혼잣말
   */
  async wanderStep() {
    if (!this.wanderEnabled || !this.canMove() || this.isDragging || this.wanderBusy) {
      // 숨겨진(비활성) 탭에서는 방랑하지 않음 (P1-3)
      this.scheduleWander();
      return;
    }

    this.wanderBusy = true;

    // 랜덤 목표 위치 (화면 가장자리에서 50px 이상 떨어지게)
    const targetX = randomInt(50, window.innerWidth - 100);
    const targetY = randomInt(80, window.innerHeight - 150);

    // right/bottom 좌표계로 변환 (아바타 크기 50px 정도 고려)
    const rightX = window.innerWidth - targetX - 25;
    const bottomY = window.innerHeight - targetY - 25;

    this.approachTarget = {
      x: Math.max(5, Math.min(window.innerWidth - 60, rightX)),
      y: Math.max(5, Math.min(window.innerHeight - 60, bottomY))
    };

    // 이동 완료 후 혼잣말 콜백
    this.approachOnComplete = () => this.lookAndComment(targetX, targetY);

    const begin=()=>{
      if(!this.wanderBusy||!this.wanderEnabled||!this.canMove())return;
      this.clampPosition();this.beginApproach();const generation=this.movementGeneration;
      this.wanderSafetyTimer=this.later(()=>{if(generation!==this.movementGeneration)return;this.cancelApproach();this._wanderDone();},15000);
    };
    if(!this.behaviorController?.lookThenWalk(begin))begin();
  }

  /**
   * 현재 위치 주변의 웹 콘텐츠를 "읽고" LLM에게 혼잣말 요청
   */
  async lookAndComment(clientX, clientY) {
    const generation = this.actionGeneration;
    if (!this.wanderEnabled || !this.canMove() || this.isDragging || !this.contentAwarenessEnabled) {
      // P0-1: 웹 인식 OFF면 주변 텍스트를 모으지 않음 (배경도 재차 차단)
      this._wanderDone();
      return;
    }

    try {
      // 현재 위치 근처의 DOM 요소 찾기
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) { this._wanderDone(); return; }

      // 주변 텍스트 수집 (최대 300자)
      let nearbyText = '';
      const parent = el.closest('p, div, section, article, li, td, h1, h2, h3, h4, h5, h6') || el;
      nearbyText = (parent.textContent || '').trim().substring(0, 300);

      if (!nearbyText || nearbyText.length < 40) {
        // 조용한 구간: 대부분 아무 말도 하지 않음
        if (Math.random() < 0.25) {
          this.showBubble(CompanionPolicy.reaction('wander','wander-empty-'+generation));
        }
        this._wanderDone();
        return;
      }

      // 페이지 정보
      const pageTitle = document.title || '';
      const pageType = typeof detectPageType === 'function'
        ? detectPageType(window.location.href, document.body.textContent || '')
        : 'general';

      // Background에 혼잣말 요청
      const response = await chrome.runtime.sendMessage({
        type: MSG_WANDER_MONOLOGUE,
        data: { pageTitle, nearbyText, pageType }
      }).catch(() => null);

      if (generation !== this.actionGeneration || !this.canMove() || !this.wanderEnabled || !this.contentAwarenessEnabled) return;
      if(response?.type==='wander_reply') {
        if(response.data?.mood)this.updateMood(response.data.mood);
        this.showBubble(response.data?.reaction||null);
      }

    } catch (_) {
      // 조용히 넘어감
    }

    if (generation === this.actionGeneration) this._wanderDone();
  }

  _wanderDone() {
    this.wanderBusy = false;
    this.scheduleWander();
  }

  onAvatarClick(e) {
    if (this.isDragging || this.dragMoved) return;
    this.behaviorController?.activity();
    // 더블클릭과 구분: 두 번째 클릭이면 패널 열기를 취소
    if (this.clickTimer) {
      this.clearTimer(this.clickTimer);
      this.clickTimer = null;
      return;
    }
    this.clickTimer = this.later(() => {
      this.clickTimer = null;
      chrome.runtime.sendMessage({ type: MSG_AVATAR_CLICK }).catch(() => {});
      this.attentionPop();
    }, 280);
  }

  onAvatarDoubleClick(e) {
    // 드래그 중이면 더블클릭 무시
    if (this.isDragging || this.dragMoved) return;
    this.clearTimer(this.clickTimer); this.clickTimer = null;
    e.preventDefault();

    const busy=this.behaviorController?.beginBusy('greeting');
    const generation = ++this.actionGeneration;
    this.behaviorController?.activity();
    this.showBubble(CompanionPolicy.reaction('waiting','greeting-wait-'+generation));

    // Background에 요청 → LLM이 재미난 말 생성
    chrome.runtime.sendMessage({
      type: MSG_AVATAR_DOUBLE_CLICK,
      data: { url: window.location.href, title: document.title }
    }).then(response => {
      if (generation !== this.actionGeneration || !this.floatingAvatarEnabled || document.hidden) return;
      if (response && response.type === 'double_click_reply') {
        if(response.data?.mood)this.updateMood(response.data.mood);
        this.showBubble(response.data?.reaction||null);
      }
    }).catch(() => {
      if (generation !== this.actionGeneration || !this.floatingAvatarEnabled || document.hidden) return;
      this.hideBubble(false);
    }).finally(()=>{if(busy)this.behaviorController?.endBusy(busy);});
  }

  // ============================================================
  // 관심 끌기 — 아바타 크기 애니메이션
  // ============================================================

  attentionPop() {
    if (this.isDragging || !this.canMove()) return;
    // 기존 애니메이션 제거 후 다시 추가 (재트리거)
    this.avatarTarget.classList.remove('ha-attention');
    void this.avatarTarget.offsetWidth;
    this.avatarTarget.classList.add('ha-attention');
    // 애니메이션 끝나면 클래스 제거
    this.later(() => {
      this.avatarTarget.classList.remove('ha-attention');
    }, 1300);
  }

  /**
   * 랜덤 관심 끌기 — 5~15분 간격으로 심심할 때 꼬물거림
   */
  scheduleRandomPop() {
    if (this.randomPopTimer || !this.canMove()) return;
    this.randomPopTimer = this.later(() => {
      this.randomPopTimer = null;
      if (this.canMove() && !this.isDragging) this.attentionPop();
      this.scheduleRandomPop();
    }, randomInt(4,12)*60*1000);
  }

  // ============================================================
  // 말풍선
  // ============================================================

  showBubble(packet) {
    if(packet&&this.reactionGate.has(packet.id))return;
    this.hideBubble(false);
    const active=!this.destroyed&&!document.hidden&&this.floatingAvatarEnabled&&!this.isDragging&&!this.isApproaching;
    if(!this.reactionGate.take(packet,{enabled:this.speechBubblesEnabled,active,focusMode:this.focusMode}))return;
    this.bubblePacket=packet;this.bubble=document.createElement('div');this.bubble.className='ha-bubble';this.bubble.textContent=packet.text;
    this.bubble.setAttribute('role','status');this.shadow.appendChild(this.bubble);this.bubbleVisible=true;
    if(!this.placeBubble())return;
    this.bubbleTimer=this.later(()=>this.hideBubble(false),CompanionPolicy.RULES.duration);
  }
  hideBubble() {
    this.clearTimer(this.bubbleTimer);this.bubbleTimer=null;
    if(this.bubble){this.bubble.textContent='';this.bubble.remove();this.bubble=null;}this.bubbleVisible=false;this.bubblePacket=null;
  }
  placeBubble() {
    if(!this.bubble||!this.wrapper)return false;
    const bubble=this.bubble;const bounds=bubble.getBoundingClientRect(),avatar=this.wrapper.getBoundingClientRect();
    const viewport=window.visualViewport;
    const position=CompanionPolicy.chooseBubble(avatar,bounds,{left:viewport?.offsetLeft||0,top:viewport?.offsetTop||0,width:viewport?.width||window.innerWidth,height:viewport?.height||window.innerHeight},12);
    if(!position){this.hideBubble(false);return false;}
    bubble.style.left=position.x+'px';bubble.style.top=position.y+'px';return true;
  }

  // ============================================================
  // 아바타 기분 업데이트
  // ============================================================

  updateMood(mood) {
    if (!mood || !this.avatarTarget) return;
    this.currentMood = normalizeMood(mood) || 'default';
    if(this.behaviorController)this.behaviorController.setMood(this.currentMood);else this.animationView?.update(this.currentMood, this.behavior);
    this.avatarTarget.setAttribute('aria-label', `댕댕이 ${getMoodData(this.currentMood).desc}. 클릭하면 대화 열기, 더블클릭하면 말 걸기`);
  }

  // ============================================================
  // 페이지 콘텐츠 추출
  // ============================================================

  extractPageContent() {
    const url = window.location.href;
    const title = document.title || '';

    // --- 전략 1: 의미론적 본문 추출 ---
    let text = this.extractSemanticContent();

    // --- 전략 2: 전략 1이 부실하면 콘텐츠 밀도 기반 추출 ---
    if (!text || text.length < 100) {
      text = this.extractByDensity();
    }

    // --- 전략 3: 그것도 안 되면 단락 기반 ---
    if (!text || text.length < 50) {
      text = this.extractParagraphs();
    }

    // --- 전략 4: 최후의 수단, body 전체 ---
    if (!text || text.length < 30) {
      text = this.extractFromBody();
    }

    // --- 텍스트 정제 ---
    text = this.cleanText(text);

    // --- 메타 정보 보강 ---
    const metaInfo = this.extractMetaInfo();
    if (metaInfo) {
      text = metaInfo + '\n\n' + text;
    }

    // content.js는 넉넉하게 20000자까지 보내고,
    // 실제 설정값 기반 자르기는 storage.js에서 처리
    if (text.length > 20000) {
      text = text.substring(0, 20000) + '...';
    }

    const pageType = detectPageType ? detectPageType(url, text) : 'general';

    return { title, url, text, type: pageType };
  }

  /**
   * 전략 1: 의미론적 HTML5 + 일반적인 콘텐츠 셀렉터
   */
  extractSemanticContent() {
    const selectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content', '.article-content', '.entry-content',
      '.post-body', '.article-body', '.news-content',
      '[itemprop="articleBody"]',
      '.story-body', '.article-text',
      '#article-body', '#content-body',
      '.document-body', '.doc-content'
    ];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 80) {
          // 클론 후 잡요소 제거
          const clone = el.cloneNode(true);
          const removes = clone.querySelectorAll(
            'script, style, noscript, svg, iframe, ' +
            'nav, .nav, .navigation, .menu, ' +
            '.ad, .advertisement, .ads, .banner, ' +
            '.sidebar, .aside, .related, .recommend, ' +
            '.comment, .comments, .social, .share, ' +
            'footer, .footer, button, .btn'
          );
          removes.forEach(r => r.remove());
          const t = clone.textContent.trim();
          if (t.length > 80) return t;
        }
      } catch(e) { /* skip broken selector */ }
    }
    return '';
  }

  /**
   * 전략 2: 텍스트 밀도 기반 — 가장 "알맹이" 많은 DOM 요소 찾기
   */
  extractByDensity() {
    let bestEl = null;
    let bestScore = 0;

    const candidates = document.querySelectorAll(
      'div, section, article, main, .content, .post, .article, .entry'
    );

    candidates.forEach(el => {
      // 너무 작거나 큰 요소는 건너뜀
      const textLen = (el.textContent || '').trim().length;
      if (textLen < 200 || textLen > 50000) return;

      // 태그 수 대비 텍스트 비율 = 콘텐츠 밀도
      const tagCount = el.querySelectorAll('*').length;
      const density = tagCount > 0 ? textLen / tagCount : textLen;

      // <p> 태그 개수 가중치
      const pCount = el.querySelectorAll('p').length;

      // 점수 = 밀도 × 본문 적합도
      const score = density * Math.log(1 + pCount);

      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    });

    if (bestEl) {
      const clone = bestEl.cloneNode(true);
      const removes = clone.querySelectorAll(
        'script, style, noscript, svg, iframe, nav, ' +
        '.ad, .advertisement, .sidebar, .comment, ' +
        'footer, button, .btn, .share, .social'
      );
      removes.forEach(r => r.remove());
      return clone.textContent.trim();
    }
    return '';
  }

  /**
   * 전략 3: <p> + <h1~h6> + <li> 태그만 모아서 구성
   */
  extractParagraphs() {
    const parts = [];
    const seen = new Set();

    document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre, figcaption').forEach(el => {
      // 화면에 보이는 요소만 (숨김 제외)
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity) === 0) return;

      const t = el.textContent.trim();
      if (t.length < 10) return;

      // 중복 제거 (같은 텍스트가 여러 요소에 걸쳐 있는 경우)
      const key = t.substring(0, 50);
      if (seen.has(key)) return;
      seen.add(key);

      // 제목 태그는 구분자 추가
      if (/^H[1-6]$/.test(el.tagName)) {
        parts.push('## ' + t);
      } else {
        parts.push(t);
      }
    });

    return parts.join('\n\n');
  }

  /**
   * 전략 4: body에서 잡요소 제거
   */
  extractFromBody() {
    try {
      const clone = document.body.cloneNode(true);
      const removes = clone.querySelectorAll(
        'script, style, noscript, svg, iframe, img, video, audio, canvas, ' +
        'nav, header, footer, .nav, .menu, .sidebar, .aside, ' +
        '.ad, .ads, .advertisement, .banner, .popup, .modal, ' +
        '.comment, .comments, .social, .share, .related, .recommend, ' +
        'button, .btn, input, select, textarea, form'
      );
      removes.forEach(r => r.remove());
      return clone.textContent || '';
    } catch(e) {
      return document.body.textContent || '';
    }
  }

  /**
   * 텍스트 정제
   */
  cleanText(text) {
    if (!text) return '';
    return text
      .replace(/[\r\n\t]+/g, '\n')       // 줄바꿈 정규화
      .replace(/ {2,}/g, ' ')             // 과도한 공백 제거
      .replace(/\n{3,}/g, '\n\n')         // 과도한 빈 줄 제거
      .replace(/^\s+|\s+$/gm, '')         // 각 줄 앞뒤 공백 제거
      .replace(/([.!?])\s*\n/g, '$1\n')   // 문장 끝 정리
      .trim();
  }

  /**
   * 메타 정보 추출 (OG 태그, description 등)
   */
  extractMetaInfo() {
    const parts = [];

    // Open Graph / Twitter 설명
    const ogDesc = document.querySelector(
      'meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]'
    );
    if (ogDesc) {
      const desc = ogDesc.getAttribute('content') || '';
      if (desc.length > 30) {
        parts.push('📝 ' + desc);
      }
    }

    // 키워드/태그
    const keywords = document.querySelector('meta[name="keywords"]');
    if (keywords) {
      const kw = keywords.getAttribute('content') || '';
      if (kw.length > 5) {
        parts.push('🏷️ 키워드: ' + kw);
      }
    }

    // 사이트 이름
    const siteName = document.querySelector('meta[property="og:site_name"]');
    if (siteName) {
      const name = siteName.getAttribute('content') || '';
      if (name) parts.push('📍 출처: ' + name);
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  sendPageContent() {
    // P0-1: 웹 인식 OFF면 추출·전송 자체를 하지 않음
    if (!this.contentAwarenessEnabled) return;
    const content = this.extractPageContent();
    chrome.runtime.sendMessage(createPageContent ? createPageContent(content) : {
      type: 'page_content',
      data: content
    }).catch(() => {});
  }

  // ============================================================
  // SPA / 페이지 변경 감지
  // ============================================================

  observePageChanges() {
    let lastUrl = window.location.href;

    // 1. URL 변경 폴링 (2초 간격)
    this.every(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        // 잠시 기다려 DOM 업데이트
        this.later(() => this.sendPageContent(), 1500);
      }
    }, 2000);

    // 2. DOM 변경 감지 (디바운스)
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (!this.host?.isConnected) { this.destroy(); return; }
      if (debounceTimer) this.clearTimer(debounceTimer);
      debounceTimer = this.later(() => {
        // URL 변경이 있을 때만 전송 (중복 방지)
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          this.sendPageContent();
        }
      }, 2000);
    });

    this.pageObserver = observer;
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ============================================================
  // Background 메시지 수신
  // ============================================================

  setupMessageListener() {
    this.messageListener = (msg, sender, sendResponse) => {
      switch (msg.type) {
        case 'show_bubble':
          if(this.focusMode&&['proactive','wander'].includes(msg.data?.source)){this.hideBubble(false);sendResponse({type:'bubble_suppressed'});break;}
          if(msg.data?.mood)this.updateMood(msg.data.mood);
          this.showBubble(msg.data?.reaction||null);
          sendResponse({ type: 'bubble_shown' });
          break;

        case 'update_mood':
          this.updateMood(msg.data?.mood || 'default');
          sendResponse({ type: 'mood_updated' });
          break;

        case 'set_avatar_visible':
          this.setVisible(!!msg.data?.visible);
          sendResponse({ type: 'avatar_visibility_set' });
          break;

        case 'content_settings_updated':
          // P0 리뷰: 배경이 방송하는 비민감 설정 갱신
          this.applySettingsMap(msg.data?.settings);
          sendResponse({ type: 'content_settings_applied' });
          break;

        case 'typing':
          this.behaviorController?.setBusy('broadcast',!!msg.data?.active);
          if(!msg.data?.active&&this.bubblePacket?.source==='waiting')this.hideBubble(false);
          sendResponse({ type: 'typing_ack' });
          break;

        case 'request_page_content':
          // P0-2: 요청한 배경에 즉시 데이터 응답 (스냅샷 고정용). OFF면 빈 응답.
          if (this.contentAwarenessEnabled) {
            const content = this.extractPageContent();
            sendResponse({ type: MSG_PAGE_CONTENT, data: content });
          } else {
            sendResponse({ type: 'page_content_skipped' });
          }
          break;
      }
    };
    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  // ============================================================
  // 위치 저장/로드
  // ============================================================

  async loadPosition() {
    try {
      // 비민감 값이라 storage.session 사용 (local은 신뢰 컨텍스트 전용)
      const result = await chrome.storage.session.get('avatar_position');
      if (result.avatar_position) {
        this.position = result.avatar_position;
        if (this.wrapper) this.updateWrapperPosition();
      }
    } catch {
      // 기본값 유지
    }
  }
}

// --- 초기화 ---
let floatingAvatar;

// 중복 생성 방지
if (!document.getElementById('haru-avatar-host')) {
  floatingAvatar = new FloatingAvatarController();
}
