import React, {useLayoutEffect,useRef} from 'react';
import { CalendarOutline, FileOutline, HistogramOutline, UserOutline } from 'antd-mobile-icons';

// The target is a navigation symbol, not a replacement for the established brand Logo.
export function BottomNavigation({section,open}:{section:string;open:(name:string)=>void}) {
 const scoring=section==='score';
 const focusScoring=useRef(false);
 useLayoutEffect(()=>{if(scoring&&focusScoring.current){document.querySelector<HTMLElement>('main')?.focus({preventScroll:true});focusScoring.current=false;}},[scoring]);
 const entries=[{key:'news',icon:<FileOutline/>,title:'资讯'},{key:'training',icon:<CalendarOutline/>,title:'训练'},{key:'score',icon:<svg className="nav-target" viewBox="0 0 40 40" focusable="false"><g className="nav-target-a1" fill="none" stroke="#082572" strokeWidth="2"><circle cx="20" cy="20" r="18"/><circle cx="20" cy="20" r="11"/></g><g className="nav-target-a2"><circle cx="20" cy="20" r="15.5" fill="none" stroke="#082572" strokeWidth="7"/><circle cx="20" cy="20" r="9" fill="none" stroke="#b7d1fc" strokeWidth="5"/></g><circle cx="20" cy="20" r="4" fill="#ef9e66"/></svg>,title:'记分'},{key:'history',icon:<HistogramOutline/>,title:'复盘'},{key:'profile',icon:<UserOutline/>,title:'我的'}];
 return <nav className={`app-tabbar${scoring?' app-tabbar-scoring':''}`} aria-label="主导航">
  <div className="nav-surface" aria-hidden="true"><span/><svg viewBox="0 0 128 72" preserveAspectRatio="none"><path d="M0 0 C20 0 19 14 27 35 C42 66 86 66 101 35 C109 14 108 0 128 0 V72 H0 Z"/></svg><span/></div>
  <div className="app-nav-items">{entries.map(({key,icon,title})=><button type="button" key={key} className={['app-nav-item',key==='score'?'app-nav-score':'',section===key?'app-nav-current':''].filter(Boolean).join(' ')} aria-label={title} aria-current={section===key?'page':undefined} onClick={()=>{if(key==='score'&&scoring)return;focusScoring.current=key==='score';open(key);}}><span className="app-nav-icon" aria-hidden="true">{icon}</span>{key!=='score'&&<span className="app-nav-title">{title}</span>}</button>)}</div>
 </nav>;
}
