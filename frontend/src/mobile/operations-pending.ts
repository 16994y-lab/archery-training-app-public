// A short IDB readwrite transaction coordinates synchronous localStorage changes
// across cooperating tabs. It stores no account data and never holds a network call.
export function withOperationsPendingLock<T>(key:string,current:()=>boolean,action:()=>T):Promise<T>{
 return new Promise((resolve,reject)=>{
  let db:IDBDatabase|undefined,tx:IDBTransaction|undefined,settled=false,value:T;
  const deadline=performance.now()+5000;
  const allowed=()=>!settled&&performance.now()<deadline&&current();
  const close=()=>{try{db?.close();}catch{}};
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);try{tx?.abort();}catch{}close();reject(new Error('pending coordination unavailable'));};
  const timer=setTimeout(fail,5000);
  try{
   if(!allowed())return fail();
   const open=indexedDB.open('gongxingji-operations-coordinate-v1',1);
   open.onerror=open.onblocked=fail;
   open.onupgradeneeded=()=>{if(!allowed()){try{open.transaction?.abort();}catch{}return fail();}try{open.result.createObjectStore('scopes');}catch{fail();}};
   open.onsuccess=()=>{
    if(settled){try{open.result.close();}catch{}return;}
    db=open.result;db.onversionchange=fail;
    if(!allowed())return fail();
    try{
     tx=db.transaction('scopes','readwrite');
     tx.onerror=tx.onabort=fail;
     tx.oncomplete=()=>{if(settled)return;if(!allowed())return fail();settled=true;clearTimeout(timer);close();resolve(value);};
     const read=tx.objectStore('scopes').get(key);
     read.onerror=fail;
     read.onsuccess=()=>{if(settled)return;if(!allowed())return fail();try{value=action();if(value&&typeof(value as {then?:unknown}).then==='function')fail();}catch{fail();}};
    }catch{fail();}
   };
  }catch{fail();}
 });
}
