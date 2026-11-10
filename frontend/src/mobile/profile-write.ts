import type {Data} from './domain';

export type ProfileIdentity={owner:string|null;authVerified:boolean;phoneVerified?:boolean;localAllowed?:boolean};
/** Local access is issued by the existing verified-device identity and account-partition guard. */
export function localProfileOwner(identity:ProfileIdentity){
  return identity.phoneVerified===true&&(identity.authVerified||identity.localAllowed===true)?identity.owner:null;
}
/** Recheck the originating account when the actual repository callback runs. */
export function profileChangeForOwner(owner:string|null,current:()=>ProfileIdentity,change:(data:Data)=>void){
  return (data:Data)=>{
    const identity=current();
    if(!owner||localProfileOwner(identity)!==owner)throw new Error('账号已变化，请重新打开个人资料');
    change(data);
  };
}

/** A failed first save keeps the same generated name available for explicit retry. */
export async function saveDefaultProfileName(owner:string,name:string,update:(change:(data:Data)=>void)=>Promise<boolean>,current:()=>ProfileIdentity){
  const saved=await update(profileChangeForOwner(owner,current,data=>{if(!data.profile.name.trim())data.profile.name=name;}));
  return saved&&localProfileOwner(current())===owner;
}
