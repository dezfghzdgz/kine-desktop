import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedSite, checkSiteMove, normalizeSite } from '../dist/esm/siteMove.js';

const OLD = 'https://kine-lac.vercel.app';
const NEW = 'https://kine.cz';
const SUPA = 'https://abc.supabase.co';

/** Napodobený web: adresa -> co vrátí /api/desktop/config (null = nedostupné). */
function fakeFetch(sites) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const site = url.replace(/\/api\/desktop\/config$/, '');
    const body = sites[site];
    if (body === undefined || body === null) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('adresa webu: bez lomítka, malá doména, jen http(s) bez cesty', () => {
  assert.equal(normalizeSite('https://Kine.CZ/'), 'https://kine.cz');
  assert.equal(normalizeSite('https://kine.cz/watch/1'), null);
  assert.equal(normalizeSite('ftp://kine.cz'), null);
  assert.equal(normalizeSite('nesmysl'), null);
  assert.equal(normalizeSite(undefined), null);
});

test('hlášená adresa: nová vlastní doména ano; stejná, http, localhost a návrat na vercel.app ne', () => {
  assert.equal(announcedSite(OLD, { siteUrl: 'https://kine.cz/' }), NEW);
  assert.equal(announcedSite(OLD, { siteUrl: OLD }), null);
  assert.equal(announcedSite(OLD, { siteUrl: 'http://kine.cz' }), null);
  assert.equal(announcedSite('http://localhost:3000', { siteUrl: NEW }), null, 'vývoj zůstává na localhostu');
  assert.equal(announcedSite(OLD, { siteUrl: 'https://localhost' }), null);
  assert.equal(announcedSite(NEW, { siteUrl: OLD }), null, 'z vlastní domény zpátky na vercel.app nikdy');
  assert.equal(announcedSite(NEW, { siteUrl: 'https://www.kine.cz' }), 'https://www.kine.cz');
  assert.equal(announcedSite(OLD, null), null);
});

test('stěhování: nová adresa musí odpovědět stejnou databází a potvrdit sama sebe', async () => {
  const ok = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: NEW }, [NEW]: { supabaseUrl: SUPA, siteUrl: NEW } });
  assert.equal(await checkSiteMove(OLD, ok), NEW);
  assert.deepEqual(ok.calls, [`${OLD}/api/desktop/config`, `${NEW}/api/desktop/config`]);

  const otherDb = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: NEW }, [NEW]: { supabaseUrl: 'https://cizi.supabase.co', siteUrl: NEW } });
  assert.equal(await checkSiteMove(OLD, otherDb), null, 'jiná databáze = jiné Kine');

  const notConfirmed = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: NEW }, [NEW]: { supabaseUrl: SUPA, siteUrl: OLD } });
  assert.equal(await checkSiteMove(OLD, notConfirmed), null);

  const down = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: NEW } });
  assert.equal(await checkSiteMove(OLD, down), null, 'nová adresa ještě neběží');

  const same = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: OLD } });
  assert.equal(await checkSiteMove(OLD, same), null);
  assert.equal(same.calls.length, 1);

  const offline = fakeFetch({});
  assert.equal(await checkSiteMove(OLD, offline), null);
});

test('stěhování s přesměrováním: holá doména -> www = appka jde rovnou na www', async () => {
  const APEX = 'https://playkine.com';
  const WWW = 'https://www.playkine.com';
  // Web hlásí holou doménu, ta přesměruje na www (fetch vrátí konečnou adresu v res.url).
  const redirecting = async (url) => {
    const site = url.replace(/\/api\/desktop\/config$/, '');
    if (site === OLD) return { ok: true, url, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    if (site === APEX) return { ok: true, url: `${WWW}/api/desktop/config`, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    return { ok: false, json: async () => ({}) };
  };
  assert.equal(await checkSiteMove(OLD, redirecting), WWW);
  // Hlášená adresa přesměruje zpátky tam, kde appka je (vercel.app): web tedy opravdu
  // odpovídá tady - nic neměnit (jinak by appka chodila přes přesměrování bez přihlášení).
  const back = async (url) => {
    const site = url.replace(/\/api\/desktop\/config$/, '');
    if (site === OLD) return { ok: true, url, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    return { ok: true, url: `${OLD}/api/desktop/config`, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
  };
  assert.equal(await checkSiteMove(OLD, back), null);
  // Bez res.url (starší fetch) jako dřív.
  const plain = fakeFetch({ [OLD]: { supabaseUrl: SUPA, siteUrl: APEX }, [APEX]: { supabaseUrl: SUPA, siteUrl: APEX } });
  assert.equal(await checkSiteMove(OLD, plain), APEX);
});

test('stěhování s přesměrováním: appka na www zůstane na www; z holé domény jde na www', async () => {
  const APEX = 'https://playkine.com';
  const WWW = 'https://www.playkine.com';
  // Web hlásí holou doménu (nejkratší), ta přesměruje na www.
  const site = async (url) => {
    const s = url.replace(/\/api\/desktop\/config$/, '');
    if (s === APEX) return { ok: true, url: `${WWW}/api/desktop/config`, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    if (s === WWW) return { ok: true, url, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    if (s === OLD) return { ok: true, url, json: async () => ({ supabaseUrl: SUPA, siteUrl: APEX }) };
    return { ok: false, json: async () => ({}) };
  };
  assert.equal(await checkSiteMove(OLD, site), WWW, 'z vercel.app rovnou na www');
  assert.equal(await checkSiteMove(WWW, site), null, 'na www už je - zpátky na holou ne');
  assert.equal(await checkSiteMove(APEX, site), WWW, 'z holé domény (přesměrovává) na www');
});
