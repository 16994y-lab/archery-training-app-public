const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const frontend = path.resolve(__dirname, '..');
const { buildSync } = createRequire(path.join(frontend, 'package.json'))('esbuild');
const source = path.join(frontend, 'src/mobile/long-term-analysis.ts');
const result = buildSync({stdin:{contents:fs.readFileSync(source,'utf8')+"\nexport * from './domain';",resolveDir:path.join(frontend,'src/mobile'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
const compiled = {exports:{}};
new Function('module','exports','require',result.outputFiles[0].text)(compiled,compiled.exports,require);
const C = compiled.exports;
const equipment = {id:'e1',name:'同一套器材',bow:'反曲弓',riser:'R',limbs:'L',arrows:'A',sight:'S',stabilizer:'St',string:'String',tab:'T',other:'',favorite:false};
function arrow(code, id, point, extra = {}) {
  return {id,code,x:point?.[0]??null,y:point?.[1]??null,face:1,source:point?'target':'number',enteredAt:'2026-11-01T01:00:00Z',...extra};
}
function session(id, groups, date = '2026-11-01') {
  const conditions = C.defaultConditions();
  conditions.size=40;
  conditions.equipment=structuredClone(equipment);
  return {id,name:id,date,started:date+'T01:00:00Z',ended:date+'T02:00:00Z',status:'completed',conditions,plan:null,
    ends:groups.map((codes,i)=>({id:'end'+i,blockId:'free',half:'',capacity:6,confirmed:true,
      arrows:codes.map((code,j)=>typeof code==='string'?arrow(code,'a'+i+'-'+j):code)}))};
}

test('calendar dates are validated and bounds include both endpoints',()=>{
  const records=[session('a',[['X']],'2026-10-31'),session('b',[['10']],'2026-11-01'),session('c',[['9']],'2026-11-02')];
  assert.equal(C.validAnalysisDate('2026-02-30'),false);
  assert.equal(C.validAnalysisDate('2024-02-29'),true);
  assert.equal(C.validAnalysisDate('2026-2-03'),false);
  assert.deepEqual(C.buildLongTermAnalysis(records,{start:'2026-11-01',end:'2026-11-02'}).records.map(p=>p.id),['b','c']);
  for(const options of [{start:'2026-02-30'},{start:'2026-11-02',end:'2026-11-01'}]){
    const result=C.buildLongTermAnalysis(records,options);
    assert.equal(result.validRange,false);assert.equal(result.records.length,0);assert.equal(result.conditions.length,1);
  }
});

test('X, ordinary ten, miss and unequal groups use actual counts',()=>{
  const s=session('counts',[['X','10','M'],['9']]);
  const result=C.buildLongTermAnalysis([s]).same[0];
  assert.deepEqual([result.n,result.total,result.average,result.highRate],[4,29,7.25,75]);
  assert.equal(result.groupMin,20/3);assert.equal(result.groupMax,9);
  const draft={...s,id:'draft',status:'draft'};
  const empty=session('empty',[[]]);
  assert.deepEqual(C.buildLongTermAnalysis([s,draft,empty]).records.map(p=>p.id),['counts']);
});

test('workload and group structure do not split matching scoring conditions',()=>{
  const a=session('a',[['10']],'2026-11-01'),b=session('b',[['9','9','9'],['8']],'2026-11-02');
  b.ends[0].capacity=10;b.ends[0].half='上半场';b.plan={id:'plan'};
  assert.equal(C.longTermConditionKey(a),C.longTermConditionKey(b));
  const result=C.buildLongTermAnalysis([a,b]);
  assert.equal(result.conditions.length,1);assert.equal(result.same.length,2);assert.equal(result.weightedAverage,45/5);
  b.conditions.distance=30;
  assert.notEqual(C.longTermConditionKey(a),C.longTermConditionKey(b));
  const selected=C.buildLongTermAnalysis([a,b],{condition:C.longTermConditionKey(a)});
  assert.equal(selected.records.length,2);assert.equal(selected.same.length,1);
});

test('unknown dimensions and equipment remain individual records',()=>{
  const a=session('a',[['10']]),b=session('b',[['9']]);
  a.conditions.size=null;b.conditions.size=null;
  let result=C.buildLongTermAnalysis([a,b]);
  assert.equal(result.conditions.length,2);assert.equal(result.same.length,1);
  assert.equal(result.same[0].rms,null);
  result=C.buildLongTermAnalysis([a,b],{condition:'session:a'});
  assert.equal(result.same[0].id,'a');
  b.conditions.size=40;b.conditions.equipment=null;
  assert.equal(C.longTermConditionKey(b),null);
});

test('only confirmed trusted coordinates enter the range target and numeric scores keep no points',()=>{
  const s=session('points',[[
    arrow('X','center',[0,0]),arrow('10','ten',[.08,0]),arrow('M','miss',[1.1,0]),
    arrow('10','mapped',[.08,0],{source:'photo'}),arrow('10','manual',[.08,0],{source:'photo',coordinateEvidence:'manual-target-confirmed'}),
    arrow('10','number',[.08,0],{source:'number'}),arrow('9','invalid',[0,0]),
  ]]);
  s.ends.push({id:'unconfirmed',confirmed:false,arrows:[arrow('X','pending',[0,0])]});
  const result=C.buildLongTermAnalysis([s]);
  assert.equal(result.targetArrows.length,4);assert.equal(result.targetTrusted,4);
  assert(result.targetArrows.some(a=>a.code==='M'));assert(result.targetArrows.every(a=>a.id.startsWith('points:')));
  assert.equal(result.same[0].trusted,4);
  assert(Math.abs(result.same[0].centerX-20*(.16/3))<1e-12);
  assert.equal(result.same[0].centerY,0);
  assert.equal(C.buildLongTermAnalysis([session('numeric',[['X','10','M']])]).targetArrows.length,0);
  assert.equal(s.ends[0].arrows[0].id,'center');
});

test('RMS and centers isolate each face and preserve measured centimeter scale',()=>{
  const s=session('faces',[[]]);
  s.conditions.target=structuredClone(C.builtTargets.find(t=>t.id==='mobile-vertical-r'));
  s.ends[0].arrows=[arrow('10','a',[.06,0]),arrow('10','b',[-.06,0]),arrow('9','c',[.3,0],{face:2}),arrow('9','d',[.3,.01],{face:2})];
  const first=C.buildLongTermAnalysis([s],{face:1}),second=C.buildLongTermAnalysis([s],{face:2});
  assert.equal(first.targetArrows.length,2);assert.equal(second.targetArrows.length,2);
  assert.equal(first.same[0].centerX,0);assert(Math.abs(first.same[0].rms-.6)<1e-12);
  assert.equal(second.same[0].centerX,3);assert(Math.abs(second.same[0].rms-.05)<1e-12);
});

test('moving average is trailing, arrow weighted and never mixes conditions',()=>{
  const records=[session('a',[['10']],'2026-11-01'),session('b',[['9','9']],'2026-11-02'),session('c',[['8','8','8']],'2026-11-03')];
  const points=C.buildLongTermAnalysis(records).same;
  assert.deepEqual(C.weightedMovingAverage(points),[null,null,52/6]);
  const other={...points[0],id:'other',conditionKey:'other'};
  assert.deepEqual(C.weightedMovingAverage([points[0],other,points[1],points[2]]),[null,null,null,52/6]);
  assert.deepEqual(C.weightedMovingAverage(points,0),[null,null,null]);
});

test('Pearson uses pairwise complete values, handles constant data and exposes sample counts',()=>{
  const positive=C.pearsonCorrelation([[1,2],[2,4],[3,6],[4,null],[null,8]]);
  const negative=C.pearsonCorrelation([[1,3],[2,2],[3,1]]);
  assert.equal(positive.n,3);assert(Math.abs(positive.value-1)<1e-12);
  assert.equal(negative.n,3);assert(Math.abs(negative.value+1)<1e-12);
  assert.deepEqual(C.pearsonCorrelation([[1,1],[1,2]]),{value:null,n:2});
  assert.deepEqual(C.pearsonCorrelation([[1,2],[Infinity,4]]),{value:null,n:1});
  const points=C.buildLongTermAnalysis([session('a',[['10']]),session('b',[['9','9']])]).same;
  const matrix=C.correlationMatrix(points);
  assert.equal(matrix.cells[0][0].n,2);assert.equal(matrix.cells[0][1].n,0);assert.equal(matrix.cells[0][1].value,null);
});

test('reused arrow IDs across sessions retain every range point',()=>{
  const a=session('a',[[arrow('X','same-id',[0,0])]],'2026-11-01');
  const b=session('b',[[arrow('X','same-id',[0,0])]],'2026-11-02');
  const result=C.buildLongTermAnalysis([a,b]);
  assert.deepEqual(result.targetArrows.map(a=>a.id),['a:same-id','b:same-id']);
  assert.equal(result.spatialSample,0);
});

test('range target does not cap the saved trusted points',()=>{
  const records=Array.from({length:3},(_,index)=>session('many-'+index,[Array.from({length:200},(_,i)=>arrow('X','point'+i,[0,0]))]));
  const result=C.buildLongTermAnalysis(records);
  assert.equal(result.targetArrows.length,600);
  assert.equal(new Set(result.targetArrows.map(a=>a.id)).size,600);
});

test('same-date sessions sort by actual time and remain separate on tied timestamps',()=>{
  const a=session('a',[['10']]),b=session('b',[['9']]),c=session('c',[['8']]);
  a.started='2026-11-01T08:00:00Z';b.started='2026-11-01T09:00:00+08:00';c.started=a.started;
  assert.deepEqual(C.buildLongTermAnalysis([c,a,b]).records.map(p=>p.id),['b','a','c']);
});

test('saved multi-face selection clamps to the newly active target',()=>{
  const single=session('single',[[arrow('X','p',[0,0])]]);
  const result=C.buildLongTermAnalysis([single],{face:3});
  assert.equal(result.activeFace,1);assert.equal(result.targetArrows.length,1);assert.equal(result.same[0].trusted,1);
  assert.equal(C.buildLongTermAnalysis([single],{face:0}).activeFace,1);
  assert.equal(C.buildLongTermAnalysis([single],{face:NaN}).activeFace,1);
  assert(result.conditions[0].label.includes(single.conditions.target.name));
});

test('range with only unknown conditions defaults to its own latest record',()=>{
  const known=session('known',[['10']],'2026-10-01');
  const unknown=session('unknown',[['9']],'2026-11-01');
  unknown.conditions.equipment=null;
  const options={start:'2026-11-01',end:'2026-11-01'};
  let result=C.buildLongTermAnalysis([known,unknown],options);
  assert.equal(result.activeCondition,'session:unknown');assert.equal(result.same[0].id,'unknown');
  result=C.buildLongTermAnalysis([known,unknown],{...options,condition:C.longTermConditionKey(known)});
  assert.equal(result.activeCondition,C.longTermConditionKey(known));assert.equal(result.same.length,0);
});

test('legacy targets without saved ring rules retain an explicit fingerprint',()=>{
  const current=session('current',[['10']]),legacy=session('legacy',[['10']]);
  legacy.conditions.target.ring_rules=null;
  assert.doesNotThrow(()=>C.buildLongTermAnalysis([legacy]));
  assert.notEqual(C.longTermConditionKey(current),C.longTermConditionKey(legacy));
  assert.equal(C.buildLongTermAnalysis([current,legacy]).conditions.length,2);
});
