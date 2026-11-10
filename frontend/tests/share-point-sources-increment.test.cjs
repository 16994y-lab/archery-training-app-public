const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {build}=require('esbuild');

async function adapter(){
 const built=await build({entryPoints:[path.resolve(__dirname,'../src/mobile/share-poster/session-poster.ts')],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+'\n//# sourceURL=synthetic-poster-adapter.mjs').toString('base64'));
}
const assets={logo:'data:image/png;base64,AA=='};
const sample={demo:true,title:'合成来源核对',nickname:'合成射手',date:'2026-11-01',arrows:4,total:30,x:0,ten:3,miss:1,points:[
 {x:0,y:0,code:'10',source:'target',estimated:false},
 {x:.2,y:.2,code:'10',source:'photo-manual',estimated:false},
 {x:-.2,y:-.2,code:'10',source:'photo-mapped',estimated:true},
 {x:1.1,y:.1,code:'M',source:'photo-mapped',estimated:true},
]};

test('both poster layouts preserve coordinates and distinguish target, photo-confirmed, photo-reference and M',async()=>{
 const {renderSharePosterSvg}=await import(pathToFileURL(path.resolve(__dirname,'../src/mobile/share-poster/poster-core.mjs')));
 for(const [variant,cx,cy,scale] of [['score',566,502,116],['target',380,482,198]]){
  const svg=renderSharePosterSvg(sample,assets,variant);
  const markers=[...svg.matchAll(/<g data-point-source="([^"]+)" data-point-miss="([^"]+)">(.*?)<\/g>/g)];
  assert.deepEqual(markers.map(m=>[m[1],m[2]]),[['target','false'],['photo-manual','false'],['photo-mapped','false'],['photo-mapped','true']]);
  assert.match(markers[0][3],new RegExp(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}"`));
  assert.match(markers[1][3],/<rect .*fill="#087d87"/);
  assert.match(markers[2][3],/<path .*fill="#ffffff" stroke="#9b6500"/);
  assert.match(markers[3][3],/stroke="#98a4b5"/);
  assert.ok(markers[3][3].includes((cx+1.1*scale).toFixed(2)));
  assert.ok(markers[3][3].includes((cy-.1*scale).toFixed(2)));
  assert.doesNotMatch(svg,/落点图例|点靶|照片人工|照片参考|红色为 M/);
  assert.match(svg,/>30</);assert.match(svg,/M {1,2}1|data-score-kind="M"[^]*?>1<\/text>/);
 }
 assert.throws(()=>renderSharePosterSvg({...sample,points:[{...sample.points[0],source:'photo-mapped'}]},assets),/来源与参考标记不一致/);
 const empty=renderSharePosterSvg({...sample,points:[]},assets,'target');assert.doesNotMatch(empty,/data-point-source|落点图例/);
});

test('session adapter forwards each saved source without changing training data or inventing numeric coordinates',async()=>{
 const {posterDataFromSession}=await adapter();
 const target={id:'synthetic-target',name:'合成靶',target_type:'CUSTOM_RING_GEOMETRY',scoring_mode:'RING_GEOMETRY',face_count:1,
  rules_version:'target-contract/v1',allowed_score_codes:['10','M'],coordinate_space:'selected-face-scoring-square/v1',boundary_policy:'HIGHER_SCORE_INCLUSIVE',
  ring_rules:[{score_code:'10',label:'10',outer_radius_norm:.5,color:'#f5cf36'}],
  layout:{kind:'SINGLE',face_count:1,faces:[{index:1,anchor_x:.5,anchor_y:.5}]},
  plot:{coordinate_space:'face-with-white-buffer/v1',center_x:.5,center_y:.5,outer_scoring_radius_norm:5/12,calibration_boundary_score_code:'10',control_order:['TOP','RIGHT','BOTTOM','LEFT']}};
 const session={status:'completed',name:'合成来源',date:'2026-11-01',conditions:{target},ends:[{confirmed:true,arrows:[
  {code:'10',source:'target',face:1,x:0,y:0},
  {code:'10',source:'photo',coordinateEvidence:'manual-target-confirmed',face:1,x:.2,y:.2},
  {code:'10',source:'photo',face:1,x:-.2,y:-.2},
  {code:'M',source:'photo',face:1,x:1.1,y:.1},
  {code:'10',source:'number',face:1,x:null,y:null},
 ]}]};
 const before=JSON.stringify(session),data=posterDataFromSession(session);
 assert.equal(JSON.stringify(session),before);
 assert.deepEqual(data.points.map(p=>p.source),['target','photo-manual','photo-mapped','photo-mapped']);
 assert.deepEqual(data.points.map(p=>p.estimated),[false,false,true,true]);
 assert.deepEqual([data.arrows,data.total,data.miss,data.points.length],[5,40,1,4]);
 assert.equal(data.pointCount,4);
});
