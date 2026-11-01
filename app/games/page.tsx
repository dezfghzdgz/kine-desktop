import { permanentRedirect } from 'next/navigation';

/**
 * Hry už nemají vlastní záložku: procházet podle hry jde v Explore → Hry
 * (řada her s hledáním nad videi - components/GamesRail.tsx), stránky
 * jednotlivých her zůstávají (/game/[slug]). Stará adresa vede tam.
 */
export default function GamesPage() {
  permanentRedirect('/explore?category=catGaming');
}
