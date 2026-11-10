import { project } from "./photo-geometry";
import type { Matrix } from "./photo-geometry";

export type LocalPhoto = { canvas: HTMLCanvasElement; url: string; dispose: () => void };

export async function canvasPhoto(canvas: HTMLCanvasElement): Promise<LocalPhoto> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("照片预览失败")), "image/jpeg", .92));
  const url = URL.createObjectURL(blob);
  return { canvas, url, dispose: () => { URL.revokeObjectURL(url); canvas.width = canvas.height = 0; } };
}

export async function importPhoto(file: File, maxLongEdge = 1600): Promise<LocalPhoto> {
  if (!Number.isInteger(maxLongEdge) || maxLongEdge < 32 || maxLongEdge > 1600) throw new Error("照片工作尺寸无效");
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("请选择 JPEG、PNG 或 WebP 照片；HEIC 请先在设备上转换");
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("请选择不超过 20 MB 的照片");
  const url = URL.createObjectURL(file);
  const img = new Image();
  let canvas: HTMLCanvasElement;
  try {
    img.src = url;
    await img.decode().catch(() => { throw new Error("照片无法解码，请重新选择或拍摄"); });
    if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error("照片像素过大，请缩小后导入（最多 4000 万像素）");
    const scale = Math.min(1, maxLongEdge / Math.max(img.naturalWidth, img.naturalHeight));
    canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally { img.src = ""; URL.revokeObjectURL(url); }
  // The decoded original is no longer referenced during preview encoding or ORT work.
  return canvasPhoto(canvas);
}

export async function rotatePhoto(photo: LocalPhoto): Promise<LocalPhoto> {
  const canvas = document.createElement("canvas");
  canvas.width = photo.canvas.height; canvas.height = photo.canvas.width;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(photo.canvas, 0, 0);
  return canvasPhoto(canvas);
}

/** Inverse projective sampling, with bilinear interpolation. Yield between strips. */
export async function rectifyPhoto(source: HTMLCanvasElement, target: HTMLCanvasElement, toImage: Matrix, signal: AbortSignal) {
  const size = 480;
  const pixels = source.getContext("2d")!.getImageData(0, 0, source.width, source.height);
  const output = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    if (y % 40 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (signal.aborted) return; }
    for (let x = 0; x < size; x++) {
      const p = project(toImage, { x: x / (size - 1), y: y / (size - 1) });
      const sx = p.x * (source.width - 1), sy = p.y * (source.height - 1), dst = (y * size + x) * 4;
      output.data[dst + 3] = 255;
      if (sx < 0 || sx >= source.width - 1 || sy < 0 || sy >= source.height - 1) {
        output.data[dst] = output.data[dst + 1] = output.data[dst + 2] = 225; continue;
      }
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      for (let c = 0; c < 3; c++) {
        const i = (iy * source.width + ix) * 4 + c;
        output.data[dst + c] = pixels.data[i] * (1 - fx) * (1 - fy) + pixels.data[i + 4] * fx * (1 - fy) + pixels.data[i + source.width * 4] * (1 - fx) * fy + pixels.data[i + source.width * 4 + 4] * fx * fy;
      }
    }
  }
  if (signal.aborted) return;
  target.width = target.height = size;
  target.getContext("2d")!.putImageData(output, 0, 0);
}
