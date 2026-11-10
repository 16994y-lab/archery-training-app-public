import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {browserCamera,CaptureGuideVoice,CaptureSession,type CameraAdapter,type CameraPhase,type CaptureResult} from './capture-session';
import {useInnerBack} from './ui';
import './manual-capture.css';
import {PHOTO_HELP_TEXT} from './photo-help';
import './photo-next.css';

type Props={onPhoto:(result:CaptureResult)=>void;onClose:()=>void;onGallery:()=>void;adapter?:CameraAdapter;voice?:CaptureGuideVoice;demo?:boolean};
export function ManualCapture({onPhoto,onClose,onGallery,adapter=browserCamera,voice,demo=false}:Props){
 const video=useRef<HTMLVideoElement>(null),dialog=useRef<HTMLElement>(null),mounted=useRef(false),focusTicket=useRef(0);
 const focusEvidence=useRef<{kind:'not-requested'|'point'|'center'|'unsupported';point?:{x:number;y:number}}>({kind:'not-requested'}),voiceEvidence=useRef<'not-requested'|'requested'|'started'|'completed'|'unavailable'|'failed'|'stopped'>('not-requested');
 const [phase,setPhase]=useState<CameraPhase>('idle'),[message,setMessage]=useState(''),[speaking,setSpeaking]=useState(false),[voiceNote,setVoiceNote]=useState(''),[ratio,setRatio]=useState(3/4),[focusPoint,setFocusPoint]=useState<{x:number;y:number;kind:'waiting'|'point'|'center'|'unsupported'}|null>(null);
 const voiceRef=useRef<CaptureGuideVoice|null>(null);if(!voiceRef.current)voiceRef.current=voice??new CaptureGuideVoice(typeof speechSynthesis==='undefined'?undefined:speechSynthesis,text=>new SpeechSynthesisUtterance(text),typeof window==='undefined'?undefined:window.Gongxingji);
 const session=useRef<CaptureSession|null>(null);if(!session.current)session.current=new CaptureSession(adapter,(state,text)=>{if(mounted.current){setPhase(state);setMessage(text);}});
 const callbacks=useRef({onClose,onPhoto,onGallery});callbacks.current={onClose,onPhoto,onGallery};
 function stopVoice(record=false){voiceRef.current?.stop();if(record&&!['not-requested','completed','unavailable','failed'].includes(voiceEvidence.current))voiceEvidence.current='stopped';if(mounted.current)setSpeaking(false);}
 function invalidateFocus(){focusTicket.current++;focusEvidence.current={kind:'not-requested'};if(mounted.current)setFocusPoint(null);}
 function close(){invalidateFocus();session.current?.stop('closed','');stopVoice();callbacks.current.onClose();}
 useInnerBack(true,close,80);
 function speak(){stopVoice();voiceEvidence.current='requested';let settled=false;const ok=voiceRef.current!.play(()=>{settled=true;voiceEvidence.current='completed';if(mounted.current){setSpeaking(false);setVoiceNote('语音播放结束，可直接拍摄。');}},()=>{settled=true;voiceEvidence.current='failed';if(mounted.current){setSpeaking(false);setVoiceNote('本机语音播放失败，完整文字提示仍可查看；不影响拍摄。');}});if(!ok)voiceEvidence.current='unavailable';setSpeaking(ok&&!settled);if(!settled)setVoiceNote(ok?'已请求本机中文语音 · 可随时拍摄或停止':'当前设备没有可用的本机中文语音，已保留完整文字提示；不影响拍摄。');}
 function open(){invalidateFocus();if(demo){setMessage('合成演示不会打开相机');return;}if(video.current)void session.current!.open(video.current);}
 useEffect(()=>{
  mounted.current=true;const before=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';
  const pause=()=>{invalidateFocus();session.current?.stop('stopped','已切到后台，相机已关闭；返回后请重新开启。');stopVoice(true);if(mounted.current)setVoiceNote('切到后台后语音已停止；返回后可手动重播。');};
  const speech=(event:Event)=>{const detail=(event as CustomEvent<{state?:string;message?:string}>).detail;if(!detail)return;if(detail.state==='started'||detail.state==='pending')setSpeaking(true);else setSpeaking(false);if(detail.state==='started')voiceEvidence.current='started';else if(detail.state==='pending')voiceEvidence.current='requested';else if(detail.state==='done')voiceEvidence.current='completed';else if(detail.state==='unavailable')voiceEvidence.current='unavailable';else if(detail.state==='error')voiceEvidence.current='failed';else if(detail.state==='stopped')voiceEvidence.current='stopped';if(detail.message)setVoiceNote(detail.message);};
  const hidden=()=>{if(document.hidden)pause();};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}if(e.key==='Tab'){
   const items=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary,[tabindex="0"]')??[])].filter(item=>item.getClientRects().length>0);const first=items[0],last=items[items.length-1];
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }};
  document.addEventListener('visibilitychange',hidden);window.addEventListener('gongxingji-background',pause);window.addEventListener('gongxingji-speech',speech);window.addEventListener('pagehide',pause);window.addEventListener('keydown',key,true);
  dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  if(!demo){setVoiceNote('需要时可展开拍摄帮助，手动播放语音。');if(!document.hidden)open();else pause();}
  return()=>{mounted.current=false;focusTicket.current++;session.current?.stop('closed','');voiceRef.current?.stop();document.body.style.overflow=overflow;
   document.removeEventListener('visibilitychange',hidden);window.removeEventListener('gongxingji-background',pause);window.removeEventListener('gongxingji-speech',speech);window.removeEventListener('pagehide',pause);window.removeEventListener('keydown',key,true);if(before?.isConnected)before.focus();};
 },[]);
 useEffect(()=>{if(demo){invalidateFocus();session.current?.stop('stopped','合成演示不会打开相机');stopVoice(true);}},[demo]);
 async function take(){
  if(dialog.current?.querySelector('.capture-shutter')===document.activeElement)dialog.current.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
  focusTicket.current++;stopVoice(true);const result=video.current?await session.current!.take(video.current):null;if(result&&mounted.current)callbacks.current.onPhoto({...result,evidence:{focus:focusEvidence.current.kind,focusPoint:focusEvidence.current.point,voice:voiceEvidence.current,capturedAt:new Date().toISOString()}});}
 async function focusAt(clientX:number,clientY:number,frame:HTMLElement){
  if(phase!=='ready')return;const ticket=++focusTicket.current;const box=frame.getBoundingClientRect(),point={x:Math.min(1,Math.max(0,(clientX-box.left)/box.width)),y:Math.min(1,Math.max(0,(clientY-box.top)/box.height))};
  setFocusPoint({...point,kind:'waiting'});const result=await session.current!.focus(point);if(!mounted.current||ticket!==focusTicket.current||session.current!.phase!=='ready')return;focusEvidence.current={kind:result.kind,point};setFocusPoint({...point,kind:result.kind});
 }
 function gallery(){invalidateFocus();session.current?.stop('closed','');stopVoice();callbacks.current.onGallery();}
 const canTake=phase==='ready',pending=phase==='requesting'||phase==='capturing';
 return createPortal(<section ref={dialog} className="manual-capture capture-clean" role="dialog" aria-modal="true" aria-label="主靶引导拍摄">
  <header><button type="button" onClick={close}>取消</button><strong>主靶拍摄 <small>测试版</small></strong><span>手动快门</span></header>
  {demo&&<p className="capture-demo">合成取景演示 · 未开启摄像头 / 语音 / 识别</p>}
  <div className="capture-stage"><div className="capture-frame" role="button" tabIndex={canTake?0:-1} aria-label="相机取景；点按靶心位置对焦" onPointerUp={e=>void focusAt(e.clientX,e.clientY,e.currentTarget)} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&canTake){e.preventDefault();const box=e.currentTarget.getBoundingClientRect();void focusAt(box.left+box.width/2,box.top+box.height/2,e.currentTarget);}}} style={{aspectRatio:String(ratio),width:`min(100%, calc(var(--capture-height, 52vh) * ${ratio}))`}}>
   <video ref={video} muted playsInline autoPlay aria-label="后置相机完整取景" onResize={()=>{if(video.current?.videoWidth&&video.current.videoHeight)setRatio(video.current.videoWidth/video.current.videoHeight);}}/>
   <div className="capture-overlay" aria-hidden="true"><svg viewBox="0 0 100 100"><path className="paper-guide" d="M6 20V6H20M80 6H94V20M94 80V94H80M20 94H6V80"/><path className="capture-cross" d="M47 50H53M50 47V53"/></svg></div>
   {focusPoint&&<span className={`capture-focus capture-focus-${focusPoint.kind}`} style={{left:`${focusPoint.x*100}%`,top:`${focusPoint.y*100}%`}} aria-hidden="true"/>}
   {phase!=='ready'&&phase!=='capturing'&&<div className="capture-placeholder">{phase==='requesting'?'正在打开相机…':phase==='error'?'取景暂不可用':'相机已停止'}</div>}
  </div></div>
  <div className="capture-instructions"><strong>正对主靶，清晰后拍摄</strong><details><summary>拍摄帮助与语音</summary><p>{PHOTO_HELP_TEXT}</p><p>点按靶心可请求设备对焦。是否正对、距离是否合适请自行核对。</p><div className="capture-voice"><button type="button" onClick={speak} disabled={demo||phase==='capturing'}>{speaking?'重新播放语音':'播放语音提示'}</button><button type="button" disabled={demo} onClick={()=>{stopVoice(true);setVoiceNote('语音已停止，可直接拍摄。');}}>停止语音</button><span role="status">{speaking?'正在使用本机语音播报…':voiceNote}</span></div></details></div>
  <footer><p role={phase==='error'?'alert':'status'}>{message}</p>
   <div className="capture-shutter-row capture-shutter-two"><button type="button" onClick={gallery}>相册</button><button type="button" className="capture-shutter" onClick={()=>void take()} disabled={!canTake}>{phase==='capturing'?'正在拍摄…':'拍摄照片'}</button></div>
   {!canTake&&!pending&&<button type="button" className="capture-reopen" onClick={open}>重新开启相机</button>}
   <small>手动拍摄 · 核对候选后才记入成绩</small>
  </footer>
 </section>,document.body);
}
