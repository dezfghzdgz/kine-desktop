/**
 * Klávesové zkratky appky.
 *
 * Zkratka je text z částí spojených plusem: modifikátory (Ctrl, Alt,
 * Shift, Super), klávesy (F8, S, 5, num5, Space, PageUp, `, …) a tlačítka
 * myši (Mouse3 = kolečko, Mouse4/Mouse5 = boční tlačítka). Může to být
 * klidně víc kláves najednou: "F8", "Ctrl+Shift+S", "F8+F9", "Ctrl+Mouse5".
 *
 * Dva způsoby, jak appka zkratku poslouchá:
 *  - jednoduchá (modifikátory + jedna klávesa): systémová zkratka přes
 *    Electron globalShortcut - funguje všude, i na macOS/Linuxu;
 *  - složená (víc kláves, tlačítko myši, klávesa jako Pause): pomocník na
 *    Windows (main/winHelper.ts) sleduje stav kláves přes GetAsyncKeyState.
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
};

export type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Super';

const MODIFIERS: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Super'];
const MOUSE = ['Mouse3', 'Mouse4', 'Mouse5'];

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
  for (const raw of text.split('+')) {
    const part = raw.trim();
    if (part === 'CommandOrControl' || part === 'Control' || part === 'Ctrl') mods.add('Ctrl');
    else if ((MODIFIERS as string[]).includes(part)) mods.add(part as Modifier);
    else if (MOUSE.includes(part)) {
      if (!mouse.includes(part)) mouse.push(part);
    } else if (KEYS[part]) {
      if (!keys.includes(part)) keys.push(part);
    } else return null;
  }
  if (keys.length + mouse.length === 0) return null;
  if (keys.length + mouse.length > 3) return null;
  return { mods: MODIFIERS.filter((m) => mods.has(m)), keys, mouse };
}

export function isHotkey(value: unknown): boolean {
  return parseHotkey(value) !== null;
}

/** Zpátky na text v pevném pořadí (Ctrl+Alt+Shift+Super+klávesy+myš). */
export function formatHotkey(h: Hotkey): string {
  return [...h.mods, ...h.keys, ...h.mouse].join('+');
}

/** Jde to jako systémová zkratka Electronu (modifikátory + jedna klávesa)? */
export function isSimpleHotkey(h: Hotkey): boolean {
  return h.mouse.length === 0 && h.keys.length === 1 && KEYS[h.keys[0]]?.electron !== null;
}

/** Electron accelerator pro jednoduchou zkratku, jinak null. */
export function toAccelerator(h: Hotkey): string | null {
  if (!isSimpleHotkey(h)) return null;
  return [...h.mods, KEYS[h.keys[0]].electron as string].join('+');
}

/** Virtual-key kódy pro pomocníka na Windows (Super = 0x5b, pomocník bere i pravou klávesu Win). */
export function hotkeyVks(h: Hotkey): number[] {
  return [...h.mods.map((m) => MOD_VK[m]), ...h.keys.map((k) => KEYS[k].vk), ...h.mouse.map((m) => MOUSE_VK[m])];
}

/** Lidsky čitelný tvar ("Ctrl + Shift + S", "Mouse 5", "F8 + F9"). */
export function hotkeyLabel(text: string): string {
  const h = parseHotkey(text);
  if (!h) return text;
  const parts = [
    ...h.mods.map((m) => (m === 'Super' ? 'Win' : m)),
    ...h.keys.map((k) => KEYS[k]?.label ?? k),
    ...h.mouse.map((m) => m.replace('Mouse', 'Mouse ')),
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
  private held = new Set<string>();

  /** Stisk (KeyboardEvent.code). Vrací true, když to bylo něco použitelného. */
  keyDown(code: string): boolean {
    const part = partFromCode(code);
    if (!part) return false;
    this.held.add(code);
    if (part.kind === 'mod') this.mods.add(part.part);
    else if (!this.keys.includes(part.part) && this.keys.length + this.mouse.length < 3) this.keys.push(part.part);
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
    if (!this.mouse.includes(part) && this.keys.length + this.mouse.length < 3) this.mouse.push(part);
    return true;
  }

  mouseUp(button: number): Hotkey | null {
    this.held.delete(`mouse:${button}`);
    return this.maybeDone();
  }

  /** Co je zatím stisknuté (pro živý náhled v poli). */
  current(): Hotkey {
    return { mods: MODIFIERS.filter((m) => this.mods.has(m)), keys: [...this.keys], mouse: [...this.mouse] };
  }

  /** Něco nahraného (mimo samotné modifikátory)? */
  hasKey(): boolean {
    return this.keys.length + this.mouse.length > 0;
  }

  reset(): void {
    this.mods.clear();
    this.keys = [];
    this.mouse = [];
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
