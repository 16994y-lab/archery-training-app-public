// Independent share-poster renderer. All visible training values come from one completed session.
export const POSTER_SIZE = Object.freeze({ width: 760, height: 1120 });
export const PROMO_PAGE_URL = 'https://service-1.example.invalid/get-app/';

const xml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const finiteInt = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}不是有效的本次训练数据`);
  return value;
};
const widthOf = (value, size) => Array.from(value).reduce((width, char) => width + (/\p{Script=Han}|[\u3000-\u303f\uff00-\uffef]/u.test(char) ? 1 : /[A-Z0-9]/.test(char) ? .65 : /\s/.test(char) ? .33 : .62) * size, 0);

function fittedLines(value, width, maxLines, preferred, minimum, label) {
  const chars = Array.from(clean(value));
  for (let size = preferred; size >= minimum; size--) {
    const lines = [''];
    for (const char of chars) {
      const current = lines.length - 1;
      if (lines[current] && widthOf(lines[current] + char, size) > width) lines.push('');
      lines[lines.length - 1] += char;
    }
    if (lines.length <= maxLines && lines.every(line => widthOf(line, size) <= width)) return { lines, size };
  }
  throw new Error(`${label}过长，无法完整放进海报；请在分享前缩短`);
}

function textLines(value, x, y, width, maxLines, preferred, minimum, color, weight, label, lineHeight = 1.28) {
  const { lines, size } = fittedLines(value, width, maxLines, preferred, minimum, label);
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? Math.round(size * lineHeight) : 0}">${xml(line)}</tspan>`).join('')}</text>`;
}

function verifyData(data, assets) {
  if (!data || typeof data !== 'object') throw new Error('缺少训练资料');
  const arrows = finiteInt(data.arrows, '箭数');
  if (!arrows) throw new Error('本场没有实际箭数，不能生成成绩海报');
  const total = finiteInt(data.total, '总分');
  const x = finiteInt(data.x, 'X数');
  const ten = finiteInt(data.ten, '普通10数');
  const miss = finiteInt(data.miss, 'M数');
  if (x + ten + miss > arrows || total > arrows * 10) throw new Error('成绩分布与本场箭数不一致');
  if (!Array.isArray(data.points)) throw new Error('落点资料格式无效');
  const pointCount = data.pointCount === undefined ? data.points.length : finiteInt(data.pointCount, '落点总数');
  if (data.points.length > pointCount || pointCount > arrows || data.points.length > 80) throw new Error('落点数量与本场箭数不一致');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(data.date))) throw new Error('本场日期无效');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(assets?.logo ?? '') || assets.logo.length > 1_500_000) throw new Error('未载入原品牌 Logo，暂不能生成海报');
  if (assets.qr && (assets.promoVerified !== true || assets.promoUrl !== PROMO_PAGE_URL)) throw new Error('独立宣传页尚未部署核实，暂不能展示二维码');
  if (assets.qr && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(assets.qr) || assets.qr.length > 1_500_000)) throw new Error('宣传二维码素材无效');
  for (const point of data.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1.2 || Math.abs(point.y) > 1.2 || (point.code !== undefined && !/^(X|10|[1-9]|M)$/.test(point.code)) || (point.estimated !== undefined && typeof point.estimated !== 'boolean')) throw new Error('落点资料超出已核实范围');
    if (point.source !== undefined && (!['target','photo-manual','photo-mapped'].includes(point.source) || point.estimated !== undefined && point.estimated !== (point.source === 'photo-mapped'))) throw new Error('落点来源与参考标记不一致');
  }
  if (data.target) {
    if (!Array.isArray(data.target.rings) || data.target.rings.length < 1 || data.target.rings.length > 12) throw new Error('靶型环带资料无效');
    let previous = 0;
    for (const ring of data.target.rings) {
      if (!/^(X|10|[1-9])$/.test(ring.code) || !/^#[0-9a-f]{6}$/i.test(ring.color) || !Number.isFinite(ring.radius) || ring.radius <= previous || ring.radius > 1.05) throw new Error('靶型环带与本场快照不一致');
      previous = ring.radius;
    }
  }
  fittedLines(data.title || '本次训练', 640, 2, 37, 23, '训练标题');
  fittedLines(data.nickname || '射手', 300, 2, 24, 16, '昵称');
  fittedLines(data.highlight || '', 600, 1, 24, 18, '本次亮点');
  return { ...data, title: clean(data.title) || '本次训练', nickname: clean(data.nickname) || '射手', arrows, total, x, ten, miss, pointCount };
}

const defs = `<defs>
 <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffdf9"/><stop offset=".7" stop-color="#f1f7fb"/><stop offset="1" stop-color="#e8eafc"/></linearGradient>
 <linearGradient id="deep" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0c2655"/><stop offset=".48" stop-color="#174a82"/><stop offset="1" stop-color="#553d8e"/></linearGradient>
 <linearGradient id="night" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111b42"/><stop offset=".55" stop-color="#1c4277"/><stop offset="1" stop-color="#245979"/></linearGradient>
 <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#46d3ef"/><stop offset=".55" stop-color="#a29cf4"/><stop offset="1" stop-color="#ffc589"/></linearGradient>
 <filter id="soft"><feGaussianBlur stdDeviation="30"/></filter>
 <clipPath id="score-clip"><rect x="48" y="326" width="664" height="438" rx="36"/></clipPath>
</defs>`;

function brand(assets, light = false) {
  return `${light ? '<rect x="43" y="37" width="75" height="74" rx="19" fill="#f7fbff"/>' : ''}<image href="${assets.logo}" x="50" y="43" width="62" height="62" preserveAspectRatio="xMidYMid meet"/>
    <text x="125" y="72" fill="${light ? '#ffffff' : '#14345f'}" font-size="26" font-weight="750">弓行记</text>
    <text x="126" y="96" fill="${light ? '#b4d2eb' : '#577796'}" font-size="12" letter-spacing="3">GONGXINGJI</text>`;
}

function demoBadge(data, light = false) {
  return data.demo ? `<rect x="551" y="50" width="155" height="40" rx="20" fill="${light ? '#ffffff' : '#173f77'}" fill-opacity="${light ? '.14' : '1'}"/><text x="628" y="77" text-anchor="middle" fill="${light ? '#ffffff' : '#ffffff'}" font-size="18" font-weight="700">合成演示</text>` : '';
}

function qrPanel(x, y, assets, dark = false) {
  const ink = dark ? '#d6ecfa' : '#23446c';
  if (assets.qr) return `<text x="${x}" y="${y + 30}" fill="${ink}" font-size="20" font-weight="650">扫码了解弓行记</text><text x="${x}" y="${y + 61}" fill="${ink}" font-size="15">训练计划 · 手动记分 · 历史复盘</text>`;
  return `<text x="${x}" y="${y + 30}" fill="${ink}" font-size="20" font-weight="650">认真练习，清楚记录</text><text x="${x}" y="${y + 61}" fill="${ink}" font-size="15">让每一次练习，都有迹可循</text>`;
}

function pointMark(point, x, y, radius) {
  // Older renderer callers have only estimated; retain that distinction without inventing coordinates.
  const source = point.source || (point.estimated ? 'photo-mapped' : 'target');
  const color = point.code === 'M' ? '#bf3f43' : source === 'photo-mapped' ? '#9b6500' : source === 'photo-manual' ? '#087d87' : '#172c59';
  const cx = x.toFixed(2), cy = y.toFixed(2);
  const shape = source === 'photo-mapped'
    ? `<path d="M${cx} ${(y-radius).toFixed(2)} L${(x+radius).toFixed(2)} ${cy} L${cx} ${(y+radius).toFixed(2)} L${(x-radius).toFixed(2)} ${cy} Z" fill="#ffffff" stroke="${color}" stroke-width="2.5"/>`
    : source === 'photo-manual'
      ? `<rect x="${(x-radius).toFixed(2)}" y="${(y-radius).toFixed(2)}" width="${radius*2}" height="${radius*2}" rx="1.5" fill="${color}" stroke="#ffffff" stroke-width="2.5"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" stroke="#ffffff" stroke-width="${radius===8?3:2.5}"/>`;
  return `<g data-point-source="${source}" data-point-miss="${point.code==='M'}">${shape}</g>`;
}

function pointLegend(data, y, light = false) {
  if (!data.points.length) return '';
  const ink = light ? '#d2e7f4' : '#456b8b';
  return `<g aria-label="落点图例">${[
    [{source:'target'},90,'点靶'],
    [{source:'photo-manual'},215,'照片人工'],
    [{source:'photo-mapped'},385,'照片参考'],
    [{source:'target',code:'M'},575,'红色为 M'],
  ].map(([point,x,label])=>`${pointMark(point,x,y,5)}<text x="${x+13}" y="${y+4}" fill="${ink}" font-size="13">${label}</text>`).join('')}</g>`;
}

function posterA(data, assets) {
  const date = xml(data.date.replaceAll('-', '.'));
  const average = (data.total / data.arrows).toFixed(2);
  const scoreSize = data.total >= 1000 ? 103 : 126;
  const scoreX = 90 + String(data.total).length * scoreSize * .68;
  const plottedPoints = data.points.map(point => pointMark(point,566+point.x*116,502-point.y*116,6)).join('');
  const scoreRings = data.target?.rings?.length ? [...data.target.rings].reverse().map(ring => `<circle cx="566" cy="502" r="${(ring.radius * 116).toFixed(2)}" fill="${ring.color}" fill-opacity=".72" stroke="#d1e6f1" stroke-opacity=".5" stroke-width="1"/>`).join('') : `<g fill="none" stroke="url(#glow)" opacity=".42"><circle cx="566" cy="502" r="116" stroke-width="14"/><circle cx="566" cy="502" r="84" stroke-width="16"/><circle cx="566" cy="502" r="52" stroke-width="16"/><circle cx="566" cy="502" r="20" stroke-width="15"/></g>`;
  const pointCaption = data.pointCount > data.points.length ? `显示 ${data.points.length}/${data.pointCount} 个位置 · 详见来源` : `有位置 ${data.pointCount}/${data.arrows} 箭 · 来源见下方说明`;
  return `<rect width="760" height="1120" fill="url(#paper)"/>
    <circle cx="711" cy="103" r="125" fill="#bedaf3" opacity=".35" filter="url(#soft)"/>
    ${brand(assets)}${demoBadge(data)}
    <text x="52" y="144" fill="#536c89" font-size="18" letter-spacing="3">TRAINING MOMENT / 训练片刻</text>
    ${textLines(data.title, 52, 192, 640, 2, 37, 23, '#102e59', 750, '训练标题')}
    <text x="53" y="283" fill="#54708b" font-size="19">${date}  ·  ${xml(data.arrows)} 箭已记录</text>
    <rect x="48" y="326" width="664" height="438" rx="36" fill="url(#deep)"/>
    <g clip-path="url(#score-clip)"><circle cx="566" cy="443" r="180" fill="#74d9f0" opacity=".16" filter="url(#soft)"/>
    ${scoreRings}${plottedPoints}</g>
    <text x="90" y="391" fill="#a8d8f0" font-size="18" letter-spacing="3">本次训练 / TOTAL SCORE</text>
    <text x="87" y="548" fill="#ffffff" font-size="${scoreSize}" font-weight="780">${data.total}</text>
    <text x="${scoreX}" y="540" fill="#dbf5ff" font-size="27">分</text>
    <text x="90" y="596" fill="#d0e5f4" font-size="22">平均 ${average} 环 / 箭</text>
    <text x="566" y="650" text-anchor="middle" fill="#d4e9f5" font-size="13">${pointCaption}</text>
    <line x1="90" x2="670" y1="670" y2="670" stroke="#a2d4ef" stroke-opacity=".28"/>
    <text x="102" y="714" fill="#ffffff" font-size="24" font-weight="700">X  ${data.x}</text>
    <text x="299" y="714" fill="#ffffff" font-size="24" font-weight="700">10  ${data.ten}</text>
    <text x="503" y="714" fill="#ffffff" font-size="24" font-weight="700">M  ${data.miss}</text>
    <text x="89" y="795" fill="#728aa2" font-size="17">训练由</text>
    ${textLines(data.nickname, 164, 798, 300, 2, 24, 16, '#173c68', 700, '昵称')}
    ${textLines(data.coordinateShortNote || pointCaption, 89, 826, 616, 1, 15, 11, '#456b8b', 600, '落点来源')}
    ${pointLegend(data,852)}
    <rect x="48" y="875" width="664" height="70" rx="25" fill="#ffffff" opacity=".9"/>
    <rect x="48" y="875" width="8" height="70" rx="4" fill="url(#glow)"/>
    <text x="77" y="898" fill="#6a839c" font-size="14">本次记录亮点</text>
    ${textLines(data.highlight, 77, 920, 600, 1, 24, 18, '#173c68', 730, '亮点')}
    <line x1="48" x2="${assets.qr ? 520 : 712}" y1="976" y2="976" stroke="#cad9e8"/>
    ${qrPanel(56, 982, assets)}
    ${assets.qr ? `<image href="${assets.qr}" x="544" y="954" width="150" height="150"/>` : `<rect x="573" y="993" width="120" height="69" rx="16" fill="#e3ebf5"/><text x="633" y="1020" text-anchor="middle" fill="#4e6e8e" font-size="16" font-weight="700">GONGXINGJI</text><text x="633" y="1045" text-anchor="middle" fill="#6f88a0" font-size="14">清楚记录</text>`}
    <text x="55" y="1090" fill="#7390a7" font-size="14">仅描述本次已完成训练 · 分享前请核对内容</text>`;
}

function targetArt(data) {
  const rings = data.target?.rings?.length
    ? [...data.target.rings].reverse().map(ring => `<circle cx="380" cy="482" r="${(ring.radius * 182).toFixed(2)}" fill="${ring.color}" stroke="#253d4f" stroke-width="1.5"/>`).join('')
    : [184, 155, 126, 97, 68, 39].map((radius, index) => `<circle cx="380" cy="482" r="${radius}" fill="none" stroke="${index % 2 ? '#d7eff9' : '#81c9eb'}" stroke-opacity="${index ? '.34' : '.64'}" stroke-width="${index ? 16 : 19}"/>`).join('');
  const points = data.points.map(point => pointMark(point,380+point.x*182,482-point.y*182,8)).join('');
  return `<circle cx="380" cy="482" r="218" fill="#d0ecfa" fill-opacity=".08"/><circle cx="380" cy="482" r="190" fill="#19416c" fill-opacity=".65"/>${rings}<path d="M374 482h12M380 476v12" stroke="#223b53" stroke-width="2"/>${points}`;
}

function posterB(data, assets) {
  const shown = data.points.length > 80 ? 80 : data.points.length;
  const pointNote = data.coordinateNote || (shown ? `已确认靶内点 ${shown}/${data.arrows} 箭；环线仅为示意` : '靶面为视觉示意 · 本场无可展示落点');
  const scoreSize = Math.min(98, Math.floor(350 / (String(data.total).length * .7)));
  return `<rect width="760" height="1120" fill="url(#night)"/>
    <circle cx="60" cy="221" r="135" fill="#65cbdf" opacity=".14" filter="url(#soft)"/>
    ${brand(assets, true)}${demoBadge(data, true)}
    ${textLines(data.title, 52, 172, 640, 2, 34, 22, '#ffffff', 740, '训练标题')}
    <text x="54" y="241" fill="#afd2e9" font-size="18">${xml(data.date.replaceAll('-', '.'))}  ·  本次训练</text>
    ${textLines(data.nickname, 54, 273, 640, 2, 20, 16, '#d7eaf6', 650, '昵称')}
    ${targetArt(data)}
    ${textLines(pointNote, 62, 710, 636, 2, 16, 13, '#d2e7f4', 600, '落点来源')}
    ${pointLegend(data,747,true)}
    <rect x="48" y="764" width="664" height="300" rx="34" fill="#f8fbff"/>
    <text x="78" y="814" fill="#5c7896" font-size="17" letter-spacing="2">本次 / SESSION</text>
    <text x="75" y="921" fill="#103b6c" font-size="${scoreSize}" font-weight="780">${data.total}</text>
    <text x="77" y="950" fill="#587b9a" font-size="20">分 · ${data.arrows} 箭</text>
    <text x="80" y="1004" fill="#234b75" font-size="18">X ${data.x}　普通 10 ${data.ten}　M ${data.miss}</text>
    <line x1="470" y1="807" x2="470" y2="1029" stroke="#cadce9"/>
    <rect x="507" y="830" width="166" height="133" rx="20" fill="#e5eef6"/>
    ${assets.qr ? `<image href="${assets.qr}" x="530" y="837" width="120" height="120"/><text x="590" y="997" text-anchor="middle" fill="#607e9d" font-size="13">扫码进入网站宣传页</text>` : `<text x="590" y="883" text-anchor="middle" fill="#315b80" font-size="19" font-weight="700">弓行记</text><text x="590" y="916" text-anchor="middle" fill="#6b87a0" font-size="15">清楚记录每一箭</text><text x="590" y="997" text-anchor="middle" fill="#607e9d" font-size="13">训练计划 · 记分 · 复盘</text>`}
    <text x="52" y="1097" fill="#c6dfea" font-size="14">${xml(data.highlight)}　·　仅本次真实记录</text>`;
}

export function renderSharePosterSvg(rawData, assets, variant = 'score') {
  if (!['score', 'target'].includes(variant)) throw new Error('未知海报版式');
  const data = verifyData(rawData, assets);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="760" height="1120" viewBox="0 0 760 1120" role="img" aria-label="弓行记本次训练分享海报"><g font-family="Arial, Microsoft YaHei, Noto Sans CJK SC, sans-serif">${defs}${variant === 'score' ? posterA(data, assets) : posterB(data, assets)}</g></svg>`;
}

export async function imageUrlToDataUrl(url) {
  // The Android bundle may inline the small original logo as a data URL.
  // Fetching that URL is blocked by the packaged page's connect-src policy.
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) {
    if (url.length > 1_500_000) throw new Error('海报素材格式或大小不符');
    return url;
  }
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('海报品牌素材载入失败');
  const blob = await response.blob();
  if (blob.type !== 'image/png' || blob.size > 1024 * 1024) throw new Error('海报素材格式或大小不符');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('海报素材读取失败'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function rasterizeSharePoster(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('海报 PNG 生成失败'));
      image.src = url;
    });
    if (image.naturalWidth !== 760 || image.naturalHeight !== 1120) throw new Error('海报尺寸异常');
    const canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 1120;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前设备暂不能生成 PNG');
    context.drawImage(image, 0, 0);
    const png = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}
