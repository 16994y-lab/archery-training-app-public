// Kept equal to scoring.ts: the drawable target has a 5/12 canvas radius.
// This module is also run directly by the no-dependency verification script.
const PLOT_TARGET_RADIUS = 5 / 12;

export type TargetCoordinate = { x: number; y: number };

export type ScatterEllipse = {
  center: TargetCoordinate;
  radiusX: number;
  radiusY: number;
  rotationDegrees: number;
};

export function hasTargetCoordinates(point: { x_norm: number | null; y_norm: number | null }): point is { x_norm: number; y_norm: number } {
  return point.x_norm !== null && point.y_norm !== null;
}

export function targetToPlot(point: TargetCoordinate): TargetCoordinate {
  return {
    x: 0.5 + (point.x - 0.5) * PLOT_TARGET_RADIUS * 2,
    y: 0.5 + (point.y - 0.5) * PLOT_TARGET_RADIUS * 2,
  };
}

/**
 * A descriptive one-standard-deviation ellipse. It is intentionally not a
 * confidence interval or a hit-probability prediction.
 */
export function scatterEllipse(points: TargetCoordinate[]): ScatterEllipse | null {
  if (points.length < 3) return null;
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const divisor = points.length - 1;
  const xx = points.reduce((sum, point) => sum + (point.x - center.x) ** 2, 0) / divisor;
  const yy = points.reduce((sum, point) => sum + (point.y - center.y) ** 2, 0) / divisor;
  const xy = points.reduce((sum, point) => sum + (point.x - center.x) * (point.y - center.y), 0) / divisor;
  const trace = xx + yy;
  const determinant = xx * yy - xy * xy;
  const root = Math.sqrt(Math.max(0, trace * trace / 4 - determinant));
  const major = Math.sqrt(Math.max(0, trace / 2 + root));
  const minor = Math.sqrt(Math.max(0, trace / 2 - root));
  return {
    center,
    radiusX: major,
    radiusY: minor,
    rotationDegrees: Math.atan2(2 * xy, xx - yy) * 90 / Math.PI,
  };
}
