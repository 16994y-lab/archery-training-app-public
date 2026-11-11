import publishedCalendar from './competition-calendar.bundled.v1.json';
import {readBoundedResponse} from './bounded-response';
import type {CompetitionEvent,CompetitionLinkKind} from './competition-calendar.types';

export const COMPETITION_URL='https://service-1.example.invalid/competition-calendar.v1.json';
export const COMPETITION_CACHE_KEY='gongxingji-reviewed-calendar-v1';
export const COMPETITION_MAX_BYTES=180000;
export const COMPETITION_REFRESH_INTERVAL=15*60*1000;
export type CompetitionPublication={schema:1;revision:number;events:readonly CompetitionEvent[]};
export const bundledCompetitions=publishedCalendar as CompetitionPublication;
const linkKinds=new Set<CompetitionLinkKind>(['notice','rules','entry','schedule','spectator','broadcast','report','results']);
const spectatorStates=new Set(['免费入场','购票入场','预约入场','不对公众开放']);
const text=(v:unknown,max=800):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[<>\u0000-\u001f]/.test(v);
function date(v:unknown):v is string{
  return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
}
function cutoff(v:unknown){
  return typeof v==='string'&&date(v.slice(0,10))&&(v.length===10||/^T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\+08:00$/.test(v.slice(10)));
}
function publicLink(v:unknown):v is string{
  if(!text(v,1800)||!/^[\x21-\x7e]+$/.test(v)||!/^https:\/\/[A-Za-z0-9.-]+\//.test(v)||v.includes('\\'))return false;
  const url=new URL(v);
  return !url.username&&!url.password&&!url.port&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    &&!/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname);
}
export function parseCompetitionPublication(raw:string):CompetitionPublication{
  if(new TextEncoder().encode(raw).byteLength>COMPETITION_MAX_BYTES)throw new Error('赛事文件过大');
  const result=JSON.parse(raw) as CompetitionPublication;
  if(!result||result.schema!==1||!Number.isSafeInteger(result.revision)||result.revision<1||!Array.isArray(result.events)||!result.events.length||result.events.length>150)throw new Error('赛事格式无效');
  const ids=new Set<string>();
  for(const e of result.events){
    if(!e||!text(e.id,80)||!/^[a-z0-9-]+$/.test(e.id)||ids.has(e.id)||!text(e.name,160)||!text(e.level,40)||!text(e.province,70)||!text(e.city,70)||!Number.isInteger(e.year)||e.year<2020||e.year>2100||!date(e.checkedOn))throw new Error('赛事记录无效');
    ids.add(e.id);
    for(const key of ['country','venue','dateNote','eligibility','entryMethod','entryNote','format','result'] as const){
      if(e[key]!==undefined&&!text(e[key]))throw new Error('赛事文字无效');
    }
    if(e.eligibilitySummary!==undefined&&!text(e.eligibilitySummary,40))throw new Error('报名资格摘要无效');
    if(e.month!==undefined&&(!Number.isInteger(e.month)||e.month<1||e.month>12)||e.startDate!==undefined&&(!date(e.startDate)||Number(e.startDate.slice(0,4))!==e.year)||e.endDate!==undefined&&(!date(e.endDate)||!e.startDate||e.endDate<e.startDate))throw new Error('赛期无效');
    if(e.entryDeadline!==undefined&&!cutoff(e.entryDeadline)||e.entryDeadlineZone!==undefined&&(e.entryDeadlineZone!=='UTC'||e.entryDeadline?.length!==10)||e.individualEntryFrom!==undefined&&!date(e.individualEntryFrom))throw new Error('赛事报名期限无效');
    if(e.spectator!==undefined&&(!e.spectator||!text(e.spectator.admission)||!text(e.spectator.broadcast)||e.spectator.status!==undefined&&!spectatorStates.has(e.spectator.status)||e.spectator.liveStream!==undefined&&!text(e.spectator.liveStream,40)))throw new Error('观赛说明无效');
    for(const key of ['schedule','reports'] as const){
      const entries=e[key];
      if(entries!==undefined&&(!Array.isArray(entries)||entries.length>30||!entries.every(item=>text(item))))throw new Error('赛事说明无效');
    }
    if(!Array.isArray(e.links)||!e.links.length||e.links.length>15||e.links.some((link:CompetitionEvent['links'][number])=>!link||!linkKinds.has(link.kind)||!text(link.label,160)||!publicLink(link.url)))throw new Error('赛事来源无效');
  }
  return result;
}

export function readCompetitionCache():CompetitionPublication{
  try{
    const cached=localStorage.getItem(COMPETITION_CACHE_KEY);
    if(cached){
      const snapshot=parseCompetitionPublication(cached);
      if(snapshot.revision>bundledCompetitions.revision)return snapshot;
    }
  }catch{/* Use the verified copy bundled with the application. */}
  return bundledCompetitions;
}

export async function fetchCompetitionPublication(http:(url:string,options:RequestInit)=>Promise<Response>,prior:CompetitionPublication){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await http(COMPETITION_URL,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
    if(!response.ok)throw new Error('赛事服务暂不可用');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,COMPETITION_MAX_BYTES,controller.signal));
    const publication=parseCompetitionPublication(raw);
    if(publication.revision<=prior.revision)return prior;
    try{localStorage.setItem(COMPETITION_CACHE_KEY,JSON.stringify(publication));}catch{/* The in-memory publication remains readable. */}
    return publication;
  }finally{clearTimeout(timer);}
}
