import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild');
const result=await build({entryPoints:[fileURLToPath(new URL('../src/mobile/review-state.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {clearReviewViewState}=mod.exports;

test('account switch clears review dates, equipment and session selection without touching other session data',()=>{
 const data=new Map([
  ['gongxingji.review.v2.visual-compare-from-a','"2026-10-01"'],
  ['gongxingji.review.v2.visual-compare-kit-b','"synthetic-equipment"'],
  ['gongxingji.review.v2.session-group-synthetic','1'],
  ['gongxingji.review.v2.session-face-synthetic','2'],
  ['unrelated-document','preserve'],
  ['gongxingji.review.v20.keep','preserve-prefix-neighbor'],
 ]);
 globalThis.sessionStorage={get length(){return data.size;},key:i=>[...data.keys()][i]??null,removeItem:key=>data.delete(key)};
 try{clearReviewViewState();assert.deepEqual([...data],[['unrelated-document','preserve'],['gongxingji.review.v20.keep','preserve-prefix-neighbor']]);clearReviewViewState();assert.equal(data.size,2);}finally{delete globalThis.sessionStorage;}
});

test('unavailable view storage cannot prevent an existing account switch',()=>{
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('storage unavailable');}});
 try{assert.doesNotThrow(clearReviewViewState);}finally{delete globalThis.sessionStorage;}
});
