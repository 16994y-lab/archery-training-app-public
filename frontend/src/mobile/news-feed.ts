import bundled from './news-feed.v1.json';
import manualDetails from './news-details.v1.json';
const canonical=(v:unknown):string=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,JSON.parse(canonical(x))])):v);
export type NewsCategory='赛事'|'训练'|'研究';
export type NewsArticle={id:string;category:NewsCategory;title:string;date:string;source:string;summary:string;paragraphs:string[];url:string;attribution?:string;doi?:string};
export type NewsFeed={schema:1;revision:number;reviewedAt:string;articles:NewsArticle[]};
const hosts=new Set(['www.sport.gov.cn','www.worldarchery.sport','www.frontiersin.org','journals.plos.org']);
const validDate=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
export function parseNewsFeed(raw:unknown):NewsFeed{
 const feed=raw as NewsFeed;
 if(new TextEncoder().encode(JSON.stringify(raw)).length>180000)throw new Error('资讯文件过大');
 if(!feed||feed.schema!==1||!Number.isSafeInteger(feed.revision)||feed.revision<1||!validDate(feed.reviewedAt)||!Array.isArray(feed.articles)||!feed.articles.length||feed.articles.length>100)throw new Error('资讯格式不支持');
 const ids=new Set<string>(),urls=new Set<string>(),dois=new Set<string>();
 for(const a of feed.articles){
  if(!a||!text(a.id,80)||!/^[a-z0-9-]+$/.test(a.id)||!['赛事','训练','研究'].includes(a.category)||!text(a.title,160)||!validDate(a.date)||a.date>feed.reviewedAt||!text(a.source,160)||!text(a.summary,600)||!Array.isArray(a.paragraphs)||!a.paragraphs.length||a.paragraphs.length>12||a.paragraphs.some(p=>!text(p,1200)))throw new Error('资讯条目不完整');
  const url=new URL(a.url);if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.port||url.hash)throw new Error('资讯来源未通过核对');
  if(ids.has(a.id)||urls.has(url.href))throw new Error('资讯重复');ids.add(a.id);urls.add(url.href);
  if(a.doi!==undefined){if(!/^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i.test(a.doi)||dois.has(a.doi.toLowerCase()))throw new Error('论文标识重复或无效');dois.add(a.doi.toLowerCase());}
  if(a.attribution!==undefined&&!text(a.attribution,400))throw new Error('署名无效');
 }
 return {...feed,articles:[...feed.articles].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id))};
}
export const bundledNews:NewsFeed={...bundled,schema:1};
export const newsAutoReady=(import.meta as ImportMeta & {env?:Record<string,string>}).env?.VITE_NEWS_AUTO_READY==='true';
export const NEWS_FEED_URL=newsAutoReady?'https://service-1.example.invalid/api/news/publication.v1.json':'https://service-1.example.invalid/news-feed.v1.json';
export const NEWS_CACHE_KEY='gongxingji-reviewed-news-v1';
export const NEWS_MAX_BYTES=180000;
export const NEWS_AUTO_INTERVAL=24*60*60*1000;
export type NewsSnapshot={feed:NewsFeed;checkedAt:number|null;cached:boolean;detailBaseline?:NewsFeed};
const latestReviewDate=(now:number)=>new Date(Math.max(now,Date.parse(bundledNews.reviewedAt+'T23:59:59Z'))).toISOString().slice(0,10);
export function readNewsCache(storage:Pick<Storage,'getItem'>,now=Date.now()):NewsSnapshot{
 try{const raw=storage.getItem(NEWS_CACHE_KEY);if(!raw||raw.length>NEWS_MAX_BYTES)throw Error();const value=JSON.parse(raw),feed=parseNewsFeed(value.feed);if(feed.revision<bundledNews.revision||feed.reviewedAt>latestReviewDate(now)||!Number.isFinite(value.checkedAt)||value.checkedAt<=0||value.checkedAt>now)throw Error();return {feed,checkedAt:value.checkedAt,cached:true};}catch{return {feed:bundledNews,checkedAt:null,cached:false};}
}
/** Public reviewed text only. Caller supplies transport; no session or training data. */
export async function fetchReviewedNews(http:(url:string,options:RequestInit)=>Promise<Response>,prior:NewsSnapshot,storage:Pick<Storage,'setItem'>,now=Date.now(),persist=true):Promise<NewsSnapshot>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await http(NEWS_FEED_URL,{method:'GET',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
  if(!response.ok)throw new Error('暂时无法检查更新，已保留原有内容');
  const raw=await response.text();if(new TextEncoder().encode(raw).length>NEWS_MAX_BYTES)throw new Error('资讯文件过大，已保留原有内容');
  const publication=JSON.parse(raw);
  const feed=parseNewsFeed(newsAutoReady?publication.feed:publication);
  let detailBaseline:NewsFeed|undefined;
  if(newsAutoReady){
   const baseline=parseNewsFeed(publication.detailBaseline);
   if(publication.schema!=='gxj-news-publication-v1'||canonical(baseline)!==canonical(bundledNews)||canonical(publication.details)!==canonical(manualDetails)||baseline.articles.some(a=>!feed.articles.some(b=>canonical(a)===canonical(b))))throw new Error('已有正文绑定不一致，已保留原有内容');
   const automatic=feed.articles.filter(a=>!baseline.articles.some(b=>b.id===a.id));
   if(!Array.isArray(publication.provenance)||publication.provenance.length!==automatic.length||new Set(publication.provenance.map((p:{id:string})=>p.id)).size!==automatic.length||automatic.some(a=>a.category!=='赛事'||!/^auto-[a-f0-9]{24}$/.test(a.id)||!['www.worldarchery.sport','www.sport.gov.cn'].includes(new URL(a.url).hostname)||!publication.provenance.some((p:{id:string;url:string;date:string;mode:string;humanApproved:boolean;sourceSHA256:string})=>p.id===a.id&&p.url===a.url&&p.date===a.date&&p.mode==='automatic-brief'&&p.humanApproved===false&&/^[a-f0-9]{64}$/.test(p.sourceSHA256))))throw new Error('自动快讯来源未通过核对，已保留原有内容');
   detailBaseline=baseline;
  }
  const latestDate=latestReviewDate(now);
  if(feed.reviewedAt>latestDate)throw new Error('资讯日期未通过核对，已保留原有内容');
  if(feed.revision<prior.feed.revision)throw new Error('更新版本较旧，已保留原有内容');
  if(feed.revision===prior.feed.revision&&canonical(feed)!==canonical(prior.feed))throw new Error('资讯版本不一致，已保留原有内容');
  const result={feed,checkedAt:now,cached:persist,...(detailBaseline?{detailBaseline}:{})};
  if(persist)try{storage.setItem(NEWS_CACHE_KEY,JSON.stringify(result));}catch{throw new Error('资讯缓存未能保存，已保留原有内容');}
  return result;
 }finally{clearTimeout(timer);}
}
/** Shared across page mounts. Failures retain their retry window, never success time. */
export function createNewsRefresher(options:{persist?:boolean}={}){
 let lastAttempt:number|null=null,ongoing:Promise<NewsSnapshot>|null=null;
 return (http:(url:string,options:RequestInit)=>Promise<Response>,prior:NewsSnapshot,storage:Pick<Storage,'setItem'>,now=Date.now())=>{
  if(ongoing)return ongoing;
  if(lastAttempt!==null&&now-lastAttempt<60000)return Promise.reject(new Error('刚刚检查过，请稍后再试。'));
  lastAttempt=now;ongoing=fetchReviewedNews(http,prior,storage,now,options.persist!==false).finally(()=>{ongoing=null;});return ongoing;
 };
}
