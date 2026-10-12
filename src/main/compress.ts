import { cpus, constants as osConstants, setPriority } from 'node:os';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import type { Clip, CompressStatus } from '../shared/types';
import { compressArgs, compressedOk, compressSkipReason, compressSummary, compressTempPath, type CompressLevel } from '../shared/compress';
import { probe, spawnFfmpeg } from './ffmpeg';
import { progressPercent } from './editPlan';
import { log } from './log';

/**
 * Zmenšování klipů na pozadí (Klipy -> úložiště nahoře): jeden klip po
 * druhém, s nejnižší prioritou a polovinou jader. Když se zapne hra
 * (nahrávání, vysílání), rozdělaný klip se odloží a čeká se, až dohraje.
 * Původní soubor se nahradí, až je zmenšený v pořádku (stejná délka, má
 * obraz, je opravdu menší) - jinak zůstane, jak byl. Náhled, název, hra,
 * oblíbené i nahrání na Kine zůstávají.
 */
type Deps = {
  list: () => Clip[];
  get: (id: string) => Clip | null;
  update: (id: string, patch: Partial<Clip>) => void;
  gameRunning: () => boolean;
  /** Otevřený v přehrávači (soubor drží okno, může se upravovat) - odložit na konec. */
  inUse: (clipId: string) => boolean;
  onChange: (status: CompressStatus | null) => void;
};

const IDLE: CompressStatus = { running: false, level: 'medium', total: 0, done: 0, skipped: 0, savedBytes: 0, percent: 0, paused: false, finishedAt: null };

/** Jak dopadl jeden klip: hotovo / přeskočen / odložit (hra, přehrávač). */
type Outcome = 'done' | 'skipped' | 'later-game' | 'later-player';

export class ClipCompressor {
  private status: CompressStatus = { ...IDLE };
  private queue: string[] = [];
  private child: ReturnType<typeof spawnFfmpeg> | null = null;
  /** Proč se rozdělaný klip přerušil (hra se zapnula, klip se otevřel). */
  private interrupt: 'game' | 'player' | null = null;
  private cancelled = false;
  private loopRunning = false;

  constructor(private deps: Deps) {}

  current(): CompressStatus | null {
    return this.status.running || this.status.finishedAt ? { ...this.status } : null;
  }

  /** Spustí zmenšení vybraných klipů (bez výběru všech, které má smysl zmenšit). Vrací počet. */
  start(level: CompressLevel, ids?: string[]): number {
    if (this.status.running || this.loopRunning) return 0;
    const pool = this.deps.list().filter((c) => !ids || ids.includes(c.id));
    const plan = compressSummary(pool, level);
    if (plan.count === 0) return 0;
    this.queue = [...plan.ids];
    this.cancelled = false;
    this.interrupt = null;
    this.status = { ...IDLE, running: true, level, total: plan.count };
    log(`zmenšování klipů (${level}): ${plan.count} klipů, odhad úspory ${Math.round(plan.savingBytes / 1048576)} MB`);
    this.emit();
    void this.loop();
    return plan.count;
  }

  cancel(): void {
    if (!this.status.running) return;
    this.cancelled = true;
    this.queue = [];
    // Natvrdo - rozdělaný soubor se stejně maže (ffmpeg by na SIGTERM ještě dokódovával).
    this.child?.kill('SIGKILL');
  }

  /** Hlášení "Ušetřeno X" zavřené. */
  dismiss(): void {
    if (this.status.running) return;
    this.status = { ...IDLE };
    this.emit();
  }

  private emit(): void {
    this.deps.onChange(this.current());
  }

  private async loop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    const retry: string[] = [];
    try {
      while (!this.cancelled) {
        // Při hře se nezmenšuje (bralo by hře výkon) - čeká se, až dohraje.
        if (this.deps.gameRunning()) {
          if (!this.status.paused) {
            this.status.paused = true;
            this.status.percent = 0;
            this.emit();
          }
          // Po kouscích - Zrušit se projeví hned.
          for (let i = 0; i < 10 && !this.cancelled; i++) await sleep(500);
          continue;
        }
        if (this.status.paused) {
          this.status.paused = false;
          this.emit();
        }
        let id = this.queue.shift();
        let fromRetry = false;
        if (!id && retry.length > 0) {
          // Klipy, které byly otevřené v přehrávači - ještě jednou na konci.
          id = retry.shift();
          fromRetry = true;
        }
        if (!id) break;
        if (this.deps.inUse(id)) {
          if (!fromRetry) retry.push(id);
          else this.finishOne('skipped');
          continue;
        }
        const outcome = await this.one(id);
        if (this.cancelled) break;
        if (outcome === 'later-game') {
          // Zapnula se hra - klip se udělá znovu od začátku, až dohraje.
          this.queue.unshift(id);
          this.status.percent = 0;
          this.emit();
          continue;
        }
        if (outcome === 'later-player') {
          if (!fromRetry) retry.push(id);
          else this.finishOne('skipped');
          this.status.percent = 0;
          this.emit();
          continue;
        }
        this.finishOne(outcome);
      }
    } finally {
      this.loopRunning = false;
      this.child = null;
      this.interrupt = null;
      this.status.running = false;
      this.status.paused = false;
      this.status.percent = 0;
      this.status.finishedAt = Date.now();
      log(`zmenšování klipů ${this.cancelled ? 'zrušeno' : 'hotovo'}: ${this.status.done}/${this.status.total}, přeskočeno ${this.status.skipped}, ušetřeno ${Math.round(this.status.savedBytes / 1048576)} MB`);
      this.emit();
    }
  }

  private finishOne(outcome: 'done' | 'skipped'): void {
    if (outcome === 'skipped') this.status.skipped++;
    this.status.done++;
    this.status.percent = 0;
    this.emit();
  }

  private async one(id: string): Promise<Outcome> {
    const clip = this.deps.get(id);
    const level = this.status.level;
    if (!clip || compressSkipReason(clip, level) !== null || !existsSync(clip.file)) return 'skipped';
    const tmp = compressTempPath(clip.file);
    rmSync(tmp, { force: true });
    let before: { size: number; mtimeMs: number };
    try {
      const st = statSync(clip.file);
      before = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return 'skipped';
    }
    const threads = Math.max(1, Math.floor(cpus().length / 2));
    const args = compressArgs(clip.file, tmp, level, { height: clip.height, threads });
    this.interrupt = null;
    try {
      await this.run(id, args, clip.durationSeconds);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (this.cancelled) return 'skipped';
      if (this.interrupt === 'game') {
        log(`zmenšení klipu ${clip.id}: zapnula se hra - dokončí se potom`);
        return 'later-game';
      }
      if (this.interrupt === 'player') {
        log(`zmenšení klipu ${clip.id}: klip se otevřel v přehrávači - zkusí se na konci`);
        return 'later-player';
      }
      log(`zmenšení klipu ${clip.id} se nepovedlo: ${(e as Error).message}`);
      return 'skipped';
    } finally {
      this.interrupt = null;
    }
    if (this.cancelled) {
      rmSync(tmp, { force: true });
      return 'skipped';
    }
    const info = await probe(tmp);
    let after = 0;
    try {
      after = statSync(tmp).size;
    } catch {
      // nevzniklo
    }
    const verdict = compressedOk(
      { bytes: before.size, durationSeconds: clip.durationSeconds },
      { bytes: after, durationSeconds: info.durationSeconds, hasVideo: info.width !== null && info.height !== null }
    );
    if (verdict !== 'ok') {
      rmSync(tmp, { force: true });
      log(`zmenšení klipu ${clip.id}: ${verdict === 'broken' ? 'výsledek nesedí (délka / obraz) - původní zůstává' : 'menší by nebyl - nechává se'}`);
      // Už se o to příště nepokoušet (stejná nebo slabší úroveň by dopadla stejně).
      if (verdict === 'not-smaller') this.deps.update(clip.id, { compressed: { level, at: new Date().toISOString(), originalBytes: clip.compressed?.originalBytes ?? before.size } });
      return 'skipped';
    }
    // Mezitím se s klipem mohlo něco stát (zkrácení, smazání, nahrávání na Kine) - pak se nic nemění.
    const fresh = this.deps.get(id);
    let changed = !fresh || fresh.file !== clip.file || !!fresh.deletedAt || compressSkipReason(fresh, level) === 'uploading';
    if (!changed) {
      try {
        const st = statSync(clip.file);
        changed = st.size !== before.size || st.mtimeMs !== before.mtimeMs;
      } catch {
        changed = true;
      }
    }
    if (changed) {
      rmSync(tmp, { force: true });
      log(`zmenšení klipu ${clip.id}: klip se mezitím změnil - nechává se, jak je`);
      return 'skipped';
    }
    // Zmenšený soubor celý na disk dřív, než nahradí původní (výpadek proudu po výměně).
    try {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // nevadí - zapíše ho systém sám
    }
    // Výměna: původní stranou, zmenšený na jeho místo, pak původní pryč (při chybě zpátky).
    const backup = `${clip.file}.kine-orig`;
    try {
      rmSync(backup, { force: true });
      renameSync(clip.file, backup);
    } catch (e) {
      // Soubor drží jiný program (přehrávač, střih) - klip zůstane, jak je.
      rmSync(tmp, { force: true });
      log(`zmenšení klipu ${clip.id}: soubor je otevřený jinde (${(e as Error).message})`);
      return 'skipped';
    }
    try {
      renameSync(tmp, clip.file);
    } catch (e) {
      try {
        renameSync(backup, clip.file);
      } catch {
        // nemělo by nastat - záloha zůstane vedle s příponou .kine-orig (vrátí ji ClipLibrary.load)
      }
      rmSync(tmp, { force: true });
      log(`zmenšení klipu ${clip.id}: výměna souboru selhala (${(e as Error).message})`);
      return 'skipped';
    }
    rmSync(backup, { force: true });
    const original = clip.compressed?.originalBytes ?? before.size;
    this.deps.update(clip.id, {
      sizeBytes: after,
      width: info.width ?? clip.width,
      height: info.height ?? clip.height,
      durationSeconds: info.durationSeconds ?? clip.durationSeconds,
      compressed: { level, at: new Date().toISOString(), originalBytes: original },
    });
    this.status.savedBytes += before.size - after;
    log(`zmenšen klip ${clip.id}: ${Math.round(before.size / 1048576)} MB -> ${Math.round(after / 1048576)} MB (${level})`);
    return 'done';
  }

  private run(id: string, args: string[], totalSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnFfmpeg(args, { low: true });
      // Práce, na kterou nikdo nečeká - nejnižší priorita (hra, prohlížeč i střih mají přednost).
      if (child.pid) {
        try {
          setPriority(child.pid, osConstants.priority.PRIORITY_LOW);
        } catch {
          // zůstane "pod normálem"
        }
      }
      this.child = child;
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
      });
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        let idx: number;
        while ((idx = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, idx);
          stdout = stdout.slice(idx + 1);
          const percent = progressPercent(line, totalSeconds);
          if (percent !== null && percent !== this.status.percent) {
            this.status.percent = percent;
            this.emit();
          }
        }
      });
      // Zapnutá hra nebo otevřený klip = přerušit hned (klip se udělá znovu později).
      const watch = setInterval(() => {
        if (this.interrupt) return;
        if (this.deps.gameRunning()) this.interrupt = 'game';
        else if (this.deps.inUse(id)) this.interrupt = 'player';
        if (this.interrupt) child.kill('SIGKILL');
      }, 2000);
      // Hodinová nahrávka zápasu na pomalém PC trvá - strop jen proti zaseknutí.
      const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(10 * 60 * 1000, totalSeconds * 20 * 1000));
      const done = () => {
        clearTimeout(timer);
        clearInterval(watch);
        if (this.child === child) this.child = null;
      };
      child.on('error', (e) => {
        done();
        reject(e);
      });
      child.on('close', (code) => {
        done();
        if (code === 0 && !this.interrupt) resolve();
        else reject(new Error(this.interrupt ? `přerušeno (${this.interrupt})` : stderr.trim().split('\n').pop() || `ffmpeg ${code}`));
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
