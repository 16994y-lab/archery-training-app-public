import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSharePosterSvg, imageUrlToDataUrl, POSTER_SIZE, PROMO_PAGE_URL } from '../src/mobile/share-poster/poster-core.mjs';

const assets = { logo: 'data:image/png;base64,AA==' };
const session = () => ({
  demo: true,
  title: '18 米稳态训练',
  nickname: '示例射手',
  date: '2026-09-30',
  arrows: 11,
  total: 91,
  x: 2,
  ten: 2,
  miss: 1,
  points: [{ x: .1, y: -.2 }],
});

test('bundled PNG data URL is accepted without a network fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected fetch'); };
  try {
    assert.equal(await imageUrlToDataUrl(assets.logo), assets.logo);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('both compact layouts use the same factual values and fixed export dimensions', () => {
  assert.deepEqual(POSTER_SIZE, { width: 760, height: 1120 });
  for (const variant of ['score', 'target']) {
    const svg = renderSharePosterSvg(session(), assets, variant);
    assert.match(svg, /width="760" height="1120"/);
    assert.match(svg, />91</);
    assert.match(svg, /X  2|data-score-kind="X"[^]*?>2<\/text>/);
    assert.match(svg, /合成演示/);
    assert.match(svg, /和 Momo、示例射手 一起射箭吧/);
    assert.doesNotMatch(svg, /<image href="https?:/);
    assert.doesNotMatch(svg, /排名|粉丝|生涯最佳/);
  }
});

test('no coordinates never produces an invented plotted arrow', () => {
  const svg = renderSharePosterSvg({ ...session(), points: [] }, assets, 'target');
  assert.doesNotMatch(svg, /data-point-source/);
  const scoreSvg = renderSharePosterSvg({ ...session(), points: [] }, assets, 'score');
  assert.doesNotMatch(scoreSvg, /data-point-source/);
});

test('target postcard uses the saved five-to-ten ring snapshot rather than decorative ten-ring art', () => {
  const target={name:'5–10 环靶',rings:[
    {code:'X',color:'#f5cf36',radius:.08},{code:'10',color:'#f5cf36',radius:.16},
    {code:'9',color:'#e34747',radius:.32},{code:'8',color:'#e34747',radius:.5},
    {code:'7',color:'#299ed2',radius:.7},{code:'6',color:'#299ed2',radius:.85},
    {code:'5',color:'#202329',radius:1}
  ]};
  const svg=renderSharePosterSvg({...session(),target},assets,'target');
  assert.match(svg,/r="198\.00" fill="#202329"/);
  assert.match(svg,/r="15\.84" fill="#f5cf36"/);
  assert.doesNotMatch(svg,/fill="#ffffff" stroke="#253d4f"/);
  assert.throws(()=>renderSharePosterSvg({...session(),target:{...target,rings:[]}},assets,'target'),/靶型环带资料无效/);
});

test('score poster plots saved tap coordinates at the same orientation as target poster, including located M', () => {
  const data = { ...session(), points: [{ x: 0, y: 0, code: 'X' }, { x: 1.1, y: -.2, code: 'M' }], pointCount: 2 };
  const scoreSvg = renderSharePosterSvg(data, assets, 'score');
  const targetSvg = renderSharePosterSvg(data, assets, 'target');
  assert.match(scoreSvg, /cx="566\.00" cy="502\.00" r="6" fill="#172c59"/);
  assert.match(scoreSvg, /cx="693\.60" cy="525\.20" r="6" fill="#98a4b5"/);
  assert.match(targetSvg, /cx="380\.00" cy="482\.00" r="8" fill="#172c59"/);
  assert.match(targetSvg, /cx="597\.80" cy="521\.60" r="8" fill="#98a4b5"/);
});

test('one miss is a valid zero-score session while an empty session is refused', () => {
  const svg = renderSharePosterSvg({ ...session(), arrows: 1, total: 0, x: 0, ten: 0, miss: 1, points: [] }, assets);
  assert.match(svg, />0</);
  assert.throws(() => renderSharePosterSvg({ ...session(), arrows: 0 }, assets), /没有实际箭数/);
});

test('title and nickname are escaped and a legacy title is limited to 20 visible characters', () => {
  const svg = renderSharePosterSvg({ ...session(), title: 'A&B <训练>', nickname: '射手"甲' }, assets);
  assert.match(svg, /A&amp;B &lt;训练&gt;/);
  assert.match(svg, /射手&quot;甲/);
  const long = renderSharePosterSvg({ ...session(), title: '射'.repeat(1000) }, assets);
  const titleLines = [...long.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].slice(0, 2);
  assert.equal(titleLines.map(match => match[1]).join(''), '射'.repeat(19) + '…');
});

test('a QR image and inconsistent scoring values are blocked', () => {
  assert.throws(() => renderSharePosterSvg(session(), { ...assets, qr: 'data:image/png;base64,AA==' }), /宣传页尚未部署/);
  assert.throws(() => renderSharePosterSvg({ ...session(), arrows: 3, x: 2, ten: 2 }, assets), /成绩分布/);
});

test('only an explicitly verified fixed website QR is rendered in both layouts', () => {
  const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const verified = { ...assets, qr, promoUrl: PROMO_PAGE_URL, promoVerified: true };
  assert.throws(() => renderSharePosterSvg(session(), { ...verified, promoUrl: 'https://example.com/' }), /宣传页尚未部署/);
  for (const variant of ['score', 'target']) {
    const svg = renderSharePosterSvg(session(), verified, variant);
    assert.ok(svg.includes(`data-poster-qr="" href="${qr}"`));
    assert.match(svg, /data-poster-qr=""[^>]*filter="url\(#qr-ink\)"/);
    assert.doesNotMatch(svg, /待上线|待核实|APK|下载|扫码|导入弓行记|仅本次真实记录|落点图例/);
    assert.doesNotMatch(renderSharePosterSvg(session(), assets, variant), /data-poster-qr/);
  }
});

test('invitation omits missing and invalid stored names, and fits eight visible nickname characters', () => {
  const verified = { ...assets, qr: assets.logo, promoUrl: PROMO_PAGE_URL, promoVerified: true };
  for (const nickname of ['', '  ', '射手', '弓'.repeat(9), '弓行记客服']) {
    const svg = renderSharePosterSvg({ ...session(), nickname }, verified, 'target');
    assert.match(svg, /和 Momo 一起射箭吧/);
    assert.doesNotMatch(svg, /射手|Momo、/);
  }
  const nickname = '弓行八字昵称样例';
  const svg = renderSharePosterSvg({ ...session(), nickname }, verified, 'target');
  const invite = svg.match(/<g data-poster-invite="">([^]*?)<\/g>/)[1];
  assert.equal([...invite.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(match => match[1]).join(''), `和 Momo、${nickname} 一起射箭吧`);
});
