/** Photo pixels are normalized to the image, not to the score canvas. */
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type Matrix = number[];
export const CONTROL_LABELS = ["上", "右", "下", "左"];
export const PLOT_CONTROLS: Quad = [{ x: .5, y: 1 / 12 }, { x: 11 / 12, y: .5 }, { x: .5, y: 11 / 12 }, { x: 1 / 12, y: .5 }];
export const inUnit = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

export function project(h: Matrix, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-9) throw new Error("校准产生无效透视，请重新定位四点");
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

/** The raw image can extend across the inverse horizon, outside the calibrated face. */
export function projectInPlot(h: Matrix, p: Point): Point | null {
  try { const result = project(h, p); return inUnit(result) ? result : null; }
  catch { return null; }
}

export function homography(from: Quad, to: Quad): Matrix {
  const a: number[][] = [];
  from.forEach(({ x, y }, i) => {
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) throw new Error("四点过近或共线，无法校准");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = col; j <= 8; j++) a[col][j] /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const ratio = a[row][col];
      for (let j = col; j <= 8; j++) a[row][j] -= ratio * a[col][j];
    }
  }
  return [...a.map(row => row[8]), 1];
}

/** Ratio is the selected ring radius relative to the scoring outer ring.
 * Canonical saved coordinates always remain on the full scoring canvas. */
export function calibrationControls(radiusRatio = 1): Quad {
  if (!Number.isFinite(radiusRatio) || radiusRatio <= 0 || radiusRatio > 1) throw new Error("校准环线比例无效");
  if (radiusRatio === 1) return PLOT_CONTROLS.map(p => ({ ...p })) as Quad;
  return PLOT_CONTROLS.map(p => ({ x: .5 + (p.x - .5) * radiusRatio, y: .5 + (p.y - .5) * radiusRatio })) as Quad;
}

export function calibration(controls: Quad, radiusRatio = 1) {
  const reference = calibrationControls(radiusRatio);
  if (!controls.every(inUnit)) throw new Error("四个控制点必须在照片内");
  for (let i = 0; i < 4; i++) {
    const a = controls[i], b = controls[(i + 1) % 4], c = controls[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < .0005 * radiusRatio * radiusRatio) throw new Error("请按上、右、下、左顺序定位，四点不能交叉或过近");
  }
  const toPlot = homography(controls, reference);
  const toImage = homography(reference, controls);
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const weights = corners.map(p => toImage[6] * p.x + toImage[7] * p.y + 1);
  if (weights.some(w => w < .05)) throw new Error("透视过强，无法可靠校正，请重新拍摄或调整控制点");
  return { toPlot, toImage };
}

export type Candidate = { id: string; point: Point; reviewed: boolean };
export type ConfirmedPhotoArrow = { id: string; plot_x_norm: number; plot_y_norm: number; target_face_index: number };
export type PhotoBatch = { confirmed: true; arrows: ConfirmedPhotoArrow[] };

export function buildPhotoBatch(candidates: Candidate[], controls: Quad, face: number, remaining: number, radiusRatio = 1): PhotoBatch {
  if (!candidates.length || candidates.length > remaining) throw new Error("请核对候选数量与本组剩余箭数");
  if (![1, 2, 3].includes(face)) throw new Error("请先选择目标靶面");
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error("箭点标识重复");
  const { toPlot } = calibration(controls, radiusRatio);
  return { confirmed: true, arrows: candidates.map(c => {
    if (!c.reviewed) throw new Error("请逐点确认所有箭点");
    if (!inUnit(c.point)) throw new Error("箭点必须在照片内");
    const p = project(toPlot, c.point);
    if (!inUnit(p)) throw new Error("箭点超出可记录白边范围，请删除该候选并用数字 M 记录，或重新校准");
    // Explicit whitelist: never serialize photo bytes, names, or calibration.
    return { id: c.id, plot_x_norm: p.x, plot_y_norm: p.y, target_face_index: face };
  }) };
}

/** Local color heuristic only; no model and no claimed recognition accuracy. */
export function locateTarget(data: Uint8ClampedArray, width: number, height: number, targetType: string): Quad | null {
  let minX = width, maxX = -1, minY = height, maxY = -1, red = 0, blue = 0;
  const yellows: Point[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 85 && r > g * 1.45 && r > b * 1.3) { red++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (b > 65 && b > r * 1.3 && b > g * 1.05) blue++;
    if (r > 115 && g > 85 && Math.min(r, g) > b * 1.5) yellows.push({ x, y });
  }
  if (red < width * height * .003 || blue < red * .1 || yellows.length < red * .03) return null;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
  if (rx < 8 || ry < 8 || rx / ry < .3 || rx / ry > 3) return null;
  if (yellows.filter(p => Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) < .55).length < red * .03) return null;
  const factor = targetType === "WA_VERTICAL_3_SPOT" ? 1.25 : 2.5;
  const controls: Quad = [{ x: cx / width, y: (cy - ry * factor) / height }, { x: (cx + rx * factor) / width, y: cy / height }, { x: cx / width, y: (cy + ry * factor) / height }, { x: (cx - rx * factor) / width, y: cy / height }];
  return controls.every(inUnit) ? controls : null;
}
