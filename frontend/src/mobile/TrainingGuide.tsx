import React, {useEffect,useLayoutEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Data} from './domain';
import {finishRegistrationIntro,registrationIntroStage} from './intro-preference';
import './training-guide.css';

const labels={
 'new-training':{number:1,title:'新开训练',hint:'点「新开训练」，设置这场训练。'},
 'choose-target':{number:2,title:'选择靶型',hint:'打开靶型图库，点选本场实际使用的靶型。'},
 'choose-target-option':{number:2,title:'选择靶型',hint:'从图库里选实际使用的靶型。'},
 'choose-size':{number:3,title:'选择尺寸',hint:'选择靶纸实际尺寸。不知道尺寸时可以选「未知」。'},
 'choose-distance':{number:4,title:'选择距离',hint:'点一个训练距离，也可以在「更多距离」自己填写。'},
 'start-training':{number:5,title:'开始这场训练',hint:'核对训练条件后，点「开始这场训练」。'},
 'target-mode':{number:6,title:'点靶录入',hint:'切回「点靶录入」，在靶面上记录一箭。'},
 'target-input':{number:6,title:'点靶录入',hint:'在靶面轻点实际落点，记录一箭。'},
 'number-mode':{number:7,title:'数字录入',hint:'点「数字录入」，切换到环值键盘。'},
 'number-input':{number:7,title:'数字录入',hint:'点这一箭的环值。X、10 和 M 分别选对应按键。'},
 'photo-mode':{number:8,title:'照片录入',hint:'点「照片录入」，用靶面照片记录下一箭。'},
 'photo-import':{number:8,title:'导入靶面照片',hint:'拍摄本组靶面，或从相册选择一张清晰照片。'},
 'photo-review':{number:8,title:'核对照片环值',hint:'对照实际照片核对候选。删掉误点、核对环值，再确认加入。'},
 'photo-missing-point':{number:8,title:'补记漏掉的一箭',hint:'若照片上确实有漏检的箭，打开「全屏对照」后用「补漏点」。人工核对时可直接标记。'},
 'photo-unsupported':{number:8,title:'当前靶型不支持照片录入',hint:'可以跳过引导并继续手动记分。想练习照片录入时，请用支持的靶型另开训练。'},
 'photo-confirm':{number:8,title:'确认照片成绩',hint:'确认环值和箭数准确后，把成绩加入本组。'},
 'photo-manual':{number:8,title:'手动核对照片',hint:'可以手动标记照片上的箭，选择实际环值后确认。'},
 'save-group':{number:9,title:'保存本组',hint:'点「保存本组并继续」，把刚录的成绩存下来。'},
 'finish-training':{number:9,title:'保存整场训练',hint:'点「结束训练」并确认，打开这场复盘。'},
 'resume-training':{number:6,title:'继续这场训练',hint:'点「继续训练」，接着完成上次的记分。'},
};
type GuideTarget=keyof typeof labels;
export type SetupGuideStep='choose-target'|'choose-size'|'choose-distance'|'start-training';
type GuideStep='new-training'|'resume-training'|'target-input'|'number-input'|'photo-import'|'save-group'|'finish-training';
const targetOrder:Partial<Record<GuideTarget,GuideTarget[]>>={
 'choose-target':['choose-target-option','choose-target'],
 'target-input':['target-input','target-mode'],
 'number-input':['number-input','number-mode'],
 'photo-import':['photo-unsupported','photo-manual','photo-confirm','photo-missing-point','photo-review','photo-import','photo-mode'],
};

const sessionKey=(owner:string)=>'gongxingji-training-guide-session-v1:'+owner;
function readSession(owner:string) {
 try{return localStorage.getItem(sessionKey(owner));}catch{return null;}
}
function storeSession(owner:string,id:string|null) {
 try{
  if(id)localStorage.setItem(sessionKey(owner),id);
  else localStorage.removeItem(sessionKey(owner));
 }catch{/* The current guide can continue in memory. */}
}

export function useTrainingGuide(owner:string|null,allowed:boolean,scene:string,data:Data,onComplete:()=>void){
 const [,refresh]=useState(0);
 const [replayOwner,setReplayOwner]=useState<string|null>(null);
 const [started,setStarted]=useState<{owner:string;id:string}|null>(null);
 useEffect(()=>{
  const changed=()=>refresh(n=>n+1);
  window.addEventListener('gongxingji-registration-intro',changed);
  return()=>window.removeEventListener('gongxingji-registration-intro',changed);
 },[]);
 const registration=allowed&&!!owner&&registrationIntroStage(owner)==='intro';
 const active=allowed&&!!owner&&(registration||replayOwner===owner);
 const sessionId=active&&owner?(started?.owner===owner?started.id:registration?readSession(owner):null):null;
 const session=sessionId?data.sessions.find(item=>item.id===sessionId):undefined;
 const end=session?.ends[session.currentEnd];
 const recorded=new Set(session?.ends.flatMap(group=>group.arrows.map(arrow=>arrow.source)));
 const saved=new Set(session?.ends.slice(0,session.currentEnd).filter(group=>group.confirmed).flatMap(group=>group.arrows.map(arrow=>arrow.source)));
 const methodsComplete=saved.has('target')&&saved.has('number')&&saved.has('photo');
 const close=()=>{
  if(!owner)return;
  if(registration){
   finishRegistrationIntro(owner);
   window.dispatchEvent(new Event('gongxingji-registration-intro'));
  }
  storeSession(owner,null);setStarted(null);setReplayOwner(null);
 };
 const completed=active&&methodsComplete&&session?.status==='completed';
 useEffect(()=>{
  if(completed){close();onComplete();}
 },[completed]);
 let step:GuideStep|null=null;
 if(active&&!completed){
  if(scene==='training')step=session?.status==='active'&&session.id===data.activeId?'resume-training':'new-training';
  if(scene==='score'&&session?.status==='active'&&session.id===data.activeId){
   const needsSave=!!end&&(end.arrows.length>=end.capacity||
    end.arrows.length>0&&recorded.has('target')&&recorded.has('number')&&recorded.has('photo'));
   if(methodsComplete)step='finish-training';
   else if(needsSave)step='save-group';
   else if(!recorded.has('target'))step='target-input';
   else if(!recorded.has('number'))step='number-input';
   else step='photo-import';
  }
 }
 return {
  step,
  recordStart:(id:string)=>{
   if(!active||!owner)return;
   setStarted({owner,id});
   if(registration)storeSession(owner,id);
  },
  close,
  replay:()=>{
   if(!owner||!allowed)return;
   storeSession(owner,null);setStarted(null);setReplayOwner(owner);
  },
 };
}

export function TrainingGuide({step,paused,onSkip}:{step:GuideStep|SetupGuideStep|null;paused:boolean;onSkip:()=>void}){
 const [spot,setSpot]=useState<{step:GuideTarget;marker:GuideTarget;x:number;y:number;width:number;height:number;floor:number;inDialog:boolean}|null>(null);
 const [cardSize,setCardSize]=useState({width:0,height:0});
 const [card,setCard]=useState<HTMLElement|null>(null);

 useLayoutEffect(()=>{
  if(!step||paused){setSpot(null);return;}
  let frame=0,anchor:Element|null=null,alive=true,settleUntil=performance.now()+450;
  const markers=targetOrder[step]??[step];
  const measure=()=>{
   if(!alive)return;
   const dialogs=Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"],dialog[open]')).filter(node=>node.getClientRects().length);
   const dialog=dialogs[dialogs.length-1];
   const root=dialog??document.querySelector('main.gx-page');
   const marker=markers.find(name=>root?.querySelector(`[data-guide-target="${name}"]`)?.getClientRects().length);
   const target=marker&&root?.querySelector(`[data-guide-target="${marker}"]`);
   if(!target||!marker){setSpot(null);return;}
   const viewport=window.visualViewport?.height??window.innerHeight;
   const footer=document.querySelector('.app-tabbar')?.getBoundingClientRect();
   const floor=!dialog&&footer&&footer.height>0?Math.min(viewport,footer.top):viewport;
   let rect=target.getBoundingClientRect();
   if(anchor!==target){
    anchor=target;
    settleUntil=performance.now()+450;
   }
   if(performance.now()<settleUntil&&(rect.top<12||rect.bottom>floor-16)&&rect.height<floor-30){
    target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    rect=target.getBoundingClientRect();
   }
   const {left:x,top:y,width,height}=rect;
   setSpot(previous=>previous?.step===step&&previous.marker===marker&&previous.x===x&&previous.y===y&&previous.width===width&&previous.height===height&&previous.floor===floor&&previous.inDialog===!!dialog?previous:{step,marker,x,y,width,height,floor,inDialog:!!dialog});
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
  const main=document.querySelector('main.gx-page');
  const changes=new MutationObserver(schedule);
  changes.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-guide-target']});
  const resize=new ResizeObserver(schedule);
  if(main)resize.observe(main);
  window.addEventListener('scroll',schedule,true);
  window.addEventListener('resize',schedule);
  window.visualViewport?.addEventListener('resize',schedule);
  // Wait for the page's normal navigation scroll restoration before focusing the control.
  frame=requestAnimationFrame(schedule);
  const settled=window.setTimeout(schedule,290);
  return()=>{
   alive=false;cancelAnimationFrame(frame);window.clearTimeout(settled);changes.disconnect();resize.disconnect();
   window.removeEventListener('scroll',schedule,true);
   window.removeEventListener('resize',schedule);
   window.visualViewport?.removeEventListener('resize',schedule);
  };
 },[step,paused]);

 useLayoutEffect(()=>{
  if(!card)return;
  const measure=()=>{const {width,height}=card.getBoundingClientRect();setCardSize({width,height});};
  measure();
  const resize=new ResizeObserver(measure);resize.observe(card);
  return()=>resize.disconnect();
 },[card]);

 if(paused||!step||spot?.step!==step)return null;
 const content=labels[spot.marker];
 const margin=12,gap=14;
 const usableBottom=spot.floor-margin;
 const below=spot.y+spot.height+gap;
 const above=spot.y-cardSize.height-gap;
 const top=below+cardSize.height<=usableBottom?below:Math.max(margin,above);
 const width=cardSize.width||Math.min(300,window.innerWidth-2*margin);
 const left=Math.max(margin,Math.min(spot.x+(spot.width-width)/2,window.innerWidth-width-margin));
 return createPortal(<div className="training-guide-layer" data-in-dialog={spot.inDialog||undefined}>
  <div className="training-guide-window" aria-hidden="true" style={{left:spot.x-5,top:spot.y-5,width:spot.width+10,height:spot.height+10}}/>
  <aside ref={setCard} className="training-guide-card" data-guide-step={spot.marker} aria-label="实操引导" style={{left,top}}>
   <div className="training-guide-heading">
    <strong>{content.number}/9 · {content.title}</strong>
    <button type="button" onClick={onSkip}>跳过引导</button>
   </div>
   <p key={spot.marker} role="status">{content.hint}</p>
  </aside>
 </div>,document.body);
}
