import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';

/** A single-line label which reveals overflow after staying visible. */
export function DwellLabel({text}:{text:string}){
 const viewport=useRef<HTMLSpanElement>(null),content=useRef<HTMLSpanElement>(null);
 const [travel,setTravel]=useState(0),[visible,setVisible]=useState(false),[running,setRunning]=useState(false);
 useLayoutEffect(()=>{
  const outer=viewport.current,inner=content.current;if(!outer||!inner)return;
  const measure=()=>setTravel(Math.max(0,inner.scrollWidth-outer.clientWidth));measure();
  const resize=new ResizeObserver(measure);resize.observe(outer);resize.observe(inner);
  return()=>resize.disconnect();
 },[text]);
 useEffect(()=>{
  const node=viewport.current;if(!node)return;
  const observer=new IntersectionObserver(entries=>setVisible(Boolean(entries[0]?.isIntersecting&&entries[0].intersectionRatio>.9)),{threshold:[0,.9,1]});
  observer.observe(node);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  setRunning(false);if(!visible||travel<2)return;
  const timer=window.setTimeout(()=>setRunning(true),2400);return()=>clearTimeout(timer);
 },[visible,travel,text]);
 const style={'--choice-travel':`${travel}px`,'--choice-duration':`${Math.max(7,travel/24+4)}s`} as React.CSSProperties;
 return <span ref={viewport} className={`choice-label${running?' is-running':''}`} style={style} title={text}><span ref={content} className="choice-label-content">{text}</span></span>;
}
