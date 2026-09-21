import { globalShortcut } from 'electron';
import { hotkeyVks, isSimpleHotkey, parseHotkey, toAccelerator } from '../shared/hotkeys';
import type { WinHelper } from './winHelper';
import { log } from './log';

/**
 * Zkratky appky - dva motory pod jednou střechou:
 *  - jednoduché (modifikátory + jedna klávesa) přes Electron globalShortcut,
 *  - složené (víc kláves, tlačítka myši, Pause…) přes pomocníka na Windows,
 *    který sleduje GetAsyncKeyState.
 *
 * Který motor se použije, řeší tahle třída; zbytek appky jen dostane
 * "zkratka X stisknuta".
 */
export type HotkeyId = 'clip' | 'toggle';

export type HotkeyProblem = { id: HotkeyId; hotkey: string; reason: HotkeyReason };
export type HotkeyReason = 'in-use' | 'unsupported' | 'helper-down' | 'invalid';

export class HotkeyManager {
  private chordIds: HotkeyId[] = [];
  private wanted: Record<HotkeyId, string> = { clip: '', toggle: '' };
  private problems: HotkeyProblem[] = [];
  private registered = new Set<string>();

  constructor(
    private deps: {
      helper: WinHelper | null;
      onFire: (id: HotkeyId) => void;
      onProblemsChanged: () => void;
    }
  ) {
    deps.helper?.on({
      hotkey: (index) => {
        const id = this.chordIds[index];
        if (id) deps.onFire(id);
      },
      state: () => {
        // Pomocník naběhl/spadl - složené zkratky s ním ožívají/umírají.
        this.recomputeProblems();
        deps.onProblemsChanged();
      },
    });
  }

  chordsSupported(): boolean {
    return !!this.deps.helper && process.platform === 'win32';
  }

  currentProblems(): HotkeyProblem[] {
    return this.problems;
  }

  /** Zaregistruje obě zkratky; co nejde, skončí v problems (a hráč to uvidí). */
  apply(hotkeys: Record<HotkeyId, string>): HotkeyProblem[] {
    this.wanted = { ...hotkeys };
    globalShortcut.unregisterAll();
    this.registered.clear();
    const chords: number[][] = [];
    this.chordIds = [];

    for (const id of ['clip', 'toggle'] as HotkeyId[]) {
      const text = hotkeys[id];
      const parsed = parseHotkey(text);
      if (!parsed) continue;
      if (isSimpleHotkey(parsed)) {
        const acc = toAccelerator(parsed)!;
        let ok = false;
        try {
          ok = globalShortcut.register(acc, () => this.deps.onFire(id));
        } catch (e) {
          log(`zkratka ${acc}: ${(e as Error).message}`);
        }
        if (ok) this.registered.add(text);
        else log(`zkratku ${acc} nejde zaregistrovat (drží ji jiný program)`);
      } else if (this.chordsSupported()) {
        this.chordIds.push(id);
        chords.push(hotkeyVks(parsed));
      }
    }
    this.deps.helper?.setHotkeys(chords);
    this.recomputeProblems();
    return this.problems;
  }

  private recomputeProblems(): void {
    const problems: HotkeyProblem[] = [];
    for (const id of ['clip', 'toggle'] as HotkeyId[]) {
      const text = this.wanted[id];
      if (!text) continue;
      const parsed = parseHotkey(text);
      if (!parsed) {
        problems.push({ id, hotkey: text, reason: 'invalid' });
        continue;
      }
      if (isSimpleHotkey(parsed)) {
        if (!this.registered.has(text)) problems.push({ id, hotkey: text, reason: 'in-use' });
      } else if (!this.chordsSupported()) {
        problems.push({ id, hotkey: text, reason: 'unsupported' });
      } else if (!this.deps.helper?.isRunning()) {
        problems.push({ id, hotkey: text, reason: 'helper-down' });
      }
    }
    this.problems = problems;
  }

  /** Půjde tahle zkratka? (pro pole v nastavení, ještě před uložením) */
  available(text: string): HotkeyReason | 'ok' {
    const parsed = parseHotkey(text);
    if (!parsed) return 'invalid';
    if (!isSimpleHotkey(parsed)) {
      if (!this.chordsSupported()) return 'unsupported';
      return this.deps.helper?.isRunning() ? 'ok' : 'helper-down';
    }
    if (this.registered.has(text)) return 'ok';
    const acc = toAccelerator(parsed)!;
    if (globalShortcut.isRegistered(acc)) return 'ok';
    try {
      const ok = globalShortcut.register(acc, () => undefined);
      if (ok) globalShortcut.unregister(acc);
      return ok ? 'ok' : 'in-use';
    } catch {
      return 'in-use';
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll();
  }
}
