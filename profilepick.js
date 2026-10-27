/* profilepick.js — the one profile picker, Shruti's title screen (Tony,
   2026-10-27: "the same profile screen in every app that uses profiles").

   A deep ground, one soft halo behind the title that breathes very slowly, a
   faint glow along the bottom edge and a fine grain; the app's mark rising,
   its name settling from wide letter-spacing, a thin rule, a spaced line of
   what the app is for, "Who goes there?", then one frosted card per person
   whose emblem glows in that person's colour.

   The host keeps everything that is its own: which profile is chosen, the
   lock, the favourite, when the screen shows. This file only draws it.

     var pick = A1Pick.mount(el, {
       app: 'shruti',                       // A1Head.icon() mark (or mark: '<svg…>')
       title: 'Shruti', sub: 'Read · Listen · Watch · Study',
       profiles: [{ id: 'tony', label: 'Tony' }, { id: 'veda', label: 'Veda' }],  // + domId, aria, emblem
       state: function (id) { return { note, noteIcon, tone, fav, locked, off }; },
       onChoose: function (id) {},
       onStar: function (id) {},            // shows the ★ in each card's corner
       onLock: function (id) {},            // or a padlock there instead
       starTitle / lockTitle: function (id, st) { return '…'; }
     });
     pick.refresh();                        // re-reads state() in place

   el becomes the full-screen overlay (class a1-pk); showing and hiding it is
   the host's (hidden, display or a body attribute). The cards are built once
   and refreshed in place, so a tap on the star never replays the entrance.
   ORCA, on its own origin and server-rendered, carries a port of this CSS in
   its app.css section 11. */
(function () {
  'use strict';
  if (window.A1Pick) return;

  var STAR = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
  var LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var UNLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
  // Each person's emblem: Tony's drawn fleur-de-lis (the emoji is always
  // gold), Veda's four-point star.
  var EMBLEM = {
    tony: '<svg width="0.78em" height="0.78em" viewBox="0 0 24 22" aria-hidden="true"><path d="M12 1C14.7 3.7 15.5 7.6 13.7 13H10.3C8.5 7.6 9.3 3.7 12 1ZM13.9 13C14.4 9.1 17.3 6.7 20.3 7.7C22.7 8.5 23.4 11.6 21.4 13.4C21.6 11.8 20.6 10.4 19 10.6C17.3 10.9 16.2 12.2 15.8 13ZM10.1 13C9.6 9.1 6.7 6.7 3.7 7.7C1.3 8.5 .6 11.6 2.6 13.4C2.4 11.8 3.4 10.4 5 10.6C6.7 10.9 7.8 12.2 8.2 13ZM7.4 13.4H16.6A.85 .85 0 0 1 16.6 15.1H7.4A.85 .85 0 0 1 7.4 13.4ZM10.9 15.5H13.1C13.1 17.6 12.7 19.4 12 21.2C11.3 19.4 10.9 17.6 10.9 15.5ZM13.6 15.5H15.3C15.6 17.1 16.7 18.1 18.4 17.9C17.8 19.5 16.1 20 14.9 19.2C14.1 18.6 13.7 17.4 13.6 15.5ZM10.4 15.5H8.7C8.4 17.1 7.3 18.1 5.6 17.9C6.2 19.5 7.9 20 9.1 19.2C9.9 18.6 10.3 17.4 10.4 15.5Z" fill="currentColor"/></svg>',
    veda: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 7.2L21.5 12l-7.2 2.3L12 21.5l-2.3-7.2L2.5 12l7.2-2.3z" fill="currentColor"/></svg>'
  };

  var GRAIN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";
  var E = 'cubic-bezier(.2,.8,.2,1)';
  // Every rule is under .a1-pk so a host's own button/h1 styles never reach in.
  var CSS = [
    '.a1-pk{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;box-sizing:border-box;',
    'padding:calc(env(safe-area-inset-top,0px) + 24px) 16px calc(env(safe-area-inset-bottom,0px) + 24px);text-align:center;overflow-y:auto;',
    'background:radial-gradient(90% 55% at 50% 108%,rgba(183,159,196,.09),rgba(183,159,196,0) 70%),#131317;color:#ece6fb}',
    '.a1-pk[hidden]{display:none}',
    '.a1-pk *,.a1-pk *::before,.a1-pk *::after{box-sizing:border-box}',
    // The halo: one light, behind the title, breathing over 10 s.
    ".a1-pk::before{content:'';position:fixed;left:50%;top:34%;width:min(980px,150vw);height:min(720px,110vw);pointer-events:none;",
    'transform:translate(-50%,-50%);background:radial-gradient(closest-side,rgba(192,174,234,.16),rgba(150,128,214,.06) 55%,rgba(150,128,214,0));',
    'animation:a1pkBreathe 10s ease-in-out infinite}',
    // Grain, so the dark reads as a surface rather than a void.
    ".a1-pk::after{content:'';position:fixed;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;background-image:" + GRAIN + '}',
    '@keyframes a1pkBreathe{0%,100%{opacity:.75;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.05)}}',
    '.a1-pk .pk-in{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;width:100%;max-width:760px;margin:auto}',
    '.a1-pk .pk-mark{width:52px;height:52px;color:#c0aeea;margin-bottom:18px;opacity:0;animation:a1pkRise .5s 0s ' + E + ' forwards}',
    '.a1-pk .pk-mark svg{width:100%;height:100%;display:block;filter:drop-shadow(0 0 18px rgba(192,174,234,.35))}',
    ".a1-pk .pk-title{margin:0;padding:0;font:600 clamp(54px,12vw,104px)/1 'Manrope',system-ui,sans-serif;letter-spacing:-1.5px;color:#ece6fb;text-transform:none;",
    'opacity:0;animation:a1pkWord .6s .05s ' + E + ' forwards}',
    '.a1-pk .pk-rule{width:56px;height:1px;margin:22px 0 16px;background:rgba(192,174,234,.55);opacity:0;animation:a1pkRise .45s .25s ' + E + ' forwards}',
    ".a1-pk .pk-sub{font:600 clamp(10.5px,1.6vw,12.5px) 'Inter',system-ui,sans-serif;letter-spacing:5px;text-transform:uppercase;color:#9a9aa6;",
    'opacity:0;animation:a1pkRise .5s .3s ' + E + ' forwards}',
    ".a1-pk .pk-ask{margin:clamp(40px,7vh,64px) 0 16px;font:700 10.5px 'Inter',system-ui,sans-serif;letter-spacing:2.4px;text-transform:uppercase;color:#8a8a96;",
    'opacity:0;animation:a1pkRise .45s .38s ' + E + ' forwards}',
    '.a1-pk .pk-cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}',
    '.a1-pk .pk-card{--pk:#c0aeea;--pk-rgb:192,174,234;position:relative;width:176px;margin:0;padding:30px 16px 22px;display:flex;flex-direction:column;align-items:center;gap:14px;',
    'background:rgba(32,32,38,.52);border:1px solid rgba(255,255,255,.08);border-radius:24px;cursor:pointer;overflow:hidden;color:inherit;',
    '-webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2);',
    'box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 18px 50px rgba(0,0,0,.35);',
    'opacity:0;animation:a1pkRise .5s .42s ' + E + ' forwards;',
    'transition:transform .35s ' + E + ',border-color .35s,box-shadow .35s,background .35s,opacity .35s}',
    '.a1-pk .pk-card+.pk-card{animation-delay:.48s}',
    '.a1-pk .pk-card.veda{--pk:#b79fc4;--pk-rgb:183,159,196}',
    // A soft pool of the person's colour behind the emblem, brighter on hover.
    ".a1-pk .pk-card::before{content:'';position:absolute;left:50%;top:-40px;width:220px;height:200px;transform:translateX(-50%);pointer-events:none;",
    'background:radial-gradient(closest-side,rgba(var(--pk-rgb),.22),rgba(var(--pk-rgb),0));opacity:.55;transition:opacity .35s}',
    '.a1-pk .pk-card:hover,.a1-pk .pk-card:focus-visible{transform:translateY(-6px);border-color:rgba(var(--pk-rgb),.5);background:rgba(36,36,44,.62);',
    'box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(var(--pk-rgb),.12)}',
    '.a1-pk .pk-card:hover::before,.a1-pk .pk-card:focus-visible::before{opacity:1}',
    '.a1-pk .pk-card:active{transform:translateY(-2px) scale(.985)}',
    '.a1-pk .pk-card:focus-visible{outline:none}',
    // A profile that cannot be opened here (Shield's other owner) stays tappable but reads as unavailable.
    '.a1-pk .pk-card.off{filter:saturate(.4)}.a1-pk .pk-card.off .pk-em,.a1-pk .pk-card.off .nm{opacity:.5}',
    '.a1-pk .pk-em{position:relative;width:76px;height:76px;display:grid;place-items:center;border-radius:50%;color:var(--pk);font-size:42px;line-height:1;',
    'background:radial-gradient(circle at 50% 38%,rgba(var(--pk-rgb),.2),rgba(var(--pk-rgb),.05) 70%);',
    'box-shadow:0 0 0 1px rgba(var(--pk-rgb),.32) inset,0 0 28px rgba(var(--pk-rgb),.14);transition:box-shadow .35s,transform .35s ' + E + '}',
    ".a1-pk .pk-em::after{content:'';position:absolute;inset:-7px;border-radius:50%;border:1px solid rgba(var(--pk-rgb),.18);transition:inset .35s " + E + ',border-color .35s}',
    '.a1-pk .pk-card:hover .pk-em,.a1-pk .pk-card:focus-visible .pk-em{transform:scale(1.04);box-shadow:0 0 0 1px rgba(var(--pk-rgb),.5) inset,0 0 40px rgba(var(--pk-rgb),.3)}',
    '.a1-pk .pk-card:hover .pk-em::after,.a1-pk .pk-card:focus-visible .pk-em::after{inset:-10px;border-color:rgba(var(--pk-rgb),.34)}',
    '.a1-pk .pk-em svg{width:32px;height:32px;display:block}',
    ".a1-pk .pk-card .nm{position:relative;font:750 20px/1.1 'Manrope',system-ui,sans-serif;letter-spacing:-.3px;color:#f1eef8}",
    ".a1-pk .pk-card.veda .nm{font:700 21px/1.1 'Playfair Display',serif;letter-spacing:0}",
    ".a1-pk .pk-note{position:relative;height:14px;display:flex;align-items:center;justify-content:center;gap:5px;",
    "font:700 9.5px 'Inter',system-ui,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:rgba(var(--pk-rgb),.85)}",
    '.a1-pk .pk-note.warn{color:#d68a7c}.a1-pk .pk-note.dim{color:#8a8a96}',
    '.a1-pk .pk-note svg{width:11px;height:11px}',
    // The corner: the favourite star, or (TaskHub) the padlock that manages the password.
    '.a1-pk .pk-star{position:absolute;top:8px;right:8px;z-index:1;width:32px;height:32px;min-width:0;min-height:0;margin:0;padding:0;display:grid;place-items:center;',
    'border-radius:50%;color:#8a8a96;border:0;background:transparent;box-shadow:none;cursor:pointer;opacity:0;transition:opacity .25s,background .2s,color .2s}',
    '.a1-pk .pk-card:hover .pk-star,.a1-pk .pk-card:focus-within .pk-star,.a1-pk .pk-star.on{opacity:1}',
    '@media (hover:none){.a1-pk .pk-star{opacity:.7}}',
    '.a1-pk .pk-star svg{width:15px;height:15px}',
    '.a1-pk .pk-star:hover{background:rgba(255,255,255,.08);color:#d6d6de}',
    '.a1-pk .pk-star.on{color:#e0b874}.a1-pk .pk-star.on svg{fill:currentColor}',
    '.a1-pk .pk-star.lk.on{color:var(--pk)}.a1-pk .pk-star.lk.on svg{fill:none}',
    '.a1-pk .pk-extra{position:relative;margin-top:22px;max-width:420px}',
    '@keyframes a1pkRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '@keyframes a1pkWord{from{opacity:0;letter-spacing:8px;transform:translateY(6px)}to{opacity:1;letter-spacing:-2px;transform:none}}',
    '@media (max-width:420px){.a1-pk .pk-cards{gap:12px}.a1-pk .pk-card{width:calc(50vw - 24px);max-width:168px;padding:26px 10px 18px}.a1-pk .pk-em{width:68px;height:68px}}',
    '@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.a1-pk .pk-card{background:rgba(32,32,38,.92)}}',
    '@media (prefers-reduced-motion:reduce){.a1-pk .pk-mark,.a1-pk .pk-title,.a1-pk .pk-rule,.a1-pk .pk-sub,.a1-pk .pk-ask,.a1-pk .pk-card,.a1-pk::before{animation:none;opacity:1}}'
  ].join('');

  function addStyle() {
    var head = document.head || document.documentElement;
    if (!document.getElementById('a1-pick-css')) {
      var s = document.createElement('style');
      s.id = 'a1-pick-css';
      s.textContent = CSS;
      head.appendChild(s);
    }
    // The three faces the screen is set in; a host that already loads them
    // gets them from the browser's cache.
    if (!document.getElementById('a1-pick-fonts')) {
      var l = document.createElement('link');
      l.id = 'a1-pick-fonts';
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@600;700&family=Manrope:wght@500..800&family=Playfair+Display:wght@700&display=swap';
      head.appendChild(l);
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mount(el, o) {
    addStyle();
    o = o || {};
    var profiles = o.profiles || [{ id: 'tony', label: 'Tony' }, { id: 'veda', label: 'Veda' }];
    var mark = o.mark || (window.A1Head && o.app ? A1Head.icon(o.app) : '');
    el.classList.add('a1-pk');
    el.innerHTML =
      '<div class="pk-in">' +
        '<div class="pk-mark">' + mark + '</div>' +
        '<h1 class="pk-title">' + esc(o.title) + '</h1>' +
        '<div class="pk-rule"></div>' +
        '<div class="pk-sub">' + esc(o.sub) + '</div>' +
        '<div class="pk-ask">' + esc(o.ask || 'Who goes there?') + '</div>' +
        '<div class="pk-cards"></div>' +
        '<div class="pk-extra" hidden></div>' +
      '</div>';
    var cards = el.querySelector('.pk-cards');
    var corner = o.onStar ? 'star' : o.onLock ? 'lock' : '';
    cards.innerHTML = profiles.map(function (p) {
      return '<div class="pk-card ' + esc(p.id) + '"' + (p.domId ? ' id="' + esc(p.domId) + '"' : '') + ' role="button" tabindex="0" data-p="' + esc(p.id) + '" aria-label="' + esc(p.aria || p.label) + '">' +
        (corner ? '<button type="button" class="pk-star' + (corner === 'lock' ? ' lk' : '') + '" data-corner="' + esc(p.id) + '"></button>' : '') +
        '<span class="pk-em">' + (p.emblem || EMBLEM[p.id] || '') + '</span>' +
        '<span class="nm">' + esc(p.label) + '</span>' +
        '<span class="pk-note"></span></div>';
    }).join('');

    function refresh() {
      profiles.forEach(function (p) {
        var card = cards.querySelector('[data-p="' + p.id + '"]');
        if (!card) return;
        var st = (o.state && o.state(p.id)) || {};
        card.classList.toggle('last', !!st.last);
        card.classList.toggle('off', !!st.off);
        var note = card.querySelector('.pk-note');
        var ic = st.noteIcon === 'lock' ? LOCK : st.noteIcon === 'unlock' ? UNLOCK : '';
        note.className = 'pk-note' + (st.tone ? ' ' + st.tone : '');
        note.innerHTML = ic + esc(st.note || '');
        var b = card.querySelector('.pk-star');
        if (!b) return;
        if (corner === 'star') {
          b.className = 'pk-star' + (st.fav ? ' on' : '');
          b.innerHTML = STAR;
          b.title = o.starTitle ? o.starTitle(p.id, st) : st.fav ? 'Default on this device (tap to clear)' : 'Make default on this device';
          b.setAttribute('aria-label', 'Default profile');
          b.setAttribute('aria-pressed', st.fav ? 'true' : 'false');
        } else {
          b.className = 'pk-star lk' + (st.locked ? ' on' : '');
          b.innerHTML = st.locked ? LOCK : UNLOCK;
          b.title = o.lockTitle ? o.lockTitle(p.id, st) : st.locked ? 'Locked: manage the password' : 'Set a password';
          b.setAttribute('aria-label', b.title);
        }
      });
    }

    cards.addEventListener('click', function (e) {
      var c = e.target.closest('[data-corner]');
      if (c) {
        e.stopPropagation();
        var id = c.getAttribute('data-corner');
        if (corner === 'star') o.onStar(id); else o.onLock(id);
        refresh();
        return;
      }
      var card = e.target.closest('[data-p]');
      if (card && o.onChoose) o.onChoose(card.getAttribute('data-p'));
    });
    cards.addEventListener('keydown', function (e) {
      if (e.target.closest('[data-corner]')) return;
      var card = e.target.closest('[data-p]');
      if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (o.onChoose) o.onChoose(card.getAttribute('data-p')); }
    });

    refresh();
    return {
      el: el,
      refresh: refresh,
      /** A line under the cards (MAGI's storage notice); null clears it. */
      extra: function (node) {
        var x = el.querySelector('.pk-extra');
        x.textContent = '';
        if (node) x.append(node);
        x.hidden = !node;
      }
    };
  }

  window.A1Pick = { mount: mount, EMBLEM: EMBLEM, ICON: { star: STAR, lock: LOCK, unlock: UNLOCK } };
})();
