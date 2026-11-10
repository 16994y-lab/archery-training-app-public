import React,{useId,useState} from 'react';
import type {Target} from './domain';
import {Button,Modal} from './ui';
import {TargetPreview} from './TargetChoice';
import {photoSupportedTargets,photoTargetNotice,type PhotoTargetLocationIssue} from './photo-target-notice';
import './photo-target-notice.css';

export function PhotoTargetNotice({target,face,issue,disabled=false,onManual}:{
 target:Target;face:number;issue?:PhotoTargetLocationIssue;disabled?:boolean;onManual:()=>void;
}){
 const titleId=useId(),previewId=useId();
 const [open,setOpen]=useState(false),[previewKey,setPreviewKey]=useState('current');
 const state=photoTargetNotice(target,face,issue),supported=photoSupportedTargets();
 const preview=previewKey==='current'?target:supported.find(item=>item.id===previewKey)??target;
 const show=()=>{setPreviewKey('current');setOpen(true);};
 return <section className={`photo-target-notice${state.alert?' photo-target-notice-warning':''}`} aria-labelledby={titleId} data-target-support={state.kind}>
  <h4 id={titleId}>{state.title}</h4>
  <p className="photo-target-current"><span>当前选择</span><strong>{state.selectedLabel}</strong></p>
  <p role={state.alert?'alert':undefined}>{state.message}</p>
  <p className="photo-target-limit">尚未自动判断照片的靶型；候选环值仍需人工核对。</p>
  <div className="photo-target-actions">
   <Button disabled={disabled} onClick={show}>查看支持靶型 / 切换预览</Button>
   <Button disabled={disabled} onClick={onManual}>返回手动记分</Button>
  </div>
  {open&&<Modal title="对照照片核对靶型" onClose={()=>setOpen(false)}>
   <div className="photo-target-gallery">
    <p>本场当前选择：<strong>{state.selectedLabel}</strong></p>
    <label htmlFor={previewId}>选择对照预览</label>
    <select id={previewId} value={previewKey} onChange={event=>setPreviewKey(event.target.value)}>
     <option value="current">当前选择：{target.name}</option>
     {supported.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    <div className="photo-target-preview"><TargetPreview target={preview}/><b>{preview.name}</b></div>
    <p className="photo-target-preview-note" role="status">此处只切换对照预览，本场仍使用「{target.name}」。</p>
    <details><summary>照片录入支持的 {supported.length} 个内置靶型</summary>
     <ul>{supported.map(item=><li key={item.id}>{item.name}{item.face_count>1?'（单个选定靶位）':''}</li>)}</ul>
     <p>支持入口不代表每张照片都能定位或识别；模糊、侧拍和多靶照片仍需人工核对。</p>
    </details>
    <p>若照片靶型与当前选择不同，请返回记分，并按实际靶型另开训练录入；已有成绩和靶型快照保留。</p>
    <div className="photo-target-actions">
     <Button kind="primary" onClick={()=>setOpen(false)}>保留当前选择</Button>
     <Button onClick={()=>{setOpen(false);onManual();}}>返回手动记分</Button>
    </div>
   </div>
  </Modal>}
 </section>;
}
