export type ReviewRoute = {name:string;id?:string};
type ReturnState = {reviewReturn:{path:string;index:number}};
const reviewNames = new Set(['history','history-all','insights','trends','compare','detail','reflection','report','group']);
const sessionNames = new Set(['insights','detail','reflection']);
export const isReviewRoute = (name:string)=>reviewNames.has(name);
const pathFor = ({name,id}:ReviewRoute)=>'/'+name+(id?'?id='+encodeURIComponent(id):'');

function returnState(state:unknown):ReturnState['reviewReturn']|null {
 const value=(state as Partial<ReturnState>|null)?.reviewReturn;
 if(!value||typeof value.path!=='string'||!Number.isInteger(value.index)||value.index<0)return null;
 // Training can open a completed record directly. Other return targets stay inside review.
 if(value.path!=='/training'&&!/^\/(history|history-all|insights|trends|compare|detail|reflection|report|group)(\?id=[^&#]*)?$/.test(value.path))return null;
 return value;
}

export function reviewNavigation(current:ReviewRoute,target:ReviewRoute,state:unknown,index:number) {
 if(!isReviewRoute(target.name))return {};
 const sameSession=sessionNames.has(current.name)&&sessionNames.has(target.name)&&current.id===target.id;
 const selectingSession=sessionNames.has(current.name)&&target.name==='insights';
 if(sameSession||selectingSession)return {replace:true,state:returnState(state)?state:null};
 const hasReviewParent=isReviewRoute(current.name)||(current.name==='training'&&target.name==='detail');
 return {state:hasReviewParent?{reviewReturn:{path:pathFor(current),index:Math.max(0,index)}}:null};
}

export function reviewBackTarget(route:ReviewRoute,state:unknown,index:number) {
 const parent=returnState(state);
 const fallback=route.name==='group'&&route.id?pathFor({name:'detail',id:route.id.split(':')[0]}):
  route.name==='report'&&route.id?pathFor({name:'insights',id:route.id}):'/history';
 const path=parent?.path??fallback;
 const parentName=path.slice(1).split('?')[0];
 const label=parentName==='training'?'返回训练':parentName==='history-all'?'返回训练记录':parentName==='trends'?'返回长期分析':parentName==='compare'?'返回长期分析':parentName==='detail'?'返回单场复盘':parentName==='reflection'?'返回训练心得':parentName==='insights'?'返回单场复盘':'返回复盘';
 return {path,label,useHistory:!!parent&&index>0&&parent.index===index-1};
}
