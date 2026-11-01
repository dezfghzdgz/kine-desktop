'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/lib/i18n';
import { authHeaders, cacheableUrl } from '@/lib/authHeaders';
import { useUserRole } from '@/lib/useUserRole';
import { announceLiveCount } from '@/lib/useLiveCount';
import { categoryLabel, isCategoryKey } from '@/lib/categories';
import { gameBySlug, isGameSlug } from '@/lib/games';
import { LiveCard, recentLiveList, rememberLiveList, type LiveItem } from '@/components/LiveNowRow';
import UpcomingStreams from '@/components/UpcomingStreams';

type Sort = 'foryou' | 'viewers' | 'newest' | 'small';
const SORTS: Sort[] = ['foryou', 'viewers', 'newest', 'small'];
/** „Malé přenosy“: do tolika diváků (seznam řazený podle diváků by je nechal věčně dole). */
const SMALL_MAX_VIEWERS = 10;

/** Stránka Živě: všechny přenosy, které teď běží - kategorie, řazení, diváci. */
export default function StreamsPage() {
  return (
    <Suspense fallback={null}>
      <StreamsInner />
    </Suspense>
  );
}

/** Diagnostika ze serveru (jen tým Kine, ?diag=1) - app/api/live/now. */
type LiveDiag = {
  at?: string;
  instance?: string;
  viewer?: string;
  error?: string;
  ms?: { sync: number; total: number };
  sync?: { at: string; listingOk: boolean; listed: number; rows: number; error: string | null } | null;
  rows?: DiagRow[];
  own?: (DiagRow & { now?: { evidence: DiagEvidence; wouldDecide: string; appPingFresh: boolean; appTrusted: boolean } }) | null;
};
type DiagEvidence = { lifecycle: boolean | null; listed: boolean; hls: boolean | null; videoUid: string | null };
type DiagRow = {
  owner: string;
  username: string | null;
  isLive: boolean;
  inList: boolean;
  why: string | null;
  startedS: number | null;
  endedS: number | null;
  appPingS: number | null;
  confirmedS: number | null;
  stoppedS: number | null;
  hiddenS: number | null;
  lastDecision: { decision: string; atS: number | null; silent: boolean; skipped: boolean; evidence: DiagEvidence } | null;
};

const yn = (v: boolean | null | undefined) => (v === true ? 'ano' : v === false ? 'ne' : '?');
const sec = (v: number | null | undefined) => (typeof v === 'number' ? `${v} s` : '-');

/** Diagnostika v řádcích - čitelná na obrazovce i zkopírovaná do zprávy. */
function diagLines(d: LiveDiag, status: string): string[] {
  // První řádek stavu (HTTP, čas, CDN, region, přihlášení), pod ním případně stav kanálu podle profilu.
  const [head, ...more] = status.split('\n');
  if (d.error) return [`${head} · chyba diagnostiky: ${d.error}`, ...more];
  const lines = [`${head} · ${d.at ?? ''} · instance ${d.instance ?? '?'} · odpověď ${d.ms?.total ?? '?'} ms (srovnání ${d.ms?.sync ?? '?'} ms)`, ...more];
  if (d.sync) {
    lines.push(`Cloudflare seznam běžících: ${d.sync.listingOk ? 'ok' : `CHYBA ${d.sync.error ?? ''}`} · běží ${d.sync.listed} · řádků ${d.sync.rows} · ${d.sync.at}`);
  } else lines.push('Srovnání s Cloudflare na téhle instanci zatím neproběhlo.');
  const row = (r: DiagRow) => {
    const dec = r.lastDecision
      ? `${r.lastDecision.decision}${r.lastDecision.skipped ? ' (nezapsáno)' : ''}${r.lastDecision.silent ? ' (bez Cloudflare)' : ''} před ${sec(r.lastDecision.atS)} [lifecycle ${yn(r.lastDecision.evidence.lifecycle)}, záznam ${yn(r.lastDecision.evidence.listed)}, HLS ${yn(r.lastDecision.evidence.hls)}]`
      : 'zatím nic';
    return `@${r.username ?? r.owner.slice(0, 8)}: ${r.isLive ? 'ŽIVĚ' : 'neživě'} · v seznamu ${yn(r.inList)}${r.why ? ` (${r.why})` : ''} · začátek ${sec(r.startedS)} · konec ${sec(r.endedS)} · appka ${sec(r.appPingS)} · potvrzeno ${sec(r.confirmedS)} · Ukončit ${sec(r.stoppedS)} · skryto ${sec(r.hiddenS)} · srovnání: ${dec}`;
  };
  for (const r of d.rows ?? []) lines.push(row(r));
  if (d.own?.now) {
    const n = d.own.now;
    lines.push(`Tvůj přenos teď: lifecycle ${yn(n.evidence.lifecycle)} · záznam vstupu ${yn(n.evidence.listed)} · HLS ${yn(n.evidence.hls)} · srovnání by: ${n.wouldDecide} · appka čerstvá ${yn(n.appPingFresh)} · appce se věří ${yn(n.appTrusted)}`);
  } else if (!d.own) lines.push('Tvůj kanál nemá přenos (ani nedávno skončený).');
  return lines;
}

/** Diagnostika pro tým Kine pod seznamem: proč přenos v Živě je / není (dočasně, než se Živě vyladí). */
function LiveDiagBox({ diag, status, ownMissing }: { diag: LiveDiag; status: string; ownMissing: boolean }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const lines = diagLines(diag, status);
  return (
    <details className="streams-diag" open={ownMissing || undefined}>
      <summary>
        {t('liveDiagTitle')}
        {ownMissing && <span className="streams-diag-warn"> · {t('liveDiagOwnMissing')}</span>}
      </summary>
      <p className="streams-diag-hint">{t('liveDiagHint')}</p>
      <pre className="streams-diag-text">{lines.join('\n')}</pre>
      <button
        type="button"
        className="streams-btn streams-diag-copy"
        onClick={() => {
          const text = `${lines.join('\n')}\n\n${JSON.stringify(diag)}`;
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            },
            () => undefined
          );
        }}
      >
        {copied ? t('liveDiagCopied') : t('liveDiagCopy')}
      </button>
    </details>
  );
}

function StreamsInner() {
  const { t } = useLanguage();
  const params = useSearchParams();
  const router = useRouter();
  // Tým Kine dostane k seznamu diagnostiku (proč přenos je / není v Živě).
  const { isAdmin, isModerator } = useUserRole();
  const staffRef = useRef(false);
  staffRef.current = isAdmin || isModerator;
  /** Načtení seznamu zvenku (role týmu Kine se zjistí až po načtení stránky - diagnostika pak hned). */
  const loadRef = useRef<(() => void) | null>(null);
  /** Seznam už přišel i s diagnostikou (dotaz za tým Kine). */
  const staffLoadedRef = useRef(false);
  const [diag, setDiag] = useState<{ data: LiveDiag; status: string } | null>(null);
  // Seznam z minula (hlavní stránka, předchozí návštěva) hned - obnoví se potichu.
  const [streams, setStreams] = useState<LiveItem[] | null>(() => recentLiveList()?.streams ?? null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sort, setSort] = useState<Sort>(() => {
    const s = params.get('sort');
    return s === 'viewers' || s === 'newest' || s === 'small' ? s : 'foryou';
  });
  const [category, setCategory] = useState<string | null>(() => {
    const c = params.get('category');
    return isCategoryKey(c) ? c : null;
  });
  // Hra (/streams?game=counter-strike-2 - odkaz ze stránky hry).
  const [game, setGame] = useState<string | null>(() => {
    const g = params.get('game');
    return isGameSlug(g) ? g : null;
  });

  useEffect(() => {
    let cancelled = false;
    // Kdy přišel poslední platný seznam - starý (přenosy v něm už nemusí běžet) se neukazuje.
    let loadedAt = recentLiveList()?.at ?? 0;
    async function load() {
      if (document.hidden) return;
      const staff = staffRef.current;
      if (staff) staffLoadedRef.current = true;
      const started = Date.now();
      try {
        // S přihlášením jde tvůj přenos a odebírané kanály dopředu (lib/liveNow.ts).
        const headers = await authHeaders();
        const res = await fetch(cacheableUrl(`/api/live/now?limit=60&viewers=1${staff ? '&diag=1' : ''}`, headers), { cache: 'no-store', headers });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (staff) {
          // Odkud odpověď přišla (mezipaměť CDN Vercelu, region) a jestli šla s přihlášením - a pro srovnání
          // stav vlastního kanálu tak, jak ho vidí profil (odznak LIVE, stránka přenosu - /api/live/status).
          const vercelCache = res.headers.get('x-vercel-cache');
          const region = (res.headers.get('x-vercel-id') ?? '').split('::').slice(0, -1).join('>');
          const status = `HTTP ${res.status} · ${Date.now() - started} ms${vercelCache ? ` · CDN ${vercelCache}` : ''}${region ? ` · ${region}` : ''} · přihlášení ${headers.Authorization ? 'ano' : 'ne'}`;
          let profileCheck: string | null = null;
          const ownId = typeof body?.diag?.viewer === 'string' ? (body.diag.viewer as string) : null;
          if (ownId) {
            try {
              const sres = await fetch(`/api/live/status?channel=${encodeURIComponent(ownId)}`, { cache: 'no-store', headers });
              const sbody = await sres.json().catch(() => null);
              profileCheck = `Profil (stav kanálu jako u odznaku LIVE): HTTP ${sres.status} · živě ${sbody?.live ? 'ano' : 'ne'}${sbody?.held ? ' (čeká na kontrolu)' : ''}${sbody?.moderation?.restricted ? ` (${sbody.moderation.restricted})` : ''}`;
            } catch (e) {
              profileCheck = `Profil: chyba ${(e as Error).message}`;
            }
          }
          if (cancelled) return;
          setDiag(
            body?.diag
              ? { data: body.diag as LiveDiag, status: profileCheck ? `${status}\n${profileCheck}` : status }
              : res.ok
                ? null
                : { data: { error: String(body?.error ?? res.statusText) }, status }
          );
        }
        if (res.ok && body && Array.isArray(body.streams)) {
          loadedAt = Date.now();
          setStreams(body.streams);
          setEnabled(body.enabled !== false);
          setFailed(false);
          // Číslo u Živě v menu podle téhož seznamu - ať se nerozchází s tím, co je vidět
          // (bez přenosů, které vidí jen majitel a tým Kine - číslo je stejné pro všechny).
          const publicTotal = typeof body.publicTotal === 'number' ? body.publicTotal : typeof body.total === 'number' ? body.total : body.streams.length;
          announceLiveCount(publicTotal);
          rememberLiveList(body.streams, publicTotal);
        } else setFailed(true);
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          if (staff) setDiag({ data: { error: (e as Error).message }, status: `síť · ${Date.now() - started} ms` });
        }
      }
    }
    load();
    loadRef.current = () => void load();
    const refresh = setInterval(load, 20 * 1000);
    const tick = setInterval(() => {
      setNow(Date.now());
      // Seznam se dlouho nepodařilo obnovit: starý se neukazuje (přenosy v něm už nemusí
      // běžet), ale ani "nikdo nevysílá" - to by nemusela být pravda. Hláška, že se nenačetl.
      // Karta na pozadí se neobnovuje schválně - to vyřeší návrat (onVisible).
      if (!document.hidden && loadedAt && Date.now() - loadedAt > 90 * 1000) {
        loadedAt = 0;
        setStreams(null);
        setFailed(true);
      }
    }, 1000);
    const onVisible = () => {
      if (document.hidden) return;
      // Hodně starý seznam pryč; mladší zůstane vidět, než přijde nový.
      if (loadedAt && Date.now() - loadedAt > 60 * 1000) {
        loadedAt = 0;
        setStreams(null);
        setFailed(false);
      }
      load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      loadRef.current = null;
      clearInterval(refresh);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Role týmu Kine dorazí až po prvním načtení seznamu: diagnostika hned, ne až při dalším obnovení (20 s).
  const staffNow = isAdmin || isModerator;
  useEffect(() => {
    if (staffNow && !staffLoadedRef.current) loadRef.current?.();
  }, [staffNow]);

  // Volby v adrese - odkaz jde poslat ("koukni, kdo hraje hry").
  function choose(next: { sort?: Sort; category?: string | null; game?: string | null }) {
    const s = next.sort ?? sort;
    const c = next.category === undefined ? category : next.category;
    // Hra patří ke kategorii Hry - jiná kategorie ji zruší.
    const g = next.game === undefined ? (next.category !== undefined && next.category !== 'catGaming' ? null : game) : next.game;
    setSort(s);
    setCategory(c);
    setGame(g);
    const q = new URLSearchParams();
    if (c) q.set('category', c);
    if (g) q.set('game', g);
    if (s !== 'foryou') q.set('sort', s);
    router.replace(q.toString() ? `/streams?${q}` : '/streams', { scroll: false });
  }

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of streams ?? []) if (s.category) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [streams]);

  // Hry, které se teď vysílají (čipy pod kategoriemi) - jen když nějaká je.
  const games = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of streams ?? []) if (s.game && gameBySlug(s.game)) counts.set(s.game, (counts.get(s.game) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [streams]);

  const shown = useMemo(() => {
    const list = (streams ?? []).filter((s) => (!category || s.category === category) && (!game || s.game === game));
    if (sort === 'viewers') {
      return list
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (b.s.viewers ?? -1) - (a.s.viewers ?? -1) || a.i - b.i)
        .map(({ s }) => s);
    }
    const at = (s: LiveItem) => (s.startedAt ? new Date(s.startedAt).getTime() || 0 : 0);
    if (sort === 'newest') return [...list].sort((a, b) => at(b) - at(a));
    // Malé přenosy (do 10 diváků): šance pro začínající - jinak zůstanou pod velkými pořád.
    // Pořadí se každou minutu promíchá, ať není navrchu věčně ten samý.
    if (sort === 'small') {
      const seed = Math.floor(Date.now() / 60000);
      const key = (s: LiveItem) => { let h = seed; for (const ch of s.ownerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
      return list.filter((s) => (s.viewers ?? 0) <= SMALL_MAX_VIEWERS).sort((a, b) => key(a) - key(b));
    }
    return list;
  }, [streams, category, game, sort]);

  const sortLabel: Record<Sort, string> = {
    foryou: t('streamsSortForYou'),
    viewers: t('streamsSortViewers'),
    newest: t('streamsSortNewest'),
    small: t('streamsSortSmall'),
  };
  const total = streams?.length ?? 0;

  return (
    <div className="streams-page">
      <div className="streams-head">
        <div>
          <h1 className="streams-title">
            <span className="live-dot" aria-hidden="true" /> {t('streamsTitle')}
            {total > 0 && <span className="streams-count">{total}</span>}
          </h1>
          <p className="streams-sub">{t('streamsSubtitle')}</p>
        </div>
        <Link href="/live" className="streams-go-live">
          <span className="sidebar-live-icon" aria-hidden="true" />
          {t('goLiveLink')}
        </Link>
      </div>

      {total > 0 && (
        <div className="streams-filters">
          <div className="search-filter-group" role="radiogroup" aria-label={t('streamsSortLabel')}>
            {SORTS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={sort === s} className={`search-chip ${sort === s ? 'active' : ''}`} onClick={() => choose({ sort: s })}>
                {sortLabel[s]}
              </button>
            ))}
          </div>
          {categories.length > 0 && (
            <div className="search-filter-group streams-categories" role="radiogroup" aria-label={t('categoryLabel')}>
              <button type="button" role="radio" aria-checked={!category} className={`search-chip ${!category ? 'active' : ''}`} onClick={() => choose({ category: null })}>
                {t('streamsAllCategories')} <span className="streams-chip-count">{total}</span>
              </button>
              {categories.map(([key, count]) => (
                <button key={key} type="button" role="radio" aria-checked={category === key} className={`search-chip ${category === key ? 'active' : ''}`} onClick={() => choose({ category: key })}>
                  {categoryLabel(key, t)} <span className="streams-chip-count">{count}</span>
                </button>
              ))}
            </div>
          )}
          {(games.length > 0 || game) && (
            <div className="search-filter-group streams-games" role="radiogroup" aria-label={t('navGames')}>
              <button type="button" role="radio" aria-checked={!game} className={`search-chip ${!game ? 'active' : ''}`} onClick={() => choose({ game: null })}>
                {t('gamesAll')}
              </button>
              {games.map(([slug, count]) => (
                <button key={slug} type="button" role="radio" aria-checked={game === slug} className={`search-chip ${game === slug ? 'active' : ''}`} onClick={() => choose({ game: slug })}>
                  {gameBySlug(slug)?.name} <span className="streams-chip-count">{count}</span>
                </button>
              ))}
              {game && !games.some(([slug]) => slug === game) && (
                <button type="button" role="radio" aria-checked className="search-chip active" onClick={() => choose({ game: null })}>
                  {gameBySlug(game)?.name} <span className="streams-chip-count">0</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {streams === null && !failed ? (
        <div className="live-now-grid" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="streams-skeleton" />
          ))}
        </div>
      ) : failed && total === 0 ? (
        // Nový seznam nepřišel: "nikdo nevysílá" by nemusela být pravda (dřív se ukazovalo
        // podle starého prázdného seznamu z hlavní stránky).
        <p style={{ color: 'var(--text-faint)' }}>{t('streamsLoadFailed')}</p>
      ) : total === 0 ? (
        <div className="streams-empty panel">
          <span className="streams-empty-icon" aria-hidden="true">
            <span className="sidebar-live-icon" />
          </span>
          <p className="streams-empty-title">{enabled ? t('streamsEmptyTitle') : t('streamsDisabled')}</p>
          <p className="streams-empty-text">{t('streamsEmptyText')}</p>
          <div className="streams-empty-actions">
            <Link href="/live" className="streams-btn primary">
              {t('streamsStart')}
            </Link>
            <Link href="/download" className="streams-btn">
              {t('streamsClipper')}
            </Link>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="streams-empty panel">
          <p className="streams-empty-title">{t('streamsEmptyCategory')}</p>
          <div className="streams-empty-actions">
            <button type="button" className="streams-btn" onClick={() => choose({ category: null, game: null })}>
              {t('streamsShowAll')}
            </button>
          </div>
        </div>
      ) : (
        <div className="live-now-grid streams-grid">
          {shown.map((s) => (
            <LiveCard key={s.ownerId} item={s} now={now} showCategory={!category} />
          ))}
        </div>
      )}

      {/* Plánovaná vysílání s odpočtem a „Připomenout“ (components/UpcomingStreams.tsx). */}
      <UpcomingStreams />

      {diag && (
        <LiveDiagBox
          diag={diag.data}
          status={diag.status}
          ownMissing={!!diag.data.own?.isLive && !diag.data.own?.inList}
        />
      )}

      <details className="streams-how">
        <summary>{t('streamsHowTitle')}</summary>
        <p>{t('streamsHowShown')}</p>
        <p>{t('streamsHowOrder')}</p>
        <p>{t('streamsHowSafety')}</p>
      </details>
    </div>
  );
}
