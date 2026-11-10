import { scatterOutline } from '../features/model-alignment/scatter-outline';

export type SpatialPoint = { x: number; y: number };

const distance = (a: SpatialPoint, b: SpatialPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const area = (a: SpatialPoint, b: SpatialPoint, c: SpatialPoint) =>
  Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

function farthestPair(points: readonly SpatialPoint[]) {
  const hull = scatterOutline(points);
  if (!hull.length) return null;
  if (hull.length === 1) return { distance: 0, endpoints: [hull[0]] };
  if (hull.length === 2) return { distance: distance(hull[0], hull[1]), endpoints: hull };

  // The farthest pair lies on the convex hull. Its antipodal vertex advances
  // around the hull as each edge turns, so even a large session stays bounded.
  let best = 0;
  let endpoints = [hull[0], hull[1]];
  const consider = (a: SpatialPoint, b: SpatialPoint) => {
    const candidate = distance(a, b);
    if (candidate > best) {
      best = candidate;
      endpoints = [a, b];
    }
  };
  let opposite = 1;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const next = () => (opposite + 1) % hull.length;
    while (area(a, b, hull[next()]) > area(a, b, hull[opposite])) opposite = next();
    consider(a, hull[opposite]);
    consider(b, hull[opposite]);
    if (area(a, b, hull[next()]) === area(a, b, hull[opposite])) {
      consider(a, hull[next()]);
      consider(b, hull[next()]);
    }
  }
  return { distance: best, endpoints };
}

export function spatialDiameter(points: readonly SpatialPoint[]): number | null {
  return points.length > 1 ? farthestPair(points)?.distance ?? null : null;
}

export function spatialCenter(points: readonly SpatialPoint[]): SpatialPoint | null {
  if (!points.length) return null;
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function clearSpatialOutlier(points: readonly SpatialPoint[]) {
  if (points.length < 5 || points.length > 1500) return null;
  const pair = farthestPair(points);
  if (!pair || pair.distance <= 0) return null;
  const matches: { index: number; before: number; after: number }[] = [];

  for (const candidate of pair.endpoints) {
    const index = points.indexOf(candidate);
    const rest = points.filter((_, position) => position !== index);
    const after = spatialDiameter(rest);
    if (after === null || after > pair.distance * .65) continue;

    const nearest = rest.map(() => Infinity);
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const gap = distance(rest[i], rest[j]);
        nearest[i] = Math.min(nearest[i], gap);
        nearest[j] = Math.min(nearest[j], gap);
      }
    }
    nearest.sort((a, b) => a - b);
    const mid = Math.floor(nearest.length / 2);
    const typical = nearest.length % 2 ? nearest[mid] : (nearest[mid - 1] + nearest[mid]) / 2;
    const isolation = rest.reduce((min, point) => Math.min(min, distance(candidate, point)), Infinity);
    if (isolation > 0 && isolation >= typical * 2) matches.push({ index, before: pair.distance, after });
  }
  return matches.length === 1 ? matches[0] : null;
}
