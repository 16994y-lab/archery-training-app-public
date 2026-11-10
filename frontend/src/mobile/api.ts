/** Existing public API adapter. No device document is silently projected into the older schema. */
import {communityTestOnly,trainingCloudUnavailable,emailEnrollmentReady,nativeSessionRelayReady} from './release-mode';
import {parseEnrollmentStatus,requireEnrollmentRequest,type EnrollmentRequest} from './email-enrollment-contract';
import {assertPortableBackupTree} from './manual-backup-portable';
import {assertHostedBackupFits,requireTransportJsonBytes,MANUAL_BACKUP_CAPACITY_MESSAGE} from './manual-backup-transport';
import {requireNewPassword} from './password-policy';
import {readBoundedResponse} from './bounded-response';
import {maskPhone} from './account-display';
import {verifiedProfileDefault} from './profile-local';
import {DeletionNotStartedError} from './account-deletion-core';
import {InvitationPrepareRejected} from './registration-invitation';
import {emailChangeReady} from './release-mode';
import {changeEmail,changeUuid,parseEmailChange,type EmailChangeStatus} from './email-change-contract';
import {SCORE_BACKUP_MAX_BYTES,validateScoreBackupDocument,parseScoreBackupResponse,type ScoreBackupDocument,type ScoreBackupResponse} from './score-backup';
function timeoutSignal(ms:number) {const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),ms);(timer as unknown as {unref?:()=>void}).unref?.();return controller.signal;}
const requests=new Map<string,{resolve:(r:Response)=>void;reject:(e:Error)=>void}>();
if(typeof window!=='undefined')window.addEventListener('gongxingji-http',event=>{
  const result=(event as CustomEvent).detail,pending=requests.get(result?.id);if(!pending)return;
  requests.delete(result.id);
  try{
    if(result.error)throw new Error(result.error);
    // Fetch forbids even an empty string body for these no-content statuses.
    const body=[204,205,304].includes(result.status)?null:result.body;
    pending.resolve(new Response(body,{status:result.status,headers:{'Content-Type':'application/json'}}));
  }catch(error){pending.reject(error instanceof Error?error:new Error('服务器响应无效'));}
});
export function transport(url:string,options:RequestInit):Promise<Response>{
  if(typeof window==='undefined'||!window.Gongxingji?.request)return fetch(url,options);
  return new Promise((resolve,reject)=>{const id=`request-${Date.now()}-${Math.random()}`;requests.set(id,{resolve,reject});options.signal?.addEventListener('abort',()=>{if(requests.delete(id))reject(new Error('连接超时，本机数据保持不变'));},{once:true});try{window.Gongxingji!.request!(id,url,options.method??'GET',JSON.stringify(options.headers??{}),String(options.body??''));}catch(e){requests.delete(id);reject(e);}});
}

export type CloudConfig={api:string;auth:string;publicKey:string};
type RelayRefreshCandidate={accessToken:string;refreshToken:string;expiresAt:number;refreshPending?:true};
export type AuthSession={owner:string;email:string;accessToken:string;refreshToken:string;expiresAt:number;service:string;phoneVerified?:boolean;profileDefaultName?:string|null;relayRefreshSafe?:true;relayRefreshPending?:true;relayRefreshCandidate?:RelayRefreshCandidate};
export type OriginalChannelSession={session:Readonly<AuthSession>;generation:number;serviceOrigin:string;supabaseOrigin:string;publishableKey:string};
/** Display facts from a freshly authenticated /user response, never an admission proof. */
export type AcceptedAccountFacts={owner:string;createdAt:string|null;phoneVerified:boolean;generation:number;source:'password'|'otp'|'email-enrollment'|'phone-binding'|'other'};
export type EmailSecurityStatus={owner:string;emailVerified:boolean;emailVerificationReady:boolean;challenge:string|null;expiresIn:number;retryAfter:number};
export type EmailSecurityChallenge={owner:string;challenge:string;sent:boolean;delivery:'accepted'|'unknown';expiresIn:number;retryAfter:number};
export type EmailBindingStatus={owner:string;state:'idle'|'requesting'|'pending'|'verifying'|'uncertain'|'invalidated'|'verified'|'needs_proof';intent:string|null;email:string|null;emailVerified:boolean;retryAfter:number;canVerify:boolean};
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function mainlandPhone(input:string):string{
 const value=input.trim().replace(/[\s()-]/g,'');
 const phone=/^1[3-9]\d{9}$/.test(value)?'+86'+value:value.startsWith('0086')?'+'+value.slice(2):/^861[3-9]\d{9}$/.test(value)?'+'+value:value;
 if(/^\+861[3-9]\d{9}$/.test(phone))return phone;
 if(value.startsWith('+')||value.startsWith('00')||/^1\d{10}$/.test(value))throw new Error('暂不支持该手机号，请使用中国大陆手机号');
 throw new Error('请输入有效的 11 位中国大陆手机号');
}
const confirmedPhone=(user:Record<string,unknown>)=>typeof user.phone==='string'&&/^\+?861[3-9]\d{9}$/.test(user.phone)&&typeof user.phone_confirmed_at==='string'&&Number.isFinite(Date.parse(user.phone_confirmed_at));
export const otpLength=(kind:'phone'|'email')=>kind==='phone'?6:8;
export class CloudHttpError extends Error {constructor(message:string,readonly status:number){super(message);}}
export type OtpSendReceipt={outcome:'accepted'|'unconfirmed';message:string;retryAfterSeconds?:number};
export class OtpSendError extends CloudHttpError {constructor(message:string,status:number,readonly outcome:'rejected'|'unknown',readonly retryAfterSeconds?:number){super(message,status);}}
const otpRetryAfter=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=86400?value:undefined;
const unknownOtpMessage='验证码发送结果未确认；若已收到，可直接填写。请等待冷却结束后自行核对是否重试，本页面不会自动重发。';
export class PasswordOutcomeUnknownError extends Error {constructor(){super('密码修改结果尚未确认，已停止重复提交。请使用新密码登录核对；原账号和本机训练保留。');}}
export class RecoverySessionExpiredError extends Error {constructor(){super('本次找回验证已失效，请返回验证码步骤重新验证；不会自动发送短信。');}}
export class EnrollmentNotStartedError extends CloudHttpError {}
export const mobileServiceBase=(base:string)=>base.replace(/\/$/,'').replace(/\/api$/,'');
export function serviceKey(c:CloudConfig){
  const api=mobileServiceBase(c.api),auth=c.auth.replace(/\/$/,'');
  // Only this verified backend alias and Auth project share the historical identity.
  // Keep existing session and archive keys intact across both upgrade and rollback.
  const identity=api==='https://service-1.example.invalid'&&auth==='https://auth-4.example.invalid'
    ?'https://service-3.example.invalid':api;
  return `${identity}|${auth}`;
}
export function validateCloudConfig(config:CloudConfig){
  if(!config.api||!config.auth||!config.publicKey)throw new Error('云服务尚未配置，请在高级设置中填写测试服务地址与公开客户端密钥');
  new ExistingApiClient(config.api,config.auth,config.publicKey);
  const auth=new URL(config.auth);if(auth.pathname!=='/'&&auth.pathname!=='')throw new Error('认证地址应为项目根地址，不含 /auth/v1');
  if(config.publicKey.startsWith('sb_secret_'))throw new Error('不能在手机中配置服务端秘密密钥');
  if(config.publicKey.split('.').length===3){try{const encoded=config.publicKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');const claims=JSON.parse(atob(encoded));if(claims.role==='service_role')throw new Error('不能在手机中配置 service_role 密钥');}catch(error){if(error instanceof Error&&error.message.includes('service_role'))throw error;}}
}

/** Supabase Auth REST calls. Passwords and one-time codes are never persisted. */
export class CloudApiClient {
  session:AuthSession|null=null;
  private passwordWriteUncertain=false;
  private passwordWritePending=false;
  private rejectedSession=false;
  get sessionRejected(){return this.rejectedSession;}
  /** Presentation only: never clears or replays a refresh whose result is unknown. */
  get reauthenticationRequired(){
    const session=this.session;
    return this.rejectedSession||!!session&&this.relayEnabled&&(
      session.relayRefreshCandidate?.refreshPending===true
      ||session.relayRefreshPending===true&&!session.relayRefreshCandidate
      ||session.relayRefreshSafe!==true&&session.expiresAt<=Date.now()+60000);
  }
  // A verified response supplies only an in-memory preview; no new stored phone field.
  private phonePreview:{owner:string;value:string}|null=null;
  private accountFacts:AcceptedAccountFacts|null=null;
  get acceptedAccountFacts():AcceptedAccountFacts|null{
    const facts=this.accountFacts;
    return facts&&facts.owner===this.session?.owner&&facts.generation===this.generation?{...facts}:null;
  }
  get phoneDisplay(){return this.session?.phoneVerified&&this.phonePreview?.owner===this.session.owner?this.phonePreview.value:'';}
  private generation=0;
  get communityGeneration(){return this.generation;}
  /** Original credentials stay inside Root's transport closure, never in a UI prop. */
  originalChannelSession():OriginalChannelSession|null{
    const s=this.session;
    if(!s||s.expiresAt<=Date.now()+60000||s.service!==serviceKey(this.config)
      ||this.refreshing||this.bindingRefresh||this.validating)return null;
    try{
      const service=new URL(mobileServiceBase(this.config.api)),auth=new URL(this.config.auth);
      if([service,auth].some(u=>u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash))return null;
      return {session:{...s},generation:this.generation,serviceOrigin:service.origin,supabaseOrigin:auth.origin,publishableKey:this.config.publicKey};
    }catch{return null;}
  }
  /** Persist facts only. Original tokens, expiry, owner and partition are retained. */
  async commitChannelFacts(facts:{owner:string;kind:'email'|'phone';target:string;phoneVerified:true},expected:OriginalChannelSession,isCurrent:()=>boolean){
    const matches=()=>{
      const s=this.session,p=expected.session;
      return isCurrent()&&!!s&&this.generation===expected.generation&&s.owner===p.owner&&s.service===p.service
        &&s.accessToken===p.accessToken&&s.refreshToken===p.refreshToken&&s.expiresAt===p.expiresAt
        &&s.expiresAt>Date.now()+60000&&this.config.publicKey===expected.publishableKey;
    };
    if(!matches()||facts.owner!==expected.session.owner||facts.phoneVerified!==true||!['email','phone'].includes(facts.kind))throw new Error('原账号状态已变化，渠道事实未采用');
    const target=facts.kind==='email'?changeEmail(facts.target):mainlandPhone(facts.target);
    if(target!==facts.target)throw new Error('渠道事实格式未能核对');
    const session={...this.session!,phoneVerified:true,...(facts.kind==='email'?{email:target}:{})};
    await this.persist(session);
    if(!matches()){
      await this.persist(this.session);
      throw new Error('保存期间账号已变化，请重新核对当前登录');
    }
    this.session=session;
    if(facts.kind==='phone')this.phonePreview={owner:session.owner,value:maskPhone(target)};
  }
  /** Cancel outstanding credentials without claiming a durable logout yet. */
  invalidatePendingAuth(){this.generation++;this.accountFacts=null;}
  private refreshing:Promise<void>|null=null;
  private bindingRefresh:Promise<void>|null=null;
  private validating:Promise<AuthSession|null>|null=null;
  private relayRefreshDispatch=false;
  private sessionWrites:Promise<void>=Promise.resolve();
  async settleSessionWrites(){await this.sessionWrites.catch(()=>{});}
  constructor(readonly config:CloudConfig,private saveSession:(session:AuthSession|null)=>Promise<void>,private http:typeof transport=transport,private testOnly=communityTestOnly){validateCloudConfig(config);}
  private persist(session:AuthSession|null){
    const generation=this.generation;
    const work=this.sessionWrites.then(async()=>{
      if(generation!==this.generation)throw new Error('账号已变化，旧保存已取消');
      await this.saveSession(session);
      if(generation!==this.generation){
        // Correct an in-flight old write before a queued logout/new login saves.
        await this.saveSession(this.session);
        throw new Error('账号已变化，旧保存未采用');
      }
    });
    this.sessionWrites=work.catch(()=>{});return work;
  }
  restore(session:AuthSession|null){this.phonePreview=null;this.accountFacts=null;if(session&&session.service===serviceKey(this.config)){this.session=session;}return this.session;}
  /** Only for an isolated, non-persistent recovery client. Invalidates late replies. */
  discardTemporarySession(){this.generation++;this.session=null;this.accountFacts=null;}
  private headers(token?:string){return {'Content-Type':'application/json',apikey:this.config.publicKey,...(token?{Authorization:`Bearer ${token}`}:{})};}
  private get relayEnabled(){return nativeSessionRelayReady&&mobileServiceBase(this.config.api)==='https://service-1.example.invalid'&&this.config.auth.replace(/\/$/,'')==='https://auth-4.example.invalid';}
  private async auth(path:string,method:string,body?:unknown,token?:string){
    if(this.relayEnabled&&method==='POST'&&path==='/token?grant_type=refresh_token'){
      if(!this.relayRefreshDispatch)throw new Error('登录续接必须先安全保存状态，请用原账号重新登录');
      this.relayRefreshDispatch=false;
    }
    const input=body as Record<string,unknown>|undefined;
    const relayPath=this.relayEnabled?((method==='GET'||method==='PUT')&&path==='/user'?'/user':method==='POST'&&path==='/token?grant_type=password'?'/password':method==='POST'&&path==='/token?grant_type=refresh_token'?'/refresh':method==='POST'&&path==='/otp'&&typeof input?.create_user==='boolean'&&input?.channel==='sms'?'/phone-otp':method==='POST'&&path==='/verify'&&input?.type==='sms'?'/phone-verify':null):null;
    const url=relayPath?mobileServiceBase(this.config.api)+'/api/auth/native-session'+relayPath:this.config.auth.replace(/\/$/,'')+'/auth/v1'+path;
    const otpRequest=method==='POST'&&path==='/otp';
    const unknownOtp=unknownOtpMessage;
    let response:Response;
    // The relay owns bounded SMS retries. Keep one HTTP wait; other auth limits stay unchanged.
    try{response=await this.http(url,{method,cache:'no-store',headers:this.headers(token),body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(relayPath==='/phone-otp'?45000:20000)});}
    catch{if(otpRequest)throw new OtpSendError('请求超时或连接中断。'+unknownOtp,0,'unknown');throw new Error('账号连接未完成，可能中断或超时；本机资料保留，请稍后核对登录状态。');}
    if(!response.ok){
      let code='',retryAfterSeconds:number|undefined;
      try{
        const result=await response.json();
        const safeDetail=relayPath&&result.detail&&typeof result.detail==='object'?result.detail:null;
        code=typeof result.code==='string'?result.code:typeof result.error_code==='string'?result.error_code:typeof safeDetail?.code==='string'?safeDetail.code:'';
        retryAfterSeconds=otpRetryAfter(safeDetail?.retryAfterSeconds??result.retryAfterSeconds);
      }catch{/* Keep the HTTP status when the response is not JSON. */}
      const known:Record<string,string>={
        phone_provider_disabled:'短信登录服务尚未开启，请等待服务接通；无需修改手机号或反复发送',
        email_provider_disabled:'邮箱登录服务尚未开启，请等待服务接通',
        signup_disabled:'当前服务尚未开放新用户注册，请等待服务接通',
        otp_disabled:'本次仅核对已有账号，请核对原手机号；如需注册，请返回“首次注册或登录”入口后手动获取',
        otp_expired:'验证码不正确或已过期，请核对后重试，或重新获取验证码。',
        same_password:'新密码不能与当前密码相同，请换一个新密码；当前密码尚未更改',
        invalid_credentials:'账号或密码不正确，请核对后重试。忘记密码可通过验证码找回。',
        gxj_invalid_credentials:'账号或密码不正确，请核对后重试。忘记密码可通过验证码找回。',
        gxj_sms_rejected:'本次短信未发送成功，不计入今日 5 次；请稍后重新申请，已有验证码仍由服务核验',
        gxj_sms_total_limit:'短信累计额度已用完，请联系服务方恢复；无需反复发送',
        gxj_sms_day_limit:'今日短信额度已用完，请在下一额度周期重试',
        gxj_sms_phone_day_limit:'此号码今日短信次数已用完，请在下一额度周期重试',
        gxj_sms_cooldown:retryAfterSeconds===undefined?'此号码仍在发送间隔内，请稍后再申请':`此号码仍需等待 ${retryAfterSeconds} 秒后再申请验证码`,
        gxj_sms_month_limit:'本月短信额度已用完，请等待下月；服务方需同时核对套餐剩余量',
        gxj_sms_capacity_expired:'短信套餐已到期，请联系服务方恢复；无需反复发送',
        gxj_sms_duplicate:'本次请求已处理，请查看已收到的短信；不要重复提交',
        gxj_phone_unsupported:'暂不支持该手机号，请使用中国大陆手机号',
        gxj_phone_signup_conflict:'本次手机号验证暂时无法继续，请稍后重新获取验证码；已收到的验证码可直接填写',
        gxj_phone_signup_unavailable:'手机号注册服务暂未就绪，请稍后重试',
        gxj_phone_signup_rejected:'手机号注册未通过核对，请检查号码或稍后重试',
        gxj_registration_invite_unavailable:'邀请准备未通过，注册未继续；请读取已保存的邀请进度，勿反复发码',
        gxj_sms_unknown:'短信发送结果未确认，请先查看已收到的短信；通常需冷却 60 秒，以页面倒计时为准。倒计时结束后可手动重新获取，不会自动重发',
        gxj_sms_gate_unavailable:'短信发送状态暂时无法核对，请稍后核对，不要自动重发',
      };
      // Display reviewed local messages only; remote free text may contain private data.
      const verificationFailure=[400,401,403,422].includes(response.status)&&method==='POST';
      const codeMatchesRequest=['invalid_credentials','gxj_invalid_credentials'].includes(code)?verificationFailure&&path==='/token?grant_type=password':code==='otp_expired'?verificationFailure&&path==='/verify':true;
      const knownMessage=codeMatchesRequest&&Object.prototype.hasOwnProperty.call(known,code)?known[code]:null;
      const message=knownMessage??(response.status===429?'请求过于频繁，请稍后重试；验证码申请还需遵守发送间隔和额度。':otpRequest?unknownOtp:response.status>=500?'账号服务暂时不可用，请稍后重试；本机资料保持不变。':'本次账号请求未能完成，请稍后核对登录状态。');
      if(otpRequest){const uncertain=!knownMessage||['gxj_sms_unknown','gxj_sms_gate_unavailable','gxj_sms_duplicate'].includes(code);throw new OtpSendError(message,response.status,uncertain?'unknown':'rejected',retryAfterSeconds);}
      throw new CloudHttpError(message,response.status);
    }
    if(response.status===204)return {};
    try{
      const result=await response.json();
      if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();
      return result;
    }catch{if(otpRequest)throw new OtpSendError(unknownOtp,response.status,'unknown');throw new Error('账号响应未能确认；本机资料保留，请稍后核对登录状态。');}
  }
  private verifiedName(user:Record<string,unknown>){
    const prior=this.session;
    const previous=prior?.owner===user.id&&prior?.service===serviceKey(this.config)?prior.profileDefaultName:undefined;
    return verifiedProfileDefault(user.created_at,confirmedPhone(user)?user.phone:null,previous);
  }
  private async accept(result:Record<string,unknown>,generation:number,expectedOwner?:string,expectedPhone?:string,expectedEmail?:string,source:AcceptedAccountFacts['source']='other'){
    if(generation!==this.generation)throw new Error('账号操作已取消，旧响应已丢弃');
    if(typeof result.access_token!=='string'||typeof result.refresh_token!=='string')throw new Error('账号响应缺少登录凭据');
    const user=await this.auth('/user','GET',undefined,result.access_token);
    if(typeof user.id!=='string'||!user.id||(expectedOwner&&user.id!==expectedOwner))throw new Error('账号身份校验失败，未绑定本机资料');
    if(expectedPhone&&(!confirmedPhone(user)||mainlandPhone(String(user.phone))!==expectedPhone))throw new Error('找回手机号未能核对，未更改密码');
    if(expectedEmail&&(typeof user.email!=='string'||user.email.trim().toLowerCase()!==expectedEmail))throw new Error('邮箱身份未能核对，未保存登录');
    if(source==='otp'&&expectedEmail&&!confirmedPhone(user))throw new Error('此账号尚未完成手机验证，请先使用手机号注册；未保存登录');
    const session:AuthSession={owner:user.id,email:typeof user.email==='string'?user.email:'',accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()+Math.max(1,Number(result.expires_in)||3600)*1000,service:serviceKey(this.config),phoneVerified:confirmedPhone(user),profileDefaultName:this.verifiedName(user),...(this.relayEnabled?{relayRefreshSafe:true as const}:{})};
    if(generation!==this.generation)throw new Error('账号已切换，旧响应已丢弃');
    await this.persist(session);
    if(generation!==this.generation){await this.persist(this.session);throw new Error('账号已切换，旧响应已丢弃');}
    this.session=session;this.rejectedSession=false;if(source==='password'||source==='otp')this.passwordWriteUncertain=false;this.phonePreview={owner:session.owner,value:session.phoneVerified?maskPhone(user.phone):''};
    const created=typeof user.created_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(user.created_at)?Date.parse(user.created_at):NaN;
    this.accountFacts={owner:session.owner,createdAt:Number.isFinite(created)?new Date(created).toISOString():null,phoneVerified:session.phoneVerified===true,generation,source};
    return session;
  }
  /** Normal password authentication, but never adopts a different account. */
  async reauthenticateDeletion(kind:'phone'|'email',destination:string,password:string,owner:string){
    if(this.session?.owner!==owner||!password)throw new Error('请使用当前账号重新验证');
    const target=kind==='phone'?mainlandPhone(destination):destination.trim().toLowerCase();
    if(kind==='email'&&(!/^\S+@\S+\.\S+$/.test(target)||target.length>254))throw new Error('请输入当前账号的有效邮箱');
    const generation=++this.generation;
    return this.accept(await this.auth('/token?grant_type=password','POST',{[kind]:target,password}),generation,owner,kind==='phone'?target:undefined,kind==='email'?target:undefined,'password');
  }
  /** No implicit refresh or retry around an irreversible operation. */
  async accountDeletionRequest(action:'prepare'|'confirm',body:unknown,owner:string){
    const prior=this.session,generation=this.generation;
    if(!prior||prior.owner!==owner||prior.expiresAt<=Date.now())throw new Error('请重新验证当前账号后核对注销范围');
    const response=await this.http(mobileServiceBase(this.config.api)+'/api/account-deletion/'+action,{method:action==='prepare'?'GET':'POST',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+prior.accessToken},body:action==='prepare'?undefined:JSON.stringify(body),signal:timeoutSignal(20000)});
    if(this.generation!==generation||this.session?.owner!==owner)throw new Error('账号已变化，注销结果须读取原请求核对');
    if(!response.ok){
      if(action==='confirm'&&[403,409].includes(response.status)){
        let detail:unknown;try{detail=JSON.parse(new TextDecoder().decode(await readBoundedResponse(response,16*1024))).detail;}catch{/* Any unknown body keeps the dispatched journal. */}
        const d=detail as {code?:unknown;message?:unknown}|null;
        if(d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).sort().join()==='code,message'&&d.code==='account_deletion_not_started'&&d.message==='本次注销尚未开始，请重新验证并核对范围')throw new DeletionNotStartedError();
      }else await response.body?.cancel();
      throw new CloudHttpError(`注销请求未能确认（${response.status}），请读取原请求结果`,response.status);
    }
    return JSON.parse(new TextDecoder().decode(await readBoundedResponse(response,128*1024)));
  }
  async login(email:string,password:string){const generation=++this.generation;return this.accept(await this.auth('/token?grant_type=password','POST',{email:email.trim(),password}),generation,undefined,undefined,undefined,'password');}
  async loginPhone(phone:string,password:string){const target=mainlandPhone(phone);if(!password)throw new Error('请输入密码');const generation=++this.generation;return this.accept(await this.auth('/token?grant_type=password','POST',{phone:target,password}),generation,undefined,target,undefined,'password');}
  async acceptEmailReturn(result:{access_token:string;refresh_token:string;expires_in:number}):Promise<AuthSession>{
    if(!result||typeof result.access_token!=='string'||!result.access_token||typeof result.refresh_token!=='string'||!result.refresh_token||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new Error('邮件回跳凭据不完整，请重新请求找回邮件');
    return this.accept(result,++this.generation);
  }
  async register(email:string,password:string){requireNewPassword(password);const generation=++this.generation;const result=await this.auth('/signup','POST',{email:email.trim(),password});if(result.access_token)return this.accept(result,generation);return null;}
  private async enrollment(action:'start'|'status'|'resend'|'verify',body:EnrollmentRequest,generation:number){
    if(!emailEnrollmentReady)throw new Error('邮箱验证码注册尚未开放，请使用手机号注册');
    if(this.session&&action!=='status')throw new Error('请先继续完成当前账号，不能另建注册身份');
    requireEnrollmentRequest(body,action);
    const response=await this.http(mobileServiceBase(this.config.api)+'/api/auth/email-enrollment/'+action,{method:'POST',cache:'no-store',headers:this.headers(),body:JSON.stringify(body),signal:timeoutSignal(20000)});
    if(generation!==this.generation)throw new Error('注册操作已取消，进度保留；请重新读取');
    if(!response.ok){
      let detail;try{detail=(await response.json()).detail;}catch{/* Unstructured failures cannot authorize discarding progress. */}
      if(action==='start'&&[403,422].includes(response.status)&&detail?.notStarted===true&&['invalid_email','email_not_approved'].includes(detail.code))throw new EnrollmentNotStartedError(detail.code==='invalid_email'?'邮箱格式未通过核对，注册尚未开始，可更正邮箱':'该邮箱尚未加入本轮测试，注册尚未开始，可更正邮箱',response.status);
      const messages:Record<number,string>={400:'注册或验证码未通过核对，请检查本次最新邮件',403:'当前注册无法继续，请核对原注册进度或使用原账号登录',409:'注册状态正在变化，请重新读取；不要重复发送',410:'本次注册续接已到期，请联系支持核对',429:'请求过于频繁，请稍后再读取状态',503:'邮箱注册服务暂不可用，请稍后读取状态'};throw new CloudHttpError(messages[response.status]??`注册请求未能确认（${response.status}），请先读取状态`,response.status);}
    return response.json();
  }
  async emailEnrollmentStatus(action:'start'|'status'|'resend',body:EnrollmentRequest){const generation=this.generation;const value=await this.enrollment(action,body,generation);if(generation!==this.generation)throw new Error('注册操作已取消');return parseEnrollmentStatus(value,body.enrollment);}
  async verifyEmailEnrollment(body:EnrollmentRequest,expectedOwner:string){
    if(!uuid(expectedOwner))throw new Error('请先读取本次注册身份');
    const generation=++this.generation,result=await this.enrollment('verify',body,generation);
    if(result.owner!==expectedOwner||result.email!==body.email||result.emailVerified!==true||result.phoneRequired!==true)throw new Error('邮箱注册证明未能核对，未保存登录');
    return this.accept(result,generation,expectedOwner,undefined,body.email,'email-enrollment');
  }
  async registrationRewardsCall(action:'prepare'|'read'|'status'|'complete',body:Record<string,unknown>={}){
    const generation=this.generation,previous=this.session,authenticated=action==='status'||action==='complete';
    if(authenticated&&(!previous||!previous.phoneVerified||previous.expiresAt<=Date.now()+60000))throw new Error('请先核对当前账号登录状态');
    const path=action==='status'?'/api/team/registration/me':action==='complete'?'/api/team/registration/complete':'/api/auth/registration-rewards/'+action;
    const signal=timeoutSignal(15000),response=await this.http(mobileServiceBase(this.config.api)+path,{method:action==='status'?'GET':'POST',cache:'no-store',headers:this.headers(authenticated?previous!.accessToken:undefined),body:action==='status'?undefined:JSON.stringify(body),signal,redirect:'error',referrerPolicy:'no-referrer'});
    if(generation!==this.generation||authenticated&&this.session!==previous)throw new Error('账号已变化，注册奖励结果未采用');
    if(!response.ok){
      if(action==='prepare' && (response.status===422||response.status===429)){
        let errorBody:unknown;
        try{errorBody=JSON.parse(new TextDecoder().decode(await readBoundedResponse(response,1024,signal)));}catch{/* Retain unknown outcome. */}
        if(errorBody && typeof errorBody==='object' && Object.keys(errorBody).length===1 && 'detail' in errorBody &&
           errorBody.detail==='注册奖励状态暂无法确认，请读取原进度；不要重复提交')
          throw new InvitationPrepareRejected(response.status===429?'邀请准备请求较多，请稍后重试':'邀请码准备未受理，请核对输入后重试');
      }
      throw new Error('邀请核对结果暂未确认，请读取原进度；登录和本机训练保持');
    }
    const bytes=await readBoundedResponse(response,16384,signal);
    if(generation!==this.generation||authenticated&&this.session!==previous)throw new Error('账号已变化，注册奖励结果未采用');
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  async sendOtp(kind:'phone'|'email',destination:string,createUser=false,registrationCapability?:string):Promise<OtpSendReceipt>{
    const value=kind==='email'?destination.trim().toLowerCase():destination.trim();
    if(kind==='phone'?!/^\+861[3-9]\d{9}$/.test(value):!/^\S+@\S+\.\S+$/.test(value))throw new Error(kind==='phone'?'请输入 +86 开头的中国大陆手机号':'请输入有效邮箱');
    if(registrationCapability!==undefined&&(kind!=='phone'||!createUser||! /^[A-Za-z0-9_-]{43}$/.test(registrationCapability)))throw new Error('注册进度绑定无效');
    const result=await this.auth('/otp','POST',{[kind]:value,create_user:createUser,...(kind==='phone'?{channel:'sms'}:{}),...(registrationCapability?{data:{gxj_reward_registration:registrationCapability}}:{})});
    const accepted=result.sent===true&&result.deliveryStatus==='accepted';
    return {outcome:accepted?'accepted':'unconfirmed',retryAfterSeconds:otpRetryAfter(result.retryAfterSeconds),message:accepted?'短信发送请求已受理，请以手机实际收到为准；新旧验证码是否有效由服务核验。':kind==='phone'?unknownOtpMessage:'邮箱验证码请求已返回；若已收到邮件，可填写验证码。'};
  }
  async verifyOtp(kind:'phone'|'email',destination:string,code:string,expectedOwner?:string){
    const token=code.trim(),digits=otpLength(kind);if(token.length!==digits||!/^\d+$/.test(token))throw new Error(`请输入 ${digits} 位验证码`);
    const value=kind==='email'?destination.trim().toLowerCase():destination.trim();
    if(kind==='phone'?!/^\+861[3-9]\d{9}$/.test(value):!/^\S+@\S+\.\S+$/.test(value))throw new Error('接收地址无效，请重新填写');
    const generation=++this.generation;
    return this.accept(await this.auth('/verify','POST',{[kind]:value,token,type:kind==='phone'?'sms':'email'}),generation,expectedOwner,kind==='phone'?mainlandPhone(value):undefined,kind==='email'?value:undefined,'otp');
  }
  async recover(email:string){await this.auth('/recover','POST',{email:email.trim()});}
  /** Used only by the non-persistent recovery client, never as a login shortcut. */
  async verifyPhoneRecovery(phone:string,code:string){
    const target=mainlandPhone(phone),token=code.trim();
    if(!/^\d{6}$/.test(token))throw new Error('请输入 6 位验证码');
    const generation=++this.generation;
    return this.accept(await this.auth('/verify','POST',{phone:target,token,type:'sms'}),generation,undefined,target);
  }
  async verify(email:string,code:string,type:'signup'|'recovery'){
    const generation=++this.generation;
    // Supabase's email OTP form uses "email"; signup links keep their own type.
    let payload:Record<string,string>={email:email.trim(),token:code.trim(),type:type==='signup'&&new RegExp(`^\\d{${otpLength('email')}}$`).test(code.trim())?'email':type};
    // A user may paste the verification URL from their own email instead of an OTP.
    if(/^https:\/\//i.test(code.trim())){const url=new URL(code.trim());const auth=new URL(this.config.auth);if(url.origin!==auth.origin||url.pathname!=='/auth/v1/verify'||url.searchParams.get('type')!==type)throw new Error('请使用当前账号邮件中的对应验证链接');const hash=url.searchParams.get('token');if(!hash)throw new Error('验证链接缺少 token');payload={token_hash:hash,type};}
    return this.accept(await this.auth('/verify','POST',payload),generation);
  }
  async refresh(){
    if(this.bindingRefresh)await this.bindingRefresh.catch(()=>{});
    if(this.refreshing)return this.refreshing;
    const previous=this.session,generation=this.generation;if(!previous)throw new CloudHttpError('请先登录；本机资料保持不变',401);
    this.refreshing=(async()=>{try{
      if(this.relayEnabled&&previous.relayRefreshCandidate){await this.resumeRefreshCandidate(previous,generation);return;}
      if(this.relayEnabled&&(previous.relayRefreshSafe!==true||previous.relayRefreshPending!==undefined))throw new Error('原登录续接结果尚未确认，请用原账号重新登录；本机资料保持');
      if(this.relayEnabled){const pending={...previous,relayRefreshPending:true as const};await this.persist(pending);if(generation!==this.generation||this.session!==previous){await this.persist(this.session);throw new Error('账号已变化，未发送登录续接');}this.session=pending;}
      this.relayRefreshDispatch=this.relayEnabled;
      const result=await this.auth('/token?grant_type=refresh_token','POST',{refresh_token:previous.refreshToken});
      if(this.relayEnabled){
        const pending=await this.saveRefreshCandidate(result,previous,generation);
        await this.resumeRefreshCandidate(pending,generation);
      }else await this.accept(result,generation,previous.owner);
    }catch(error){if(error instanceof CloudHttpError&&[400,401,403].includes(error.status)&&generation===this.generation){this.rejectedSession=true;await this.persist(null);if(generation===this.generation)this.session=null;else await this.persist(this.session);}throw error;}})().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  private async saveRefreshCandidate(result:Record<string,unknown>,previous:AuthSession,generation:number){
    if(generation!==this.generation||this.session?.owner!==previous.owner||this.session.service!==previous.service)throw new Error('账号已变化，旧续接响应已丢弃');
    if(typeof result.access_token!=='string'||!result.access_token||typeof result.refresh_token!=='string'||!result.refresh_token||typeof result.expires_in!=='number'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new Error('登录续接响应不完整，请用原账号重新登录');
    const candidate:RelayRefreshCandidate={accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()+result.expires_in*1000};
    if(!Number.isFinite(candidate.expiresAt))throw new Error('登录续接有效期无效');
    const pending:AuthSession={...previous,relayRefreshPending:true,relayRefreshCandidate:candidate};
    // Keep received credentials isolated from all ordinary API consumers. If the
    // secure write fails, retain the candidate in memory for a save-only retry.
    this.session=pending;await this.persist(pending);return pending;
  }
  private async resumeRefreshCandidate(previous:AuthSession,generation:number):Promise<void>{
    let pending=previous,candidate=pending.relayRefreshCandidate;
    if(!candidate||pending.relayRefreshPending!==true||pending.service!==serviceKey(this.config)
      ||typeof candidate.accessToken!=='string'||!candidate.accessToken||typeof candidate.refreshToken!=='string'||!candidate.refreshToken
      ||!Number.isFinite(candidate.expiresAt)||candidate.refreshPending!==undefined&&candidate.refreshPending!==true)throw new Error('登录续接凭据无法核对，请用原账号重新登录');
    const current=()=>generation===this.generation&&this.session===pending;
    if(!current())throw new Error('账号已变化，续接已取消');
    if(candidate.refreshPending)throw new Error('原登录续接结果尚未确认，请用原账号重新登录；本机资料保持');
    // Also retries a prior failed secure write, never the prior refresh POST.
    await this.persist(pending);
    if(!current())throw new Error('账号已变化，续接已取消');
    if(candidate.expiresAt<=Date.now()+60000){
      const unusedRefresh=candidate.refreshToken;
      const unconsumed=pending;
      pending={...pending,relayRefreshCandidate:{...candidate,refreshPending:true}};
      this.session=pending;
      try{await this.persist(pending);}catch(error){
        // No HTTP request has been dispatched. Only this still-current operation
        // can restore the unconsumed candidate for a durable-save retry.
        if(current())this.session=unconsumed;
        throw error;
      }
      if(!current())throw new Error('账号已变化，未发送登录续接');
      this.relayRefreshDispatch=true;
      const result=await this.auth('/token?grant_type=refresh_token','POST',{refresh_token:unusedRefresh});
      pending=await this.saveRefreshCandidate(result,pending,generation);
      candidate=pending.relayRefreshCandidate!;
    }
    const user=await this.auth('/user','GET',undefined,candidate.accessToken);
    if(!current())throw new Error('账号已变化，旧核验响应已丢弃');
    if(user.id!==previous.owner)throw new CloudHttpError('登录身份不一致，请重新登录',401);
    if(candidate.expiresAt<=Date.now())throw new Error('本次登录核验期间凭据已过期，请重新连接');
    const session:AuthSession={owner:previous.owner,service:previous.service,email:typeof user.email==='string'?user.email:'',phoneVerified:confirmedPhone(user),profileDefaultName:this.verifiedName(user),accessToken:candidate.accessToken,refreshToken:candidate.refreshToken,expiresAt:candidate.expiresAt,relayRefreshSafe:true};
    await this.persist(session);
    if(!current())throw new Error('账号已变化，旧核验结果未采用');
    this.session=session;this.rejectedSession=false;this.phonePreview={owner:session.owner,value:session.phoneVerified?maskPhone(user.phone):''};
  }
  /** Validate a restored identity without reading or uploading any training data. */
  async validateSession():Promise<AuthSession|null>{
    if(this.validating)return this.validating;
    const previous=this.session,generation=this.generation;
    if(!previous)return null;
    this.validating=(async()=>{
      try{
        if(previous.relayRefreshCandidate||previous.expiresAt<=Date.now()+60000){await this.refresh();}
        else{
          const user=await this.auth('/user','GET',undefined,previous.accessToken);
          if(generation!==this.generation)throw new Error('账号操作已取消');
          if(user.id!==previous.owner)throw new CloudHttpError('登录身份不一致，请重新登录',401);
          const session={...previous,email:typeof user.email==='string'?user.email:'',phoneVerified:confirmedPhone(user),profileDefaultName:this.verifiedName(user)};await this.persist(session);if(generation!==this.generation){await this.persist(this.session);throw new Error('账号操作已取消');}this.session=session;this.phonePreview={owner:session.owner,value:session.phoneVerified?maskPhone(user.phone):''};
        }
        if(generation!==this.generation)throw new Error('账号操作已取消');
        this.rejectedSession=false;
        return this.session;
      }catch(error){
        if(error instanceof CloudHttpError&&[400,401,403].includes(error.status)&&generation===this.generation&&this.session){
          this.rejectedSession=true;
          await this.persist(null);
          if(generation===this.generation)this.session=null;else await this.persist(this.session);
        }
        throw error;
      }
    })().finally(()=>{this.validating=null;});
    return this.validating;
  }
  async updatePassword(password:string){
    if(this.passwordWriteUncertain)throw new PasswordOutcomeUnknownError();
    if(this.passwordWritePending)throw new Error('密码正在提交，请稍候');
    requireNewPassword(password);if(!this.session)throw new Error('先登录或验证找回邮件');
    const generation=this.generation,owner=this.session.owner;
    this.passwordWritePending=true;
    let dispatched=false;
    try{
      if(this.session.expiresAt<Date.now()+60000)await this.refresh();
      const current=()=>generation===this.generation&&this.session?.owner===owner;
      if(!current())throw new Error('账号操作已取消，未继续更改密码');
      dispatched=true;const receipt=await this.auth('/user','PUT',{password},this.session!.accessToken);
      if(this.relayEnabled&&(receipt.id!==owner||receipt.password_updated!==true))throw new PasswordOutcomeUnknownError();
      if(!current())throw new PasswordOutcomeUnknownError();
    }catch(error){if(!dispatched||error instanceof CloudHttpError&&[400,401,403,413,415,422,429].includes(error.status))throw error;this.passwordWriteUncertain=true;throw new PasswordOutcomeUnknownError();}
    finally{this.passwordWritePending=false;}
  }
  async logout(){
    const previous=this.session;this.generation++;
    // Until the durable credential clear is acknowledged, the UI must still show
    // the prior account. A restart could otherwise restore a session shown as signed out.
    await this.persist(null);
    this.session=null;
    if(previous){try{await this.auth('/logout?scope=local','POST',undefined,previous.accessToken);}catch{return false;}}
    return true;
  }
  private async account(path:string,method:string,body?:unknown){
    const previous=this.session,generation=this.generation;if(!previous)throw new CloudHttpError('请先使用邮箱密码登录',401);
    if(previous.expiresAt<Date.now()+60000)await this.refresh();
    if(generation!==this.generation||this.session?.owner!==previous.owner)throw new Error('账号已切换，操作已取消');
    const response=await this.http(mobileServiceBase(this.config.api)+'/api/auth'+path,{method,cache:'no-store',headers:this.headers(this.session.accessToken),body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(20000)});
    const result=await response.json().catch(()=>({}));if(generation!==this.generation||this.session?.owner!==previous.owner)throw new Error('账号已切换，结果未采用');
    if(!response.ok)throw new CloudHttpError(typeof result.detail==='string'?result.detail:`账号操作未完成（${response.status}）`,response.status);
    return result as Record<string,unknown>;
  }
  async startPhoneBinding(phone:string){const owner=this.session?.owner;const result=await this.account('/phone-binding/start','POST',{phone:mainlandPhone(phone)});if(result.owner!==owner||result.sent!==true)throw new Error('手机发送状态不一致，请重新核对');}
  async verifyPhoneBinding(phone:string,code:string){if(!/^\d{6}$/.test(code))throw new Error('请输入 6 位验证码');const target=mainlandPhone(phone),owner=this.session?.owner,generation=this.generation;if(!owner)throw new Error('请先使用邮箱密码登录');const result=await this.account('/phone-binding/verify','POST',{phone:target,token:code});return this.accept(result,generation,owner,target,undefined,'phone-binding');}
  async emailSecurityStatus():Promise<EmailSecurityStatus>{
    const owner=this.session?.owner,result=await this.account('/email-security/status','GET');
    if(result.owner!==owner||typeof result.emailVerified!=='boolean'||typeof result.emailVerificationReady!=='boolean'||(result.challenge!==null&&(typeof result.challenge!=='string'||!uuid(result.challenge)))||typeof result.expiresIn!=='number'||!Number.isFinite(result.expiresIn)||result.expiresIn<0||result.expiresIn>300||typeof result.retryAfter!=='number'||!Number.isInteger(result.retryAfter)||result.retryAfter<0||result.retryAfter>60)throw new Error('邮箱验证状态未能核对，请重试');
    return result as EmailSecurityStatus;
  }
  private bindingStatus(result:Record<string,unknown>,owner:string|undefined):EmailBindingStatus{
    if(result.owner!==owner||!['idle','requesting','pending','verifying','uncertain','invalidated','verified','needs_proof'].includes(String(result.state))
      ||(result.intent!==null&&(typeof result.intent!=='string'||!uuid(result.intent)))
      ||(result.email!==null&&(typeof result.email!=='string'||!/^\S+@\S+\.\S+$/.test(result.email)))
      ||typeof result.emailVerified!=='boolean'||typeof result.canVerify!=='boolean'||typeof result.retryAfter!=='number'||!Number.isInteger(result.retryAfter)||result.retryAfter<0||result.retryAfter>300
      ||(result.canVerify&&(!result.intent||result.email||!['pending','uncertain'].includes(String(result.state))||result.retryAfter===0))
      ||(result.state==='verified'&&(!result.email||!result.emailVerified))
      ||(result.emailVerified&&result.state!=='verified'))throw new Error('绑定邮箱状态未能核对，请重新读取');
    return result as EmailBindingStatus;
  }
  private lastEmailChange:{owner:string;generation:number;receipt:EmailChangeStatus}|null=null;
  /** Exactly one request; never refresh, retry, or accept response credentials. */
  async emailChangeAction(action:'status'|'begin'|'request'|'verify'|'cancel'|'reconcile',body:Record<string,unknown>={},visible:()=>boolean=()=>true):Promise<EmailChangeStatus>{
    if(!emailChangeReady)throw new Error('更换邮箱尚未开放');
    const previous=this.session,generation=this.generation;
    const current=()=>!!previous&&visible()&&this.generation===generation&&this.session?.owner===previous.owner;
    if(!previous||!current())throw new Error('账号状态已变化，请重新读取');
    const fields:string[]={status:[],begin:['kind','target','lost_channel'],request:['intent','target'],verify:['intent','target','leg','token'],cancel:['intent'],reconcile:['intent']}[action];
    if(!fields||Object.keys(body).some(k=>!fields.includes(k)))throw new Error('更换请求无效');
    if(action==='begin'&&(body.kind!=='email'||body.lost_channel!==false))throw new Error('此入口只支持双方邮箱确认');
    if(!['status','begin'].includes(action)&&!changeUuid(body.intent))throw new Error('请先读取本次更换请求');
    if(['begin','request','verify'].includes(action)){if(typeof body.target!=='string'||changeEmail(body.target)!==body.target)throw new Error('请重新填写本次新邮箱');}
    if(action==='verify'&&(!['old','new'].includes(String(body.leg))||typeof body.token!=='string'||!/^\d{8}$/.test(body.token)))throw new Error('请输入本次邮箱的 8 位验证码');
    const response=await this.http(mobileServiceBase(this.config.api)+'/api/auth/channel-change/'+action,{method:action==='status'?'GET':'POST',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${previous.accessToken}`},body:action==='status'?undefined:JSON.stringify(body),signal:timeoutSignal(20000)});
    if(!current())throw new Error('页面或账号已变化，旧响应已丢弃');
    if(!response.ok)throw new CloudHttpError(`更换请求未能确认（${response.status}），请读取状态核对，避免重复发送`,response.status);
    const raw:unknown=await response.json();if(!current())throw new Error('页面或账号已变化，旧响应已丢弃');
    const receipt=parseEmailChange(raw,typeof body.intent==='string'?body.intent:undefined);
    if(action==='begin'&&(typeof receipt.resumed!=='boolean'||!receipt.intent))throw new Error('新更换请求未能核对，请读取状态');
    if(action==='begin'&&this.lastEmailChange?.owner===previous.owner&&this.lastEmailChange.receipt.state==='completed'&&(receipt.intent===this.lastEmailChange.receipt.intent||receipt.resumed!==false))throw new Error('新请求重复引用了上次完成收据，请读取状态核对');
    this.lastEmailChange={owner:previous.owner,generation,receipt};return receipt;
  }
  /** Explicit refresh + same UID read ONLY. Never replays a change write. */
  async revalidateEmailChange(visible:()=>boolean=()=>true){
    const prior=this.session,generation=this.generation;
    const current=()=>!!prior&&visible()&&this.generation===generation&&this.session?.owner===prior.owner;
    if(!emailChangeReady||!current()||this.refreshing||this.bindingRefresh)throw new Error('账号正在变化，请稍后重新核验');
    const result=await this.auth('/token?grant_type=refresh_token','POST',{refresh_token:prior!.refreshToken});
    if(!current())throw new Error('页面或账号已变化，登录核验响应已丢弃');
    if(typeof result.access_token!=='string'||!result.access_token||typeof result.refresh_token!=='string'||!result.refresh_token||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new Error('登录核验凭据未能确认，原身份保留');
    const user=await this.auth('/user','GET',undefined,result.access_token);
    if(!current())throw new Error('页面或账号已变化，登录身份响应已丢弃');
    if(user.id!==prior!.owner||!confirmedPhone(user)||typeof user.email!=='string')throw new Error('原账号身份未能核对，登录核验结果未保存');
    const session={...prior!,email:user.email,accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()+result.expires_in*1000,phoneVerified:true};
    await this.persist(session);if(!current()){await this.persist(this.session);throw new Error('页面或账号已变化，核验凭据未采用');}this.session=session;this.phonePreview={owner:session.owner,value:maskPhone(user.phone)};
  }
  /** Re-read the ORIGINAL bearer identity; new email proof remains separate. */
  async confirmChangedEmail(target:string,visible:()=>boolean=()=>true){
    const email=changeEmail(target),prior=this.session,generation=this.generation,last=this.lastEmailChange;
    const current=()=>!!prior&&visible()&&this.generation===generation&&this.session?.owner===prior.owner;
    if(!emailChangeReady||!current()||last?.owner!==prior!.owner||last?.generation!==generation||last.receipt.state!=='completed')throw new Error('请先读取已完成的本次更换状态');
    const user=await this.auth('/user','GET',undefined,prior!.accessToken);
    if(!current())throw new Error('页面或账号已变化，身份结果已丢弃');
    if(user.id!==prior!.owner||typeof user.email!=='string'||user.email.trim().toLowerCase()!==email||!confirmedPhone(user))throw new Error('原账号与新邮箱未能核对，登录保持原身份');
    const session={...prior!,email,phoneVerified:true};await this.persist(session);
    if(!current()){await this.persist(this.session);throw new Error('页面或账号已变化，旧身份结果未采用');}
    this.session=session;this.phonePreview={owner:session.owner,value:maskPhone(user.phone)};
  }
  async emailBindingStatus():Promise<EmailBindingStatus>{
    const owner=this.session?.owner;return this.bindingStatus(await this.account('/email-binding/status','GET'),owner);
  }
  async startEmailBinding(email:string):Promise<EmailBindingStatus&{delivery:'accepted'|'unknown'}>{
    email=email.trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)throw new Error('请输入有效的本人邮箱');
    const owner=this.session?.owner,result=await this.account('/email-binding/start','POST',{email});
    const state=this.bindingStatus(result,owner);if(!['accepted','unknown'].includes(String(result.delivery)))throw new Error('绑定邮件请求结果待核对，请重新读取状态');
    return {...state,delivery:result.delivery as 'accepted'|'unknown'};
  }
  async verifyEmailBinding(intent:string,email:string,token:string){
    email=email.trim().toLowerCase();if(!uuid(intent)||!/^\S+@\S+\.\S+$/.test(email)||!/^[0-9]{6,10}$/.test(token))throw new Error('请输入本次绑定的邮箱和验证码');
    const owner=this.session?.owner,generation=this.generation;
    const result=await this.account('/email-binding/verify','POST',{intent,email,token});
    if(result.owner!==owner||result.email!==email||result.emailVerified!==true)throw new Error('邮箱绑定结果未能核对，请重新读取状态');
    await this.refreshBoundEmail(email,owner,generation);
  }
  async refreshBoundEmail(email:string,owner=this.session?.owner,generation=this.generation){
    if(this.bindingRefresh)throw new Error('正在核对绑定结果，请稍候');
    this.bindingRefresh=this.readBoundEmail(email,owner,generation).finally(()=>{this.bindingRefresh=null;});
    return this.bindingRefresh;
  }
  private async readBoundEmail(email:string,owner:string|undefined,generation:number){
    if(this.refreshing)await this.refreshing;
    const prior=this.session,current=()=>generation===this.generation&&this.session?.owner===owner;
    if(!prior||!current())throw new Error('账号已切换，绑定结果未采用');
    const user=await this.auth('/user','GET',undefined,prior.accessToken);
    if(!current())throw new Error('账号已切换，绑定结果未采用');
    if(user.id!==owner||user.email!==email||!confirmedPhone(user))throw new Error('邮箱绑定身份未能核对，请重新读取状态');
    const session={...prior,email,phoneVerified:true};await this.persist(session);
    if(!current()){await this.persist(this.session);throw new Error('账号已切换，绑定结果未采用');}
    this.session=session;this.phonePreview={owner:session.owner,value:maskPhone(user.phone)};
  }
  async startEmailVerification():Promise<EmailSecurityChallenge>{
    const owner=this.session?.owner,result=await this.account('/email-security/start','POST',{});
    if(result.owner!==owner||typeof result.challenge!=='string'||!uuid(result.challenge)||typeof result.sent!=='boolean'||result.delivery!==(result.sent?'accepted':'unknown')||result.expiresIn!==300||result.retryAfter!==60)throw new Error('邮件请求状态未能核对，请检查收件箱后重试');
    return result as EmailSecurityChallenge;
  }
  async verifyEmailOwnership(challenge:string,token:string){
    if(!uuid(challenge)||!/^\d{6}$/.test(token))throw new Error('请输入本次邮件中的 6 位验证码');
    const owner=this.session?.owner,result=await this.account('/email-security/verify','POST',{challenge,token});
    if(result.owner!==owner||result.emailVerified!==true)throw new Error('邮箱验证结果未能核对，请重试');
  }
  async request<T>(path:string,method='GET',body?:unknown,revision?:number):Promise<T>{
    if(this.testOnly)throw new Error(trainingCloudUnavailable);
    if(path!=='/api/mobile-document')throw new Error('同步接口路径无效');
    if(!this.session)throw new CloudHttpError('请登录对应账号；本机资料保持不变',401);
    if(this.session.expiresAt<Date.now()+60000)await this.refresh();
    const generation=this.generation,owner=this.session!.owner;
    for(let attempt=0;attempt<2;attempt++){
      const token=this.session?.accessToken;if(!token)throw new CloudHttpError('登录已失效；本机资料保持不变',401);
      const headers:Record<string,string>={Accept:'application/json',Authorization:`Bearer ${token}`};if(body!==undefined)headers['Content-Type']='application/json';if(revision!==undefined)headers['If-Match']=String(revision);
      const response=await this.http(mobileServiceBase(this.config.api)+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(30000)});
      if(generation!==this.generation||this.session?.owner!==owner)throw new Error('账号已切换，旧响应已丢弃');
      if(response.status===401&&attempt===0){await this.refresh();continue;}
      if(!response.ok){let detail='';try{const result=await response.json();if(typeof result.detail==='string')detail='：'+result.detail.slice(0,220);}catch{/* A proxy error must not be mistaken for a document. */}throw new CloudHttpError(response.status===409?'其他设备刚更新资料，将重新读取合并':response.status===404?'此服务尚未部署手机全资料同步接口':`云同步失败（${response.status}）${detail}；本机资料已保留`,response.status);}
      return response.json();
    }
    throw new CloudHttpError('登录已失效，请重新登录；本机资料保持不变',401);
  }
  /** A reviewed manual archive action; exactly one HTTP request, no 401 PUT replay. */
  async manualBackupRequest(method:'GET'|'PUT',document?:unknown,revision?:number,signal?:AbortSignal):Promise<unknown>{
    if(!this.testOnly)throw new Error('手动备份要求自动同步保持关闭');
    if(method!=='GET'&&method!=='PUT')throw new Error('备份仅允许读取或明确上传');
    if(method==='GET'&&(document!==undefined||revision!==undefined))throw new Error('备份读取不能携带上传内容');
    if(method==='PUT'&&(document===undefined||!Number.isSafeInteger(revision)||revision===undefined||revision<0))throw new Error('备份上传缺少有效版本');
    if(method==='PUT'){assertPortableBackupTree(document);assertHostedBackupFits(document);}
    const body=method==='PUT'?JSON.stringify({document}):undefined;
    if(body)requireTransportJsonBytes(body);
    if(!this.session)throw new CloudHttpError('请先登录，资料保持本机',401);
    const generation=this.generation,owner=this.session.owner,token=this.session.accessToken;
    const headers:Record<string,string>={Accept:'application/json',Authorization:`Bearer ${token}`};
    if(body){headers['Content-Type']='application/json';headers['If-Match']=String(revision);}
    const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,30000);
    signal?.addEventListener('abort',stop,{once:true});
    try{
      if(signal?.aborted)throw new Error('备份请求已取消');
      const response=await this.http(mobileServiceBase(this.config.api)+'/api/mobile-document',{method,headers,body,signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(controller.signal.aborted||this.generation!==generation||this.session?.owner!==owner)throw new Error('账号已变化或操作取消，备份响应未采用');
      if(!response.ok){await response.body?.cancel();throw new CloudHttpError(response.status===409?'其他设备已更新云备份，请重新读取确认':response.status===413?MANUAL_BACKUP_CAPACITY_MESSAGE:response.status===404||response.status===503?'完整备份服务尚未开放；本机资料保持原值':`完整备份未完成（${response.status}）；本机资料保持原值`,response.status);}
      let bytes:Uint8Array;
      try{bytes=await readBoundedResponse(response,4_000_000,controller.signal);}catch(error){if(controller.signal.aborted)throw new Error('云备份读取已取消，结果尚未确认');if(error instanceof Error&&error.message==='服务响应超出容量保护')throw new CloudHttpError(MANUAL_BACKUP_CAPACITY_MESSAGE,413);throw new Error('云备份响应未完整读取，结果尚未确认；请重新读取核对');}
      if(controller.signal.aborted||this.generation!==generation||this.session?.owner!==owner)throw new Error('账号已变化或操作取消，备份响应未采用');
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('云备份响应格式无法核对；本机资料保留');}
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
  }
  /** Explicit score-only transfer. Kept separate from the disabled whole-archive sync. */
  async scoreBackupRequest(method:'GET'|'PUT',document?:ScoreBackupDocument,revision?:number):Promise<ScoreBackupResponse>{
    if(method!=='GET'&&method!=='PUT')throw new Error('成绩备份只允许读取或明确上传');
    if(method==='GET'&&(document!==undefined||revision!==undefined))throw new Error('读取成绩备份不应包含上传内容');
    if(method==='PUT'){
      if(document===undefined||!Number.isSafeInteger(revision)||revision===undefined||revision<0)throw new Error('上传成绩备份缺少有效云端版本');
      validateScoreBackupDocument(document);
    }
    const body=method==='PUT'?JSON.stringify({document}):undefined;
    if(body&&new TextEncoder().encode(body).length>SCORE_BACKUP_MAX_BYTES+32)throw new Error('成绩备份超过 2 MiB，未上传');
    if(!this.session)throw new CloudHttpError('请先登录；本机成绩保持不变',401);
    if(this.session.expiresAt<Date.now()+60000)await this.refresh();
    const generation=this.generation,owner=this.session!.owner;
    for(let attempt=0;attempt<2;attempt++){
      const token=this.session?.accessToken;if(!token)throw new CloudHttpError('登录已失效；本机成绩保持不变',401);
      const headers:Record<string,string>={Accept:'application/json',Authorization:`Bearer ${token}`};
      if(body!==undefined){headers['Content-Type']='application/json';headers['If-Match']=String(revision);}
      const response=await this.http(mobileServiceBase(this.config.api)+'/api/score-backup',{method,headers,body,signal:timeoutSignal(30000)});
      if(generation!==this.generation||this.session?.owner!==owner)throw new Error('账号已切换，旧成绩响应已丢弃');
      if(response.status===401&&attempt===0){await this.refresh();continue;}
      if(!response.ok){
        let detail='';try{const result=await response.json();if(typeof result.detail==='string')detail='：'+result.detail.slice(0,180);}catch{/* Keep the status when an upstream proxy does not return JSON. */}
        const message=response.status===409?'云端成绩已由其他设备更新，请重新读取后核对；本机成绩未改变'
          :response.status===503?'成绩备份服务尚未开放或暂时不可用；本机成绩保持不变'
          :response.status===404?'成绩备份接口尚未部署；本机成绩保持不变'
          :`成绩备份未完成（${response.status}）${detail}；本机成绩保持不变`;
        throw new CloudHttpError(message,response.status);
      }
      return parseScoreBackupResponse(await response.json());
    }
    throw new CloudHttpError('登录已失效，请重新登录；本机成绩保持不变',401);
  }
}
export class ExistingApiClient {
  private accessToken:string|null=null;
  private generation=0;
  owner:string|null=null;
  constructor(readonly base:string,readonly authBase:string,readonly publicKey:string){
    for(const value of [base,authBase].filter(Boolean)){const url=new URL(value);if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw new Error('服务地址须为 HTTPS，不含密码、查询参数或片段');}
  }
  async login(email:string,password:string){const generation=++this.generation;const response=await transport(`${this.authBase.replace(/\/$/,'')}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'Content-Type':'application/json',apikey:this.publicKey},body:JSON.stringify({email,password}),signal:timeoutSignal(15000)});if(!response.ok)throw new Error(`登录失败（${response.status}），请核对账号与服务配置`);const result=await response.json();if(typeof result.access_token!=='string')throw new Error('登录响应缺少令牌');const check=await transport(`${this.authBase.replace(/\/$/,'')}/auth/v1/user`,{headers:{apikey:this.publicKey,Authorization:`Bearer ${result.access_token}`},signal:timeoutSignal(15000)});if(!check.ok)throw new Error('账户身份校验失败');const user=await check.json();if(!user.id)throw new Error('账户身份缺失');if(generation!==this.generation)throw new Error('账号操作已取消，旧响应已丢弃');this.accessToken=result.access_token;this.owner=user.id;return {id:user.id,email:user.email};}
  logout(){this.generation++;this.accessToken=null;this.owner=null;}
  async request<T>(path:string,method='GET',body?:unknown,revision?:number):Promise<T>{const generation=this.generation;if(!path.startsWith('/')||path.includes('..'))throw new Error('接口路径无效');const headers:Record<string,string>={Accept:'application/json'};if(this.accessToken)headers.Authorization=`Bearer ${this.accessToken}`;if(body!==undefined)headers['Content-Type']='application/json';if(revision!==undefined)headers['If-Match']=String(revision);const response=await transport(this.base.replace(/\/$/,'')+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(15000)});if(!response.ok){if(response.status===409)throw new Error('云端版本已变化，本机内容未覆盖，请重新读取并核对');if(response.status===401||response.status===403)throw new Error('请先登录对应账户；本机训练不受影响');throw new Error(`接口请求失败（${response.status}），未使用模拟数据`);}const result=await response.json();if(generation!==this.generation)throw new Error('账户已退出或切换，旧响应已丢弃');return result;}
  targets(){return this.request<unknown[]>('/targets');}
  plans(){return this.request<Record<string,unknown>[]>('/training-plans');}
  history(){return this.request<Record<string,unknown>[]>('/history');}
  detail(id:string){return this.request<Record<string,unknown>>(`/history/sessions/${encodeURIComponent(id)}`);}
  exportHistory(){return this.request<unknown>('/history/export.json');}
  /** Retained interface boundary. Full mobile structures require an approved API extension. */
  capabilities(){return {readPlans:true,readHistory:true,mobileDocumentSync:false,reason:'自由训练、器材快照、目标与日历尚无无损云端合同'};}
}
