import {useEffect,useMemo,useRef,useState} from 'react';
import qrcode from 'qrcode-generator';
import {CompetitionDisplayScreen} from './CompetitionDisplay';
import {closeTimerRoom,createTimerRoom,readTimerRoom,timerDisplayAvailable,timerFrameTimeout,timerPairingEnded,timerPairingQr,type OnlineTimerFrame} from './online-timer-display';
import {createTimerSound} from './timer-sound';

type Room=Awaited<ReturnType<typeof createTimerRoom>>;

export function OnlineCompetitionDisplay(){
 const [room,setRoom]=useState<Room|null>(null),[paired,setPaired]=useState(false);
 const [frame,setFrame]=useState<OnlineTimerFrame|null>(null),[error,setError]=useState('');
 const [opening,setOpening]=useState(false),[soundOn,setSoundOn]=useState(false),[soundHint,setSoundHint]=useState('');
 const currentRoom=useRef<Room|null>(null),mounted=useRef(true),openingRef=useRef(false);
 const sound=useMemo(createTimerSound,[]),enabled=useRef(false);
 const qr=useMemo(()=>{
  if(!room)return '';
  const image=qrcode(0,'M');
  image.addData(timerPairingQr(room.pairCode));image.make();
  return image.createDataURL(8,32);
 },[room]);

 async function start(){
  if(openingRef.current)return;
  openingRef.current=true;setOpening(true);setError('');setPaired(false);setFrame(null);
  const prior=currentRoom.current;
  currentRoom.current=null;setRoom(null);
  if(prior)void closeTimerRoom(prior.displayKey).catch(()=>{});
  try{
   if(!await timerDisplayAvailable()){
    if(mounted.current)setError('在线大屏暂未开放或服务不可达。可用计时菜单里的本机或同 Wi-Fi 投影。');
    return;
   }
   if(!mounted.current)return;
   const next=await createTimerRoom();
   if(!mounted.current){void closeTimerRoom(next.displayKey).catch(()=>{});return;}
   currentRoom.current=next;setRoom(next);
  }catch{
   if(mounted.current)setError('暂时生成不了配对码，请检查网络后重试。');
  }finally{
   openingRef.current=false;
   if(mounted.current)setOpening(false);
  }
 }

 useEffect(()=>{
  mounted.current=true;void start();
  function close(){
   const active=currentRoom.current;
   if(active)void closeTimerRoom(active.displayKey).catch(()=>{});
  }
  window.addEventListener('pagehide',close);
  return ()=>{mounted.current=false;window.removeEventListener('pagehide',close);close();sound.close();};
 },[sound]);

 useEffect(()=>{
  if(!room)return;
  let active=true,lastSeq=0,lastFrameAt=0,lastSignal='',pairedOnce=false;
  let poll:number|undefined;
  function ended(){
   active=false;currentRoom.current=null;setRoom(null);setPaired(false);setFrame(null);
   setError('本次配对已结束，请重新生成二维码。');
  }
  async function refresh(){
   try{
    const next=await readTimerRoom(room!.displayKey);
    if(!active||currentRoom.current!==room)return;
    if(!next.connected&&pairedOnce){ended();return;}
    if(!next.connected)return;
    pairedOnce=true;setPaired(true);
    if(!next.frame){setFrame(null);lastFrameAt=0;return;}
    if(next.seq<=lastSeq)return;
    const continuous=lastFrameAt>0&&performance.now()-lastFrameAt<timerFrameTimeout;
    const signal=next.frame.signal;
    if(signal&&signal.id!==lastSignal){
     lastSignal=signal.id;
     if(continuous&&enabled.current){
      if(sound.isReady())sound.play(signal.kind);
      else setSoundHint('声音已暂停，请点「试听大屏提示音」恢复。');
     }
    }
    lastSeq=next.seq;lastFrameAt=performance.now();
    setFrame(next.frame);
   }catch(error){
    if(active&&currentRoom.current===room&&timerPairingEnded(error))ended();
   }finally{
    if(active&&currentRoom.current===room)poll=window.setTimeout(()=>void refresh(),450);
   }
  }
  const watch=window.setInterval(()=>{
   if(lastFrameAt&&performance.now()-lastFrameAt>timerFrameTimeout){lastFrameAt=0;setFrame(null);}
  },100);
  void refresh();
  return ()=>{active=false;window.clearTimeout(poll);window.clearInterval(watch);};
 },[room,sound]);

 async function testSound(){
  const ready=await sound.unlock();
  enabled.current=ready;setSoundOn(ready);
  setSoundHint(ready?'大屏提示音已开启。':'浏览器没能开启声音，请再试听一次。');
  if(ready)sound.play('prepare');
 }
 const soundActions=<><button className="button" type="button" onClick={()=>void testSound()}>试听大屏提示音</button>
  {soundOn&&<button className="button" type="button" onClick={()=>{enabled.current=false;sound.close();setSoundOn(false);setSoundHint('大屏提示音已关闭。');}}>关闭大屏声音</button>}</>;
 return paired?<div className="timer-online-display">
  <CompetitionDisplayScreen frame={frame} emptyLabel="等待手机信号 · 请停止发射" actions={<>
   <span className="timer-connection-label" aria-live="polite">{frame?'已连接':'连接未确认'}</span>
   {soundActions}
   <button className="button" type="button" onClick={()=>void start()}>断开并重新配对</button>
  </>}/>
  {soundHint&&<p className="timer-online-hint" role="status">{soundHint}</p>}
 </div>:<main className="timer-online-pair">
  <section>
   <h1>弓行记 · 比赛大屏</h1>
   <p>在手机打开「训练 → 比赛计时 → 投影大屏」，选择「扫码连接在线大屏」。</p>
   {qr&&<><img src={qr} alt="本次大屏配对二维码" width={320} height={320}/>
    <p role="status">等待手机扫码</p>
    <details><summary>显示配对码</summary><code>{room?.pairCode}</code></details>
   </>}
   {error&&<p role="alert">{error}</p>}
   {opening&&<p role="status">正在生成二维码…</p>}
   <div className="competition-timer-display-actions">
    {soundActions}
    <button className="button" type="button" disabled={opening} onClick={()=>void start()}>重新生成二维码</button>
   </div>
   <p>用现场扬声器时，在这里试听开启大屏声音，再关闭手机提示音。</p>
   {soundHint&&<p role="status">{soundHint}</p>}
  </section>
 </main>;
}
