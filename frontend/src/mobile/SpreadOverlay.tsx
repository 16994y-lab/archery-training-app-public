import React, { useMemo } from 'react';
import { Arrow } from './domain';
import { statistics, decimal, percent } from './statistics';
import { concentration } from '../features/model-alignment/spread-analysis';

export const GROUP_COLORS=['#082572','#a34513','#5e42a6','#007a8c','#ad285e'];
export function SpreadOverlay({stats:s,circles=true,shape=true}:{stats:ReturnType<typeof statistics>;circles?:boolean;shape?:boolean}) {
 const multiple=(s.groups?.groups.length??0)>1;
 return <g className="spread-overlay" pointerEvents="none">
  {s.hull.length>2&&<polygon data-kind="all-point-hull" points={s.hull.map(p=>`${p.x},${-p.y}`).join(' ')} fill="none" stroke="#082572" strokeWidth=".013" strokeDasharray=".035 .025"/>}
  {s.hull.length===2&&<line x1={s.hull[0].x} y1={-s.hull[0].y} x2={s.hull[1].x} y2={-s.hull[1].y} stroke="#082572" strokeWidth=".013"/>}
  {circles&&!multiple&&s.circle&&s.inside.length>=3&&<circle data-kind="concentration" cx={s.circle.x} cy={-s.circle.y} r={s.circle.radius} fill="none" stroke="#007b92" strokeWidth=".018" strokeDasharray=".04 .018"/>}
  {circles&&s.groups?.groups.map((group,i)=>{const c=concentration(group)!;return <g key={i} data-kind="candidate-group">
    <circle data-kind="candidate-circle" cx={c.x} cy={-c.y} r={c.radius} fill="none" stroke={GROUP_COLORS[i%GROUP_COLORS.length]} strokeWidth=".022"/>
    {c.radius===0&&<path d={`M${c.x-.025} ${-c.y}h.05M${c.x} ${-c.y-.025}v.05`} stroke={GROUP_COLORS[i%GROUP_COLORS.length]} strokeWidth=".012"/>}
    <text x={c.x+.025} y={-c.y-.04} fontSize=".08" fill={GROUP_COLORS[i%GROUP_COLORS.length]} stroke="white" strokeWidth=".009" paintOrder="stroke">群{i+1}</text>
  </g>;})}
  {shape&&s.ellipse&&s.inside.length>=3&&<ellipse data-kind="direction-ellipse" cx={s.ellipse.center.x} cy={-s.ellipse.center.y} rx={s.ellipse.radiusX} ry={s.ellipse.radiusY} transform={`rotate(${-s.ellipse.rotationDegrees} ${s.ellipse.center.x} ${-s.ellipse.center.y})`} fill="none" stroke="#a34513" strokeWidth=".012"/>}
 </g>;
}
/** Live scoring shows only blue circles; all diagnostic geometry remains in review. */
export function ScoringCircles({stats:s}:{stats:ReturnType<typeof statistics>}) {
 if(s.inside.length<3)return null;
 const circles=s.groups?.groups.length?s.groups.groups.map(g=>concentration(g)!):s.circle?[s.circle]:[];
 return <g className="scoring-circles" pointerEvents="none">{circles.map((c,i)=><circle key={i} data-kind="scoring-circle" cx={c.x} cy={-c.y} r={c.radius} fill="none" stroke="#1976d2" strokeWidth=".018"/>)}</g>;
}
export function SpreadExplanation({arrows,face}:{arrows:Arrow[];face?:number}) {
 const s=useMemo(()=>statistics(face?arrows.filter(a=>a.face===face):arrows),[arrows,face]);
 return <div className="live-spread-caption"><p>本{face?'靶位':'范围'}实际 {s.n} 箭 · 可信坐标 {s.located}/{s.n}（{percent(s.coverage)}）· 靶内 {s.inside.length} 点。照片参考映射只画点，不参与辅助圈。</p>
  {s.inside.length<3?<p>至少3个靶内落点后绘制集中圈；数字箭不补坐标。当前全点轮廓仍保留。</p>:<p>实线圈为候选箭群各自的80%集中圈，群号与颜色对应；虚线外轮廓包含有坐标的M。{(s.groups?.groups.length??0)>1?'检测到多个候选中心，隐藏统一集中圈。':'青色虚线圈为靶内总体80%集中圈。'}橙色椭圆为一倍样本标准差，不是置信区间。</p>}
  {s.groups?<><p>候选分群 {s.groups.groups.length} 个 · 未分群 {s.groups.unassigned.length} 点；阈值0.18个计分半径、最少3点。未分群只是离群候选，不删除。</p>{s.groups.groups.map((g,i)=>{const c=concentration(g)!;return <p key={i} className="group-legend"><i style={{background:GROUP_COLORS[i%GROUP_COLORS.length]}}/>群{i+1}：{g.length}/{s.inside.length}靶内点，圈内 {c.included}/{c.count}，半径 {decimal(c.radius)}。坐标右/上为正。</p>;})}</>:<p>靶内超过1500点，暂停候选聚类；请缩小范围，所有成绩仍保留。</p>}
  <p className="caption">圈与候选分群会随样本、阈值变化，不推断动作或器材原因。三联记分仅分析当前靶位，复盘可选择明确的靶心对齐叠加。</p>
 </div>;
}
