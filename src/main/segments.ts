/**
 * Zásobník posledních sekund jako řada kousků (segmentů) na disku.
 *
 * Obraz teče z prohlížečové části (MediaRecorder, jeden souvislý WebM
 * proud) do ffmpeg, který ho bez překódování krájí po klíčových snímcích
 * na krátké soubory a zapisuje seznam hotových kousků (CSV: soubor,
 * začátek, konec v sekundách od startu proudu). Tady se ten seznam
 * převádí na časovou osu v "hodinách počítače" a vybírají se kousky pro
 * klip. Čistá logika bez electronu - má test.
 */

export type Segment = {
  /** Cesta k souboru (absolutní). */
  file: string;
  /** Začátek a konec podle hodin počítače (ms od epochy). */
  startWall: number;
  endWall: number;
  generation: number;
};

export type CsvRow = { file: string; start: number; end: number };

/** Řádky CSV od ffmpeg (-segment_list_type csv): soubor,začátek,konec. */
export function parseSegmentCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Název souboru může v teorii obsahovat čárku, čísla ne - proto se
    // bere odzadu.
    const lastComma = trimmed.lastIndexOf(',');
    const secondComma = trimmed.lastIndexOf(',', lastComma - 1);
    if (lastComma < 0 || secondComma < 0) continue;
    const file = trimmed.slice(0, secondComma);
    const start = Number(trimmed.slice(secondComma + 1, lastComma));
    const end = Number(trimmed.slice(lastComma + 1));
    if (!file || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    rows.push({ file, start, end });
  }
  return rows;
}

/** Převede řádek CSV na kousek s časy podle hodin počítače. */
export function toSegment(row: CsvRow, generation: number, generationStartWall: number, dir: string, join: (a: string, b: string) => string): Segment {
  return {
    file: join(dir, row.file),
    startWall: generationStartWall + row.start * 1000,
    endWall: generationStartWall + row.end * 1000,
    generation,
  };
}

/**
 * Kousky pro klip končící v čase endWall a sahající `seconds` zpět.
 *
 * Vrací kousky, které se s oknem překrývají, seřazené podle času. První
 * kousek může začínat až o délku kousku dřív, než okno - klip je tedy
 * o nejvýš pár sekund delší, ne kratší. Konec je přesný: nahrávání se ve
 * chvíli stisku zastaví a poslední kousek končí právě tam.
 */
export function selectForClip(segments: Segment[], endWall: number, seconds: number): Segment[] {
  const startWall = endWall - seconds * 1000;
  return segments
    .filter((s) => s.endWall > startWall && s.startWall < endWall)
    .sort((a, b) => a.startWall - b.startWall);
}

/** Celková délka vybraných kousků v sekundách. */
export function totalSeconds(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.endWall - s.startWall) / 1000, 0);
}

/**
 * Které kousky už jsou k ničemu: skončily dřív než (teď - keepSeconds).
 * Volá se po každém novém kousku, ať zásobník na disku neroste.
 */
export function expired(segments: Segment[], nowWall: number, keepSeconds: number): Segment[] {
  const limit = nowWall - keepSeconds * 1000;
  return segments.filter((s) => s.endWall < limit);
}

/** Obsah souboru pro ffmpeg concat demuxer. Apostrofy v cestě se escapují podle jeho pravidel. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
}
