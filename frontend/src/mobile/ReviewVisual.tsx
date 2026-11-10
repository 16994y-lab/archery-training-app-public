import {FirstBatchHeader} from './FirstBatchHeader';
import './training-review.css';
import {ChoiceSelect} from './ChoiceSelect';
import {sessionTimeLabel} from './session-label';
import React, { useMemo, useState } from 'react';
import { allArrows, localDate, Session } from './domain';
import { savedCoordinateCoverage, strictComparisonKey } from './analysis-insights';
import { decimal, equipmentKey, statistics } from './statistics';
import { Chart, ChartOption } from './Chart';
import { AppIcon } from './AppIcon';
import { SessionSpatialReview } from './SessionSpatialReview';
import { SessionScoreOverview } from './SessionScoreOverview';
import { SessionGroupCompare } from './SessionGroupCompare';
import { spatialDiameter } from './session-spatial-geometry';
import { useReviewState } from './review-state';
import { Back, Modal } from './ui';
import { activity, emptyVisualFilter, visualComparison, visualRecords, VisualFilter } from './review-visual-model';
import './review-visual.css';
import {TrainingActivity} from './TrainingActivity';

export type VisualProps={sessions:Session[];open:(name:string,id?:string)=>void;today?:string};
const signed=(n:number)=>`${n>=0?'+':''}${n.toFixed(2)}`;
function Method({children,label='数值与计算依据'}:{children:React.ReactNode;label?:string}){return <details className="vx-method"><summary>{label}</summary>{children}</details>;}
function Card({title,children,extra,className='',id}:{title:string;children:React.ReactNode;extra?:React.ReactNode;className?:string;id?:string}){return <section id={id} className={`vx-card ${className}`}><div className="vx-card-head"><h2 tabIndex={id?-1:undefined}>{title}</h2>{extra}</div>{children}</section>;}
function Button({children,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>){return <button type="button" className="vx-button" {...props}>{children}</button>;}
function Empty({filtered,onClear,open}:{filtered?:boolean;onClear?:()=>void;open:VisualProps['open']}){return <section className="vx-empty"><svg viewBox="0 0 180 100" aria-hidden="true"><path d="M15 84H165M32 60L72 42L106 60L144 24" fill="none" stroke="#c6d9e8" strokeWidth="3" strokeDasharray="5 5"/><circle cx="106" cy="60" r="8" fill="#e5edf4"/></svg><h2>{filtered?'筛选内没有记录':'还没有完成训练'}</h2><p>{filtered?'换个范围再看。':'草稿不计入复盘。'}</p><Button onClick={()=>filtered?onClear?.():open('training')}>{filtered?'清除筛选':'去训练'}</Button></section>;}
function lineOption(labels:string[],values:(number|null)[],name:string,bar=false):ChartOption{return {tooltip:{trigger:'axis',confine:true,renderMode:'richText'},grid:{left:31,right:14,top:14,bottom:30},xAxis:{type:'category',data:labels,axisTick:{show:false},axisLabel:{hideOverlap:true,color:'#586f82'}},yAxis:{type:'value',min:0,max:bar?undefined:10,minInterval:bar?1:undefined,splitLine:{lineStyle:{color:'#e8eff5'}},axisLabel:{color:'#586f82'}},series:[{name,type:bar?'bar':'line',data:values,symbolSize:8,connectNulls:false,barMaxWidth:16,lineStyle:{width:2.5,color:'#356ac1'},itemStyle:{color:'#356ac1'},areaStyle:bar?undefined:{color:'#79a9df',opacity:.14}}]};}
export type SessionReviewView='analysis'|'records'|'notes';
export function SessionReviewHeader({session:s,sessions,view,open,onBack,backLabel='返回复盘'}:{session:Session;sessions:Session[];view:SessionReviewView;open:VisualProps['open'];onBack:()=>void;backLabel?:string}){
 const records=sessions.filter(r=>r.status==='completed').sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id));
 const choices=records.some(r=>r.id===s.id)?records:[s,...records];
 const views=[['records','insights','成绩与记录'],['notes','reflection','训练心得']] as const;
 const share=s.status==='completed'&&s.ends.some(end=>end.arrows.length)
  ? <button type="button" className="vx-approved-share" aria-label="分享本场训练" data-return-focus={`share-visual-${s.id}`} onClick={()=>open('report',s.id)}><AppIcon name="share"/></button>
  : undefined;
 return <header className="vx-session-context"><Back title="单场复盘" onBack={onBack} label={backLabel} action={share}/><div className="vx-session-identity training-session-summary"><span className="training-section-caption">{s.status==='completed'?'已完成训练':'未完成，不计入复盘总览'}</span><h2>{s.name}</h2><p>{sessionTimeLabel(s)} · {s.conditions.distance}米 · {allArrows(s).length}箭</p></div>{choices.length>1&&<label className="vx-select vx-session-picker"><span>切换训练</span><ChoiceSelect appearance="aurora" aria-label="切换训练" value={s.id} onChange={e=>{if(e.target.value!==s.id)open('insights',e.target.value);}}>{choices.map(r=><option key={r.id} value={r.id} data-description={`${sessionTimeLabel(r)} · ${r.conditions.distance}米 · ${allArrows(r).length}箭`}>{r.name}</option>)}</ChoiceSelect></label>}<nav className="vx-session-nav" aria-label="单场复盘视图">{views.map(([key,route,label])=><button key={key} type="button" aria-current={(view==='notes'?key==='notes':key==='records')?'page':undefined} onClick={()=>{if((view==='notes')!==(key==='notes'))open(route,s.id);}}>{label}</button>)}</nav></header>;
}
function ReviewFilter({filter,distances,onApply,onClose}:{filter:VisualFilter;distances:number[];onApply:(filter:VisualFilter)=>void;onClose:()=>void}){
 const [draft,setDraft]=useState<VisualFilter>({...filter});
 const update=(patch:Partial<VisualFilter>)=>setDraft(current=>({...current,...patch}));
 const invalid=Boolean(draft.from&&draft.to&&draft.from>draft.to);
 return <Modal title="筛选训练" onClose={onClose}><form className="vx-filter-form" onSubmit={event=>{event.preventDefault();if(!invalid)onApply(draft);}}>
  <label>时间范围<ChoiceSelect appearance="aurora" aria-label="筛选时间范围" value={draft.days} onChange={event=>update({days:event.target.value,from:'',to:''})}><option value="7">近7天</option><option value="30">近30天</option><option value="all">全部 / 自选日期</option></ChoiceSelect></label>
  <div className="vx-filter-dates"><label>开始日期<input aria-label="开始日期" type="date" value={draft.from} onChange={event=>update({from:event.target.value,days:'all'})}/></label><label>结束日期<input aria-label="结束日期" type="date" value={draft.to} onChange={event=>update({to:event.target.value,days:'all'})}/></label></div>
  {invalid&&<p className="vx-filter-error" role="alert">开始日期不能晚于结束日期。</p>}
  <label>距离<ChoiceSelect appearance="aurora" aria-label="筛选距离" value={draft.distance} onChange={event=>update({distance:event.target.value})}><option value="">全部距离</option>{distances.map(distance=><option value={distance} key={distance}>{distance}米</option>)}</ChoiceSelect></label>
  <label>搜索<input aria-label="搜索训练" type="search" value={draft.query} onChange={event=>update({query:event.target.value})} placeholder="名称、心得、器材"/></label>
  <div className="vx-filter-actions"><Button onClick={()=>setDraft({...emptyVisualFilter,days:'all'})}>重置</Button><Button onClick={onClose}>取消</Button><Button type="submit" className="vx-button vx-primary" disabled={invalid}>应用筛选</Button></div>
 </form></Modal>;
}

export function ReviewHomeVisual({sessions,open,today=localDate()}:VisualProps){
 const [filter,setFilter]=useReviewState<VisualFilter>('visual-home-filter',{...emptyVisualFilter});
 const [metric,setMetric]=useReviewState('visual-home-metric','arrows'),[filterOpen,setFilterOpen]=useState(false);
 const records=useMemo(()=>visualRecords(sessions,filter,today),[sessions,filter,today]),st=statistics(records.flatMap(allArrows)),last=records.find(s=>allArrows(s).length>0);
 const allCompleted=sessions.filter(s=>s.status==='completed'),hasFilter=filter.days!=='all'||Boolean(filter.distance||filter.query||filter.from||filter.to);
 const detailsActive=Boolean(filter.distance||filter.query||filter.from||filter.to),points=activity(records,today),max=Math.max(1,...points.map(p=>p.arrows));
 const key=last?strictComparisonKey(last):null,cohort=key?records.filter(s=>strictComparisonKey(s)===key).sort((a,b)=>a.started.localeCompare(b.started)):[];
 const update=(patch:Partial<VisualFilter>)=>setFilter({...filter,...patch});
 const clear=()=>setFilter({...emptyVisualFilter,days:'all'});
 return <div className="vx-page vx-review-home" data-page="review">
  <div className="training-batch-heading"><FirstBatchHeader title="复盘" eyebrow="训练手记 / 复盘" description="先看训练量和均环，再打开一场训练回看逐箭记录。" meta={`共 ${allCompleted.length} 场已完成`}/></div>
  <section className="vx-overview-group" aria-label="复盘范围与数据概览"><div className="vx-overview-group-title"><h2>训练概览</h2><span>范围内已完成记录</span></div><div className="vx-toolbar"><div className="vx-segment" aria-label="复盘时间范围">{[['7','7天'],['30','30天'],['all','全部']].map(([value,label])=><button type="button" key={value} aria-pressed={filter.days===value} onClick={()=>update({days:value,from:'',to:''})}>{label}</button>)}</div><Button className="vx-button vx-filter-trigger" aria-haspopup="dialog" aria-expanded={filterOpen} onClick={()=>setFilterOpen(true)}>筛选{detailsActive?' · 已设':''}</Button></div>
  {detailsActive&&<div className="vx-filter-summary"><span>{[filter.from||filter.to?(filter.from||'不限')+' 至 '+(filter.to||today):'',filter.distance?filter.distance+'米':'',filter.query?'搜索：'+filter.query:''].filter(Boolean).join(' · ')}</span><Button onClick={clear}>清除</Button></div>}
  {filter.from&&filter.to&&filter.from>filter.to&&<p role="alert" className="vx-state">日期范围倒置，请重新筛选。</p>}
  <section className="vx-overview" aria-label="训练数据概览"><h2 className="sr-only">训练数据概览</h2><div className="vx-volume"><div><span>实际箭量</span><strong data-value="arrows">{st.n}<small>箭</small></strong></div><div><b>{records.length}</b><span>已完成场次</span></div><div><b>{decimal(st.average)}</b><span>加权均环 · 含M</span></div></div><p className="vx-overview-scope">{filter.from||filter.to?'自选日期':filter.days==='all'?'全部日期':'近'+filter.days+'天'}{detailsActive?' · 按当前筛选':' · 已完成训练'}</p></section></section>
  <nav className="vx-secondary-entries vx-analysis-entries" aria-label="长期训练分析"><Button onClick={()=>open('trends')}><span><b>长期分析</b><small>成绩、箭量与落点</small></span><span aria-hidden="true">↗</span></Button></nav>
  <Card title="训练记录" extra={<Button aria-label="全部训练记录" onClick={()=>open('history-all')}>全部 {allCompleted.length}场 ›</Button>}>{records.length?records.slice(0,5).map(session=>{const stats=statistics(allArrows(session));return <button type="button" key={session.id} className="vx-record" onClick={()=>open('insights',session.id)}><span><b>{session.name}</b><small>{sessionTimeLabel(session)} · {session.conditions.distance}m · {stats.n}箭</small></span><span><strong>{decimal(stats.average)}</strong><small>均环 · 单场复盘 ›</small></span></button>;}):<p className="vx-state">当前范围没有训练记录。</p>}</Card>
  <TrainingActivity sessions={sessions} open={open} today={today}/>
  {!records.length?<Empty filtered={allCompleted.length>0&&hasFilter} onClear={clear} open={open}/>:<>
   <Card title={metric==='arrows'?'近期训练节奏':'近期同条件成绩'} className="vx-home-chart" extra={<div className="vx-segment" aria-label="概览图表指标"><button type="button" aria-pressed={metric==='arrows'} onClick={()=>setMetric('arrows')}>箭量</button><button type="button" aria-pressed={metric==='average'} onClick={()=>setMetric('average')}>均环</button></div>}>
    {metric==='arrows'?<><div className="vx-activity" role="group" aria-label="最近14天每日实际箭量，点击按日筛选">{points.map(point=><button type="button" key={point.date} aria-label={point.date+' '+point.arrows+'箭 '+point.sessions+'场'} onClick={()=>update({from:point.date,to:point.date,days:'all'})}><i style={{height:point.arrows?Math.max(5,point.arrows/max*60)+'px':'3px'}} data-empty={point.arrows===0}/><small>{point.date.slice(-2)}</small></button>)}</div><div className="vx-foot"><span>近14天 · 当前筛选内</span><b>{points.reduce((n,point)=>n+point.arrows,0)}箭</b></div></>:cohort.length>0?<><Chart option={lineOption(cohort.slice(-12).map(session=>session.date.slice(5)),cohort.slice(-12).map(session=>statistics(allArrows(session)).average),'均环')} label="最近同条件场次均环，纵轴0到10环" height={130} onSelect={index=>open('insights',cohort.slice(-12)[index].id)}/><p className="vx-state">同条件 {cohort.length}场 · 排除 {records.length-cohort.length}场{cohort.length<2?' · 仅1场，暂无趋势':''}{cohort.length>12?' · 图示最近12场':''}</p></>:<p className="vx-state">条件未完整 · 暂无可比趋势</p>}
    <Method><p>范围内 {records.length}场 / {st.n}箭 / {st.total}分，均环按全部实际箭数加权，含 {st.distribution.M}箭M。箭量图只显示最近14日，未训练日为0箭，不是0分；全部历史仍可访问。成绩图只使用最新场次的完整同条件记录，其余不合并。</p><table><thead><tr><th>日期</th><th>场</th><th>箭</th></tr></thead><tbody>{points.map(point=><tr key={point.date}><th>{point.date}</th><td>{point.sessions}</td><td>{point.arrows}</td></tr>)}</tbody></table>{metric==='average'&&<table><thead><tr><th>同条件场次</th><th>均环</th><th>分/箭</th></tr></thead><tbody>{cohort.map(session=>{const value=statistics(allArrows(session));return <tr key={session.id}><th><button type="button" className="vx-table-button" onClick={()=>open('insights',session.id)}>{session.date}</button></th><td>{decimal(value.average)}</td><td>{value.total}/{value.n}</td></tr>;})}</tbody></table>}</Method>
   </Card>
  </>}
  {filterOpen&&<ReviewFilter filter={filter} distances={[...new Set(allCompleted.map(session=>session.conditions.distance))].sort((a,b)=>a-b)} onClose={()=>setFilterOpen(false)} onApply={next=>{setFilter(next);setFilterOpen(false);}}/>}
 </div>;
}

function SessionGroupRecords({session,group,onSelect,open}:{session:Session;group:number|null;onSelect:(group:number)=>void;open:VisualProps['open']}){
 const trusted=new Set(savedCoordinateCoverage(session).trusted);
 const {target,size}=session.conditions;
 const scale=size===null?1:size*target.sizeRatio/2;
 const unit=size===null?'靶半径':'cm';
 const rows=session.ends.flatMap((end,index)=>{
  if(!end.arrows.length)return [];
  const points=target.face_count===1?end.arrows.filter(arrow=>trusted.has(arrow)).map(arrow=>({x:arrow.x!,y:arrow.y!})):[];
  const spread=spatialDiameter(points);
  return [{index,average:statistics(end.arrows).average,spread:spread===null?'—':`${(spread*scale).toFixed(1)} ${unit}`}];
 });
 const active=rows.find(row=>row.index===group)??rows[0];
 return <Card id="session-groups" title="逐组记录" className="vx-approved-group-records">
  <div className="vx-approved-record-head" aria-hidden="true"><span>组别</span><span>均环</span><span>散布</span></div>
  <div role="group" aria-label="逐组成绩">{rows.map(row=><Button key={row.index} aria-pressed={row.index===group} onClick={()=>{onSelect(row.index);document.getElementById('session-spatial')?.scrollIntoView({block:'nearest'});}}>
   <span>第 {row.index+1} 组</span><span>{decimal(row.average)}</span><span>{row.spread}</span>
  </Button>)}</div>
  {active&&<Button onClick={()=>open('group',`${session.id}:${active.index}`)}>查看或改分 · 第 {active.index+1} 组 ›</Button>}
  {active&&session.ends[active.index].note&&<p className="review-note">第 {active.index+1} 组备注 · {session.ends[active.index].note}</p>}
  {session.note&&<p className="review-note">训练备注 · {session.note}</p>}
 </Card>;
}

export function SessionVisual({sessions,open,sessionId,onBack,backLabel='返回复盘',recordsContent}:VisualProps&{sessionId?:string;onBack:()=>void;backLabel?:string;recordsContent?:React.ReactNode}){
 const records=useMemo(()=>sessions.filter(session=>session.status==='completed').sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id)),[sessions]);
 const session=sessionId?records.find(record=>record.id===sessionId):records[0];
 const [selected,setGroup]=useReviewState<number|null>(`session-group-${session?.id??'missing'}`,null);
 if(!session)return <div className="vx-page"><Back title="单场复盘" onBack={onBack} label={backLabel}/>{sessionId?<Card title="记录不可用"><p>未找到这场已完成训练。</p><Button onClick={onBack}>{backLabel}</Button></Card>:<Empty open={open}/>}</div>;
 const group=selected!==null&&session.ends[selected]?.arrows.length?selected:null;
 const hasArrows=allArrows(session).length>0;
 return <div className="vx-page vx-session-flow vx-approved-session" data-page="session">
  <SessionReviewHeader session={session} sessions={sessions} view="analysis" open={open} onBack={onBack} backLabel={backLabel}/>
  {hasArrows?<>
   <SessionScoreOverview session={session} group={group} setGroup={setGroup}/>
   <SessionSpatialReview session={session} group={group} setGroup={setGroup}/>
   <SessionGroupRecords session={session} group={group} onSelect={setGroup} open={open}/>
   <SessionGroupCompare session={session}/>
  </>:<Card title="没有逐箭成绩"><p>可查看已保存的心得与记录。</p></Card>}
  {recordsContent??<Card title="训练工具"><Button onClick={()=>open('adjust',session.id)}>调整下次训练</Button></Card>}
 </div>;
}

export function CompareVisual({sessions,open,onBack,backLabel="返回复盘",showHeader=true}:VisualProps&{onBack:()=>void;backLabel?:string;showHeader?:boolean}){
 const records=sessions.filter(s=>s.status==='completed').sort((a,b)=>a.started.localeCompare(b.started));
 const [mode,setMode]=useReviewState('visual-compare-mode','session'),[aId,setA]=useReviewState('visual-compare-a',records[records.length-2]?.id??''),[bId,setB]=useReviewState('visual-compare-b',records[records.length-1]?.id??''),[metric,setMetric]=useReviewState('visual-compare-metric','average');
 const [fromA,setFromA]=useReviewState('visual-compare-from-a',records[0]?.date??''),[toA,setToA]=useReviewState('visual-compare-to-a',records[0]?.date??''),[fromB,setFromB]=useReviewState('visual-compare-from-b',records[records.length-1]?.date??''),[toB,setToB]=useReviewState('visual-compare-to-b',records[records.length-1]?.date??'');
 const keys=[...new Set(records.map(s=>equipmentKey(s.conditions.equipment)))].filter(k=>k!=='unknown'),[kitA,setKitA]=useReviewState('visual-compare-kit-a',keys[0]??''),[kitB,setKitB]=useReviewState('visual-compare-kit-b',keys[1]??'');
 const A=mode==='session'?records.filter(s=>s.id===aId):mode==='period'?records.filter(s=>s.date>=fromA&&s.date<=toA):records.filter(s=>equipmentKey(s.conditions.equipment)===kitA);
 const B=mode==='session'?records.filter(s=>s.id===bId):mode==='period'?records.filter(s=>s.date>=fromB&&s.date<=toB):records.filter(s=>equipmentKey(s.conditions.equipment)===kitB);
 const invalid=mode==='period'&&(!fromA||!toA||!fromB||!toB||fromA>toA||fromB>toB||!(toA<fromB||toB<fromA));
 const result=visualComparison(A,B,mode==='equipment'),labels:Record<string,string>={average:'均环',n:'箭量',total:'总分',x:'X率',ten:'普通10率',miss:'M率',yellow:'9+10+X率'},rate=['x','ten','miss','yellow'].includes(metric);
 const values=[result.a,result.b].map(s=>s[metric as keyof typeof s] as number|null),maximum=rate?1:metric==='average'?10:Math.max(1,...values.map(n=>n??0));
 return <div className="vx-page" data-page="compare">{showHeader&&<Back title="训练对比" onBack={onBack} label={backLabel}/>}<div className="vx-segment">{[['session','两场'],['period','时间段'],['equipment','器材']].map(([k,label])=><button key={k} aria-pressed={mode===k} onClick={()=>setMode(k)}>{label}</button>)}</div>{!records.length?<Empty open={open}/>:<><div className="vx-pair-inputs">{[0,1].map(index=><label key={index}>{index?'B':'A'}{mode==='session'?<ChoiceSelect appearance="aurora" aria-label={`${index?'B':'A'}场次`} value={index?bId:aId} onChange={e=>(index?setB:setA)(e.target.value)}><option value="">请选择</option>{records.map(s=><option key={s.id} value={s.id} data-description={`${sessionTimeLabel(s)} · ${s.conditions.distance}米`}>{s.name}</option>)}</ChoiceSelect>:mode==='equipment'?<ChoiceSelect appearance="aurora" aria-label={`${index?'B':'A'}器材`} value={index?kitB:kitA} onChange={e=>(index?setKitB:setKitA)(e.target.value)}><option value="">请选择套组</option>{keys.map(k=><option value={k} key={k}>{records.find(s=>equipmentKey(s.conditions.equipment)===k)?.conditions.equipment?.name}</option>)}</ChoiceSelect>:<><input aria-label={`${index?'B':'A'}开始日期`} type="date" value={index?fromB:fromA} onChange={e=>(index?setFromB:setFromA)(e.target.value)}/><input aria-label={`${index?'B':'A'}结束日期`} type="date" value={index?toB:toA} onChange={e=>(index?setToB:setToA)(e.target.value)}/></>}</label>)}</div>
 <Card title="成绩对照" extra={<label><span className="sr-only">比较指标</span><ChoiceSelect appearance="aurora" aria-label="比较指标" value={metric} onChange={e=>setMetric(e.target.value)}>{Object.entries(labels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</ChoiceSelect></label>}>
 <p className={`vx-state ${result.reason||invalid?'vx-low':''}`} role="status">{invalid?'日期倒置或重叠 · 差值不可用':result.reason??(mode==='equipment'?'其他条件相同 · 器材快照不同':'完整同条件')} · 记录差异不说明原因</p>
 {invalid?<p>请调整两段不重叠日期。</p>:<><div className="vx-big-pair">{values.map((v,index)=><div key={index}><span>{index?'B':'A'} · {index?B.length:A.length}场</span><strong>{v===null?'—':rate?`${(v*100).toFixed(1)}%`:decimal(v,metric==='n'||metric==='total'?0:2)}</strong><div className={`vx-track ${index?'vx-track-b':''}`}><i style={{width:`${(v??0)/maximum*100}%`}}/></div><small>{[result.a,result.b][index].total}分 / {[result.a,result.b][index].n}箭</small></div>)}</div><div className="vx-comparison-delta"><span>B − A · 均环差</span><b>{result.delta===null?'—':signed(result.delta)+'环'}</b></div>{result.a.n!==result.b.n&&<p className="vx-state">两侧箭量不同 · 不按总分判断优劣</p>}</>}
 <Method label="全部指标与来源"><table><thead><tr><th>指标</th><th>A</th><th>B</th></tr></thead><tbody>{Object.entries(labels).map(([k,v])=><tr key={k}><th>{v}</th>{[result.a,result.b].map((s,j)=>{const n=s[k as keyof typeof s] as number|null;return <td key={j}>{n===null?'—':['x','ten','miss','yellow'].includes(k)?`${(n*100).toFixed(1)}%`:decimal(n,k==='n'||k==='total'?0:2)}</td>;})}</tr>)}</tbody></table>{[A,B].map((rs,index)=><div key={index}><b>{index?'B':'A'} 来源</b>{rs.map(s=><Button key={s.id} onClick={()=>open('insights',s.id)}>{s.date} · {s.conditions.distance}m · {allArrows(s).length}箭</Button>)}</div>)}<p>各侧分母为该侧全部实际箭数，含M；条件缺失、规则版本、器材或组结构不同均不出同条件差值。时间段/器材含混合条件时仍显示原始汇总，差值停用。</p></Method></Card>
 {!invalid&&<Card title="环值比例"><Chart option={{tooltip:{trigger:'axis',confine:true,renderMode:'richText'},legend:{data:['A','B'],top:0,bottom:'auto'},grid:{left:36,right:10,top:38,bottom:30},xAxis:{type:'category',data:['X','10','9','8','7','6','5','4','3','2','1','M'],axisLabel:{interval:0,fontSize:10}},yAxis:{type:'value',name:'%',max:100},series:[result.a,result.b].map((s,j)=>({name:j?'B':'A',type:'bar',barMaxWidth:12,itemStyle:{color:j?'#a76624':'#356ac1'},data:['X','10','9','8','7','6','5','4','3','2','1','M'].map(c=>s.n?s.distribution[c]/s.n*100:null)}))}} label="A与B各环比例，分母各自含M" height={190}/><Method label="环值数值"><table><thead><tr><th>环</th><th>A 箭/分母</th><th>B 箭/分母</th></tr></thead><tbody>{['X','10','9','8','7','6','5','4','3','2','1','M'].map(c=><tr key={c}><th>{c}</th><td>{result.a.distribution[c]}/{result.a.n}</td><td>{result.b.distribution[c]}/{result.b.n}</td></tr>)}</tbody></table></Method></Card>}
 <Card title="落点与原始记录"><p className="vx-state">空间图按各场靶面和来源分开；照片参考不作可信统计。</p>{[...A,...B].map(s=><Button key={s.id} onClick={()=>open('insights',s.id)}>{s.date} · 查看本场落点 ›</Button>)}</Card></>}</div>;
}
