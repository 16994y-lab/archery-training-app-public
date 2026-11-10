import React from 'react';

const partialPhone=/^[0-9]{0,11}$/;
/** Refuse malformed edits rather than silently changing the destination number. */
export function phoneEdit(value:string):boolean{return partialPhone.test(value);}
export function phonePaste(value:string,text:string,start:number,end:number):string|null{
 if(!/^[0-9]+$/.test(text))return null;
 const next=value.slice(0,start)+text+value.slice(end);
 return phoneEdit(next)?next:null;
}
type Props=Omit<React.InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'onPaste'|'type'|'inputMode'|'maxLength'|'pattern'>&{value:string;onValueChange:(value:string)=>void};
export function MainlandPhoneInput({value,onValueChange,...props}:Props){
 return <input {...props} type="tel" inputMode="numeric" maxLength={11} pattern="1[3-9][0-9]{9}" value={value}
  onChange={event=>{const next=event.currentTarget.value;if(phoneEdit(next))onValueChange(next);else event.currentTarget.value=value;}}
  onPaste={event=>{event.preventDefault();const input=event.currentTarget,next=phonePaste(value,event.clipboardData.getData('text'),input.selectionStart??value.length,input.selectionEnd??value.length);if(next!==null)onValueChange(next);}}/>;
}
