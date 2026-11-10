import type {AutoFace,AutoPoint} from '../auto-target';

export type PhotoReviewView={scale:number;x:number;y:number};
export type ReviewSurfaceBox={left:number;top:number;width:number;height:number};
export const initialPhotoReviewView=():PhotoReviewView=>({scale:1,x:0,y:0});

/** Explain the existing persistence mode; this does not change scoring. */
export function photoSaveModeNotice(saveCoordinates:boolean):string{
 return saveCoordinates
  ?'实验坐标会作为参考点展示，不参加可信散布计算；环值仍需按原图核对，不自动判压线。'
  :'环值为估算，压线请按原图更正；本批只存环值，不计入落点分布。';
}

export function scoreOrderValue(code:string):number{
 if(code==='X')return 11;if(code==='M')return 0;const value=Number(code);return Number.isFinite(value)?value:-1;
}

export function moveArrayItem<T>(items:T[],from:number,to:number):T[]{
 if(from<0||from>=items.length||to<0||to>=items.length||from===to)return items;
 const next=[...items],[item]=next.splice(from,1);next.splice(to,0,item);return next;
}

export function adjacentCandidateId(ids:string[],selected:string|null,offset:-1|1):string|null{
 if(!ids.length)return null;
 const current=Math.max(0,ids.indexOf(selected??''));
 return ids[Math.min(ids.length-1,Math.max(0,current+offset))];
}

export function nudgePhotoPoint(point:AutoPoint,dxPixels:number,dyPixels:number,width:number,height:number):AutoPoint{
 if(width<1||height<1||!Number.isFinite(width)||!Number.isFinite(height))return point;
 return {x:Math.min(1,Math.max(0,point.x+dxPixels/width)),y:Math.min(1,Math.max(0,point.y+dyPixels/height))};
}

export type TargetPointDisposition='invalid'|'inside'|'miss-located'|'miss-unlocated';
export function targetPointDisposition(point:AutoPoint|null):TargetPointDisposition{
 if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return 'invalid';
 if(Math.hypot(point.x,point.y)<=1)return 'inside';
 return Math.abs(point.x)<=1.2&&Math.abs(point.y)<=1.2?'miss-located':'miss-unlocated';
}

export function boundedPhotoReviewView(view:PhotoReviewView):PhotoReviewView{
 const scale=Math.min(6,Math.max(1,view.scale)),limit=1.2-1.2/scale;
 return {scale,x:Math.min(limit,Math.max(-limit,view.x)),y:Math.min(limit,Math.max(-limit,view.y))};
}

/** Photo pixels (+y down) to canonical target coordinates (+y down). */
export function photoPointToTarget(face:AutoFace,point:AutoPoint,radiusRatio:number):AutoPoint{
 const dx=point.x-face.center.x,dy=point.y-face.center.y,[a,b,c,d]=face.inverse;
 return {x:(a*dx+b*dy)*radiusRatio,y:(c*dx+d*dy)*radiusRatio};
}

/** Canonical target coordinates (+y down) back to source-photo pixels. */
export function targetPointToPhoto(face:AutoFace,point:AutoPoint,radiusRatio:number):AutoPoint{
 const x=point.x/radiusRatio,y=point.y/radiusRatio,[a,b,c,d]=face.shape;
 return {x:face.center.x+a*x+b*y,y:face.center.y+c*x+d*y};
}

/** A mapped-pane addition is still a photo candidate, never confirmed target evidence. */
export function mappedPhotoAddition(face:AutoFace|null,point:AutoPoint,radiusRatio:number,width:number,height:number):AutoPoint|null{
 if(!face||![point.x,point.y,radiusRatio,width,height,face.center.x,face.center.y,...face.shape,...face.inverse].every(Number.isFinite)
   ||radiusRatio<=0||width<=0||height<=0||Math.abs(point.x)>1.2||Math.abs(point.y)>1.2)return null;
 const [a,b,c,d]=face.shape;if(Math.abs(a*d-b*c)<1e-12)return null;
 const pixel=targetPointToPhoto(face,point,radiusRatio),normalized={x:pixel.x/width,y:pixel.y/height};
 if(normalized.x<0||normalized.x>1||normalized.y<0||normalized.y>1)return null;
 const back=photoPointToTarget(face,pixel,radiusRatio);
 if(!Number.isFinite(back.x)||!Number.isFinite(back.y)||Math.abs(back.x-point.x)>1e-7||Math.abs(back.y-point.y)>1e-7)return null;
 return normalized;
}

/**
 * Optional recovery adjustment for an otherwise accepted near-frontal fit.
 * It changes only the fitted centre and uniform scale; it is not perspective
 * correction and never asks the user for four calibration points.
 */
export function adjustAutoFace(face:AutoFace,dxPixels:number,dyPixels:number,scale:number,width:number,height:number):AutoFace{
 const safeScale=Math.min(1.15,Math.max(.85,Number.isFinite(scale)?scale:1));
 const dx=Math.min(width*.08,Math.max(-width*.08,Number.isFinite(dxPixels)?dxPixels:0));
 const dy=Math.min(height*.08,Math.max(-height*.08,Number.isFinite(dyPixels)?dyPixels:0));
 const [a,b,c,d]=face.shape.map(value=>value*safeScale) as AutoFace['shape'];
 const center={x:face.center.x+dx,y:face.center.y+dy};
 return {...face,center,shape:[a,b,c,d],inverse:face.inverse.map(value=>value/safeScale) as AutoFace['inverse'],radius:face.radius*safeScale,controls:[
  {x:(center.x-b)/width,y:(center.y-d)/height},
  {x:(center.x+a)/width,y:(center.y+c)/height},
  {x:(center.x+b)/width,y:(center.y+d)/height},
  {x:(center.x-a)/width,y:(center.y-c)/height},
 ]};
}

/** SVG matrix mapping the original image directly into canonical target space. */
export function photoImageMatrix(face:AutoFace,radiusRatio:number){
 const [a,b,c,d]=face.inverse;
 return {a:a*radiusRatio,b:c*radiusRatio,c:b*radiusRatio,d:d*radiusRatio,e:-(a*face.center.x+b*face.center.y)*radiusRatio,f:-(c*face.center.x+d*face.center.y)*radiusRatio};
}

/** Display-only fit of a photo; these coordinates are never target coordinates. */
export function rawPhotoDisplayMatrix(width:number,height:number){
 const scale=2.2/Math.max(1,width,height);
 return {a:scale,b:0,c:0,d:scale,e:-width*scale/2,f:-height*scale/2};
}
export function rawPhotoPointToDisplay(point:AutoPoint,width:number,height:number):AutoPoint{
 const m=rawPhotoDisplayMatrix(width,height);
 return {x:point.x*width*m.a+m.e,y:point.y*height*m.d+m.f};
}
/** Inverse display fit; the caller rejects clicks in the letterbox area. */
export function displayPointToRawPhoto(point:AutoPoint,width:number,height:number):AutoPoint{
 const m=rawPhotoDisplayMatrix(width,height);
 return {x:(point.x-m.e)/(width*m.a),y:(point.y-m.f)/(height*m.d)};
}

export function reviewSurfacePoint(clientX:number,clientY:number,box:ReviewSurfaceBox,view:PhotoReviewView):AutoPoint{
 const side=Math.min(box.width,box.height),span=2.4/view.scale;
 return {x:view.x+(clientX-box.left-box.width/2)/side*span,y:view.y+(clientY-box.top-box.height/2)/side*span};
}

export function zoomPhotoReviewAt(anchor:AutoPoint,clientX:number,clientY:number,box:ReviewSurfaceBox,scale:number):PhotoReviewView{
 const next=boundedPhotoReviewView({scale,x:0,y:0}),span=2.4/next.scale,side=Math.min(box.width,box.height);
 return boundedPhotoReviewView({scale:next.scale,x:anchor.x-(clientX-box.left-box.width/2)/side*span,y:anchor.y-(clientY-box.top-box.height/2)/side*span});
}
