/** Hosted JSON packets are capped independently of the 24 MiB local file format. */
export const MANUAL_BACKUP_TRANSPORT_MAX_BYTES=4_000_000;
export const MANUAL_BACKUP_CAPACITY_MESSAGE='在线备份完整 JSON 超过 4,000,000 字节；请保留本机资料并导出备份文件';
export function transportJsonBytes(text:string):number{return new TextEncoder().encode(text).length;}
export function requireTransportJsonBytes(text:string):void{
  if(transportJsonBytes(text)>MANUAL_BACKUP_TRANSPORT_MAX_BYTES)throw Object.assign(new Error(MANUAL_BACKUP_CAPACITY_MESSAGE),{status:413});
}
/** Reserve the full success envelope, including the longest supported version and timestamp. */
export function assertHostedBackupFits(document:unknown):void{
  requireTransportJsonBytes(JSON.stringify({document}));
  requireTransportJsonBytes(JSON.stringify({revision:Number.MAX_SAFE_INTEGER,document,updatedAt:'9999-12-31T23:59:59.999999+00:00'}));
}
