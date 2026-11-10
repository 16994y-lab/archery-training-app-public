import type { Session } from '../domain';
import { allArrows } from '../domain';
import { statistics } from '../statistics';
import { savedCoordinateCoverage } from '../analysis-insights';
import { imageUrlToDataUrl, PROMO_PAGE_URL, renderSharePosterSvg, sharePosterNickname } from './poster-core.mjs';
import type { PosterData, PosterVariant } from './poster-core.mjs';

// Enable only after the fixed product-introduction page is checked anonymously.
export const PROMO_PAGE_VERIFIED = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_PROMO_PAGE_VERIFIED === '1';

/** Use the session owner's current profile nickname unless the preview hides it. */
export function posterDataFromSession(session: Session, options: { nickname?: string; includeNickname?: boolean } = {}): PosterData {
  if (session.status !== 'completed') throw new Error('只有已完成的训练能生成分享海报');
  const arrows = allArrows(session);
  if (!arrows.length) throw new Error('本场没有实际箭数，不能生成成绩海报');
  const stats = statistics(arrows);
  const coverage = savedCoordinateCoverage(session);
  const located = session.conditions.target.face_count === 1 ? [...coverage.trusted,...coverage.estimated].filter(arrow=>arrow.face===1) : [];
  const points:PosterData['points'] = located.slice(0, 80).map(arrow => ({ x: arrow.x!, y: arrow.y!, code: arrow.code, estimated: arrow.source==='photo'&&arrow.coordinateEvidence!=='manual-target-confirmed',source:arrow.source==='target'?'target':arrow.coordinateEvidence==='manual-target-confirmed'?'photo-manual':'photo-mapped' }));
  return {
    demo: false,
    title: session.name.trim() || '本次训练',
    nickname: options.includeNickname === false ? '' : sharePosterNickname(options.nickname),
    date: session.date,
    arrows: stats.n,
    total: stats.total,
    x: stats.distribution.X,
    ten: stats.distribution['10'],
    miss: stats.distribution.M,
    points,
    pointCount: located.length,
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
