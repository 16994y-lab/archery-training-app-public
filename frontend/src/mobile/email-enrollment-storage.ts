/** Registration continuation is private account state, never part of training exports. */
export type EnrollmentDraft={version:1;service:string;email:string;resume:string;enrollment:string|null;createdAt:string};
type NativeEnrollment={emailEnrollmentRead?:()=>string;emailEnrollmentWrite?:(value:string,expectedHash:string)=>string};
export interface EnrollmentStorage{read():Promise<EnrollmentDraft|null>;write(value:EnrollmentDraft|null):Promise<void>}
const storageKey='email-enrollment-v1';
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function parseEnrollmentDraft(raw:string|null):EnrollmentDraft|null{
 if(raw===null)return null;
 try{
  const value=JSON.parse(raw);
  if(!value||Object.keys(value).sort().join()!=='createdAt,email,enrollment,resume,service,version'||value.version!==1
   ||typeof value.service!=='string'||value.service.length>600||!value.service.includes('|')
   ||typeof value.email!=='string'||value.email.length>254||value.email!==value.email.trim().toLowerCase()||!/^\S+@\S+\.\S+$/.test(value.email)
   ||typeof value.resume!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value.resume)
   ||value.enrollment!==null&&!uuid(value.enrollment)
   ||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw Error();
  return value as EnrollmentDraft;
 }catch{throw new Error('注册进度无法读取，原内容已保留；请先核对，不要重复发送验证码');}
}
function reply(raw:string){
 const result=JSON.parse(raw);
 if(result?.ok!==true)throw new Error('注册进度未能安全保存，请重新读取，不要重复发送验证码');
 if(typeof result.hash!=='string'||! /^[a-f0-9]{64}$/.test(result.hash)||result.data!=null&&typeof result.data!=='string')throw new Error('注册进度存储响应无效');
 return {data:(result.data??null) as string|null,hash:result.hash as string};
}
let database:Promise<IDBDatabase>|null=null;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gongxingji-cloud-private',1);request.onupgradeneeded=()=>request.result.createObjectStore('private');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('账号独立存储不可用，请先核对注册进度'));});}
function bridge(){return typeof window==='undefined'?undefined:window.Gongxingji as typeof window.Gongxingji&NativeEnrollment;}
export function createEnrollmentStorage(nativeReader:()=>NativeEnrollment|undefined=bridge,databaseReader:()=>Promise<IDBDatabase>=db):EnrollmentStorage{
 let baseline:{kind:'native';hash:string}|{kind:'browser';raw:string|null}|null=null,serial:Promise<unknown>=Promise.resolve();
 const locked=<T,>(work:()=>Promise<T>)=>{const next=serial.then(work);serial=next.catch(()=>{});return next;};
 return {
  read(){return locked(async()=>{
   baseline=null;const native=nativeReader();
   if(native){if(!native.emailEnrollmentRead)throw new Error('请先更新应用以安全保存注册进度');const loaded=reply(native.emailEnrollmentRead());const parsed=parseEnrollmentDraft(loaded.data);baseline={kind:'native',hash:loaded.hash};return parsed;}
   const database=await databaseReader();const raw=await new Promise<string|null>((resolve,reject)=>{const request=database.transaction('private','readonly').objectStore('private').get(storageKey);request.onsuccess=()=>typeof request.result==='string'||request.result==null?resolve(request.result??null):reject(new Error('注册进度格式无效，原内容保留'));request.onerror=()=>reject(new Error('注册进度读取失败'));});
   const parsed=parseEnrollmentDraft(raw);baseline={kind:'browser',raw};return parsed;
  });},
  write(value){return locked(async()=>{
   const raw=value===null?null:JSON.stringify(value);parseEnrollmentDraft(raw);
   if(!baseline)throw new Error('请先读取注册进度，不能覆盖未知内容');
   const native=nativeReader();
   if(native){if(baseline.kind!=='native'||!native.emailEnrollmentWrite)throw new Error('注册存储环境已变化，请重新读取');const saved=reply(native.emailEnrollmentWrite(raw??'',baseline.hash));baseline={kind:'native',hash:saved.hash};return;}
   if(baseline.kind!=='browser')throw new Error('注册存储环境已变化，请重新读取');
   const expected=baseline.raw,database=await databaseReader();
   await new Promise<void>((resolve,reject)=>{const tx=database.transaction('private','readwrite'),store=tx.objectStore('private'),request=store.get(storageKey);let failure:Error|null=null;
    request.onsuccess=()=>{const current=request.result??null;if(current===raw)return;if(current!==expected){failure=new Error('另一页面已更新注册进度，本次未覆盖；请重新读取');tx.abort();return;}if(raw===null)store.delete(storageKey);else store.put(raw,storageKey);};
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??new Error('注册进度保存未完成，请先核对，不要重复发送验证码'));tx.onerror=()=>reject(failure??new Error('注册进度保存失败，请先核对，不要重复发送验证码'));
   });baseline={kind:'browser',raw};
  });},
 };
}
export const enrollmentStorage=createEnrollmentStorage();
export function newEnrollmentResume(random:Crypto=crypto){const bytes=new Uint8Array(32);random.getRandomValues(bytes);return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
