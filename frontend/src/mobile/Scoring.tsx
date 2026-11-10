import './training-review.css';
import React, { useEffect, useId, useRef, useState } from 'react';
import { addArrow, advance, allArrows, appendConfirmedMisses, beginRest, confirmEnd, createEnd, currentBlock, discardSession, finishSession, now, resizeEnd, resolveMissingArrows, scoreAt, Session, sessionPlannedArrows } from './domain';
import { statistics } from './statistics';
import { NumberInput, Back, Button, Empty, Field, LayoutPicker, Modal, Panel, sessionIn, TargetFace, useApp, useInnerBack } from './ui';
import { Metrics, Spatial, Distribution } from './Analysis';
import { PhotoEntry, VideoEntry } from './media';
import { ScoringCircles } from './SpreadOverlay';
import { GroupNotes, SessionSettings } from './ScoringExtras';
import { offlineAndroid, videoCoachReady } from './release-mode';
import {sessionTimeLabel} from './session-label';

// Run inside the existing repository transaction: confirm and advance commit together.
export function saveScoringEndAndContinue(session:Session, expectedEndId:string, expectedCount:number, expectedCapacity:number, missingMode:'M'|'skip', face:number) {
 const end=session.ends[session.currentEnd];
 if(session.status!=='active'||end?.id!==expectedEndId||end.confirmed||session.rest.some(r=>!r.ended)||currentBlock(session)?.kind==='rest')throw new Error('本组状态已变化，请重新核对；未重复保存。');
 resolveMissingArrows(session,expectedEndId,expectedCount,expectedCapacity,missingMode,face);
 confirmEnd(session);
 // An explicitly appended group after the plan's end has no next plan block.
 if(!session.plan||currentBlock(session))advance(session);
}

function scoreKeyColors(target:Session['conditions']['target'],code:string):React.CSSProperties|undefined{
 if(code==='M')return undefined;
 const color=target.ring_rules?.find(rule=>rule.score_code===code)?.color;
 if(!color||!/^#[0-9a-f]{6}$/i.test(color))return undefined;
 const channels=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
 const luminance=.2126*channels[0]+.7152*channels[1]+.0722*channels[2];
 const ink=(1.05/(luminance+.05))>=((luminance+.05)/.075)?'#fff':'#173653';
 return {'--score-key-color':color,'--score-key-ink':ink} as React.CSSProperties;
}

function ScoreTarget({showSpread,setShowSpread,...props}:React.ComponentProps<typeof TargetFace>&{showSpread:boolean;setShowSpread:(value:boolean)=>void}) {
 const [full,setFull]=useState(false),container=useRef<HTMLDivElement>(null);
 useInnerBack(full,()=>setFull(false),30);
 useEffect(()=>{if(!full)return;const previous=document.body.style.overflow,focus=document.activeElement as HTMLElement|null;document.body.style.overflow='hidden';container.current?.querySelector<HTMLButtonElement>('.score-fullscreen')?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();setFull(false);}if(e.key==='Tab'){const elements=Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex]')??[]).filter(element=>element.tabIndex>=0&&!element.hasAttribute('disabled')&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden');const first=elements[0],last=elements[elements.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};window.addEventListener('keydown',key);return()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',key);if(focus?.isConnected)focus.focus();};},[full]);
 return <div ref={container} className={full?'score-target-fullscreen':'score-target-inline'} role={full?'dialog':undefined} aria-modal={full?true:undefined} aria-label={full?'全屏靶面录入':undefined}>
  {full&&<h2>靶面录入</h2>}
  <div className="score-target-grid">
   <label className="check score-spread"><input type="checkbox" checked={showSpread} onChange={e=>setShowSpread(e.target.checked)}/>辅助圈</label>
   <Button className="score-fullscreen" onClick={()=>setFull(!full)}>{full?'退出全屏':'全屏'}</Button>
   <TargetFace {...props}/>
  </div>
  {full&&<p className="caption">双指或按钮缩放，放大后拖动查看；键盘 + / - 缩放、方向键移动、0 还原。轻点录入。</p>}
 </div>;
}

export function Scoring({sessionId,review=false,onBack,endIndex}:{sessionId:string;review?:boolean;onBack?:()=>void;endIndex?:number}) {
 const {data,update,ask,open}=useApp(),raw=data.sessions.find(s=>s.id===sessionId),s=raw&&endIndex!==undefined?{...raw,currentEnd:endIndex}:raw;
 const [extras,setExtras]=useState<'notes'|'settings'|'more'|null>(null),[selected,setSelected]=useState<string|null>(null),[face,setFace]=useState(1),[capacity,setCapacity]=useState(6);
 const [entry,setEntry]=useState<'manual'|'video'>('manual'),[mode,setMode]=useState<'target'|'number'|'photo'>('target'),[photoDirty,setPhotoDirty]=useState(false),[clock,setClock]=useState(Date.now()),[showSpread,setShowSpread]=useState(true),[savingEnd,setSavingEnd]=useState(false);
 const continuing=useRef(false),entryId=useId();
 useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{setSelected(null);setCapacity(s?.ends[s.currentEnd]?.capacity??6);},[s?.id,s?.currentEnd,s?.ends[s.currentEnd]?.capacity]);
 if(!s)return <Empty title="没有当前场次">从训练页开始或恢复草稿。</Empty>;
 const end=s.ends[s.currentEnd],block=currentBlock(s),rest=s.rest.find(r=>!r.ended),atRest=block?.kind==='rest',finishedPlan=Boolean(s.plan&&!block),stats=statistics(end?.arrows??[]),editing=selected!==null,faceStats=statistics((end?.arrows??[]).filter(a=>a.face===face));
 const cannotAdd=Boolean(review||end?.confirmed||(end&&end.arrows.length>=end.capacity));
 const change=async(fn:(session:Session)=>void)=>update(d=>{const q=sessionIn(d,s.id),position=q.currentEnd;if(endIndex!==undefined)q.currentEnd=endIndex;fn(q);if(endIndex!==undefined)q.currentEnd=position;});
 const record=async(code:string,point?:{x:number;y:number})=>{if((rest||atRest)&&!review)return;if(await change(q=>addArrow(q,code,face,selected,point,point?'target':'number')))setSelected(null);};
 const continueEnd=async()=>{
  if(continuing.current||!end)return;
  continuing.current=true;
  try {
   let missingMode:'M'|'skip'='skip';
   if(end.arrows.length<end.capacity){
    const missing=end.capacity-end.arrows.length;
    const choice=await ask('还有未记录的箭，如何保存本组？',`计划 ${end.capacity} 箭，已录 ${end.arrows.length} 箭，少 ${missing} 箭。若照片漏识别了命中箭，请先返回补点或手动录入；只有确认脱靶才记 M。`,['返回录入',`少的 ${missing} 箭确实脱靶，记 M`,`仅保存已录 ${end.arrows.length} 箭，不记 M`]);
    if(choice===0)return;
    missingMode=choice===1?'M':'skip';
   }
   setSavingEnd(true);
   if(await change(q=>saveScoringEndAndContinue(q,end.id,end.arrows.length,end.capacity,missingMode,face))){setSelected(null);window.scrollTo(0,0);}
  } finally {continuing.current=false;setSavingEnd(false);}
 };
 const endTraining=async()=>{
  const choice=await ask('结束本次训练？',`当前已保存 ${allArrows(s).length} 箭。结束会打开本场数据分析；放弃只隐藏本轮，不影响其他已保存训练，也不会补M。`,['继续训练','放弃本轮训练','结束并查看分析']);
  if(choice===1){if(await ask('确认放弃本轮训练？','本轮将从训练和复盘列表隐藏；其他训练保持不变，原始内容仍保留在本机备份数据中。',['返回','确认放弃'])===1&&await update(d=>discardSession(d,sessionIn(d,s.id))))open('training');return;}
  if(choice===2){
   let missingMode:'M'|'skip'='skip';
   if(end&&!end.confirmed&&end.arrows.length>0&&end.arrows.length<end.capacity){
    const missing=end.capacity-end.arrows.length;
    const choice=await ask('结束前，缺少的箭如何记录？',`本组计划 ${end.capacity} 箭，已录 ${end.arrows.length} 箭。照片漏识别的命中箭请先返回补录；确认脱靶才记 M。`,['返回录入',`少的 ${missing} 箭确实脱靶，记 M`,`仅保存已录 ${end.arrows.length} 箭，不记 M`]);
    if(choice===0)return;
    missingMode=choice===1?'M':'skip';
   }
   if(await update(d=>{const q=sessionIn(d,s.id);if(end&&!end.confirmed&&end.arrows.length>0)resolveMissingArrows(q,end.id,end.arrows.length,end.capacity,missingMode,face);finishSession(d,q);}))open('insights',s.id);
  }
 };
 const chooseMode=async(next:'target'|'number'|'photo')=>{
  if(next===mode)return;
  if(mode==='photo'&&photoDirty&&await ask('切换录入方式？','尚未确认的照片候选会清除；已经加入本组的成绩保持不变。',['继续核对','清除候选并切换'])!==1)return;
  setMode(next);
 };
 if(videoCoachReady&&entry==='video')return <VideoEntry session={s} onBack={()=>setEntry('manual')}/>;
 const elapsed=rest?Math.max(0,Math.floor((clock-Date.parse(rest.started))/1000)):0,remaining=rest?.minutes==null?null:Math.max(0,Math.round(rest.minutes*60)-elapsed);
 const sourceNames={number:'数字',target:'点靶',photo:'照片核对'};
 const sources=[...new Set((end?.arrows??[]).map(a=>sourceNames[a.source]))].join(' / ');
 const lastPlanned=Boolean(s.plan&&block?.kind==='score'&&s.blockIndex===s.plan.blocks.length-1&&s.blockEnd+1>=block.ends);
 return <div className="score-workbench">
  <div className="score-heading">
   {review?<Back title={`修改第 ${s.currentEnd+1} 组`} onBack={onBack!}/>:<h1>{s.name}</h1>}
   <div className="score-heading-actions"><Button disabled={photoDirty} onClick={()=>setExtras('more')}>更多</Button>{!review&&<Button disabled={photoDirty} onClick={()=>void endTraining()}>结束训练</Button>}</div>
  </div>
  <div className="score-session-facts" aria-label="本场训练条件"><span>{s.conditions.distance} 米</span><span>{s.conditions.size?`${s.conditions.size} cm`:'尺寸未知'} · {s.conditions.target.name}</span><time dateTime={s.started}>{sessionTimeLabel(s)} 开始</time></div>
  {review&&<p className="notice">选中已有箭后修改，箭数不增加。数字改分会清除该箭原坐标，所有统计随保存重算。</p>}
  {review&&end?.confirmed&&end.arrows.length>0&&end.arrows.length<end.capacity&&<Panel title="核对未记录的箭">
   <p>本组原定 {end.capacity} 箭，已保存 {end.arrows.length} 箭，少 {end.capacity-end.arrows.length} 箭；目前未把空位算作 M。照片漏识别的命中箭不能补记为 M。</p>
   <Button onClick={async()=>{
    const missing=end.capacity-end.arrows.length;
    const choice=await ask('确认补记脱靶箭？',`只有确定少的 ${missing} 箭都实际射出且脱靶，才补记 ${missing} 个 M；总分不变，平均环和命中率会按 ${end.capacity} 箭重新计算。当前选择靶位 ${face}。`,['保持现有记录',`确认补记 ${missing} 个 M`]);
    if(choice!==1)return;
    await update(d=>appendConfirmedMisses(sessionIn(d,s.id),s.currentEnd,end.id,end.arrows.length,end.capacity,s.revision,face));
   }}>少的 {end.capacity-end.arrows.length} 箭确实脱靶，补记 M</Button>
  </Panel>}
  {!review&&(rest||atRest)&&<Panel title={atRest?block!.label:'自主休息'}><p>休息起止只由“开始休息”和“继续训练”记录。</p>{rest?<><div className="timer">{rest.timer&&remaining!==null?`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`:`${Math.floor(elapsed/60)}分${elapsed%60}秒`}</div><p>{rest.timer&&remaining===0?'页面计时已到，等待你主动继续。':'已记录实际开始时间。'}</p>{rest.timer&&<Button onClick={()=>change(q=>{q.rest.find(r=>!r.ended)!.timer=false;})}>关闭页面计时，继续休息</Button>}<Button kind="primary" onClick={()=>change(q=>{if(currentBlock(q)?.kind==='rest')advance(q);else q.rest.find(r=>!r.ended)!.ended=now();})}>继续训练</Button></>:<div className="actions"><Button kind="primary" onClick={()=>change(q=>beginRest(q,block!.minutes,true))}>开始休息并计时</Button><Button onClick={()=>change(q=>beginRest(q,null,false))}>开始休息，不计时</Button><Button onClick={()=>change(advance)}>跳过本次休息</Button></div>}<p className="caption">仅页面计时；锁屏、后台提醒未接入。</p></Panel>}
  {!review&&finishedPlan&&end?.confirmed&&!rest&&<Panel title="计划内容已执行到末尾"><p>实际 {allArrows(s).length} 箭 / 原计划 {sessionPlannedArrows(s)} 箭，可结束或追加训练。</p><Button onClick={()=>change(q=>{if(q.ends.length>=500)throw new Error('达到500组保护');q.ends.push(createEnd(undefined,end.capacity));q.currentEnd=q.ends.length-1;})}>追加一组</Button></Panel>}
  {extras==='settings'&&<SessionSettings session={s} onClose={()=>setExtras(null)}/>}
  {extras==='notes'&&end&&<GroupNotes session={s} index={s.currentEnd} arrowId={selected} onClose={()=>setExtras(null)}/>}
  {extras==='more'&&<Modal title="更多训练操作" onClose={()=>setExtras(null)}>
   {end&&<Button className="wide" onClick={()=>setExtras('notes')}>{selected?'选中箭备注':'本组备注'}</Button>}
   <Button className="wide" onClick={()=>setExtras('settings')}>本场设置</Button>
   <p className="caption">{s.conditions.equipment?.name??'器材未填，可在本场设置中补记'}</p>
   {!review&&<>
    {end&&!rest&&!atRest&&<><div className="capacity-row"><Field label="本组箭数"><NumberInput min="1" max="300" value={capacity} onValue={setCapacity}/></Field><Button onClick={async()=>{if(await change(q=>resizeEnd(q,capacity)))setExtras(null);}}>设置箭数</Button><Button onClick={async()=>{if(await change(q=>resizeEnd(q,q.ends[q.currentEnd].capacity+6)))setExtras(null);}}>＋6位置</Button></div>
     <Button className="wide" kind="danger" disabled={!end.arrows.length||end.confirmed} onClick={async()=>{setExtras(null);if(await ask('清空本组？',`将清除本组 ${end.arrows.length} 支已录箭；其他组保持不变。`,['取消','清空本组'])===1){if(await change(q=>{q.ends[q.currentEnd].arrows=[];q.revision++;})){setSelected(null);setExtras(null);}}}}>清空本组</Button></>}
    {videoCoachReady&&<Button className="wide" onClick={()=>{setExtras(null);setEntry('video');}}>动作复盘</Button>}
    {!rest&&!atRest&&<Button className="wide" onClick={async()=>{setExtras(null);const v=await ask('记录自主休息','按实际点击记录起止，不自动判断组间停顿。',['取消','开始不计时休息','开始10分钟页面计时']);if(v>0&&await change(q=>beginRest(q,v===2?10:null,v===2)))setExtras(null);}}>记录休息</Button>}
   </>}
   <p className="caption">实际 {allArrows(s).length} 箭 · 已确认 {s.ends.filter(e=>e.confirmed).length} 组 · 原计划 {sessionPlannedArrows(s)??'不限'} 箭</p>
   <div className="chips">{s.ends.map((e,i)=><Button key={e.id} disabled={!e.confirmed} onClick={()=>{setExtras(null);open('group',s.id+':'+i);}}>第{i+1}组 {e.confirmed?'✓':'录入中'}</Button>)}</div>
  </Modal>}
  {end&&(!atRest||review)&&(!rest||review)&&<>
   <section className="score-results" aria-label="本组成绩">
    <div className="group-bar"><h2>第 {s.currentEnd+1} 组 {end.half}</h2><span>{end.arrows.length}/{end.capacity} 箭 · <b>{stats.total}</b> 分</span></div>
    <div className="recorded" aria-label="已录成绩">{end.arrows.length===0?<p className="score-empty-hint" role="status">等待录入 · 可选择下方点靶、数字或照片录入</p>:end.arrows.map((a,i)=><button key={a.id} className={`arrow ${selected===a.id?'chosen':''}`} disabled={photoDirty} onClick={()=>{setSelected(selected===a.id?null:a.id);setFace(a.face);}} aria-label={`第${i+1}箭 ${a.code}`} aria-pressed={selected===a.id}><b>{a.code}</b>{s.conditions.target.face_count>1&&<small>靶{a.face}</small>}</button>)}</div>
    {end.arrows.length>0&&<div className="score-results-footer"><span>{sources} · 点击成绩可修改</span></div>}
   </section>
   {editing&&<div className="edit-banner"><b>正在修改选中箭，不会新增</b><Button onClick={()=>setSelected(null)}>取消选中</Button></div>}
   <div className="score-entry-modes" role="group" aria-label="录入方式">
    <Button aria-pressed={mode==='target'} className={mode==='target'?'selected':''} aria-controls={entryId} onClick={()=>void chooseMode('target')}>点靶录入</Button>
    <Button aria-pressed={mode==='number'} className={mode==='number'?'selected':''} aria-controls={entryId} onClick={()=>void chooseMode('number')}>数字录入</Button>
    {!offlineAndroid&&!review&&<Button aria-pressed={mode==='photo'} className={mode==='photo'?'selected':''} disabled={editing||end.confirmed} aria-controls={entryId} onClick={()=>void chooseMode('photo')}>照片录入<span className="score-beta">测试版</span></Button>}
   </div>
   <section id={entryId} className={`score-entry-panel ${mode==='photo'?'score-entry-photo':''}`} aria-label={mode==='target'?'点靶录入区':mode==='number'?'数字录入区':'照片录入区'}>
    {!offlineAndroid&&mode==='photo'?<PhotoEntry key={`${s.id}:${end.id}:${face}`} session={s} face={face} onBack={()=>setMode('target')} onDirtyChange={setPhotoDirty}/>:<>
     <LayoutPicker target={s.conditions.target} face={face} setFace={setFace}/>
     <p className="score-entry-hint" role="status">{editing?(mode==='number'?'选择环值修改此箭；数字改分会清除原坐标。':'轻点靶面调整此箭的位置；双指缩放不记箭。'):cannotAdd?'本组已录完。点击上方成绩可修改，或保存后继续。':mode==='target'?'轻点记一箭；双指缩放，放大后拖动查看。':'轻点环值记一箭；数字录入不生成落点。'}</p>
     {mode==='number'
      ?<div className="numeric-pad" aria-label="分值输入">{s.conditions.target.allowed_score_codes.map(code=>{const style=scoreKeyColors(s.conditions.target,code);return <button key={code} data-code={code} disabled={!editing&&cannotAdd} onClick={()=>record(code)} style={style} className={code==='M'?'miss':style?`score-ring${code==='X'?' score-x':''}`:''}>{code}</button>;})}</div>
      :<ScoreTarget showSpread={showSpread} setShowSpread={setShowSpread} zoomable resetKey={`${s.id}:${end.id}`} target={s.conditions.target} arrows={end.arrows} face={face} selected={selected} overlay={showSpread?<ScoringCircles stats={faceStats}/>:null} onTap={!editing&&cannotAdd?undefined:(x,y)=>record(scoreAt(s.conditions.target,x,y),{x,y})}/>
     }
    </>}
   </section>
   {!review&&<div className="score-primary-actions"><Button className="score-undo" disabled={photoDirty||!end.arrows.length||end.confirmed} onClick={async()=>{if(await change(q=>{q.ends[q.currentEnd].arrows.pop();q.revision++;}))setSelected(null);}}>撤销上一箭</Button>{end.confirmed?(finishedPlan?<span className="badge">本组已保存</span>:<Button kind="primary" disabled={photoDirty} onClick={()=>change(advance)}>继续下一项 →</Button>):<Button kind="primary" disabled={photoDirty||!end.arrows.length||savingEnd} onClick={continueEnd}>{savingEnd?'正在保存…':finishedPlan?'保存追加组':lastPlanned?'保存最后一组':'保存本组并继续'}</Button>}</div>}
   {mode!=='photo'&&<details className="score-help"><summary>录入与辅助圈说明</summary><p>点击上方成绩再输入即可修改。边框内靶外白区可记 M 并保留位置；数字改分会清除该箭坐标。压线环值请人工核对。</p><p>当前靶位 {faceStats.n} 箭，坐标 {faceStats.located}/{faceStats.n}。蓝圈表示靶内落点的80%集中范围，至少3个靶内落点后显示；多个候选群分别绘圈，数字箭不补坐标。完整分析在复盘查看。</p><p>成功录入的成绩已保存到本机，切换录入方式或模块不会清空。</p></details>}
  </>}
  {review&&end&&<><Metrics arrows={end.arrows}/><Distribution arrows={end.arrows}/><Spatial arrows={end.arrows} target={s.conditions.target} size={s.conditions.size}/></>}
  {!review&&<section className="score-saved-ends" aria-label="已保存各组成绩"><h2>已保存 {s.ends.filter(item=>item.confirmed&&item.arrows.length).length} 组</h2>{s.ends.map((item,index)=>item.confirmed&&item.arrows.length?<button type="button" key={item.id} onClick={()=>open('group',`${s.id}:${index}`)} aria-label={`查看第${index+1}组，${item.arrows.length}箭，${statistics(item.arrows).total}分`}><span>第 {index+1} 组</span><strong>{statistics(item.arrows).total} 分</strong><small>{item.arrows.length} 箭 · {item.arrows.map(arrow=>arrow.code).join(' / ')}</small></button>:null)}{!s.ends.some(item=>item.confirmed&&item.arrows.length)&&<p>保存本组后，成绩会显示在这里。</p>}</section>}
 </div>;
}
