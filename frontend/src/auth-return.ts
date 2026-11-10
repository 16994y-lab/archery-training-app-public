/** Mail callbacks are handled before either training application mounts. */
export function isAuthReturn(hash:string,search:string){
  const fragment=new URLSearchParams(hash.replace(/^#/,''));
  const query=new URLSearchParams(search.replace(/^\?/,''));
  return [fragment,query].some(p=>['access_token','refresh_token','token_hash','code','error','error_code'].some(k=>p.has(k))||['recovery','signup'].includes(p.get('type')??''));
}
export function redirectAuthReturn(){
  if(!isAuthReturn(window.location.hash,window.location.search))return false;
  // Fixed same-origin destination; never follow a next/redirect_to from a callback.
  const query=new URLSearchParams(window.location.search.replace(/^\?/,''));
  const rejectedQuery=['access_token','refresh_token','token_hash','code','error','error_code'].some(k=>query.has(k));
  const fragment=rejectedQuery||window.location.hash.length+window.location.search.length>32768?'#error=invalid_callback':window.location.hash;
  // Never forward query credentials or arbitrary query parameters into another request.
  window.history.replaceState(null,'',window.location.pathname);
  window.location.replace('/auth/account-recovery.html'+fragment);
  return true;
}
export type EmailReturn={type:'recovery'|'signup';access_token:string;refresh_token:string;expires_in:number};
export function parseEmailReturn(hash:string,search:string,now=Date.now()):EmailReturn{
  if(hash.length+search.length>32768)throw new Error('验证链接不完整，请重新发送邮件。');
  const fragment=new URLSearchParams(hash.replace(/^#/,'')),query=new URLSearchParams(search.replace(/^\?/,''));
  // Query-string credentials would enter request logs; only accept implicit fragments.
  if(['access_token','refresh_token','token_hash','code'].some(k=>query.has(k)))throw new Error('此验证链接格式不受支持，请从弓行记重新发送邮件。');
  if([fragment,query].some(p=>p.has('error')||p.has('error_code')))throw new Error('验证链接已失效或无法使用，请重新发送邮件并打开最新一封。');
  for(const k of ['access_token','refresh_token','expires_in','expires_at','token_type','type'])if(fragment.getAll(k).length>1)throw new Error('验证链接包含重复信息，请重新发送邮件。');
  const type=fragment.get('type'),access=fragment.get('access_token'),refresh=fragment.get('refresh_token'),expires=Number(fragment.get('expires_in'));
  if((type!=='recovery'&&type!=='signup')||!access||!refresh||fragment.get('token_type')!=='bearer'||!Number.isFinite(expires)||expires<=0||expires>86400)throw new Error('没有取得有效的邮箱验证信息，请重新打开最新邮件中的链接。');
  if(fragment.has('expires_at')){const until=Number(fragment.get('expires_at'));if(!Number.isFinite(until)||until*1000<=now)throw new Error('验证链接已过期，请重新发送邮件。');}
  return {type,access_token:access,refresh_token:refresh,expires_in:expires};
}
