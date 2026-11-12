// Shared Canvas renderer. No storage, messages, LLM calls, or worker frame timers.
(() => {
  const assets=new Map(), posters=new Map();
  const pendingCaches=new WeakMap([[assets,new Map()],[posters,new Map()]]);
  const limits={atlases:4,posters:8};
  function cached(map,key,limit,create) {
    if (map.has(key)) { const value=map.get(key); map.delete(key); map.set(key,value); return value; }
    const pending=pendingCaches.get(map);
    if(pending.has(key))return pending.get(key);
    const value=create(); map.set(key,value);pending.set(key,value);
    const settled=()=>{if(pending.get(key)===value)pending.delete(key);};
    value.then(settled,settled);
    while(map.size>limit) map.delete(map.keys().next().value);
    value.catch(()=>{if(map.get(key)===value)map.delete(key);});
    return value;
  }
  async function decodeImage(url) { const image=new Image(); image.src=url; await image.decode(); return image; }
  function frameAt(clip,elapsed) {
    const total=clip.durations.reduce((a,b)=>a+b,0);
    let t=clip.loop?elapsed%total:Math.min(elapsed,total-.001);
    for(let i=0;i<clip.durations.length;i++){if(t<clip.durations[i])return clip.sequence[i];t-=clip.durations[i];}
    return clip.sequence.at(-1);
  }
  function advancePosition(position,target,deltaMs,speed=90) {
    const dx=target.x-position.x,dy=target.y-position.y,distance=Math.hypot(dx,dy);
    const step=Math.min(distance,speed*Math.min(Math.max(deltaMs,0),50)/1000);
    return {x:position.x+(distance?dx/distance*step:0),y:position.y+(distance?dy/distance*step:0),done:distance<=step};
  }
  function loadAsset(url) {
    return cached(assets,url,limits.atlases,async()=>{
      const response=await fetch(url);if(!response.ok)throw Error('atlas load');
      const data=await response.json();const image=await decodeImage(new URL(data.image,url).href);
      if(!Array.isArray(data.frameSize)||data.frameSize.length!==2||!data.frameSize.every(n=>Number.isInteger(n)&&n>0))throw Error('frame size');
      if(!Array.isArray(data.anchor)||data.anchor.length!==2||!data.anchor.every((n,i)=>Number.isFinite(n)&&n>=0&&n<=data.frameSize[i]))throw Error('anchor');
      if(!data.clips||!Object.keys(data.clips).length)throw Error('clips');
      for(const clip of Object.values(data.clips)) {
        if(!clip.frames?.length||!clip.sequence?.length||clip.durations?.length!==clip.sequence.length||
          !clip.durations.every(n=>Number.isFinite(n)&&n>0)||!clip.sequence.every(n=>Number.isInteger(n)&&clip.frames[n]))throw Error('clip');
        if(clip.holdFrame!==undefined&&(!Number.isInteger(clip.holdFrame)||!clip.frames[clip.holdFrame]))throw Error('hold frame');
        for(const r of clip.frames)if(r.length!==4||!r.every(Number.isInteger)||r[0]<0||r[1]<0||r[2]!==data.frameSize[0]||r[3]!==data.frameSize[1]||r[0]+r[2]>image.naturalWidth||r[1]+r[3]>image.naturalHeight)throw Error('rect');
      }
      return {data,image};
    });
  }
  class Player {
    constructor(canvas,{onFallback=()=>{},onReady=()=>{},onComplete=()=>{},size=64,raf=fn=>globalThis.requestAnimationFrame(fn),caf=id=>globalThis.cancelAnimationFrame(id)}={}) {
      this.canvas=canvas;this.ctx=canvas.getContext('2d');this.onFallback=onFallback;this.onReady=onReady;this.onComplete=onComplete;
      this.size=size;this.raf=raf;this.caf=caf;this.id=null;this.elapsed=0;this.last=null;
      this.paused=false;this.dead=false;this.generation=0;this.facing=1;this.rate=1;this.hasDrawn=false;
      this.asset=null;this.name=null;this.completed=false;this.static=false;
      this.resize();
    }
    resize(){const dpr=Math.min(globalThis.devicePixelRatio||1,2);this.canvas.width=this.canvas.height=Math.round(this.size*dpr);this.drawKey=null;this.hasDrawn=false;this.draw();}
    invalidate(){return ++this.generation;}
    async play(name,url,{returnTo=null}={}) {
      if(this.dead)return false;
      // Reuse is a new intent too: preserve the PR1/e95a672 stale-load fix.
      const generation=this.invalidate();
      if(this.name===name&&this.url===url&&this.asset){this.activeGeneration=generation;this.schedule();return true;}
      try {
        const asset=await loadAsset(url);
        if(this.dead||generation!==this.generation)return false;
        const clip=asset.data.clips[name];if(!clip)throw Error('missing clip');
        this.asset=asset;this.clip=clip;this.name=name;this.url=url;this.returnTo=returnTo;
        this.activeGeneration=generation;this.completed=false;this.static=false;this.heldFrame=null;
        this.lastError=null;this.elapsed=0;this.last=null;this.drawKey=null;this.draw();this.onReady();this.schedule();return true;
      }catch(error){return this.failed(error,generation);}
    }
    async showPoster(name,url,{anchor=null}={}) {
      if(this.dead)return false;const generation=this.invalidate();
      if(this.static&&this.name===name&&this.url===url&&this.asset){this.activeGeneration=generation;return true;}
      try {
        const image=await cached(posters,url,limits.posters,()=>decodeImage(url));
        if(this.dead||generation!==this.generation)return false;
        const w=image.naturalWidth,h=image.naturalHeight;if(!w||!h)throw Error('poster size');
        this.halt();this.asset={image,data:{frameSize:[w,h],anchor:anchor||[w/2,h/2]}};
        this.clip={frames:[[0,0,w,h]],sequence:[0],durations:[1],loop:false};
        this.name=name;this.url=url;this.activeGeneration=generation;this.static=true;this.completed=true;this.heldFrame=0;
        this.elapsed=0;this.drawKey=null;this.lastError=null;this.draw();this.onReady();return true;
      }catch(error){return this.failed(error,generation);}
    }
    failed(error,generation) {
      if(!this.dead&&generation===this.generation){this.lastError=error.message;this.invalidate();this.pause();this.onFallback();}
      return false;
    }
    draw() {
      if(!this.asset||!this.ctx)return;
      const frame=this.heldFrame??frameAt(this.clip,this.elapsed),key=`${this.url}:${frame}:${this.facing}:${this.canvas.width}`;
      if(this.drawKey===key)return;this.drawKey=key;
      const [x,y,w,h]=this.clip.frames[frame],ctx=this.ctx,size=this.canvas.width;
      const [ax,ay]=this.asset.data.anchor,[fw,fh]=this.asset.data.frameSize;
      const anchorX=size*ax/fw,anchorY=size*ay/fh;
      ctx.clearRect(0,0,size,size);ctx.save();ctx.translate(anchorX,anchorY);ctx.scale(this.facing,1);
      ctx.drawImage(this.asset.image,x,y,w,h,-anchorX,-anchorY,size,size);ctx.restore();this.hasDrawn=true;
    }
    schedule() {
      if(this.dead||this.paused||!this.asset||this.completed||this.static||this.id!==null)return;
      this.id=this.raf(t=>{
        this.id=null;if(this.dead||this.paused)return;
        if(this.last!==null)this.elapsed+=Math.min(Math.max(t-this.last,0),50)*this.rate;this.last=t;
        const total=this.clip.durations.reduce((a,b)=>a+b,0);
        if(!this.clip.loop&&this.elapsed>=total){
          this.completed=true;this.heldFrame=this.clip.holdFrame??this.clip.sequence.at(-1);this.draw();this.halt();
          // An old one-shot must not enqueue its returnTo over a newer pending mood.
          if(this.activeGeneration===this.generation){
            const next=this.returnTo,finishedGeneration=this.generation;this.onComplete();
            if(next&&!this.dead&&finishedGeneration===this.generation)this.play(next.name,next.url);
          }
          return;
        }
        this.draw();this.schedule();
      });
    }
    halt(){if(this.id!==null)this.caf(this.id);this.id=null;this.last=null;}
    pause(){this.paused=true;this.halt();}
    resume(){if(!this.dead){this.paused=false;this.last=null;this.schedule();}}
    stop(){this.invalidate();this.pause();this.asset=null;this.name=null;}
    setFacing(direction){this.facing=direction==='left'?-1:1;this.draw();}
    setRate(rate){this.rate=Number.isFinite(rate)?Math.max(.75,Math.min(1.25,rate)):1;}
    destroy(){if(this.dead)return;this.stop();this.dead=true;this.onFallback=this.onReady=this.onComplete=()=>{};}
  }
  function normalize(mood){return (typeof normalizeMood==='function'?normalizeMood(mood):null)|| (Object.hasOwn(globalThis.CompanionAssets.moods,mood)?mood:'default');}
  class View {
    constructor(target,{size=64,visible=true,variant='body',url=p=>chrome.runtime.getURL(p)}={}) {
      if(target.tagName==='IMG')throw Error('Companion View requires a stable input container, not an image');
      target.companionView?.destroy();target.companionView=this;
      this.target=target;this.url=url;this.variant=variant;this.behavior='idle';this.mood='default';this.visible=visible;this.generation=0;
      this.canvas=document.createElement('canvas');this.canvas.className='companion-canvas';this.canvas.style.width=this.canvas.style.height=`${size}px`;
      this.canvas.setAttribute('aria-hidden','true');target.appendChild(this.canvas);
      this.player=new Player(this.canvas,{size,onComplete:()=>{if(!this.dead&&this.behavior!=='walk'){if(!this.behavior.startsWith('command:'))this.settledMood=this.mood;this.mode='hold';}}});
      this.media=matchMedia('(prefers-reduced-motion: reduce)');this.events=new AbortController();
      const listen=(t,type,fn)=>t.addEventListener(type,fn,{signal:this.events.signal});
      listen(document,'visibilitychange',()=>this.sync());listen(this.media,'change',()=>this.sync());listen(window,'resize',()=>this.player.resize());
      listen(window,'pagehide',e=>{if(e.persisted){this.suspended=true;this.sync();}else this.destroy();});
      listen(window,'pageshow',()=>{this.suspended=false;this.sync();});
      this.removal=new MutationObserver(()=>{if(!target.isConnected)this.destroy();});this.removal.observe(document.body,{childList:true,subtree:true});
      this.sync();
    }
    update(mood,behavior=this.behavior){const key=normalize(mood);if(key!==this.mood||(behavior!==this.behavior&&(behavior.startsWith('command:')||this.behavior.startsWith('command:'))))this.settledMood=null;this.mood=key;this.behavior=behavior;this.sync();}
    setVisible(visible){this.visible=!!visible;this.sync();}
    selection() {
      const registry=globalThis.CompanionAssets,entry=registry.moods[this.mood];
      if(this.variant==='face')return {key:`face:${this.mood}`,poster:entry.face,anchor:[96,96]};
      if(this.behavior.startsWith('command:')){const [,name,token]=this.behavior.split(':');const action=registry.actions?.[name];if(action)return {...action,key:`command:${name}:${token}`,action:true,atlas:!this.media.matches&&!this.posterOnly?action.atlas:null};}
      if(this.behavior==='walk'&&!this.media.matches)return {...registry.walk,key:'walk',poster:registry.moods.default.poster,anchor:registry.anchor};
      const animate=entry.atlas&&!this.posterOnly&&!this.media.matches&&this.behavior!=='dragging'&&this.settledMood!==this.mood;
      return {...entry,key:`${animate?'clip':'poster'}:${this.mood}`,atlas:animate?entry.atlas:null};
    }
    async poster(selection,generation) {
      const registry=globalThis.CompanionAssets,face=this.variant==='face';
      const candidates=[selection.poster,face?registry.moods.default.face:registry.moods.default.poster,face?registry.emergencyFace:registry.emergencyBody];
      if(this.posterGeneration!==generation){this.posterGeneration=generation;this.posterAttempts=new Set();this.posterSuccess=null;}
      if(this.posterSuccess&&this.player.static&&this.player.hasDrawn){this.mode=this.posterSuccess;return true;}
      for(const path of new Set(candidates)) {
        if(this.dead||generation!==this.generation)return false;
        if(this.posterAttempts.has(path))continue;this.posterAttempts.add(path);
        const ok=await this.player.showPoster(selection.key,path.startsWith('data:')?path:this.url(path),{anchor:path.startsWith('data:')?null:selection.anchor});
        if(this.dead||generation!==this.generation)return false;
        if(!ok&&selection.action&&path===selection.poster)this.onActionError?.();
        if(ok){this.mode=path.startsWith('data:')?'emergency':'poster';this.posterSuccess=this.mode;return true;}
      }
      this.mode='unavailable';return false; // Retain any last good pixels; never retry in a frame loop.
    }
    async sync() {
      if(this.dead)return;
      const active=this.visible&&!this.suspended&&!document.hidden&&this.behavior!=='paused';
      this.canvas.hidden=!active;
      const selection=this.selection(),key=`${active}:${selection.key}`;
      if(key===this.selectionKey)return;this.selectionKey=key;
      const generation=++this.generation;this.player.invalidate();this.player.pause();
      if(!active){this.mode='paused';return;}
      const first=!this.player.hasDrawn;
      if(first){
        this.mode='initial';
        const registry=globalThis.CompanionAssets;
        await this.player.showPoster('initial',this.variant==='face'?registry.emergencyFace:registry.emergencyBody);
        if(this.dead||generation!==this.generation)return;
      }
      if(first||!selection.atlas){await this.poster(selection,generation);}
      if(this.dead||generation!==this.generation||!selection.atlas)return;
      // Keep the current good frame while loading; the only drawable layer is this canvas.
      this.mode='loading';if(selection.action)this.player.stop();this.player.paused=false;
      const ok=await this.player.play(selection.clip,this.url(selection.atlas));
      if(this.dead||generation!==this.generation)return;
      if(ok){this.mode='animation';return;}
      if(selection.action)this.onActionError?.();
      await this.poster(selection,generation);
    }
    destroy(){if(this.dead)return;this.dead=true;this.generation++;this.player.destroy();this.events.abort();this.removal.disconnect();this.canvas.remove();if(this.target.companionView===this)delete this.target.companionView;}
  }
  globalThis.CompanionAnimation={Player,View,frameAt,advancePosition,loadAsset,cacheStats:()=>({atlases:assets.size,posters:posters.size,pendingAtlases:pendingCaches.get(assets).size,pendingPosters:pendingCaches.get(posters).size,limits:{...limits}})};
})();
