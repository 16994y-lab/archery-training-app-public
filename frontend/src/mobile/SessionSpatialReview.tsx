import React, { useMemo, useRef, useState } from 'react';
import { savedCoordinateCoverage } from './analysis-insights';
import { allArrows, scoreValue, type Arrow, type Session } from './domain';
import { clearSpatialOutlier, spatialCenter, spatialDiameter, type SpatialPoint } from './session-spatial-geometry';
import { TargetFace } from './TargetFace';
import './session-spatial-review.css';

type ScopeProps = { session: Session; group: number | null; setGroup: (group: number | null) => void };
type ReviewPoint = SpatialPoint & { arrow: Arrow; group: number; order: number };
const sourceLabel = { target: '点靶录入', photo: '照片录入', number: '数字录入' };
const groupLabel = (group: number) => `第 ${group + 1} 组`;

function offsetLabels(point: SpatialPoint | null, scale: number, unit: string): string[] {
  if (!point) return ['无落点'];
  const axes = [[point.x, '左', '右'], [point.y, '下', '上']] as const;
  const offsets = axes.flatMap(([value, negative, positive]) => {
    const amount = Math.abs(value * scale).toFixed(unit === 'cm' ? 1 : 2);
    return Number(amount) ? [`${value < 0 ? negative : positive} ${amount} ${unit}`] : [];
  });
  return offsets.length ? offsets : ['居中'];
}

function BiasCross({ point, bound }: { point: SpatialPoint; bound: number }) {
  return <svg className="review-bias-cross" viewBox="-4 -4 8 8" aria-hidden="true">
    <path d="M-3.65 0H3.65M0-3.65V3.65" fill="none" stroke="currentColor" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
    <circle r=".22" fill="white" stroke="currentColor" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
    <circle cx={point.x * 3.3 / bound} cy={-point.y * 3.3 / bound} r=".52" fill="#285fb4" stroke="white" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function SessionSpatialReview(props: ScopeProps) {
  return <SpatialReview key={props.session.id} {...props} />;
}

function SpatialReview({ session, group, setGroup }: ScopeProps) {
  const coverage = useMemo(() => savedCoordinateCoverage(session), [session]);
  const [face, setFace] = useState(coverage.trusted[0]?.face ?? coverage.estimated[0]?.face ?? 1);
  const [order, setOrder] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { target, size } = session.conditions;
  const available = useMemo(() => session.ends.flatMap((end, index) => end.arrows.length ? [index] : []), [session.ends]);
  const activeGroup = group !== null && available.includes(group) ? group : null;
  const groupArrows = activeGroup === null ? null : session.ends[activeGroup].arrows;
  const arrows = useMemo(() => groupArrows ?? allArrows(session), [groupArrows, session]);
  const trustedSet = useMemo(() => new Set(coverage.trusted), [coverage]);
  const scopeArrows = useMemo(() => new Set(arrows), [arrows]);
  const locations = useMemo(() => session.ends.flatMap((end, groupIndex) =>
    end.arrows.flatMap((arrow, index) => arrow.face === face && trustedSet.has(arrow)
      ? [{ x: arrow.x!, y: arrow.y!, arrow, group: groupIndex, order: index + 1 }]
      : [])), [session.ends, face, trustedSet]);
  const trusted = useMemo(() => activeGroup === null ? locations : locations.filter(point => point.group === activeGroup), [activeGroup, locations]);
  const reference = useMemo(() => coverage.estimated.filter(arrow => arrow.face === face && scopeArrows.has(arrow)), [coverage, face, scopeArrows]);
  const plotted = useMemo(() => [...reference, ...trusted.map(point => point.arrow)], [reference, trusted]);
  const bias = useMemo(() => spatialCenter(trusted.filter(point => point.arrow.code !== 'M')), [trusted]);
  const diameter = useMemo(() => spatialDiameter(trusted), [trusted]);
  const ring = useMemo(() => {
    if (trusted.length < 2) return null;
    const center = spatialCenter(trusted)!;
    const radius = trusted.reduce((max, point) => Math.max(max, Math.hypot(point.x - center.x, point.y - center.y)), 0);
    return radius ? { ...center, radius } : null;
  }, [trusted]);
  const outlier = useMemo(() => clearSpatialOutlier(trusted), [trusted]);
  const outerPoint: ReviewPoint | null = outlier ? trusted[outlier.index] : null;
  const factor = size !== null && Number.isFinite(size) && size > 0 ? size * target.sizeRatio / 2 : null;
  const scale = factor ?? 1;
  const unit = factor === null ? '半径' : 'cm';
  const showDistance = (value: number) => `${(value * scale).toFixed(factor === null ? 2 : 1)} ${unit}`;
  const centers = useMemo(() => {
    const byGroup = new Map<number, ReviewPoint[]>();
    for (const point of locations) {
      if (point.arrow.code === 'M') continue;
      const list = byGroup.get(point.group);
      if (list) list.push(point);
      else byGroup.set(point.group, [point]);
    }
    return available.map(index => ({ index, point: spatialCenter(byGroup.get(index) ?? []) }));
  }, [available, locations]);
  const bound = centers.reduce((max, row) => row.point
    ? Math.max(max, Math.abs(row.point.x), Math.abs(row.point.y))
    : max, .2);
  const average = arrows.length ? (arrows.reduce((sum, arrow) => sum + scoreValue(arrow.code), 0) / arrows.length).toFixed(2) : '—';
  const chosen = order && activeGroup !== null ? arrows.find(arrow => arrow.id === selected) : undefined;
  const chosenPoint = chosen && plotted.find(arrow => arrow.id === chosen.id);

  function chooseGroup(index: number | null, reveal = false) {
    if (index !== activeGroup) setSelected(null);
    setGroup(index);
    if (reveal) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: 'nearest' });
    }
  }

  return <>
    <section id="session-spatial" className="vx-card vx-spatial review-session-spatial">
      <div className="vx-card-head">
        <h2 ref={heading} tabIndex={-1}>落点与散布</h2>
        {activeGroup !== null && <button type="button" className="review-spatial-all" onClick={() => {
          chooseGroup(null);
          heading.current?.focus({ preventScroll: true });
        }}>看全场</button>}
      </div>
      {target.face_count > 1 && <div className="review-face-tabs" role="group" aria-label="落点靶位">
        {Array.from({ length: target.face_count }, (_, index) => index + 1).map(item => <button type="button" key={item}
          aria-pressed={face === item} onClick={() => { setFace(item); setSelected(null); }}>{item} 号靶</button>)}
      </div>}
      <div className="review-spatial-stage">
        <div className="review-spatial-primary">
          <TargetFace target={target} face={face} arrows={plotted} selected={chosenPoint?.id} review zoomable={plotted.length > 0}
            resetKey={String(activeGroup ?? 'all')}
            overlay={ring && <g pointerEvents="none" aria-hidden="true">
              <circle cx={ring.x} cy={-ring.y} r={ring.radius} fill="none" stroke="#fff" strokeWidth="3.5" vectorEffect="non-scaling-stroke" />
              <circle data-spread-ring cx={ring.x} cy={-ring.y} r={ring.radius} fill="none" stroke="#126256" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
            </g>}
            annotation={outerPoint && <circle data-spatial-outlier cx={outerPoint.x} cy={-outerPoint.y} r=".054" fill="none"
              stroke="#ac4d18" strokeWidth="2.3" vectorEffect="non-scaling-stroke" pointerEvents="none" aria-hidden="true" />} />
          {!plotted.length && <p className="review-spatial-empty">未记录落点</p>}
        </div>
        <dl className="review-spatial-readout" aria-label="当前靶面数据" aria-live="polite">
          <div><dt>{activeGroup === null ? '本场数据' : groupLabel(activeGroup)}</dt><dd>{arrows.length} 箭</dd></div>
          <div><dt>{activeGroup === null ? '总偏向' : '本组偏向'}</dt>
            <dd>{bias && <BiasCross point={bias} bound={bound} />}{bias ? offsetLabels(bias, scale, unit).map(text => <span key={text}>{text}</span>) : '—'}</dd>
          </div>
          <div><dt>散布</dt><dd>{diameter === null ? '—' : showDistance(diameter)}</dd></div>
          <div><dt>均环</dt><dd>{average}</dd></div>
        </dl>
      </div>
      {(trusted.length || reference.length) > 0 && <p className="review-spatial-coverage">
        已确认落点 {trusted.length}{reference.length ? ` · 照片参考 ${reference.length}` : ''}
        {target.face_count > 1 ? ' · 均环按所有靶位' : ''}
      </p>}
      {outlier && outerPoint && <div className="review-spatial-outlier">
        <strong>最外一箭 · {groupLabel(outerPoint.group)}第 {outerPoint.order} 箭</strong>
        <p>散布 {showDistance(outlier.before)}，仅排除该点观察为 {showDistance(outlier.after)}</p>
      </div>}
      {activeGroup !== null && <div className="review-arrow-order">
        <label className="review-order-toggle"><input type="checkbox" checked={order} onChange={event => setOrder(event.target.checked)} />查看录入箭序</label>
        {order && <>
          <div className="review-arrow-list" role="group" aria-label="录入箭序">{arrows.map((arrow, index) => <button
            type="button" key={arrow.id} aria-pressed={arrow.id === selected} onClick={() => {
              if (trustedSet.has(arrow) || coverage.estimated.includes(arrow)) setFace(arrow.face);
              setSelected(arrow.id === selected ? null : arrow.id);
            }}>{index + 1} · {arrow.code}</button>)}</div>
          {chosen && <p className="review-spatial-coverage" aria-live="polite">第 {arrows.indexOf(chosen) + 1} 箭 · {chosen.code} · {sourceLabel[chosen.source]}{chosenPoint ? '' : ' · 无落点'}</p>}
        </>}
      </div>}
    </section>
    <section id="session-group-bias" className="vx-card review-session-bias">
      <div className="vx-card-head"><h2 tabIndex={-1}>各组偏向</h2>{bias && <span>蓝点 · 平均落点</span>}</div>
      <div className="review-bias-groups" role="group" aria-label="选择组别查看靶面">
        {centers.map(({ index, point }) => <button key={index} type="button" aria-pressed={activeGroup === index}
          onClick={() => chooseGroup(index, true)}>
          <strong>{groupLabel(index)}</strong>
          {point && <BiasCross point={point} bound={bound} />}
          {offsetLabels(point, scale, unit).map(text => <span key={text}>{text}</span>)}
        </button>)}
      </div>
    </section>
  </>;
}
