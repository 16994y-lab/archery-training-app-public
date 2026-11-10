import React, { useEffect, useRef, useState } from 'react';
import { Session, uid } from './domain';
import { Back, Button, Field, Panel, sessionIn, useApp, useInnerBack } from './ui';
export { PhotoWorkspace as PhotoEntry } from './PhotoWorkspace';
export function VideoEntry({session,onBack}:{session:Session;onBack:()=>void}) {
  const [mode,setMode]=useState<'motion'|'notes'>('motion');
  useInnerBack(true,onBack);
  return <><Back title="动作复盘 · 测试版" onBack={onBack}/><div className="actions">
    <Button kind={mode==='motion'?'primary':''} onClick={()=>setMode('motion')}>骨架与轨迹</Button>
    <Button kind={mode==='notes'?'primary':''} onClick={()=>setMode('notes')}>人工时间点与备注</Button>
  </div>{mode==='motion'?<MotionFrame/>:<VideoNotes session={session}/>}</>;
}
export function MotionOverview({onBack}:{onBack:()=>void}){
  useInnerBack(true,onBack);
  return <><Back title="视频教练 · 动作观察测试版" onBack={onBack}/><MotionFrame/></>;
}
export function MotionFrame(){
  const frame=useRef<HTMLIFrameElement>(null),resize=useRef<ResizeObserver|null>(null);
  const [height,setHeight]=useState(1000),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const current=frame.current;
    const signal=(type:string)=>{try{current?.contentWindow?.dispatchEvent(new Event(type));}catch{/* The iframe has already unloaded. */}};
    const stop=()=>signal('gongxingji-background');
    const hidden=()=>{if(document.visibilityState==='hidden')stop();};
    window.addEventListener('gongxingji-background',stop);document.addEventListener('visibilitychange',hidden);
    return()=>{signal('gongxingji-dispose');resize.current?.disconnect();window.removeEventListener('gongxingji-background',stop);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  return <section aria-label="本机动作观察"><p className="caption">模型随安装包离线提供。关节点是模型估计，不是动作评分；手机性能与拍摄条件会影响结果。</p>
    {failed&&<p role="alert">动作观察资源未能打开。可返回使用人工时间点与备注，记分不受影响。</p>}
    <iframe ref={frame} title="本机骨架与轨迹测试版" src="./motion-h1/index.html" allow="camera 'self'; microphone 'none'" style={{width:'100%',height,border:0,borderRadius:16,background:'#f4f8fd'}} onError={()=>setFailed(true)} onLoad={()=>{
      try{const doc=frame.current?.contentDocument;if(!doc?.querySelector('#pose-canvas')){setFailed(true);return;}
        resize.current?.disconnect();const fit=()=>setHeight(Math.max(700,Math.ceil(doc.documentElement.scrollHeight)));
        resize.current=new ResizeObserver(fit);resize.current.observe(doc.body);fit();
      }catch{setFailed(true);}
    }}/>
  </section>;
}
function VideoNotes({session}:{session:Session}) {const {update,tell}=useApp();const [url,setUrl]=useState(''),[note,setNote]=useState('');const ref=useRef<HTMLVideoElement>(null);useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);return <Panel><p>本人选择本机视频，手动记录时间点与观察。视频文件不上传、不复制进档案，重新打开时需再次选择原视频。此入口不是AI动作指导。</p><Field label="选择视频"><input type="file" accept="video/*" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)setUrl(URL.createObjectURL(file));}}/></Field>{url&&<video ref={ref} src={url} controls playsInline onError={()=>tell('此设备无法播放该视频格式；手动记分不受影响')}/>}<Field label="本人观察（不作自动动作诊断）"><textarea value={note} onChange={e=>setNote(e.target.value)}/></Field><Button disabled={!url||!note.trim()} onClick={async()=>{const time=ref.current?.currentTime??0;if(await update(d=>{sessionIn(d,session.id).videoNotes.push({id:uid(),time,note});}))setNote('');}}>保存当前视频时间点与备注</Button>{session.videoNotes.map(n=><p key={n.id}>{n.time.toFixed(1)}秒：{n.note}</p>)}</Panel>;}
