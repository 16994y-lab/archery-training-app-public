import {unzipSync} from 'fflate/browser';

/** Admission for this backend's seekable ZIP_STORED profile, not a general ZIP decoder.
 * fflate performs extraction. The profile rejects unsupported/encrypted/ZIP64 archives
 * and compares both directory views before fflate allocates any entry output. */
export function parsePinnedStoredMediaZip(bytes:Uint8Array,expected:ReadonlyMap<string,number|null>,guard:()=>void):Map<string,Uint8Array>{
  const fail=()=>{throw new Error('媒体ZIP目录、条目或容量不符合原归档；未恢复');};
  guard();if(bytes.length<22||bytes.length>50*1024*1024||expected.size<2||expected.size>101)fail();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-22;
  const u16=(at:number)=>{if(at<0||at+2>bytes.length)fail();return view.getUint16(at,true);};
  const u32=(at:number)=>{if(at<0||at+4>bytes.length)fail();return view.getUint32(at,true);};
  if(u32(end)!==0x06054b50||u16(end+4)!==0||u16(end+6)!==0||u16(end+20)!==0||u16(end+8)!==expected.size||u16(end+10)!==expected.size)fail();
  const directory=u32(end+16),directoryBytes=u32(end+12);
  if(directory+directoryBytes!==end||directory>=end)fail();
  let cursor=directory,local=0,total=0;const seen=new Set<string>(),names=[...expected.keys()];
  for(let index=0;index<expected.size;index++){
    guard();if(cursor+46>end||u32(cursor)!==0x02014b50)fail();
    const version=u16(cursor+6),flags=u16(cursor+8),compression=u16(cursor+10),crc=u32(cursor+16),packed=u32(cursor+20),size=u32(cursor+24),length=u16(cursor+28);
    if(version>20||flags!==0||compression!==0||packed!==size||size===0xffffffff||u16(cursor+30)!==0||u16(cursor+32)!==0||u16(cursor+34)!==0||u32(cursor+42)!==local||length<1||length>64||cursor+46+length>end)fail();
    const nameBytes=bytes.subarray(cursor+46,cursor+46+length);if(nameBytes.some(b=>b<32||b>126))fail();
    const name=String.fromCharCode(...nameBytes),wanted=expected.get(name);
    if(!expected.has(name)||name!==names[index]||seen.has(name)||!/^manifest\.json$|^objects\/[a-f0-9]{32}$/.test(name))fail();
    if(size<1||size>(name==='manifest.json'?1024*1024:50*1024*1024)||(wanted!==null&&size!==wanted)||(total+=size)>100*1024*1024+1024*1024)fail();
    if(local+30+length+size>directory||u32(local)!==0x04034b50||u16(local+4)!==version||u16(local+6)!==flags||u16(local+8)!==compression||u32(local+14)!==crc||u32(local+18)!==size||u32(local+22)!==size||u16(local+26)!==length||u16(local+28)!==0)fail();
    for(let at=0;at<length;at++)if(bytes[local+30+at]!==nameBytes[at])fail();
    seen.add(name);local+=30+length+size;cursor+=46+length;
  }
  if(cursor!==end||local!==directory||seen.size!==expected.size)fail();
  guard();const extracted=unzipSync(bytes,{filter:entry=>{
    guard();const wanted=expected.get(entry.name);
    if(!expected.has(entry.name)||entry.compression!==0||entry.size!==entry.originalSize||entry.originalSize>(entry.name==='manifest.json'?1024*1024:50*1024*1024)||(wanted!==null&&wanted!==entry.originalSize))fail();
    return true;
  }});guard();
  const result=new Map<string,Uint8Array>();
  for(const name of names){const value=extracted[name];if(!(value instanceof Uint8Array)||value.length<1||(expected.get(name)!==null&&value.length!==expected.get(name)))fail();result.set(name,value);}
  if(Object.keys(extracted).length!==expected.size)fail();return result;
}