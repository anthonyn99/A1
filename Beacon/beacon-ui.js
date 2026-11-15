/* ═══════════════════════════════════════════════════════════════════════════
   Beacon's panel. Loaded by Beacon/beacon.js the first time Beacon.open() runs;
   never loaded by a program directly. Contract: docs/Beacon/README.md

   A shadow root, so no program's CSS reaches in and none of this leaks out.
   Tony's side wears Guardian's MAGI tokens and Veda's side her TaskHub
   palette, the same two themes as the lock card. No fades: it opens and
   closes instantly. Desktop and tablet get a centred sheet, phones a bottom
   sheet with 44px targets.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
if (window.BeaconUI) return;
var B = window.Beacon;
var FCM = 'fcm_tokens';
var ACTIVE_MS = 10 * 60 * 1000;
var STALE_MS = 60 * 86400 * 1000;
var NAMES = { tony: 'Tony', veda: 'Veda' };
var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@600;700;800&family=Lora:wght@500;600;700&display=swap';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// "Thursday, November 12, 1:48 PM" (the year only when it is not this one).
function fullTime(t) {
  if (!t) return '';
  var d = new Date(+t), o = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  try { return d.toLocaleString('en-US', o); } catch (e) { return d.toString(); }
}
function ago(t) {
  if (!t) return 'never';
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 30 * 86400) return Math.floor(s / 86400) + 'd ago';
  try { return new Date(+t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(+t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }); } catch (e) { return ''; }
}

var SV = function (p, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };
var I = {
  phone: SV('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  tablet: SV('<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  laptop: SV('<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/>'),
  desktop: SV('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>'),
  beacon: SV('<circle cx="12" cy="12" r="2"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 18.7a9.5 9.5 0 0 1 0-13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>'),
  bell: SV('<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>'),
  bellOff: SV('<path d="M13.7 20a2 2 0 0 1-3.4 0M8.3 3.9A6 6 0 0 1 18 9c0 2.5.4 4.2.9 5.3M6.1 6.2C6 7.1 6 8 6 9c0 6-2 7-2 7h12.5M3 3l18 18"/>'),
  lock: SV('<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
  unlock: SV('<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7"/>'),
  bio: SV('<path d="M12 11c0 3.5-1 6.5-3 9M8.5 6.6A6 6 0 0 1 18 11c0 2-.2 4-.7 5.8M6 9a6 6 0 0 0-.5 2.4c0 1.6-.4 3.1-1 4.4M15 11.5c0 2.6-.5 5.1-1.6 7.3M12 8a3 3 0 0 0-3 3c0 1.2-.1 2.4-.4 3.5"/>'),
  pencil: SV('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: SV('<path d="M3.5 6.5h17M9 6.5V4h6v2.5M6 6.5l1 13.5h10l1-13.5"/>'),
  close: SV('<path d="M6 6l12 12M18 6 6 18"/>', 2),
  refresh: SV('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>'),
  chev: SV('<path d="m6 9 6 6 6-6"/>', 2)
};
var KINDS = [['phone', 'Phone'], ['tablet', 'Tablet'], ['laptop', 'Laptop'], ['desktop', 'Desktop']];
function kindIcon(k) { return I[k === 'computer' ? 'desktop' : k] || I.desktop; }
function bioName(os) { return os === 'iOS' || os === 'iPadOS' ? 'Face ID / Touch ID' : os === 'macOS' ? 'Touch ID' : os === 'Windows' ? 'Windows Hello' : os === 'Android' ? 'Fingerprint' : 'Biometrics'; }

var CSS = [
':host{all:initial}',
':host,*,*::before,*::after{-webkit-tap-highlight-color:transparent}',
'*{box-sizing:border-box}',
'button{font:inherit;color:inherit;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
'[hidden]{display:none!important}',
'.ov{position:fixed;inset:0;z-index:2147482500;display:flex;align-items:center;justify-content:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:rgba(0,0,0,.6);-webkit-backdrop-filter:blur(7px) saturate(.9);backdrop-filter:blur(7px) saturate(.9);font-family:var(--f);color:var(--tx);-webkit-font-smoothing:antialiased;overscroll-behavior:contain}',
/* Tony: Guardian's MAGI tokens. Veda: her TaskHub palette (Guardian's veda theme). */
'.ov[data-theme=tony]{--bg:#1a1a1d;--s1:#232327;--s2:#2c2c31;--s3:#34343a;--bd:rgba(255,255,255,.07);--bdl:#45454c;--tx:#f4f3f0;--txd:#adadb2;--txm:#8d8d94;--ac:#c0aeea;--acl:#dbd0f5;--acs:rgba(192,174,234,.12);--onac:#1a1a1d;--red:#d68a7c;--reds:rgba(214,138,124,.12);--ok:#9fcfa8;--oks:rgba(159,207,168,.1);--ring:rgba(192,174,234,.18);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Manrope","Inter",system-ui,sans-serif;--r:10px;--rb:6px;--btn-fs:10px;--btn-tt:uppercase;--btn-ls:1px;--title-fs:22px;--title-w:800;--title-ls:-.3px}',
'.ov[data-theme=veda]{--bg:#1B1C1E;--s1:#26272A;--s2:#2E2F33;--s3:#36373C;--bd:#3D3E43;--bdl:#4A4B51;--tx:#ECECEE;--txd:#AFB0B5;--txm:#8a8b90;--ac:#A892B0;--acl:#C9B6D0;--acs:rgba(141,118,154,.16);--onac:#ffffff;--red:#E07A6F;--reds:rgba(224,122,111,.12);--ok:#9cc7a4;--oks:rgba(156,199,164,.1);--ring:rgba(141,118,154,.28);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Lora",Georgia,serif;--r:10px;--rb:8px;--btn-fs:12.5px;--btn-tt:none;--btn-ls:0;--title-fs:24px;--title-w:700;--title-ls:-.2px}',
'.sheet{position:relative;width:720px;max-width:100%;max-height:min(88vh,920px);display:flex;flex-direction:column;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);box-shadow:0 24px 70px rgba(0,0,0,.55);outline:none;overflow:hidden}',
'.hd{display:flex;align-items:flex-start;gap:14px;padding:22px 22px 14px}',
'.hic{flex:none;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ac);background:var(--s2);border:1px solid var(--bd)}',
'.hic svg{width:21px;height:21px}',
'.ht{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
'.kick{font:700 10px/1 var(--f);letter-spacing:1.6px;text-transform:uppercase;color:var(--acl)}',
'h2{margin:0;font-family:var(--fd);font-size:var(--title-fs);font-weight:var(--title-w);letter-spacing:var(--title-ls);line-height:1.15;color:var(--tx)}',
'.sub{font:400 13px/1.45 var(--f);color:var(--txm)}',
'.ib{flex:none;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--rb);border:1px solid transparent;background:none;color:var(--txm);cursor:pointer;padding:0}',
'.ib svg{width:18px;height:18px}',
'.bar{display:flex;align-items:center;gap:10px;padding:0 22px 14px;border-bottom:1px solid var(--bd)}',
'.seg{display:inline-flex;padding:3px;gap:3px;background:var(--bg);border:1px solid var(--bd);border-radius:calc(var(--rb) + 3px)}',
'.seg button{border:0;background:none;color:var(--txd);font:600 12.5px/1 var(--f);padding:8px 13px;border-radius:var(--rb);cursor:pointer;white-space:nowrap}',
'.seg button[aria-pressed=true]{background:var(--s3);color:var(--tx);box-shadow:inset 0 0 0 1px var(--bdl)}',
'.bar .sp{flex:1}',
'.count{font:500 12px var(--f);color:var(--txm);font-variant-numeric:tabular-nums;white-space:nowrap}',
'.body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:6px 22px 18px}',
'.sec{padding-top:16px}',
'.sh{display:flex;align-items:baseline;gap:8px;margin:0 2px 10px}',
'.st{font:700 10px/1 var(--f);letter-spacing:1.4px;text-transform:uppercase;color:var(--txm)}',
'.sn{font:500 12px/1.4 var(--f);color:var(--txm)}',
'.list{display:flex;flex-direction:column;gap:10px}',
'.dev{background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden}',
'.dev.me{border-color:var(--bdl)}',
'.dh{display:flex;align-items:center;gap:13px;padding:14px 14px 12px}',
'.dic{position:relative;flex:none;width:44px;height:44px;border-radius:var(--rb);display:flex;align-items:center;justify-content:center;background:var(--bg);border:1px solid var(--bd);color:var(--txd)}',
'.dev.me .dic{color:var(--ac)}',
'.dic svg{width:22px;height:22px}',
'.live{position:absolute;right:-3px;top:-3px;width:11px;height:11px;border-radius:50%;background:var(--ok);border:2px solid var(--s2)}',
'.dt{flex:1;min-width:0}',
'.dn{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;font:650 15px/1.3 var(--f);color:var(--tx);word-break:break-word}',
'.dm{margin-top:3px;font:400 12.5px/1.45 var(--f);color:var(--txm)}',
'.tag{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:999px;font:700 9.5px/1 var(--f);letter-spacing:.6px;text-transform:uppercase;border:1px solid var(--bdl);color:var(--txd)}',
'.tag.me{border-color:var(--ac);color:var(--acl)}',
'.tag.old{color:var(--txm)}',
'.apps{border-top:1px solid var(--bd)}',
'.ap{padding:10px 14px}',
'.ap+.ap{border-top:1px solid var(--bd)}',
'.ar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px}',
'.an{font:600 13px/1.3 var(--f);color:var(--tx);min-width:84px}',
'.pills{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:1}',
'.pill{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:4px 9px;border-radius:999px;border:1px solid var(--bd);background:var(--bg);font:500 12px/1.2 var(--f);color:var(--txd);white-space:nowrap}',
'.pill svg{width:13px;height:13px;flex:none}',
'.pill.ok{color:var(--ok);background:var(--oks);border-color:transparent}',
'.pill.bad{color:var(--red);background:var(--reds);border-color:transparent}',
'.pill.ac{color:var(--acl);background:var(--acs);border-color:transparent}',
'button.pill{cursor:pointer}',
'button.pill .cv{display:inline-flex;transition:none}',
'button.pill[aria-expanded=true] .cv{transform:rotate(180deg)}',
'.when{margin-left:auto;font:500 12px var(--f);color:var(--txm);font-variant-numeric:tabular-nums;white-space:nowrap}',
'.locks{margin-top:8px;display:flex;flex-direction:column;gap:2px;padding:6px 8px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--rb)}',
'.lk{display:flex;align-items:center;gap:8px;min-height:30px;font:500 12.5px/1.3 var(--f);color:var(--txd)}',
'.lk svg{width:14px;height:14px;flex:none}',
'.lk .ln{flex:1;min-width:0;color:var(--tx)}',
'.lk .lo{color:var(--ok)}.lk .lc{color:var(--red)}.lk .lb{color:var(--txm);display:inline-flex;align-items:center;gap:4px}',
'.flag{margin:0 14px 12px;padding:9px 11px;border-radius:var(--rb);background:var(--acs);color:var(--acl);font:500 12.5px/1.45 var(--f);display:flex;align-items:center;gap:10px}',
'.flag .fx{margin-left:auto}',
'.acts{display:flex;gap:8px;padding:10px 14px 12px;border-top:1px solid var(--bd)}',
'.b{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:7px 13px;border-radius:var(--rb);border:1px solid var(--bdl);background:var(--s1);color:var(--txd);font:700 var(--btn-fs)/1 var(--f);letter-spacing:var(--btn-ls);text-transform:var(--btn-tt);cursor:pointer;white-space:nowrap}',
'.b svg{width:14px;height:14px;flex:none}',
'.b.dg{color:var(--red)}',
'.b.pri{border-color:var(--ac);color:var(--acl)}',
'.b.solid{background:var(--ac);border-color:var(--ac);color:var(--onac)}',
'.b.solid.dg{background:var(--red);border-color:var(--red);color:#1a1a1d}',
'.b:disabled{opacity:.45;cursor:default}',
'.b.link{border:0;background:none;padding:0 2px;min-height:0;color:var(--acl);text-decoration:underline;text-underline-offset:2px}',
'.acts .b.rm{margin-left:auto}',
'.inl{padding:12px 14px 14px;border-top:1px solid var(--bd);background:var(--s1);display:flex;flex-direction:column;gap:12px}',
'.inl p{margin:0;font:400 13px/1.5 var(--f);color:var(--txd)}',
'.inl p b{color:var(--tx);font-weight:600}',
'.inl .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
'label.fl{display:flex;flex-direction:column;gap:6px;font:700 9.5px/1 var(--f);letter-spacing:1px;text-transform:uppercase;color:var(--txm)}',
'input{width:100%;background:var(--bg);border:1px solid var(--bdl);border-radius:var(--rb);color:var(--tx);font:600 14.5px var(--f);padding:11px 13px;outline:none}',
'input:focus{border-color:var(--ac);box-shadow:0 0 0 3px var(--ring)}',
'.kinds{display:flex;gap:6px;flex-wrap:wrap}',
'.kinds button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:6px 11px;border-radius:var(--rb);border:1px solid var(--bd);background:var(--bg);color:var(--txd);font:500 12.5px/1 var(--f);cursor:pointer}',
'.kinds button svg{width:16px;height:16px}',
'.kinds button[aria-pressed=true]{border-color:var(--ac);color:var(--acl);background:var(--acs)}',
'.err{font:600 12px/1.4 var(--f);color:var(--red)}',
'.empty{padding:26px 16px;text-align:center;border:1px dashed var(--bdl);border-radius:var(--r);font:400 13px/1.55 var(--f);color:var(--txm)}',
'.empty b{display:block;margin-bottom:4px;font:600 14px var(--f);color:var(--txd)}',
'.state{padding:44px 16px;text-align:center;font:500 13px/1.55 var(--f);color:var(--txm);display:flex;flex-direction:column;align-items:center;gap:12px}',
'.ft{padding:12px 22px 16px;border-top:1px solid var(--bd);font:400 12px/1.5 var(--f);color:var(--txm)}',
'.toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:10px 14px;border-radius:var(--rb);background:var(--s3);border:1px solid var(--bdl);color:var(--tx);font:500 13px/1.4 var(--f);box-shadow:0 10px 30px rgba(0,0,0,.4);pointer-events:none}',
'.toast.bad{border-color:var(--red)}',
'button:focus-visible,input:focus-visible{outline:2px solid var(--ac);outline-offset:1px}',
'@media (hover:hover) and (pointer:fine){.ib:hover{color:var(--tx);background:var(--s2);border-color:var(--bd)}.seg button:hover:not([aria-pressed=true]){color:var(--tx)}.b:hover:not(:disabled){background:var(--s3);border-color:var(--ac);color:var(--tx)}.b.dg:hover:not(:disabled){border-color:var(--red);color:var(--red)}.b.solid:hover:not(:disabled){filter:brightness(1.06);color:var(--onac)}.b.solid.dg:hover:not(:disabled){color:#1a1a1d}.b.link:hover{background:none}button.pill:hover{border-color:var(--bdl);color:var(--tx)}.kinds button:hover{border-color:var(--bdl)}}',
'.b:active:not(:disabled){transform:translateY(1px)}',
/* Tablet: a little more room for the action row. */
'@media (max-width:820px){.sheet{width:100%}}',
/* Phone: a bottom sheet, edge to edge, big targets. */
'@media (max-width:600px){',
'  .ov{align-items:flex-end;padding:0;padding-top:max(24px,env(safe-area-inset-top))}',
'  .sheet{width:100%;max-height:calc(100dvh - max(24px,env(safe-area-inset-top)));border-radius:16px 16px 0 0;border-bottom:0}',
'  .hd{padding:18px 16px 12px}.bar{padding:0 16px 12px}.body{padding:4px 16px 16px}',
'  .ft{padding:12px 16px max(16px,env(safe-area-inset-bottom))}',
'  .ib{width:44px;height:44px;margin:-4px -6px 0 0}',
'  .seg{flex:1}.seg button{flex:1;padding:11px 8px;font-size:13px}',
'  .count{display:none}',
'  .dh{padding:13px 12px 11px}.ap{padding:10px 12px}',
'  .an{min-width:0;width:100%}',
'  .acts{display:grid;grid-template-columns:repeat(3,1fr);padding:10px 12px 12px}',
'  .acts .b{min-height:44px;font-size:max(var(--btn-fs),11px)}',
'  .acts .b.rm{margin-left:0}',
'  .inl{padding:12px}.inl .row .b{flex:1;min-height:44px}',
'  input{min-height:48px;font-size:16px}',
'  .kinds button{min-height:42px;flex:1;justify-content:center}',
'  .flag{margin:0 12px 12px}',
'}',
'@media (pointer:coarse){button.pill{min-height:34px}.b.link{min-height:34px}}'
].join('\n');

/* ── Model: what to show for a device and an app on it ──────────────────── */
function devName(d) { return d.name || B.defaultName(d.meta || {}); }
function devKind(d) { return d.kindSet || (d.meta && d.meta.kind) || 'computer'; }
function devSub(d) {
  var m = d.meta || {}, bits = [];
  if (m.hint && m.hint !== devName(d)) bits.push(m.hint);
  else if (m.model && m.model !== devName(d)) bits.push(m.model);
  if (m.os) bits.push(m.os + (m.osVer ? ' ' + m.osVer : ''));
  if (m.browser) bits.push(m.browser);
  if (m.app) bits.push(m.os === 'iOS' || m.os === 'iPadOS' ? 'Home Screen app' : 'Installed app');
  return bits.join(' · ') || 'Unknown device';
}
function pushView(p, tok) {
  if (p) {
    if (p.perm === 'unsupported') return { cls: '', icon: I.bellOff, text: 'No notifications here', title: 'This browser cannot show notifications.' };
    if (p.perm === 'denied') return { cls: 'bad', icon: I.bellOff, text: 'Notifications blocked', title: 'Blocked in the browser’s site settings on that device.' };
    if (p.perm !== 'granted') return { cls: '', icon: I.bellOff, text: 'Notifications not allowed', title: 'The browser has not been given permission yet.' };
    if (p.route === 'none') return { cls: '', icon: I.bellOff, text: 'Notifications off', title: 'A neutral device: TaskHub’s main is set to none, so nothing is sent to it.' };
    if (!p.on && !(tok && tok.on)) return { cls: '', icon: I.bellOff, text: 'Not registered for push', title: 'Allowed, but this browser has no push token yet. Opening the program there usually fixes it.' };
    return { cls: 'ok', icon: I.bell, text: 'Notifications on', title: 'Allowed, with a push token.' };
  }
  if (tok) {
    if (!tok.on) return { cls: '', icon: I.bellOff, text: 'Not registered for push', title: '' };
    if (tok.route === 'none') return { cls: '', icon: I.bellOff, text: 'Notifications off', title: 'A neutral device: nothing is sent to it.' };
    return { cls: 'ok', icon: I.bell, text: 'Notifications on', title: 'Has a push token. Last refreshed ' + fullTime(tok.updated) + '.' };
  }
  return null;
}
function locksView(locks, profile) {
  var mine = (locks || []).filter(function (l) { return l.owner === profile; });
  if (!mine.length) return { cls: '', icon: I.unlock, text: 'No lock', list: [] };
  var shut = mine.filter(function (l) { return !l.open; }).length;
  if (shut === mine.length) return { cls: 'ac', icon: I.lock, text: 'Locked' + (mine.length > 1 ? ' · ' + mine.length : ''), list: mine };
  if (shut) return { cls: 'ac', icon: I.lock, text: shut + ' of ' + mine.length + ' locked', list: mine };
  return { cls: '', icon: I.unlock, text: 'Unlocked' + (mine.length > 1 ? ' · ' + mine.length : ''), list: mine };
}
// The rows a device card shows: one per program (scope 'all') or the open
// program only, plus a push token no program row already accounts for.
function rowsFor(d, ctx) {
  var rows = [], apps = d.apps || {}, used = {};
  var tokOf = function (app) {
    return (d.tokens || []).filter(function (t) { return t.coll === FCM ? (app === 'taskhub' || app === 'mylist') : t.app === app; })[0] || null;
  };
  Object.keys(apps).sort(function (a, b) { return (apps[b].seen || 0) - (apps[a].seen || 0); }).forEach(function (a) {
    if (ctx.scope !== 'all' && a !== ctx.app) return;
    var e = apps[a] || {}, tok = tokOf(a);
    if (tok) used[tok.coll + '/' + tok.id] = 1;
    if (e.push && e.push.coll && e.push.id) used[e.push.coll + '/' + e.push.id] = 1;
    rows.push({ key: a, label: e.label || B.appName(a), push: e.push ? pushView(e.push, tok) : null, locks: locksView(e.locks, ctx.profile), seen: e.seen || 0 });
  });
  (d.tokens || []).forEach(function (t) {
    if (used[t.coll + '/' + t.id]) return;
    if (ctx.scope !== 'all') {
      var fits = t.coll === FCM ? (ctx.fcm || ctx.app === 'taskhub' || ctx.app === 'mylist') : t.app === ctx.app;
      if (!fits) return;
    }
    rows.push({ key: 'tok:' + t.coll + t.id, label: t.label || 'Notifications', push: pushView(null, t), locks: null, seen: t.updated });
  });
  return rows;
}
function visible(d, ctx) { return ctx.scope === 'all' || rowsFor(d, ctx).length > 0; }
function canLock(d, profile) {
  if (d.legacy && !/^dev_|^fp_/.test(d.id)) return false;
  if (d.legacy) return true;
  var apps = d.apps || {};
  return Object.keys(apps).some(function (a) { return (apps[a].locks || []).some(function (l) { return l.owner === profile; }); });
}

/* ── The panel ──────────────────────────────────────────────────────────── */
var P = null;    // the open panel's state
function ensureFonts() {
  try {
    if (document.querySelector('link[data-guardian-fonts],link[data-beacon-fonts]')) return;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONT_HREF; l.setAttribute('data-beacon-fonts', '');
    (document.head || document.documentElement).appendChild(l);
  } catch (e) {}
}
function open(ctx) {
  if (P) close();
  ensureFonts();
  var host = document.createElement('beacon-panel');
  host.setAttribute('data-beacon', '');
  host.setAttribute('data-a1-popup', 'off');
  var root = host.attachShadow({ mode: 'open' });
  var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
  var ov = document.createElement('div');
  ov.className = 'ov'; ov.setAttribute('data-theme', ctx.profile === 'veda' ? 'veda' : 'tony');
  ov.innerHTML =
    '<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="bt" tabindex="-1">' +
      '<header class="hd"><div class="hic">' + I.beacon + '</div>' +
        '<div class="ht"><div class="kick">Beacon</div><h2 id="bt">Devices</h2>' +
        '<div class="sub">' + esc(NAMES[ctx.profile]) + '’s devices and neutral ones. The other person’s never show here.</div></div>' +
        '<button class="ib" data-x title="Close" aria-label="Close">' + I.close + '</button></header>' +
      '<div class="bar"><div class="seg" role="group" aria-label="Show">' +
        (ctx.app ? '<button data-scope="app" aria-pressed="true">' + esc(ctx.appLabel) + '</button>' : '') +
        '<button data-scope="all" aria-pressed="' + (ctx.app ? 'false' : 'true') + '">All programs</button></div>' +
        '<span class="sp"></span><span class="count" data-count></span>' +
        '<button class="ib" data-refresh title="Refresh" aria-label="Refresh">' + I.refresh + '</button></div>' +
      '<div class="body" data-body><div class="state">Finding your devices…</div></div>' +
      '<footer class="ft">Remove stops a device’s notifications at once and locks every program on it the next time it opens. Opening A1 there again adds it back, behind its password.</footer>' +
    '</section>';
  root.appendChild(ov);
  document.documentElement.appendChild(host);
  P = { ctx: Object.assign({ scope: ctx.app ? 'app' : 'all' }, ctx), host: host, root: root, ov: ov, data: null, form: null, openLocks: {},
    prevFocus: document.activeElement, prevOverflow: document.documentElement.style.overflow, dirty: false, unwatch: null };
  document.documentElement.style.overflow = 'hidden';
  wire(P);
  ov.querySelector('.sheet').focus({ preventScroll: true });
  load();
  P.unwatch = B.watch(ctx.profile, function () { reloadSoon(); });
  return Promise.resolve(true);
}
function close() {
  if (!P) return;
  var p = P; P = null;
  try { p.unwatch && p.unwatch(); } catch (e) {}
  document.removeEventListener('keydown', p.onKey, true);
  p.host.remove();
  document.documentElement.style.overflow = p.prevOverflow || '';
  try { if (p.prevFocus && p.prevFocus.focus) p.prevFocus.focus({ preventScroll: true }); } catch (e) {}
}
function wire(p) {
  var ov = p.ov, down = null;
  // Closes on a click that starts AND ends on the backdrop (popups.js' rule):
  // a drag out of a text field never closes it.
  ov.addEventListener('pointerdown', function (e) { down = e.target === ov; });
  ov.addEventListener('click', function (e) { if (e.target === ov && down) close(); down = null; });
  p.onKey = function (e) {
    if (P !== p || e.key !== 'Escape') return;
    e.stopPropagation(); e.preventDefault();
    if (p.form) { p.form = null; render(); } else close();
  };
  document.addEventListener('keydown', p.onKey, true);
  ov.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !ov.contains(t)) return;
    if (t.hasAttribute('data-x')) return close();
    if (t.hasAttribute('data-refresh')) return load();
    var sc = t.getAttribute('data-scope');
    if (sc) { p.ctx.scope = sc; p.form = null; render(); return; }
    var card = t.closest('[data-dev]'), dev = card ? find(card.getAttribute('data-dev')) : null;
    if (t.hasAttribute('data-locks')) {
      var k = t.getAttribute('data-locks'); p.openLocks[k] = !p.openLocks[k]; render(); return;
    }
    if (!dev) return;
    var act = t.getAttribute('data-act');
    if (act === 'rename') { p.form = { id: dev.id, type: 'rename', kind: devKind(dev) }; render(); focusIn('input'); return; }
    if (act === 'lock') { p.form = { id: dev.id, type: 'lock' }; render(); focusIn('[data-ok]'); return; }
    if (act === 'remove') { p.form = { id: dev.id, type: 'remove' }; render(); focusIn('[data-cancel]'); return; }
    if (act === 'uncmd') { run(dev, function () { return B.cancel(dev.owner, dev.id); }, 'Lock cancelled.'); return; }
    if (t.hasAttribute('data-cancel')) { p.form = null; render(); return; }
    if (t.hasAttribute('data-kind')) {
      p.form.kind = t.getAttribute('data-kind');
      p.root.querySelectorAll('[data-kind]').forEach(function (b) { b.setAttribute('aria-pressed', b === t ? 'true' : 'false'); });
      return;
    }
    if (t.hasAttribute('data-ok')) return submit(dev);
  });
  ov.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && p.form && p.form.type === 'rename') {
      e.preventDefault(); var dev = find(p.form.id); if (dev) submit(dev);
    }
  });
}
function focusIn(sel) { setTimeout(function () { var el = P && P.root.querySelector('.inl ' + sel); if (el) { el.focus(); if (el.select) el.select(); } }, 0); }
function find(id) { return P && P.data ? P.data.devices.filter(function (d) { return d.id === id; })[0] || null : null; }
function toast(msg, bad) {
  if (!P) return;
  var old = P.root.querySelector('.toast'); if (old) old.remove();
  var t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
  P.root.querySelector('.sheet').appendChild(t);
  setTimeout(function () { t.remove(); }, 3200);
}
function run(dev, fn, done) {
  var p = P;
  return Promise.resolve().then(fn).then(function (r) {
    if (P !== p) return r;
    p.form = null; toast(typeof done === 'function' ? done(r) : done); load(true);
    return r;
  }, function (e) {
    if (P !== p) return;
    toast('That didn’t go through. Check the connection and try again.', true);
    var b = p.root.querySelector('.inl [data-ok]'); if (b) b.disabled = false;
  });
}
function submit(dev) {
  var f = P.form; if (!f) return;
  var ok = P.root.querySelector('.inl [data-ok]'); if (ok) ok.disabled = true;
  if (f.type === 'rename') {
    var inp = P.root.querySelector('.inl input'), name = inp ? inp.value.trim() : '';
    var kindChanged = f.kind !== devKind(dev);
    return run(dev, function () {
      var jobs = [B.rename(dev.owner, dev.id, name)];
      if (kindChanged) jobs.push(B.setKind(dev.owner, dev.id, f.kind));
      return Promise.all(jobs);
    }, 'Saved.');
  }
  if (f.type === 'lock') {
    return run(dev, function () { return B.lock(dev.owner, dev.id, P.ctx.profile); },
      function (r) { return r && r.now ? 'This device is locked.' : 'It locks the next time it opens an A1 program.'; });
  }
  if (f.type === 'remove') {
    var self = dev.id === P.data.self;
    return run(dev, function () { return B.remove(dev); }, self ? 'This device was removed and locked.' : devName(dev) + ' was removed.');
  }
}
var reloadT = 0;
function reloadSoon() { clearTimeout(reloadT); reloadT = setTimeout(function () { load(true); }, 600); }
function load(quiet) {
  var p = P; if (!p) return;
  if (!quiet || !p.data) p.root.querySelector('[data-body]').innerHTML = '<div class="state">Finding your devices…</div>';
  B.list(p.ctx.profile, { pushLists: p.ctx.pushLists }).then(function (data) {
    if (P !== p) return;
    p.data = data;
    if (p.form && !find(p.form.id)) p.form = null;
    // Never redraw under someone typing a name: catch up when the form closes.
    if (p.form && p.form.type === 'rename' && quiet) { p.dirty = true; return; }
    render();
  }, function () {
    if (P !== p) return;
    if (p.data && quiet) return;
    p.root.querySelector('[data-body]').innerHTML = '<div class="state">Couldn’t reach your devices. Check the connection and try again.' +
      '<button class="b pri" data-refresh>' + I.refresh + 'Try again</button></div>';
  });
}

function render() {
  var p = P; if (!p || !p.data) return;
  p.dirty = false;
  var ctx = p.ctx, data = p.data;
  var devs = data.devices.filter(function (d) { return visible(d, ctx); });
  // This device first, then the most recently active.
  devs.sort(function (a, b) { return (b.id === data.self) - (a.id === data.self) || (b.seen || 0) - (a.seen || 0); });
  var mine = devs.filter(function (d) { return d.owner === ctx.profile; });
  var neutral = devs.filter(function (d) { return d.owner === 'neutral'; });
  p.root.querySelector('[data-count]').textContent = devs.length + (devs.length === 1 ? ' device' : ' devices');
  var where = ctx.scope === 'all' ? 'an A1 program' : ctx.appLabel;
  var h = '<div class="sec"><div class="sh"><span class="st">Your devices</span></div>';
  h += mine.length ? '<div class="list">' + mine.map(card).join('') + '</div>'
    : '<div class="empty"><b>No devices yet</b>A device shows up here once it opens ' + esc(where) + ' as ' + esc(NAMES[ctx.profile]) + '.</div>';
  h += '</div>';
  if (neutral.length) {
    h += '<div class="sec"><div class="sh"><span class="st">Neutral devices</span><span class="sn">Neither person’s: TaskHub’s main is set to none. Both of you see these.</span></div>' +
      '<div class="list">' + neutral.map(card).join('') + '</div></div>';
  }
  var body = p.root.querySelector('[data-body]'), top = body.scrollTop;
  body.innerHTML = h;
  body.scrollTop = top;
  p.root.querySelectorAll('[data-scope]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-scope') === ctx.scope ? 'true' : 'false'); });
}
function card(d) {
  var p = P, ctx = p.ctx, me = d.id === p.data.self;
  var active = d.seen && Date.now() - d.seen < ACTIVE_MS;
  var stale = d.seen && Date.now() - d.seen > STALE_MS;
  var h = '<article class="dev' + (me ? ' me' : '') + '" data-dev="' + esc(d.id) + '">';
  h += '<div class="dh"><div class="dic">' + kindIcon(devKind(d)) + (active ? '<i class="live" title="Active now"></i>' : '') + '</div>';
  h += '<div class="dt"><div class="dn"><span>' + esc(devName(d)) + '</span>' +
    (me ? '<span class="tag me">This device</span>' : '') +
    (stale ? '<span class="tag old">Inactive</span>' : '') + '</div>';
  h += '<div class="dm">' + esc(devSub(d)) + '</div></div></div>';
  var rows = rowsFor(d, ctx);
  if (rows.length) {
    h += '<div class="apps">' + rows.map(function (r) {
      var lk = r.locks, key = d.id + '|' + r.key, openL = !!p.openLocks[key];
      var x = '<div class="ap"><div class="ar"><span class="an">' + esc(r.label) + '</span><span class="pills">';
      if (r.push) x += '<span class="pill ' + r.push.cls + '" title="' + esc(r.push.title) + '">' + r.push.icon + esc(r.push.text) + '</span>';
      if (lk) {
        if (lk.list.length) x += '<button class="pill ' + lk.cls + '" data-locks="' + esc(key) + '" aria-expanded="' + openL + '" title="Each lock on this device">' + lk.icon + esc(lk.text) + '<span class="cv">' + I.chev + '</span></button>';
        else x += '<span class="pill">' + lk.icon + 'No lock</span>';
      }
      x += '<span class="when" title="' + esc(fullTime(r.seen)) + '">' + esc(ago(r.seen)) + '</span></span></div>';
      if (lk && lk.list.length && openL) {
        x += '<div class="locks">' + lk.list.map(function (l) {
          return '<div class="lk">' + (l.open ? I.unlock : I.lock) + '<span class="ln">' + esc(l.label) + '</span>' +
            (l.bio ? '<span class="lb" title="' + esc(bioName((d.meta || {}).os)) + ' is set up">' + I.bio + '</span>' : '') +
            '<span class="' + (l.open ? 'lo' : 'lc') + '">' + (l.open ? 'Unlocked' : 'Locked') + '</span></div>';
        }).join('') + '</div>';
      }
      return x + '</div>';
    }).join('') + '</div>';
  } else if (ctx.scope === 'all') {
    h += '<div class="apps"><div class="ap"><span class="sn">No program has checked in from here yet.</span></div></div>';
  }
  if (d.cmd && d.cmd.lock) {
    h += '<div class="flag">' + I.lock + '<span>Lock sent ' + esc(ago(d.cmd.lock)) + '. It applies the next time this device opens an A1 program.</span>' +
      '<button class="b link fx" data-act="uncmd">Cancel</button></div>';
  }
  var f = p.form && p.form.id === d.id ? p.form : null;
  var renameable = !(d.legacy && !/^dev_|^fp_/.test(d.id));
  var lockable = canLock(d, ctx.profile);
  if (!f) {
    h += '<div class="acts">' +
      '<button class="b" data-act="rename"' + (renameable ? '' : ' disabled title="Known only by its push token"') + '>' + I.pencil + 'Rename</button>' +
      '<button class="b" data-act="lock"' + (lockable ? '' : ' disabled title="No program on this device has a lock"') + '>' + I.lock + 'Lock</button>' +
      '<button class="b dg rm" data-act="remove">' + I.trash + 'Remove</button></div>';
  } else h += form(d, f, me);
  return h + '</article>';
}
function form(d, f, me) {
  var n = esc(devName(d));
  if (f.type === 'rename') {
    return '<div class="inl"><label class="fl">Name<input type="text" maxlength="60" value="' + esc(d.name || '') + '" placeholder="' + n + '" autocomplete="off" spellcheck="false"></label>' +
      '<div class="fl" style="display:flex;flex-direction:column;gap:6px;font:700 9.5px/1 var(--f);letter-spacing:1px;text-transform:uppercase;color:var(--txm)">Type<div class="kinds">' +
      KINDS.map(function (k) { return '<button type="button" data-kind="' + k[0] + '" aria-pressed="' + ((f.kind === k[0] || (f.kind === 'computer' && k[0] === 'desktop')) ? 'true' : 'false') + '">' + I[k[0]] + k[1] + '</button>'; }).join('') +
      '</div></div><div class="row"><button class="b" data-cancel>Cancel</button><button class="b solid" data-ok>Save</button></div></div>';
  }
  if (f.type === 'lock') {
    return '<div class="inl"><p>' + (me
      ? 'Lock every A1 program on <b>this device</b> now? Each one asks for its password again.'
      : 'Lock every A1 program on <b>' + n + '</b>? It locks the next time it opens an A1 program, then each one asks for its password.') + '</p>' +
      '<div class="row"><button class="b" data-cancel>Cancel</button><button class="b solid" data-ok>' + I.lock + 'Lock</button></div></div>';
  }
  return '<div class="inl"><p>' + (me
    ? 'Remove <b>this device</b>? Its notifications stop and every program here locks right away.'
    : 'Remove <b>' + n + '</b>? Its notifications stop now, and every program on it locks the next time it opens.') +
    ' Opening A1 there again adds it back.</p>' +
    '<div class="row"><button class="b" data-cancel>Cancel</button><button class="b solid dg" data-ok>' + I.trash + 'Remove</button></div></div>';
}

window.BeaconUI = { open: open, close: close, isOpen: function () { return !!P; }, _rowsFor: rowsFor, _pushView: pushView, _locksView: locksView };
})();
