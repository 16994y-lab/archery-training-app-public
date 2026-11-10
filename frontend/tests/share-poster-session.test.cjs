const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');

let adapter;
async function loadAdapter() {
  if (!adapter) {
    const built = await build({ entryPoints: ['frontend/src/mobile/share-poster/session-poster.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    adapter = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
  }
  return adapter;
}

function targetFor(codes,radii,faceCount=1) {
  return {id:'synthetic-target',name:'合成同心圆',target_type:'CUSTOM_RING_GEOMETRY',scoring_mode:'RING_GEOMETRY',face_count:faceCount,
    rules_version:'target-contract/v1',allowed_score_codes:[...codes,'M'],coordinate_space:'selected-face-scoring-square/v1',boundary_policy:'HIGHER_SCORE_INCLUSIVE',
    ring_rules:codes.map((score_code,i)=>({score_code,label:score_code,color:i<2?'#f5cf36':'#2997c5',outer_radius_norm:radii[i]})),
    layout:{kind:faceCount===1?'SINGLE':'VERTICAL_THREE',face_count:faceCount,faces:Array.from({length:faceCount},(_,i)=>({index:i+1,anchor_x:.5,anchor_y:faceCount===1?.5:.18+i*.32}))},
    plot:{coordinate_space:'face-with-white-buffer/v1',center_x:.5,center_y:.5,outer_scoring_radius_norm:5/12,calibration_boundary_score_code:codes.at(-1),control_order:['TOP','RIGHT','BOTTOM','LEFT']}};
}
function makeSession(faceCount = 1) {
  return {
    status: 'completed',
    name: '本次训练',
    date: '2026-09-30',
    conditions: { target: targetFor(['X','10','9','8','7'],[.12,.18,.35,.45,.5],faceCount) },
    note: '不得放入海报的私人心得',
    ends: [{ confirmed:true, arrows: [
      { code: 'X', x: .1, y: .2, face: 1, source: 'target' },
      { code: '10', x: null, y: null, face: 1, source: 'number' },
      { code: '9', x: -.3, y: .4, face: 1, source: 'target' },
      { code: 'M', x: 1.1, y: 0, face: 1, source: 'target' },
    ] }],
  };
}

test('adapter derives only this completed session and separates X, ordinary 10, and M', async () => {
  const { posterDataFromSession } = await loadAdapter();
  const data = posterDataFromSession(makeSession());
  assert.equal(data.arrows, 4);
  assert.equal(data.total, 29);
  assert.deepEqual([data.x, data.ten, data.miss], [1, 1, 1]);
  assert.equal(data.nickname, '');
  assert.deepEqual(data.points, [{ x: .1, y: .2, code: 'X', estimated:false, source:'target' }, { x: -.3, y: .4, code: '9', estimated:false, source:'target' }, { x: 1.1, y: 0, code: 'M', estimated:false, source:'target' }]);
  assert.equal(data.pointCount, 3);
  assert.ok(!JSON.stringify(data).includes('私人心得'));
  assert.ok(!('photo' in data) && !('email' in data));
});

test('synthetic 18-arrow 98-point session keeps six real taps and its five-to-ten target snapshot', async () => {
  const { posterDataFromSession } = await loadAdapter();
  const groups = [['X','10','9','8','7','M'],['X','8','7','7','6','M'],['6','5','5','M','M','M']];
  const codes = ['X','10','9','8','7','6','5'];
  const radii = [1/24,1/12,1/6,1/4,1/3,5/12,1/2];
  const target = {...targetFor(codes,radii),name:'5–10 环单靶 · X'};
  const coordinates = [0,.1,.3,.48,.63,1.1];
  const mapped = [0,.45,.62,.62,.78,1.1];
  const session = { status:'completed',name:'合成18箭对账',date:'2026-10-01',conditions:{target},ends:groups.map((scores,group)=>({confirmed:true,arrows:scores.map((code,i)=>({
    code,face:1,source:group===0?'target':group===1?'photo':'number',x:group===0?coordinates[i]:group===1?mapped[i]:null,y:group<2?0:null,
  }))})) };
  const data = posterDataFromSession(session);
  assert.deepEqual([data.arrows,data.total,data.x,data.ten,data.miss],[18,98,2,1,5]);
  assert.deepEqual([data.points.length,data.pointCount,data.target.rings.length],[12,12,7]);
  assert.deepEqual(data.target.rings.map(ring=>ring.code),codes);
  assert.equal(data.points.filter(point=>point.estimated).length,6);
  const { renderSharePosterSvg } = await import('../src/mobile/share-poster/poster-core.mjs');
  const svg = renderSharePosterSvg(data,{logo:'data:image/png;base64,AA=='},'target');
  assert.match(svg,/>98</);assert.match(svg,/r="198\.00"/);
  assert.doesNotMatch(svg,/落点 12\/18|照片映射|数字6无位置|本次 9 环及以上|仅本次真实记录/);
});

test('poster ring count follows the selected six-to-ten or full ten-ring target', async () => {
  const { posterDataFromSession } = await loadAdapter();
  for(const [codes,expected] of [[['10','9','8','7','6'],5],[['X','10','9','8','7','6','5','4','3','2','1'],11]]){
    const sample=makeSession();
    sample.conditions.target={...targetFor(codes,codes.map((_,i)=>(i+1)/codes.length*.5)),name:'当前靶型'};
    const data=posterDataFromSession(sample);
    assert.equal(data.target.rings.length,expected);
    assert.equal(data.target.rings.at(-1).code,codes.at(-1));
  }
});

test('saved photo reference mapping is plotted separately from manually confirmed photo positions', async () => {
  const { posterDataFromSession } = await loadAdapter();
  const sample = makeSession();
  sample.ends[0].arrows[1] = { code: '10', x: .3, y: 0, face: 1, source: 'photo' };
  const data = posterDataFromSession(sample);
  assert.equal(data.arrows, 4);
  assert.equal(data.points.length, 4);
  assert.equal(data.points.filter(point=>point.estimated).length,1);
  assert.ok(data.points.some(point => point.code === 'M' && point.x === 1.1));
  sample.ends[0].arrows[1].coordinateEvidence = 'manual-target-confirmed';
  const confirmed = posterDataFromSession(sample);
  assert.equal(confirmed.points.length, 4);
  assert.equal(confirmed.points.filter(point=>point.estimated).length,0);
  assert.ok(confirmed.points.some(point => point.code === '10' && point.x === .3));
});

test('saved nickname is included by default and can be hidden; multiple target faces are not merged', async () => {
  const { posterDataFromSession } = await loadAdapter();
  assert.equal(posterDataFromSession(makeSession(), { nickname: ' 展示昵称 ' }).nickname, '展示昵称');
  assert.equal(posterDataFromSession(makeSession(), { nickname: '展示昵称', includeNickname: false }).nickname, '');
  assert.equal(posterDataFromSession(makeSession(), { nickname: '射手' }).nickname, '');
  const multiple = posterDataFromSession(makeSession(3));
  assert.deepEqual(multiple.points, []);
  assert.equal(multiple.pointCount, 0);
});

test('drafts and zero arrow sessions cannot produce a poster', async () => {
  const { posterDataFromSession } = await loadAdapter();
  assert.throws(() => posterDataFromSession({ ...makeSession(), status: 'draft' }), /已完成/);
  assert.throws(() => posterDataFromSession({ ...makeSession(), ends: [] }), /没有实际箭数/);
});
