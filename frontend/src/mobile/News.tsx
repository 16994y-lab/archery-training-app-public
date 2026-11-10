import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {Back,Button,Panel} from './ui';
import {transport} from './api';
import {bundledNews,createNewsRefresher,NEWS_AUTO_INTERVAL,readNewsCache,type NewsSnapshot} from './news-feed';
import {articleTags,categoryLabels,searchArticles} from './news-presentation';
import {ReviewedImage} from './NewsImage';
import {reviewedDetailFor} from './news-detail-contract';
import bundledNewsDetails from './news-details.v1.json';
import {CompetitionCalendar} from './CompetitionCalendar';
import {domesticEvents} from './events-domestic';
import {internationalEvents} from './events-international';
import {regionalEvents} from './events-regional';
import {AppIcon} from './AppIcon';
import './news.css';
import './news-next.css';

export const newsUpdatesReady=(import.meta as ImportMeta & {env?:Record<string,string>}).env?.VITE_NEWS_UPDATES_READY==='true';
const requestNews=createNewsRefresher({persist:false});
const transientStore:Pick<Storage,'setItem'>={setItem(){}};
let memorySnapshot:NewsSnapshot|null=null;
const onlineNow=()=>navigator.onLine!==false;
const readingView={query:'',scrollY:0,lastRead:null as string|null};
export const newsRuntimeDiagnostics:{lastSuccess:number|null;lastFailure:string|null;networkEvents:number}={lastSuccess:null,lastFailure:null,networkEvents:0};

const competitions=[...domesticEvents,...internationalEvents,...regionalEvents];
function NewsHeading({calendar=false,open=false}:{calendar?:boolean;open?:boolean}){
 return <><header className="press-masthead">
   <div><span className="press-brand">弓行记</span><h1>射箭资讯</h1></div>
   <svg viewBox="0 0 148 90" className="press-mark" aria-hidden="true" fill="none">
    <g stroke="currentColor" transform="rotate(-17 109 47)"><ellipse cx="109" cy="47" rx="31" ry="36"/><ellipse cx="109" cy="47" rx="23" ry="27"/><ellipse cx="109" cy="47" rx="15" ry="18"/><ellipse cx="109" cy="47" rx="7" ry="9"/></g>
    <path d="m19 16 90 31M20 16l-7-9 13 5 4 8-12 1-10-7z" stroke="#396c74" fill="#c4dfdc" strokeLinejoin="round"/><path d="m103 41 6 6-9 1" stroke="#386970"/>
   </svg>
  </header>
  <nav className="news-section-switch" aria-label="资讯栏目">
   <Link to="/news" aria-current={!calendar?'page':undefined}><AppIcon name="book"/>新闻原文</Link>
   <Link to="/news?view=calendar" aria-current={calendar&&!open?'page':undefined}><AppIcon name="calendar"/>比赛日历</Link>
   <Link to="/news?view=calendar&entry=individual" aria-current={calendar&&open?'page':undefined}><AppIcon name="person"/>个人报名</Link>
  </nav></>;
}
export function News({detailDocument=bundledNewsDetails}:{detailDocument?:unknown}={}){
 const params=new URLSearchParams(useLocation().search);
 if(params.get('view')==='calendar')return <div className="news-page">{!params.get('event')&&<NewsHeading calendar open={params.get('entry')==='individual'}/>}<CompetitionCalendar events={competitions}/></div>;
 return <NewsFeedView detailDocument={detailDocument}/>;
}
function NewsFeedView({detailDocument}:{detailDocument:unknown}){
 const location=useLocation(),navigate=useNavigate();
 const [snapshot,setSnapshot]=useState<NewsSnapshot>(()=>{if(memorySnapshot)return memorySnapshot;try{return readNewsCache(localStorage);}catch{return {feed:bundledNews,checkedAt:null,cached:false};}});
 const [network,setNetwork]=useState<'checking'|'ready'|'offline'|'unavailable'>(()=>!onlineNow()?'offline':newsUpdatesReady&&!memorySnapshot?.checkedAt?'checking':'ready');
 const [query,setQuery]=useState(readingView.query),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const state=useRef(snapshot),inFlight=useRef(false),mounted=useRef(true),titleRef=useRef<HTMLHeadingElement>(null),searchRef=useRef<HTMLInputElement>(null),lastRead=useRef<string|null>(readingView.lastRead),networkEpoch=useRef(0);
 useEffect(()=>{readingView.query=query;},[query]);
 const refresh=useCallback(async(manual=false)=>{
  if(!onlineNow()){setNetwork('offline');return;}
  if(!newsUpdatesReady||inFlight.current)return;
  inFlight.current=true;setBusy(true);setMessage('');
  try{const next=await requestNews(transport,state.current,transientStore);const changed=next.feed.revision>state.current.feed.revision;state.current=next;memorySnapshot=next;newsRuntimeDiagnostics.lastSuccess=next.checkedAt;newsRuntimeDiagnostics.lastFailure=null;if(mounted.current){setSnapshot(next);if(onlineNow())setNetwork('ready');setMessage(changed?'已更新资讯。':manual?'目前没有新内容。':'');}}
  catch(e){const error=e instanceof Error?e.message:'unknown';newsRuntimeDiagnostics.lastFailure=error;if(mounted.current){if(error==='刚刚检查过，请稍后再试。'){setMessage('请稍后再试。');setNetwork(n=>n==='ready'?'ready':'unavailable');}else {setNetwork(!onlineNow()?'offline':'unavailable');setMessage('请检查网络状态后重试。');}}}
  finally{inFlight.current=false;if(mounted.current)setBusy(false);}
 },[]);
 useEffect(()=>{mounted.current=true;const check=(force=false)=>{if(onlineNow()&&document.visibilityState==='visible'&&(force||!state.current.checkedAt||Date.now()-state.current.checkedAt>=NEWS_AUTO_INTERVAL))void refresh();};const offline=()=>{networkEpoch.current++;newsRuntimeDiagnostics.networkEvents++;setNetwork('offline');};const online=()=>{networkEpoch.current++;newsRuntimeDiagnostics.networkEvents++;setNetwork(newsUpdatesReady?'checking':'ready');void refresh();};const visibility=()=>check(false);check(!memorySnapshot?.checkedAt);window.addEventListener('offline',offline);window.addEventListener('online',online);document.addEventListener('visibilitychange',visibility);return()=>{mounted.current=false;window.removeEventListener('offline',offline);window.removeEventListener('online',online);document.removeEventListener('visibilitychange',visibility);};},[refresh]);
 const selectedId=new URLSearchParams(location.search).get('id'),article=snapshot.feed.articles.find(item=>item.id===selectedId);
 useLayoutEffect(()=>{
  if(network!=='ready')return;
  if(selectedId){titleRef.current?.focus({preventScroll:true});window.scrollTo(0,0);}
  else {document.getElementById(`news-item-${lastRead.current}`)?.focus({preventScroll:true});window.scrollTo(0,readingView.scrollY);}
 },[selectedId,network]);
 const back=()=>navigate('/news',{replace:true});
 if(network!=='ready')return <div className="news-page news-network-only">{selectedId?<Back title="资讯详情" onBack={back}/>:<NewsHeading/>}<Panel><h2 aria-live="polite">{network==='checking'?'正在连接资讯…':'请检查网络状态'}</h2>{network!=='checking'&&<Button onClick={()=>void refresh(true)} disabled={busy}>重试</Button>}<p role="status">{message}</p></Panel></div>;
 if(selectedId&&!article)return <div className="news-page"><Back title="资讯详情" onBack={back}/><Panel><h2 ref={titleRef} tabIndex={-1}>这篇内容暂不可用</h2><p>可返回列表查看当前可阅读的内容。</p><Button onClick={back}>返回资讯</Button></Panel></div>;
 if(article){
  const detail=reviewedDetailFor(article,detailDocument,snapshot.detailBaseline??snapshot.feed);
  return <div className="news-page"><Back title="资讯详情" onBack={back}/><article className="news-article">
   <h2 ref={titleRef} tabIndex={-1}>{article.title}</h2>
   <div className="news-byline">
    <p className="news-article-meta"><strong>{article.source}</strong><time dateTime={article.date}>{article.date}</time></p>
    <a className="news-original-link" href={article.url} target="_blank" rel="noopener noreferrer" aria-label={`在浏览器阅读${article.source}完整原文`}>阅读完整原文 <span aria-hidden="true">↗</span></a>
   </div>
   <ReviewedImage article={article} variant="detail"/>
   {detail?.quote&&<section className="news-source-excerpt"><h3>原文摘句</h3><blockquote lang="en">{detail.quote.english}</blockquote><p>{detail.quote.chinese}</p></section>}
  </article></div>;
 }
 const items=searchArticles(snapshot.feed.articles,query);
 const clearSearch=()=>{setQuery('');searchRef.current?.focus();};
 const searchTag=(tag:string)=>{setQuery(tag);searchRef.current?.focus();};
 return <div className="news-page"><NewsHeading/>
  <div className="press-toolbar"><div className="news-search" role="search" aria-label="搜索资讯"><label className="news-search-label" htmlFor="news-query">搜索资讯或标签</label><div className="news-search-field"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8.5" cy="8.5" r="5.7"/><path d="m13 13 4 4"/></svg><input id="news-query" ref={searchRef} type="search" value={query} maxLength={160} placeholder="搜标题、来源或主题" onChange={event=>setQuery(event.target.value)} autoComplete="off" onKeyDown={event=>{if(event.key==='Escape')clearSearch();}}/>{query&&<button type="button" aria-label="清空搜索" onClick={clearSearch}>×</button>}</div></div>
   <div className="press-topics" aria-label="常用标签"><button type="button" aria-pressed={!query} onClick={clearSearch}>全部</button>{(['赛事','训练','研究'] as const).map(value=><button key={value} type="button" aria-pressed={query===categoryLabels[value]} onClick={()=>searchTag(categoryLabels[value])} aria-label={`搜索${categoryLabels[value]}资讯`}>{categoryLabels[value]}</button>)}</div></div>
  <p className="news-update-message" role="status" aria-live="polite">{busy?'正在检查更新，当前内容仍可阅读。':message}</p>
  {query.trim()&&<p className="news-search-result" role="status" aria-live="polite">找到 {items.length} 篇相关资讯</p>}
  <section className="news-reading-list" aria-label="资讯列表">
   <div className="press-section-title"><h2>{query.trim()?'搜索结果':'近期选读'}</h2>{newsUpdatesReady&&<button type="button" disabled={busy} onClick={()=>void refresh(true)} aria-label="检查资讯更新">刷新 <span aria-hidden="true">↻</span></button>}</div>
   {items.length?<ul className="press-list">{items.map(item=><li key={item.id}>
    <a id={`news-item-${item.id}`} className="press-story" href={item.url} target="_blank" rel="noopener noreferrer" onClick={()=>{lastRead.current=item.id;readingView.lastRead=item.id;readingView.scrollY=window.scrollY;}} aria-label={`${item.title}，打开${item.source}原文`}>
     <span className="press-story-copy"><span className="press-dateline">{categoryLabels[item.category]}<i aria-hidden="true"/><time dateTime={item.date}>{item.date}</time></span><strong>{item.title}</strong><span className="press-source">{item.source} <span aria-hidden="true">↗</span></span></span><ReviewedImage article={item} variant="card"/>
    </a>{articleTags(item).length>1&&<div className="press-subtopics">{articleTags(item).slice(1).map(tag=><button type="button" key={tag} onClick={()=>searchTag(tag)} aria-label={`按标签搜索：${tag}`}>#{tag}</button>)}</div>}
   </li>)}</ul>:<Panel className="news-search-empty"><h2>没有找到相关资讯</h2><p>试试“侧桥”“瞄准”或“赛事”，也可以清空搜索查看全部。</p><Button onClick={clearSearch}>清空搜索，查看全部</Button></Panel>}
  </section>
  <details className="news-update-details"><summary>更新情况</summary><p>{snapshot.cached?'正在阅读已有缓存。':snapshot.checkedAt?'本次获取的内容仅保留到本次打开结束。':'正在阅读内置精选。'}</p><p>{snapshot.checkedAt?`上次成功检查：${new Date(snapshot.checkedAt).toLocaleString('zh-CN')}`:'尚未成功检查在线更新。'}</p><p>本批整理：{snapshot.feed.reviewedAt}。需要联网阅读资讯。</p></details>
 </div>;
}
