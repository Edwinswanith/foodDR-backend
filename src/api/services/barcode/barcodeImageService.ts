/**
 * Real barcode decoding from an uploaded photo — ported in spirit (not
 * byte-for-byte) from FoodDr/backend-node's barcodeImageService.ts: same
 * approach (greyscale + multiple preprocessing passes + region tiling, tried
 * against a real decoder, no placeholder/mocked output), adapted to this
 * checkout's actual dependencies:
 *  - image preprocessing uses `jimp` (already a dependency here) instead of
 *    `sharp` (native binary, not installed in this checkout)
 *  - decoding uses only `@zxing/library` (already a dependency here); the
 *    real service's second decoder, `@undecaf/zbar-wasm`, is not installed
 *    here and is not silently swapped in — this is a real reduction in
 *    decode robustness versus prod, not hidden.
 *  - the tiling grid is reduced (center + horizontal bands + halves, not the
 *    full 3x3 overlapping grid) to keep a single scan request fast without
 *    the zbar fallback to lean on.
 */
import { Jimp } from "jimp";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import AppError from "../../core/error-handler";
import { ERROR_MESSAGE } from "../../constants";
import { normalizeBarcode, validateBarcode } from "./barcodeService";

const SUPPORTED_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
];

function createReader(): MultiFormatReader {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DecodeHit {
  text: string;
  format: string;
}

/** Greyscale + optional crop/resize/rotate/contrast, then extract a 1-channel luminance plane. */
async function toLuminancePlane(
  buffer: Buffer,
  opts: { region?: Region; resizeWidth?: number; rotateDeg?: number; contrast?: boolean } = {},
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = await Jimp.fromBuffer(buffer);
  // Mutate in place (Jimp v1 methods return `this`) — re-assigning `img` across
  // these calls confuses TS's generic method-chain inference on this Jimp version.
  if (opts.rotateDeg) img.rotate(opts.rotateDeg);
  if (opts.region) img.crop(opts.region);
  if (opts.resizeWidth && img.width !== opts.resizeWidth) {
    const scale = opts.resizeWidth / img.width;
    img.resize({ w: opts.resizeWidth, h: Math.max(1, Math.round(img.height * scale)) });
  }
  img.greyscale();
  if (opts.contrast) img.contrast(0.3);

  const { width, height, data } = img.bitmap; // RGBA after greyscale (R === G === B)
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < luminance.length; i += 1) {
    luminance[i] = data[i * 4] as number;
  }
  return { data: luminance, width, height };
}

function decodeFromLuminance(luminance: Uint8ClampedArray, width: number, height: number): DecodeHit | null {
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      const source = new RGBLuminanceSource(luminance, width, height);
      const bitmap = new BinaryBitmap(new Binarizer(source));
      const result = createReader().decode(bitmap);
      return { text: normalizeBarcode(result.getText()), format: BarcodeFormat[result.getBarcodeFormat()] };
    } catch {
      // try the next binarizer
    }
  }
  return null;
}

async function decodeVariant(buffer: Buffer, opts: Parameters<typeof toLuminancePlane>[1]): Promise<DecodeHit | null> {
  const { data, width, height } = await toLuminancePlane(buffer, opts);
  return decodeFromLuminance(data, width, height);
}

function cropRegions(width: number, height: number): Region[] {
  const out: Region[] = [];
  const push = (x: number, y: number, w: number, h: number): void => {
    const cx = Math.max(0, Math.round(x));
    const cy = Math.max(0, Math.round(y));
    const cw = Math.min(width - cx, Math.round(w));
    const ch = Math.min(height - cy, Math.round(h));
    if (cw > 20 && ch > 20) out.push({ x: cx, y: cy, w: cw, h: ch });
  };
  push(width * 0.2, height * 0.2, width * 0.6, height * 0.6); // center 60%
  for (const f of [0, 1 / 3, 2 / 3]) push(0, height * f, width, height / 3); // horizontal bands
  push(0, 0, width / 2, height); // left half
  push(width / 2, 0, width / 2, height); // right half
  return out;
}

export interface DecodedBarcode {
  barcode: string;
  format: string;
}

export async function detectBarcodeFromImage(buffer: Buffer): Promise<DecodedBarcode> {
  if (!buffer?.length) {
    throw new AppError(ERROR_MESSAGE.SCAN_IMAGE_REQUIRED, [], 400);
  }

  const finalize = (hit: DecodeHit): DecodedBarcode => {
    const validation = validateBarcode(hit.text);
    if (!validation.valid) {
      throw new AppError(ERROR_MESSAGE.BARCODE_FORMAT_INVALID_SHORT, [], 400);
    }
    return { barcode: hit.text, format: hit.format };
  };

  const attempts: Parameters<typeof toLuminancePlane>[1][] = [
    {},
    { contrast: true },
    { resizeWidth: 1600, contrast: true },
    { resizeWidth: 2200, contrast: true },
    { rotateDeg: 90 },
    { rotateDeg: 180 },
    { rotateDeg: 270 },
  ];
  for (const attempt of attempts) {
    try {
      const hit = await decodeVariant(buffer, attempt);
      if (hit) return finalize(hit);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // try the next preprocessing variant
    }
  }

  // Region tiling — isolate + upscale a small barcode within a cluttered photo.
  try {
    const base = await Jimp.fromBuffer(buffer);
    const regions = cropRegions(base.width, base.height);
    for (const region of regions) {
      try {
        const hit = await decodeVariant(buffer, { region, resizeWidth: 1400, contrast: true });
        if (hit) return finalize(hit);
      } catch (error) {
        if (error instanceof AppError) throw error;
        // skip this tile
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
  }

  throw new AppError(ERROR_MESSAGE.BARCODE_NOT_DETECTED, [], 400);
}
