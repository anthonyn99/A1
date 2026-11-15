/* ═══════════════════════════════════════════════════════════════════════════
   Beacon's panel. Loaded by Beacon/beacon.js the first time Beacon.open() runs;
   never loaded by a program directly. Contract: docs/Beacon/README.md

   A shadow root, so no program's CSS reaches in and none of this leaks out.
   Tony's side wears Guardian's MAGI tokens and Veda's side her TaskHub
   palette, the same two themes as the lock card. No fades: it opens, expands
   and closes instantly.

   The layout (rebuilt 2026-11-15 for Tony: "way more elegant"): one quiet
   surface per section, a row per device with its state as small glyphs; a
   tap opens the row into its programs, locks and actions. Devices not seen
   for 60 days fold into Inactive, which can be cleared in one go.

   Its own scroll thumb: native scrollbars are hidden everywhere in A1
   (Shared/scrollbar.js), which cannot reach into a shadow root, and the
   browser's own bar in here would not drag in Brave. This one is A1's thin
   overlay thumb, dragged with pointer capture (mouse, pen or finger).
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
// A device whose clock runs ahead writes a time in the future: that reads as now.
function ago(t) {
  if (!t) return 'never';
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 30 * 86400) return Math.floor(s / 86400) + 'd ago';
  try { return new Date(+t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(+t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }); } catch (e) { return ''; }
}

var SV = function (p, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 1.7) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };
var I = {
  phone: SV('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  tablet: SV('<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  laptop: SV('<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/>'),
  desktop: SV('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>'),
  unknown: SV('<rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/><path d="M10.2 8.4a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1M12 13.2h0"/>'),
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
  chev: SV('<path d="m9 6 6 6-6 6"/>', 2),
  down: SV('<path d="m6 9 6 6 6-6"/>', 2)
};
var KINDS = [['phone', 'Phone'], ['tablet', 'Tablet'], ['laptop', 'Laptop'], ['desktop', 'Desktop']];
function bioName(os) { return os === 'iOS' || os === 'iPadOS' ? 'Face ID / Touch ID' : os === 'macOS' ? 'Touch ID' : os === 'Windows' ? 'Windows Hello' : os === 'Android' ? 'Fingerprint' : 'Biometrics'; }

var CSS = [
':host{all:initial}',
':host,*,*::before,*::after{-webkit-tap-highlight-color:transparent}',
'*{box-sizing:border-box}',
'button{font:inherit;color:inherit;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;margin:0}',
'[hidden]{display:none!important}',
'.ov{position:fixed;inset:0;z-index:2147482500;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));background:rgba(0,0,0,.6);-webkit-backdrop-filter:blur(7px) saturate(.9);backdrop-filter:blur(7px) saturate(.9);font-family:var(--f);color:var(--tx);-webkit-font-smoothing:antialiased;overscroll-behavior:contain}',
/* Tony: Guardian's MAGI tokens. Veda: her TaskHub palette (Guardian's veda theme). */
'.ov[data-theme=tony]{--bg:#1a1a1d;--s1:#1f1f23;--s2:#26262b;--s3:#2f2f35;--hov:rgba(255,255,255,.035);--bd:rgba(255,255,255,.065);--bdl:rgba(255,255,255,.12);--tx:#f4f3f0;--txd:#b4b4b9;--txm:#86868d;--ac:#c0aeea;--acl:#dbd0f5;--acs:rgba(192,174,234,.12);--onac:#1a1a1d;--red:#e0968a;--reds:rgba(224,150,138,.12);--ok:#a6d4ae;--oks:rgba(166,212,174,.12);--ring:rgba(192,174,234,.2);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Manrope","Inter",system-ui,sans-serif;--title-w:800;--title-ls:-.4px}',
'.ov[data-theme=veda]{--bg:#1B1C1E;--s1:#222326;--s2:#28292D;--s3:#313237;--hov:rgba(255,255,255,.035);--bd:rgba(255,255,255,.07);--bdl:rgba(255,255,255,.13);--tx:#ECECEE;--txd:#B4B5BA;--txm:#8a8b91;--ac:#A892B0;--acl:#CDBAD4;--acs:rgba(168,146,176,.15);--onac:#ffffff;--red:#E58A80;--reds:rgba(229,138,128,.12);--ok:#a3cfab;--oks:rgba(163,207,171,.12);--ring:rgba(168,146,176,.28);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Lora",Georgia,serif;--title-w:700;--title-ls:-.2px}',
'.sheet{position:relative;width:640px;max-width:100%;max-height:min(86vh,900px);display:flex;flex-direction:column;background:var(--s1);border:1px solid var(--bd);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.25);outline:none;overflow:hidden}',
/* Header */
'.hd{display:flex;align-items:flex-start;gap:14px;padding:24px 24px 0}',
'.hic{flex:none;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--ac);background:var(--acs)}',
'.hic svg{width:20px;height:20px}',
'.ht{flex:1;min-width:0}',
'h2{margin:1px 0 0;font-family:var(--fd);font-size:22px;font-weight:var(--title-w);letter-spacing:var(--title-ls);line-height:1.15;color:var(--tx)}',
'.sum{margin-top:5px;font:400 13px/1.45 var(--f);color:var(--txm);font-variant-numeric:tabular-nums}',
'.sum b{font-weight:600;color:var(--txd)}',
'.sum .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin:0 5px 1px 0;vertical-align:middle}',
'.hbtns{display:flex;gap:2px;margin:-4px -8px 0 0}',
'.ib{flex:none;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:0;background:none;color:var(--txm);cursor:pointer;padding:0}',
'.ib svg{width:18px;height:18px}',
'.bar{display:flex;align-items:center;gap:12px;padding:18px 24px 14px}',
'.seg{display:inline-flex;padding:3px;background:var(--bg);border-radius:11px;box-shadow:inset 0 0 0 1px var(--bd)}',
'.seg button{border:0;background:none;color:var(--txm);font:600 13px/1 var(--f);padding:8px 14px;border-radius:8px;cursor:pointer;white-space:nowrap}',
'.seg button[aria-pressed=true]{background:var(--s3);color:var(--tx);box-shadow:0 1px 2px rgba(0,0,0,.3)}',
'.note{flex:1;min-width:0;text-align:right;font:400 12px/1.4 var(--f);color:var(--txm)}',
/* Body + its own scroll thumb */
'.wrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid var(--bd)}',
'.body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:4px 24px 22px;scrollbar-width:none}',
'.body::-webkit-scrollbar{display:none;width:0;height:0}',
'.rail{position:absolute;top:6px;bottom:6px;right:3px;width:12px;touch-action:none;cursor:default}',
'.thumb{position:absolute;left:3px;right:3px;top:0;border-radius:99px;background:rgba(173,173,178,.32);touch-action:none;cursor:grab}',
'.rail:hover .thumb,.rail.drag .thumb{background:rgba(173,173,178,.6);left:2px;right:2px}',
'.rail.drag .thumb{cursor:grabbing}',
/* Sections */
'.sec{padding-top:20px}',
'.sh{display:flex;align-items:center;gap:10px;margin:0 4px 9px;min-height:22px}',
'.st{white-space:nowrap;font:700 10.5px/1 var(--f);letter-spacing:1.3px;text-transform:uppercase;color:var(--txm)}',
'.sn{font:400 12px/1.4 var(--f);color:var(--txm)}',
'.sh .sp{flex:1}',
'.lnk{border:0;background:none;padding:4px 2px;font:600 12px/1 var(--f);color:var(--acl);cursor:pointer;white-space:nowrap}',
'.lnk.dg{color:var(--red)}',
'.card{background:var(--s2);border-radius:14px;box-shadow:inset 0 0 0 1px var(--bd);overflow:hidden}',
'.dev+.dev{border-top:1px solid var(--bd)}',
/* A device row */
'.row{display:flex;align-items:center;gap:13px;width:100%;padding:13px 14px 13px 13px;border:0;background:none;text-align:left;cursor:pointer;color:inherit}',
'.dev.open>.row{background:var(--hov)}',
'.dic{position:relative;flex:none;width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--txd);box-shadow:inset 0 0 0 1px var(--bd)}',
'.dev.me .dic{color:var(--ac);background:var(--acs);box-shadow:none}',
'.dev.old .dic{color:var(--txm)}',
'.dic svg{width:21px;height:21px}',
'.live{position:absolute;right:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 2.5px var(--s2)}',
'.dt{display:block;flex:1;min-width:0}',
'.dn{display:flex;align-items:center;gap:8px;font:600 14.5px/1.3 var(--f);color:var(--tx);min-width:0}',
'.dn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.dev.old .dn{color:var(--txd)}',
'.tag{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font:650 10px/1 var(--f);letter-spacing:.2px;color:var(--acl);background:var(--acs)}',
'.tag.n{color:var(--txd);background:var(--s3)}',
'.dm{display:block;margin-top:2px;font:400 12.5px/1.4 var(--f);color:var(--txm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.dm .act{color:var(--ok)}',
'.gl{flex:none;display:flex;align-items:center;gap:4px}',
'.g{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--txm)}',
'.g svg{width:15px;height:15px}',
'.g.ok{color:var(--ok);background:var(--oks)}.g.bad{color:var(--red);background:var(--reds)}.g.ac{color:var(--acl);background:var(--acs)}',
'.cv{flex:none;display:flex;color:var(--txm);margin-left:2px}',
'.cv svg{width:16px;height:16px}',
'.dev.open .cv{transform:rotate(90deg);color:var(--txd)}',
/* Open: details */
'.det{padding:2px 14px 14px 66px}',
'.pg{padding:10px 0;border-top:1px solid var(--bd)}',
'.pg:first-child{border-top:0;padding-top:4px}',
'.ph{display:flex;align-items:baseline;gap:10px}',
'.pn{font:600 13px/1.3 var(--f);color:var(--tx)}',
'.pw{margin-left:auto;font:400 12px var(--f);color:var(--txm);font-variant-numeric:tabular-nums;white-space:nowrap}',
'.facts{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:6px}',
'.f{display:inline-flex;align-items:center;gap:6px;font:500 12.5px/1.3 var(--f);color:var(--txd)}',
'.f svg{width:14px;height:14px;flex:none;color:var(--txm)}',
'.f.ok,.f.ok svg{color:var(--ok)}.f.bad,.f.bad svg{color:var(--red)}.f.ac,.f.ac svg{color:var(--acl)}',
'.lks{margin-top:8px;display:flex;flex-direction:column;gap:1px}',
'.lk{display:flex;align-items:center;gap:8px;min-height:26px;font:400 12.5px/1.3 var(--f);color:var(--txd)}',
'.lk svg{width:13px;height:13px;flex:none;color:var(--txm)}',
'.lk .ln{flex:1;min-width:0}',
'.lk .lb{display:inline-flex;color:var(--txm)}',
'.lk .lo{color:var(--ok);font-weight:500}.lk .lc{color:var(--acl);font-weight:500}',
'.flag{margin:4px 0 2px;padding:9px 12px;border-radius:10px;background:var(--acs);color:var(--acl);font:500 12.5px/1.45 var(--f);display:flex;align-items:center;gap:10px}',
'.flag svg{width:15px;height:15px;flex:none}',
'.flag .lnk{margin-left:auto}',
'.meta{margin-top:10px;font:400 12px/1.5 var(--f);color:var(--txm)}',
'.acts{display:flex;gap:8px;margin-top:12px}',
'.b{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:7px 13px;border-radius:9px;border:0;background:var(--s3);color:var(--txd);font:600 12.5px/1 var(--f);cursor:pointer;white-space:nowrap}',
'.b svg{width:14px;height:14px;flex:none}',
'.b.dg{color:var(--red);background:var(--reds)}',
'.b.solid{background:var(--ac);color:var(--onac)}',
'.b.solid.dg{background:var(--reds);color:var(--red);box-shadow:inset 0 0 0 1px rgba(224,150,138,.45)}',
'.b:disabled{opacity:.4;cursor:default}',
'.acts .b.rm{margin-left:auto}',
'.inl{margin-top:12px;padding:14px;border-radius:12px;background:var(--bg);display:flex;flex-direction:column;gap:12px;box-shadow:inset 0 0 0 1px var(--bd)}',
'.inl p{margin:0;font:400 13px/1.5 var(--f);color:var(--txd)}',
'.inl p b{color:var(--tx);font-weight:600}',
'.inl .r2{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
'.fl{display:flex;flex-direction:column;gap:7px;font:600 11px/1 var(--f);color:var(--txm)}',
'input{width:100%;background:var(--s1);border:1px solid var(--bdl);border-radius:9px;color:var(--tx);font:500 14.5px var(--f);padding:10px 12px;outline:none}',
'input:focus{border-color:var(--ac);box-shadow:0 0 0 3px var(--ring)}',
'.kinds{display:flex;gap:6px;flex-wrap:wrap}',
'.kinds button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:6px 11px;border-radius:9px;border:0;background:var(--s2);color:var(--txd);font:500 12.5px/1 var(--f);cursor:pointer;box-shadow:inset 0 0 0 1px var(--bd)}',
'.kinds button svg{width:16px;height:16px}',
'.kinds button[aria-pressed=true]{color:var(--acl);background:var(--acs);box-shadow:inset 0 0 0 1px var(--ac)}',
/* States */
'.empty{padding:28px 18px;text-align:center;font:400 13px/1.55 var(--f);color:var(--txm)}',
'.empty b{display:block;margin-bottom:3px;font:600 14px var(--f);color:var(--txd)}',
'.state{padding:56px 16px;text-align:center;font:400 13px/1.55 var(--f);color:var(--txm);display:flex;flex-direction:column;align-items:center;gap:14px}',
'.foot{padding:16px 6px 0;font:400 12px/1.55 var(--f);color:var(--txm);text-align:center}',
'.toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:10px 15px;border-radius:11px;background:var(--s3);color:var(--tx);font:500 13px/1.4 var(--f);box-shadow:0 12px 34px rgba(0,0,0,.45),inset 0 0 0 1px var(--bdl);pointer-events:none;z-index:2}',
'.toast.bad{box-shadow:0 12px 34px rgba(0,0,0,.45),inset 0 0 0 1px var(--red)}',
'button:focus-visible,input:focus-visible{outline:2px solid var(--ac);outline-offset:-2px}',
'@media (hover:hover) and (pointer:fine){',
'  .ib:hover{color:var(--tx);background:var(--s2)}',
'  .seg button:hover:not([aria-pressed=true]){color:var(--tx)}',
'  .row:hover{background:var(--hov)}',
'  .b:hover:not(:disabled){background:var(--bdl);color:var(--tx)}',
'  .b.dg:hover:not(:disabled){background:rgba(224,150,138,.2);color:var(--red)}',
'  .b.solid:hover:not(:disabled){filter:brightness(1.07);color:var(--onac)}',
'  .b.solid.dg:hover:not(:disabled){filter:none;background:rgba(224,150,138,.24);color:#f6bdb3}',
'  .lnk:hover{text-decoration:underline;text-underline-offset:3px}',
'  .kinds button:hover{box-shadow:inset 0 0 0 1px var(--bdl)}',
'}',
'.b:active:not(:disabled){transform:translateY(1px)}',
/* Phone: a bottom sheet, edge to edge, 44px targets. */
'@media (max-width:600px){',
'  .ov{align-items:flex-end;padding:0;padding-top:max(24px,env(safe-area-inset-top))}',
'  .sheet{width:100%;max-height:calc(100dvh - max(24px,env(safe-area-inset-top)));border-radius:20px 20px 0 0;border-bottom:0}',
'  .sheet::before{content:"";position:absolute;top:7px;left:50%;width:36px;height:4px;margin-left:-18px;border-radius:4px;background:var(--bdl)}',
'  .hd{padding:24px 16px 0}.bar{padding:16px 16px 12px}.body{padding:2px 16px max(18px,env(safe-area-inset-bottom))}',
'  .ib{width:44px;height:44px}',
'  .seg{flex:1}.seg button{flex:1;padding:11px 8px}',
'  .note{display:none}',
'  .row{padding:12px 12px 12px 11px;gap:12px}',
'  .det{padding:2px 12px 14px 12px}',
'  .acts{display:grid;grid-template-columns:repeat(3,1fr)}',
'  .acts .b{min-height:44px}.acts .b.rm{margin-left:0}',
'  .inl .r2 .b{flex:1;min-height:44px}',
'  input{min-height:46px;font-size:16px}',
'  .kinds button{min-height:42px;flex:1;justify-content:center}',
'  .lnk{padding:10px 4px}',
'  .sh{flex-wrap:wrap;row-gap:4px}.sh .sn{order:3;flex-basis:100%}',
'}',
'@media (pointer:coarse){.g{width:28px;height:28px}}'
].join('\n');

/* ── Model: what to show for a device and an app on it ──────────────────── */
function unknownDev(d) { var m = d.meta || {}; return !m.os && !m.model && !m.browser; }
function devName(d) { return d.name || (unknownDev(d) ? 'Unknown device' : B.defaultName(d.meta || {})); }
function devKind(d) { return d.kindSet || (d.meta && d.meta.kind) || 'computer'; }
function kindIcon(d) { if (!d.kindSet && unknownDev(d)) return I.unknown; var k = devKind(d); return I[k === 'computer' ? 'desktop' : k] || I.desktop; }
function devSub(d) {
  var m = d.meta || {}, bits = [];
  if (unknownDev(d)) return d.legacy ? 'Known only by its notification token' : 'Unknown device';
  if (m.hint && m.hint !== devName(d)) bits.push(m.hint);
  else if (m.model && m.model !== devName(d)) bits.push(m.model);
  if (m.os) bits.push(m.os + (m.osVer ? ' ' + m.osVer : ''));
  if (m.browser) bits.push(m.browser);
  if (m.app) bits.push(m.os === 'iOS' || m.os === 'iPadOS' ? 'Home Screen app' : 'Installed app');
  return bits.join(' · ');
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
  if (!mine.length) return { cls: '', icon: I.unlock, text: 'No lock', list: [], shut: 0 };
  var shut = mine.filter(function (l) { return !l.open; }).length;
  var n = mine.length > 1 ? mine.length + ' locks' : 'Lock';
  if (shut === mine.length) return { cls: 'ac', icon: I.lock, text: 'Locked' + (mine.length > 1 ? ' · ' + mine.length : ''), list: mine, shut: shut, label: n };
  if (shut) return { cls: 'ac', icon: I.lock, text: shut + ' of ' + mine.length + ' locked', list: mine, shut: shut, label: n };
  return { cls: '', icon: I.unlock, text: 'Unlocked' + (mine.length > 1 ? ' · ' + mine.length : ''), list: mine, shut: 0, label: n };
}
// The program rows a device shows: one per program (scope 'all') or the open
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
function isActive(d) { return d.seen && Date.now() - d.seen < ACTIVE_MS; }
function isStale(d) { return !!(d.seen && Date.now() - d.seen > STALE_MS); }
// The row's glyphs: the strongest notification state, then any lock.
function glyphs(rows) {
  var push = null, lock = null;
  rows.forEach(function (r) {
    if (r.push && (!push || r.push.cls === 'ok' || (r.push.cls === 'bad' && push.cls !== 'ok'))) push = r.push;
    if (r.locks && r.locks.list.length && (!lock || r.locks.shut > lock.shut)) lock = r.locks;
  });
  var h = '';
  if (push) h += '<span class="g ' + (push.cls || '') + '" title="' + esc(push.text) + '">' + push.icon + '</span>';
  if (lock) h += '<span class="g ' + (lock.shut ? 'ac' : '') + '" title="' + esc(lock.text) + '">' + lock.icon + '</span>';
  return h;
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
        '<div class="ht"><h2 id="bt">Devices</h2><div class="sum" data-count>' + esc(NAMES[ctx.profile]) + '’s devices</div></div>' +
        '<div class="hbtns"><button class="ib" data-refresh title="Refresh" aria-label="Refresh">' + I.refresh + '</button>' +
        '<button class="ib" data-x title="Close" aria-label="Close">' + I.close + '</button></div></header>' +
      '<div class="bar"><div class="seg" role="group" aria-label="Show">' +
        (ctx.app ? '<button data-scope="app" aria-pressed="true">' + esc(ctx.appLabel) + '</button>' : '') +
        '<button data-scope="all" aria-pressed="' + (ctx.app ? 'false' : 'true') + '">All programs</button></div>' +
        '<span class="note">' + esc(NAMES[ctx.profile]) + '’s and neutral devices only</span></div>' +
      '<div class="wrap"><div class="body" data-body><div class="state">Finding your devices…</div></div>' +
        '<div class="rail" data-rail hidden><div class="thumb"></div></div></div>' +
    '</section>';
  root.appendChild(ov);
  document.documentElement.appendChild(host);
  P = { ctx: Object.assign({ scope: ctx.app ? 'app' : 'all' }, ctx), host: host, root: root, ov: ov, data: null, form: null, open: {}, showOld: false,
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
  try { p.ro && p.ro.disconnect(); } catch (e) {}
  document.removeEventListener('keydown', p.onKey, true);
  window.removeEventListener('resize', p.onResize);
  p.host.remove();
  document.documentElement.style.overflow = p.prevOverflow || '';
  try { if (p.prevFocus && p.prevFocus.focus) p.prevFocus.focus({ preventScroll: true }); } catch (e) {}
}

/* ── The scroll thumb ───────────────────────────────────────────────────── */
function thumbSync(p) {
  var body = p.root.querySelector('[data-body]'), rail = p.root.querySelector('[data-rail]');
  if (!body || !rail) return;
  var sh = body.scrollHeight, ch = body.clientHeight;
  if (sh <= ch + 1) { rail.hidden = true; return; }
  rail.hidden = false;
  var track = rail.clientHeight, h = Math.max(32, Math.round(track * ch / sh));
  var top = Math.round((track - h) * body.scrollTop / (sh - ch));
  var th = rail.firstChild;
  th.style.height = h + 'px';
  th.style.transform = 'translateY(' + top + 'px)';
}
function wireThumb(p) {
  var body = p.root.querySelector('[data-body]'), rail = p.root.querySelector('[data-rail]'), th = rail.firstChild;
  body.addEventListener('scroll', function () { thumbSync(p); }, { passive: true });
  p.onResize = function () { thumbSync(p); };
  window.addEventListener('resize', p.onResize);
  if (window.ResizeObserver) { p.ro = new ResizeObserver(function () { thumbSync(p); }); p.ro.observe(body); }
  var drag = null;
  rail.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    var sh = body.scrollHeight, ch = body.clientHeight, track = rail.clientHeight, h = th.offsetHeight;
    var ratio = (sh - ch) / Math.max(1, track - h);
    if (e.target !== th) {
      // A press on the track pages toward it, then keeps dragging from there.
      var tr = th.getBoundingClientRect();
      body.scrollTop += (e.clientY < tr.top ? -1 : 1) * ch * 0.9;
    }
    drag = { y: e.clientY, top: body.scrollTop, ratio: ratio, id: e.pointerId };
    rail.classList.add('drag');
    try { rail.setPointerCapture(e.pointerId); } catch (x) {}
  });
  rail.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    body.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio;
  });
  var end = function (e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null; rail.classList.remove('drag');
  };
  rail.addEventListener('pointerup', end); rail.addEventListener('pointercancel', end);
  rail.addEventListener('lostpointercapture', end);
}

function wire(p) {
  var ov = p.ov, down = null;
  // Closes on a click that starts AND ends on the backdrop (popups.js' rule):
  // a drag out of a text field never closes it.
  ov.addEventListener('pointerdown', function (e) { down = e.target === ov; });
  ov.addEventListener('click', function (e) { if (e.target === ov && down) close(); down = null; });
  p.onKey = function (e) {
    if (P !== p || e.key !== 'Escape') return;
    if (window.Guardian && window.Guardian.isOpen && window.Guardian.isOpen()) return;
    e.stopPropagation(); e.preventDefault();
    if (p.form) { p.form = null; render(); } else close();
  };
  document.addEventListener('keydown', p.onKey, true);
  wireThumb(p);
  ov.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !ov.contains(t)) return;
    if (t.hasAttribute('data-x')) return close();
    if (t.hasAttribute('data-refresh')) return load();
    var sc = t.getAttribute('data-scope');
    if (sc) { p.ctx.scope = sc; p.form = null; render(); return; }
    if (t.hasAttribute('data-old')) { p.showOld = !p.showOld; if (!p.showOld && p.form && p.form.id === '*old') p.form = null; render(); return; }
    if (t.hasAttribute('data-clear-old')) { p.form = { id: '*old', type: 'clearold' }; p.showOld = true; render(); focusIn('[data-cancel]'); return; }
    if (p.form && p.form.id === '*old') {
      if (t.hasAttribute('data-cancel')) { p.form = null; render(); return; }
      if (t.hasAttribute('data-ok')) return clearOld(t);
    }
    var card = t.closest('[data-dev]'), dev = card ? find(card.getAttribute('data-dev')) : null;
    if (!dev) return;
    if (t.hasAttribute('data-toggle')) {
      p.open[dev.id] = !p.open[dev.id];
      if (!p.open[dev.id] && p.form && p.form.id === dev.id) p.form = null;
      render(); return;
    }
    var act = t.getAttribute('data-act');
    if (act === 'rename') { p.form = { id: dev.id, type: 'rename', kind: devKind(dev) }; render(); focusIn('input'); return; }
    if (act === 'lock') { p.form = { id: dev.id, type: 'lock' }; render(); focusIn('[data-ok]'); return; }
    if (act === 'remove') { p.form = { id: dev.id, type: 'remove' }; render(); focusIn('[data-cancel]'); return; }
    if (act === 'uncmd') { run(function () { return B.cancel(dev.owner, dev.id); }, 'Lock cancelled.'); return; }
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
function run(fn, done) {
  var p = P;
  return Promise.resolve().then(fn).then(function (r) {
    if (P !== p) return r;
    p.form = null; toast(typeof done === 'function' ? done(r) : done); load(true);
    return r;
  }, function () {
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
    return run(function () {
      var jobs = [B.rename(dev.owner, dev.id, name)];
      if (kindChanged) jobs.push(B.setKind(dev.owner, dev.id, f.kind));
      return Promise.all(jobs);
    }, 'Saved.');
  }
  if (f.type === 'lock') {
    return run(function () { return B.lock(dev.owner, dev.id, P.ctx.profile); },
      function (r) { return r && r.now ? 'This device is locked.' : 'It locks the next time it opens an A1 program.'; });
  }
  if (f.type === 'remove') {
    var self = dev.id === P.data.self;
    return run(function () { return B.remove(dev); }, self ? 'This device was removed and locked.' : devName(dev) + ' was removed.');
  }
}
function oldDevices() {
  var p = P, self = p.data.self;
  return p.data.devices.filter(function (d) { return d.id !== self && isStale(d) && visible(d, p.ctx); });
}
function clearOld(btn) {
  btn.disabled = true;
  var list = oldDevices();
  run(function () {
    return list.reduce(function (pr, d) { return pr.then(function () { return B.remove(d); }); }, Promise.resolve());
  }, list.length + (list.length === 1 ? ' inactive device was removed.' : ' inactive devices were removed.'));
}
var reloadT = 0;
function reloadSoon() { clearTimeout(reloadT); reloadT = setTimeout(function () { load(true); }, 600); }
function load(quiet) {
  var p = P; if (!p) return;
  if (!quiet || !p.data) { p.root.querySelector('[data-body]').innerHTML = '<div class="state">Finding your devices…</div>'; thumbSync(p); }
  B.list(p.ctx.profile, { pushLists: p.ctx.pushLists }).then(function (data) {
    if (P !== p) return;
    p.data = data;
    if (p.form && p.form.id !== '*old' && !find(p.form.id)) p.form = null;
    // Never redraw under someone typing a name: catch up when the form closes.
    if (p.form && p.form.type === 'rename' && quiet) { p.dirty = true; return; }
    render();
  }, function () {
    if (P !== p) return;
    if (p.data && quiet) return;
    p.root.querySelector('[data-body]').innerHTML = '<div class="state">Couldn’t reach your devices. Check the connection and try again.' +
      '<button class="b" data-refresh>' + I.refresh + 'Try again</button></div>';
    thumbSync(p);
  });
}

function render() {
  var p = P; if (!p || !p.data) return;
  p.dirty = false;
  var ctx = p.ctx, data = p.data, self = data.self;
  var devs = data.devices.filter(function (d) { return visible(d, ctx); });
  // This device first, then the most recently active.
  devs.sort(function (a, b) { return (b.id === self) - (a.id === self) || (b.seen || 0) - (a.seen || 0); });
  var live = devs.filter(function (d) { return d.id === self || !isStale(d); });
  var old = devs.filter(function (d) { return d.id !== self && isStale(d); });
  var mine = live.filter(function (d) { return d.owner === ctx.profile; });
  var neutral = live.filter(function (d) { return d.owner === 'neutral'; });
  var nAct = devs.filter(isActive).length;
  var nPush = devs.filter(function (d) { return rowsFor(d, ctx).some(function (r) { return r.push && r.push.cls === 'ok'; }); }).length;
  p.root.querySelector('[data-count]').innerHTML = '<b>' + devs.length + '</b> ' + (devs.length === 1 ? 'device' : 'devices') +
    (nAct ? ' · <span class="dot"></span>' + nAct + ' active now' : '') +
    (nPush ? ' · ' + nPush + ' get notifications' : '');
  var where = ctx.scope === 'all' ? 'an A1 program' : ctx.appLabel;
  var h = '<div class="sec"><div class="sh"><span class="st">Your devices</span></div>';
  h += mine.length ? '<div class="card">' + mine.map(row).join('') + '</div>'
    : '<div class="card"><div class="empty"><b>No devices yet</b>A device shows up here once it opens ' + esc(where) + ' as ' + esc(NAMES[ctx.profile]) + '.</div></div>';
  h += '</div>';
  if (neutral.length) {
    h += '<div class="sec"><div class="sh"><span class="st">Neutral devices</span><span class="sn">Nobody’s main device. You both see these.</span></div>' +
      '<div class="card">' + neutral.map(row).join('') + '</div></div>';
  }
  if (old.length) {
    var clearing = p.form && p.form.id === '*old';
    h += '<div class="sec"><div class="sh"><span class="st">Inactive</span><span class="sn">' + old.length + ' not seen in 60 days</span><span class="sp"></span>' +
      '<button class="lnk" data-old aria-expanded="' + p.showOld + '">' + (p.showOld ? 'Hide' : 'Show') + '</button>' +
      (p.showOld && !clearing ? '<button class="lnk dg" data-clear-old>Remove all</button>' : '') + '</div>';
    if (clearing) {
      h += '<div class="inl" style="margin:0 0 10px"><p>Remove all <b>' + old.length + ' inactive devices</b>? Their notifications stop now, and each one locks if it ever opens A1 again.</p>' +
        '<div class="r2"><button class="b" data-cancel>Cancel</button><button class="b solid dg" data-ok>' + I.trash + 'Remove ' + old.length + '</button></div></div>';
    }
    if (p.showOld) h += '<div class="card">' + old.map(row).join('') + '</div>';
    h += '</div>';
  }
  h += '<div class="foot">Remove stops a device’s notifications at once and locks it the next time it opens A1. Opening A1 there again adds it back, behind its passwords.</div>';
  var body = p.root.querySelector('[data-body]'), top = body.scrollTop;
  body.innerHTML = h;
  body.scrollTop = top;
  p.root.querySelectorAll('[data-scope]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-scope') === ctx.scope ? 'true' : 'false'); });
  thumbSync(p);
}
function row(d) {
  var p = P, ctx = p.ctx, me = d.id === p.data.self, open = !!p.open[d.id];
  var rows = rowsFor(d, ctx), active = isActive(d), stale = isStale(d);
  var when = active ? '<span class="act">Active now</span>' : (d.seen ? ago(d.seen) : '');
  var sub = devSub(d);
  var h = '<div class="dev' + (me ? ' me' : '') + (open ? ' open' : '') + (stale ? ' old' : '') + '" data-dev="' + esc(d.id) + '">';
  h += '<button class="row" data-toggle aria-expanded="' + open + '">' +
    '<span class="dic">' + kindIcon(d) + (active ? '<i class="live" title="Active now"></i>' : '') + '</span>' +
    '<span class="dt"><span class="dn"><span class="nm">' + esc(devName(d)) + '</span>' +
      (me ? '<span class="tag">This device</span>' : '') + (stale && d.owner === 'neutral' ? '<span class="tag n">Neutral</span>' : '') + '</span>' +
    '<span class="dm" title="' + esc(d.seen ? 'Last active ' + fullTime(d.seen) : '') + '">' + when + (sub && when ? ' · ' : '') + esc(sub) + '</span></span>' +
    '<span class="gl">' + glyphs(rows) + '</span><span class="cv">' + I.chev + '</span></button>';
  if (open) h += details(d, rows, me);
  return h + '</div>';
}
function details(d, rows, me) {
  var p = P, ctx = p.ctx, os = (d.meta || {}).os;
  var h = '<div class="det">';
  if (rows.length) {
    h += rows.map(function (r) {
      var x = '<div class="pg"><div class="ph"><span class="pn">' + esc(r.label) + '</span><span class="pw" title="' + esc(fullTime(r.seen)) + '">' + esc(ago(r.seen)) + '</span></div><div class="facts">';
      if (r.push) x += '<span class="f ' + r.push.cls + '" title="' + esc(r.push.title) + '">' + r.push.icon + esc(r.push.text) + '</span>';
      if (r.locks) x += '<span class="f ' + (r.locks.shut ? 'ac' : '') + '">' + r.locks.icon + esc(r.locks.text) + '</span>';
      x += '</div>';
      if (r.locks && r.locks.list.length > 1 || (r.locks && r.locks.list.length === 1 && r.locks.list[0].bio)) {
        x += '<div class="lks">' + r.locks.list.map(function (l) {
          return '<div class="lk">' + (l.open ? I.unlock : I.lock) + '<span class="ln">' + esc(l.label) + '</span>' +
            (l.bio ? '<span class="lb" title="' + esc(bioName(os)) + ' is set up">' + I.bio + '</span>' : '') +
            '<span class="' + (l.open ? 'lo' : 'lc') + '">' + (l.open ? 'Unlocked' : 'Locked') + '</span></div>';
        }).join('') + '</div>';
      }
      return x + '</div>';
    }).join('');
  } else h += '<div class="pg"><span class="sn">No program has checked in from here yet.</span></div>';
  if (d.cmd && d.cmd.lock) {
    h += '<div class="flag">' + I.lock + '<span>Lock sent ' + esc(ago(d.cmd.lock)) + '. It applies the next time this device opens A1.</span>' +
      '<button class="lnk" data-act="uncmd">Cancel</button></div>';
  }
  if (d.first) h += '<div class="meta">First seen ' + esc(fullTime(d.first)) + (d.seen ? ' · last active ' + esc(fullTime(d.seen)) : '') + '</div>';
  var f = p.form && p.form.id === d.id ? p.form : null;
  var renameable = !(d.legacy && !/^dev_|^fp_/.test(d.id));
  var lockable = canLock(d, ctx.profile);
  if (!f) {
    h += '<div class="acts">' +
      '<button class="b" data-act="rename"' + (renameable ? '' : ' disabled title="Known only by its notification token"') + '>' + I.pencil + 'Rename</button>' +
      '<button class="b" data-act="lock"' + (lockable ? '' : ' disabled title="No program on this device has a lock"') + '>' + I.lock + 'Lock</button>' +
      '<button class="b dg rm" data-act="remove">' + I.trash + 'Remove</button></div>';
  } else h += form(d, f, me);
  return h + '</div>';
}
function form(d, f, me) {
  var n = esc(devName(d));
  if (f.type === 'rename') {
    return '<div class="inl"><label class="fl">Name<input type="text" maxlength="60" value="' + esc(d.name || '') + '" placeholder="' + n + '" autocomplete="off" spellcheck="false"></label>' +
      '<div class="fl">Type<div class="kinds">' +
      KINDS.map(function (k) { return '<button type="button" data-kind="' + k[0] + '" aria-pressed="' + ((f.kind === k[0] || (f.kind === 'computer' && k[0] === 'desktop')) ? 'true' : 'false') + '">' + I[k[0]] + k[1] + '</button>'; }).join('') +
      '</div></div><div class="r2"><button class="b" data-cancel>Cancel</button><button class="b solid" data-ok>Save</button></div></div>';
  }
  if (f.type === 'lock') {
    return '<div class="inl"><p>' + (me
      ? 'Lock every A1 program on <b>this device</b> now? Each one asks for its password again.'
      : 'Lock every A1 program on <b>' + n + '</b>? It locks the next time it opens A1, then each program asks for its password.') + '</p>' +
      '<div class="r2"><button class="b" data-cancel>Cancel</button><button class="b solid" data-ok>' + I.lock + 'Lock</button></div></div>';
  }
  return '<div class="inl"><p>' + (me
    ? 'Remove <b>this device</b>? Its notifications stop and every program here locks right away.'
    : 'Remove <b>' + n + '</b>? Its notifications stop now, and every program on it locks the next time it opens.') +
    ' Opening A1 there again adds it back.</p>' +
    '<div class="r2"><button class="b" data-cancel>Cancel</button><button class="b solid dg" data-ok>' + I.trash + 'Remove</button></div></div>';
}

window.BeaconUI = { open: open, close: close, isOpen: function () { return !!P; }, _rowsFor: rowsFor, _pushView: pushView, _locksView: locksView };
})();
