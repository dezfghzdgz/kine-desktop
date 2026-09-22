/**
 * Klávesové zkratky appky.
 *
 * Zkratka je text z částí spojených plusem: modifikátory (Ctrl, Alt,
 * Shift, Super), klávesy (F8, S, 5, num5, Space, PageUp, `, …), tlačítka
 * myši (Mouse3 = kolečko, Mouse4/Mouse5 = boční tlačítka) a tlačítka
 * ovladače (PadA, PadRB, PadBack, PadUp…). Může to být klidně víc kláves
 * najednou: "F8", "Ctrl+Shift+S", "F8+F9", "Ctrl+Mouse5", "PadBack+PadRB".
 *
 * Dva způsoby, jak appka zkratku poslouchá:
 *  - jednoduchá (modifikátory + jedna klávesa): systémová zkratka přes
 *    Electron globalShortcut - funguje všude, i na macOS/Linuxu;
 *  - složená (víc kláves, tlačítko myši, klávesa jako Pause, ovladač):
 *    pomocník na Windows (main/winHelper.ts) sleduje stav kláves přes
 *    GetAsyncKeyState a ovladač přes XInput.
 *
 * Bere se event.code, ne event.key: kód nezávisí na rozložení klávesnice
 * ani na Shiftu, takže "Shift+S" nedopadne jako "Shift+s".
 */

export type Hotkey = {
  /** V pevném pořadí Ctrl, Alt, Shift, Super. */
  mods: Modifier[];
  /** Klávesy mimo modifikátory (názvy částí, např. "F8", "S", "num5", "Space"). */
  keys: string[];
  /** "Mouse3" | "Mouse4" | "Mouse5". */
  mouse: string[];
  /** Tlačítka ovladače ("PadA", "PadRB", …) - drží se všechna najednou. */
  pad: string[];
};

export type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Super';

const MODIFIERS: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Super'];
const MOUSE = ['Mouse3', 'Mouse4', 'Mouse5'];

/**
 * Tlačítka ovladače (Xbox / XInput): název části -> maska XInput wButtons
 * (spouště LT/RT jako vlastní bity nad ní), popisek a pořadí tlačítka ve
 * standardním rozložení Gamepad API prohlížeče (pro záznam v nastavení).
 * Pomocník na Windows dostane masku posunutou o PAD_VK_BASE, aby se
 * vešla mezi virtual-key kódy kláves.
 */
export const PAD_VK_BASE = 0x100000;
export const PAD_BUTTONS: Record<string, { mask: number; label: string; gamepadIndex: number }> = {
  PadA: { mask: 0x1000, label: 'A', gamepadIndex: 0 },
  PadB: { mask: 0x2000, label: 'B', gamepadIndex: 1 },
  PadX: { mask: 0x4000, label: 'X', gamepadIndex: 2 },
  PadY: { mask: 0x8000, label: 'Y', gamepadIndex: 3 },
  PadLB: { mask: 0x0100, label: 'LB', gamepadIndex: 4 },
  PadRB: { mask: 0x0200, label: 'RB', gamepadIndex: 5 },
  PadLT: { mask: 0x10000, label: 'LT', gamepadIndex: 6 },
  PadRT: { mask: 0x20000, label: 'RT', gamepadIndex: 7 },
  PadBack: { mask: 0x0020, label: 'View', gamepadIndex: 8 },
  PadStart: { mask: 0x0010, label: 'Menu', gamepadIndex: 9 },
  PadLS: { mask: 0x0040, label: 'LS', gamepadIndex: 10 },
  PadRS: { mask: 0x0080, label: 'RS', gamepadIndex: 11 },
  PadUp: { mask: 0x0001, label: 'D-pad ↑', gamepadIndex: 12 },
  PadDown: { mask: 0x0002, label: 'D-pad ↓', gamepadIndex: 13 },
  PadLeft: { mask: 0x0004, label: 'D-pad ←', gamepadIndex: 14 },
  PadRight: { mask: 0x0008, label: 'D-pad →', gamepadIndex: 15 },
};
const PAD_ORDER = Object.keys(PAD_BUTTONS);

/** Část zkratky podle pořadí tlačítka ve standardním rozložení Gamepad API, nebo null. */
export function partFromGamepadButton(index: number): string | null {
  return PAD_ORDER.find((name) => PAD_BUTTONS[name].gamepadIndex === index) ?? null;
}

/** Klávesy podle názvu části -> Windows virtual-key kód (pro pomocníka) a název pro Electron. */
const KEYS: Record<string, { vk: number; electron: string | null; label?: string }> = {
  Space: { vk: 0x20, electron: 'Space' },
  Insert: { vk: 0x2d, electron: 'Insert' },
  Delete: { vk: 0x2e, electron: 'Delete' },
  Home: { vk: 0x24, electron: 'Home' },
  End: { vk: 0x23, electron: 'End' },
  PageUp: { vk: 0x21, electron: 'PageUp' },
  PageDown: { vk: 0x22, electron: 'PageDown' },
  Pause: { vk: 0x13, electron: null },
  ScrollLock: { vk: 0x91, electron: 'Scrolllock' },
  PrintScreen: { vk: 0x2c, electron: 'PrintScreen' },
  Tab: { vk: 0x09, electron: 'Tab' },
  CapsLock: { vk: 0x14, electron: 'Capslock' },
  Backspace: { vk: 0x08, electron: 'Backspace' },
  Enter: { vk: 0x0d, electron: 'Enter' },
  Up: { vk: 0x26, electron: 'Up', label: '↑' },
  Down: { vk: 0x28, electron: 'Down', label: '↓' },
  Left: { vk: 0x25, electron: 'Left', label: '←' },
  Right: { vk: 0x27, electron: 'Right', label: '→' },
  numadd: { vk: 0x6b, electron: 'numadd', label: 'Num +' },
  numsub: { vk: 0x6d, electron: 'numsub', label: 'Num -' },
  nummult: { vk: 0x6a, electron: 'nummult', label: 'Num *' },
  numdiv: { vk: 0x6f, electron: 'numdiv', label: 'Num /' },
  numdec: { vk: 0x6e, electron: 'numdec', label: 'Num .' },
  '`': { vk: 0xc0, electron: '`' },
  '-': { vk: 0xbd, electron: '-' },
  '=': { vk: 0xbb, electron: '=' },
  '[': { vk: 0xdb, electron: '[' },
  ']': { vk: 0xdd, electron: ']' },
  '\\': { vk: 0xdc, electron: '\\' },
  ';': { vk: 0xba, electron: ';' },
  "'": { vk: 0xde, electron: "'" },
  ',': { vk: 0xbc, electron: ',' },
  '.': { vk: 0xbe, electron: '.' },
  '/': { vk: 0xbf, electron: '/' },
};
for (let i = 1; i <= 24; i++) KEYS[`F${i}`] = { vk: 0x6f + i, electron: `F${i}` };
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i);
  KEYS[letter] = { vk: 0x41 + i, electron: letter };
}
for (let i = 0; i <= 9; i++) {
  KEYS[String(i)] = { vk: 0x30 + i, electron: String(i) };
  KEYS[`num${i}`] = { vk: 0x60 + i, electron: `num${i}`, label: `Num ${i}` };
}

const MOD_VK: Record<Modifier, number> = { Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Super: 0x5b };
const MOUSE_VK: Record<string, number> = { Mouse3: 0x04, Mouse4: 0x05, Mouse5: 0x06 };

/** Rozebere text zkratky; neplatný text -> null. */
export function parseHotkey(text: unknown): Hotkey | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const mods = new Set<Modifier>();
  const keys: string[] = [];
  const mouse: string[] = [];
  const pad: string[] = [];
  for (const raw of text.split('+')) {
    const part = raw.trim();
    if (part === 'CommandOrControl' || part === 'Control' || part === 'Ctrl') mods.add('Ctrl');
    else if ((MODIFIERS as string[]).includes(part)) mods.add(part as Modifier);
    else if (MOUSE.includes(part)) {
      if (!mouse.includes(part)) mouse.push(part);
    } else if (PAD_BUTTONS[part]) {
      if (!pad.includes(part)) pad.push(part);
    } else if (KEYS[part]) {
      if (!keys.includes(part)) keys.push(part);
    } else return null;
  }
  if (keys.length + mouse.length + pad.length === 0) return null;
  if (keys.length + mouse.length + pad.length > 3) return null;
  // Ovladač je vždy jen ovladač - modifikátory klávesnice se s ním nekombinují.
  if (pad.length > 0 && mods.size > 0) return null;
  return { mods: MODIFIERS.filter((m) => mods.has(m)), keys, mouse, pad: PAD_ORDER.filter((p) => pad.includes(p)) };
}

export function isHotkey(value: unknown): boolean {
  return parseHotkey(value) !== null;
}

/** Zpátky na text v pevném pořadí (Ctrl+Alt+Shift+Super+klávesy+myš+ovladač). */
export function formatHotkey(h: Hotkey): string {
  return [...h.mods, ...h.keys, ...h.mouse, ...(h.pad ?? [])].join('+');
}

/** Je ve zkratce ovladač? */
export function hasPad(h: Hotkey): boolean {
  return (h.pad?.length ?? 0) > 0;
}

/** Jde to jako systémová zkratka Electronu (modifikátory + jedna klávesa)? */
export function isSimpleHotkey(h: Hotkey): boolean {
  return h.mouse.length === 0 && !hasPad(h) && h.keys.length === 1 && KEYS[h.keys[0]]?.electron !== null;
}

/** Electron accelerator pro jednoduchou zkratku, jinak null. */
export function toAccelerator(h: Hotkey): string | null {
  if (!isSimpleHotkey(h)) return null;
  return [...h.mods, KEYS[h.keys[0]].electron as string].join('+');
}

/**
 * Virtual-key kódy pro pomocníka na Windows (Super = 0x5b, pomocník bere i
 * pravou klávesu Win). Tlačítka ovladače jako PAD_VK_BASE + maska XInput -
 * pomocník podle základu pozná, že se má ptát ovladače, ne klávesnice.
 */
export function hotkeyVks(h: Hotkey): number[] {
  return [
    ...h.mods.map((m) => MOD_VK[m]),
    ...h.keys.map((k) => KEYS[k].vk),
    ...h.mouse.map((m) => MOUSE_VK[m]),
    ...(h.pad ?? []).map((p) => PAD_VK_BASE + PAD_BUTTONS[p].mask),
  ];
}

/** Lidsky čitelný tvar ("Ctrl + Shift + S", "Mouse 5", "F8 + F9", "🎮 View + RB"). */
export function hotkeyLabel(text: string): string {
  const h = parseHotkey(text);
  if (!h) return text;
  const parts = [
    ...h.mods.map((m) => (m === 'Super' ? 'Win' : m)),
    ...h.keys.map((k) => KEYS[k]?.label ?? k),
    ...h.mouse.map((m) => m.replace('Mouse', 'Mouse ')),
    ...(h.pad ?? []).map((p, i) => (i === 0 ? '🎮 ' : '') + PAD_BUTTONS[p].label),
  ];
  return parts.join(' + ');
}

// ---- záznam zkratky v okně nastavení -------------------------------------------

const CODE_MODIFIERS: Record<string, Modifier> = {
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Super',
  MetaRight: 'Super',
};

const CODE_SPECIAL: Record<string, string> = {
  Space: 'Space',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Pause: 'Pause',
  ScrollLock: 'ScrollLock',
  PrintScreen: 'PrintScreen',
  Tab: 'Tab',
  CapsLock: 'CapsLock',
  Backspace: 'Backspace',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** Část zkratky z KeyboardEvent.code, nebo null (Escape, neznámé klávesy). */
export function partFromCode(code: string): { kind: 'mod'; part: Modifier } | { kind: 'key'; part: string } | null {
  if (CODE_MODIFIERS[code]) return { kind: 'mod', part: CODE_MODIFIERS[code] };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return { kind: 'key', part: code };
  if (/^Key[A-Z]$/.test(code)) return { kind: 'key', part: code.slice(3) };
  if (/^Digit[0-9]$/.test(code)) return { kind: 'key', part: code.slice(5) };
  if (/^Numpad[0-9]$/.test(code)) return { kind: 'key', part: 'num' + code.slice(6) };
  const special = CODE_SPECIAL[code];
  return special ? { kind: 'key', part: special } : null;
}

/** Tlačítko myši z MouseEvent.button: 1 = kolečko, 3 a 4 = boční. Levé a pravé se nenabízí. */
export function partFromMouseButton(button: number): string | null {
  return button === 1 ? 'Mouse3' : button === 3 ? 'Mouse4' : button === 4 ? 'Mouse5' : null;
}

/**
 * Skládá zkratku z kláves, které hráč právě drží. Přidávají se během
 * držení, hotovo je, když všechno pustí (nebo když se kombinace
 * ustálí). Čistá logika, aby šla otestovat.
 */
export class HotkeyRecorder {
  private mods = new Set<Modifier>();
  private keys: string[] = [];
  private mouse: string[] = [];
  private pad: string[] = [];
  private held = new Set<string>();

  /** Stisk (KeyboardEvent.code). Vrací true, když to bylo něco použitelného. */
  keyDown(code: string): boolean {
    const part = partFromCode(code);
    if (!part) return false;
    this.held.add(code);
    if (part.kind === 'mod') this.mods.add(part.part);
    else if (!this.keys.includes(part.part) && this.count() < 3) this.keys.push(part.part);
    return true;
  }

  /** Puštění; vrací hotovou zkratku, když už nic nedrží a něco nahrál. */
  keyUp(code: string): Hotkey | null {
    this.held.delete(code);
    return this.maybeDone();
  }

  mouseDown(button: number): boolean {
    const part = partFromMouseButton(button);
    if (!part) return false;
    this.held.add(`mouse:${button}`);
    if (!this.mouse.includes(part) && this.count() < 3) this.mouse.push(part);
    return true;
  }

  mouseUp(button: number): Hotkey | null {
    this.held.delete(`mouse:${button}`);
    return this.maybeDone();
  }

  /**
   * Stav tlačítek ovladače (Gamepad API, standardní rozložení): která jsou
   * teď stisknutá. Volá se dokola při záznamu; vrací hotovou zkratku, když
   * hráč všechno pustil.
   */
  padState(pressedIndexes: number[]): Hotkey | null {
    const now = new Set<string>();
    for (const index of pressedIndexes) {
      const part = partFromGamepadButton(index);
      if (!part) continue;
      now.add(`pad:${part}`);
      if (!this.pad.includes(part) && this.count() < 3) this.pad.push(part);
    }
    for (const key of [...this.held]) if (key.startsWith('pad:') && !now.has(key)) this.held.delete(key);
    for (const key of now) this.held.add(key);
    return this.maybeDone();
  }

  private count(): number {
    return this.keys.length + this.mouse.length + this.pad.length;
  }

  /** Co je zatím stisknuté (pro živý náhled v poli). S ovladačem se modifikátory klávesnice neberou. */
  current(): Hotkey {
    const pad = PAD_ORDER.filter((p) => this.pad.includes(p));
    return { mods: pad.length > 0 ? [] : MODIFIERS.filter((m) => this.mods.has(m)), keys: [...this.keys], mouse: [...this.mouse], pad };
  }

  /** Něco nahraného (mimo samotné modifikátory)? */
  hasKey(): boolean {
    return this.count() > 0;
  }

  reset(): void {
    this.mods.clear();
    this.keys = [];
    this.mouse = [];
    this.pad = [];
    this.held.clear();
  }

  private maybeDone(): Hotkey | null {
    if (this.held.size > 0) return null;
    // Všechno puštěné. Samotné modifikátory zkratku nedělají - zahodí se,
    // ať nezůstane Shift viset do dalšího pokusu.
    if (!this.hasKey()) {
      this.reset();
      return null;
    }
    const done = this.current();
    this.reset();
    return done;
  }
}
