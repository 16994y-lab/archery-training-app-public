import React, { createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button as MobileButton, Input, Popup, NavBar, Form, List } from 'antd-mobile';
import type { Data, Session, Target, Arrow } from './domain';
import {AppIcon} from './AppIcon';
import type {PhotoSaveState} from './photo-save-receipt';
export type Update = (change:(data:Data)=>void)=>Promise<boolean>;
export type ToastOptions = {placement?:'top';durationMs?:number};
export type ToastMessage = ToastOptions & {message:string};
export function useToast(){
 const [toast,setToast]=useState<ToastMessage|null>(null);
 const tell=useCallback((message:string,options?:ToastOptions)=>setToast(message?{message,...options}:null),[]);
 const clearToast=useCallback(()=>setToast(null),[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(clearToast,toast.durationMs??5000);return()=>clearTimeout(timer);},[toast,clearToast]);
 return {toast,tell,clearToast};
}
export function AppToast({notice}:{notice:ToastMessage}){
 return <div role="status" aria-live="polite" aria-atomic="true" className={notice.placement==='top'?'toast toast-top':'toast'}>{notice.message}</div>;
}
export type AppContext = { data:Data; update:Update; retryPendingSave:()=>Promise<boolean>; hasPendingSave:()=>boolean; readSaveState?:()=>PhotoSaveState; open:(name:string,id?:string)=>void; ask:(title:string,body:string,choices:string[],primaryChoice?:number)=>Promise<number>; tell:(message:string,options?:ToastOptions)=>void };
export const AppCtx=createContext<AppContext>(null!);
export const useApp=()=>useContext(AppCtx);
export function useEditGuard(value:unknown){const {ask}=useApp();const initial=useRef(JSON.stringify(value)),approved=useRef(false);const dirty=JSON.stringify(value)!==initial.current;
 useEffect(()=>{const guard=(e:Event)=>{if(dirty&&!approved.current)e.preventDefault();};const unload=(e:BeforeUnloadEvent)=>{if(dirty&&!approved.current){e.preventDefault();e.returnValue='';}};window.addEventListener('gongxingji:before-navigate',guard);window.addEventListener('beforeunload',unload);return()=>{window.removeEventListener('gongxingji:before-navigate',guard);window.removeEventListener('beforeunload',unload);};},[dirty]);
 return {dirty,saved:()=>{approved.current=true;},close:async(onClose:()=>void)=>{if(!dirty||await ask('离开当前编辑？','这些编辑尚未保存，是否放弃本次编辑？',['继续编辑','放弃编辑'])===1){approved.current=true;onClose();}}};
}
export function Button({children,kind='',...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{kind?:string}){const kinds=kind.split(/\s+/);return <MobileButton {...props} color={kinds.includes('primary')?'primary':kinds.includes('danger')?'danger':'default'} className={`button ${kind} ${props.className??''}`}>{children}</MobileButton>;}
// AntD's clickable list row is an anchor without href. Keep its visual layout
// inside a native button so keyboard and screen-reader navigation also work.
export function ActionListItem({onClick,disabled,children,...props}:React.ComponentProps<typeof List.Item>){
 return <button type="button" className="app-list-action" disabled={disabled} onClick={onClick}><List.Item {...props} clickable={false} arrowIcon={props.arrowIcon??true}>{children}</List.Item></button>;
}
export function Field({label,children,hint}:{label:string;children:React.ReactNode;hint?:string}){
 const id=React.useId();const child=React.isValidElement<{id?:string;'aria-label'?:string;'aria-describedby'?:string}>(children)?React.cloneElement(children,{id:children.props.id??id+'-input','aria-describedby':[children.props['aria-describedby'],hint?id+'-hint':undefined].filter(Boolean).join(' ')||undefined}):children;
 return <div className="field"><label htmlFor={React.isValidElement<{id?:string}>(child)?child.props.id:undefined}>{label}</label>{child}{hint&&<small id={id+'-hint'}>{hint}</small>}</div>;
}
// Keep the editing string separate: an empty required field is invalid, never a saved zero.
export function NumberInput({value,onValue,defaultValue:ignoredDefault,size:ignoredSize,...props}:Omit<React.InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'>&{value:number;onValue:(n:number)=>void}) {
  const format=(n:number)=>Number.isFinite(n)?String(n):'';
  const [text,setText]=useState(()=>format(value));const last=useRef(value);
  useEffect(()=>{if(!Object.is(value,last.current)){last.current=value;setText(format(value));}},[value]);
  return <Input {...props} min={undefined} max={undefined} type="number" inputMode={props.step&&props.step!==1&&props.step!=='1'?'decimal':'numeric'} value={text} onChange={raw=>{setText(raw);const n=raw.trim()===''?NaN:Number(raw);last.current=n;onValue(n);}} onBlur={e=>{if(Number.isFinite(value))setText(String(value));props.onBlur?.(e);}}/>;
}
export function Empty({title,children}:{title:string;children:React.ReactNode}){return <section className="empty"><h2>{title}</h2><p>{children}</p></section>;}
export function Panel({title,children,className='' }:{title?:string;children:React.ReactNode;className?:string}){return <section className={`panel ${className}`.trim()}>{title&&<h2>{title}</h2>}{children}</section>;}
export function Back({title,onBack,label='返回',dirty,action}:{title:string;onBack:()=>void;label?:string;dirty?:boolean;action?:React.ReactNode}){return <div ref={element=>element?.querySelector('.adm-nav-bar-left')?.setAttribute('role','presentation')}><NavBar className="subhead" back={null} right={action??(dirty!==undefined?<span className="gx-save-state" role="status">{dirty?'未保存':''}</span>:undefined)} left={<button type="button" className="adm-nav-bar-back app-back" aria-label={label} onClick={onBack} title={label}><AppIcon name="back"/></button>}><h1>{title}</h1></NavBar></div>;}
const backHandlers=new Map<symbol,{priority:number;run:()=>void}>();
if(typeof window!=='undefined')window.addEventListener('gongxingji-back',e=>{const top=[...backHandlers.values()].reverse().sort((a,b)=>b.priority-a.priority)[0];if(top){e.stopImmediatePropagation();top.run();}},true);
export function useInnerBack(active:boolean,onBack:()=>void,priority=10) {const fn=useRef(onBack);fn.current=onBack;useEffect(()=>{if(!active)return;const key=Symbol();backHandlers.set(key,{priority,run:()=>fn.current()});return()=>{backHandlers.delete(key);};},[active,priority]);}
type ModalProps={title:string;children:React.ReactNode;onClose:()=>void;container?:HTMLElement};
const modalDialogs=new Map<symbol,HTMLElement>();
function ModalBody({title,children,onClose}:ModalProps){
 const dialog=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
 useLayoutEffect(()=>{
  const element=dialog.current;if(!element)return;
  const key=Symbol(),previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  modalDialogs.set(key,element);
  const top=()=>{const items=[...modalDialogs.values()];return items[items.length-1];};
  const controls=()=>Array.from(element.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]')).filter(item=>item.tabIndex>=0&&!item.matches(':disabled')&&!item.closest('[inert]')&&item.getClientRects().length>0&&getComputedStyle(item).visibility!=='hidden');
  const focus=()=>element.focus({preventScroll:true});
  const keyboard=(event:KeyboardEvent)=>{
   if(top()!==element||event.isComposing)return;
   if(event.key==='Escape'){
    if(event.target instanceof HTMLSelectElement&&CSS.supports('selector(select:open)')&&event.target.matches(':open'))return;
    event.preventDefault();event.stopImmediatePropagation();close.current();
   }
   if(event.key==='Tab'){
    const items=controls(),first=items[0],last=items[items.length-1],active=document.activeElement;
    if(!first){event.preventDefault();focus();}
    else if(!element.contains(active)||active===element){event.preventDefault();(event.shiftKey?last:first)?.focus();}
    else if(event.shiftKey&&active===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
   }
  };
  const containFocus=(event:FocusEvent)=>{if(top()===element&&!element.contains(event.target as Node))focus();};
  document.addEventListener('keydown',keyboard,true);document.addEventListener('focusin',containFocus,true);focus();
  return()=>{
   modalDialogs.delete(key);document.removeEventListener('keydown',keyboard,true);document.removeEventListener('focusin',containFocus,true);
   const current=top();
   if(previous?.isConnected&&(!current||current.contains(previous)))previous.focus({preventScroll:true});
   else current?.focus({preventScroll:true});
  };
 },[]);
 return <section ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><button type="button" className="adm-popup-close-icon" aria-label={`关闭${title}`} style={{border:0,background:'transparent',color:'inherit',cursor:'pointer'}} onClick={onClose}>×</button><h2>{title}</h2>{children}</section>;
}
export function Modal(props:ModalProps) {useInnerBack(true,props.onClose,100);return <Popup visible getContainer={props.container} onClose={props.onClose} onMaskClick={props.onClose} bodyClassName="app-popup" bodyStyle={{borderTopLeftRadius:24,borderTopRightRadius:24,maxHeight:'88dvh',overflowY:'auto'}}><ModalBody {...props}/></Popup>;}
export function ValidatedForm({children,onFinish}:{children:React.ReactNode;onFinish:()=>void|Promise<void>}) {return <Form className="app-form" onFinish={onFinish} layout="vertical">{children}</Form>;}
export function sessionIn(d:Data,id:string):Session{const s=d.sessions.find(s=>s.id===id);if(!s)throw new Error('记录不存在');return s;}
export {TargetFace} from './TargetFace';
export function LayoutPicker({target,face,setFace}:{target:Target;face:number;setFace:(n:number)=>void}) {if(target.face_count===1)return null;return <div className={`faces ${target.layout?.kind.toLowerCase()}`} aria-label="选择靶位">{target.layout?.faces.map(f=><button key={f.index} className={face===f.index?'chosen':''} onClick={()=>setFace(f.index)} style={{left:`${f.anchor_x*100}%`,top:`${f.anchor_y*100}%`}} aria-pressed={face===f.index}>靶 {f.index}</button>)}</div>;}
