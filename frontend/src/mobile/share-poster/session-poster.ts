import type { Session } from '../domain';
import { allArrows, scoreValue } from '../domain';
import { statistics } from '../statistics';
import { savedCoordinateCoverage } from '../analysis-insights';
import { imageUrlToDataUrl, PROMO_PAGE_URL, renderSharePosterSvg } from './poster-core.mjs';
import type { PosterData, PosterVariant } from './poster-core.mjs';

// Enable only after the fixed product-introduction page is checked anonymously.
export const PROMO_PAGE_VERIFIED = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_PROMO_PAGE_VERIFIED === '1';

/** A caller must explicitly opt in to showing the current profile nickname. */
export function posterDataFromSession(session: Session, options: { nickname?: string; includeNickname?: boolean } = {}): PosterData {
  if (session.status !== 'completed') throw new Error('只有已完成的训练能生成分享海报');
  const arrows = allArrows(session);
  if (!arrows.length) throw new Error('本场没有实际箭数，不能生成成绩海报');
  const stats = statistics(arrows);
  const high = arrows.filter(arrow => scoreValue(arrow.code) >= 9).length;
  const x = stats.distribution.X;
  const ten = stats.distribution['10'];
  const miss = stats.distribution.M;
  const highlight = x >= 2
    ? `本次 X 环 ${x} 箭 · 与普通 10 分开记录`
    : high >= 3
      ? `本次 9 环及以上 ${high} 箭 / ${stats.n} 箭`
      : `本次完成 ${stats.n} 箭 · M ${miss} 箭`;

  const coverage = savedCoordinateCoverage(session);
  const located = session.conditions.target.face_count === 1 ? [...coverage.trusted,...coverage.estimated].filter(arrow=>arrow.face===1) : [];
  const points:PosterData['points'] = located.slice(0, 80).map(arrow => ({ x: arrow.x!, y: arrow.y!, code: arrow.code, estimated: arrow.source==='photo'&&arrow.coordinateEvidence!=='manual-target-confirmed',source:arrow.source==='target'?'target':arrow.coordinateEvidence==='manual-target-confirmed'?'photo-manual':'photo-mapped' }));
  const breakdown = `落点 ${located.length}/${stats.n}：点靶${coverage.target} · 照片确认${coverage.photoManual} · 照片映射${coverage.photoMapped}；数字${coverage.numeric}无位置${coverage.scoreOnly?`，仅环值${coverage.scoreOnly}`:''}`;
  const coordinateNote = session.conditions.target.face_count > 1
    ? '本场多靶位落点不合并展示 · 环带按靶型快照绘制'
    : located.length > 80 ? `${breakdown}；画面仅显示前 80 点` : breakdown;

  return {
    demo: false,
    title: session.name.trim() || '本次训练',
    nickname: options.includeNickname ? options.nickname?.trim() || '射手' : '射手',
    date: session.date,
    arrows: stats.n,
    total: stats.total,
    x,
    ten,
    miss,
    highlight,
    points,
    pointCount: located.length,
    coordinateNote,
    coordinateShortNote: session.conditions.target.face_count > 1 ? '多靶位落点不合并显示' : `位置${located.length}/${stats.n} · 点靶${coverage.target} 照片人工${coverage.photoManual} 映射${coverage.photoMapped} 数字${coverage.numeric}无位置`,
    target: { name: session.conditions.target.name, rings: (session.conditions.target.ring_rules??[]).map(rule=>({code:rule.score_code,color:rule.color,radius:rule.outer_radius_norm*2})) },
  };
}

export async function renderSessionPosterSvg(session: Session, variant: PosterVariant, options: { nickname?: string; includeNickname?: boolean } = {}): Promise<string> {
  const data = posterDataFromSession(session, options);
  const logoUrl = new URL('../../../public/ui/logo-mark.png', import.meta.url).href;
  const logo = await imageUrlToDataUrl(logoUrl);
  const qr = PROMO_PAGE_VERIFIED ? await imageUrlToDataUrl(new URL('../../../public/ui/promo-site-qr.png', import.meta.url).href) : undefined;
  return renderSharePosterSvg(data, { logo, qr, promoUrl: qr ? PROMO_PAGE_URL : undefined, promoVerified: PROMO_PAGE_VERIFIED }, variant);
}
