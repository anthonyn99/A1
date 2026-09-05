/* ═══════════════════════════════════════════════════════════════════════════
 * d2l-sync.js — Brightspace calendar import
 * ---------------------------------------------------------------------------
 * Pulls the student's Brightspace calendar (via the studyos-d2l Worker) and
 * reconciles it into StudyOS's own `events` and `tasks`.
 *
 * SCOPE: the calendar ICS feed is the ONLY Brightspace data a student can
 * reach without an admin-registered OAuth client. Grades, announcements and
 * course files need the Valence API — see ARCHITECTURE.md §8. They are not
 * half-implemented here on purpose.
 *
 * ── The three things that make this safe ──────────────────────────────────
 *
 * 1. ONE-WAY, D2L WINS, BUT ONLY OVER ITS OWN FIELDS. Brightspace owns the
 *    title and the date. StudyOS owns everything Brightspace cannot know:
 *    done, weight, priority, notif, notes. Clobbering those on every sync is
 *    the bug the field-ownership table in reconcile() exists to prevent.
 *
 * 2. `done` SURVIVES THE WHOLESALE REPLACE. studyos.js:3603 assigns
 *    `tasks = remote.tasks` outright on every remote update, so a ticked
 *    import would be lost. _d2lDone below is a module-scope Map that lives
 *    outside the replaced array — the same trick _sosCloudUrls
 *    (js/studyos.js:372) uses to keep file URLs sticky.
 *
 * 3. AN EMPTY FEED NEVER DELETES ANYTHING. An expired Brightspace token
 *    returns an HTML login page, not an error. It parses to zero events, which
 *    without a guard reconciles to "D2L deleted your whole semester". This is
 *    the sharpest edge in the feature; see the guards in reconcile().
 *
 * Talks to studyos.js only through window._sosBridge — getClasses/getEvents/
 * getTasks/getD2LMap to read, applyD2L to write. Nothing here reaches into
 * that file's scope, and nothing there knows what D2L is.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CFG = (window.STUDYOS_CONFIG || {}).cloudflare || {};
  var D2L = CFG.d2l || {};
  var API = String(D2L.baseUrl || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'sos_d2l_token';

  // Degrade cleanly when unconfigured, exactly as taskmirror.js does.
  function enabled() {
    if (!API || D2L.enabled === false) return false;
    if (window.STUDYOS_CONFIG_READY && !window.STUDYOS_CONFIG_READY('cloudflare')) return false;
    return /^https:\/\//.test(API) && API.indexOf('‹REPLACE') === -1;
  }

  var B = null;
  function bridge() { B = window._sosBridge; return B; }

  /* ── Local-state carry-over ───────────────────────────────────────────────
     The problem this solves: studyos.js assigns `tasks = remote.tasks` outright
     on every remote update (js/studyos.js:3603). A task the user ticked is
     replaced by whatever the incoming document says, so without a copy held
     OUTSIDE that array, every tick on an imported item is lost the moment
     another device syncs. _sosCloudUrls (js/studyos.js:372) keeps file URLs
     sticky across the same replace; this is the same trick for `done`.

     Each entry is stamped with WHEN it was observed, and a later observation
     never loses to an earlier one. That ordering rule is what makes it correct
     rather than merely usually-right:

       - Reading the array back after a replace must not overwrite a tick that
         happened after the document being replayed was written. Without the
         stamp, learnDone() would re-read the wiped array and helpfully record
         done:false over the user's real done:true — the guard defeating itself.
       - A genuine untick, in this tab or arriving from TaskHub through
         setTaskDone, is newer than whatever is in the Map and must win.

     `seen` is the stamp source: a monotonic counter, not a clock, because two
     events inside the same millisecond are common and Date.now() cannot order
     them. */
  var _d2lDone = new Map();
  var _seq = 0;

  function noteDone(key, done, seq) {
    var prev = _d2lDone.get(key);
    if (prev && prev.seq > seq) return;         // an older observation: ignore
    _d2lDone.set(key, { done: !!done, seq: seq });
  }

  function learnDone() {
    if (!bridge() || !B.getTasks) return;
    var seq = ++_seq;
    var list = B.getTasks() || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t._d2l && t._d2l.k) noteDone(t._d2l.k, t.done, seq);
    }
  }

  /* After a remote replace the array is authoritative for everything EXCEPT
     the fields StudyOS owns locally, so this deliberately does not re-learn
     `done` from it — that is what poisoned the Map before. It only records
     keys it has never seen, so an item first encountered from another device
     still gets an initial value. */
  function learnNewKeysOnly() {
    if (!bridge() || !B.getTasks) return;
    var seq = ++_seq;
    var list = B.getTasks() || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t._d2l && t._d2l.k && !_d2lDone.has(t._d2l.k)) noteDone(t._d2l.k, t.done, seq);
    }
  }

  function doneFor(key, fallback) {
    var rec = _d2lDone.get(key);
    return rec ? rec.done : !!fallback;
  }

  /* WHEN each of the two is safe to run — the whole correctness argument:
   *
   *   fb-sos-saved  fires after a LOCAL write. Something in this tab changed
   *                 the data: a checkbox, or TaskHub ticking through
   *                 setTaskDone (js/studyos.js:3655). The array is the freshest
   *                 truth there is, so learn everything from it.
   *
   *   fb-sos-remote fires after ANOTHER device's document was applied over the
   *                 local arrays. Its `done` flags are that device's, which may
   *                 be older than a tick made here. Adopt only keys never seen
   *                 before, and leave known ones alone.
   *
   * studyos.js registers its own fb-sos-remote handler first (it loads first),
   * so its wholesale replace has already run by the time these fire; the
   * setTimeout makes that ordering explicit rather than incidental. */
  window.addEventListener('fb-sos-saved',  function () { setTimeout(learnDone, 0); });
  window.addEventListener('fb-sos-remote', function () { setTimeout(learnNewKeysOnly, 0); });

  /* ── Transport ────────────────────────────────────────────────────────────
     The Worker holds the feed URL; it is never sent here and never stored in
     the browser or in Firestore. Only the session token lives locally. */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  async function api(path, body) {
    var r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: getToken() }, body || {})),
    });
    var data = {};
    try { data = await r.json(); } catch (e) { data = { ok: false, error: 'bad response from the sync service' }; }
    if (r.status === 401) setToken('');
    return data;
  }

  async function ensureSession() {
    if (getToken()) {
      var st = await api('/feed/status', {});
      if (st && st.ok) return { ok: true, status: st };
    }
    var pw = await window.uiPrompt(
      'Enter your StudyOS App Lock password to connect Brightspace.',
      { title: 'Unlock', password: true, okLabel: 'Continue' });
    if (pw == null) return { ok: false, cancelled: true };
    var s = await api('/lock/session', { password: pw });
    if (!s || !s.ok) { await window.uiAlert('That password was not accepted.'); return { ok: false }; }
    setToken(s.token);
    var st2 = await api('/feed/status', {});
    return { ok: true, status: st2 };
  }

  /* ── Time ─────────────────────────────────────────────────────────────────
     The Worker deliberately does NOT convert UTC timestamps — it runs in UTC
     and cannot know where the student is. The browser can, so the conversion
     lands here. A floating TZID time is already the course's local wall clock
     and is left exactly as-is. */
  function localizeTime(item) {
    if (!item || item.allDay || !item.time) return { date: item ? item.date : '', time: '' };
    if (!item.isUtc) return { date: item.date, time: item.time };
    var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(item.dtRaw || '');
    if (!m) return { date: item.date, time: item.time };
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return {
      date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
      time: p(d.getHours()) + ':' + p(d.getMinutes()),
    };
  }

  function todayISO() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function shiftISO(days) {
    var d = new Date(); d.setDate(d.getDate() + days);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function defaultMap() {
    return { version: 1, lastSyncAt: 0, horizonDays: 210, lookbackDays: 30, courses: {} };
  }

  /* Match a detected D2L course against an existing StudyOS class, so the
     common case needs no manual mapping at all. Compares against `code` first
     (MATH 2202 vs math-2202) then falls back to a name prefix. */
  function normKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function guessClassId(course, classes) {
    var key = normKey(course.key);
    var label = normKey(course.label);
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      var code = normKey(c.code);
      if (code && (code === key || code === label)) return c.id;
    }
    for (var j = 0; j < classes.length; j++) {
      var c2 = classes[j], nm = normKey(c2.name);
      if (!nm) continue;
      if (nm === key || nm === label) return c2.id;
      if (key && nm.indexOf(key) === 0) return c2.id;
      if (key && key.indexOf(nm) === 0 && nm.length >= 4) return c2.id;
    }
    return '';
  }

  function byteSize(o) {
    try { return new Blob([JSON.stringify(o)]).size; }
    catch (e) { try { return JSON.stringify(o).length; } catch (_) { return 0; } }
  }

  function uid() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ── Reconcile ────────────────────────────────────────────────────────────
     Pure with respect to the bridge: computes the next arrays and a report,
     and does not apply anything. dryRun() and the UI both use it. */
  function reconcile(payload, map) {
    // NOT learnDone(): after a remote replace the array's `done` flags are
    // whatever the incoming document said, which is precisely the value this
    // Map exists to override. Re-reading here would let the replace poison the
    // record it is supposed to survive. Only genuinely-new keys are adopted.
    learnNewKeysOnly();
    var classes = B.getClasses() || [];
    var curEvents = B.getEvents() || [];
    var curTasks = B.getTasks() || [];
    var classIds = {};
    classes.forEach(function (c) { if (c && c.id) classIds[c.id] = true; });

    var existing = new Map();
    curEvents.concat(curTasks).forEach(function (it) {
      if (it && it._d2l && it._d2l.k) existing.set(it._d2l.k, it);
    });

    var lo = shiftISO(-Math.abs(map.lookbackDays || 30));
    var hi = shiftISO(Math.abs(map.horizonDays || 210));

    var incoming = (payload.items || []).filter(function (i) {
      var cfg = map.courses[i.courseKey];
      if (!cfg || !cfg.enabled || !cfg.classId) return false;
      // A class deleted in StudyOS must not leave orphaned imports behind.
      if (!classIds[cfg.classId]) return false;
      return i.date >= lo && i.date <= hi;
    });

    var nextEvents = curEvents.filter(function (e) { return !(e && e._d2l); });
    var nextTasks = curTasks.filter(function (t) { return !(t && t._d2l); });

    var report = { added: 0, updated: 0, unchanged: 0, removed: 0, seen: {} };

    incoming.forEach(function (i) {
      var cfg = map.courses[i.courseKey];
      var prior = existing.get(i.key);
      var when = localizeTime(i);
      var asTask = cfg.importAs === 'tasks' ||
        (cfg.importAs !== 'events' && (i.allDay || i.type === 'hw'));

      report.seen[i.key] = true;

      if (asTask) {
        var priorDate = prior ? (prior.dueDate || '') : '';
        var priorTime = prior ? (prior.dueTime || '') : '';
        var changed = !prior || prior.name !== i.title || priorDate !== when.date || priorTime !== when.time;
        nextTasks.push({
          // Reusing the prior id is critical: taskmirror.js mirrors tasks into
          // TaskHub keyed on it, so a fresh id every sync would spawn a
          // duplicate TaskHub row and orphan the old one.
          id: prior ? prior.id : uid(),
          name: i.title,                                        // D2L wins
          dueDate: when.date,                                   // D2L wins
          dueTime: when.time,                                   // D2L wins
          priority: prior ? prior.priority : 'medium',          // local wins
          classId: cfg.classId,
          notes: prior ? prior.notes : (i.description || ''),   // local wins
          notif: prior ? prior.notif : 'none',                  // local wins
          repeat: 'none', repeatDays: [], repeatEndDate: '',
          done: doneFor(i.key, prior ? prior.done : false),     // local wins
          _d2l: { k: i.key, at: Date.now() },
        });
        if (!prior) report.added++; else if (changed) report.updated++; else report.unchanged++;
      } else {
        var changedE = !prior || prior.name !== i.title || prior.date !== when.date || prior.time !== when.time;
        nextEvents.push({
          id: prior ? prior.id : uid(),
          name: i.title,                                        // D2L wins
          date: when.date,                                      // D2L wins
          time: when.time,                                      // D2L wins
          classId: cfg.classId,
          // A type the user corrected by hand outranks the heuristic.
          type: (prior && prior._d2lTypeOverride) ? prior._d2lTypeOverride : i.type,
          notif: prior ? prior.notif : 'none',                  // local wins
          weight: prior ? (prior.weight || 0) : 0,              // local wins
          repeat: 'none', repeatDays: [], repeatEndDate: '',
          _d2l: { k: i.key, at: Date.now() },
        });
        if (prior && prior._d2lTypeOverride) {
          nextEvents[nextEvents.length - 1]._d2lTypeOverride = prior._d2lTypeOverride;
        }
        if (!prior) report.added++; else if (changedE) report.updated++; else report.unchanged++;
      }
    });

    existing.forEach(function (_v, k) { if (!report.seen[k]) report.removed++; });

    report.events = nextEvents;
    report.tasks = nextTasks;
    report.existingCount = existing.size;
    report.incomingCount = incoming.length;
    report.bytes = byteSize({ events: nextEvents, tasks: nextTasks });
    return report;
  }

  /* ── Guards ───────────────────────────────────────────────────────────────
     Returns an error string, or null when the import is safe to apply. */
  var SIZE_CEILING = 600 * 1024;   // 900 KB doc budget minus room for the rest

  function guard(report, payload) {
    // The big one. A feed that fetched fine but yielded nothing is far more
    // likely to be an expired token serving a login page than a semester that
    // genuinely emptied overnight.
    if (report.incomingCount === 0 && report.existingCount > 0) {
      return 'Brightspace returned no matching events, but you have ' + report.existingCount +
        ' imported item(s). Nothing was changed — this usually means the calendar link expired. ' +
        'Reconnect it from Brightspace › Calendar › Subscribe.';
    }
    if (report.removed > 0 && report.removed > report.existingCount / 2) {
      return null; // handled as a confirmation, not a hard stop — see apply()
    }
    if (report.bytes > SIZE_CEILING) {
      return 'This import would use ' + Math.round(report.bytes / 1024) + ' KB, over the ' +
        Math.round(SIZE_CEILING / 1024) + ' KB budget for a single sync document. ' +
        'Reduce the import window in Settings, or skip a course.';
    }
    return null;
  }

  async function apply(report, map) {
    var err = guard(report);
    if (err) { await window.uiAlert(err, { title: 'Import stopped' }); return false; }

    if (report.removed > 0 && report.removed > report.existingCount / 2) {
      var ok = await window.uiConfirm(
        'This will remove ' + report.removed + ' of your ' + report.existingCount +
        ' imported items. That is a lot at once — it can happen at the end of a term, but it also ' +
        'happens when a calendar link partly fails. Continue?',
        { title: 'Remove ' + report.removed + ' items?', okLabel: 'Continue', danger: true });
      if (!ok) return false;
    }

    map.lastSyncAt = Date.now();
    B.applyD2L({ events: report.events, tasks: report.tasks, map: map });
    return true;
  }

  /* ── UI ───────────────────────────────────────────────────────────────────
     A self-contained modal rather than a new view: switchView() hardcodes its
     own titles/nav maps (js/studyos.js:734), so a new view would mean editing
     that function's internals, and the mobile bottom nav has no free slot. */
  var elModal = null;

  function css() {
    if (document.getElementById('d2l-style')) return;
    var s = document.createElement('style');
    s.id = 'd2l-style';
    s.textContent = [
      '.d2l-back{position:fixed;inset:0;background:rgba(15,12,20,.55);backdrop-filter:blur(4px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px}',
      '.d2l-card{background:var(--card,#fff);color:var(--text,#241f2b);border-radius:18px;max-width:640px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.3)}',
      '.d2l-hd{padding:20px 22px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line,#ece7f0)}',
      '.d2l-hd h2{margin:0;font-size:18px;font-weight:700;flex:1}',
      '.d2l-bd{padding:18px 22px}',
      '.d2l-ft{padding:14px 22px 20px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}',
      '.d2l-p{margin:0 0 12px;line-height:1.55;font-size:14px;color:var(--muted,#6f6579)}',
      '.d2l-warn{background:rgba(220,150,40,.12);border:1px solid rgba(220,150,40,.35);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5;margin:0 0 14px}',
      '.d2l-err{background:rgba(210,60,60,.1);border:1px solid rgba(210,60,60,.35);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5;margin:0 0 14px}',
      '.d2l-in{width:100%;padding:11px 12px;border:1px solid var(--line,#ddd6e2);border-radius:10px;font:inherit;font-size:14px;background:var(--bg,#faf8fc);color:inherit;box-sizing:border-box}',
      '.d2l-btn{padding:10px 16px;border-radius:10px;border:1px solid var(--line,#ddd6e2);background:var(--bg,#f6f3f8);color:inherit;font:inherit;font-size:14px;font-weight:600;cursor:pointer}',
      '.d2l-btn.pri{background:var(--accent,#8D769A);border-color:var(--accent,#8D769A);color:#fff}',
      '.d2l-btn:disabled{opacity:.5;cursor:default}',
      '.d2l-row{border:1px solid var(--line,#ece7f0);border-radius:12px;padding:12px 14px;margin-bottom:10px}',
      '.d2l-row h4{margin:0 0 2px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.d2l-meta{font-size:12px;color:var(--muted,#8b8194);margin-bottom:9px}',
      '.d2l-flag{font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;background:rgba(220,150,40,.16);color:#c2a173}',
      '.d2l-sel{width:100%;padding:9px 10px;border:1px solid var(--line,#ddd6e2);border-radius:9px;font:inherit;font-size:13px;background:var(--bg,#faf8fc);color:inherit;margin-bottom:7px;box-sizing:border-box}',
      '.d2l-seg{display:flex;gap:6px;font-size:12px;align-items:center;flex-wrap:wrap;color:var(--muted,#6f6579)}',
      '.d2l-seg button{padding:5px 11px;border-radius:8px;border:1px solid var(--line,#ddd6e2);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.d2l-seg button[aria-pressed="true"]{background:var(--accent,#8D769A);border-color:var(--accent,#8D769A);color:#fff}',
      '.d2l-stat{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 14px;font-size:14px}',
      '.d2l-stat b{display:block;font-size:22px;font-weight:700;line-height:1.2}',
      '.d2l-note{font-size:12px;color:var(--muted,#8b8194);line-height:1.5}',
      '@media(prefers-color-scheme:dark){.d2l-card{background:#241f2b;color:#f2eef6}.d2l-in,.d2l-sel,.d2l-btn{background:#2e2836}}',
    ].join('');
    document.head.appendChild(s);
  }

  function close() { if (elModal) { elModal.remove(); elModal = null; } }

  function shell(title, bodyHTML, footHTML) {
    css();
    close();
    elModal = document.createElement('div');
    elModal.className = 'd2l-back';
    elModal.innerHTML =
      '<div class="d2l-card" role="dialog" aria-modal="true"><div class="d2l-hd"><h2>' + title + '</h2>' +
      '<button class="d2l-btn" data-x>Close</button></div>' +
      '<div class="d2l-bd">' + bodyHTML + '</div>' +
      '<div class="d2l-ft">' + (footHTML || '') + '</div></div>';
    elModal.addEventListener('click', function (e) { if (e.target === elModal) close(); });
    elModal.querySelector('[data-x]').onclick = close;
    document.body.appendChild(elModal);
    return elModal;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Panel 1 — Connect */
  function panelConnect(msg) {
    var body =
      '<p class="d2l-p">In Brightspace, open <b>Calendar</b>, click <b>Subscribe</b>, choose ' +
      '<b>All Calendars and Tasks</b>, and copy the link it gives you.</p>' +
      (msg ? '<div class="d2l-err">' + esc(msg) + '</div>' : '') +
      '<div class="d2l-warn"><b>That link is a password.</b> Anyone who has it can read your whole ' +
      'course calendar. It is stored in your own Cloudflare Worker &mdash; never in this browser, ' +
      'and never in your synced data.</div>' +
      '<input class="d2l-in" id="d2l-url" type="password" autocomplete="off" spellcheck="false" ' +
      'placeholder="https://…brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=…">' +
      '<p class="d2l-note" style="margin-top:10px">No <b>Subscribe</b> button? Your school has ' +
      'disabled calendar feeds, and there is no way around that without an API account from them.</p>';
    var m = shell('Connect Brightspace', body,
      '<button class="d2l-btn" data-cancel>Cancel</button>' +
      '<button class="d2l-btn pri" data-go>Connect</button>');
    m.querySelector('[data-cancel]').onclick = close;
    var go = m.querySelector('[data-go]');
    go.onclick = async function () {
      var url = (m.querySelector('#d2l-url').value || '').trim();
      if (!url) return;
      go.disabled = true; go.textContent = 'Checking…';
      var res = await api('/feed/set', { url: url });
      go.disabled = false; go.textContent = 'Connect';
      if (!res || !res.ok) { panelConnect((res && res.error) || 'Could not read that feed.'); return; }
      openMapping(res.probe);
    };
    setTimeout(function () { var i = m.querySelector('#d2l-url'); if (i) i.focus(); }, 30);
  }

  /* Panel 2 — Map courses onto classes */
  var _pendingMap = null;

  function openMapping(probe) {
    var classes = (bridge() && B.getClasses()) || [];
    var map = B.getD2LMap() || defaultMap();
    map.courses = map.courses || {};

    (probe.courses || []).forEach(function (c) {
      if (!map.courses[c.key]) {
        var guess = guessClassId(c, classes);
        map.courses[c.key] = {
          classId: guess, label: c.label, importAs: 'auto', enabled: !!guess,
        };
      } else {
        map.courses[c.key].label = c.label;
      }
    });
    _pendingMap = map;

    var opts = function (sel) {
      return '<option value="">— Skip this course —</option>' +
        classes.map(function (c) {
          return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' +
            esc(c.name) + (c.code ? ' (' + esc(c.code) + ')' : '') + '</option>';
        }).join('');
    };

    var rows = (probe.courses || []).map(function (c) {
      var cfg = map.courses[c.key];
      return '<div class="d2l-row" data-key="' + esc(c.key) + '">' +
        '<h4>' + esc(c.label) +
        (c.confidence === 'low' ? '<span class="d2l-flag">check this</span>' : '') + '</h4>' +
        '<div class="d2l-meta">' + c.count + ' item' + (c.count === 1 ? '' : 's') + ' in Brightspace</div>' +
        '<select class="d2l-sel" data-cls>' + opts(cfg.classId) + '</select>' +
        '<div class="d2l-seg"><span>Import as</span>' +
        ['auto', 'events', 'tasks'].map(function (v) {
          return '<button data-as="' + v + '" aria-pressed="' + (cfg.importAs === v) + '">' + v + '</button>';
        }).join('') + '</div></div>';
    }).join('');

    var noClasses = classes.length
      ? ''
      : '<div class="d2l-warn">You have no classes yet. Close this, add your classes in StudyOS, ' +
        'then reopen Brightspace to map them.</div>';

    var m = shell('Match your courses',
      '<p class="d2l-p">Pick the StudyOS class each Brightspace course belongs to. Anything left on ' +
      '<b>Skip</b> is ignored entirely, so a wrong guess here costs nothing.</p>' + noClasses + rows,
      '<button class="d2l-btn" data-cancel>Cancel</button>' +
      '<button class="d2l-btn pri" data-next>Preview import</button>');

    m.querySelector('[data-cancel]').onclick = close;
    m.querySelectorAll('.d2l-row').forEach(function (row) {
      var key = row.getAttribute('data-key');
      row.querySelector('[data-cls]').onchange = function () {
        _pendingMap.courses[key].classId = this.value;
        _pendingMap.courses[key].enabled = !!this.value;
      };
      row.querySelectorAll('[data-as]').forEach(function (b) {
        b.onclick = function () {
          _pendingMap.courses[key].importAs = b.getAttribute('data-as');
          row.querySelectorAll('[data-as]').forEach(function (o) {
            o.setAttribute('aria-pressed', String(o === b));
          });
        };
      });
    });
    m.querySelector('[data-next]').onclick = function () { runPreview(_pendingMap); };
  }

  /* Panel 3 — Preview and apply */
  async function runPreview(map) {
    var m = shell('Checking Brightspace…', '<p class="d2l-p">Fetching your calendar…</p>', '');
    var payload = await api('/sync', { force: true });
    if (!payload || !payload.ok) {
      shell('Brightspace', '<div class="d2l-err">' + esc((payload && payload.error) || 'Sync failed.') + '</div>',
        '<button class="d2l-btn" data-cancel>Close</button>');
      elModal.querySelector('[data-cancel]').onclick = close;
      return;
    }

    var rep = reconcile(payload, map);
    var hard = guard(rep);

    var notes = [];
    if (payload.stale) notes.push('Showing the last successful fetch — Brightspace did not respond just now.');
    if (payload.recurringCount) {
      notes.push(payload.recurringCount + ' repeating item' + (payload.recurringCount === 1 ? ' was' : 's were') +
        ' imported as a single entry each. Brightspace repeat rules are not expanded.');
    }
    if (payload.truncated) notes.push('Your calendar is unusually large, so only the first ' + payload.totalParsed + ' items were read.');

    var body = hard
      ? '<div class="d2l-err">' + esc(hard) + '</div>'
      : '<div class="d2l-stat">' +
        '<div><b>' + rep.added + '</b>adding</div>' +
        '<div><b>' + rep.updated + '</b>updating</div>' +
        '<div><b>' + rep.unchanged + '</b>unchanged</div>' +
        '<div><b>' + rep.removed + '</b>removing</div></div>' +
        '<p class="d2l-note">Anything you have ticked off stays ticked. Your own events and tasks are ' +
        'never touched.<br>Estimated size after import: <b>' + Math.round(rep.bytes / 1024) +
        ' KB</b> of your 900 KB budget.</p>' +
        (notes.length ? '<p class="d2l-note" style="margin-top:10px">' + notes.map(esc).join('<br>') + '</p>' : '');

    var foot = hard
      ? '<button class="d2l-btn" data-cancel>Close</button>'
      : '<button class="d2l-btn" data-back>Back</button>' +
        '<button class="d2l-btn pri" data-apply>' +
        (rep.added + rep.updated + rep.removed === 0 ? 'Nothing to change' : 'Import') + '</button>';

    var mm = shell('Preview import', body, foot);
    if (mm.querySelector('[data-cancel]')) mm.querySelector('[data-cancel]').onclick = close;
    if (mm.querySelector('[data-back]')) {
      mm.querySelector('[data-back]').onclick = function () {
        openMapping({ courses: payload.courses });
      };
    }
    var ap = mm.querySelector('[data-apply]');
    if (ap) {
      ap.onclick = async function () {
        ap.disabled = true;
        var ok = await apply(rep, map);
        if (ok) {
          shell('Brightspace',
            '<p class="d2l-p">Imported. ' + rep.added + ' added, ' + rep.updated + ' updated' +
            (rep.removed ? ', ' + rep.removed + ' removed' : '') + '.</p>',
            '<button class="d2l-btn pri" data-cancel>Done</button>');
          elModal.querySelector('[data-cancel]').onclick = close;
        } else { ap.disabled = false; }
      };
    }
  }

  /* Entry point */
  async function open() {
    if (!enabled()) {
      await window.uiAlert('Brightspace import is not configured for this install.');
      return;
    }
    if (!bridge()) { await window.uiAlert('StudyOS is still starting up. Try again in a moment.'); return; }

    shell('Brightspace', '<p class="d2l-p">Checking your connection…</p>', '');
    var s = await ensureSession();
    if (!s.ok) { close(); return; }

    if (!s.status || !s.status.configured) { panelConnect(); return; }

    var map = B.getD2LMap();
    var known = map && map.courses && Object.keys(map.courses).length;
    var last = s.status.lastFetchAt
      ? new Date(s.status.lastFetchAt).toLocaleString()
      : 'never';

    var body =
      '<p class="d2l-p">Connected to <b>' + esc(s.status.host || 'Brightspace') + '</b>.<br>' +
      'Last checked: ' + esc(last) + '.</p>' +
      (known ? '' : '<p class="d2l-p">No courses matched yet — run a sync to set them up.</p>');

    var m = shell('Brightspace', body,
      '<button class="d2l-btn" data-dis>Disconnect</button>' +
      '<button class="d2l-btn" data-remap>Match courses</button>' +
      '<button class="d2l-btn pri" data-sync>Sync now</button>');

    m.querySelector('[data-sync]').onclick = function () {
      runPreview(B.getD2LMap() || defaultMap());
    };
    m.querySelector('[data-remap]').onclick = async function () {
      var p = await api('/sync', { force: false });
      if (p && p.ok) openMapping({ courses: p.courses });
      else await window.uiAlert((p && p.error) || 'Could not reach Brightspace.');
    };
    m.querySelector('[data-dis]').onclick = async function () {
      var ok = await window.uiConfirm(
        'Disconnect Brightspace? Your imported items stay in StudyOS — they simply stop updating.',
        { title: 'Disconnect', okLabel: 'Disconnect', danger: true });
      if (!ok) return;
      await api('/feed/clear', {});
      setToken('');
      close();
    };
  }

  window.sosD2LOpen = open;

  // Test seam: scripts/test-d2l-client.mjs drives reconcile() directly so the
  // done-carry-over can be asserted on the rebuilt items, not just on counts.
  window._d2lInternals = { reconcile: reconcile, guard: guard, learnDone: learnDone,
                           learnNewKeysOnly: learnNewKeysOnly, doneFor: doneFor,
                           localizeTime: localizeTime, defaultMap: defaultMap,
                           guessClassId: guessClassId, doneMap: _d2lDone };

  // Console helper: report what a sync WOULD do, without applying anything.
  window._d2lDryRun = async function () {
    if (!bridge()) return 'bridge not ready';
    var p = await api('/sync', { force: true });
    if (!p || !p.ok) return p;
    var rep = reconcile(p, B.getD2LMap() || defaultMap());
    return {
      added: rep.added, updated: rep.updated, unchanged: rep.unchanged, removed: rep.removed,
      incoming: rep.incomingCount, existing: rep.existingCount,
      bytes: rep.bytes, blocked: guard(rep), courses: p.courses,
    };
  };

  // Hide the entry point entirely when unconfigured, rather than offering a
  // button that can only fail.
  function paintButton() {
    var b = document.getElementById('sos-d2l-btn');
    if (b) b.style.display = enabled() ? '' : 'none';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintButton);
  } else { paintButton(); }

  setTimeout(learnDone, 1200);
})();
