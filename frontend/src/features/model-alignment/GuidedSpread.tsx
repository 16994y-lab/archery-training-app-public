import { useState } from "react";
import type { ScoreSession } from "../../scoring-session";
import { resolveTargetContract } from "../../target-contract";
import { TargetRings } from "../scoring/TargetCanvas";
import { scatterEllipse } from "../../review";
import { concentration, spreadSummary } from "./spread-analysis";

const colors=["#116b67","#b15d16","#7754ad","#256caa"];
export function GuidedSpread({session,endFilter,bias=false}:{session:ScoreSession;endFilter:"all"|number;bias?:boolean}) {
  const [mode,setMode]=useState("circle"), [face,setFace]=useState("all");
  const target=resolveTargetContract(session.target), radius=target.plot?.outer_scoring_radius_norm;
  const arrows=session.ends.filter(e=>endFilter==="all"||e.sequence===endFilter).flatMap(e=>e.arrows.map(a=>({...a,group:e.sequence})));
  const selected=arrows.filter(a=>face==="all"||a.target_face_index===Number(face));
  const located=selected.filter(a=>radius&&a.plot_x_norm!=null&&a.plot_y_norm!=null&&(target.face_count===1||a.target_face_index!=null)).map(a=>({...a,x:(a.plot_x_norm!-.5)/radius!,y:(a.plot_y_norm!-.5)/radius!}));
  const inside=located.filter(a=>a.score_code!=="M"), result=spreadSummary(inside), c=result.circle;
  const ellipse=scatterEllipse(inside.map(a=>({x:a.x,y:a.y})));
  const effective=bias?"bias":mode;
  const label=(v:number,negative:string,positive:string)=>Math.abs(v)<.005?"接近中心":`${v<0?negative:positive}${(Math.abs(v)*100).toFixed(1)}%`;
  return <section className="chart-card guided-spread"><div className="chart-head"><h3>{bias?"偏向与分散，分开看":"箭群集中与分布"}</h3><span className="coverage-note">有坐标 {located.length}/{selected.length} 箭</span></div>
    {target.face_count>1&&<label>分靶位<select value={face} onChange={e=>setFace(e.target.value)}><option value="all">靶心对齐叠加（非靶纸位置）</option>{[1,2,3].map(n=><option key={n} value={n}>靶位{n}</option>)}</select></label>}
    {!bias&&<div className="spread-tabs">{[["circle","集中圈"],["ellipse","方向形状"],["groups","箭群分布"]].map(([id,name])=><button key={id} aria-pressed={mode===id} onClick={()=>setMode(id)}>{name}</button>)}</div>}
    {!located.length?<p>没有落点坐标。数字成绩可以分析环数，不能推算方向或聚类。</p>:<>
    <svg viewBox="-125 -125 250 250" className="guided-plot" aria-label="实际落点分析" role="img"><TargetRings target={target} cx={0} cy={0} scoringRadius={100}/>
      {c&&effective==="circle"&&<circle cx={c.x*100} cy={c.y*100} r={c.radius*100} className="spread-circle"/>}
      {c&&effective==="bias"&&<path d={`M0 0 L${c.x*100} ${c.y*100}`} stroke="#116b67" strokeWidth="3"/>}
      {ellipse&&effective==="ellipse"&&<ellipse cx={ellipse.center.x*100} cy={ellipse.center.y*100} rx={ellipse.radiusX*100} ry={ellipse.radiusY*100} transform={`rotate(${ellipse.rotationDegrees} ${ellipse.center.x*100} ${ellipse.center.y*100})`} className="spread-circle"/>}
      {effective==="groups"&&result.sufficient&&result.groups.map((g,i)=>{const center=concentration(g)!;return <g key={i}><circle cx={center.x*100} cy={center.y*100} r={Math.max(5,...g.map(p=>Math.hypot(p.x-center.x,p.y-center.y)*100))} fill={colors[i%4]} fillOpacity=".14" stroke={colors[i%4]} strokeWidth="2"/><text x={center.x*100} y={center.y*100-9} fill={colors[i%4]} fontWeight="bold">群{i+1}</text></g>;})}
      {located.map((a,i)=>{const group=result.groups.findIndex(g=>g.some(p=>p.index===inside.indexOf(a)));return a.score_code==="M"?<path key={a.id} d={`M${a.x*100-3} ${a.y*100-3}l6 6m-6 0l6 -6`} stroke="#a03e49" strokeWidth="2"/>:<circle key={a.id||i} cx={a.x*100} cy={a.y*100} r="2.8" fill={effective==="groups"&&result.sufficient&&group>=0?colors[group%4]:"white"} stroke="#20334b" strokeWidth="1.2"/>;})}
      {c&&<path d={`M${c.x*100-5} ${c.y*100}h10m-5 -5v10`} stroke="#153f45" strokeWidth="2"/>}
    </svg>
    <p className="plot-legend">＋ 箭群中心　× 已定位M　圆点 实际落点</p>
    {c&&<div className="analysis-observation"><strong>{effective==="circle"?`集中圈内 ${c.included}/${c.count} 箭（${Math.round(c.included/c.count*100)}%）`:effective==="groups"?result.sufficient?`当前参数划分 ${result.groups.length} 个候选箭群` : "坐标较少，暂不分群":`${label(c.x,"左偏","右偏")} · ${label(c.y,"上偏","下偏")}`}</strong><p>{effective==="circle"?`以箭群平均中心绘制，半径为计分半径的${(c.radius*100).toFixed(1)}%；覆盖至少80%的本次靶内定位点，圈外箭仍保留。`:effective==="ellipse"?"椭圆只描述方向形状，不等于概率范围；与集中圈互斥显示。":effective==="bias"?"偏移小不代表集中；需要同时观察集中圈大小。坐标不能直接判断动作或体能原因。":"分群依据点间距离，不是按环数或录入先后分组；没有分入箭群的点仍保留。"}</p></div>}
    {effective==="groups"&&result.sufficient&&<div className="cluster-list">{result.groups.map((g,i)=>{const center=concentration(g)!;return <article key={i} style={{borderLeftColor:colors[i%4]}}><strong>群{i+1} · {g.length}箭 · {(g.length/inside.length*100).toFixed(0)}%</strong><p>{label(center.x,"左偏","右偏")} · {label(center.y,"上偏","下偏")}<br/>来自第{[...new Set(g.map(p=>p.group))].join("、")}组</p></article>;})}<p>未归群 {result.unassigned.length}箭 · 已定位M {located.length-inside.length}箭另列。</p><p>{result.sensitive?"分群对邻近范围敏感，不能认定存在稳定的多个箭群。":"邻近范围小幅调整未改变当前分组；仍仅描述本次样本。"}</p><details><summary>计算口径</summary>密度分群邻近距离为计分半径的18%，最少3点；另用15%和21%检查敏感性。少于6个靶内点不显示分群，6点仅为界面门槛，不是可靠性的证明。</details></div>}
    <p className="alignment-data-note">集中与方向只使用靶内有坐标的箭；M仍计入成绩分母，无坐标箭不补点。距离、靶型不同不直接比较；尺寸未知不换算厘米。</p></>}
  </section>;
}
