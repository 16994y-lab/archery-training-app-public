import React from 'react';
import { localDate, Session, allArrows } from './domain';
import { Button } from './ui';
import { useReviewState } from './review-state';

export function HistoryCalendar({sessions,selected,onSelect}:{sessions:Session[];selected:string;onSelect:(day:string)=>void}) {
  const [month,setMonth]=useReviewState('calendar-month',localDate().slice(0,7));
  const parsed=new Date(month+'-01T12:00:00'),valid=Number.isFinite(parsed.getTime())?parsed:new Date();
  const first=new Date(valid.getFullYear(),valid.getMonth(),1),offset=(first.getDay()+6)%7,days=new Date(valid.getFullYear(),valid.getMonth()+1,0).getDate();
  const byDate=new Map<string,Session[]>();sessions.forEach(s=>byDate.set(s.date,[...(byDate.get(s.date)??[]),s]));
  const shift=(n:number)=>setMonth(localDate(new Date(first.getFullYear(),first.getMonth()+n,1)).slice(0,7));
  return <div className="review-calendar"><div className="line"><Button aria-label="记录日历上个月" onClick={()=>shift(-1)}>‹</Button><h3>{first.getFullYear()}年 {first.getMonth()+1}月</h3><Button aria-label="记录日历下个月" onClick={()=>shift(1)}>›</Button></div><div className="review-calendar-grid">{['一','二','三','四','五','六','日'].map(d=><span key={d} className="weekday">{d}</span>)}{Array.from({length:offset},(_,i)=><span key={'blank'+i}/>)}{Array.from({length:days},(_,i)=>{const key=localDate(new Date(first.getFullYear(),first.getMonth(),i+1)),items=byDate.get(key)??[],arrows=items.flatMap(allArrows).length;return <button key={key} className={`${selected===key?'selected':''} ${items.length?'recorded':''} ${key===localDate()?'today':''}`} aria-pressed={selected===key} aria-label={`${key}，${items.length}场，${arrows}箭`} onClick={()=>onSelect(selected===key?'':key)}><b>{i+1}</b><small>{items.length?`${items.length}场`:''}</small></button>;})}</div><p className="caption">按训练日期标记真实完成记录；日期选择可再次轻点取消。{selected&&` 当前：${selected}`}</p></div>;
}
