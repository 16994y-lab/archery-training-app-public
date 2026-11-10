import React, { useMemo } from 'react';
import { Chart, type ChartOption } from './Chart';
import type { Session } from './domain';
import { buildLongTermAnalysis, correlationMatrix, weightedMovingAverage, type LongTermPoint } from './long-term-analysis';
import { useReviewState } from './review-state';
import { decimal } from './statistics';
import { TargetFace } from './TargetFace';
import './long-term-analysis.css';

const scoreColor='#6952ad';
const volumeColor='#158579';
const otherColor='#ad722f';
const selectedColor='#b87828';
const shortDate=(date:string)=>date.slice(5).replace('-', '/');
const show=(value:number|null,digits=2)=>decimal(value,digits);

function sessionLabel(point:LongTermPoint){
  const time=new Date(point.session.started).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
  return `${shortDate(point.date)} ${time} · ${point.session.name}`;
}

function categoryLabels(points:LongTermPoint[]){
  const counts=new Map<string,number>();
  points.forEach(point=>counts.set(point.date,(counts.get(point.date)??0)+1));
  return points.map(point=>counts.get(point.date)!>1
    ? `${shortDate(point.date)}\n${new Date(point.session.started).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`
    : shortDate(point.date));
}

function axisChart(points:LongTermPoint[],unit:string):ChartOption{
  return {
    tooltip:{trigger:'axis',confine:true,renderMode:'richText'},
    grid:{left:42,right:15,top:23,bottom:points.length>12?54:32},
    xAxis:{type:'category',data:categoryLabels(points),axisTick:{show:false},axisLabel:{hideOverlap:true,fontSize:12}},
    yAxis:{type:'value',name:unit,nameGap:8,scale:true,axisLabel:{fontSize:12},splitLine:{lineStyle:{color:'#dce6ef'}}},
    dataZoom:points.length>12?[{type:'slider',start:0,end:100,height:15,bottom:1,showDetail:false}]:[],
  };
}

function scatterChart(points:LongTermPoint[],x:(point:LongTermPoint)=>number,y:(point:LongTermPoint)=>number,
  xName:string,yName:string,selected:string):ChartOption{
  return {
    tooltip:{trigger:'item',confine:true,renderMode:'richText'},
    grid:{left:42,right:17,top:25,bottom:38},
    xAxis:{type:'value',name:xName,nameLocation:'middle',nameGap:25,scale:true,axisLabel:{fontSize:12},splitLine:{show:false}},
    yAxis:{type:'value',name:yName,nameGap:8,scale:true,axisLabel:{fontSize:12},splitLine:{lineStyle:{color:'#dce6ef'}}},
    series:[{type:'scatter',name:yName,symbolSize:8,
      data:points.map(point=>({name:sessionLabel(point),value:[x(point),y(point)],
        symbolSize:point.id===selected?13:8,itemStyle:{color:point.id===selected?selectedColor:scoreColor,opacity:.85}}))}],
  };
}

export function LongTermAnalysis({sessions,open}:{sessions:Session[];open:(name:string,id?:string)=>void}){
  const [start,setStart]=useReviewState('long-term:start','');
  const [end,setEnd]=useReviewState('long-term:end','');
  const [condition,setCondition]=useReviewState('long-term:condition','');
  const [face,setFace]=useReviewState('long-term:face',1);
  const [picked,setPicked]=useReviewState('long-term:picked','');
  const [moving,setMoving]=useReviewState('long-term:moving',false);
  const model=useMemo(()=>buildLongTermAnalysis(sessions,{start:start||undefined,end:end||undefined,condition,face}),[sessions,start,end,condition,face]);
  const {records,same,targetSession}=model;
  const targetFace=model.activeFace;
  const selected=records.find(point=>point.id===picked)??same[same.length-1]??records[records.length-1];
  const selectedId=selected?.id??'';
  const matrix=useMemo(()=>correlationMatrix(same),[same]);
  const movingValues=useMemo(()=>weightedMovingAverage(same),[same]);
  const movingById=new Map(same.map((point,index)=>[point.id,movingValues[index]]));
  const located=same.filter(point=>point.rms!==null);
  const choose=(points:LongTermPoint[])=>(index:number)=>{if(points[index])setPicked(points[index].id);};
  const selectedData=(points:LongTermPoint[],value:(point:LongTermPoint)=>number|null)=>points.map(point=>({
    name:sessionLabel(point),value:value(point),symbolSize:point.id===selectedId?12:8,
    itemStyle:{color:point.id===selectedId?selectedColor:scoreColor},
  }));
  const scoreChart:ChartOption={...axisChart(records,'环'),series:[
    {name:'本场均环',type:'line',connectNulls:false,lineStyle:{color:scoreColor,width:2.5},itemStyle:{color:scoreColor},
      label:{show:records.length<=8,position:'top',fontSize:12,color:'#20364c',formatter:params=>typeof params.value==='number'?params.value.toFixed(2):''},
      data:selectedData(records,point=>point.conditionKey===model.activeCondition?point.average:null)},
    ...(moving?[{name:'三场加权平均',type:'line' as const,connectNulls:false,symbolSize:4,
      lineStyle:{color:volumeColor,width:2,type:'dashed' as const},itemStyle:{color:volumeColor},data:records.map(point=>movingById.get(point.id)??null)}]:[]),
  ]};
  const volumeChart:ChartOption={...axisChart(records,'箭'),
    yAxis:{type:'value',name:'箭',nameGap:8,min:0,minInterval:1,axisLabel:{fontSize:12},splitLine:{lineStyle:{color:'#dce6ef'}}},
    series:[{name:'实际箭量',type:'bar',barMaxWidth:24,
      label:{show:records.length<=12,position:'top',fontSize:12,color:'#20364c'},
      data:records.map(point=>({name:sessionLabel(point),value:point.n,itemStyle:{
        color:point.conditionKey===model.activeCondition?volumeColor:otherColor,
        borderColor:point.id===selectedId?selectedColor:undefined,borderWidth:point.id===selectedId?3:0,
      }}))}],
  };
  const biasChart:ChartOption={...axisChart(same,'cm'),legend:{data:['左右','上下'],top:0,right:5,itemWidth:15,itemHeight:7,textStyle:{fontSize:12}},
    grid:{left:42,right:15,top:29,bottom:same.length>12?54:32},series:[
      {name:'左右',type:'line',connectNulls:false,lineStyle:{color:scoreColor,width:2},itemStyle:{color:scoreColor},data:selectedData(same,point=>point.centerX)},
      {name:'上下',type:'line',connectNulls:false,lineStyle:{color:volumeColor,width:2,type:'dashed'},itemStyle:{color:volumeColor},
        data:same.map(point=>({value:point.centerY,symbolSize:point.id===selectedId?12:8,itemStyle:{color:point.id===selectedId?selectedColor:volumeColor}}))},
    ]};
  const highChart:ChartOption={...axisChart(same,'%'),
    yAxis:{type:'value',name:'%',nameGap:8,min:0,max:100,axisLabel:{fontSize:12},splitLine:{lineStyle:{color:'#dce6ef'}}},
    series:[{name:'9 环及以上',type:'line',lineStyle:{color:scoreColor,width:2.5},itemStyle:{color:scoreColor},data:selectedData(same,point=>point.highRate)}]};
  const rangeChart:ChartOption={...axisChart(same,'环'),
    tooltip:{trigger:'axis',confine:true,renderMode:'richText',formatter:params=>{
      const item=Array.isArray(params)?params[0]:params;
      const point=same[item?.dataIndex??-1];
      return point?`${sessionLabel(point)}\n最低组 ${show(point.groupMin)} 环\n最高组 ${show(point.groupMax)} 环\n本场均环 ${show(point.average)} 环`:'';
    }},
    series:[
      {name:'最低组',type:'bar',stack:'range',silent:true,itemStyle:{color:'transparent'},emphasis:{disabled:true},
        tooltip:{show:false},data:same.map(point=>point.groupMin)},
      {name:'组间均环范围',type:'bar',stack:'range',barWidth:4,itemStyle:{color:'#8ba1ba'},
        data:same.map(point=>point.groupMax===null||point.groupMin===null?null:point.groupMax-point.groupMin)},
      {name:'本场均环',type:'line',showSymbol:true,lineStyle:{opacity:0},itemStyle:{color:scoreColor},data:selectedData(same,point=>point.average)},
    ]};
  return <div className="long-term-analysis" data-long-term-analysis>
    <section className="vx-card lt-controls" aria-label="分析范围">
      <div className="lt-dates">
        <label>开始日期<input type="date" aria-label="开始日期" value={start||model.availableStart||''} onChange={event=>setStart(event.target.value)}/></label>
        <label>结束日期<input type="date" aria-label="结束日期" value={end||model.availableEnd||''} onChange={event=>setEnd(event.target.value)}/></label>
      </div>
      <label className="lt-condition">训练项目<select aria-label="训练项目" value={model.activeCondition} onChange={event=>{setCondition(event.target.value);setFace(1);setPicked('');}}>
        {model.conditions.map(item=><option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      {(start||end)&&<button className="vx-button lt-reset-range" type="button" onClick={()=>{setStart('');setEnd('');}}>全部日期</button>}
      {!model.validRange&&<p className="lt-state" role="alert">请选择有效日期，开始日期须早于或等于结束日期。</p>}
    </section>
    <section className="vx-card lt-target-section" aria-labelledby="long-term-target-title">
      <div className="lt-heading"><h2 id="long-term-target-title">区间落点</h2><span>{same.length} 场</span></div>
      {targetSession?<>
        {targetSession.conditions.target.face_count>1&&<div className="lt-faces" aria-label="落点靶位">
          {Array.from({length:targetSession.conditions.target.face_count},(_,index)=><button key={index} type="button" aria-pressed={targetFace===index+1}
            className="vx-button" onClick={()=>setFace(index+1)}>{index+1} 号靶</button>)}
        </div>}
        <div className="lt-target-layout">
          <TargetFace target={targetSession.conditions.target} arrows={model.targetArrows} face={targetFace} zoomable review resetKey={`long-term:${model.activeCondition}:${start}:${end}:${targetFace}`}/>
          <dl className="lt-target-metrics">
            <div><dt>实际箭数</dt><dd>{model.totalArrows}<small> 箭</small></dd></div>
            <div><dt>可信落点</dt><dd>{model.targetTrusted}<small> 个</small></dd></div>
            <div><dt>加权均环</dt><dd>{show(model.weightedAverage)}<small> 环</small></dd></div>
          </dl>
        </div>
        {!model.targetTrusted&&<p className="lt-state">所选范围没有已保存的可信落点。</p>}
      </>:<p className="lt-state">所选范围暂无训练记录。</p>}
    </section>
    <section className="vx-card lt-chart-section" aria-labelledby="long-term-score-title">
      <div className="lt-heading"><h2 id="long-term-score-title">成绩与训练量</h2><span>{records.length} 场</span></div>
      {selected&&<div className="lt-selection">
        <select aria-label="查看训练场次" value={selectedId} onChange={event=>setPicked(event.target.value)}>
          {records.map(point=><option key={point.id} value={point.id}>{sessionLabel(point)}</option>)}
        </select>
        <div className="lt-selected-values" aria-live="polite"><b>{show(selected.average)} 环</b><span>{selected.n} 箭</span><span>坐标 {selected.trusted} 个</span>
          <button type="button" className="vx-button" onClick={()=>open('insights',selected.id)}>查看本场</button>
        </div>
      </div>}
      <div className="lt-heading"><h3>同条件均环</h3><label className="lt-toggle"><input type="checkbox" checked={moving} onChange={event=>setMoving(event.target.checked)}/>三场加权平均</label></div>
      {same.length?<Chart option={scoreChart} height={records.length>12?225:195} label="同条件各场均环走势" onSelect={choose(records)}/>:<p className="lt-state">所选范围暂无同条件记录。</p>}
      <div className="lt-heading"><h3>每场实记箭量</h3><div className="lt-legend"><span><i style={{background:volumeColor}}/>同条件</span><span><i style={{background:otherColor}}/>其他条件</span></div></div>
      {records.length?<Chart option={volumeChart} height={records.length>12?205:170} label="各场实际记录箭数" onSelect={choose(records)}/>:<p className="lt-state">所选范围暂无记录。</p>}
    </section>
    <section className="vx-card lt-chart-section" aria-labelledby="long-term-relation-title">
      <div className="lt-heading"><h2 id="long-term-relation-title">指标关系</h2><span>同条件 {same.length} 场</span></div>
      <div className="lt-relations">
        <div><div className="lt-heading"><h3>均环与散布</h3><span>{located.length} 场</span></div>
          <Chart option={scatterChart(located,point=>point.average,point=>point.rms!,'均环（环）','RMS（cm）',selectedId)} height={205}
            label="各场均环与落点 RMS 散布关系" onSelect={choose(located)}/></div>
        <div><div className="lt-heading"><h3>箭量与均环</h3><span>{same.length} 场</span></div>
          <Chart option={scatterChart(same,point=>point.n,point=>point.average,'箭量（箭）','均环（环）',selectedId)} height={205}
            label="各场实际箭量与均环关系" onSelect={choose(same)}/></div>
      </div>
      <div className="lt-heading"><h3>相关系数</h3><span>各格按有效场次计算</span></div>
      <table className="lt-matrix" aria-label="均环、散布和箭量的相关系数"><thead><tr><th scope="col">指标</th>{matrix.labels.map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{matrix.cells.map((row,rowIndex)=><tr key={matrix.labels[rowIndex]}><th scope="row">{matrix.labels[rowIndex]}</th>
          {row.map((cell,column)=><td key={column} data-sign={cell.value===null?'none':cell.value>=0?'positive':'negative'} title={`${cell.n} 场`}>
            <b>{show(cell.value)}</b><small>{cell.n} 场</small>
          </td>)}
        </tr>)}</tbody></table>
    </section>
    <section className="vx-card lt-chart-section" aria-labelledby="long-term-stability-title">
      <div className="lt-heading"><h2 id="long-term-stability-title">偏向与稳定性</h2><span>同条件</span></div>
      <div className="lt-heading"><h3>平均落点偏移</h3><span>右、上为正</span></div>
      <Chart option={biasChart} height={same.length>12?225:195} label="各场平均落点的水平和垂直偏移" onSelect={choose(same)}/>
      <div className="lt-heading"><h3>9 环及以上占比</h3><span>含 9、10、X</span></div>
      <Chart option={highChart} height={same.length>12?205:170} label="各场 9 环、10 环与 X 的箭数占比" onSelect={choose(same)}/>
      <div className="lt-heading"><h3>场内各组均环范围</h3><span>最低组至最高组</span></div>
      <Chart option={rangeChart} height={same.length>12?225:195} label="各场最低组、最高组和本场均环" onSelect={choose(same)}/>
    </section>
  </div>;
}
