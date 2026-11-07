/* ════════════════════════════════════════════════════════════════════════════
   Neo's programs — every program linked from Veda's TaskHub, in one registry.
   Docs: docs/TaskHub/neo-assistant.md ("Programs").

   VEDA'S SIDE ONLY. Tony's Neo never sees this list (his bridge has no
   openProgram/program methods, and every call here refuses off her side).

   Where the list comes from (nothing hardcoded but Warden):
     · her header links          window._navGetLinks('veda')   → _navOpenLink
     · her LifeHub list          LifeHub.list('veda')          → LifeHub.launch
     · Warden, her links page    (another repo; replaces this page)
   The same page reached two ways is listed once (by its address). A program
   Neo knows (KNOWN) keeps a stable id ("studyos", "mylist", …) so the model
   can name it; anything else gets the id of the link it came from.

   Acting inside a program: a connector, registered with
     window._vdNeoPrograms.register(id, { summary(), ops: { name: { args, say?, confirm?, run(args) } } })
   gives Neo a short summary (sent as state.programs, so reading costs no
   extra call) and the operations it may run. Each op answers true, a
   {ok:false, reason} or a promise of one, like every other Neo action.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window._vdNeoPrograms) return;

  // Stable ids for the programs Neo knows, matched on the page's address.
  // Two links to the same kind of page (MAGI and MAGI (T)) keep their own ids:
  // the first takes the known id, the next its link's id.
  var KNOWN = [
    { id: 'studyos', re: /\/studyos\/?(index\.html)?(?=[?#]|$)/i, aliases: ['study', 'study os', 'studies', 'my classes'] },
    { id: 'finance', re: /\/finance(\/|\.html)?(index\.html)?(?=[?#]|$)/i, aliases: ['my finances', 'money', 'budget'] },
    { id: 'tradeboard', re: /(\/\/tradeboard\.vedapatel05\.workers\.dev\/?(index\.html)?|\/tradeboard\.html)(?=[?#]|$)/i, aliases: ['trade', 'trade board', 'trading'] },
    { id: 'mylist', re: /\/mylist\.html(?=[?#]|$)/i, aliases: ['list', 'my list', 'my lists', 'lists'] },
    { id: 'wellness', re: /\/wellness\.html(?=[?#]|$)/i, aliases: ['wellness tracker'] },
    { id: 'magi_council', re: /\/\/magi-council[\w.-]*\.workers\.dev/i, aliases: ['council', 'magi council'] },
    { id: 'magi', re: /\/magi\.html(?=[?#]|$)/i, aliases: ['maggie', 'magic'] },
    { id: 'shruti', re: /\/shruti\.html(?=[?#]|$)/i, aliases: ['shruti app'] },
    { id: 'shield', re: /\/shield\.html(?=[?#]|$)/i, aliases: ['shield web'] },
    { id: 'system', re: /\/\/solo-leveling\.[\w.-]+/i, aliases: ['solo leveling', 'solo-leveling', 'my system'] },
    { id: 'orca', re: /\/\/orca\.vedapatel05\.workers\.dev/i, aliases: ['orca ai'] },
    { id: 'reserv', re: /\/\/reserv\.vedapatel05\.workers\.dev/i, aliases: ['reserve', 'reserves', 'reservations'] },
    // Tony's program, with no Veda profile: Neo never lists, opens or touches it (Veda, 2026-11-06).
    { id: 'everwell', re: /\/everwell\.html(?=[?#]|$)/i, aliases: [], off: true },
    { id: 'warden', re: /\/\/vedacpatel\.github\.io\/warden\//i, aliases: ['my links', 'links', 'links page'] },
    { id: 'riftiq', re: /\/riftiq\.html(?=[?#]|$)/i, aliases: ['rift iq', 'war room', 'warroom'] },
  ];
  var WARDEN = { id: 'warden', label: 'Warden', url: 'https://vedacpatel.github.io/warden/warden.html', aliases: ['my links', 'links', 'links page'], src: 'warden' };
  // Programs inside her TaskHub itself, listed first so Neo can read and act in them too.
  var BUILTINS = [
    { id: 'notebook', label: 'V\'s Notebook', url: 'builtin:notebook', aliases: ['notebook', 'journal', 'my journal', 'my notebook', 'v notebook'], src: 'builtin',
      openFn: function () { if (!window._vedaNav) return { ok: false, reason: 'no_bridge' }; window._vedaNav('journal'); return true; } },
    { id: 'plans', label: 'Plans', url: 'builtin:plans', aliases: ['plans with tony', 'my plans'], src: 'builtin',
      openFn: function () { if (!window._thOpenPlansVeda) return { ok: false, reason: 'no_bridge' }; window._thOpenPlansVeda(); return true; } },
  ];
  var CONNECTORS = {};

  function isVeda() { return window._activeProfile === 'veda'; }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function addrKey(u) {
    return String(u || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/index\.html$/, '/').replace(/\/+$/, '');
  }
  function knownFor(url) { for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i].re.test(String(url || ''))) return KNOWN[i]; return null; }
  function isTaskHub(url) { return /\/A1\/?(index\.html)?(?=[?#]|$)/i.test(String(url || '')); }

  // → [{id, label, url, aliases, src, ref}]
  function list() {
    if (!isVeda()) return [];
    var out = [], seen = {};
    function put(e) {
      if (!e.url || isTaskHub(e.url)) return;      // TaskHub itself: open_app taskhub
      if ((knownFor(e.url) || {}).off) return;     // a program Neo stays out of
      var k = addrKey(e.url);
      if (seen[k]) return;
      var kn = knownFor(e.url);
      if (kn && !out.some(function (x) { return x.id === kn.id; })) { e.id = kn.id; e.aliases = kn.aliases; }
      seen[k] = 1; out.push(e);
    }
    BUILTINS.forEach(function (b) { put(Object.assign({}, b)); });
    // `tab`: the named tab its own button or tile uses, so a deep link lands there too.
    var links = []; try { links = (window._navGetLinks && window._navGetLinks('veda')) || []; } catch (e) {}
    links.forEach(function (l) { if (l && l.label) put({ id: 'link:' + l.id, label: l.label, url: l.url, aliases: [], src: 'header', ref: l.id, tab: 'link_veda_' + l.id }); });
    var apps = []; try { apps = (window.LifeHub && window.LifeHub.list && window.LifeHub.list('veda')) || []; } catch (e) {}
    apps.forEach(function (a) { if (a && a.name && !a.hidden) put({ id: 'lh:' + a.id, label: a.name, url: a.url, aliases: [], src: 'lifehub', ref: a.id, tab: a.tab || ('lh_' + a.id) }); });
    put(Object.assign({}, WARDEN));
    return out;
  }

  // A program by id, label or alias (what she said, or what the model copied).
  function find(q) {
    var all = list(), n = norm(q);
    if (!n) return null;
    var by = function (f) { return all.filter(f)[0] || null; };
    // A known program's id wins, so "MAGI" is MAGI (T), the A1 page (Veda, 2026-11-06);
    // her council link is "council". Then her own label, an alias, part of a label.
    return by(function (p) { return p.id === q || norm(p.id) === n; })
      || by(function (p) { return norm(p.label) === n; })
      || by(function (p) { return (p.aliases || []).some(function (a) { return norm(a) === n; }); })
      || by(function (p) { var l = ' ' + norm(p.label) + ' '; return l.indexOf(' ' + n + ' ') >= 0 || (' ' + n + ' ').indexOf(l) >= 0; })
      || null;
  }

  function openUrl(url, tab) {
    var w = null;
    try { w = window._tnOpenTab ? window._tnOpenTab(url, tab) : window.open(url, '_blank'); } catch (e) {}
    return w ? true : { ok: false, reason: 'blocked' };
  }
  // A place inside a program: its tab, sent there even when it is already open
  // on that page (_tnOpenTab only brings such a tab forward; the #route differs).
  function openDeep(url, tab) {
    var w = null;
    try { w = window._tnOpenTab ? window._tnOpenTab(url, tab) : window.open(url, tab || '_blank'); } catch (e) {}
    if (!w) return { ok: false, reason: 'blocked' };
    try { if (w.location && w.location.href !== url) w.location.href = url; } catch (e) {}   // another origin: _tnOpenTab sent it
    return true;
  }

  // ── locks ────────────────────────────────────────────────────────────────
  // A program behind a Guardian lock: Neo neither reads nor acts in it until
  // it is unlocked. Acting asks for the unlock (alGate), as its own button does.
  function locked(id) {
    var c = CONNECTORS[id], G = window.Guardian;
    try { return !!(c && c.lock && G && G.mustBlock && G.mustBlock(c.lock)); } catch (e) { return false; }
  }
  function gated(id, fn) {
    var c = CONNECTORS[id];
    if (!locked(id)) return fn();
    if (!window.alGate) return { ok: false, reason: 'locked' };
    var p = new Promise(function (res) {
      window.alGate(c.lock, function () { Promise.resolve().then(fn).then(res, function () { res({ ok: false, reason: 'failed' }); }); }, function () { res({ ok: false, reason: 'locked' }); });
      setTimeout(function () { res({ ok: false, reason: 'locked' }); }, 120000);
    });
    p.gated = true; return p;
  }

  // Opens it the way its own button or tile does (locks, named tabs and
  // Shield's local programs included). `deep` is a connector's place inside it.
  function open(q, deep) {
    if (!isVeda()) return { ok: false, reason: 'no_bridge' };
    var p = find(q);
    if (!p) return { ok: false, reason: 'not_found' };
    var c = CONNECTORS[p.id];
    if (deep && c && c.deep) {
      var u = c.deep(deep, p);
      if (u) return openDeep(u, p.tab || ('neo_' + p.id));
    }
    if (p.src === 'builtin') return p.openFn();
    if (p.src === 'warden') {
      // It replaces this page, so Neo finishes speaking first.
      if (!window._gotoWarden) return { ok: false, reason: 'no_bridge' };
      setTimeout(window._gotoWarden, 2600); return true;
    }
    if (p.src === 'header' && window._navOpenLink) { window._navOpenLink('veda', p.ref); return true; }
    if (p.src === 'lifehub' && window.LifeHub && window.LifeHub.launch && window.LifeHub.launch('veda', p.ref)) return true;
    return openUrl(p.url, 'neo_' + p.id);
  }

  function opsOf(id) { var c = CONNECTORS[id]; return (c && c.ops) || {}; }
  function opInfo(program, op) {
    var p = find(program); if (!p) return null;
    var o = opsOf(p.id)[op]; return o ? { program: p, op: o } : null;
  }

  // The worker's schema carries args as [{k, v}] (Gemini's schema has no free
  // objects); tests and the page may pass a plain object.
  function argsOf(a) {
    if (!Array.isArray(a)) return (a && typeof a === 'object') ? a : {};
    var o = {}; a.forEach(function (x) { if (x && x.k) o[String(x.k)] = x.v; }); return o;
  }

  // Run one operation inside a program.
  function run(program, op, args) {
    if (!isVeda()) return { ok: false, reason: 'no_bridge' };
    args = argsOf(args);
    var p = find(program);
    if (!p) return { ok: false, reason: 'not_found' };
    var o = opsOf(p.id)[op];
    if (!o || typeof o.run !== 'function') return { ok: false, reason: 'no_op' };
    var go = function () {
      try {
        var r = o.run(args || {}, p);
        if (r && typeof r.then === 'function') return r.then(function (v) { refreshSoon(p.id); return v; }, function () { return { ok: false, reason: 'failed' }; });
        refreshSoon(p.id);
        return r;
      } catch (e) { return { ok: false, reason: 'failed' }; }
    };
    return gated(p.id, go);
  }

  // ── summaries (state.programs) ───────────────────────────────────────────
  // Each connector's summary() may be async; the last answer is kept here and
  // refreshed every 5 minutes and after Neo's own changes, so a turn never waits.
  var SUM = {}, SUM_AT = {}, EVERY = 5 * 60 * 1000;
  function refresh(id) {
    var c = CONNECTORS[id]; if (!c || typeof c.summary !== 'function') return Promise.resolve();
    if (locked(id)) { delete SUM[id]; SUM_AT[id] = 0; return Promise.resolve(); }   // nothing read while it is locked
    SUM_AT[id] = Date.now();
    return Promise.resolve().then(function () { return c.summary(); })
      .then(function (s) { if (s != null) SUM[id] = s; }, function () {});
  }
  function refreshSoon(id) { setTimeout(function () { refresh(id); }, 1500); }
  function refreshAll(force) {
    if (!isVeda()) return Promise.resolve();
    return Promise.all(Object.keys(CONNECTORS).map(function (id) {
      if (!force && SUM_AT[id] && Date.now() - SUM_AT[id] < EVERY) return null;
      return refresh(id);
    }));
  }

  // What the worker sees: every linked program, with what Neo may do in it.
  function state() {
    if (!isVeda()) return [];
    refreshAll(false);
    return list().slice(0, 40).map(function (p) {
      var o = { id: p.id, label: p.label };
      var ops = opsOf(p.id), names = Object.keys(ops);
      if (names.length) o.ops = names.map(function (n) { return n + (ops[n].args ? '(' + ops[n].args + ')' : '()'); });
      if (locked(p.id)) o.summary = 'Locked. Neo cannot see inside until Veda unlocks it herself.';
      else if (SUM[p.id] != null) o.summary = SUM[p.id];
      return o;
    });
  }

  window._vdNeoPrograms = {
    list: list,
    find: find,
    open: open,
    run: run,
    opInfo: opInfo,
    state: state,
    refreshAll: refreshAll,
    register: function (id, c) { if (id && c) { CONNECTORS[id] = c; SUM_AT[id] = 0; } },
    norm: norm,
    // The best match for what she said among `items` (a page title, a plan, a list):
    // exact, then whole words either way, then every word she said.
    pick: function (items, q, key) {
      var n = norm(q); if (!n) return null;
      var f = function (x) { return norm(key ? x[key] : x); };
      return items.filter(function (x) { return f(x) === n; })[0]
        || items.filter(function (x) { var l = ' ' + f(x) + ' '; return l.indexOf(' ' + n + ' ') >= 0 || (' ' + n + ' ').indexOf(l) >= 0; })[0]
        || items.filter(function (x) { var l = ' ' + f(x) + ' '; return n.split(' ').every(function (w) { return l.indexOf(' ' + w) >= 0; }); })[0]
        || null;
    },
    _test: { KNOWN: KNOWN, BUILTINS: BUILTINS, addrKey: addrKey, connectors: CONNECTORS, summaries: SUM, refresh: refresh },
  };
})();
