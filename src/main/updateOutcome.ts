/**
 * Čistá část hlídání aktualizací (bez electronu - testuje se): jak dopadla
 * poslední instalace a jestli je ve Windows zapnutý Smart App Control.
 *
 * Před "Aktualizovat" si appka zapíše pokus (z jaké verze na jakou).
 * Instalátor (build/installer.nsh) zapíše do
 * %LOCALAPPDATA%\<appka>-updater\installer-result.txt výsledek:
 *   result=ok | blocked | in-use | files-missing
 *   version=0.9.9
 * Po dalším startu appka obojí porovná se svou verzí a jednou řekne, co se
 * stalo (hlavně proč aktualizace neprošla - stará verze zůstala a běží).
 */
import type { SmartAppControlState, UpdateIssue } from '../shared/types';
import { isNewerVersion } from './updaterParse';

export type InstallerResultKind = 'ok' | 'blocked' | 'in-use' | 'files-missing';
export type InstallerResult = { result: InstallerResultKind; version: string | null };
export type UpdateAttempt = { from: string; to: string; at: number };

export type UpdateFailReason = UpdateIssue['reason'];
export type UpdateOutcome =
  | { kind: 'none' }
  | { kind: 'updated'; from: string; to: string }
  | { kind: 'failed'; version: string; reason: UpdateFailReason };

const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Starší pokus než tohle se už nehlásí (appka mezitím běžela, hráč si ho nepamatuje). */
export const ATTEMPT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** installer-result.txt -> výsledek, nebo null (prázdné / nesmysl). */
export function parseInstallerResult(text: string | null | undefined): InstallerResult | null {
  if (!text) return null;
  const get = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(text)?.[1] ?? '';
  const result = get('result');
  if (result !== 'ok' && result !== 'blocked' && result !== 'in-use' && result !== 'files-missing') return null;
  const version = get('version');
  return { result, version: VERSION_RE.test(version) ? version : null };
}

/** update-attempt.json -> pokus, nebo null. */
export function parseUpdateAttempt(text: string | null | undefined): UpdateAttempt | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<UpdateAttempt>;
    const from = String(raw?.from ?? '');
    const to = String(raw?.to ?? '');
    const at = Number(raw?.at);
    if (!VERSION_RE.test(from) || !VERSION_RE.test(to) || !Number.isFinite(at)) return null;
    return { from, to, at };
  } catch {
    return null;
  }
}

/**
 * Jak dopadla poslední aktualizace (po startu appky).
 *  - pokus z appky a běží nová verze -> updated
 *  - pokus z appky a běží pořád ta stará -> failed (důvod od instalátoru;
 *    když instalátor nic nezapsal, nejspíš se vůbec nespustil)
 *  - bez pokusu (aktualizaci spustila starší verze appky nebo hráč ručně),
 *    ale instalátor hlásí neúspěch novější verze -> failed
 */
export function judgeUpdateOutcome(input: {
  current: string;
  attempt: UpdateAttempt | null;
  installer: InstallerResult | null;
  now: number;
}): UpdateOutcome {
  const { current, installer, now } = input;
  const attempt = input.attempt && now - input.attempt.at >= -60_000 && now - input.attempt.at < ATTEMPT_MAX_AGE_MS ? input.attempt : null;
  if (attempt) {
    if (current === attempt.to || isNewerVersion(current, attempt.to)) return { kind: 'updated', from: attempt.from, to: current };
    if (current === attempt.from || !isNewerVersion(current, attempt.from)) {
      const reason: UpdateFailReason =
        installer && installer.result !== 'ok' && (installer.version === null || installer.version === attempt.to) ? installer.result : 'not-started';
      return { kind: 'failed', version: attempt.to, reason };
    }
    return { kind: 'none' };
  }
  if (installer && installer.result !== 'ok' && installer.version && isNewerVersion(installer.version, current)) {
    return { kind: 'failed', version: installer.version, reason: installer.result };
  }
  return { kind: 'none' };
}

/**
 * Výstup `reg query HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy /v
 * VerifiedAndReputablePolicyState` -> stav Smart App Control
 * (0 vypnuto, 1 zapnuto, 2 zkušební režim - nic neblokuje).
 */
export function parseSmartAppControl(output: string | null | undefined): SmartAppControlState | null {
  if (!output) return null;
  const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  if (!m) return null;
  const value = parseInt(m[1], 16);
  if (value === 0) return 'off';
  if (value === 1) return 'on';
  if (value === 2) return 'evaluation';
  return null;
}

/**
 * Chyba kvůli politice Windows (Smart App Control / App Control / AppLocker)?
 * Např. Add-Type v pomocníkovi: "An Application Control policy has blocked
 * this file. (Exception from HRESULT: 0x800711C7)".
 */
export function isWindowsPolicyBlock(message: string | null | undefined): boolean {
  if (!message) return false;
  return /application control|applocker|0x800711C7|smart app control|blocked by (?:your )?(?:system administrator|group policy)|policy has blocked/i.test(message);
}
