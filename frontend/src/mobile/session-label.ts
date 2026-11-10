import type {Session} from './domain';

const pad=(n:number)=>String(n).padStart(2,'0');
/** Render the saved start time, never invent a time for historical records. */
export function sessionTimeLabel(session:Pick<Session,'date'|'started'>){
 const stamp=new Date(session.started);
 return Number.isNaN(stamp.getTime())?session.date:`${pad(stamp.getMonth()+1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
}
export function nextUnnamedSessionName(sessions:Pick<Session,'name'>[]){
 const occupied=new Set(sessions.map(s=>s.name));let next=1;
 for(const name of occupied){const match=/^未命名([1-9]\d{0,8})$/.exec(name);if(match)next=Math.max(next,Number(match[1])+1);}
 while(occupied.has(`未命名${next}`))next++;
 return `未命名${next}`;
}
