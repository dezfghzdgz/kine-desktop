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
