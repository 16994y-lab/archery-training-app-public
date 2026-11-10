import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {CloudPanel} from './Cloud';
import {DesktopLoginLayout} from './DesktopLoginLayout';
import {AccountDeletionEntry} from './AccountDeletion';
import {AccountDeletionLink} from './AccountOverview';
import {accountDeletionReady} from './release-mode';
import {chooseLoginDestination,loginDestination,loginLanding,workspacePath} from './login-destination';
import {cloudSync} from './cloud-sync';
import {isReviewRoute} from './review-navigation';
import {rememberTeamInvitation,teamInvitationRoute} from './team-invitation';
import {repository} from './store';
import {Button,Panel,useApp,useInnerBack} from './ui';
import {News} from './News';
import {IntroScreens} from './IntroScreens';
import {BrandLoading} from './BrandLoading';
import {hasPendingRegistrationIntro,registrationIntroPersistence,registrationIntroStage,advanceRegistrationIntro,finishRegistrationIntro} from './intro-preference';
import {PasswordField} from './PasswordField';
import {PASSWORD_RULE,requireNewPassword} from './password-policy';
import './account-access.css';
const brandLogo=new URL('../../public/ui/logo-mark.png',import.meta.url).href;

/** This gate only verifies identity. Training remains in the existing local store. */
export function StartupAccount({children}:{children:React.ReactNode}){
  const {update}=useApp(),navigate=useNavigate(),location=useLocation();
  const nativeApp=typeof window!=='undefined'&&!!window.Gongxingji;
  const [destination,setDestination]=useState(loginDestination);
  const chooseDestination=(value:'user'|'coach')=>{chooseLoginDestination(value);setDestination(value);};
  if(location.pathname==='/team')rememberTeamInvitation(location.search);
  const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
  useEffect(()=>{setDestination(loginDestination());},[status.owner,location.pathname]);
  const [,refreshIntro]=useState(0),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[passwordBusy,setPasswordBusy]=useState(false),[passwordError,setPasswordError]=useState(''),[settingPassword,setSettingPassword]=useState(false);
  const passwordFlight=useRef(false),passwordForm=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(settingPassword)passwordForm.current?.querySelector<HTMLInputElement>('input')?.focus();},[settingPassword]);
  const finishIntro=()=>{if(status.owner)finishRegistrationIntro(status.owner);refreshIntro(v=>v+1);};
  useEffect(()=>{const changed=()=>refreshIntro(v=>v+1);window.addEventListener('gongxingji-registration-intro',changed);return()=>window.removeEventListener('gongxingji-registration-intro',changed);},[]);
  useEffect(()=>{setPassword('');setConfirm('');setPasswordError('');setSettingPassword(false);},[status.owner]);
  const skipPassword=()=>{setPassword('');setConfirm('');setPasswordError('');if(status.owner&&cloudSync.getStatus().owner===status.owner){advanceRegistrationIntro(status.owner);refreshIntro(v=>v+1);}};
  const savePassword=async()=>{if(passwordFlight.current)return;const owner=status.owner;passwordFlight.current=true;setPasswordBusy(true);setPasswordError('');try{requireNewPassword(password);if(password!==confirm)throw new Error('两次输入的密码不一致');if(!owner||cloudSync.getStatus().owner!==owner)throw new Error('账号已变化，请重新确认');const secret=password;setPassword('');setConfirm('');await cloudSync.updatePassword(secret);if(cloudSync.getStatus().owner===owner){advanceRegistrationIntro(owner);refreshIntro(v=>v+1);}}catch(e){if(alive.current&&cloudSync.getStatus().owner===owner)setPasswordError(e instanceof Error?e.message:'密码未能保存，可稍后设置');}finally{passwordFlight.current=false;setPasswordBusy(false);}};
  const [checking,setChecking]=useState(true),[checkCount,setCheckCount]=useState(0),[checkFailed,setCheckFailed]=useState(false),[error,setError]=useState('');
  const lastOwner=useRef<string|null>(null),renderedOwner=useRef<string|null>(null),resumeOwner=useRef<string|null>(null),pageRef=useRef<HTMLDivElement>(null),alive=useRef(true),checkPending=useRef(false),accountFormShown=useRef(false);
  const bootAccountKey=useRef(repository.accountKey()),acceptedOnce=useRef(false),loginPresented=useRef(false);
  async function check(){
    if(checkPending.current||cloudSync.getStatus().busy)return;
    const current=cloudSync.getStatus();
    resumeOwner.current=!checkFailed&&current.owner&&current.authVerified&&current.phoneVerified===true&&renderedOwner.current===current.owner&&!hasPendingRegistrationIntro(current.owner)?current.owner:null;
    checkPending.current=true;
    setChecking(true);setCheckFailed(false);setError('');
    let checkedOwner=cloudSync.getStatus().owner;
    try{
      await cloudSync.initialize({read:()=>repository.data,update,pending:()=>!!repository.pending});
      checkedOwner=cloudSync.getStatus().owner;
      if(checkedOwner&&navigator.onLine!==false&&!cloudSync.getStatus().reauthenticationRequired)await cloudSync.verifySession();
    }catch(e){resumeOwner.current=null;if(alive.current&&cloudSync.getStatus().owner===checkedOwner){
      setCheckFailed(true);
      const message=e instanceof Error?e.message:'登录状态未能确认，请重试';
      setError(/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(message)||/^云连接失败：(?:Unable to resolve host\b|(?:java\.net\.)?UnknownHostException\b|无法解析主机)/i.test(message)
        ?'暂时无法连接账号服务。已有训练保存在本机，请恢复网络后重新连接。':message);
    }}
    finally{checkPending.current=false;resumeOwner.current=null;if(alive.current){setCheckCount(count=>count+1);setChecking(false);}}
  }
  const checkRef=useRef(check);checkRef.current=check;
  useEffect(()=>{
    alive.current=true;void checkRef.current();
    // Returning from the SMS app must preserve an unfinished OTP form.
    const foreground=()=>document.visibilityState==='visible'&&navigator.onLine!==false;
    const resume=()=>{const current=cloudSync.getStatus();if(foreground()&&!cloudSync.otpSendInProgress()&&current.owner&&!current.reauthenticationRequired)void checkRef.current();};
    const refreshDue=()=>{if(foreground()&&!cloudSync.otpSendInProgress()&&cloudSync.sessionRefreshDue())void checkRef.current();};
    window.addEventListener('online',resume);window.addEventListener('gongxingji-foreground',resume);document.addEventListener('visibilitychange',resume);
    const refreshTimer=window.setInterval(refreshDue,30000);
    return()=>{alive.current=false;window.clearInterval(refreshTimer);window.removeEventListener('online',resume);window.removeEventListener('gongxingji-foreground',resume);document.removeEventListener('visibilitychange',resume);};
  },[update]);
  useEffect(()=>{setError('');setCheckFailed(false);},[status.owner]);
  // Every completion changes state even if React batches checking true/false.
  // This commits the cleared request guard after synchronous external-store updates.
  const hasChecked=checkCount>0,verifying=checking||checkPending.current;
  const unifiedLogin=!nativeApp&&!status.authVerified&&status.reauthenticationRequired===true;
  const allowed=status.localAllowed===true&&!unifiedLogin;
  // Keep the explicit account page reachable while its saved session needs verification.
  const awaitingAccountVerification=location.pathname==='/account'&&status.authVerified!==true;
  if(allowed)renderedOwner.current=status.owner;
  if(renderedOwner.current!==status.owner)renderedOwner.current=null;
  useEffect(()=>{
    if(unifiedLogin){lastOwner.current=null;if(location.pathname!=='/')navigate('/',{replace:true});return;}
    if(allowed&&!awaitingAccountVerification&&status.owner&&status.owner!==lastOwner.current){
      // A restored, already-selected account may keep its review or workspace deep link.
      // This preserves navigation only; workspace permissions are freshly checked by /me.
      // Explicit login, registration and every later account transition still reset.
      const preserveDestination=!acceptedOnce.current&&!loginPresented.current&&!!bootAccountKey.current&&bootAccountKey.current===repository.accountKey()&&!hasPendingRegistrationIntro(status.owner)&&(isReviewRoute(location.pathname.slice(1))||!nativeApp&&workspacePath(location.pathname));
      acceptedOnce.current=true;lastOwner.current=status.owner;
      if(!preserveDestination)navigate(loginLanding(teamInvitationRoute()||'/training'),{replace:true});
    }
    if(!status.owner&&lastOwner.current){lastOwner.current=null;navigate(nativeApp?'/account':'/',{replace:true});}
  },[allowed,awaitingAccountVerification,unifiedLogin,nativeApp,status.owner,navigate,location.pathname]);
  const offerPassword=registrationIntroStage(status.owner)==='password';
  const registrationWelcome=allowed&&hasPendingRegistrationIntro(status.owner)&&(!offerPassword||status.authVerified);
  const keepingPage=false;
  const publicNews=!allowed&&!keepingPage&&!registrationWelcome&&location.pathname==='/news';
  useInnerBack(publicNews,()=>navigate(new URLSearchParams(location.search).has('id')?'/news':'/account',{replace:true}),20);
  // A signed-in email account can manage itself before binding a phone.
  const canManagePending=accountDeletionReady&&!!status.owner&&status.authVerified&&!status.phoneVerified&&!allowed;
  const pendingSection=canManagePending&&location.pathname==='/account'?new URLSearchParams(location.search).get('id'):null;
  const pendingManagement=pendingSection==='management'||pendingSection==='deletion';
  const pendingBack=()=>navigate(pendingSection==='deletion'?'/account?id=management':'/account',{replace:true});
  useInnerBack(pendingManagement,pendingBack,20);
  const showPage=(allowed&&!registrationWelcome)||keepingPage;
  useEffect(()=>{if(pageRef.current)pageRef.current.inert=keepingPage;},[keepingPage]);
  const introStorageNotice=registrationIntroPersistence(status.owner)===false?'介绍偏好暂未存入本机，重开可能再次提示。可以继续训练。':'';
  const showIntro=registrationWelcome&&!offerPassword;
  useEffect(()=>{if(allowed&&!awaitingAccountVerification&&!registrationWelcome&&loginDestination()==='coach'&&!workspacePath(location.pathname))navigate('/coach',{replace:true});},[allowed,awaitingAccountVerification,registrationWelcome,location.pathname,navigate]);
  // Keep an existing auth form mounted while rechecking the same identity.
  const showAccountForm=!showIntro&&!allowed&&hasChecked&&(!verifying||accountFormShown.current);
  accountFormShown.current=showAccountForm;
  if(showAccountForm)loginPresented.current=true;
  if(pendingManagement)return <main className="startup-account account-access">
    <Button className="account-back-link" onClick={pendingBack}>‹ {pendingSection==='deletion'?'返回账号管理':'返回验证手机'}</Button>
    {pendingSection==='deletion'?<AccountDeletionEntry key={status.owner}/>:<Panel title="账号管理"><AccountDeletionLink onClick={()=>navigate('/account?id=deletion')}/></Panel>}
  </main>;
  if(!allowed&&!registrationWelcome&&!publicNews&&!showAccountForm&&verifying)return <BrandLoading/>;
  if(publicNews)return <main className="startup-account startup-public-news"><Button onClick={()=>navigate('/account',{replace:true})}>返回登录</Button><News/></main>;
  return <><div ref={pageRef} className={keepingPage?'startup-resume-page':undefined} hidden={!showPage} aria-hidden={!showPage} aria-busy={keepingPage} onClickCapture={event=>{if(keepingPage){event.preventDefault();event.stopPropagation();}}} onKeyDownCapture={event=>{if(keepingPage){event.preventDefault();event.stopPropagation();}}}>
    {allowed&&!registrationWelcome&&introStorageNotice&&<p role="status" className="account-preference-warning">{introStorageNotice}</p>}
    {renderedOwner.current&&!registrationWelcome?<React.Fragment key={renderedOwner.current}>{children}</React.Fragment>:null}
  </div>{keepingPage&&<p className="startup-resume-status" role="status" aria-live="polite">正在连接…</p>}{(!allowed||registrationWelcome)&&!keepingPage&&<main className={showIntro?'startup-intro':'startup-account'} aria-busy={verifying}>
    {showIntro?<IntroScreens onDone={finishIntro} onSkip={finishIntro} onExistingAccount={finishIntro} context="registered" notice={introStorageNotice}/>:registrationWelcome?<>
    <header className="page-title"><img className="auth-brand-logo" src={brandLogo} alt="" width="72" height="72"/><h1>注册已完成</h1><p>现在可以开始记录训练</p></header>
    {introStorageNotice&&<p role="status" className="account-preference-warning">{introStorageNotice}</p>}<Panel className="account-access account-card" title="设置登录密码（可选）"><p>以后可用手机号或已绑定邮箱和密码登录，也可继续使用短信验证码。</p>
     {passwordError&&<p role="alert" className="account-error">{passwordError}。已验证账号保留，可稍后设置。</p>}
     {settingPassword?<form ref={passwordForm} onSubmit={event=>{event.preventDefault();void savePassword();}}><p className="caption">{PASSWORD_RULE}</p><PasswordField label="登录密码" value={password} onChange={setPassword} disabled={passwordBusy} autoComplete="new-password"/><PasswordField label="再次输入密码" value={confirm} onChange={setConfirm} disabled={passwordBusy} autoComplete="new-password"/><Button kind="primary" className="wide" type="submit" disabled={passwordBusy||!password||!confirm}>保存密码</Button></form>:<Button kind="primary" className="wide" onClick={()=>setSettingPassword(true)}>立即设置</Button>}<Button className="wide" disabled={passwordBusy} onClick={skipPassword}>稍后再说</Button>
    </Panel>
    </>:<>
    <DesktopLoginLayout destination={destination} onDestination={chooseDestination}>
    <div style={{position:'relative'}}>
      {showAccountForm&&<fieldset disabled={verifying} style={{border:0,margin:0,padding:0,minWidth:0}}>
        {error&&!status.reauthenticationRequired&&<Panel title="登录状态尚未确认"><p role="alert">{error}</p><Button disabled={status.busy} onClick={()=>void check()}>重新连接</Button></Panel>}
        <CloudPanel key={status.owner??'signed-out'} startup/>
        {canManagePending&&<Button className="account-text-link" onClick={()=>navigate('/account?id=management')}>账号管理</Button>}
      </fieldset>}
      {verifying&&<div className={`startup-opening${showAccountForm?' startup-opening-overlay':''}`}>
        <p role="status" aria-live="polite"><span className="startup-opening-dot" aria-hidden="true"/>正在打开…</p>
      </div>}
    </div>
    </DesktopLoginLayout></>}
  </main>}</>;
}
