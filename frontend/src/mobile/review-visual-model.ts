import { allArrows, Session } from './domain';
import { sessionInsight, strictComparisonKey } from './analysis-insights';
import { statistics } from './statistics';

export type VisualFilter = { days: string; distance: string; query: string; from: string; to: string };
export const emptyVisualFilter: VisualFilter = {days:'30',distance:'',query:'',from:'',to:''};
export function visualRecords(sessions:Session[],f:VisualFilter,today:string) {
  const date=new Date(today+'T12:00:00');date.setDate(date.getDate()-Number(f.days||1)+1);
  const start=f.days==='all'?'':`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  if(f.from&&f.to&&f.from>f.to)return [];
  const query=f.query.trim().toLocaleLowerCase();
  return sessions.filter(s=>s.status==='completed'&&s.date<=today&&(!start||s.date>=start)&&(!f.from||s.date>=f.from)&&(!f.to||s.date<=f.to)&&(!f.distance||s.conditions.distance===Number(f.distance))&&(!query||[s.name,s.note,s.conditions.target.name,s.conditions.bow,s.conditions.equipment?.name??''].join(' ').toLocaleLowerCase().includes(query))).sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id));
}
export function activity(sessions:Session[],today:string,days=14) {
  return Array.from({length:days},(_,i)=>{const d=new Date(today+'T12:00:00');d.setDate(d.getDate()-days+1+i);const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;const records=sessions.filter(s=>s.date===date);return {date,arrows:records.flatMap(allArrows).length,sessions:records.length};});
}
export function groupRange(s:Session){const rows=sessionInsight(s,[]).ends;const values=rows.map(r=>r.average).filter((n):n is number=>n!==null);return {min:values.length>=2?Math.min(...values):null,max:values.length>=2?Math.max(...values):null,groups:values.length};}
export function comparisonEligibility(a:Session[],b:Session[],equipment=false) {
  if(!a.length||!b.length)return '一侧没有完成记录';
  if(a.some(s=>b.some(t=>s.id===t.id)))return '两侧记录重叠';
  const keys=[...a,...b].map(strictComparisonKey);
  if(keys.some(k=>k===null))return '条件未完整，差值不可用';
  // Equipment mode checks every other saved field and structure, allowing only the selected equipment to differ.
  const normalize=(key:string)=>{const fields=JSON.parse(key);if(equipment)fields[11]=null;return JSON.stringify(fields);};
  if(new Set(keys.map(k=>normalize(k!))).size!==1)return '条件或实际组结构不同';
  return null;
}
export function visualComparison(a:Session[],b:Session[],equipment=false){const reason=comparisonEligibility(a,b,equipment),A=statistics(a.flatMap(allArrows)),B=statistics(b.flatMap(allArrows));return {a:A,b:B,reason,delta:!reason&&A.average!==null&&B.average!==null?B.average-A.average:null};}
