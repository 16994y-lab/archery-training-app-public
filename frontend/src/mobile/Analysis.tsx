import {ChoiceSelect} from './ChoiceSelect';
import React, { useMemo, useState } from 'react';
import { allArrows, Arrow, scoreAt, Session, Target } from './domain';
import { statistics, percent, decimal, trend, conditionKey, equipmentKey, comparable } from './statistics';
import { Panel, TargetFace, Field } from './ui';
import { SpreadOverlay, SpreadExplanation } from './SpreadOverlay';
import { ComparisonGraphs, comparisonSample } from './Comparison';
import { Chart, ChartOption } from './Chart';
import { scoreExtremes } from './review-data';
import { useReviewState } from './review-state';
export function Metrics({arrows}:{arrows:Arrow[]}) {const s=useMemo(()=>statistics(arrows),[arrows]),extra=scoreExtremes(arrows);return <><div className="metrics"><div><b>{s.n}</b><span>实际箭量</span></div><div><b>{s.total}</b><span>总分</span></div><div><b>{decimal(s.average)}</b><span>加权平均环</span></div></div><div className="rates"><span>9+10+X {percent(s.yellow)}</span><span>X {percent(s.x)}</span><span>普通10 {percent(s.ten)}</span><span>M {percent(s.miss)}</span><span>命中率 {percent(extra.hit)}</span></div><p className="caption">平均环与各比例分母均为全部 {s.n} 箭（含 M）；命中为非M箭。9+10+X为标准靶黄心率，自建靶按分值比例解释。可信坐标 {s.located}/{s.n}（{percent(s.coverage)}）；照片参考映射另行展示。</p></>;}
export function Distribution({arrows}:{arrows:Arrow[]}) {const s=useMemo(()=>statistics(arrows),[arrows]);const entries=['X','10','9','8','7','6','5','4','3','2','1','M'].map(c=>[c,s.distribution[c]] as const);const option:ChartOption={tooltip:{trigger:'axis',confine:true,renderMode:'richText'},grid:{left:38,right:12,top:30,bottom:35},xAxis:{type:'category',data:entries.map(([c])=>c)},yAxis:{type:'value',name:'箭',minInterval:1},series:[{name:'箭数',type:'bar',data:entries.map(([code,n])=>({value:n,itemStyle:{color:code==='X'?'#ea823d':code==='M'?'#8197ac':'#123d78'}})),barMaxWidth:24}]};return <Panel title="环值分布"><Chart option={option} label="实际环值箭数分布，X与普通10分开" height={230}/><details className="review-data-details"><summary>查看各环箭数和计算口径</summary><div className="review-distribution-values">{entries.map(([code,n])=><span key={code}><b>{code}</b> {n}箭 · {percent(s.n?n/s.n:null)}</span>)}</div><p className="caption">分母为全部 {s.n} 箭；X 与普通10分别统计，M也计入箭量。</p></details></Panel>;}
export function Spatial({arrows,target,size}:{arrows:Arrow[];target:Target;size:number|null}) {const [face,setFace]=useState(0),[circles,setCircles]=useState(true);const filtered=face?arrows.filter(a=>a.face===face):arrows;
  const plotted=filtered.filter(a=>a.source!=='number'&&a.x!==null&&a.y!==null&&Number.isFinite(a.x)&&Number.isFinite(a.y)&&Math.abs(a.x)<=1.2&&Math.abs(a.y)<=1.2&&scoreAt(target,a.x,a.y)===a.code);
  const trusted=plotted.filter(a=>a.source==='target'||a.coordinateEvidence==='manual-target-confirmed'),mapped=plotted.filter(a=>a.source==='photo'&&a.coordinateEvidence!=='manual-target-confirmed');
  const s=useMemo(()=>statistics(trusted),[trusted]);const factor=size===null?null:size*target.sizeRatio/2;const multiple=(s.groups?.groups.length??0)>1;
  return <Panel title="落点与散布">{target.face_count>1&&<Field label="空间分析靶位"><ChoiceSelect value={face} onChange={e=>setFace(Number(e.target.value))}><option value={0}>靶心对齐叠加（1–3号）</option>{[1,2,3].map(n=><option key={n} value={n}>{n}号靶位</option>)}</ChoiceSelect></Field>}
    <p><b>有位置 {plotted.length}/{filtered.length} 箭</b> · 点靶 {trusted.filter(a=>a.source==='target').length} · 照片人工确认 {trusted.filter(a=>a.source==='photo').length} · 照片参考映射 {mapped.length} · 数字 {filtered.filter(a=>a.source==='number').length} 无位置。</p>
    <label className="check"><input type="checkbox" checked={circles} onChange={e=>setCircles(e.target.checked)}/>显示可信点的集中圈与方向</label>
    <TargetFace zoomable target={target} arrows={plotted.map(a=>({...a,face:1}))} overlay={<SpreadOverlay stats={s} circles={circles} shape={circles}/>}/>
    <p className="caption">落点统一用圆点展示。照片参考坐标不参加集中圈计算；只有环值的记录无法补位置。</p>
    <details className="review-data-details"><summary>查看坐标与散布计算详情</summary><p>可信坐标 {trusted.length} 点，其中靶内 {s.inside.length} 点，靶外 M {trusted.length-s.inside.length} 点。{target.face_count>1?(face?`当前为 ${face} 号靶位。`:'各靶位靶心对齐叠加，不是原三联布局。'):''}</p>
    {s.circle?<><p>靶内中心：水平 {decimal(s.circle.x)}、垂直 {decimal(s.circle.y)}；右、上为正，单位为计分半径。{factor!==null&&` 换算：${decimal(s.circle.x*factor)} / ${decimal(s.circle.y*factor)} cm。`}</p><p>{multiple?'存在多个候选中心，已隐藏统一集中圈。':`80%集中圈半径 ${decimal(s.circle.radius)}，实际覆盖 ${s.circle.included}/${s.circle.count} 个可信靶内点${factor!==null?`（${decimal(s.circle.radius*factor)} cm）`:''}。`}</p><p>方向椭圆为可信靶内坐标的一倍样本标准差，方向 {decimal(s.ellipse?.rotationDegrees,1)}°；不表示置信区间或概率保证。</p></>:<p>可信靶内坐标不足，无法计算偏向、集中圈及方向形状。</p>}
    {s.extents&&s.located>=2&&<p>含坐标 M 的可信点散布：宽 {decimal(s.extents.width)}、高 {decimal(s.extents.height)} 个计分半径{factor!==null?`，约 ${decimal(s.extents.width*factor)} × ${decimal(s.extents.height*factor)} cm`:''}。虚线是可信点外轮廓。</p>}
    {factor===null&&<p className="notice">尺寸未知，只显示相对尺度，不计算厘米。</p>}
    <SpreadExplanation arrows={trusted}/></details>
  </Panel>;
}
export { Trends } from './Trends';
function EquipmentPair({sessions:ss}:{sessions:Session[]}) {
 const eqs=[...new Set(ss.map(s=>equipmentKey(s.conditions.equipment)))];
 const key='equipment:'+conditionKey(ss[0],false);
 const [savedA,setA]=useReviewState(key+':a',eqs[0]??''),[savedB,setB]=useReviewState(key+':b',eqs[1]??'');
 const a=eqs.includes(savedA)?savedA:eqs[0]??'',b=eqs.includes(savedB)?savedB:eqs[1]??'';
 const select=(label:string,value:string,onChange:(s:string)=>void)=><Field label={label}><ChoiceSelect value={value} onChange={e=>onChange(e.target.value)}><option value="">请选择套组</option>{eqs.map(key=><option key={key} value={key}>{ss.find(s=>equipmentKey(s.conditions.equipment)===key)!.conditions.equipment!.name}</option>)}</ChoiceSelect></Field>;
 return <div className="equipment-pair"><h3>{ss[0].conditions.distance}m · {ss[0].conditions.target.name} · {ss[0].conditions.size}cm</h3>
  {eqs.length<2?<p>此条件只有一套配置，{ss.length}场/{ss.flatMap(allArrows).length}箭；需要另一套同条件实际记录后对照。</p>:<><div className="form-row">{select('A器材配置',a,setA)}{select('B器材配置',b,setB)}</div>{a&&b&&a!==b?<ComparisonGraphs a={comparisonSample(ss.find(s=>equipmentKey(s.conditions.equipment)===a)?.conditions.equipment?.name??'A',ss.filter(s=>equipmentKey(s.conditions.equipment)===a))} b={comparisonSample(ss.find(s=>equipmentKey(s.conditions.equipment)===b)?.conditions.equipment?.name??'B',ss.filter(s=>equipmentKey(s.conditions.equipment)===b))}/>:<p>请选择两套不同的器材配置。</p>}</>}
 </div>;
}
export function EquipmentComparison({sessions}:{sessions:Session[]}) {
 const compatible=sessions.filter(s=>comparable(s)&&s.conditions.equipment),keys=[...new Set(compatible.map(s=>conditionKey(s,false)))];
 return <Panel title="同条件器材图形对照">{!compatible.length&&<p>需要尺寸、弓种明确且选择器材的完成记录。</p>}{keys.map(key=><EquipmentPair key={key} sessions={compatible.filter(s=>conditionKey(s,false)===key)}/>)}<p className="caption">按距离、靶规则、计分尺寸比例、尺寸及弓种分开；器材按真实配件快照区分，改名不产生新配置。差异不证明由器材导致。</p></Panel>;
}
