import { VARIANT_TILE_INSET } from './tile-crop';

/**
 * Crop one cell out of a variant contact sheet in the browser so the picked
 * tile can show as the start frame before the upscale lands.
 *
 * Same-origin `/r2/` URLs decode without CORS. Cross-origin sheets (fal CDN,
 * storage-dev) need ACAO; callers should swallow a failure and keep the
 * previous still.
 */
export async function cropGridTileToObjectUrl(options: {
  gridUrl: string;
  index: number;
  cols: number;
  rows: number;
  inset?: number;
}): Promise<string> {
  const { gridUrl, index, cols, rows, inset = VARIANT_TILE_INSET } = options;
  const img = await loadImage(gridUrl);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const cellW = img.naturalWidth / cols;
  const cellH = img.naturalHeight / rows;
  const sx = cellW * col + cellW * inset;
  const sy = cellH * row + cellH * inset;
  const sw = Math.max(1, cellW * (1 - 2 * inset));
  const sh = Math.max(1, cellH * (1 - 2 * inset));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas context to crop variant tile');
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      0.92
    );
  });
  return URL.createObjectURL(blob);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (
      typeof location !== 'undefined' &&
      /^https?:\/\//.test(url) &&
      !url.startsWith(location.origin)
    ) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`Failed to load variant grid image: ${url}`));
    img.src = url;
  });
}
