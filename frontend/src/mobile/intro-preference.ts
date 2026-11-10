// Presentation only: local completion never grants product access.
export type IntroStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type RegistrationIntroStage='password'|'intro'|'done';
const stages=new Map<string,RegistrationIntroStage>(),persistence=new Map<string,boolean>();
function storage():IntroStorage|undefined{try{return localStorage;}catch{return undefined;}}
function accountKey(owner:string){if(!owner||owner.length>200||/[\u0000-\u001f]/.test(owner))throw new Error('介绍账号未确认');return 'gongxingji-registration-intro-v2:'+owner;}
function read(owner:string,store?:IntroStorage):RegistrationIntroStage|null{
 const key=accountKey(owner);if(stages.has(key))return stages.get(key)!;
 try{const value=store?.getItem(key);return value==='pending'?'password':value==='password'||value==='intro'||value==='done'?value:null;}catch{return null;}
}
function write(owner:string,value:RegistrationIntroStage,store?:IntroStorage){const key=accountKey(owner);stages.set(key,value);let durable=false;try{store?.setItem(key,value);durable=store?.getItem(key)===value;}catch{}persistence.set(key,durable);return durable;}
export function registrationIntroPersistence(owner:string|null){return owner?persistence.get(accountKey(owner))??null:null;}
/** Root calls only after proven new-registration completion, never ordinary login/recovery. */
export function markRegistrationIntroPending(owner:string,store=storage()){
 if(read(owner,store))return;const durable=write(owner,'password',store);
 if(typeof window!=='undefined')window.dispatchEvent(new Event('gongxingji-registration-intro'));
 return durable;
}
export function registrationIntroStage(owner:string|null,store=storage()){
 if(!owner)return null;const value=read(owner,store);return value==='done'?null:value;
}
export function hasPendingRegistrationIntro(owner:string|null,store=storage()){return registrationIntroStage(owner,store)!==null;}
/** Skipping/saving password advances immediately so relaunch cannot repeat the optional prompt. */
export function advanceRegistrationIntro(owner:string,store=storage()){
 if(read(owner,store)==='password')return write(owner,'intro',store);return registrationIntroPersistence(owner);
}
export function finishRegistrationIntro(owner:string,store=storage()){return write(owner,'done',store);}
// Compatibility for presentation-only callers; startup ignores the old device-wide flag.
export function hasSeenIntro(){try{return storage()?.getItem('gongxingji-intro-v1')==='seen';}catch{return false;}}
export function markIntroSeen(){try{storage()?.setItem('gongxingji-intro-v1','seen');}catch{}}
