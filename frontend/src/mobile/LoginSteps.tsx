import React,{useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Button} from './ui';
import './login-steps.css';

const logo=new URL('../../public/ui/logo-mark.png',import.meta.url).href;
const arrow=new URL('./login-arrow.svg',import.meta.url).href;
const narrowLogin='(max-width:999px)';
export type LoginStep='welcome'|'number'|'code'|'alternate';
type Direction='forward'|'back';
type Step={step:LoginStep;previous:LoginStep|null;direction:Direction};

export function useNarrowLogin(){
 const [narrow,setNarrow]=useState(()=>!!window.Gongxingji||matchMedia(narrowLogin).matches);
 useEffect(()=>{
  if(window.Gongxingji)return;
  const query=matchMedia(narrowLogin);
  const update=()=>setNarrow(query.matches);
  query.addEventListener('change',update);
  return ()=>query.removeEventListener('change',update);
 },[]);
 return narrow;
}

export function useLoginSteps(){
 const [path,setPath]=useState<Step>({step:'welcome',previous:null,direction:'forward'});
 const open=(step:LoginStep,direction:Direction='forward')=>setPath(current=>
  current.step===step?current:{step,previous:current.step,direction});
 useEffect(()=>{
  if(path.previous===null)return;
  const timeout=setTimeout(()=>setPath(current=>current===path?{...current,previous:null}:current),360);
  return ()=>clearTimeout(timeout);
 },[path]);
 return {path,open};
}

type Props={
 path:Step;
 onBack:()=>void;
 onPhone:()=>void;
 onEmail:()=>void;
 onPassword:()=>void;
 disabled:boolean;
 notice:ReactNode;
 numberForm:ReactNode;
 codeForm:ReactNode;
 alternateTitle:string;
 alternateForm:ReactNode;
 reauthentication:boolean;
 showSplash:boolean;
};

function LoginBrand(){
 return <span className="step-login-brand"><img src={logo} alt=""/>弓行记</span>;
}

export function LoginSteps({path,onBack,onPhone,onEmail,onPassword,disabled,notice,numberForm,codeForm,alternateTitle,alternateForm,reauthentication,showSplash}:Props){
 const dialogTitle=useId(),stage=useRef<HTMLDivElement>(null);
 const {step,previous,direction}=path;
 useEffect(()=>{
  if(previous===null)return;
  stage.current?.querySelector<HTMLElement>('[data-screen="active"] h1')?.focus({preventScroll:true});
 },[step,previous]);
 useEffect(()=>{
  if(step==='welcome')return;
  const escape=(event:KeyboardEvent)=>{
   if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing&&!document.querySelector('dialog[open]')){
    event.preventDefault();onBack();
   }
  };
  window.addEventListener('keydown',escape);
  return ()=>window.removeEventListener('keydown',escape);
 },[step,onBack]);
 function pane(id:LoginStep,title:string,content:ReactNode){
  const active=step===id,leaving=previous===id;
  if(!active&&!leaving)return null;
  const backLabel=id==='code'?'返回手机号登录':'返回欢迎页';
  const titleId=dialogTitle+'-'+id;
  return <section key={id} className="step-login-screen" data-screen={active?'active':'leaving'} data-direction={direction}
    data-animate={previous!==null} aria-labelledby={titleId} aria-hidden={!active}>
   <fieldset disabled={!active} className="step-login-content">
    {id==='welcome'?<>
     <header className="step-login-welcome"><LoginBrand/><h1 id={titleId} tabIndex={-1}>记录每一箭，<br/>看见每一次进步</h1></header>
     <div className="step-login-actions">
      {reauthentication&&<p role="status">请重新登录，已有训练资料保留。</p>}
      <Button kind="primary" type="button" disabled={disabled} onClick={onPhone}>手机号登录或注册</Button>
      <div className="step-login-alternates">
       <Button type="button" disabled={disabled} onClick={onEmail}>邮箱登录</Button>
       <Button type="button" disabled={disabled} onClick={onPassword}>使用密码登录</Button>
      </div>
     </div>
     <footer className="step-login-notice">{notice}</footer>
    </>:<>
     <header className="step-login-header"><button type="button" onClick={onBack} disabled={disabled} aria-label={backLabel} className="step-login-back"/></header>
     <div className="step-login-body"><h1 id={titleId} tabIndex={-1}>{title}</h1>{content}</div>
    </>}
   </fieldset>
  </section>;
 }
 return <div ref={stage} className="step-login-stage">
  {showSplash&&<div className="step-login-splash" aria-hidden="true">
   <div className="step-login-splash-copy"><span>准备</span><span>开弓</span></div>
   <i className="step-login-arrow-trail"/><img src={arrow} className="step-login-arrow" alt=""/>
   <LoginBrand/>
  </div>}
  {pane('welcome','',null)}
  {pane('number','手机号登录',numberForm)}
  {pane('code','输入验证码',codeForm)}
  {pane('alternate',alternateTitle,alternateForm)}
 </div>;
}
