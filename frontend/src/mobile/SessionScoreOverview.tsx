import React, { useMemo, useState } from 'react';
import { sessionInsight } from './analysis-insights';
import { Chart, type ChartOption } from './Chart';
import type { Session } from './domain';
import { decimal } from './statistics';
import './session-score-compare.css';

export function SessionScoreOverview({session,group,setGroup}:{session:Session;group:number|null;setGroup:(group:number)=>void}) {
  const insight=useMemo(()=>sessionInsight(session,[]),[session]);
  const [picked,setPicked]=useState<string|null>(null);
  const groups=insight.ends;
  const selected=groups.find(end=>end.index===group)??groups[groups.length-1];
  if(!selected)return null;
  const arrows=session.ends[selected.index].arrows;
  const pickedIndex=arrows.findIndex(arrow=>arrow.id===picked);
  const activeArrow=arrows[pickedIndex];
  const distribution=['X','10','9','8','7','6','5','4','3','2','1','M']
    .map(code=>[code,insight.distribution[code]] as const)
    .filter(([,count])=>count>0);
  const chart:ChartOption={
    grid:{left:34,right:10,top:13,bottom:groups.length>10?43:29},
    tooltip:{trigger:'axis',confine:true,renderMode:'richText'},
    xAxis:{type:'category',data:groups.map(row=>`第${row.index+1}组`),axisTick:{show:false},axisLabel:{hideOverlap:true}},
    yAxis:{type:'value',minInterval:1,scale:true,splitLine:{lineStyle:{color:'#dce7f2'}}},
    dataZoom:groups.length>10?[{type:'slider',height:13,bottom:2,startValue:Math.max(0,groups.findIndex(row=>row.index===selected.index)-8),endValue:Math.max(9,groups.findIndex(row=>row.index===selected.index)),showDetail:false}]:[],
    series:[{name:'单组总分',type:'line',lineStyle:{color:'#6751a9',width:2.5},itemStyle:{color:'#6751a9'},symbolSize:9,
      data:groups.map(row=>({value:row.total,symbolSize:row.index===selected.index?14:9,itemStyle:row.index===selected.index?{color:'#b56923'}:undefined})),
      label:{show:groups.length<=8,position:'top',fontWeight:'bold',color:'#203b5a'}}],
  };
  return <section className="vx-card session-score-overview" id="session-score-overview">
    <div className="session-score-heading"><h2>本场概览</h2><small>{session.date}</small></div>
    <dl className="session-score-kpis">
      <div><dt>本场总分</dt><dd>{insight.total}</dd></div>
      <div><dt>加权均环</dt><dd>{decimal(insight.average)}</dd></div>
      <div><dt>实际箭数</dt><dd>{insight.arrows}</dd></div>
      <div><dt>X / 普通 10 / M</dt><dd>{insight.distribution.X} / {insight.distribution['10']} / {insight.distribution.M}</dd></div>
    </dl>
    <div className="session-score-heading"><h3>环值构成</h3><small>{insight.arrows} 箭</small></div>
    <div className="session-score-distribution" role="img" aria-label={distribution.map(([code,n])=>`${code} ${n} 箭`).join('，')}>
      {distribution.map(([code,n])=><span key={code} data-score={code} style={{flex:n}} title={`${code} · ${n} 箭`}/>) }
    </div>
    <div className="session-score-legend">{distribution.map(([code,n])=><span key={code}><i data-score={code}/>{code} · {n}</span>)}</div>
    <div className="session-score-heading"><h3>逐组走势与逐箭</h3><small>单组总分（分）</small></div>
    <Chart option={chart} label="按组记录的总分走势" height={groups.length>10?160:125} onSelect={index=>{const row=groups[index];if(row)setGroup(row.index);}}/>
    <div className="session-score-heading session-score-group">
      <label><span className="sr-only">逐箭组别</span><select aria-label="逐箭组别" value={selected.index} onChange={event=>setGroup(Number(event.target.value))}>
        {groups.map(row=><option key={row.index} value={row.index}>第 {row.index+1} 组 · {row.total} 分</option>)}
      </select></label><small>均环 {decimal(selected.average)} · {selected.arrows} 箭</small>
    </div>
    <div className="session-score-arrows" aria-label={`第 ${selected.index+1} 组录入箭序`}>
      {arrows.map((arrow,index)=><button key={arrow.id} type="button" data-score={arrow.code} aria-label={`录入第 ${index+1} 箭，${arrow.code}`} aria-pressed={picked===arrow.id} onClick={()=>setPicked(picked===arrow.id?null:arrow.id)}>{arrow.code}</button>)}
    </div>
    {activeArrow&&<p className="vx-state" role="status">录入第 {pickedIndex+1} 箭 · {activeArrow.code}{session.conditions.target.face_count>1?` · ${activeArrow.face} 号靶`:''}{activeArrow.note?` · ${activeArrow.note}`:''}</p>}
  </section>;
}
