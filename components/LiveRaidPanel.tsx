'use client';

import { useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n';
import { useLiveList } from '@/lib/useLiveList';
import { RAID_COUNTDOWN_S } from '@/lib/liveRaid';
import { gameBySlug } from '@/lib/games';
import ConfirmDialog from './ConfirmDialog';
import { PanelHeading } from './HelpTip';
import ProfileImage from './ProfileImage';
import UiIcon from './UiIcon';
import type { LiveItem } from './LiveNowRow';

/**
 * Studio: raid (app/api/live/raid). Během vysílání seznam kanálů, které
 * právě vysílají - jedním klikem k nim pošleš své diváky (jejich stránka
 * je za pár vteřin přesune). Chvíli po odeslání jde raid ještě zrušit.
 */
export default function LiveRaidPanel({ token, userId, live, onToast }: { token: string; userId: string; live: boolean; onToast: (message: string, type: 'success' | 'error') => void }) {
  const { t } = useLanguage();
  const [confirm, setConfirm] = useState<LiveItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ name: string; at: number } | null>(null);

  async function raid(item: LiveItem) {
    setConfirm(null);
    setBusy(true);
    const name = item.profile.displayName || item.profile.username;
    try {
      const res = await fetch('/api/live/raid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: item.ownerId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = body?.code;
        const text =
          code === 'cooldown'
            ? t('liveRaidErrCooldown').replace('{s}', String(body?.retryS ?? 60))
            : code === 'target-offline'
              ? t('liveRaidErrOffline')
              : code === 'target-raiding'
                ? t('liveRaidErrTargetRaiding')
              : code === 'pair-limit'
                ? t('liveRaidErrPair')
                : code === 'blocked'
                  ? t('liveRaidErrBlocked')
                  : code === 'not-live'
                    ? t('liveRaidOnlyLive')
                    : body?.error ?? t('liveRaidErrFailed');
        throw new Error(text);
      }
      setSent({ name, at: Date.now() });
      onToast(t('liveRaidSent').replace('{name}', name), 'success');
    } catch (e) {
      onToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch('/api/live/raid', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(t('liveRaidErrFailed'));
      setSent(null);
      onToast(t('liveRaidCancelled'), 'success');
    } catch (e) {
      onToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Zrušit jde, dokud diváci nejsou přesunutí (odpočet + rezerva na obnovu stránky).
  const cancellable = sent && Date.now() - sent.at < (RAID_COUNTDOWN_S + 20) * 1000;

  return (
    <div className="panel live-raid-panel">
      <PanelHeading icon="bolt" title={t('liveRaidHeading')} help={t('liveRaidHint')} />
      {confirm && (
        <ConfirmDialog
          message={t('liveRaidConfirm').replace('{name}', confirm.profile.displayName || confirm.profile.username)}
          onConfirm={() => void raid(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {!live ? (
        <p className="live-hint" style={{ margin: 0 }}>{t('liveRaidOnlyLive')}</p>
      ) : (
        <>
          {sent && (
            <div className="live-raid-sent" role="status">
              <UiIcon name="bolt" size={15} />
              <span>{t('liveRaidSent').replace('{name}', sent.name)}</span>
              {cancellable && (
                <button type="button" className="live-small-btn" onClick={cancel} disabled={busy}>
                  {t('liveRaidCancel')}
                </button>
              )}
            </div>
          )}
          <RaidTargets userId={userId} busy={busy} onPick={setConfirm} />
        </>
      )}
    </div>
  );
}

/** Kdo teď vysílá (bez mě a bez skrytých) - seznam se načítá jen během vlastního vysílání. */
function RaidTargets({ userId, busy, onPick }: { userId: string; busy: boolean; onPick: (item: LiveItem) => void }) {
  const { t } = useLanguage();
  const streams = useLiveList();
  const [query, setQuery] = useState('');
  const others = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (streams ?? [])
      .filter((s) => s.ownerId !== userId && !s.hidden)
      .filter((s) => !q || `${s.profile.displayName ?? ''} ${s.profile.username} ${s.title}`.toLocaleLowerCase().includes(q))
      .slice(0, 12);
  }, [streams, userId, query]);

  return (
    <>
      <label className="games-search live-raid-search">
        <UiIcon name="search" size={15} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('liveRaidSearch')} aria-label={t('liveRaidSearch')} maxLength={40} />
      </label>
      {streams === null ? (
        <p className="live-hint">{t('loading')}</p>
      ) : others.length === 0 ? (
        <p className="live-hint">{t('liveRaidNoneLive')}</p>
      ) : (
        <ul className="live-raid-list">
          {others.map((s) => {
            const name = s.profile.displayName || s.profile.username;
            const game = gameBySlug(s.game);
            return (
              <li key={s.ownerId} className="live-raid-item">
                <span className="live-raid-avatar" aria-hidden="true">
                  {s.profile.avatarUrl ? <ProfileImage src={s.profile.avatarUrl} /> : <span className="avatar-initial">{name.slice(0, 1).toUpperCase()}</span>}
                </span>
                <span className="live-raid-item-text">
                  <span className="live-raid-item-name">{name}</span>
                  <span className="live-raid-item-sub">
                    {game ? `${game.name} · ` : ''}
                    {s.title || '—'}
                  </span>
                </span>
                <button type="button" className="live-small-btn live-raid-btn" onClick={() => onPick(s)} disabled={busy}>
                  <UiIcon name="bolt" size={13} /> {t('liveRaidButton')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
