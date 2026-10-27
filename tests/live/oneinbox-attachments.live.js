// OneInbox attachments (2026-10-27): images show in the message, other files
// as preview cards, everything opens in a viewer; an HTML part with nothing in
// it (a phone sending just a photo) no longer draws an empty white box; cid:
// inline images are drawn inside the HTML; the body frame grows to its content.
//
// The mail worker and Firebase are faked as in oneinbox-drag.live.js; the
// attachments are real PNG/text bytes made here. Nothing leaves the machine.
//
// Run:          node tests/live/oneinbox-attachments.live.js
// Shots too:    node tests/live/oneinbox-attachments.live.js --shots
'use strict';
process.env.CDP_ALLOW_FONTS = '1';
const fs = require('fs');
const zlib = require('zlib');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.argv[2] === '--shots';

// A real PNG: w×h, a two-colour diagonal split.
function png(w, h, a, b) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x / w > y / h ? a : b, y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const PHOTO = png(640, 360, [120, 90, 200], [40, 160, 140]);
const LOGO = png(120, 40, [230, 80, 60], [250, 250, 250]);
const NOTES = Buffer.from('Line one of the notes\nLine two: 42 items\nLine three\n');
const DATA = { photo: PHOTO, logo: LOGO, notes: NOTES, pdf: Buffer.from('%PDF-1.1\n%fake\n') };

const ACCT = 'alpha@example.com';
const T0 = 1790000000000;
const LIST = [
  { id: 'm1', account: ACCT, from: 'Anthony <alpha@example.com>', subject: '(no subject)', snippet: '', date: String(T0), unread: false },
  { id: 'm2', account: ACCT, from: 'Shop <news@shop.example>', subject: 'Your receipt', snippet: 'Thanks', date: String(T0 - 3600e3), unread: false },
];
const FULL = {
  // What Gmail on a phone sends with a photo: an HTML part that is only a div.
  m1: { html: '<div dir="auto"></div>', text: '', attachments: [
    { filename: 'Screenshot_20261026_211419.jpg', mimeType: 'image/jpeg', size: PHOTO.length, attachmentId: 'photo', inline: false, contentId: '' }] },
  m2: { html: '<p>Thanks for your order.</p><p><img src="cid:logo123" alt="logo"></p><p>Total $12.00</p>', text: '', attachments: [
    { filename: 'logo.png', mimeType: 'image/png', size: LOGO.length, attachmentId: 'logo', inline: true, contentId: 'logo123' },
    { filename: 'receipt.pdf', mimeType: 'application/pdf', size: 2048, attachmentId: 'pdf', inline: false, contentId: '' },
    { filename: 'notes.txt', mimeType: 'application/octet-stream', size: NOTES.length, attachmentId: 'notes', inline: false, contentId: '' }] },
};
const fetched = [];

const FB = `
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const signInAnonymously = () => Promise.resolve({ user: { uid: 't' } });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 't' }), 0); return () => {}; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}
export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const collection = (db, ...p) => ({ path: p.join('/') });
export const query = (c) => c;
export const orderBy = () => ({});
export const limit = () => ({});
export const getDoc = () => Promise.resolve({ exists: () => false, data: () => ({}) });
export const setDoc = () => Promise.resolve();
export const onSnapshot = () => () => {};
`;

const mock = {
  patterns: ['https://oneinbox-api.av1.workers.dev/*', 'https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    const api = /^https:\/\/(oneinbox-api|taskhub-reminders)\.av1\.workers\.dev(\/[^?]*)/.exec(req.url);
    if (!api) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    const body = (() => { try { return JSON.parse(req.postData || '{}'); } catch { return {}; } })();
    switch (api[2]) {
      case '/accounts': return { json: { ok: true, accounts: [{ email: ACCT, name: 'alpha', signature: '' }] } };
      case '/gmail/list': return { json: { ok: true, messages: LIST } };
      case '/gmail/labels': return { json: { ok: true, labels: [] } };
      case '/gmail/message': {
        const m = LIST.find((x) => x.id === body.id);
        return { json: { ok: true, message: { ...m, labelIds: [], internalDate: Number(m.date), to: ACCT, ...FULL[body.id] } } };
      }
      case '/gmail/attachment': {
        fetched.push(body.attachmentId);
        const d = DATA[body.attachmentId];
        return { json: { ok: true, data: b64url(d), size: d.length } };
      }
      default: return { json: { ok: true } };
    }
  },
};

async function shot(c, name) {
  if (!SHOTS) return;
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath('oneinbox-att-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}
const q = (c, js) => evalJs(c, js);
const open = async (c, i) => { await q(c, `document.querySelectorAll('.msgrow')[${i}].click(); 1`); await sleep(1500); };

async function run(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html?blank' }); await sleep(800);
  await q(c, "localStorage.clear(); sessionStorage.clear(); localStorage.setItem('oneinbox_lock_session', JSON.stringify({token:'test'})); 1");
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' });
  await sleep(2500);
  const tag = `[${w}] `;

  // ── 1. the photo-only message ──
  await open(c, 0);
  ok(tag + 'empty HTML part draws no white frame', (await q(c, "return !document.getElementById('mailFrame')+'';")) === 'true');
  ok(tag + 'no "no text" line when there is an attachment', (await q(c, "return !document.querySelector('.readbody .nobody')+'';")) === 'true');
  const img = JSON.parse(await q(c, "var i=document.querySelector('.attimg img'); return JSON.stringify(i?{w:i.naturalWidth,h:i.naturalHeight,shown:i.getBoundingClientRect().width}:null);"));
  ok(tag + 'the photo is drawn in the message', img && img.w === 640 && img.h === 360 && img.shown > 100, JSON.stringify(img));
  ok(tag + 'the photo card names the file', /Screenshot_20261026_211419\.jpg/.test(await q(c, "return document.querySelector('.attimg .cap').textContent;")));
  await shot(c, w + '-photo');

  await q(c, "document.querySelector('.attimg').click(); 1"); await sleep(600);
  const v = JSON.parse(await q(c, "var i=document.querySelector('.attview .stage img'); return JSON.stringify(i?{w:i.naturalWidth}:null);"));
  ok(tag + 'clicking the photo opens it full size', v && v.w === 640, JSON.stringify(v));
  await shot(c, w + '-viewer');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  ok(tag + 'Esc closes the viewer', (await q(c, "return !document.querySelector('.attview')+'';")) === 'true');
  const before = fetched.filter((x) => x === 'photo').length;
  await q(c, "document.querySelector('.attimg').click(); 1"); await sleep(400);
  ok(tag + 'reopening reuses the fetched bytes', fetched.filter((x) => x === 'photo').length === before);
  await q(c, "document.querySelector('.attview [data-v=x]').click(); 1"); await sleep(200);

  // ── 2. HTML with a cid: image plus files ──
  await open(c, 1);
  const fr = JSON.parse(await q(c, `var f=document.getElementById('mailFrame'); if(!f) return 'null';
    var d=f.contentDocument, i=d&&d.querySelector('img');
    return JSON.stringify({h:f.getBoundingClientRect().height, src:i?i.getAttribute('src').slice(0,22):'', nw:i?i.naturalWidth:0});`));
  ok(tag + 'the HTML body is shown', fr && fr.h > 0, JSON.stringify(fr));
  ok(tag + 'the frame fits its content (not 900px)', fr && fr.h < 400, fr && fr.h);
  ok(tag + 'the cid: image is drawn inside the HTML', fr && fr.src === 'data:image/png;base64,' && fr.nw === 120, JSON.stringify(fr));
  ok(tag + 'the frame still runs no scripts', /allow-same-origin/.test(await q(c, "return document.getElementById('mailFrame').getAttribute('sandbox');"))
    && !/allow-scripts/.test(await q(c, "return document.getElementById('mailFrame').getAttribute('sandbox');")));
  const cards = JSON.parse(await q(c, "return JSON.stringify([...document.querySelectorAll('.attcard')].map(e=>e.querySelector('.nm').textContent));"));
  ok(tag + 'the inline logo is not listed again; the two files are', JSON.stringify(cards) === '["receipt.pdf","notes.txt"]', JSON.stringify(cards));
  ok(tag + 'no image section for a message whose only image is inline', (await q(c, "return document.querySelectorAll('.attimg').length;")) === 0);
  ok(tag + 'the PDF card says PDF', (await q(c, "return document.querySelector('.attcard .thumb').textContent.trim();")) === 'PDF');
  ok(tag + 'the text card shows its first lines', /Line two: 42 items/.test(await q(c, "var p=document.querySelectorAll('.attcard')[1].querySelector('pre'); return p?p.textContent:'';")));
  await shot(c, w + '-files');
  await q(c, "document.querySelectorAll('.attcard')[1].click(); 1"); await sleep(500);
  ok(tag + 'a text file opens readable in the viewer', /Line three/.test(await q(c, "var p=document.querySelector('.attview .stage pre'); return p?p.textContent:'';")));
  await q(c, "document.querySelector('.attview [data-v=x]').click(); 1"); await sleep(200);
  await q(c, "document.querySelectorAll('.attcard')[0].click(); 1"); await sleep(500);
  ok(tag + 'a PDF opens in the viewer', (await q(c, "var f=document.querySelector('.attview .stage iframe'); return f?f.src.slice(0,5):'';")) === 'blob:');
  await q(c, "document.querySelector('.attview [data-v=x]').click(); 1"); await sleep(200);
  ok(tag + 'no horizontal page scroll', (await q(c, "return (document.documentElement.scrollWidth<=innerWidth)+'';")) === 'true');
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await run(c, 1440, 900, false);
  await run(c, 390, 844, true);
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
