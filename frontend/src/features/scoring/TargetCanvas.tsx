import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Arrow } from "../../scoring-session";
import { resolveTargetContract } from "../../target-contract";
import type { TargetContract } from "../../target-contract";
import { filterArrowsForFace, targetRingVisuals } from "../../request-gate";
import { concentration } from "../model-alignment/spread-analysis";

export type TargetPoint = Readonly<{ x: number; y: number }>;

const SIZE = 120;

export function arrowsForFace(arrows: readonly Arrow[], faceIndex: number | null, faceCount: number): Arrow[] {
  return filterArrowsForFace(arrows, faceIndex, faceCount);
}

export function ringVisuals(target: TargetContract) {
  return targetRingVisuals(target);
}

export function TargetRings({ target, cx, cy, scoringRadius }: { target: TargetContract; cx: number; cy: number; scoringRadius: number }) {
  return <>{ringVisuals(target).map((rule) => {
    const radius = rule.radiusRatio * scoringRadius;
    const normalized = rule.color.toLowerCase();
    const light = normalized === "#f7f7f7" || normalized === "#f4d03f";
    return <g key={rule.score_code}>
      <circle cx={cx} cy={cy} r={radius} fill={rule.color} className="target-ring" />
      <text x={cx} y={cy - radius + 3.2} textAnchor="middle" className={light ? "ring-copy dark" : "ring-copy"}>{rule.label}</text>
    </g>;
  })}</>;
}

export function pointFromClient(rect: Pick<DOMRect, "left" | "top" | "width" | "height">, clientX: number, clientY: number) {
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
}

export function TargetCanvas({ target, arrows, faceIndex, selectedSequence, disabled, onPointSelect, onSelectArrow }: {
  target: TargetContract;
  arrows: Arrow[];
  faceIndex: number | null;
  selectedSequence: number | null;
  disabled?: boolean;
  onPointSelect(point: TargetPoint): void;
  onSelectArrow(sequence: number): void;
}) {
  const contract = resolveTargetContract(target);
  const pointerStart = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [zoom, setZoom] = useState<{x:number;y:number}|null>(null);
  if (contract.scoring_mode !== "RING_GEOMETRY" || !contract.ring_rules || !contract.plot) return null;
  const centerX = contract.plot.center_x * SIZE;
  const centerY = contract.plot.center_y * SIZE;
  const scoringRadius = contract.plot.outer_scoring_radius_norm * SIZE;
  const faceArrows = arrowsForFace(arrows, faceIndex, contract.face_count);
  const selectedArrow = faceArrows.find((arrow) => arrow.sequence === selectedSequence);
  const circle = concentration(faceArrows.filter(a=>a.score_code!=="M"&&a.plot_x_norm!==null&&a.plot_y_norm!==null).map(a=>({x:a.plot_x_norm!*SIZE,y:a.plot_y_norm!*SIZE})));
  const choose = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    const local = pointFromClient(rect, event.clientX, event.clientY);
    const point = zoom ? {x:zoom.x+local.x*.5,y:zoom.y+local.y*.5}:local;
    onPointSelect(point);
  };
  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = pointerStart.current;
    if (!start || start.id !== event.pointerId || disabled) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 6) start.moved = true;
  };
  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = pointerStart.current;
    if (!start || start.id !== event.pointerId || disabled) return;
    pointerStart.current = null;
    if (!start.moved) choose(event);
  };
  return <div className="target-canvas-wrap">
    <button className="target-zoom" type="button" disabled={disabled} onClick={()=>setZoom(zoom?null:{x:Math.max(0,Math.min(.5,(selectedArrow?.plot_x_norm??.5)-.25)),y:Math.max(0,Math.min(.5,(selectedArrow?.plot_y_norm??.5)-.25))})}>{zoom?"查看全靶":"放大查看"}</button>
    <svg className="target-canvas" viewBox={zoom?`${zoom.x*SIZE} ${zoom.y*SIZE} ${SIZE*.5} ${SIZE*.5}`:`0 0 ${SIZE} ${SIZE}`} role="application" aria-label="靶面点选区；轻点立即记录，滑动不会记分" tabIndex={disabled ? -1 : 0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointerStart.current = null; }}>
      <rect x="0" y="0" width={SIZE} height={SIZE} rx="5" className="target-board" />
      <TargetRings target={contract} cx={centerX} cy={centerY} scoringRadius={scoringRadius} />
      {circle && circle.count>1 && <circle className="live-concentration" aria-label={`集中圈覆盖${circle.included}/${circle.count}支靶内定位箭`} cx={circle.x} cy={circle.y} r={circle.radius}/>}
      <line x1={centerX - 2} y1={centerY} x2={centerX + 2} y2={centerY} className="target-cross" />
      <line x1={centerX} y1={centerY - 2} x2={centerX} y2={centerY + 2} className="target-cross" />
      {faceArrows.filter((arrow) => arrow.plot_x_norm !== null && arrow.plot_y_norm !== null).map((arrow) => <g key={arrow.id} role="button" tabIndex={disabled ? -1 : 0} aria-label={`选择第 ${arrow.sequence} 箭，${arrow.score_code}`} className={selectedSequence === arrow.sequence ? "canvas-arrow selected" : "canvas-arrow"} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!disabled) onSelectArrow(arrow.sequence); }} onKeyDown={(event) => { if (!disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelectArrow(arrow.sequence); } }}>
        <circle cx={arrow.plot_x_norm! * SIZE} cy={arrow.plot_y_norm! * SIZE} r="3" />
        <text x={arrow.plot_x_norm! * SIZE} y={arrow.plot_y_norm! * SIZE + 1.2} textAnchor="middle">{arrow.sequence}</text>
      </g>)}
    </svg>
    {circle&&circle.count>1&&<small className="circle-caption">集中圈 {circle.included}/{circle.count}箭 · 靶内定位点 · 非概率预测</small>}
  </div>;
}
