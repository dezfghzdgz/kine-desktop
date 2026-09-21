/**
 * Převod stisku klávesy (z pole "Zkratka" v nastavení) na Electron
 * accelerator, tedy řetězec jako "F8" nebo "Ctrl+Shift+S".
 *
 * Bere se event.code, ne event.key: kód nezávisí na rozložení klávesnice
 * ani na tom, jestli je zapnutý Shift, takže "Shift+S" nedopadne jako
 * "Shift+s" nebo "Shift+S" podle nálady prohlížeče.
 */

export type KeyLike = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

const SPECIAL: Record<string, string> = {
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

/** Samotné modifikátory (stisknutý jen Ctrl) zkratku nedělají - vrací null. */
export function acceleratorFromKey(e: KeyLike): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

function keyName(code: string): string | null {
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
  return SPECIAL[code] ?? null;
}

/** Lidsky čitelný tvar pro zobrazení ("Ctrl + Shift + S"). */
export function acceleratorLabel(acc: string): string {
  return acc.split('+').join(' + ');
}
