import React,{useEffect,useRef,useState} from 'react';
import {useGesture} from '@use-gesture/react';
import type {Arrow,Target} from './domain';
import {boundedView,initialTargetView,insideSurface,surfacePoint,TargetTapGate,zoomAt,type TargetView} from './target-interaction';

type TargetFaceProps={target:Target;arrows?:Arrow[];selected?:string|null;face?:number;onTap?:(x:number,y:number)=>void;size?:string;overlay?:React.ReactNode;zoomable?:boolean;resetKey?:string};
export function TargetFace(props:TargetFaceProps) {
  // A different scoring scene must also dispose the gesture library's active contacts.
  return <TargetSurface key={`${props.target.id}:${props.face??1}:${props.resetKey??''}`} {...props}/>;
}
function TargetSurface({target,arrows=[],selected,face=1,onTap,size='normal',overlay,zoomable=false,resetKey=''}:TargetFaceProps) {
  const surface=useRef<SVGSVGElement>(null),gate=useRef(new TargetTapGate()),current=useRef(initialTargetView());
  const [view,setView]=useState(initialTargetView),[touch,setTouch]=useState(false);
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
  },{target:surface,enabled:zoomable,eventOptions:{passive:false},pinch:{from:()=>[current.current.scale,0],scaleBounds:{min:1,max:6},rubberband:false,pinchOnWheel:false},drag:{threshold:9,filterTaps:true,pointer:{keys:false},preventDefault:true}});
  const contact=(e:React.PointerEvent<SVGSVGElement>)=>({id:e.pointerId,x:e.clientX,y:e.clientY,time:Date.now(),primary:e.isPrimary});
  const up=(e:React.PointerEvent<SVGSVGElement>)=>{
    const accepted=gate.current.end(contact(e),!insideSurface(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect()));setTouch(false);if(!accepted||!onTap)return;
    // SVG's actual inverse matrix includes its viewBox, layout and page scrolling.
    const matrix=e.currentTarget.getScreenCTM();if(!matrix)return;
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),x=p.x,y=-p.y;
    if(Math.abs(x)<=1.2&&Math.abs(y)<=1.2)onTap(x,y);
  };
  const span=2.4/view.scale;
  return <div className={zoomable?'target-workspace':'target-static'}>
    {zoomable&&<div className="target-zoom-tools"><span>双指或按钮缩放 · 放大后拖动</span><button type="button" onClick={()=>zoom(1/1.5)} disabled={view.scale<=1} aria-label="缩小靶纸">−</button><button type="button" onClick={()=>zoom(1.5)} disabled={view.scale>=6} aria-label="放大靶纸">＋</button><button type="button" onClick={reset} disabled={view.scale===1}>还原靶纸</button><output aria-label="靶纸缩放比例">{Math.round(view.scale*100)}%</output></div>}
    <svg ref={surface} className={`target ${size} ${zoomable?'zoomable':''} ${touch?'touching':''}`} viewBox={`${view.x-span/2} ${-view.y-span/2} ${span} ${span}`} aria-label={onTap?'点击靶面录入，边框内白区为M':'实际落点图'} role="img"
      tabIndex={zoomable?0:undefined} onKeyDown={zoomable?keyboard:undefined} aria-keyshortcuts={zoomable?'+ - 0 Home ArrowLeft ArrowRight ArrowUp ArrowDown':undefined}
      aria-description={zoomable?'聚焦靶面后，按加减键缩放、方向键移动，按0或Home还原；这些按键不会录入箭。':undefined}
      onPointerDownCapture={e=>{if(e.button!==0)return;gate.current.down(contact(e));setTouch(gate.current.count===1&&!!onTap);}}
      onPointerMoveCapture={e=>{if(!insideSurface(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect()))gate.current.block();gate.current.move(contact(e));}}
      onPointerUpCapture={up}
      onPointerCancelCapture={e=>{gate.current.end(contact(e),true);setTouch(false);}}
      onLostPointerCapture={e=>{gate.current.end(contact(e),true);setTouch(false);}}
      onPointerLeave={()=>{gate.current.block();setTouch(false);}}>
      <rect x="-1.19" y="-1.19" width="2.38" height="2.38" rx=".02" fill="white" stroke="#8ca7c5" strokeWidth=".012"/>
      {[...(target.ring_rules??[])].reverse().map(r=><circle key={r.score_code} r={r.outer_radius_norm*2} fill={r.color} stroke={['3','4'].includes(r.score_code)?'#eee':'#46483d'} strokeWidth=".004"/>)}
      <path d="M-.022 0H.022M0-.022V.022" stroke="#30332f" strokeWidth=".004"/>
      {overlay}
      {arrows.filter(a=>a.face===face&&a.x!==null&&a.y!==null).map(a=>{const estimated=a.source==='photo'&&a.coordinateEvidence!=='manual-target-confirmed';return <g key={a.id} data-point-source={estimated?'photo-mapped':a.source==='photo'?'photo-manual':'target'}><circle cx={a.x!} cy={-a.y!} r={a.id===selected?'.043':'.027'} fill={a.id===selected?'#fff':'#172c59'} stroke="#fff" strokeWidth=".009"/>{a.id===selected&&<circle cx={a.x!} cy={-a.y!} r=".058" fill="none" stroke="#082572" strokeWidth=".012"/>}</g>;})}
      <text x="1.09" y="-1.08" textAnchor="middle" fontSize=".09" fill="#536d86">M</text>
    </svg>
  </div>;
}
