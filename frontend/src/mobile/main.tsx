import {AccountDeletionBoundary} from './AccountDeletion';
import {ContributionCoordinator} from './PhotoContribution';
import {CloudRestoreNotice} from './CloudRestoreNotice';
import { redirectAuthReturn } from '../auth-return';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ConfigProvider, Collapse, Switch } from 'antd-mobile';
import { BottomNavigation } from './Navigation';
import {DesktopUserShell} from './DesktopUserShell';
import {chooseLoginDestination,loginLanding,workspacePath} from './login-destination';
const WorkspaceApp=React.lazy(()=>import('../workspace/WorkspaceApp').then(module=>({default:module.WorkspaceApp})));
import { News } from './News';
import { PromotionEntry } from './PromotionEntry';
import { copy, Data, defaultConditions, initialData, newPlan, Plan, resumeSession, scoreBlock, setTemporaryHalves, startSession, uid } from './domain';
import { exportText, repository } from './store';
import { NumberInput, AppCtx, AppToast, Back, Button, Field, Modal, Panel, useApp, useToast } from './ui';
import { ConditionsForm, PlanEditor, TrainingHome, PlanLibrary, PlanDetail, CalendarPage, ProgramList, Drafts } from './PlanningPages';
import { ProgramEditor } from './Planning';
import { Account, EquipmentEditor, GoalEditor, TargetEditor } from './Profile';
import { ProfileSettings, ProfileHome, PersonalProfile, SupportDeveloper, GoalList, EquipmentList, AccessoryList, AccessoryEditor, TargetList, About, UserGuide } from './ProfilePages';
import { DataManagement, RecoveryScreen } from './DataManagement';
import { Scoring } from './Scoring';
import { MotionOverview } from './media';
import { HistoryAll, HistoryTrends, ReportPreview, SessionDetail } from './History';
import { ReviewHomeCandidate, AnalysisCandidate, CompareCandidate } from './review-visual-adapter';
import { isReviewRoute, reviewNavigation, reviewBackTarget } from './review-navigation';
import { clearReviewViewState } from './review-state';
import { FeedbackCommunity } from './SupportPages';
import {AppRewards,AppAnnouncements} from './RewardsEntry';
import { CloudPanel } from './Cloud';
import { StartupAccount } from './StartupAccount';
import {MyTeam} from './MyTeam';
import {rememberTeamInvitation,teamInvitationRoute} from './team-invitation';
import { BrandLoading } from './BrandLoading';
import { IntroScreens } from './IntroScreens';
import { cloudSync } from './cloud-sync';
import { communityTestOnly, videoCoachReady } from './release-mode';
import './mobile.css';
import './next.css';
import './scoring-layout.css';
import './modern.css';
import './global-ui-increment.css';
import './app-theme.css';
import {FirstBatchHeader} from './FirstBatchHeader';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string|null}>{state={error:null as string|null};static getDerivedStateFromError(error:Error){return {error:error.message};}render(){if(this.state.error)return <main><h1>页面无法继续显示</h1><p>已保存的训练没有清空，请重新打开。</p><p>{this.state.error}</p><Button onClick={()=>window.location.reload()}>重新打开</Button></main>;return this.props.children;}}
const routes=['team','community','news','training','plans','plan','plan-detail','program','programs','calendar','drafts','motion','score','history','history-all','insights','trends','compare','detail','reflection','report','group','profile','settings','personal','support','feedback','rewards','announcements','equipment-list','equipment','accessories','accessory','goals','goal','targets','target','account','legacy-account','data','about','guide','intro','promotion'];
if(location.hash.startsWith('#/team?'))rememberTeamInvitation(location.hash.split('?')[1]||'');
if(!window.Gongxingji&&workspacePath(location.hash.slice(1).split('?')[0]))chooseLoginDestination('coach');
const AccountBoundary=communityTestOnly?StartupAccount:React.Fragment;
function App(){
 const [data,setData]=useState<Data>(initialData),[loaded,setLoaded]=useState(false),[loadError,setLoadError]=useState(''),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState('');
 const lock=useRef(false),[question,setQuestion]=useState<{title:string;body:string;choices:string[]}|null>(null),answer=useRef<((n:number)=>void)|null>(null);
 const [config,setConfig]=useState<{plan:Plan|null;activeId:string|null;epoch:number;requestId:string;scheduleId?:string}|null>(null),[initialPlan,setInitialPlan]=useState<Plan|undefined>();
 const configRef=useRef(config);configRef.current=config;
 const setCurrentConfig=(next:typeof config)=>{configRef.current=next;setConfig(next);};
 const startReceipt=useRef<{requestId:string;sessionId:string;epoch:number}|null>(null),startFlight=useRef(false),beginFlight=useRef(false),resumeFlight=useRef(false);
 const location=useLocation(),navigate=useNavigate(),navType=useNavigationType(),requestedRoute=location.pathname.slice(1)||'training';const route={name:!window.Gongxingji&&workspacePath(location.pathname)?'workspace':routes.includes(requestedRoute)&&(requestedRoute!=='motion'||videoCoachReady)?requestedRoute:'training',id:new URLSearchParams(location.search).get('id')??undefined};
 const accountStatus=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const showPrivateNotices=!communityTestOnly||accountStatus.localAllowed===true;
 const returnFocus=useRef(new Map<string,string>());
 const positions=useRef(new Map<string,number>());const positionKey=useRef(location.key);
 const {toast,tell,clearToast}=useToast();
 const renderedEpoch=repository.accountEpoch(),renderedOwner=accountStatus.owner;
 const update=useCallback(async(change:(d:Data)=>void)=>{if(cloudSync.isAccountDeletionFrozen()){tell('账号注销正在核对，暂不能修改资料');return false;}if(renderedEpoch!==repository.accountEpoch()||renderedOwner!==cloudSync.getStatus().owner){tell('账号已切换，旧页面修改未保存');return false;}if(communityTestOnly&&!cloudSync.getStatus().localAllowed){tell('请联网登录后使用自己的本机资料');return false;}if(lock.current){tell('正在保存，请稍候再操作');return false;}lock.current=true;setBusy(true);try{const next=await repository.mutate(change);setData(next);setSaveError('');cloudSync.localSaved();return true;}catch(e){const message=(e as Error).message;if(repository.pending)setSaveError(message);tell(message);return false;}finally{lock.current=false;setBusy(false);}},[tell,renderedEpoch,renderedOwner]);
 const updateRef=useRef(update);updateRef.current=update;
 const finishStart=useCallback((saved:Data)=>{const receipt=startReceipt.current,current=configRef.current;if(!receipt||!current||receipt.requestId!==current.requestId||receipt.epoch!==repository.accountEpoch()||saved.activeId!==receipt.sessionId||!saved.sessions.some(s=>s.id===receipt.sessionId&&s.status==='active'))return false;startReceipt.current=null;setCurrentConfig(null);navigate('/score');return true;},[navigate]);
 const retryPendingSave=useCallback(async()=>{if(cloudSync.isAccountDeletionFrozen()){tell('账号注销正在核对，暂不能修改资料');return false;}if(communityTestOnly&&!cloudSync.getStatus().localAllowed){tell('请联网登录本机资料所属的原账号');return false;}if(lock.current){tell('正在保存，请稍候再操作');return false;}if(!repository.pending){tell('没有等待重试的本机保存');return false;}lock.current=true;setBusy(true);try{const next=await repository.retry();setData(next);setSaveError('');cloudSync.localSaved();tell(finishStart(next)?'训练已保存，可以继续记分':'重试保存成功');return true;}catch(e){const message=(e as Error).message;setSaveError(message);tell(message);return false;}finally{lock.current=false;setBusy(false);}},[tell,finishStart]);
 const ask=useCallback((title:string,body:string,choices:string[])=>new Promise<number>(resolve=>{if(answer.current){resolve(0);return;}answer.current=resolve;setQuestion({title,body,choices});}),[]);
 const choose=(n:number)=>{const resolve=answer.current;answer.current=null;setQuestion(null);resolve?.(n);};
 const reloadSaved=async()=>{if(lock.current||cloudSync.isAccountDeletionFrozen())return;if(await ask('重新读取已保存记录？','请先导出待保存内容。确认后放弃这次未保存的修改，读取已保存版本；不会覆盖其他窗口保存的记录。',['保留待保存内容','放弃未保存修改并重读'])!==1)return;lock.current=true;setBusy(true);try{setData(await repository.reloadSaved());setSaveError('');startReceipt.current=null;startFlight.current=false;setCurrentConfig(null);navigate('/training',{replace:true});tell('已重新读取保存记录，未保存修改已放弃');}catch(e){tell(e instanceof Error?e.message:'读取失败，待保存内容仍保留');}finally{lock.current=false;setBusy(false);}};
 useEffect(()=>{repository.load().then(d=>{setData(d);setLoaded(true);void cloudSync.initialize({read:()=>repository.data,update:change=>updateRef.current(change),pending:()=>!!repository.pending,localAccount:repository.accountKey,selectLocalAccount:async(key,legacy)=>{
   if(lock.current||repository.pending)throw new Error('请先完成本机保存，再切换账号');
   const changed=repository.accountKey()!==key;const next=await repository.selectAccount(key,legacy);setData(next);
   if(changed){clearReviewViewState();answer.current?.(0);answer.current=null;setQuestion(null);startReceipt.current=null;startFlight.current=false;setCurrentConfig(null);setInitialPlan(undefined);setSaveError('');clearToast();positions.current.clear();returnFocus.current.clear();navigate(loginLanding(teamInvitationRoute()||'/training'),{replace:true});}
 }}).catch(e=>tell(e.message));}).catch(e=>setLoadError(e.message));},[tell]);
 useEffect(()=>{window.history.scrollRestoration='manual';},[]);
 useEffect(()=>{const save=()=>{if(positionKey.current===location.key)positions.current.set(location.key,window.scrollY);};window.addEventListener('scroll',save,{passive:true});return()=>window.removeEventListener('scroll',save);},[location.key]);
 useLayoutEffect(()=>{
  positionKey.current=location.key;
  if(route.name==='news'||route.name==='community')return;
  const y=navType==='POP'?positions.current.get(location.key)??0:0;
  const frame=requestAnimationFrame(()=>{
   const marker=navType==='POP'&&returnFocus.current.get(location.key);
   const target=marker?document.querySelector<HTMLElement>(`[data-return-focus="${CSS.escape(marker)}"]`):null;
   if(target)target.closest('details')?.setAttribute('open','');
   window.scrollTo(0,y);
   if(!document.querySelector('dialog[open],[role="dialog"]')&&!document.activeElement?.matches('input,textarea,select')){
    (target??document.querySelector<HTMLElement>('main'))?.focus({preventScroll:true});
   }
  });
  return()=>cancelAnimationFrame(frame);
 },[location.key,navType,route.name]);
 const guard=async()=>{if(cloudSync.isAccountDeletionFrozen()){tell('账号注销正在核对，请先处理原请求');return false;}if(communityTestOnly&&!cloudSync.getStatus().localAllowed){tell('请先完成登录');return false;}if(lock.current||repository.pending){tell('保存尚未完成，请先重试或导出未保存内容');return false;}if(!window.dispatchEvent(new Event('gongxingji:before-navigate',{cancelable:true}))&&await ask('离开当前编辑？','尚未确认的照片或编辑内容会释放；已保存的训练记录保留。',['继续编辑','离开此页'])!==1)return false;return true;};
 const open=(name:string,id?:string)=>{void(async()=>{if(!await guard())return;if(name==='/coach'){if(!window.Gongxingji){chooseLoginDestination('coach');navigate('/coach');}return;}if(route.name==='workspace')chooseLoginDestination('user');positions.current.set(location.key,window.scrollY);if(name==='resume'){
  if(resumeFlight.current)return;resumeFlight.current=true;
  const current=repository.data.activeId,epoch=repository.accountEpoch(),target=repository.data.sessions.find(s=>s.id===id);
  try{if(!target||!['active','draft'].includes(target.status)){tell('这份草稿已变化，请重新打开草稿箱');return;}
   if(current&&current!==id){const active=repository.data.sessions.find(s=>s.id===current);const choice=await ask('继续这份草稿？',`将继续 ${target.date} · ${target.name}。当前训练 ${active?.name??''} 会保留为草稿，所有组和已录内容保持。`,['取消','保留当前草稿并继续']);if(choice!==1)return;}
   if(await update(d=>{if(repository.accountEpoch()!==epoch||d.activeId!==current||d.sessions.find(s=>s.id===id)?.revision!==target.revision)throw new Error('训练状态已变化，请重新选择草稿');resumeSession(d,id!,'keep');}))navigate('/score');
  }finally{resumeFlight.current=false;}return;
 }

 if(name==='adjust'){const s=repository.data.sessions.find(s=>s.id===id);if(!s)return;const p=s.plan?copy(s.plan):newPlan();p.id=uid();p.name=s.name+' · 下次调整';p.conditions=copy(s.conditions);p.archived=false;if(!s.plan)p.blocks=[{...scoreBlock(),ends:Math.max(1,s.ends.filter(e=>e.arrows.length).length),arrows:s.ends[0]?.capacity??6}];setInitialPlan(p);navigate('/plan');return;}
 if(!routes.includes(name)||(name==='motion'&&!videoCoachReady))return;
 const path='/'+name+(id?'?id='+encodeURIComponent(id):'');if(path===location.pathname+location.search)return;
 const marker=document.activeElement?.closest<HTMLElement>('[data-return-focus]')?.dataset.returnFocus;
 if(marker)returnFocus.current.set(location.key,marker);else returnFocus.current.delete(location.key);
 const switchingSupport=['support','feedback'].includes(route.name)&&['support','feedback'].includes(name);
 navigate(path,switchingSupport?{replace:true}:reviewNavigation(route,{name,id},location.state,Number(window.history.state?.idx)||0));})();};
 const reviewReturn=reviewBackTarget(route,location.state,Number(window.history.state?.idx)||0);
 const goBack=()=>{void(async()=>{if(!await guard())return;positions.current.set(location.key,window.scrollY);if(isReviewRoute(route.name)&&route.name!=='history'){
  if(reviewReturn.useHistory)navigate(-1);else navigate(reviewReturn.path,{replace:true});return;
 }if(Number(window.history.state?.idx)>0)navigate(-1);else if(route.name==='account'&&route.id)navigate(route.id==='cloud-conflicts'?'/account?id=cloud':'/account',{replace:true});
 else if(route.name==='rewards'&&route.id)navigate('/rewards',{replace:true});
 else navigate(['team','support','feedback','settings','rewards','announcements'].includes(route.name)?'/profile':'/training',{replace:true});})();};
 useEffect(()=>{const back=()=>{if(question){choose(0);return;}if(config){cancelConfig();return;}goBack();};const notice=(e:Event)=>tell((e as CustomEvent).detail);const jump=(e:Event)=>open((e as CustomEvent).detail.name,(e as CustomEvent).detail.id);window.addEventListener('gongxingji-back',back);window.addEventListener('gongxingji-notice',notice);window.addEventListener('gongxingji-open',jump);return()=>{window.removeEventListener('gongxingji-back',back);window.removeEventListener('gongxingji-notice',notice);window.removeEventListener('gongxingji-open',jump);};});
 useEffect(()=>{const sync=()=>{if(!communityTestOnly&&document.visibilityState==='visible'&&cloudSync.getStatus().owner&&!cloudSync.getStatus().busy)void cloudSync.sync(true).catch(()=>{});};window.addEventListener('online',sync);document.addEventListener('visibilitychange',sync);return()=>{window.removeEventListener('online',sync);document.removeEventListener('visibilitychange',sync);};},[]);
 const editPlan=(id?:string,initial?:Plan)=>{setInitialPlan(initial);open('plan',id);};
 const cancelConfig=()=>{if(lock.current||repository.pending){tell('保存尚未完成，请先重试或重新读取已保存记录');return;}startReceipt.current=null;startFlight.current=false;setCurrentConfig(null);};
 const begin=async(plan:Plan|null,scheduleId?:string,keepCurrent=false)=>{
  if(beginFlight.current||configRef.current)return;beginFlight.current=true;
  const epoch=renderedEpoch,owner=renderedOwner;
  const sameAccount=()=>repository.accountEpoch()===epoch&&cloudSync.getStatus().owner===owner;
  try{if(!sameAccount()||!await guard())return;if(!sameAccount()){tell('账号已切换，请重新选择训练');return;}const activeId=repository.data.activeId,active=repository.data.sessions.find(s=>s.id===activeId);
   if(active&&!keepCurrent){const choice=await ask('已有当前训练',`${active.date} · ${active.name}，已录 ${active.ends.reduce((n,e)=>n+e.arrows.length,0)} 箭。新开训练是另一场；当前训练会保留为草稿。`,['取消','保留草稿并新开训练','继续当前训练']);if(choice===0)return;if(choice===2){open('score');return;}}
   if(!sameAccount()||repository.data.activeId!==activeId){tell('当前训练已变化，请重新选择');return;}
   startReceipt.current=null;startFlight.current=false;setCurrentConfig({plan:plan?copy(plan):null,activeId,epoch,requestId:uid(),scheduleId});window.scrollTo(0,0);
  }finally{beginFlight.current=false;}
 };

 if(loadError)return <RecoveryScreen message={loadError}/>;
 if(!loaded)return <BrandLoading/>;
 let content:React.ReactNode;
 switch(route.name){
 case 'workspace':content=<React.Suspense fallback={<BrandLoading/>}><WorkspaceApp onUser={()=>open('training')}/></React.Suspense>;break;
 case 'team':content=<MyTeam onBack={goBack}/>;break;
 case 'community':case 'news':content=<News/>;break;
 case 'training':content=<TrainingHome onStart={begin} onEdit={editPlan}/>;break;
 case 'plans':content=<PlanLibrary onBack={goBack} onEdit={editPlan}/>;break;
 case 'plan-detail':content=<PlanDetail id={route.id!} onBack={goBack} onStart={begin} onEdit={editPlan}/>;break;
 case 'plan':content=<PlanEditor key={route.id??initialPlan?.id??'new'} id={route.id} initial={initialPlan} onBack={goBack}/>;break;
 case 'program':content=<ProgramEditor key={route.id??'new'} id={route.id} onBack={goBack}/>;break;
 case 'programs':content=<ProgramList onBack={goBack}/>;break;
 case 'calendar':content=<CalendarPage onBack={goBack} onStart={begin}/>;break;
 case 'drafts':content=<Drafts onBack={goBack}/>;break;
 case 'motion':content=videoCoachReady?<MotionOverview onBack={goBack}/>:<TrainingHome onStart={begin} onEdit={editPlan}/>;break;
 case 'score':content=data.activeId?<Scoring key={data.activeId} sessionId={data.activeId}/>:<><FirstBatchHeader eyebrow="训练 / 逐箭记录" title="开始记分" description="选好弓种、距离和靶面，就可以记录第一箭。"/><div className="gx-entry-actions"><Button kind="primary" onClick={()=>begin(null)}>新开训练</Button><Button onClick={()=>open('plans')}>选择可复用计划</Button></div></>;break;
 case 'history':content=<ReviewHomeCandidate/>;break;
 case 'history-all':content=<HistoryAll onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'insights':content=<AnalysisCandidate key={route.id??'latest'} sessionId={route.id} onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'trends':content=<HistoryTrends onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'compare':content=<CompareCandidate onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'detail':case 'reflection':content=<SessionDetail key={route.id+route.name} id={route.id!} initialTab={route.name==='reflection'?'notes':'records'} onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'report':content=<ReportPreview id={route.id!} onBack={goBack} backLabel={reviewReturn.label}/>;break;
 case 'group':{const [id,index]=(route.id??'').split(':');content=<Scoring key={route.id} sessionId={id} endIndex={Number(index)} review onBack={goBack}/>;break;}
 case 'profile':content=<ProfileHome/>;break;
 case 'settings':content=<ProfileSettings onBack={goBack}/>;break;
 case 'personal':content=<PersonalProfile onBack={goBack}/>;break;
 case 'support':content=<SupportDeveloper onBack={goBack}/>;break;
 case 'feedback':content=<FeedbackCommunity onBack={goBack}/>;break;
 case 'rewards':content=<AppRewards onBack={goBack} section={route.id}/>;break;
 case 'announcements':content=<AppAnnouncements onBack={goBack}/>;break;
 case 'equipment-list':content=<EquipmentList onBack={goBack}/>;break;
 case 'equipment':content=<EquipmentEditor key={route.id??'new'} id={route.id} onBack={goBack}/>;break;
 case 'accessories':content=<AccessoryList onBack={goBack}/>;break;
 case 'accessory':content=<AccessoryEditor key={route.id??'new'} id={route.id} onBack={goBack}/>;break;
 case 'goals':content=<GoalList onBack={goBack}/>;break;
 case 'goal':content=<GoalEditor key={route.id??'new'} id={route.id} onBack={goBack}/>;break;
 case 'targets':content=<TargetList onBack={goBack}/>;break;
 case 'target':content=<TargetEditor key={route.id??'new'} id={route.id} onBack={goBack}/>;break;
 case 'legacy-account':content=communityTestOnly?<CloudPanel onBack={goBack}/>:<Account onBack={goBack}/>;break;
 case 'account':content=<CloudPanel section={route.id} onBack={goBack}/>;break;
 case 'data':content=<DataManagement onBack={goBack}/>;break;
 case 'about':content=<About onBack={goBack}/>;break;
 case 'guide':content=<UserGuide onBack={goBack}/>;break;
 case 'intro':content=<IntroScreens revisit onDone={goBack} onSkip={goBack} onExistingAccount={goBack}/>;break;
 case 'promotion':content=<PromotionEntry onBack={goBack}/>;break;
 default:content=<TrainingHome onStart={begin} onEdit={editPlan}/>;
 }
 if(config)content=<StartConfiguration key={config.requestId} plan={config.plan} blocked={busy||!!repository.pending} onCancel={cancelConfig} onStart={async(c,arrows,half)=>{
  if(startFlight.current||lock.current||repository.pending)return;if(startReceipt.current&&finishStart(repository.data))return;
  startFlight.current=true;
  const saved=await update(d=>{
   if(configRef.current?.requestId!==config.requestId||repository.accountEpoch()!==config.epoch||d.activeId!==config.activeId)throw new Error('当前训练已变化，请取消配置后重新新开');
   const p=config.plan?{...copy(config.plan),conditions:copy(c)}:null;
   const session=startSession(d,c,arrows,p,'keep',config.scheduleId??null);if(!p)setTemporaryHalves(session,half);
   startReceipt.current={requestId:config.requestId,sessionId:session.id,epoch:config.epoch};
  });
  if(saved)finishStart(repository.data);else startFlight.current=false;
 }}/>;

 const section=['history-all','insights','detail','reflection','report','group','trends','compare'].includes(route.name)?'history':['team','settings','personal','support','feedback','rewards','announcements','equipment-list','equipment','accessories','accessory','goals','goal','targets','target','account','legacy-account','data','about','guide','intro','promotion'].includes(route.name)?'profile':['plans','plan-detail','plan','program','programs','calendar','drafts','motion'].includes(route.name)?'training':route.name==='community'?'news':route.name;
 const compactScoring=route.name==='score'&&!config&&Boolean(data.activeId);
 return <AppCtx.Provider value={{data,update,retryPendingSave,hasPendingSave:()=>lock.current||repository.pending!==null,readSaveState:()=>({data:repository.data,pending:repository.pending}),open,ask,tell}}><AccountDeletionBoundary><ContributionCoordinator/><AccountBoundary>{route.name==='workspace'?content:<DesktopUserShell route={route.name} section={section} open={open} enabled={!window.Gongxingji&&!config&&route.name!=='intro'}>{saveError&&<aside role="alert" className="save-error"><b>尚未保存：{saveError}</b><p>当前待保存内容仍保留，请先重试。</p><Button onClick={()=>void retryPendingSave()}>重试保存</Button><Button onClick={()=>{try{exportText('gongxingji-unsaved-backup.json',JSON.stringify(repository.pending,null,2),'application/json');tell('已请求保存，以系统完成提示为准');}catch(e){tell(e instanceof Error?e.message:'导出失败，待保存内容仍保留');}}}>导出待保存内容</Button><Button onClick={()=>void reloadSaved()}>重新读取已保存记录</Button></aside>}<CloudRestoreNotice/><main tabIndex={-1} data-route={config?'start':route.name} className={['gx-page',busy?'saving':'',compactScoring?'scoring-main':''].filter(Boolean).join(' ')} aria-busy={busy}>{content}</main>{!config&&route.name!=='intro'&&<BottomNavigation section={section} open={open}/>}</DesktopUserShell>}{showPrivateNotices&&toast&&<AppToast notice={toast}/>}{showPrivateNotices&&question&&<Modal title={question.title} onClose={()=>choose(0)}><p>{question.body}</p><div className="modal-actions">{question.choices.map((choice,i)=><Button key={i} kind={i?'primary':''} onClick={()=>choose(i)}>{choice}</Button>)}</div></Modal>}</AccountBoundary></AccountDeletionBoundary></AppCtx.Provider>;
}
function StartConfiguration({plan,blocked,onCancel,onStart}:{plan:Plan|null;blocked:boolean;onCancel:()=>void;onStart:(c:ReturnType<typeof defaultConditions>,n:number,half:number|null)=>Promise<void>}) {const {data}=useApp();const [c,setC]=useState(()=>copy(plan?.conditions??{...defaultConditions(),bow:data.profile.bow})),[n,setN]=useState(plan?.blocks.find(b=>b.kind==='score')?.arrows??6),[split,setSplit]=useState(false),[half,setHalf]=useState(6);return <><Back title={plan?'新开计划训练':'新开训练'} onBack={onCancel}/><p>{plan?`${plan.name} · 每次执行保存独立记录`:'无需填写总组数，选择靶型、尺寸或未知、距离即可开始。'}</p><fieldset className="start-configuration-fields" disabled={blocked}><Panel title="训练条件"><ConditionsForm value={c} onChange={setC}/></Panel>{!plan&&<Panel title="组数与箭数"><Field label="当前组箭数（之后仍可调整）"><NumberInput min={1} max={300} value={n} onValue={setN}/></Field><Collapse><Collapse.Panel key="half" title="半场设置（可选）"><div className="list-row"><span>明确区分上下半场</span><Switch checked={split} onChange={setSplit}/></div>{split&&<Field label="上半场组数"><NumberInput min={1} max={500} value={half} onValue={setHalf}/></Field>}<p className="caption">不分半场也可训练；只设置边界，不要求总组数。</p></Collapse.Panel></Collapse></Panel>}</fieldset><div className="page-actions"><Button kind="primary" className="wide" disabled={blocked} onClick={()=>onStart(c,n,split?half:null)}>开始这场训练</Button><Button className="wide" disabled={blocked} onClick={onCancel}>取消配置，保留原记录</Button></div></>;}
window.addEventListener('hashchange',redirectAuthReturn);
if (!redirectAuthReturn()) createRoot(document.getElementById('root')!).render(<ErrorBoundary><ConfigProvider><HashRouter><App/></HashRouter></ConfigProvider></ErrorBoundary>);
