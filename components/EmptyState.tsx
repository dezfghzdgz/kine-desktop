import type { ReactNode } from 'react';
import UiIcon, { type UiIconName } from './UiIcon';

/**
 * Prázdná stránka / sekce: ikonka v kroužku, nadpis, řádek vysvětlení
 * a případně tlačítko (Vaše videa, Historie stažení, Aktivita...).
 */
export default function EmptyState({ icon, title, text, action, compact = false }: { icon: UiIconName; title: string; text?: string | null; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state panel${compact ? ' compact' : ''}`}>
      <span className="empty-state-icon" aria-hidden="true">
        <UiIcon name={icon} size={compact ? 20 : 26} />
      </span>
      <p className="empty-state-title">{title}</p>
      {text && <p className="empty-state-text">{text}</p>}
      {action}
    </div>
  );
}
