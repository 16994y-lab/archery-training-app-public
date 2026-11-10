// Shared review entry points; navigation stays owned by the root router.
import React from 'react';
import { Back, useApp } from './ui';
import { SessionDetail } from './History';
import { ReviewHomeVisual, SessionVisual, CompareVisual } from './ReviewVisual';
import { HistoryComparison } from './Comparison';
import { EquipmentComparison } from './Analysis';
export function ReviewHomeCandidate(){const {data,open}=useApp();return <ReviewHomeVisual sessions={data.sessions} open={open}/>;}
export function AnalysisCandidate({sessionId,onBack,backLabel}:{sessionId?:string;onBack:()=>void;backLabel?:string}){const {data,open}=useApp();const id=sessionId??[...data.sessions].filter(session=>session.status==='completed').sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id))[0]?.id;return id?<SessionDetail key={id} id={id} initialTab="analysis" onBack={onBack} backLabel={backLabel}/>:<SessionVisual sessions={data.sessions} open={open} onBack={onBack} backLabel={backLabel}/>;}
export function CompareCandidate({onBack,backLabel}:{onBack:()=>void;backLabel?:string}){
 const {data,open}=useApp(),records=data.sessions.filter(s=>s.status==='completed');
 const jump=(id:string)=>{const section=document.getElementById(id);section?.scrollIntoView({block:'start'});section?.querySelector<HTMLElement>('h2')?.focus({preventScroll:true});};
 return <div className="vx-comparison-page vx-comparison-flow"><Back title="训练对比" onBack={onBack} label={backLabel??'返回复盘'}/><nav className="vx-comparison-nav" aria-label="定位对比图表">{[['compare-scores','成绩对照'],['compare-spatial','空间叠图'],['compare-equipment','器材分析']].map(([id,label])=><button type="button" key={id} onClick={()=>jump(id)}>{label}</button>)}</nav>
  <section id="compare-scores" aria-label="成绩对照"><h2 className="sr-only" tabIndex={-1}>成绩对照</h2><CompareVisual sessions={data.sessions} open={open} onBack={onBack} backLabel={backLabel} showHeader={false}/></section>
  <section id="compare-spatial" className="vx-comparison-more" aria-label="空间叠图"><h2 tabIndex={-1}>空间叠图</h2><HistoryComparison sessions={records}/></section>
  <section id="compare-equipment" className="vx-comparison-more" aria-label="器材分析"><h2 tabIndex={-1}>器材分析</h2><EquipmentComparison sessions={records}/></section>
 </div>;
}
