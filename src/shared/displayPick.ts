/**
 * Který monitor snímat (klipy i živé vysílání - obojí jde z jednoho snímání).
 *
 * Hráč si monitor vybere v Nastavení -> Snímání nebo přímo v záložce Živě
 * (nastavení displayId = id monitoru z Electronu, '' = hlavní). Zdroje
 * obrazovek od desktopCapturer mají display_id, podle kterého se najde ten
 * správný. Na některých počítačích s Windows (dvě grafiky, notebook +
 * monitor) Electron display_id nevyplní - pak by se vždy snímal první zdroj
 * a výběr monitoru by nic nedělal. Pořadí zdrojů ale odpovídá pořadí monitorů
 * (screen.getAllDisplays), takže se v tom případě vezme zdroj na stejném místě.
 */

export type ScreenSourceLike = { id: string; display_id: string };
export type DisplayRef = { id: string; primary: boolean };

export function pickScreenSource<T extends ScreenSourceLike>(sources: T[], displays: DisplayRef[], wantedId: string): T | null {
  if (sources.length === 0) return null;
  const noIds = sources.every((s) => !s.display_id);
  const byDisplay = (id: string): T | undefined => (id ? sources.find((s) => s.display_id === id) : undefined);
  const byIndex = (id: string): T | undefined => {
    if (!id || !noIds) return undefined;
    const index = displays.findIndex((d) => d.id === id);
    return index >= 0 ? sources[index] : undefined;
  };
  const wanted = wantedId.trim();
  if (wanted) {
    const exact = byDisplay(wanted) ?? byIndex(wanted);
    if (exact) return exact;
  }
  const primary = displays.find((d) => d.primary)?.id ?? '';
  return byDisplay(primary) ?? byIndex(primary) ?? sources[0];
}
