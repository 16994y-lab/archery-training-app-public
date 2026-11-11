import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PullToRefresh} from 'antd-mobile';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {Back,Button,Panel,useInnerBack} from './ui';
import {bundledNews,type NewsSnapshot} from './news-feed';
import {categoryLabels,deduplicateNewsRows,newsReadingCopy,newsIsPublished,searchArticles,sourceTranslationFor} from './news-presentation';
import {reviewedEventNews,reviewedEventStoryFor} from './reviewed-event-news';
import {ReviewedImage} from './NewsImage';
import {NewsArticleHeading,NewsParagraphPair,NewsSections,PressStoryRow} from './NewsArticleBody';
import type {NewsArticle} from './news-feed';
import {reviewedDetailFor} from './news-detail-contract';
import bundledNewsDetails from './news-details.v1.json';
import {CompetitionCalendar} from './CompetitionCalendar';
import {bundledCompetitions} from './competition-publication';
import type {CompetitionEvent} from './competition-calendar.types';
import {NewsCompetitionHome} from './NewsCompetitionHome';
import {LiuzhouChampionshipStory,liuzhouReportArticles,liuzhouStoryId} from './LiuzhouChampionshipStory';
import {AppIcon} from './AppIcon';
import './news.css';
import './news-next.css';

const NEWS_NOTICE_MS=3000;
const readingView={query:'',competitionQuery:'',scrollY:0,lastRead:null as string|null};

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
export function OfflineNews({detailDocument=bundledNewsDetails,competitionDay}:{detailDocument?:unknown;competitionDay?:string}={}){
 const params=new URLSearchParams(useLocation().search);
 const competitions=bundledCompetitions.events;
 if(params.get('story')===liuzhouStoryId)return <LiuzhouChampionshipStory/>;
 if(params.get('view')==='calendar'||params.has('event'))return <div className="news-page">{!params.get('event')&&<NewsHeading calendar open={params.get('entry')==='individual'}/>}<CompetitionCalendar events={competitions} day={competitionDay}/></div>;
 return <NewsFeedView detailDocument={detailDocument} competitionDay={competitionDay} competitions={competitions}/>;
}
function NewsFeedView({detailDocument,competitionDay,competitions}:{detailDocument:unknown;competitionDay?:string;competitions:readonly CompetitionEvent[]}){
 const location=useLocation(),navigate=useNavigate();
 const snapshot:NewsSnapshot={feed:bundledNews,checkedAt:null,cached:false};
 const [query,setQuery]=useState(readingView.query);
 const [competitionQuery,setCompetitionQuery]=useState(readingView.competitionQuery);
 const [searchActive,setSearchActive]=useState(false);
 const [notice,setNotice]=useState<{text:string}|null>(null);
 const titleRef=useRef<HTMLHeadingElement>(null),searchRef=useRef<HTMLInputElement>(null),lastRead=useRef<string|null>(readingView.lastRead);
 useEffect(()=>{readingView.query=query;readingView.competitionQuery=competitionQuery;},[query,competitionQuery]);
 useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(null),NEWS_NOTICE_MS);return()=>window.clearTimeout(timer);},[notice]);
 const refresh=async()=>{setNotice({text:'离线版显示内置精选，原文及主办方链接由你点击时打开。'});};
 const params=new URLSearchParams(location.search);
 const selectedId=params.get('id'),moreEvents=params.get('view')==='more-events';
 const fromMeet=Boolean(location.state?.fromMeetDetail);
 const backLabel=fromMeet?'返回赛事详情':'返回资讯';
 const listPeriod=moreEvents?[params.get('year'),params.get('month'),params.get('date')].join('/'):'';
 const article=liuzhouReportArticles.find(item=>item.id===selectedId)??reviewedEventNews.find(item=>item.id===selectedId)??snapshot.feed.articles.find(item=>item.id===selectedId&&newsIsPublished(item));
 useLayoutEffect(()=>{
  if(selectedId){titleRef.current?.focus({preventScroll:true});window.scrollTo(0,0);}
  else if(moreEvents)window.scrollTo(0,0);
  else {document.getElementById(`news-item-${lastRead.current}`)?.focus({preventScroll:true});window.scrollTo(0,readingView.scrollY);}
 },[selectedId,article?.id,moreEvents,listPeriod]);
 const back=()=>{
  if(selectedId&&(fromMeet||location.state?.fromNewsList===selectedId)){navigate(-1);return;}
  const params=new URLSearchParams(location.search);params.delete('id');
  navigate({pathname:location.pathname,search:params.toString()},{replace:true});
 };
 useInnerBack(Boolean(selectedId),back,30);
 const competitionOverview=<NewsCompetitionHome events={competitions} day={competitionDay} keyword={competitionQuery} onKeywordChange={setCompetitionQuery}/>;
 if(moreEvents)return <div className="news-page">{competitionOverview}</div>;
 if(selectedId&&!article)return <div className="news-page"><Back title="资讯详情" label={backLabel} onBack={back}/><Panel><h2 ref={titleRef} tabIndex={-1}>这篇内容暂不可用</h2><p>可返回查看当前可阅读的内容。</p><Button onClick={back}>{backLabel}</Button></Panel></div>;
 if(article){
  const detail=reviewedDetailFor(article,detailDocument,snapshot.detailBaseline??snapshot.feed);
  const copy=newsReadingCopy(article);
  const translation=sourceTranslationFor(article);
  const sources=reviewedEventStoryFor(article)?.sources;
  const sourceTarget=window.Gongxingji?'_self':'_blank';
  return <div className="news-page"><Back title="资讯详情" label={backLabel} onBack={back}/><article className="news-article">
   <NewsArticleHeading title={copy.title} titleRef={titleRef} source={copy.sourceLabel??article.source} date={article.date}/>
   <ReviewedImage article={article} variant="detail"/>
   {translation?<section className="news-reading-section news-source-translation">
    <h2>{translation.title}</h2>
    {translation.sections.map(section=><NewsParagraphPair key={section.title} en={section.original} zh={section.text}/>)}
    <p className="news-translation-credit">{translation.credit} <a href={translation.licenseUrl} target={window.Gongxingji?'_self':'_blank'} rel="noopener noreferrer">CC BY 4.0</a></p>
   </section>:<>
    <section className="news-reading-section"><h2>{copy.leadTitle}</h2><p className="news-article-lead">{copy.summary}</p></section>
    {copy.translationPending&&<p className="news-update-message">中文导读正在整理。</p>}
    <NewsSections navigation={copy.navigation===true} sections={copy.sections.map(section=>({title:section.title,body:section.paragraphs.map((paragraph,index)=><p key={index}>{paragraph}</p>)}))}/>
    {detail?.quote&&<section className="news-source-excerpt"><h2>原文摘句译文</h2><p>{detail.quote.chinese}</p></section>}
   </>}
   <footer className="news-article-source">
    <a className="news-original-link" href={article.url} target={sourceTarget} rel="noopener noreferrer" aria-label={`在浏览器查看${article.source}原文`}>查看原文 <span aria-hidden="true">↗</span></a>
    {!!sources?.length&&<ul className="meet-links" aria-label="其他资料来源">{sources.map(source=><li key={source.url}><a href={source.url} target={sourceTarget} rel="noopener noreferrer">{source.label}<span aria-hidden="true"> ↗</span></a></li>)}</ul>}
   </footer>
  </article></div>;
 }
 const items=searchArticles(deduplicateNewsRows([...liuzhouReportArticles,...reviewedEventNews,...snapshot.feed.articles.filter(newsIsPublished)]),query)
  .sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
 const clearSearch=()=>{setQuery('');searchRef.current?.focus();};
 const searchTag=(tag:string)=>{setQuery(tag);searchRef.current?.focus();};
 const storyRow=(item:NewsArticle)=>{
  const copy=newsReadingCopy(item);
  const params=new URLSearchParams(location.search);params.set('id',item.id);
  const link={id:`news-item-${item.id}`,to:{pathname:location.pathname,search:params.toString()},state:{fromNewsList:item.id},
   onClick:()=>{lastRead.current=item.id;readingView.lastRead=item.id;readingView.scrollY=window.scrollY;}};
  return <PressStoryRow key={item.id} title={copy.title} summary={copy.summary}
   link={link} image={<ReviewedImage article={item} variant="card"/>}
   meta={<>{categoryLabels[item.category]}<span>·</span><time dateTime={item.date}>{item.date}</time></>}/>;
 };
 return <div className="news-page"><PullToRefresh onRefresh={refresh} completeText="" completeDelay={0}>
  <p className="news-update-message" role="status" aria-live="polite">{notice?.text}</p>
  <NewsHeading compact/>{competitionOverview}
  <section className="news-reading-list" aria-label="资讯列表" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setSearchActive(false);}}>
   <div className="press-section-title">
    <h2>{query.trim()?'搜索结果':'全部资讯'}</h2>
    <div className="news-search-field press-inline-search" role="search" aria-label="新闻搜索">
     <input id="news-query" ref={searchRef} type="search" aria-label="搜索新闻" value={query} maxLength={160} placeholder="搜新闻" onFocus={()=>setSearchActive(true)} onChange={event=>setQuery(event.target.value)} autoComplete="off" onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing)clearSearch();}}/>
     {query&&<button type="button" aria-label="清空新闻搜索" onClick={clearSearch}>×</button>}
    </div>
   </div>
   {(searchActive||query.trim())&&<div className="press-topics" aria-label="常用标签"><button type="button" aria-pressed={!query} onClick={clearSearch}>全部</button>{(['赛事','训练','研究'] as const).map(value=><button key={value} type="button" aria-pressed={query===categoryLabels[value]} onClick={()=>searchTag(categoryLabels[value])} aria-label={`搜索${categoryLabels[value]}资讯`}>{categoryLabels[value]}</button>)}</div>}
   {query.trim()&&<p className="news-search-result" role="status" aria-live="polite">找到 {items.length} 篇相关资讯</p>}
   {items.length>0?<ul className="press-list">{items.map(storyRow)}</ul>
    :<Panel className="news-search-empty"><h2>没有找到相关资讯</h2><p>试试“侧桥”“瞄准”或“赛事”，也可以清空搜索查看全部。</p><Button onClick={clearSearch}>清除筛选，查看全部</Button></Panel>}
  </section>
  <details className="news-update-details"><summary>更新情况</summary><p>当前显示内置精选与赛历，未连接正式资讯服务。</p><p>本批整理：{snapshot.feed.reviewedAt}。</p><p>原文与主办方链接由你点击时打开。</p></details>
 </PullToRefresh></div>;
}
