import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { TRASH_DAYS, type Clip, type ClipUpload } from '../shared/types';
import { compressTempPath } from '../shared/compress';
import { isCloudflareUploadUrl } from '../shared/upload';
import { isPathInside } from './safePath';

/**
 * Knihovna klipů: soubory ve složce s klipy + index.json vedle nich.
 *
 * Index je jediný zdroj pravdy pro appku (název, hra, stav nahrání).
 * Když hráč soubor smaže ručně ve Windows, klip z indexu při načtení
 * zmizí taky - nic se nehlásí, prostě ho nemá.
 *
 * Index ale leží ve složce s klipy, kterou může sdílet síť, cloud nebo jiný
 * účet na PC (druhý disk) - appka mu proto nevěří naslepo: klip a kamera musí
 * ležet ve složce s klipy, náhled tam nebo ve složce s náhledy, rozjeté
 * nahrávání smí navázat jen u Cloudflare. Co nesedí, se při načtení vynechá
 * (nic se nemaže) - viz sanitize().
 *
 * Smazání = koš: soubor se přesune do podsložky .trash a klip dostane
 * deletedAt. Odtud jde obnovit; po TRASH_DAYS dnech (nebo "vysypat koš")
 * zmizí nadobro. Klipy v koši nejsou v list(), jen v trash().
 */
export type ClipLibraryOptions = {
  /** Složky s náhledy klipů (userData/thumbs této i sourozenecké appky) - náhled smí ležet i tam. */
  thumbDirs?: readonly string[];
  /** Adresa rozjetého nahrávání, na kterou se smí po restartu navázat (výchozí: jen Cloudflare Stream). */
  allowTusUrl?: (url: string) => boolean;
};

export class ClipLibrary {
  private clips: Clip[] = [];
  private listeners = new Set<(clips: Clip[]) => void>();
  /** Odložený zápis průběhu nahrávání (viz setUpload). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private dir: string,
    /** Kam hlásit, když se soubor nepovede přesunout (koš). */
    private log: (message: string) => void = () => undefined,
    private readonly options: ClipLibraryOptions = {}
  ) {}

  /** Kde smí ležet náhled: ve složce s klipy nebo ve složce s náhledy. */
  private get thumbRoots(): string[] {
    return [this.dir, ...(this.options.thumbDirs ?? [])];
  }

  /**
   * Záznam z index.json, kterému appka věří, nebo null (vynechat). Kontroluje se
   * jen text cest a skutečná cesta uvnitř složky - na cestu mimo složku (jiný disk,
   * síťová, relativní) se na disk vůbec nesahá. Klip mimo složku = pryč z knihovny;
   * náhled nebo kamera mimo = jen ten údaj pryč; nahrávání jinam než k Cloudflare =
   * zapomenout adresu (začne se znovu přes Kine).
   */
  private sanitize(raw: unknown): Clip | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Clip;
    if (typeof c.id !== 'string' || !c.id || typeof c.file !== 'string' || !isPathInside(c.file, [this.dir])) return null;
    const clip: Clip = { ...c };
    if (clip.thumb !== null && !(typeof clip.thumb === 'string' && isPathInside(clip.thumb, this.thumbRoots))) clip.thumb = null;
    if (clip.camera !== undefined && clip.camera !== null && !(typeof clip.camera === 'object' && isPathInside(clip.camera.file, [this.dir]))) delete clip.camera;
    const up = clip.upload;
    if (up && (up.state === 'paused' || up.state === 'uploading') && up.tusUrl !== undefined) {
      const allowed = this.options.allowTusUrl ?? isCloudflareUploadUrl;
      if (typeof up.tusUrl !== 'string' || !allowed(up.tusUrl)) {
        const next = { ...up };
        delete next.tusUrl;
        clip.upload = next;
      }
    }
    return clip;
  }

  get directory(): string {
    return this.dir;
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json');
  }

  /** Složka koše (uvnitř složky s klipy, skrytá tečkou). */
  get trashDir(): string {
    return join(this.dir, '.trash');
  }

  /** Načte index; klipy bez souboru vyhodí. Volá se při startu a po změně složky. */
  load(dir?: string): void {
    if (dir) this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'));
    } catch {
      parsed = [];
    }
    const raw = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    // Dřív, než se na cokoli sáhne: jen záznamy s cestami uvnitř složky (viz sanitize).
    const list: Clip[] = [];
    for (const item of raw) {
      const clip = this.sanitize(item);
      if (clip) list.push(clip);
    }
    if (list.length < raw.length) this.log(`knihovna: ${raw.length - list.length} záznamů v index.json ukazuje mimo složku s klipy - vynechány (soubory se nemažou)`);
    // Zmenšování klipu přerušené uprostřed výměny (pád, vypnutí PC): původní soubor zpátky,
    // nedokončený zmenšený pryč (src/main/compress.ts).
    for (const c of list) {
      try {
        const backup = `${c.file}.kine-orig`;
        if (existsSync(backup)) {
          // Chybí klip = výměna nedoběhla, původní zpátky. Klip je = zmenšený už je na místě, záloha pryč.
          if (!existsSync(c.file)) renameSync(backup, c.file);
          else rmSync(backup, { force: true });
        }
        const tmp = compressTempPath(c.file);
        if (existsSync(tmp)) rmSync(tmp, { force: true });
      } catch {
        // nevadí - zkusí se příště
      }
    }
    this.clips = list.filter((c) => existsSync(c.file));
    this.purgeExpired();
    // Rozjeté nahrávání z minula nemá kdo dokončit - vrátí se do fronty,
    // po startu si ho uploader vezme znovu (tus umí pokračovat).
    for (const c of this.clips) {
      if (c.upload && c.upload.state === 'uploading') {
        c.upload = { state: 'paused', percent: c.upload.percent, reason: 'offline', tusUrl: c.upload.tusUrl, videoId: c.upload.videoId };
      }
    }
    this.save();
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.indexPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.clips, null, 2));
    renameSync(tmp, this.indexPath);
    for (const l of this.listeners) l(this.listAll());
  }

  /** Posluchači dostávají všechny klipy včetně koše (okno si je roztřídí podle deletedAt). */
  onChange(listener: (clips: Clip[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Nejnovější první, bez koše. */
  list(): Clip[] {
    return this.listAll().filter((c) => !c.deletedAt);
  }

  /** Všechny klipy včetně koše, nejnovější první. */
  listAll(): Clip[] {
    return [...this.clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Klipy v koši, naposledy smazané první. */
  trash(): Clip[] {
    return this.clips.filter((c) => !!c.deletedAt).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  /** Součty pro správu místa: klipy a koš (z indexu, bez sahání na disk). */
  usage(): { clipsBytes: number; clipsCount: number; trashBytes: number; trashCount: number } {
    let clipsBytes = 0;
    let clipsCount = 0;
    let trashBytes = 0;
    let trashCount = 0;
    for (const c of this.clips) {
      if (c.deletedAt) {
        trashBytes += c.sizeBytes || 0;
        trashCount += 1;
      } else {
        clipsBytes += c.sizeBytes || 0;
        clipsCount += 1;
      }
    }
    return { clipsBytes, clipsCount, trashBytes, trashCount };
  }

  get(id: string): Clip | null {
    return this.clips.find((c) => c.id === id) ?? null;
  }

  bySession(sessionId: string): Clip[] {
    return this.list().filter((c) => c.sessionId === sessionId);
  }

  add(clip: Clip): void {
    // Kdy klip přibyl - strop místa (shared/storage.ts) čerstvé klipy nemaže.
    if (!clip.addedAt) clip.addedAt = new Date().toISOString();
    this.clips.push(clip);
    this.save();
  }

  update(id: string, patch: Partial<Clip>): Clip | null {
    const clip = this.get(id);
    if (!clip) return null;
    Object.assign(clip, patch);
    this.save();
    return clip;
  }

  /**
   * Stav nahrávání. Samotná procenta nahrávání (každý kus tus, stav uploading / paused)
   * se zapisují a hlásí oknu nejvýš jednou za 600 ms: dřív každý kus znamenal zápis celého
   * seznamu na disk a překreslení celého okna (u stovky klipů to trhalo). Změna stavu
   * (fronta -> nahrává -> hotovo / chyba) a průběh zpracování u Cloudflare (dotaz jednou
   * za pár sekund) jdou hned.
   */
  setUpload(id: string, upload: ClipUpload | null): void {
    const clip = this.get(id);
    if (!clip) return;
    const prev = clip.upload;
    const progressOnly = !!prev && !!upload && prev.state === upload.state && (upload.state === 'uploading' || upload.state === 'paused');
    clip.upload = upload;
    if (!progressOnly) {
      this.save();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 600);
    this.saveTimer.unref?.();
  }

  /** Smazání = do koše (soubor do .trash, klip dostane deletedAt). Klip už v koši se smaže nadobro. */
  remove(id: string): void {
    const clip = this.get(id);
    if (!clip) return;
    if (clip.deletedAt) {
      this.purge(id);
      return;
    }
    let target = clip.file;
    try {
      mkdirSync(this.trashDir, { recursive: true });
      target = uniqueIn(this.trashDir, basename(clip.file));
      moveFile(clip.file, target);
    } catch (e) {
      // Přesun nešel (jiný disk bez práv apod.) - klip zůstane, kde je, jen se označí.
      this.log(`koš: ${clip.file} nejde přesunout: ${(e as Error).message}`);
      target = clip.file;
    }
    clip.file = target;
    // Kamera zvlášť jde do koše s klipem.
    if (clip.camera) {
      try {
        const camTarget = uniqueIn(this.trashDir, basename(clip.camera.file));
        moveFile(clip.camera.file, camTarget);
        clip.camera = { ...clip.camera, file: camTarget };
      } catch (e) {
        this.log(`koš: ${clip.camera.file} nejde přesunout: ${(e as Error).message}`);
      }
    }
    clip.deletedAt = new Date().toISOString();
    this.save();
  }

  /** Vrátí klip z koše zpátky mezi klipy (soubor do složky s klipy). */
  restore(id: string): Clip | null {
    const clip = this.get(id);
    if (!clip || !clip.deletedAt) return clip;
    try {
      const target = uniqueIn(this.dir, basename(clip.file));
      if (target !== clip.file) moveFile(clip.file, target);
      clip.file = target;
    } catch (e) {
      // Zůstane v .trash, ale bude zase vidět - lepší než přijít o klip.
      this.log(`koš: ${clip.file} nejde vrátit: ${(e as Error).message}`);
    }
    if (clip.camera) {
      try {
        const camTarget = uniqueIn(this.dir, basename(clip.camera.file));
        if (camTarget !== clip.camera.file) moveFile(clip.camera.file, camTarget);
        clip.camera = { ...clip.camera, file: camTarget };
      } catch (e) {
        this.log(`koš: ${clip.camera.file} nejde vrátit: ${(e as Error).message}`);
      }
    }
    delete clip.deletedAt;
    this.save();
    return clip;
  }

  /** Smaže klip nadobro i s náhledem - jen soubory ve složce s klipy (náhled i ve složce s náhledy). */
  purge(id: string): void {
    const clip = this.get(id);
    if (!clip) return;
    const files: [string | null | undefined, string[]][] = [
      [clip.file, [this.dir]],
      [clip.thumb, this.thumbRoots],
      [clip.camera?.file, [this.dir]],
    ];
    for (const [f, roots] of files) {
      if (!f) continue;
      // Pojistka i za běhu (odkaz / junction podstrčený po načtení): mimo složku se nic nemaže.
      if (!isPathInside(f, roots)) {
        this.log(`koš: ${f} leží mimo složku s klipy - nemaže se`);
        continue;
      }
      try {
        unlinkSync(f);
      } catch {
        // Soubor už není - to je v pořádku.
      }
    }
    this.clips = this.clips.filter((c) => c.id !== id);
    this.save();
  }

  /** Vysype koš. */
  emptyTrash(): void {
    for (const c of this.trash()) this.purge(c.id);
  }

  /** Klipy v koši déle než TRASH_DAYS zmizí samy (při načtení a jednou za čas). Vrací, kolik. */
  purgeExpired(now = Date.now()): number {
    const limit = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
    const old = this.clips.filter((c) => c.deletedAt && Date.parse(c.deletedAt) < limit);
    for (const c of old) this.purge(c.id);
    return old.length;
  }
}

/** Cesta do složky s daným názvem; když tam už je, přidá " (2)", " (3)"… */
function uniqueIn(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/** Přesun souboru; přes disky (rename nejde) kopie + smazání. */
function moveFile(from: string, to: string): void {
  if (from === to) return;
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}
