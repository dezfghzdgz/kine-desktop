'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/lib/i18n';
import { GAMES, gameBySlug, searchGames, type Game } from '@/lib/games';
import { loadFollowedGames, loadPopularGames } from '@/lib/gamesData';
import { videoCountLabel } from '@/lib/plural';
import GameTile from './GameTile';
import UiIcon from './UiIcon';

type RailItem = { game: Game; count: number | null; followed: boolean };

/**
 * Procházení podle hry v Explore → Hry (samostatná záložka Hry už není):
 * nejdřív sledované hry, pak co se teď hraje (videa za 30 dní), pak celý
 * katalog - vodorovně, s hledáním přímo v řadě. Dlaždice vedou na stránky
 * her (/game/[slug]).
 */
export default function GamesRail() {
  const { t, lang } = useLanguage();
  const [query, setQuery] = useState('');
  const [followed, setFollowed] = useState<string[]>([]);
  const [popular, setPopular] = useState<{ game: Game; count: number }[]>([]);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadFollowedGames().then((list) => {
      if (!cancelled) setFollowed(list);
    });
    void loadPopularGames().then((list) => {
      if (!cancelled) setPopular(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo<RailItem[]>(() => {
    const counts = new Map(popular.map((x) => [x.game.slug, x.count]));
    const mine = new Set(followed);
    const q = query.trim();
    if (q) return searchGames(q, 40).map(({ game }) => ({ game, count: counts.get(game.slug) ?? null, followed: mine.has(game.slug) }));
    const seen = new Set<string>();
    const out: RailItem[] = [];
    const add = (game: Game | null, isFollowed: boolean) => {
      if (!game || seen.has(game.slug)) return;
      seen.add(game.slug);
      out.push({ game, count: counts.get(game.slug) ?? null, followed: isFollowed });
    };
    for (const slug of followed) add(gameBySlug(slug), true);
    for (const { game } of popular) add(game, false);
    for (const game of GAMES) add(game, false);
    return out;
  }, [query, followed, popular]);

  // Nové hledání = řada od začátku (výsledky by jinak mohly být mimo obrazovku).
  useEffect(() => {
    if (rowRef.current) rowRef.current.scrollLeft = 0;
  }, [query]);

  return (
    <section className="games-rail" aria-label={t('gamesBrowseByGame')}>
      <div className="games-rail-head">
        <p className="panel-heading" style={{ margin: 0 }}>
          {t('gamesBrowseByGame')}
        </p>
        <label className="games-search games-rail-search">
          <UiIcon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('gamesSearchPlaceholder')}
            aria-label={t('gamesSearchPlaceholder')}
            maxLength={40}
          />
        </label>
      </div>
      {items.length === 0 ? (
        <p className="games-rail-empty">{t('gamesNoResults')}</p>
      ) : (
        <div className="game-row" ref={rowRef}>
          {items.map(({ game, count, followed: isFollowed }) => (
            <GameTile
              key={game.slug}
              game={game}
              badge={isFollowed ? t('gamesFollowing') : null}
              sub={count ? videoCountLabel(count, lang, t) : null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
