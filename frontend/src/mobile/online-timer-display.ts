import {transport} from './api';
import type {CompetitionDisplayFrame} from './CompetitionDisplay';
import type {TimerSignal as TimerSignalKind} from './timer-sound';

const keyPattern=/^[A-Za-z0-9_-]{43}$/;
const qrPrefix='gongxingji-timer:';
const signalKinds:TimerSignalKind[]=['prepare','shoot','warning','stop','scoring'];
export const timerDisplayWebsite=new URL('#/timer-display',location.href).href;
export const timerFrameTimeout=2500;
export const timerHeartbeatInterval=600;
export type TimerSignal={id:string;kind:TimerSignalKind};
export type OnlineTimerFrame=CompetitionDisplayFrame&{signal:TimerSignal|null};
type Room={displayKey:string;pairCode:string};
type DisplayState={connected:boolean;seq:number;frame:OnlineTimerFrame|null};

export function timerPairingQr(pairCode:string){return qrPrefix+pairCode;}
export function timerPairCode(text:string):string|null{
 const value=text.trim();
 const code=value.startsWith(qrPrefix)?value.slice(qrPrefix.length):value;
 return keyPattern.test(code)?code:null;
}

export class TimerDisplayError extends Error{
 constructor(readonly status:number,message:string){super(message);}
}
export function timerPairingEnded(error:unknown){
 return error instanceof TimerDisplayError&&[401,403,404,410].includes(error.status);
}

export async function timerDisplayAvailable():Promise<boolean>{
 try{return (await request('/status','GET'))?.ready===true;}
 catch{return false;}
}

async function request(path:string,method:string,token?:string,body?:object){
 const base=location.origin;
 const controller=new AbortController();
 const timeout=window.setTimeout(()=>controller.abort(),2200);
 const headers:Record<string,string>={};
 if(token)headers.Authorization='Bearer '+token;
 if(body)headers['Content-Type']='application/json';
 try{
  const response=await transport(base+'/api/timer-display'+path,{
   method,headers,body:body?JSON.stringify(body):undefined,signal:controller.signal,
   cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
   keepalive:method==='DELETE'
  });
  if(!response.ok)throw new TimerDisplayError(response.status,
   response.status===503?'在线大屏服务暂不可用。':
    response.status===429?'操作太快，请稍后再试。':
     '大屏配对已失效或连接未完成。');
  return response.status===204?null:await response.json();
 }finally{window.clearTimeout(timeout);}
}

function requireKey(value:unknown):string{
 if(typeof value!=='string'||!keyPattern.test(value))throw new Error('大屏服务返回的配对信息无效。');
 return value;
}
export async function createTimerRoom():Promise<Room>{
 const value=await request('/rooms','POST');
 return {displayKey:requireKey(value?.displayKey),pairCode:requireKey(value?.pairCode)};
}
export async function claimTimerRoom(pairCode:string){
 const value=await request('/claim','POST',undefined,{pairCode});
 return requireKey(value?.controlKey);
}
export async function readTimerRoom(displayKey:string):Promise<DisplayState>{
 const value=await request('/state','GET',displayKey);
 if(typeof value?.connected!=='boolean'||!Number.isSafeInteger(value.seq)||value.seq<0||
    (value.frame!==null&&!validFrame(value.frame)))throw new Error('大屏计时状态无效。');
 return value;
}
export async function publishTimerRoom(controlKey:string,seq:number,frame:OnlineTimerFrame):Promise<boolean>{
 const value=await request('/frame','PUT',controlKey,{seq,frame});
 if(typeof value?.displayOnline!=='boolean')throw new Error('大屏回执未能确认。');
 return value.displayOnline;
}
export function closeTimerRoom(key:string){
 return request('/connection','DELETE',key);
}

function validFrame(frame:unknown):frame is OnlineTimerFrame{
 if(!frame||typeof frame!=='object')return false;
 const value=frame as OnlineTimerFrame;
 return ['ready','prepare','shoot','warning','stopped','scoring'].includes(value.stage)&&
  typeof value.label==='string'&&value.label.length<=48&&
  Array.isArray(value.clocks)&&value.clocks.length>=1&&value.clocks.length<=2&&
  value.clocks.every(clock=>clock&&typeof clock.name==='string'&&clock.name.length<=12&&
   /^\d{2}:\d{2}$/.test(clock.time)&&typeof clock.active==='boolean')&&
  (value.signal===null||Boolean(value.signal&&typeof value.signal.id==='string'&&
   value.signal.id.length<=64&&signalKinds.includes(value.signal.kind)));
}
