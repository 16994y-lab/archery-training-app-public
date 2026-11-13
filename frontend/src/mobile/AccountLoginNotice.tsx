import React,{useEffect,useId,useRef,useState} from 'react';
import {useInnerBack} from './ui';
import {UsageNotice} from './UsageNotice';

export type LoginNoticeRequest={continueLogin?:()=>void};
const noticeTitle='使用须知与隐私说明';

export function AccountLoginNotice({accepted,onAccept,onRead}:{accepted:boolean;onAccept:(value:boolean)=>void;onRead:()=>void}){
 return <div className="login-notice">
  <label><input type="checkbox" checked={accepted} onChange={event=>onAccept(event.target.checked)} aria-label={`我已阅读并同意《${noticeTitle}》`}/>我已阅读并同意</label>
  <button type="button" onClick={onRead}>《{noticeTitle}》</button>
 </div>;
}

export function AccountLoginNoticeDialog({request,onClose,onAgree}:{request:LoginNoticeRequest;onClose:()=>void;onAgree:()=>void}){
 const ref=useRef<HTMLDialogElement>(null),titleId=useId();
 const prompting=!!request.continueLogin;
 const [reading,setReading]=useState(!prompting);
 const readTitle=useRef<HTMLHeadingElement>(null);
 useInnerBack(true,onClose,100);
 useEffect(()=>{
  const dialog=ref.current;
  dialog?.showModal();
  return ()=>{dialog?.close();};
 },[]);
 useEffect(()=>{if(reading&&prompting)readTitle.current?.focus();},[reading,prompting]);
 return <dialog ref={ref} className="login-notice-dialog" aria-labelledby={titleId}
  onCancel={event=>{event.preventDefault();onClose();}}>
  <div className="login-notice-dialog-content">
   <h2 id={titleId} ref={readTitle} tabIndex={-1}>{noticeTitle}</h2>
   {reading?<UsageNotice expanded/>:<p>请阅读并同意<button type="button" className="login-notice-link" onClick={()=>setReading(true)}>《{noticeTitle}》</button>后继续。</p>}
  </div>
  <div className="login-notice-dialog-actions">
   <button type="button" onClick={onClose}>{prompting?'取消':'关闭'}</button>
   {prompting&&<button type="button" onClick={onAgree}>同意</button>}
  </div>
 </dialog>;
}
