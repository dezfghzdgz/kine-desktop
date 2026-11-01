'use client';

import Link from 'next/link';
import { listenForPushResubscribe, syncPush } from '@/lib/pushClient';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage } from '@/lib/i18n';
import { CATEGORY_KEYS } from '@/lib/categories';
import { useMobileNav } from '@/lib/mobileNavContext';
import BrandLogo from './BrandLogo';
import ProfileMenu from './ProfileMenu';
import NotificationBell from './NotificationBell';
import SparksNavButton from './SparksNavButton';
import { useUserRole } from '@/lib/useUserRole';
import { isInDesktopApp } from '@/lib/desktopRelease';
import { useLiveCount } from '@/lib/useLiveCount';
import { PAYMENTS_ENABLED } from '@/lib/payments';
import { ensureOwnProfile } from '@/lib/ensureProfile';
import { hasKinePlus } from '@/lib/plus';
import {
  FireIcon, SparkleIcon, DiceIcon,
  CarIcon, PlaneIcon, FilmIcon, GamepadIcon, MusicIcon, ComedyIcon, BlogIcon,
  HowToIcon, HeartHandIcon, SportsIcon, ScienceIcon, EducationIcon,
  EntertainmentIcon, NewsIcon, PetIcon,
} from './ReactionIcons';
import ProfileImage from './ProfileImage';
import UiIcon from './UiIcon';

function baseLinks(t: (key: any) => string) {
  return [
    { href: '/', label: t('home'), icon: HomeIcon },
  ];
}

const EXPLORE_TABS = [
  { tab: 'trending', key: 'trending', icon: FireIcon },
  { tab: 'newest', key: 'newest', icon: SparkleIcon },
  { tab: 'surprise', key: 'surprise', icon: DiceIcon },
];

// Každá kategorie má vlastní ikonku, ať jde poznat na první pohled -
// dřív měly všechny ten samý štítek.
const CATEGORY_ICONS: Record<string, typeof CarIcon> = {
  catCars: CarIcon,
  catTravel: PlaneIcon,
  catFilm: FilmIcon,
  catGaming: GamepadIcon,
  catMusic: MusicIcon,
  catComedy: ComedyIcon,
  catPeople: BlogIcon,
  catHowTo: HowToIcon,
  catNonprofit: HeartHandIcon,
  catSports: SportsIcon,
  catScience: ScienceIcon,
  catEducation: EducationIcon,
  catEntertainment: EntertainmentIcon,
  catNews: NewsIcon,
  catPets: PetIcon,
};

// Seznam kategorií je jeden pro celou appku (lib/categories). Tady se k němu
// jen dolepí ikonky - dřív tu byl vlastní seznam a nic nehlídalo, že se
// nerozejde s tím, co nabízí nahrávání.
const EXPLORE_CATEGORIES = CATEGORY_KEYS.map((key) => ({ key, icon: CATEGORY_ICONS[key] }));

function loggedInLinksGroup1(t: (key: any) => string) {
  return [
    { href: '/subscriptions', label: t('subscriptions'), icon: SubscribersIcon },
    { href: '/playlists', label: t('playlists'), icon: PlaylistIcon },
    { href: '/watch-later', label: t('watchLater'), icon: WatchLaterIcon },
    { href: '/activity', label: t('yourActivity'), icon: LikedIcon },
  ];
}

function loggedInLinksGroup2(t: (key: any) => string) {
  return [
    { href: '/downloaded', label: t('downloaded'), icon: DownloadIcon },
    { href: '/your-videos', label: t('yourVideos'), icon: YourVideosIcon },
  ];
}

// Profil se dotváří nejvýš jednou naráz (menu se načítá při každé navigaci i změně přihlášení).
let ensuringProfile: Promise<boolean> | null = null;

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { t, lang } = useLanguage();
  const { isModerator, isAdmin } = useUserRole();
  const [exploreOpen, setExploreOpen] = useState(false);
  const { open: mobileNavOpen, close: closeMobileNav } = useMobileNav();
  // Kolik kanálů teď vysílá (odkaz Živě v menu).
  const liveCount = useLiveCount();
  // Po přechodu na jinou stránku (odkaz v nabídce účtu, v oznámeních…) panel vždycky zaleze.
  useEffect(() => {
    closeMobileNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Rozbalený Explore na nižším okně: menu roluje, tak ať je seznam hned vidět.
  useEffect(() => {
    if (!exploreOpen) return;
    const id = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('.sidebar-sublist').forEach((el) => el.scrollIntoView({ block: 'nearest' }));
    });
    return () => cancelAnimationFrame(id);
  }, [exploreOpen]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [user, setUser] = useState<{ id: string; username: string; avatar_url: string | null } | null>(null);
  const [ratingMode, setRatingMode] = useState<'stars' | 'like_dislike'>('like_dislike');
  // Předplatitel Kine Plus: u loga malé „Plus“ - ať je pořád vidět, že předplatné běží.
  const [kinePlus, setKinePlus] = useState(false);
  const [loading, setLoading] = useState(true);
  // Běží web v okně appky Kine do PC? (až po načtení v prohlížeči, ať se server a klient shodnou)
  const [inDesktopApp, setInDesktopApp] = useState(false);
  useEffect(() => {
    setInDesktopApp(isInDesktopApp());
  }, []);

  // Push oznámení (lib/pushClient.ts): obnovit přihlášení u serveru (jednou za den)
  // a poslouchat, když prohlížeč adresu pro oznámení změní.
  const signedInId = user?.id ?? null;
  useEffect(() => {
    if (!signedInId) return;
    void syncPush(lang);
    return listenForPushResubscribe(lang);
  }, [signedInId, lang]);

  useEffect(() => {
    loadUser();
    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      loadUser();
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Znovu načíst po odchodu ze stránek, kde se profil mění (Nastavení - rating_mode,
  // Kine Plus, průvodce), jinak nejvýš jednou za minutu. Dřív se při KAŽDÉM přechodu
  // ptalo dvakrát na server (ověření přihlášení + profil) - zbytečně to brzdilo.
  const lastLoad = useRef(0);
  const prevPath = useRef<string | null>(pathname);
  useEffect(() => {
    const from = prevPath.current;
    prevPath.current = pathname;
    const fromProfilePage = /^\/(settings|plus|welcome|choose-|agree-to-rules)/.test(from ?? '');
    if (fromProfilePage || Date.now() - lastLoad.current > 60 * 1000) loadUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  async function loadUser() {
    lastLoad.current = Date.now();
    // Přihlášení z paměti prohlížeče (bez dotazu na server) - menu jen ukazuje jméno a odkazy.
    const { data: sessionData } = await supabase.auth.getSession();
    const authData = { user: sessionData.session?.user ?? null };
    if (!authData.user) {
      setUser(null);
      setKinePlus(false);
      setLoading(false);
      return;
    }
    let { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('username, avatar_url, rating_mode, plan, plan_until')
      .eq('id', authData.user.id)
      .single();
    // Bez migrace předplatného (sloupce plan) - načíst aspoň zbytek.
    if (profileError && profileError.code !== 'PGRST116') {
      ({ data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('username, avatar_url, rating_mode')
        .eq('id', authData.user.id)
        .single());
    }

    // Přihlášený bez profilu (registrace s potvrzením e-mailu - odkaz z e-mailu vede
    // rovnou sem, ne přes přihlášení): profil se dotvoří a jde se do průvodce.
    // PGRST116 = žádný řádek (výpadek sítě má jiný kód - tam se nic nezakládá).
    if (!profile && profileError?.code === 'PGRST116') {
      ensuringProfile ??= ensureOwnProfile(supabase, authData.user).finally(() => {
        ensuringProfile = null;
      });
      if (await ensuringProfile) {
        router.push('/welcome');
        return;
      }
    }

    setUser({
      id: authData.user.id,
      username: profile?.username ?? 'uživatel',
      avatar_url: profile?.avatar_url ?? null,
    });
    setRatingMode((profile?.rating_mode as 'stars' | 'like_dislike') ?? 'like_dislike');
    setKinePlus(hasKinePlus((profile as any)?.plan, (profile as any)?.plan_until));
    setLoading(false);
  }

  return (
    <>
    <aside className="sidebar">
      <div className="sidebar-logo-row">
        <BrandLogo className="sidebar-logo" />
        {kinePlus && (
          <Link href="/plus" className="logo-plus-mark" title="Kine Plus">
            Plus
          </Link>
        )}
        <span className="sidebar-beta">BETA 0.0986</span>
      </div>
      <nav className="sidebar-nav" style={{ flex: 1 }}>
        {baseLinks(t).map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href} className={`sidebar-link ${active ? 'active' : ''}`}>
              <Icon />
              {label}
            </Link>
          );
        })}

        <button
          className={`sidebar-link ${pathname === '/explore' ? 'active' : ''}`}
          onClick={() => setExploreOpen((v) => !v)}
          style={{ justifyContent: 'space-between' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ExploreIcon />
            {t('explore')}
          </span>
          <span style={{ fontSize: 11, transform: exploreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
        </button>
        {exploreOpen && (
          <div className="sidebar-sublist">
            {EXPLORE_TABS.map(({ tab, key, icon: Icon }) => (
              <Link key={tab} href={`/explore?tab=${tab}`} className="sidebar-link sidebar-sublink" title={t(key as any)}>
                <Icon size={16} />
                <span>{t(key as any)}</span>
              </Link>
            ))}
            {EXPLORE_CATEGORIES.map(({ key: catKey, icon: CatIcon }) => (
              <Link key={catKey} href={`/explore?category=${catKey}`} className="sidebar-link sidebar-sublink" title={t(catKey as any)}>
                <CatIcon size={16} />
                <span>{t(catKey as any)}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Všechny přenosy, které teď běží - číslo = kolik kanálů vysílá. */}
        <Link href="/streams" className={`sidebar-link ${pathname === '/streams' ? 'active' : ''}`}>
          <LiveNowIcon />
          {t('navLive')}
          {liveCount > 0 && (
            <span className="sidebar-live-count" title={t('navLiveCount').replace('{count}', String(liveCount))}>
              {liveCount}
            </span>
          )}
        </Link>

        {user && (
          <>
            <div className="sidebar-divider" />
            {loggedInLinksGroup1(t).map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link key={href} href={href} className={`sidebar-link ${active ? 'active' : ''}`}>
                  <Icon />
                  {label}
                </Link>
              );
            })}

            <div className="sidebar-divider" />
            {loggedInLinksGroup2(t).map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link key={href} href={href} className={`sidebar-link ${active ? 'active' : ''}`}>
                  <Icon />
                  {label}
                </Link>
              );
            })}
          </>
        )}

        <div className="sidebar-divider" />
        <Link href="/upload" className={`sidebar-link ${pathname === '/upload' ? 'active' : ''}`}>
          <CreateIcon />
          {t('create')}
        </Link>
        {user && (
          <Link href="/live" className={`sidebar-link ${pathname === '/live' ? 'active' : ''}`}>
            <span className="sidebar-live-icon" aria-hidden="true" />
            {t('goLiveLink')}
          </Link>
        )}
        {/* Podpora Kine (platba) - až poběží placení (lib/payments.ts). I bez přihlášení
            (dar je pak anonymní), ať je „Podpořit Kine“ vidět pro všechny. */}
        {PAYMENTS_ENABLED && (
          <Link href="/donate" className={`sidebar-link ${pathname === '/donate' ? 'active' : ''}`}>
            <DonateIcon />
            {t('donateSidebarLabel')}
          </Link>
        )}
        {isModerator && (
          <Link href="/reports" className={`sidebar-link ${pathname === '/reports' ? 'active' : ''}`}>
            <UiIcon name="flag" size={20} />
            {t('reportsPageTitle')}
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin/revenue-share" className={`sidebar-link ${pathname === '/admin/revenue-share' ? 'active' : ''}`}>
            <UiIcon name="coins" size={20} />
            {t('revenueShareLabel')}
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin/errors" className={`sidebar-link ${pathname === '/admin/errors' ? 'active' : ''}`}>
            <UiIcon name="bug" size={20} />
            {t('clientErrorsLabel')}
          </Link>
        )}
        {/* Nastavení plateb: kontrola Stripe, ceny, webhook (app/admin/stripe). */}
        {isAdmin && (
          <Link href="/admin/stripe" className={`sidebar-link ${pathname === '/admin/stripe' ? 'active' : ''}`}>
            <UiIcon name="coins" size={20} />
            {t('stripeSetupLabel')}
          </Link>
        )}
        {/* Hlídač nákladů (Cloudflare, Supabase) a nastavení push oznámení. */}
        {isAdmin && (
          <Link href="/admin/costs" className={`sidebar-link ${pathname === '/admin/costs' ? 'active' : ''}`}>
            <UiIcon name="chart" size={20} />
            {t('costsAdminLabel')}
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin/push" className={`sidebar-link ${pathname === '/admin/push' ? 'active' : ''}`}>
            <UiIcon name="bell" size={20} />
            {t('pushAdminLabel')}
          </Link>
        )}
        {/* Odznaky spravuje celý tým Kine - moderátor i správce. */}
        {(isAdmin || isModerator) && (
          <Link href="/admin/badges" className={`sidebar-link ${pathname === '/admin/badges' ? 'active' : ''}`}>
            <UiIcon name="trophy" size={20} />
            {t('specialBadgesAdminLabel')}
          </Link>
        )}
        {/* Co je Kine a naše appky - pro každého, i nepřihlášeného. */}
        <Link href="/about" className={`sidebar-link sidebar-about ${pathname === '/about' ? 'active' : ''}`}>
          <AboutIcon />
          {t('aboutLink')}
        </Link>
      </nav>

      {!loading && (
        <div>
          {user && <NotificationBell />}
          {user ? (
            <ProfileMenu username={user.username} avatarUrl={user.avatar_url} />
          ) : (
            <Link href="/login" className="sidebar-link">
              <ProfileIcon />
              {t('profile')}
            </Link>
          )}
        </div>
      )}
    </aside>

    {/* Spodní lišta na mobilu - zůstává vždy vidět (kromě chvíle, kdy je
        otevřená boční zásuvka - pak jde za ni). Rychlé přepínání mezi
        nejdůležitějšími místy appky. */}
    <nav className="mobile-bottom-nav">
      <Link href="/" className={`mobile-nav-item ${pathname === '/' ? 'active' : ''}`}>
        <HomeIcon />
        <span>{t('home')}</span>
      </Link>
      <SparksNavButton />
      <button className="mobile-nav-item mobile-nav-create" onClick={() => setCreateMenuOpen(true)}>
        <CreateIcon />
      </button>
      {/* Nepřihlášený nemá zvoneček - místo prázdné díry Odběry (jako YouTube);
          pět sloupců drží + pořád přesně uprostřed. */}
      {user ? (
        <NotificationBell mobileTrigger />
      ) : (
        <Link href="/subscriptions" className={`mobile-nav-item ${pathname === '/subscriptions' ? 'active' : ''}`}>
          <SubscribersIcon />
          <span>{t('subscriptions')}</span>
        </Link>
      )}
      {user ? (
        <Link href="/channel/me" className="mobile-nav-item">
          <span className="mobile-nav-avatar">
            {user.avatar_url ? <ProfileImage src={user.avatar_url} /> : <ProfileIcon />}
          </span>
        </Link>
      ) : (
        <Link href="/login" className="mobile-nav-item">
          <ProfileIcon />
        </Link>
      )}
    </nav>

    {createMenuOpen && (
      <div className="mobile-drawer-backdrop" onClick={() => setCreateMenuOpen(false)}>
        <div className="mobile-drawer mobile-drawer-bottom" onClick={(e) => e.stopPropagation()}>
          <div className="mobile-drawer-handle" />
          <Link href="/upload" className="sidebar-link" onClick={() => setCreateMenuOpen(false)}>
            <YourVideosIcon />
            Video
          </Link>
          <Link href="/channel/me?tab=posts&compose=text" className="sidebar-link" onClick={() => setCreateMenuOpen(false)}>
            <CreateIcon />
            Text
          </Link>
          <Link href="/channel/me?tab=posts&compose=photo" className="sidebar-link" onClick={() => setCreateMenuOpen(false)}>
            <DownloadIcon />
            {t('postPhotoTab')}
          </Link>
          <Link href="/channel/me?tab=posts&compose=poll" className="sidebar-link" onClick={() => setCreateMenuOpen(false)}>
            <PlaylistIcon />
            {t('postPollTab')}
          </Link>
          <Link href="/live" className="sidebar-link" onClick={() => setCreateMenuOpen(false)}>
            <span className="sidebar-live-icon" aria-hidden="true" />
            {t('goLiveLink')}
          </Link>
        </div>
      </div>
    )}

    {/* Mobilní zásuvka - vidět jen po kliknutí na "☰" v horní liště (viz TopBar).
        Obsahuje stejné odkazy, ve stejném pořadí, jako běžné menu. Roluje jen vnitřek
        (.mobile-drawer-scroll); oznámení a účet jsou v patičce MIMO rolování - Safari na
        iPhonu totiž position: fixed uvnitř rolujícího prvku mačká do něj (nabídka účtu a
        oznámení se pak kreslily přes položky panelu). */}
    {mobileNavOpen && (
      <div className="mobile-drawer-backdrop" onClick={closeMobileNav}>
        <div className="mobile-drawer mobile-drawer-side" onClick={(e) => e.stopPropagation()}>
         <div className="mobile-drawer-scroll">
          <div className="sidebar-logo-row">
            <BrandLogo className="sidebar-logo" onNavigate={closeMobileNav} />
            {kinePlus && (
              <Link href="/plus" className="logo-plus-mark" title="Kine Plus" onClick={closeMobileNav}>
                Plus
              </Link>
            )}
          </div>
          <div className="sidebar-divider" />

          {baseLinks(t).map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="sidebar-link" onClick={closeMobileNav}>
              <Icon />
              {label}
            </Link>
          ))}

          <button
            className="sidebar-link"
            onClick={() => setExploreOpen((v) => !v)}
            style={{ justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ExploreIcon />
              {t('explore')}
            </span>
            <span style={{ fontSize: 11, transform: exploreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
          </button>
          {exploreOpen && (
            <div className="sidebar-sublist">
              {EXPLORE_TABS.map(({ tab, key, icon: Icon }) => (
                <Link key={tab} href={`/explore?tab=${tab}`} className="sidebar-link sidebar-sublink" onClick={closeMobileNav} title={t(key as any)}>
                  <Icon size={16} />
                  <span>{t(key as any)}</span>
                </Link>
              ))}
              {EXPLORE_CATEGORIES.map(({ key: catKey, icon: CatIcon }) => (
                <Link key={catKey} href={`/explore?category=${catKey}`} className="sidebar-link sidebar-sublink" onClick={closeMobileNav} title={t(catKey as any)}>
                  <CatIcon size={16} />
                  <span>{t(catKey as any)}</span>
                </Link>
              ))}
            </div>
          )}

          <Link href="/streams" className="sidebar-link" onClick={closeMobileNav}>
            <LiveNowIcon />
            {t('navLive')}
            {liveCount > 0 && <span className="sidebar-live-count">{liveCount}</span>}
          </Link>

          {user && (
            <>
              <div className="sidebar-divider" />
              {loggedInLinksGroup1(t).map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="sidebar-link" onClick={closeMobileNav}>
                  <Icon />
                  {label}
                </Link>
              ))}
              <div className="sidebar-divider" />
              {loggedInLinksGroup2(t).map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="sidebar-link" onClick={closeMobileNav}>
                  <Icon />
                  {label}
                </Link>
              ))}
            </>
          )}

          <div className="sidebar-divider" />
          <Link href="/upload" className="sidebar-link" onClick={closeMobileNav}>
            <CreateIcon />
            {t('create')}
          </Link>
          {user && (
            <Link href="/live" className="sidebar-link" onClick={closeMobileNav}>
              <span className="sidebar-live-icon" aria-hidden="true" />
              {t('goLiveLink')}
            </Link>
          )}
          {PAYMENTS_ENABLED && (
            <Link href="/donate" className="sidebar-link" onClick={closeMobileNav}>
              <DonateIcon />
              {t('donateSidebarLabel')}
            </Link>
          )}
          {/* Appky ke stažení: do PC i Kine Clipper pro Android (od 0118 i na telefonu -
              stránka /download předvybere Android). Uvnitř appky (režim "Kine + klipy")
              místo toho odkaz na klipy v ní (kine://…, appka si ho převezme). */}
          {inDesktopApp ? (
            <a href="kine://open?tab=clips" className="sidebar-link" onClick={closeMobileNav}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
              </svg>
              {t('desktopClipsLink')}
            </a>
          ) : (
            <Link href="/download" className="sidebar-link" onClick={closeMobileNav}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              {t('desktopAppLink')}
            </Link>
          )}
          {isModerator && (
            <Link href="/reports" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="flag" size={20} />
              {t('reportsPageTitle')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/revenue-share" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="coins" size={20} />
              {t('revenueShareLabel')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/errors" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="bug" size={20} />
              {t('clientErrorsLabel')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/stripe" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="coins" size={20} />
              {t('stripeSetupLabel')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/costs" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="chart" size={20} />
              {t('costsAdminLabel')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/push" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="bell" size={20} />
              {t('pushAdminLabel')}
            </Link>
          )}
          {(isAdmin || isModerator) && (
            <Link href="/admin/badges" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="trophy" size={20} />
              {t('specialBadgesAdminLabel')}
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/plus" className="sidebar-link" onClick={closeMobileNav}>
              <UiIcon name="sparkle" size={20} />
              {t('adminPlusLabel')}
            </Link>
          )}
          <Link href="/about" className="sidebar-link" onClick={closeMobileNav}>
            <AboutIcon />
            {t('aboutLink')}
          </Link>
         </div>

          {!loading && (
            <div className="mobile-drawer-foot">
              {user && <NotificationBell onNavigate={closeMobileNav} />}
              {user ? (
                <div className="mobile-drawer-profile">
                  <ProfileMenu username={user.username} avatarUrl={user.avatar_url} onNavigate={closeMobileNav} />
                </div>
              ) : (
                <Link href="/login" className="sidebar-link" onClick={closeMobileNav}>
                  <ProfileIcon />
                  {t('profile')}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}

export function SparkIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" strokeLinejoin="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="5" width="7" height="7" rx="1" />
      <rect x="14" y="5" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" strokeLinecap="round" />
    </svg>
  );
}

/** Podpořit Kine: srdce (místo emoji 💛, ať je v řadě stejné jako ostatní ikony), v teplé barvě. */
function DonateIcon() {
  return (
    <svg className="sidebar-icon sidebar-icon-donate" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 11.5L12 4l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** O Kine: písmeno i v kroužku. */
function AboutIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.4" />
    </svg>
  );
}

/** Živě: anténa s vlnami. */
function LiveNowIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.3 18.7a9.5 9.5 0 0 1 0-13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" />
    </svg>
  );
}

function ExploreIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 6-6 2 2-6 6-2z" strokeLinejoin="round" />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="8.5" r="3.3" />
      <path d="M5 20c1-3.2 4-5 7-5s6 1.8 7 5" strokeLinecap="round" />
    </svg>
  );
}

function WatchLaterIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LikedIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinejoin="round" />
    </svg>
  );
}

function PlaylistIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 6h12M3 12h12M3 18h7" strokeLinecap="round" />
      <path d="M17 10l4 3-4 3v-6z" strokeLinejoin="round" />
    </svg>
  );
}

function YourVideosIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="5" width="14" height="14" rx="2" />
      <path d="M17 9.5l4-2.5v10l-4-2.5" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M12 4v11m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1" strokeLinecap="round" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SubscribersIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8.5" cy="9" r="3" />
      <circle cx="16" cy="10.5" r="2.3" />
      <path d="M2.5 19c.6-3 3-4.8 6-4.8s5.4 1.8 6 4.8" strokeLinecap="round" />
      <path d="M14.5 14.6c2.3.3 4 1.8 4.5 4.4" strokeLinecap="round" />
    </svg>
  );
}
