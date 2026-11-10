import type {NewsArticle,NewsFeed} from './news-feed';
import {NEWS_MAX_BYTES,parseNewsFeed} from './news-feed';
export type DetailSection={kind:'context'|'methods'|'findings'|'limits';title:string;paragraphs:string[]};
export type NewsDetail={articleRef:NewsArticle;mode:'independent-analysis'|'licensed-adaptation';textLicense:{status:'unknown'|'cc-by-4.0';sourceUrl:string;evidenceSHA256?:string};sections:DetailSection[];quote?:{english:string;chinese:string};sourceEvidenceSHA256:string};
export type NewsDetailDocument={schema:1;feedRevision:number;feedReviewedAt:string;status:'draft'|'reviewed';reviewedBy:string|null;reviewedAt:string|null;articles:NewsDetail[]};
const safe=(v:unknown,n:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ownKeys=(v:object,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
export function sameArticle(a:NewsArticle,b:NewsArticle){return ['id','title','date','source','category','summary','url','attribution','doi'].every(k=>(a as unknown as Record<string,unknown>)[k]===(b as unknown as Record<string,unknown>)[k])&&JSON.stringify(a.paragraphs)===JSON.stringify(b.paragraphs);}
export function parseDetailDocument(raw:unknown,feed:NewsFeed):NewsDetailDocument{
 if(new TextEncoder().encode(JSON.stringify(raw)).length+new TextEncoder().encode(JSON.stringify(feed)).length>NEWS_MAX_BYTES)throw Error('详情容量超限');
 const d=raw as NewsDetailDocument;
 if(!d||!ownKeys(d,['schema','feedRevision','feedReviewedAt','status','reviewedBy','reviewedAt','articles'])||d.schema!==1||d.feedRevision!==feed.revision||d.feedReviewedAt!==feed.reviewedAt||!['draft','reviewed'].includes(d.status)||!Array.isArray(d.articles)||!d.articles.length||d.articles.length>100)throw Error('详情版本不匹配');
 if(d.status==='reviewed'&&(!safe(d.reviewedBy,160)||typeof d.reviewedAt!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d.reviewedAt)||new Date(d.reviewedAt+'T00:00:00Z').toISOString().slice(0,10)!==d.reviewedAt||d.reviewedAt<feed.reviewedAt||d.reviewedAt>new Date().toISOString().slice(0,10)))throw Error('详情审核未完成');
 const ids=new Set<string>();
 for(const a of d.articles){
  if(!a||!ownKeys(a,['articleRef','mode','textLicense','sections','quote','sourceEvidenceSHA256'])||!a.articleRef||!['independent-analysis','licensed-adaptation'].includes(a.mode)||!sha(a.sourceEvidenceSHA256))throw Error('详情不完整');
  parseNewsFeed({schema:1,revision:feed.revision,reviewedAt:feed.reviewedAt,articles:[a.articleRef]});
  const base=feed.articles.find(b=>b.id===a.articleRef.id);if(!base||!sameArticle(base,a.articleRef)||ids.has(base.id))throw Error('详情原文身份不匹配');ids.add(base.id);
  const l=a.textLicense;if(!l||!ownKeys(l,['status','sourceUrl','evidenceSHA256'])||!['unknown','cc-by-4.0'].includes(l.status)||l.sourceUrl!==base.url||l.status==='cc-by-4.0'&&!sha(l.evidenceSHA256))throw Error('详情许可未绑定');
  if((a.mode==='licensed-adaptation'||a.quote)&&l.status!=='cc-by-4.0')throw Error('未核许可不能翻译转载');
  if(!Array.isArray(a.sections)||a.sections.length!==4||new Set(a.sections.map(s=>s.kind)).size!==4||a.sections.some(s=>!['context','methods','findings','limits'].includes(s.kind)||!ownKeys(s,['kind','title','paragraphs'])||!safe(s.title,160)||!Array.isArray(s.paragraphs)||!s.paragraphs.length||s.paragraphs.some(t=>!safe(t,1200)))||a.sections.reduce((n,s)=>n+s.paragraphs.length,0)>12)throw Error('详情正文不完整或超限');
  if(a.quote&&(!ownKeys(a.quote,['english','chinese'])||!safe(a.quote.english,400)||a.quote.english.split(/\s+/).length>25||!safe(a.quote.chinese,400)))throw Error('原文节选超限');
 }
 return d;
}
/** Drafts and unknown/mismatched versions cannot be rendered in the product. */
export function reviewedDetailFor(article:NewsArticle,raw:unknown,feed:NewsFeed):NewsDetail|undefined{
 if(raw===undefined)return undefined;
 try{const d=parseDetailDocument(raw,feed);return d.status==='reviewed'?d.articles.find(a=>sameArticle(a.articleRef,article)):undefined;}catch{return undefined;}
}
