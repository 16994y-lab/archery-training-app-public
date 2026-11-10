import React,{useId,useState} from 'react';

/** A visible label and an explicit, keyboard-accessible visibility control. */
export function PasswordField({label,value,onChange,disabled=false,autoComplete='current-password'}:{label:string;value:string;onChange:(value:string)=>void;disabled?:boolean;autoComplete?:'current-password'|'new-password'}){
 const id=useId(),[visible,setVisible]=useState(false);
 return <div className="field"><label htmlFor={id}>{label}</label><div className="account-password">
  <input id={id} type={visible?'text':'password'} autoComplete={autoComplete} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>
  <button type="button" className="password-visibility" aria-label={`${visible?'隐藏':'显示'}${label}`} aria-pressed={visible} disabled={disabled} onClick={()=>setVisible(current=>!current)}>{visible?'隐藏':'显示'}</button>
 </div></div>;
}
