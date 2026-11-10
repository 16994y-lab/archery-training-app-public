import { useState, useCallback } from 'react';

const prefix='gongxingji.review.v2.';
// Called only after the existing account partition switch succeeds. No training data lives here.
export function clearReviewViewState(){
  try {const keys:string[]=[];for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key?.startsWith(prefix))keys.push(key);}keys.forEach(key=>sessionStorage.removeItem(key));} catch { /* Unavailable session storage must not block local training. */ }
}

// View preferences only. Training documents remain in the repository, never here.
export function useReviewState<T>(key: string, initial: T): [T, (value: T | ((old: T) => T)) => void] {
  const storageKey = prefix + key;
  const [value,setValue] = useState<T>(() => { try { const saved = sessionStorage.getItem(storageKey); return saved === null ? initial : JSON.parse(saved) as T; } catch { return initial; } });
  const update = useCallback((next: T | ((old:T)=>T)) => setValue(old => {
    const resolved = typeof next === 'function' ? (next as (old:T)=>T)(old) : next;
    try { sessionStorage.setItem(storageKey,JSON.stringify(resolved)); } catch { /* Browsing still works when storage is unavailable. */ }
    return resolved;
  }),[storageKey]);
  return [value,update];
}
