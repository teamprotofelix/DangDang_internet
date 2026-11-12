// ============================================================
// sidepanel.js — 사이드 패널 UI 컨트롤러
// 채팅 렌더링, 아바타 표시, 설정 관리
// ============================================================

class SidePanelController {
  constructor() {
    // DOM 요소
    this.avatarImg = document.getElementById('avatar-img');
    this.moodBadge = document.getElementById('mood-badge');
    this.moodLabel = document.getElementById('mood-label');
    this.messagesContainer = document.getElementById('messages');
    this.chatContainer = document.getElementById('chat-container');
    this.messageInput = document.getElementById('message-input');
    this.btnSend = document.getElementById('btn-send');
    this.btnSettings = document.getElementById('btn-settings');
    this.btnClear = document.getElementById('btn-clear');
    this.btnToggleAvatar = document.getElementById('btn-toggle-avatar');
    this.btnToggleTheme = document.getElementById('btn-toggle-theme');
    this.btnTogglePose = document.getElementById('btn-toggle-pose');
    this.settingsPanel = document.getElementById('settings-panel');
    this.typingIndicator = document.getElementById('typing-indicator');
    this.charCount = document.getElementById('char-count');

    // 업무 모드 DOM
    this.btnWorkMode = document.getElementById('btn-mode-work');
    this.btnModeChat = document.getElementById('btn-mode-chat');
    this.btnModeCode = document.getElementById('btn-mode-code');
    this.codePanel = document.getElementById('code-panel');
    this.workPanel = document.getElementById('work-panel');
    this.inputAreaEl = document.getElementById('input-area');

    // 포즈 디스플레이
    this.poseViewport = document.getElementById('pose-avatar');
    this.poseSpeech = document.getElementById('pose-speech');
    this.poseDisplay = document.getElementById('pose-display');
    this.poseSpeechTimer = null;

    // 상태
    this.currentMood = 'default';
    this.settingsVisible = false;
    this.cachedSettings = null;
    this.sending = false;
    this.lastUserText = '';
    this.currentTheme = 'auto';

    if (typeof CompanionAnimation !== 'undefined' && this.poseViewport) {
      this.animationView = new CompanionAnimation.View(this.poseViewport, {size:160});
      this.faceViews = [
        [this.avatarImg,56],
        [document.getElementById('pose-toggle-face'),22],
        [document.getElementById('onboarding-avatar'),72]
      ].filter(([target]) => target).map(([target,size]) => new CompanionAnimation.View(target,{size,variant:'face'}));
    }
    this.reactionGate=new CompanionPolicy.ReactionGate();
    this.typingSources=new Set();
    this.companionRequestId=generateId();
    if (this.animationView) {
      this.behaviorController=new CompanionBehavior.Controller(this.animationView,{
        onReaction:packet=>this.showPoseSpeech(packet),
        onState:state=>{this.updatePoseActionLabel(state.command?{action:CompanionBehavior.COMMANDS[state.command.name].label+' · 잠깐 함께해요'}:getMoodData(state.mood));this.playControls?.update(state);},
        onCommandStart:command=>this.startPanelCommand(command),
        onCommandEnd:()=>{this.playBall?.destroy();this.playBall=null;this.clearPoseSpeech();}
      });
      window.addEventListener('pagehide',()=>{this.clearPoseSpeech();chrome.runtime.sendMessage({type:MSG_TYPING,data:{active:false,requestId:this.companionRequestId}}).catch(()=>{});});
      document.addEventListener('visibilitychange',()=>{if(document.hidden)this.clearPoseSpeech();});
      window.addEventListener('resize',()=>this.clearPoseSpeech());
    }
    if(typeof CompanionControls!=='undefined'){
      this.playControls=CompanionControls.create(name=>{
        if(this.behaviorController?.perform(name))this.closePoseActions(true);
      });
      document.querySelector('.pose-interaction-row')?.appendChild(this.playControls.element);
      window.addEventListener('resize',()=>this.behaviorController?.cancelCommand('resize'));
    }
    if(typeof PlayMemoryClient!=='undefined'&&this.behaviorController){this.playMemoryClient=new PlayMemoryClient.Client({controller:this.behaviorController,settings:()=>this.cachedSettings,controls:this.playControls,reaction:p=>this.showPoseSpeech(p),clear:()=>this.clearPoseSpeech(),management:document.getElementById('play-memory-settings')});window.addEventListener('pagehide',e=>{if(!e.persisted)this.playMemoryClient.destroy();});}
    // 초기화
    this.init();
  }

  startPanelCommand({name,token,reduced}) {
    if(name==='come'){this.behaviorController.commandLater(token,()=>this.behaviorController.finishCommand(token),reduced?1200:2300);return;}
    if(name!=='play')return;
    const stage=this.poseViewport?.parentElement;if(!stage)return;
    const w=stage.clientWidth,h=stage.clientHeight,size=20;
    if(w<120||h<80){this.playControls?.announce('공간이 작아서 제자리에서 놀아요.');return;}
    this.playBall=new CompanionControls.Ball(stage,{size,onError:()=>this.behaviorController?.failCommand(token)});
    this.playBall.roll({left:w/2-65,top:h-size-5},{left:w/2+45,top:h-size-5},{duration:800,motion:!reduced});
    this.behaviorController.commandLater(token,()=>this.behaviorController.finishCommand(token),reduced?1200:2400);
  }

  async init() {
    this.bindEvents();
    await this.loadHistory();
    await this.loadSettings();
    await this.loadMemoryToUI();
    await this.playMemoryClient?.ready({reunion:true});
    this.maybeShowOnboarding();
    this.restoreAppMode();
    this.scrollToBottom();

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.currentTheme === 'auto') this.applyTheme('auto');
      });
    }

    console.log('[반려AI] 💕 Side Panel 초기화 완료');
  }

  // ============================================================
  // 이벤트 바인딩
  // ============================================================

  bindEvents() {
    this.setupPoseActions();
    document.getElementById('btn-pet')?.setAttribute('title','쓰다듬기 · 3초에 한 번');
    document.getElementById('btn-pet')?.addEventListener('click',e=>{e.stopPropagation();if(this.behaviorController?.pet())this.closePoseActions(true);});
    // 전송 버튼
    this.btnSend.addEventListener('click', () => this.sendMessage());
    this.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!e.isComposing) this.sendMessage();
      }
    });

    // 글자 수 + textarea 높이
    this.messageInput.addEventListener('input', () => {
      this.behaviorController?.activity();
      const len = this.messageInput.value.length;
      this.charCount.textContent = `${len}/100000`;
      this.autoResizeInput();
    });

    if (this.btnToggleAvatar) {
      this.btnToggleAvatar.addEventListener('click', () => this.toggleFloatingAvatar());
    }
    if (this.btnToggleTheme) {
      this.btnToggleTheme.addEventListener('click', () => this.toggleTheme());
    }
    if (this.btnTogglePose) {
      this.btnTogglePose.addEventListener('click', () => this.togglePoseDisplay());
    }

    const btnOnboardSettings = document.getElementById('btn-onboarding-settings');
    const btnOnboardLater = document.getElementById('btn-onboarding-later');
    if (btnOnboardSettings) {
      btnOnboardSettings.addEventListener('click', () => {
        this.hideOnboarding(true);
        if (!this.settingsVisible) this.toggleSettings();
        document.getElementById('input-api-key')?.focus();
      });
    }
    if (btnOnboardLater) {
      btnOnboardLater.addEventListener('click', () => this.hideOnboarding(true));
    }

    // 설정 버튼
    this.btnSettings.addEventListener('click', () => this.toggleSettings());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.settingsVisible) {
        e.preventDefault();
        this.toggleSettings(false);
      }
    });

    // 대화 초기화 버튼
    this.btnClear.addEventListener('click', () => this.clearHistory());

    // 업무 모드 토글
    this.btnWorkMode.addEventListener('click', () => this.setAppMode('work'));
    if (this.btnModeChat) {
      this.btnModeChat.addEventListener('click', () => this.setAppMode('chat'));
    }
    if (this.btnModeCode) {
      this.btnModeCode.addEventListener('click', () => this.setAppMode('code'));
    }
    this.coding = new CodingPanel(this);
    this.patents = new PatentPanel(this);
    this.bindFileUploads();

    // Background 메시지 수신
    chrome.runtime.onMessage.addListener((msg) => this.handleBackgroundMessage(msg));

    // 플로팅 아바타 등 설정이 다른 화면에서 바뀌면 동기화
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings?.newValue) return;
      const s = changes.settings.newValue;
      this.applyCompanionSettings(s);
      const floatingToggle = document.getElementById('toggle-floating-avatar');
      if (floatingToggle && typeof s.floatingAvatarEnabled === 'boolean') {
        floatingToggle.checked = s.floatingAvatarEnabled;
        this.syncFloatingAvatarButton(s.floatingAvatarEnabled);
      }
      const bubbleToggle = document.getElementById('toggle-speech-bubbles');
      if (bubbleToggle && typeof s.speechBubblesEnabled === 'boolean') {
        bubbleToggle.checked = s.speechBubblesEnabled;
      }
    });
  }

  // ============================================================
  // 메시지 전송
  // ============================================================

  async sendMessage(overrideText) {
    if (overrideText == null && this.coding.chatMode.checked) {
      await this.coding.fromChat();
      return;
    }
    const text = (overrideText ?? this.messageInput.value).trim();
    if (!text || this.sending) return;

    const settings = this.cachedSettings || await this.ensureSettings();
    if (!hasApiReady(settings)) {
      this.showOnboarding();
      return;
    }

    if (overrideText == null) {
      this.messageInput.value = '';
      this.charCount.textContent = '0/100000';
      this.autoResizeInput();
    }

    this.lastUserText = text;
    this.sending = true;
    this.renderMessage({ role: 'user', content: text, timestamp: nowISO() });
    this.behaviorController?.activity();
    this.showTyping(true);

    const streamEls = this.beginStreamingBubble();
    let requestEpoch = null; // P1 리뷰: 요청 시작 시점의 대화 세대 (초기화 후 늦은 저장 방지)

    try {
      if (typeof llmClient !== 'undefined') {
        llmClient.applyConfig({
          apiBase: settings.apiBase,
          model: settings.model,
          apiKey: settings.apiKey || '',
          maxTokens: settings.maxTokens,
          apiPreset: settings.apiPreset,
          modelContextTokens: settings.modelContextTokens,
          modelMaxOutputTokens: settings.modelMaxOutputTokens
        });
      }

      // P0-2: 배경에 대상 탭(패널 창)의 페이지 스냅샷 요청 — OFF 게이트 포함
      let pageContent = null;
      try {
        const win = await chrome.windows.getCurrent();
        const pageResp = await chrome.runtime.sendMessage({
          type: 'get_page_context',
          data: { windowId: win?.id ?? null }
        });
        if (pageResp && pageResp.type === 'page_context') {
          pageContent = pageResp.data?.pageContent || null;
        }
      } catch (_) { /* 페이지 없이 진행 */ }

      // P0-4: 요청별 예산 — 출력은 짧은 대화용 소액, 입력은 컨텍스트 상한 내
      const budgetBase = computeRequestBudget({
        apiConfig: settings,
        messages: [],
        outputReserveTokens: CONFIG.modelLimits.chatMaxOutputTokens
      });
      const historyBudget = await StorageManager.computeHistoryBudget(
        settings, text, pageContent, budgetBase.maxInputTokens
      );

      let context = await StorageManager.buildLLMContext(text, pageContent || null, {
        historyTokenBudget: historyBudget
      });

      // P0 리뷰: 최종 요청 전체를 예산 안으로 강제 축소 (초과 요청 차단)
      let enforced = enforceRequestBudget({
        apiConfig: settings,
        messages: context,
        outputReserveTokens: budgetBase.maxOutput
      });
      if (enforced.trimmed === 'hard') {
        throw new Error('모델 컨텍스트 상한이 너무 작아 요청을 만들 수 없어요. 설정에서 컨텍스트 상한을 올려주세요!');
      }
      if (enforced.trimmed) {
        this.showToast('입력이 예산을 넘어 일부를 잘라 보냈어요 ⚠️', 'info');
      }
      context = enforced.messages;

      // P1 리뷰: 요청 시작 시점의 대화 세대 고정
      requestEpoch = await StorageManager.get(CONFIG.storageKeys.historyEpoch);
      await StorageManager.addMessage('user', text, null, {}, { epoch: requestEpoch });
      this.absorbMemoryFromUser(text);

      // P0 리뷰 2차/3차: 컨텍스트 구성·저장 이후, API 전송 직전에 페이지 재검증 (패널 직접 호출 경로).
      // 재검증 실패(예외·응답 없음)도 페이지를 유지하지 않고 제거해 재구성한다 — OFF 상태에서
      // 기존 페이지가 전송되는 것을 원천 차단.
      if (pageContent) {
        let mustDrop = false;
        try {
          const win2 = await chrome.windows.getCurrent();
          const recheck = await chrome.runtime.sendMessage({
            type: 'get_page_context',
            data: { windowId: win2?.id ?? null }
          });
          const nowSnap = (recheck && recheck.type === 'page_context')
            ? (recheck.data?.pageContent || null)
            : null;
          if (!nowSnap || nowSnap.url !== pageContent.url) {
            mustDrop = true;
          }
        } catch (_) {
          mustDrop = true; // 재검증 실패 → 확인되지 않은 페이지는 제외
        }
        if (mustDrop) {
          pageContent = null;
          const historyBudget2 = await StorageManager.computeHistoryBudget(
            settings, text, null, budgetBase.maxInputTokens
          );
          context = await StorageManager.buildLLMContext(text, null, {
            historyTokenBudget: historyBudget2
          });
          enforced = enforceRequestBudget({
            apiConfig: settings,
            messages: context,
            outputReserveTokens: budgetBase.maxOutput
          });
          if (enforced.trimmed === 'hard') {
            throw new Error('모델 컨텍스트 상한이 너무 작아 요청을 만들 수 없어요. 설정에서 컨텍스트 상한을 올려주세요!');
          }
          if (enforced.trimmed) this.showToast('입력이 예산을 넘어 일부를 잘라 보냈어요 ⚠️', 'info');
          context = enforced.messages;
          this.showToast('페이지 참조를 확인하지 못해 제외했어요 (웹 인식 OFF 또는 페이지 변경)', 'info');
        }
      }

      let full = '';
      try {
        const streamed = await llmClient.chatStream(context, {
          maxTokens: enforced.budget.maxOutput,
          timeoutMs: CONFIG.api.timeoutMs
        }, (acc) => {
          full = acc;
          const visible = extractStreamingVisibleText(acc);
          if (visible) this.updateStreamingBubble(streamEls, visible);
        });
        full = streamed.content || full;
        if (streamed.truncated) {
          full += '\n(응답이 너무 길어 잘렸어! 이어서 물어보면 계속 말해줄게~)';
        }
      } catch (streamErr) {
        if (!streamErr.canFallbackToChat?.()) throw streamErr;
        const fallback = await llmClient.chatWithRetry(context, {
          maxTokens: enforced.budget.maxOutput,
          timeoutMs: CONFIG.api.timeoutMs
        });
        const fallbackText = fallback.content + (fallback.truncated
          ? '\n(응답이 너무 길어 잘렸어! 이어서 물어보면 계속 말해줄게~)' : '');
        const parsed = parseMoodFromResponse(fallbackText);
        await this.finishAssistantReply(streamEls, parsed.message, parsed.mood, requestEpoch, text);
        return;
      }

      const parsed = parseMoodFromResponse(full);
      await this.finishAssistantReply(streamEls, parsed.message, parsed.mood, requestEpoch, text);
    } catch (err) {
      console.error('[반려AI] 메시지 전송 오류:', err.statusCode || err.name || '오류');
      const errorMsg = (err && err.getUserMessage)
        ? err.getUserMessage()
        : '앗, 연결이 안 되는 것 같아... 잠시 후에 다시 시도해줄래? (´•ω•̥`)';
      const partial = err.partialContent && extractStreamingVisibleText(err.partialContent);
      this.finalizeStreamingBubble(streamEls, partial ? partial + '\n\n' + errorMsg : errorMsg,
        { error: true, retryText: text });
      this.updateAvatarMood('sad');
      await StorageManager.addMessage('assistant', errorMsg, 'sad', { error: true }, { epoch: requestEpoch ?? undefined });
      chrome.runtime.sendMessage({
        type: MSG_CHAT_COMPLETED,
        data: { content: errorMsg, mood: 'sad',source:'error' }
      }).catch(() => {});
    } finally {
      this.sending = false;
      this.showTyping(false);
      this.messageInput.focus();
    }
  }

  async ensureSettings() {
    if (this.cachedSettings) return this.cachedSettings;
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG_GET_SETTINGS });
      if (response?.data?.settings) {
        this.cachedSettings = { ...response.data.settings, ...(response.data.api || {}) };
        return this.cachedSettings;
      }
    } catch (_) { /* fall through */ }
    if (typeof StorageManager !== 'undefined') {
      const [settings, api] = await Promise.all([
        StorageManager.getSettings(),
        StorageManager.getResolvedApiConfig()
      ]);
      this.cachedSettings = { ...settings, ...api };
      return this.cachedSettings;
    }
    return DEFAULT_SETTINGS;
  }

  beginStreamingBubble() {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble avatar streaming';
    const content = document.createElement('div');
    content.className = 'bubble-content';
    content.textContent = '';
    bubble.appendChild(content);
    const footer = document.createElement('div');
    footer.className = 'bubble-footer';
    const time = document.createElement('span');
    time.className = 'bubble-time';
    time.textContent = '작성 중';
    footer.appendChild(time);
    bubble.appendChild(footer);
    this.messagesContainer.appendChild(bubble);
    this.scrollToBottom();
    return { bubble, content, time, footer };
  }

  updateStreamingBubble(els, text) {
    if (!els?.content) return;
    els.content.textContent = text;
    this.scrollToBottom();
  }

  finalizeStreamingBubble(els, text, { error = false, retryText = '' } = {}) {
    if (!els?.bubble) {
      this.renderMessage({
        role: 'assistant',
        content: text,
        mood: error ? 'sad' : 'default',
        timestamp: nowISO(),
        error
      }, { retryText: error ? retryText : '' });
      return;
    }
    els.bubble.classList.remove('streaming');
    els.content.textContent = text;
    els.time.textContent = formatTime(nowISO());
    if (error && retryText) {
      this.attachRetryButton(els.footer || els.bubble, retryText);
    }
    this.scrollToBottom();
  }

  async finishAssistantReply(els, message, mood, requestEpoch, questionText = null) {
    // P1 리뷰 2차: 저장·렌더링·방송 전에 epoch 확인 (스트림 실패 재시도 경로 포함 공통)
    if (requestEpoch != null) {
      const current = await StorageManager.get(CONFIG.storageKeys.historyEpoch);
      if (isEpochStale(requestEpoch, current)) {
        els?.bubble?.remove();
        this.showToast('대화가 초기화되어 응답을 표시하지 않았어', 'info');
        return;
      }
    }
    const reply = message || '(미소 지으며 고개를 끄덕인다)';
    const nextMood = mood || 'default';
    this.finalizeStreamingBubble(els, reply);
    this.updateAvatarMood(nextMood);
    const eventId='panel-chat-'+String(requestEpoch)+'-'+Date.now();
    this.showPoseSpeech(CompanionPolicy.completion(reply,{id:eventId}));
    await StorageManager.addMessage('assistant', reply, nextMood, {}, { epoch: requestEpoch });
    await StorageManager.saveMoodState(nextMood); // 1단계: 감정 지속성
    // 1단계: 스트리밍 버블에도 복사 + 다시 생성 버튼 (재생성 질문은 이 답변에 고정, 시간과 한 줄)
    if (els?.bubble) {
      const footer = els.footer || els.bubble;
      this.attachCopyButton(footer, reply);
      this.attachRegenButton(footer, questionText || this.lastUserText);
    }
    chrome.runtime.sendMessage({
      type: MSG_CHAT_COMPLETED,
      data: { content: reply, mood: nextMood,eventId }
    }).catch(() => {});
  }

  attachRegenButton(bubble, questionText) {
    if (!bubble || !questionText) return;
    // P1 리뷰 3차: 다시 버튼은 최신 답변에만 — 이전 답변의 버튼은 제거
    if (this._regenButtons) {
      for (const b of this._regenButtons) {
        try { b.remove(); } catch (_) { /* 이미 제거됨 */ }
      }
    }
    this._regenButtons = [];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-again';
    btn.textContent = '🔄 다시';
    btn.title = '같은 질문으로 다시 답변받기';
    // 재생성할 질문을 이 답변에 고정 (전역 lastUserText 사용 금지)
    btn.addEventListener('click', () => this.sendMessage(questionText));
    bubble.appendChild(btn);
    this._regenButtons.push(btn);
  }

  attachCopyButton(bubble, text) {
    if (!bubble || !text) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-copy';
    btn.textContent = '📋 복사';
    btn.title = '답변 복사';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('복사했어! 📋', 'success');
      } catch (_) {
        this.showToast('복사가 막혀 있어 직접 복사해줘', 'error');
      }
    });
    bubble.appendChild(btn);
  }

  async absorbMemoryFromUser(text) {
    try {
      const hints = extractMemoryHints(text);
      if (!hints.userName && !hints.likes.length && !hints.dislikes.length) return;
      const current = await StorageManager.getMemory();
      const merged = mergeMemoryHints(current, hints);
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        await StorageManager.updateMemory(merged);
        this.fillMemoryFields(merged);
      }
    } catch (_) { /* 기억 추출 실패는 무시 */ }
  }

  // ============================================================
  // 메시지 렌더링
  // ============================================================

  renderMessage(msg, { retryText = '' } = {}) {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${msg.role}`;

    const content = document.createElement('div');
    content.className = 'bubble-content';
    content.textContent = msg.content;
    bubble.appendChild(content);

    // 시간 + 액션 버튼을 한 줄(푸터 행)로 배치
    const footer = document.createElement('div');
    footer.className = 'bubble-footer';
    const time = document.createElement('span');
    time.className = 'bubble-time';
    time.textContent = msg.timestamp ? formatTime(msg.timestamp) : '방금';
    footer.appendChild(time);
    bubble.appendChild(footer);

    const canRetry = retryText || (msg.error && this.lastUserText);
    if (msg.role === 'assistant' && canRetry) {
      this.attachRetryButton(footer, retryText || this.lastUserText);
    }
    // 1단계: 답변 복사 버튼
    if (msg.role === 'assistant' && msg.content) {
      this.attachCopyButton(footer, msg.content);
    }

    this.messagesContainer.appendChild(bubble);
    this.scrollToBottom();
  }

  attachRetryButton(bubble, retryText) {
    if (!retryText) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-retry';
    btn.textContent = '다시 말하기';
    btn.setAttribute('aria-label', '마지막 말을 다시 보내기');
    btn.addEventListener('click', () => this.sendMessage(retryText));
    bubble.appendChild(btn);
  }

  async loadHistory() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG_GET_HISTORY });
      if (response && response.type === MSG_HISTORY_LOADED && response.data.messages) {
        this.messagesContainer.innerHTML = '';
        const list = response.data.messages;
        for (let i = 0; i < list.length; i++) {
          const msg = list[i];
          let retryText = '';
          if (msg.error) {
            const prevUser = [...list.slice(0, i)].reverse().find((m) => m.role === 'user');
            retryText = prevUser?.content || '';
          }
          this.renderMessage(msg, { retryText });
        }

        // 마지막 아바타 메시지의 mood로 설정 (1단계: 시간 경과에 따라 감쇠)
        const lastAvatarMsg = [...response.data.messages].reverse()
          .find(m => m.role === 'assistant');
        if (lastAvatarMsg) {
          const elapsedMin = lastAvatarMsg.timestamp
            ? Math.max(0, (Date.now() - new Date(lastAvatarMsg.timestamp).getTime()) / 60000)
            : 0;
          this.updateAvatarMood(decayMood(lastAvatarMsg.mood, elapsedMin));
        }
      }
    } catch (err) {
      console.warn('[반려AI] 이력 로드 실패:', err);
    }
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    });
  }

  // ============================================================
  // 아바타 기분 업데이트
  // ============================================================

  autoResizeInput() {
    if (!this.messageInput) return;
    this.messageInput.style.height = 'auto';
    this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
  }

  updateAvatarMood(mood) {
    if (!mood) return;
    mood = normalizeMood(mood) || 'default';
    const moodData = getMoodData(mood);
    this.currentMood = mood;
    if(this.behaviorController)this.behaviorController.setMood(mood);
    else this.animationView?.update(mood);
    this.faceViews?.forEach(view => view.update(mood));
    this.applyMoodPalette(mood);
    this.avatarImg.setAttribute('aria-label', `댕댕이 ${moodData.desc}`);
    this.poseViewport?.setAttribute('aria-label', `댕댕이 ${moodData.desc}`);
    this.moodBadge.textContent = moodData.label;
    this.moodLabel.textContent = moodData.desc;
    this.updatePoseActionLabel(moodData);
  }

  updatePoseActionLabel(moodData) {
    if (!this.poseDisplay) return;
    let label = this.poseDisplay.querySelector('.pose-action-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'pose-action-label visible';
      this.poseDisplay.appendChild(label);
    }
    label.textContent = moodData.action || '';
    label.title = moodData.action || '';
  }

  /**
   * 포즈 이미지 위에 말풍선 표시
   */
  clearPoseSpeech() {
    if(this.poseSpeechTimer)clearTimeout(this.poseSpeechTimer);this.poseSpeechTimer=null;this.poseSpeechPacket=null;
    if(this.poseSpeech){this.poseSpeech.textContent='';this.poseSpeech.classList.add('hidden');this.poseSpeech.setAttribute('aria-hidden','true');}
  }

  showPoseSpeech(packet) {
    if(!this.poseSpeech)return;
    if(packet&&this.reactionGate.has(packet.id))return;
    this.clearPoseSpeech();
    const settings=this.cachedSettings||{};
    const active=!document.hidden&&!this.poseDisplay?.classList.contains('collapsed')&&!this.behaviorController?.dead;
    if(!this.reactionGate.take(packet,{enabled:settings.speechBubblesEnabled===true,active,focusMode:settings.focusMode===true}))return;
    this.poseSpeechPacket=packet;
    this.poseSpeech.textContent=packet.text;this.poseSpeech.classList.remove('hidden');this.poseSpeech.setAttribute('aria-hidden','false');
    const row=this.poseSpeech.parentElement;
    if(row&&this.poseSpeech.getBoundingClientRect&&this.poseSpeech.getBoundingClientRect().height>row.clientHeight+1){this.clearPoseSpeech();return;}
    this.poseSpeechTimer=setTimeout(()=>this.clearPoseSpeech(),CompanionPolicy.RULES.duration);
  }

  applyCompanionSettings(settings) {
    const publicSettings=Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter(key=>Object.hasOwn(settings,key)).map(key=>[key,settings[key]]));
    this.cachedSettings={...(this.cachedSettings||{}),...publicSettings};
    settings=this.cachedSettings;
    this.behaviorController?.configure(settings);
    this.playMemoryClient?.updatePolicy();
    const movement=document.getElementById('movement-selector'),focus=document.getElementById('toggle-focus');
    if(movement)movement.value=CompanionPolicy.settings(settings).movementLevel;
    if(focus)focus.checked=settings.focusMode===true;
    if(settings.speechBubblesEnabled!==true||settings.focusMode)this.clearPoseSpeech();
  }

  // ============================================================
  // 타이핑 인디케이터
  // ============================================================

  showTyping(show,source='chat') {
    this.typingSources ||= new Set();
    const unchanged=show===this.typingSources.has(source);
    if(show)this.typingSources.add(source);else this.typingSources.delete(source);
    this.behaviorController?.setBusy(source,show);
    if(show&&!unchanged)this.showPoseSpeech(CompanionPolicy.reaction('waiting','waiting-'+source+'-'+Date.now()));
    else if(!show&&this.poseSpeechPacket?.source==='waiting')this.clearPoseSpeech();
    if(unchanged)return;
    if(source==='chat')chrome.runtime.sendMessage({type:MSG_TYPING,data:{active:!!show,requestId:this.companionRequestId}}).catch(()=>{});
    if (this.typingSources.size>0) {
      this.typingIndicator.classList.remove('hidden');
      this.startTypingCycle();
    } else {
      this.typingIndicator.classList.add('hidden');
      this.stopTypingCycle();
    }
  }

  // 1단계: 타이핑 단계 순환 — 살아있는 느낌의 진행 표현
  startTypingCycle() {
    this.stopTypingCycle();
    const stages = ['생각 중', '고개를 갸웃', '두근두근', '답장을 쓰는 중'];
    const textEl = this.typingIndicator?.querySelector('.typing-text');
    if (!textEl) return;
    let i = 0;
    const apply = () => { textEl.textContent = '댕댕이가 ' + stages[i % stages.length] + '...'; };
    apply();
    this.typingCycleTimer = setInterval(() => { i++; apply(); }, 1600);
  }

  stopTypingCycle() {
    if (this.typingCycleTimer) {
      clearInterval(this.typingCycleTimer);
      this.typingCycleTimer = null;
    }
  }

  // ============================================================
  // 설정
  // ============================================================

  async loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG_GET_SETTINGS });
      if (response && response.type === MSG_SETTINGS_LOADED) {
        // 신뢰된 패널이므로 API 구성(키 포함)을 병합해 받음
        const merged = { ...response.data.settings, ...(response.data.api || {}) };
        this.applySettingsToUI(merged);
      }
    } catch (err) {
      console.warn('[반려AI] 설정 로드 실패:', err);
    }
  }

  applySettingsToUI(settings) {
    this.cachedSettings = settings;
    this.applyCompanionSettings(settings);
    this.applyTheme(settings.theme || 'auto');
    this.maybeShowOnboarding();
    // 기능 토글
    document.getElementById('toggle-proactive').checked = settings.proactiveEnabled;
    document.getElementById('toggle-content-aware').checked = settings.contentAwarenessEnabled;
    document.getElementById('toggle-model-memory').checked = settings.sendMemoryToModel;
    const approachToggle = document.getElementById('toggle-approach');
    if (approachToggle) approachToggle.checked = settings.approachEnabled !== false;
    const wanderToggle = document.getElementById('toggle-wander');
    if (wanderToggle) wanderToggle.checked = settings.wanderEnabled !== false;
    const floatingToggle = document.getElementById('toggle-floating-avatar');
    if (floatingToggle) floatingToggle.checked = settings.floatingAvatarEnabled !== false;
    const bubbleToggle = document.getElementById('toggle-speech-bubbles');
    if (bubbleToggle) bubbleToggle.checked = settings.speechBubblesEnabled !== false;
    this.syncFloatingAvatarButton(settings.floatingAvatarEnabled !== false);
    this.applyPoseCollapsed(!!settings.poseCollapsed);

    // API 설정 필드
    document.getElementById('input-api-base').value = settings.apiBase || '';
    document.getElementById('input-model').value = settings.model || '';
    document.getElementById('input-api-key').value = settings.apiKey || '';
    // P0 리뷰: 키가 현재 표시 중인 주소의 origin에 속함을 추적 (주소 변경 시 키 교체/비움)
    this._keyOrigin = normalizeApiOrigin(settings.apiBase || '');

    // maxTokens 슬라이더
    const maxTokens = settings.maxTokens || 25000;
    const tokenSlider = document.getElementById('input-max-tokens');
    if (tokenSlider) {
      tokenSlider.value = maxTokens;
      document.getElementById('max-tokens-value').textContent = maxTokens;
    }

    // 모델 컨텍스트/최대 출력 상한 슬라이더 (P0-4)
    const ctxLimit = settings.modelContextTokens || 32768;
    const ctxSlider = document.getElementById('input-model-context');
    if (ctxSlider) {
      ctxSlider.value = ctxLimit;
      document.getElementById('model-context-value').textContent = Number(ctxLimit).toLocaleString();
    }
    const maxOut = settings.modelMaxOutputTokens || 8192;
    const outSlider = document.getElementById('input-model-max-out');
    if (outSlider) {
      outSlider.value = maxOut;
      document.getElementById('model-max-out-value').textContent = Number(maxOut).toLocaleString();
    }

    // 페이지 용량 슬라이더
    const pageChars = settings.pageContentMaxChars || 5000;
    const pageSlider = document.getElementById('input-page-chars');
    if (pageSlider) {
      pageSlider.value = pageChars;
      document.getElementById('page-chars-value').textContent =
        Number(pageChars).toLocaleString();
    }

    // 말 걸기 간격 슬라이더
    const interval = settings.proactiveIntervalMin || 15;
    const intervalSlider = document.getElementById('input-interval');
    if (intervalSlider) {
      intervalSlider.value = interval;
      document.getElementById('interval-value').textContent = interval + '분';
    }

    // 프리셋 셀렉터
    const wanderMin = settings.wanderIntervalMin || 60;
    const wanderSlider = document.getElementById('input-wander-interval');
    if (wanderSlider) {
      const minutes = Math.max(1, Math.round(wanderMin / 60));
      wanderSlider.value = minutes;
      const wanderLabel = document.getElementById('wander-interval-value');
      if (wanderLabel) wanderLabel.textContent = minutes + '분';
    }

    const movement=document.getElementById('movement-selector'),focus=document.getElementById('toggle-focus');
    if(movement)movement.onchange=()=>this.updateSetting({movementLevel:movement.value});
    if(focus)focus.onchange=()=>this.updateSetting({focusMode:focus.checked});
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) themeSelector.value = settings.theme || 'auto';

    this.populatePresetSelector(settings.apiPreset || 'custom');
  }

  /**
   * 프리셋 셀렉터 채우기
   */
  populatePresetSelector(currentPresetId) {
    const selector = document.getElementById('preset-selector');
    if (!selector) return;

    selector.innerHTML = '';
    const presets = CONFIG.apiPresets;
    const presetKeys = Object.keys(presets);

    // 사용자 정의(custom)는 항상 맨 마지막에
    const orderedKeys = [
      ...presetKeys.filter(k => k !== 'custom'),
      'custom'
    ];

    let matchedPreset = null;

    orderedKeys.forEach(key => {
      const preset = presets[key];
      const option = document.createElement('option');
      option.value = key;
      option.textContent = preset.label;
      if (key === currentPresetId) {
        option.selected = true;
        matchedPreset = preset;
      }
      selector.appendChild(option);
    });

    // 프리셋 설명 표시
    this.updatePresetDescription(currentPresetId);

    // 선택 변경 이벤트
    selector.onchange = (e) => this.onPresetChanged(e.target.value);
  }

  /**
   * 프리셋 설명 업데이트
   */
  updatePresetDescription(presetId) {
    const descEl = document.getElementById('preset-desc');
    const preset = CONFIG.apiPresets[presetId];
    if (descEl && preset) {
      descEl.textContent = preset.description || '';
    }
  }

  /**
   * 프리셋 변경 시 필드 자동 채우기.
   * P0-3: API 키는 "해당 제공자 origin에 저장된 키"만 표시한다.
   * 저장된 키가 없으면 빈 입력 — 이전 제공자의 키가 다른 제공자로 넘어가지 않음.
   */
  onPresetChanged(presetId) {
    const preset = CONFIG.apiPresets[presetId];
    if (!preset) return;
    const base = document.getElementById('input-api-base');
    const key = document.getElementById('input-api-key');
    if (presetId !== 'custom') {
      base.value = preset.apiBase;
      document.getElementById('input-model').value = preset.model;
    }
    const origin = normalizeApiOrigin(base.value);
    key.value = '';
    this._keyOrigin = origin;
    this._keySwapPromise = StorageManager.getApiKeys().then(keys => {
      if (document.getElementById('preset-selector').value !== presetId
        || normalizeApiOrigin(base.value) !== origin || key.value) return;
      key.value = keys[origin] || (presetId === 'ollama' ? 'ollama' : '');
    }).catch(() => {});
    this.updatePresetDescription(presetId);
  }

  toggleSettings(forceOpen) {
    this.settingsVisible = typeof forceOpen === 'boolean' ? forceOpen : !this.settingsVisible;
    this.settingsPanel.classList.toggle('hidden', !this.settingsVisible);
    this.btnSettings.classList.toggle('active', this.settingsVisible);
    this.btnSettings.title = this.settingsVisible ? '설정 닫기' : '설정';
    this.btnSettings.setAttribute('aria-label', this.settingsVisible ? '설정 닫기' : '설정 열기');
    this.btnSettings.setAttribute('aria-expanded', this.settingsVisible ? 'true' : 'false');

    if (this.settingsVisible) {
      this.bindSettingsEvents();
      this.loadSettings();
      document.getElementById('btn-close-settings')?.focus();
    }
  }

  bindSettingsEvents() {
    // API 설정 저장
    document.getElementById('btn-save-api').onclick = () => this.saveApiConfig();

    // 연결 테스트
    document.getElementById('btn-test-api').onclick = () => this.testApiConnection();

    // maxTokens 슬라이더 — 변경 즉시 저장
    const tokenSlider = document.getElementById('input-max-tokens');
    const tokenValue = document.getElementById('max-tokens-value');
    if (tokenSlider && tokenValue) {
      tokenSlider.oninput = () => {
        tokenValue.textContent = Number(tokenSlider.value).toLocaleString();
      };
      tokenSlider.onchange = () => {
        const val = parseInt(tokenSlider.value) || 256;
        this.updateSetting({ maxTokens: Math.min(55000, Math.max(256, val)) });
        this.showToast(`기본 응답 길이 → ${val.toLocaleString()} 저장! 📏`, 'success');
      };
    }

    // 모델 컨텍스트 상한 / 최대 출력 상한 (P0-4)
    const ctxSlider = document.getElementById('input-model-context');
    const ctxValue = document.getElementById('model-context-value');
    if (ctxSlider && ctxValue) {
      ctxSlider.oninput = () => {
        ctxValue.textContent = Number(ctxSlider.value).toLocaleString();
      };
      ctxSlider.onchange = () => {
        const val = parseInt(ctxSlider.value) || 32768;
        this.updateSetting({ modelContextTokens: Math.min(2000000, Math.max(4096, val)) });
        this.showToast(`컨텍스트 상한 → ${val.toLocaleString()} 토큰 저장! 🧠`, 'success');
      };
    }
    const outSlider = document.getElementById('input-model-max-out');
    const outValue = document.getElementById('model-max-out-value');
    if (outSlider && outValue) {
      outSlider.oninput = () => {
        outValue.textContent = Number(outSlider.value).toLocaleString();
      };
      outSlider.onchange = () => {
        const val = parseInt(outSlider.value) || 8192;
        this.updateSetting({ modelMaxOutputTokens: Math.min(200000, Math.max(512, val)) });
        this.showToast(`최대 출력 상한 → ${val.toLocaleString()} 토큰 저장! 📤`, 'success');
      };
    }

    // 페이지 용량 슬라이더 — 변경 즉시 저장
    const pageSlider = document.getElementById('input-page-chars');
    const pageValue = document.getElementById('page-chars-value');
    if (pageSlider && pageValue) {
      pageSlider.oninput = () => {
        pageValue.textContent = Number(pageSlider.value).toLocaleString();
      };
      pageSlider.onchange = () => {
        const val = parseInt(pageSlider.value) || 5000;
        this.updateSetting({ pageContentMaxChars: val });
        this.showToast(`페이지 읽기 → ${val.toLocaleString()}자 저장! 🌐`, 'success');
      };
    }

    // API 키 보기/숨기기
    document.getElementById('btn-toggle-key-vis').onclick = () => {
      const input = document.getElementById('input-api-key');
      input.type = input.type === 'password' ? 'text' : 'password';
    };

    // P0 리뷰 3차: 주소 origin이 바뀌면 키를 "동기적으로 즉시" 비운 뒤
    // 비동기로 해당 origin의 저장 키를 채운다. 교체가 끝나기 전에
    // 저장·연결 테스트가 옛 키를 읽지 않도록 _keySwapPromise로 차단.
    document.getElementById('input-api-base').addEventListener('input', () => {
      const baseEl = document.getElementById('input-api-base');
      const keyEl = document.getElementById('input-api-key');
      const newOrigin = normalizeApiOrigin(baseEl.value.trim());
      if (this._keyOrigin && newOrigin && newOrigin !== this._keyOrigin) {
        // 1) 동기적으로 즉시 비움 — 옛 키가 읽히는 창을 제거
        keyEl.value = '';
        this._keyOrigin = newOrigin;
        this.showToast('주소가 바뀌어 API 키를 해당 주소의 저장 키로 교체하는 중이에요 (없으면 빈 칸)', 'info');
        const originAtStart = newOrigin;
        // 2) 비동기 교체 — 진행 중에는 저장/테스트가 이 프로미스를 기다림
        const swap = (async () => {
          try {
            const keys = (typeof StorageManager !== 'undefined')
              ? await StorageManager.getApiKeys()
              : {};
            // 그 사이 origin이 또 바뀌었으면 건너뜀
            if (normalizeApiOrigin(baseEl.value.trim()) !== originAtStart) return;
            if (!keyEl.value) keyEl.value = keys[originAtStart] || '';
          } catch (_) {
            // 저장 키 조회 실패 시 빈 칸 유지
          }
        })();
        this._keySwapPromise = swap.catch(() => {});
      }
    });

    // 기능 토글
    document.getElementById('toggle-model-memory').onchange = event =>
      this.updateSetting({ sendMemoryToModel: event.target.checked });
    document.getElementById('toggle-proactive').onchange = (e) =>
      this.updateSetting({ proactiveEnabled: e.target.checked });
    document.getElementById('toggle-content-aware').onchange = (e) =>
      this.updateSetting({ contentAwarenessEnabled: e.target.checked });
    const approachToggle = document.getElementById('toggle-approach');
    if (approachToggle) {
      approachToggle.onchange = (e) => {
        this.updateSetting({ approachEnabled: e.target.checked });
      };
    }
    const wanderToggle = document.getElementById('toggle-wander');
    if (wanderToggle) {
      wanderToggle.onchange = (e) => {
        this.updateSetting({ wanderEnabled: e.target.checked });
      };
    }
    const floatingToggle = document.getElementById('toggle-floating-avatar');
    if (floatingToggle) {
      floatingToggle.onchange = (e) => {
        this.updateSetting({ floatingAvatarEnabled: e.target.checked });
        this.syncFloatingAvatarButton(e.target.checked);
        this.showToast(
          e.target.checked ? '플로팅 아바타를 켰어요! 🎀' : '플로팅 아바타를 숨겼어요.',
          'success'
        );
      };
    }
    const bubbleToggle = document.getElementById('toggle-speech-bubbles');
    if (bubbleToggle) {
      bubbleToggle.onchange = (e) => {
        this.updateSetting({ speechBubblesEnabled: e.target.checked });
      };
    }

    const wanderSlider = document.getElementById('input-wander-interval');
    const wanderValue = document.getElementById('wander-interval-value');
    if (wanderSlider && wanderValue) {
      wanderSlider.oninput = () => {
        wanderValue.textContent = wanderSlider.value + '분';
      };
      wanderSlider.onchange = () => {
        const minutes = parseInt(wanderSlider.value, 10) || 1;
        this.updateSetting({
          wanderIntervalMin: minutes * 60,
          wanderIntervalMax: minutes * 60 + 60
        });
        this.showToast(`구경 간격 → ${minutes}분 저장! 🐾`, 'success');
      };
    }

    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) {
      themeSelector.onchange = (e) => {
        const theme = e.target.value;
        this.applyTheme(theme);
        this.updateSetting({ theme });
      };
    }

    const btnSaveMemory = document.getElementById('btn-save-memory');
    if (btnSaveMemory) {
      btnSaveMemory.onclick = () => this.saveMemoryFromUI();
    }

    // 말 걸기 간격 슬라이더
    const intervalSlider = document.getElementById('input-interval');
    const intervalValue = document.getElementById('interval-value');
    if (intervalSlider && intervalValue) {
      intervalSlider.oninput = () => {
        intervalValue.textContent = intervalSlider.value + '분';
      };
      intervalSlider.onchange = () => {
        const val = parseInt(intervalSlider.value) || 15;
        // min = val, max = val+5 (약간의 랜덤성 유지)
        this.updateSetting({
          proactiveIntervalMin: val,
          proactiveIntervalMax: Math.min(val + 5, 30)
        });
        this.showToast(`말 걸기 간격 → ${val}분 저장! ⏱️`, 'success');
      };
    }
    // 데이터 관리
    document.getElementById('btn-export').onclick = () => this.exportConversation();
    document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
    document.getElementById('import-file').onchange = (e) => this.importConversation(e);

    // 저장소 정보 업데이트
    this.updateStorageInfo();

    // 닫기
    document.getElementById('btn-close-settings').onclick = () => this.toggleSettings();
  }

  /**
   * API 설정 저장 (apiBase, model, apiKey 한 번에)
   */
  async saveApiConfig() {
    if (this._keySwapPromise) await this._keySwapPromise;
    const apiBase = document.getElementById('input-api-base').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const apiKey = document.getElementById('input-api-key').value.trim();
    const maxTokens = Math.min(55000, Math.max(256, parseInt(document.getElementById('input-max-tokens').value) || 25000));
    const pageChars = parseInt(document.getElementById('input-page-chars').value) || 5000;
    const presetId = document.getElementById('preset-selector').value;
    const modelContextTokens = parseInt(document.getElementById('input-model-context')?.value) || 32768;
    const modelMaxOutputTokens = parseInt(document.getElementById('input-model-max-out')?.value) || 8192;

    if (!apiBase) {
      this.showToast('API 주소를 입력해주세요!', 'error');
      return;
    }
    if (!model) {
      this.showToast('모델명을 입력해주세요!', 'error');
      return;
    }

    // P0 리뷰 2차: 저장 전 키 origin 확인 — 다른 주소의 키는 저장하지 않음
    let effectiveKey = apiKey;
    try {
      const keys = (typeof StorageManager !== 'undefined') ? await StorageManager.getApiKeys() : {};
      effectiveKey = resolveKeyForOrigin(keys, normalizeApiOrigin(apiBase), apiKey);
      if (apiKey && !effectiveKey) {
        this.showToast('입력된 키가 다른 주소의 키예요. 저장하지 않았어요 — 새 주소의 키를 입력해주세요! 🔑', 'error');
        return;
      }
    } catch (_) { /* 무시 */ }

    try { chatCompletionURL({ apiBase, model, apiKey: effectiveKey, apiPreset: presetId }); }
    catch (error) { this.showToast(error.getUserMessage?.() || error.message, 'error'); return; }

    // API 필드는 배경에서 제공자·origin별로 분리 저장됨 (P0-3)
    const response = await chrome.runtime.sendMessage({
      type: MSG_UPDATE_SETTINGS,
      data: {
        apiPreset: presetId, apiBase, model, apiKey: effectiveKey, maxTokens,
        pageContentMaxChars: pageChars,
        modelContextTokens, modelMaxOutputTokens
      }
    });

    if (response?.data?.api) {
      this.cachedSettings = {
        ...(this.cachedSettings || {}),
        ...response.data.settings,
        ...response.data.api
      };
    } else {
      this.cachedSettings = {
        ...(this.cachedSettings || {}),
        apiPreset: presetId, apiBase, model, apiKey: effectiveKey, maxTokens,
        pageContentMaxChars: pageChars,
        modelContextTokens, modelMaxOutputTokens
      };
    }
    this.hideOnboarding(false);
    // P0 리뷰: 저장 후 키 origin 추적 갱신
    this._keyOrigin = normalizeApiOrigin(apiBase);
    this.showToast('API 설정이 저장되었어요! 💾\n' + apiBase + '\n기본 응답 길이: ' + maxTokens, 'success');
  }

  /**
   * API 연결 테스트
   */
  async testApiConnection() {
    if (this._keySwapPromise) await this._keySwapPromise;
    const apiBase = document.getElementById('input-api-base').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const apiKey = document.getElementById('input-api-key').value.trim();

    if (!apiBase || !model) {
      this.showToast('API 주소와 모델명을 먼저 입력해주세요!', 'error');
      return;
    }

    // P0 리뷰 2차: 전송 직전 키 origin 확인 — 다른 주소의 키가 섞였으면 보내지 않음
    let effectiveKey = apiKey;
    try {
      const keys = (typeof StorageManager !== 'undefined') ? await StorageManager.getApiKeys() : {};
      effectiveKey = resolveKeyForOrigin(keys, normalizeApiOrigin(apiBase), apiKey);
      if (apiKey && !effectiveKey) {
        this.showToast('입력된 키가 다른 주소의 키예요. 새 주소의 키를 입력해주세요! 🔑', 'error');
        return;
      }
    } catch (_) { /* 키 저장소 접근 실패 시 입력값 사용 */ }

    const resultEl = document.getElementById('api-test-result');
    resultEl.classList.remove('hidden', 'success', 'error');
    resultEl.classList.add('testing');
    resultEl.textContent = '⏳ 연결 테스트 중...';

    try {
      const client = new LLMClient();
      client.applyConfig({
        apiBase, model, apiKey: effectiveKey,
        apiPreset: document.getElementById('preset-selector').value,
        modelContextTokens: Number(document.getElementById('input-model-context')?.value) || 32768,
        modelMaxOutputTokens: Number(document.getElementById('input-model-max-out')?.value) || 8192
      });
      await client.chat([{ role: 'user', content: 'Reply with OK.' }], {
        maxTokens: isExaone(client) ? 1024 : isOpenAILuna(client) ? 32 : 5,
        reasoningEffort: 'none', timeoutMs: 25000, bodyTimeoutMs: 25000
      });
      resultEl.classList.remove('testing', 'error');
      resultEl.classList.add('success');
      resultEl.textContent = '✅ 연결 성공! API가 정상 작동합니다~ (╹◡╹)♡';
    } catch (err) {
      resultEl.classList.remove('testing', 'success');
      resultEl.classList.add('error');
      resultEl.textContent = '❌ ' + (err.getUserMessage?.() || 'API 연결에 실패했어요. 주소와 연결 상태를 확인해주세요.');
    }
  }

  async updateSetting(partial) {
    this.applyCompanionSettings(partial);
    await chrome.runtime.sendMessage({
      type: MSG_UPDATE_SETTINGS,
      data: partial
    });
  }

  syncFloatingAvatarButton(enabled) {
    if (!this.btnToggleAvatar) return;
    this.btnToggleAvatar.classList.toggle('avatar-off', !enabled);
    this.btnToggleAvatar.title = enabled ? '플로팅 아바타 끄기' : '플로팅 아바타 켜기';
  }

  async toggleFloatingAvatar() {
    const checkbox = document.getElementById('toggle-floating-avatar');
    const next = checkbox ? !checkbox.checked : true;
    if (checkbox) checkbox.checked = next;
    await this.updateSetting({ floatingAvatarEnabled: next });
    this.syncFloatingAvatarButton(next);
    this.showToast(next ? '플로팅 아바타를 켰어요! 🎀' : '플로팅 아바타를 숨겼어요.', 'success');
  }

  setupPoseActions() {
    const toggle=document.getElementById('btn-pose-actions');
    const popover=document.getElementById('pose-actions-popover');
    if(!toggle||!popover)return;
    this.poseActionsToggle=toggle;
    this.poseActionsPopover=popover;
    this.poseActionsEvents?.abort();
    const events=this.poseActionsEvents=new AbortController();
    toggle.addEventListener('click',e=>{
      if(this.poseDisplay?.classList.contains('collapsed'))return;
      if(!popover.hidden){this.closePoseActions();return;}
      popover.hidden=false;
      toggle.setAttribute('aria-expanded','true');
      if(e.detail===0)popover.querySelector('button:not(:disabled)')?.focus();
    },{signal:events.signal});
    // This is a disclosure of ordinary buttons, not an ARIA menu: Tab/Shift+Tab
    // remain native. Escape and focus leaving return it to its closed state.
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!popover.hidden){e.preventDefault();this.closePoseActions(true);}
    },{signal:events.signal});
    document.addEventListener('pointerdown',e=>{
      if(!popover.contains(e.target)&&!toggle.contains(e.target))this.closePoseActions();
    },{signal:events.signal});
    document.addEventListener('focusin',e=>{
      if(!popover.contains(e.target)&&!toggle.contains(e.target))this.closePoseActions();
    },{signal:events.signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.closePoseActions();},{signal:events.signal});
    window.addEventListener('resize',()=>this.closePoseActions(),{signal:events.signal});
    window.addEventListener('pagehide',e=>{
      this.closePoseActions();
      if(!e.persisted)events.abort();
    },{signal:events.signal});
  }

  closePoseActions(restoreFocus=false) {
    if(!this.poseActionsPopover)return;
    const wasOpen=!this.poseActionsPopover.hidden;
    this.poseActionsPopover.hidden=true;
    this.poseActionsToggle?.setAttribute('aria-expanded','false');
    if(wasOpen&&restoreFocus)this.poseActionsToggle?.focus();
  }

  applyPoseCollapsed(collapsed) {
    if(collapsed){
      const focused=this.poseActionsPopover?.contains(document.activeElement)||document.activeElement===this.poseActionsToggle;
      this.closePoseActions();
      if(focused)this.btnTogglePose?.focus();
    }
    if(this.behaviorController)this.behaviorController.setVisible(!collapsed);else this.animationView?.setVisible(!collapsed);
    if(collapsed)this.clearPoseSpeech();
    if (this.poseDisplay) {
      this.poseDisplay.classList.toggle('collapsed', collapsed);
    }
    if (this.btnTogglePose) {
      const label = document.getElementById('pose-toggle-label');
      const chevron = document.getElementById('pose-toggle-chevron');
      if (label) label.textContent = collapsed ? '댕댕이 보기' : '댕댕이 접기';
      if (chevron) chevron.textContent = collapsed ? '▴' : '▾';
      this.btnTogglePose.title = collapsed ? '댕댕이 화면 펼치기' : '댕댕이 화면 접기';
      this.btnTogglePose.setAttribute('aria-label', this.btnTogglePose.title);
      this.btnTogglePose.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }

  async togglePoseDisplay() {
    const collapsed = !this.poseDisplay?.classList.contains('collapsed');
    this.applyPoseCollapsed(collapsed);
    await this.updateSetting({ poseCollapsed: collapsed });
  }

  isDarkTheme() {
    if (this.currentTheme === 'dark') return true;
    if (this.currentTheme === 'pastel') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  applyTheme(theme) {
    this.currentTheme = theme || 'auto';
    const resolved = this.isDarkTheme() ? 'dark' : 'pastel';
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
    ['--primary', '--primary-dark', '--primary-light', '--bg',
      '--bubble-avatar', '--bubble-avatar-border'].forEach((name) => {
      root.style.removeProperty(name);
    });
    if (this.currentMood) this.applyMoodPalette(this.currentMood);
    this.syncThemeButton();
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector && (theme === 'dark' || theme === 'pastel' || theme === 'auto')) {
      themeSelector.value = theme;
    }
  }

  applyMoodPalette(mood) {
    if (typeof MOOD_COLORS === 'undefined') return;
    const palette = MOOD_COLORS[mood] || MOOD_COLORS['default'];
    const root = document.documentElement;
    root.style.setProperty('--primary', palette.primary);
    root.style.setProperty('--primary-dark', palette.primaryDark);
    if (this.isDarkTheme()) {
      // 밝은 파스텔 말풍선/배경은 덮어쓰지 않음 — 흰색 글씨가 묻힘
      return;
    }
    root.style.setProperty('--primary-light', palette.primaryLight);
    root.style.setProperty('--bubble-avatar', palette.bubbleAvatar);
    root.style.setProperty('--bubble-avatar-border', palette.bubbleAvatarBorder);
    root.style.setProperty('--bg', palette.bg);
  }

  syncThemeButton() {
    if (!this.btnToggleTheme) return;
    const dark = this.isDarkTheme();
    this.btnToggleTheme.textContent = dark ? '☀️' : '🌙';
    const label = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
    this.btnToggleTheme.title = label;
    this.btnToggleTheme.setAttribute('aria-label', label);
    this.btnToggleTheme.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  async toggleTheme() {
    const next = this.isDarkTheme() ? 'pastel' : 'dark';
    this.applyTheme(next);
    await this.updateSetting({ theme: next });
  }

  maybeShowOnboarding() {
    const settings = this.cachedSettings;
    if (!settings) return;
    if (hasApiReady(settings)) {
      this.hideOnboarding(false);
      return;
    }
    if (!settings.onboardingDismissed) this.showOnboarding();
  }

  showOnboarding() {
    const el = document.getElementById('onboarding');
    if (!el) return;
    el.classList.remove('hidden');
    document.getElementById('btn-onboarding-settings')?.focus();
  }

  hideOnboarding(persist) {
    const el = document.getElementById('onboarding');
    if (el) el.classList.add('hidden');
    if (persist) this.updateSetting({ onboardingDismissed: true });
  }

  fillMemoryFields(memory) {
    const nameEl = document.getElementById('input-user-name');
    const likesEl = document.getElementById('input-likes');
    const dislikesEl = document.getElementById('input-dislikes');
    const notesEl = document.getElementById('input-memory-notes');
    if (nameEl) nameEl.value = memory.userName || '';
    if (likesEl) likesEl.value = (memory.likes || []).join(', ');
    if (dislikesEl) dislikesEl.value = (memory.dislikes || []).join(', ');
    if (notesEl) notesEl.value = (memory.notes || []).join('\n');
  }

  async loadMemoryToUI() {
    try {
      let memory;
      if (typeof StorageManager !== 'undefined') {
        memory = await StorageManager.getMemory();
      } else {
        const res = await chrome.runtime.sendMessage({ type: MSG_GET_MEMORY });
        memory = res?.data?.memory;
      }
      if (memory) this.fillMemoryFields(memory);
    } catch (_) { /* 무시 */ }
  }

  async saveMemoryFromUI() {
    const splitCsv = (value) =>
      String(value || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    const notes = String(document.getElementById('input-memory-notes')?.value || '')
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);

    const payload = {
      userName: (document.getElementById('input-user-name')?.value || '').trim().slice(0, 20),
      likes: splitCsv(document.getElementById('input-likes')?.value),
      dislikes: splitCsv(document.getElementById('input-dislikes')?.value),
      notes
    };

    if (typeof StorageManager !== 'undefined') {
      await StorageManager.updateMemory(payload);
    } else {
      await chrome.runtime.sendMessage({ type: MSG_UPDATE_MEMORY, data: payload });
    }
    this.showToast('기억을 저장했어! 다음에 대화할 때 떠올릴게 🐾', 'success');
  }

  // ============================================================
  // 업무 모드
  // ============================================================

  /**
   * 업무 모드 토글
   */
  async restoreAppMode() {
    try {
      const stored = await chrome.storage.local.get(CONFIG.storageKeys.lastAppMode);
      const mode = stored[CONFIG.storageKeys.lastAppMode];
      if (mode === 'work' || mode === 'code' || mode === 'chat') {
        this.setAppMode(mode);
      }
    } catch (_) { /* keep chat */ }
  }

  setAppMode(mode) {
    const next = mode === 'work' || mode === 'code' ? mode : 'chat';
    this.appMode = next;

    this.btnModeChat?.classList.toggle('active', next === 'chat');
    this.btnWorkMode?.classList.toggle('active', next === 'work');
    this.btnModeCode?.classList.toggle('active', next === 'code');
    this.btnModeChat?.setAttribute('aria-selected', next === 'chat' ? 'true' : 'false');
    this.btnWorkMode?.setAttribute('aria-selected', next === 'work' ? 'true' : 'false');
    this.btnModeCode?.setAttribute('aria-selected', next === 'code' ? 'true' : 'false');

    this.chatContainer?.classList.toggle('hidden', next !== 'chat');
    this.workPanel?.classList.toggle('hidden', next !== 'work');
    this.codePanel?.classList.toggle('hidden', next !== 'code');
    if (this.inputAreaEl) this.inputAreaEl.classList.toggle('hidden', next !== 'chat');

    if (next === 'work') {
      this.updateAvatarMood('study');
      this.moodLabel.textContent = '업무 중 📚';
    } else if (next === 'code') {
      this.updateAvatarMood('think');
      this.moodLabel.textContent = '코딩 중 ⚡';
    } else {
      this.updateAvatarMood('default');
      this.moodLabel.textContent = '기본';
    }

    chrome.storage.local.set({ [CONFIG.storageKeys.lastAppMode]: next }).catch(() => {});
  }

  bindFileUploads() {
    const chatInput = document.getElementById('chat-file-input');
    const btnAttach = document.getElementById('btn-attach');

    if (btnAttach && chatInput) {
      btnAttach.addEventListener('click', () => chatInput.click());
      chatInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) await this.importFileToField(file, this.messageInput, { chat: true });
      });
    }

    this.enableDrop(this.messageInput, (file) => this.importFileToField(file, this.messageInput, { chat: true }));
  }

  enableDrop(el, onFile) {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('file-drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('file-drop-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('file-drop-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) await onFile(file);
    });
  }

  async importFileToField(file, field, { chat } = {}) {
    if (!field || typeof FileIO === 'undefined') return;
    try {
      this.showToast(`파일을 읽는 중... 📄\n${file.name}`, 'info');
      const parsed = await FileIO.parseFile(file, {
        maxChars: chat ? FileIO.CHAT_MAX_CHARS : FileIO.WORK_MAX_CHARS
      });
      const chunk = chat ? FileIO.wrapForChat(parsed.name, parsed.text) : parsed.text;
      const cur = field.value.trim();
      field.value = cur ? `${cur}\n\n${chunk}` : chunk;
      field.dispatchEvent(new Event('input'));
      if (chat) this.autoResizeInput();
      field.focus();
      const extra = parsed.truncated ? '\n앞부분만 넣었어.' : '';
      const details = [];
      if (parsed.stats && (parsed.stats.tables || parsed.stats.images)) {
        details.push(`표 ${parsed.stats.tables} · 그림 ${parsed.stats.images}`);
      }
      if (parsed.warnings && parsed.warnings.length) {
        details.push(`⚠️ 경고 ${parsed.warnings.length}개: ${parsed.warnings[0]}`);
      }
      const detailLine = details.length ? '\n' + details.join('\n') : '';
      this.showToast(`글자를 넣었어! 📎\n${parsed.name} · ${parsed.chars.toLocaleString()}자${extra}${detailLine}`, 'success');
    } catch (err) {
      console.warn('[반려AI] 파일 읽기 실패:', err);
      this.showToast(err.message || '파일을 읽지 못했어', 'error');
    }
  }

  // ============================================================
  // 데이터 내보내기 / 가져오기
  // ============================================================

  async exportConversation() {
    try {
      // StorageManager를 통해 내보내기
      if (typeof StorageManager !== 'undefined') {
        const filename = await StorageManager.exportConversationToFile();
        this.showToast(`대화를 내보냈어요! 📥\n${filename}`, 'success');
      } else {
        // IndexedDB 직접 사용 (side panel 컨텍스트)
        const filename = await indexedDBStorage.exportToFile();
        this.showToast(`대화를 내보냈어요! 📥\n${filename}`, 'success');
      }
    } catch (err) {
      this.showToast('내보내기에 실패했어요... (´•ω•̥`)', 'error');
      console.error('[반려AI] 내보내기 실패:', err);
    }
  }

  async importConversation(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!confirm(`'${file.name}' 파일에서 대화를 가져올까요?\n현재 대화는 유지되고, 백업 내용이 추가됩니다!`)) {
      event.target.value = '';
      return;
    }

    try {
      let result;
      if (typeof StorageManager !== 'undefined') {
        result = await StorageManager.importConversationFromFile(file);
      } else {
        result = await indexedDBStorage.importFromFile(file);
      }

      this.showToast(`대화 ${result.imported}개를 가져왔어요! 📤`, 'success');

      // 채팅 새로고침
      await this.loadHistory();
      this.updateStorageInfo();
    } catch (err) {
      this.showToast('파일 형식이 올바르지 않아요... 😢', 'error');
      console.error('[반려AI] 가져오기 실패:', err);
    }

    event.target.value = '';
  }

  async updateStorageInfo() {
    const infoEl = document.getElementById('storage-info');
    if (!infoEl) return;

    try {
      let info;
      if (typeof StorageManager !== 'undefined') {
        info = await StorageManager.getStorageInfo();
      } else if (typeof indexedDBStorage !== 'undefined') {
        info = await indexedDBStorage.getStorageInfo();
      } else {
        infoEl.innerHTML = '<span>저장소 정보를 불러올 수 없어요</span>';
        return;
      }

      infoEl.innerHTML =
        `<span>📊 총 대화: <b>${info.totalMessagesEver?.toLocaleString() || info.messageCount}</b>개</span><br>` +
        `<span>💾 예상 용량: <b>${info.estimatedSizeKB || '0'} KB</b></span>`;
    } catch (err) {
      infoEl.innerHTML = '<span>저장소 정보를 불러올 수 없어요</span>';
    }
  }

  /**
   * 토스트 메시지 표시
   */
  showToast(message, type = 'info', durationMs = 2500) {
    // 기존 토스트 제거
    const existing = document.querySelector('.haru-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `haru-toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'error' ? '#FFCDD2' : type === 'success' ? '#C8E6C9' : '#E3F2FD'};
      color: #5D4037;
      padding: 10px 20px;
      border-radius: 16px;
      font-size: 13px;
      z-index: 9999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      animation: toastIn 0.3s ease;
      text-align: center;
      white-space: pre-line;
      max-width: 280px;
      pointer-events: none;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, Math.max(1200, Number(durationMs) || 2500));
  }

  // ============================================================
  // 대화 초기화
  // ============================================================

  async clearHistory() {
    if (!confirm('정말로 대화 내역을 모두 지울까요? (´•ω•̥`)')) return;

    await chrome.runtime.sendMessage({ type: MSG_CLEAR_HISTORY });
    this.messagesContainer.innerHTML = '';

    // 초기 환영 메시지 다시 표시
    this.renderMessage({
      role: 'assistant',
      content: '대화를 새로 시작했어! 다시 만나서 반가워~ (╹◡╹)♡\n무슨 이야기 하고 싶어?',
      mood: 'smile',
      timestamp: nowISO()
    });
  }

  // ============================================================
  // Background 메시지 핸들러
  // ============================================================

  handleBackgroundMessage(msg) {
    switch (msg.type) {
      case MSG_NEW_MESSAGE:
        if(msg.data?.source==='proactive'&&this.cachedSettings?.focusMode){this.clearPoseSpeech();break;}
        this.renderMessage(msg.data);
        if (msg.data.role === 'assistant') {
          this.updateAvatarMood(msg.data.mood);
          this.showTyping(false,'broadcast');
          this.showPoseSpeech(['chat','proactive'].includes(msg.data.source)?CompanionPolicy.completion(msg.data.content,{source:msg.data.source==='proactive'?'proactive':'complete',id:msg.data.eventId}):null);
        }
        break;

      case MSG_ERROR:
        // 기타 오류는 토스트만 (업무 실패를 다운로드 결과로 만들지 않음)
        console.warn('[반려AI] 📡 MSG_ERROR 수신:', msg.data?.message);
        break;

      case MSG_TYPING:
        this.showTyping(msg.data.active,'broadcast');
        break;

      case MSG_SETTINGS_LOADED:
        this.applySettingsToUI({ ...msg.data.settings, ...(msg.data.api || {}) });
        break;
    }
  }
}

// --- 전역 인스턴스 (DOM 로드 후 초기화) ---
let controller;
document.addEventListener('DOMContentLoaded', () => {
  controller = new SidePanelController();
});
