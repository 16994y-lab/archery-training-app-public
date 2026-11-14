import {useEffect,useRef,useState} from 'react';
import {Button} from './ui';
import {timerPairCode} from './online-timer-display';

export function TimerPairScanner({onCode,busy}:{onCode:(code:string)=>void;busy:boolean}){
 const [camera,setCamera]=useState(false),[input,setInput]=useState(''),[message,setMessage]=useState(''),[needsPlay,setNeedsPlay]=useState(false);
 const video=useRef<HTMLVideoElement>(null),callback=useRef(onCode);
 callback.current=onCode;
 useEffect(()=>{
  if(!camera)return;
  const player=video.current;
  if(!player)return;
  let active=true,stream:MediaStream|undefined,scan:number|undefined;
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  async function open(){
   try{
    if(!navigator.mediaDevices?.getUserMedia||!context)throw new Error('camera unavailable');
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    if(!active){stream.getTracks().forEach(track=>track.stop());return;}
    player!.srcObject=stream;
    try{await player!.play();}catch{if(active)setNeedsPlay(true);}
    const {default:decode}=await import('jsqr');
    if(!active)return;
    scan=window.setInterval(()=>{
     if(!active||!player!.videoWidth)return;
     const scale=Math.min(1,720/Math.max(player!.videoWidth,player!.videoHeight));
     canvas.width=Math.max(1,Math.round(player!.videoWidth*scale));
     canvas.height=Math.max(1,Math.round(player!.videoHeight*scale));
     context!.drawImage(player!,0,0,canvas.width,canvas.height);
     const pixels=context!.getImageData(0,0,canvas.width,canvas.height);
     const result=decode(pixels.data,pixels.width,pixels.height,{inversionAttempts:'dontInvert'});
     if(!result)return;
     const code=timerPairCode(result.data);
     if(!code){setMessage('这不是弓行记大屏的配对码。');return;}
     active=false;window.clearInterval(scan);
     stream?.getTracks().forEach(track=>track.stop());
     setMessage('');setCamera(false);callback.current(code);
    },175);
   }catch{
    if(active){setCamera(false);setMessage('相机未能打开。请检查相机权限，或从大屏复制配对码。');}
   }
  }
  void open();
  return ()=>{
   active=false;window.clearInterval(scan);stream?.getTracks().forEach(track=>track.stop());
   player.srcObject=null;
  };
 },[camera]);
 return <div className="timer-pair-scanner">
  {camera?<><video ref={video} autoPlay muted playsInline aria-label="扫描大屏配对码"/>
   {needsPlay&&<Button onClick={()=>void video.current?.play().then(()=>setNeedsPlay(false),()=>setMessage('相机预览暂不可用，可改用配对码。'))}>启动相机预览</Button>}
   <Button onClick={()=>setCamera(false)}>关闭相机</Button></>:
   <Button kind="primary" disabled={busy} onClick={()=>{setMessage('');setNeedsPlay(false);setCamera(true);}}>扫一扫连接大屏</Button>}
  <details><summary>无法扫码时，输入配对码</summary>
   <form onSubmit={event=>{
    event.preventDefault();
    const code=timerPairCode(input);
    if(!code){setMessage('配对码格式不正确，请从大屏完整复制。');return;}
    setCamera(false);setInput('');setMessage('');callback.current(code);
   }}>
    <label>配对码<input value={input} onChange={event=>setInput(event.target.value)} maxLength={100} autoComplete="off" autoCapitalize="none" spellCheck={false}/></label>
    <Button type="submit" disabled={busy||!input.trim()}>连接大屏</Button>
   </form>
  </details>
  {message&&<p role="status">{message}</p>}
 </div>;
}
