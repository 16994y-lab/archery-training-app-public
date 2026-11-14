import React,{useEffect,useRef,useState} from 'react';
import type {AutoFace} from '../auto-target';
import type {Candidate} from '../photo-geometry';
import type {LocalPhoto} from '../photo-image';
import type {Target} from './domain';
import {boundedPhotoReviewView,displayPointToRawPhoto,rawPhotoDisplayMatrix,rawPhotoPointToDisplay,initialPhotoReviewView,mappedPhotoAddition,photoImageMatrix,photoPointToTarget,reviewSurfacePoint,targetPointToPhoto,zoomPhotoReviewAt,type PhotoReviewView} from './photo-review';
import {Button} from './ui';

export type PhotoReviewLayout='photo'|'target'|'split';
type Props={photo:LocalPhoto;geometry:AutoFace|null;radiusRatio:number;target:Target;candidates:Candidate[];selected:string|null;adding:boolean;frozen:boolean;layout:PhotoReviewLayout;showAlignment:boolean;showZoomControls?:boolean;onSelect:(id:string)=>void;onAdd:(point:{x:number;y:number})=>void;manualPoints?:Record<string,{x:number;y:number}>;markingCandidateId?:string|null;onTargetPoint?:(point:{x:number;y:number})=>void};

export function PhotoComparison(props:Props){
 const [view,setView]=useState<PhotoReviewView>(initialPhotoReviewView);
 useEffect(()=>setView(initialPhotoReviewView()),[props.photo.url,props.geometry?.center.x,props.geometry?.center.y,props.radiusRatio,props.layout]);
 const zoom=(factor:number)=>setView(v=>boundedPhotoReviewView({...v,scale:v.scale*factor}));
 const zoomLabel=props.layout==='photo'||!props.geometry?'原照片缩放':props.layout==='split'?'两图按同一靶面坐标同步':'靶面缩放';
 return <>
  {props.showZoomControls!==false&&<div className="media-zoom-tools" aria-label={zoomLabel}>
   <span>{zoomLabel}</span><Button disabled={view.scale<=1} onClick={()=>zoom(.8)}>缩小</Button><output>{Math.round(view.scale*100)}%</output><Button disabled={view.scale>=6} onClick={()=>zoom(1.25)}>放大</Button><Button disabled={view.scale===1&&view.x===0&&view.y===0} onClick={()=>setView(initialPhotoReviewView())}>还原</Button>
  </div>}
  <div className={`media-compare media-compare-${props.layout}`}>
   {props.layout!=='target'&&<ReviewSurface kind="photo" {...props} view={view} setView={setView}/>}
   {props.layout!=='photo'&&<ReviewSurface kind="target" {...props} view={props.geometry?view:initialPhotoReviewView()} setView={setView}/>}
  </div>
 </>;
}

function ReviewSurface({kind,layout,photo,geometry,radiusRatio,target,candidates,selected,adding,frozen,showAlignment,view,setView,onSelect,onAdd,manualPoints={},markingCandidateId,onTargetPoint}:{kind:'photo'|'target';view:PhotoReviewView;setView:React.Dispatch<React.SetStateAction<PhotoReviewView>>}&Props){
 const surface=useRef<SVGSVGElement>(null),pointers=useRef(new Map<number,{x:number;y:number}>()),last=useRef<{x:number;y:number}|null>(null),tap=useRef<{x:number;y:number;time:number;moved:boolean}|null>(null),pinch=useRef<{distance:number;anchor:{x:number;y:number};view:PhotoReviewView}|null>(null);
 const referenceOnly=kind==='target'&&!geometry;
 // A standalone photo keeps its original proportions. The split view still
 // shares target coordinates between both panes when the fit is available.
 const displayGeometry=layout==='photo'?null:geometry;
 const [keyboardPoint,setKeyboardPoint]=useState({x:.5,y:.5}),[keyboardTarget,setKeyboardTarget]=useState({x:0,y:0}),[keyboardFocus,setKeyboardFocus]=useState(false);
 const points=referenceOnly?[]:candidates.map(c=>({candidate:c,target:displayGeometry?photoPointToTarget(displayGeometry,{x:c.point.x*photo.canvas.width,y:c.point.y*photo.canvas.height},radiusRatio):rawPhotoPointToDisplay(c.point,photo.canvas.width,photo.canvas.height)}));
 const span=2.4/view.scale,matrix=displayGeometry?photoImageMatrix(displayGeometry,radiusRatio):rawPhotoDisplayMatrix(photo.canvas.width,photo.canvas.height);
 const selectedPoint=points.find(item=>item.candidate.id===selected)?.target;
 useEffect(()=>{pointers.current.clear();last.current=null;tap.current=null;pinch.current=null;},[photo.url]);
 useEffect(()=>{if(!selectedPoint)return;setView(current=>{if(current.scale===1)return current;const visible=2.4/current.scale,margin=visible*.12;if(selectedPoint.x>=current.x-visible/2+margin&&selectedPoint.x<=current.x+visible/2-margin&&selectedPoint.y>=current.y-visible/2+margin&&selectedPoint.y<=current.y+visible/2-margin)return current;return boundedPhotoReviewView({...current,x:selectedPoint.x,y:selectedPoint.y});});},[selected,selectedPoint?.x,selectedPoint?.y,setView]);
 function down(e:React.PointerEvent<SVGSVGElement>){
  if(frozen||referenceOnly||e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});last.current={x:e.clientX,y:e.clientY};
  tap.current=pointers.current.size===1?{x:e.clientX,y:e.clientY,time:Date.now(),moved:false}:null;
  if(pointers.current.size===2){const [a,b]=[...pointers.current.values()],cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,box=e.currentTarget.getBoundingClientRect();pinch.current={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),anchor:reviewSurfacePoint(cx,cy,box,view),view};}
 }
 function move(e:React.PointerEvent<SVGSVGElement>){
  if(frozen||referenceOnly||!pointers.current.has(e.pointerId))return;const previous=pointers.current.get(e.pointerId)!;pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(tap.current&&Math.hypot(e.clientX-tap.current.x,e.clientY-tap.current.y)>8)tap.current.moved=true;
  const box=e.currentTarget.getBoundingClientRect(),values=[...pointers.current.values()];
  if(values.length>=2&&pinch.current){const [a,b]=values,cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,scale=pinch.current.view.scale*Math.hypot(a.x-b.x,a.y-b.y)/pinch.current.distance;setView(zoomPhotoReviewAt(pinch.current.anchor,cx,cy,box,scale));return;}
  if(values.length===1&&view.scale>1){const dx=e.clientX-previous.x,dy=e.clientY-previous.y;if(dx||dy)setView(v=>boundedPhotoReviewView({...v,x:v.x-dx/Math.min(box.width,box.height)*(2.4/v.scale),y:v.y-dy/Math.min(box.width,box.height)*(2.4/v.scale)}));}
  last.current={x:e.clientX,y:e.clientY};
 }
 function finish(e:React.PointerEvent<SVGSVGElement>,cancelled=false){
  const one=pointers.current.size===1,start=tap.current;pointers.current.delete(e.pointerId);
  if(!pointers.current.size){pinch.current=null;last.current=null;tap.current=null;}else{tap.current=null;pinch.current=null;}
  if(frozen||referenceOnly||cancelled||!one||!start||start.moved||Date.now()-start.time>=650)return;
  const box=e.currentTarget.getBoundingClientRect(),targetPoint=reviewSurfacePoint(e.clientX,e.clientY,box,view);
  if(kind==='target'&&geometry&&markingCandidateId&&onTargetPoint){onTargetPoint({x:targetPoint.x,y:-targetPoint.y});return;}
  // In explicit add mode every tap is a new point, even when two shafts are very close.
  if(kind==='target'&&adding){const point=mappedPhotoAddition(geometry,targetPoint,radiusRatio,photo.canvas.width,photo.canvas.height);if(point)onAdd(point);return;}
  if(kind==='photo'&&adding){const pixel=displayGeometry?targetPointToPhoto(displayGeometry,targetPoint,radiusRatio):null,point=pixel?{x:pixel.x/photo.canvas.width,y:pixel.y/photo.canvas.height}:displayPointToRawPhoto(targetPoint,photo.canvas.width,photo.canvas.height);if(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1)onAdd(point);return;}
  // Select by nearest screen-space point instead of overlapping SVG hit circles.
  const side=Math.min(box.width,box.height),nearest=points.map(({candidate,target:p})=>({id:candidate.id,distance:Math.hypot(p.x-targetPoint.x,p.y-targetPoint.y)*side/span})).sort((a,b)=>a.distance-b.distance)[0];
  if(nearest&&nearest.distance<=32)onSelect(nearest.id);
 }
 function wheel(e:React.WheelEvent<SVGSVGElement>){if(frozen||referenceOnly)return;e.preventDefault();const box=e.currentTarget.getBoundingClientRect(),anchor=reviewSurfacePoint(e.clientX,e.clientY,box,view);setView(zoomPhotoReviewAt(anchor,e.clientX,e.clientY,box,view.scale*(e.deltaY<0?1.25:.8)));}
 function key(e:React.KeyboardEvent<SVGSVGElement>){
  if(frozen||!adding||referenceOnly)return;
  if(displayGeometry){
   if(e.key==='Enter'||e.key===' '){e.preventDefault();const point=mappedPhotoAddition(displayGeometry,keyboardTarget,radiusRatio,photo.canvas.width,photo.canvas.height);if(!e.repeat&&point)onAdd(point);return;}
   const step=e.shiftKey ? .04 : .01,delta:Record<string,{x:number;y:number}>={ArrowLeft:{x:-step,y:0},ArrowRight:{x:step,y:0},ArrowUp:{x:0,y:-step},ArrowDown:{x:0,y:step}},change=delta[e.key];
   if(!change)return;e.preventDefault();const next={x:Math.min(1.2,Math.max(-1.2,keyboardTarget.x+change.x)),y:Math.min(1.2,Math.max(-1.2,keyboardTarget.y+change.y))};setKeyboardTarget(next);setView(current=>boundedPhotoReviewView({...current,x:next.x,y:next.y}));return;
  }
  if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!e.repeat)onAdd(keyboardPoint);return;}
  const step=e.shiftKey ? .02 : .005,delta:Record<string,{x:number;y:number}>={ArrowLeft:{x:-step,y:0},ArrowRight:{x:step,y:0},ArrowUp:{x:0,y:-step},ArrowDown:{x:0,y:step}};
  const move=delta[e.key];if(!move)return;e.preventDefault();const point={x:Math.min(1,Math.max(0,keyboardPoint.x+move.x)),y:Math.min(1,Math.max(0,keyboardPoint.y+move.y))};setKeyboardPoint(point);const p=rawPhotoPointToDisplay(point,photo.canvas.width,photo.canvas.height);setView(current=>boundedPhotoReviewView({...current,x:p.x,y:p.y}));
 }
 const cursorPoint=displayGeometry?keyboardTarget:rawPhotoPointToDisplay(keyboardPoint,photo.canvas.width,photo.canvas.height);
 return <figure className={`media-compare-pane media-compare-${kind}`}><figcaption>{kind==='photo'?'已标记实际照片':referenceOnly?'靶面参考 · 无映射':adding?'在此补点 · 同步至照片':markingCandidateId?'点此确认所选箭的靶面位置':'映射参考 · 实验'}</figcaption><svg ref={surface} viewBox={`${view.x-span/2} ${view.y-span/2} ${span} ${span}`} role="img" tabIndex={!referenceOnly&&!frozen?0:undefined} onKeyDown={key} onFocus={()=>setKeyboardFocus(true)} onBlur={()=>setKeyboardFocus(false)} aria-label={kind==='photo'?(geometry?'实际照片上的识别候选，可缩放和平移；补点时方向键移动光标，回车添加':'实际照片人工标记，可缩放；开启标记后方向键移动光标，回车添加'):referenceOnly?'靶面参考，未建立照片映射，不显示落点':adding?'映射靶面补点，方向键移动光标，回车添加；新增仍需对照照片核对':markingCandidateId?'请点击靶面，确认所选箭的实际位置':'与照片同步位置的实验性映射参考'} onPointerDown={down} onPointerMove={move} onPointerUp={e=>finish(e)} onPointerCancel={e=>finish(e,true)} onLostPointerCapture={e=>{if(pointers.current.has(e.pointerId))finish(e,true);}} onWheel={wheel}>
  {kind==='photo'?<><rect x="-1.2" y="-1.2" width="2.4" height="2.4" fill="#dfe6ec"/><image href={photo.url} width={photo.canvas.width} height={photo.canvas.height} transform={`matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`}/>{geometry&&showAlignment&&<g className="photo-alignment-overlay" aria-label="电子靶环线对齐参考">{[...(target.ring_rules??[])].filter((r,index,all)=>index===all.findIndex(item=>item.outer_radius_norm===r.outer_radius_norm)).map(r=><circle key={r.score_code} cx="0" cy="0" r={r.outer_radius_norm*2}/>) }<path d="M-.035 0H.035M0-.035V.035"/></g>}</>:<><rect x="-1.19" y="-1.19" width="2.38" height="2.38" rx=".02" fill="white" stroke="#8ca7c5" strokeWidth=".012"/>{[...(target.ring_rules??[])].reverse().map(r=><circle key={r.score_code} cx="0" cy="0" r={r.outer_radius_norm*2} fill={r.color} stroke={['3','4'].includes(r.score_code)?'#eee':'#46483d'} strokeWidth=".004"/>)}<path d="M-.022 0H.022M0-.022V.022" stroke="#30332f" strokeWidth=".004"/><text x="1.09" y="-1.08" textAnchor="middle" fontSize=".09" fill="#536d86">M</text></>}
  {points.map(({candidate,target:p})=><g key={candidate.id} data-candidate={candidate.id} className={`media-dot ${selected===candidate.id?'chosen':''}`}><circle className="media-hit" cx={p.x} cy={p.y} r={.09/view.scale}/><circle className="media-marker-halo" cx={p.x} cy={p.y} r={.014/view.scale}/><circle className="media-point" cx={p.x} cy={p.y} r={.012/view.scale}/>{selected===candidate.id&&<circle className="media-selected-ring" cx={p.x} cy={p.y} r={.023/view.scale}/>}</g>)}
  {kind==='target'&&geometry&&Object.entries(manualPoints).map(([id,point])=><g key={id} aria-label={`第 ${candidates.findIndex(candidate=>candidate.id===id)+1} 点人工确认位置`}><circle cx={point.x} cy={-point.y} r={.032/view.scale} fill="#fff" stroke="#bf5b0d" strokeWidth={.014/view.scale}/><circle cx={point.x} cy={-point.y} r={.009/view.scale} fill="#bf5b0d"/></g>)}
  {!referenceOnly&&adding&&keyboardFocus&&<path d={`M${cursorPoint.x-.035/view.scale} ${cursorPoint.y}h${.07/view.scale}M${cursorPoint.x} ${cursorPoint.y-.035/view.scale}v${.07/view.scale}`} stroke="#fff" strokeWidth={.006/view.scale} pointerEvents="none"/>}
 </svg></figure>;
}
