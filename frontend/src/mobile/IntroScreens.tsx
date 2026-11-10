import React, { useId, useRef, useState } from 'react';
import { Swiper } from 'antd-mobile';
import type { SwiperRef } from 'antd-mobile';
import { introPages } from './intro-content';
import { useInnerBack } from './ui';
import './intro-screens.css';

export type IntroScreensProps = {
 onDone: () => void;
 onSkip: () => void;
 onExistingAccount: () => void;
 /** Revisit is presentation only; caller owns routes, session and preference. */
 revisit?: boolean;
 context?: 'registered'|'public';
 notice?:string;
};

export function IntroScreens({onDone,onSkip,onExistingAccount,revisit=false,context='public',notice=''}:IntroScreensProps) {
 const [index,setIndex]=useState(0),[failedImages,setFailedImages]=useState<ReadonlySet<string>>(new Set());
 const swiper=useRef<SwiperRef>(null),region=useId();
 const go=(next:number)=>swiper.current?.swipeTo(Math.max(0,Math.min(introPages.length-1,next)));
 useInnerBack(true,()=>index>0?go(index-1):onSkip(),30);
 const fail=(id:string)=>setFailedImages(current=>new Set([...current,id]));
 const content=useRef<HTMLElement>(null);
 React.useEffect(()=>{content.current?.focus({preventScroll:true});},[index]);
 return <section className="intro-screens" aria-label="弓行记功能介绍" onKeyDown={event=>{
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  if(event.key==='ArrowRight'){event.preventDefault();go(index+1);}
  if(event.key==='ArrowLeft'){event.preventDefault();go(index-1);}
 }}>
  <header className="intro-top">
   <div className="intro-brand"><img src={new URL('../../public/ui/logo-mark.png', import.meta.url).href} alt="" width="38" height="38"/><div><strong>弓行记</strong><span>你的射箭训练记录</span></div></div>
   <button type="button" className="intro-link" onClick={onSkip}>{revisit?'关闭':'跳过'}</button>
  </header>
  {notice&&<p className="account-preference-warning" role="status">{notice}</p>}
  <div className="intro-content" id={region}>
   <Swiper ref={swiper} autoplay={false} loop={false} indicator={false} onIndexChange={setIndex} className="intro-swiper">
    {introPages.map((page,i)=><Swiper.Item key={page.id}>
     <article ref={i===index?content:undefined} tabIndex={i===index?-1:undefined} className="intro-card" aria-hidden={i!==index} aria-labelledby={region+'-'+page.id}>
      <p className="intro-kicker">训练 · 计划 · 记分 · 复盘</p>
      <h2 id={region+'-'+page.id}>{page.title}</h2><p className="intro-description">{page.description}</p>
      <figure className="intro-figure">
       {failedImages.has(page.id)?<div className="intro-image-fallback"><span>界面图片暂时无法显示</span><p>{page.imageAlt}</p></div>:<img src={page.image} alt={page.imageAlt} width="640" height="560" loading="eager" decoding="async" onError={()=>fail(page.id)}/>}
       <figcaption>演示记录 · 当前产品界面</figcaption>
      </figure>
      <ol className="intro-steps">{page.steps.map(step=><li key={step}>{step}</li>)}</ol>
     </article>
    </Swiper.Item>)}
   </Swiper>
  </div>
  <footer className="intro-footer">
   <p className="intro-progress" role="status" aria-live="polite" aria-atomic="true">第 {index+1} / {introPages.length} 页 · {introPages[index].title}</p>
   <div className="intro-actions"><button type="button" className="intro-previous" disabled={index===0} onClick={()=>go(index-1)} aria-controls={region}>上一页</button><button type="button" className="intro-next" onClick={()=>index===introPages.length-1?onDone():go(index+1)} aria-controls={region}>{index===introPages.length-1?(revisit?'返回':context==='registered'?'开始训练':'开始使用／登录注册'):'下一步'}</button></div>
   {!revisit&&context!=='registered'&&<button type="button" className="intro-account" onClick={onExistingAccount}>已有账号，直接登录</button>}
  </footer>
 </section>;
}
export default IntroScreens;
