// Shared review entry points; navigation stays owned by the root router.
import React from 'react';
import { useApp } from './ui';
import { SessionDetail } from './History';
import { ReviewHomeVisual, SessionVisual } from './ReviewVisual';
export function ReviewHomeCandidate(){const {data,open}=useApp();return <ReviewHomeVisual sessions={data.sessions} open={open}/>;}
export function AnalysisCandidate({sessionId,onBack,backLabel}:{sessionId?:string;onBack:()=>void;backLabel?:string}){const {data,open}=useApp();const id=sessionId??[...data.sessions].filter(session=>session.status==='completed').sort((a,b)=>b.started.localeCompare(a.started)||b.id.localeCompare(a.id))[0]?.id;return id?<SessionDetail key={id} id={id} initialTab="analysis" onBack={onBack} backLabel={backLabel}/>:<SessionVisual sessions={data.sessions} open={open} onBack={onBack} backLabel={backLabel}/>;}
