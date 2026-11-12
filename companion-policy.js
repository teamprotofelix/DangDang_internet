// Shared fixed reactions and non-sensitive companion policy. No LLM or storage access.
(() => {
  const LEVELS=Object.freeze({calm:{autoMin:120000,autoMax:240000,restAfter:180000,wanderFactor:2},normal:{autoMin:60000,autoMax:120000,restAfter:120000,wanderFactor:1},lively:{autoMin:30000,autoMax:60000,restAfter:90000,wanderFactor:.65}});
  const RULES=Object.freeze({reactionMax:24,replyMax:40,duration:2000,maxDuration:3000,cooldown:1200,petCooldown:3000,petHold:2100});
  const WORDS=Object.freeze({reunion:'다시 만나서 반가워!',reunion_long:'많이 보고 싶었어!',suggest_play:'공놀이도 해 볼까?',suggest_paw:'손 놀이도 해 볼까?',suggest_sit:'잠깐 앉아 볼까?',suggest_come:'같이 있어 볼까?',suggest_pet:'쓰다듬어 줄래?',come:'여기로 갈게!',sit:'얌전히 앉았어.',paw:'여기!',play:'공놀이하자!',pet:'헤헤, 좋아!',greeting:'안녕 멍!',waiting:'생각 중이야…',complete:'이야기해 줘서 고마워!',proactive:'잠깐 인사하러 왔어!',wander:'천천히 구경 중이야.',error:'잠깐 쉬었다 해보자.'});
  const explicit=new Set(['pet','greeting','come','sit','paw','play']);
  function graphemes(value){
    const text=String(value??'');
    if(typeof Intl!=='undefined'&&Intl.Segmenter)return [...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(x=>x.segment);
    const result=[];let regional=0,join=false;
    for(const c of text){const mark=/[\p{Mark}\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u.test(c),flag=/[\u{1F1E6}-\u{1F1FF}]/u.test(c);
      if(result.length&&(mark||join||c==='\u200d'||(flag&&regional%2===1)))result[result.length-1]+=c;else result.push(c);
      join=c==='\u200d';regional=flag?regional+1:0;
    }return result;
  }
  function plain(text){return typeof text==='string'&&!/[\r\n`|<>]/.test(text)&&!/(?:https?:\/\/|www\.)/i.test(text)&&!/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s)/m.test(text);}
  function validReaction(text){return plain(text)&&text.trim()===text&&graphemes(text).length>0&&graphemes(text).length<=RULES.reactionMax&&(text.match(/[.!?。！？]/gu)||[]).length<=1;}
  function briefReply(text){return typeof text==='string'&&plain(text)&&graphemes(text).length<=RULES.replyMax&&text.trim().length>0;}
  function reaction(source,id){if(!Object.hasOwn(WORDS,source))return null;return {type:'companion_reaction',source,id:String(id||source),text:WORDS[source]};}
  function completion(text,{source='complete',id}={}){return briefReply(text)?reaction(source,id):null;}
  function validPacket(p){return !!p&&p.type==='companion_reaction'&&Object.hasOwn(WORDS,p.source)&&p.text===WORDS[p.source]&&typeof p.id==='string'&&p.id.length>0&&validReaction(p.text);}
  function allowed(p,{enabled=false,active=true,focusMode=false}={}){return validPacket(p)&&enabled&&active&&(!focusMode||explicit.has(p.source));}
  class ReactionGate{
    constructor(now=()=>Date.now()){this.now=now;this.seen=new Map();this.last=-Infinity;}
    has(id){return this.seen.has(id);}
    take(p,context){if(!allowed(p,context)||this.has(p.id))return false;const at=this.now();this.seen.set(p.id,at);while(this.seen.size>64)this.seen.delete(this.seen.keys().next().value);if(at-this.last<RULES.cooldown&&!explicit.has(p.source))return false;this.last=at;return true;}
  }
  function chooseBubble(avatar,bubble,viewport,gap=8){
    const pad=4,w=bubble.width,h=bubble.height,left=viewport.left||0,top=viewport.top||0,right=left+viewport.width,bottom=top+viewport.height;
    if(w<=0||h<=0||w>viewport.width-2*pad||h>viewport.height-2*pad||avatar.right<=left||avatar.left>=right||avatar.bottom<=top||avatar.top>=bottom)return null;
    const clampX=x=>Math.max(left+pad,Math.min(right-w-pad,x)),clampY=y=>Math.max(top+pad,Math.min(bottom-h-pad,y));
    const points=[{x:clampX((avatar.left+avatar.right-w)/2),y:avatar.top-gap-h},{x:clampX((avatar.left+avatar.right-w)/2),y:avatar.bottom+gap},{x:avatar.left-gap-w,y:clampY((avatar.top+avatar.bottom-h)/2)},{x:avatar.right+gap,y:clampY((avatar.top+avatar.bottom-h)/2)}];
    return points.find(p=>p.x>=left+pad&&p.y>=top+pad&&p.x+w<=right-pad&&p.y+h<=bottom-pad&&(p.x+w<=avatar.left-gap||p.x>=avatar.right+gap||p.y+h<=avatar.top-gap||p.y>=avatar.bottom+gap))||null;
  }
  function settings(s={}){return {movementLevel:Object.hasOwn(LEVELS,s.movementLevel)?s.movementLevel:'normal',focusMode:s.focusMode===true};}
  globalThis.CompanionPolicy={LEVELS,RULES,WORDS,graphemes,validReaction,briefReply,reaction,completion,validPacket,allowed,ReactionGate,chooseBubble,settings};
})();
