import {ChoiceSelect} from './ChoiceSelect';
import {sessionTimeLabel} from './session-label';
import React, { useState } from 'react';
import { allArrows, Arrow, Conditions, Session } from './domain';
import { statistics, conditionKey, decimal, percent, splitSegments } from './statistics';
import { concentration } from '../features/model-alignment/spread-analysis';
import { Button, Field, NumberInput, Panel, TargetFace, useApp } from './ui';

import { Chart, ChartOption } from './Chart';
import { useReviewState } from './review-state';

export type ComparisonSample={label:string;arrows:Arrow[];conditions:Conditions|null;sessions:number;sourceSessions?:Session[]};
export function comparisonSample(label:string,sessions:Session[]):ComparisonSample {
 const keys=new Set(sessions.map(s=>conditionKey(s,false)));
 return {label,arrows:sessions.flatMap(allArrows),sessions:sessions.length,sourceSessions:sessions,conditions:keys.size===1?sessions[0].conditions:null};
}
const COLORS=['#082572','#a34513'];
type Metric='average'|'n'|'total'|'yellow'|'x'|'ten'|'miss';
const labels:Record<Metric,string>={average:'加权平均环',n:'实际箭量',total:'总分',yellow:'9+10+X率',x:'X率',ten:'普通10率',miss:'M率'};
const ratio=(metric:Metric)=>['yellow','x','ten','miss'].includes(metric);
function ComparisonLayer({arrows,index,label}:{arrows:Arrow[];index:number;label:string}) {
 const s=statistics(arrows),color=COLORS[index];
 const groups=s.groups===null?[]:s.groups.groups.length>1?s.groups.groups:[s.inside];
 return <g pointerEvents="none" data-comparison={label}>
  {groups.map((g,i)=>{const c=concentration(g);return g.length>=3&&c&&<g key={i}><circle cx={c.x} cy={-c.y} r={c.radius} fill="none" stroke={color} strokeWidth=".02" strokeDasharray={index?'.045 .02':undefined}/><text x={c.x+.03} y={-c.y-.04} fill={color} fontSize=".08" stroke="white" strokeWidth=".01" paintOrder="stroke">{label}{groups.length>1?i+1:''}</text></g>;})}
  {arrows.filter(a=>a.x!==null&&a.y!==null).map(a=><circle key={a.id} cx={a.x!} cy={-a.y!} r=".027" fill="#172c59" stroke="#fff" strokeWidth=".009"/>)}
 </g>;
}

export function ComparisonGraphs({a,b}:{a:ComparisonSample;b:ComparisonSample}) {
 const {open}=useApp();
 const stateKey='graph:'+a.label+':'+b.label;
 const [metric,setMetric]=useReviewState<Metric>(stateKey+':metric','average'),[overlay,setOverlay]=useReviewState(stateKey+':overlay',false),[face,setFace]=useReviewState(stateKey+':face',0);
 const samples=[a,b],stats=samples.map(s=>statistics(s.arrows));
 const sameGeometry=Boolean(a.conditions&&b.conditions&&conditionKey({conditions:a.conditions} as Session,false)===conditionKey({conditions:b.conditions} as Session,false));
 const codes=['X','10','9','8','7','6','5','4','3','2','1','M'];
 const scoreOption:ChartOption={tooltip:{trigger:'axis',confine:true,renderMode:'richText'},grid:{left:38,right:55,top:20,bottom:35},xAxis:{type:'value',min:0,max:ratio(metric)?100:undefined,axisLabel:{formatter:ratio(metric)?'{value}%':'{value}'}},yAxis:{type:'category',inverse:true,data:['A','B']},series:[{name:labels[metric],type:'bar',barMaxWidth:34,label:{show:true,position:'right',formatter:p=>p.value==null?'—':String(p.value)+(ratio(metric)?'%':'')},data:stats.map((s,i)=>({value:s[metric]===null?null:ratio(metric)?Number((s[metric]!*100).toFixed(2)):Number(s[metric]!.toFixed(2)),itemStyle:{color:COLORS[i]}}))}]};
 const distributionOption:ChartOption={tooltip:{trigger:'axis',confine:true,renderMode:'richText'},legend:{data:['A','B'],top:0,left:'center'},grid:{left:46,right:12,top:38,bottom:35},xAxis:{type:'category',data:codes},yAxis:{type:'value',name:'%',min:0},series:stats.map((st,i)=>({name:i?'B':'A',type:'bar',barMaxWidth:14,data:codes.map(code=>st.n?Number((st.distribution[code]/st.n*100).toFixed(2)):null),itemStyle:{color:COLORS[i]}}))};
 const display=(n:number|null)=>ratio(metric)?percent(n):decimal(n,metric==='n'||metric==='total'?0:2);
 const plotArrows=(sample:ComparisonSample)=>sample.conditions?.target.face_count===1?sample.arrows:face?sample.arrows.filter(p=>p.face===face):sample.arrows;
 return <div className="comparison-graphs">
  <div className="comparison-legend">{samples.map((s,i)=><p key={i}><i style={{background:COLORS[i]}}/><b>{i?'B':'A'} · {s.label}</b><span>{s.sessions}场 / {stats[i].n}箭 · 坐标 {stats[i].located}/{stats[i].n}（{percent(stats[i].coverage)}）</span></p>)}</div>
  <Field label="比较指标"><ChoiceSelect value={metric} onChange={e=>setMetric(e.target.value as Metric)}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</ChoiceSelect></Field>
  <Chart option={scoreOption} label={`${labels[metric]}A与B比较图`} height={180}/>
  <p className="caption">{labels[metric]}：{stats.map((s,i)=>`${i?'B':'A'} ${display(s[metric])}`).join('；')}。平均与比例按各自全部实际箭数计算（含M）；箭量不同不根据总分断言优劣。</p>
  <h3>环值比例对照</h3><Chart option={distributionOption} label="A与B各环值比例比较图" height={260}/><details className="review-data-details"><summary>查看全部分值、箭数与比例</summary><div className="table-scroll"><table><thead><tr><th>分值</th><th>A 箭数 / 比例</th><th>B 箭数 / 比例</th></tr></thead><tbody>{codes.map(code=><tr key={code}><th>{code}</th>{stats.map((st,i)=><td key={i}>{st.distribution[code]}/{st.n} · {percent(st.n?st.distribution[code]/st.n:null)}</td>)}</tr>)}</tbody></table></div></details>
  <h3>实际落点对照</h3>
  {samples.some(s=>s.conditions&&(s.conditions.size===null||!s.conditions.bow))&&<p className="notice">部分尺寸或弓种未填写，仅按已知靶规则和相对坐标展示；未知条件不视为已确认相同。</p>}
  {a.conditions&&b.conditions&&a.conditions.target.face_count!==b.conditions.target.face_count&&<p className="caption">单靶侧始终显示自身1号靶全部落点；靶位选择只过滤三联侧。</p>}
  {!a.conditions||!b.conditions?<p className="notice">至少一侧没有记录或含多种靶面/距离/尺寸/弓种，请缩小比较条件后查看落点图。不会将不同规则的坐标画在同一张靶上。</p>:<>
   {!sameGeometry&&<p className="notice">两侧训练条件不同，分别展示各自靶面；不进行共同尺度叠加，不据此断言进步或退步。</p>}
   {Math.max(a.conditions.target.face_count,b.conditions.target.face_count)>1&&<Field label="比较靶位"><ChoiceSelect value={face} onChange={e=>setFace(Number(e.target.value))}><option value={0}>靶心对齐叠加 · 非原三联布局</option>{[1,2,3].map(n=><option key={n} value={n}>{n}号靶位</option>)}</ChoiceSelect></Field>}
   {sameGeometry&&<label className="check"><input type="checkbox" checked={overlay} onChange={e=>setOverlay(e.target.checked)}/>将A与B靶心对齐叠加</label>}
   {overlay&&sameGeometry?<TargetFace target={a.conditions.target} overlay={<>{samples.map((sample,i)=><ComparisonLayer key={i} arrows={plotArrows(sample)} index={i} label={i?'B':'A'}/>)}</>}/>:<div className="comparison-plots">{samples.map((sample,i)=><div key={i}><h3 style={{color:COLORS[i]}}>{i?'B':'A'} · {sample.label}</h3><TargetFace target={sample.conditions!.target} overlay={<ComparisonLayer arrows={plotArrows(sample)} index={i} label={i?'B':'A'}/>}/></div>)}</div>}
   {samples.map((sample,i)=>{const st=statistics(plotArrows(sample)),c=sample.conditions!;const factor=c.size===null?null:c.size*c.target.sizeRatio/2;return <p className="caption" key={i}>{i?'B':'A'}：当前靶位范围 {st.n}箭，坐标 {st.located}/{st.n}，靶内 {st.inside.length}点；水平/垂直 {decimal(st.circle?.x)} / {decimal(st.circle?.y)}，RMS {decimal(st.circle?.rms)} 个计分半径。{factor===null?'尺寸未知，无厘米分析。':`计分直径 ${decimal(factor*2)}cm，全坐标宽/高 ${decimal(st.extents?st.extents.width*factor:null)} / ${decimal(st.extents?st.extents.height*factor:null)}cm。`}</p>;})}
  </>}
  {samples.some(sample=>sample.sourceSessions)&&<div className="review-comparison-sources"><h3>比较对象的来源记录</h3>{samples.map((sample,i)=><details key={i}><summary>{i?'B':'A'} · {sample.label} · {sample.sourceSessions?.length??0}场</summary>{sample.sourceSessions?.length?sample.sourceSessions.map(session=><button key={session.id} className="history-row" onClick={()=>open('detail',session.id)}><span><b>{session.name}</b><small>{session.date} · {session.conditions.distance}m</small></span><span>{allArrows(session).length}箭 ›</span></button>):<p>该范围没有已完成记录。</p>}</details>)}</div>}
  <p className="caption">A、B落点统一用圆点展示；环是80%经验集中圈，多个候选中心分别绘圈。M坐标显示但不进入圈，数字成绩不造坐标。聚类超过1500靶内点暂停分群；小样本不足3点不画圈。三联按所选靶位或明确的靶心对齐方式展示。</p>
 </div>;
}

export function HistoryComparison({sessions}:{sessions:Session[]}) {
 const sorted=[...sessions].sort((a,b)=>a.started.localeCompare(b.started));
 const [mode,setMode]=useReviewState('comparison-mode','session'),[aId,setAId]=useReviewState('comparison-a-id',sorted[sorted.length-2]?.id??sorted[0]?.id??''),[bId,setBId]=useReviewState('comparison-b-id',sorted[sorted.length-1]?.id??'');
 const [aFrom,setAFrom]=useReviewState('comparison-a-from',sorted[0]?.date??''),[aTo,setATo]=useReviewState('comparison-a-to',sorted[0]?.date??''),[bFrom,setBFrom]=useReviewState('comparison-b-from',sorted[sorted.length-1]?.date??''),[bTo,setBTo]=useReviewState('comparison-b-to',sorted[sorted.length-1]?.date??''),[condition,setCondition]=useReviewState('comparison-condition','all');
 const conditions=[...new Map(sessions.map(s=>[conditionKey(s,false),s])).entries()];
 const eligible=condition==='all'?sessions:sessions.filter(s=>conditionKey(s,false)===condition);
 const a=mode==='session'?sessions.filter(s=>s.id===aId):eligible.filter(s=>s.date>=aFrom&&s.date<=aTo);
 const b=mode==='session'?sessions.filter(s=>s.id===bId):eligible.filter(s=>s.date>=bFrom&&s.date<=bTo);
 const invalid=mode==='session'?aId===bId||!a.length||!b.length:!aFrom||!aTo||!bFrom||!bTo||aFrom>aTo||bFrom>bTo||!(aTo<bFrom||bTo<aFrom);
 return <Panel title="两场 / 两个时间段比较"><p className="caption">比较对象独立选择，不随上方历史浏览筛选改变。两侧须为不同场次或不重叠日期。</p>
  <Field label="比较对象"><ChoiceSelect value={mode} onChange={e=>setMode(e.target.value)}><option value="session">两次训练</option><option value="period">两个时间段</option></ChoiceSelect></Field>
  {mode==='session'?<div className="form-row">{[[aId,setAId],[bId,setBId]].map(([id,setter],i)=><Field key={i} label={`${i?'B':'A'}场次`}><ChoiceSelect value={id as string} onChange={e=>(setter as (s:string)=>void)(e.target.value)}><option value="">请选择</option>{sorted.map(s=><option key={s.id} value={s.id} data-description={`${sessionTimeLabel(s)} · ${s.conditions.distance}米`}>{s.name}</option>)}</ChoiceSelect></Field>)}</div>:<>
   <Field label="比较训练条件"><ChoiceSelect value={condition} onChange={e=>setCondition(e.target.value)}><option value="all">所有条件（混合时只比较成绩图）</option>{conditions.map(([key,s])=><option key={key} value={key}>{s.conditions.distance}m · {s.conditions.target.name} · {s.conditions.size??'未知'}cm · {s.conditions.bow||'弓种未知'}</option>)}</ChoiceSelect></Field>
   {[[aFrom,setAFrom,aTo,setATo],[bFrom,setBFrom,bTo,setBTo]].map(([from,setFrom,to,setTo],i)=><div className="form-row" key={i}><Field label={`${i?'B':'A'}开始日期`}><input type="date" value={from as string} onChange={e=>(setFrom as (s:string)=>void)(e.target.value)}/></Field><Field label={`${i?'B':'A'}结束日期`}><input type="date" value={to as string} onChange={e=>(setTo as (s:string)=>void)(e.target.value)}/></Field></div>)}
  </>}
  {invalid?<p className="notice">请选择两个不同场次，或完整且不重叠的日期范围；不会重复计算同一批箭。</p>:<ComparisonGraphs a={comparisonSample(mode==='session'?a[0]?.name??'空场次':`${aFrom} 至 ${aTo}`,a)} b={comparisonSample(mode==='session'?b[0]?.name??'空场次':`${bFrom} 至 ${bTo}`,b)}/>}
 </Panel>;
}

export function GroupComparison({session:s}:{session:Session}) {
 const {open}=useApp();
 const hasHalves=s.ends.some(e=>e.arrows.length&&e.half==='上半场')&&s.ends.some(e=>e.arrows.length&&e.half==='下半场');
 const [selectedMode,setMode]=useReviewState(s.id+':group-mode',hasHalves?'half':'range');const mode=selectedMode==='half'&&!hasHalves?'range':selectedMode;const [aFrom,setAFrom]=useReviewState(s.id+':a-from',1),[aTo,setATo]=useReviewState(s.id+':a-to',Math.max(1,Math.floor(s.ends.length/2))),[bFrom,setBFrom]=useReviewState(s.id+':b-from',Math.max(2,Math.floor(s.ends.length/2)+1)),[bTo,setBTo]=useReviewState(s.id+':b-to',s.ends.length);
 const actual=s.ends.map((end,index)=>({end,number:index+1})).filter(e=>e.end.arrows.length);
 const parts=mode==='half'?['上半场','下半场'].map(h=>actual.filter(e=>e.end.half===h)):mode==='range'?[actual.filter(e=>e.number>=aFrom&&e.number<=aTo),actual.filter(e=>e.number>=bFrom&&e.number<=bTo)]:splitSegments(actual);
 const invalid=mode==='range'&&(![aFrom,aTo,bFrom,bTo].every(n=>Number.isInteger(n)&&n>=1&&n<=s.ends.length)||aFrom>aTo||bFrom>bTo||!(aTo<bFrom||bTo<aFrom));
 const names=mode==='half'?['上半场','下半场']:mode==='range'?[`第${aFrom}–${aTo}组`,`第${bFrom}–${bTo}组`]:['数学前段（非半场）','数学后段（非半场）'];
 return <Panel title="组别与半场图形比较"><p className="caption">此处独立选择本场比较对象；组号使用原实际编号，与上方单范围查看互不改写。</p>
  <Field label="组别比较方式"><ChoiceSelect value={mode} onChange={e=>setMode(e.target.value)}><option value="range">自选两个组范围</option>{hasHalves&&<option value="half">明确上 / 下半场</option>}<option value="split">数学前后段（非比赛半场）</option></ChoiceSelect></Field>
  {mode==='range'&&<>{[[aFrom,setAFrom,aTo,setATo],[bFrom,setBFrom,bTo,setBTo]].map(([from,setFrom,to,setTo],i)=><div className="form-row" key={i}><Field label={`${i?'B':'A'}从第几组`}><NumberInput min="1" max={s.ends.length} value={from as number} onValue={setFrom as (n:number)=>void}/></Field><Field label={`${i?'B':'A'}到第几组`}><NumberInput min="1" max={s.ends.length} value={to as number} onValue={setTo as (n:number)=>void}/></Field></div>)}</>}
  {invalid?<p className="notice">请填写有效且不重叠的两个组范围。</p>:<ComparisonGraphs a={{label:names[0],arrows:parts[0].flatMap(e=>e.end.arrows),conditions:s.conditions,sessions:parts[0].length?1:0}} b={{label:names[1],arrows:parts[1].flatMap(e=>e.end.arrows),conditions:s.conditions,sessions:parts[1].length?1:0}}/>}
  <h3>实际逐组均环</h3><Chart option={{tooltip:{trigger:'axis',confine:true,renderMode:'richText'},grid:{left:38,right:15,top:25,bottom:45},xAxis:{type:'category',data:actual.map(e=>`第${e.number}组`),axisLabel:{hideOverlap:true}},yAxis:{type:'value',min:0,max:10,name:'环'},series:[{type:'bar',name:'均环',data:actual.map(e=>statistics(e.end.arrows).average)}]}} label="实际组号加权平均环图，轻点可查看本组" height={230} onSelect={index=>{if(actual[index])open('group',`${s.id}:${actual[index].number-1}`);}}/><div className="review-distribution-values">{actual.map(({end,number})=><button key={end.id} className="review-source-link" onClick={()=>open('group',`${s.id}:${number-1}`)}>第{number}组 · {decimal(statistics(end.arrows).average)}环 / {end.arrows.length}箭</button>)}</div>
  <p className="caption">纵轴0–10环；点选图柱或组名进入实际记录。数学奇数组前段ceil(n/2)、后段floor(n/2)，不重叠。未标半场不猜标签，空组不补M。</p>
 </Panel>;
}
