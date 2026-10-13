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

/**
 * Od kterého kousku (indexu) mají všechny stejné rozměry jako ten
 * poslední. Neznámé rozměry (null) se berou jako "sedí". Pro klip se
 * použije jen tenhle souvislý konec - prohlížeč neumí přehrát soubor,
 * kde se uprostřed změní velikost obrazu.
 */
export function sameResolutionTailStart(sizes: (string | null)[]): number {
  if (sizes.length === 0) return 0;
  const last = sizes[sizes.length - 1];
  if (!last) return 0;
  let start = sizes.length - 1;
  while (start > 0 && (sizes[start - 1] === null || sizes[start - 1] === last)) start -= 1;
  return start;
}

// ---- rozměry obrazu: kde se měnily ------------------------------------------------------

/** Hlášení snímací stránky: od `at` (hodiny počítače) má obraz rozměry `size` ("1920x1080"). */
export type SizeReport = { at: number; size: string };

/** Generace z pohledu rozměrů: rozměry na začátku a hlášené změny. */
export type GenerationSizes = { id: number; size: string | null; resizes: SizeReport[] };

/** O kolik se může hlášení změny opozdit (snímací stránka se ptá jednou za sekundu) + rezerva. */
const REPORT_SLACK_MS = 2000;

/**
 * Rozměry kousků podle hlášení snímací stránky, bez jediného spuštění
 * ffmpeg: když všechny generace v klipu hlásily stejné rozměry a během
 * klipu (s rezervou na zpoždění hlášení) žádná změna nebyla, vrátí ty
 * rozměry. Jinak null - pak se musí změřit (sizeRuns).
 */
export function reportedSize(chosen: Segment[], gens: GenerationSizes[]): string | null {
  if (chosen.length === 0) return null;
  const from = chosen[0].startWall - REPORT_SLACK_MS;
  const to = chosen[chosen.length - 1].endWall + REPORT_SLACK_MS;
  const byId = new Map(gens.map((g) => [g.id, g]));
  let size: string | null = null;
  for (const id of new Set(chosen.map((s) => s.generation))) {
    const g = byId.get(id);
    if (!g || !g.size) return null;
    if (g.resizes.some((r) => r.at > from && r.at < to)) return null;
    // Rozměry v klipu = poslední změna před ním, jinak rozměry na začátku generace.
    const before = g.resizes.filter((r) => r.at <= from);
    const s = before.length > 0 ? before[before.length - 1].size : g.size;
    if (size !== null && s !== size) return null;
    size = s;
  }
  return size;
}

/**
 * Rozdělí kousky (seřazené podle času) na souvislé úseky se stejnými
 * rozměry obrazu. Měří se jen to nutné: kraje, kousky kolem hlášených
 * změn (začátky generací a 'resized') a pak půlením mezi dvěma změřenými
 * kousky s různými rozměry, dokud se nenajde přesná hranice. Neměřené
 * kousky dostanou rozměry nejbližšího změřeného před sebou (neznámé =
 * "sedí"). `maxProbes` = strop - u dlouhé nahrávky se neměří tisíce kousků.
 */
export async function sizeRuns(
  segments: Segment[],
  reports: SizeReport[],
  probeSize: (file: string) => Promise<string | null>,
  options: { maxProbes?: number; concurrency?: number } = {}
): Promise<{ runs: Segment[][]; sizes: (string | null)[] }> {
  const n = segments.length;
  if (n === 0) return { runs: [], sizes: [] };
  const maxProbes = options.maxProbes ?? 48;
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const sizes: (string | null | undefined)[] = new Array(n).fill(undefined);
  let probes = 0;

  const measure = async (indexes: number[]) => {
    const todo = [...new Set(indexes)].filter((i) => i >= 0 && i < n && sizes[i] === undefined);
    const allowed = todo.slice(0, Math.max(0, maxProbes - probes));
    probes += allowed.length;
    for (let k = 0; k < allowed.length; k += concurrency) {
      const batch = allowed.slice(k, k + concurrency);
      const results = await Promise.all(batch.map((i) => probeSize(segments[i].file).catch(() => null)));
      batch.forEach((i, j) => (sizes[i] = results[j]));
    }
  };

  // 1) kraje + kousky kolem hlášených změn (jeden před, ten s hlášením a jeden po).
  const initial = [0, n - 1];
  for (const r of reports) {
    for (let i = 0; i < n; i++) {
      const s = segments[i];
      if (s.endWall > r.at - REPORT_SLACK_MS && s.startWall < r.at + REPORT_SLACK_MS) initial.push(i - 1, i, i + 1);
    }
  }
  await measure(initial);

  // 2) půlení: mezi dvěma změřenými s různými rozměry se hledá přesná hranice.
  for (let guard = 0; guard < 200 && probes < maxProbes; guard++) {
    const known: number[] = [];
    sizes.forEach((s, i) => {
      if (s) known.push(i);
    });
    const wanted: number[] = [];
    for (let k = 1; k < known.length; k++) {
      const a = known[k - 1];
      const b = known[k];
      if (sizes[a] === sizes[b]) continue;
      const open: number[] = [];
      for (let i = a + 1; i < b; i++) if (sizes[i] === undefined) open.push(i);
      if (open.length > 0) wanted.push(open[open.length >> 1]);
    }
    if (wanted.length === 0) break;
    await measure(wanted);
  }

  // 3) neměřené (a neznámé) převezmou rozměry nejbližšího změřeného před sebou (na začátku toho prvního).
  let carry: string | null = (sizes.find((s) => !!s) as string | undefined) ?? null;
  const filled: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (sizes[i]) carry = sizes[i] as string;
    filled.push(carry);
  }
  const runs: Segment[][] = [];
  let current: Segment[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && filled[i] !== filled[i - 1]) {
      runs.push(current);
      current = [];
    }
    current.push(segments[i]);
  }
  runs.push(current);
  return { runs, sizes: filled };
}

/**
 * Úseky nahrávky zápasu k uložení: po každé změně rozměrů se poslední
 * kousek starého úseku vynechá (změna může být uprostřed něj - a soubor,
 * kde se v půlce změní velikost obrazu, prohlížeč nepřehraje). Úseky
 * kratší než `minSeconds` se zahodí (načítací obrazovka, alt-tab na chvilku).
 */
export function recordingParts(runs: Segment[][], minSeconds = 5): Segment[][] {
  const nonEmpty = runs.filter((run) => run.length > 0);
  // Jeden úsek (rozlišení se neměnilo) = celá nahrávka, i kdyby byla krátká.
  if (nonEmpty.length <= 1) return nonEmpty;
  const trimmed = nonEmpty.map((run, i) => (i < nonEmpty.length - 1 && run.length > 1 ? run.slice(0, -1) : run));
  const kept = trimmed.filter((run) => totalSeconds(run) >= minSeconds);
  if (kept.length > 0) return kept;
  // Všechno krátké - aspoň ten nejdelší úsek, ať se nahrávka neztratí.
  return [trimmed.reduce((best, run) => (totalSeconds(run) > totalSeconds(best) ? run : best))];
}

// ---- plán klipu: obraz + zvlášť nahraný mikrofon --------------------------------------

/** Položka pro concat demuxer: soubor, jak dlouho v klipu trvá, případně kde ho uříznout. */
export type ConcatEntry = { file: string; duration: number; outpoint?: number };

export type ClipPlan = {
  video: ConcatEntry[];
  /** Délka obrazu v klipu (s). */
  videoSeconds: number;
  /** Kousky mikrofonu, nebo null, když mikrofon není. */
  mic: ConcatEntry[] | null;
  /** Kde v klipu začíná první kousek mikrofonu (ms; záporné = začátek se uřízne). */
  micOffsetMs: number;
};

/**
 * Jak slepit obraz a mikrofon, aby seděly na sebe.
 *
 * Obraz (se zvukem hry) a mikrofon se nahrávají dvěma recordery do dvou
 * řad kousků. Kousky obrazu jdou v klipu za sebou (každý přesně tak dlouhý,
 * jak ho zapsal ffmpeg - `duration` v seznamu, ať si concat nic nedomýšlí).
 * Každý kousek mikrofonu se pak umístí podle hodin počítače na místo, kam
 * patří vůči obrazu STEJNÉ generace (po klipu se nahrávání rozjíždí znovu
 * a mezi generacemi je malá mezera - ta se v klipu vypouští u obrazu, tak
 * i u mikrofonu). `latencyMs` = o kolik je mikrofon pozadu (posune se dopředu).
 */
export function planClip(video: Segment[], mic: Segment[], latencyMs = 0): ClipPlan {
  const videoSorted = [...video].sort((a, b) => a.startWall - b.startWall);
  const entries: ConcatEntry[] = [];
  // Kde v klipu začíná která generace obrazu a od kdy (podle hodin) tam je.
  const layout = new Map<number, { wallStart: number; wallEnd: number; outStart: number }>();
  let out = 0;
  for (const s of videoSorted) {
    const duration = Math.max(0.001, (s.endWall - s.startWall) / 1000);
    entries.push({ file: s.file, duration: round3(duration) });
    const g = layout.get(s.generation);
    if (!g) layout.set(s.generation, { wallStart: s.startWall, wallEnd: s.endWall, outStart: out });
    else g.wallEnd = Math.max(g.wallEnd, s.endWall);
    out += duration;
  }
  const videoSeconds = round3(out);

  // Kousky mikrofonu z generací, které v klipu jsou, a jen ty, co se s obrazem překrývají.
  const placed: { seg: Segment; outMs: number }[] = [];
  for (const m of [...mic].sort((a, b) => a.startWall - b.startWall)) {
    const g = layout.get(m.generation);
    if (!g || m.endWall <= g.wallStart || m.startWall >= g.wallEnd) continue;
    placed.push({ seg: m, outMs: g.outStart * 1000 + (m.startWall - g.wallStart) - latencyMs });
  }
  if (placed.length === 0) return { video: entries, videoSeconds, mic: null, micOffsetMs: 0 };

  const micEntries: ConcatEntry[] = placed.map((p, i) => {
    const actual = Math.max(0.001, (p.seg.endWall - p.seg.startWall) / 1000);
    const next = placed[i + 1];
    if (!next) return { file: p.seg.file, duration: round3(actual) };
    // Další kousek musí začít přesně na svém místě: kratší = mezera (doplní se tichem),
    // delší = konec se uřízne, ať se kousky nepřekrývají.
    const slot = Math.max(0.001, (next.outMs - p.outMs) / 1000);
    return slot < actual - 0.0005 ? { file: p.seg.file, duration: round3(slot), outpoint: round3(slot) } : { file: p.seg.file, duration: round3(slot) };
  });
  return { video: entries, videoSeconds, mic: micEntries, micOffsetMs: Math.round(placed[0].outMs) };
}

/** Seznam pro concat demuxer i s délkami (a případně výstupním bodem) každého souboru. */
export function concatScript(entries: ConcatEntry[]): string {
  const lines: string[] = ['ffconcat version 1.0'];
  for (const e of entries) {
    lines.push(`file '${e.file.replace(/'/g, `'\\''`)}'`);
    lines.push(`duration ${e.duration.toFixed(3)}`);
    if (e.outpoint !== undefined) lines.push(`outpoint ${e.outpoint.toFixed(3)}`);
  }
  return lines.join('\n') + '\n';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- obnova nahrávky zápasu po pádu ---------------------------------------------------

/** Generace zásobníku, jak ji popisuje gen.json a CSV seznamy v její složce. */
export type SavedGeneration = {
  id: number;
  startWall: number;
  mimeType: string;
  hasAudio: boolean;
  hasMic: boolean;
  micLatencyMs: number;
  /** Zpoždění zvuku hry (ms), když šel přímo z Windows přes pomocníka (starší gen.json ho nemají = 0). */
  systemLatencyMs?: number;
  video: Segment[];
  mic: Segment[];
};

/**
 * Co z přerušené nahrávky zápasu (spadla appka, snímání nebo Windows) jde
 * slepit: kousky obrazu, které skončily po startu nahrávání - stejně jako
 * při běžném uložení (selectForClip) - jen z generací se stejným formátem
 * jako ta poslední (concat neumí míchat kodeky), k nim mikrofon těch
 * generací. Seřazené podle hodin počítače.
 */
export function recoverySegments(gens: SavedGeneration[], sinceWall: number): { video: Segment[]; mic: Segment[]; gens: SavedGeneration[] } {
  const withVideo = gens
    .map((g) => ({ ...g, video: g.video.filter((s) => s.endWall > sinceWall) }))
    .filter((g) => g.video.length > 0)
    .sort((a, b) => a.startWall - b.startWall);
  if (withVideo.length === 0) return { video: [], mic: [], gens: [] };
  const mime = withVideo[withVideo.length - 1].mimeType;
  const same = withVideo.filter((g) => g.mimeType === mime);
  const byTime = (a: Segment, b: Segment) => a.startWall - b.startWall;
  return {
    video: same.flatMap((g) => g.video).sort(byTime),
    mic: same.flatMap((g) => (g.hasMic ? g.mic : [])).sort(byTime),
    gens: same,
  };
}
