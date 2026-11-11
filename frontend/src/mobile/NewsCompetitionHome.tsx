import {useRef,useState} from 'react';
import {Link,useLocation,useNavigate,useSearchParams} from 'react-router-dom';
import {beijingDay,deadlineInfo,locationText,onDay,overlapsPeriod,useCompetitionClock} from './CompetitionCalendar';
import {bundledCompetitions} from './competition-publication';
import {furryImage} from './avatar-local';
import {Back,Modal,useInnerBack} from './ui';
import {ChoiceSelect} from './ChoiceSelect';
import type {CompetitionEvent} from './competition-calendar.types';

type Scope='domestic'|'international';
type Region={scope:Scope;area:string;city:string};
const week=['一','二','三','四','五','六','日'];
const months=Array.from({length:12},(_,index)=>index+1);
const regionName=(event:CompetitionEvent)=>event.country??event.province;
const scopeOf=(event:CompetitionEvent):Scope=>event.country?'international':'domestic';
const chineseOrder=(a:string,b:string)=>a.localeCompare(b,'zh-CN');
const twoDigits=(number:number)=>String(number).padStart(2,'0');

function RegionPicker({events,selected,onSelect,onClose}:{events:readonly CompetitionEvent[];selected:Region|null;onSelect:(region:Region|null)=>void;onClose:()=>void}){
  const [scope,setScope]=useState<Scope>(selected?.scope??'domestic');
  const [draftArea,setDraftArea]=useState(selected?.area??'');
  const scoped=events.filter(event=>scopeOf(event)===scope);
  const areas=[...new Set(scoped.map(regionName))].sort(chineseOrder);
  const area=areas.includes(draftArea)?draftArea:areas[0];
  const cities=[...new Set(scoped.filter(event=>regionName(event)===area).map(event=>event.city).filter(Boolean))].sort(chineseOrder);
  const active=selected?.scope===scope&&selected.area===area;
  const choose=(city:string)=>{if(area)onSelect({scope,area,city});};
  const changeScope=(next:Scope)=>{setScope(next);setDraftArea(selected?.scope===next?selected.area:'');};
  return <Modal title="地区检索" onClose={onClose}>
    <div className="event-region-picker">
      <div className="event-region-tabs" role="group" aria-label="赛事范围">
        <button type="button" aria-pressed={scope==='domestic'} onClick={()=>changeScope('domestic')}>国内</button>
        <button type="button" aria-pressed={scope==='international'} onClick={()=>changeScope('international')}>国际</button>
      </div>
      {area?<div className="event-region-columns">
        <section aria-label={scope==='domestic'?'省份或地区':'国家'}><h3>{scope==='domestic'?'省份或地区':'国家'}</h3>
          {areas.map(value=><button key={value} type="button" aria-pressed={value===area} onClick={()=>setDraftArea(value)}>{value}</button>)}
        </section>
        <section aria-label="城市"><h3>城市</h3>
          <button type="button" aria-pressed={active&&selected?.city===''} onClick={()=>choose('')}>全部城市</button>
          {cities.map(city=><button key={city} type="button" aria-pressed={active&&selected?.city===city} onClick={()=>choose(city)}>{city}</button>)}
        </section>
      </div>:<p>这一范围暂无收录地区。</p>}
      <button type="button" className="event-region-reset" onClick={()=>onSelect(null)}>全部地区</button>
    </div>
  </Modal>;
}

function dateRange(start:string,end?:string){
  const short=(date:string)=>`${Number(date.slice(5,7))}.${Number(date.slice(8,10))}`;
  if(!end||end===start)return short(start);
  return `${short(start)}–${start.slice(0,7)===end.slice(0,7)?Number(end.slice(8,10)):short(end)}`;
}

function UpcomingCard({event,now,cutoff}:{event:CompetitionEvent;now:number;cutoff:ReturnType<typeof deadlineInfo>}){
  const [params]=useSearchParams();
  const closed=Boolean(cutoff&&now>=cutoff.at);
  const location=locationText(event);
  const bundled=bundledCompetitions.events.find(item=>item.id===event.id);
  const eligibilitySummary=event.eligibilitySummary??(bundled?.eligibility===event.eligibility?bundled?.eligibilitySummary:undefined);
  const detail=new URLSearchParams(params);
  detail.set('event',event.id);
  return <article className="event-front-card" data-event={event.id}>
    <header>
      <p className="event-front-meta"><span>{event.country?'海外':'国内'}</span><span className="event-front-date">{event.startDate?dateRange(event.startDate,event.endDate):'日期待定'}</span></p>
      <h3 title={event.name}>{event.name}</h3>
      <p className="event-front-location" title={location}>{location}</p>
    </header>
    <dl className="event-front-entry">
      <div className={'event-front-cutoff'+(closed?' event-front-closed':'')}>
        <dt>报名截止</dt>
        <dd>{cutoff?<>
          <time dateTime={event.entryDeadline}>{cutoff.dateAndTime}</time>
          {cutoff.zoneLabel&&<small>{cutoff.zoneLabel}</small>}
          {closed&&<small>已截止</small>}
        </>:'待公布'}</dd>
      </div>
      <div className="event-front-qualification">
        <dt>报名资格</dt><dd title={event.eligibility}>{eligibilitySummary??event.eligibility??'待公布'}</dd>
      </div>
      <div className="event-front-qualification"><dt>现场观赛</dt><dd>{event.endDate&&event.endDate<beijingDay(now)?'赛期已过':event.spectator?.status??'入场待确认'}</dd></div>
      <div className="event-front-qualification event-front-broadcast"><dt>官方直播</dt><dd title={event.spectator?.liveStream}>{event.spectator?.liveStream??'暂未核实'}</dd></div>
    </dl>
    <div className="event-front-detail-anchor">
      <Link className="event-front-detail" to={{search:detail.toString()}} state={{fromMeetList:event.id,fromOverview:true}} aria-label={event.name+'赛事详情'}><span>详情 <span aria-hidden="true">›</span></span></Link>
    </div>
  </article>;
}

export function NewsCompetitionHome({events,day,keyword,onKeywordChange}:{events:readonly CompetitionEvent[];day?:string;keyword:string;onKeywordChange:(value:string)=>void}){
  const [regionOpen,setRegionOpen]=useState(false);
  const [params,setParams]=useSearchParams();
  const location=useLocation(),navigate=useNavigate();
  const searchRef=useRef<HTMLInputElement>(null);
  const more=params.get('view')==='more-events';
  const activeKeyword=more?(params.get('query')??'').slice(0,80):keyword;
  const terms=activeKeyword.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const now=useCompetitionClock(events,day);
  const today=beijingDay(now),currentYear=Number(today.slice(0,4));
  const years=[...new Set([currentYear,currentYear+1,...events.flatMap(e=>e.endDate?[e.year,Number(e.endDate.slice(0,4))]:[e.year])])].sort((a,b)=>a-b);
  const year=years.includes(Number(params.get('year')))?Number(params.get('year')):currentYear;
  const rawMonth=params.get('month');
  const month=rawMonth==='0'||months.includes(Number(rawMonth))?Number(rawMonth):Number(today.slice(5,7));
  const prefix=`${year}-${twoDigits(month)}-`;
  const totalDays=month?new Date(Date.UTC(year,month,0)).getUTCDate():0;
  const offset=month?(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7:0;
  const dates=Array.from({length:totalDays},(_,index)=>index+1);
  const rawDate=params.get('date');
  const selectedDay=dates.find(value=>rawDate===prefix+twoDigits(value));
  const selectedDate=selectedDay?prefix+twoDigits(selectedDay):'';
  const rawArea=params.get('region'),rawScope=params.get('scope'),rawCity=params.get('city');
  const regionEvents=rawArea?events.filter(e=>regionName(e)===rawArea&&(!rawScope||scopeOf(e)===rawScope)):[];
  const region:Region|null=rawArea&&regionEvents.length?{area:rawArea,scope:scopeOf(regionEvents[0]),city:rawCity&&regionEvents.some(e=>e.city===rawCity)?rawCity:''}:null;
  const inMonth=events.filter(event=>{
    if(region&&(scopeOf(event)!==region.scope||regionName(event)!==region.area||region.city&&event.city!==region.city))return false;
    if(!overlapsPeriod(event,year,month))return false;
    const searchable=[event.name,event.country,event.province,event.city,event.venue].join(' ').normalize('NFKC').toLowerCase();
    return terms.every(term=>searchable.includes(term));
  });
  const monthRows=inMonth.map(event=>({event,cutoff:deadlineInfo(event)}))
    .sort((a,b)=>{
      const aTime=a.cutoff?.at??Infinity,bTime=b.cutoff?.at??Infinity;
      const aGroup=a.cutoff?(aTime>now?0:1):2,bGroup=b.cutoff?(bTime>now?0:1):2;
      return aGroup-bGroup||(aTime===bTime?0:aTime-bTime)||(a.event.startDate??'9999').localeCompare(b.event.startDate??'9999')||chineseOrder(a.event.name,b.event.name);
    });
  const upcoming=selectedDate?monthRows.filter(({event})=>onDay(event,selectedDate)):monthRows;
  const update=(values:Record<string,string>)=>{
    const next=new URLSearchParams(params);
    for(const [key,value] of Object.entries(values)){if(value)next.set(key,value);else next.delete(key);}
    setParams(next,{replace:true,state:location.state});
  };
  const chooseRegion=(next:Region|null)=>{setRegionOpen(false);update({region:next?.area??'',scope:next?.scope??'',city:next?.city??''});};
  const clearKeyword=()=>{onKeywordChange('');searchRef.current?.focus();};
  const back=()=>{if(location.state?.fromOverview)navigate(-1);else update({view:'',query:''});};
  useInnerBack(more,back,30);
  const periodTitle=month?`${month}月比赛`:`${year}年比赛`;
  const monthParams=new URLSearchParams(params);
  monthParams.set('view','more-events');
  monthParams.set('year',String(year));
  monthParams.set('month',String(month));
  monthParams.set('query',activeKeyword.trim());
  monthParams.delete('date');
  const periodFilters=<>
    <ChoiceSelect aria-label="年份" value={year} onChange={e=>update({year:e.target.value,month:String(month),date:''})}>{years.map(value=><option key={value} value={value}>{value}年</option>)}</ChoiceSelect>
    <ChoiceSelect aria-label="月份" value={month} onChange={e=>update({year:String(year),month:e.target.value,date:''})}><option value="0">全年</option>{months.map(value=><option key={value} value={value}>{value}月</option>)}</ChoiceSelect>
  </>;
  if(more){
    const title=selectedDay?`${month}月${selectedDay}日比赛`:periodTitle;
    return <section className="event-front-more-page" aria-label={title}>
      <Back title={title} label="返回资讯首页" onBack={back}/>
      <div className="event-date-filters event-month-list-filters" role="group" aria-label="切换比赛年月">{periodFilters}</div>
      <div className="event-more-tools">
        <p className="event-more-context">{[`${year}年`,`共 ${upcoming.length} 场`,region?.area,region?.city,activeKeyword.trim()].filter(Boolean).join(' · ')}</p>
        {selectedDate&&<Link to={{search:monthParams.toString()}} replace state={location.state}>查看{periodTitle}</Link>}
        {(region||terms.length>0)&&<button type="button" onClick={()=>update({region:'',scope:'',city:'',query:''})}>清除筛选</button>}
      </div>
      {upcoming.length?<div className="event-front-more-list">{upcoming.map(({event,cutoff})=><UpcomingCard key={event.id} event={event} now={now} cutoff={cutoff}/>)}</div>:<p className="event-front-empty" role="status">{region||terms.length?'当前筛选没有匹配的比赛。':selectedDate?'这天暂无收录比赛。':month?'这个月暂无收录比赛。':'这一年暂无收录比赛。'}</p>}
    </section>;
  }
  return <section className="event-front-section" aria-labelledby="upcoming-events-title">
    <div className="event-front-heading"><h2 id="upcoming-events-title">比赛速览</h2><Link to="/news?view=calendar&entry=individual">个人报名</Link></div>
    <div className="event-overview">
      <div className={'event-overview-left'+(month?'':' event-overview-year')}>
        {month>0?<div className="event-overview-calendar" aria-label={`${year}年${month}月比赛日历`}>
          <div className="event-month-heading"><h3>{year} 年 {month} 月</h3><span>有比赛</span></div>
          <div className="event-month-week" aria-hidden="true">{week.map(value=><span key={value}>{value}</span>)}</div>
          <ol className="event-month-days" aria-label="本月日期">
            {dates.map(value=>{
              const date=prefix+twoDigits(value);
              const daily=new URLSearchParams(monthParams);
              daily.set('date',date);
              const count=inMonth.filter(event=>onDay(event,date)).length;
              return <li key={value} style={value===1?{gridColumnStart:offset+1}:undefined} className={count?'event-month-active':undefined}>
                <Link to={{search:daily.toString()}} state={{fromOverview:true}} aria-current={date===today?'date':undefined} aria-label={`${month}月${value}日，${count}场比赛`} className={date===selectedDate?'event-month-selected':undefined}>{value}</Link>
              </li>;
            })}
          </ol>
        </div>:<div className="event-overview-calendar">
          <div className="event-month-heading"><h3>{year} 年全年</h3><span>{monthRows.length} 场比赛</span></div>
        </div>}
        <div className="news-search-field event-keyword-search" role="search" aria-label="比赛搜索">
          <input ref={searchRef} type="search" aria-label="搜索比赛" placeholder="搜比赛或地点" maxLength={80} autoComplete="off" value={keyword} onChange={event=>onKeywordChange(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing)clearKeyword();}}/>
          {keyword&&<button type="button" aria-label="清空比赛搜索" onClick={clearKeyword}>×</button>}
        </div>
        <div className="event-overview-filters">
          <span id="event-region-label">地区检索</span>
          <button type="button" className="event-region-trigger" aria-labelledby="event-region-label event-region-value" aria-haspopup="dialog" aria-expanded={regionOpen} onClick={()=>setRegionOpen(true)}><span id="event-region-value">{region?[region.area,region.city].filter(Boolean).join(' · '):'全部地区'}</span><span aria-hidden="true">⌄</span></button>
          <span id="event-date-label">日期检索</span>
          <div className={'event-date-filters'+(month?'':' event-month-list-filters')} role="group" aria-labelledby="event-date-label">
            {periodFilters}
            {month>0&&<ChoiceSelect aria-label="日期" value={selectedDay??''} onChange={e=>update({date:e.target.value?prefix+twoDigits(Number(e.target.value)):''})}><option value="">全月</option>{dates.map(value=><option key={value} value={value}>{value}日</option>)}</ChoiceSelect>}
          </div>
        </div>
      </div>
      <div className="event-overview-cards" aria-label="比赛摘要">
        {upcoming.slice(0,2).map(({event,cutoff})=><UpcomingCard key={event.id} event={event} now={now} cutoff={cutoff}/>)}
        {upcoming.length<2&&<div className="event-front-mascot" role="status">
          <img src={furryImage('furry-arctic-fox')} alt="" width="84" height="84"/>
          <strong>只有这些啦</strong>
          {!upcoming.length&&<small>当前筛选没有比赛</small>}
        </div>}
      </div>
      <Link className="event-front-more" to={{search:monthParams.toString()}} state={{fromOverview:true}}>查看{periodTitle} · {monthRows.length} 场</Link>
    </div>
    {regionOpen&&<RegionPicker events={events} selected={region} onSelect={chooseRegion} onClose={()=>setRegionOpen(false)}/>}
  </section>;
}
