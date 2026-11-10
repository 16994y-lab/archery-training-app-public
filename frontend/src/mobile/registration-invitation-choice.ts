// Only user-entered invitation text goes here. The bearer capability and server
// request journal continue to live in the private registration database.
type Draft={code:string; tag:string|null; revision:string; dirty?:true};
export type InvitationChoice={kind:'none'|'selected'|'unavailable'; code:string; revision?:string};
const none:InvitationChoice={kind:'none',code:''};
const tabKey=(service:string)=>'gxj.signup.tab.v1:'+service;
const key=(service:string,tag:string)=>'gxj.signup.choice.v1:'+service+':'+tag;
const pendingMemory=new Map<string,Draft>();
const localNumber=(phone:string)=>phone.replace(/^\+86/,'');
let resolvedPhone='',resolvedTag='';
export const invitationPhoneReady=(phone:string)=>!/^1[3-9]\d{9}$/.test(localNumber(phone)) || resolvedPhone===localNumber(phone);
async function phoneTag(phone:string){
  const number=localNumber(phone);
  if(!/^1[3-9]\d{9}$/.test(number))throw Error();
  if(number===resolvedPhone)return resolvedTag;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('+86'+number));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
function decode(raw:string|null):Draft|null{
  if(raw===null)return null;
  const value=JSON.parse(raw);
  if(typeof value?.code!=='string'||value.code.length>32||typeof value.revision!=='string'||
    !(value.tag===null||typeof value.tag==='string'&&/^[a-f0-9]{64}$/.test(value.tag)))throw Error();
  return value as Draft;
}
function tab(service:string){return pendingMemory.get(service)??decode(sessionStorage.getItem(tabKey(service)));}
function setTab(service:string,draft:Draft|null){
  if(draft)sessionStorage.setItem(tabKey(service),JSON.stringify(draft));else sessionStorage.removeItem(tabKey(service));
  pendingMemory.delete(service);
}
const selected=(v:Draft):InvitationChoice=>({kind:'selected',code:v.code,revision:v.revision});
export function readInvitationChoice(service:string):InvitationChoice{
  try{
    const v=tab(service);
    return pendingMemory.has(service)?{kind:'unavailable',code:v?.code??''}:v?selected(v):none;
  }catch{return {kind:'unavailable',code:pendingMemory.get(service)?.code??''};}
}
export function rememberInvitationCode(service:string,code:string,phone:string){
  const number=localNumber(phone);
  const v:Draft={code:code.trim(),tag:number&&number===resolvedPhone?resolvedTag:null,revision:crypto.randomUUID()};
  const pending:Draft={...v,dirty:true};
  pendingMemory.set(service,pending);
  try{
    // If durable storage rejects this edit, a reload must still require it.
    setTab(service,pending);
    if(v.tag)localStorage.setItem(key(service,v.tag),JSON.stringify(v));
    setTab(service,v);
  }catch{pendingMemory.set(service,pending);}
}
export async function restoreInvitationPhone(service:string,phone:string,current:()=>boolean):Promise<InvitationChoice>{
  try{
    const tag=await phoneTag(phone);
    if(!current())return none;
    resolvedPhone=localNumber(phone);resolvedTag=tag;
    const previous=tab(service),slot=key(service,tag);
    let v=decode(localStorage.getItem(slot));
    if(v && v.tag!==tag)throw Error();
    // An unbound draft is text explicitly typed before a full number existed.
    // Never move an already-bound selection from another number into this slot.
    if(previous && (previous.tag===null || previous.dirty && previous.tag===tag)){
      v={code:previous.code,revision:previous.revision,tag};
      localStorage.setItem(slot,JSON.stringify(v));
    }
    setTab(service,v);
    return v?selected(v):none;
  }catch{return {kind:'unavailable',code:readInvitationChoice(service).code};}
}
export async function finishInvitationChoice(service:string,phone:string,revision:string){
  const tag=await phoneTag(phone),slot=key(service,tag);
  if(decode(localStorage.getItem(slot))?.revision===revision)localStorage.removeItem(slot);
  if(tab(service)?.revision===revision)setTab(service,null);
}
