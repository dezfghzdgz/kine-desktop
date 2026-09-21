/**
 * Názvy klipů a souborů.
 *
 * Soubor: "Kine 2026-09-21 20-14-05 CS2.mp4" - řadí se podle času, nese
 * hru, a nemá v sobě nic, co by Windows nebo macOS odmítly.
 * Název na Kine: "CS2 · klip 21. 9. 20:14" - krátký, hráč si ho může
 * v okýnku po hře přepsat.
 */

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Část názvu souboru, která nesmí obsahovat zakázané znaky ani být moc dlouhá. */
export function safeFilePart(text: string, max = 40): string {
  const cleaned = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || 'klip';
}

export function clipFileBase(at: Date, game: string | null): string {
  const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}-${pad2(at.getMinutes())}-${pad2(at.getSeconds())}`;
  return game ? `Kine ${stamp} ${safeFilePart(game)}` : `Kine ${stamp}`;
}

export function defaultClipTitle(at: Date, game: string | null, lang: 'cs' | 'en'): string {
  const time = `${at.getDate()}. ${at.getMonth() + 1}. ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const word = lang === 'cs' ? 'klip' : 'clip';
  return game ? `${game} · ${word} ${time}` : `${word[0].toUpperCase()}${word.slice(1)} ${time}`;
}

/** Hashtag ze jména hry: "Counter-Strike 2" -> "counterstrike2". */
export function gameHashtag(game: string): string {
  return game
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}
