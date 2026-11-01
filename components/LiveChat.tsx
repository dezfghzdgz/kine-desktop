'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage } from '@/lib/i18n';
import { CHAT_MAX_LENGTH } from '@/lib/liveChat';
import { FOLLOW_MINUTES_OPTIONS, SLOW_MODE_OPTIONS } from '@/lib/liveChatRules';
import {
  CHAT_COLORS,
  applySuggestion,
  draftQuery,
  emoteSuggestions,
  mentions,
  normalizeOutgoing,
  parseChatCommand,
  readChatMeta,
  userSuggestions,
  KINE_EMOTES,
  type ChatCommand,
  type Suggestion,
} from '@/lib/chatEmotes';
import { useChatEmotes } from '@/lib/useChatEmotes';
import { formatTipAmount } from '@/lib/liveTips';
import { CREATOR_PAYMENTS_ENABLED } from '@/lib/payments';
import { ChatSpeaker, TTS_MODES, readTtsMode, saveTtsMode, speechText, type TtsMode } from '@/lib/chatSpeech';
import ProfileImage from './ProfileImage';
import UiIcon, { type UiIconName } from './UiIcon';
import { SpeakerIcon } from './ReactionIcons';
import { ChatBody, ChatName } from './ChatText';
import ChatEmotePicker, { rememberRecent } from './ChatEmotePicker';
import ChatEmoteManager from './ChatEmoteManager';
import LivePollBox from './LivePollBox';

type Message = {
  id: number;
  user_id: string;
  body: string;
  created_at: string;
  /** 'tip' = podpora ve vysílání (zvýrazněná, s částkou). Bez migrace chybí. */
  kind?: string | null;
  tip_amount_cents?: number | null;
  tip_currency?: string | null;
  /** Odznaky, barva jména, odpověď, /me (lib/chatEmotes.ts - ChatMeta). Bez migrace chat-emoty chybí. */
  meta?: unknown;
  profiles?: { username: string | null; avatar_url: string | null } | null;
};

/**
 * Které sloupce databáze má (null = ještě nevíme) - zjistí se při prvním
 * načtení; bez migrace se chat načte bez nich (podpory: podpory-kontrola,
 * meta: chat-emoty).
 */
const columns: { tip: boolean | null; meta: boolean | null } = { tip: null, meta: null };

function fieldsFor(): string {
  return ['id, user_id, body, created_at', columns.tip !== false ? 'kind, tip_amount_cents, tip_currency' : '', columns.meta !== false ? 'meta' : '', 'profiles(username, avatar_url)']
    .filter(Boolean)
    .join(', ');
}

/** Podpora: částka (podle jazyka webu). */
function tipLabel(m: Message, lang: string): string | null {
  if (m.kind !== 'tip' || !m.tip_amount_cents || !m.tip_currency) return null;
  return formatTipAmount(m.tip_amount_cents, m.tip_currency, lang);
}

type Pinned = { id: number; uid: string; u: string; t: string; at: string };

type Rules = {
  available: boolean;
  /** Režim jen emoty a připínání (migrace chat-emoty). */
  extras?: boolean;
  settings: { slowSeconds: number; followersOnly: boolean; followMinutes: number; blockLinks: boolean; minAccountMinutes: number; shield: boolean; emoteOnly?: boolean };
  pinned?: Pinned | null;
  role: 'owner' | 'staff' | 'moderator' | 'viewer';
  canModerate: boolean;
  blockedTerms?: string[];
  bans?: { userId: string; username: string | null; until: string | null }[];
};

/**
 * Chat k živému vysílání nebo premiéře.
 *
 * Čte se přímo z databáze (tabulka je veřejně čitelná) - posledních 80
 * zpráv každé ~3 s, a to jen když je karta vidět. Celý výpis se bere
 * znovu, takže zmizí i zprávy, které mezitím smazal moderátor. Psaní,
 * mazání a moderace jdou přes /api/live/chat (přihlášení, blokace, tempo,
 * pravidla chatu - lib/liveChatRules.ts).
 *
 * Jako na Twitchi a Kicku: emoty (Kine i vlastní emoty kanálu) a emoji
 * s výběrem a našeptáváním (":", "@"), odpovědi na zprávy, @zmínky,
 * odznaky a barvy jmen, připnutá zpráva, režim jen emoty a příkazy
 * (/me, /ban, /timeout, /slow, /followers, /emoteonly, /color, /help).
 *
 * Podoby: "panel" (u přenosu), "popout" (samostatné okno /live/<id>/chat)
 * a "overlay" (průhledný chat pro OBS - jen zprávy, bez psaní).
 */
export default function LiveChat({
  room,
  canModerate = false,
  className = '',
  variant = 'panel',
  popoutHref,
  tts: ttsFromUrl,
  since = null,
  note = null,
}: {
  room: string;
  /** Majitel kanálu / videa (rozhodne stejně server - tohle jen ukáže tlačítka hned). */
  canModerate?: boolean;
  className?: string;
  variant?: 'panel' | 'popout' | 'overlay';
  /** Odkaz na chat v samostatném okně (ikonka v hlavičce). */
  popoutHref?: string;
  /** Překryv pro OBS: čtení nahlas z adresy (?tts=tips / ?tts=all). */
  tts?: TtsMode;
  /**
   * Jen zprávy od téhle chvíle (ISO) - chat vysílání patří k jednomu vysílání
   * (lib/liveChat.ts - chatSessionSince). null = všechny.
   */
  since?: string | null;
  /** Řádek nahoře v chatu (třeba "vysílání skončilo, chat začíná nanovo"). */
  note?: string | null;
}) {
  const { t, lang } = useLanguage();
  const [messages, setMessages] = useState<Message[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [termsDraft, setTermsDraft] = useState('');
  const [actionsFor, setActionsFor] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState(false);
  const [myColor, setMyColor] = useState<string | null | undefined>(undefined);
  const [hiddenPin, setHiddenPin] = useState<number | null>(null);
  // Nová anketa (jen streamer a moderátoři, jen chat živého vysílání).
  const [pollComposer, setPollComposer] = useState(false);
  const [suggest, setSuggest] = useState<{ items: Suggestion[]; index: number; start: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const overlay = variant === 'overlay';
  const mod = !!rules?.canModerate || canModerate;
  const emotes = useChatEmotes(room);
  // Čtení nahlas (lib/chatSpeech.ts): režim, předčítač a kam až se už četlo.
  const [ttsMode, setTtsMode] = useState<TtsMode>('off');
  const [ttsMenu, setTtsMenu] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(true);
  const speakerRef = useRef<ChatSpeaker | null>(null);
  const spokenUpToRef = useRef<number | null>(null);

  useEffect(() => {
    setTtsSupported(ChatSpeaker.supported());
    setTtsMode(overlay ? ttsFromUrl ?? 'off' : readTtsMode());
  }, [overlay, ttsFromUrl]);

  useEffect(() => {
    if (ttsMode === 'off') {
      speakerRef.current?.stop();
      return;
    }
    speakerRef.current ??= new ChatSpeaker(lang);
    speakerRef.current.setLang(lang);
  }, [ttsMode, lang]);

  useEffect(() => () => speakerRef.current?.stop(), []);

  // Nové zprávy -> přečíst (jen ty, co přišly po zapnutí; vlastní ne).
  useEffect(() => {
    if (messages.length === 0) return;
    const maxId = messages[messages.length - 1].id;
    const from = spokenUpToRef.current;
    spokenUpToRef.current = Math.max(from ?? 0, maxId);
    if (from === null || ttsMode === 'off' || !speakerRef.current) return;
    const templates = { tip: t('ttsTip'), tipNoMessage: t('ttsTipNoMessage'), chat: t('ttsChat'), link: t('ttsLinkWord') };
    for (const m of messages) {
      if (m.id <= from || m.user_id === userId) continue;
      const text = speechText({ kind: m.kind, name: m.profiles?.username ?? '?', body: m.body, amount: tipLabel(m, lang) }, ttsMode, templates);
      if (text) speakerRef.current.say(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  function changeTts(next: TtsMode) {
    // Zapnutí nečte, co už v chatu je - jen nové.
    if (messages.length > 0) spokenUpToRef.current = messages[messages.length - 1].id;
    setTtsMode(next);
    saveTtsMode(next);
    if (next !== 'off') {
      speakerRef.current ??= new ChatSpeaker(lang);
      // Krátké potvrzení - prohlížeč tím zároveň dostane od kliknutí svolení mluvit.
      speakerRef.current.say(next === 'tips' ? t('ttsOnTips') : t('ttsOnAll'));
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // Potvrzení ("Hotovo.", barva uložena) samo zmizí; nápověda příkazů vydrží déle.
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), info === t('liveChatCommandsHelp') ? 20000 : 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  // Moje jméno: zmínky o mně se zvýrazní.
  useEffect(() => {
    if (!userId || overlay) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setMyName((data as { username?: string | null } | null)?.username ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, overlay]);

  async function authHeader(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function refresh() {
    const asked = `${room}|${since ?? ''}`;
    const load = () => {
      let query = supabase.from('live_chat_messages').select(fieldsFor()).eq('room', room);
      if (since) query = query.gte('created_at', since);
      return query.order('id', { ascending: false }).limit(overlay ? 30 : 80);
    };
    let { data, error: loadError } = await load();
    // Databáze bez novějších sloupců (podpory, meta) - chat jede dál bez nich.
    for (let attempt = 0; attempt < 2 && loadError && /column|meta|kind|tip_amount|tip_currency/i.test(loadError.message ?? ''); attempt++) {
      const message = loadError.message ?? '';
      if (/meta/i.test(message) && columns.meta !== false) columns.meta = false;
      else if (/kind|tip_amount|tip_currency/i.test(message) && columns.tip !== false) columns.tip = false;
      else if (columns.meta !== false) columns.meta = false;
      else columns.tip = false;
      ({ data, error: loadError } = await load());
    }
    if (!loadError) {
      columns.tip = columns.tip ?? true;
      columns.meta = columns.meta ?? true;
    }
    // Mezitím začalo / skončilo vysílání (jiný chat) - odpověď patří starému.
    if (asked !== sessionRef.current) return;
    if (loadError) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setMessages(((data ?? []) as unknown as Message[]).reverse());
  }

  async function loadRules() {
    try {
      const res = await fetch(`/api/live/chat?room=${encodeURIComponent(room)}`, { headers: await authHeader(), cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as Rules;
      setRules(body);
      if (body.blockedTerms) setTermsDraft((current) => (current ? current : body.blockedTerms!.join(', ')));
    } catch {
      // Bez pravidel se chat ukáže dál, jen bez přehledu režimů.
    }
  }

  // Nové vysílání (nebo jeho konec) = nový chat: staré zprávy hned pryč, ne až po načtení.
  const sessionRef = useRef(`${room}|${since ?? ''}`);
  if (sessionRef.current !== `${room}|${since ?? ''}`) {
    sessionRef.current = `${room}|${since ?? ''}`;
    stickToBottomRef.current = true;
    if (messages.length > 0) setMessages([]);
  }

  useEffect(() => {
    let cancelled = false;
    refresh();
    if (!overlay) loadRules();
    const timer = setInterval(() => {
      if (!cancelled && (overlay || document.visibilityState === 'visible')) refresh();
    }, overlay ? 2000 : 3000);
    // Pravidla a připnutá zpráva - častěji, ať se připnutí ukáže brzo.
    const rulesTimer = overlay
      ? null
      : setInterval(() => {
          if (!cancelled && document.visibilityState === 'visible') loadRules();
        }, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (rulesTimer) clearInterval(rulesTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, userId, since]);

  // Nové zprávy dole - ale jen když divák nečte starší (neodroloval nahoru); jinak tlačítko "Nové zprávy".
  const lastSeenIdRef = useRef<number | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  useEffect(() => {
    const list = listRef.current;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    if (list && (stickToBottomRef.current || overlay)) {
      list.scrollTop = list.scrollHeight;
      lastSeenIdRef.current = lastId;
      setNewBelow(false);
    } else if (lastId !== null && lastSeenIdRef.current !== null && lastId > lastSeenIdRef.current) {
      setNewBelow(true);
    }
  }, [messages, overlay]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    if (stickToBottomRef.current) {
      setNewBelow(false);
      lastSeenIdRef.current = messages.length ? messages[messages.length - 1].id : null;
    }
  }

  function scrollToNewest() {
    const list = listRef.current;
    stickToBottomRef.current = true;
    setNewBelow(false);
    lastSeenIdRef.current = messages.length ? messages[messages.length - 1].id : null;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }

  /** Klik na jméno v chatu: "@jméno " do pole (jako na Twitchi). */
  function mentionUser(name: string) {
    if (!userId || !name || name === '—') return;
    const add = `@${name} `;
    setDraft((d) => (d.includes(add.trim()) ? d : `${d}${d && !/\s$/.test(d) ? ' ' : ''}${add}`).slice(0, CHAT_MAX_LENGTH));
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function durationLabel(minutes: number): string {
    if (minutes >= 1440 && minutes % 1440 === 0) return t('liveChatDays').replace('{n}', String(minutes / 1440));
    if (minutes >= 60 && minutes % 60 === 0) return t('liveChatHours').replace('{n}', String(minutes / 60));
    return t('liveChatMinutes').replace('{n}', String(minutes));
  }

  function rejectionText(body: any): string {
    switch (body?.code) {
      case 'slow':
        return t('liveChatErrSlow').replace('{s}', String(body.seconds ?? 2));
      case 'followers':
        return body.minutes > 0 ? t('liveChatErrFollowersMin').replace('{d}', durationLabel(body.minutes)) : t('liveChatErrFollowers');
      case 'newAccount':
        return t('liveChatErrNewAccount');
      case 'links':
        return t('liveChatErrLinks');
      case 'blocked':
        return t('liveChatErrBlocked');
      case 'emoteOnly':
        return t('liveChatErrEmoteOnly');
      case 'banned':
        return t('liveChatErrBanned');
      case 'timeout':
        return t('liveChatErrTimeout').replace('{time}', new Date(body.until).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }));
      default:
        return body?.error ?? t('liveChatUnavailable');
    }
  }

  /** Odeslat zprávu (i /me). true = povedlo se. */
  async function postMessage(text: string, opts: { action?: boolean } = {}): Promise<boolean> {
    const res = await fetch('/api/live/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ room, body: normalizeOutgoing(text, emotes.map), ...(replyTo ? { replyTo: replyTo.id } : {}), ...(opts.action ? { action: true } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json?.code ? rejectionText(json) : res.status === 429 ? t('liveChatTooFast') : json.error ?? t('liveChatUnavailable'));
      return false;
    }
    return true;
  }

  /** Příkaz z chatu (/ban, /slow, /color…). true = hotovo (pole se vyprázdní). */
  async function runCommand(cmd: ChatCommand): Promise<boolean> {
    const modOnly = () => {
      setError(t('liveChatCommandModOnly'));
      return false;
    };
    switch (cmd.cmd) {
      case 'me':
        return postMessage(cmd.text, { action: true });
      case 'ban':
      case 'unban':
        if (!mod) return modOnly();
        return moderateByName(cmd.user, cmd.cmd);
      case 'timeout':
        if (!mod) return modOnly();
        return moderateByName(cmd.user, 'timeout', cmd.minutes);
      case 'slow':
        if (!mod) return modOnly();
        return saveRules({ settings: { slowSeconds: cmd.seconds } });
      case 'followers':
        if (!mod) return modOnly();
        return saveRules({ settings: cmd.minutes === null ? { followersOnly: false, followMinutes: 0 } : { followersOnly: true, followMinutes: cmd.minutes } });
      case 'emoteonly':
        if (!mod) return modOnly();
        return saveRules({ settings: { emoteOnly: cmd.on ?? !rules?.settings.emoteOnly } });
      case 'unpin':
        if (!mod) return modOnly();
        return saveRules({ pin: null });
      case 'color':
        return saveColor(cmd.color);
      case 'help':
        setInfo(t('liveChatCommandsHelp'));
        return true;
      case 'invalid':
        setError(t('liveChatCommandInvalid').replace('{name}', cmd.name));
        return false;
      default:
        setError(t('liveChatCommandUnknown').replace('{name}', cmd.name));
        return false;
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    let body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setInfo(null);
    setSuggest(null);
    try {
      const cmd = parseChatCommand(body);
      let ok: boolean;
      if (cmd) ok = await runCommand(cmd);
      else {
        // "//text" = zpráva začínající lomítkem.
        if (body.startsWith('//')) body = body.slice(1);
        ok = await postMessage(body);
      }
      if (!ok) return;
      setDraft('');
      setReplyTo(null);
      stickToBottomRef.current = true;
      if (!cmd || cmd.cmd === 'me') await refresh();
    } catch {
      setError(t('liveChatUnavailable'));
    } finally {
      setSending(false);
    }
  }

  async function remove(id: number) {
    setMessages((list) => list.filter((m) => m.id !== id));
    setActionsFor(null);
    await fetch('/api/live/chat', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
  }

  async function moderate(target: string, action: 'timeout' | 'ban' | 'unban', minutes = 10) {
    setActionsFor(null);
    const res = await fetch('/api/live/chat/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ room, userId: target, action, minutes }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) setError(json?.error ?? t('liveChatUnavailable'));
    else if (action !== 'unban') setMessages((list) => list.filter((m) => m.user_id !== target));
    await loadRules();
  }

  async function moderateByName(name: string, action: 'timeout' | 'ban' | 'unban', minutes = 10): Promise<boolean> {
    const res = await fetch('/api/live/chat/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ room, username: name, action, minutes }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setError(json?.error ?? t('liveChatUnavailable'));
      return false;
    }
    setInfo(t('liveChatCommandDone'));
    await Promise.all([loadRules(), refresh()]);
    return true;
  }

  async function saveRules(patch: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const res = await fetch('/api/live/chat', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ room, ...patch }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setError(json?.error ?? t('liveChatUnavailable'));
      return false;
    }
    if (json?.blockedTerms) setTermsDraft(json.blockedTerms.join(', '));
    await loadRules();
    return true;
  }

  async function openColorMenu() {
    setColorMenu((v) => !v);
    if (myColor !== undefined) return;
    try {
      const res = await fetch('/api/live/chat/color', { headers: await authHeader(), cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      setMyColor(res.ok ? body?.color ?? null : null);
    } catch {
      setMyColor(null);
    }
  }

  async function saveColor(color: string | null): Promise<boolean> {
    setError(null);
    const res = await fetch('/api/live/chat/color', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ color }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setError(json?.error ?? t('liveChatUnavailable'));
      return false;
    }
    setMyColor(color);
    setInfo(t('liveChatNameColorSaved'));
    return true;
  }

  // ---- psaní: našeptávání a vkládání emotů ----------------------------------------------------

  const recentNames = useMemo(() => {
    const names: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const name = messages[i].profiles?.username;
      if (name && name !== myName) names.push(name);
    }
    return names;
  }, [messages, myName]);

  const allEmotes = useMemo(() => [...KINE_EMOTES, ...emotes.channel], [emotes.channel]);

  const updateSuggestions = useCallback(
    (text: string, caret: number) => {
      const q = draftQuery(text, caret);
      if (!q) {
        setSuggest(null);
        return;
      }
      const items = q.kind === 'user' ? userSuggestions(q.query, recentNames) : emoteSuggestions(q.query, allEmotes);
      setSuggest(items.length ? { items, index: 0, start: q.start } : null);
    },
    [recentNames, allEmotes]
  );

  function acceptSuggestion(s: Suggestion) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    if (!suggest) return;
    const next = applySuggestion(draft, caret, suggest.start, s);
    setDraft(next.text.slice(0, CHAT_MAX_LENGTH));
    setSuggest(null);
    if (s.kind === 'emote') rememberRecent(s.code);
    if (s.kind === 'emoji') rememberRecent(s.emoji);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggest) {
      if (e.key === 'Escape' && replyTo) setReplyTo(null);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggest.items.length;
      setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      acceptSuggestion(suggest.items[suggest.index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSuggest(null);
    }
  }

  /** Emote / emoji z výběru na místo kurzoru (s mezerami okolo). */
  function insertAtCaret(text: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after.startsWith(' ') ? '' : ' ';
    const next = `${before}${pre}${text}${post}${after}`.slice(0, CHAT_MAX_LENGTH);
    const caret = Math.min(next.length, (before + pre + text + post).length);
    setDraft(next);
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(caret, caret);
    });
  }

  function startReply(m: Message) {
    setReplyTo(m);
    setActionsFor(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const s = rules?.settings;
  const modes: { icon: UiIconName; label: string }[] = [];
  if (s?.shield) modes.push({ icon: 'shield', label: t('liveChatModeShield') });
  if (s?.emoteOnly) modes.push({ icon: 'smile', label: t('liveChatModeEmoteOnly') });
  if (s && s.slowSeconds > 0) modes.push({ icon: 'timer', label: t('liveChatModeSlow').replace('{d}', t('liveChatSeconds').replace('{n}', String(s.slowSeconds))) });
  if (s?.followersOnly) modes.push({ icon: 'users', label: t('liveChatModeFollowers') });
  if (s?.blockLinks) modes.push({ icon: 'link', label: t('liveChatModeLinks') });
  const pinned = rules?.pinned && rules.pinned.id !== hiddenPin ? rules.pinned : null;
  const manageEmotes = rules?.role === 'owner' || rules?.role === 'staff';
  // Ankety a raidy jsou jen v chatu živého vysílání (ne u premiér).
  const liveRoom = room.startsWith('channel:');
  let pollHint: string | null = null;
  for (let i = messages.length - 1; i >= 0 && liveRoom; i--) {
    const id = messages[i].kind === 'poll' ? (messages[i].meta as { poll?: unknown } | null)?.poll : null;
    if (typeof id === 'string') {
      pollHint = id;
      break;
    }
  }

  /** Raid / nová anketa - řádek v chatu místo obyčejné zprávy (text v jazyce diváka). */
  function eventLine(m: Message): { icon: UiIconName; text: string } | null {
    if (m.kind === 'raid') {
      const viewers = (m.meta as { raid?: { viewers?: unknown } } | null)?.raid?.viewers;
      const name = m.profiles?.username ?? '—';
      return {
        icon: 'bolt',
        text: typeof viewers === 'number' && viewers > 0 ? t('liveRaidChat').replace('{name}', name).replace('{n}', String(viewers)) : t('liveRaidChatNoCount').replace('{name}', name),
      };
    }
    if (m.kind === 'poll') return { icon: 'poll', text: t('livePollChatLine').replace('{q}', m.body.replace(/^📊\s*/u, '')) };
    return null;
  }

  if (overlay) {
    return (
      <div className={`live-chat-overlay ${className}`} ref={listRef}>
        {liveRoom && <LivePollBox room={room} canManage={false} loggedIn={false} pollHint={pollHint} overlay />}
        {messages.slice(-20).map((m) => {
          const event = eventLine(m);
          if (event) {
            return (
              <div key={m.id} className={`live-chat-overlay-msg event ${m.kind}`}>
                <UiIcon name={event.icon} size={15} /> {event.text}
              </div>
            );
          }
          const tip = tipLabel(m, lang);
          const meta = readChatMeta(m.meta);
          return (
            <div key={m.id} className={`live-chat-overlay-msg ${tip ? 'tip' : ''} ${meta.me ? 'action' : ''}`}>
              <ChatName userId={m.user_id} name={m.profiles?.username ?? '—'} meta={meta} />
              {tip && <span className="live-chat-tip-amount">💛 {tip}</span>}
              {tip && m.body === '💛' ? null : <ChatBody body={m.body} emotes={emotes.map} />}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`live-chat ${variant === 'popout' ? 'live-chat-popout' : ''} ${className}`}>
      <div className="live-chat-head">
        <span>{t('liveChatHeading')}</span>
        <span className="live-chat-head-actions">
          {userId && (
            <span className="live-chat-tts">
              <button
                type="button"
                className={`live-chat-icon-btn ${colorMenu ? 'active' : ''}`}
                onClick={openColorMenu}
                title={t('liveChatNameColor')}
                aria-label={t('liveChatNameColor')}
                aria-expanded={colorMenu}
              >
                <UiIcon name="palette" size={16} />
              </button>
              {colorMenu && (
                <span className="live-chat-tts-menu chat-color-menu" role="menu">
                  <span className="live-chat-panel-note">{t('liveChatNameColor')}</span>
                  <span className="chat-color-swatches">
                    {CHAT_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="menuitemradio"
                        aria-checked={myColor === c}
                        className={`chat-color-swatch ${myColor === c ? 'active' : ''}`}
                        style={{ background: c }}
                        title={c}
                        aria-label={c}
                        onClick={() => saveColor(c)}
                      />
                    ))}
                  </span>
                  <button type="button" role="menuitemradio" aria-checked={myColor === null} className={myColor === null ? 'active' : ''} onClick={() => saveColor(null)}>
                    {t('liveChatNameColorDefault')}
                  </button>
                </span>
              )}
            </span>
          )}
          <span className="live-chat-tts">
            <button
              type="button"
              className={`live-chat-icon-btn ${ttsMode !== 'off' ? 'active' : ''}`}
              onClick={() => setTtsMenu((v) => !v)}
              title={t('ttsButton')}
              aria-label={t('ttsButton')}
              aria-expanded={ttsMenu}
            >
              <SpeakerIcon muted={ttsMode === 'off'} size={16} />
            </button>
            {ttsMenu && (
              <span className="live-chat-tts-menu" role="menu">
                {!ttsSupported && <span className="live-chat-panel-note">{t('ttsUnsupported')}</span>}
                {/* "Jen podpory" až s placením (lib/payments.ts) - bez podpor by nečetlo nic. */}
                {TTS_MODES.filter((m) => m !== 'tips' || CREATOR_PAYMENTS_ENABLED || ttsMode === 'tips').map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitemradio"
                    aria-checked={ttsMode === m}
                    className={ttsMode === m ? 'active' : ''}
                    disabled={!ttsSupported && m !== 'off'}
                    onClick={() => {
                      changeTts(m);
                      setTtsMenu(false);
                    }}
                  >
                    {m === 'off' ? t('ttsOff') : m === 'tips' ? t('ttsTips') : t('ttsAll')}
                  </button>
                ))}
                {ttsMode !== 'off' && (
                  <button type="button" onClick={() => speakerRef.current?.skip()}>
                    ⏭ {t('ttsSkip')}
                  </button>
                )}
                <span className="live-chat-panel-note">{t('ttsHint')}</span>
              </span>
            )}
          </span>
          {popoutHref && (
            <a
              href={popoutHref}
              target="_blank"
              rel="noopener"
              className="live-chat-icon-btn"
              title={t('liveChatPopout')}
              aria-label={t('liveChatPopout')}
              onClick={(e) => {
                e.preventDefault();
                window.open(popoutHref, `kine-chat-${room.replace(/[^a-z0-9]/gi, '')}`, 'width=420,height=720');
              }}
            >
              ⧉
            </a>
          )}
          {mod && liveRoom && (
            <button
              type="button"
              className={`live-chat-icon-btn ${pollComposer ? 'active' : ''}`}
              onClick={() => setPollComposer((v) => !v)}
              title={t('livePollNew')}
              aria-label={t('livePollNew')}
              aria-expanded={pollComposer}
            >
              <UiIcon name="poll" size={16} />
            </button>
          )}
          {mod && (
            <button
              type="button"
              className={`live-chat-icon-btn ${panelOpen ? 'active' : ''}`}
              onClick={() => setPanelOpen((v) => !v)}
              title={t('liveChatSettings')}
              aria-label={t('liveChatSettings')}
              aria-expanded={panelOpen}
            >
              <UiIcon name="sliders" size={16} />
            </button>
          )}
        </span>
      </div>
      {modes.length > 0 && (
        <div className="live-chat-modes">
          {modes.map((m) => (
            <span key={m.icon} className="live-chat-mode">
              <UiIcon name={m.icon} size={13} />
              {m.label}
            </span>
          ))}
        </div>
      )}

      {mod && panelOpen && rules && (
        <div className="live-chat-panel">
          {!rules.available && <p className="live-chat-panel-note">{t('liveChatRulesNeedMigration')}</p>}
          <button
            type="button"
            className={`live-chat-shield ${s?.shield ? 'on' : ''}`}
            onClick={() => saveRules({ shield: !s?.shield })}
            disabled={!rules.available}
          >
            <UiIcon name="shield" size={15} />
            {s?.shield ? t('liveChatShieldOff') : t('liveChatShield')}
          </button>
          <p className="live-chat-panel-note">{t('liveChatShieldHint')}</p>
          <label className="live-chat-panel-row">
            <span>{t('liveChatSlowMode')}</span>
            <select value={s?.slowSeconds ?? 0} onChange={(e) => saveRules({ settings: { slowSeconds: Number(e.target.value) } })} disabled={!rules.available}>
              {SLOW_MODE_OPTIONS.map((sec) => (
                <option key={sec} value={sec}>
                  {sec === 0 ? t('liveChatOff') : t('liveChatSeconds').replace('{n}', String(sec))}
                </option>
              ))}
            </select>
          </label>
          <label className="live-chat-panel-row">
            <span>{t('liveChatFollowersOnly')}</span>
            <select
              value={s?.followersOnly ? String(s.followMinutes) : 'off'}
              onChange={(e) =>
                saveRules({ settings: e.target.value === 'off' ? { followersOnly: false, followMinutes: 0 } : { followersOnly: true, followMinutes: Number(e.target.value) } })
              }
              disabled={!rules.available}
            >
              <option value="off">{t('liveChatFollowersAll')}</option>
              {FOLLOW_MINUTES_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t('liveChatFollowersAny') : t('liveChatFollowersMin').replace('{d}', durationLabel(m))}
                </option>
              ))}
            </select>
          </label>
          <label className="live-chat-panel-row live-chat-panel-check">
            <input type="checkbox" checked={!!s?.blockLinks} onChange={(e) => saveRules({ settings: { blockLinks: e.target.checked } })} disabled={!rules.available} />
            <span>{t('liveChatBlockLinks')}</span>
          </label>
          <label className="live-chat-panel-row live-chat-panel-check">
            <input
              type="checkbox"
              className="chat-emote-only-toggle"
              checked={!!s?.emoteOnly}
              onChange={(e) => saveRules({ settings: { emoteOnly: e.target.checked } })}
              disabled={!rules.available || rules.extras === false}
            />
            <span>{t('liveChatEmoteOnly')}</span>
          </label>
          {rules.available && rules.extras === false && <p className="live-chat-panel-note">{t('liveChatExtrasNeedMigration')}</p>}
          <label className="live-chat-panel-col">
            <span>{t('liveChatBlockedTerms')}</span>
            <textarea rows={2} value={termsDraft} onChange={(e) => setTermsDraft(e.target.value)} placeholder={t('liveChatBlockedTermsHint')} disabled={!rules.available} />
          </label>
          <button
            type="button"
            className="live-small-btn"
            onClick={() => saveRules({ settings: { blockedTerms: termsDraft.split(',').map((x) => x.trim()).filter(Boolean) } })}
            disabled={!rules.available}
          >
            {t('liveChatSave')}
          </button>
          {manageEmotes && <ChatEmoteManager room={room} emotes={emotes.channel} available={emotes.available} onChange={emotes.replace} />}
          {rules.bans && rules.bans.length > 0 && (
            <div className="live-chat-bans">
              <p className="live-chat-panel-title">{t('liveChatBansHeading')}</p>
              {rules.bans.map((b) => (
                <div key={b.userId} className="live-chat-ban">
                  <span>
                    {b.username ?? '—'}{' '}
                    <span className="live-chat-panel-note">
                      {b.until
                        ? t('liveChatBannedUntil').replace('{time}', new Date(b.until).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }))
                        : t('liveChatBannedForever')}
                    </span>
                  </span>
                  <button type="button" className="live-small-btn" onClick={() => moderate(b.userId, 'unban')}>
                    {t('liveChatUnban')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {pinned && (
        <div className="chat-pinned" role="note">
          <UiIcon name="pin" size={14} />
          <span className="chat-pinned-text">
            <span className="chat-pinned-label">{t('liveChatPinned')}</span>
            {pinned.u && <span className="live-chat-user">{pinned.u}</span>}
            <ChatBody body={pinned.t} emotes={emotes.map} me={myName} jumbo={false} />
          </span>
          {mod ? (
            <button type="button" className="live-chat-icon-btn" onClick={() => saveRules({ pin: null })} title={t('liveChatUnpin')} aria-label={t('liveChatUnpin')}>
              ✕
            </button>
          ) : (
            <button type="button" className="live-chat-icon-btn" onClick={() => setHiddenPin(pinned.id)} title={t('liveChatHidePinned')} aria-label={t('liveChatHidePinned')}>
              ✕
            </button>
          )}
        </div>
      )}

      {liveRoom && (
        <LivePollBox
          room={room}
          canManage={mod}
          loggedIn={!!userId}
          pollHint={pollHint}
          composerOpen={pollComposer}
          onComposerClose={() => setPollComposer(false)}
        />
      )}

      <div ref={listRef} className="live-chat-list" onScroll={onScroll} aria-live="polite">
        {note && <p className="live-chat-note">{note}</p>}
        {unavailable && <p className="live-chat-empty">{t('liveChatUnavailable')}</p>}
        {!unavailable && messages.length === 0 && <p className="live-chat-empty">{t('liveChatEmpty')}</p>}
        {messages.map((m) => {
          const event = eventLine(m);
          if (event) {
            return (
              <div key={m.id} className={`live-chat-event ${m.kind}`} data-anim-scope>
                <UiIcon name={event.icon} size={15} />
                <span>{event.text}</span>
              </div>
            );
          }
          const own = m.user_id === userId;
          const tip = tipLabel(m, lang);
          const meta = readChatMeta(m.meta);
          const mentioned = !own && ((!!userId && meta.r?.uid === userId) || mentions(m.body, myName));
          return (
            <div
              key={m.id}
              className={`live-chat-msg ${tip ? 'tip' : ''} ${mentioned ? 'mentioned' : ''} ${meta.first ? 'first' : ''} ${meta.me ? 'action' : ''}`}
              data-anim-scope
            >
              <span className="live-chat-avatar" aria-hidden="true">
                {m.profiles?.avatar_url ? <ProfileImage src={m.profiles.avatar_url} /> : null}
              </span>
              <span className="live-chat-text">
                {meta.r && (
                  <span className="chat-reply-ref">
                    <UiIcon name="reply" size={11} />
                    <span className="chat-reply-name">@{meta.r.u || '—'}</span>
                    <span className="chat-reply-snippet">{meta.r.t}</span>
                  </span>
                )}
                {meta.first && <span className="chat-first-tag">{t('liveChatFirstTime')}</span>}
                <ChatName
                  userId={m.user_id}
                  name={m.profiles?.username ?? '—'}
                  meta={meta}
                  onClick={userId && !own && m.profiles?.username ? () => mentionUser(m.profiles!.username!) : undefined}
                />
                {tip && <span className="live-chat-tip-amount">💛 {tip}</span>}
                {tip && m.body === '💛' ? null : <ChatBody body={m.body} emotes={emotes.map} me={myName} />}
                {actionsFor === m.id && mod && !own && (
                  <span className="live-chat-actions">
                    <button type="button" onClick={() => remove(m.id)}>
                      {t('liveChatDelete')}
                    </button>
                    <button type="button" onClick={() => moderate(m.user_id, 'timeout', 10)}>
                      {t('liveChatTimeout')}
                    </button>
                    <button type="button" className="danger" onClick={() => moderate(m.user_id, 'ban')}>
                      {t('liveChatBan')}
                    </button>
                    {rules?.extras !== false && (
                      <button type="button" onClick={() => saveRules({ pin: m.id }).then(() => setActionsFor(null))}>
                        {t('liveChatPin')}
                      </button>
                    )}
                  </span>
                )}
              </span>
              <span className="live-chat-msg-actions">
                {userId && !own && (
                  <button type="button" className="live-chat-delete" onClick={() => startReply(m)} aria-label={t('liveChatReply')} title={t('liveChatReply')}>
                    <UiIcon name="reply" size={13} />
                  </button>
                )}
                {mod && own && rules?.extras !== false && (
                  <button type="button" className="live-chat-delete" onClick={() => saveRules({ pin: m.id })} aria-label={t('liveChatPin')} title={t('liveChatPin')}>
                    <UiIcon name="pin" size={13} />
                  </button>
                )}
                {mod && !own ? (
                  <button
                    type="button"
                    className="live-chat-delete"
                    onClick={() => setActionsFor((v) => (v === m.id ? null : m.id))}
                    aria-label={t('liveChatModerate')}
                    title={t('liveChatModerate')}
                  >
                    ⋯
                  </button>
                ) : own ? (
                  <button type="button" className="live-chat-delete" onClick={() => remove(m.id)} aria-label={t('liveChatDelete')} title={t('liveChatDelete')}>
                    ✕
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
        {newBelow && (
          <button type="button" className="chat-new-below" onClick={scrollToNewest}>
            <UiIcon name="chevronDown" size={14} />
            {t('liveChatNewMessages')}
          </button>
        )}
      </div>
      {userId ? (
        <div className="live-chat-compose">
          {replyTo && (
            <div className="chat-replying">
              <UiIcon name="reply" size={13} />
              <span className="chat-replying-text">
                {t('liveChatReplyingTo').replace('{name}', `@${replyTo.profiles?.username ?? '—'}`)}
                <span className="chat-reply-snippet">{replyTo.body}</span>
              </span>
              <button type="button" className="live-chat-icon-btn" onClick={() => setReplyTo(null)} aria-label={t('liveChatCancelReply')} title={t('liveChatCancelReply')}>
                ✕
              </button>
            </div>
          )}
          {suggest && (
            <div className="chat-suggest" role="listbox">
              {suggest.items.map((item, i) => (
                <button
                  key={item.kind === 'user' ? `u:${item.name}` : item.kind === 'emote' ? `e:${item.code}` : `j:${item.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === suggest.index}
                  className={`chat-suggest-item ${i === suggest.index ? 'active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => acceptSuggestion(item)}
                >
                  {item.kind === 'emote' ? <img src={item.url} alt="" /> : item.kind === 'emoji' ? <span className="chat-suggest-emoji">{item.emoji}</span> : <span className="chat-suggest-at">@</span>}
                  <span>{item.kind === 'user' ? item.name : item.kind === 'emote' ? item.code : `:${item.name}:`}</span>
                </button>
              ))}
            </div>
          )}
          {pickerOpen && <ChatEmotePicker channelEmotes={emotes.channel} onPick={insertAtCaret} onClose={() => setPickerOpen(false)} />}
          <form className="live-chat-form" onSubmit={send}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={CHAT_MAX_LENGTH}
              onChange={(e) => {
                setDraft(e.target.value);
                updateSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setSuggest(null), 150)}
              placeholder={s?.emoteOnly && !mod ? t('liveChatPlaceholderEmoteOnly') : t('liveChatPlaceholder')}
              aria-label={t('liveChatPlaceholder')}
              aria-autocomplete="list"
              disabled={unavailable}
            />
            <button
              type="button"
              className={`live-chat-icon-btn chat-emote-toggle ${pickerOpen ? 'active' : ''}`}
              onClick={() => setPickerOpen((v) => !v)}
              aria-label={t('liveChatEmotePicker')}
              title={t('liveChatEmotePicker')}
              aria-expanded={pickerOpen}
            >
              <UiIcon name="smile" size={18} />
            </button>
            <button type="submit" disabled={sending || !draft.trim() || unavailable}>
              {t('liveChatSend')}
            </button>
          </form>
        </div>
      ) : (
        <p className="live-chat-signin">
          <Link href={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`}>{t('liveChatSignIn')}</Link>
        </p>
      )}
      {error && <p className="live-chat-error">{error}</p>}
      {!error && info && <p className="live-chat-info">{info}</p>}
    </div>
  );
}
