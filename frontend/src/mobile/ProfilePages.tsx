import {AppUpdatePanel} from './AppUpdatePanel';
import {ContributionSettings} from './PhotoContribution';
import {ChoiceSelect} from './ChoiceSelect';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Form, Input, List, Switch } from 'antd-mobile';
import { Accessory, copy, localDate, uid } from './domain';
import { decimal, goalProgress } from './statistics';
import { ActionListItem, Back, Button, Field, Panel, Modal, useApp, useEditGuard } from './ui';
import {cloudSync} from './cloud-sync';
import {DeviceAvatar,useLocalAvatar} from './AvatarEditor';
import {RewardsAvatarEditor as AvatarEditor} from './RewardsEntry';
import {nicknameFromVerifiedPhoneDisplay,profileDefaultNickname,validNickname} from './profile-local';
import {localProfileOwner,profileChangeForOwner,saveDefaultProfileName} from './profile-write';
import './profile-next.css';
import './profile-hub.css';
import {AppIcon, type AppIconName} from './AppIcon';
export {SupportDeveloper} from './SupportPages';
declare const __ANDROID_VERSION__:string;
const APP_VERSION=typeof __ANDROID_VERSION__==='undefined'?'本地预览':__ANDROID_VERSION__;
export const ACCESSORY_LABELS:Record<string,string>={riser:'弓把 / 弓身',limbs:'弓片 / 磅数',arrows:'箭杆 / 长度 / 挠度',sight:'瞄准器',stabilizer:'平衡杆',string:'弓弦',tab:'护指 / 撒放器',other:'其他配件'};
const AVATARS:Record<string,string>={initial:'',bow:'🏹',target:'◎',star:'★'};
export function ProfileAvatar({name,avatar}:{name:string;avatar?:string}){const content=AVATARS[avatar??'initial']||Array.from(name.trim())[0]||'弓';return <span className={`profile-avatar profile-avatar-${avatar??'initial'}`} aria-label={`头像：${avatar==='initial'||!avatar?'姓名首字':'预设图案'}`}>{content}</span>;}

function ProfileToolIcon({kind}:{kind:'help'|'settings'}) {
 return <svg className="app-line-icon" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {kind==='help'?<><path d="M4 13v-2a8 8 0 0 1 16 0v6c0 2-2 4-5 4h-2"/><rect x="3" y="12" width="4" height="6" rx="2"/><rect x="17" y="12" width="4" height="6" rx="2"/></>:<><path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3"/><circle cx="13" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/></>}
 </svg>;
}

function ProfileHubRow({icon,children,onClick,focusKey}:{icon:AppIconName;children:React.ReactNode;onClick:()=>void;focusKey?:string}) {
 return <button className="profile-hub-row" type="button" onClick={onClick} data-return-focus={focusKey}>
  <AppIcon name={icon}/><span>{children}</span><span className="profile-hub-chevron" aria-hidden="true"/>
 </button>;
}

function ProfileHubGoal() {
 const {data,open}=useApp();
 const today=localDate();
 const goal=data.goals.filter(item=>item.start<=today&&item.end>=today).sort((a,b)=>a.end.localeCompare(b.end))[0];
 if(!goal)return <section className="profile-hub-goal" aria-labelledby="profile-goal-title">
  <h2 id="profile-goal-title">训练目标</h2>
  <button className="profile-hub-goal-empty" type="button" onClick={()=>open('goals')} data-return-focus="profile-goals">
   <AppIcon name="target"/><span><strong>{data.goals.length?'查看训练目标':'设置训练目标'}</strong><small>按箭数、场次或均环设定目标</small></span><span className="profile-hub-chevron" aria-hidden="true"/>
  </button>
 </section>;
 const {value}=goalProgress(data,goal);
 const unit=goal.type==='arrows'?'箭':goal.type==='sessions'?'场':'均环';
 const progress=Math.min(goal.value,Math.max(0,value??0));
 return <section className="profile-hub-goal" aria-labelledby="profile-goal-title">
  <h2 id="profile-goal-title">训练目标</h2>
  <div className="profile-hub-goal-card">
   <button className="profile-hub-goal-link" type="button" onClick={()=>open('goals')} data-return-focus="profile-goals">
    <span>{goal.name}</span><span className="profile-hub-chevron" aria-hidden="true"/>
   </button>
   <div className="profile-hub-goal-values">
    <span>{value===null?'尚无完成记录':<><strong>{goal.type==='average'?decimal(value):value}</strong> / {goal.value} {unit}</>}</span>
    <b>{value===null?'—':`${Math.round(progress/goal.value*100)}%`}</b>
   </div>
   <progress className="profile-hub-goal-progress" max={goal.value} value={progress} aria-label={`${goal.name}进度`}/>
  </div>
 </section>;
}

export function ProfileHome(){
 const {data,update,open,tell}=useApp(),status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const owner=localProfileOwner(status),avatar=useLocalAvatar(owner);
 const phoneName=owner&&status.phoneVerified?nicknameFromVerifiedPhoneDisplay(status.phoneDisplay):null;
 const [editingName,setEditingName]=useState(false),[editingAvatar,setEditingAvatar]=useState(false),[name,setName]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[defaultPending,setDefaultPending]=useState(false);
 const [helpOpen,setHelpOpen]=useState(false);
 const helpTrigger=useRef<HTMLButtonElement>(null);
 const defaultAttempt=useRef<string|null>(null),saveFlight=useRef<string|null>(null),alive=useRef(true),renderedOwner=useRef(owner),nameTrigger=useRef<HTMLButtonElement>(null);renderedOwner.current=owner;
 const closeName=()=>{setEditingName(false);requestAnimationFrame(()=>nameTrigger.current?.focus({preventScroll:true}));};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const saveDefaultName=async(target:string)=>{if(saveFlight.current===target)return;saveFlight.current=target;setSaving(true);try{const value=await profileDefaultNickname(target,status.profileDefaultName);const saved=await saveDefaultProfileName(target,value,update,cloudSync.getStatus);if(alive.current&&renderedOwner.current===target)setDefaultPending(!saved);}catch(e){if(alive.current&&renderedOwner.current===target){setDefaultPending(true);tell(e instanceof Error?e.message:'可以点用户名填写自己的称呼');}}finally{if(saveFlight.current===target)saveFlight.current=null;if(alive.current&&renderedOwner.current===target)setSaving(false);}};
 useEffect(()=>{setEditingName(false);setEditingAvatar(false);setName('');setError('');setDefaultPending(false);setSaving(false);},[owner]);
 useEffect(()=>{if(data.profile.name.trim()||!owner||status.profileDefaultName===null)return;const attempt=JSON.stringify([owner,status.profileDefaultName]);if(defaultAttempt.current===attempt)return;defaultAttempt.current=attempt;void saveDefaultName(owner);},[owner,status.profileDefaultName,data.profile.name,update,tell]);
 const beginName=()=>{setName(data.profile.name);setError('');setEditingName(true);};
 const useAccountDefaultName=async()=>{if(!owner||saveFlight.current===owner)return;const originatingOwner=owner;saveFlight.current=originatingOwner;setSaving(true);setError('');try{const next=phoneName??await profileDefaultNickname(originatingOwner,status.profileDefaultName);if(localProfileOwner(cloudSync.getStatus())!==originatingOwner)throw new Error('账号已变化，请重新打开个人资料');if(alive.current&&renderedOwner.current===originatingOwner)setName(next);}catch(e){if(alive.current&&renderedOwner.current===originatingOwner)setError(e instanceof Error?e.message:'默认昵称暂时无法生成');}finally{if(saveFlight.current===originatingOwner)saveFlight.current=null;if(alive.current&&renderedOwner.current===originatingOwner)setSaving(false);}};
 const saveName=async()=>{
  if(!owner||saveFlight.current===owner)return;const originatingOwner=owner;saveFlight.current=originatingOwner;setSaving(true);setError('');try{const next=validNickname(name);const saved=await update(profileChangeForOwner(originatingOwner,cloudSync.getStatus,d=>{d.profile.name=next;}));if(saved&&alive.current&&renderedOwner.current===originatingOwner){closeName();setDefaultPending(false);}}catch(e){if(alive.current&&renderedOwner.current===originatingOwner)setError(e instanceof Error?e.message:'用户名未能保存');}finally{if(saveFlight.current===originatingOwner)saveFlight.current=null;if(alive.current&&renderedOwner.current===originatingOwner)setSaving(false);}};
 const draftCount=data.sessions.filter(session=>session.status==='draft').length;
 const profileSummary=[data.profile.bow,data.profile.hand].filter(Boolean).join(' · ');
 const closeHelp=()=>{
  setHelpOpen(false);
  requestAnimationFrame(()=>helpTrigger.current?.focus({preventScroll:true}));
 };
 return <div className="gx-profile profile-hub">
 <header className="profile-hub-header">
  <h1>我的</h1>
  <div className="profile-hub-tools">
   <button type="button" ref={helpTrigger} aria-label="帮助与反馈" aria-haspopup="dialog" onClick={()=>setHelpOpen(true)}><ProfileToolIcon kind="help"/></button>
   <button className="profile-hub-settings-button" type="button" aria-label="设置" onClick={()=>open('settings')} data-return-focus="profile-settings"><ProfileToolIcon kind="settings"/></button>
  </div>
 </header>
 <div className="profile-hub-identity">
  <button type="button" className="profile-avatar-button" aria-label="更换头像" disabled={!owner} onClick={()=>setEditingAvatar(true)}><DeviceAvatar value={avatar.value} fallback={<ProfileAvatar name={data.profile.name} avatar={data.profile.avatar}/>}/></button>
  <div className="profile-hub-identity-copy">
  <button type="button" ref={nameTrigger} className="profile-name-button" aria-label="编辑用户名" disabled={!owner} onClick={beginName}><span className="profile-name-label">{data.profile.name||'设置你的用户名'}</span>{owner&&<span aria-hidden="true"> ›</span>}</button>
   <button type="button" className="profile-hub-personal-link" aria-label="个人资料" onClick={()=>open('personal')} data-return-focus="profile-personal">{profileSummary||'个人资料'}<span className="profile-hub-chevron" aria-hidden="true"/></button>
  </div>
 </div>

 {avatar.error&&<p role="status" className="profile-local-note">{avatar.error}</p>}
 {defaultPending&&!data.profile.name.trim()&&<Panel><p role="status">默认用户名尚未保存，可以重试或点用户名填写自己的称呼。</p><Button disabled={saving||!owner} onClick={()=>{if(owner)void saveDefaultName(owner);}}>重试保存用户名</Button></Panel>}
 {editingName&&<Modal title="编辑用户名" onClose={()=>{if(!saving)closeName();}}><form className="profile-name-editor" onSubmit={event=>{event.preventDefault();void saveName();}}><Field label="用户名" hint="昵称最多 8 个字，不能包含违禁词。"><input autoFocus value={name} disabled={saving} onChange={e=>{setName(e.target.value);setError('');}} autoComplete="nickname"/></Field>{error&&<p role="alert" className="avatar-error">{error}</p>}<p className="caption">新注册账号的默认昵称为“打弓人”加已验证手机号后四位。你也可以填写自己的称呼，点保存生效。</p><Button type="button" disabled={saving||!owner} onClick={()=>void useAccountDefaultName()}>{phoneName?'使用手机号后四位':'使用账号默认昵称'}</Button><div className="actions"><Button type="button" disabled={saving} onClick={closeName}>取消</Button><Button kind="primary" type="submit" disabled={saving||!name.trim()}>保存</Button></div></form></Modal>}
 {editingAvatar&&owner&&<AvatarEditor key={owner} owner={owner} currentAvatar={avatar.value} currentOwner={()=>localProfileOwner(cloudSync.getStatus())} onClose={()=>setEditingAvatar(false)} onSaved={()=>tell('头像已保存到本机')}/>}
 <nav className="profile-hub-shortcuts" aria-label="常用入口">
  <button type="button" className="profile-hub-equipment" onClick={()=>open('equipment-list')} data-return-focus="profile-equipment"><AppIcon name="kit"/><strong>器材与配件</strong><small>{data.equipment.length} 套器材</small></button>
  <button type="button" className="profile-hub-team" onClick={()=>open('team')} data-return-focus="profile-team"><AppIcon name="person"/><strong>我的团队</strong><small>训练与共享</small></button>
  <button type="button" className="profile-hub-drafts" onClick={()=>open('drafts')} data-return-focus="profile-drafts"><AppIcon name="draft"/><strong>草稿箱</strong><small>{draftCount} 场草稿</small></button>
 </nav>
 <ProfileHubGoal/>
 <nav className="profile-hub-list" aria-label="其他功能">
  <ProfileHubRow icon="target" focusKey="profile-targets" onClick={()=>open('targets')}>自建靶面</ProfileHubRow>
  <ProfileHubRow icon="person" focusKey="profile-rewards" onClick={()=>open('rewards')}>邀请与特别伙伴</ProfileHubRow>
  <ProfileHubRow icon="info" focusKey="profile-announcements" onClick={()=>open('announcements')}>公告与版本说明</ProfileHubRow>
  <ProfileHubRow icon="heart" focusKey="profile-support" onClick={()=>open('support')}>赞赏支持</ProfileHubRow>
 </nav>
 {helpOpen&&<Modal title="帮助与反馈" onClose={closeHelp}>
  <div className="profile-hub-list">
   <ProfileHubRow icon="book" onClick={()=>{setHelpOpen(false);open('guide');}}>使用指南</ProfileHubRow>
   <ProfileHubRow icon="chat" onClick={()=>{setHelpOpen(false);open('feedback');}}>反馈与交流群</ProfileHubRow>
  </div>
 </Modal>}
 </div>;
}

export function ProfileSettings({onBack}:{onBack:()=>void}) {
 const {data,open}=useApp();
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const avatar=useLocalAvatar(localProfileOwner(status));
 return <div className="profile-hub profile-hub-settings">
  <Back title="设置" onBack={onBack}/>
  <button className="profile-hub-identity profile-hub-settings-identity" type="button" onClick={()=>open('personal')} data-return-focus="settings-personal">
   <DeviceAvatar value={avatar.value} fallback={<ProfileAvatar name={data.profile.name} avatar={data.profile.avatar}/>}/>
   <span><strong>{data.profile.name||'个人资料'}</strong><small>{[data.profile.bow,data.profile.hand].filter(Boolean).join(' · ')||'头像、用户名与弓种'}</small></span>
   <span className="profile-hub-chevron" aria-hidden="true"/>
  </button>
  <div className="profile-hub-list" role="group" aria-label="账号与数据">
   <ProfileHubRow icon="shield" focusKey="settings-account" onClick={()=>open('account')}>账号中心</ProfileHubRow>
   <ProfileHubRow icon="data" focusKey="settings-data" onClick={()=>open('data')}>数据管理</ProfileHubRow>
  </div>
  <details className="profile-hub-contribution">
   <summary><AppIcon name="chart"/><span>模型改进</span><span className="profile-hub-chevron" aria-hidden="true"/></summary>
   <ContributionSettings/>
  </details>
  <div className="profile-hub-list" role="group" aria-label="功能与版本">
   <ProfileHubRow icon="book" focusKey="settings-intro" onClick={()=>open('intro')}>重看功能介绍</ProfileHubRow>
   <ProfileHubRow icon="info" focusKey="settings-about" onClick={()=>open('about')}>关于与设备能力</ProfileHubRow>
   <ProfileHubRow icon="info" focusKey="settings-promotion" onClick={()=>open('promotion')}>了解弓行记</ProfileHubRow>
  </div>
 </div>;
}

export function PersonalProfile({onBack}:{onBack:()=>void}){const {data,update}=useApp();const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus),owner=localProfileOwner(status),localAvatar=useLocalAvatar(owner);const initialName=useRef(data.profile.name).current;const [formValues,setFormValues]=useState(copy({...data.profile,avatar:data.profile.avatar??'initial'}));const guard=useEditGuard(formValues);return <><Back title="个人资料" dirty={guard.dirty} onBack={()=>void guard.close(onBack)}/><Panel><div className="profile-avatar-preview"><DeviceAvatar value={localAvatar.value} fallback={<ProfileAvatar name={formValues.name} avatar={formValues.avatar}/>}/><span>点“我的”页头像可更换；图片只保存在本机。</span></div><Form className="app-form" initialValues={copy({...data.profile,avatar:data.profile.avatar??'initial'})} onValuesChange={(_,values)=>setFormValues(values)} onFinish={async values=>{if(await update(profileChangeForOwner(owner,cloudSync.getStatus,d=>{d.profile={...d.profile,...values,name:values.name===initialName?d.profile.name:validNickname(values.name??'')};}))){if(localProfileOwner(cloudSync.getStatus())===owner){guard.saved();onBack();}}}} footer={<Button type="submit" className="wide" kind="primary">保存资料</Button>}><Form.Item name="name" label="用户名" description="昵称最多 8 个字，不能包含违禁词。" rules={[{validator:async(_,value:string)=>{if(value!==initialName)validNickname(value??'');}}]}><Input/></Form.Item><Form.Item name="bow" label="主要弓种"><ChoiceSelect>{['反曲弓','复合弓','光弓','传统弓','其他'].map(b=><option key={b}>{b}</option>)}</ChoiceSelect></Form.Item><Form.Item name="hand" label="持弓手"><ChoiceSelect><option value="">未填写</option><option>左手持弓</option><option>右手持弓</option></ChoiceSelect></Form.Item><Form.Item name="experience" label="自我介绍 / 训练经历"><textarea className="personal-introduction-input" rows={4} maxLength={500} placeholder="写下你的训练经历或一句喜欢的话"/></Form.Item><Form.Item name="competition" label="比赛需求"><Input maxLength={500}/></Form.Item></Form><p className="caption">用户名是本机展示名称。内置打弓动物头像可直接点“我的”页头像选择；选择独立保存在本机，不进入训练备份。暂不开放用户自选头像。这里的预设样式仅用于没有本机图片时的显示。</p></Panel></>;}

export function GoalList({onBack}:{onBack:()=>void}){const {data,open}=useApp();return <><Back title="训练目标" onBack={onBack}/>{!data.goals.length&&<Panel title="还没有训练目标"><p>可按箭数、场次或均环设定目标，并查看实际训练进度。</p><Button kind="primary" className="wide" onClick={()=>open('goal')}>＋训练目标</Button></Panel>}{data.goals.map(g=>{const p=goalProgress(data,g);return <Panel key={g.id}><h2>{g.name}</h2><p>{g.start} → {g.end}</p><div className="goal-value">{decimal(p.value)} <small>/ {g.value} {g.type==='arrows'?'箭':g.type==='sessions'?'次':'均环'}</small></div><progress max={g.value} value={Math.min(p.value??0,g.value)} aria-label={g.name+'进度'}/><p className="caption">实际样本 {p.sessions}场 / {p.count}箭{p.mixed?'；含不同条件，仅作累计参考。':'。'}</p><Button onClick={()=>open('goal',g.id)}>调整目标</Button></Panel>;})}{data.goals.length>0&&<Button kind="primary" className="wide" onClick={()=>open('goal')}>＋训练目标</Button>}</>;}

export function EquipmentList({onBack}:{onBack:()=>void}){const {data,open}=useApp();return <><Back title="器材与配件" onBack={onBack}/><Panel title="我的套组">{!data.equipment.length&&<p>还没有套组。把常用弓和箭存为一套，下次训练可直接选用。</p>}<List>{data.equipment.map(q=><ActionListItem key={q.id} description={`${q.bow} · ${q.riser||'弓把未填'} / ${q.arrows||'箭未填'}`} onClick={()=>open('equipment',q.id)}>{q.favorite?'★ ':''}{q.name}</ActionListItem>)}</List><Button kind="primary" className="wide" onClick={()=>open('equipment')}>＋新建套组</Button></Panel><List className="entry-list"><ActionListItem description={`${(data.accessories??[]).length}件 · 可在套组内选用`} onClick={()=>open('accessories')}>常用配件库</ActionListItem></List><p className="caption">型号由本人填写，训练保存独立器材快照。</p></>;}

export function AccessoryList({onBack}:{onBack:()=>void}){
 const {data,open}=useApp(),groups=new Map<string,Accessory[]>();
 for(const accessory of data.accessories??[]){
  const group=groups.get(accessory.category);
  if(group)group.push(accessory);else groups.set(accessory.category,[accessory]);
 }
 return <><Back title="常用配件" onBack={onBack}/><Panel>{groups.size===0&&<p>还没有常用配件。</p>}<p className="caption">保存自己的已知型号，组装器材套组时直接选用。</p><Button kind="primary" className="wide" onClick={()=>open('accessory')}>＋添加常用配件</Button></Panel>
 {[...groups].map(([category,items])=><section key={category}><h2 className="profile-section-title">{ACCESSORY_LABELS[category]??category}</h2><List className="entry-list profile-menu">{items.map(a=><ActionListItem key={a.id} description={a.note||undefined} onClick={()=>open('accessory',a.id)}>{a.name}{a.favorite?' · 常用':''}</ActionListItem>)}</List></section>)}</>;
}
export function AccessoryEditor({id,onBack}:{id?:string;onBack:()=>void}){const {data,update}=useApp();const [a,setA]=useState<Accessory>(()=>copy(data.accessories?.find(v=>v.id===id)??{id:uid(),category:'arrows',name:'',note:'',favorite:true}));const guard=useEditGuard(a);return <><Back title={id?'编辑配件':'添加配件'} dirty={guard.dirty} onBack={()=>void guard.close(onBack)}/><Panel><Field label="配件类别"><ChoiceSelect value={a.category} onChange={e=>setA({...a,category:e.target.value})}>{Object.entries(ACCESSORY_LABELS).map(([k,v])=><option value={k} key={k}>{v}</option>)}</ChoiceSelect></Field><Field label="型号 / 名称"><Input value={a.name} maxLength={500} onChange={v=>setA({...a,name:v})}/></Field><Field label="配件备注"><textarea value={a.note} maxLength={2000} onChange={e=>setA({...a,note:e.target.value})}/></Field><div className="list-row"><span>设为常用</span><Switch checked={a.favorite} onChange={v=>setA({...a,favorite:v})}/></div><Button kind="primary" className="wide" onClick={async()=>{if(await update(d=>{if(!a.name.trim())throw new Error('填写配件名称');d.accessories??=[];const i=d.accessories.findIndex(v=>v.id===a.id);if(i>=0)d.accessories[i]=copy(a);else d.accessories.push(copy(a));})){guard.saved();onBack();}}}>保存配件</Button></Panel></>;}

export function TargetList({onBack}:{onBack:()=>void}){const {data,open}=useApp();return <><Back title="自建同心圆靶面" onBack={onBack}/><Panel>{!data.targets.length&&<p>还没有自建靶面。标准靶面可在新开训练时直接选择。</p>}<List>{data.targets.map(t=><ActionListItem key={t.id} description="创建新修订不会改变旧记录" onClick={()=>open('target',t.id)}>{t.name}</ActionListItem>)}</List><Button className="wide" kind="primary" onClick={()=>open('target')}>＋自建靶面</Button><p className="caption">本版仅支持同心圆，支持环带、分值、颜色与可选X；尺寸在开练时选择。</p></Panel></>;}
export function About({onBack}:{onBack:()=>void}){return <><Back title="关于弓行记" onBack={onBack}/><AppUpdatePanel/><Panel><h2>弓行记 {APP_VERSION}</h2><p>个人射箭训练</p><p>个人训练保存在本机，可按需选择成绩备份。照片默认在本机处理；仅在你单独选择参与模型改进且同意生效后，按有效条款处理之后新加载的推理工作图与保存时确认的修正。可在设置退出，个人训练与备份不受影响。</p></Panel><Panel title="当前设备能力"><p>已接入本机离线保存、相机或相册选图、文件导出和分享入口。</p><p>照片可在本机生成可校正候选；默认只保存核对后的环值。逐点手动定位可保存可信位置；实验参考坐标须另行选择，不参加可信散布计算。自动映射不等于人工确认的真实落点。视频动作观察仍在独立开发，当前交付未开放。</p><p>锁屏／后台准时提醒尚未接入。休息计时只在页面展示，到时不会强制继续。</p></Panel><Panel title="版本说明"><p>本次更新增加贡献记录的只读核对和照片处理阶段提示；未确认的贡献不会自动重传。</p><p>照片识别结果需逐箭核对；识别失败时，仍可返回手动记分。</p></Panel></>;}


export function UserGuide({onBack,onPractice}:{onBack:()=>void;onPractice?:()=>void}){
 const {open}=useApp();
 return <><Back title="使用指南" onBack={onBack}/><Panel><p>先选训练，再逐箭记分，最后完成并复盘。点击下面的步骤查看操作。</p>{onPractice&&<Button kind="primary" className="wide" onClick={onPractice}>开始实操引导</Button>}<div className="user-guide">
  <details className="review-data-details" open><summary>1. 开始训练与安排日历</summary><p>在“训练”选择“新开训练”，或使用已保存的计划。开始前核对靶面、距离、每组箭数与器材。</p><p>日历可安排单次训练；长期安排按选中的训练日分配每周箭量。修改安排保留已执行记录，归档计划仍显示原关联。</p><Button onClick={()=>open('training')}>去训练</Button></details>
  <details className="review-data-details"><summary>2. 逐箭记分与修改</summary><p>可输入环值，也可点击靶面录入位置。X和普通10都计10分，X单独统计；M计0分并算一箭，未录空位不会自动变成M。</p><p>发现录错时进入对应组修改，再保存。首页可继续当前训练、保留草稿并新开，或确认放弃整场。草稿箱可直接继续或放弃；取消新建配置会保留原训练。“下一组”属于同一场，“新开训练”会建立另一场。</p><Button onClick={()=>open('score')}>去记分</Button></details>
  <details className="review-data-details"><summary>3. 核对照片候选与跨组保存</summary><p>在记分页打开照片，按提示选择完整靶面并核对校准。无法确定靶面时，按提示重拍，或返回数字／点靶记分。</p><p>逐箭核对位置和环值，删除错点；漏识别的命中箭先补点或手动录入。候选少于计划箭数时，可按已录箭数保存，或确认脱靶后补M；补M不会生成位置。</p><p>继续下一组时核对组号和箭数。照片参考位置与人工点靶分别标记，自动参考不能当作可信散布结论。</p></details>
  <details className="review-data-details"><summary>4. 完成、复盘与保存图</summary><p>完成场次后到“复盘”查看历史、逐组成绩和数据分析；均环按实际录入箭数计算。没有设置上下半场的场次按全场展示。</p><p>没有坐标的数字成绩不会画成落点。打开单场复盘图，核对箭数、来源和图形后，再使用保存或分享入口。</p><Button onClick={()=>open('history')}>去复盘</Button></details>
  <details className="review-data-details"><summary>5. 账号安全与找回密码</summary><p>手机号默认用短信验证码登录。邮箱注册先验证邮箱，再验证同一账号的 +86 手机；密码可稍后设置。已属于其他账号的手机号不能绑定。</p><p>在账号安全完成一次真正的邮箱验证后，可增加邮件验证码找回。平时邮箱密码登录无需重复收码；也可使用已绑定手机的验证码登录，再设置密码。按账号页当前可用提示操作。</p><p>登录和退出不会自动上传或转移已有本机训练。</p><Button onClick={()=>open('account')}>查看账号</Button></details>
  <details className="review-data-details"><summary>6. 备份、恢复与保存失败</summary><p>在“数据管理”导出本机完整备份，确认文件已保存后再保管。恢复先预览和核对冲突，再确认采用；取消保留原资料。</p><p>遇到保存或导出失败，按页面提示重新连接、重读或导出待存内容。不要通过卸载应用来处理未保存的记录。</p><Button onClick={()=>open('data')}>打开数据管理</Button></details>
 </div></Panel></>;
}
