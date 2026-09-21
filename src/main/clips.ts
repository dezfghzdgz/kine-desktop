import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, ClipUpload } from '../shared/types';

/**
 * Knihovna klipů: soubory ve složce s klipy + index.json vedle nich.
 *
 * Index je jediný zdroj pravdy pro appku (název, hra, stav nahrání).
 * Když hráč soubor smaže ručně ve Windows, klip z indexu při načtení
 * zmizí taky - nic se nehlásí, prostě ho nemá.
 */
export class ClipLibrary {
  private clips: Clip[] = [];
  private listeners = new Set<(clips: Clip[]) => void>();

  constructor(private dir: string) {}

  get directory(): string {
    return this.dir;
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json');
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
    for (const l of this.listeners) l(this.list());
  }

  onChange(listener: (clips: Clip[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Nejnovější první. */
  list(): Clip[] {
    return [...this.clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

  /** Smaže klip i s náhledem z disku. */
  remove(id: string): void {
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
}
