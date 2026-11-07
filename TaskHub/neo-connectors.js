/* ════════════════════════════════════════════════════════════════════════════
   Neo inside Veda's programs — the connectors (TaskHub/neo-programs.js).
   Docs: docs/TaskHub/neo-assistant.md ("Programs").

   One connector per program: summary() is what Neo can tell her about it
   (sent as state.programs[].summary), and ops are what it may do there.
   Every op answers true, {ok:false, reason, say?} or a promise of one; an op
   that reads something aloud answers {ok:true, say}, which Neo speaks after
   its reply. VEDA'S SIDE ONLY: the registry refuses every call off her side.

   Phase 1 (2026-11-06): V's Notebook, Plans, Shruti, MAGI (T).
   Each writes the way its own program does:
     · Notebook  only through Notebook's API (pages, page, putPage, open)
     · Plans     only through PlansCore, as Veda
     · Shruti    field-path patches on dashboards/shruti_veda (never setDoc)
     · MAGI      reads dashboards/magi_veda; asking hands MAGI the question
                 through its own #tb= link (A1Debrief), and MAGI runs it
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var R = window._vdNeoPrograms;
  if (!R || window._vdNeoConnectors) return;

  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function timeout(ms, v) { return new Promise(function (res) { setTimeout(function () { res(v); }, ms); }); }
  function race(p, ms, v) { return Promise.race([Promise.resolve(p).catch(function () { return v; }), timeout(ms, v)]); }
  function day(t) { if (!t) return ''; var d = new Date(typeof t === 'number' ? t : String(t)); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function list3(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function str(v) { return String(v == null ? '' : v).trim(); }
  var bad = function (reason, say) { var o = { ok: false, reason: reason }; if (say) o.say = say; return o; };
  var spoken = function (say) { return { ok: true, say: say }; };

  /* ── V's Notebook ─────────────────────────────────────────────────────── */
  var NB = 'bj';
  function nbReady() { var N = window.Notebook; return !!(N && N.mounts && N.mounts[NB] && N.pages && N.page); }
  function nbPages() { return nbReady() ? race(window.Notebook.pages(NB), 8000, null) : Promise.resolve(null); }
  function nbFind(title) {
    return nbPages().then(function (ps) {
      if (!ps) return bad('journal_not_ready');
      var p = R.pick(ps, title, 'title');
      return p || bad('not_found', 'I can\'t find a page called ' + (str(title) || 'that') + ' in your notebook.');
    });
  }
  function nbPage(title) {
    return nbFind(title).then(function (m) {
      if (m.ok === false) return m;
      return race(window.Notebook.page(NB, m.id), 8000, null).then(function (p) { return p || bad('journal_not_ready'); });
    });
  }
  var LOCKED_PAGE = 'That page has its own lock, so I can\'t read it.';
  R.register('notebook', {
    lock: 'veda_journal',
    summary: function () {
      return nbPages().then(function (ps) {
        if (!ps) return null;
        var rec = ps.filter(function (p) { return !p.pinned; }).sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
        return rec.length + ' pages. Most recent: ' + rec.slice(0, 12).map(function (p) {
          return '"' + clip(p.title || 'Untitled', 60) + '" (' + day(p.updated) + (p.locked ? ', locked' : '') + ')';
        }).join('; ') + '.';
      });
    },
    ops: {
      read_page: { args: 'title', run: function (a) {
        return nbPage(a.title).then(function (p) {
          if (p.ok === false) return p;
          if (p.locked) return bad('locked', LOCKED_PAGE);
          var t = clip(p.text, 900);
          return spoken((p.title || 'Untitled') + '. ' + (t || 'It\'s empty.'));
        });
      } },
      find: { args: 'words', run: function (a) {
        var q = R.norm(a.words || a.text || a.title);
        if (!q) return bad('invalid');
        return nbPages().then(function (ps) {
          if (!ps) return bad('journal_not_ready');
          var words = q.split(' ');
          return Promise.all(ps.filter(function (p) { return !p.locked; }).map(function (m) {
            return window.Notebook.page(NB, m.id).then(function (p) { return p; }, function () { return null; });
          })).then(function (all) {
            var hits = all.filter(function (p) {
              var t = ' ' + R.norm((p && p.title) + ' ' + (p && p.text)) + ' ';
              return p && words.every(function (w) { return t.indexOf(' ' + w) >= 0; });
            }).sort(function (x, y) { return (y.updated || 0) - (x.updated || 0); });
            if (!hits.length) return spoken('No page mentions ' + str(a.words || a.text || a.title) + '.');
            var names = hits.slice(0, 5).map(function (p) { return p.title || 'Untitled'; });
            return spoken((hits.length === 1 ? 'One page: ' : hits.length + ' pages' + (hits.length > 5 ? ', the latest' : '') + ': ') + list3(names) + '.');
          });
        });
      } },
      open_page: { args: 'title', run: function (a) {
        return nbFind(a.title).then(function (m) {
          if (m.ok === false) return m;
          if (window._vedaNav) window._vedaNav('journal');
          return race(window.Notebook.open(NB, m.id), 9000, false).then(function (v) { return v ? true : bad('journal_not_ready'); });
        });
      } },
      new_page: { args: 'title?, text', run: function (a) {
        var text = str(a.text); if (!text || !nbReady()) return bad(text ? 'journal_not_ready' : 'invalid');
        var d = new Date();
        return race(window.Notebook.putPage(NB, { id: 'neo' + d.getTime().toString(36), title: str(a.title) || ('Note · ' + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })),
          data: { html: text.split(/\n+/).map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') }, tags: [], folder: null }), 10000, null)
          .then(function (p) { return p ? true : bad('journal_not_ready'); });
      } },
      append: { args: 'title, text', run: function (a) {
        var text = str(a.text); if (!text) return bad('invalid');
        return nbPage(a.title).then(function (p) {
          if (p.ok === false) return p;
          if (p.locked) return bad('locked', LOCKED_PAGE);
          if (p.template !== 'page' || p.pinned) return bad('invalid', 'I can only add to an ordinary page.');
          var html = (p.html || '') + text.split(/\n+/).map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('');
          return race(window.Notebook.putPage(NB, { id: p.id, data: { html: html } }), 10000, null).then(function (r) { return r ? true : bad('failed'); });
        });
      } },
      tag: { args: 'title, tag', run: function (a) {
        var tag = str(a.tag).replace(/^#/, ''); if (!tag) return bad('invalid');
        return nbPage(a.title).then(function (p) {
          if (p.ok === false) return p;
          if (p.locked) return bad('locked', LOCKED_PAGE);
          if (p.template !== 'page' || p.pinned) return bad('invalid', 'I can only tag an ordinary page.');
          var tags = (p.tags || []).filter(function (t) { return R.norm(t) !== R.norm(tag); }).concat([tag]);
          return race(window.Notebook.putPage(NB, { id: p.id, tags: tags }), 10000, null).then(function (r) { return r ? true : bad('failed'); });
        });
      } },
    },
  });

  /* ── Plans (her plans with Tony; state.plans already lists them) ───────── */
  function planNamed(title) {
    var PC = window.PlansCore; if (!PC || !PC.bucket) return null;
    var b = PC.bucket(), seen = {}, all = [];
    ['mine', 'overdue', 'confirmed', 'proposed', 'ideas', 'archive'].forEach(function (k) { (b[k] || []).forEach(function (p) { if (p && !seen[p.id]) { seen[p.id] = 1; all.push(p); } }); });
    return R.pick(all, title, 'title');
  }
  function planResult(v) {
    if (v === 'ok') return true;
    if (v === 'pending') return spoken('It\'s agreed with Tony, so I\'ve sent him the change to approve.');
    if (v === 'nochange') return bad('already', 'It\'s already at that time.');
    if (v === 'bioFailed') return bad('bioFailed');
    return bad('failed');
  }
  var DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
  R.register('plans', {
    lock: 'veda_taskhub',
    ops: {
      edit: { args: 'title, new_title?, date? (YYYY-MM-DD), time? (HH:MM), notes?', run: function (a) {
        var PC = window.PlansCore, p = planNamed(a.title);
        if (!PC || !PC.applyEdit) return bad('no_bridge');
        if (!p) return bad('not_found');
        var d = DATE.test(str(a.date)) ? a.date : p.date || null, tm = TIME.test(str(a.time)) ? a.time : p.time || null;
        return Promise.resolve(PC.applyEdit(p.id, str(a.new_title) || p.title, a.notes != null ? str(a.notes) : (p.notes || ''), d, tm)).then(planResult);
      } },
      reschedule: { args: 'title, date (YYYY-MM-DD), time? (HH:MM), reason?', run: function (a) {
        var PC = window.PlansCore, p = planNamed(a.title);
        if (!PC || !PC.proposeReschedule) return bad('no_bridge');
        if (!p) return bad('not_found');
        if (!DATE.test(str(a.date))) return bad('invalid');
        return Promise.resolve(PC.proposeReschedule(p.id, a.date, TIME.test(str(a.time)) ? a.time : null, str(a.reason))).then(planResult);
      } },
      remove_idea: { args: 'title', confirm: function (a) { return 'delete the plan idea ' + (str(a.title) || 'that'); }, run: function (a) {
        var PC = window.PlansCore, p = planNamed(a.title);
        if (!PC || !PC.removePlan) return bad('no_bridge');
        if (!p) return bad('not_found');
        if (p.stage !== 'idea') return bad('invalid', 'Only an idea can be deleted from here. A plan with Tony is cancelled together.');
        PC.removePlan(p.id); return true;
      } },
    },
  });

  /* ── Shruti (dashboards/shruti_veda; the Gita) ─────────────────────────── */
  var SH_DOC = 'dashboards/shruti_veda', BOOK = 'gita', MODES = ['read', 'listen', 'watch', 'study', 'lessons'];
  var bookP = null;
  function gitaBook() {
    if (!bookP) bookP = fetch('Shruti/books/gita/book.json').then(function (r) { return r.json(); }).catch(function () { bookP = null; return null; });
    return bookP;
  }
  function chTitle(b, n) {
    if (!b) return '';
    if (n === 0) return 'Introduction';
    var c = (b.chapters || []).filter(function (x) { return x.n === n; })[0];
    return c ? c.title : '';
  }
  function chName(b, n) { return n === 0 ? 'the Introduction' : 'Chapter ' + n + (chTitle(b, n) ? ', ' + chTitle(b, n) : ''); }
  // "4", "chapter four", "intro" → 4 / 0; null when it names no chapter.
  var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18 };
  function chOf(v) {
    var s = R.norm(v).replace(/^chapter /, '');
    if (/^intro/.test(s)) return 0;
    var n = /^\d+$/.test(s) ? parseInt(s, 10) : NUMW[s];
    return n >= 0 && n <= 18 ? n : null;
  }
  function shDoc() { return window._fbNeoGet ? race(window._fbNeoGet(SH_DOC), 8000, null) : Promise.resolve(null); }
  function shProgress(doc) { return ((doc && doc.progress) || {})[BOOK] || {}; }
  function markCh(n, done) {
    if (!window._fbNeoPatch) return Promise.resolve(bad('no_bridge'));
    var base = 'progress.' + BOOK + '.ch' + n, now = Date.now(), f = {};
    f[base + '.f'] = done ? 1 : 0; f[base + '.done'] = !!done; f[base + '.modes.read'] = done ? 1 : 0; f[base + '.at'] = now;
    f.last = { book: BOOK, n: n, at: now };
    return window._fbNeoPatch(SH_DOC, f).then(function (ok) { return ok ? true : bad('failed'); });
  }
  R.register('shruti', {
    lock: 'veda_shruti',
    // { n, mode } → a place in Shruti, on her profile.
    deep: function (d, p) {
      var n = typeof d === 'object' ? d.n : chOf(d); if (n == null) return null;
      var base = String(p.url || 'https://anthonyn99.github.io/A1/shruti.html').split('#')[0];
      base += (base.indexOf('?') >= 0 ? '&' : '?') + 'profile=veda';
      return base + '#/b/' + BOOK + '/' + n + (d.mode && MODES.indexOf(d.mode) >= 0 ? '/' + d.mode : '');
    },
    summary: function () {
      return Promise.all([shDoc(), gitaBook()]).then(function (r) {
        var doc = r[0], b = r[1]; if (!doc) return null;
        var pr = shProgress(doc), read = [], going = [];
        Object.keys(pr).forEach(function (k) {
          var n = parseInt(k.replace(/^ch/, ''), 10), c = pr[k] || {}; if (isNaN(n)) return;
          if (c.done) read.push(n); else if (Number(c.f) > 0) going.push(n + ' (' + Math.round(c.f * 100) + '%)');
        });
        read.sort(function (x, y) { return x - y; });
        var next = null; for (var i = 1; i <= 18; i++) if (read.indexOf(i) < 0) { next = i; break; }
        var last = doc.last && doc.last.book === BOOK ? doc.last.n : null;
        var marks = 0; Object.keys(((doc.bookmarks || {})[BOOK]) || {}).forEach(function (k) { marks += Object.keys(doc.bookmarks[BOOK][k] || {}).length; });
        return 'Bhagavad-Gita, 18 chapters plus an Introduction; each has Read, Listen (podcast), Watch (video), Study and Lessons. ' +
          (last != null ? 'Last opened: ' + chName(b, last) + '. ' : '') +
          'Read: ' + (read.length ? read.map(function (n) { return n === 0 ? 'Intro' : n; }).join(', ') : 'none yet') + '. ' +
          (going.length ? 'In progress: ' + going.join(', ') + '. ' : '') +
          (next ? 'Next unread: ' + chName(b, next) + '. ' : 'Every chapter is read. ') +
          'Bookmarks: ' + marks + '.';
      });
    },
    ops: {
      open_chapter: { args: 'chapter (number or "intro"), mode? (read|listen|watch|study|lessons)', run: function (a) {
        var n = chOf(a.chapter); if (n == null) return bad('invalid');
        return R.open('shruti', { n: n, mode: str(a.mode).toLowerCase() || '' });
      } },
      continue: { args: '', run: function () {
        return shDoc().then(function (doc) {
          var l = doc && doc.last && doc.last.book === BOOK ? doc.last.n : 1;
          return R.open('shruti', { n: l });
        });
      } },
      mark_read: { args: 'chapter', run: function (a) { var n = chOf(a.chapter); return n == null ? bad('invalid') : markCh(n, true); } },
      mark_unread: { args: 'chapter', run: function (a) { var n = chOf(a.chapter); return n == null ? bad('invalid') : markCh(n, false); } },
    },
  });

  /* ── MAGI (T): the A1 MAGI page, her profile (dashboards/magi_veda) ────── */
  var MG_DOC = 'dashboards/magi_veda';
  function mgRuns() {
    if (!window._fbNeoGet) return Promise.resolve(null);
    return race(window._fbNeoGet(MG_DOC), 8000, null).then(function (d) { return d && Array.isArray(d.runs) ? d.runs : (d ? [] : null); });
  }
  R.register('magi', {
    lock: 'veda_magi',
    summary: function () {
      return mgRuns().then(function (runs) {
        if (!runs) return null;
        if (!runs.length) return 'No deliberations yet.';
        return 'Recent questions to the council: ' + runs.slice(0, 8).map(function (r) {
          return '"' + clip(r.question, 120) + '" (' + day(r.created_at) + (r.status && r.status !== 'complete' ? ', ' + r.status : '') + ')';
        }).join('; ') + '.';
      });
    },
    ops: {
      ask: { args: 'question', confirm: function (a) { return 'ask the MAGI council: ' + clip(a.question, 140) + '. It uses your AI accounts'; }, run: function (a, p) {
        var q = str(a.question), D = window.A1Debrief;
        if (!q) return bad('invalid');
        if (!D || !D.b64u || !D.openMagi) return bad('no_bridge');
        var payload = { v: 1, src: 'neo', q: q, units: [], run: 1, t: Date.now(), p: 'veda' };
        var url = String(p.url || 'https://anthonyn99.github.io/A1/magi.html').split('#')[0] + '#tb=' + D.b64u(JSON.stringify(payload));
        return D.openMagi(url) === false ? bad('blocked') : true;
      } },
      read_answer: { args: 'question? (latest if left out)', run: function (a) {
        return mgRuns().then(function (runs) {
          if (!runs) return bad('no_bridge');
          var r = str(a.question) ? R.pick(runs, a.question, 'question') : runs[0];
          if (!r) return bad('not_found', 'I can\'t find a question like that in MAGI.');
          return race(window._fbNeoGet(MG_DOC + '/runs/' + r.id), 8000, null).then(function (d) {
            var s = d && d.synthesis;
            if (!s || !s.synthesis_ok || !s.verdict) return spoken('"' + clip(r.question, 100) + '" has no verdict yet.');
            return spoken('On "' + clip(r.question, 100) + '": ' + clip(s.verdict, 900));
          });
        });
      } },
    },
  });

  window._vdNeoConnectors = { chOf: chOf, clip: clip, gitaBook: gitaBook };
})();
