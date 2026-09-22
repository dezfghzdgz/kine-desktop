import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage, shell } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NO_PRICES, hasClipsPlus, hasKinePlus, normalizePlan, type AccountInfo } from '../shared/plan';
import { log } from './log';

/**
 * Přihlášení k Kine.
 *
 * Appka NEMÁ zadrátované klíče k databázi - stáhne si je z Kine
 * (/api/desktop/config: adresa Supabase a veřejný "anon" klíč, ten samý,
 * který má každý návštěvník webu v prohlížeči). Díky tomu jde appka
 * přepnout na jinou instalaci Kine (vývoj na localhostu) bez nové verze.
 *
 * Dvě cesty k přihlášení:
 *  1. Přes prohlížeč: appka otevře kine.../connect?port=…&state=…, hráč
 *     tam (už přihlášený) klikne "Připojit počítač". Stránka si od Kine
 *     vyžádá jednorázový přihlašovací token PRO TENHLE počítač a pošle ho
 *     na http://127.0.0.1:<port>/link (nebo přes odkaz kine://link…).
 *     Appka z něj udělá vlastní relaci - s vlastním obnovovacím tokenem,
 *     takže se prohlížeč a appka navzájem neodhlašují.
 *  2. E-mail + heslo přímo v appce (Kine používá jen e-mail a heslo).
 *
 * Relace se ukládá zašifrovaná systémem (safeStorage: na Windows DPAPI),
 * takže si ji nepřečte jiný uživatel počítače.
 */

export type DesktopConfig = { supabaseUrl: string; supabaseAnonKey: string; siteUrl: string };

export type Account = AccountInfo;

type Listener = (account: Account | null) => void;

export class Auth {
  private client: SupabaseClient | null = null;
  private clientFor: string | null = null;
  private account: Account | null = null;
  private listeners = new Set<Listener>();
  private linkServer: Server | null = null;
  private linkState: string | null = null;
  private readonly dir: string;

  constructor(private siteUrl: () => string) {
    this.dir = app.getPath('userData');
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  current(): Account | null {
    return this.account;
  }

  /** Při startu: obnovit relaci z disku (když je). */
  async init(): Promise<void> {
    try {
      const client = await this.getClient();
      const { data } = await client.auth.getSession();
      if (data.session) await this.loadAccount();
    } catch (e) {
      log(`obnova přihlášení: ${(e as Error).message}`);
    }
  }

  /** Přístupový token pro volání Kine; supabase-js ho sám obnoví, když vypršel. */
  async getToken(): Promise<string | null> {
    try {
      const client = await this.getClient();
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  }

  // ---- konfigurace a klient ------------------------------------------------

  private async fetchConfig(): Promise<DesktopConfig> {
    const site = this.siteUrl();
    const cacheFile = join(this.dir, 'kine-config.json');
    try {
      const res = await fetch(`${site}/api/desktop/config`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<DesktopConfig>;
      if (!data.supabaseUrl || !data.supabaseAnonKey) throw new Error('no config');
      const config: DesktopConfig = { supabaseUrl: data.supabaseUrl, supabaseAnonKey: data.supabaseAnonKey, siteUrl: site };
      writeFileSync(cacheFile, JSON.stringify(config));
      return config;
    } catch (e) {
      // Offline: vezme se poslední známá konfigurace pro tuhle adresu.
      if (existsSync(cacheFile)) {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as DesktopConfig;
        if (cached.siteUrl === site) return cached;
      }
      throw new Error(`no-config:${(e as Error).message}`);
    }
  }

  private async getClient(): Promise<SupabaseClient> {
    const site = this.siteUrl();
    if (this.client && this.clientFor === site) return this.client;
    const config = await this.fetchConfig();
    this.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: this.storage(),
        storageKey: 'kine-desktop-auth',
      },
    });
    this.clientFor = site;
    return this.client;
  }

  /** Úložiště relace: jeden šifrovaný soubor. */
  private storage() {
    const file = join(this.dir, 'auth.bin');
    const encrypt = (text: string): Buffer =>
      safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from('plain:' + text, 'utf8');
    const decrypt = (buf: Buffer): string => {
      if (buf.subarray(0, 6).toString('utf8') === 'plain:') return buf.subarray(6).toString('utf8');
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '';
    };
    const readAll = (): Record<string, string> => {
      try {
        return JSON.parse(decrypt(readFileSync(file))) as Record<string, string>;
      } catch {
        return {};
      }
    };
    const writeAll = (data: Record<string, string>) => {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, encrypt(JSON.stringify(data)));
    };
    return {
      getItem: (key: string) => readAll()[key] ?? null,
      setItem: (key: string, value: string) => {
        const data = readAll();
        data[key] = value;
        writeAll(data);
      },
      removeItem: (key: string) => {
        const data = readAll();
        delete data[key];
        writeAll(data);
      },
    };
  }

  private async loadAccount(): Promise<void> {
    const client = await this.getClient();
    const { data } = await client.auth.getUser();
    const user = data.user;
    if (!user) {
      this.setAccount(null);
      return;
    }
    const previous = this.account;
    const same = previous?.userId === user.id ? previous : null;
    const account: Account = {
      userId: user.id,
      username: user.email?.split('@')[0] ?? 'kine',
      email: user.email ?? null,
      plan: same?.plan ?? 'free',
      planUntil: same?.planUntil ?? null,
      clipsPlus: same?.clipsPlus ?? false,
      kinePlus: same?.kinePlus ?? false,
      maxClipSeconds: same?.maxClipSeconds ?? 60,
      plusAvailable: previous?.plusAvailable ?? false,
      prices: previous?.prices ?? NO_PRICES,
      brandColor: same?.brandColor ?? null,
    };

    // Kdo jsem a co smím (plán Kine Plus, barva Kine) - z Kine, ne z
    // databáze napřímo: pravidla jsou na jednom místě (lib/plus.ts).
    try {
      const { data: session } = await client.auth.getSession();
      const token = session.session?.access_token;
      if (token) {
        const res = await fetch(`${this.siteUrl()}/api/desktop/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const me = (await res.json()) as Partial<AccountInfo> & { id?: string; plusPriceLabel?: string | null };
          if (me.username) account.username = me.username;
          account.plan = normalizePlan(me.plan);
          account.planUntil = me.planUntil ?? null;
          account.clipsPlus = typeof me.clipsPlus === 'boolean' ? me.clipsPlus : hasClipsPlus(account.plan);
          account.kinePlus = typeof me.kinePlus === 'boolean' ? me.kinePlus : hasKinePlus(account.plan);
          account.maxClipSeconds = typeof me.maxClipSeconds === 'number' ? me.maxClipSeconds : account.clipsPlus ? 300 : 60;
          account.plusAvailable = Boolean(me.plusAvailable);
          const prices = (me.prices ?? {}) as Partial<AccountInfo['prices']>;
          account.prices = {
            kine: typeof prices.kine === 'string' ? prices.kine : null,
            clips: typeof prices.clips === 'string' ? prices.clips : me.plusPriceLabel ?? null,
            all: typeof prices.all === 'string' ? prices.all : null,
          };
          account.brandColor = typeof me.brandColor === 'string' ? me.brandColor : null;
        } else {
          log(`/api/desktop/me odpověděla ${res.status}`);
        }
      }
    } catch (e) {
      log(`/api/desktop/me: ${(e as Error).message}`);
    }
    this.setAccount(account);
  }

  /**
   * Barva Kine zvolená v appce (5x klik na logo) -> na účet hráče, ať ji
   * má stejnou i web. Stejná cesta jako z prohlížeče (profiles.brand_color,
   * vlastní řádek). Bez přihlášení se nic neposílá.
   */
  async setBrandColor(color: string | null): Promise<void> {
    if (!this.account) return;
    try {
      const client = await this.getClient();
      const { error } = await client.from('profiles').update({ brand_color: color }).eq('id', this.account.userId);
      if (error) {
        log(`barva na účet: ${error.message}`);
        return;
      }
      this.account = { ...this.account, brandColor: color };
    } catch (e) {
      log(`barva na účet: ${(e as Error).message}`);
    }
  }

  /**
   * Jednorázový přihlašovací token pro web Kine v okně appky: appka je
   * přihlášená, web ne -> web dostane vlastní relaci (stejná cesta jako
   * /connect, jen obráceně). Null bez přihlášení nebo když Kine neodpoví.
   */
  async webLinkToken(): Promise<string | null> {
    const token = await this.getToken();
    if (!token) return null;
    try {
      const res = await fetch(`${this.siteUrl()}/api/desktop/link`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = (await res.json()) as { token_hash?: string };
      return data.token_hash ?? null;
    } catch (e) {
      log(`token pro web: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Opačný směr: hráč se přihlásil ve webu v okně appky, appka ne. Z jeho
   * přístupového tokenu si přes Kine vyžádá jednorázový token a udělá
   * z něj vlastní relaci - obnovovací tokeny se nesdílí.
   */
  async loginFromWebToken(webAccessToken: string): Promise<void> {
    const res = await fetch(`${this.siteUrl()}/api/desktop/link`, { method: 'POST', headers: { Authorization: `Bearer ${webAccessToken}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`link ${res.status}`);
    const data = (await res.json()) as { token_hash?: string };
    if (!data.token_hash) throw new Error('missing token');
    const client = await this.getClient();
    const { error } = await client.auth.verifyOtp({ type: 'magiclink', token_hash: data.token_hash });
    if (error) throw new Error(translateAuthError(error.message));
    await this.loadAccount();
  }

  /** Znovu se zeptat na plán a barvu (po startu, po přihlášení, občas). */
  async refresh(): Promise<void> {
    if (!this.account) return;
    try {
      await this.loadAccount();
    } catch (e) {
      log(`obnova účtu: ${(e as Error).message}`);
    }
  }

  private setAccount(account: Account | null): void {
    this.account = account;
    for (const l of this.listeners) l(account);
  }

  // ---- přihlášení ----------------------------------------------------------

  async loginWithPassword(email: string, password: string): Promise<void> {
    const client = await this.getClient();
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error(translateAuthError(error.message));
    await this.loadAccount();
  }

  async logout(): Promise<void> {
    try {
      const client = await this.getClient();
      // Jen tahle relace - "global" by odhlásil i prohlížeč a mobil hráče.
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // I když odhlášení na serveru neprojde, lokálně se relace zahodí.
    }
    try {
      unlinkSync(join(this.dir, 'auth.bin'));
    } catch {
      // Soubor už není.
    }
    this.setAccount(null);
  }

  /**
   * Přihlášení přes prohlížeč. Vrací, až přijde token (nebo po 10 minutách
   * skončí chybou). Mezitím appka poslouchá na 127.0.0.1.
   */
  async loginViaBrowser(): Promise<void> {
    this.closeLinkServer();
    const state = randomBytes(16).toString('hex');
    this.linkState = state;

    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handleLinkRequest(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
      this.linkServer = server;
    });

    const url = `${this.siteUrl()}/connect?port=${port}&state=${state}`;
    log(`přihlášení přes prohlížeč: ${url}`);
    await shell.openExternal(url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closeLinkServer();
        reject(new Error('browser-timeout'));
      }, 10 * 60 * 1000);
      this.linkResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.linkReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  private linkResolve: (() => void) | null = null;
  private linkReject: ((e: Error) => void) | null = null;

  cancelBrowserLogin(): void {
    this.closeLinkServer();
    this.linkReject?.(new Error('cancelled'));
    this.linkResolve = null;
    this.linkReject = null;
  }

  private closeLinkServer(): void {
    this.linkServer?.close();
    this.linkServer = null;
  }

  /** Odkaz kine://link?th=…&state=… (když prohlížeč nemohl na 127.0.0.1). */
  async handleDeepLink(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'kine:' || (parsed.hostname !== 'link' && parsed.pathname.replace(/^\/+/, '') !== 'link')) return false;
    const th = parsed.searchParams.get('th');
    const state = parsed.searchParams.get('state');
    if (!th) return false;
    await this.finishLink(th, state);
    return true;
  }

  private async finishLink(tokenHash: string, state: string | null): Promise<void> {
    if (!this.linkState || state !== this.linkState) throw new Error('bad-state');
    const client = await this.getClient();
    const { error } = await client.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
    if (error) throw new Error(translateAuthError(error.message));
    this.linkState = null;
    await this.loadAccount();
    this.closeLinkServer();
    this.linkResolve?.();
    this.linkResolve = null;
    this.linkReject = null;
  }

  private handleLinkRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const origin = req.headers.origin ?? '';
    const allowed = origin === this.siteUrl();
    const cors: Record<string, string> = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : {};

    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403, cors);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/ping')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'kine-desktop', version: app.getVersion() }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/link') || !allowed) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (d) => {
      body += d.toString();
      if (body.length > 10000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body) as { token_hash?: string; state?: string };
        if (!data.token_hash) throw new Error('missing token');
        await this.finishLink(data.token_hash, data.state ?? null);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        log(`připojení přes prohlížeč selhalo: ${(e as Error).message}`);
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
  }
}

/**
 * Chyby přihlášení jako kódy - text v jazyce hráče dosadí okno
 * (renderer/errors.ts: bad-credentials -> authErrBadCredentials…).
 */
function translateAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'bad-credentials';
  if (/email not confirmed/i.test(message)) return 'email-not-confirmed';
  if (/rate limit/i.test(message)) return 'rate-limit';
  if (/expired|invalid/i.test(message)) return 'link-expired';
  return message;
}
