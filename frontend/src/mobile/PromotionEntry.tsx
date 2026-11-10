import React from 'react';
import { Back, Panel } from './ui';
import { PROMO_PAGE_URL } from './share-poster/poster-core.mjs';
import { PROMO_PAGE_VERIFIED } from './share-poster/session-poster';
import './news.css';

/** Standalone page; App/Profile routing is integrated separately by the controller. */
export function PromotionEntry({ onBack }: { onBack: () => void }) {
  return <>
    <Back title="了解弓行记" onBack={onBack} />
    <article className="news-article">
      <span className="news-local-label">GONG XING JI</span>
      <h2>认真练习，清楚记录。</h2>
      <p>用训练计划、逐箭记分和历史复盘，让每一次练习有迹可循。</p>
      <Panel title="一场训练的清楚路径">
        <p>训练前定计划；训练中区分 X、普通 10 和 M；练完后回看自己的实际记录。</p>
      </Panel>
      {PROMO_PAGE_VERIFIED&&<div className="news-article-source">
        <img src={new URL('../../public/ui/promo-site-qr.png', import.meta.url).href} alt="弓行记固定宣传页二维码" width="220" height="220" style={{ display: 'block', maxWidth: '100%', height: 'auto', marginBottom: 16 }} />
        <p>扫码了解弓行记，也可以直接打开产品介绍。</p>
        <a className="news-original-link" href={PROMO_PAGE_URL} target="_blank" rel="noopener noreferrer" aria-label="查看弓行记产品介绍，在浏览器打开">查看产品介绍 <span aria-hidden="true">↗</span></a>
      </div>}
    </article>
  </>;
}
