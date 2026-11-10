/** Same portable-tree exclusions as the existing mobile_documents server. */
const forbidden=new Set('password passwd secret accesstoken refreshtoken authorization apikey publickey servicerole privatekey connection email phone phonenumber photo photos image images video videos base64 blob dataurl mediabytes __proto__ constructor prototype'.split(' '));
export function assertPortableBackupTree(value:unknown){
  function walk(v:unknown,depth=0){
    if(depth>24)throw new Error('备份层级过深，未发送');
    if(Array.isArray(v)){if(v.length>30000)throw new Error('备份列表超过容量');v.forEach(x=>walk(x,depth+1));}
    else if(v&&typeof v==='object'){const entries=Object.entries(v);if(entries.length>100)throw new Error('备份字段过多');for(const [key,child]of entries){if(forbidden.has(key.toLowerCase())||forbidden.has(key.toLowerCase().replace(/[-_]/g,'')))throw new Error('备份含媒体或账号凭据字段，未发送');walk(child,depth+1);}}
    else if(typeof v==='string'){if(v.length>10000||/^(data:|file:|content:)/i.test(v))throw new Error('备份含媒体内容或过长文本');}
    else if(v!==null&&typeof v!=='boolean'&&(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e15))throw new Error('备份含无效值');
  }
  walk(value);
}
