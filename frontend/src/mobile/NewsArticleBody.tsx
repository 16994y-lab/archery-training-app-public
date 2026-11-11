import type {ReactNode,Ref} from 'react';
import {Link,type To} from 'react-router-dom';

type StoryLink={to:To;state?:object;onClick?:()=>void;id?:string}|{href:string};

export function PressStoryRow({link,title,summary,meta,image}:{
 link:StoryLink;title:string;summary?:string;meta:ReactNode;image?:ReactNode;
}){
 const external='href' in link;
 const content=<>{image}<span className="press-story-copy">
  <strong>{title}</strong>
  {summary&&<span className="press-story-summary">{summary}</span>}
  <span className="press-dateline">{meta}</span>
 </span><span className="press-chevron" aria-hidden="true">{external?'↗':'›'}</span></>;
 const className='press-story';
 return <li>{external
  ?<a className={className} href={link.href} target={window.Gongxingji?'_self':'_blank'} rel="noopener noreferrer">{content}</a>
  :<Link {...link} className={className}>{content}</Link>}</li>;
}

export function NewsArticleHeading({title,titleRef,source,date}:{
 title:string;titleRef:Ref<HTMLHeadingElement>;source:string;date:string;
}){
 return <header>
  <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
  <p className="news-article-meta"><strong>{source}</strong><time dateTime={date}>{date}</time></p>
 </header>;
}

export function NewsSections({sections,navigation=true}:{sections:readonly {title:string;body:ReactNode}[];navigation?:boolean}){
 const showDirectory=navigation&&sections.length>1;
 const jumpTo=(id:string)=>{
  const heading=document.getElementById(id);
  heading?.focus({preventScroll:true});
  heading?.scrollIntoView({block:'start'});
 };
 return <>
  {showDirectory&&<nav className="news-reading-directory" aria-label="文章目录">
   {sections.map(({title},index)=><button type="button" key={title} onClick={()=>jumpTo('reading-section-'+index)}>{title}</button>)}
  </nav>}
  {sections.map(({title,body},index)=><section className={'news-reading-section'+(showDirectory?' news-section-indexed':'')} key={title}>
   <h2 id={showDirectory?'reading-section-'+index:undefined} tabIndex={showDirectory?-1:undefined}>{title}</h2>
   {body}
  </section>)}
 </>;
}

export function NewsParagraphPair({en,zh,heading=false}:{en:string;zh:string;heading?:boolean}){
 return <div className={'news-paragraph-pair'+(heading?' news-pair-heading':'')}>
  {heading?<h2 lang="en">{en}</h2>:<p lang="en">{en}</p>}
  <p lang="zh-CN">{zh}</p>
 </div>;
}
