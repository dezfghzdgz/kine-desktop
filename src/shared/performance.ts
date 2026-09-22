/**
 * Kolik výkonu smí appka brát - jedna volba v nastavení, která řídí, jak
 * často se appka na co ptá. Nic z toho nemění kvalitu klipů (tu má
 * hráč zvlášť v Kvalitě); jde o hlídání her, pomocníka pro Windows,
 * herní události, náhledy v knihovně a kontrolu aktualizací.
 *
 *  low       - úsporný: slabší PC nebo hra, která potřebuje každé procento;
 *              hra se pozná do ~10 s, náhledy při najetí vypnuté
 *  balanced  - výchozí (dnešní chování)
 *  high      - výkon: rychlá reakce (hra do ~2 s, ovladač 15 ms), na
 *              silném PC to není znát
 */
import type { PerformanceMode } from './types';

export type { PerformanceMode };

export type PerformanceProfile = {
  /** Jak často se hlídají hry (procesy, Steam, popředí), ms. */
  gamePollMs: number;
  /** Pomocník na Windows: smyčka pro kombinace kláves / tlačítka myši / ovladač, ms. */
  helperFastMs: number;
  /** Pomocník: jak často hlásí okno v popředí, ms. */
  helperForegroundMs: number;
  /** Pomocník: jak často posílá seznam procesů, s. */
  helperProcessesS: number;
  /** League of Legends Live Client API, ms. */
  lolPollMs: number;
  /** Tiché přehrávání klipu při najetí myší na kartu. */
  hoverPreview: boolean;
  /** Kontrola aktualizací, h. */
  updateCheckHours: number;
};

export const PERFORMANCE: Record<PerformanceMode, PerformanceProfile> = {
  low: { gamePollMs: 10000, helperFastMs: 50, helperForegroundMs: 2000, helperProcessesS: 10, lolPollMs: 4000, hoverPreview: false, updateCheckHours: 24 },
  balanced: { gamePollMs: 5000, helperFastMs: 30, helperForegroundMs: 1000, helperProcessesS: 5, lolPollMs: 2000, hoverPreview: true, updateCheckHours: 6 },
  high: { gamePollMs: 2000, helperFastMs: 15, helperForegroundMs: 500, helperProcessesS: 3, lolPollMs: 1000, hoverPreview: true, updateCheckHours: 6 },
};

export const PERFORMANCE_MODES: readonly PerformanceMode[] = ['low', 'balanced', 'high'];

export function performanceProfile(mode: unknown): PerformanceProfile {
  return PERFORMANCE[(PERFORMANCE_MODES as readonly string[]).includes(String(mode)) ? (mode as PerformanceMode) : 'balanced'];
}
