/**
 * Vidí diváci obraz? (živé vysílání z appky - čistá část, testuje se)
 *
 * Kousky proudu šly ven a Cloudflare je bral, a přesto divák mohl vidět
 * jen zamrzlý první snímek (u Cloudflare nevznikaly nové kousky videa -
 * třeba když grafika v recorderu nedává klíčové snímky). Appka si to teď
 * ověřuje sama, stejně jako divák: čte HLS vysílání u Cloudflare (jen
 * playlist, žádné video) a hlídá, že přibývají nové kousky. Když ne, přepne
 * vysílání do kompatibilního režimu (livePlan.ts: ffmpeg obraz zakóduje
 * znovu - pevné snímky za sekundu, klíčový snímek každé 2 s, jako OBS).
 */

/** checking = ještě se neví, ok = diváci obraz vidí, stalled = obraz u diváků stojí, unknown = nejde ověřit. */
export type LiveHealth = 'checking' | 'ok' | 'stalled' | 'unknown';

/** Jak dlouho smí Cloudflare po startu vysílání chystat první kousky. */
export const HEALTH_FIRST_MS = 60_000;
/** Bez nového kousku tak dlouho = obraz u diváků stojí. */
export const HEALTH_STALL_MS = 25_000;
/** Bez jediného přečteného playlistu a bez potvrzení od Kine tak dlouho = Cloudflare proud nezpracovává. */
export const HEALTH_NOTHING_MS = 90_000;

export type MediaPlaylist = { kind: 'media'; sequence: number; segments: string[]; ended: boolean };
export type MasterPlaylist = { kind: 'master'; variants: { url: string; bandwidth: number }[] };

/** Text playlistu HLS -> hlavní (varianty) / mediální (kousky); null = není to playlist. */
export function parsePlaylist(text: string, baseUrl: string): MasterPlaylist | MediaPlaylist | null {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const resolve = (uri: string): string | null => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return null;
    }
  };
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: { url: string; bandwidth: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bw = Number(/BANDWIDTH=(\d+)/i.exec(lines[i])?.[1] ?? NaN);
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
      const url = uri ? resolve(uri) : null;
      if (url) variants.push({ url, bandwidth: Number.isFinite(bw) ? bw : 0 });
    }
    return { kind: 'master', variants };
  }
  if (!lines.some((l) => l.startsWith('#EXTINF') || l.startsWith('#EXT-X-TARGETDURATION'))) return null;
  const sequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text)?.[1] ?? 0);
  const segments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) segments.push(uri);
  }
  return { kind: 'media', sequence: Number.isFinite(sequence) ? sequence : 0, segments, ended: lines.includes('#EXT-X-ENDLIST') };
}

/** Varianta, která se bude hlídat: nejmenší datový tok (stejně se čte jen playlist). */
export function pickVariant(master: MasterPlaylist): string | null {
  const sorted = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
  return sorted[0]?.url ?? null;
}

/**
 * Hlídání jednoho vysílání: dostává přečtené playlisty a říká, jestli
 * obraz u diváků běží.
 */
export class HlsWatch {
  private key: string | null = null;
  private advancedAt: number | null = null;
  /** Kolikrát se playlist podařilo přečíst (bez toho se nedá poznat "stojí" od "adresa nejde"). */
  private reads = 0;
  private readonly firstMs: number;
  private readonly stallMs: number;
  private readonly nothingMs: number;

  /** Časy jdou v testu zkrátit. */
  constructor(times: { firstMs?: number; stallMs?: number; nothingMs?: number } = {}) {
    this.firstMs = times.firstMs ?? HEALTH_FIRST_MS;
    this.stallMs = times.stallMs ?? HEALTH_STALL_MS;
    this.nothingMs = times.nothingMs ?? HEALTH_NOTHING_MS;
  }

  reset(): void {
    this.key = null;
    this.advancedAt = null;
    this.reads = 0;
  }

  /** Přečtený mediální playlist (null = nešel přečíst / ještě není). */
  observe(media: Pick<MediaPlaylist, 'sequence' | 'segments'> | null, at: number): void {
    if (!media || media.segments.length === 0) return;
    this.reads += 1;
    const key = `${media.sequence}:${media.segments.length}:${media.segments[media.segments.length - 1]}`;
    if (this.key !== null && key !== this.key) this.advancedAt = at;
    this.key = key;
  }

  /** Viděl už aspoň jeden playlist? */
  everRead(): boolean {
    return this.reads > 0;
  }

  /**
   * Verdikt: `liveSince` = kdy toto spojení začalo vysílat, `confirmed` = Kine
   * hlásí, že Cloudflare přenos vidí (null = neví se).
   */
  verdict(liveSince: number, at: number, confirmed: boolean | null): LiveHealth {
    if (this.advancedAt !== null && at - this.advancedAt < this.stallMs) return 'ok';
    if (this.reads > 0) {
      // Playlist je, jen nepřibývá: obraz u diváků stojí (po rozjezdu, nebo když se zastavil).
      if (this.advancedAt === null && at - liveSince < this.firstMs) return 'checking';
      return 'stalled';
    }
    // Playlist se ještě nepřečetl ani jednou.
    if (at - liveSince < this.firstMs) return 'checking';
    // Kine hlásí, že Cloudflare přenos vidí - jen playlist nejde přečíst: ověřit nejde.
    if (confirmed === true) return 'unknown';
    return at - liveSince >= this.nothingMs ? 'stalled' : 'checking';
  }
}
