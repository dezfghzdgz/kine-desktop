import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKineSite, isKineUrl, isWebFrameUrl, kineWebPermission } from '../dist/esm/webGuard.js';

const SITE = 'https://www.playkine.com';

test('web Kine: adresa z nastavení (www i bez), oficiální adresy, cizí web ne', () => {
  assert.equal(isKineUrl('https://playkine.com/watch/1', SITE), true);
  assert.equal(isKineUrl('http://www.playkine.com/', SITE), false, 'jiný protokol');
  assert.equal(isKineUrl('https://www.playkine.com.evil.example/', SITE), false);
  assert.equal(isKineSite('https://kine-lac.vercel.app/x', SITE), true, 'stará oficiální adresa (přesměrování)');
  assert.equal(isKineSite('https://evil.example/', SITE), false);
  assert.equal(isKineSite('https://www.playkine.com/x', 'http://localhost:3000'), true, 'vývoj: oficiální web zůstává Kine');
});

test('web Kine: vložené rámce smí jen na web', () => {
  for (const url of ['https://challenges.cloudflare.com/x', 'about:blank', 'about:srcdoc', 'blob:https://www.playkine.com/1', 'data:text/html,x']) assert.equal(isWebFrameUrl(url), true, url);
  for (const url of ['kine://settings', 'ms-msdt:/id', 'file:///C:/x', 'search-ms:query=x', 'javascript:alert(1)']) assert.equal(isWebFrameUrl(url), false, url);
});

test('web Kine: kamera a mikrofon jen hlavní stránce Kine', () => {
  assert.equal(kineWebPermission('media', { requestingUrl: `${SITE}/studio`, isMainFrame: true }, SITE), true);
  assert.equal(kineWebPermission('media', { requestingUrl: `${SITE}/embed`, isMainFrame: false, topUrl: `${SITE}/studio` }, SITE), false, 'vložený rámec ne');
  assert.equal(kineWebPermission('media', { requestingUrl: 'https://evil.example/', isMainFrame: true }, SITE), false, 'cizí web (přesměrování) ne');
  assert.equal(kineWebPermission('media', { isMainFrame: true }, SITE), false, 'bez adresy ne');
});

test('web Kine: openExternal a ostatní nikdo; celá obrazovka i přehrávači ve stránce Kine', () => {
  for (const permission of ['openExternal', 'geolocation', 'midi', 'hid', 'usb', 'serial', 'clipboard-read', 'display-capture', 'unknown']) {
    assert.equal(kineWebPermission(permission, { requestingUrl: SITE, isMainFrame: true, topUrl: SITE }, SITE), false, permission);
  }
  assert.equal(kineWebPermission('notifications', { requestingUrl: SITE, isMainFrame: true }, SITE), true);
  assert.equal(kineWebPermission('clipboard-sanitized-write', { requestingUrl: 'https://evil.example/', isMainFrame: true }, SITE), false);
  assert.equal(kineWebPermission('fullscreen', { requestingUrl: 'https://customer-a.cloudflarestream.com/x', isMainFrame: false, topUrl: `${SITE}/watch/1` }, SITE), true);
  assert.equal(kineWebPermission('fullscreen', { requestingUrl: 'https://evil.example/', isMainFrame: true, topUrl: 'https://evil.example/' }, SITE), false);
});
