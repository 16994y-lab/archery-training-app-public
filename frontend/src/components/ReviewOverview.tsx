import type { CSSProperties } from "react";

export type ReviewPeriod = 7 | 30 | 90 | "all";

export type ReviewTrendPoint = {
  id: string;
  confirmed_at: string;
  total_score: number;
  average_score: number | null;
  hit_rate: number | null;
  arrow_count: number;
};

const dayMs = 24 * 60 * 60 * 1000;

export function isInReviewPeriod(iso: string, period: ReviewPeriod, now = Date.now()) {
  if (period === "all") return true;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && timestamp >= now - period * dayMs;
}

export function filterReviewTrend(trend: ReviewTrendPoint[], period: ReviewPeriod, now = Date.now()) {
  return trend.filter((point) => isInReviewPeriod(point.confirmed_at, period, now));
}

const periodOptions: Array<{ value: ReviewPeriod; label: string }> = [
  { value: 7, label: "7天" },
  { value: 30, label: "30天" },
  { value: 90, label: "90天" },
  { value: "all", label: "全部" },
];

const periodLabel = (period: ReviewPeriod) => period === "all" ? "全部记录" : `近 ${period} 天`;

function formatAverage(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function ReviewTrendChart({ trend }: { trend: ReviewTrendPoint[] }) {
  const valid = trend
    .filter((point): point is ReviewTrendPoint & { average_score: number } => point.average_score !== null && Number.isFinite(Date.parse(point.confirmed_at)))
    .sort((a, b) => Date.parse(a.confirmed_at) - Date.parse(b.confirmed_at));

  if (valid.length === 0) {
    return <section className="review-trend-card review-empty-card"><div><p>每次训练平均环</p><strong>当前范围暂无记录</strong></div><span>完成并确认训练后，真实走势会显示在这里。</span></section>;
  }

  const dates = valid.map((point) => new Date(point.confirmed_at));
  const scores = valid.map((point) => point.average_score);
  const minDate = Math.min(...dates.map((date) => date.getTime()));
  const maxDate = Math.max(...dates.map((date) => date.getTime()));
  const minScore = Math.max(0, Math.min(...scores) - 0.3);
  const maxScore = Math.min(10, Math.max(...scores) + 0.3);
  const width = 320;
  const height = 132;
  const padX = 30;
  const padTop = 18;
  const padBottom = 25;
  const dateSpan = maxDate - minDate || 1;
  const scoreSpan = maxScore - minScore || 1;
  const pointX = (date: Date) => valid.length === 1 ? width / 2 : padX + ((date.getTime() - minDate) / dateSpan) * (width - padX * 2);
  const pointY = (score: number) => padTop + (1 - (score - minScore) / scoreSpan) * (height - padTop - padBottom);
  const points = valid.map((point, index) => ({ point, date: dates[index], score: scores[index], x: pointX(dates[index]), y: pointY(scores[index]) }));
  const fmtDate = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`;
  const labeled = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);

  return <section className="review-trend-card">
    <div className="review-card-heading"><div><p>趋势</p><h2>每次训练平均环</h2></div><span>{valid.length} 场真实记录</span></div>
    <svg className="review-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`当前范围 ${valid.length} 场训练的平均环走势`}>
      <defs>
        <linearGradient id="reviewTrendStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#238aa3" />
          <stop offset=".55" stopColor="#55b8e8" />
          <stop offset="1" stopColor="#7f80dc" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + ratio * (height - padTop - padBottom);
        return <line key={ratio} x1={padX} y1={y} x2={width - padX} y2={y} />;
      })}
      <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} />
      {points.map((item, index) => <g key={item.point.id}>
        <circle cx={item.x} cy={item.y} r="3.2"><title>{`${item.date.toLocaleString("zh-CN")} · 平均 ${item.score.toFixed(2)} · ${item.point.arrow_count} 箭`}</title></circle>
        {labeled.has(index) && <text x={item.x} y={height - 6} textAnchor="middle">{fmtDate(item.date)}</text>}
      </g>)}
    </svg>
  </section>;
}

export function ReviewOverview({ trend, period, onPeriodChange, now = Date.now() }: {
  trend: ReviewTrendPoint[];
  period: ReviewPeriod;
  onPeriodChange(period: ReviewPeriod): void;
  now?: number;
}) {
  const filtered = filterReviewTrend(trend, period, now);
  const totalScore = filtered.reduce((sum, point) => sum + point.total_score, 0);
  const arrowCount = filtered.reduce((sum, point) => sum + point.arrow_count, 0);
  const weightedAverage = arrowCount > 0 ? totalScore / arrowCount : null;
  const scored = filtered.filter((point) => point.average_score !== null).sort((a, b) => Date.parse(a.confirmed_at) - Date.parse(b.confirmed_at));
  const latest = scored[scored.length - 1];
  const previous = scored[scored.length - 2];
  const delta = latest && previous ? latest.average_score! - previous.average_score! : null;
  const metric = formatAverage(weightedAverage);
  const metricStyle = { "--metric-characters": metric.length } as CSSProperties;

  return <section className="review-overview" aria-label="长期训练概览">
    <nav className="review-period-tabs" aria-label="复盘统计时间范围">
      {periodOptions.map((option) => <button key={option.value} type="button" aria-pressed={period === option.value} onClick={() => onPeriodChange(option.value)}>{option.label}</button>)}
    </nav>

    <article className="motion-metric-card review-primary-metric">
      <div className="metric-topline"><span>长期加权平均环</span><span className="metric-status">{periodLabel(period)}</span></div>
      <div className="review-metric-body">
        <div className="review-metric-copy">
          <div className="motion-metric-value" style={metricStyle}><strong>{metric}</strong><span>/ 10</span></div>
          <p>{arrowCount > 0 ? `${arrowCount} 箭 · M 计入统计分母` : "完成并确认训练后开始累计"}</p>
        </div>
        <div className="review-motion-cue" aria-hidden="true">
          {delta !== null && <span className={delta >= 0 ? "is-up" : "is-down"}>{delta >= 0 ? "+" : ""}{delta.toFixed(2)}</span>}
          <img src="/ui/review-motion-line.svg" alt="" />
        </div>
      </div>
    </article>

    <div className="review-fact-grid">
      <article><span>正式总箭数</span><strong>{arrowCount.toLocaleString("zh-CN")}</strong><small>仅统计已确认训练</small></article>
      <article><span>训练场次</span><strong>{filtered.length.toLocaleString("zh-CN")}</strong><small>{periodLabel(period)}</small></article>
    </div>

    <ReviewTrendChart trend={filtered} />
  </section>;
}
