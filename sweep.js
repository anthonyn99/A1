/*
 * A1 self-cleanup, browser half.
 *
 * What counts as trash is not decided here. It is listed in cleanup-rules.json,
 * which magi/sweep.py and tests/cleanup-rules.test.js read too. This file only
 * runs the "localStorage" and "firestore" items of the program that loads it:
 *
 *   <script src="sweep.js" data-program="index" defer></script>
 *
 * The limits are hard rules (tests/cleanup-rules.test.js pins them):
 *   - Nothing happens on boot. The first run waits firstRunDelayMs and then an
 *     idle callback, so it never competes with the page's own start-up.
 *   - At most one sweep per program per day, stamped in localStorage. If the
 *     stamp can't be written (Veda's Brave throws on any storage access), it
 *     doesn't sweep at all, because it can't promise "once a day".
 *   - Firestore: zero reads. It deletes only fixed doc ids from the rules, at
 *     most firestoreDeletesPerSweep, and only through the page's own adapter
 *     (window._a1SweepFirestore), which says when the boot write guard has
 *     cleared. A delete that succeeded is remembered, so it is never repeated.
 *   - Fail closed: rules that won't load or have an unexpected shape mean
 *     nothing is deleted that run.
 *   - An item with "delete": false is a dry run. It is listed in the report and
 *     left alone. In the console: A1Sweep.report(), or A1Sweep.run({force:true}).
 */
(function () {
  'use strict';
  if (window.A1Sweep) return;

  var me = document.currentScript;
  var PROGRAM = (me && me.getAttribute('data-program')) || '';
  var RULES_URL = (me && me.src ? me.src.replace(/sweep\.js(\?.*)?$/, '') : '') + 'cleanup-rules.json';
  var STAMP = 'a1_sweep_day:' + PROGRAM;
  var REPORT = 'a1_sweep_report:' + PROGRAM;
  var DONE = 'a1_sweep_done';
  var STORES = { localStorage: 1, firestore: 1, kv: 1, disk: 1 };
  var CATEGORIES = { failed: 1, unused: 1, outdated: 1, corrupt: 1 };
  var DOC_RE = /^dashboards\/[A-Za-z0-9_-]+$/;

  function store() { try { return window.localStorage || null; } catch (e) { return null; } }
  function get(k) { var s = store(); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(k, v) { var s = store(); try { if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  // Throws on anything unexpected, which aborts the whole run.
  function check(rules) {
    if (!rules || rules.version !== 1 || !Array.isArray(rules.items) || !rules.limits) throw new Error('rules: bad shape');
    var max = rules.limits.firestoreDeletesPerSweep;
    if (typeof max !== 'number' || max < 0 || max > 25) throw new Error('rules: firestoreDeletesPerSweep out of range');
    var ids = {};
    rules.items.forEach(function (it) {
      if (!it || typeof it.id !== 'string' || ids[it.id]) throw new Error('rules: bad or duplicate id');
      ids[it.id] = 1;
      if (!STORES[it.store] || !CATEGORIES[it.category]) throw new Error('rules: ' + it.id + ' has an unknown store or category');
      if (typeof it.delete !== 'boolean' || typeof it.capDays !== 'number') throw new Error('rules: ' + it.id + ' lacks delete/capDays');
      if (!it.owner || !it.reason) throw new Error('rules: ' + it.id + ' lacks an owner or a reason');
      if (it.store === 'firestore' && !DOC_RE.test(it.doc || '')) throw new Error('rules: ' + it.id + ' is not a fixed doc id');
      // A key in localStorage has no timestamp, so only "gone on the first sweep" works there.
      if (it.store === 'localStorage' && it.capDays !== 0) throw new Error('rules: ' + it.id + ' localStorage items cannot age');
    });
    return rules;
  }

  function matches(it, k) {
    if ((it.exact || []).indexOf(k) !== -1) return true;
    return (it.prefix || []).some(function (p) { return p && k.indexOf(p) === 0; });
  }

  function doneList() { try { return JSON.parse(get(DONE) || '[]') || []; } catch (e) { return []; } }

  // Works out the run without touching anything.
  function plan(rules) {
    var mine = rules.items.filter(function (it) { return it.program === PROGRAM; });
    var out = { ls: [], fs: [] };
    var s = store();
    var keys = [];
    if (s) { for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k) keys.push(k); } }
    mine.forEach(function (it) {
      if (it.store === 'localStorage') {
        keys.forEach(function (k) { if (matches(it, k)) out.ls.push({ id: it.id, key: k, del: it.delete }); });
      } else if (it.store === 'firestore') {
        if (doneList().indexOf(it.id) === -1) out.fs.push({ id: it.id, doc: it.doc, del: it.delete });
      }
    });
    return out;
  }

  var running = null;
  function run(opts) {
    opts = opts || {};
    if (running) return running;
    running = (async function () {
      var rep = { program: PROGRAM, at: new Date().toISOString(), deleted: [], wouldDelete: [], skipped: [], error: null };
      try {
        if (!PROGRAM) throw new Error('no data-program on the script tag');
        if (!opts.force && get(STAMP) === today()) { rep.skipped.push('already swept today'); return rep; }
        // Stamp first: a crash half-way must not turn into a sweep on every load.
        if (!set(STAMP, today())) throw new Error('localStorage unavailable; not sweeping');
        var res = await fetch(RULES_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error('rules: HTTP ' + res.status);
        var rules = check(await res.json());
        var p = plan(rules);
        var dry = !!opts.dryRun;

        p.ls.forEach(function (x) {
          if (!x.del || dry) { rep.wouldDelete.push(x.id + ': localStorage ' + x.key); return; }
          try { localStorage.removeItem(x.key); rep.deleted.push(x.id + ': localStorage ' + x.key); }
          catch (e) { rep.skipped.push(x.id + ': ' + x.key + ' (' + e.message + ')'); }
        });

        var fsa = window._a1SweepFirestore;
        var budget = rules.limits.firestoreDeletesPerSweep;
        for (var i = 0; i < p.fs.length; i++) {
          var x = p.fs[i];
          if (!x.del || dry) { rep.wouldDelete.push(x.id + ': Firestore ' + x.doc + ' (if it exists)'); continue; }
          if (!fsa || typeof fsa.del !== 'function' || !fsa.ready || !fsa.ready()) { rep.skipped.push(x.id + ': Firestore not ready (write guard)'); continue; }
          if (budget <= 0) { rep.skipped.push(x.id + ': over the per-sweep delete cap'); continue; }
          budget--;
          try {
            await fsa.del(x.doc);
            var d = doneList(); d.push(x.id); set(DONE, JSON.stringify(d));
            rep.deleted.push(x.id + ': Firestore ' + x.doc);
          } catch (e) { rep.skipped.push(x.id + ': ' + (e && e.message)); }
        }
      } catch (e) {
        rep.error = String(e && e.message || e);
      }
      set(REPORT, JSON.stringify(rep));
      if (rep.deleted.length || rep.wouldDelete.length || rep.error) {
        console.info('[A1Sweep ' + PROGRAM + '] deleted ' + rep.deleted.length + ', would delete ' + rep.wouldDelete.length +
          (rep.error ? ', stopped: ' + rep.error : '') + '. A1Sweep.report() for the list.');
      }
      return rep;
    })();
    running.then(function () { running = null; }, function () { running = null; });
    return running;
  }

  function report() { try { return JSON.parse(get(REPORT) || 'null'); } catch (e) { return null; } }

  window.A1Sweep = { run: run, report: report, program: PROGRAM };

  // Off the hot path: a minute after load, then whenever the browser is idle.
  function later() {
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1); };
    idle(function () { run(); }, { timeout: 30000 });
  }
  function arm() { setTimeout(later, 60000); }
  if (document.readyState === 'complete') arm();
  else window.addEventListener('load', arm, { once: true });
})();
