/**
 * Klíč živého vysílání pryč z textu, který jde do protokolu, do diagnostiky
 * nebo do okna. Kdo klíč má, vysílá za kanál hráče - a ffmpeg ho v chybách
 * píše celou adresou ("rtmps://live.cloudflare.com:443/live/<klíč>: I/O error").
 *
 * Skryje se:
 *  - všechno za /live/ v adresách rtmp:// a rtmps:// (až po mezeru, uvozovky, ? nebo #),
 *  - hodnoty parametrů, které vypadají jako klíč (key, streamKey, stream_key,
 *    streamid, passphrase, secret, token),
 *  - známé klíče předané v `secrets` kdekoli v textu (nejméně 6 znaků - kratší
 *    by skrývaly i obyčejná slova).
 *
 * Čistá logika (tests/redact.test.mjs) - používá ji protokol (log.ts), vysílání
 * (live.ts) a diagnostika (main.ts).
 */

export const REDACTED = '***';

/** Adresa rtmp(s) až po /live/ (skupina 1) a co za ním následuje (skupina 2). */
const RTMP_LIVE = /(rtmps?:\/\/[^\s'"<>]*?\/live\/)([^\s'"<>?#]+)/gi;
/** Parametr adresy s klíčem: název a "=" (skupina 1), hodnota až po & / mezeru / # (nahradí se). */
const KEY_PARAM = /([?&](?:stream[_-]?key|streamid|key|passphrase|secret|token)=)[^&\s'"<>#]+/gi;
/** Interpunkce za adresou ("…/live/klíč: I/O error") k adrese nepatří - zůstane. */
const TRAILING = /[:,.;)\]]+$/;

export function redactStreamKeys(text: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const secret of secrets) {
    const s = typeof secret === 'string' ? secret.trim() : '';
    if (s.length >= 6) out = out.split(s).join(REDACTED);
  }
  out = out.replace(RTMP_LIVE, (_match, prefix: string, rest: string) => `${prefix}${REDACTED}${TRAILING.exec(rest)?.[0] ?? ''}`);
  return out.replace(KEY_PARAM, (_match, prefix: string) => `${prefix}${REDACTED}`);
}
