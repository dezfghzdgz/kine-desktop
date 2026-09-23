import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { TRASH_DAYS, type Clip, type ClipUpload } from '../shared/types';

/**
 * Knihovna klipů: soubory ve složce s klipy + index.json vedle nich.
 *
 * Index je jediný zdroj pravdy pro appku (název, hra, stav nahrání).
 * Když hráč soubor smaže ručně ve Windows, klip z indexu při načtení
 * zmizí taky - nic se nehlásí, prostě ho nemá.
 *
 * Smazání = koš: soubor se přesune do podsložky .trash a klip dostane
 * deletedAt. Odtud jde obnovit; po TRASH_DAYS dnech (nebo "vysypat koš")
 * zmizí nadobro. Klipy v koši nejsou v list(), jen v trash().
 */
export class ClipLibrary {
  private clips: Clip[] = [];
  private listeners = new Set<(clips: Clip[]) => void>();

  constructor(
    private dir: string,
    /** Kam hlásit, když se soubor nepovede přesunout (koš). */
    private log: (message: string) => void = () => undefined
  ) {}

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
    const list = Array.isArray(parsed) ? (parsed as Clip[]) : [];
    this.clips = list.filter((c) => c && typeof c.id === 'string' && typeof c.file === 'string' && existsSync(c.file));
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

  setUpload(id: string, upload: ClipUpload | null): void {
    this.update(id, { upload });
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
    delete clip.deletedAt;
    this.save();
    return clip;
  }

  /** Smaže klip nadobro i s náhledem. */
  purge(id: string): void {
    const clip = this.get(id);
    if (!clip) return;
    for (const f of [clip.file, clip.thumb]) {
      if (f) {
        try {
          unlinkSync(f);
        } catch {
          // Soubor už není - to je v pořádku.
        }
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
