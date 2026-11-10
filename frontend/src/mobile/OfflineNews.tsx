import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PullToRefresh} from 'antd-mobile';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {Back,Button,Panel,useInnerBack} from './ui';
import {AppIcon} from './AppIcon';
import {OfflineCompetitionCalendar} from './OfflineCompetitionCalendar';
import {NewsCompetitionHome} from './NewsCompetitionHome';
import {NewsArticleHeading,NewsParagraphPair,NewsSections,PressStoryRow} from './NewsArticleBody';
import {localCompetitions,localNewsArticles,localNewsReviewedOn,type LocalNewsArticle} from './local-news-snapshot';
import './news.css';
import './offline-news.css';

const readingView={query:'',competitionQuery:'',scrollY:0,lastRead:null as string|null};
const categoryLabels={赛事:'赛事',训练:'训练观察',研究:'研究选读'};
const order=(a:LocalNewsArticle,b:LocalNewsArticle)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id);
const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().trim();

function NewsHeading({calendar=false,open=false,compact=false}:{calendar?:boolean;open?:boolean;compact?:boolean}){
 return <><header className={'press-masthead'+(compact?' press-masthead-compact':'')}>
   <div><span className="press-brand">弓行记</span><h1>射箭资讯</h1></div>
   <svg viewBox="0 0 148 90" className="press-mark" aria-hidden="true" fill="none">
    <g stroke="currentColor" transform="rotate(-17 109 47)"><ellipse cx="109" cy="47" rx="31" ry="36"/><ellipse cx="109" cy="47" rx="23" ry="27"/><ellipse cx="109" cy="47" rx="15" ry="18"/><ellipse cx="109" cy="47" rx="7" ry="9"/></g>
    <path d="m19 16 90 31M20 16l-7-9 13 5 4 8-12 1-10-7z" stroke="#396c74" fill="#c4dfdc" strokeLinejoin="round"/><path d="m103 41 6 6-9 1" stroke="#386970"/>
   </svg>
  </header>
  {!compact&&<nav className="news-section-switch" aria-label="资讯栏目">
   <Link to="/news" aria-current={!calendar?'page':undefined}><AppIcon name="book"/>资讯首页</Link>
   <Link to="/news?view=calendar" aria-current={calendar&&!open?'page':undefined}><AppIcon name="calendar"/>比赛日历</Link>
   <Link to="/news?view=calendar&entry=individual" aria-current={calendar&&open?'page':undefined}><AppIcon name="person"/>个人报名</Link>
  </nav>}</>;
}

export function OfflineNews({competitionDay}:{competitionDay?:string}={}){
 const params=new URLSearchParams(useLocation().search);
 if(params.get('view')==='calendar'||params.has('event')){
  return <div className="news-page">{!params.get('event')&&<NewsHeading calendar open={params.get('entry')==='individual'}/>}<OfflineCompetitionCalendar events={localCompetitions} day={competitionDay}/></div>;
 }
 return <NewsFeedView competitionDay={competitionDay}/>;
}

function NewsFeedView({competitionDay}:{competitionDay?:string}){
 const location=useLocation(),navigate=useNavigate();
 const [query,setQuery]=useState(readingView.query);
 const [competitionQuery,setCompetitionQuery]=useState(readingView.competitionQuery);
 const [searchActive,setSearchActive]=useState(false),[notice,setNotice]=useState(false);
 const titleRef=useRef<HTMLHeadingElement>(null),searchRef=useRef<HTMLInputElement>(null);
 const noticeTimer=useRef<number|undefined>(undefined);
 useEffect(()=>{readingView.query=query;readingView.competitionQuery=competitionQuery;},[query,competitionQuery]);
 useEffect(()=>()=>window.clearTimeout(noticeTimer.current),[]);
 const refresh=async()=>{
  window.clearTimeout(noticeTimer.current);
  setNotice(true);
  noticeTimer.current=window.setTimeout(()=>setNotice(false),3000);
 };
 const params=new URLSearchParams(location.search);
 const selectedId=params.get('id')??params.get('story'),moreEvents=params.get('view')==='more-events';
 const fromMeet=Boolean(location.state?.fromMeetDetail);
 const backLabel=fromMeet?'返回赛事详情':'返回资讯';
 const listPeriod=moreEvents?[params.get('year'),params.get('month'),params.get('date')].join('/'):'';
 const article=localNewsArticles.find(item=>item.id===selectedId);
 useLayoutEffect(()=>{
  if(selectedId){titleRef.current?.focus({preventScroll:true});window.scrollTo(0,0);}
  else if(moreEvents)window.scrollTo(0,0);
  else {document.getElementById(`news-item-${readingView.lastRead}`)?.focus({preventScroll:true});window.scrollTo(0,readingView.scrollY);}
 },[selectedId,moreEvents,listPeriod]);
 const back=()=>{
  if(selectedId&&(fromMeet||location.state?.fromNewsList===selectedId)){navigate(-1);return;}
  const next=new URLSearchParams(location.search);next.delete('id');next.delete('story');
  navigate({pathname:location.pathname,search:next.toString()},{replace:true});
 };
 useInnerBack(Boolean(selectedId),back,30);
 const overview=<NewsCompetitionHome events={localCompetitions} day={competitionDay} keyword={competitionQuery} onKeywordChange={setCompetitionQuery}/>;
 if(moreEvents)return <div className="news-page">{overview}</div>;
 if(selectedId&&!article)return <div className="news-page"><Back title="资讯详情" label={backLabel} onBack={back}/><Panel><h2 ref={titleRef} tabIndex={-1}>本地快照未收录这篇资讯</h2><Button onClick={back}>{backLabel}</Button></Panel></div>;
 if(article)return <div className="news-page"><Back title="资讯详情" label={backLabel} onBack={back}/><article className="news-article">
  <NewsArticleHeading title={article.title} titleRef={titleRef} source={article.source} date={article.date}/>
  {article.image&&<figure className="news-original-figure">
   <img src={article.image.src} alt={article.image.alt} decoding="async"/>
   <figcaption>{article.image.credit} · <a href={article.image.sourceUrl} target="_blank" rel="noopener noreferrer">图片出处</a> · <a href={article.image.licenseUrl} target="_blank" rel="noopener noreferrer">CC BY 4.0</a></figcaption>
  </figure>}
  {article.bilingual?<section className="news-reading-section news-source-translation">
   <h2>双语导读</h2>{article.originalTitle&&<p className="news-original-title" lang="en">{article.originalTitle}</p>}
   {article.bilingual.map(paragraph=><NewsParagraphPair key={paragraph.en} en={paragraph.en} zh={paragraph.zh}/>)}
   <p className="news-translation-credit">英文与中文均为本地整理的导读。DVIDS 原报道标注为公有领域。</p>
  </section>:<section className="news-reading-section"><h2>导读</h2><p className="news-article-lead">{article.summary}</p></section>}
  {article.sections&&<NewsSections sections={article.sections.map(section=>({title:section.title,body:section.paragraphs.map(paragraph=><p key={paragraph}>{paragraph}</p>)}))}/>}
  {article.sources&&<section className="news-reading-section"><h2>相关来源</h2><ul>{article.sources.map(source=><li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.label} ↗</a></li>)}</ul></section>}
  <footer className="news-article-source"><a className="news-original-link" href={article.url} target="_blank" rel="noopener noreferrer">查看原文 <span aria-hidden="true">↗</span></a></footer>
 </article></div>;

 const terms=normalize(query).split(/\s+/).filter(Boolean);
 const items=localNewsArticles.filter(item=>{
  const searchable=normalize([item.title,item.summary,item.source,item.category,categoryLabels[item.category],item.originalTitle,item.bilingual?'双语导读':'',...(item.sections?.flatMap(section=>[section.title,...section.paragraphs])??[])].join(' '));
  return terms.every(term=>searchable.includes(term));
 }).sort(order);
 const clearSearch=()=>{setQuery('');searchRef.current?.focus();};
 const searchTag=(tag:string)=>{setQuery(tag);searchRef.current?.focus();};
 return <div className="news-page"><PullToRefresh onRefresh={refresh} completeText="" completeDelay={0}>
  <button className="news-keyboard-refresh" type="button" onClick={()=>void refresh()}>检查本地资讯</button>
  <p className="news-update-message" role="status" aria-live="polite">{notice?`正在阅读 ${localNewsReviewedOn} 的本地快照。`:''}</p>
  <NewsHeading compact/>{overview}
  <section className="news-reading-list" aria-label="资讯列表" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setSearchActive(false);}}>
   <div className="press-section-title">
    <h2>{query.trim()?'搜索结果':'全部资讯'}</h2>
    <div className="news-search-field press-inline-search" role="search" aria-label="新闻搜索">
     <input id="news-query" ref={searchRef} type="search" aria-label="搜索新闻" value={query} maxLength={160} placeholder="搜新闻" onFocus={()=>setSearchActive(true)} onChange={event=>setQuery(event.target.value)} autoComplete="off" onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing)clearSearch();}}/>
     {query&&<button type="button" aria-label="清空新闻搜索" onClick={clearSearch}>×</button>}
    </div>
   </div>
   {(searchActive||query.trim())&&<div className="press-topics" aria-label="常用标签"><button type="button" aria-pressed={!query} onClick={clearSearch}>全部</button>{Object.values(categoryLabels).map(value=><button key={value} type="button" aria-pressed={query===value} onClick={()=>searchTag(value)} aria-label={`搜索${value}资讯`}>{value}</button>)}</div>}
   {query.trim()&&<p className="news-search-result" role="status" aria-live="polite">找到 {items.length} 篇相关资讯</p>}
   {items.length?<ul className="press-list">{items.map(item=>{
    const next=new URLSearchParams(location.search);next.set('id',item.id);
    return <PressStoryRow key={item.id} title={item.title} summary={item.summary}
     link={{id:`news-item-${item.id}`,to:{pathname:location.pathname,search:next.toString()},state:{fromNewsList:item.id},
      onClick:()=>{readingView.lastRead=item.id;readingView.scrollY=window.scrollY;}}}
     image={item.image&&<span className="news-remote-thumbnail"><img src={item.image.src} alt="" loading="lazy" decoding="async"/></span>}
     meta={<>{item.eventId==='2026-liuzhou-university-championship'?'赛事专题':item.bilingual?'双语导读':categoryLabels[item.category]}<span>·</span><time dateTime={item.date}>{item.date}</time></>}/>;
   })}</ul>:<Panel className="news-search-empty"><h2>没有找到相关资讯</h2><p>试试“柳州”“侧桥”或“DVIDS”，也可以清空搜索查看全部。</p><Button onClick={clearSearch}>清除筛选，查看全部</Button></Panel>}
  </section>
  <details className="news-update-details"><summary>更新情况</summary><p>当前显示 {localNewsReviewedOn} 整理的本地精选和赛历。原文及主办方链接由你点击时打开。</p></details>
 </PullToRefresh></div>;
}
