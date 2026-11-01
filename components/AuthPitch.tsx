'use client';

import { useLanguage } from '@/lib/i18n';
import UiIcon, { type UiIconName } from './UiIcon';

const PITCH: { icon: UiIconName; title: 'signupPitchVideosTitle' | 'signupPitchLiveTitle' | 'signupPitchClipsTitle' | 'signupPitchFreeTitle'; text: 'signupPitchVideos' | 'signupPitchLive' | 'signupPitchClips' | 'signupPitchFree' }[] = [
  { icon: 'film', title: 'signupPitchVideosTitle', text: 'signupPitchVideos' },
  { icon: 'broadcast', title: 'signupPitchLiveTitle', text: 'signupPitchLive' },
  { icon: 'gamepad', title: 'signupPitchClipsTitle', text: 'signupPitchClips' },
  { icon: 'chat', title: 'signupPitchFreeTitle', text: 'signupPitchFree' },
];

/**
 * Co Kine je - vlevo vedle registrace a přihlášení, aby to nebyl jen
 * formulář bez kontextu (na mobilu pod formulářem / schované - CSS .signup).
 */
export default function AuthPitch({ title }: { title?: string }) {
  const { t } = useLanguage();
  return (
    <aside className="signup-pitch">
      <p className="signup-kicker">Kine</p>
      <h2>{title ?? t('signupPitchTitle')}</h2>
      <ul>
        {PITCH.map((p) => (
          <li key={p.icon}>
            <span className="signup-pitch-icon" aria-hidden="true">
              <UiIcon name={p.icon} size={20} />
            </span>
            <span>
              <b>{t(p.title)}</b>
              <span>{t(p.text)}</span>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
