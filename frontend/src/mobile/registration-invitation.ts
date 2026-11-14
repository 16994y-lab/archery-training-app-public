/** Private registration progress. Never used as evidence that an account is new. */
export const registrationRewardsReady=(import.meta as ImportMeta & {env?:Record<string,string>}).env?.VITE_REGISTRATION_REWARDS_ENABLED==='1';
export type RegistrationState={owner:string;service:string;state:'existing_or_unproven'|'pending'|'registered_without_invite'|'awarded'|'unavailable'|'revoked';registrationId:string|null;revision:number};
export type RegistrationRequest=(action:'prepare'|'read'|'status'|'complete',body?:Record<string,unknown>)=>Promise<unknown>;
export type PrivateStore={read(key:string):Promise<string|null>;write(key:string,value:string,expected:string|null):Promise<void>};
export class InvitationPrepareRejected extends Error {}
export const validRegistrationInvitationCode=(code:string)=>/^[A-Za-z0-9_-]{32}$/.test(code.trim());
type Draft={version:1;service:string;requestId:string;capability:string;phoneDigest:string;codeDigest:string;state:'unknown'|'prepared'|'bound'|'expired'|'missing'|'rejected'|'finished'};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const fail=()=>new Error('邀请注册进度暂时未能核对，请稍后再试');
export function parseRegistration(value:unknown):RegistrationState{
 const v=value as RegistrationState;
 if(!v||Object.keys(v).sort().join()!=='owner,registrationId,revision,service,state'||!uuid(v.owner)||typeof v.service!=='string'||!/^https:\/\//.test(v.service)||!['existing_or_unproven','pending','registered_without_invite','awarded','unavailable','revoked'].includes(v.state)||!Number.isSafeInteger(v.revision)||v.revision<0||(v.registrationId!==null&&!uuid(v.registrationId))||(v.state==='existing_or_unproven')!==(v.registrationId===null))throw fail();
 return v;
}
function draft(raw:string|null):Draft|null{if(raw===null)return null;let d:Draft;try{d=JSON.parse(raw);}catch{throw fail();}if(!d||Object.keys(d).sort().join()!=='capability,codeDigest,phoneDigest,requestId,service,state,version'||d.version!==1||!uuid(d.requestId)||! /^[A-Za-z0-9_-]{43}$/.test(d.capability)||! /^[a-f0-9]{64}$/.test(d.phoneDigest)||! /^[a-f0-9]{64}$/.test(d.codeDigest)||typeof d.service!=='string'||!['unknown','prepared','bound','expired','missing','rejected','finished'].includes(d.state))throw fail();return d;}
let database:Promise<IDBDatabase>|null=null;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('gongxingji-cloud-private',1);req.onupgradeneeded=()=>req.result.createObjectStore('private');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(fail());});}
export const registrationPrivateStore:PrivateStore={
 async read(key){const database=await db();return new Promise((resolve,reject)=>{const req=database.transaction('private','readonly').objectStore('private').get('registration-rewards-v1:'+key);req.onsuccess=()=>typeof req.result==='string'||req.result==null?resolve(req.result??null):reject(fail());req.onerror=()=>reject(fail());});},
 async write(key,value,expected){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('private','readwrite'),store=tx.objectStore('private'),id='registration-rewards-v1:'+key,req=store.get(id);req.onsuccess=()=>{const actual=req.result??null;if(actual!==expected){tx.abort();return;}store.put(value,id);};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(fail());tx.onerror=()=>reject(fail());});}
};
export class RegistrationInvitationFlow{
 private busy=false;
 constructor(private store:PrivateStore=registrationPrivateStore,private random:Crypto=crypto){}
 private async locked<T>(work:()=>Promise<T>){if(this.busy)throw fail();this.busy=true;try{return await work();}finally{this.busy=false;}}
 private key(service:string){return 'prepare:'+service;}
 async unfinishedRequest(service:string,phone:string):Promise<string|null>{
  const saved=draft(await this.store.read(this.key(service)));
  return saved && saved.service===service && saved.state!=='finished' && saved.phoneDigest===await this.hash(phone)?saved.requestId:null;
 }
 async finishRequest(service:string,phone:string,requestId:string){
  const key=this.key(service),raw=await this.store.read(key),saved=draft(raw);
  if(!saved || saved.service!==service || saved.requestId!==requestId || saved.phoneDigest!==await this.hash(phone) || saved.state==='finished')return;
  const archive='archive:'+service+':'+requestId,old=await this.store.read(archive);
  if(old===null)await this.store.write(archive,raw!,null);
  else if(draft(old)?.capability!==saved.capability)throw fail();
  await this.store.write(key,JSON.stringify({...saved,state:'finished'}),raw);
 }
 private async hash(phone:string){return Array.from(new Uint8Array(await this.random.subtle.digest('SHA-256',new TextEncoder().encode(phone)))).map(n=>n.toString(16).padStart(2,'0')).join('');}
 private async refresh(saved:Draft,raw:string,request:RegistrationRequest){
  const value=await request('read',{requestId:saved.requestId,capability:saved.capability}) as {requestId:string;state:string};
  if(!value||Object.keys(value).sort().join()!=='requestId,state'||value.requestId!==saved.requestId||!['not_found','prepared','bound','expired'].includes(value.state))throw fail();
  // A missing read cannot prove that an unknown write will not commit later.
  const state:Draft['state']=value.state==='not_found'?(saved.state==='unknown'?'unknown':'missing'):value.state as Draft['state'];
  const next={...saved,state},nextRaw=JSON.stringify(next);
  await this.store.write(this.key(saved.service),nextRaw,raw);
  return {saved:next,raw:nextRaw};
 }
 private async create(service:string,phone:string,code:string,request:RegistrationRequest,raw:string|null){
  const bytes=new Uint8Array(32);this.random.getRandomValues(bytes);const capability=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const current:Draft={version:1,service,requestId:this.random.randomUUID(),capability,phoneDigest:await this.hash(phone),codeDigest:await this.hash(code),state:'unknown'},pending=JSON.stringify(current),key=this.key(service);
  await this.store.write(key,pending,raw);
  let value:{requestId:string;state:string};
  try{value=await request('prepare',{requestId:current.requestId,capability,phone,invitationCode:code}) as typeof value;}
  catch(error){
   if(error instanceof InvitationPrepareRejected)await this.store.write(key,JSON.stringify({...current,state:'rejected'}),pending);
   throw error;
  }
  if(!value||Object.keys(value).sort().join()!=='requestId,state'||value.requestId!==current.requestId||value.state!=='prepared')throw fail();
  await this.store.write(key,JSON.stringify({...current,state:'prepared'}),pending);return capability;
 }
 async prepare(service:string,phone:string,code:string,request:RegistrationRequest){
  const choice=code.trim();
  if(!choice)return undefined;
  if(!validRegistrationInvitationCode(choice))throw new Error('请输入32位邀请码');
  return this.locked(async()=>{
   const raw=await this.store.read(this.key(service)),saved=draft(raw);
   if(saved&&saved.service!==service)throw fail();
   if(!saved||saved.state==='rejected'||saved.state==='finished')return this.create(service,phone,choice,request,raw);
   if(saved.phoneDigest!==await this.hash(phone))throw new Error('另一个手机号的邀请尚待核对。可清空邀请码继续登录');

   const checked=await this.refresh(saved,raw!,request);
   if(checked.saved.state==='expired'||checked.saved.state==='missing'){
    // Archive the terminal request before replacing its active slot by compare-and-set.
    const archive='archive:'+service+':'+saved.requestId,old=await this.store.read(archive);
    if(old===null)await this.store.write(archive,checked.raw,null);
    else if(draft(old)?.requestId!==saved.requestId||draft(old)?.capability!==saved.capability)throw fail();
    return this.create(service,phone,choice,request,checked.raw);
   }
   if(saved.codeDigest!==await this.hash(choice))throw new Error('请使用上次填写的邀请码，或清空后继续登录');
   if(checked.saved.state!=='prepared'&&checked.saved.state!=='bound')throw fail();
   return saved.capability;
  });
 }
 async completeOnce(request:RegistrationRequest,current:()=>{owner:string;service:string}|null){
  const actor=current();if(!actor)throw fail();const matches=()=>{const now=current();return now?.owner===actor.owner&&now.service===actor.service;};
  const state=parseRegistration(await request('status'));if(!matches()||state.owner!==actor.owner||state.service!==actor.service)throw fail();if(state.state!=='pending')return state;
  const key='complete:'+actor.service+':'+actor.owner+':'+state.registrationId,old=await this.store.read(key);if(old!==null)throw fail();
  await this.store.write(key,'unknown',null);if(!matches())throw fail();
  const result=parseRegistration(await request('complete',{registrationId:state.registrationId}));if(!matches()||result.owner!==actor.owner||result.service!==actor.service||result.registrationId!==state.registrationId||result.state==='pending')throw fail();
  await this.store.write(key,result.state,'unknown');return result;
 }
}
