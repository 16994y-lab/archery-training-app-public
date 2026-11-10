import React, { useMemo, useRef, useState } from 'react';
import { savedCoordinateCoverage } from './analysis-insights';
import { scoreValue, type Arrow, type Session } from './domain';
import { spatialDiameter } from './session-spatial-geometry';
import { decimal } from './statistics';
import { TargetFace } from './TargetFace';
import './session-score-compare.css';

type GroupRange=readonly [number,number];
type Side='a'|'b';
const plotLimit=320;
const groupLabel=(index:number)=>`第 ${index+1} 组`;
const rangeLabel=([from,to]:GroupRange)=>from===to?groupLabel(from):`第 ${from+1}–${to+1} 组`;
const sameRange=(a:GroupRange,b:GroupRange)=>a[0]===b[0]&&a[1]===b[1];

function readRange(session:Session,range:GroupRange,face:number){
  const ends=session.ends.slice(range[0],range[1]+1);
  const arrows=ends.flatMap(end=>end.arrows);
  const coverage=savedCoordinateCoverage({...session,ends});
  const trusted=coverage.trusted.filter(arrow=>arrow.face===face);
  const estimated=coverage.estimated.filter(arrow=>arrow.face===face);
  const inside=trusted.filter(arrow=>arrow.code!=='M');
  const center=inside.length<2?null:{
    x:inside.reduce((sum,arrow)=>sum+arrow.x!,0)/inside.length,
    y:inside.reduce((sum,arrow)=>sum+arrow.y!,0)/inside.length,
  };
  const spread=spatialDiameter(trusted.map(arrow=>({x:arrow.x!,y:arrow.y!})));
  const average=arrows.length?arrows.reduce((sum,arrow)=>sum+scoreValue(arrow.code),0)/arrows.length:null;
  return {arrows:arrows.length,faceArrows:arrows.filter(arrow=>arrow.face===face).length,trusted,estimated,center,spread,average};
}

function offsetText(center:{x:number;y:number}|null,scale:number,unit:string){
  if(!center)return '—';
  const parts=([[center.x,'右','左'],[center.y,'上','下']] as const).flatMap(([value,positive,negative])=>{
    const magnitude=decimal(Math.abs(value)*scale);
    return magnitude==='0.00'?[]:[`${value>0?positive:negative} ${magnitude}`];
  });
  return parts.length?`${parts.join(' · ')} ${unit}`:'居中';
}

function sampledPoints(trusted:Arrow[],estimated:Arrow[]){
  const placed=trusted.slice(-plotLimit);
  const slots=plotLimit-placed.length;
  return slots?placed.concat(estimated.slice(-slots)):placed;
}

export function SessionGroupCompare({session}:{session:Session}){
  const available=useMemo(()=>session.ends.flatMap((end,index)=>end.arrows.length?[index]:[]),[session]);
  return available.length<2?null:<GroupCompare key={session.id} session={session} available={available}/>;
}

function GroupCompare({session,available}:{session:Session;available:number[]}){
  const [ranges,setRanges]=useState<Record<Side,GroupRange>>(()=>({a:[available[0],available[0]],b:[available[1],available[1]]}));
  const [editing,setEditing]=useState<{side:Side;range:GroupRange}|null>(null);
  const [face,setFace]=useState(1);
  const triggers=useRef<Record<Side,HTMLButtonElement|null>>({a:null,b:null});
  const {target,size}=session.conditions;
  const faceNumber=Math.min(face,target.face_count);
  const factor=size!==null&&Number.isFinite(size)&&size>0&&Number.isFinite(target.sizeRatio)&&target.sizeRatio>0?size*target.sizeRatio/2:null;
  const scale=factor??1,unit=factor===null?'计分半径':'cm';
  const valid=(range:GroupRange)=>available.includes(range[0])&&available.includes(range[1])&&range[0]<=range[1];
  const aRange:GroupRange=valid(ranges.a)?ranges.a:[available[0],available[0]];
  const fallbackB=available[0]===aRange[0]&&aRange[0]===aRange[1]?available[1]:available[0];
  const bRange:GroupRange=valid(ranges.b)&&!sameRange(ranges.b,aRange)?ranges.b:[fallbackB,fallbackB];
  const a=useMemo(()=>readRange(session,aRange,faceNumber),[session,aRange[0],aRange[1],faceNumber]);
  const b=useMemo(()=>readRange(session,bRange,faceNumber),[session,bRange[0],bRange[1],faceNumber]);
  const pair={a:aRange,b:bRange};
  const values={a,b};
  const overlap=available.filter(index=>index>=Math.max(aRange[0],bRange[0])&&index<=Math.min(aRange[1],bRange[1]));
  const other=editing?.side==='a'?bRange:aRange;
  const draft=editing&&(valid(editing.range)?editing.range:pair[editing.side]);
  const identical=draft&&sameRange(draft,other);
  const axes=target.face_count>1?`${faceNumber} 号靶位`:'同一尺度';
  return <section id="session-group-compare" className="vx-card session-group-compare">
    <div className="session-score-heading"><h2>同组对比</h2><small>{axes}</small></div>
    {target.face_count>1&&<label className="session-group-face">靶位<select value={faceNumber} onChange={event=>setFace(Number(event.target.value))}>
      {Array.from({length:target.face_count},(_,index)=><option value={index+1} key={index}>{index+1} 号靶</option>)}
    </select></label>}
    <div className="session-group-targets">
      {(['a','b'] as const).map(side=>{
        const value=values[side],points=sampledPoints(value.trusted,value.estimated);
        return <div key={side} className="session-group-side" data-side={side}>
          <button ref={element=>{triggers.current[side]=element;}} type="button" className="vx-button session-group-pick" aria-label={`${side.toUpperCase()} 组别范围，${rangeLabel(pair[side])}`} aria-expanded={editing?.side===side} aria-controls={editing?.side===side?'session-group-range':undefined} onClick={()=>setEditing(editing?.side===side?null:{side,range:pair[side]})}>
            <b>{side.toUpperCase()} · {rangeLabel(pair[side])}</b><small>{value.arrows} 箭　▾</small>
          </button>
          <TargetFace target={target} face={faceNumber} arrows={points} review/>
          <small className="session-group-coverage">{value.trusted.length}/{value.faceArrows} 个可信落点{value.estimated.length>0&&` · ${value.estimated.length} 个照片参考`}</small>
        </div>;
      })}
    </div>
    {editing&&draft&&<fieldset id="session-group-range" className="session-group-range">
      <legend>{editing.side.toUpperCase()} 组别范围</legend>
      <label>起始<select value={draft[0]} onChange={event=>{const from=Number(event.target.value);setEditing({...editing,range:[from,Math.max(from,draft[1])]});}}>
        {available.map(index=><option key={index} value={index}>{groupLabel(index)}</option>)}
      </select></label>
      <label>结束<select value={draft[1]} onChange={event=>setEditing({...editing,range:[draft[0],Number(event.target.value)]})}>
        {available.filter(index=>index>=draft[0]).map(index=><option key={index} value={index}>{groupLabel(index)}</option>)}
      </select></label>
      {identical&&<small role="status">请选择不同的组别范围</small>}
      <button type="button" className="vx-button" disabled={Boolean(identical)} onClick={()=>{setRanges({...pair,[editing.side]:draft});setEditing(null);triggers.current[editing.side]?.focus({preventScroll:true});}}>应用</button>
    </fieldset>}
    {overlap.length>0&&<p className="vx-state">两侧都包含{rangeLabel([overlap[0],overlap[overlap.length-1]])}</p>}
    <table className="session-group-results">
      <thead><tr><th scope="col">指标</th><th scope="col">A</th><th scope="col">B</th></tr></thead>
      <tbody>
        <tr><th scope="row">偏移</th><td>{offsetText(a.center,scale,unit)}</td><td>{offsetText(b.center,scale,unit)}</td></tr>
        <tr><th scope="row">散布</th>{[a,b].map((value,index)=><td key={index}>{value.spread===null?'—':`${decimal(value.spread*scale)} ${unit}`}</td>)}</tr>
        <tr><th scope="row">均环</th><td>{decimal(a.average)}</td><td>{decimal(b.average)}</td></tr>
      </tbody>
    </table>
    {!a.trusted.length&&!b.trusted.length&&<p className="vx-state">当前靶位无可信落点。</p>}
    {[a,b].some(side=>side.trusted.length+side.estimated.length>plotLimit)&&<p className="vx-state">每侧最多显示 {plotLimit} 个点 · 统计使用全部可信落点</p>}
  </section>;
}
