/** Durable deletion coordination. A dispatched operation is NEVER sent twice. */
export type DeletionScope={owner:string;service:string;apiOrigin:string;localService:string};
export type DeletionPreview={version:1;policyVersion:'account-deletion-v1';owner:string;service:string;scopeDigest:string;counts:Record<string,number>;blockers:{code:string;message:string}[];requiresRecentAuthentication:true;recentAuthentication:boolean;canDelete:boolean;storagePending:boolean};
export type DeletionReceipt={version:1;requestId:string;state:'pending'|'completed';stage:'storage'|'storage_unknown'|'finalizing'|'done';canClearLocal:boolean};
export type DeletionJournal={version:1;scope:DeletionScope;requestId:string;readbackCapability:string;scopeDigest:string;attempted:boolean;notStarted:boolean;receipt:DeletionReceipt|null;localDone:boolean;warnings:string[]};
/** Only an explicit server rollback attestation may release a dispatched operation. */
export class DeletionNotStartedError extends Error {constructor(){super('本次注销尚未开始，请重新验证并核对范围');}}
export interface DeletionStore {read():Promise<DeletionJournal|null>;compareAndSet(expected:DeletionJournal|null,next:DeletionJournal|null):Promise<void>}
export interface DeletionPort {prepare(scope:DeletionScope):Promise<unknown>;freeze(scope:DeletionScope):Promise<void>;confirm(journal:DeletionJournal):Promise<unknown>;status(journal:DeletionJournal):Promise<unknown>;resume(journal:DeletionJournal):Promise<unknown>;clearLocal(journal:DeletionJournal):Promise<string[]>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>new Error('注销状态未能核对，请保留当前页面，只读取原请求结果。');
const countKeys=['trainingSessions','trainingPlans','cloudBackups','teamMemberships','teamsOwned','rewardSources','rewardClaims','invitationLinks','feedbackRecords','privateMedia','contributionPhotos','archiveRecords','communityRecords'];
export const sameDeletionScope=(a:DeletionScope,b:DeletionScope)=>a.owner===b.owner&&a.service===b.service&&a.apiOrigin===b.apiOrigin&&a.localService===b.localService;
export function parseDeletionPreview(raw:unknown,scope:DeletionScope):DeletionPreview {
 const v=raw as DeletionPreview;
 if(!v||v.version!==1||v.policyVersion!=='account-deletion-v1'||v.owner!==scope.owner||v.service!==scope.service||!hex(v.scopeDigest)||!v.counts||Array.isArray(v.counts)||Object.keys(v.counts).length!==countKeys.length||Object.entries(v.counts).some(([k,n])=>!countKeys.includes(k)||!Number.isSafeInteger(n)||n<0)||!Array.isArray(v.blockers)||v.blockers.some(b=>!b||typeof b.code!=='string'||typeof b.message!=='string')||v.requiresRecentAuthentication!==true||typeof v.recentAuthentication!=='boolean'||typeof v.canDelete!=='boolean'||typeof v.storagePending!=='boolean'||v.canDelete&&(v.blockers.length>0||!v.recentAuthentication))throw fail();
 return v;
}
export function parseDeletionReceipt(raw:unknown,id:string):DeletionReceipt {
 const v=raw as DeletionReceipt;
 if(!v||Object.keys(v).sort().join()!=='canClearLocal,requestId,stage,state,version'||v.version!==1||v.requestId!==id||!['pending','completed'].includes(v.state)||!['storage','storage_unknown','finalizing','done'].includes(v.stage)||typeof v.canClearLocal!=='boolean'||(v.state==='completed')!==(v.stage==='done')||v.canClearLocal!==(v.state==='completed'))throw fail();return v;
}
export function parseDeletionJournal(raw:string|null):DeletionJournal|null {
 if(raw===null)return null;let j:DeletionJournal;try{j=JSON.parse(raw);}catch{throw fail();}
 if(!j||Object.keys(j).sort().join()!=='attempted,localDone,notStarted,readbackCapability,receipt,requestId,scope,scopeDigest,version,warnings'||j.version!==1||!j.scope||Object.keys(j.scope).sort().join()!=='apiOrigin,localService,owner,service'||!uuid(j.scope.owner)||!uuid(j.requestId)||!hex(j.scopeDigest)||typeof j.readbackCapability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(j.readbackCapability)||typeof j.attempted!=='boolean'||typeof j.notStarted!=='boolean'||typeof j.localDone!=='boolean'||!Array.isArray(j.warnings)||j.warnings.some(s=>typeof s!=='string')||typeof j.scope.localService!=='string'||!j.scope.localService||![j.scope.service,j.scope.apiOrigin].every(s=>{try{const u=new URL(s);return u.protocol==='https:'&&u.origin===s;}catch{return false;}}))throw fail();
 const api=j.scope.apiOrigin==='https://service-1.example.invalid'&&j.scope.service==='https://auth-4.example.invalid'?'https://service-3.example.invalid':j.scope.apiOrigin;
 if(j.scope.localService!==api+'|'+j.scope.service)throw fail();
 if(j.receipt!==null){parseDeletionReceipt(j.receipt,j.requestId);if(!j.attempted)throw fail();}if(j.notStarted&&(!j.attempted||j.receipt!==null)||j.localDone&&j.receipt?.state!=='completed')throw fail();return j;
}
export class AccountDeletionFlow {
 private busy=false;
 constructor(private store:DeletionStore,private port:DeletionPort,private random:Crypto=crypto){}
 private async locked<T>(f:()=>Promise<T>){if(this.busy)throw new Error('正在核对本次注销，请稍候。');this.busy=true;try{return await f();}finally{this.busy=false;}}
 async begin(scope:DeletionScope,preview:DeletionPreview,confirmation:string){return this.locked(async()=>{
  const checked=parseDeletionPreview(preview,scope);if(!checked.canDelete||confirmation!=='注销此账号')throw new Error('请先核对注销范围、重新验证本人并输入确认文字。');
  if(await this.store.read())throw new Error('本机已有一项注销记录，请先读取原请求。');
  const latest=parseDeletionPreview(await this.port.prepare(scope),scope);
  if(!latest.canDelete||latest.scopeDigest!==checked.scopeDigest)throw new Error('注销范围或本人验证已变化，请重新核对范围后再确认。');
  const bytes=new Uint8Array(32);this.random.getRandomValues(bytes);
  const cap=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  let j:DeletionJournal={version:1,scope:{...scope},requestId:this.random.randomUUID(),readbackCapability:cap,scopeDigest:checked.scopeDigest,attempted:false,notStarted:false,receipt:null,localDone:false,warnings:[]};
  parseDeletionJournal(JSON.stringify(j));await this.store.compareAndSet(null,j);await this.port.freeze(scope);
  const dispatched={...j,attempted:true};await this.store.compareAndSet(j,dispatched);j=dispatched;
  let raw:unknown;try{raw=await this.port.confirm(j);}catch(e){if(!(e instanceof DeletionNotStartedError))throw e;const rejected={...j,notStarted:true};await this.store.compareAndSet(j,rejected);return rejected;}
  const receipt=parseDeletionReceipt(raw,j.requestId);const next={...j,receipt};await this.store.compareAndSet(j,next);return next;
 });}
 async read(){return this.locked(async()=>{const j=await this.store.read();if(!j)throw fail();if(j.receipt?.state==='completed'||j.notStarted)return j;const receipt=parseDeletionReceipt(await this.port.status(j),j.requestId);const next={...j,receipt};await this.store.compareAndSet(j,next);return next;});}
 async resume(){return this.locked(async()=>{const j=await this.store.read();if(!j||!j.attempted||j.receipt?.state!=='pending')throw fail();const checked=parseDeletionReceipt(await this.port.status(j),j.requestId);const receipt=checked.state==='completed'?checked:parseDeletionReceipt(await this.port.resume(j),j.requestId);const next={...j,receipt};await this.store.compareAndSet(j,next);return next;});}
 async cleanup(){return this.locked(async()=>{const j=await this.store.read();if(!j||j.receipt?.state!=='completed'||!j.receipt.canClearLocal)throw fail();if(j.localDone)return j;await this.port.freeze(j.scope);const warnings=await this.port.clearLocal(j);const next={...j,localDone:true,warnings};await this.store.compareAndSet(j,next);return next;});}
 async dismiss(){return this.locked(async()=>{const j=await this.store.read();if(!j?.localDone)throw fail();await this.store.compareAndSet(j,null);});}
}
