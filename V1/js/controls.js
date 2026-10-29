/* ============================================================================
 * StudyOS — form controls (window.SosControls)
 * ============================================================================
 * No browser-drawn controls anywhere in StudyOS (Tony, 2026-10-29): every
 * <select>, date, time and number field is shown as StudyOS's own.
 *
 * Progressive, not a rewrite: the native element STAYS in the DOM, hidden, and
 * stays the source of truth. A trigger is drawn beside it and a popover opens
 * from the trigger. So every existing line that reads or sets `.value`, fills a
 * <select> with innerHTML, or listens for `change` keeps working untouched:
 *
 *   - `.value` (and a select's `.selectedIndex`) get an own setter on the
 *     element that writes through to the native one and repaints the trigger;
 *   - a select's options are watched (MutationObserver), so a refill repaints;
 *   - a pick sets the value and dispatches real `input` + `change` events
 *     (bubbling), so inline onchange="" handlers and listeners both fire.
 *
 * Number fields keep their text box (typing a number is fastest) and gain a
 * minus / plus pair; the browser's spin arrows are hidden in CSS.
 *
 * Enhances everything already on the page at boot and anything added later
 * (one MutationObserver on <body>). Skips V's Notebook (its own UI) and any
 * element marked data-native.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.SosControls) return;

  var SKIP = '.sos-nb-host, .sos-nb-modal-host, [data-native]';
  var SEL = 'select, input[type="date"], input[type="time"], input[type="number"]';
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function svg(body, w) {
    return '<svg viewBox="0 0 24 24" width="' + (w || 16) + '" height="' + (w || 16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var IC = {
    chev:  svg('<path d="m6 9 6 6 6-6"/>', 14),
    left:  svg('<path d="m15 18-6-6 6-6"/>'),
    right: svg('<path d="m9 18 6-6-6-6"/>'),
    cal:   svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>', 14),
    minus: svg('<path d="M5 12h14"/>', 14),
    plus:  svg('<path d="M12 5v14"/><path d="M5 12h14"/>', 14),
    x:     svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 13)
  };

  var DESC_IN = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var DESC_SEL = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var DESC_SI = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

  function rawVal(el) { return (el.tagName === 'SELECT' ? DESC_SEL : DESC_IN).get.call(el); }
  function setRaw(el, v) { (el.tagName === 'SELECT' ? DESC_SEL : DESC_IN).set.call(el, v); }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* Give an element an own `.value` setter that repaints its trigger. */
  function watchValue(el, repaint) {
    var d = el.tagName === 'SELECT' ? DESC_SEL : DESC_IN;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return d.get.call(this); },
      set: function (v) { d.set.call(this, v); repaint(); }
    });
    if (el.tagName === 'SELECT') {
      Object.defineProperty(el, 'selectedIndex', {
        configurable: true,
        get: function () { return DESC_SI.get.call(this); },
        set: function (v) { DESC_SI.set.call(this, v); repaint(); }
      });
    }
    el.addEventListener('change', repaint);
    new MutationObserver(repaint).observe(el, { attributes: true, attributeFilter: ['disabled'], childList: el.tagName === 'SELECT', subtree: el.tagName === 'SELECT' });
  }

  /* ── The one popover ───────────────────────────────────────────────────── */
  var pop = null, popOwner = null, popClose = null;
  function closePop() {
    if (!pop) return;
    var p = pop, owner = popOwner, cb = popClose;
    pop = null; popOwner = null; popClose = null;
    p.classList.add('leave');
    setTimeout(function () { p.remove(); }, 120);
    if (owner) owner.setAttribute('aria-expanded', 'false');
    if (cb) cb();
  }
  function openPop(trigger, build, onClose, minW) {
    if (pop && popOwner === trigger) { closePop(); return null; }
    closePop();
    var p = document.createElement('div');
    p.className = 'sosc-pop';
    p.setAttribute('role', 'dialog');
    document.body.appendChild(p);
    pop = p; popOwner = trigger; popClose = onClose || null;
    trigger.setAttribute('aria-expanded', 'true');
    build(p);
    place(p, trigger, minW);
    return p;
  }
  function place(p, trigger, minW) {
    var r = trigger.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = Math.max(r.width, minW || 0);
    w = Math.min(w, vw - 16);
    p.style.width = w + 'px';
    var left = Math.min(Math.max(8, r.left), vw - w - 8);
    p.style.left = left + 'px';
    var h = p.offsetHeight;
    var below = vh - r.bottom - 8, above = r.top - 8;
    if (h <= below || below >= above) {
      p.style.top = (r.bottom + 6) + 'px';
      p.style.maxHeight = Math.max(160, below - 6) + 'px';
      p.classList.remove('up');
    } else {
      p.style.maxHeight = Math.max(160, above - 6) + 'px';
      h = Math.min(h, above - 6);
      p.style.top = (r.top - 6 - h) + 'px';
      p.classList.add('up');
    }
  }
  document.addEventListener('pointerdown', function (e) {
    if (!pop) return;
    if (pop.contains(e.target) || (popOwner && popOwner.contains(e.target))) return;
    closePop();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (pop && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); var o = popOwner; closePop(); if (o) o.focus(); }
  }, true);
  window.addEventListener('resize', closePop);
  document.addEventListener('scroll', function (e) {
    if (pop && !pop.contains(e.target)) closePop();
  }, true);

  function trig(el, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sosc-trigger ' + cls;
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    // Keep the field's own width hints (inline max-width / flex / width).
    ['width', 'maxWidth', 'minWidth', 'flex'].forEach(function (k) { if (el.style[k]) b.style[k] = el.style[k]; });
    if (el.id) b.id = el.id + '-sosc';
    el.classList.add('sosc-native');
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-hidden', 'true');
    el.insertAdjacentElement('afterend', b);
    // A <label for=…> pointing at the hidden field now focuses the trigger.
    if (el.id) document.querySelectorAll('label[for="' + el.id + '"]').forEach(function (l) {
      l.addEventListener('click', function (ev) { ev.preventDefault(); b.focus(); });
    });
    return b;
  }

  /* ── Select ─────────────────────────────────────────────────────────────── */
  function enhanceSelect(el) {
    var b = trig(el, 'sosc-select');
    function paint() {
      var o = el.options[el.selectedIndex];
      var txt = o ? o.textContent : '';
      b.innerHTML = '<span class="sosc-txt' + (!o || o.value === '' ? ' ph' : '') + '">' + esc(txt || 'Choose…') + '</span><span class="sosc-chev">' + IC.chev + '</span>';
      b.disabled = el.disabled;
    }
    watchValue(el, paint);
    paint();
    b.addEventListener('click', function () {
      if (el.disabled) return;
      openPop(b, function (p) {
        p.classList.add('sosc-list');
        p.setAttribute('role', 'listbox');
        var rows = [];
        Array.prototype.forEach.call(el.children, function (node) {
          if (node.tagName === 'OPTGROUP') {
            var h = document.createElement('div'); h.className = 'sosc-grp'; h.textContent = node.label; p.appendChild(h);
            Array.prototype.forEach.call(node.children, add);
          } else add(node);
        });
        function add(o) {
          if (o.tagName !== 'OPTION' || o.hidden) return;
          var r = document.createElement('button');
          r.type = 'button';
          r.className = 'sosc-opt' + (o.selected ? ' on' : '');
          r.disabled = o.disabled;
          r.setAttribute('role', 'option');
          r.innerHTML = '<span class="sosc-otxt">' + esc(o.textContent) + '</span>' + (o.selected ? '<span class="sosc-tick">' + IC.check + '</span>' : '');
          r.addEventListener('click', function () {
            var changed = rawVal(el) !== o.value;
            setRaw(el, o.value);
            paint();
            closePop();
            b.focus();
            if (changed) fire(el);
          });
          p.appendChild(r);
          rows.push(r);
        }
        p.addEventListener('keydown', function (e) {
          var i = rows.indexOf(document.activeElement);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            var n = i + (e.key === 'ArrowDown' ? 1 : -1);
            while (rows[n] && rows[n].disabled) n += (e.key === 'ArrowDown' ? 1 : -1);
            if (rows[n]) rows[n].focus();
          } else if (e.key.length === 1) {
            var k = e.key.toLowerCase();
            var hit = rows.find(function (r, j) { return j > i && !r.disabled && r.textContent.trim().toLowerCase().charAt(0) === k; })
                   || rows.find(function (r) { return !r.disabled && r.textContent.trim().toLowerCase().charAt(0) === k; });
            if (hit) hit.focus();
          }
        });
        setTimeout(function () {
          var on = p.querySelector('.sosc-opt.on') || rows[0];
          if (on) { on.focus({ preventScroll: true }); on.scrollIntoView({ block: 'nearest' }); }
        }, 10);
      }, null, 200);
    });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); b.click(); }
    });
  }

  /* ── Date ───────────────────────────────────────────────────────────────── */
  function fmtDate(v) {
    var d = parseIso(v);
    if (!d) return '';
    // The year only when it is not this one: the field stays short enough for a phone.
    var o = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('en-US', o);
  }
  function enhanceDate(el) {
    var b = trig(el, 'sosc-date');
    function paint() {
      var v = rawVal(el);
      b.innerHTML = '<span class="sosc-ic">' + IC.cal + '</span><span class="sosc-txt' + (v ? '' : ' ph') + '">' + esc(v ? fmtDate(v) : (el.placeholder || 'Pick a date')) + '</span>';
      b.disabled = el.disabled;
    }
    watchValue(el, paint);
    paint();
    b.addEventListener('click', function () {
      if (el.disabled) return;
      var cur = parseIso(rawVal(el)) || new Date();
      var view = new Date(cur.getFullYear(), cur.getMonth(), 1);
      openPop(b, function (p) {
        p.classList.add('sosc-cal');
        function pick(v) {
          var changed = rawVal(el) !== v;
          setRaw(el, v); paint(); closePop(); b.focus();
          if (changed) fire(el);
        }
        function draw() {
          var y = view.getFullYear(), m = view.getMonth();
          var first = new Date(y, m, 1).getDay();
          var days = new Date(y, m + 1, 0).getDate();
          var sel = rawVal(el), today = iso(new Date());
          var html = '<div class="sosc-cal-hd"><button type="button" class="sosc-nav" data-nav="-1" aria-label="Previous month">' + IC.left + '</button>'
            + '<div class="sosc-cal-t">' + MONTHS[m] + ' <span>' + y + '</span></div>'
            + '<button type="button" class="sosc-nav" data-nav="1" aria-label="Next month">' + IC.right + '</button></div>'
            + '<div class="sosc-dow">' + DOW.map(function (d) { return '<span>' + d + '</span>'; }).join('') + '</div><div class="sosc-days">';
          for (var i = 0; i < first; i++) html += '<span></span>';
          for (var d = 1; d <= days; d++) {
            var v = y + '-' + pad(m + 1) + '-' + pad(d);
            html += '<button type="button" class="sosc-day' + (v === sel ? ' on' : '') + (v === today ? ' today' : '') + '" data-v="' + v + '">' + d + '</button>';
          }
          html += '</div><div class="sosc-foot"><button type="button" class="sosc-link" data-clear>Clear</button><button type="button" class="sosc-link pri" data-today>Today</button></div>';
          p.innerHTML = html;
          p.querySelectorAll('[data-nav]').forEach(function (n) {
            n.addEventListener('click', function () { view.setMonth(view.getMonth() + (+n.dataset.nav)); draw(); });
          });
          p.querySelectorAll('[data-v]').forEach(function (n) { n.addEventListener('click', function () { pick(n.dataset.v); }); });
          p.querySelector('[data-clear]').addEventListener('click', function () { pick(''); });
          p.querySelector('[data-today]').addEventListener('click', function () { pick(today); });
        }
        draw();
        setTimeout(function () { var on = p.querySelector('.sosc-day.on') || p.querySelector('.sosc-day.today') || p.querySelector('.sosc-day'); if (on) on.focus({ preventScroll: true }); }, 10);
      }, null, 288);
    });
  }

  /* ── Time ───────────────────────────────────────────────────────────────── */
  function fmtTime(v) {
    var m = /^(\d{1,2}):(\d{2})/.exec(v || '');
    if (!m) return '';
    var h = +m[1], ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  }
  function enhanceTime(el) {
    var b = trig(el, 'sosc-time');
    function paint() {
      var v = rawVal(el);
      b.innerHTML = '<span class="sosc-ic">' + IC.clock + '</span><span class="sosc-txt' + (v ? '' : ' ph') + '">' + esc(v ? fmtTime(v) : (el.placeholder || 'Pick a time')) + '</span>';
      b.disabled = el.disabled;
    }
    watchValue(el, paint);
    paint();
    b.addEventListener('click', function () {
      if (el.disabled) return;
      openPop(b, function (p) {
        p.classList.add('sosc-clock');
        var m0 = /^(\d{1,2}):(\d{2})/.exec(rawVal(el) || '');
        var H = m0 ? +m0[1] : 9, M = m0 ? +m0[2] : 0;
        var hadValue = !!m0;
        function commit() {
          var v = pad(H) + ':' + pad(M);
          var changed = rawVal(el) !== v;
          setRaw(el, v); paint(); hadValue = true;
          if (changed) fire(el);
          draw();
        }
        function col(items, isOn, onPick, cls) {
          return '<div class="sosc-col ' + cls + '">' + items.map(function (it, i) {
            return '<button type="button" class="sosc-cell' + (isOn(it) ? ' on' : '') + '" data-i="' + i + '">' + it.label + '</button>';
          }).join('') + '</div>';
        }
        var hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (h) { return { label: String(h), h12: h }; });
        var mins = [];
        for (var i = 0; i < 60; i += 5) mins.push({ label: pad(i), m: i });
        if (M % 5) { mins.push({ label: pad(M), m: M }); mins.sort(function (a, c) { return a.m - c.m; }); }
        var aps = [{ label: 'AM', pm: false }, { label: 'PM', pm: true }];
        function draw() {
          var pm = H >= 12, h12 = H % 12 || 12;
          p.innerHTML = '<div class="sosc-cols">'
            + col(hours, function (it) { return hadValue && it.h12 === h12; }, null, 'h')
            + col(mins, function (it) { return hadValue && it.m === M; }, null, 'm')
            + col(aps, function (it) { return hadValue && it.pm === pm; }, null, 'ap')
            + '</div><div class="sosc-foot"><button type="button" class="sosc-link" data-clear>Clear</button><button type="button" class="sosc-link pri" data-done>Done</button></div>';
          p.querySelectorAll('.sosc-col.h .sosc-cell').forEach(function (n, i) {
            n.addEventListener('click', function () { var hh = hours[i].h12 % 12; H = (H >= 12 ? 12 : 0) + hh; commit(); });
          });
          p.querySelectorAll('.sosc-col.m .sosc-cell').forEach(function (n, i) {
            n.addEventListener('click', function () { M = mins[i].m; commit(); });
          });
          p.querySelectorAll('.sosc-col.ap .sosc-cell').forEach(function (n, i) {
            n.addEventListener('click', function () { var pmNow = aps[i].pm; H = (H % 12) + (pmNow ? 12 : 0); commit(); });
          });
          p.querySelector('[data-clear]').addEventListener('click', function () {
            var changed = rawVal(el) !== '';
            setRaw(el, ''); paint(); closePop(); b.focus();
            if (changed) fire(el);
          });
          p.querySelector('[data-done]').addEventListener('click', function () { if (!hadValue) commit(); closePop(); b.focus(); });
          p.querySelectorAll('.sosc-col').forEach(function (c) {
            var on = c.querySelector('.sosc-cell.on');
            if (on) c.scrollTop = on.offsetTop - c.clientHeight / 2 + on.offsetHeight / 2;
          });
        }
        draw();
      }, null, 240);
    });
  }

  /* ── Number ─────────────────────────────────────────────────────────────── */
  function enhanceNumber(el) {
    var wrap = document.createElement('span');
    wrap.className = 'sosc-num';
    ['width', 'maxWidth', 'minWidth', 'flex'].forEach(function (k) { if (el.style[k]) { wrap.style[k] = el.style[k]; el.style[k] = ''; } });
    el.parentNode.insertBefore(wrap, el);
    var minus = document.createElement('button');
    minus.type = 'button'; minus.className = 'sosc-step'; minus.innerHTML = IC.minus; minus.setAttribute('aria-label', 'Decrease');
    var plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'sosc-step'; plus.innerHTML = IC.plus; plus.setAttribute('aria-label', 'Increase');
    wrap.appendChild(minus); wrap.appendChild(el); wrap.appendChild(plus);
    el.classList.add('sosc-numin');
    el.setAttribute('inputmode', el.step && String(el.step).indexOf('.') >= 0 ? 'decimal' : 'numeric');
    function stepBy(dir) {
      if (el.disabled) return;
      var st = parseFloat(el.step) || 1;
      var lo = el.min !== '' ? parseFloat(el.min) : -Infinity, hi = el.max !== '' ? parseFloat(el.max) : Infinity;
      var cur = parseFloat(rawVal(el));
      if (!isFinite(cur)) cur = isFinite(lo) ? lo : 0; else cur += dir * st;
      cur = Math.min(hi, Math.max(lo, cur));
      var dec = (String(st).split('.')[1] || '').length;
      setRaw(el, dec ? cur.toFixed(dec) : String(Math.round(cur)));
      fire(el);
    }
    // Press and hold repeats, after a pause, like a native spinner.
    [[minus, -1], [plus, 1]].forEach(function (pair) {
      var t = null, iv = null;
      pair[0].addEventListener('pointerdown', function (e) {
        e.preventDefault();
        stepBy(pair[1]);
        t = setTimeout(function () { iv = setInterval(function () { stepBy(pair[1]); }, 70); }, 420);
      });
      function stop() { clearTimeout(t); clearInterval(iv); t = iv = null; }
      pair[0].addEventListener('pointerup', stop);
      pair[0].addEventListener('pointerleave', stop);
      pair[0].addEventListener('pointercancel', stop);
      pair[0].addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepBy(pair[1]); } });
    });
  }

  /* ── Wiring ─────────────────────────────────────────────────────────────── */
  function enhance(el) {
    if (el._sosc || (el.closest && el.closest(SKIP))) return;
    el._sosc = true;
    try {
      if (el.tagName === 'SELECT') { if (!el.multiple && !(el.size > 1)) enhanceSelect(el); }
      else if (el.type === 'date') enhanceDate(el);
      else if (el.type === 'time') enhanceTime(el);
      else if (el.type === 'number') enhanceNumber(el);
    } catch (e) { console.warn('[StudyOS] control enhance failed:', e); }
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(SEL)) enhance(root);
    root.querySelectorAll(SEL).forEach(enhance);
  }
  var queued = false, pending = [];
  function boot() {
    scan(document.body);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) pending.push(n); }); });
      if (queued || !pending.length) return;
      queued = true;
      // A microtask: the code that inserted the field sets its value right
      // after, in the same task, and that value must win the first paint.
      Promise.resolve().then(function () {
        queued = false;
        var list = pending; pending = [];
        list.forEach(function (n) { if (n.isConnected) scan(n); });
        if (pop && popOwner && !popOwner.isConnected) closePop();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.SosControls = { enhance: enhance, scan: scan, close: closePop, formatDate: fmtDate, formatTime: fmtTime };
})();
