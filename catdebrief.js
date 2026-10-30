/* catdebrief.js — "Debrief in MAGI" for TradeHub Catalysts events.
 *
 * Every earnings and macro event TradeHub Catalysts publishes shows up on both
 * TaskHubs (dashboards/market_calendar). Ten minutes after a macro release has
 * come out (an earnings report: the moment it is out), its card grows a ▶ button: press it and MAGI opens (or the MAGI tab
 * that is already open comes forward) and convenes a debrief of THAT event,
 * in the profile of the TaskHub you pressed it in.
 *
 * ONE FILE, TWO READERS. index.html draws the button and launches; TradeHub's
 * Catalysts tab edits the settings. Both load this file unpinned from
 * GitHub Pages, so the defaults, the prompt filler and the timing rules
 * cannot drift between the page that shows a button and the page that
 * configures it.
 *
 * SETTINGS live in their own doc, dashboards/catalyst_debrief, never inside
 * dashboards/market_calendar: TradeHub rewrites that doc whole on every
 * publish, so anything else stored there would be wiped by the next build.
 *   { tony:{units:[...]}, veda:{units:[...]},
 *     templates:{earnings:"...", macro:"...", group:"..."},
 *     defaults:{earnings:"...", macro:"...", group:"..."}, groupMin, savedAt }
 * `defaults` is a template Tony set as his own default ("Set as default",
 * 2026-10-14): a blank template falls back to it, and a blank default to the
 * built-in TEMPLATES.
 * TradeHub is the only writer; index.html only listens.
 *
 * GROUPED RELEASES (2026-10-29). Macro releases on one day that come out
 * within `groupMin` minutes of the first (default 15: the ECB at 8:15 with
 * PCE, GDP and jobless claims at 8:30) draw as ONE card with ONE ▶, which
 * sends the `group` template: every release debriefed in one go. groups()
 * is the rule and both TaskHubs draw from it; 0 turns grouping off.
 *
 * THE HANDOFF is MAGI's own #tb= fragment (see magi.html "handoff"), with
 * one field added: `p`, the profile. MAGI opens in that profile, switching
 * an open console over if it was showing the other person. Zero reads and
 * zero writes per launch: the prompt rides in the url fragment.
 *
 * Plain ES5-ish script, no build step, no globals other than A1Debrief.
 * tests/catdebrief.test.js runs it in a sandbox. */
(function (root) {
  'use strict';

  var MAGI_URL = 'https://anthonyn99.github.io/A1/magi.html';
  var DOC = 'dashboards/catalyst_debrief';
  var PROFILES = ['tony', 'veda'];
  // How long after the release the button appears. Numbers land at the
  // release minute; ten minutes gives every source time to print them and
  // the first market reaction time to happen, so the debrief has substance.
  var DELAY_MIN = 10;
  // Earnings have no such wait: EARN_ET already names the time a report is
  // out by, and Tony wants the button then (2026-10-29: 4:40 ET felt like
  // "50 minutes after the close").
  var EARN_DELAY_MIN = 0;
  // The four verified units, the same default TradeHub's Analysis tab uses
  // (TB_MAGI_DEFAULT_UNITS). A unit the engine lacks is skipped by MAGI.
  var DEFAULT_UNITS = ['chatgpt', 'claude', 'gemini', 'deepseek'];
  // Macro releases this close to the first one of a run share a card.
  var GROUP_MIN = 15, GROUP_MAX = 120;
  var KINDS = ['earnings', 'macro', 'group'];

  /* Earnings carry no release clock, only Finnhub's session tag. These are
   * the times a report in each session is reliably out by, in ET:
   *   bmo (before the open)  — almost all print 6:00–8:00
   *   amc (after the close)  — almost all print 16:01–16:10 (the 4:05 wire
 *                            is the norm; a few stragglers print by 16:30)
   *   dmh (during the day)   — rare; midday
   * An untagged report (TSM and other ADRs come from Nasdaq's scan with no
   * session) waits for the later of the two, so the button never offers a
   * debrief of numbers that cannot exist yet. A macro release with no fixed
   * clock (a Fed speaker) waits for the close the same way. */
  var EARN_ET = { bmo: { hh: 8, mm: 0 }, amc: { hh: 16, mm: 5 }, dmh: { hh: 12, mm: 0 } };
  var LATE_ET = { hh: 16, mm: 30 };

  var TEMPLATES = {
    earnings:
      '{ticker} just reported earnings ({timing}, {date}). Debrief this report:\n\n' +
      '1. Results vs. consensus: EPS (consensus was {epsEst}) and revenue, beat or miss and by how much, plus the key segment or KPI numbers.\n' +
      '2. Guidance: next quarter and full year vs. what the Street expected.\n' +
      '3. The biggest takeaways from the release and the call: margins, demand, capex, buybacks, management tone.\n' +
      '4. Market reaction: how {ticker} is trading after hours or pre-market vs. the move options priced in, and the read-through to peers, its sector and the indices.\n' +
      '5. Expected market movement into the next session, and the levels and catalysts to watch.\n\n' +
      'Use the latest data available. If the report is not out yet, say so plainly instead of guessing.',
    macro:
      'The {event} just came out ({time}, {date}). Debrief this release:\n\n' +
      '1. The actual numbers vs. consensus and the prior reading: headline and core or key components, plus any revisions.\n' +
      '2. What surprised, and what it means for the Fed path and rate expectations.\n' +
      '3. The immediate market reaction: S&P 500 and Nasdaq futures, 2y and 10y Treasury yields, the dollar, and anything else that moved.\n' +
      '4. Expected market movement for the rest of the session, and what to watch next.\n\n' +
      'Use the latest data available. If the release is not out yet, say so plainly instead of guessing.',
    group:
      'These {count} releases just came out together ({time}, {date}):\n{events}\n\n' +
      'Debrief them all in one go, as one market picture:\n\n' +
      '1. Each release: the actual numbers vs. consensus and the prior reading, headline and core or key components, plus any revisions.\n' +
      '2. What surprised, whether the releases confirm or contradict each other, and what they mean together for the Fed path, rate expectations and any other central bank in the list.\n' +
      '3. The immediate market reaction: S&P 500 and Nasdaq futures, 2y and 10y Treasury yields, the dollar, and anything else that moved, and which release drove it.\n' +
      '4. Expected market movement for the rest of the session, and what to watch next.\n\n' +
      'Use the latest data available. If any release is not out yet, say so plainly for that one instead of guessing.'
  };

  // What the settings screen lists under each template.
  var PLACEHOLDERS = {
    earnings: [['{ticker}', 'ticker, e.g. TSM'], ['{timing}', 'before the open / after the close'], ['{date}', 'report date'], ['{epsEst}', 'consensus EPS']],
    macro: [['{event}', 'release name, e.g. September CPI Report'], ['{time}', 'release time, ET'], ['{date}', 'release date'], ['{category}', 'Inflation, Jobs, Fed…']],
    group: [['{events}', 'one line per release: name, category, time'], ['{count}', 'how many releases'], ['{time}', 'release time or span, ET'], ['{date}', 'release date']]
  };

  function isEarn(ev) { return !!ev && ev.kind === 'earnings'; }

  // Leading symbol of an earnings title ("AAPL Earnings" → "AAPL"); same rule
  // as index.html's mcTicker, but the event's own `ticker` wins when present.
  function tickerOf(ev) {
    if (ev && ev.ticker) return String(ev.ticker).toUpperCase();
    var nm = String((ev && (ev.title || ev.name)) || '');
    var m = /^\$?([A-Z][A-Z0-9.]{0,5})\b/.exec(nm);
    return m ? m[1] : nm.replace(/\s*earnings\s*$/i, '').trim();
  }

  function cleanUnits(a) {
    if (!Array.isArray(a)) return null;
    var seen = {}, out = [];
    for (var i = 0; i < a.length && out.length < 12; i++) {
      var id = String(a[i] || '').trim();
      if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && !seen[id]) { seen[id] = 1; out.push(id); }
    }
    return out;
  }

  /* Any stored shape → a complete config. An ARRAY of units, even an empty
   * one, is a choice and is kept (empty = "whatever MAGI already has
   * ticked"); only a profile that never chose gets the defaults. A blank
   * template falls back to the default (the one set in TradeHub, else the
   * built-in), so a wiped textarea cannot send MAGI an empty prompt. */
  function normalize(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var out = { templates: {}, defaults: {} };
    var gm = Number(raw.groupMin);
    out.groupMin = (raw.groupMin == null || raw.groupMin === '' || !isFinite(gm)) ? GROUP_MIN : Math.max(0, Math.min(GROUP_MAX, Math.round(gm)));
    PROFILES.forEach(function (p) {
      var u = cleanUnits(raw[p] && raw[p].units);
      out[p] = { units: u === null ? DEFAULT_UNITS.slice() : u };
    });
    var t = (raw.templates && typeof raw.templates === 'object') ? raw.templates : {};
    var d = (raw.defaults && typeof raw.defaults === 'object') ? raw.defaults : {};
    KINDS.forEach(function (k) {
      var ds = typeof d[k] === 'string' ? d[k].slice(0, 6000) : '';
      out.defaults[k] = ds.trim() ? ds : TEMPLATES[k];
      var s = typeof t[k] === 'string' ? t[k].slice(0, 6000) : '';
      out.templates[k] = s.trim() ? s : out.defaults[k];
    });
    return out;
  }

  var CFG = normalize(null);
  function setConfig(raw) {
    CFG = normalize(raw);
    try { root.dispatchEvent(new CustomEvent('a1debrief:config', { detail: CFG })); } catch (e) {}
    return CFG;
  }
  function config() { return CFG; }

  // Epoch ms of a wall-clock time in New York on dateStr ("YYYY-MM-DD").
  // Same construction as index.html's thZonedTs, so DST is handled the same.
  function nyTs(dateStr, hh, mm) {
    var p = String(dateStr).split('-').map(Number);
    var guess = Date.UTC(p[0], p[1] - 1, p[2], hh, mm, 0);
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    var hr = +parts.hour; if (hr === 24) hr = 0;
    var asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hr, +parts.minute);
    return guess - (asTz - guess);
  }

  /* When the event came out, in epoch ms, or null for one that never
   * "comes out" (a market holiday). `macroET` is the caller's release-time
   * table ({hh,mm} or null) — index.html's mcMacroET, TradeHub's tbMacroET —
   * so this file does not grow a third copy of that list. */
  function releaseAt(ev, macroET) {
    if (!ev || !ev.date || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date) || ev.kind === 'holiday') return null;
    var t = isEarn(ev) ? (EARN_ET[ev.when] || EARN_ET.amc) : (macroET || LATE_ET);
    try { return nyTs(ev.date, t.hh, t.mm); } catch (e) { return null; }
  }
  function dueAt(ev, macroET) {
    var r = releaseAt(ev, macroET);
    return r === null ? null : r + (isEarn(ev) ? EARN_DELAY_MIN : DELAY_MIN) * 60000;
  }
  function isDue(ev, macroET, now) {
    var d = dueAt(ev, macroET);
    return d !== null && (now == null ? Date.now() : now) >= d;
  }
  /* The soonest due time still ahead of `now` across a list, or null. A
   * TaskHub schedules ONE timer for it, so a button appears on the minute
   * without the page re-rendering on a clock. */
  function nextDue(events, macroETof, now) {
    now = now == null ? Date.now() : now;
    var best = null;
    (events || []).forEach(function (ev) {
      var d = dueAt(ev, macroETof ? macroETof(ev) : null);
      if (d !== null && d > now && (best === null || d < best)) best = d;
    });
    return best;
  }

  /* Split a day's catalysts into cards. Earnings share ONE card per day (as
   * before); macro releases with a known release clock share a card when
   * they come out within `groupMin` minutes of the run's FIRST release, so a
   * run cannot creep across the morning. Untimed releases and holidays stand
   * alone. Returns arrays in display order: earnings, then by release time. */
  function groups(events, macroETof, groupMin) {
    var gm = groupMin == null ? CFG.groupMin : Math.max(0, +groupMin || 0);
    var list = (events || []).filter(Boolean), out = [];
    var earn = list.filter(isEarn);
    if (earn.length) out.push(earn);
    var timed = [], solo = [];
    list.forEach(function (ev, i) {
      if (isEarn(ev)) return;
      var t = ev.kind === 'holiday' ? null : (macroETof ? macroETof(ev) : null);
      var x = { ev: ev, i: i, m: t ? t.hh * 60 + t.mm : null };
      if (t && gm > 0) timed.push(x); else solo.push(x);
    });
    timed.sort(function (a, b) { return a.m - b.m || a.i - b.i; });
    var runs = [], cur = null;
    timed.forEach(function (x) {
      if (cur && x.ev.date === cur.date && x.m - cur.m <= gm) cur.evs.push(x.ev);
      else { cur = { date: x.ev.date, m: x.m, i: x.i, evs: [x.ev] }; runs.push(cur); }
    });
    // Back into time order with the stand-alone ones; untimed go last.
    solo.forEach(function (x) { runs.push({ m: x.m == null ? 1e9 : x.m, i: x.i, evs: [x.ev] }); });
    runs.sort(function (a, b) { return a.m - b.m || a.i - b.i; });
    runs.forEach(function (r) { out.push(r.evs); });
    return out;
  }
  function isGroup(list) {
    return Array.isArray(list) && list.length > 1 && !list.some(isEarn);
  }
  /* What a card's ▶ debriefs right now, or null for no button. An earnings
   * card debriefs every report already out; a group of releases waits for
   * its LAST release, so one press covers them all. */
  function debriefable(list, macroETof, now) {
    list = (Array.isArray(list) ? list : [list]).filter(Boolean);
    var due = list.filter(function (ev) { return isDue(ev, macroETof ? macroETof(ev) : null, now); });
    if (!due.length) return null;
    if (isGroup(list) && due.length < list.length) return null;
    return due;
  }

  function fmtDate(ds) {
    try {
      return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ds; }
  }
  function fmtET(t) {
    if (!t) return '';
    var h = t.hh % 12 || 12;
    return h + ':' + (t.mm < 10 ? '0' : '') + t.mm + (t.hh < 12 ? ' AM' : ' PM') + ' ET';
  }
  var TIMING = { bmo: 'before the open', amc: 'after the close', dmh: 'during market hours' };
  var CAT = { ecb: 'ECB', gdp: 'GDP' };
  function catLabel(c) { c = String(c || ''); return CAT[c.toLowerCase()] || (c ? c.charAt(0).toUpperCase() + c.slice(1) : ''); }

  /* Fill-in-the-blank. Unknown {words} are left alone (so a template can
   * mention braces), and an EMPTY value tidies up after itself: "(, Oct 14)"
   * must not reach the prompt. */
  function fill(tpl, ev, macroET) {
    var eps = ev && ev.epsEst;
    var vals = {
      ticker: isEarn(ev) ? tickerOf(ev) : '',
      event: String((ev && (ev.title || ev.name)) || '').trim(),
      date: ev && ev.date ? fmtDate(ev.date) : '',
      timing: isEarn(ev) ? (TIMING[ev.when] || '') : '',
      time: !isEarn(ev) ? fmtET(macroET) : '',
      epsEst: (typeof eps === 'number' && isFinite(eps)) ? '$' + eps.toFixed(2) : 'not available',
      category: catLabel(ev && ev.category)
    };
    var s = String(tpl || '').replace(/\{(ticker|event|date|timing|time|epsEst|category)\}/g, function (m, k) { return vals[k]; });
    return s
      .replace(/\(\s*[,;]\s*/g, '(').replace(/\s*[,;]\s*\)/g, ')').replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1').trim();
  }

  /* A group of releases → the `group` template. {events} is one line per
   * release; {time} is the shared clock, or the span ("8:15–8:30 AM ET"). */
  function fillGroup(tpl, list, macroETof) {
    var ts = list.map(function (ev) { return macroETof ? macroETof(ev) : null; });
    var lines = list.map(function (ev, i) {
      var bits = [catLabel(ev.category), fmtET(ts[i])].filter(Boolean);
      return '- ' + String(ev.title || ev.name || '').trim() + (bits.length ? ' (' + bits.join(', ') + ')' : '');
    });
    var known = ts.filter(Boolean).sort(function (a, b) { return (a.hh * 60 + a.mm) - (b.hh * 60 + b.mm); });
    var time = '';
    if (known.length) {
      var a = known[0], b = known[known.length - 1];
      time = (a.hh === b.hh && a.mm === b.mm) ? fmtET(a)
        : fmtET(a).replace(/ (AM|PM) ET$/, (a.hh < 12) === (b.hh < 12) ? '' : ' $1') + '–' + fmtET(b);
    }
    var vals = { events: lines.join('\n'), count: String(list.length), time: time, date: list[0].date ? fmtDate(list[0].date) : '' };
    var s = String(tpl || '').replace(/\{(events|count|time|date)\}/g, function (m, k) { return vals[k]; });
    return s
      .replace(/\(\s*[,;]\s*/g, '(').replace(/\s*[,;]\s*\)/g, ')').replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1').trim();
  }

  /* The whole prompt for one card. A day with several earnings shows ONE
   * card, so it debriefs every report on it that is already out; a group of
   * releases sends the `group` template, all of them in one go. */
  function prompt(events, cfg, macroETof) {
    cfg = cfg || CFG;
    var list = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (!list.length) return '';
    if (isGroup(list)) return fillGroup((cfg.templates && cfg.templates.group) || TEMPLATES.group, list, macroETof);
    var parts = list.map(function (ev) {
      var met = macroETof ? macroETof(ev) : null;
      return fill(isEarn(ev) ? cfg.templates.earnings : cfg.templates.macro, ev, met);
    });
    if (parts.length === 1) return parts[0];
    var names = list.map(function (ev) { return isEarn(ev) ? tickerOf(ev) : String(ev.title || ev.name || ''); });
    return 'Debrief each of these ' + parts.length + ' reports separately (' + names.join(', ') + '):\n\n' +
      parts.map(function (p, i) { return '### ' + (i + 1) + '. ' + names[i] + '\n\n' + p; }).join('\n\n');
  }

  // base64url of UTF-8, chunked (TradeHub's tbB64u, same reason).
  function b64u(str) {
    var b = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function link(q, units, profile, base) {
    var p = PROFILES.indexOf(profile) >= 0 ? profile : 'tony';
    var payload = { v: 1, src: 'catalysts', q: String(q || ''), units: units || [], run: 1, t: Date.now(), p: p };
    return String(base || MAGI_URL).split('#')[0] + '#tb=' + b64u(JSON.stringify(payload));
  }

  /* ── One MAGI tab ──────────────────────────────────────────────────────
   * TradeHub's tbOpenMagi, for the same reason it exists there: TaskHub's
   * _tnOpenTab only brings an open tab forward, and for a debrief the point
   * of the click is the PROMPT. 'a1tab_magi' is the name TaskHub's MAGI
   * button, TradeHub and the morning launcher all use, so every opener lands
   * in one console. When the name lookup misses (a browser restart drops the
   * links that make names findable), tabsync.js's heartbeat says whether a
   * console still exists, and 'deliver' hands it the url. */
  var TAB_KEY = 'magi', TAB_NAME = 'a1tab_' + TAB_KEY;
  function claimed() {
    try { var r = JSON.parse(localStorage.getItem('a1tab:' + TAB_KEY) || 'null'); return !!(r && r.t && (Date.now() - r.t) < 20000); }
    catch (e) { return false; }
  }
  function go(w, url) {
    try { w.location.replace(url); } catch (e) { try { w.location.href = url; } catch (e2) {} }
    try { w.focus(); } catch (e) {}
  }
  function handOver(w, url) {
    var bc = null;
    try { bc = new BroadcastChannel('a1tabs'); } catch (e) { bc = null; }
    if (!bc) { go(w, url); return; }
    var rid = Math.random().toString(36).slice(2), settled = false, answered = false;
    var timer = setTimeout(function () { finish(false); }, 300);
    function finish(keepOld) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (keepOld) { try { bc.postMessage({ t: 'deliver', k: TAB_KEY, url: url }); } catch (e) {} try { w.close(); } catch (e) {} }
      else { if (answered) { try { bc.postMessage({ t: 'retire', k: TAB_KEY }); } catch (e) {} } go(w, url); }
      setTimeout(function () { try { bc.close(); } catch (e) {} }, 1500);
    }
    bc.onmessage = function (ev) {
      var d = ev && ev.data;
      if (!d || d.t !== 'claimed' || d.k !== TAB_KEY || d.rid !== rid) return;
      answered = true;
      // Busy (a council is running) or not closable: keep it, it queues the
      // prompt until the run ends. Retiring it would throw the run away.
      finish(!!d.ok || !!d.busy || d.closable === false);
    };
    try { bc.postMessage({ t: 'claim', k: TAB_KEY, rid: rid }); } catch (e) { finish(false); }
  }
  function openMagi(url) {
    if (!url) return false;
    var w = null;
    // This very tab may carry MAGI's name: window.name survives navigation,
    // so a tab that once held MAGI and now holds TaskHub IS 'a1tab_magi', and
    // the lookup would hand back TaskHub itself to navigate away. Give the
    // name up first, so the lookup finds the real console or opens one.
    // tabsync.js on this page then also answers to 'magi' (its key outlives
    // the name in sessionStorage), so a handover would be answered by THIS
    // tab and the 'deliver' would navigate it. Such a tab skips the handover.
    var selfIsMagi = false;
    try { selfIsMagi = root.name === TAB_NAME || root.sessionStorage.getItem('a1TabKey') === TAB_KEY; } catch (e) {}
    try { if (root.name === TAB_NAME) root.name = ''; } catch (e) {}
    try { w = root.open('', TAB_NAME); } catch (e) { w = null; }
    if (w === root) w = null;
    if (!w) { try { return !!root.open(url, TAB_NAME); } catch (e) { return false; } }
    var cur = null;
    try { cur = w.location.href; } catch (e) { cur = null; }
    if (cur === '' || cur === 'about:blank') {
      try { w.name = TAB_NAME; } catch (e) {}
      if (!selfIsMagi && claimed()) { handOver(w, url); return true; }
    }
    // The console itself, or a blank tab nobody claims. Only the fragment
    // differs for an open console, so this is not a reload: MAGI hears it on
    // hashchange.
    go(w, url);
    return true;
  }

  /* The ▶ button. `events` is the card's event(s); `opts.macroET(ev)` is
   * the host's release-time table; `opts.magiUrl` an override (LifeHub may
   * point MAGI elsewhere). Synchronous inside the click, or the tab open is
   * popup-blocked. Returns false when the browser refused the tab. */
  function launch(events, profile, opts) {
    opts = opts || {};
    var p = PROFILES.indexOf(profile) >= 0 ? profile : 'tony';
    var cfg = CFG;
    var q = prompt(events, cfg, opts.macroET);
    if (!q) return false;
    return openMagi(link(q, cfg[p].units, p, opts.magiUrl));
  }

  root.A1Debrief = {
    MAGI_URL: MAGI_URL, DOC: DOC, PROFILES: PROFILES, DELAY_MIN: DELAY_MIN,
    DEFAULT_UNITS: DEFAULT_UNITS, TEMPLATES: TEMPLATES, PLACEHOLDERS: PLACEHOLDERS,
    EARN_ET: EARN_ET, LATE_ET: LATE_ET, GROUP_MIN: GROUP_MIN, GROUP_MAX: GROUP_MAX, KINDS: KINDS,
    groups: groups, isGroup: isGroup, debriefable: debriefable,
    normalize: normalize, setConfig: setConfig, config: config,
    releaseAt: releaseAt, dueAt: dueAt, isDue: isDue, nextDue: nextDue,
    fill: fill, prompt: prompt, link: link, b64u: b64u, openMagi: openMagi, launch: launch
  };
})(typeof window !== 'undefined' ? window : this);
