/** Canon SELPHY CP1500 postcard — true 6×4-class stock is 148 × 100 mm, not 6×4 inch. */
export const SELPHY_POSTCARD_W_MM = 148;
export const SELPHY_POSTCARD_H_MM = 100;

export interface PhysicalPhotoCrop {
  /** 1 = fill the frame (cover). Higher zooms in and crops more. */
  zoom: number;
  /** Horizontal offset in the crop window, −1 … 1. */
  panX: number;
  /** Vertical offset in the crop window, −1 … 1. */
  panY: number;
}

export const PHYSICAL_PHOTO_CROP_DEFAULT: PhysicalPhotoCrop = {
  zoom: 1,
  panX: 0,
  panY: 0,
};

export interface PhysicalSheetLayoutMm {
  pageWmm: number;
  pageHmm: number;
  cellWmm: number;
  cellHmm: number;
  gapMm: number;
  marginXMm: number;
  marginYMm: number;
  fits: boolean;
}

/** Place two exact-cm cells on the postcard; leftover space becomes gap + margins. */
export function autoPhysicalSheetMm(cellWidthCm: number, cellHeightCm: number): PhysicalSheetLayoutMm {
  const cellWmm = Number(cellWidthCm) * 10;
  const cellHmm = Number(cellHeightCm) * 10;
  const pageWmm = SELPHY_POSTCARD_W_MM;
  const pageHmm = SELPHY_POSTCARD_H_MM;
  const leftoverW = pageWmm - cellWmm * 2;
  const leftoverH = pageHmm - cellHmm;
  const gapMm = leftoverW >= 8 ? 4 : Math.max(0, leftoverW * 0.2);
  const marginXMm = Math.max(0, (leftoverW - gapMm) / 2);
  const marginYMm = Math.max(0, leftoverH / 2);
  return {
    pageWmm,
    pageHmm,
    cellWmm,
    cellHmm,
    gapMm,
    marginXMm,
    marginYMm,
    fits: leftoverW >= -0.25 && leftoverH >= -0.25,
  };
}

export function clampPhysicalCrop(crop?: Partial<PhysicalPhotoCrop> | null): PhysicalPhotoCrop {
  const z = Number(crop?.zoom);
  const x = Number(crop?.panX);
  const y = Number(crop?.panY);
  return {
    zoom: Number.isFinite(z) ? Math.min(4, Math.max(1, z)) : 1,
    panX: Number.isFinite(x) ? Math.min(1, Math.max(-1, x)) : 0,
    panY: Number.isFinite(y) ? Math.min(1, Math.max(-1, y)) : 0,
  };
}

export interface PhysicalCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Window into a rotated photo that covers `safeW` × `safeH` at zoom 1.
 * `rw`/`rh` are the photo size after ±90° rotation.
 */
export function computeRotatedCrop(
  rw: number,
  rh: number,
  safeW: number,
  safeH: number,
  crop?: Partial<PhysicalPhotoCrop> | null,
): PhysicalCropRect {
  const { zoom, panX, panY } = clampPhysicalCrop(crop);
  const srcW = Math.max(1, rw);
  const srcH = Math.max(1, rh);
  const destW = Math.max(1, safeW);
  const destH = Math.max(1, safeH);
  const cover = Math.max(destW / srcW, destH / srcH);
  const scale = cover * zoom;
  const safeAr = destW / destH;
  let visW = Math.min(srcW, destW / scale);
  let visH = Math.min(srcH, destH / scale);
  if (visW / visH > safeAr) visW = visH * safeAr;
  else visH = visW / safeAr;
  visW = Math.min(srcW, Math.max(1, visW));
  visH = Math.min(srcH, Math.max(1, visH));
  const maxL = Math.max(0, srcW - visW);
  const maxT = Math.max(0, srcH - visH);
  const left = Math.round(Math.min(maxL, Math.max(0, maxL / 2 + panX * (maxL / 2))));
  const top = Math.round(Math.min(maxT, Math.max(0, maxT / 2 + panY * (maxT / 2))));
  const width = Math.max(1, Math.min(Math.round(visW), srcW - left));
  const height = Math.max(1, Math.min(Math.round(visH), srcH - top));
  return { left, top, width, height };
}
