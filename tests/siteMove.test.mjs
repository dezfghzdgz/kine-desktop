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
