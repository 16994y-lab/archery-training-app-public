import React from 'react';
import {Button} from './ui';

/** The pad changes the selected photo point by source-image pixels. */
export function PhotoReviewNudge({disabled,step,onStep,onNudge}:{disabled:boolean;step:1|4;onStep:(step:1|4)=>void;onNudge:(dx:number,dy:number)=>void}){
 return <aside className="photo-review-nudge" aria-label="照片点位微调">
  <div className="photo-review-step" role="group" aria-label="微调步长">
   <Button disabled={disabled} aria-pressed={step===1} kind={step===1?'selected':''} onClick={()=>onStep(1)}>1px</Button>
   <Button disabled={disabled} aria-pressed={step===4} kind={step===4?'selected':''} onClick={()=>onStep(4)}>4px</Button>
  </div>
  <div className="photo-review-directions" role="group" aria-label="移动选中照片点">
   <Button disabled={disabled} className="nudge-up" aria-label="选中照片点向上移动" onClick={()=>onNudge(0,-1)}>↑</Button>
   <Button disabled={disabled} className="nudge-left" aria-label="选中照片点向左移动" onClick={()=>onNudge(-1,0)}>←</Button>
   <span aria-hidden="true">{step}px</span>
   <Button disabled={disabled} className="nudge-right" aria-label="选中照片点向右移动" onClick={()=>onNudge(1,0)}>→</Button>
   <Button disabled={disabled} className="nudge-down" aria-label="选中照片点向下移动" onClick={()=>onNudge(0,1)}>↓</Button>
  </div>
 </aside>;
}
