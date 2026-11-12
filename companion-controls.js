// Local-only controls and independent ball object. No storage, messages or LLM.
(() => {
 const LABELS={come:'이리 와',sit:'앉아',paw:'손',play:'공놀이'};
 const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
 function rect(left,top,width,height){return {left,top,right:left+width,bottom:top+height,width,height};}
 function plan(avatar,viewport,name,level='normal',obstacles=[]){
  const range={calm:80,normal:120,lively:160}[level]||120,pad=12;
  const minX=viewport.left+pad,maxX=viewport.right-avatar.width-pad,minY=viewport.top+pad,maxY=viewport.bottom-avatar.height-pad;
  if(maxX<minX||maxY<minY)return null;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const safe=(target,ball)=>{
   const sweep={left:Math.min(avatar.left,target.left,ball?.start.left??Infinity,ball?.end.left??Infinity),top:Math.min(avatar.top,target.top,ball?.start.top??Infinity,ball?.end.top??Infinity),right:Math.max(avatar.right,target.right,ball?.start.right??-Infinity,ball?.end.right??-Infinity),bottom:Math.max(avatar.bottom,target.bottom,ball?.start.bottom??-Infinity,ball?.end.bottom??-Infinity)};
   return sweep.left>=viewport.left&&sweep.top>=viewport.top&&sweep.right<=viewport.right&&sweep.bottom<=viewport.bottom&&!obstacles.some(r=>overlap(sweep,r));
  };
  if(name==='come'){
   const x=(minX+maxX)/2,y=maxY,dx=x-avatar.left,dy=y-avatar.top,d=Math.hypot(dx,dy),factor=d?Math.min(1,range/d):0;
   const target=rect(clamp(avatar.left+dx*factor,minX,maxX),clamp(avatar.top+dy*factor,minY,maxY),avatar.width,avatar.height);
   return safe(target)?{target,ball:null}:null;
  }
  for(const direction of [-1,1]){
   const from=minX+(direction<0?26:0),to=maxX-(direction>0?26:0);if(to<from)continue;
   const x=clamp(avatar.left+direction*range,from,to),distance=Math.abs(x-avatar.left);
   if(distance<40)continue;
   const target=rect(x,clamp(avatar.top,minY,maxY),avatar.width,avatar.height),size=18;
   const ball={start:rect(direction<0?avatar.left-size-8:avatar.right+8,avatar.top+48,size,size),end:rect(direction<0?target.left-size-8:target.right+8,target.top+48,size,size)};
   if(safe(target,ball))return {target,ball};
  }return null;
 }
 function create(onCommand){
  const element=document.createElement('div');element.className='companion-controls';element.setAttribute('role','group');element.setAttribute('aria-label','댕댕이 교감과 재롱');
  const events=new AbortController(),buttons={};
  for(const [name,label] of Object.entries(LABELS)){
   const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.command=name;button.setAttribute('aria-label','댕댕이 '+label);button.title=label+' · 같은 동작은 끝날 때까지 다시 시작하지 않아요';
   for(const type of ['mousedown','touchstart','dblclick'])button.addEventListener(type,e=>e.stopPropagation(),{signal:events.signal});
   button.addEventListener('click',e=>{e.stopPropagation();onCommand(name);},{signal:events.signal});element.appendChild(button);buttons[name]=button;
  }
  const status=document.createElement('span');status.className='companion-command-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');element.appendChild(status);
  let previous=null;
  return {element,buttons,status,recommend(action){for(const [name,b] of Object.entries(buttons)){b.toggleAttribute('data-suggested',name===action);b.title=LABELS[name]+(name===action?' · 함께 해 볼까요?':' · 같은 동작은 끝날 때까지 다시 시작하지 않아요');}},announce:text=>{status.textContent=text;},update(state){
   const inactive=state.kind==='paused'||state.kind==='dragging';
   for(const [name,b] of Object.entries(buttons)){b.disabled=inactive||state.command?.name===name;b.setAttribute('aria-busy',state.command?.name===name?'true':'false');}
   const token=state.command?.token??null;
   if(token!==previous){status.textContent=state.command?LABELS[state.command.name]+' 동작 중':inactive?'지금은 잠깐 쉬고 있어요.':'동작을 마쳤어요.';previous=token;}
  },destroy(){events.abort();}};
 }
 class Ball{
  constructor(container,{fixed=false,url=CompanionAssets.ball,size=18,onError=()=>{}}={}){
   // Exactly one ball per owning play field, independent of the dog's Canvas.
   container.querySelectorAll('.companion-ball').forEach(b=>b.remove());this.element=document.createElement('img');this.element.className='companion-ball';this.element.alt='';this.element.setAttribute('aria-hidden','true');
   this.element.style.cssText=`position:${fixed?'fixed':'absolute'};width:${size}px;height:${size}px;pointer-events:none;`;this.element.onerror=()=>{if(!this.dead){this.destroy();onError();}};
   this.element.src=chrome.runtime.getURL(url);container.appendChild(this.element);
  }
  roll(start,end,{duration=700,motion=true,done=()=>{}}={}){
   if(this.dead)return;this.element.style.left=start.left+'px';this.element.style.top=start.top+'px';
   if(!motion){this.element.style.left=end.left+'px';this.element.style.top=end.top+'px';return;}
   this.animation=this.element.animate([{transform:'translate(0,0) rotate(0deg)'},{transform:`translate(${end.left-start.left}px,${end.top-start.top}px) rotate(210deg)`}],{duration,easing:'ease-out',fill:'forwards'});
   this.animation.finished.then(()=>{if(!this.dead)done();},()=>{});
  }
  destroy(){if(this.dead)return;this.dead=true;this.animation?.cancel();this.element.onerror=null;this.element.remove();}
 }
 globalThis.CompanionControls={create,Ball,plan,rect};
})();
