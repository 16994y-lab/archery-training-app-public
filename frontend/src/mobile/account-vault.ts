import {copy,initialData,LIMITS,type Data} from './domain';
import type {StorageAdapter} from './store';

type Vault={version:1;active:string;accounts:Record<string,Data>};
export interface VaultPersistence {
  read():Promise<string|null>;
  // expectedLegacy is checked in the same transaction as the first vault write.
  write(value:string,expected:string|null,expectedLegacy:string|null):Promise<void>;
}
export function createAccountStorage(legacy:StorageAdapter,disk:VaultPersistence,validate:(v:unknown)=>Data):StorageAdapter {
  let raw:string|null=null,legacyRaw:string|null=null,vault:Vault|null=null,loaded=false;
  const own=(v:Vault,key:string)=>Object.prototype.hasOwnProperty.call(v.accounts,key);
  function parse(text:string):Vault {
    const v=JSON.parse(text) as Vault;
    if(!v||v.version!==1||Object.keys(v).sort().join()!=='accounts,active,version'||typeof v.active!=='string'||!v.accounts||Array.isArray(v.accounts)||!own(v,v.active))throw new Error('本机账号资料无法核对，所有原件保留，请勿卸载');
    for(const [key,data] of Object.entries(v.accounts)){if(!key||key.length>2048)throw new Error('本机账号归属无效');validate(data);}
    return v;
  }
  async function commit(next:Vault){
    const text=JSON.stringify(next);
    if(new TextEncoder().encode(text).length>128*1024*1024)throw new Error('本机各账号资料达到容量保护，原资料保留，请先分别导出备份');
    await disk.write(text,raw,legacyRaw);raw=text;vault=next;
  }
  return {
    accountKey:()=>vault?.active??null,
    async read(){raw=await disk.read();vault=raw===null?null:parse(raw);legacyRaw=vault?null:await legacy.read();loaded=true;return vault?JSON.stringify(vault.accounts[vault.active]):legacyRaw;},
    async write(text,expected){
      if(!loaded)throw new Error('须先读取本机资料');
      if(!vault){await legacy.write(text,expected);legacyRaw=text;return;}
      const data=validate(JSON.parse(text)),current=vault.accounts[vault.active];
      if(data.revision===current.revision&&text===JSON.stringify(current))return;
      if(current.revision!==expected||data.revision!==expected+1)throw new Error('本机账号或记录已变化，请重新打开');
      const next=copy(vault);next.accounts[next.active]=data;await commit(next);
    },
    async selectAccount(key,legacyOwner,current){
      if(!loaded||!key||key.length>2048)throw new Error('账号资料尚未安全打开');
      if(new TextEncoder().encode(JSON.stringify(current)).length>LIMITS.bytes)throw new Error('当前账号资料超过容量保护');
      validate(current);
      if(vault?.active===key)return copy(vault.accounts[key]);
      const next:Vault=vault?copy(vault):{version:1,active:key,accounts:{}};
      if(!vault){
        if(!legacyOwner&&legacyRaw!==null&&JSON.stringify(current)!==JSON.stringify(initialData()))throw new Error('旧资料所属账号尚未核对，原件保留，请先恢复原账号');
        if(legacyOwner)Object.defineProperty(next.accounts,legacyOwner,{value:copy(current),enumerable:true,writable:true,configurable:true});
      }
      if(!own(next,key)){const fresh=initialData();fresh.connection=copy(current.connection);Object.defineProperty(next.accounts,key,{value:fresh,enumerable:true,writable:true,configurable:true});}
      next.active=key;await commit(next);return copy(next.accounts[key]);
    }
  };
}
