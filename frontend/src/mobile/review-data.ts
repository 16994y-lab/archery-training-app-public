import { allArrows, Data, Session, scoreValue, localDate } from './domain';
import { dateBucket, trend } from './statistics';

export type HistoryFilter = { from: string; to: string; distance: string; day: string; query: string; period: string };
export const emptyHistoryFilter: HistoryFilter = { from: '', to: '', distance: '', day: '', query: '', period: 'all' };
export function filterHistory(sessions: Session[], f: HistoryFilter) {
  const query = f.query.trim().toLocaleLowerCase();
  return sessions.filter(s => s.status === 'completed' && (!f.from || s.date >= f.from) && (!f.to || s.date <= f.to) && (!f.day || s.date === f.day) && (!f.distance || s.conditions.distance === Number(f.distance)) && (!query || [s.name,s.note,s.conditions.target.name,s.conditions.bow,s.conditions.equipment?.name??''].join(' ').toLocaleLowerCase().includes(query))).sort((a,b) => b.started.localeCompare(a.started));
}
export function presetRange(days: number, today = new Date()) {
  const start = new Date(today.getFullYear(),today.getMonth(),today.getDate());
  start.setDate(start.getDate() - days + 1);
  return { from: localDate(start), to: localDate(today), day: '', period: String(days) };
}
export function removeCompletedSession(data: Data, id: string) {
  const session = data.sessions.find(s => s.id === id);
  if (!session || session.status !== 'completed') throw new Error('只能删除已完成的历史记录，请刷新后重试。');
  data.sessions = data.sessions.filter(s => s.id !== id);
  data.schedules.forEach(s => { if (s.sessionId === id) s.sessionId = null; });
  if (data.activeId === id) data.activeId = null;
}
export function scoreExtremes(arrows: ReturnType<typeof allArrows>) {
  let max=-Infinity,min=Infinity,hits=0;
  for(const arrow of arrows){const value=scoreValue(arrow.code);max=Math.max(max,value);min=Math.min(min,value);if(arrow.code!=='M')hits++;}
  return { max: arrows.length ? max : null, min: arrows.length ? min : null, hit: arrows.length ? hits/arrows.length : null };
}
export function sourceSessions(sessions: Session[], grain: 'day'|'week'|'month'|'session', key: string) {
  return sessions.filter(s => (grain === 'session' ? s.id : dateBucket(s.date,grain)) === key);
}
export function reviewTrend(sessions: Session[], grain: 'day'|'week'|'month'|'session') {
  // IDs distinguish real sessions even when imported records share a timestamp.
  if(grain==='session')return [...sessions].sort((a,b)=>a.started.localeCompare(b.started)).map(s=>({...trend([s],'session')[0],key:s.id}));
  return trend(sessions,grain).map(p=>({...p,key:p.date}));
}
export function csvSession(s: Session) {
  const cell = (value: unknown) => '"' + String(value ?? '').replace(/"/g,'""') + '"';
  const lines = ['group,entry,score,face,x_radius,y_radius,source,group_note,arrow_note'];
  s.ends.forEach((end,i) => end.arrows.forEach((arrow,j) => lines.push([i+1,j+1,arrow.code,arrow.face,arrow.x,arrow.y,arrow.source,(end as typeof end & {note?:string}).note,(arrow as typeof arrow & {note?:string}).note].map(cell).join(','))));
  return '\ufeff' + lines.join('\r\n');
}
