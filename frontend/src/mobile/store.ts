import { copy, Data, initialData, LIMITS, now, positive, scoreAt, validateConditions, validatePlan } from './domain';
import {createAccountStorage,type VaultPersistence} from './account-vault';
declare global { interface Window { Gongxingji?: { read(): string; write(value:string,expectedRevision:number): string; exportFile(name:string,content:string,mime:string,share:boolean): string; capabilities():string; request?(id:string,url:string,method:string,headers:string,body:string):void; communityRequest?(id:string,url:string,method:string,headers:string,body:string,scope:string,owner:string,sessionFingerprint:string):void; communitySessionFingerprint?(scope:string,owner:string):string; communityPendingRead?(scope:string,owner:string):string; communityPendingWrite?(scope:string,owner:string,value:string):string; privateMediaFingerprint?(scope:string,owner:string):string; mediaArchiveFingerprint?(scope:string,owner:string):string; privateMediaBegin?(id:string,url:string,method:string,headers:string,json:string,scope:string,owner:string,pin:string,bytes:number,sha256:string):string; privateMediaChunk?(id:string,sequence:number,encoded:string):string; privateMediaFinish?(id:string):string; privateMediaCancel?(id:string):void; mediaArchiveExportBegin?(id:string,name:string,scope:string,owner:string,pin:string,bytes:number,sha256:string):string; mediaArchiveExportChunk?(id:string,sequence:number,encoded:string):string; mediaArchiveExportFinish?(id:string):string; mediaArchiveExportCancel?(id:string):void; speakGuide?(text:string):string; stopGuide?():void; setReviewMode?(active:boolean):string; }; } }
export function validateData(value: unknown): Data {
  const d=value as Data;
  const text=(v:unknown,label:string)=>{if(typeof v!=='string'||v.length>10000)throw new Error(`${label}文本无效`);};
  const reference=(v:unknown,label:string)=>{if(v!==null&&(typeof v!=='string'||!v||v.length>10000))throw new Error(`${label}引用无效`);};
  const date=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw new Error('日期数据无效');};
  if(!d||d.schema!==1||!Number.isSafeInteger(d.revision)||d.revision<0)throw new Error('数据版本不支持或损坏，原文件已保留');
  for(const k of ['sessions','plans','targets','equipment','schedules','programs','goals'] as const) {if(!Array.isArray(d[k]))throw new Error(`数据缺少 ${k}`);const ids=d[k].map(x=>x.id);if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('数据标识无效或重复');}
  if(!d.profile||!d.connection||d.sessions.length>LIMITS.sessions)throw new Error('数据结构或容量不支持');
  for(const key of ['name','bow','hand','experience','competition'] as const)text(d.profile[key],'个人资料');
  if(d.profile.avatar!==undefined&&!['initial','bow','target','star'].includes(d.profile.avatar))throw new Error('头像样式无效');
  for(const key of ['api','auth','publicKey'] as const)text(d.connection[key],'连接设置');
  const equipment=(e:Data['equipment'][number])=>{if(!e||typeof e.favorite!=='boolean')throw new Error('器材结构无效');for(const key of ['id','name','bow','riser','limbs','arrows','sight','stabilizer','string','tab','other'] as const)text(e[key],'器材');};
  d.equipment.forEach(equipment);
  if(d.accessories!==undefined){if(!Array.isArray(d.accessories)||d.accessories.length>5000||new Set(d.accessories.map(a=>a.id)).size!==d.accessories.length)throw new Error('配件数据无效');for(const a of d.accessories){for(const k of ['id','category','name','note'] as const)text(a[k],'配件');if(!a.id||typeof a.favorite!=='boolean')throw new Error('配件标识或常用状态无效');}}
  for(const g of d.goals){text(g.name,'目标');date(g.start);date(g.end);if(g.end<g.start||!['arrows','sessions','average'].includes(g.type)||!Number.isFinite(g.value)||g.value<=0||(g.type==='average'&&g.value>10)||(g.distance!==null&&(!Number.isFinite(g.distance)||g.distance<=0)))throw new Error('目标数据无效');}
  for(const p of d.programs){text(p.name,'长期安排');text(p.note,'长期安排');date(p.start);date(p.end);positive(p.perWeek,'每周次数',7);positive(p.arrowsPerWeek,'每周箭量',210000);if(p.end<p.start||!Array.isArray(p.weekdays)||p.weekdays.length!==p.perWeek||new Set(p.weekdays).size!==p.weekdays.length||p.weekdays.some(v=>!Number.isInteger(v)||v<0||v>6))throw new Error('长期安排星期或日期无效');}
  for(const p of d.programs)reference(p.planId,'长期安排计划');
  const schedule=(a:Data['schedules'][number])=>{date(a.date);text(a.name,'日历安排');positive(a.arrows,'单次安排箭量',LIMITS.sessionArrows);reference(a.planId,'日历计划');reference(a.programId,'日历长期安排');reference(a.sessionId,'日历场次');};
  d.schedules.forEach(schedule);
  d.plans.forEach(validatePlan);d.targets.forEach(target=>validateConditions({target,size:null,distance:1,bow:'',equipment:null}));
  const globalIds=new Set<string>();
  for(const s of d.sessions) {
    reference(s.scheduleId,'场次日历');if(s.scheduleSnapshot){text(s.scheduleSnapshot.id,'日历快照标识');schedule(s.scheduleSnapshot);}
    validateConditions(s.conditions);if(s.plan)validatePlan(s.plan);if(s.conditions.equipment)equipment(s.conditions.equipment);text(s.name,'场次');text(s.note,'心得');date(s.date);positive(s.revision,'场次版本',Number.MAX_SAFE_INTEGER);if(!Array.isArray(s.skippedRests))throw new Error('休息结构无效');
    for(const v of [s.energy,s.fatigue])if(v!==null&&(!Number.isFinite(v)||v<0||v>10))throw new Error('自评须在0–10之间或未知');
    if(!['active','draft','completed','discarded'].includes(s.status)||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)||!Number.isFinite(Date.parse(s.started))||!Array.isArray(s.ends)||s.ends.length>LIMITS.ends||!Array.isArray(s.rest)||!Array.isArray(s.videoNotes))throw new Error('场次结构或日期无效');
    if(!Number.isInteger(s.currentEnd)||s.currentEnd<0||(s.ends.length>0&&s.currentEnd>=s.ends.length))throw new Error('当前组无效');
    let count=0;
    for(const e of s.ends) {
      if(typeof e.confirmed!=='boolean'||!['','上半场','下半场'].includes(e.half))throw new Error('分组确认或半场状态无效');if(e.note!==undefined)text(e.note,'组备注');
      positive(e.capacity,'本组箭数',LIMITS.arrowsPerEnd);if(!Array.isArray(e.arrows)||e.arrows.length>e.capacity)throw new Error('组箭量超出容量');count+=e.arrows.length;
      for(const a of e.arrows) {
        if(!a.id||globalIds.has(a.id))throw new Error('单箭标识重复');globalIds.add(a.id);
        if(a.note!==undefined)text(a.note,'单箭备注');
        if(!s.conditions.target.allowed_score_codes.includes(a.code)||!Number.isInteger(a.face)||a.face<1||a.face>s.conditions.target.face_count||!['number','target','photo'].includes(a.source))throw new Error('单箭规则或来源无效');
        if((a.x===null)!==(a.y===null))throw new Error('坐标必须成对');
        if(a.x!==null) {if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||Math.abs(a.x)>1.2+1e-8||Math.abs(a.y!)>1.2+1e-8||scoreAt(s.conditions.target,a.x,a.y!)!==a.code)throw new Error('坐标与成绩不一致');}
        if(a.source==='number'&&a.x!==null)throw new Error('数字录入不能伪造坐标');
        if(a.coordinateEvidence!==undefined&&(a.coordinateEvidence!=='manual-target-confirmed'||a.source!=='photo'||a.x===null))throw new Error('照片落点人工确认证据无效');
      }
    }
    if(count>LIMITS.sessionArrows)throw new Error('单场箭量超出容量');if(s.halfBoundary!=null)positive(s.halfBoundary,'半场边界',LIMITS.ends);
    for(const r of s.rest)if(!Number.isFinite(Date.parse(r.started))||(r.ended!==null&&!Number.isFinite(Date.parse(r.ended)))||typeof r.timer!=='boolean')throw new Error('休息时间数据无效');
    for(const n of s.videoNotes){text(n.note,'视频备注');if(!Number.isFinite(n.time)||n.time<0)throw new Error('视频时间点无效');}
    if(s.status==='completed'&&(!s.ended||!count))throw new Error('完成场次缺少实际成绩');
  }
  if(d.activeId&&!d.sessions.some(s=>s.id===d.activeId&&s.status==='active'))throw new Error('当前训练引用失效');
  if(d.sessions.filter(s=>s.status==='active').length>(d.activeId?1:0))throw new Error('当前场次存在冲突');
  return d;
}
function serialized(d:Data) {const text=JSON.stringify(d);if(new TextEncoder().encode(text).length>LIMITS.bytes)throw new Error('本机文档超过24MB容量保护。请导出备份，当前数据没有删除。');return text;}
export interface StorageAdapter {read():Promise<string|null>;write(text:string,expected:number):Promise<void>;accountKey?:()=>string|null;selectAccount?:(key:string,legacyOwner:string|null,current:Data)=>Promise<Data>;}
function db():Promise<IDBDatabase> {return new Promise((resolve,reject)=>{const r=indexedDB.open('gongxingji-android-local-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('本机存储被另一窗口占用'));});}
export const browserStorage: StorageAdapter={
  async read(){const d=await db();try{return await new Promise<string|null>((resolve,reject)=>{const s=d.transaction('data').objectStore('data'),v=s.get('account-vault');v.onsuccess=()=>{if(v.result!=null){reject(new Error('资料已按账号保存，请登录对应账号查看；旧原件保留'));return;}const r=s.get('state');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);};v.onerror=()=>reject(v.error);});}finally{d.close();}},
  async write(text,expected){const d=await db();try{await new Promise<void>((resolve,reject)=>{const tx=d.transaction('data','readwrite');const store=tx.objectStore('data'),v=store.get('account-vault');let failure:Error|null=null;const fail=(e:unknown)=>{failure=e as Error;tx.abort();};v.onsuccess=()=>{if(v.result!=null){fail(new Error('账号资料已切换，旧页面不能继续保存'));return;}const r=store.get('state');r.onsuccess=()=>{try{const rev=r.result?JSON.parse(r.result).revision:0;if(rev===expected+1&&r.result===text)return;if(rev!==expected)throw new Error('另一窗口已更改数据，请导出未保存内容并重新打开');store.put(text,'state');}catch(e){fail(e);}};};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error??new Error('保存事务中止'));});}finally{d.close();}}
};
export const nativeStorage:StorageAdapter={async read(){const r=JSON.parse(window.Gongxingji!.read());if(!r.ok)throw new Error(r.error);return r.data??null;},async write(text,expected){const r=JSON.parse(window.Gongxingji!.write(text,expected));if(!r.ok)throw new Error(r.error);}};
// Archive and replace in one IndexedDB transaction; recovery never discards the source.
export async function recoverBrowserData(expectedRaw:string,next:Data):Promise<void>{
  validateData(next);const connection=await db();
  try{await new Promise<void>((resolve,reject)=>{const tx=connection.transaction('data','readwrite'),items=tx.objectStore('data');let failure:Error|null=null;
    const vault=items.get('account-vault');vault.onsuccess=()=>{if(vault.result!=null){failure=new Error('资料已按账号保存，请登录对应账号恢复，旧原件保留');tx.abort();return;}const request=items.get('state');request.onsuccess=()=>{try{if(request.result!==expectedRaw)throw new Error('本机资料已变化，请重新检查恢复预览');let revision=0;try{revision=JSON.parse(expectedRaw).revision;}catch{}if(!Number.isSafeInteger(revision)||revision<0)revision=0;const recovered={...copy(next),revision:revision+1,updated:now()};items.add(expectedRaw,'recovery-'+Date.now()+'-'+crypto.randomUUID());items.put(serialized(recovered),'state');}catch(e){failure=e as Error;tx.abort();}};};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error??new Error('恢复事务中止，原文件保留'));
  });}finally{connection.close();}
}
export class Repository {
  data:Data=initialData();pending:Data|null=null;private serial:Promise<unknown>=Promise.resolve();private epoch=0;private switching=false;private stale=false;
  constructor(private storage:StorageAdapter){}
  accountKey=()=>this.stale?'!unconfirmed':this.storage.accountKey?.()??null;
  accountEpoch=()=>this.epoch;
  private assertEpoch(epoch:number){if(this.stale||epoch!==this.epoch||this.switching)throw new Error('账号资料已切换，请重新打开，旧页面操作未保存');}
  selectAccount(key:string,legacyOwner:string|null):Promise<Data>{
    if(this.stale)return Promise.reject(new Error('账号资料已切换，请重新打开应用'));
    if(!this.storage.selectAccount)return Promise.reject(new Error('当前存储尚不支持多账号'));
    if(this.switching)return Promise.reject(new Error('正在切换账号资料'));
    if(this.accountKey()===key)return Promise.resolve(this.data);
    this.switching=true;this.epoch++;
    const run=this.serial.then(async()=>{if(this.pending)throw new Error('尚有未保存内容，请先保存或导出后换号');try{const next=await this.storage.selectAccount!(key,legacyOwner,this.data);this.data=validateData(next);return this.data;}catch(error){this.stale=true;throw error;}}).finally(()=>{this.switching=false;});this.serial=run.catch(()=>{});return run;
  }
  async load() {if(this.stale)throw new Error('账号资料需要重新打开应用后核对');const raw=await this.storage.read();this.data=raw?validateData(JSON.parse(raw)):initialData();return this.data;}
  mutate(change:(next:Data)=>void):Promise<Data> {if(this.switching||this.stale)return Promise.reject(new Error('账号资料已切换，旧页面操作未保存'));const epoch=this.epoch;const run=this.serial.then(async()=>{this.assertEpoch(epoch);if(this.pending)throw new Error('上一项尚未保存，请先重试或导出未保存内容');const d=copy(this.data);change(d);d.revision=this.data.revision+1;d.updated=now();validateData(d);const text=serialized(d);try{await this.storage.write(text,this.data.revision);}catch(e){this.pending=d;throw e;}this.data=d;return d;});this.serial=run.catch(()=>{});return run;}
  retry(){if(this.switching||this.stale)return Promise.reject(new Error('账号资料已切换，请重新打开'));const epoch=this.epoch;const run=this.serial.then(async()=>{this.assertEpoch(epoch);if(!this.pending)return this.data;const p=this.pending;await this.storage.write(serialized(p),this.data.revision);this.data=p;this.pending=null;return p;});this.serial=run.catch(()=>{});return run;}
  reloadSaved():Promise<Data>{const epoch=this.epoch,key=this.accountKey();const run=this.serial.then(async()=>{this.assertEpoch(epoch);const raw=await this.storage.read();if(this.accountKey()!==key){this.stale=true;this.epoch++;throw new Error('另一页面已切换账号，请重新打开并登录');}const saved=raw===null?initialData():validateData(JSON.parse(raw));this.data=saved;this.pending=null;return saved;});this.serial=run.catch(()=>{});return run;}
  async importBackup(text:string){if(new TextEncoder().encode(text).length>LIMITS.bytes)throw new Error('导入文件超过24MB');const incoming=validateData(JSON.parse(text));return this.mutate(d=>{if(d.sessions.length||d.plans.length||d.equipment.length||d.goals.length||d.schedules.length||d.programs.length||d.targets.length)throw new Error('恢复仅支持空资料库，避免覆盖现有记录。请在新安装中恢复。');Object.assign(d,copy(incoming));});}
}
type AccountBridge={accountVaultRead?:()=>string;accountVaultWrite?:(value:string,expectedHash:string,legacyHash:string)=>string};
function accountNative(){return typeof window==='undefined'?undefined:window.Gongxingji as typeof window.Gongxingji&AccountBridge;}
async function digestText(text:string|null){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text??''))),v=>v.toString(16).padStart(2,'0')).join('');}
export const accountVaultDisk:VaultPersistence={
  async read(){const native=accountNative();if(native){if(!native.accountVaultRead)throw new Error('请覆盖安装支持多账号的更新包，原资料保留');const r=JSON.parse(native.accountVaultRead());if(!r.ok)throw new Error(r.error);return r.data??null;}
    const d=await db();try{return await new Promise<string|null>((resolve,reject)=>{const r=d.transaction('data').objectStore('data').get('account-vault');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);});}finally{d.close();}},
  async write(value,expected,legacy){const native=accountNative();if(native){if(!native.accountVaultWrite)throw new Error('安装包尚不支持账号隔离');const r=JSON.parse(native.accountVaultWrite(value,await digestText(expected),await digestText(legacy)));if(!r.ok)throw new Error(r.error);if(r.hash!==await digestText(value))throw new Error('账号资料写后核对失败，请重新打开');return;}
    const d=await db();try{await new Promise<void>((resolve,reject)=>{const tx=d.transaction('data','readwrite'),s=tx.objectStore('data'),r=s.get('account-vault');let failure:Error|null=null;
      const fail=()=>{failure=new Error('另一页面已修改账号资料，请重新打开，原件保留');tx.abort();};
      r.onsuccess=()=>{if(r.result===value)return;if((r.result??null)!==expected){fail();return;}if(expected===null){const old=s.get('state');old.onsuccess=()=>{if((old.result??null)!==legacy)fail();else s.put(value,'account-vault');};}else s.put(value,'account-vault');};
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??new Error('账号资料保存中断，原件保留'));
    });}finally{d.close();}}
};
export const repository=new Repository(createAccountStorage(typeof window!=='undefined'&&window.Gongxingji?nativeStorage:browserStorage,accountVaultDisk,validateData));
export function exportText(name:string,content:string,mime='text/plain',share=false) {
  if(window.Gongxingji){const r=JSON.parse(window.Gongxingji.exportFile(name,content,mime,share));if(!r.ok)throw new Error(r.error);return;}
  const blob=new Blob([content],{type:mime}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
