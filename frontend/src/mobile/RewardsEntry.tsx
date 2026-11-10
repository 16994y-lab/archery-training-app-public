import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {RegistrationResult} from './RegistrationResult';
import {RewardsPage} from './RewardsPage';
import {RewardsClient,type RewardMe,sameIdentity} from './rewards-api';
import {useRewardsIdentity} from './rewards-state';
import {authorizeRewardAvatar} from './reward-avatar';
import {AvatarEditor,useLocalAvatar} from './AvatarEditor';
import {localProfileOwner} from './profile-write';
import {SupportOperations,Announcements} from './SupportOperations';
import {Back,useApp} from './ui';
declare const __ANDROID_VERSION__:string;
export const appRewardsClient=new RewardsClient({subscribe:cloudSync.subscribe,api:{identity:cloudSync.teamIdentity,request:async(path,method,body,bound)=>{await cloudSync.ensureTeamIdentity();return cloudSync.getTeamApi().request(path,method,body,bound);}}});
function useOriginalRewardChannel(){
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus),[retry,setRetry]=useState(0),[message,setMessage]=useState('');
 useEffect(()=>{let live=true;setMessage('');void cloudSync.ensureTeamIdentity().catch(()=>{if(live)setMessage('当前账号连接尚未核对，可联网后重试；本机训练和原头像保持。');});return()=>{live=false;};},[status.owner,retry]);
 return {status,message,retry:()=>setRetry(v=>v+1)};
}
export function AppRewards({onBack,section}:{onBack:()=>void;section?:string}){
 const {open,tell}=useApp(),access=useOriginalRewardChannel(),owner=localProfileOwner(access.status),avatar=useLocalAvatar(owner),[editing,setEditing]=useState(false);
 useEffect(()=>setEditing(false),[owner]);
 return <>{access.message&&<p role="status">{access.message}<button onClick={access.retry}>重新核对连接</button></p>}<RewardsPage section={section} onDetail={detail=>open('rewards',detail)} resultSlot={<RegistrationResult/>} client={appRewardsClient} onBack={onBack} onChooseAvatar={()=>owner?setEditing(true):open('profile')} onSupport={()=>open('support')} onFeedback={()=>open('feedback')}/>{editing&&owner&&<RewardsAvatarEditor owner={owner} currentAvatar={avatar.value} currentOwner={()=>localProfileOwner(cloudSync.getStatus())} onClose={()=>setEditing(false)} onSaved={()=>tell('头像已保存到本机')}/>}</>;
}
export function AppSupportOperations({initialTab='feedback'}:{initialTab?:'feedback'|'donations'|'incidents'}){const access=useOriginalRewardChannel();return <>{access.message&&<p role="status">{access.message}<button onClick={access.retry}>重新核对连接</button></p>}<SupportOperations client={appRewardsClient} appVersion={typeof __ANDROID_VERSION__==='undefined'?'Web':__ANDROID_VERSION__} initialTab={initialTab}/></>;}
export function AppAnnouncements({onBack}:{onBack:()=>void}){const access=useOriginalRewardChannel();return <><Back title="公告与版本说明" onBack={onBack}/>{access.message&&<p role="status">{access.message}<button onClick={access.retry}>重新核对连接</button></p>}<Announcements client={appRewardsClient} target="user"/></>;}
export function RewardsAvatarEditor(props:React.ComponentProps<typeof AvatarEditor>){
 const {key,identity}=useRewardsIdentity(appRewardsClient),[proof,setProof]=useState<{key:string;value:RewardMe}|null>(null);
 useEffect(()=>{if(props.owner&&navigator.onLine!==false)void cloudSync.ensureTeamIdentity().catch(()=>{});},[props.owner]);
 useEffect(()=>{let live=true;setProof(null);if(identity?.owner===props.owner)void appRewardsClient.readMe(identity).then(value=>{if(live&&sameIdentity(appRewardsClient.identity(),identity))setProof({key,value});},()=>{});return()=>{live=false;};},[key,props.owner]);
 const current=proof?.key===key&&identity?.owner===props.owner?proof.value:null;
 return <AvatarEditor key={key||props.owner} {...props} rewardProof={current} authorizeReward={identity?reward=>authorizeRewardAvatar(appRewardsClient,identity,reward):undefined}/>;
}
