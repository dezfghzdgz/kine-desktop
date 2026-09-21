/**
 * Nahrávání souboru po částech (protokol tus) do Cloudflare Stream.
 *
 * Stejný postup jako v webové Kine (lib/tusUpload.ts), jen pro Node:
 * soubor se čte po kusech z disku a posílá PATCHem, každý kus s údajem,
 * kolik bajtů už druhá strana má. Přerušení (hráč pustil hru) je
 * obyčejný AbortSignal - nahrávání se zastaví a později se HEADem zjistí,
 * kde pokračovat. Nic se neposílá znovu od začátku.
 *
 * Cloudflare chce kusy aspoň 5 MiB a dělitelné 256 KiB (kromě posledního).
 */

export const TUS_CHUNK_SIZE = 8 * 1024 * 1024;

export class TusError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TusError';
  }
}

export class TusAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'TusAborted';
  }
}

export type ChunkReader = (offset: number, length: number) => Promise<Uint8Array>;

export type TusOptions = {
  url: string;
  size: number;
  read: ChunkReader;
  /** Odkud začít (po pauze); 0 = od začátku. Skutečný stav se ještě ověří HEADem. */
  offset?: number;
  chunkSize?: number;
  onProgress?: (uploaded: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const HEADERS = { 'Tus-Resumable': '1.0.0' };

/** Kolik bajtů už server má. */
export async function tusOffset(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<number> {
  const res = await fetchImpl(url, { method: 'HEAD', headers: HEADERS, signal });
  if (!res.ok) throw new TusError(`HEAD ${res.status}`, res.status);
  const offset = Number(res.headers.get('Upload-Offset'));
  if (!Number.isFinite(offset)) throw new TusError('Server nevrátil Upload-Offset.');
  return offset;
}

/**
 * Nahraje soubor. Vrací, až je celý u Cloudflare. Při přerušení hodí
 * TusAborted; volající si pamatuje url a příště zavolá znovu.
 */
export async function tusUpload(options: TusOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const chunkSize = options.chunkSize ?? TUS_CHUNK_SIZE;
  const maxRetries = options.maxRetries ?? 4;
  const signal = options.signal;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new TusAborted();
  };

  throwIfAborted();
  let offset = options.offset ?? 0;
  if (offset > 0) {
    // Po pauze se nevěří vlastní představě, ale serveru.
    offset = await tusOffset(options.url, fetchImpl, signal).catch((e) => {
      if (signal?.aborted) throw new TusAborted();
      throw e;
    });
  }
  options.onProgress?.(offset);

  while (offset < options.size) {
    throwIfAborted();
    const length = Math.min(chunkSize, options.size - offset);
    const chunk = await options.read(offset, length);

    let attempt = 0;
    for (;;) {
      throwIfAborted();
      try {
        const res = await fetchImpl(options.url, {
          method: 'PATCH',
          headers: {
            ...HEADERS,
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunk as unknown as BodyInit,
          signal,
        });

        if (res.status === 409 || res.status === 400) {
          // Nesedí offset - server má víc/míň, než si myslíme. Zjistit a jet dál.
          offset = await tusOffset(options.url, fetchImpl, signal);
          break;
        }
        if (!res.ok) throw new TusError(`Cloudflare odmítl kus (kód ${res.status}).`, res.status);

        const next = Number(res.headers.get('Upload-Offset'));
        offset = Number.isFinite(next) && next > 0 ? next : offset + length;
        options.onProgress?.(offset);
        break;
      } catch (e) {
        if (signal?.aborted || e instanceof TusAborted) throw new TusAborted();
        // Chyby 4xx kromě offsetu neopakovat - nezmizí samy.
        if (e instanceof TusError && e.status && e.status >= 400 && e.status < 500) throw e;
        attempt += 1;
        if (attempt > maxRetries) throw e instanceof Error ? e : new TusError(String(e));
        await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
        // Po výpadku se raději zeptat, kde jsme.
        try {
          offset = await tusOffset(options.url, fetchImpl, signal);
          if (offset >= options.size) return;
          break;
        } catch {
          // HEAD taky nešel - zkusí se PATCH znovu se stejným offsetem.
        }
      }
    }
  }
}
