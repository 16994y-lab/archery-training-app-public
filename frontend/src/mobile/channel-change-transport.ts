import {normalizeTarget,parseReceipt,validChannelCode,type Action,type Actor,type ChannelKind,type ChannelTransport,type Receipt} from './channel-change-client';
import {readBoundedResponse} from './bounded-response';
type SessionSnapshot=Actor&{accessToken:string;serviceOrigin:string;supabaseOrigin:string;publishableKey:string};
export type ChannelTransportDependencies={
 readSession():SessionSnapshot|null;
 commitChannelFacts(facts:{owner:string;kind:ChannelKind;target:string;phoneVerified:true},actor:Actor):Promise<void>;
 fetcher?:typeof fetch;
};
const fields:Record<Action,string[]>={status:[], 'target-check':['kind','target'],begin:['kind','target','lost_channel'],'old-start':['intent'],'old-verify':['intent','target','token'],request:['intent','target'],verify:['intent','target','leg','token'],cancel:['intent'],reconcile:['intent']};
const validUuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const confirmedDate=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function origin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('服务地址尚未核对。');return u.origin;}
export function createChannelTransport(deps:ChannelTransportDependencies):ChannelTransport {
 const http=deps.fetcher??fetch;let last:{actor:Actor;receipt:Receipt}|null=null;
 const snapshot=(actor:Actor)=>{const s=deps.readSession();if(!s||s.owner!==actor.owner||s.sessionEpoch!==actor.sessionEpoch||!s.accessToken)throw new Error('账号状态已变化。');return {...s};};
 const same=(s:SessionSnapshot)=>{const n=deps.readSession();return !!n&&n.owner===s.owner&&n.sessionEpoch===s.sessionEpoch&&n.accessToken===s.accessToken&&n.serviceOrigin===s.serviceOrigin&&n.supabaseOrigin===s.supabaseOrigin&&n.publishableKey===s.publishableKey;};
 async function send(url:string,s:SessionSnapshot,signal:AbortSignal,method:string,body?:Readonly<Record<string,unknown>>,native=false){
  if(signal.aborted||!same(s))throw new Error('旧请求已取消。');
  const abort=new AbortController(),stop=()=>abort.abort(),timer=setTimeout(stop,20000);signal.addEventListener('abort',stop,{once:true});
  try{
   if(native&&!s.publishableKey)throw new Error('原认证服务尚未配置。');
   const response=await http(url,{method,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+s.accessToken,...(native?{apikey:s.publishableKey}:{})},body:method==='GET'?undefined:JSON.stringify(body),signal:abort.signal});
   if(signal.aborted||!same(s))throw new Error('旧响应已丢弃。');
   if(!response.ok)throw new Error('服务返回失败（'+response.status+'），请读取状态。');
   const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,1024*1024,abort.signal)));if(signal.aborted||!same(s))throw new Error('旧响应已丢弃。');
   if(!raw||typeof raw!=='object'||'access_token'in raw||'refresh_token'in raw||'session'in raw)throw new Error('服务结果未通过安全核对。');return raw as Record<string,unknown>;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',stop);}
 }
 return {
  async request(action,body,actor,signal){
   const s=snapshot(actor),allowed=fields[action];
   if(!allowed||Object.keys(body).some(k=>!allowed.includes(k))||allowed.some(k=>!(k in body)))throw new Error('更换请求格式无效。');
   if(action!=='status'&&action!=='begin'&&action!=='target-check'&&!validUuid(body.intent))throw new Error('请求编号无效。');
   if(action==='begin'||action==='target-check'){
    if(body.kind!=='email'&&body.kind!=='phone')throw new Error('渠道无效。');
    if(typeof body.target!=='string'||normalizeTarget(body.kind,body.target)!==body.target)throw new Error('目标格式无效。');
    if(action==='begin'&&(typeof body.lost_channel!=='boolean'||body.kind==='email'&&body.lost_channel))throw new Error('此邮箱入口需要双邮箱确认。');
   }
   if(action==='verify'||action==='old-verify'){
    const known=last,source=action==='old-verify'?'authority':'native';
    if(!known||known.actor.owner!==actor.owner||known.actor.sessionEpoch!==actor.sessionEpoch||known.receipt.intent!==body.intent||!validChannelCode(body.token,known.receipt.kind,source)||action==='verify'&&(body.leg!=='old'&&body.leg!=='new'||known.receipt.kind==='phone'&&body.leg!=='new'))throw new Error('验证码格式或渠道未核对。');
   }
   const raw=await send(origin(s.serviceOrigin)+'/api/auth/channel-change/'+action,s,signal,action==='status'?'GET':'POST',body);
   if(action==='target-check'){
    if(typeof raw.available!=='boolean'||raw.reservationCreated!==false)throw new Error('目标核查结果未知。');
    return {available:raw.available,reservationCreated:false,reason:raw.available?'available_at_read':'unavailable'};
   }
   const receipt=parseReceipt(raw);
   if(typeof body.intent==='string'&&receipt.intent!==body.intent)throw new Error('收据不属于本次请求。');
   if(action==='begin'&&(typeof raw.resumed!=='boolean'||!receipt.intent))throw new Error('建立结果未核对。');
   last={actor:{...actor},receipt};return receipt;
  },
  async confirmOriginalAccount(kind,target,actor,signal){
   const s=snapshot(actor),known=last;
   if(known?.actor.owner!==actor.owner||known.actor.sessionEpoch!==actor.sessionEpoch||known.receipt.state!=='completed'||known.receipt.kind!==kind)throw new Error('先读取已完成的本次请求。');
   target=normalizeTarget(kind,target);
   const user=await send(origin(s.supabaseOrigin)+'/auth/v1/user',s,signal,'GET',undefined,true);
   const phone=typeof user.phone==='string'?normalizeTarget('phone',user.phone):'';
   const actual=typeof user[kind]==='string'?normalizeTarget(kind,user[kind] as string):'';
   if(user.id!==actor.owner||user.is_anonymous!==false||!phone||!confirmedDate(user.phone_confirmed_at)||!confirmedDate(user[kind+'_confirmed_at'])||actual!==target)throw new Error('原账号渠道未核对。');
   if(signal.aborted||!same(s))throw new Error('旧身份结果已丢弃。');
   // Root implementation changes facts only, preserving original tokens,
   // owner/partition and sessionEpoch; no training read/write or transfer.
   await deps.commitChannelFacts({owner:actor.owner,kind,target,phoneVerified:true},actor);
   if(signal.aborted||!same(s))throw new Error('渠道事实未采用，请重新读取。');
  }
 };
}
