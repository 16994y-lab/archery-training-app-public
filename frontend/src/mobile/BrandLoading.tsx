import React,{useEffect,useState} from 'react';
import './brand-loading.css';
const logo=new URL('../../public/ui/logo-mark.png',import.meta.url).href;

/** Presentation deadlines do not change authentication or retry network requests. */
export function BrandLoading(){
 const [stage,setStage]=useState(0);
 useEffect(()=>{const slow=setTimeout(()=>setStage(1),8000),stalled=setTimeout(()=>setStage(2),15000);return()=>{clearTimeout(slow);clearTimeout(stalled);};},[]);
 return <main className={`brand-loading${stage===2?' brand-loading-stalled':''}`} aria-label="正在打开弓行记" aria-busy={stage<2}>
  <div className="brand-loading-center"><img className="brand-loading-logo" src={logo} alt="弓行记" width="108" height="108"/><p className="brand-loading-slogan">记录每一箭，看见每一次进步</p></div>
  {stage>0&&<div className="brand-loading-recovery" role="status"><p>{stage===1?'打开较慢，请稍候…':'暂时未能打开。已保存的记录仍保留。'}</p>{stage===2&&<button type="button" onClick={()=>window.location.reload()}>重新打开</button>}</div>}
 </main>;
}
