/** Public registration progress is not an authenticated session. */
export type EnrollmentStatus={enrollment:string;attempt:string;owner:string|null;state:'creating'|'pending'|'verifying'|'verified'|'complete'|'uncertain'|'invalidated';delivery:'idle'|'inflight'|'accepted'|'unknown';nativeOutcome:'pending'|'accepted'|'unknown';emailVerified:boolean;registrationComplete:boolean;canVerify:boolean;canResend:boolean;expiresIn:number;retryAfter:number};
export type EnrollmentRequest={email:string;resume:string;enrollment?:string;attempt?:string;token?:string};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** Same canonical form as the existing server mail delivery adapter. */
export function canonicalEnrollmentEmail(value:string){const email=value.trim().toLowerCase();return email.length<=254&&/^[\x00-\x7f]+$/.test(email)&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)&&!email.includes('..')?email:null;}
export function parseEnrollmentStatus(value:unknown,expected?:string):EnrollmentStatus{
 const v=value as EnrollmentStatus;
 if(!v||!uuid(v.enrollment)||(expected&&v.enrollment!==expected)||!uuid(v.attempt)||v.owner!==null&&!uuid(v.owner)
  ||!['creating','pending','verifying','verified','complete','uncertain','invalidated'].includes(v.state)
  ||!['idle','inflight','accepted','unknown'].includes(v.delivery)||!['pending','accepted','unknown'].includes(v.nativeOutcome)
  ||typeof v.emailVerified!=='boolean'||typeof v.registrationComplete!=='boolean'||typeof v.canVerify!=='boolean'||typeof v.canResend!=='boolean'
  ||!Number.isInteger(v.expiresIn)||v.expiresIn<0||v.expiresIn>300||!Number.isInteger(v.retryAfter)||v.retryAfter<0||v.retryAfter>60
  ||v.registrationComplete&&!v.owner||v.canVerify&&(!v.attempt||!v.owner))throw new Error('注册状态未能核对，请重新读取；不会自动发送邮件');
 return {enrollment:v.enrollment,attempt:v.attempt,owner:v.owner,state:v.state,delivery:v.delivery,nativeOutcome:v.nativeOutcome,emailVerified:v.emailVerified,registrationComplete:v.registrationComplete,canVerify:v.canVerify,canResend:v.canResend,expiresIn:v.expiresIn,retryAfter:v.retryAfter};
}
export function requireEnrollmentRequest(value:EnrollmentRequest,action:'start'|'status'|'resend'|'verify'){
 if(typeof value.email!=='string'||canonicalEnrollmentEmail(value.email)!==value.email||! /^[A-Za-z0-9_-]{43}$/.test(value.resume))throw new Error('注册信息无效，请重新核对');
 if(action!=='start'&&!uuid(value.enrollment))throw new Error('请先读取本次注册进度');
 if(action==='verify'&&(!uuid(value.attempt)||! /^[0-9]{6,10}$/.test(value.token??'')))throw new Error('请输入本次邮件中的验证码');
}
