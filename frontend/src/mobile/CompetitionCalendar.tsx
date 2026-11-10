import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Link,useLocation,useNavigate,useSearchParams} from 'react-router-dom';
import {ChoiceSelect} from './ChoiceSelect';
import {Back} from './ui';
import type {CompetitionEvent,CompetitionLinkKind} from './competition-calendar.types';
import './competition-calendar.css';

const week=['一','二','三','四','五','六','日'];
const two=(n:number)=>String(n).padStart(2,'0');
const monthDay=(day:string)=>Number(day.slice(5,7))+'月'+Number(day.slice(8,10))+'日';
const beijingDay=(at:number)=>new Date(at+8*60*60*1000).toISOString().slice(0,10);
const locationText=(e:CompetitionEvent)=>[...new Set([e.province,e.city].filter(Boolean))].join(' · ');

// A deadline published without a time gives no grounds for declaring registration
// closed during that day. Show the published date until the next Beijing day.
function deadlineInfo(value:string|undefined) {
  const match=value?.match(/^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\+08:00)?$/);
  if(!match)return null;
  const [,date,hour,minute,second]=match;
  const midnight=Date.parse(date+'T00:00:00+08:00');
  if(!Number.isFinite(midnight)||beijingDay(midnight)!==date)return null;
  const at=hour===undefined?midnight+86400000:midnight+(Number(hour)*3600+Number(minute)*60+Number(second??0))*1000;
  const clock=hour===undefined?'':' '+hour+':'+minute+(second&&second!=='00'?':'+second:'');
  return {at,short:monthDay(date)+clock,full:date.slice(0,4)+'年'+monthDay(date)+clock+(clock?'（北京时间）':'')};
}
function useCompetitionClock(events:readonly CompetitionEvent[],fixed?:string){
  const [live,setLive]=useState(Date.now);
  useEffect(()=>{
    if(fixed)return;
    const nextDay=Date.parse(beijingDay(live)+'T00:00:00+08:00')+86400000;
    const next=events.reduce((first,e)=>{
      const cutoff=deadlineInfo(e.entryDeadline)?.at;
      return cutoff!==undefined&&cutoff>live?Math.min(first,cutoff):first;
    },nextDay);
    const update=()=>setLive(Date.now());
    const timer=window.setTimeout(update,Math.max(1,next-Date.now()));
    window.addEventListener('focus',update);
    return ()=>{window.clearTimeout(timer);window.removeEventListener('focus',update);};
  },[events,live,fixed]);
  return fixed?Date.parse(fixed.length===10?fixed+'T00:00:00+08:00':fixed):live;
}

function dateText(e:CompetitionEvent) {
  if(!e.startDate) return e.month?`${e.year}年${e.month}月 · 日期待定`:`${e.year}年 · 日期待定`;
  const start=e.startDate.slice(0,4)+'年'+monthDay(e.startDate);
  if(!e.endDate)return start+'起';
  if(e.endDate===e.startDate)return start;
  const end=e.endDate.slice(0,4)===e.startDate.slice(0,4)?monthDay(e.endDate):e.endDate.slice(0,4)+'年'+monthDay(e.endDate);
  return start+' — '+end;
}
function statusOf(e:CompetitionEvent,day:string) {
  if(e.endDate&&e.endDate<day)return e.result||e.links.some(l=>l.kind==='results')?'已结束':'赛期已过';
  if(e.startDate&&e.startDate>day)return '即将举行';
  if(e.startDate&&e.startDate<=day&&e.endDate&&e.endDate>=day)return '赛期内';
  return e.startDate?'已公布开赛日':'赛期待定';
}
function overlapsPeriod(e:CompetitionEvent,year:number,month:number) {
  if(!e.startDate)return e.year===year&&(!month||e.month===month);
  const prefix=month?`${year}-${two(month)}`:String(year);
  return e.startDate.slice(0,prefix.length)<=prefix&&(e.endDate??e.startDate).slice(0,prefix.length)>=prefix;
}
const onDay=(e:CompetitionEvent,date:string)=>Boolean(e.startDate&&e.startDate<=date&&(e.endDate??e.startDate)>=date);
function changeQuery(params:URLSearchParams,changes:Record<string,string>){
  const next=new URLSearchParams(params);
  for(const [key,value] of Object.entries(changes)){if(value)next.set(key,value);else next.delete(key);}
  return next;
}
function SourceLinks({event,kinds}:{event:CompetitionEvent;kinds:CompetitionLinkKind[]}){
  const links=event.links.filter(l=>kinds.includes(l.kind)&&/^https?:\/\//i.test(l.url));
  if(!links.length)return null;
  return <ul className="meet-links">{links.map(l=><li key={l.kind+l.url}><a className={l.kind==='entry'?'meet-entry-link':undefined} href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<span aria-hidden="true"> ↗</span></a></li>)}</ul>;
}
function EventDetail({event:e,day,now,back}:{event:CompetitionEvent;day:string;now:number;back:()=>void}){
  const title=useRef<HTMLHeadingElement>(null);
  const deadline=deadlineInfo(e.entryDeadline);
  const hasSchedule=Boolean(e.format||e.schedule?.length||e.links.some(l=>l.kind==='schedule'));
  const hasCoverage=Boolean(e.result||e.reports?.length||e.links.some(l=>l.kind==='report'||l.kind==='results'));
  useLayoutEffect(()=>{title.current?.focus({preventScroll:true});window.scrollTo(0,0);},[e.id]);
  return <section className="meet-page">
    <Back title="赛事详情" label="返回比赛日历" onBack={back}/>
    <header className="meet-detail-head">
      <p className="meet-kicker">{e.level} <span>·</span> {statusOf(e,day)}</p>
      <h2 ref={title} tabIndex={-1}>{e.name}</h2>
      <p className="meet-date">{dateText(e)}</p>
      <p>{locationText(e)}{e.venue&&' · '+e.venue}</p>
      {e.dateNote&&<small>{e.dateNote}</small>}
    </header>
    <section className="meet-detail-block"><h3>参赛与报名</h3>
      {e.eligibility||e.entryMethod||e.entryDeadline?<dl>
        {e.eligibility&&<><dt>参赛资格</dt><dd>{e.eligibility}</dd></>}
        {e.entryMethod&&<><dt>报名方式</dt><dd>{e.entryMethod}</dd></>}
        {e.entryDeadline&&<><dt>报名截止</dt><dd>{deadline&&now>=deadline.at&&<strong className="meet-closed-label">报名已截止 · </strong>}{deadline?.full??e.entryDeadline}</dd></>}
      </dl>:!e.entryNote&&<p>报名资格和办理方式待核实。</p>}
      {e.entryNote&&<p>{e.entryNote}</p>}
      <SourceLinks event={e} kinds={['notice','rules','entry']}/>
    </section>
    {hasSchedule&&<section className="meet-detail-block"><h3>赛程安排</h3>
      {e.format&&<p>{e.format}</p>}
      {!!e.schedule?.length&&<ul className="meet-updates">{e.schedule.map(item=><li key={item}>{item}</li>)}</ul>}
      <SourceLinks event={e} kinds={['schedule']}/>
    </section>}
    {(hasCoverage||Boolean(e.endDate&&e.endDate<day))&&<section className="meet-detail-block"><h3>赛况与成绩</h3>
      {e.reports?.map(note=><p key={note}>{note}</p>)}
      {e.result&&<p>{e.result}</p>}
      {!hasCoverage&&<p>暂未核到官方成绩。</p>}
      <SourceLinks event={e} kinds={['report','results']}/>
    </section>}
    <p className="meet-checked">最近核对 <time dateTime={e.checkedOn}>{e.checkedOn}</time></p>
  </section>;
}
export function CompetitionCalendar({events,day:fixedDay}:{events:readonly CompetitionEvent[];day?:string}){
  const [params,setParams]=useSearchParams(),location=useLocation(),navigate=useNavigate();
  const last=useRef<{id:string;scroll:number}|null>(null);
  const now=useCompetitionClock(events,fixedDay),day=beijingDay(now);
  const nowYear=Number(day.slice(0,4)),nowMonth=Number(day.slice(5,7));
  const years=[...new Set([nowYear,nowYear+1,...events.flatMap(e=>e.endDate?[e.year,Number(e.endDate.slice(0,4))]:[e.year])])].sort((a,b)=>a-b);
  const requested=Number(params.get('year')),year=years.includes(requested)?requested:nowYear;
  const rawMonth=params.get('month');
  const month=rawMonth!==null&&/^(?:0?[0-9]|1[0-2])$/.test(rawMonth)?Number(rawMonth):(year===nowYear?nowMonth:0);
  const areas=[...new Set(events.map(e=>e.province).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const area=areas.includes(params.get('region')??'')?params.get('region')!:'';
  const selectedId=params.get('event');
  const individual=params.get('entry')==='individual';
  useLayoutEffect(()=>{
    if(!selectedId&&last.current){
      const previous=last.current;last.current=null;
      document.getElementById('meet-'+previous.id)?.focus({preventScroll:true});
      window.scrollTo(0,previous.scroll);
    }
  },[selectedId]);
  const update=(changes:Record<string,string>)=>setParams(changeQuery(params,changes),{replace:true});
  if(selectedId){
    const e=events.find(item=>item.id===selectedId);
    const back=()=>{if(location.state?.fromMeetList===selectedId)navigate(-1);else update({event:''});};
    return e?<EventDetail event={e} day={day} now={now} back={back}/>:<section className="meet-page"><Back title="赛事详情" label="返回比赛日历" onBack={back}/><p>当前赛历没有这场比赛。</p></section>;
  }
  const prefix=`${year}-${two(month)}`;
  const inMonth=events.filter(e=>(!area||e.province===area)&&overlapsPeriod(e,year,month))
    .sort((a,b)=>(a.startDate??`${a.year}-${two(a.month??13)}-32`).localeCompare(b.startDate??`${b.year}-${two(b.month??13)}-32`)||a.name.localeCompare(b.name,'zh-CN'));
  const totalDays=month?new Date(Date.UTC(year,month,0)).getUTCDate():0;
  const offset=month?(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7:0;
  const selectedDate=params.get('date');
  const date=month&&selectedDate&&/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)&&selectedDate.startsWith(prefix+'-')&&Number(selectedDate.slice(-2))>=1&&Number(selectedDate.slice(-2))<=totalDays&&inMonth.some(e=>onDay(e,selectedDate))?selectedDate:'';
  const rows=individual?events.filter(e=>{
    const cutoff=deadlineInfo(e.entryDeadline);
    return (!area||e.province===area)&&e.individualEntryFrom&&e.individualEntryFrom<=day
      &&cutoff&&now<cutoff.at&&(!e.endDate||e.endDate>=day)&&e.links.some(l=>l.kind==='entry');
  }).sort((a,b)=>deadlineInfo(a.entryDeadline)!.at-deadlineInfo(b.entryDeadline)!.at):date?inMonth.filter(e=>onDay(e,date)):inMonth;
  return <section className="meet-page" aria-label="比赛日历">
    {individual&&<div className="meet-open-intro"><h2>个人报名</h2><p>按报名截止时间排列，含跨月比赛。年龄、会员资格和剩余名额以主办方说明为准。</p></div>}
    <div className={'meet-filters'+(individual?' meet-area-only':'')}>
      {!individual&&<>
      <div className="field"><label htmlFor="meet-year">年份</label><ChoiceSelect id="meet-year" aria-label="年份" value={year} onChange={e=>update({year:e.target.value,month:'0',date:''})}>{years.map(y=><option key={y} value={y}>{y}年</option>)}</ChoiceSelect></div>
      <div className="field"><label htmlFor="meet-month">月份</label><ChoiceSelect id="meet-month" aria-label="月份" value={month} onChange={e=>update({month:e.target.value,date:''})}><option value="0">全年</option>{months.map(m=><option key={m} value={m}>{m}月</option>)}</ChoiceSelect></div>
      </>}
      <div className="field"><label htmlFor="meet-region">地区</label><ChoiceSelect id="meet-region" aria-label="地区" value={area} onChange={e=>update({region:e.target.value,date:''})}><option value="">全部地区</option>{areas.map(a=><option key={a}>{a}</option>)}</ChoiceSelect></div>
    </div>
    {!individual&&month>0&&<div className="meet-month">
      <div className="meet-month-head"><h2>{year}年{month}月</h2><small><i aria-hidden="true"/>有赛事</small></div>
      <div className="meet-grid" aria-hidden="true">{week.map(w=><span className="meet-weekday" key={w}>{w}</span>)}</div>
      <div className="meet-grid" aria-label={year+'年'+month+'月日期'}>
        {Array.from({length:offset},(_,i)=><span key={'pad'+i} aria-hidden="true"/>)}
        {Array.from({length:totalDays},(_,i)=>{
          const n=i+1,d=prefix+'-'+two(n),count=inMonth.filter(e=>onDay(e,d)).length;
          return count?<button type="button" className="meet-day meet-active-day" key={d} aria-label={`${month}月${n}日，${count}场赛事`} aria-pressed={date===d} aria-current={d===day?'date':undefined} onClick={()=>update({date:date===d?'':d})}>{n}<i aria-hidden="true"/></button>:<span className="meet-day" aria-current={d===day?'date':undefined} key={d}>{n}</span>;
        })}
      </div>
    </div>}
    <div className="meet-list-heading"><h2>{individual?'报名期内':date?monthDay(date)+'的比赛':month?'本月赛程':year+'年赛程'}</h2><span role="status">{rows.length} 场</span>{!individual&&date&&<button type="button" onClick={()=>update({date:''})}>查看全月</button>}</div>
    {rows.length?<ul className="meet-event-list">{rows.map(e=>{
      const deadline=deadlineInfo(e.entryDeadline);
      const showDeadline=deadline&&(e.endDate?e.endDate>=day:e.year>=nowYear);
      return <li key={e.id}>
      <Link id={'meet-'+e.id} to={{pathname:location.pathname,search:changeQuery(params,{event:e.id}).toString()}} state={{fromMeetList:e.id}} onClick={()=>{last.current={id:e.id,scroll:window.scrollY};}}>
        <span className="meet-row-meta">{e.level} · {statusOf(e,day)}</span>
        <strong>{e.name}</strong><span className="meet-row-info">{dateText(e)} · {locationText(e)}{individual&&e.venue&&' · '+e.venue}</span>
        {individual&&e.eligibility&&<span className="meet-row-eligibility">{e.eligibility}</span>}
        {showDeadline&&<span className={'meet-entry-state'+(now>=deadline.at?' meet-entry-closed':'')}>{now>=deadline.at?'报名已截止':'报名截止 '+deadline.short}</span>}
        <span className="meet-chevron" aria-hidden="true">›</span>
      </Link>
    </li>;})}</ul>:individual?<div className="meet-empty"><p>{area?area+'暂未核到':'暂未核到'}仍在个人报名期内的比赛。</p>
      {area&&<button type="button" onClick={()=>update({region:''})}>查看全部地区</button>}<Link to="/news?view=calendar">浏览比赛日历</Link>
    </div>:<div className="meet-empty"><p>这个时段{area?'在'+area:''}暂未收录赛事。</p>
      {month>0?<button type="button" onClick={()=>update({month:'0',date:''})}>查看全年赛程</button>:area&&<button type="button" onClick={()=>update({region:'',date:''})}>查看全部地区</button>}
    </div>}
  </section>;
}
const months=Array.from({length:12},(_,i)=>i+1);
