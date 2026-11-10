import { isTap } from './domain';

export type TargetView={scale:number;x:number;y:number};
export type SurfaceBox={left:number;top:number;width:number;height:number};
export type Contact={id:number;x:number;y:number;time:number;primary?:boolean};
export const initialTargetView=():TargetView=>({scale:1,x:0,y:0});
export function boundedView(view:TargetView):TargetView {
  const scale=Math.min(6,Math.max(1,view.scale)),limit=1.2-1.2/scale;
  return {scale,x:Math.min(limit,Math.max(-limit,view.x)),y:Math.min(limit,Math.max(-limit,view.y))};
}
export function insideSurface(x:number,y:number,box:SurfaceBox) {
  return x>=box.left&&x<=box.left+box.width&&y>=box.top&&y<=box.top+box.height;
}
export function surfacePoint(x:number,y:number,box:SurfaceBox,view:TargetView) {
  const side=Math.min(box.width,box.height),span=2.4/view.scale;
  return {x:view.x+(x-box.left-box.width/2)/side*span,y:view.y-(y-box.top-box.height/2)/side*span};
}
export function zoomAt(anchor:{x:number;y:number},origin:[number,number],box:SurfaceBox,scale:number) {
  const v=boundedView({scale,x:0,y:0}),offset=surfacePoint(...origin,box,v);
  return boundedView({scale:v.scale,x:anchor.x-offset.x,y:anchor.y-offset.y});
}
/** A multi-contact gesture stays ineligible until EVERY contact has left. */
export class TargetTapGate {
  private contacts=new Map<number,Contact>();
  private blocked=false;
  get count(){return this.contacts.size;}
  down(contact:Contact){if(!this.contacts.size)this.blocked=contact.primary===false;else this.blocked=true;this.contacts.set(contact.id,contact);}
  move(contact:Contact){const start=this.contacts.get(contact.id);if(start&&Math.hypot(contact.x-start.x,contact.y-start.y)>9)this.block();}
  block(){this.blocked=true;}
  end(contact:Contact,cancelled=false){
    const start=this.contacts.get(contact.id);
    const tap=!cancelled&&!this.blocked&&this.contacts.size===1&&!!start&&isTap(start,contact,false);
    if(cancelled)this.blocked=true;
    this.contacts.delete(contact.id);if(!this.contacts.size)this.blocked=false;
    return tap;
  }
  clear(){this.contacts.clear();this.blocked=false;}
}
