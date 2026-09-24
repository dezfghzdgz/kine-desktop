/**
 * Pomocníci k nahrávání na Kine, společní hlavnímu procesu a oknům
 * (bez Electronu, testovatelné).
 */

/**
 * "#Klip, cs2 mirage" -> ["klip", "cs2", "mirage"]: bez #, malými písmeny,
 * jen písmena (i s diakritikou - web je bere taky), čísla a podtržítko,
 * bez dvojic, nejvýš 15 po 30 znacích.
 */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').split(/[\s,#]+/)) {
    const tag = raw.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 30);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 15) break;
  }
  return out;
}

/** Hashtagy zpátky do pole: "klip counterstrike2 kine". */
export function formatHashtags(tags: string[]): string {
  return tags.map((t) => `#${t}`).join(' ');
}

/** Čas kapitoly jako na YouTube: "3:12", "1:02:03". */
export function chapterTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Značka vzniká ve chvíli, kdy hráč zmáčkne klip - to, co chtěl uložit, se
 * stalo těsně předtím. Přehrávač i kapitoly proto začínají kousek před ní.
 */
export const MARKER_LEAD_SECONDS = 10;

/**
 * Značky z nahrávky zápasu jako kapitoly pro Kine: "0:00 <začátek>" a pak
 * značky po sobě (každá kousek před okamžikem uložení), aspoň 10 s od
 * sebe (dva klipy během vteřiny = jedna kapitola), jen uvnitř nahrávky.
 * Méně než dvě kapitoly = žádné.
 */
export function markerChapters(markers: { time: number; label: string }[] | undefined, startLabel: string, durationSeconds?: number): { time: number; title: string }[] {
  if (!markers || markers.length === 0) return [];
  const out: { time: number; title: string }[] = [{ time: 0, title: startLabel }];
  for (const m of [...markers].sort((a, b) => a.time - b.time)) {
    const time = Math.floor(Math.max(0, m.time - MARKER_LEAD_SECONDS));
    if (time < 10) continue;
    if (durationSeconds && time >= durationSeconds) continue;
    if (time - out[out.length - 1].time < 10) continue;
    out.push({ time, title: String(m.label || '').trim().slice(0, 100) || startLabel });
  }
  return out.length >= 2 ? out : [];
}

/** Kapitoly jako řádky do popisu videa ("0:00 Začátek\n3:12 Triple kill"). */
export function chaptersText(chapters: { time: number; title: string }[]): string {
  return chapters.map((c) => `${chapterTime(c.time)} ${c.title}`).join('\n');
}
