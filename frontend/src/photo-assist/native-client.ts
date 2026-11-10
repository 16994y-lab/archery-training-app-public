import {isPhotoStage,recordPhotoStage} from './diagnostics';
import type {ContactResult} from './client';

type NativeBridge={photoInferenceStart:(id:string,png:string,width:number,height:number)=>string;photoInferenceCancel:(id:string)=>void};
export function nativePhotoBridge():NativeBridge|undefined{
 const bridge=(globalThis as typeof globalThis&{Gongxingji?:Partial<NativeBridge>}).Gongxingji;
 return typeof bridge?.photoInferenceStart==='function'&&typeof bridge.photoInferenceCancel==='function'?bridge as NativeBridge:undefined;
}
export function validContactResult(value:unknown,width:number,height:number):value is ContactResult{
 if(!value||typeof value!=='object')return false;
 const r=value as ContactResult;
 return r.width===width&&r.height===height&&Number.isFinite(r.inference_ms)&&r.inference_ms>=0&&Array.isArray(r.peaks)&&r.peaks.length<=256&&r.peaks.every(p=>p!==null&&typeof p==='object'&&Number.isInteger(p.x)&&Number.isInteger(p.y)&&p.x>=0&&p.x<width&&p.y>=0&&p.y<height&&Number.isFinite(p.response)&&p.response>=0&&p.response<=1)&&(r.verifiedModelSha256==null||typeof r.verifiedModelSha256==='string'&&/^[a-f0-9]{64}$/.test(r.verifiedModelSha256));
}
export function inferNativeContacts(bridge:NativeBridge,canvas:HTMLCanvasElement,signal:AbortSignal,progress:(message:string)=>void):Promise<ContactResult>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new DOMException('已取消','AbortError'));return;}
  const id=crypto.randomUUID(),width=canvas.width,height=canvas.height;
  let done=false,started=false,timer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('gongxingji-photo-result',receive);signal.removeEventListener('abort',abort);};
  const cancel=()=>{if(started)try{bridge.photoInferenceCancel(id);}catch{}};
  const fail=(message:string,aborted=false)=>{if(done)return;done=true;cancel();cleanup();recordPhotoStage(aborted?'CANCELLED':'PHOTO_FAILED');reject(aborted?new DOMException(message,'AbortError'):new Error(message));};
  const abort=()=>fail('已取消识别。',true);
  const receive=(event:Event)=>{
   if(done)return;const r=(event as CustomEvent).detail;if(!r||r.id!==id)return;
   if(r.type==='stage'){
    // Native phases are logged by the native executor, before allocations begin.
    if(isPhotoStage(r.stage))try{if(r.stage==='SESSION_CREATE')progress('正在加载本机识别模型…');else if(r.stage==='INFERENCE_RUN')progress('正在寻找接触点…');}catch{fail('识别界面未能更新，请返回手动记分。');}
    return;
   }
   if(r.type==='error'){fail(r.code==='PHOTO_TIMEOUT'?'识别超过90秒，已停止。请返回手动记分。':r.code==='PHOTO_CANCELLED'?'已取消识别。':'本机识别计算未完成，请返回手动记分。',r.code==='PHOTO_CANCELLED');return;}
   if(r.type!=='result'||!validContactResult(r,width,height)){fail('识别结果未通过检查，未导入候选。');return;}
   done=true;cleanup();resolve(r);
  };
  try{
   if(!Number.isInteger(width)||!Number.isInteger(height)||Math.min(width,height)<32||Math.max(width,height)>1024)throw Error('input');
   const png=canvas.toDataURL('image/png');if(!png.startsWith('data:image/png;base64,')||png.length>8*1024*1024)throw Error('input');
   window.addEventListener('gongxingji-photo-result',receive);signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{recordPhotoStage('TIMEOUT');fail('识别超过90秒，已停止。请返回手动记分。');},90000);
   progress('正在加载本机识别模型…');if(done||signal.aborted)return;recordPhotoStage('INPUT_READY');started=true;
   const ack=JSON.parse(bridge.photoInferenceStart(id,png,width,height));if(!ack||ack.ok!==true)fail(ack?.code==='PHOTO_BUSY'?'上一张照片仍在结束处理中，请稍后再试。':'照片未能开始识别，请返回手动记分。');
  }catch{fail('本机识别未能启动，请返回手动记分。');}
 });
}
