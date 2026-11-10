/**
 * Front-end preview of the server's manual-target scoring contract.
 *
 * The server remains the final source of truth. This module is deliberately
 * small and mirrors backend/app/scoring.py so that offline feedback and the
 * rendered target never invent a different ring score.
 */
import { PLOT_TARGET_RADIUS, resolveTargetContract } from "./target-contract";
import type { TargetContract } from "./target-contract";
export { PLOT_TARGET_RADIUS } from "./target-contract";

export function targetCoordinatesFromPlot(plotX: number, plotY: number, target?: TargetContract | string): readonly [number, number] | null {
  const plotRadius = target === undefined ? PLOT_TARGET_RADIUS : resolveTargetContract(target).plot?.outer_scoring_radius_norm;
  if (!plotRadius) throw new Error("该靶面不支持点击录入");
  const dx = plotX - 0.5;
  const dy = plotY - 0.5;
  if (Math.hypot(dx, dy) > plotRadius + 1e-12) return null;
  return [0.5 + (dx / plotRadius) * 0.5, 0.5 + (dy / plotRadius) * 0.5];
}

export function scoreFromTargetCoordinates(target: TargetContract | string, xNorm: number, yNorm: number): string {
  const contract = resolveTargetContract(target);
  if (contract.scoring_mode !== "RING_GEOMETRY" || !contract.ring_rules) throw new Error("该靶面不支持点击录入");
  const radius = Math.hypot(xNorm - 0.5, yNorm - 0.5);
  return contract.ring_rules.find(rule => radius <= rule.outer_radius_norm + 1e-12)?.score_code ?? "M";
}

export function scoreFromPlotCoordinates(contract: TargetContract | string, plotX: number, plotY: number): string {
  const target = targetCoordinatesFromPlot(plotX, plotY, contract);
  return target ? scoreFromTargetCoordinates(contract, target[0], target[1]) : "M";
}
