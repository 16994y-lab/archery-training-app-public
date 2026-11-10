import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,Input,ConfigProvider} from 'antd-mobile';
import zhCN from 'antd-mobile/es/locales/zh-CN';
import {CloudApiClient,CloudHttpError,type AuthSession} from './mobile/api';
import {isAuthReturn,parseEmailReturn,type EmailReturn} from './auth-return';
import publicConfig from '../mobile-public-config.json';
import './account-recovery.css';
const logo=new URL('../public/ui/logo-mark.png',import.meta.url).href;

// Capture and remove credentials before any authentication request or rendering.
let returned:EmailReturn|null=null,initialError='';
try{returned=parseEmailReturn(window.location.hash,window.location.search);}catch(error){initialError=(error as Error).message;}
window.history.replaceState(null,'',window.location.pathname);
const temporaryClient=new CloudApiClient(publicConfig,async()=>{});
let replacingCallback=false;
// A second email opened in this same tab must never reuse the previous form or identity.
window.addEventListener('hashchange',()=>{if(isAuthReturn(window.location.hash,window.location.search)){replacingCallback=true;temporaryClient.discardTemporarySession();window.location.reload();}});

export function RecoveryPage({callback,error,client}:{callback:EmailReturn|null;error:string;client:CloudApiClient}){
  const [phase,setPhase]=useState<'checking'|'form'|'done'|'confirmed'|'error'>(callback?'checking':'error');
  const [message,setMessage]=useState(error),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false);
  const flight=useRef(false),started=useRef<Promise<Pick<AuthSession,'email'>>|null>(null);
  useEffect(()=>{let active=true;if(!callback)return;started.current??=client.acceptEmailReturn(callback).then(session=>({email:session.email})).finally(()=>{callback.access_token='';callback.refresh_token='';returned=null;});started.current.then(session=>{if(!active)return;setEmail(session.email);setPhase(callback.type==='recovery'?'form':'confirmed');if(callback.type==='signup')client.discardTemporarySession();}).catch(()=>{if(active){client.discardTemporarySession();setMessage('邮箱验证未完成。链接可能已失效，或当前无法连接账号服务，请重新打开最新邮件后再试。');setPhase('error');}});return()=>{active=false;};},[callback,client]);
  useEffect(()=>{const forget=()=>{client.discardTemporarySession();setPassword('');setConfirmation('');setMessage('重置页面已关闭，请重新打开最新邮件中的链接。');setPhase('error');};window.addEventListener('pagehide',forget);return()=>window.removeEventListener('pagehide',forget);},[client]);
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();if(flight.current||replacingCallback)return;
    if(password.length<8){setMessage('新密码至少需要 8 个字符。');return;}
    if(password!==confirmation){setMessage('两次输入的密码不一致。');return;}
    flight.current=true;setBusy(true);setMessage('');const secret=password;setPassword('');setConfirmation('');
    try{await client.updatePassword(secret);client.discardTemporarySession();setPhase('done');}
    catch(error){setMessage(error instanceof CloudHttpError&&error.status===429?'操作过于频繁，请稍后再试。':error instanceof CloudHttpError&&[400,401,403].includes(error.status)?'密码未能更新。请使用符合账号要求的新密码，或重新发送找回邮件。':'连接未完成，暂时无法确认密码是否更新。请尝试用新密码登录，或重新发送找回邮件。');}
    finally{flight.current=false;setBusy(false);}
  };
  const leave=()=>{client.discardTemporarySession();window.location.replace('/next/#/account');};
  return <ConfigProvider locale={zhCN}><main className="recovery-page"><header><img src={logo} alt="弓行记图标"/><span>弓行记</span></header><section className="recovery-card" aria-labelledby="recovery-title"><p className="recovery-eyebrow">账号与数据安全</p><h1 id="recovery-title">{phase==='confirmed'?'邮箱确认完成':phase==='done'?'密码已重置':'重置密码'}</h1>
    {phase==='checking'&&<p role="status">正在验证邮件链接…</p>}
    {phase==='form'&&<><p>为 <strong>{email||'此邮箱账号'}</strong> 设置新密码。</p><form onSubmit={submit}><label htmlFor="recovery-password">新密码</label><Input id="recovery-password" aria-label="新密码" type="password" autoComplete="new-password" value={password} onChange={setPassword} disabled={busy} placeholder="至少 8 个字符"/><label htmlFor="recovery-confirmation">再次输入新密码</label><Input id="recovery-confirmation" aria-label="再次输入新密码" type="password" autoComplete="new-password" value={confirmation} onChange={setConfirmation} disabled={busy}/>{message&&<p role="alert" className="recovery-error">{message}</p>}<Button block color="primary" type="submit" loading={busy} disabled={busy}>保存新密码</Button></form><p className="recovery-note">此页面只处理账号密码。不会绑定、上传或改写这台设备上的训练资料。刷新页面后需重新打开邮件链接。</p><Button block fill="none" disabled={busy} onClick={leave}>取消并返回登录</Button></>}
    {phase==='error'&&<><p role="alert" className="recovery-error">{message}</p><p>请在登录页填写邮箱，重新发送找回邮件，再打开最新邮件中的链接。</p><Button block color="primary" onClick={leave}>返回登录页</Button></>}
    {(phase==='done'||phase==='confirmed')&&<><p role="status">{phase==='done'?'请回到 App 或网页版，使用新密码登录。':'邮箱已通过验证，请返回 App 或网页版登录。'}</p><p className="recovery-note">此页面没有登录训练应用，也没有上传本机资料。</p><Button block color="primary" onClick={leave}>返回登录页</Button></>}
  </section></main></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<RecoveryPage callback={returned} error={initialError} client={temporaryClient}/>);
