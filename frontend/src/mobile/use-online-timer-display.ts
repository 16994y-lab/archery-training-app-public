import {useEffect,useRef,useState,type RefObject} from 'react';
import {claimTimerRoom,closeTimerRoom,publishTimerRoom,timerHeartbeatInterval,timerPairingEnded,type OnlineTimerFrame} from './online-timer-display';

export function useOnlineTimerDisplay(snapshot:RefObject<{frame:OnlineTimerFrame;cueExpiresAt:number}|null>){
 const [state,setState]=useState<'idle'|'pairing'|'waiting'|'connected'|'retrying'>('idle');
 const [message,setMessage]=useState('');
 const session=useRef<string|null>(null),flight=useRef(false),mounted=useRef(true);
 const [key,setKey]=useState<string|null>(null);

 function disconnect(){
  const prior=session.current;
  session.current=null;setKey(null);setState('idle');
  if(prior)void closeTimerRoom(prior).catch(()=>{});
 }

 async function connect(code:string){
  if(flight.current||session.current)return;
  flight.current=true;setState('pairing');setMessage('');
  try{
   const controlKey=await claimTimerRoom(code);
   if(!mounted.current||document.hidden){void closeTimerRoom(controlKey).catch(()=>{});return;}
   session.current=controlKey;setKey(controlKey);setState('waiting');
  }catch(error){
   if(mounted.current)setMessage(error instanceof Error?error.message:'配对未完成，请重新扫码。');
  }finally{
   flight.current=false;
   if(mounted.current&&!session.current)setState('idle');
  }
 }

 useEffect(()=>{
  mounted.current=true;
  function close(){
   const prior=session.current;
   session.current=null;
   if(prior)void closeTimerRoom(prior).catch(()=>{});
  }
  function onHidden(){
   if(!document.hidden||!session.current)return;
   disconnect();setMessage('已离开前台，大屏连接结束。');
  }
  document.addEventListener('visibilitychange',onHidden);
  window.addEventListener('pagehide',disconnect);
  return ()=>{
   mounted.current=false;close();
   document.removeEventListener('visibilitychange',onHidden);
   window.removeEventListener('pagehide',disconnect);
  };
 },[]);

 useEffect(()=>{
  if(!key)return;
  let active=true,seq=0,wait:number|undefined;
  async function tick(){
   if(!active||session.current!==key)return;
   try{
    const next=snapshot.current;
    const displayOnline=next&&await publishTimerRoom(key!,++seq,performance.now()<next.cueExpiresAt?next.frame:{...next.frame,signal:null});
    if(active&&session.current===key){
     setState(displayOnline?'connected':'waiting');
     setMessage(displayOnline?'':'等待电脑大屏回执，请确认网页仍开着。');
    }
   }catch(error){
    if(!active||session.current!==key)return;
    if(timerPairingEnded(error)){
     disconnect();setMessage('本次配对已结束，请重新扫码。');return;
    }
    setState('retrying');setMessage('大屏同步暂未确认，正在重连。');
   }finally{
    if(active&&session.current===key)wait=window.setTimeout(()=>void tick(),timerHeartbeatInterval);
   }
  }
  void tick();
  return ()=>{active=false;window.clearTimeout(wait);};
 },[key,snapshot]);
 return {state,message,connect,disconnect};
}
