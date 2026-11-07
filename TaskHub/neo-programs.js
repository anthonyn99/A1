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
  var KNOWN = [
    { id: 'studyos', re: /\/studyos\/?(index\.html)?(?=[?#]|$)/i, aliases: ['study os', 'studies', 'my classes'] },
    { id: 'tradeboard', re: /\/tradeboard\.html(?=[?#]|$)/i, aliases: ['trade board', 'trading'] },
    { id: 'mylist', re: /\/mylist\.html(?=[?#]|$)/i, aliases: ['my list', 'my lists', 'lists'] },
    { id: 'wellness', re: /\/wellness\.html(?=[?#]|$)/i, aliases: ['wellness tracker'] },
    { id: 'magi', re: /\/magi\.html(?=[?#]|$)/i, aliases: ['maggie', 'magic'] },
    { id: 'shruti', re: /\/shruti\.html(?=[?#]|$)/i, aliases: ['shruti app'] },
    { id: 'shield', re: /\/shield\.html(?=[?#]|$)/i, aliases: ['shield web'] },
  ];
  var WARDEN = { id: 'warden', label: 'Warden', url: 'https://vedacpatel.github.io/warden/warden.html', aliases: ['my links', 'links', 'links page'], src: 'warden' };
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
      var k = addrKey(e.url);
      if (seen[k]) return;
      var kn = knownFor(e.url);
      if (kn) { e.id = kn.id; e.aliases = kn.aliases; }
      if (out.some(function (x) { return x.id === e.id; })) return;
      seen[k] = 1; out.push(e);
    }
    var links = []; try { links = (window._navGetLinks && window._navGetLinks('veda')) || []; } catch (e) {}
    links.forEach(function (l) { if (l && l.label) put({ id: 'link:' + l.id, label: l.label, url: l.url, aliases: [], src: 'header', ref: l.id }); });
    var apps = []; try { apps = (window.LifeHub && window.LifeHub.list && window.LifeHub.list('veda')) || []; } catch (e) {}
    apps.forEach(function (a) { if (a && a.name && !a.hidden) put({ id: 'lh:' + a.id, label: a.name, url: a.url, aliases: [], src: 'lifehub', ref: a.id }); });
    put(Object.assign({}, WARDEN));
    return out;
  }

  // A program by id, label or alias (what she said, or what the model copied).
  function find(q) {
    var all = list(), n = norm(q);
    if (!n) return null;
    var by = function (f) { return all.filter(f)[0] || null; };
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

  // Opens it the way its own button or tile does (locks, named tabs and
  // Shield's local programs included). `deep` is a connector's place inside it.
  function open(q, deep) {
    if (!isVeda()) return { ok: false, reason: 'no_bridge' };
    var p = find(q);
    if (!p) return { ok: false, reason: 'not_found' };
    var c = CONNECTORS[p.id];
    if (deep && c && c.deep) {
      var u = c.deep(deep, p);
      if (u) return openUrl(u, 'neo_' + p.id);
    }
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
    try {
      var r = o.run(args || {}, p);
      if (r && typeof r.then === 'function') return r.then(function (v) { refreshSoon(p.id); return v; }, function () { return { ok: false, reason: 'failed' }; });
      refreshSoon(p.id);
      return r;
    } catch (e) { return { ok: false, reason: 'failed' }; }
  }

  // ── summaries (state.programs) ───────────────────────────────────────────
  // Each connector's summary() may be async; the last answer is kept here and
  // refreshed every 5 minutes and after Neo's own changes, so a turn never waits.
  var SUM = {}, SUM_AT = {}, EVERY = 5 * 60 * 1000;
  function refresh(id) {
    var c = CONNECTORS[id]; if (!c || typeof c.summary !== 'function') return Promise.resolve();
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
      if (SUM[p.id] != null) o.summary = SUM[p.id];
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
    _test: { KNOWN: KNOWN, addrKey: addrKey, connectors: CONNECTORS, summaries: SUM },
  };
})();
