/** Kept outside the user archive: neither credentials nor merge bases are exported. */
type NativeCloud={cloudMetaRead?:()=>string;cloudMetaWrite?:(value:string,expectedHash:string)=>string;secureReadResult?:(key:string)=>string;secureWriteIfCurrent?:(key:string,value:string,expectedHash:string)=>string;localIdentityRead?:()=>string;localIdentityWrite?:(value:string,expectedHash:string)=>string};
export interface CloudStorage {readMeta():Promise<string|null>;writeMeta(value:string):Promise<void>;readSession():Promise<string|null>;writeSession(value:string|null):Promise<void>;readLocalIdentity?():Promise<string|null>;writeLocalIdentity?(value:string,announce?:boolean):Promise<void>}
function bridge(){return typeof window==='undefined'?undefined:window.Gongxingji as typeof window.Gongxingji&NativeCloud;}
function metaResult(raw:string,reading=false){const value=JSON.parse(raw);if(!value.ok)throw new Error(value.error||'云同步元信息保存失败，现有资料已保留');if(typeof value.hash!=='string'||!(/^[a-f0-9]{64}$/.test(value.hash)||(reading&&value.data==null&&value.hash==='')))throw new Error('云同步元信息缺少有效版本校验，请更新安装包后重试');if(reading&&value.data!=null&&typeof value.data!=='string')throw new Error('云同步元信息格式无效');return {data:(value.data??null) as string|null,hash:value.hash as string};}
let database:Promise<IDBDatabase>|null=null;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gongxingji-cloud-private',1);request.onupgradeneeded=()=>request.result.createObjectStore('private');request.onerror=()=>reject(new Error('账号独立存储不可用'));request.onsuccess=()=>resolve(request.result);});}
/** One instance belongs to one activity/tab. Its baseline is changed only by an
 * explicit read or a confirmed write, never by silently retrying a conflict. */
export function createCloudStorage(nativeReader:()=>NativeCloud|undefined=bridge,databaseReader:()=>Promise<IDBDatabase>=db):CloudStorage {
  let baseline:{kind:'native';hash:string}|{kind:'browser';value:string|null}|null=null;
  let serial:Promise<unknown>=Promise.resolve();
  let identityBaseline:{kind:'native';hash:string}|{kind:'browser';value:string|null}|null=null;
  let sessionBaseline:{kind:'native';hash:string}|{kind:'browser';value:string|null;revision:number}|null=null;
  const channel=typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel('gongxingji-private-identity'):null;
  if(channel)channel.onmessage=event=>window.dispatchEvent(new Event(event.data==='reverified'?'gongxingji-local-identity-reverified':'gongxingji-local-identity-changed'));
  const sameActive=(before:string|null,after:string)=>{try{const a=JSON.parse(before??'null'),b=JSON.parse(after);return a?.version===1&&b?.version===1&&a.state==='active'&&b.state==='active'&&typeof a.owner==='string'&&a.owner===b.owner&&typeof a.service==='string'&&a.service===b.service;}catch{return false;}};
  const locked=<T,>(work:()=>Promise<T>)=>{const next=serial.then(work);serial=next.catch(()=>{});return next;};
  async function browserRead(){const database=await databaseReader();return new Promise<string|null>((resolve,reject)=>{const request=database.transaction('private','readonly').objectStore('private').get('meta');request.onsuccess=()=>{if(request.result!==undefined&&request.result!==null&&typeof request.result!=='string'){reject(new Error('云同步元信息格式无效'));return;}resolve(request.result??null);};request.onerror=()=>reject(new Error('云同步元信息读取失败'));});}
  async function browserCompareAndSet(value:string,expected:string|null){
    const database=await databaseReader();
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction('private','readwrite'),store=tx.objectStore('private'),request=store.get('meta');let failure:Error|null=null;
      request.onsuccess=()=>{try{const current=request.result??null;if(current===value)return;if(current!==expected)throw new Error('另一页面已更新同步元信息；本次保存已停止，请关闭旧页面后重新打开。本机训练资料保持不变。');store.put(value,'meta');}catch(error){failure=error instanceof Error?error:new Error('同步元信息保存失败');tx.abort();}};
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??new Error('同步元信息事务中止，现有资料已保留'));tx.onerror=()=>reject(failure??new Error('同步元信息保存失败，现有资料已保留'));
    });
  }
  return {
    readMeta(){return locked(async()=>{baseline=null;const native=nativeReader();if(native){if(!native.cloudMetaRead)throw new Error('此安装包尚未接入云资料存储');const loaded=metaResult(native.cloudMetaRead(),true);baseline={kind:'native',hash:loaded.hash};return loaded.data;}const value=await browserRead();baseline={kind:'browser',value};return value;});},
    writeMeta(value){return locked(async()=>{
      if(!baseline)throw new Error('须先读取同步元信息，不能直接覆盖保存');
      if(new TextEncoder().encode(value).length>128*1024*1024)throw new Error('账号隔离档案达到容量保护；请导出备份并整理，现有资料未删除');
      const native=nativeReader();
      if(native){if(baseline.kind!=='native'||!native.cloudMetaWrite)throw new Error('同步存储环境已变化，请重新打开页面');const saved=metaResult(native.cloudMetaWrite(value,baseline.hash));baseline={kind:'native',hash:saved.hash};}
      else {if(baseline.kind!=='browser')throw new Error('同步存储环境已变化，请重新打开页面');await browserCompareAndSet(value,baseline.value);baseline={kind:'browser',value};}
    });},
    readSession(){return locked(async()=>{
      sessionBaseline=null;const native=nativeReader();
      if(native){if(!native.secureReadResult)throw new Error('请安装支持登录恢复保护的更新包，原资料保留');const loaded=metaResult(native.secureReadResult('cloud-session'),true);sessionBaseline={kind:'native',hash:loaded.hash};return loaded.data;}
      const database=await databaseReader();
      const loaded=await new Promise<{value:string|null;revision:number}>((resolve,reject)=>{
        const tx=database.transaction('private','readonly'),store=tx.objectStore('private'),value=store.get('session'),revision=store.get('session-revision');
        tx.oncomplete=()=>{const v=value.result??null,r=revision.result??0;if(v!==null&&typeof v!=='string'||!Number.isSafeInteger(r)||r<0){reject(new Error('登录存储版本无效，原资料保留'));return;}resolve({value:v,revision:r});};
        tx.onabort=tx.onerror=()=>reject(new Error('登录存储读取失败，原资料保留'));
      });sessionBaseline={kind:'browser',...loaded};return loaded.value;
    });},
    writeSession(value){return locked(async()=>{
      if(!sessionBaseline)throw new Error('须先读取登录状态，不能直接覆盖保存');
      if(value!==null&&new TextEncoder().encode(value).length>128*1024)throw new Error('账号会话超出容量');
      const native=nativeReader();
      if(native){if(sessionBaseline.kind!=='native'||!native.secureWriteIfCurrent)throw new Error('请安装支持登录恢复保护的更新包，原资料保留');const saved=metaResult(native.secureWriteIfCurrent('cloud-session',value??'',sessionBaseline.hash));sessionBaseline={kind:'native',hash:saved.hash};return;}
      if(sessionBaseline.kind!=='browser')throw new Error('登录存储环境已变化，请重新打开');
      const expected=sessionBaseline,database=await databaseReader();
      await new Promise<void>((resolve,reject)=>{
        const tx=database.transaction('private','readwrite'),store=tx.objectStore('private'),current=store.get('session'),revision=store.get('session-revision');let failure:Error|null=null;
        revision.onsuccess=()=>{try{
          // Equal pending payloads must still conflict: acknowledging both would
          // authorize two pages to consume the same refresh token. Keep a revision
          // even after logout so empty -> login -> empty cannot resurrect an old login.
          if((current.result??null)!==expected.value||(revision.result??0)!==expected.revision)throw new Error('另一页面已改变登录状态，请重新打开；原资料保留');
          if(expected.revision>=Number.MAX_SAFE_INTEGER)throw new Error('登录存储版本已达上限，原资料保留');
          if(value===null)store.delete('session');else store.put(value,'session');store.put(expected.revision+1,'session-revision');
        }catch(error){failure=error instanceof Error?error:new Error('登录保存失败');tx.abort();}};
        tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure??new Error('登录保存失败，原资料保留'));
      });sessionBaseline={kind:'browser',value,revision:expected.revision+1};
    });},
    readLocalIdentity(){return locked(async()=>{
      identityBaseline=null;const native=nativeReader();
      if(native){if(!native.localIdentityRead)throw new Error('请安装支持离线身份的更新包，原资料保留');const loaded=metaResult(native.localIdentityRead(),true);identityBaseline={kind:'native',hash:loaded.hash};return loaded.data;}
      const database=await databaseReader();const value=await new Promise<string|null>((resolve,reject)=>{const r=database.transaction('private','readonly').objectStore('private').get('local-identity');r.onsuccess=()=>typeof r.result==='string'||r.result==null?resolve(r.result??null):reject(new Error('本机身份格式无效'));r.onerror=()=>reject(new Error('本机身份读取失败'));});identityBaseline={kind:'browser',value};return value;
    });},
    writeLocalIdentity(value,announce=true){return locked(async()=>{
      if(!identityBaseline)throw new Error('须先核对本机身份，原资料保留');const reverified=identityBaseline.kind==='browser'&&sameActive(identityBaseline.value,value),native=nativeReader();
      if(native){if(identityBaseline.kind!=='native'||!native.localIdentityWrite)throw new Error('本机身份存储环境已变化');const saved=metaResult(native.localIdentityWrite(value,identityBaseline.hash));identityBaseline={kind:'native',hash:saved.hash};}
      else{
        if(identityBaseline.kind!=='browser')throw new Error('本机身份存储环境已变化');const expected=identityBaseline.value,database=await databaseReader();
        await new Promise<void>((resolve,reject)=>{const tx=database.transaction('private','readwrite'),s=tx.objectStore('private'),r=s.get('local-identity');let conflict=false;r.onsuccess=()=>{if((r.result??null)!==expected){conflict=true;tx.abort();}else s.put(value,'local-identity');};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(new Error(conflict?'另一页面已改变登录状态，请重新打开；原资料保留':'本机身份保存失败'));tx.onerror=()=>reject(new Error('本机身份保存失败'));});identityBaseline={kind:'browser',value};
      }
      // A quiet recheck still commits through CAS; real identity changes always notify.
      if(announce||!reverified)channel?.postMessage(reverified?'reverified':'changed');
    });},
  };
}
export const cloudStorage:CloudStorage=createCloudStorage();
