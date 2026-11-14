import React,{useEffect,useRef,useState} from 'react';
import {useGesture} from '@use-gesture/react';
import type {Arrow,Target} from './domain';
import {boundedView,initialTargetView,insideSurface,surfacePoint,TargetTapGate,zoomAt,type TargetView} from './target-interaction';

type TargetFaceProps={target:Target;arrows?:Arrow[];selected?:string|null;face?:number;onTap?:(x:number,y:number)=>void;size?:string;overlay?:React.ReactNode;annotation?:React.ReactNode;zoomable?:boolean;resetKey?:string;review?:boolean;guideTarget?:string};
const pointSource = (arrow: Arrow) => arrow.source !== 'photo'
  ? 'target' : arrow.coordinateEvidence === 'manual-target-confirmed' ? 'photo-manual' : 'photo-mapped';

function denseReviewDots(arrows: Arrow[]) {
  const groups = new Map<string, string[]>();
  for (const arrow of arrows) {
    const source = pointSource(arrow);
    const x = (arrow.x! - .027).toFixed(4), y = (-arrow.y!).toFixed(4);
    const d = `M${x} ${y}a.027 .027 0 1 0 .054 0a.027 .027 0 1 0 -.054 0Z`;
    const list = groups.get(source);
    if (list) list.push(d);
    else groups.set(source, [d]);
  }
  return Array.from(groups, ([source, paths]) => <path key={source} data-point-source={source}
    data-point-count={paths.length} d={paths.join('')} fill={source === 'photo-mapped' ? 'white' : '#172c59'}
    stroke={source === 'photo-mapped' ? '#5d7397' : '#fff'} strokeWidth=".009" />);
}
export function TargetFaceRings({target,review=false}:{target:Target;review?:boolean}) {
  const rings=target.ring_rules??[];
  const visible=review?rings.filter((ring,index)=>ring.color.toLowerCase()!==rings[index+1]?.color.toLowerCase()):rings;
  const circles=[...visible].reverse().map(r=><circle key={r.score_code} r={r.outer_radius_norm*2} fill={r.color}
    stroke={['3','4'].includes(r.score_code)?'#eee':'#46483d'} strokeWidth={review?'.008':'.004'}/>);
  return review?<g data-target-rings="review">{circles}</g>:<>{circles}</>;
}
export function TargetFace(props:TargetFaceProps) {
  // A different scoring scene must also dispose the gesture library's active contacts.
  return <TargetSurface key={`${props.target.id}:${props.face??1}:${props.resetKey??''}`} {...props}/>;
}
function TargetSurface({target,arrows=[],selected,face=1,onTap,size='normal',overlay,annotation,zoomable=false,resetKey='',review=false,guideTarget}:TargetFaceProps) {
  const surface=useRef<SVGSVGElement>(null),gate=useRef(new TargetTapGate()),current=useRef(initialTargetView());
  const [view,setView]=useState(initialTargetView),[touch,setTouch]=useState(false);
  const panEnabled=zoomable&&(!review||view.scale>1);
  const changeView=(next:TargetView)=>{current.current=boundedView(next);setView(current.current);};
  const reset=()=>{gate.current.clear();setTouch(false);changeView(initialTargetView());};
  const zoom=(factor:number)=>{gate.current.block();setTouch(false);changeView({...current.current,scale:current.current.scale*factor});};
  const keyboard=(event:React.KeyboardEvent<SVGSVGElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const key=event.key,step=.24/current.current.scale;
    if(!['+','=','-','_','0','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return;
    event.preventDefault();gate.current.block();setTouch(false);
    if(key==='+'||key==='=')zoom(1.5);
    else if(key==='-'||key==='_')zoom(1/1.5);
    else if(key==='0'||key==='Home')reset();
    else changeView({...current.current,x:current.current.x+(key==='ArrowRight'?step:key==='ArrowLeft'?-step:0),y:current.current.y+(key==='ArrowUp'?step:key==='ArrowDown'?-step:0)});
  };
  useEffect(reset,[target.id,face,resetKey]);
  useEffect(()=>{gate.current.block();setTouch(false);},[selected,onTap===undefined]);
  useEffect(()=>{const cancel=()=>{gate.current.clear();setTouch(false);};window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',cancel);return()=>{window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',cancel);gate.current.clear();};},[]);
  useEffect(()=>{
    // Another finger anywhere on the page invalidates an in-progress target tap.
    const anotherContact=()=>{if(gate.current.count){gate.current.block();setTouch(false);}};
    window.addEventListener('pointerdown',anotherContact,true);
    return()=>window.removeEventListener('pointerdown',anotherContact,true);
  },[]);
  useGesture({
    onPinch:({first,origin,offset:[scale],memo})=>{
      gate.current.block();setTouch(false);const box=surface.current?.getBoundingClientRect();if(!box?.width)return;
      const anchor=first?surfacePoint(...origin,box,current.current):memo;
      if(anchor)changeView(zoomAt(anchor,origin,box,scale));return anchor;
    },
    onDrag:({delta:[dx,dy],first,pinching})=>{
      if(first||pinching||gate.current.count>1||current.current.scale<=1)return;
      const box=surface.current?.getBoundingClientRect();if(!box?.width)return;
      gate.current.block();const span=2.4/current.current.scale;
      changeView({...current.current,x:current.current.x-dx/Math.min(box.width,box.height)*span,y:current.current.y+dy/Math.min(box.width,box.height)*span});
    }
  },{
    target:surface,enabled:zoomable,eventOptions:{passive:false},
    // At the original size, one finger scrolls the page while two fingers control the target.
    pinch:{from:()=>[current.current.scale,0],scaleBounds:{min:1,max:6},rubberband:false,pinchOnWheel:false,pointer:{touch:review},preventDefault:review},
    drag:{enabled:panEnabled,threshold:9,filterTaps:true,pointer:{keys:false},preventDefault:true}
  });
  const contact=(e:React.PointerEvent<SVGSVGElement>)=>({id:e.pointerId,x:e.clientX,y:e.clientY,time:Date.now(),primary:e.isPrimary});
  const up=(e:React.PointerEvent<SVGSVGElement>)=>{
    const accepted=gate.current.end(contact(e),!insideSurface(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect()));setTouch(false);if(!accepted||!onTap)return;
    // SVG's actual inverse matrix includes its viewBox, layout and page scrolling.
    const matrix=e.currentTarget.getScreenCTM();if(!matrix)return;
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),x=p.x,y=-p.y;
    if(Math.abs(x)<=1.2&&Math.abs(y)<=1.2)onTap(x,y);
  };
  const span=2.4/view.scale;
  const plotted=arrows.filter(a=>a.face===face&&a.x!==null&&a.y!==null);
  const dense=review&&plotted.length>500;
  const individual=dense?plotted.filter(a=>a.id===selected):plotted;
  return <div className={zoomable?(review?'target-workspace target-review-workspace':'target-workspace'):'target-static'}>
    {zoomable&&!review&&<div className="target-zoom-tools"><span>双指或按钮缩放 · 放大后拖动</span><button type="button" onClick={()=>zoom(1/1.5)} disabled={view.scale<=1} aria-label="缩小靶纸">−</button><button type="button" onClick={()=>zoom(1.5)} disabled={view.scale>=6} aria-label="放大靶纸">＋</button><button type="button" onClick={reset} disabled={view.scale===1}>还原靶纸</button><output aria-label="靶纸缩放比例">{Math.round(view.scale*100)}%</output></div>}
    <svg ref={surface} className={`target ${size} ${panEnabled?'zoomable':''} ${touch?'touching':''}`} viewBox={`${view.x-span/2} ${-view.y-span/2} ${span} ${span}`} aria-label={onTap?'点击靶面录入，边框内白区为M':'实际落点图'} role="img"
      data-guide-target={guideTarget} tabIndex={zoomable?0:undefined} onKeyDown={zoomable?keyboard:undefined} aria-keyshortcuts={zoomable?'+ - 0 Home ArrowLeft ArrowRight ArrowUp ArrowDown':undefined}
      aria-description={zoomable?(review?'双指缩放。键盘可用加减键缩放、方向键移动，按 0 或 Home 还原。':'聚焦靶面后，按加减键缩放、方向键移动，按0或Home还原；这些按键不会录入箭。'):undefined}
      onPointerDownCapture={e=>{if(e.button!==0)return;gate.current.down(contact(e));setTouch(gate.current.count===1&&!!onTap);}}
      onPointerMoveCapture={e=>{if(!insideSurface(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect()))gate.current.block();gate.current.move(contact(e));}}
      onPointerUpCapture={up}
      onPointerCancelCapture={e=>{gate.current.end(contact(e),true);setTouch(false);}}
      onLostPointerCapture={e=>{gate.current.end(contact(e),true);setTouch(false);}}
      onPointerLeave={()=>{gate.current.block();setTouch(false);}}>
      <rect x="-1.19" y="-1.19" width="2.38" height="2.38" rx=".02" fill="white" stroke="#8ca7c5" strokeWidth=".012"/>
      <TargetFaceRings target={target} review={review}/>
      <path d="M-.022 0H.022M0-.022V.022" stroke="#30332f" strokeWidth=".004"/>
      {overlay}
      {dense&&denseReviewDots(plotted.filter(a=>a.id!==selected))}
      {individual.map(a=>{const source=pointSource(a),reference=review&&source==='photo-mapped';return <g key={a.id} data-point-source={source}><circle cx={a.x!} cy={-a.y!} r={a.id===selected?'.043':'.027'} fill={a.id===selected||reference?'#fff':'#172c59'} stroke={reference?'#5d7397':'#fff'} strokeWidth=".009"/>{a.id===selected&&<circle cx={a.x!} cy={-a.y!} r=".058" fill="none" stroke="#082572" strokeWidth=".012"/>}</g>;})}
      {annotation}
      {!review&&<text x="1.09" y="-1.08" textAnchor="middle" fontSize=".09" fill="#536d86">M</text>}
    </svg>
    {zoomable&&review&&view.scale>1&&<button className="target-review-reset" type="button" onClick={()=>{surface.current?.focus({preventScroll:true});reset();}} aria-label="还原靶纸">还原</button>}
  </div>;
}
