import {ChoiceSelect} from './ChoiceSelect';
import React, { useEffect, useState, useRef } from 'react';
import { allArrows, copy, sessionPlannedArrows, unexecutedGroups, Session } from './domain';
import { decimal, percent, statistics } from './statistics';
import { Distribution, EquipmentComparison, Metrics, Spatial, Trends } from './Analysis';
import { NumberInput, Back, Button, Empty, Field, Panel, sessionIn, useApp } from './ui';
import { exportText } from './store';
import { VideoEntry } from './media';
import { offlineAndroid, videoCoachReady } from './release-mode';
import {hasOfflineFileSaver,isOfflineFileHost,saveOfflineFile} from './offline-file-export';
import { HistoryComparison, GroupComparison } from './Comparison';
import { useReviewState } from './review-state';
import { HistoryCalendar } from './HistoryCalendar';
import { emptyHistoryFilter, filterHistory, HistoryFilter, presetRange, removeCompletedSession, scoreExtremes, csvSession } from './review-data';
import { SharePosterModal } from './share-poster/SharePosterModal';
import './review.css';
import { SessionReviewHeader, SessionVisual } from './ReviewVisual';
import {sessionTimeLabel} from './session-label';

export function ReportPreview({id,onBack,backLabel="返回单场复盘"}:{id:string;onBack:()=>void;backLabel?:string}) {
  const {data}=useApp(),s=data.sessions.find(session=>session.id===id);
  if(!s)return <><Back title="分享海报" onBack={onBack} label={backLabel}/><Empty title="记录不存在">请返回选择其他场次。</Empty></>;
  if(s.status!=='completed'||!allArrows(s).length)return <><Back title="分享海报" onBack={onBack} label={backLabel}/><Empty title="完成训练后再分享">这场训练尚未形成可分享的成绩。</Empty></>;
  return <><Back title="分享海报" onBack={onBack} label={backLabel}/><SharePosterModal session={s} nickname={data.profile.name} onClose={onBack} restoreFocus={()=>{}}/></>;
}

function useFilters() { return useReviewState<HistoryFilter>('history-filter',emptyHistoryFilter); }
function Filters({value:f,onChange}:{value:HistoryFilter;onChange:(f:HistoryFilter)=>void}) {
  const set=(patch:Partial<HistoryFilter>)=>onChange({...f,...patch});
  return <div className="review-filters"><div className="review-periods" aria-label="历史日期快捷筛选">{[7,30,90].map(days=><Button key={days} aria-pressed={f.period===String(days)} kind={f.period===String(days)?'selected':''} onClick={()=>set(presetRange(days))}>近{days}天</Button>)}<Button aria-pressed={f.period==='all'} kind={f.period==='all'?'selected':''} onClick={()=>set({from:'',to:'',day:'',period:'all'})}>全部</Button></div><Field label="搜索训练记录"><input type="search" value={f.query} maxLength={200} onChange={e=>set({query:e.target.value})} placeholder="名称、心得、靶型、器材"/></Field><details className="review-data-details"><summary>日期与距离筛选{f.from||f.to||f.distance?' · 已设置':''}</summary><div className="form-row date-row"><Field label="开始日期"><input type="date" value={f.from} onChange={e=>set({from:e.target.value,period:'custom',day:''})}/></Field><Field label="结束日期"><input type="date" value={f.to} onChange={e=>set({to:e.target.value,period:'custom',day:''})}/></Field></div><Field label="距离（米）"><input type="number" value={f.distance} placeholder="全部距离" onChange={e=>set({distance:e.target.value})}/></Field><Button onClick={()=>onChange({...emptyHistoryFilter})}>清除所有筛选</Button></details>{f.from&&f.to&&f.from>f.to&&<p className="notice" role="alert">开始日期晚于结束日期，请调整范围。</p>}{f.day&&<Button onClick={()=>set({day:''})}>取消日期筛选 · {f.day}</Button>}</div>;
}
export function History() {
  const {data,open}=useApp(),records=filterHistory(data.sessions,emptyHistoryFilter),recent=records.slice(0,5);
  const completed=records;
  if(!completed.length)return <><div className="page-title"><span className="eyebrow">GONGXINGJI · 复盘</span><h1>完成一次训练后再复盘</h1><p>这里会显示真实记录、变化趋势和训练对比。</p></div><Button kind="primary" className="wide insights-entry" onClick={()=>open('insights')}>数据分析 · 看本场变化 ›</Button><Panel className="empty-state-panel"><Empty title="还没有完成训练">草稿不会计入复盘；完成训练后记录会自动出现在这里。</Empty><div className="empty-state-actions"><Button kind="primary" className="wide" onClick={()=>open('training')}>去训练</Button>{data.sessions.some(session=>session.status==='draft')&&<Button className="wide" onClick={()=>open('drafts')}>查看草稿</Button>}</div></Panel></>;
  return <><div className="page-title"><span className="eyebrow">GONGXINGJI · 复盘</span><h1>每次训练，都有迹可循</h1><p>先看最近记录，再按需要查找全部历史。</p></div><Panel title="训练概览"><Metrics arrows={records.flatMap(allArrows)}/><p>{records.length}场完成训练；草稿、未执行部分不进入总览。</p></Panel><Button kind="primary" className="wide insights-entry" onClick={()=>open('insights')}>数据分析 · 看本场变化 ›</Button><div className="review-entry-grid"><button onClick={()=>open('trends')}><strong>变化趋势</strong><span>日 / 周 / 月 / 场次 ›</span></button><button onClick={()=>open('compare')}><strong>训练对比</strong><span>场次 / 时间段 / 器材 ›</span></button></div><Panel title="最近训练">{recent.map(s=><HistoryRow key={s.id} session={s} onOpen={()=>open('insights',s.id)}/>)}<Button className="wide" onClick={()=>open('history-all')}>查看全部历史与搜索 · {records.length}场 ›</Button></Panel></>;
}
function HistoryRow({session:s,onOpen}:{session:Session;onOpen:()=>void}) {const st=statistics(allArrows(s));return <button className="history-row" data-record-id={s.id} onClick={onOpen}><span><b>{s.name}</b><small>{sessionTimeLabel(s)} · {s.conditions.distance}m · {s.conditions.target.name}</small></span><span><strong>{st.total}分</strong><small>{st.n}箭 / 均{decimal(st.average)}</small></span><span>›</span></button>;}
export function HistoryAll({onBack,backLabel="返回复盘"}:{onBack:()=>void;backLabel?:string}) {
  const {data,open}=useApp(),[filter,setFilter]=useFilters(),records=filterHistory(data.sessions,filter),calendarRecords=filterHistory(data.sessions,{...filter,day:''});
  return <><Back title="训练记录" onBack={onBack} label={backLabel}/><Panel><Filters value={filter} onChange={setFilter}/><p>当前范围 {records.length} 场完成训练；草稿不计入。</p></Panel><details className="training-disclosure training-calendar-filter"><summary>按训练日期查看 <span>{filter.day||'展开日历'}</span></summary><HistoryCalendar sessions={calendarRecords} selected={filter.day} onSelect={day=>setFilter({...filter,day})}/><p className="caption">日历标记遵循上方日期、距离与搜索范围。未来安排在“训练”。</p></details><Panel title={`训练记录 · ${records.length}场`}>{!records.length&&<p>当前范围没有完成记录。可清除筛选或先完成一次训练。</p>}{records.map(s=><HistoryRow key={s.id} session={s} onOpen={()=>open('insights',s.id)}/>)}</Panel></>;
}
export function HistoryTrends({onBack,backLabel="返回复盘"}:{onBack:()=>void;backLabel?:string}) {
  const {data,open}=useApp(),[filter,setFilter]=useFilters(),records=filterHistory(data.sessions,filter);
  return <><Back title="趋势分析" onBack={onBack} label={backLabel}/><Panel><Filters value={filter} onChange={setFilter}/><p>当前范围 {records.length}场 / {records.flatMap(allArrows).length}箭；与历史筛选保持一致。</p></Panel><Trends sessions={records}/><details className="training-disclosure"><summary>计划与实际箭量 <span>{records.length} 场明细</span></summary><div className="table-scroll"><table><thead><tr><th>训练日期 / 来源</th><th>计划箭量</th><th>实际箭量</th></tr></thead><tbody>{records.map(s=><tr key={s.id}><td><button className="review-source-link" onClick={()=>open('insights',s.id)}>{s.date} · {s.name}</button></td><td>{sessionPlannedArrows(s)??'不限'}</td><td>{allArrows(s).length}</td></tr>)}</tbody></table></div><p className="caption">频次为当前范围内完成场次数。计划箭量来自执行时快照，不根据后来模板变化改写；箭量差不自动视为未达标。</p></details></>;
}
export function HistoryCompare({onBack,backLabel="返回复盘"}:{onBack:()=>void;backLabel?:string}) {
  const {data}=useApp();const [tab,setTab]=useReviewState('compare-page-tab','sessions'),records=data.sessions.filter(s=>s.status==='completed');
  return <><Back title="训练对比" onBack={onBack} label={backLabel}/><div className="segmented"><Button aria-pressed={tab==='sessions'} kind={tab==='sessions'?'selected':''} onClick={()=>setTab('sessions')}>场次 / 时间段</Button><Button aria-pressed={tab==='equipment'} kind={tab==='equipment'?'selected':''} onClick={()=>setTab('equipment')}>同条件器材</Button></div>{tab==='equipment'?<EquipmentComparison sessions={records}/>:<HistoryComparison sessions={records}/>}</>;
}
type SessionDetailProps={id:string;onBack:()=>void;initialTab?:'records'|'analysis'|'notes';backLabel?:string};
export function SessionDetail(props:SessionDetailProps){
 const {data,open}=useApp(),session=data.sessions.find(value=>value.id===props.id);
 if(session?.status==='completed'&&props.initialTab!=='notes')return <SessionVisual key={session.id} sessions={data.sessions} open={open} sessionId={session.id} onBack={props.onBack} backLabel={props.backLabel} recordsContent={<SessionDetailContent key={session.id} {...props} embedded/>}/>;
 return <SessionDetailContent key={props.id} {...props}/>;
}
function SessionDetailContent({id,onBack,initialTab,backLabel="返回复盘",embedded=false}:SessionDetailProps&{embedded?:boolean}) {
  const {data,update,open,ask,tell}=useApp(),session=data.sessions.find(s=>s.id===id);
  const tab=initialTab==='notes'?'notes':'records';
  const [half,setHalf]=useReviewState(id+':detail-half','all'),[fromEnd,setFromEnd]=useReviewState(id+':detail-from',1),[toEnd,setToEnd]=useReviewState(id+':detail-to',session?.ends.length??1),[video,setVideo]=useState(false);
  if(!session)return <><Back title="单场复盘" onBack={onBack} label={backLabel}/><Empty title="记录不存在">记录可能已删除，请返回重新选择。</Empty></>;
  const s=session,validRange=Number.isInteger(fromEnd)&&Number.isInteger(toEnd)&&fromEnd>=1&&toEnd>=fromEnd&&toEnd<=s.ends.length;
  const hasHalves=s.ends.some(e=>e.arrows.length&&e.half==='上半场')&&s.ends.some(e=>e.arrows.length&&e.half==='下半场');
  const canCompareGroups=s.ends.filter(e=>e.arrows.length>0).length>=2;
  const effectiveHalf=hasHalves?half:'all';
  const ends=validRange?s.ends.filter((e,i)=>e.arrows.length&&i>=fromEnd-1&&i<toEnd&&(effectiveHalf==='all'||e.half===effectiveHalf)):[],arrows=ends.flatMap(e=>e.arrows);
  if(videoCoachReady&&video)return <VideoEntry session={s} onBack={()=>setVideo(false)}/>;
  const canLeaveNotes=async()=>tab!=='notes'||window.dispatchEvent(new Event('gongxingji:before-navigate',{cancelable:true}))||await ask('离开心得编辑？','本次尚未保存的心得与自评会放弃；以前保存的记录保留。',['继续编辑','放弃本次编辑'])===1;

  const openVideo=async()=>{if(await canLeaveNotes())setVideo(true);};
  const localFilePicker=offlineAndroid&&isOfflineFileHost(),canExport=!localFilePicker||hasOfflineFileSaver();
  const remove=async()=>{if(await ask('删除这次训练记录？',`${s.date} · ${s.name}，共${allArrows(s).length}箭。删除后本机成绩与心得无法恢复；计划模板保留，日历安排解除完成关联。`,['取消','继续删除'])!==1)return;if(await ask('确认删除本场',`仅删除“${s.name}”这一场。${canExport?'可先取消并在下方导出原始记录。':''}`,['保留记录','确认删除'])!==1)return;if(await update(d=>removeCompletedSession(d,s.id))){tell('已删除本场记录，计划和未来安排保留');onBack();}};
  const exportSession=async(kind:'csv'|'json')=>{
    try {
      const filename=`gongxingji-${s.date}-${s.id.slice(0,8)}.${kind}`;
      const content=kind==='csv'?csvSession(s):JSON.stringify({format:'gongxingji-session-export/v1',session:s},null,2);
      const mime=kind==='csv'?'text/csv':'application/json';
      if(localFilePicker){
        const result=await saveOfflineFile(filename,content,mime);
        tell(result==='saved'?'原始记录已保存到所选位置':'已取消保存原始记录');
      }else{
        exportText(filename,content,mime);
        tell('已请求保存原始记录，请以系统完成提示为准');
      }
    }catch(error){tell(error instanceof Error?error.message:'导出失败');}
  };
  return <div className={"session-record-view"+(embedded?" vx-merged-records":"")}>{!embedded&&<><SessionReviewHeader session={s} sessions={data.sessions} view={tab} open={open} onBack={onBack} backLabel={backLabel}/><p className="caption">{s.conditions.bow||'弓种未知'} · {s.conditions.target.name} · {s.conditions.equipment?.name??'器材未填写'} · 靶纸 {s.conditions.size??'未知'}{s.conditions.size?'cm':''}</p></>}

  {tab==='records'&&!embedded&&<Panel title="实际逐组成绩">{s.ends.map((e,i)=>{if(!e.arrows.length)return null;const st=statistics(e.arrows),ex=scoreExtremes(e.arrows);return <article className="end-summary" key={e.id}><div className="line"><h3>第{i+1}组 {e.half}</h3><Button onClick={()=>open('group',`${s.id}:${i}`)}>查看 / 改分</Button></div><div className="mini-arrows">{e.arrows.map((a,j)=><span key={a.id}><small>{j+1}{s.conditions.target.face_count>1?`(靶${a.face})`:''}</small><b>{a.code}</b>{a.note&&<small title={a.note}>有备注</small>}</span>)}</div><p>{st.n}箭 · {st.total}分 · 均{decimal(st.average)}环 · {e.confirmed?'已确认':'未确认'}</p><p className="caption">最高/最低单箭 {ex.max}/{ex.min}环；命中率 {percent(ex.hit)}（非M / 全部{st.n}箭）。</p>{e.note&&<p className="review-note">本组：{e.note}</p>}</article>;})}<p className="caption">序号是录入位置，不代表射箭先后；剩余空位不列为M。</p>{s.plan&&<details className="review-data-details"><summary>原计划快照与未执行部分</summary>{s.plan.blocks.map(b=><p key={b.id}>{b.label} {b.half}：{b.kind==='score'?`${b.ends}组×${b.arrows}箭；实际记录 ${s.ends.filter(e=>e.blockId===b.id&&e.arrows.length).length}组`:`计划休息${b.minutes}分钟；${s.rest.some(r=>r.blockId===b.id)?'已记录休息':s.skippedRests.includes(b.id)?'已跳过':'未执行'}`}</p>)}</details>}</Panel>}
  {tab==='records'&&<section id="session-advanced" className="vx-advanced-analysis" aria-label="范围与组间分析"><h2 tabIndex={-1}>范围与组间分析</h2><Panel title="本场分析范围"><div className="form-row"><Field label="从第几组"><NumberInput min="1" max={s.ends.length} value={fromEnd} onValue={setFromEnd}/></Field><Field label="到第几组"><NumberInput min="1" max={s.ends.length} value={toEnd} onValue={setToEnd}/></Field></div>{hasHalves&&<Field label="明确半场"><ChoiceSelect value={effectiveHalf} onChange={e=>setHalf(e.target.value)}><option value="all">全场</option><option>上半场</option><option>下半场</option></ChoiceSelect></Field>}{!validRange&&<p className="notice">填写本场实际范围内的起止组号，开始不能晚于结束。</p>}<Metrics arrows={arrows}/>{!hasHalves&&<p className="caption">本场未设置比赛半场，可按组号选择范围或比较实际组别。</p>}</Panel><div className="vx-range-graphs"><Distribution arrows={arrows}/><Spatial arrows={arrows} target={s.conditions.target} size={s.conditions.size}/></div>{canCompareGroups&&<section className="vx-direct-group-comparison" aria-label="组间比较"><GroupComparison session={s}/></section>}</section>}
  {tab==='notes'&&<><Notes key={s.id} session={s}/><Button onClick={()=>open('insights',s.id)}>返回成绩与记录</Button></>}
  <details className="review-data-details vx-record-tools"><summary>分享、下次训练与记录管理</summary>{embedded&&<>{s.plan&&<details className="review-data-details"><summary>原计划快照与未执行部分</summary>{s.plan.blocks.map(b=><p key={b.id}>{b.label} {b.half}：{b.kind==='score'?`${b.ends}组×${b.arrows}箭；实际记录 ${s.ends.filter(e=>e.blockId===b.id&&e.arrows.length).length}组`:`计划休息${b.minutes}分钟；${s.rest.some(r=>r.blockId===b.id)?'已记录休息':s.skippedRests.includes(b.id)?'已跳过':'未执行'}`}</p>)}</details>}</>}<p>计划 {sessionPlannedArrows(s)??'不限'}箭，实际 {allArrows(s).length}箭。{sessionPlannedArrows(s)!==null&&`计划差额 ${Math.max(0,sessionPlannedArrows(s)!-allArrows(s).length)}箭；原编排未执行 ${unexecutedGroups(s)??0}组，空位不补M。`}</p><div className="actions"><Button data-return-focus={`share-record-${s.id}`} onClick={()=>open('report',s.id)}>分享报告</Button><Button onClick={()=>open('adjust',s.id)}>调整下次训练</Button>{videoCoachReady&&<Button onClick={()=>void openVideo()}>动作复盘</Button>}</div>
  <Panel title="实际休息记录">{s.rest.length===0?<p>未记录休息，不能从录入间隔推算。</p>:s.rest.map(r=><p key={r.id}>开始 {new Date(r.started).toLocaleTimeString()} → {r.ended?new Date(r.ended).toLocaleTimeString():'尚未继续'}；{r.ended?`${Math.round((Date.parse(r.ended)-Date.parse(r.started))/1000)}秒`:'计时中'}</p>)}</Panel>{s.status==='completed'&&<Panel title="记录管理">
    {canExport?<><p className="caption">单场 JSON 只包含此场训练。{!offlineAndroid&&'完整本机备份在“我的 → 数据管理”。'}</p><div className="actions"><Button onClick={()=>void exportSession('csv')}>导出逐箭 CSV</Button><Button onClick={()=>void exportSession('json')}>导出单场 JSON</Button></div></>:<p className="caption">此设备当前无法保存 CSV 或 JSON 文件。</p>}
    <p className="caption">删除本场不会删除计划模板。其他场次与已有器材快照保持独立。</p><Button className="review-delete" onClick={()=>void remove()}>删除本场记录</Button></Panel>}</details></div>;
}
function Notes({session:s}:{session:Session}) {
 const {data,update,tell}=useApp();
 const saving=useRef(false),mounted=useRef(false),[savePending,setSavePending]=useState(false);
 const [note,setNote]=useState(s.note),[energy,setEnergy]=useState(s.energy===null?'':String(s.energy)),[fatigue,setFatigue]=useState(s.fatigue===null?'':String(s.fatigue)),[equipment,setEquipment]=useState(''),[size,setSize]=useState(''),[bow,setBow]=useState('');
 const snapshot=JSON.stringify({note,energy,fatigue,equipment,size,bow}),saved=useRef(snapshot),latest=useRef(snapshot),dirty=useRef(false);
 latest.current=snapshot;dirty.current=snapshot!==saved.current;
 useEffect(()=>{mounted.current=true;const guard=(e:Event)=>{if(dirty.current)e.preventDefault();};const unload=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('gongxingji:before-navigate',guard);window.addEventListener('beforeunload',unload);return()=>{mounted.current=false;window.removeEventListener('gongxingji:before-navigate',guard);window.removeEventListener('beforeunload',unload);};},[]);
 const save=async()=>{if(saving.current)return;saving.current=true;setSavePending(true);const captured=snapshot;try{const ok=await update(d=>{for(const v of [energy,fatigue])if(v!==''&&(!Number.isFinite(Number(v))||Number(v)<0||Number(v)>10))throw new Error('自评分须为0–10或留空');const q=sessionIn(d,s.id);q.note=note;q.energy=energy===''?null:Number(energy);q.fatigue=fatigue===''?null:Number(fatigue);if(!q.conditions.equipment&&equipment)q.conditions.equipment=copy(d.equipment.find(e=>e.id===equipment)??null);if(q.conditions.size===null&&size){const n=Number(size);if(!Number.isFinite(n)||n<=0||n>1000)throw new Error('尺寸须大于0且不超过1000cm');q.conditions.size=n;}if(!q.conditions.bow&&bow)q.conditions.bow=bow;q.revision++;});if(ok===true&&mounted.current){saved.current=captured;dirty.current=latest.current!==captured;if(!dirty.current)tell('已保存到本机',{placement:'top',durationMs:2000});}}catch{if(mounted.current)tell('未能保存到本机，请稍后重试；输入内容仍保留。');}finally{saving.current=false;if(mounted.current)setSavePending(false);}};
 return <Panel title="练后心得（可跳过，之后可补记）"><Field label="心得"><textarea value={note} maxLength={10000} onChange={e=>setNote(e.target.value)} placeholder="这次练习关注了什么，下次准备怎样调整？"/></Field><div className="form-row"><Field label="主观体能 0–10"><input type="number" min="0" max="10" value={energy} onChange={e=>setEnergy(e.target.value)}/></Field><Field label="主观疲劳 0–10"><input type="number" min="0" max="10" value={fatigue} onChange={e=>setFatigue(e.target.value)}/></Field></div>{!s.conditions.equipment&&<Field label="补记本场实际器材"><ChoiceSelect value={equipment} onChange={e=>setEquipment(e.target.value)}><option value="">不补记</option>{data.equipment.map(q=><option key={q.id} value={q.id}>{q.name}</option>)}</ChoiceSelect></Field>}{s.conditions.size===null&&<Field label="补记已核实靶纸尺寸 cm"><input type="number" min="1" value={size} onChange={e=>setSize(e.target.value)} placeholder="仍未知时留空"/></Field>}{!s.conditions.bow&&<Field label="补记本场弓种"><ChoiceSelect value={bow} onChange={e=>setBow(e.target.value)}><option value="">仍未知</option>{['反曲弓','复合弓','光弓','传统弓','其他'].map(b=><option key={b}>{b}</option>)}</ChoiceSelect></Field>}<Button kind="primary" disabled={savePending} aria-busy={savePending} onClick={()=>void save()}>{savePending?'正在保存…':'保存心得与自评'}</Button><p className="caption">未填就是缺失，不默认填中间分数，也不从成绩变化推断疲劳原因。</p></Panel>;
}
