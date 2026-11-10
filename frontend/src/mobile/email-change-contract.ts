/** Owned route receipt only; an HTTP success never supplies a login session. */
export type EmailChangeStatus={intent:string|null;state:'none'|'requesting'|'pending'|'verifying'|'uncertain'|'native_confirmed'|'completed'|'cancelled_holding'|'expired_holding'|'invalidated';authorityKind:'email'|null;requestClaimed:boolean;sessionAdopted:false;kind?:'email';authorityVerified?:boolean;newVerified?:boolean;expiresIn?:number;resumed?:boolean;reservationHeld?:boolean|null;releaseRecorded?:boolean};
export const changeUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function changeEmail(value:string){const email=value.trim().toLowerCase();if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw new Error('请重新填写本次更换的新邮箱');return email;}
export function parseEmailChange(value:unknown,expectedIntent?:string):EmailChangeStatus{
 const bad=()=>{throw new Error('更换邮箱状态未能核对，请重新读取；不要重复发送');};
 if(!value||typeof value!=='object'||Array.isArray(value))return bad();
 const r=value as Record<string,unknown>;
 const common=['intent','state','authorityKind','requestClaimed','sessionAdopted'];
 if(r.sessionAdopted!==false||typeof r.requestClaimed!=='boolean')return bad();
 if(r.intent===null){if(expectedIntent||r.state!=='none'||r.authorityKind!==null||r.requestClaimed!==false||Object.keys(r).some(k=>!common.includes(k)))return bad();return r as EmailChangeStatus;}
 if(!changeUuid(r.intent)||(expectedIntent&&r.intent!==expectedIntent)||r.kind!=='email'||r.authorityKind!=='email')return bad();
 const states=['requesting','pending','verifying','uncertain','native_confirmed','completed','cancelled_holding','expired_holding','invalidated'];
 if(!states.includes(String(r.state))||typeof r.authorityVerified!=='boolean'||typeof r.newVerified!=='boolean'||!Number.isInteger(r.expiresIn)||(r.expiresIn as number)<0||(r.expiresIn as number)>300)return bad();
 if(Object.keys(r).some(k=>![...common,'kind','authorityVerified','newVerified','expiresIn','resumed','reservationHeld','releaseRecorded'].includes(k))||(r.resumed!==undefined&&typeof r.resumed!=='boolean')
   ||r.reservationHeld!==undefined&&r.reservationHeld!==null&&typeof r.reservationHeld!=='boolean'||r.releaseRecorded!==undefined&&typeof r.releaseRecorded!=='boolean')return bad();
 if(['pending','verifying','native_confirmed','completed'].includes(String(r.state))&&!r.requestClaimed)return bad();
 if(['native_confirmed','completed'].includes(String(r.state))&&(!r.authorityVerified||!r.newVerified))return bad();
 return r as EmailChangeStatus;
}
