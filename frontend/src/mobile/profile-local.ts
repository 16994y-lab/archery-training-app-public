/** Display preferences for the personal training profile. */
import {nicknameValidationMessage} from './name-policy.mjs';

export function validNickname(value:string){
 const error=nicknameValidationMessage(value);
 if(error)throw new Error(error);
 return value.trim();
}
/** Fixed v1 derivation: display-only, not a unique account identifier. No storage or phone is read. */
export async function defaultNickname(owner:string){
 if(!owner||owner.length>128)throw new Error('请先确认当前账号');
 if(!globalThis.crypto?.subtle)throw new Error('暂时无法生成默认昵称，请手动填写');
 const bytes=new TextEncoder().encode('gongxingji-account-default-name/v1:'+owner);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 const suffix=new DataView(digest).getUint32(0,false)%10000;
 return '打弓人'+String(suffix).padStart(4,'0');
}

/** Uses the verified, masked display value from the current account only. */
export function nicknameFromVerifiedPhoneDisplay(display?:string):string|null{
 const suffix=/^1[3-9]\*{5}(\d{4})$/.exec(display??'')?.[1];
 return suffix?'打弓人'+suffix:null;
}

// New registrations use the verified phone suffix from this policy boundary
// (2026-11-03 17:34 China time). Never infer account age from this installation.
const phoneNameCutover=Date.parse('2026-11-03T09:34:00Z');
export function verifiedProfileDefault(createdAt:unknown,verifiedPhone:unknown,original?:string|null):string|null{
 if(typeof createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt))return null;
 const registered=Date.parse(createdAt);
 if(!Number.isFinite(registered))return null;
 if(registered<phoneNameCutover)return 'legacy';
 if(typeof verifiedPhone!=='string'||!/^\+?861[3-9]\d{9}$/.test(verifiedPhone))return null;
 if(original&&/^打弓人\d{4}$/.test(original))return original;
 return '打弓人'+verifiedPhone.slice(-4);
}

export function profileDefaultNickname(owner:string,verifiedName?:string|null):Promise<string>{
 // Sessions and fixtures from before this policy have the legacy name contract.
 if(verifiedName===undefined||verifiedName==='legacy')return defaultNickname(owner);
 if(owner&&verifiedName&&/^打弓人\d{4}$/.test(verifiedName))return Promise.resolve(verifiedName);
 return Promise.reject(new Error('默认用户名等待核对账号注册信息和已验证手机号，可稍后重试或自行填写。'));
}
