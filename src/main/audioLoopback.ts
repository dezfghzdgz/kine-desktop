import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { log } from './log';
import { isWindowsPolicyBlock } from './updateOutcome';
import LOOPBACK_CS from '../helper/KineLoopback.cs';

/**
 * Zvuk hry přímo z Windows (WASAPI loopback, stejně jako OBS).
 *
 * Normálně zvuk hry dává Chromium (getDisplayMedia, loopback výchozího
 * výstupu). U některých zařízení to ale nejde otevřít - virtuální 7.1
 * zařízení ovladačů headsetů (Logitech G HUB, Razer Synapse), Oculus /
 * Meta Quest, Steam Streaming: Chromium chce stereo a Windows odmítne
 * ("Could not start audio source"). OBS s tím problém nemá, protože
 * zařízení otevře v jeho vlastním formátu. Přesně to dělá tenhle pomocník
 * (src/helper/KineLoopback.cs přes PowerShell): zvuk převede na stereo
 * float32 a pošle ho sem, odsud jde do snímací stránky, kde z něj Web
 * Audio udělá stopu místo té z Chromia (src/renderer/capture.ts).
 *
 * Hráč nemusí nic nastavovat - spustí se sám, jen když cesta přes Chromium
 * nejde.
 */

export type LoopbackFormat = { sampleRate: number; channels: number; channelMask: number; device: string };
export type LoopbackStart = { ok: true; format: LoopbackFormat } | { ok: false; error: string };

type ParserEvents = {
  format: (format: LoopbackFormat) => void;
  audio: (samples: Uint8Array) => void;
  error: (text: string) => void;
};

/** Největší zpráva, kterou pomocník může poslat (zvuk po ~20 ms je pár kB). */
const MAX_FRAME = 4 * 1024 * 1024;

/**
 * Čtení protokolu pomocníka: "KLB1", pak zprávy [typ][délka u32 LE][data].
 * Cokoliv před "KLB1" (hlášky PowerShellu) se zahodí. Čisté - má test.
 */
export class LoopbackParser {
  private buf: Buffer = Buffer.alloc(0);
  private synced = false;

  constructor(private on: ParserEvents) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.synced) {
      const at = this.buf.indexOf('KLB1');
      if (at < 0) {
        // Kousek značky může být na konci - nechat poslední 3 bajty.
        if (this.buf.length > 3) this.buf = this.buf.subarray(this.buf.length - 3);
        return;
      }
      this.buf = this.buf.subarray(at + 4);
      this.synced = true;
    }
    while (this.buf.length >= 5) {
      const type = this.buf[0];
      const length = this.buf.readUInt32LE(1);
      if (length > MAX_FRAME || (type !== 0x41 && type !== 0x46 && type !== 0x45)) {
        this.buf = Buffer.alloc(0);
        this.synced = false;
        this.on.error('protocol');
        return;
      }
      if (this.buf.length < 5 + length) return;
      const payload = this.buf.subarray(5, 5 + length);
      this.buf = this.buf.subarray(5 + length);
      if (type === 0x41) {
        // Vlastní kopie (zarovnaná, bez zbytku proudu) - jde přes IPC.
        if (length >= 8) this.on.audio(new Uint8Array(payload));
      } else if (type === 0x46) {
        if (length < 12) continue;
        this.on.format({
          sampleRate: payload.readUInt32LE(0),
          channels: payload.readUInt16LE(4),
          channelMask: payload.readUInt32LE(8),
          device: payload.subarray(12).toString('utf8'),
        });
      } else {
        this.on.error(payload.toString('utf8').slice(0, 300));
      }
    }
  }
}

/** PowerShell: přeloží KineLoopback.cs (Add-Type) a pustí ho. Výstup je binární - nic jiného se na stdout nepíše. */
export const LOOPBACK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Smart App Control / App Control: nepodepsany skript bezi v omezenem rezimu, Add-Type nejde.
$langMode = [string]$ExecutionContext.SessionState.LanguageMode
if ($langMode -ne 'FullLanguage') {
  [Console]::Error.WriteLine('blocked: ' + $langMode)
  exit 3
}
try {
  $src = [System.IO.File]::ReadAllText($env:KINE_LOOPBACK_CS, [System.Text.Encoding]::UTF8)
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('addtype: ' + [string]$_)
  exit 4
}
exit ([KineLoopback.Capture]::Run())
`;

/** Zkouška bez Windows (KINE_TEST_FAKE_LOOPBACK): stejný protokol, tón 440 Hz ze "zařízení 7.1". */
const FAKE_HELPER = String.raw`
const out = process.stdout;
const frame = (type, payload) => { const head = Buffer.alloc(5); head[0] = type.charCodeAt(0); head.writeUInt32LE(payload.length, 1); out.write(Buffer.concat([head, payload])); };
out.write('Windows PowerShell hlaska pred znackou\r\n');
out.write('KLB1');
const rate = 48000;
const f = Buffer.alloc(12 + 4); f.writeUInt32LE(rate, 0); f.writeUInt16LE(8, 4); f.writeUInt32LE(0x63f, 8); f.write('fake', 12);
frame('F', f);
let n = 0;
const started = Date.now();
setInterval(() => {
  const want = Math.floor(((Date.now() - started) / 1000) * rate);
  const frames = Math.min(want - n, rate);
  if (frames <= 0) return;
  const pcm = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) { const s = 0.3 * Math.sin((2 * Math.PI * 440 * (n + i)) / rate); pcm.writeFloatLE(s, i * 8); pcm.writeFloatLE(s, i * 8 + 4); }
  n += frames;
  frame('A', pcm);
}, 20);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

export class NativeLoopback {
  private proc: ChildProcess | null = null;
  private target: WebContents | null = null;
  private wanted = false;
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Windows pomocníka nepustí (Smart App Control) - do restartu appky se nezkouší. */
  private blocked: string | null = null;
  private format: LoopbackFormat | null = null;
  private stderr = '';
  /** Číslo běhu: start() a stop() ho zvednou - časovače a odpovědi starších běhů pak nic nezastaví. */
  private run = 0;
  /** Nevyřízený start (snímací stránka čeká na odpověď) - nový start nebo stop ho ukončí. */
  private pending: ((result: LoopbackStart) => void) | null = null;
  private unwatchTarget: (() => void) | null = null;
  /** Pomocník v tomhle běhu appky už jednou pomohl - snímací stránka pak nezkouší Chromium dvakrát. */
  private helped = false;

  constructor(private userDataDir: string) {}

  static supported(): boolean {
    return process.platform === 'win32' || !!process.env.KINE_TEST_FAKE_LOOPBACK;
  }

  running(): boolean {
    return !!this.proc;
  }

  workedBefore(): boolean {
    return this.helped;
  }

  /**
   * Spustí pomocníka pro snímací stránku `target`. Vrátí formát, jakmile
   * pomocník zařízení otevře, nebo chybu (Windows nepustí, zařízení nejde
   * ani takhle, nic do 10 s). Zvuk pak chodí jako 'loopback:audio'.
   */
  start(target: WebContents): Promise<LoopbackStart> {
    this.stop();
    if (!NativeLoopback.supported()) return Promise.resolve({ ok: false, error: 'not windows' });
    if (this.blocked) return Promise.resolve({ ok: false, error: this.blocked });
    const run = ++this.run;
    this.target = target;
    this.wanted = true;
    this.restarts = [];
    // Snímací stránka zmizela (pád, konec snímání) - pomocník nemá komu posílat, pryč s ním.
    const onGone = () => {
      if (this.run === run) this.stop();
    };
    target.once('destroyed', onGone);
    this.unwatchTarget = () => {
      if (!target.isDestroyed()) target.removeListener('destroyed', onGone);
    };
    return new Promise<LoopbackStart>((resolve) => {
      let settled = false;
      const done = (result: LoopbackStart) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pending === done) this.pending = null;
        // Jen vlastní běh - starší start (nahrazený novým) nesmí zastavit ten nový.
        if (!result.ok && this.run === run) this.stop();
        if (result.ok) this.helped = true;
        resolve(result);
      };
      this.pending = done;
      // Přeložení C# při prvním spuštění chvíli trvá (pomalé PC i několik sekund).
      const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 10000);
      this.spawn(run, {
        onFormat: (format) => done({ ok: true, format }),
        onFail: (error) => done({ ok: false, error }),
      });
    });
  }

  stop(): void {
    this.run++;
    this.wanted = false;
    const pending = this.pending;
    this.pending = null;
    pending?.({ ok: false, error: 'stopped' });
    this.unwatchTarget?.();
    this.unwatchTarget = null;
    this.target = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        // už neběží
      }
      try {
        proc.kill();
      } catch {
        // už neběží
      }
    }
  }

  private send(channel: string, payload: unknown): void {
    const target = this.target;
    if (!target) return;
    if (target.isDestroyed()) {
      this.stop();
      return;
    }
    try {
      target.send(channel, payload);
    } catch {
      // stránka se právě zavírá
    }
  }

  private files(): { script: string; source: string } {
    const dir = join(this.userDataDir, 'helper');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'kine-loopback.ps1');
    const source = join(dir, 'KineLoopback.cs');
    writeFileSync(script, LOOPBACK_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8');
    writeFileSync(source, LOOPBACK_CS, 'utf8');
    return { script, source };
  }

  /** Spadl za běhu (nebo restart nedošel ani k formátu): znovu, nejvýš 3x za minutu, pak to vzdát a říct snímací stránce. */
  private restartLater(run: number, why: string): void {
    if (!this.wanted || this.run !== run) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60000);
    if (this.restarts.length >= 3 || this.blocked) {
      log(`zvuk hry přímo z Windows: pomocník pořád padá (${why}) - konec`);
      this.send('loopback:ended', why);
      this.wanted = false;
      return;
    }
    this.restarts.push(now);
    log(`zvuk hry přímo z Windows: pomocník skončil (${why}) - znovu`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && this.run === run && !this.proc) this.spawn(run);
    }, 1000);
  }

  private spawn(run: number, first?: { onFormat: (f: LoopbackFormat) => void; onFail: (error: string) => void }): void {
    let proc: ChildProcess;
    this.stderr = '';
    try {
      if (process.env.KINE_TEST_FAKE_LOOPBACK) {
        proc = spawn(process.execPath, ['-e', FAKE_HELPER], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else {
        const { script, source } = this.files();
        // Stdin zůstane otevřený: když appka skončí (i pádem), zavře se a pomocník skončí sám.
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, KINE_LOOPBACK_CS: source },
        });
      }
    } catch (e) {
      const why = (e as Error).message;
      log(`zvuk hry přímo z Windows: pomocník se nespustil: ${why}`);
      if (isWindowsPolicyBlock(why)) this.blocked = why;
      if (first) first.onFail(why);
      else this.restartLater(run, why);
      return;
    }
    this.proc = proc;
    proc.stdin?.on('error', () => {
      // pomocník už neběží
    });
    let gotFormat = false;
    const kill = () => {
      try {
        proc.kill();
      } catch {
        // už neběží
      }
    };
    const parser = new LoopbackParser({
      format: (format) => {
        const changed = !this.format || this.format.sampleRate !== format.sampleRate || this.format.channels !== format.channels || this.format.device !== format.device;
        this.format = format;
        if (changed) log(`zvuk hry přímo z Windows: ${format.sampleRate} Hz, ${format.channels} kanálů (maska 0x${format.channelMask.toString(16)})`);
        if (!gotFormat && first) first.onFormat(format);
        else this.send('loopback:format', format);
        gotFormat = true;
      },
      audio: (samples) => this.send('loopback:audio', samples),
      error: (text) => {
        log(`zvuk hry přímo z Windows: ${text}`);
        if (!gotFormat) first?.onFail(text);
        // Rozbitý proud: pomocníka ukončit - restart začne čistě od značky KLB1.
        if (text === 'protocol') kill();
      },
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.proc === proc) parser.push(chunk);
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (text: string) => {
      if (this.stderr.length < 2000) this.stderr += text;
    });
    proc.on('error', (e) => {
      // Nespustil se vůbec (nenalezeno, zakázáno) - "exit" pak nemusí přijít; nečekat zbytečně.
      log(`zvuk hry přímo z Windows: ${e.message}`);
      if (isWindowsPolicyBlock(e.message)) this.blocked = e.message;
      if (this.proc !== proc) return;
      this.proc = null;
      if (!gotFormat && first) first.onFail(e.message);
      else this.restartLater(run, e.message);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const why = this.stderr.trim().split('\n')[0]?.trim() || `exit ${code}`;
      if (code === 3 || /^blocked/.test(why)) this.blocked = why;
      if (!gotFormat && first) {
        log(`zvuk hry přímo z Windows nejde: ${why}`);
        first.onFail(why);
        return;
      }
      this.restartLater(run, why);
    });
  }
}
