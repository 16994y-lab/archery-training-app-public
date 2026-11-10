/** A receipt lives only in the device's private store, separately from cloud tokens. */
export type LocalIdentity={version:1;owner:string;service:string;verifiedAt:number;state:'active'|'signed-out'|'revoked'};
export function parseLocalIdentity(raw:string|null):LocalIdentity|null{
  if(raw===null)return null;
  const v=JSON.parse(raw) as LocalIdentity;
  if(!v||Object.keys(v).sort().join()!=='owner,service,state,verifiedAt,version'||v.version!==1
    ||typeof v.owner!=='string'||!v.owner||v.owner.length>128||typeof v.service!=='string'||!v.service
    ||!Number.isFinite(v.verifiedAt)||v.verifiedAt<0||(v.state==='active'&&v.verifiedAt===0)||!['active','signed-out','revoked'].includes(v.state))
    throw new Error('本机身份凭据无法核对，请联网登录原账号；原资料保留');
  return v;
}
