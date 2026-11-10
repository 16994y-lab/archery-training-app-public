import {cloudSync} from '../mobile/cloud-sync';
import {TeamHttpError,type TeamIdentity} from '../mobile/team-api';

// Original App gate owns authentication, persistence and refresh; roles stay server-only.
type Status={phase:'signed-out'|'ready'|'busy'|'error';message:string;phoneDisplay:string;owner:string|null};
const listeners=new Set<()=>void>();
let signingOut=false,queue:Promise<unknown>=Promise.resolve(),scopeVersion=0,lastScope='';
const subject=()=>!window.Gongxingji&&!signingOut&&cloudSync.getStatus().authVerified?cloudSync.teamLocalScope():null;
function scopeKey(){const value=JSON.stringify(subject());if(value!==lastScope){lastScope=value;scopeVersion++;}return value==='null'?null:value+'|'+scopeVersion;}
const identity=():TeamIdentity|null=>!window.Gongxingji&&!signingOut&&cloudSync.getStatus().authVerified?cloudSync.teamIdentity():null;
function readStatus():Status{const s=cloudSync.getStatus();return {phase:signingOut?'busy':scopeKey()?'ready':'signed-out',message:s.authVerified?'':'请先联网核对账号',phoneDisplay:s.phoneDisplay||'',owner:s.owner};}
let status=readStatus();
function emit(){scopeKey();status=readStatus();listeners.forEach(listener=>listener());}
cloudSync.subscribe(emit);
export const workspaceAuth={
 getStatus:()=>status,
 subscribe:(listener:()=>void)=>{listeners.add(listener);const timer=setInterval(emit,30000);return()=>{clearInterval(timer);listeners.delete(listener);};},
 initialize:async()=>{emit();},
 logout:async()=>{signingOut=true;emit();try{await cloudSync.logout();}finally{signingOut=false;emit();}},
};
export const api={
 identity,
 request<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',body?:unknown,bound?:TeamIdentity):Promise<T>{
   const before=scopeKey();
   const work=queue.then(async()=>{
     if(!before||before!==scopeKey())throw new TeamHttpError('账号已变化，旧操作未发送',401);
     await cloudSync.ensureTeamIdentity();const after=identity();
     if(!after||before!==scopeKey()||bound&&JSON.stringify(bound)!==JSON.stringify(after))throw new TeamHttpError('账号已变化，请重新核对',401);
     return cloudSync.getTeamApi().request<T>(path,method,body,after);
   });
   queue=work.catch(()=>{});return work;
 },
};
