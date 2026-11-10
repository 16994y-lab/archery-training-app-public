import { allArrows, Arrow, Data, Equipment, Goal, sessionPlannedArrows, plannedArrows, scoreValue, unexecutedGroups, Session } from './domain';
import { concentration, densityGroups } from '../features/model-alignment/spread-analysis';
import { scatterEllipse } from '../review';
import { scatterOutline } from '../features/model-alignment/scatter-outline';
export function statistics(arrows:Arrow[]) {
  const n=arrows.length,total=arrows.reduce((t,a)=>t+scoreValue(a.code),0),distribution=Object.fromEntries(['X','10','9','8','7','6','5','4','3','2','1','M'].map(c=>[c,arrows.filter(a=>a.code===c).length]));
  // Reference photo mappings may be drawn, but only a target tap or a manually
  // confirmed photo position can support concentration and scatter claims.
  const located=arrows.filter(a=>a.x!==null&&a.y!==null&&(a.source==='target'||a.source==='photo'&&a.coordinateEvidence==='manual-target-confirmed')),
    points=located.map(a=>({x:a.x!,y:a.y!})),inside=located.filter(a=>a.code!=='M').map(a=>({x:a.x!,y:a.y!}));
  const circle=concentration(inside),ellipse=scatterEllipse(inside),hull=scatterOutline(points);
  // Group only bounded samples to keep large histories responsive; never hide omissions.
  const groups=inside.length<=1500?densityGroups(inside):null;
  const rate=(c:number)=>n?c/n:null;
  const limits=points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minY:Math.min(b.minY,p.y),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
  const extents=points.length?{width:limits.maxX-limits.minX,height:limits.maxY-limits.minY}:null;
  return {n,total,average:n?total/n:null,distribution,located:located.length,coverage:rate(located.length),yellow:rate(arrows.filter(a=>scoreValue(a.code)>=9).length),x:rate(distribution.X),ten:rate(distribution['10']),miss:rate(distribution.M),points,inside,circle,ellipse,hull,groups,extents};
}
export function equipmentKey(e:Equipment|null){return e?JSON.stringify([e.bow,e.riser,e.limbs,e.arrows,e.sight,e.stabilizer,e.string,e.tab,e.other]):'unknown';}
export function conditionKey(s:Session,includeEquipment=true) {const c=s.conditions;return JSON.stringify([c.distance,c.bow,c.size,c.target.ring_rules,c.target.layout,c.target.sizeRatio,includeEquipment?equipmentKey(c.equipment):null]);}
export function comparable(s:Session) {return s.conditions.size!==null&&s.conditions.bow!=='';}
export function dateBucket(date:string,grain:'day'|'week'|'month') {if(grain==='day')return date;if(grain==='month')return date.slice(0,7);const d=new Date(date+'T12:00:00');const offset=(d.getDay()+6)%7;d.setDate(d.getDate()-offset);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
export function trend(sessions:Session[],grain:'day'|'week'|'month'|'session') {const buckets=new Map<string,Session[]>();for(const s of sessions){const key=grain==='session'?s.started:dateBucket(s.date,grain);buckets.set(key,[...(buckets.get(key)??[]),s]);}return [...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([date,items])=>({date,stats:statistics(items.flatMap(allArrows)),sessions:items.length,fatigue:averagePresent(items.map(s=>s.fatigue)),energy:averagePresent(items.map(s=>s.energy)),fatigueN:items.filter(s=>s.fatigue!==null).length,energyN:items.filter(s=>s.energy!==null).length,conditions:new Set(items.map(s=>conditionKey(s))).size}));}
export function averagePresent(values:(number|null)[]){const present=values.filter((v):v is number=>v!==null);return present.length?present.reduce((a,b)=>a+b,0)/present.length:null;}
export function goalProgress(d:Data,g:Goal){const sessions=d.sessions.filter(s=>s.status==='completed'&&s.date>=g.start&&s.date<=g.end&&(g.distance===null||s.conditions.distance===g.distance)&&(!g.targetId||s.conditions.target.id===g.targetId));const stat=statistics(sessions.flatMap(allArrows));return {value:g.type==='arrows'?stat.n:g.type==='sessions'?sessions.length:stat.average,count:stat.n,sessions:sessions.length,mixed:new Set(sessions.map(s=>conditionKey(s))).size>1};}
export function splitSegments<T>(items:T[]) {return [items.slice(0,Math.ceil(items.length/2)),items.slice(Math.ceil(items.length/2))];}
export const percent=(v:number|null)=>v===null?'—':`${(v*100).toFixed(1)}%`;
export const decimal=(v:number|null|undefined,digits=2)=>v==null?'—':v.toFixed(digits);
export function report(s:Session,sections:string[]) {
  const st=statistics(allArrows(s)); const lines=[`弓行记 Gongxingji · 训练报告`,`${s.date} ${s.name}`,`${s.conditions.bow||'弓种未知'} · ${s.conditions.distance}m · ${s.conditions.target.name} · 尺寸 ${s.conditions.size??'未知'} cm`,`本机训练记录；同步状态以账号页为准。`];
  if(sections.includes('summary'))lines.push(`实际 ${st.n} 箭 / 计划 ${sessionPlannedArrows(s)??'不限'} 箭；原编排未执行 ${unexecutedGroups(s)??0} 组；总分 ${st.total}；加权平均 ${decimal(st.average)}`,`9+10+X比例（标准靶黄心）${percent(st.yellow)}；X ${percent(st.x)}；普通10 ${percent(st.ten)}；M ${percent(st.miss)}。分母均为全部 ${st.n} 箭，含M。`,`可信坐标覆盖 ${st.located}/${st.n}（${percent(st.coverage)}）；照片参考映射另行标记，数字录入不猜坐标。`);
  if(sections.includes('ends'))s.ends.filter(e=>e.arrows.length).forEach((e,i)=>lines.push(`第${i+1}组 ${e.half}：${e.arrows.map(a=>`${a.code}${s.conditions.target.face_count>1?`(靶${a.face})`:''}`).join(' / ')}；${e.arrows.length}箭，${statistics(e.arrows).total}分`));
  if(sections.includes('spatial'))lines.push(`靶内坐标样本 ${st.inside.length}；水平偏移 ${decimal(st.circle?.x)}，垂直偏移 ${decimal(st.circle?.y)}（单位：计分半径；右、上为正）`,`${(st.groups?.groups.length??0)>1?'多个候选中心，分别观察，不采用统一80%集中圈':`80%集中圈半径 ${decimal(st.circle?.radius)}，圈内 ${st.circle?.included??0}/${st.circle?.count??0} 靶内点`}；${st.groups?`${st.groups.groups.length} 个候选分群、${st.groups.unassigned.length} 个未分群点`:'超过1500点，候选分群未计算'}。多中心须分别观察。`,`全坐标散布宽/高 ${decimal(st.extents?.width)} / ${decimal(st.extents?.height)} 个计分半径（含有坐标M）。`,s.conditions.size&&st.extents?`物理散布宽/高 ${decimal(st.extents.width*s.conditions.size*s.conditions.target.sizeRatio/2)} / ${decimal(st.extents.height*s.conditions.size*s.conditions.target.sizeRatio/2)} cm`:'尺寸未知，未生成厘米分析。');
  if(sections.includes('notes'))lines.push(`心得：${s.note||'未填写'}；主观体能 ${s.energy??'未填'}/10；疲劳 ${s.fatigue??'未填'}/10。`);
  lines.push('以上仅描述记录，不从成绩或录入时间诊断动作、疲劳或器材原因；录入顺序不是射箭顺序。');return lines.join('\n\n');
}
