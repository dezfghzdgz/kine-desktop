import type { LiveCameraPosition, LiveCameraShape, LiveCameraSize } from './types';

/**
 * Kde a jak velká je kamera ve vysílání - stejná čísla pro kreslení do
 * vysílání (renderer/liveCompositor.ts) i pro náhled v záložce Živě, ať
 * hráč vidí přesně to, co diváci. Čistá funkce - má test.
 */

/** Šířka kamery jako podíl šířky obrazu. */
export const CAMERA_WIDTH: Record<LiveCameraSize, number> = { small: 0.18, medium: 0.25, large: 0.33 };

export type CameraRect = {
  /** Kam do obrazu (px). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Jaký výřez z kamery (px kamery) - kruh bere čtverec ze středu. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Zaoblení rohů (kruh = polovina šířky). */
  radius: number;
};

export function cameraRect(
  frameW: number,
  frameH: number,
  camW: number,
  camH: number,
  cam: { position: LiveCameraPosition; size: LiveCameraSize; shape: LiveCameraShape }
): CameraRect {
  const W = Math.max(2, frameW);
  const H = Math.max(2, frameH);
  const cw = camW > 0 ? camW : 1280;
  const ch = camH > 0 ? camH : 720;
  let w = Math.round(W * (CAMERA_WIDTH[cam.size] ?? CAMERA_WIDTH.medium));
  let sx = 0;
  let sy = 0;
  let sw = cw;
  let sh = ch;
  let h: number;
  if (cam.shape === 'circle') {
    // Kruh: čtverec ze středu kamery (obličej bývá uprostřed).
    const side = Math.min(cw, ch);
    sx = (cw - side) / 2;
    sy = (ch - side) / 2;
    sw = side;
    sh = side;
    h = w;
  } else {
    h = Math.round((w * ch) / cw);
  }
  // Kamera nikdy nezabere víc než polovinu výšky (kamera na výšku, obraz 21:9…).
  const maxH = Math.round(H * 0.5);
  if (h > maxH) {
    w = Math.max(2, Math.round((w * maxH) / h));
    h = maxH;
  }
  const margin = Math.round(Math.min(W, H) * 0.03);
  const x = cam.position.endsWith('left') ? margin : W - w - margin;
  const y = cam.position.startsWith('top') ? margin : H - h - margin;
  const radius = cam.shape === 'circle' ? w / 2 : cam.shape === 'rounded' ? Math.round(Math.min(w, h) * 0.12) : 0;
  return { x, y, w, h, sx, sy, sw, sh, radius };
}
