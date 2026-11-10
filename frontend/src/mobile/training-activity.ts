import {allArrows,localDate,type Session} from './domain';

/** Twelve calendar weeks, ending in the current week. Future cells have no value. */
export function trainingActivity(sessions:Session[],today=localDate()){
 const date=new Date(`${today}T12:00:00`),start=new Date(date);
 start.setDate(start.getDate()-((start.getDay()+6)%7)-77);
 const grouped=new Map<string,Session[]>();
 for(const session of sessions){if(session.status!=='completed'||session.date>today)continue;const list=grouped.get(session.date)??[];list.push(session);grouped.set(session.date,list);}
 return Array.from({length:84},(_,index)=>{const day=new Date(start);day.setDate(start.getDate()+index);const key=localDate(day),records=grouped.get(key)??[];return {date:key,future:key>today,arrows:records.reduce((n,s)=>n+allArrows(s).length,0),sessions:records};});
}
export function activityLevel(arrows:number){return arrows<=0?0:arrows<30?1:arrows<60?2:arrows<120?3:4;}
