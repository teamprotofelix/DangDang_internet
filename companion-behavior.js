// Per-view state controller. Priority: inactive > drag > newest explicit command/pet > busy > move > auto > actual mood.
(() => {
 const COMMANDS=Object.freeze({come:{label:'이리 와',duration:5000},sit:{label:'앉아',duration:2600},paw:{label:'손',duration:2600},play:{label:'공놀이',duration:6500}});
 class Controller{
  constructor(view,{onReaction=()=>{},onState=()=>{},onCancelMove=()=>{},onCommandStart=()=>{},onCommandEnd=()=>{},onInteractionStart=()=>{},onInteractionEnd=()=>{},now=()=>Date.now(),random=Math.random,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),environment=true,visible=true}={}){
   this.view=view;this.onReaction=onReaction;this.onState=onState;this.onCancelMove=onCancelMove;this.onCommandStart=onCommandStart;this.onCommandEnd=onCommandEnd;this.onInteractionStart=onInteractionStart;this.onInteractionEnd=onInteractionEnd;this.intentVersion=0;this.memoryEnabled=false;this.memoryProactive=false;this.commandTimers=new Set();this.activeCommand=null;this.now=now;this.random=random;this.setTimer=setTimer;this.clearTimer=clearTimer;
   this.actualMood='default';this.behavior='idle';this.visible=visible;this.active=true;this.settings=CompanionPolicy.settings();this.busy=new Map();this.sequence=0;this.generation=0;this.timers=new Set();this.lastActivity=now();this.petAt=-Infinity;this.temporary=null;
   if(environment){this.events=new AbortController();const listen=(target,type,fn)=>target.addEventListener(type,fn,{signal:this.events.signal});this.media=matchMedia('(prefers-reduced-motion: reduce)');
    listen(document,'visibilitychange',()=>this.syncActive());listen(window,'pagehide',e=>{if(e.persisted){this.suspended=true;this.syncActive();}else this.destroy();});listen(window,'pageshow',()=>{this.suspended=false;this.syncActive();});listen(this.media,'change',()=>{this.touchIntent();this.cancelCommand('motion');this.cancelTemporary(true);this.render();this.schedule();});}
   this.view.onActionError=()=>{if(this.activeCommand)this.activeCommand.failed=true;};
   this.syncActive();
  }
  later(fn,ms){const id=this.setTimer(()=>{this.timers.delete(id);if(!this.dead)fn();},ms);this.timers.add(id);return id;}
  clear(id){if(id!==undefined&&id!==null){this.clearTimer(id);this.timers.delete(id);}}
  cancelAutomatic(){if(this.temporary?.automatic){this.generation++;this.cancelTemporary();this.render();this.schedule();}}
  touchIntent(){this.intentVersion++;if(this.temporary?.kind==='reunion'){this.cancelTemporary();this.render();this.schedule();}}
  setPlayMemoryPolicy(enabled,proactive){if(this.memoryEnabled===enabled&&this.memoryProactive===proactive)return;this.memoryEnabled=!!enabled;this.memoryProactive=!!proactive;this.touchIntent();if((!enabled||!proactive)&&this.temporary?.kind==='time-rest')this.cancelTemporary();this.render();this.schedule();}
  showReunion(mood){if(!this.memoryEnabled||!this.memoryProactive)return false;return this.temporaryReaction('reunion',mood,1400,true);}
  activity(){this.lastActivity=this.now();if(['rest','time-rest'].includes(this.temporary?.kind)){this.cancelTemporary();this.render();}}
  configure(s){const next=CompanionPolicy.settings(s),changed=next.focusMode!==this.settings.focusMode||next.movementLevel!==this.settings.movementLevel;this.settings=next;if(changed){this.touchIntent();this.generation++;this.cancelCommand('settings');this.cancelTemporary();if(next.focusMode)this.onCancelMove();this.render();this.schedule();}}
  setMood(mood){this.touchIntent();this.actualMood=mood||'default';this.render();}
  setBehavior(behavior){if(behavior==='dragging'||behavior==='paused'){this.touchIntent();this.cancelCommand(behavior);this.generation++;this.cancelTemporary();this.activity();}this.behavior=behavior;this.render();this.schedule();}
  setVisible(visible){this.visible=!!visible;this.syncActive();}
  syncActive(){if(this.dead)return;const next=this.visible&&!this.suspended&&!(typeof document!=='undefined'&&document.hidden);this.active=next;if(!next){this.touchIntent();this.generation++;this.cancelCommand('hidden');this.cancelTemporary();this.clear(this.autoTimer);this.autoTimer=null;}this.view.setVisible(next);this.render();if(next)this.schedule();}
  beginBusy(source,mood='think'){this.touchIntent();const token=++this.sequence;this.busy.set(source,{token,mood});this.cancelTemporary(true);if(!this.activeCommand&&this.temporary?.kind!=='pet')this.onCancelMove();this.render();this.schedule();return token;}
  endBusy(token){for(const [source,value] of this.busy)if(value.token===token)this.busy.delete(source);this.render();this.schedule();}
  setBusy(source,active,mood='think'){if(active)return this.busy.get(source)?.token||this.beginBusy(source,mood);const entry=this.busy.get(source);if(entry)this.endBusy(entry.token);}
  cancelTemporary(automaticOnly=false){if(this.temporary&&(!automaticOnly||this.temporary.automatic)){this.generation++;this.clear(this.tempTimer);this.clear(this.petSmileTimer);this.petSmileTimer=null;this.tempTimer=null;const cancelled=this.temporary;this.temporary=null;if(cancelled.kind==='pet')this.onInteractionEnd({name:'pet',kind:'pet',token:cancelled.token,completed:false});}}
  temporaryReaction(kind,mood,duration,automatic=false,after=null){if(this.dead||!this.active||this.activeCommand||['dragging','paused'].includes(this.behavior)||(this.temporary?.kind==='pet'&&kind!=='pet')||(automatic&&(this.settings.focusMode||this.busy.size||this.temporary?.kind==='pet'||(this.media?.matches&&kind!=='reunion'))))return false;
   this.clear(this.autoTimer);this.autoTimer=null;this.cancelTemporary();const generation=++this.generation;this.temporary={kind,mood,automatic,token:generation};this.render();this.tempTimer=this.later(()=>{if(generation!==this.generation)return;const finished=this.temporary;this.temporary=null;this.tempTimer=null;this.render();if(finished?.kind==='pet')this.onInteractionEnd({name:'pet',kind:'pet',token:finished.token,completed:true});if(after&&this.active&&!this.settings.focusMode&&!this.busy.size&&this.behavior!=='dragging')after();this.schedule();},duration);return true;}
  pet(){if(this.now()-this.petAt<CompanionPolicy.RULES.petCooldown||!this.active||this.behavior==='dragging'||this.dead)return false;this.touchIntent();this.activity();this.cancelCommand('pet');this.petAt=this.now();this.onCancelMove();const ok=this.temporaryReaction('pet','aegyo',CompanionPolicy.RULES.petHold);if(ok){const generation=this.generation;this.onInteractionStart({name:'pet',kind:'pet',token:generation});this.petSmileTimer=this.later(()=>{this.petSmileTimer=null;if(this.temporary?.kind==='pet'&&generation===this.generation){this.temporary.mood='smile';this.render();}},1600);this.onReaction(CompanionPolicy.reaction('pet','pet-'+(++this.sequence)));}return ok;}
  perform(name){
   if(!Object.hasOwn(COMMANDS,name)||this.dead||!this.active||['dragging','paused'].includes(this.behavior)||this.activeCommand?.name===name)return false;
   this.touchIntent();this.activity();this.cancelCommand('replaced');this.cancelTemporary();this.clear(this.autoTimer);this.autoTimer=null;this.onCancelMove();
   const token=++this.generation;this.activeCommand={name,token,phase:'pose'};this.onInteractionStart({name,kind:'command',token});this.render();
   this.commandLater(token,()=>this.finishCommand(token),this.media?.matches?1300:COMMANDS[name].duration);
   this.onReaction(CompanionPolicy.reaction(name,'command-'+token));
   try{this.onCommandStart({...this.activeCommand,reduced:!!this.media?.matches,level:this.settings.movementLevel});}catch(_){this.failCommand(token);}
   return true;
  }
  commandLater(token,fn,ms){const id=this.later(()=>{this.commandTimers.delete(id);if(this.activeCommand?.token===token)fn();},ms);this.commandTimers.add(id);return id;}
  commandPhase(token,phase){if(this.activeCommand?.token!==token)return false;this.activeCommand.phase=phase;this.render();return true;}
  cancelCommand(reason='cancelled'){
   if(!this.activeCommand)return false;if(reason!=='complete')this.touchIntent();const previous=this.activeCommand;this.activeCommand=null;this.generation++;
   for(const id of this.commandTimers)this.clear(id);this.commandTimers.clear();this.onCommandEnd({...previous,reason});this.render();this.schedule();this.onInteractionEnd({name:previous.name,kind:'command',token:previous.token,completed:reason==='complete'&&!previous.failed});return true;
  }
  failCommand(token){if(this.activeCommand?.token!==token)return false;this.activeCommand.failed=true;return this.cancelCommand('failed');}
  finishCommand(token){if(this.activeCommand?.token!==token)return false;return this.cancelCommand('complete');}
  lookThenWalk(after){return this.temporaryReaction('look','think',900,true,after);}
  schedule(){this.clear(this.autoTimer);this.autoTimer=null;if(this.dead||!this.active||this.settings.focusMode||this.media?.matches||['dragging','paused','walk'].includes(this.behavior)||this.busy.size||this.temporary||this.activeCommand)return;
   const level=CompanionPolicy.LEVELS[this.settings.movementLevel];this.autoTimer=this.later(()=>{this.autoTimer=null;const rest=this.now()-this.lastActivity>=level.restAfter,night=this.memoryEnabled&&this.memoryProactive&&globalThis.PlayMemory?.period(this.now())==='late';this.temporaryReaction(rest?'rest':night?'time-rest':'look',rest||night?'sleepy':'think',rest||night?4200:1600,true);},level.autoMin+this.random()*(level.autoMax-level.autoMin));}
  render(){if(this.dead)return;let mood=this.actualMood,behavior=this.behavior,kind='mood';
   if(!this.active||behavior==='paused'){behavior='paused';kind='paused';}
   else if(behavior==='dragging'||behavior==='paused'){kind='dragging';}
   else if(this.activeCommand){behavior=this.activeCommand.phase==='moving'?'walk':`command:${this.activeCommand.name}:${this.activeCommand.token}`;kind='command';}
   else if(this.temporary?.kind==='pet'){mood=this.temporary.mood;behavior='idle';kind='pet';}
   else if(this.busy.size){mood=[...this.busy.values()].at(-1).mood;behavior='idle';kind='busy';}
   else if(behavior==='walk'){kind='walk';}
   else if(this.temporary){mood=this.temporary.mood;behavior='idle';kind=this.temporary.kind;}
   this.state={mood,behavior,kind,actualMood:this.actualMood,command:this.activeCommand?{...this.activeCommand}:null};this.view.update(mood,behavior);this.onState(this.state);
  }
  destroy(){if(this.dead)return;this.cancelCommand('destroy');this.dead=true;this.generation++;this.events?.abort();for(const id of this.timers)this.clearTimer(id);this.timers.clear();this.busy.clear();this.temporary=null;this.view.destroy();}
 }
 globalThis.CompanionBehavior={Controller,COMMANDS};
})();
