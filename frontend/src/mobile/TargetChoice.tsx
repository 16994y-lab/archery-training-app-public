import React, { useState } from 'react';
import { Selector, SearchBar } from 'antd-mobile';
import { Target } from './domain';
import { Button, Field, NumberInput, Modal } from './ui';

export const COMMON_DISTANCES=[5,10,18,20,25,30,40,50,60,70,90];
export function DistanceChoice({value,onChange}:{value:number;onChange:(n:number)=>void}) {
  const [other,setOther]=useState(!COMMON_DISTANCES.includes(value));
  const [expanded,setExpanded]=useState(false);
  return <section className="condition-choice distance-choice" aria-label="训练距离选择"><h3>训练距离</h3><p className="selection-value">{Number.isFinite(value)?`${value} 米`:'待填写'}</p>
    <Selector columns={4} options={[18,30,50,70].map(n=>({label:`${n} 米`,value:n}))} value={other?[]:[value]} onChange={v=>{if(v.length){setOther(false);onChange(v[0]);}}}/>
    <Button className="subtle-link" onClick={()=>setExpanded(true)}>更多距离 / 自己输入 ›</Button>
    {other&&<Field label="其他距离（米）" hint="可输入小数，须大于0且不超过1000米"><NumberInput min="0.1" max="1000" step="0.1" value={value} onValue={onChange}/></Field>}
    {expanded&&<Modal title="选择训练距离" onClose={()=>setExpanded(false)}><Selector columns={3} options={COMMON_DISTANCES.map(n=>({label:`${n} 米`,value:n}))} value={other?[]:[value]} onChange={v=>{if(v.length){setOther(false);onChange(v[0]);setExpanded(false);}}}/><Button className="wide" onClick={()=>{setOther(true);onChange(NaN);setExpanded(false);}}>其他距离 · 自己输入</Button></Modal>}
  </section>;
}

export function SizeChoice({value,onChange,custom=false}:{value:number|null;onChange:(n:number|null)=>void;custom?:boolean}) {const options=[40,60,80,122];const [other,setOther]=useState(value!==null&&!options.includes(value));return <section className="condition-choice size-choice" aria-label="靶面尺寸选择"><h3>{custom?'计分外圈直径':'靶纸名义尺寸'}</h3><p className="selection-value">{value===null?'尺寸未知':Number.isFinite(value)?`${value} cm`:'待填写'}</p><Selector columns={3} value={[other?'other':value===null?'unknown':String(value)]} options={[{label:'未知',value:'unknown'},...options.map(n=>({label:`${n} cm`,value:String(n)})),{label:'其他尺寸',value:'other'}]} onChange={v=>{if(!v.length)return;setOther(v[0]==='other');onChange(v[0]==='unknown'?null:v[0]==='other'?NaN:Number(v[0]));}}/>{other&&<Field label="其他靶面尺寸（cm）"><NumberInput min={1} max={1000} step="0.1" value={value??NaN} onValue={onChange}/></Field>}<p className="caption">允许未知；未知时不计算厘米级散布。</p></section>;}

export function TargetChoice({value,targets,onChange}:{value:Target;targets:Target[];onChange:(t:Target)=>void}) {const [visible,setVisible]=useState(false),[query,setQuery]=useState(''),[kind,setKind]=useState('all');const shown=targets.filter(t=>(kind==='all'||kind==='single'&&t.face_count===1&&!t.custom||kind==='triple'&&t.face_count===3||kind==='custom'&&t.custom)&&t.name.includes(query));return <><button className="selected-target" onClick={()=>setVisible(true)} aria-label="选择靶型"><TargetPreview target={value}/><span><small>本次靶型</small><b>{value.name}</b><em>查看靶型图库 ›</em></span></button>{visible&&<Modal title="靶型图库" onClose={()=>setVisible(false)}><SearchBar placeholder="搜索靶型" value={query} onChange={setQuery}/><Selector className="target-filter" columns={4} options={[{label:'全部',value:'all'},{label:'单靶',value:'single'},{label:'三联',value:'triple'},{label:'自建',value:'custom'}]} value={[kind]} onChange={v=>v[0]&&setKind(v[0])}/><div className="target-gallery">{shown.map(t=><button key={t.id} className={t.id===value.id?'chosen':''} onClick={()=>{onChange(t);setVisible(false);}} aria-pressed={t.id===value.id}><TargetPreview target={t}/><b>{t.name}</b><span>{t.face_count===3?'保留布局与靶位编号':'同心圆计分规则'}</span></button>)}</div>{!shown.length&&<p>没有符合条件的靶型。</p>}<p className="caption">靶面按规则绘制，选择后再设置尺寸和距离。</p></Modal>}</>;}

/** Rule-drawn paper preview: physical layout is separate from the scoring-radius canvas. */
export function TargetPreview({target}:{target:Target}) {
  const triple=target.face_count>1;
  const w=triple&&target.layout?.kind==='VERTICAL'?180:300,h=triple?300:240;
  const radius=triple?target.layout?.kind==='VERTICAL'?43:58:98;
  const faces=triple?target.layout!.faces:[{index:1,anchor_x:.5,anchor_y:.5}];
  return <svg viewBox={`0 0 ${w} ${h}`} className="target-preview" role="img" aria-label={`${target.name}靶面预览`}>
    <rect x="1" y="1" width={w-2} height={h-2} rx="12" fill="#fff" stroke="#c6d8ed"/>
    {faces.map(f=><g key={f.index} transform={`translate(${f.anchor_x*w} ${f.anchor_y*h})`}>
      {[...(target.ring_rules??[])].reverse().map(r=><circle key={r.score_code} r={r.outer_radius_norm*2*radius} fill={r.color} stroke="#455368" strokeWidth=".6"/>)}
      <path d="M-3 0H3M0-3V3" stroke="#172b43" strokeWidth=".7"/>
      {triple&&<g className="preview-face-number" transform={`translate(${radius*.75} ${radius*.75})`}><circle r="11" fill="#082572"/><text textAnchor="middle" y="4" fill="white" fontSize="12">{f.index}</text></g>}
    </g>)}
  </svg>;
}
