import React,{useEffect,useState} from 'react';
import {api,workspaceAuth} from './auth';
import {RewardsClient} from '../mobile/rewards-api';
import {AdminRewards} from './AdminRewards';
import {Announcements} from '../mobile/SupportOperations';
import {AdminOperations} from './AdminOperations';
export const workspaceRewardsClient=new RewardsClient({api,subscribe:workspaceAuth.subscribe});
export function AdminIntegration({coachReview,adminAuthorized,onPermissionLost}:{coachReview:React.ReactNode;adminAuthorized:boolean;onPermissionLost:()=>void}){
 const section=()=>{const name=location.hash.split(/[/?]/)[2];return name==='rewards'||name==='coaches'?name:'operations';};
 const [page,setPage]=useState(section),[userId,setUserId]=useState<string|undefined>();
 useEffect(()=>{const sync=()=>{const active=section();setPage(active);if(active!=='rewards')setUserId(undefined);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 if(!adminAuthorized)return null;
 const navigate=(next:'operations'|'coaches'|'rewards',id?:string)=>{setUserId(id);setPage(next);location.hash='/admin/'+next;};
 return <><nav className="reward-tabs" aria-label="管理员业务入口"><button aria-pressed={page==='operations'} onClick={()=>navigate('operations')}>管理运营</button><button aria-pressed={page==='rewards'} onClick={()=>navigate('rewards')}>奖励与领取</button><button aria-pressed={page==='coaches'} onClick={()=>navigate('coaches')}>教练审核</button></nav>{page==='operations'?<AdminOperations client={workspaceRewardsClient} adminAuthorized={adminAuthorized} onPermissionLost={onPermissionLost} onNavigate={navigate}/>:page==='rewards'?<AdminRewards client={workspaceRewardsClient} adminAuthorized={adminAuthorized} onPermissionLost={onPermissionLost} initialUserId={userId}/>:coachReview}</>;
}

export function CoachAnnouncements(){return <Announcements client={workspaceRewardsClient} target="coach"/>;}
