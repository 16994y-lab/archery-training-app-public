import {initialData} from './domain';
import {parseDeletionJournal,type DeletionJournal,type DeletionStore} from './account-deletion-core';
import {emptyScope} from './photo-contribution-store';
import {deletedMediaSelectionKey} from './cloud-media-local';
export const DELETION_EVENT='gongxingji-account-deletion-changed';
const journalKey='account-deletion-v1';
const notify=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event(DELETION_EVENT));};
const channel=typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel('gongxingji-account-deletion'):null;
if(channel)channel.onmessage=notify;
const changed=()=>{notify();channel?.postMessage('changed');};
function open(name:string,stores:string[]){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>stores.forEach(s=>r.result.createObjectStore(s,s==='scopes'?{keyPath:'key'}:s==='selections'?{keyPath:'id'}:undefined));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('本机注销记录暂不可用'));r.onblocked=()=>reject(new Error('另一页面占用本机资料，请关闭旧页面后继续核对。'));});}
async function transact(name:string,stores:string[],work:(tx:IDBTransaction)=>void){const db=await open(name,stores);try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(stores,'readwrite');tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(new Error('本机清理尚未完成，可继续本次清理；不会再次注销云端账号。'));try{work(tx);}catch{tx.abort();}});}finally{db.close();}}
export const deletionStore:DeletionStore={
 async read(){const db=await open('gongxingji-cloud-private',['private']);try{return await new Promise<DeletionJournal|null>((resolve,reject)=>{const r=db.transaction('private','readonly').objectStore('private').get(journalKey);r.onsuccess=()=>{try{resolve(parseDeletionJournal(r.result??null));}catch(e){reject(e);}};r.onerror=()=>reject(new Error('注销回查记录无法读取，请勿清除浏览器数据。'));});}finally{db.close();}},
 async compareAndSet(expected,next){await transact('gongxingji-cloud-private',['private'],tx=>{const s=tx.objectStore('private'),r=s.get(journalKey);r.onsuccess=()=>{try{const raw=r.result??null;if(raw!==(expected?JSON.stringify(expected):null)){tx.abort();return;}if(next)s.put(JSON.stringify(next),journalKey);else s.delete(journalKey);}catch{tx.abort();}};});changed();}
};
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
export function deletionApiServices(j:DeletionJournal){const allowed=['https://service-1.example.invalid','https://service-3.example.invalid'];return j.scope.service==='https://auth-4.example.invalid'&&allowed.includes(j.scope.apiOrigin)?allowed:[j.scope.apiOrigin];}
export function deletionLocalKeys(j:DeletionJournal){return [...new Set([j.scope.localService,...deletionApiServices(j).map(api=>api+'|'+j.scope.service)])].map(s=>s+'|'+j.scope.owner);}
/** Pure, ownership-bound transformation; unrelated account documents remain exact. */
export function redactDeletionMeta(raw:string,j:DeletionJournal,retainUnknown?:(value:unknown)=>void){
 const m=JSON.parse(raw),keys=new Set(deletionLocalKeys(j)),apis=deletionApiServices(j);if(!m||m.version!==1||!m.spaces||Array.isArray(m.spaces))throw new Error('同步副本格式未知，未清理。');
 const out=clone(m);
 const clean=(part:any)=>{if(!part.spaces||typeof part.spaces!=='object')throw new Error('同步副本归属未知');const p=part.pendingSwitch;
  if(p&&(keys.has(p.from)||keys.has(p.to))){const keep=keys.has(p.from)?p.to:p.from,doc=keys.has(p.from)?p.nextDoc:p.oldDoc;if(keep&&!keys.has(keep)){if(!part.spaces[keep])throw new Error('另一账号的切换副本归属未知，原件保留');const saved=clone(part.spaces[keep]);saved.local=doc;out.recoveryArchives??=[];out.recoveryArchives.push({id:'deletion-preserve-'+j.requestId+'-'+out.recoveryArchives.length,savedAt:new Date().toISOString(),spaces:{[keep]:saved},pendingSwitch:null});}else if(!keep){if(!retainUnknown)throw new Error('切换前旧副本归属未知，原件保留');retainUnknown(doc);}part.pendingSwitch=null;}
  for(const k of keys){const space=part.spaces[k];if(space&&(space.owner!==j.scope.owner||space.service+'|'+space.owner!==k))throw new Error('同步副本的账号归属不一致，原件保留');delete part.spaces[k];}if(keys.has(part.binding))part.binding=null;
 };
 // Snapshot the archive list: clean() can append an unrelated owner's preserved switch.
 for(const a of [...(out.recoveryArchives??[])])clean(a);clean(out);
 if(out.cloudSaveQueue!==undefined){const q=JSON.parse(out.cloudSaveQueue);if(!q||!q.spaces)throw new Error('云保存队列格式未知');for(const [k,s] of Object.entries(q.spaces) as [string,any][])if(s.owner===j.scope.owner&&apis.includes(s.service)){if(k!==s.service+'|'+s.owner)throw new Error('云保存队列账号归属不一致，原件保留');delete q.spaces[k];if(q.binding===k)q.binding=null;}out.cloudSaveQueue=JSON.stringify(q);}
 if(out.teamSharingQueue!==undefined){const q=JSON.parse(out.teamSharingQueue);if(!q||!Array.isArray(q.spaces))throw new Error('团队队列格式未知');q.spaces=q.spaces.filter((s:any)=>!(s.scope?.owner===j.scope.owner&&apis.includes(s.scope?.service)));out.teamSharingQueue=JSON.stringify(q);}
 return JSON.stringify(out);
}
export function redactDeletionVault(raw:string,j:DeletionJournal){const v=JSON.parse(raw);if(!v||v.version!==1||!v.accounts||!Object.prototype.hasOwnProperty.call(v.accounts,v.active))throw new Error('本机账号资料格式未知');const out=clone(v),keys=new Set(deletionLocalKeys(j));for(const k of keys)delete out.accounts[k];if(keys.has(out.active)){let key='deleted-account-placeholder:'+j.requestId;while(Object.prototype.hasOwnProperty.call(out.accounts,key))key+='-';out.active=key;out.accounts[key]=initialData();}return JSON.stringify(out);}
export function deletionPendingKeys(store:Pick<Storage,'length'|'key'|'getItem'>,j:DeletionJournal){const found:string[]=[],apis=deletionApiServices(j);
 for(let i=0;i<store.length;i++){const k=store.key(i);if(!k)continue;  for(const prefix of ['gongxingji-reward-pending-v1:','gongxingji-operations-pending-v1:','gongxingji-team-sharing-pending-v1:'])if(k.startsWith(prefix)){let scope;try{scope=JSON.parse(k.slice(prefix.length));}catch{continue;}if(Array.isArray(scope)&&apis.includes(scope[0])&&scope[1]===j.scope.owner)found.push(k);}
  if(apis.some(api=>k===`gongxingji-community-pending:${encodeURIComponent(api)}:${j.scope.owner}`))found.push(k);
 }return found;
}
/** Server completion is checked again here so callers cannot turn an unknown into deletion. */
export async function clearDeletionLocal(j:DeletionJournal){
 if(j.receipt?.state!=='completed'||!j.receipt.canClearLocal)throw new Error('云端注销尚未确认，本机资料保留。');
 if(typeof window!=='undefined'&&window.Gongxingji)throw new Error('此安装包缺少按账号清理能力，请使用当前正式网页版。');
 const warnings:string[]=[],apis=deletionApiServices(j),keys=new Set(deletionLocalKeys(j));
 await transact('gongxingji-cloud-private',['private'],tx=>{const s=tx.objectStore('private'),r=s.get('meta');r.onsuccess=()=>{try{if(r.result!=null){const unknown:unknown[]=[];s.put(redactDeletionMeta(r.result,j,value=>unknown.push(value)),'meta');if(unknown.length){s.put(JSON.stringify(unknown),'account-deletion-unassigned:'+j.requestId);warnings.push('本机存在未归属的切换前旧副本，已单独保留，未自动移交新账号。');}}}catch{tx.abort();}};
  const session=s.get('session'),revision=s.get('session-revision');revision.onsuccess=()=>{try{const value=session.result?JSON.parse(session.result):null;if(value?.owner===j.scope.owner&&keys.has(value.service+'|'+value.owner)){const rev=revision.result??0;if(!Number.isSafeInteger(rev)||rev<0||rev===Number.MAX_SAFE_INTEGER)throw Error();s.delete('session');s.put(rev+1,'session-revision');}}catch{tx.abort();}};
  const identity=s.get('local-identity');identity.onsuccess=()=>{try{const value=identity.result?JSON.parse(identity.result):null;if(value?.owner===j.scope.owner&&keys.has(value.service+'|'+value.owner))s.put(JSON.stringify({...value,state:'revoked'}),'local-identity');}catch{tx.abort();}};
  const c=s.openCursor();let scans=0;c.onsuccess=()=>{const v=c.result;if(!v)return;if(++scans>10000){tx.abort();return;}if(typeof v.key==='string'&&v.key.startsWith('registration-rewards-v1:complete:'+j.scope.service+':'+j.scope.owner+':')&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.key.slice(('registration-rewards-v1:complete:'+j.scope.service+':'+j.scope.owner+':').length)))v.delete();else if(typeof v.key==='string'&&(v.key==='email-enrollment-v1'||v.key.startsWith('registration-rewards-v1:')))warnings.push('本机可能存在未归属的注册草稿，已保留；新注册前需核对，不能视作新身份的邀请。');if(typeof v.key==='string'&&v.key.startsWith('account-deletion-unassigned:'))warnings.push('本机存在未归属的切换前旧副本，已单独保留，未自动移交新账号。');v.continue();};
 });
 await transact('gongxingji-android-local-v1',['data'],tx=>{const s=tx.objectStore('data'),r=s.get('account-vault');r.onsuccess=()=>{try{
   // Even an unmigrated legacy client must now have a vault. Its old unowned
   // state stays on disk, but cannot become a new UID's first-migration input.
   const key='deleted-account-placeholder:'+j.requestId;
   s.put(r.result!=null?redactDeletionVault(r.result,j):JSON.stringify({version:1,active:key,accounts:{[key]:initialData()}}),'account-vault');
  }catch{tx.abort();}};const old=s.get('state');old.onsuccess=()=>{if(old.result!=null)warnings.push('本机存在未归属旧训练副本，已保留；不能称本机全部清空。');};});
 // Old avatar records carry only a UID. A reward record additionally proves its service;
 // unscoped preset/photo records cannot be claimed for one Auth project.
 await transact('gongxingji-local-avatars-v1',['avatars'],tx=>{const s=tx.objectStore('avatars'),r=s.get(j.scope.owner);r.onsuccess=()=>{const v=r.result;if(v?.kind==='reward'&&apis.includes(v.service))s.delete(j.scope.owner);else if(v!=null)warnings.push('本机旧头像缺少服务归属，已保留；新身份不会自动继承。');};});
 await transact('gongxingji-photo-contributions-v1',['scopes'],tx=>{const key=JSON.stringify([j.scope.service,j.scope.owner]);tx.objectStore('scopes').put({...emptyScope(key),stopped:true,stopRequested:true,deleted:true});});
 await transact('gongxingji-selected-media-local',['selections','archive-files'],tx=>{let scans=0;const s=tx.objectStore('selections'),r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c){for(const service of apis)s.put({id:deletedMediaSelectionKey(j.scope.owner,service),deleted:true});return;}if(++scans>10000){tx.abort();return;}const v=c.value;if(v?.owner===j.scope.owner&&apis.includes(v.service))c.delete();c.continue();};const a=tx.objectStore('archive-files').openKeyCursor();a.onsuccess=()=>{const c=a.result;if(!c)return;if(++scans>20000){tx.abort();return;}if(typeof c.key==='string'&&c.key.startsWith(j.scope.owner+'|'))warnings.push('本机归档缺少服务归属，原文件已保留；未自动移交新账号。');c.continue();};});
 if(localStorage.getItem('gongxingji-registration-intro-v2:'+j.scope.owner)!==null)warnings.push('本机旧介绍偏好缺少服务归属，已保留；新身份不会自动继承。');
 for(const k of deletionPendingKeys(localStorage,j))localStorage.removeItem(k);
 for(const k of deletionPendingKeys(sessionStorage,j))sessionStorage.removeItem(k);
 return [...new Set(warnings)];
}
