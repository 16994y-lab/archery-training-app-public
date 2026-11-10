import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild');
const result=await build({entryPoints:[fileURLToPath(new URL('../src/mobile/review-navigation.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {reviewNavigation,reviewBackTarget}=mod.exports;

test('record tabs and switching sessions return once to the original filtered list',()=>{
 const origin={name:'history-all'},analysis={name:'insights',id:'sample-a'};
 const entry=reviewNavigation(origin,analysis,null,3);
 const records=reviewNavigation(analysis,{name:'detail',id:'sample-a'},entry.state,4);
 assert.equal(records.replace,true);
 const notes=reviewNavigation({name:'detail',id:'sample-a'},{name:'reflection',id:'sample-a'},records.state,4);
 assert.equal(notes.replace,true);
 const back=reviewBackTarget({name:'reflection',id:'sample-a'},notes.state,4);
 assert.deepEqual(back,{path:'/history-all',label:'返回训练记录',useHistory:true});
 const selected=reviewNavigation(analysis,{name:'insights',id:'sample-b'},entry.state,4);
 assert.equal(selected.replace,true);assert.deepEqual(selected.state,entry.state);
 const fromNotes=reviewNavigation({name:'reflection',id:'sample-a'},{name:'insights',id:'sample-b'},entry.state,4);
 assert.equal(fromNotes.replace,true);assert.deepEqual(fromNotes.state,entry.state);
});

test('group and report deep links have a same-session parent without prior history',()=>{
 assert.equal(reviewBackTarget({name:'group',id:'sample-a:2'},null,0).path,'/detail?id=sample-a');
 assert.equal(reviewBackTarget({name:'report',id:'sample-a'},null,0).path,'/insights?id=sample-a');
 assert.equal(reviewBackTarget({name:'insights',id:'sample-a'},null,0).path,'/history');
 assert.equal(reviewBackTarget({name:'trends'},null,9).useHistory,false);
});

test('return context cannot navigate outside review or use a stale history offset',()=>{
 for(const path of ['https://example.test/','//example.test/','/account','/history#other']){
  assert.equal(reviewBackTarget({name:'insights'}, {reviewReturn:{path,index:0}},1).path,'/history');
 }
 assert.equal(reviewBackTarget({name:'detail',id:'sample-a'},{reviewReturn:{path:'/history-all',index:1}},8).useHistory,false);
 assert.deepEqual(reviewNavigation({name:'training'},{name:'support'},null,0),{});
});
