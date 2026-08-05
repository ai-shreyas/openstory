import { describe, expect, it } from 'vitest';
import { parseImageDimensions } from './image-crop';

/** Minimal valid PNG header (IHDR only — enough for dimension parse). */
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  // PNG signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + type
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

/** Minimal JPEG with APP0 + SOF0 carrying dimensions. */
function makeJpeg(width: number, height: number): Uint8Array {
  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    // APP0 (JFIF) — length 16
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // SOF0 — length 11, precision 8, height, width, 1 component
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x11,
    0x00,
    // EOI
    0xff,
    0xd9,
  ];
  return new Uint8Array(bytes);
}

/** Minimal VP8X WebP with canvas size fields. */
function makeWebpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  // RIFF....WEBP
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x16, 0x00, 0x00, 0x00], 4); // chunk size (dummy)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16); // chunk size 10
  bytes.set([0x00, 0x00, 0x00, 0x00], 20); // flags + reserved
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe('parseImageDimensions (#1076)', () => {
  it('reads PNG IHDR width/height', () => {
    expect(parseImageDimensions(makePng(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('reads JPEG SOF0 width/height (model grids are often JPEG)', () => {
    expect(parseImageDimensions(makeJpeg(1536, 1536))).toEqual({
      width: 1536,
      height: 1536,
    });
  });

  it('reads WebP VP8X canvas width/height', () => {
    expect(parseImageDimensions(makeWebpVp8x(1024, 576))).toEqual({
      width: 1024,
      height: 576,
    });
  });

  it('returns null for unknown / truncated bytes', () => {
    expect(parseImageDimensions(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(parseImageDimensions(new Uint8Array(0))).toBeNull();
  });
});
