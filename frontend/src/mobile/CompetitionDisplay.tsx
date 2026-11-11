import {useEffect,useState,type ReactNode} from 'react';

export const displayChannelName=(key:string)=>`gongxingji-competition-display-${key}`;
export type CompetitionDisplayFrame={
 stage:'ready'|'prepare'|'shoot'|'warning'|'stopped'|'scoring';
 label:string;
 clocks:{name:string;time:string;active:boolean}[];
};

export function competitionDisplayKey(hash:string){
 const [path,query]=hash.split('?');
 if(path!=='#/competition-display')return null;
 const key=new URLSearchParams(query).get('key');
 return key&&/^[a-f0-9-]{36}$/.test(key)?key:null;
}

export function CompetitionDisplay({displayKey}:{displayKey:string}){
 const [frame,setFrame]=useState<CompetitionDisplayFrame|null>(null);
 useEffect(()=>{
  if(!('BroadcastChannel' in window))return;
  const channel=new BroadcastChannel(displayChannelName(displayKey));
  let lastFrame=0;
  channel.onmessage=event=>{
   const value=event.data as CompetitionDisplayFrame;
   if(!value||!['ready','prepare','shoot','warning','stopped','scoring'].includes(value.stage)||
    typeof value.label!=='string'||value.label.length>48||!Array.isArray(value.clocks)||
    value.clocks.length<1||value.clocks.length>2||
    value.clocks.some(clock=>!clock||typeof clock.name!=='string'||clock.name.length>12||
     typeof clock.time!=='string'||!/^\d{2}:\d{2}$/.test(clock.time)||typeof clock.active!=='boolean'))return;
   lastFrame=performance.now();setFrame(value);
  };
  const watch=window.setInterval(()=>{if(performance.now()-lastFrame>2500)setFrame(null);},250);
  return ()=>{window.clearInterval(watch);channel.close();};
 },[displayKey]);
 return <CompetitionDisplayScreen frame={frame}/>;
}

export function CompetitionDisplayScreen({frame,actions,emptyLabel='等待控制窗口 · 请停止发射'}:{
 frame:CompetitionDisplayFrame|null;actions?:ReactNode;emptyLabel?:string;
}){
 return <main className="competition-timer-screen competition-timer-remote">
  <div className="competition-timer-display" data-stage={frame?.stage??'stopped'}>
   <div className="competition-timer-display-head"><span>弓行记 · 比赛计时</span><div className="competition-timer-display-actions">{actions}<button className="button" type="button" onClick={()=>{if(!document.fullscreenElement)void document.documentElement.requestFullscreen?.().catch(()=>{});else void document.exitFullscreen().catch(()=>{});}}>全屏</button></div></div>
   {frame?.clocks.length===2?<div className="competition-timer-sides">{frame.clocks.map(clock=><div key={clock.name} className="competition-timer-side" data-active={clock.active}>
    <span>{clock.name}</span><div role="timer" aria-label={clock.name+'剩余时间'}>{clock.time}</div>
   </div>)}</div>:<div className="competition-timer-time" role="timer" aria-label="剩余时间">{frame?.clocks[0]?.time??'–:–'}</div>}
   <div className="competition-timer-stage" role="status">{frame?.label??emptyLabel}</div>
  </div>
 </main>;
}
