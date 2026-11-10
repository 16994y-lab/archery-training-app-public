import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const frontend=fileURLToPath(new URL('..',import.meta.url));
const built=await build({stdin:{contents:"export * from './src/mobile/target-interaction'; export * from './src/mobile/domain'; export * from './src/mobile/statistics'; export * from './src/mobile/SpreadOverlay';",resolveDir:frontend,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['react']});
const m={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(m,m.exports,require);
const {TargetTapGate,initialTargetView,boundedView,insideSurface,surfacePoint,zoomAt,ScoringCircles,SpreadOverlay,statistics,defaultConditions,scoreAt}=m.exports;
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const contact=(id,x=100,y=100,time=0,primary=id===1)=>({id,x,y,time,primary});
test('fresh single taps work, but movement and a 650ms hold never score',()=>{
 const g=new TargetTapGate();g.down(contact(1));assert.equal(g.end(contact(1,102,101,80)),true);
 g.down(contact(1));g.move(contact(1,115));g.move(contact(1));assert.equal(g.end(contact(1,100,100,80)),false);
 g.down(contact(1));assert.equal(g.end(contact(1,100,100,650)),false);
});
for(const order of [[1,2],[2,1]])test(`both pinch release orders reject every arrow (${order.join(',')})`,()=>{
 const g=new TargetTapGate();g.down(contact(1));g.down(contact(2,120));
 assert.equal(g.end(contact(order[0],100,100,20)),false);
 assert.equal(g.end(contact(order[1],100,100,40)),false);
 g.down(contact(1));assert.equal(g.end(contact(1,100,100,80)),true);
});
test('remaining finger plus a new finger remains ineligible until all fingers leave',()=>{
 const g=new TargetTapGate();g.down(contact(1));g.down(contact(2));assert.equal(g.end(contact(2)),false);
 g.down(contact(3));assert.equal(g.end(contact(3)),false);assert.equal(g.end(contact(1)),false);
});
test('cancel, lost capture, leaving the surface and scene reset cannot score late releases',()=>{
 for(const cancel of [g=>g.end(contact(1),true),g=>g.block(),g=>g.clear()]){
  const g=new TargetTapGate();g.down(contact(1));cancel(g);assert.equal(g.end(contact(1,100,100,30)),false);
  g.down(contact(1));assert.equal(g.end(contact(1,100,100,50)),true);
 }
});
test('an orphaned non-primary touch after lifecycle cancellation cannot score',()=>{
 const g=new TargetTapGate();g.down(contact(2));assert.equal(g.end(contact(2,100,100,30)),false);
});
test('zoom follows the original target anchor, including a moved pinch midpoint',()=>{
 const box={left:20,top:100,width:360,height:360},v=initialTargetView(),origin=[230,265];
 const anchor=surfacePoint(...origin,box,v),next=zoomAt(anchor,[240,280],box,3);
 const point=surfacePoint(240,280,box,next);assert.ok(Math.abs(point.x-anchor.x)<1e-12);assert.ok(Math.abs(point.y-anchor.y)<1e-12);
});
test('zoom limits and panning retain the original white M area without growing the paper',()=>{
 assert.deepEqual(boundedView({scale:.1,x:8,y:8}),initialTargetView());
 const view=boundedView({scale:20,x:9,y:-9});assert.deepEqual(view,{scale:6,x:1,y:-1});
 const point=surfacePoint(270,150,{left:0,top:0,width:300,height:300},{scale:4,x:.88,y:0});
 assert.ok(point.x>1&&point.x<1.2);assert.equal(scoreAt(defaultConditions().target,point.x,point.y),'M');
});
const arrow=(x,y,i,code='9')=>({id:String(i),code,x,y,face:1,source:'target'});
const arrows=[[-.35,.2],[-.33,.2],[-.35,.22],[.35,-.2],[.33,-.2],[.35,-.22],[1.1,.8]].map(([x,y],i)=>arrow(x,y,i,i===6?'M':'9'));
test('scoring keeps only blue candidate circles, with no hull, ellipse, group labels or forced common circle',()=>{
 const stats=statistics(arrows),svg=renderToStaticMarkup(React.createElement(ScoringCircles,{stats}));
 assert.equal((svg.match(/data-kind="scoring-circle"/g)||[]).length,2);assert.equal((svg.match(/stroke="#1976d2"/g)||[]).length,2);
 assert.doesNotMatch(svg,/<(?:polygon|line|ellipse|path|text)\b/);assert.doesNotMatch(svg,/data-kind="concentration"/);
 const review=renderToStaticMarkup(React.createElement(SpreadOverlay,{stats}));
 assert.match(review,/all-point-hull/);assert.match(review,/direction-ellipse/);assert.match(review,/candidate-circle/);
});
test('numeric arrows and fewer than three located in-target arrows do not fabricate a circle',()=>{
 const stats=statistics([arrow(null,null,1),arrow(.1,.1,2),arrow(.12,.11,3)]);
 assert.equal(renderToStaticMarkup(React.createElement(ScoringCircles,{stats})), '');
});

test('pointer capture cannot turn an out-of-viewport release into a target tap',()=>{
 const box={left:20,top:30,width:300,height:300},g=new TargetTapGate();
 g.down(contact(1,318,150));
 assert.equal(insideSurface(322,150,box),false);
 assert.equal(g.end(contact(1,322,150,40),!insideSurface(322,150,box)),false);
 assert.equal(insideSurface(21,31,box),true);
});
