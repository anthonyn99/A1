/* ============================================================================
 * StudyOS — modal dialog primitives
 * ============================================================================
 * Ported from the original host page, which StudyOS depended on for every
 * confirm/prompt it shows. Provides window.uiModal / uiAlert / uiConfirm /
 * uiPrompt / uiForm / uiChoice, all promise-based.
 *
 * Also replaces the native window.alert, so a blocking browser dialog can
 * never interrupt an upload or a sync, and every question StudyOS asks wears
 * its own look.
 *
 * uiChoice is the three-way question ("All future" / "Only this one" /
 * Cancel). Repeating deletes used to ride on uiConfirm with Cancel relabelled
 * "This only", so Escape or a stray Cancel DELETED an occurrence.
 *
 * The overlay never closes on a click outside the card: only a button or
 * Escape answers it.
 *
 * Self-contained: no libraries, injects its own CSS on first use.
 * ------------------------------------------------------------------------- */
(function () {
  if (window.uiModal) return;

  var CFG    = (window.STUDYOS_CONFIG || {});
  var ACCENT = (CFG.shell && CFG.shell.accent) || '#8D769A';

  function svg(body) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var ICONS = {
    danger: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
    info:   svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>'),
    ask:    svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>'),
    edit:   svg('<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
    repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>')
  };

  var CSS =
    '#uim-overlay{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(10,10,12,.62);backdrop-filter:blur(10px) saturate(120%);-webkit-backdrop-filter:blur(10px) saturate(120%);padding:20px;box-sizing:border-box;}'
  + '#uim-overlay.show{display:flex;animation:uimFade .18s ease;}'
  + '@keyframes uimFade{from{opacity:0}to{opacity:1}}'
  + '#uim-box{position:relative;width:100%;max-width:400px;background:linear-gradient(180deg,#212125 0%,#1b1b1f 100%);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:26px 24px 20px;box-shadow:0 40px 90px -20px rgba(0,0,0,.7),0 0 0 1px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.05);box-sizing:border-box;font-family:\'Nunito\',system-ui,-apple-system,sans-serif;color:#eeedf1;animation:uimIn .26s cubic-bezier(.2,.8,.2,1);}'
  + '@keyframes uimIn{from{transform:translateY(10px) scale(.97);opacity:0}to{transform:none;opacity:1}}'
  + '#uim-ic{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;color:#b9a3c8;background:rgba(141,118,154,.14);border:1px solid rgba(141,118,154,.22);}'
  + '#uim-ic.danger{color:#f0a9a9;background:rgba(239,159,159,.12);border-color:rgba(239,159,159,.22);}'
  + '#uim-title{font-family:\'Lora\',Georgia,serif;font-size:20px;font-weight:600;letter-spacing:-.2px;color:#f4f3f6;margin-bottom:6px;line-height:1.3;}'
  + '#uim-msg{font-size:14px;color:#a9a7b1;line-height:1.6;white-space:pre-wrap;margin-bottom:8px;}'
  + '#uim-fields{display:flex;flex-direction:column;gap:12px;margin-top:10px;}'
  + '.uim-field{display:block;}'
  + '.uim-label{display:block;font-size:10.5px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:#8a8794;margin:0 0 7px;}'
  + '.uim-input{width:100%;box-sizing:border-box;background:#141416;border:1px solid rgba(255,255,255,.1);border-radius:11px;color:#f4f3f6;font-size:14.5px;font-weight:600;padding:11px 14px;outline:none;font-family:inherit;transition:border-color .18s,box-shadow .18s;}'
  + '.uim-input:focus{border-color:' + ACCENT + ';box-shadow:0 0 0 3px rgba(141,118,154,.22);}'
  + '#uim-err{font-size:12.5px;color:#f0a9a9;font-weight:700;margin-top:8px;}'
  + '#uim-err:empty{display:none;}'
  + '#uim-btns{display:flex;gap:8px;margin-top:22px;justify-content:flex-end;flex-wrap:wrap;}'
  + '#uim-btns button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:#eeedf1;border-radius:11px;padding:10px 18px;min-height:40px;font-size:13.5px;font-weight:700;letter-spacing:.1px;cursor:pointer;font-family:inherit;transition:background .18s,border-color .18s,color .18s,transform .12s;}'
  + '#uim-btns button:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2);}'
  + '#uim-btns button:active{transform:scale(.97);}'
  + '#uim-btns button.pri{background:' + ACCENT + ';border-color:' + ACCENT + ';color:#fff;box-shadow:0 8px 22px -8px rgba(141,118,154,.7);}'
  + '#uim-btns button.pri:hover{background:#9a83a8;border-color:#9a83a8;}'
  + '#uim-btns button.dg{background:rgba(239,159,159,.14);border-color:rgba(239,159,159,.45);color:#f6b9b9;}'
  + '#uim-btns button.dg:hover{background:rgba(239,159,159,.22);border-color:#ef9f9f;color:#ffd0d0;}'
  + '#uim-btns button:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(141,118,154,.35);}'
  + '#uim-btns .uim-sp{flex:1;}'
  + '@media (max-width:520px){#uim-overlay{align-items:flex-end;padding:0;}#uim-box{max-width:none;border-radius:22px 22px 0 0;padding:24px 20px calc(env(safe-area-inset-bottom,0px) + 18px);animation:uimUp .3s cubic-bezier(.2,.8,.2,1);}'
  + '#uim-btns{flex-direction:column-reverse;}#uim-btns button{width:100%;min-height:46px;}#uim-btns .uim-sp{display:none;}.uim-input{font-size:16px;}}'
  + '@keyframes uimUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}'
  + '@media (prefers-reduced-motion:reduce){#uim-box,#uim-overlay.show{animation:none;}}';

  var queue = [], active = null;
  function el(id) { return document.getElementById(id); }

  function inject() {
    if (el('uim-overlay')) return;
    var st = document.createElement('style'); st.id = 'uim-style'; st.textContent = CSS; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.id = 'uim-overlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = '<form id="uim-box" autocomplete="off">'
      + '<div id="uim-ic"></div><div id="uim-title"></div><div id="uim-msg"></div><div id="uim-fields"></div>'
      + '<div id="uim-err"></div><div id="uim-btns"></div></form>';
    document.body.appendChild(ov);
    el('uim-box').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    // Capture phase: a dialog answers Escape before any modal under it does.
    document.addEventListener('keydown', function (e) {
      if (active && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue(active)); }
    }, true);
  }

  function cancelValue(cfg) { return cfg.kind === 'confirm' ? false : null; }

  function button(label, cls, onClick, type) {
    var b = document.createElement('button');
    b.type = type || 'button'; b.textContent = label;
    if (cls) b.className = cls;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function render(cfg) {
    inject(); active = cfg;
    var ic = el('uim-ic');
    var icon = cfg.icon || (cfg.danger ? 'danger' : cfg.kind === 'alert' ? 'info' : (cfg.kind === 'confirm' || cfg.kind === 'choice') ? 'ask' : 'edit');
    ic.innerHTML = ICONS[icon] || ICONS.info;
    ic.className = cfg.danger ? 'danger' : '';
    el('uim-title').textContent = cfg.title || '';
    el('uim-title').style.display = cfg.title ? '' : 'none';
    el('uim-msg').textContent = cfg.message || '';
    el('uim-msg').style.display = cfg.message ? '' : 'none';
    var fw = el('uim-fields'); fw.innerHTML = '';
    fw.style.display = (cfg.fields && cfg.fields.length) ? '' : 'none';
    (cfg.fields || []).forEach(function (f) {
      var lab = document.createElement('label'); lab.className = 'uim-field';
      if (f.label) { var sp = document.createElement('span'); sp.className = 'uim-label'; sp.textContent = f.label; lab.appendChild(sp); }
      var inp = document.createElement('input'); inp.className = 'uim-input'; inp.type = f.type || 'text';
      inp.value = (f.value != null ? f.value : ''); if (f.placeholder) inp.placeholder = f.placeholder; inp.setAttribute('data-name', f.name);
      if (f.autocap === false) { inp.autocapitalize = 'off'; inp.setAttribute('autocorrect', 'off'); inp.spellcheck = false; }
      lab.appendChild(inp); fw.appendChild(lab);
    });
    el('uim-err').textContent = '';

    var row = el('uim-btns'); row.innerHTML = '';
    if (cfg.kind === 'choice') {
      row.appendChild(button(cfg.cancelLabel || 'Cancel', '', function () { close(null); }));
      var sp = document.createElement('span'); sp.className = 'uim-sp'; row.appendChild(sp);
      (cfg.choices || []).forEach(function (c) {
        row.appendChild(button(c.label, c.danger ? 'dg' : (c.primary ? 'pri' : ''), function () { close(c.value); }));
      });
    } else {
      if (cfg.kind !== 'alert') row.appendChild(button(cfg.cancelLabel || 'Cancel', '', function () { close(cancelValue(cfg)); }));
      row.appendChild(button(cfg.okLabel || 'OK', cfg.danger ? 'dg' : 'pri', null, 'submit'));
    }
    el('uim-overlay').classList.add('show');
    setTimeout(function () {
      var fi = fw.querySelector('input');
      if (fi) { fi.focus(); try { fi.select(); } catch (e) {} }
      else { var last = row.lastElementChild; if (last) last.focus(); }
    }, 40);
  }

  function collect() {
    var o = {}; var ins = el('uim-fields').querySelectorAll('input');
    Array.prototype.forEach.call(ins, function (i) { o[i.getAttribute('data-name')] = i.value; });
    return o;
  }

  function submit() {
    if (!active) return; var cfg = active;
    if (cfg.kind === 'choice') return;
    if (cfg.fields && cfg.fields.length) {
      var vals = collect(), ins = el('uim-fields').querySelectorAll('input');
      for (var i = 0; i < cfg.fields.length; i++) {
        var f = cfg.fields[i];
        if (f.required && !String(vals[f.name] || '').trim()) { el('uim-err').textContent = (f.label || 'This field') + ' is required.'; if (ins[i]) ins[i].focus(); return; }
      }
      close(cfg.kind === 'prompt' ? String(vals[cfg.fields[0].name]) : vals);
    } else { close(cfg.kind === 'confirm' ? true : undefined); }
  }

  function close(result) {
    var cfg = active; active = null;
    var ov = el('uim-overlay'); if (ov) ov.classList.remove('show');
    if (cfg && cfg.resolve) cfg.resolve(result);
    if (queue.length) { render(queue.shift()); }
  }

  function open(cfg) { return new Promise(function (res) { cfg.resolve = res; if (active) queue.push(cfg); else render(cfg); }); }

  window.uiModal = open;
  window.uiIsOpen = function () { return !!active; };
  window.uiAlert = function (m, o) { o = o || {}; return open({ kind: 'alert', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK', icon: o.icon }); };
  window.uiConfirm = function (m, o) { o = o || {}; return open({ kind: 'confirm', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK', cancelLabel: o.cancelLabel || 'Cancel', danger: o.danger, icon: o.icon }); };
  window.uiPrompt = function (m, o) {
    o = o || {};
    return open({ kind: 'prompt', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK', cancelLabel: o.cancelLabel || 'Cancel',
      fields: [{ name: 'value', type: o.password ? 'password' : 'text', value: (o.default != null ? o.default : (o.value != null ? o.value : '')), placeholder: o.placeholder || '', autocap: o.autocap }] });
  };
  window.uiForm = function (cfg) {
    cfg = cfg || {};
    return open({ kind: 'form', title: cfg.title, message: cfg.message, okLabel: cfg.okLabel || 'Save', cancelLabel: cfg.cancelLabel || 'Cancel', danger: cfg.danger, fields: cfg.fields || [] });
  };
  /** Several answers plus Cancel: resolves the chosen `value`, or null on
   *  Cancel / Escape. choices: [{label, value, danger?, primary?}]. */
  window.uiChoice = function (m, o) {
    o = o || {};
    return open({ kind: 'choice', message: String(m == null ? '' : m), title: o.title, choices: o.choices || [], cancelLabel: o.cancelLabel || 'Cancel', danger: o.danger, icon: o.icon });
  };
  /** The one delete confirmation every remove/delete control in StudyOS asks. */
  window.sosConfirmDelete = function (what, detail, okLabel) {
    return window.uiConfirm(detail || 'This can’t be undone.', { title: 'Delete ' + what + '?', okLabel: okLabel || 'Delete', danger: true });
  };
  try { window.alert = function (m) { window.uiAlert(m == null ? '' : String(m)); }; } catch (e) {}
})();
