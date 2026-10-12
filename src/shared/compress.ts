/**
 * Zmenšování klipů (Klipy -> úložiště nahoře): klip se překóduje menším
 * datovým tokem (libx264, CRF), zvuk zůstane, jak je. Nahrává se ve vysoké
 * kvalitě (kolem 20 Mb/s), aby šel klip hned sdílet - na disku pak 80
 * klipů zabere i 4 GB. Po zmenšení je to typicky třetina až polovina.
 *
 * Čistý modul (bez electronu a ffmpegu) - odhad úspory pro okno, výběr
 * klipů a argumenty ffmpegu. Spouští to src/main/compress.ts.
 */

export type CompressLevel = 'light' | 'medium' | 'strong';
export const COMPRESS_LEVELS: readonly CompressLevel[] = ['light', 'medium', 'strong'];

/**
 * light  - skoro nepoznáš rozdíl (CRF 23, rozlišení zůstane)
 * medium - doporučeno (CRF 26, nejvýš 1080p)
 * strong - nejmenší (CRF 28, nejvýš 720p)
 */
export const LEVEL_SETTINGS: Record<CompressLevel, { crf: number; maxHeight: number | null; rank: number }> = {
  light: { crf: 23, maxHeight: null, rank: 1 },
  medium: { crf: 26, maxHeight: 1080, rank: 2 },
  strong: { crf: 28, maxHeight: 720, rank: 3 },
};

/** Co klip o zmenšení ví (Clip.compressed). */
export type CompressedInfo = { level: CompressLevel; at: string; originalBytes: number };

export type CompressCandidateInput = {
  id: string;
  file: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  deletedAt?: string;
  compressed?: CompressedInfo;
  audioTracks?: string[];
  upload?: { state: string } | null;
};

/** Zvuk se nepřekódovává - počítá se s ~160 kb/s na stopu. */
const AUDIO_KBPS_PER_TRACK = 160;

/**
 * Odhad datového toku obrazu (kb/s) po překódování: 1080p60 s CRF 23 hraje
 * kolem 9 Mb/s; jiné rozlišení a snímky podle počtu pixelů za sekundu
 * (mocnina 0,75 - větší obraz se komprimuje líp), každých +6 CRF polovina.
 */
export function estimateVideoKbps(width: number, height: number, fps: number, crf: number): number {
  const pixelRate = Math.max(1, width * height * fps);
  const base = 9000 * Math.pow(pixelRate / (1920 * 1080 * 60), 0.75);
  return Math.max(300, base * Math.pow(2, (23 - crf) / 6));
}

/** Rozměry po zmenšení (výška nejvýš maxHeight, šířka sudá, poměr zůstane). */
export function targetSize(width: number | null, height: number | null, maxHeight: number | null): { width: number; height: number } {
  const w = width && width > 0 ? width : 1920;
  const hgt = height && height > 0 ? height : 1080;
  if (!maxHeight || hgt <= maxHeight) return { width: w, height: hgt };
  const scale = maxHeight / hgt;
  return { width: Math.max(2, Math.round((w * scale) / 2) * 2), height: maxHeight };
}

/** Odhad velikosti klipu po zmenšení (bajty) - nikdy víc než teď. */
export function estimateCompressedBytes(clip: Pick<CompressCandidateInput, 'sizeBytes' | 'durationSeconds' | 'width' | 'height' | 'audioTracks'>, level: CompressLevel, fps = 60): number {
  const duration = clip.durationSeconds > 0 ? clip.durationSeconds : 0;
  if (duration <= 0 || clip.sizeBytes <= 0) return Math.max(0, clip.sizeBytes);
  const settings = LEVEL_SETTINGS[level];
  const size = targetSize(clip.width, clip.height, settings.maxHeight);
  const tracks = Math.max(1, clip.audioTracks?.length ?? 1);
  const kbps = estimateVideoKbps(size.width, size.height, fps, settings.crf) + AUDIO_KBPS_PER_TRACK * tracks;
  return Math.min(clip.sizeBytes, Math.round((kbps * 1000 * duration) / 8));
}

/** Zmenšení se nevyplatí pod tuhle úsporu (a u menších klipů). */
const MIN_SAVING_RATIO = 0.15;
const MIN_SAVING_BYTES = 2 * 1024 * 1024;

export type CompressSkip = 'trash' | 'webm' | 'uploading' | 'done' | 'small';

/** Proč se klip zmenšovat nebude (null = bude). */
export function compressSkipReason(clip: CompressCandidateInput, level: CompressLevel): CompressSkip | null {
  if (clip.deletedAt) return 'trash';
  // WebM (starší záznam) by se musel překódovat jinak a změnil by příponu - nech být.
  if (!/\.mp4$/i.test(clip.file)) return 'webm';
  const up = clip.upload?.state;
  if (up && up !== 'done' && up !== 'error' && up !== 'failed') return 'uploading';
  if (clip.compressed && LEVEL_SETTINGS[clip.compressed.level].rank >= LEVEL_SETTINGS[level].rank) return 'done';
  const estimate = estimateCompressedBytes(clip, level);
  const saving = clip.sizeBytes - estimate;
  if (saving < MIN_SAVING_BYTES || saving < clip.sizeBytes * MIN_SAVING_RATIO) return 'small';
  return null;
}

export type CompressSummary = { count: number; bytes: number; estimatedBytes: number; savingBytes: number; ids: string[] };

/** Které klipy jde zmenšit a kolik by se ušetřilo (pro okno a pro spuštění). */
export function compressSummary(clips: CompressCandidateInput[], level: CompressLevel): CompressSummary {
  const out: CompressSummary = { count: 0, bytes: 0, estimatedBytes: 0, savingBytes: 0, ids: [] };
  for (const clip of clips) {
    if (compressSkipReason(clip, level) !== null) continue;
    const estimate = estimateCompressedBytes(clip, level);
    out.count++;
    out.bytes += clip.sizeBytes;
    out.estimatedBytes += estimate;
    out.savingBytes += clip.sizeBytes - estimate;
    out.ids.push(clip.id);
  }
  return out;
}

/**
 * Argumenty ffmpegu: obraz libx264 s CRF úrovně (a zmenšený na výšku úrovně,
 * když je větší), všechny zvukové stopy beze změny, metadata a kapitoly
 * zůstanou, průběh na stdout (-progress). threads = ať zbyde výkon na
 * ostatní programy (běží na pozadí).
 */
export function compressArgs(input: string, output: string, level: CompressLevel, info: { height: number | null; threads: number }): string[] {
  const settings = LEVEL_SETTINGS[level];
  // -hide_banner a -nostdin přidává spawnFfmpeg sám.
  const args = ['-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', input];
  args.push('-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0');
  if (settings.maxHeight && info.height && info.height > settings.maxHeight) args.push('-vf', `scale=-2:${settings.maxHeight}`);
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(settings.crf), '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'copy', '-movflags', '+faststart', '-threads', String(Math.max(1, Math.round(info.threads))));
  args.push(output);
  return args;
}

/** Dočasný soubor vedle klipu (stejný disk = výměna jedním přejmenováním). */
export function compressTempPath(file: string): string {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const dir = file.slice(0, slash + 1);
  const name = file.slice(slash + 1).replace(/\.mp4$/i, '');
  return `${dir}.${name}.kine-small.mp4`;
}

/**
 * Je zmenšený soubor v pořádku? Stejná délka (±1 s nebo 2 %), má obraz
 * a je opravdu menší (aspoň o 8 %) - jinak se původní klip nechá.
 */
export function compressedOk(original: { bytes: number; durationSeconds: number }, result: { bytes: number; durationSeconds: number | null; hasVideo: boolean }): 'ok' | 'broken' | 'not-smaller' {
  if (!result.hasVideo || !result.bytes || result.durationSeconds === null) return 'broken';
  const tolerance = Math.max(1, original.durationSeconds * 0.02);
  if (original.durationSeconds > 0 && Math.abs(result.durationSeconds - original.durationSeconds) > tolerance) return 'broken';
  if (result.bytes > original.bytes * 0.92) return 'not-smaller';
  return 'ok';
}
