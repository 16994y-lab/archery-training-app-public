export type ChannelKind='email'|'phone';
export type ChangeState='none'|'awaiting_old'|'old_requesting'|'old_pending'|'old_verifying'|'requesting'|'pending'|'verifying'|'uncertain'|'native_confirmed'|'completed'|'cancelled_holding'|'expired_holding'|'invalidated';
export type Receipt={intent:string|null;kind?:ChannelKind;state:ChangeState;authorityKind:'email'|'phone'|null;requestClaimed:boolean;authorityVerified:boolean;newVerified:boolean;expiresIn:number;sessionAdopted:false;reservationHeld?:boolean|null;releaseRecorded?:boolean};
export type Actor=Readonly<{owner:string;sessionEpoch:number}>;
export type Action='status'|'target-check'|'begin'|'old-start'|'old-verify'|'request'|'verify'|'cancel'|'reconcile';
export interface ChannelTransport {
 request(action:Action,body:Readonly<Record<string,unknown>>,actor:Actor,signal:AbortSignal):Promise<unknown>;
 confirmOriginalAccount(kind:ChannelKind,target:string,actor:Actor,signal:AbortSignal):Promise<void>;
}
const states=new Set<ChangeState>(['none','awaiting_old','old_requesting','old_pending','old_verifying','requesting','pending','verifying','uncertain','native_confirmed','completed','cancelled_holding','expired_holding','invalidated']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal=new Set<ChangeState>(['completed','cancelled_holding','expired_holding','invalidated']);
export function channelCodeLength(kind:unknown,source:unknown):6|8 {
 if(kind!=='email'&&kind!=='phone'||source!=='native'&&source!=='authority'||source==='authority'&&kind!=='phone')throw new Error('验证码渠道尚未核对。');
 return source==='native'&&kind==='email'?8:6;
}
export function validChannelCode(token:unknown,kind:unknown,source:unknown):boolean {
 try{const length=channelCodeLength(kind,source);return typeof token==='string'&&token.length===length&&new RegExp('^[0-9]{'+length+'}$').test(token);}catch{return false;}
}
export function parseReceipt(value:unknown):Receipt {
 if(!value||typeof value!=='object')throw new Error('更换状态格式无效，请重新读取。');
 const r=value as Record<string,unknown>;
 if(r.sessionAdopted!==false||'access_token'in r||'refresh_token'in r||'session'in r||!states.has(r.state as ChangeState))throw new Error('更换结果未通过安全核对。');
 if(r.state==='none'){
  if(r.intent!==null||r.requestClaimed!==false||r.authorityKind!==null)throw new Error('更换状态格式无效。');
  return {intent:null,state:'none',authorityKind:null,requestClaimed:false,authorityVerified:false,newVerified:false,expiresIn:0,sessionAdopted:false};
 }
 if(typeof r.intent!=='string'||!uuid.test(r.intent)||!['email','phone'].includes(String(r.kind))||!['email','phone'].includes(String(r.authorityKind))||typeof r.requestClaimed!=='boolean'||typeof r.authorityVerified!=='boolean'||typeof r.newVerified!=='boolean'||typeof r.expiresIn!=='number'||!Number.isInteger(r.expiresIn)||r.expiresIn<0)throw new Error('更换状态格式无效。');
 if('reservationHeld'in r&&r.reservationHeld!==null&&typeof r.reservationHeld!=='boolean'||'releaseRecorded'in r&&typeof r.releaseRecorded!=='boolean')throw new Error('预约状态格式无效。');
 return {intent:r.intent,kind:r.kind as ChannelKind,state:r.state as ChangeState,authorityKind:r.authorityKind as 'email'|'phone',requestClaimed:r.requestClaimed,authorityVerified:r.authorityVerified,newVerified:r.newVerified,expiresIn:r.expiresIn,sessionAdopted:false,reservationHeld:r.reservationHeld as boolean|null|undefined,releaseRecorded:r.releaseRecorded as boolean|undefined};
}
export function normalizeTarget(kind:ChannelKind,target:string):string {
 const t=target.trim();
 if(kind==='phone'){
  const p=t.replace(/^\+?86/,'');if(!/^1[3-9][0-9]{9}$/.test(p))throw new Error('请输入中国大陆手机号。');return '+86'+p;
 }
 if(t.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(t))throw new Error('请输入有效邮箱。');return t.toLowerCase();
}
export function allowedActions(r:Receipt|null,enabled:boolean,unknown=false):ReadonlySet<Action> {
 const a=new Set<Action>(['status']);if(!r?.intent){if(enabled&&!unknown&&r?.state==='none'){a.add('begin');a.add('target-check');}return a;}
 a.add('reconcile');if(!terminal.has(r.state)&&r.state!=='native_confirmed')a.add('cancel');
 if(r.state==='completed'){if(enabled&&!unknown){a.add('begin');a.add('target-check');}return a;}
 if(terminal.has(r.state)&&r.releaseRecorded===true&&r.reservationHeld===false){if(enabled&&!unknown){a.add('begin');a.add('target-check');}return a;}
 if(!enabled||unknown||r.expiresIn===0)return a;
 if(r.state==='awaiting_old')a.add('old-start');
 if(r.state==='old_pending')a.add('old-verify');
 if(r.state==='requesting'&&!r.requestClaimed)a.add('request');
 if(r.state==='pending')a.add('verify');return a;
}
export type View={receipt:Receipt|null;busy:boolean;error:string;notice:string;resultUnknown:boolean};
export class ChannelChangeClient {
 private actor:Actor;private generation=0;private flight:AbortController|null=null;private dead=false;
 private listeners=new Set<()=>void>();private view:View={receipt:null,busy:false,error:'',notice:'',resultUnknown:false};
 constructor(actor:Actor,private transport:ChannelTransport){this.actor={...actor};}
 getSnapshot=()=>this.view;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private set(value:Partial<View>){this.view={...this.view,...value};for(const fn of this.listeners)fn();}
 changeActor(actor:Actor){if(this.actor.owner===actor.owner&&this.actor.sessionEpoch===actor.sessionEpoch)return;this.generation++;this.flight?.abort();this.flight=null;this.actor={...actor};this.set({receipt:null,busy:false,error:'',notice:'',resultUnknown:false});}
 activate(){if(this.dead){this.dead=false;this.flight=null;this.set({receipt:null,busy:false,error:'',notice:'',resultUnknown:false});}}
 dispose(){this.dead=true;this.generation++;this.flight?.abort();this.listeners.clear();}
 async perform(action:Action,body:Record<string,unknown>,enabled:boolean){
  if(this.dead||this.flight)return;
  if(!allowedActions(this.view.receipt,enabled,this.view.resultUnknown).has(action)){this.set({error:'当前状态不能执行此操作，请重新读取。'});return;}
  const actor={...this.actor},g=this.generation,c=new AbortController(),intent=this.view.receipt?.intent;
  if(action!=='status'&&action!=='begin'&&action!=='target-check'&&body.intent!==intent){this.set({error:'本次请求不匹配，请重新读取。'});return;}
  if(action==='verify'||action==='old-verify'){
   const r=this.view.receipt,source=action==='old-verify'?'authority':'native';
   if(!r||!validChannelCode(body.token,r.kind,source)||action==='verify'&&(body.leg!=='old'&&body.leg!=='new'||r.kind==='phone'&&body.leg!=='new')){this.set({error:'验证码格式或渠道未核对，请重新读取。'});return;}
  }
  this.flight=c;this.set({busy:true,error:'',notice:''});
  const current=()=>!this.dead&&!c.signal.aborted&&g===this.generation&&actor.owner===this.actor.owner&&actor.sessionEpoch===this.actor.sessionEpoch;
  try{
   const response=await this.transport.request(action,body,actor,c.signal);if(!current())return;
   if(action==='target-check'){
    const r=response as Record<string,unknown>;
    if(!r||typeof r.available!=='boolean'||r.reservationCreated!==false)throw new Error('目标状态未确认。');
    this.set({notice:r.available?'当前核查可用；建立请求时仍会重新核对。':'目标当前不可用，请更换或等待已有请求处理。'});return;
   }
   const r=parseReceipt(response);
   if(intent&&action!=='status'&&action!=='begin'&&r.intent!==intent)throw new Error('结果不属于本次请求。');
   this.set({receipt:r,resultUnknown:false,notice:r.state==='completed'?'后台已完成；请核对原账号的当前渠道。':''});
  }catch{if(current())this.set({error:'操作结果未确认，请读取状态；不会自动重发或重验。',resultUnknown:action==='status'?this.view.resultUnknown:true});}
  finally{if(current()){this.flight=null;this.set({busy:false});}}
 }
 async confirm(kind:ChannelKind,target:string){
  if(this.dead||this.flight||this.view.receipt?.state!=='completed'||this.view.receipt.kind!==kind)return;
  const actor={...this.actor},g=this.generation,c=new AbortController();this.flight=c;this.set({busy:true,error:''});
  const current=()=>!this.dead&&!c.signal.aborted&&g===this.generation&&actor.owner===this.actor.owner&&actor.sessionEpoch===this.actor.sessionEpoch;
  try{await this.transport.confirmOriginalAccount(kind,normalizeTarget(kind,target),actor,c.signal);if(current())this.set({notice:kind==='email'?'已核对原账号的新邮箱，请在账号安全重新验证邮箱。':'已核对原账号的新手机号。'});}
  catch{if(current())this.set({error:'原账号渠道未核对成功，请保留当前登录和训练记录。'});}
  finally{if(current()){this.flight=null;this.set({busy:false});}}
 }
}
