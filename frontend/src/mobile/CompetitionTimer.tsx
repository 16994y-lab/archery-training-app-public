import {useEffect,useMemo,useRef,useState} from 'react';
import {Back,Button,Modal,Panel,useInnerBack} from './ui';
import {ChoiceSelect} from './ChoiceSelect';
import {advancedView,startAdvanced,updateAdvanced,type AdvancedMode,type AdvancedTiming,type Side} from './advanced-timing-engine';
import {createTimerSound,type TimerSignal as SoundKind} from './timer-sound';
import {displayChannelName,type CompetitionDisplayFrame} from './CompetitionDisplay';
import './competition-timer.css';

const presets=[
 {id:'three',label:'个人统一发射',arrows:3,seconds:90},
 {id:'six',label:'个人排名赛',arrows:6,seconds:180},
] as const;
const labels={ready:'等待开始',prepare:'准备上场',shoot:'可以发射',warning:'最后 30 秒',stopped:'停止发射',scoring:'计分取箭'};
const advancedLabels:Record<AdvancedMode,string>={
 individual:'个人交替 · 每方 3 箭',
 'individual-shoot-off':'个人交替附加赛 · 每方 1 箭',
 team:'团体交替 · 每队 6 箭 / 120 秒',
 mixed:'混团交替 · 每队 4 箭 / 80 秒',
 'team-shoot-off':'团体交替附加赛 · 每队 3 箭 / 60 秒',
 'mixed-shoot-off':'混团交替附加赛 · 每队 2 箭 / 40 秒',
};
type Stage=keyof typeof labels;
type Countdown={prepareUntil:number;endAt:number;shootSignalHandled:boolean};

function remaining(deadline:number,now:number){
 return Math.max(0,Math.ceil((deadline-now)/1000));
}
const formatTime=(seconds:number)=>[Math.floor(seconds/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');

export function CompetitionTimer({onBack}:{onBack:()=>void}){
 const [choice,setChoice]=useState<'three'|'six'|'custom'>('three');
 const [customArrows,setCustomArrows]=useState('3'),[customSeconds,setCustomSeconds]=useState('90');
 const [standardStage,setStage]=useState<Stage>('ready'),[seconds,setSeconds]=useState(90);
 const [mode,setMode]=useState<'standard'|AdvancedMode>('standard'),[firstSide,setFirstSide]=useState<Side>('A');
 const [match,setMatch]=useState<AdvancedTiming|null>(null),[clock,setClock]=useState(0);
 const [projection,setProjection]=useState(false),[soundError,setSoundError]=useState(false),[phoneSound,setPhoneSound]=useState(true);
 const [browserReceiver,setBrowserReceiver]=useState('');
 const [displayKey,setDisplayKey]=useState<string|null>(null),[displayBlocked,setDisplayBlocked]=useState(false);
 const [castMenu,setCastMenu]=useState(false),[browserDisplay,setBrowserDisplay]=useState(''),[castMessage,setCastMessage]=useState('');
 const countdown=useRef<Countdown|null>(null);
 const matchRef=useRef<AdvancedTiming|null>(null);
 const sound=useMemo(createTimerSound,[]);
 const phoneSoundRef=useRef(true);
 const latestSignal=useRef<{at:number}|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),screen=useRef<HTMLDivElement>(null);
 const browserAddress=useRef<HTMLInputElement>(null);
 const nativeProjection=useRef(false),browserFullscreen=useRef(false);
 const advanced=mode!=='standard';
 const stage:Stage=advanced?match?.phase??'ready':standardStage;
 const matchView=match?advancedView(match,clock):null;
 const active=stage==='prepare'||stage==='shoot'||stage==='warning';
 const preset=presets.find(item=>item.id===choice);
 const android=window.Gongxingji;
 const arrows=preset?.arrows??Number(customArrows),duration=preset?.seconds??Number(customSeconds);
 const valid=Number.isInteger(arrows)&&arrows>=1&&arrows<=72&&Number.isInteger(duration)&&duration>=1&&duration<=600;

 function emitSignal(kind:SoundKind,gesture=false){
  const event={at:performance.now()};
  latestSignal.current=event;
  if(!phoneSoundRef.current)return;
  if(gesture){
   void sound.unlock().then(ready=>{
    if(!phoneSoundRef.current||latestSignal.current!==event||performance.now()-event.at>1000)return;
    if(ready)sound.play(kind);
    setSoundError(!ready||!sound.isReady());
   });
  }else{
   sound.play(kind);setSoundError(!sound.isReady());
  }
 }
 function testSound(){
  phoneSoundRef.current=true;setPhoneSound(true);
  void sound.unlock().then(ready=>{
   if(!phoneSoundRef.current)return;
   if(ready)sound.play('prepare');
   setSoundError(!ready||!sound.isReady());
  });
 }

 function start(){
  if(mode!=='standard'){
   if(matchRef.current&&['prepare','shoot'].includes(matchRef.current.phase))return;
   const now=performance.now(),next=startAdvanced(mode,firstSide,now);
   matchRef.current=next;setMatch(next);setClock(now);emitSignal('prepare',true);
   return;
  }
  if(!valid||countdown.current)return;
  const prepareUntil=performance.now()+10_000;
  countdown.current={prepareUntil,endAt:prepareUntil+duration*1000,shootSignalHandled:false};
  setStage('prepare');setSeconds(10);
  emitSignal('prepare',true);
 }

 function stop(){
  if(advanced){advanceMatch('stop');return;}
  if(!countdown.current)return;
  countdown.current=null;
  setSeconds(0);setStage('stopped');emitSignal('stop',true);
 }

 function score(){
  if(advanced){advanceMatch('score');return;}
  setStage('scoring');emitSignal('scoring',true);
 }

 function advanceMatch(action:Parameters<typeof updateAdvanced>[1]){
  const current=matchRef.current;
  if(!current)return;
  const now=performance.now();
  const result=updateAdvanced(current,action,now);
  matchRef.current=result.state;setMatch(result.state);setClock(now);
  if(!document.hidden)for(const signal of result.signals){
   emitSignal(signal===1?'shoot':signal===3?'scoring':'stop',action!=='tick');
  }
 }

 function chooseMode(next:typeof mode){
  matchRef.current=null;latestSignal.current=null;setMatch(null);setStage('ready');setMode(next);
 }

 useEffect(()=>{
  if(!active)return;
  function refresh(){
   if(advanced){advanceMatch('tick');return;}
   const run=countdown.current;
   if(!run)return;
   const now=performance.now();
   if(now>=run.endAt){
    countdown.current=null;
    setSeconds(0);setStage('stopped');
    if(!document.hidden&&now-run.endAt<1000)emitSignal('stop');
   }else if(now>=run.prepareUntil){
    const left=remaining(run.endAt,now);
    const next=duration>30&&left<=30?'warning':'shoot';
    if(!run.shootSignalHandled){
     run.shootSignalHandled=true;
     if(!document.hidden&&now-run.prepareUntil<1000)emitSignal('shoot');
    }
    setSeconds(left);setStage(next);
   }else setSeconds(remaining(run.prepareUntil,now));
  }
  const timer=window.setInterval(refresh,100);
  document.addEventListener('visibilitychange',refresh);
  return ()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[active,advanced,duration]);

 useEffect(()=>{
  if(!(active||projection||browserDisplay)||!navigator.wakeLock)return;
  let alive=true,pending=false,lock:WakeLockSentinel|undefined;
  async function keepAwake(){
   if(document.hidden||pending||(lock&&!lock.released))return;
   pending=true;
   try{
    const acquired=await navigator.wakeLock.request('screen');
    if(alive)lock=acquired;
    else await acquired.release();
   }catch{/* The device can decline a screen wake lock. */}
   finally{pending=false;}
  }
  void keepAwake();
  document.addEventListener('visibilitychange',keepAwake);
  return ()=>{alive=false;document.removeEventListener('visibilitychange',keepAwake);void lock?.release().catch(()=>{});};
 },[active,projection,browserDisplay]);

 function closeProjection(){
  browserFullscreen.current=false;
  if(screen.current&&document.fullscreenElement===screen.current)void document.exitFullscreen().catch(()=>{});
  if(nativeProjection.current)window.Gongxingji?.setReviewMode?.(false);
  nativeProjection.current=false;
  dialog.current?.close();
  setProjection(false);
 }

 function openProjection(){
  dialog.current?.showModal();
  setProjection(true);
  if(window.Gongxingji?.setReviewMode){
   window.Gongxingji.setReviewMode(true);
   nativeProjection.current=true;
  }else if(screen.current?.requestFullscreen){
   void screen.current.requestFullscreen().then(()=>{
    if(dialog.current?.open)browserFullscreen.current=true;
    else if(screen.current&&document.fullscreenElement===screen.current)void document.exitFullscreen().catch(()=>{});
   }).catch(()=>{});
  }
 }

 function openCastSettings(){
  if(active||!android?.openCastSettings)return;
  setCastMenu(false);
  android.openCastSettings();
 }

 useInnerBack(projection,closeProjection,30);
 useEffect(()=>{
  const onFullscreenChange=()=>{
   if(browserFullscreen.current&&!document.fullscreenElement)closeProjection();
  };
  document.addEventListener('fullscreenchange',onFullscreenChange);
  return ()=>{
   document.removeEventListener('fullscreenchange',onFullscreenChange);
   if(nativeProjection.current)window.Gongxingji?.setReviewMode?.(false);
   sound.close();
  };
 },[sound]);

 const shown=stage==='ready'?Math.max(0,valid?duration:0):seconds;
 const stageLabel=matchView?.activeSide&&stage==='shoot'?matchView.activeSide+' 方发射':labels[stage];
 const displayFrame=useRef<CompetitionDisplayFrame|null>(null);
 displayFrame.current={stage,label:stageLabel,clocks:advanced&&matchView&&stage!=='prepare'?
  (['A','B'] as const).map(side=>({name:side+' 方',time:formatTime(matchView.seconds[side]),active:side===matchView.activeSide})):
  [{name:'剩余时间',time:formatTime(advanced?matchView?.prepareSeconds??10:shown),active:false}]};
 useEffect(()=>{
  if(!displayKey)return;
  const channel=new BroadcastChannel(displayChannelName(displayKey));
  const timer=window.setInterval(()=>channel.postMessage(displayFrame.current),250);
  return ()=>{window.clearInterval(timer);channel.close();};
 },[displayKey]);
 useEffect(()=>{
  if(!browserDisplay||!android)return;
  const expired=()=>{
   setBrowserDisplay('');setBrowserReceiver('');
   setCastMessage('原地址已关闭，重新开启浏览器大屏可生成新地址。');
  };
  const publish=()=>{
   if(displayFrame.current)android.publishTimerBrowserDisplay?.(JSON.stringify(displayFrame.current));
   const receiver=android.getTimerBrowserDisplayStatus?.();
   if(receiver==='closed')expired();
   else if(receiver)setBrowserReceiver(receiver);
  };
  const timer=window.setInterval(publish,250);
  const onHidden=()=>{
   if(document.hidden){android.stopTimerBrowserDisplay?.();expired();}
  };
  document.addEventListener('visibilitychange',onHidden);
  publish();
  return ()=>{
   window.clearInterval(timer);
   document.removeEventListener('visibilitychange',onHidden);
   android.stopTimerBrowserDisplay?.();
  };
 },[android,browserDisplay]);

 function startBrowserDisplay(){
  if(browserDisplay||!android?.startTimerBrowserDisplay)return;
  try{
   const response=JSON.parse(android.startTimerBrowserDisplay());
   if(!response.ok||typeof response.data!=='string')throw new Error(response.error);
   setBrowserDisplay(response.data);
   setBrowserReceiver(android.getTimerBrowserDisplayStatus?'waiting':'');
   setCastMessage('');
  }catch(error){setCastMessage(error instanceof Error&&error.message?error.message:'大屏启动失败，请稍后重试。');}
 }
 async function copyBrowserAddress(){
  try{
   await navigator.clipboard.writeText(browserDisplay);
   setCastMessage('地址已复制。');
  }catch{
   browserAddress.current?.focus();
   browserAddress.current?.select();
   setCastMessage('地址已选中，可长按复制。');
  }
 }

 function openSecondaryDisplay(){
  const key=displayKey??crypto.randomUUID();
  const popup=window.open('', '_blank');
  if(!popup){setDisplayBlocked(true);return;}
  popup.opener=null;
  const address=new URL(location.href);
  address.hash=`/competition-display?key=${key}`;
  popup.location.replace(address.href);
  setDisplayKey(key);setDisplayBlocked(false);
 }

 function display(big:boolean){
  return <div className="competition-timer-display" data-stage={stage}>
   <div className="competition-timer-display-head">
    <span>{mode==='standard'?`${valid?arrows:'—'} 箭 / ${valid?duration:'—'} 秒`:advancedLabels[mode]}</span>
    <div className="competition-timer-display-actions">
     {!big&&<Button onClick={()=>{setCastMessage('');setCastMenu(true);}}>投影大屏</Button>}
     <Button onClick={big?closeProjection:openProjection}>{big?'退出全屏':'横屏大字'}</Button>
    </div>
   </div>
   {advanced&&matchView&&stage!=='prepare'?<div className="competition-timer-sides">
    {(['A','B'] as const).map(side=><div key={side} className="competition-timer-side" data-active={side===matchView.activeSide}>
     <span>{side} 方</span><div role="timer" aria-label={side+' 方剩余时间'}>{formatTime(matchView.seconds[side])}</div>
     <small>已确认 {matchView.confirmed[side]} / {matchView.arrowsPerSide} 箭</small>
    </div>)}
   </div>:<div className="competition-timer-time" role="timer" aria-label="剩余时间">{formatTime(advanced?matchView?.prepareSeconds??10:shown)}</div>}
   <div className="competition-timer-stage" role="status">{stageLabel}</div>
   <div className="competition-timer-controls">
    {active?<>{advanced&&stage==='shoot'&&<Button kind="primary" onClick={()=>advanceMatch('confirm')}>确认已发射一箭</Button>}<Button onClick={stop}>停止发射</Button></>:stage==='stopped'?<Button kind="primary" onClick={score}>计分取箭</Button>:<Button kind="primary" onClick={start} disabled={!advanced&&!valid}>{stage==='scoring'?'开始下一组':'开始准备'}</Button>}
   </div>
   {soundError&&<p className="competition-timer-audio">声音不可用，请查看屏幕状态。</p>}
   {!big&&browserDisplay&&<p className="competition-timer-cast-help" role="status">浏览器大屏已开启。投影大屏菜单内可查看地址或关闭。</p>}
  </div>;
 }

 return <>
  <Back title="比赛计时" onBack={onBack} label="返回训练"/>
  <Panel className="competition-timer-settings" title="选择计时模板">
   <label className="competition-timer-mode"><span>赛制</span><ChoiceSelect aria-label="赛制" value={mode} disabled={active||stage==='stopped'} onChange={event=>chooseMode(event.target.value as typeof mode)}>
    <option value="standard">统一发射／自定义</option>
    {Object.entries(advancedLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
   </ChoiceSelect></label>
   {advanced?<><div className="competition-timer-controls" aria-label="先发射一方">
    {(['A','B'] as const).map(side=><Button key={side} aria-pressed={firstSide===side} kind={firstSide===side?'selected':''} disabled={active||stage==='stopped'} onClick={()=>setFirstSide(side)}>{side} 方先发</Button>)}
   </div><p className="caption">参考世界箭联 2026-08-15 射准规则。团体最后一箭须等射手退回 1 米线后再确认。附加赛按淘汰或决赛流程设置。</p></>:<>
   <div className="competition-timer-options" aria-label="计时模板">
    {presets.map(item=><Button key={item.id} kind={choice===item.id?'selected':''} aria-pressed={choice===item.id} disabled={stage!=='ready'&&stage!=='scoring'} onClick={()=>setChoice(item.id)}>{item.label}<small>{item.arrows} 箭 / {item.seconds} 秒</small></Button>)}
    <Button kind={choice==='custom'?'selected':''} aria-pressed={choice==='custom'} disabled={stage!=='ready'&&stage!=='scoring'} onClick={()=>setChoice('custom')}>自定义<small>设置箭数和秒数</small></Button>
   </div>
   {choice==='custom'&&<div className="competition-timer-custom">
    <label>每组箭数<input type="number" min="1" max="72" step="1" inputMode="numeric" value={customArrows} disabled={active||stage==='stopped'} onChange={event=>setCustomArrows(event.target.value)}/></label>
    <label>发射时限（秒）<input type="number" min="1" max="600" step="1" inputMode="numeric" value={customSeconds} disabled={active||stage==='stopped'} onChange={event=>setCustomSeconds(event.target.value)}/></label>
   </div>}
   {!valid&&<p role="alert">请输入 1–72 支箭和 1–600 秒的整数。</p>}
   <p className="caption">{preset?'预设参考 2026 年全国青少年大众射箭公开赛南京站。':'可按训练安排或当场规程设置。'}正式比赛听从现场裁判。</p>
   </>}
   <div className="competition-timer-display-actions">
    <Button onClick={testSound} disabled={active||stage==='stopped'}>试听提示音</Button>
    <Button aria-pressed={!phoneSound} onClick={()=>{
     if(phoneSound){phoneSoundRef.current=false;setPhoneSound(false);setSoundError(false);sound.close();}
     else testSound();
    }}>{phoneSound?'关闭手机提示音':'开启手机提示音'}</Button>
   </div>
  </Panel>
  {!projection&&display(false)}
  {castMenu&&<Modal title="选择投影方式" onClose={()=>setCastMenu(false)}>
   <div className="competition-cast-options">
    {!android&&'BroadcastChannel' in window&&typeof crypto.randomUUID==='function'&&<Button onClick={openSecondaryDisplay}>打开电脑副屏</Button>}
    {displayBlocked&&<p role="status">浏览器拦截了副屏窗口，请允许弹出窗口后重试。</p>}
    {android?.startTimerBrowserDisplay&&<>
     <h3>同 Wi-Fi 浏览器大屏</h3>
     <p>手机保持在计时页。用电视浏览器，或用连接投影仪的电脑浏览器，打开下方完整的 http 地址。</p>
     {browserDisplay?<>
      <label>大屏地址<input ref={browserAddress} readOnly value={browserDisplay} onFocus={event=>event.target.select()} /></label>
      {browserReceiver&&<p role="status">{
        browserReceiver==='receiving'?'接收端已收到计时。':
        browserReceiver==='interrupted'?'接收端已中断，请回到大屏浏览器刷新。':
        browserReceiver==='opened'?'接收端已打开页面，正在等待计时。':'等待接收端打开。'
      }</p>}
      {browserReceiver==='waiting'&&<p>地址打不开时，确认两台设备连同一 Wi-Fi，并避开隔离设备的访客网络。</p>}
      <p>切到其他应用发送地址或离开计时页后，地址会失效。</p>
      <Button onClick={()=>void copyBrowserAddress()}>复制地址</Button>
      <Button onClick={()=>{setBrowserDisplay('');setCastMessage('');}}>关闭浏览器大屏</Button>
     </>:<Button kind="primary" onClick={startBrowserDisplay}>开启浏览器大屏</Button>}
    </>}
    {android&&<><h3>系统无线投屏</h3>
    <p>{active?'本组结束后再打开系统投屏，避免跳出计时。':'适用于支持手机屏幕镜像的设备。系统页打不开时，可从手机控制中心打开「投屏」。连上后返回，点「横屏大字」。'}</p>
    {android.openCastSettings&&<Button onClick={openCastSettings} disabled={active}>打开系统投屏</Button>}</>}
    {castMessage&&<p role="status">{castMessage}</p>}
    <Button onClick={()=>setCastMenu(false)}>返回计时</Button>
   </div>
  </Modal>}
  <dialog ref={dialog} className="competition-timer-dialog" aria-label="比赛计时投影" onCancel={event=>{event.preventDefault();closeProjection();}}>
   <div ref={screen} className="competition-timer-screen">{projection&&display(true)}</div>
  </dialog>
 </>;
}
