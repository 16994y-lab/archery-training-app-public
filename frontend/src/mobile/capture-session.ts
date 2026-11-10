export const CAPTURE_GUIDE = '请正对主靶，让靶纸完整入镜，箭与靶面的接触处保持清晰。停稳后，点击拍摄。';
export const GUIDE_SEEN_KEY = 'gongxingji.manual-capture-guide.v1';
export type CameraPhase = 'idle'|'requesting'|'ready'|'capturing'|'stopped'|'error'|'closed';
export type CaptureEvidence={focus:'not-requested'|'point'|'center'|'unsupported';focusPoint?:{x:number;y:number};voice:'not-requested'|'requested'|'started'|'completed'|'unavailable'|'failed'|'stopped';capturedAt:string};
export type CaptureResult = {file:File;method:'photo'|'video-frame';evidence?:CaptureEvidence};
export type CameraAdapter = {
 acquire:()=>Promise<MediaStream>;
 capture:(video:HTMLVideoElement,track:MediaStreamTrack)=>Promise<CaptureResult>;
};
export const stopTracks=(stream:MediaStream|null)=>stream?.getTracks().forEach(t=>t.stop());
export type CameraFocusResult={kind:'point'|'center'|'unsupported';message:string};
type FocusCapabilities=MediaTrackCapabilities&{focusMode?:string[];pointsOfInterest?:boolean};
type FocusConstraints=MediaTrackConstraintSet&{focusMode?:string;pointsOfInterest?:{x:number;y:number}[]};
export async function focusCameraAt(track:MediaStreamTrack,point:{x:number;y:number}):Promise<CameraFocusResult>{
 const x=Math.min(1,Math.max(0,point.x)),y=Math.min(1,Math.max(0,point.y));
 let capabilities:FocusCapabilities;try{capabilities=track.getCapabilities() as FocusCapabilities;}catch{return {kind:'unsupported',message:'此设备没有开放点按对焦；请停稳并使用系统自动对焦。'};}
 const supported=typeof navigator==='undefined'?undefined:navigator.mediaDevices?.getSupportedConstraints?.() as (MediaTrackSupportedConstraints&{pointsOfInterest?:boolean;focusMode?:boolean})|undefined;
 const pointSupported=capabilities.pointsOfInterest===true||supported?.pointsOfInterest===true;
 const modes=Array.isArray(capabilities.focusMode)?capabilities.focusMode:[],mode=modes.includes('single-shot')?'single-shot':modes.includes('continuous')?'continuous':undefined;
 if(!pointSupported&&!mode)return {kind:'unsupported',message:'此设备没有开放点按对焦；请停稳并使用系统自动对焦。'};
 const next:FocusConstraints={};if(pointSupported)next.pointsOfInterest=[{x,y}];if(mode)next.focusMode=mode;
 try{await track.applyConstraints({advanced:[next] as MediaTrackConstraintSet[]});return pointSupported?{kind:'point',message:'已在点击位置请求对焦；等画面清晰后再拍摄。'}:{kind:'center',message:'设备不支持指定位置，已重新触发自动对焦。'};}
 catch{return {kind:'unsupported',message:'点按对焦未被此设备接受；请停稳并使用系统自动对焦。'};}
}
export function cameraError(error:unknown):string {
 const name=(error as {name?:string})?.name;
 if(name==='NotAllowedError'||name==='SecurityError')return '未获得相机权限。可以从相册选择已有照片，也可以退出后使用手动记分。';
 if(name==='OverconstrainedError'||name==='NotFoundError')return '未找到可用的后置相机。请从相册选择已有照片。';
 if(name==='NotReadableError')return '相机可能正在被其他应用使用。请关闭占用后重试，或从相册选择照片。';
 return error instanceof Error?error.message:'相机暂不可用，请从相册选择照片或退出后使用手动记分。';
}
export function deadline<T>(promise:Promise<T>,ms:number,signal?:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(fn:()=>void)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);fn();};
  const cancel=()=>finish(()=>reject(new Error('本次拍摄已取消。')));
  const timer=setTimeout(()=>finish(()=>reject(new Error('相机响应超时，请重试或从相册选择照片。'))),ms);
  if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});
  promise.then(v=>finish(()=>resolve(v)),e=>finish(()=>reject(e)));
 });
}
function videoReady(video:HTMLVideoElement,signal:AbortSignal):Promise<void>{
 if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0)return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{video.removeEventListener('loadeddata',ready);video.removeEventListener('resize',ready);signal.removeEventListener('abort',cancel);clearTimeout(timer);};
  const ready=()=>{if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0){cleanup();resolve();}};
  const cancel=()=>{cleanup();reject(new Error('本次拍摄已取消。'));};
  const timer=setTimeout(()=>{cleanup();reject(new Error('没有收到相机画面，请从相册选择照片。'));},10000);
  video.addEventListener('loadeddata',ready);video.addEventListener('resize',ready);signal.addEventListener('abort',cancel,{once:true});
  if(signal.aborted)cancel();else ready();
 });
}
/** One owner, one in-flight shutter. A late permission grant is stopped, never adopted. */
export class CaptureSession {
 phase:CameraPhase='idle';private epoch=0;private focusEpoch=0;private stream:MediaStream|null=null;private abort:AbortController|null=null;private video:HTMLVideoElement|null=null;
 constructor(private adapter:CameraAdapter,private changed:(phase:CameraPhase,message:string)=>void){}
 private emit(phase:CameraPhase,message=''){this.phase=phase;this.changed(phase,message);}
 stop(phase:CameraPhase='stopped',message='相机已停止。需要继续时，请重新开启。'){
  this.epoch++;this.abort?.abort();this.abort=null;const stream=this.stream;this.stream=null;
  stream?.getVideoTracks().forEach(t=>t.removeEventListener('ended',this.ended));stopTracks(stream);
  if(this.video){this.video.pause();this.video.srcObject=null;this.video=null;}this.emit(phase,message);
 }
 private ended=()=>this.stop('stopped','相机画面已中断，请重新开启或从相册选择照片。');
 async open(video:HTMLVideoElement){
  if(this.phase==='requesting'||this.phase==='ready'||this.phase==='capturing')return;
  this.stop('idle','');const ticket=++this.epoch,ctl=new AbortController();this.abort=ctl;this.video=video;this.emit('requesting','正在打开后置相机…');
  try{
   const requested=this.adapter.acquire().then(stream=>{if(ticket!==this.epoch)stopTracks(stream);return stream;});
   const stream=await deadline(requested,15000,ctl.signal);if(ticket!==this.epoch)return;
   this.stream=stream;const track=stream.getVideoTracks()[0];
   if(!track||track.readyState!=='live'||stream.getAudioTracks().length)throw new Error('未获得有效的纯视频画面，请从相册选择照片。');
   if(track.getSettings().facingMode==='user')throw new Error('当前是前置相机，已关闭。请检查权限后重试，或从相册选择后摄照片。');
   track.addEventListener('ended',this.ended);video.srcObject=stream;
   await deadline(Promise.resolve(video.play()),10000,ctl.signal);await videoReady(video,ctl.signal);
   if(ticket===this.epoch)this.emit('ready',track.getSettings().facingMode==='environment'?'后置取景已开启 · 对准后手动拍摄':'取景已开启 · 请确认画面中是主靶，设备未报告镜头方向');
  }catch(e){if(ticket===this.epoch)this.stop('error',cameraError(e));}
 }
 async take(video:HTMLVideoElement):Promise<CaptureResult|null>{
  const track=this.stream?.getVideoTracks()[0];
  if(this.phase!=='ready'||!track||track.readyState!=='live')return null;
  const ticket=this.epoch;this.emit('capturing','正在拍摄…');
  try{
   const result=await deadline(this.adapter.capture(video,track),12000,this.abort?.signal);
   if(ticket!==this.epoch)return null;
   this.stop('closed','照片已拍摄，相机已关闭。');return result;
  }catch(e){if(ticket===this.epoch)this.stop('error',cameraError(e));return null;}
 }
 async focus(point:{x:number;y:number}):Promise<CameraFocusResult>{
  const track=this.stream?.getVideoTracks()[0];if(this.phase!=='ready'||!track||track.readyState!=='live')return {kind:'unsupported',message:'相机尚未准备好，暂不能对焦。'};
  const ticket=this.epoch,focusTicket=++this.focusEpoch;
  const result=await focusCameraAt(track,point);
  if(ticket!==this.epoch||focusTicket!==this.focusEpoch||this.phase!=='ready'||this.stream?.getVideoTracks()[0]!==track)return {kind:'unsupported',message:'本次对焦已取消，请在当前画面重新点按。'};
  this.emit('ready',result.message);return result;
 }
}
export function frameSize(width:number,height:number){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>40_000_000)throw new Error('相机画面尺寸不可用，请从相册选择照片。');
 return {width,height};
}
type StillCamera=new(track:MediaStreamTrack)=>{takePhoto:(settings?:{fillLightMode:string})=>Promise<Blob>};
export async function captureCameraImage(video:HTMLVideoElement,track:MediaStreamTrack,Still:StillCamera|undefined=(globalThis as unknown as {ImageCapture?:StillCamera}).ImageCapture,makeCanvas=()=>document.createElement('canvas')):Promise<CaptureResult>{
 if(track.readyState!=='live'||video.readyState<2)throw new Error('相机画面尚未准备好。');
 if(Still){try{
  const blob=await deadline(new Still(track).takePhoto({fillLightMode:'off'}),4000);
  if(track.readyState!=='live')throw new Error('相机已关闭。');
  if(blob.size>0&&blob.size<=20*1024*1024&&/^image\/(jpeg|png|webp)$/.test(blob.type))return {file:new File([blob],'target-photo.jpg',{type:blob.type}),method:'photo'};
 }catch{/* Unsupported still capture falls back to the complete camera frame, never a UI screenshot. */}}
 if(track.readyState!=='live'||video.readyState<2)throw new Error('相机画面已中断。');
 const {width,height}=frameSize(video.videoWidth,video.videoHeight),canvas=makeCanvas();
 canvas.width=width;canvas.height=height;
 try{
  const context=canvas.getContext('2d');if(!context)throw new Error('无法读取照片，请从相册选择照片。');
  context.drawImage(video,0,0,width,height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('照片生成失败，请重试。')),'image/jpeg',.95));
  if(!blob.size||blob.size>20*1024*1024)throw new Error('照片大小不可用，请从相册选择照片。');
  return {file:new File([blob],'target-camera-frame.jpg',{type:'image/jpeg'}),method:'video-frame'};
 }finally{canvas.width=canvas.height=0;}
}
export const browserCamera:CameraAdapter={
 acquire:()=>{if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)return Promise.reject(new Error('此环境不能使用应用内相机，请从相册选择照片。'));
 return navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{exact:'environment'},width:{ideal:1920},height:{ideal:1440}}});},
 capture:captureCameraImage,
};
export function chooseLocalChinese<T extends {lang:string;localService:boolean}>(voices:T[]):T|undefined{return voices.find(v=>v.localService===true&&/^zh(?:-|_|$)/i.test(v.lang));}
export type GuideSpeechBridge={speakGuide?:(text:string)=>string;stopGuide?:()=>void};
/** No default voice, remote service, voice download, or deferred autoplay. */
export class CaptureGuideVoice {
 private owned:false|'web'|'native'=false;private epoch=0;
 constructor(private synth:SpeechSynthesis|undefined,private utterance:(text:string)=>SpeechSynthesisUtterance=text=>new SpeechSynthesisUtterance(text),private native?:GuideSpeechBridge){}
 stop(){this.epoch++;if(this.owned==='native'){try{this.native?.stopGuide?.();}catch{/* Text and camera stay available if native speech fails. */}}else if(this.owned==='web'){try{this.synth?.cancel();}catch{/* Text and camera stay available if speech APIs fail. */}}this.owned=false;}
 play(done:()=>void,failed:()=>void=()=>{}):boolean{
  this.stop();try{
   if(this.native?.speakGuide){const response=JSON.parse(this.native.speakGuide(CAPTURE_GUIDE));if(response.ok){this.owned='native';return true;}}
   if(!this.synth||this.synth.speaking||this.synth.pending)return false;
   const voice=chooseLocalChinese(this.synth.getVoices());if(!voice)return false;
   const ticket=this.epoch,u=this.utterance(CAPTURE_GUIDE);u.voice=voice;u.lang=voice.lang;u.rate=1;
   u.onend=()=>{if(ticket===this.epoch){this.owned=false;done();}};
   u.onerror=()=>{if(ticket===this.epoch){this.owned=false;failed();}};
   this.owned='web';this.synth.speak(u);return true;
  }catch{this.owned=false;return false;}
 }
}
let seenThisProcess=false;
export function firstGuide(storage?:Pick<Storage,'getItem'|'setItem'>):boolean{
 let seen=seenThisProcess;try{seen=seen||storage?.getItem(GUIDE_SEEN_KEY)==='seen';}catch{/* Read failure: memory only. */}
 seenThisProcess=true;try{storage?.setItem(GUIDE_SEEN_KEY,'seen');}catch{/* No media or app data is affected. */}return !seen;
}
