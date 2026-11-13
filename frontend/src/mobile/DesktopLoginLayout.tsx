import React from 'react';
import type {LoginDestination} from './login-destination';
import './desktop-login.css';
import './startup-login.css';

const brandLogo=new URL('../../public/ui/logo-mark.png',import.meta.url).href;
/** The auth form stays mounted when choosing a destination. Mobile keeps its App layout. */
export function DesktopLoginLayout({destination,onDestination,secondaryLogin,children}:{destination:LoginDestination;onDestination:(value:LoginDestination)=>void;secondaryLogin?:boolean;children:React.ReactNode}){
  return <div className={`login-layout${!window.Gongxingji?' login-layout-web':''}${secondaryLogin?' login-layout-secondary':''}`}>
    <header className="login-brand">
      <div className="login-brand-name"><img src={brandLogo} alt="" width="72" height="72"/><h1>弓行记</h1></div>
      <div className="login-brand-message"><p>记录每一箭，<br className="login-desktop-break"/>看见每一次进步</p></div>
      <div className="login-brand-target" aria-hidden="true"><i/><i/><i/><b/></div>
    </header>
    <section className="login-content" aria-label="账号登录">
      <div className="login-welcome"><h2>欢迎来到弓行记</h2><p>选择入口，登录你的账号</p></div>
      <nav className="login-destinations" aria-label="登录后进入">
        <button type="button" aria-pressed={destination==='user'} onClick={()=>onDestination('user')}>用户端</button>
        <button type="button" aria-pressed={destination==='coach'} onClick={()=>onDestination('coach')}>教练端</button>
      </nav>
      {children}
      {destination==='coach'&&<p className="login-coach-note">教练账号可自行注册，申请通过后即可使用团队工作台。</p>}
    </section>
  </div>;
}
