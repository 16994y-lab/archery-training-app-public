import {ChoiceSelect} from './ChoiceSelect';
import React, { useMemo, useState } from 'react';
import { allArrows } from './domain';
import { savedCoordinateCoverage, sessionInsight } from './analysis-insights';
import { Chart, type ChartOption } from './Chart';
import { Back, Button, Empty, Field, Panel, TargetFace, useApp } from './ui';
import './analysis-insights.css';

const fmt=(value:number|null)=>value===null?'—':value.toFixed(2);
const signed=(value:number)=>`${value>=0?'+':''}${value.toFixed(2)}`;
const axis=(value:number,positive:string,negative:string)=>Math.abs(value)<.005?'居中 0.00':`${value>0?positive:negative} ${Math.abs(value).toFixed(2)}`;

export function AnalysisInsights({onBack,sessionId}:{onBack:()=>void;sessionId?:string}) {
  const {data,open}=useApp();
  const records=useMemo(()=>data.sessions.filter(s=>s.status==='completed'&&allArrows(s).length>0)
    .sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id)),[data.sessions]);
  const [selectedId,setSelectedId]=useState(sessionId??records[0]?.id??'');
  const [face,setFace]=useState(1);
  const session=records.find(s=>s.id===selectedId)??(sessionId?undefined:records[0]);
  const insight=useMemo(()=>session?sessionInsight(session,data.sessions):null,[session,data.sessions]);
  if(sessionId&&!session)return <><Back title="数据分析" onBack={onBack}/><Panel><Empty title="未找到这次已完成训练">请从复盘列表重新选择，不会自动打开另一场。</Empty><Button onClick={()=>open('history')}>返回复盘</Button></Panel></>;
  if(!session||!insight)return <><Back title="数据分析" onBack={onBack}/><Panel><Empty title="先完成一场训练">保存至少一箭并结束训练后，这里会按真实记录生成图表。</Empty><Button kind="primary" onClick={()=>open('training')}>去训练</Button></Panel></>;

  const endRows=insight.ends.slice(-24),hiddenEnds=insight.ends.length-endRows.length;
  const coverage=savedCoordinateCoverage(session),plottedCount=coverage.target+coverage.photoManual+coverage.photoMapped;
  const lowEnds=insight.ends.filter(e=>e.miss||e.low).sort((a,b)=>b.miss-a.miss||b.low-a.low||a.average!-b.average!).slice(0,5);
  const allowed=session.conditions.target.allowed_score_codes;
  const distribution=allowed.map(code=>({label:code==='10'?'普通 10':code,value:insight.distribution[code]??0,color:code==='M'?'miss':code==='X'||code==='10'?'gold':['9','8'].includes(code)?'red':['7','6','5'].includes(code)?'blue':'dark'}));
  const trendOption:ChartOption={aria:{enabled:true,description:endRows.length>1?`本场最近 ${endRows.length} 组平均环趋势`:'本组平均环'},grid:{left:42,right:16,top:18,bottom:35},xAxis:{type:'category',data:endRows.map(end=>`第${end.index+1}组`),axisLabel:{interval:endRows.length>12?'auto':0,rotate:endRows.length>8?35:0}},yAxis:{type:'value',min:0,max:10,name:'均环'},tooltip:{trigger:'axis'},series:[{name:'每组平均环',type:'line',data:endRows.map(end=>end.average===null?null:Number(end.average.toFixed(2))),symbol:'circle',symbolSize:8,lineStyle:{width:3},areaStyle:{opacity:.12},connectNulls:false}]};
  const activeFace=Math.min(Math.max(face,1),session.conditions.target.face_count);
  const faceInside=insight.spatial.inside.filter(a=>a.face===activeFace),faceMisses=insight.spatial.misses.filter(a=>a.face===activeFace);
  const faceMapped=coverage.estimated.filter(a=>a.face===activeFace);
  const points=[...faceInside.slice(-120),...faceMisses.slice(-40),...faceMapped.slice(-80)];
  const center=faceInside.length>=2?{
    x:faceInside.reduce((n,a)=>n+a.x!,0)/faceInside.length,
    y:faceInside.reduce((n,a)=>n+a.y!,0)/faceInside.length
  }:null;

  return <div className="insights-page">
    <Back title="数据分析" onBack={onBack}/>
    <div className="page-title"><span className="eyebrow">GONGXINGJI · 本场复盘</span><h2 className="insights-title">这场练了什么</h2><p>{session.date} · {session.name} · {insight.ends.length} 组 / {insight.arrows} 箭</p></div>
    <Field label="选择已完成的训练"><ChoiceSelect value={session.id} onChange={e=>{setSelectedId(e.target.value);setFace(1);}}>{records.map(s=><option key={s.id} value={s.id}>{s.date} · {s.name} · {allArrows(s).length}箭</option>)}</ChoiceSelect></Field>
    <div className="insights-conditions"><span>{session.conditions.distance}米</span><span>{session.conditions.target.name}</span><span>{session.conditions.bow||'弓种未填'}</span><span>{session.conditions.size===null?'靶纸尺寸未知':`${session.conditions.size}厘米`}</span></div>

    <section className="insights-hero" aria-label="本场成绩">
      <span className="insights-kicker">本场总分</span><div className="insights-score"><strong>{insight.total}</strong><span>分 · 平均 {fmt(insight.average)} 环 / 箭</span></div>
      <div className="insights-hero-foot"><span>{insight.arrows} 箭 · {insight.ends.length} 组</span><span>X {insight.distribution.X} · 普通10 {insight.distribution['10']} · M {insight.distribution.M}</span></div>
      <p className="insights-hero-explanation">{insight.distribution.M>0?`其中 ${insight.distribution.M} 箭为 M，已按 0 分计入均环；空箭位不算 M。`:'本场实际记录的箭中没有 M；空箭位不参与均环。'}</p>
    </section>

    <Panel title="这场可以确认的事" className="insights-facts">
      <p>{insight.ends.length===1?'目前只有 1 个有成绩的组，先看每箭记录；还不能看逐组变化。':`每组箭数可能不同，本场均环按实际 ${insight.arrows} 箭计算。`}</p>
      {insight.first&&insight.last&&insight.splitLabels&&<div className="insights-split" aria-label={insight.splitLabels.mode==='halves'?'记录中的上下半场成绩':'前后组成绩'}>
        <span>{insight.splitLabels.first}<br/><b>{fmt(insight.first.average)} 环 / 箭</b><br/>{insight.first.arrows} 箭 · {insight.first.total} 分</span>
        <span>{insight.splitLabels.last}<br/><b>{fmt(insight.last.average)} 环 / 箭</b><br/>{insight.last.arrows} 箭 · {insight.last.total} 分</span>
      </div>}
      {insight.splitLabels?.mode==='groups'&&<p className="caption">自由训练按有成绩的组分成前后两段。组数为奇数时，前段多 1 组，各段仍按实际箭数加权。</p>}
      {!insight.comparison&&<p>{insight.comparisonUnavailable==='unknown-conditions'?'靶纸尺寸、器材或规则等条件还不完整，暂不与历史训练比较。':'还没有可比较的此前同条件记录；可以按相同条件继续记录。'}</p>}
      <p className="caption">以上描述已记录成绩；单次训练和少量样本不用于判断姿势、器材或疲劳原因。</p>
    </Panel>

    <Panel title="落点覆盖" className="insights-points-panel">
      <div className="insights-point-total"><strong>{plottedCount}<small> / {insight.arrows}</small></strong><span>箭有保存位置</span></div>
      <div className="insights-point-breakdown" aria-label="落点来源"><span><i className="point-target"/>点靶 {coverage.target}</span><span><i className="point-photo-manual"/>照片人工点靶 {coverage.photoManual}</span><span><i className="point-photo-mapped"/>照片参考映射 {coverage.photoMapped}</span><span>数字 {coverage.numeric} 无位置</span>{coverage.scoreOnly>0&&<span>其他仅环值 {coverage.scoreOnly}</span>}</div>
      {session.conditions.target.face_count>1&&<Field label="查看靶位"><ChoiceSelect value={activeFace} onChange={e=>setFace(Number(e.target.value))}>{Array.from({length:session.conditions.target.face_count},(_,i)=><option value={i+1} key={i}>第 {i+1} 靶位</option>)}</ChoiceSelect></Field>}
      {points.length?<div className="insights-spatial"><TargetFace target={session.conditions.target} arrows={points} face={activeFace}/><div className="insights-spatial-copy"><p>落点统一用圆点展示；照片参考坐标可能偏移，不参加可信散布计算。</p><details className="insights-method"><summary>查看落点计算详情</summary><p>当前靶位可信靶内 {faceInside.length} 点，带方向 M {faceMisses.length} 点；照片参考映射 {faceMapped.length} 点。</p>{center?<p>可信靶内中心相对靶心：水平{axis(center.x,'右','左')}、垂直{axis(center.y,'上','下')} 个计分半径。只计算人工确认的 {faceInside.length} 个点。</p>:<p>可信靶内少于 2 点，不判断中心或散布。</p>}{faceInside.length>120||faceMisses.length>40||faceMapped.length>80?<p>图上最多显示最近 120 个可信靶内点、40 个 M 方向点及 80 个参考映射点；数量按全部合格坐标计算。</p>:null}</details></div></div>:<div className="insights-no-points"><b>这场没有已保存的可画位置</b><p>这场仍可查看逐箭成绩和均环。只有环值无法还原落点；以后可点按靶面记录位置，或逐点确认照片中的位置。</p></div>}
    </Panel>

    <div className="insights-layout">
      <Panel title={insight.ends.length>1?'逐组变化':'本组成绩'} className="insights-chart-panel">
        <Chart option={trendOption} label={insight.ends.length>1?`本场 ${insight.ends.length} 组的平均环折线图`:'本场唯一有成绩组的平均环图'} height={220}/>
        <p className="insights-section-lead">{insight.ends.length>1?'每组均环趋势；长按图表或展开下方查看原分数。':'本场只有 1 个有成绩的组，尚未形成趋势；展开下方可查看原分数。'}</p>
        <details className="insights-method"><summary>查看逐组分数与箭数</summary><div className="insights-end-list" aria-label="各组总分与平均环">
          {endRows.map(group=><div className="insights-end-row" key={group.index}>
            <span className="insights-end-label">第 {group.index+1} 组</span>
            <div className="insights-track"><span style={{width:`${Math.max(0,Math.min(100,(group.average??0)*10))}%`}}/></div>
            <strong>{group.total} 分</strong><small>均 {fmt(group.average)} · {group.arrows} 箭{group.miss?` · M ${group.miss}`:''}</small>
          </div>)}
        </div></details>
        {hiddenEnds>0&&<p className="caption">图中展示最近 {endRows.length} 组；本场分数与对比仍计入全部 {insight.ends.length} 个有箭组。</p>}
      </Panel>

      <Panel title="环值构成" className="insights-chart-panel">
        <div className="insights-distribution">{distribution.map(row=><div className="insights-dist-row" key={row.label}>
          <span>{row.label}</span><div className="insights-track"><span className={`insights-fill-${row.color}`} style={{width:`${insight.arrows?row.value/insight.arrows*100:0}%`}}/></div><strong>{row.value}</strong>
        </div>)}</div>
        <details className="insights-method"><summary>环值与分母</summary><p>X 与普通 10 分开；两者均计 10 分，M 计 0 分。分母是实际记录的 {insight.arrows} 箭，空箭位不算 M。</p></details>
      </Panel>
    </div>

    <Panel title="本场值得回看的组">
      {lowEnds.length?<><div className="insights-observations">{lowEnds.slice(0,2).map(group=><div key={group.index}><b>第 {group.index+1} 组</b><span>{group.arrows} 箭 · 均 {fmt(group.average)} 环{group.miss?` · M ${group.miss}`:''}{group.low?` · 7 环及以下 ${group.low}`:''}</span></div>)}</div>{lowEnds.length>2&&<details className="insights-method"><summary>再看 {lowEnds.length-2} 组</summary><div className="insights-observations">{lowEnds.slice(2).map(group=><div key={group.index}><b>第 {group.index+1} 组</b><span>{group.arrows} 箭 · 均 {fmt(group.average)} 环{group.miss?` · M ${group.miss}`:''}{group.low?` · 7 环及以下 ${group.low}`:''}</span></div>)}</div></details>}</>:<p>这场没有记录 M 或 7 环及以下的箭。</p>}
      <Button onClick={()=>open('detail',session.id)}>查看本场逐箭记录</Button>
    </Panel>

    {insight.comparison&&<Panel title="同条件历史对比"><strong className="insights-comparison-value">{signed(insight.comparison.delta)} 环 / 箭</strong><div className="insights-compare-bars"><span>此前</span><div className="insights-track"><span style={{width:`${insight.comparison.average*10}%`}}/></div><b>{fmt(insight.comparison.average)}</b><span>本场</span><div className="insights-track"><span style={{width:`${(insight.average??0)*10}%`}}/></div><b>{fmt(insight.average)}</b></div><details className="insights-method"><summary>查看对比口径</summary><p>只对照之前 {insight.comparison.sessions} 场完全同条件记录，合计 {insight.comparison.arrows} 箭；差异不能单独说明原因。</p></details></Panel>}
    <Panel className="insights-next"><h2>下次可观察</h2><p>{lowEnds.length?`同条件再练时，可记下第 ${lowEnds.map(e=>e.index+1).join('、')} 组附近实际发生的情况，再看变化。`:'下次按相同条件继续记录，并在当组写下可观察的情况。'}</p><p className="caption">只提示记录事实，不从环数推断姿势、器材或疲劳原因。</p><div className="actions"><Button onClick={()=>open('detail',session.id)}>逐箭记录与可选心得</Button></div></Panel>
  </div>;
}
