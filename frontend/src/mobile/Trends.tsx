import {ChoiceSelect} from './ChoiceSelect';
import React, { useMemo } from 'react';
import { Session, allArrows } from './domain';
import { statistics, percent, decimal, trend, conditionKey } from './statistics';
import { Panel, Field, Button, useApp } from './ui';
import { Chart, ChartOption } from './Chart';
import { useReviewState } from './review-state';
import { sourceSessions, reviewTrend } from './review-data';

type Metric='average'|'arrows'|'x'|'ten'|'miss'|'yellow'|'biasX'|'biasY'|'spread'|'fatigue'|'energy';
const labels:Record<Metric,string>={average:'加权平均环',arrows:'实际箭量',x:'X率',ten:'普通10率',miss:'M率',yellow:'9+10+X率（标准靶黄心）',biasX:'水平偏向',biasY:'垂直偏向',spread:'靶内RMS散布',fatigue:'主观疲劳',energy:'主观体能'};
export function Trends({sessions}:{sessions:Session[]}) {
  const {open}=useApp();
  const [grain,setGrain]=useReviewState<'day'|'week'|'month'|'session'>('trend-grain','week'),[metric,setMetric]=useReviewState<Metric>('trend-metric','average'),[condition,setCondition]=useReviewState('trend-condition','all'),[source,setSource]=useReviewState('trend-source','');
  const conditions=[...new Map(sessions.map(s=>[conditionKey(s),s])).entries()];
  const activeCondition=conditions.some(([key])=>key===condition)?condition:'all';
  const filtered=activeCondition==='all'?sessions:sessions.filter(s=>conditionKey(s)===activeCondition);
  const points=useMemo(()=>reviewTrend(filtered,grain),[filtered,grain]);
  const rate=['x','ten','miss','yellow'].includes(metric),spatial=['biasX','biasY','spread'].includes(metric);
  const unit=rate?'%':spatial?'计分半径':metric==='arrows'?'箭':metric==='average'?'环':'自评分';
  const value=(p:typeof points[number]):number|null=>metric==='average'?p.stats.average:metric==='arrows'?p.stats.n:metric==='biasX'?p.stats.circle?.x??null:metric==='biasY'?p.stats.circle?.y??null:metric==='spread'?p.stats.circle?.rms??null:metric==='fatigue'?p.fatigue:metric==='energy'?p.energy:p.stats[metric];
  const shown=(p:typeof points[number])=>rate?percent(value(p)):decimal(value(p),metric==='arrows'?0:2);
  const option:ChartOption={tooltip:{trigger:'axis',confine:true,renderMode:'richText'},grid:{left:62,right:20,top:38,bottom:points.length>12?86:54},xAxis:{type:'category',data:points.map(p=>grain==='session'?new Date(p.date).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):p.date),axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:unit,min:spatial?undefined:0,axisLabel:{formatter:rate?'{value}%':'{value}'}},dataZoom:points.length>12?[{type:'slider',startValue:Math.max(0,points.length-12),endValue:points.length-1,height:20,bottom:12}]:[],series:[{name:labels[metric],type:metric==='arrows'?'bar':'line',connectNulls:false,symbolSize:10,lineStyle:{width:3},data:points.map(p=>{const v=value(p);return v===null?null:rate?Number((v*100).toFixed(3)):v;})}]};
  const selected=points.some(p=>p.key===source)?source:'';
  const sources=selected?sourceSessions(filtered,grain,selected):[];
  return <><Panel title="变化趋势"><div className="form-row"><Field label="汇总粒度"><ChoiceSelect value={grain} onChange={e=>{setGrain(e.target.value as typeof grain);setSource('');}}><option value="day">日</option><option value="week">周（周一起）</option><option value="month">月</option><option value="session">场次</option></ChoiceSelect></Field><Field label="指标"><ChoiceSelect value={metric} onChange={e=>setMetric(e.target.value as Metric)}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</ChoiceSelect></Field></div><Field label="训练条件"><ChoiceSelect value={activeCondition} onChange={e=>{setCondition(e.target.value);setSource('');}}><option value="all">全部条件（混合展示）</option>{conditions.map(([key,s],i)=><option key={key} value={key}>{i+1}. {s.conditions.distance}m / {s.conditions.target.name} / {s.conditions.size??'未知'}cm / {s.conditions.equipment?.name??'器材未知'}</option>)}</ChoiceSelect></Field>
  {conditions.length>1&&activeCondition==='all'&&<p className="notice">包含不同训练条件，图中变化不能直接解释为进步或退步。</p>}
  <p className="caption">横轴为实际记录日期；纵轴：{labels[metric]}（{unit}）。轻点图上的点或下方日期，查看参与计算的场次。</p>
  {points.length?<><Chart option={option} label={`${labels[metric]}趋势；下方表格可选择日期查看来源`} height={310} onSelect={i=>{if(points[i])setSource(points[i].key);}}/><div className="table-scroll"><table><thead><tr><th>日期 / 来源</th><th>{labels[metric]}</th><th>场/箭</th><th>坐标</th></tr></thead><tbody>{points.map(p=><tr key={p.key} className={selected===p.key?'selected-row':''}><td><button className="review-source-link" onClick={()=>setSource(p.key)}>{grain==='session'?new Date(p.date).toLocaleString():p.date}</button></td><td>{shown(p)}</td><td>{p.sessions}/{p.stats.n}</td><td>{p.stats.located}/{p.stats.n}{metric==='fatigue'?`；自评n=${p.fatigueN}`:metric==='energy'?`；自评n=${p.energyN}`:''}</td></tr>)}</tbody></table></div></>:<p>该范围没有已完成记录；空日期不会填成0分。</p>}
  <p className="caption">每期平均按实际箭数加权，成绩比例分母含M。偏向与RMS仅用有坐标的靶内箭；单位为计分半径。自评分母为填写该项的场次数。图形仅描述变化，不推断疲劳、动作或器材原因。</p></Panel>
  {selected&&<Panel title={`${points.find(p=>p.key===selected)?.date.slice(0,10)??''} · 来源场次`}><p>{sources.length}场，{sources.flatMap(allArrows).length}箭参与该点统计；进入详情后返回可继续当前筛选。</p>{sources.map(s=>{const st=statistics(allArrows(s));return <button key={s.id} className="history-row" onClick={()=>open('detail',s.id)}><span><b>{s.name}</b><small>{s.date} · {s.conditions.distance}m · {s.conditions.target.name}</small></span><span>{st.n}箭<br/>{decimal(st.average)}环</span><span>›</span></button>;})}<Button onClick={()=>setSource('')}>收起来源</Button></Panel>}</>;
}
