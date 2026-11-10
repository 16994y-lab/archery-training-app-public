import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild');
const result=await build({entryPoints:[fileURLToPath(new URL('../src/mobile/training-activity.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {trainingActivity,activityLevel}=mod.exports;
const session=(date,status,codes)=>({date,status,ends:[{arrows:codes.map(code=>({code}))}]});
test('calendar uses 12 Monday-first weeks across a year boundary, disabling only future days',()=>{
 const days=trainingActivity([],'2027-01-02');
 assert.equal(days.length,84);assert.equal(days[0].date,'2026-10-12');assert.equal(days.at(-1).date,'2027-01-03');
 assert.equal(new Set(days.map(d=>d.date)).size,84);assert.deepEqual(days.filter(d=>d.future).map(d=>d.date),['2027-01-03']);
 assert(days.every(d=>d.arrows===0));
});
test('daily arrow volume includes M and all same-day completed sessions; excludes drafts and future records',()=>{
 const data=[session('2026-10-13','completed',['X','10','M']),session('2026-10-13','completed',['8']),session('2026-10-13','draft',['9','9']),session('2026-10-13','active',['7']),session('2026-10-14','completed',['10'])];
 const before=JSON.stringify(data),days=trainingActivity(data,'2026-10-13'),today=days.find(d=>d.date==='2026-10-13');
 assert.equal(today.arrows,4);assert.equal(today.sessions.length,2);assert.equal(days.reduce((n,d)=>n+d.arrows,0),4);assert.equal(JSON.stringify(data),before);
 assert.deepEqual([0,1,29,30,59,60,119,120].map(activityLevel),[0,1,1,2,2,3,3,4]);
});
