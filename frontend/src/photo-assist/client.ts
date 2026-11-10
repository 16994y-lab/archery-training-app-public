import type {ContactPeak} from './decoder';
import {isPhotoStage,recordPhotoStage,type PhotoStage} from './diagnostics';
import {MAX_MODEL_BYTES} from './model-resource';
import {photoFailureMessage,photoProgressMessage,photoDownloadProgressMessage} from './messages';
import {inferNativeContacts,nativePhotoBridge,validContactResult} from './native-client';
export type ContactResult={peaks:ContactPeak[];width:number;height:number;inference_ms:number;verifiedModelSha256?:string|null};
export function inferContacts(canvas:HTMLCanvasElement,signal:AbortSignal,progress:(message:string)=>void,verifyContribution=false):Promise<ContactResult>{
 const native=nativePhotoBridge();if(native)return inferNativeContacts(native,canvas,signal,progress);
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new DOMException('已取消','AbortError'));return;}
  const width=canvas.width,height=canvas.height;
  if(!Number.isInteger(width)||!Number.isInteger(height)||Math.max(width,height)>1024||Math.min(width,height)<32){reject(Error('照片尺寸不支持识别'));return;}
  let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,ended=false;
  const startedAt=performance.now(),preparationDeadline=startedAt+480000,hardDeadline=startedAt+570000;
  let inferenceDeadline:number|undefined,modelDownloading=false,modelFetchDone=false,receivedBytes=0;
  const deadline=()=>Math.min(hardDeadline,inferenceDeadline??preparationDeadline);
  const cleanup=()=>{if(ended)return;ended=true;clearTimeout(timer);signal.removeEventListener('abort',abort);worker?.terminate();};
  const fail=(error:Error,phase:PhotoStage='PHOTO_FAILED')=>{if(ended)return;recordPhotoStage(phase);cleanup();reject(error);};
  const abort=()=>fail(new DOMException('已取消','AbortError'),'CANCELLED');
  const timeout=()=>fail(Error(inferenceDeadline===undefined?'模型准备超过8分钟，已停止。请检查网络后重试或返回手动记分。':'识别计算超过90秒，已停止。请重新拍摄或返回手动记分。'),'TIMEOUT');
  const arm=()=>{clearTimeout(timer);timer=setTimeout(timeout,Math.max(0,deadline()-performance.now()));};
  try{
   arm();signal.addEventListener('abort',abort,{once:true});
   const image=canvas.getContext('2d')!.getImageData(0,0,width,height),n=width*height,rgb=new Float32Array(n*3);
   for(let i=0;i<n;i++){rgb[i]=image.data[i*4]/255;rgb[n+i]=image.data[i*4+1]/255;rgb[n*2+i]=image.data[i*4+2]/255;}
   if(signal.aborted){abort();return;}if(performance.now()>=deadline()){timeout();return;}
   recordPhotoStage('INPUT_READY');worker=new Worker(new URL('./inference.worker.ts',import.meta.url),{type:'module'});
   worker.onerror=()=>fail(Error('本机识别运行失败，请返回手动记分。'));
   worker.onmessage=e=>{
    if(ended)return;if(performance.now()>=deadline()){timeout();return;}
    const r=e.data;if(!r||typeof r!=='object'){fail(Error('识别消息无法核对'));return;}
    if(r.type==='stage'){
     if(!isPhotoStage(r.stage))return;
     // Only the first actual computation marker can switch the fixed budget.
     // Repeated or out-of-order phases and byte progress never extend a deadline.
     if(r.stage==='INFERENCE_RUN'&&inferenceDeadline===undefined){inferenceDeadline=Math.min(hardDeadline,performance.now()+90000);arm();}
     if(r.stage==='MODEL_FETCH'&&!modelFetchDone&&inferenceDeadline===undefined)modelDownloading=true;
     if(r.stage==='MODEL_FETCH_DONE'||inferenceDeadline!==undefined){modelDownloading=false;modelFetchDone=true;}
     recordPhotoStage(r.stage);
     try{const message=photoProgressMessage(r.stage);if(message)progress(message);}catch{fail(Error('识别界面未能更新，请返回手动记分。'));return;}
     if(!ended)try{worker?.postMessage({type:'stage-ack',stage:r.stage});}catch{}return;
    }
    if(r.type==='model-download'){
     if(!modelDownloading||inferenceDeadline!==undefined||!Number.isSafeInteger(r.receivedBytes)||r.receivedBytes<=receivedBytes||r.receivedBytes>MAX_MODEL_BYTES)return;
     receivedBytes=r.receivedBytes;
     try{progress(photoDownloadProgressMessage(receivedBytes));}catch{fail(Error('识别界面未能更新，请返回手动记分。'));}return;
    }
    if(r.type==='progress')return; // Never forward arbitrary worker text.
    if(r.type==='error'){fail(Error(photoFailureMessage(r.code)));return;}
    if(r.verifiedModelSha256!=null&&(typeof r.verifiedModelSha256!=='string'||! /^[a-f0-9]{64}$/.test(r.verifiedModelSha256)))r.verifiedModelSha256=null;
    if(r.type!=='result'||inferenceDeadline===undefined||!validContactResult(r,width,height)){fail(Error('识别结果校验失败，未导入候选。'));return;}
    recordPhotoStage('RESULT_READY');cleanup();resolve({peaks:r.peaks,width:r.width,height:r.height,inference_ms:r.inference_ms,verifiedModelSha256:r.verifiedModelSha256??null});
   };
   worker.postMessage({rgb,width,height,verifyContribution,assetBase:new URL('photo-assist/',document.baseURI).href},[rgb.buffer]);
  }catch{fail(Error('本机识别未能启动，请返回手动记分。'));}
 });
}
