/* ════════════════════════════════════════════════════════════════════════════
   Neo inside Veda's programs — the connectors (TaskHub/neo-programs.js).
   Docs: docs/TaskHub/neo-assistant.md ("Programs").

   One connector per program: summary() is what Neo can tell her about it
   (sent as state.programs[].summary), and ops are what it may do there.
   Every op answers true, {ok:false, reason, say?} or a promise of one; an op
   that reads something aloud answers {ok:true, say}, which Neo speaks after
   its reply. VEDA'S SIDE ONLY: the registry refuses every call off her side.

   Phase 1 (2026-11-06): V's Notebook, Plans, Shruti, MAGI (T). Phase 2: StudyOS. Phase 3: MyList.
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

  /* ── StudyOS (STUDY; dashboards/studyos, studyos_cards/<class>, …) ────────
     Phase 2 (2026-11-06). StudyOS saves its main document WHOLE (setDoc, no
     merge) and an open tab takes a remote copy's arrays wholesale. So every
     write here is a transaction on the server copy that changes one item by
     id and updates only that array; the objects are built exactly as
     StudyOS's own forms build them. An open tab saving at the same moment can
     still write over it, so the change is looked for again 3 s later and put
     back (by id, so never twice) if it is gone. Notes are pages in StudyOS's
     Notebook (dashboards/studyos_notebook), in a Notes module's folder only:
     a note in a documents module would render nowhere. Cards follow StudyOS's
     cards v2 (random id, content fingerprint, a duplicate is not added). */
  var SOS = 'dashboards/studyos', SOS_NB = 'dashboards/studyos_notebook';
  var TASK_TYPES = ['hw', 'quiz', 'exam', 'lab', 'lecture', 'other'], PRIOS = ['high', 'medium', 'low'];
  function sosUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function sosGet(path) { return window._fbNeoGet ? race(window._fbNeoGet(path || SOS), 10000, null) : Promise.resolve(null); }
  function classOf(doc, q) {
    var cs = (doc && doc.classes) || [];
    if (!str(q)) return null;
    return R.pick(cs, q, 'name') || R.pick(cs, q, 'code') || null;
  }
  function spokenDay(k) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); if (!m) return ''; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
  // The change, written; then looked for again once an open tab has had time to save.
  function sosWrite(path, field, mutate, present, missing) {
    if (!window._fbNeoTx) return Promise.resolve(bad('no_bridge'));
    var why = null;
    var tx = function (d) {
      if (!d) { why = missing || 'no_bridge'; return null; }
      var r = mutate(d);
      if (r && r.ok === false) { why = r; return null; }
      if (r == null) return null;
      var u = {}; u[field] = r; return u;
    };
    return window._fbNeoTx(path, tx).then(function (ok) {
      if (!ok) return why && why.ok === false ? why : bad(why || 'failed');
      setTimeout(function () {
        sosGet(path).then(function (d) { if (d && !present(d)) window._fbNeoTx(path, function (d2) { return d2 && !present(d2) ? tx(d2) : null; }); });
      }, 3000);
      return true;
    });
  }
  function taskNamed(d, q, open) {
    var ts = (d.tasks || []).filter(function (t) { return t && (!open || !t.done); });
    return R.pick(ts, q, 'name');
  }
  function fnv(kind, q, a) {   // StudyOS cards.js fingerprint(), exactly
    var n = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    var s = kind + '|' + n(q) + '|' + n(a), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function cardId() {
    var r = '';
    try { var b = new Uint8Array(8); crypto.getRandomValues(b); r = Array.prototype.map.call(b, function (x) { return x.toString(36); }).map(function (x) { return x.length < 2 ? '0' + x : x; }).join('').slice(0, 12); } catch (e) {}
    return 'cd_' + (r || (Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)));
  }
  function liveCard(c) { return c && !c.deletedAt && (c.status || 'active') === 'active'; }
  R.register('studyos', {
    lock: 'veda_studyos',
    deep: function (d, p) {
      var id = typeof d === 'object' ? d.classId : d; if (!id) return null;
      var base = String(p.url || 'https://tradeboard.vedapatel05.workers.dev/studyos/').split('#')[0];
      return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'class=' + encodeURIComponent(id);
    },
    summary: function () {
      return Promise.all([sosGet(), sosGet('dashboards/studyos_sessions')]).then(function (r) {
        var d = r[0], ss = r[1]; if (!d) return null;
        var cs = d.classes || [], now = new Date(), today = ymd(now), soon = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14));
        var cname = function (id) { var c = cs.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; };
        var tasks = (d.tasks || []).filter(function (t) { return t && !t.done && t.dueDate && t.dueDate <= soon; })
          .sort(function (a, b) { return (a.dueDate + (a.dueTime || '')).localeCompare(b.dueDate + (b.dueTime || '')); });
        var overdue = tasks.filter(function (t) { return t.dueDate < today; }).length;
        var evs = (d.events || []).filter(function (e) { return e && e.date >= today && e.date <= soon; })
          .sort(function (a, b) { return (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')); });
        var item = function (x, dk, tm) { return '"' + clip(x.name, 60) + '"' + (cname(x.classId) ? ' [' + clip(cname(x.classId), 30) + ']' : '') + ' ' + spokenDay(dk) + (tm ? ' ' + tm : '') + (x.type ? ' (' + x.type + ')' : ''); };
        var mins = 0; var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
        ((ss && ss.sessions) || []).forEach(function (s) { if (s && s.startedAt >= monday) mins += (Number(s.durationMs) || 0) / 60000; });
        // Cards due per class: one read per class, in parallel.
        return Promise.all(cs.map(function (c) { return sosGet('studyos_cards/' + c.id); })).then(function (decks) {
          var nowMs = Date.now();
          var due = cs.map(function (c, i) {
            var cards = ((decks[i] && decks[i].cards) || []).filter(liveCard);
            var n = cards.filter(function (k) { return k.sched && k.sched.state !== 'new' && (k.sched.due || 0) <= nowMs; }).length;
            var unseen = cards.filter(function (k) { return !k.sched || k.sched.state === 'new'; }).length;
            return n || unseen ? c.name + ': ' + n + ' due, ' + unseen + ' new' : '';
          }).filter(Boolean);
          return 'Classes: ' + (cs.length ? cs.map(function (c) {
            var notes = (c.modules || []).filter(function (m) { return m && m.type === 'notes'; }).map(function (m) { return m.name; });
            return c.name + (c.code ? ' (' + c.code + ')' : '') + (notes.length ? ', notes modules: ' + notes.join(', ') : '');
          }).join('; ') : 'none') + '. ' +
            'Open tasks due in the next 2 weeks' + (overdue ? ' (' + overdue + ' overdue)' : '') + ': ' + (tasks.length ? tasks.slice(0, 12).map(function (t) { return item(t, t.dueDate, t.dueTime); }).join('; ') : 'none') + '. ' +
            'Events: ' + (evs.length ? evs.slice(0, 10).map(function (e) { return item(e, e.date, e.time); }).join('; ') : 'none') + '. ' +
            'Flashcards: ' + (due.length ? due.join('; ') : 'none due') + '. ' +
            'Studied this week: ' + Math.round(mins) + ' min.';
        });
      });
    },
    ops: {
      add_task: { args: 'title, class?, date? (YYYY-MM-DD), time? (HH:MM), type? (hw|quiz|exam|lab|lecture|other), priority? (high|medium|low)', run: function (a) {
        var name = str(a.title); if (!name) return bad('invalid');
        var id = sosUid();
        return sosWrite(SOS, 'tasks', function (d) {
          var list = (d.tasks || []).slice();
          if (list.some(function (t) { return t && t.id === id; })) return null;
          var c = classOf(d, a.class);
          if (str(a.class) && !c) return bad('not_found', 'I can\'t find a class called ' + str(a.class) + ' in StudyOS.');
          list.push({ id: id, done: false, createdAt: Date.now(), name: name, dueDate: DATE.test(str(a.date)) ? a.date : '', dueTime: TIME.test(str(a.time)) ? a.time : '',
            priority: PRIOS.indexOf(str(a.priority)) >= 0 ? a.priority : 'medium', type: TASK_TYPES.indexOf(str(a.type)) >= 0 ? a.type : 'hw', classId: c ? c.id : '',
            notes: '', notif: 'none', repeat: 'none', repeatDays: [], repeatEndDate: '' });
          return list;
        }, function (d) { return (d.tasks || []).some(function (t) { return t && t.id === id; }); });
      } },
      complete_task: { args: 'title', run: function (a) {
        var id = null;
        return sosWrite(SOS, 'tasks', function (d) {
          var t = id ? (d.tasks || []).filter(function (x) { return x && x.id === id; })[0] : taskNamed(d, a.title, true);
          if (!t) return bad('not_found', 'I can\'t find an open StudyOS task called ' + (str(a.title) || 'that') + '.');
          id = t.id;
          return (d.tasks || []).map(function (x) { return x && x.id === id ? Object.assign({}, x, { done: true }) : x; });
        }, function (d) { return (d.tasks || []).some(function (t) { return t && t.id === id && t.done; }); });
      } },
      move_task: { args: 'title, date (YYYY-MM-DD), time? (HH:MM)', run: function (a) {
        if (!DATE.test(str(a.date))) return bad('invalid');
        var id = null;
        return sosWrite(SOS, 'tasks', function (d) {
          var t = id ? (d.tasks || []).filter(function (x) { return x && x.id === id; })[0] : taskNamed(d, a.title, true);
          if (!t) return bad('not_found', 'I can\'t find an open StudyOS task called ' + (str(a.title) || 'that') + '.');
          id = t.id;
          return (d.tasks || []).map(function (x) { return x && x.id === id ? Object.assign({}, x, { dueDate: a.date }, TIME.test(str(a.time)) ? { dueTime: a.time } : {}) : x; });
        }, function (d) { return (d.tasks || []).some(function (t) { return t && t.id === id && t.dueDate === a.date; }); });
      } },
      remove_task: { args: 'title', run: function (a) {
        var id = null;
        return sosWrite(SOS, 'tasks', function (d) {
          var t = id ? (d.tasks || []).filter(function (x) { return x && x.id === id; })[0] : taskNamed(d, a.title, false);
          if (!t) return id ? null : bad('not_found', 'I can\'t find a StudyOS task called ' + (str(a.title) || 'that') + '.');
          id = t.id;
          return (d.tasks || []).filter(function (x) { return !(x && x.id === id); });
        }, function (d) { return !(d.tasks || []).some(function (t) { return t && t.id === id; }); });
      } },
      add_event: { args: 'title, date (YYYY-MM-DD), time? (HH:MM), class?, type? (exam|quiz|hw|lab|lecture|other)', run: function (a) {
        var name = str(a.title); if (!name || !DATE.test(str(a.date))) return bad('invalid');
        var id = sosUid();
        return sosWrite(SOS, 'events', function (d) {
          var list = (d.events || []).slice();
          if (list.some(function (e) { return e && e.id === id; })) return null;
          var c = classOf(d, a.class);
          if (str(a.class) && !c) return bad('not_found', 'I can\'t find a class called ' + str(a.class) + ' in StudyOS.');
          list.push({ id: id, name: name, date: a.date, time: TIME.test(str(a.time)) ? a.time : '', classId: c ? c.id : '', type: TASK_TYPES.indexOf(str(a.type)) >= 0 ? a.type : 'other',
            weight: 0, notif: 'none', repeat: 'none', repeatDays: [], repeatEndDate: '' });
          return list;
        }, function (d) { return (d.events || []).some(function (e) { return e && e.id === id; }); });
      } },
      remove_event: { args: 'title', run: function (a) {
        var id = null;
        return sosWrite(SOS, 'events', function (d) {
          var e = id ? (d.events || []).filter(function (x) { return x && x.id === id; })[0] : R.pick(d.events || [], a.title, 'name');
          if (!e) return id ? null : bad('not_found', 'I can\'t find a StudyOS event called ' + (str(a.title) || 'that') + '.');
          id = e.id;
          return (d.events || []).filter(function (x) { return !(x && x.id === id); });
        }, function (d) { return !(d.events || []).some(function (e) { return e && e.id === id; }); });
      } },
      add_note: { args: 'text, class?, module? (a Notes module), title?', run: function (a) {
        var text = str(a.text); if (!text) return bad('invalid');
        return sosGet().then(function (d) {
          if (!d) return bad('no_bridge');
          var folder = 'quick', where = 'Quick Notes';
          if (str(a.class)) {
            var c = classOf(d, a.class);
            if (!c) return bad('not_found', 'I can\'t find a class called ' + str(a.class) + ' in StudyOS.');
            var nm = (c.modules || []).filter(function (m) { return m && m.type === 'notes'; });
            var m = str(a.module) ? R.pick(nm, a.module, 'name') : (nm.length === 1 ? nm[0] : null);
            if (!m) return bad('not_found', nm.length ? c.name + ' has more than one Notes module: ' + list3(nm.map(function (x) { return x.name; })) + '. Which one?' : c.name + ' has no Notes module yet.');
            folder = String(m.id); where = c.name + ' ' + m.name;
          }
          var now = Date.now(), id = 'neo' + now.toString(36) + Math.random().toString(36).slice(2, 6);
          var page = { id: id, title: str(a.title) || ('Note · ' + new Date(now).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })), template: 'page', folder: folder,
            created: now, updated: now, tags: [], data: { html: text.split(/\n+/).map(function (x) { return '<p>' + esc(x) + '</p>'; }).join(''), attachments: [] }, rev: 1 };
          // A new page field, and the order with it on top, from the server copy (never a stale order).
          return window._fbNeoTx(SOS_NB, function (nb) {
            nb = nb || {};
            if (nb['e_' + id]) return null;
            var u = { savedAt: now }; u['e_' + id] = page;
            if (Array.isArray(nb._order) && nb._order.length) u._order = [id].concat(nb._order.filter(function (x) { return x !== id; }));
            return u;
          }).then(function (ok) { return ok ? spoken('Noted in ' + where + '.') : bad('failed'); });
        });
      } },
      add_card: { args: 'class, question, answer', run: function (a) {
        var q = str(a.question), ans = str(a.answer); if (!q || !ans) return bad('invalid');
        return sosGet().then(function (d) {
          var c = classOf(d, a.class);
          if (!c) return bad('not_found', 'I can\'t find a class called ' + (str(a.class) || 'that') + ' in StudyOS.');
          var fp = fnv('qa', q, ans), id = cardId(), now = Date.now();
          var path = 'studyos_cards/' + c.id, dup = false;
          return sosWrite(path, 'cards', function (deck) {
            var cards = (deck.cards || []).slice();
            if (cards.some(function (k) { return k && k.id === id; })) return null;
            if (cards.some(function (k) { return k && !k.deletedAt && k.fp === fp; })) { dup = true; return bad('already', 'That card is already in ' + c.name + '.'); }
            cards.push({ id: id, fp: fp, kind: 'qa', q: q, a: ans, classId: c.id, moduleId: '', sourceNoteId: '', sourceTitle: 'Neo', topic: 'Neo', sourceSlide: null,
              createdAt: now, updatedAt: now, source: 'neo', sched: null });
            return cards;
          }, function (deck) { return dup || (deck.cards || []).some(function (k) { return k && k.id === id; }); },
          // A class with no deck yet: StudyOS makes that document itself (with its own meta), not Neo.
          bad('not_found', c.name + ' has no flashcards yet. Make the first one in StudyOS, then I can add more.'));
        });
      } },
      open_class: { args: 'class', run: function (a) {
        return sosGet().then(function (d) {
          var c = classOf(d, a.class);
          if (!c) return bad('not_found', 'I can\'t find a class called ' + (str(a.class) || 'that') + ' in StudyOS.');
          return R.open('studyos', { classId: c.id });
        });
      } },
    },
  });

  /* ── MyList (LIST; dashboards/mylist, her lists only) ─────────────────────
     Phase 3 (2026-11-06). The document holds BOTH profiles (tony, veda) and
     MyList saves it whole, so Neo changes only the field path `veda.lists`,
     in a transaction on the server copy; Tony's lists are never in a write.
     An open MyList tab ignores snapshots for 8 s after its own save, so the
     change is looked for again at 3 s and at 12 s and put back if gone. */
  var ML = 'dashboards/mylist', ML_TYPES = ['shopping', 'packing', 'itinerary', 'todo', 'reminders', 'other'];
  function mlUid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
  function mlLists(d) { return (d && d.veda && Array.isArray(d.veda.lists)) ? d.veda.lists : null; }
  // Which list: the one she named, else her only one.
  function mlList(lists, q) {
    if (str(q)) return R.pick(lists, q, 'name') || bad('not_found', 'You have no list called ' + str(q) + '.');
    if (lists.length === 1) return lists[0];
    return bad('invalid', 'Which list, ' + (lists.length ? list3(lists.map(function (l) { return l.name; })) : 'you have none yet') + '?');
  }
  function mlWrite(mutate, present) {
    if (!window._fbNeoTx) return Promise.resolve(bad('no_bridge'));
    var why = null;
    var tx = function (d) {
      var lists = mlLists(d);
      if (!lists) { why = bad('no_bridge'); return null; }   // never write lists Neo couldn't read
      var r = mutate(JSON.parse(JSON.stringify(lists)));
      if (r && r.ok === false) { why = r; return null; }
      if (r == null) return null;
      return { 'veda.lists': r, savedAt: Date.now() };
    };
    return window._fbNeoTx(ML, tx).then(function (ok) {
      if (!ok) return why || bad('failed');
      [3000, 12000].forEach(function (ms) {
        setTimeout(function () {
          sosGet(ML).then(function (d) { if (d && mlLists(d) && !present(mlLists(d))) window._fbNeoTx(ML, function (d2) { return mlLists(d2) && !present(mlLists(d2)) ? tx(d2) : null; }); });
        }, ms);
      });
      return true;
    });
  }
  function itemIn(l, q, open) {
    // open: true = only items still to do, false = only ticked ones, null = any.
    var its = (l.items || []).filter(function (x) { return x && (open == null || !x.done === open); });
    return R.pick(its, q, 'name');
  }
  R.register('mylist', {
    lock: 'mylist:profile_veda',
    summary: function () {
      return sosGet(ML).then(function (d) {
        var lists = mlLists(d); if (!lists) return null;
        if (!lists.length) return 'No lists yet.';
        return 'Her lists: ' + lists.map(function (l) {
          var open = (l.items || []).filter(function (x) { return x && !x.done; });
          return '"' + l.name + '" (' + (l.type || 'other') + ', ' + open.length + ' to do' + ((l.items || []).length - open.length ? ', ' + ((l.items || []).length - open.length) + ' done' : '') + ')' +
            (open.length ? ': ' + open.slice(0, 10).map(function (x) { return x.name + (x.qty ? ' (' + x.qty + ')' : '') + (x.store ? ' @' + x.store : ''); }).join(', ') : '');
        }).join('; ') + '.';
      });
    },
    ops: {
      read_list: { args: 'list?', run: function (a) {
        return sosGet(ML).then(function (d) {
          var lists = mlLists(d); if (!lists) return bad('no_bridge');
          var l = mlList(lists, a.list); if (l.ok === false) return l;
          var open = (l.items || []).filter(function (x) { return x && !x.done; });
          return spoken(open.length ? l.name + ': ' + list3(open.slice(0, 25).map(function (x) { return x.name + (x.qty ? ', ' + x.qty : ''); })) + '.' : l.name + ' has nothing left on it.');
        });
      } },
      add_item: { args: 'item, list?, qty?, store?', run: function (a) {
        var name = str(a.item || a.name || a.title); if (!name) return bad('invalid');
        var id = mlUid(), lid = null;
        return mlWrite(function (lists) {
          var l = lid ? lists.filter(function (x) { return x.id === lid; })[0] : mlList(lists, a.list); if (!l || l.ok === false) return l || null;
          lid = l.id;
          if ((l.items || []).some(function (x) { return x && x.id === id; })) return null;
          var store = str(a.store);
          if (store) { l.stores = l.stores || []; var f = l.stores.filter(function (s) { return String(s).toLowerCase() === store.toLowerCase(); })[0]; if (f) store = f; else l.stores.push(store); }
          (l.items = l.items || []).push({ id: id, name: name, qty: str(a.qty), store: store, desc: '', done: false });
          return lists;
        }, function (lists) { return lists.some(function (l) { return (l.items || []).some(function (x) { return x && x.id === id; }); }); });
      } },
      check_item: { args: 'item, list?', run: function (a) { return mlTick(a, true); } },
      uncheck_item: { args: 'item, list?', run: function (a) { return mlTick(a, false); } },
      remove_item: { args: 'item, list?', run: function (a) {
        var id = null;
        return mlWrite(function (lists) {
          var hit = mlFindItem(lists, a, null, id); if (!hit) return id ? null : bad('not_found', 'I can\'t find ' + (str(a.item) || 'that') + ' on your lists.');
          if (hit.ok === false) return hit;
          id = hit.it.id; hit.l.items = hit.l.items.filter(function (x) { return !(x && x.id === id); });
          return lists;
        }, function (lists) { return !lists.some(function (l) { return (l.items || []).some(function (x) { return x && x.id === id; }); }); });
      } },
      clear_checked: { args: 'list', confirm: function (a) { return 'clear the ticked items off ' + (str(a.list) || 'that list'); }, run: function (a) {
        var lid = null;
        return mlWrite(function (lists) {
          var l = lid ? lists.filter(function (x) { return x.id === lid; })[0] : mlList(lists, a.list); if (!l || l.ok === false) return l || null;
          lid = l.id;
          var before = (l.items || []).length; l.items = (l.items || []).filter(function (x) { return x && !x.done; });
          return l.items.length === before ? bad('already', 'Nothing on ' + l.name + ' is ticked.') : lists;
        }, function (lists) { return lists.filter(function (l) { return l.id === lid; }).every(function (l) { return !(l.items || []).some(function (x) { return x && x.done; }); }); });
      } },
      new_list: { args: 'name, type? (shopping|packing|itinerary|todo|reminders|other)', run: function (a) {
        var name = str(a.name || a.list); if (!name) return bad('invalid');
        var id = mlUid();
        return mlWrite(function (lists) {
          if (lists.some(function (l) { return l.id === id; })) return null;
          if (lists.some(function (l) { return R.norm(l.name) === R.norm(name); })) return bad('already', 'You already have a list called ' + name + '.');
          lists.push({ id: id, name: name, type: ML_TYPES.indexOf(str(a.type)) >= 0 ? a.type : 'other', stores: [], items: [], createdAt: Date.now() });
          return lists;
        }, function (lists) { return lists.some(function (l) { return l.id === id; }); });
      } },
    },
  });
  // The item she named, on the list she named (or on any list).
  function mlFindItem(lists, a, open, id) {
    if (id) { for (var i = 0; i < lists.length; i++) { var it = (lists[i].items || []).filter(function (x) { return x && x.id === id; })[0]; if (it) return { l: lists[i], it: it }; } return null; }
    var pool = lists;
    if (str(a.list)) { var l = mlList(lists, a.list); if (l.ok === false) return l; pool = [l]; }
    for (var j = 0; j < pool.length; j++) { var hit = itemIn(pool[j], a.item || a.name, open); if (hit) return { l: pool[j], it: hit }; }
    return null;
  }
  function mlTick(a, done) {
    var id = null;
    return mlWrite(function (lists) {
      var hit = mlFindItem(lists, a, id ? null : done, id);   // ticking looks among open items, unticking among ticked
      if (!hit) return bad('not_found', 'I can\'t find ' + (str(a.item) || 'that') + (done ? ' left' : ' ticked') + ' on your lists.');
      if (hit.ok === false) return hit;
      id = hit.it.id; hit.it.done = done;
      return lists;
    }, function (lists) { return lists.some(function (l) { return (l.items || []).some(function (x) { return x && x.id === id && !!x.done === done; }); }); });
  }

  window._vdNeoConnectors = { chOf: chOf, clip: clip, gitaBook: gitaBook, fnv: fnv };
})();
