import React,{useRef} from 'react';
import {localDate,type Session} from './domain';
import {useReviewState} from './review-state';
import {trainingActivity,activityLevel} from './training-activity';

export function TrainingActivity({sessions,open,today=localDate()}:{sessions:Session[];open:(name:string,id?:string)=>void;today?:string}){
 const days=trainingActivity(sessions,today),[selected,setSelected]=useReviewState('training-activity-date',today),buttons=useRef<(HTMLButtonElement|null)[]>([]);
 const chosen=days.find(day=>day.date===selected&&!day.future)??days.find(day=>day.date===today)!,activeDays=days.filter(day=>day.arrows>0).length,total=days.reduce((n,day)=>n+day.arrows,0);
 // Fixed squares read left to right, then continue on the next 14-day row.
 function move(event:React.KeyboardEvent,index:number){const delta=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-14,ArrowDown:14} as Record<string,number>)[event.key];if(delta===undefined)return;event.preventDefault();const next=index+delta;if(days[next]&&!days[next].future){setSelected(days[next].date);buttons.current[next]?.focus();}}
 return <section className="training-activity-region" aria-label="训练热力图">
  <div className="training-activity activity-compact activity-square-matrix">
   <div className="activity-compact-heading"><h2 className="sr-only">训练热力图</h2><span>近12周 · <b>{activeDays}</b>天 · <b>{total}</b>箭</span><div className="activity-legend" aria-label="颜色由浅到深表示每日箭量由少到多"><span>少</span>{[0,1,2,3,4].map(level=><i key={level} className={'level-'+level}/>)}<span>多</span></div></div>
   <div className="activity-square-body"><div><div className="activity-cells" role="group" aria-label="按日期从左到右排列，每行14天；左右逐日，上下跨14天">{days.map((day,index)=><button ref={element=>{buttons.current[index]=element;}} key={day.date} type="button" className={'activity-cell level-'+activityLevel(day.arrows)} disabled={day.future} tabIndex={day.date===chosen.date?0:-1} aria-pressed={day.date===chosen.date} aria-label={day.date+'，'+(day.future?'未来日期':day.arrows+'箭，'+day.sessions.length+'场训练')} title={day.date+' · '+day.arrows+'箭'} onClick={()=>setSelected(day.date)} onKeyDown={event=>move(event,index)}/>)}</div><div className="activity-matrix-range" aria-hidden="true"><span>{days[0].date.slice(5)}</span><span>日期顺序 →</span><span>{today.slice(5)}</span></div></div><div className="activity-picked-summary" aria-live="polite"><small>{chosen.date===today?'今天':chosen.date.slice(5)}</small><b>{chosen.arrows}<small>箭</small></b><span>{chosen.sessions.length}场完成</span></div></div>
   <div className="activity-date-row"><label><span className="sr-only">选择热力图日期</span><input aria-label="选择热力图日期" type="date" min={days[0].date} max={today} value={chosen.date} onChange={event=>{if(days.some(day=>day.date===event.target.value&&!day.future))setSelected(event.target.value);}}/></label><span className="activity-completed-note">每格1天 · 仅已完成</span></div>
  </div>
  <p className="sr-only">仅统计近12个日历周已完成训练，包含M；草稿不计入。方格按日期从左到右逐行排列，每行14天。可用日期输入直接选择；左右键逐日移动，上下键跨14天移动。</p>
  {chosen.sessions.length>0&&<div className="activity-selected-records" aria-label={chosen.date+'训练记录'}>{chosen.sessions.map(session=><button type="button" key={session.id} onClick={()=>open('insights',session.id)}><span>{session.name}</span><span aria-hidden="true">查看复盘 ›</span></button>)}</div>}
 </section>;
}
