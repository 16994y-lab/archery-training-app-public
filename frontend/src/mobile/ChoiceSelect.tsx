import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Modal} from './ui';
import {AppIcon,choiceIcon} from './AppIcon';
import {DwellLabel} from './DwellLabel';
import './choice-select.css';

// Retain a real select and its change event for existing forms and value bindings.
// Only its presentation changes: every device uses the same accessible sheet.
type Props=React.SelectHTMLAttributes<HTMLSelectElement> & {appearance?:'aurora'};
type Choice={value:string;label:string;description?:string;disabled:boolean};
export function ChoiceSelect({children,className='',id,value,defaultValue,onChange,disabled,appearance='aurora',...props}:Props){
 const native=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement>(null),options=useRef<HTMLDivElement>(null);
 const [shown,setShown]=useState(false),[title,setTitle]=useState('选择'),[fieldTitle,setFieldTitle]=useState(''),[choices,setChoices]=useState<Choice[]>([]),[current,setCurrent]=useState(String(value??defaultValue??''));
 const listId=React.useId();
 const [inDialog,setInDialog]=useState(false);
 useLayoutEffect(()=>{setInDialog(Boolean(native.current?.closest('dialog,[role="dialog"]')));},[]);
 useLayoutEffect(()=>{
  const el=native.current;if(!el)return;
  const next=Array.from(el.options).map(o=>({value:o.value,label:o.text,description:o.dataset.description,disabled:o.disabled||(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled)}));
  setChoices(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);setCurrent(el.value);
  const button=trigger.current,field=button?.closest('.field,.adm-form-item'),wrapping=button?.closest('label');
  setFieldTitle((props['aria-label']||field?.querySelector('label,.adm-form-item-label')?.textContent||wrapping?.querySelector('span')?.textContent||'').trim());
 },[children,value,defaultValue]);
 useEffect(()=>{
  const form=native.current?.form;if(!form)return;
  let frame=0;const reset=()=>{frame=requestAnimationFrame(()=>setCurrent(native.current?.value??''));};
  form.addEventListener('reset',reset);return()=>{form.removeEventListener('reset',reset);cancelAnimationFrame(frame);};
 },[]);
 useLayoutEffect(()=>{
  if(disabled){setShown(false);return;}
  if(!shown)return;
  const list=options.current;if(!list)return;
  // Opening and removing a focused option both retain a usable keyboard position.
  if(!list.contains(document.activeElement)){
   const selected=list.querySelector<HTMLButtonElement>('button[aria-selected=true]:not(:disabled)');
   (selected??list.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({preventScroll:true});
  }
 },[shown,choices,disabled]);
 const selected=choices.find(o=>o.value===String(value??current));
 const icon=choiceIcon(selected?.label??'',fieldTitle);
 function open(){
  if(disabled)return;
  const button=trigger.current,field=button?.closest('.field,.adm-form-item'),wrapping=button?.closest('label');
  const label=props['aria-label']||field?.querySelector('label,.adm-form-item-label')?.textContent||wrapping?.querySelector('span')?.textContent||'选择';
  setTitle(label.trim());setShown(true);
 }
 function choose(next:string){
  const el=native.current;if(!el||disabled)return;
  if(el.value!==next){el.value=next;el.dispatchEvent(new Event('change',{bubbles:true}));}
  setShown(false);
 }
 function move(event:React.KeyboardEvent<HTMLDivElement>){
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));if(!nodes.length)return;
  event.preventDefault();const index=nodes.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?nodes.length-1:Math.max(0,Math.min(nodes.length-1,index+(event.key==='ArrowDown'?1:-1)));
  nodes[next]?.focus();
 }
 // Use the platform picker inside a dialog to keep a single focus trap.
 if(inDialog||props.multiple||(props.size??0)>1)return <select {...props} ref={native} id={id} value={value} defaultValue={defaultValue} disabled={disabled} onChange={onChange} className={`choice-inline ${className}`}>{children}</select>;
 return <><select {...props} ref={native} value={value} defaultValue={defaultValue} disabled={disabled} tabIndex={-1} aria-hidden="true" className="choice-native" onChange={event=>{setCurrent(event.target.value);onChange?.(event);}}>{children}</select>
 <button ref={trigger} id={id} type="button" data-appearance={appearance} className={`choice-trigger ${className}`} disabled={disabled} role="combobox" aria-haspopup="dialog" aria-expanded={shown} aria-controls={shown?listId:undefined} aria-label={props['aria-label']} aria-describedby={props['aria-describedby']} aria-labelledby={props['aria-labelledby']} aria-invalid={props['aria-invalid']} aria-required={props.required||undefined} onClick={open} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open();}}}>{icon&&<AppIcon name={icon} className="choice-leading"/>}<span className="choice-copy"><DwellLabel text={selected?.label??'请选择'}/>{selected?.description&&<small>{selected.description}</small>}</span><svg className="choice-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
 {shown&&<Modal title={title} onClose={()=>setShown(false)}>{!choices.length&&<p role="status">当前没有可选项。</p>}<div ref={options} id={listId} className="choice-options" data-appearance={appearance} role="listbox" aria-label={title} onKeyDown={move}>{choices.map((option,index)=>{const optionIcon=choiceIcon(option.label,fieldTitle);return <button type="button" role="option" aria-selected={option.value===String(value??current)} disabled={disabled||option.disabled} key={option.value+'-'+index} onClick={()=>choose(option.value)}>{optionIcon&&<AppIcon name={optionIcon} className="choice-leading"/>}<span className="choice-copy"><DwellLabel text={option.label}/>{option.description&&<small>{option.description}</small>}</span><span className="choice-check" aria-hidden="true">{option.value===String(value??current)?'✓':''}</span></button>;})}</div><button type="button" className="choice-cancel" onClick={()=>setShown(false)}>取消</button></Modal>}</>;
}
