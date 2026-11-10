import type {ArchiveStorage} from './protected-archive';
import {assertSafeArchivePath} from './protected-archive';
import type {MediaSelection,MediaSelectionStore} from './private-media-client';
export const deletedMediaSelectionKey=(owner:string,service:string)=>'account-deletion:'+JSON.stringify([service,owner]);
let database:Promise<IDBDatabase>|null=null;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('gongxingji-selected-media-local',1);r.onupgradeneeded=()=>{r.result.createObjectStore('selections',{keyPath:'id'});r.result.createObjectStore('archive-files');};r.onerror=()=>reject(new Error('媒体独立存储不可用'));r.onsuccess=()=>resolve(r.result);});}
async function get<T>(store:string,key:string):Promise<T|null>{const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction(store,'readonly').objectStore(store).get(key);r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(new Error('媒体本机读取失败'));});}
const MAX_SCAN_ROWS=10000,MAX_SELECTIONS=1000,MAX_SELECTION_BYTES=100*1024*1024;
/** Existing random-id keys have no owner index. Read one value at a time, retain only this owner.
 * Other owners' values still have to be inspected; complete isolation requires a reviewed index migration. */
async function selected(owner:string,service:string):Promise<MediaSelection[]>{const d=await db();return new Promise((resolve,reject)=>{
  const tx=d.transaction('selections','readonly'),r=tx.objectStore('selections').openCursor();const rows:MediaSelection[]=[];let scans=0,total=0,done=false,failure:Error|null=null;
  const fail=(message:string)=>{failure=new Error(message);try{tx.abort();}catch{reject(failure);}};
  r.onsuccess=()=>{const cursor=r.result;if(!cursor){done=true;return;}if(++scans>MAX_SCAN_ROWS){fail('媒体目录达到扫描保护；原任务保留，请核对后再读');return;}
    const v=cursor.value as MediaSelection|undefined;if(v&&v.owner===owner&&v.service===service){
      if(typeof cursor.primaryKey!=='string'||v.id!==cursor.primaryKey||!(v.body instanceof Uint8Array)||!Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>50*1024*1024||v.body.byteLength!==v.bytes){fail('本归属媒体目录损坏；原任务保留');return;}
      total+=v.bytes;if(rows.length>=MAX_SELECTIONS||total>MAX_SELECTION_BYTES){fail('本归属媒体目录超过数量或字节保护；原任务保留');return;}rows.push(v);
    }cursor.continue();
  };r.onerror=()=>{failure=new Error('媒体目录读取失败');};tx.oncomplete=()=>done?resolve(rows):reject(failure??new Error('媒体目录未完整读取'));tx.onerror=()=>reject(failure??new Error('媒体目录读取失败'));tx.onabort=()=>reject(failure??new Error('媒体目录读取中断；原任务保留'));
});}
async function archiveKeys(prefix:string):Promise<string[]>{const d=await db();return new Promise((resolve,reject)=>{
  const tx=d.transaction('archive-files','readonly'),r=tx.objectStore('archive-files').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff',false,true));const paths:string[]=[];let done=false,failure:Error|null=null;
  r.onsuccess=()=>{const cursor=r.result;if(!cursor){done=true;return;}try{
      if(typeof cursor.key!=='string'||!cursor.key.startsWith(prefix))throw new Error('归档目录键不匹配');const p=cursor.key.slice(prefix.length);assertSafeArchivePath(p);
      if(paths.length>=1001)throw new Error('归档目录超过数量保护；源资料保留');paths.push(p);cursor.continue();
    }catch(e){failure=e instanceof Error?e:new Error('归档目录无效');try{tx.abort();}catch{reject(failure);}}
  };r.onerror=()=>{failure=new Error('归档目录读取失败');};tx.oncomplete=()=>done?resolve(paths):reject(failure??new Error('归档目录未完整读取'));tx.onerror=()=>reject(failure??new Error('归档目录读取失败'));tx.onabort=()=>reject(failure??new Error('归档目录读取中断；原资料保留'));
});}
async function put(store:string,value:unknown,key?:string,exclusive=false){const d=await db();return new Promise<void>((resolve,reject)=>{const tx=d.transaction(store,'readwrite'),s=tx.objectStore(store);if(exclusive)s.add(value,key);else s.put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('媒体独立保存失败，原对象保留'));tx.onabort=()=>reject(new Error('媒体独立保存未完成，原对象保留'));});}
export const mediaSelectionStorage:MediaSelectionStore={get:id=>get<MediaSelection>('selections',id),put:async value=>{const d=await db();return new Promise<void>((resolve,reject)=>{const tx=d.transaction('selections','readwrite'),s=tx.objectStore('selections'),r=s.get(deletedMediaSelectionKey(value.owner,value.service));r.onsuccess=()=>{if(r.result?.deleted===true)tx.abort();else s.put(value);};tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error('媒体保存未完成；原账号已注销或本机存储不可用'));});},list:selected};
/** An independent namespace, never the training repository. IDB is not a durable-copy attestation. */
export function browserArchiveStorage(ownerId:string,storeId:string):ArchiveStorage{if(!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)||!/^archive-[A-Za-z0-9_-]{1,100}$/.test(storeId))throw new Error('归档归属或目录无效');const prefix=ownerId+'|'+storeId+'|';return {ownerId,storeId,
  list:()=>archiveKeys(prefix),
  read:async path=>{assertSafeArchivePath(path);const r=await get<{key:string;bytes:Uint8Array}>('archive-files',prefix+path);if(!r||!(r.bytes instanceof Uint8Array))throw new Error('归档对象缺失');return Uint8Array.from(r.bytes);},
  writeExclusive:async(path,bytes)=>{assertSafeArchivePath(path);await put('archive-files',{key:prefix+path,bytes:Uint8Array.from(bytes)},prefix+path,true);},
};}
