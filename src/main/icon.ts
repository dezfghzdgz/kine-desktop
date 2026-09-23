import { nativeImage, type NativeImage } from 'electron';
import { hexToRgbTriplet } from '../shared/plan';

/**
 * Ikona appky v barvě Kine, kterou si hráč vybral (5x klik na logo).
 *
 * Ikony v build/ jsou nakreslené v tyrkysu Kine (#00c9a7) na tmavém
 * podkladu (#0a0a0b, s 15 % nádechem té barvy). Podle zeleného kanálu
 * pixelu jde poznat, "kolik tyrkysu" v něm je (0 = podklad, 1 = plná
 * barva, mezi tím vyhlazené hrany) - a přesně tolik se dosadí nové barvy.
 * Průhledné rohy zaobleného čtverce se nechávají být.
 *
 * Používá se pro okna (lišta Windows), ikonu u hodin a oznámení. Ikona
 * samotného .exe a zástupce na ploše se za běhu měnit nedá - ta zůstává
 * tyrkysová.
 */
const BG = { r: 10, g: 10, b: 11 };
const TEAL_G = 201;

const cache = new Map<string, NativeImage>();

export function brandIcon(basePath: string, color: string | null): NativeImage {
  const key = `${basePath}|${color ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const base = nativeImage.createFromPath(basePath);
  const triplet = color ? hexToRgbTriplet(color) : null;
  if (base.isEmpty() || !triplet) {
    cache.set(key, base);
    return base;
  }
  const [tr, tg, tb] = triplet.split(',').map((n) => Number(n.trim()));
  const { width, height } = base.getSize();
  // Pixely po řádcích, 4 bajty; formát je pro toBitmap i createFromBitmap
  // stejný, ale pořadí (BGRA / RGBA) se pozná až z dat: v plně tyrkysovém
  // pixelu (0, 201, 167) je modrá 167 buď první, nebo třetí.
  const buf = Buffer.from(base.toBitmap());
  let blueAt = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (buf[i + 3] === 255 && buf[i + 1] >= 195) {
      blueAt = buf[i] > buf[i + 2] ? 0 : 2;
      break;
    }
  }
  const redAt = 2 - blueAt;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    // Hrany čtverce (částečně průhledné) jsou jen podklad - nechat.
    if (buf[i + 3] < 255) continue;
    const t = Math.max(0, Math.min(1, (buf[i + 1] - BG.g) / (TEAL_G - BG.g)));
    if (t <= 0.002) continue;
    buf[i + redAt] = Math.round(BG.r + (tr - BG.r) * t);
    buf[i + 1] = Math.round(BG.g + (tg - BG.g) * t);
    buf[i + blueAt] = Math.round(BG.b + (tb - BG.b) * t);
  }
  const image = nativeImage.createFromBitmap(buf, { width, height });
  cache.set(key, image);
  return image;
}

/**
 * Zmenšená kopie pro ikonu u hodin (Windows 16 px, macOS 18 px šablona).
 * Při nahrávání zápasu dostane vpravo dole červenou tečku (ne na macOS -
 * šablona je jednobarevná).
 */
export function trayIcon(icon: NativeImage, recording = false): NativeImage {
  if (icon.isEmpty()) return nativeImage.createEmpty();
  const size = process.platform === 'darwin' ? 18 : 16;
  const small = icon.resize({ width: size, height: size });
  if (process.platform === 'darwin') {
    small.setTemplateImage(true);
    return small;
  }
  return recording ? withRecordingDot(small) : small;
}

/** Červená tečka (⏺) přes pravý dolní roh - stejné bajty jako brandIcon (BGRA / RGBA se pozná z dat). */
export function withRecordingDot(icon: NativeImage): NativeImage {
  const { width, height } = icon.getSize();
  const buf = Buffer.from(icon.toBitmap());
  if (buf.length < width * height * 4) return icon;
  const r = Math.max(3, Math.round(width * 0.22));
  const cx = width - r - 1;
  const cy = height - r - 1;
  // Pořadí kanálů: Skia na Windows i Linuxu dává BGRA (modrá první), macOS RGBA.
  // (Podle barvy to tady poznat nejde - ikona už může být přebarvená na cokoli.)
  const blueAt = process.platform === 'darwin' ? 2 : 0;
  const redAt = 2 - blueAt;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r + 0.5) continue;
      const i = (y * width + x) * 4;
      // Tmavý lem kolem tečky, ať je vidět i na tyrkysu.
      const edge = d > r - 1;
      buf[i + redAt] = edge ? 20 : 255;
      buf[i + 1] = edge ? 20 : 70;
      buf[i + blueAt] = edge ? 20 : 70;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}
