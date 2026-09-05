/* ============================================================================
 * StudyOS — modal dialog primitives
 * ============================================================================
 * Ported from the original host page, which StudyOS depended on for every
 * confirm/prompt it shows. Provides window.uiModal / uiAlert / uiConfirm /
 * uiPrompt / uiForm, all promise-based.
 *
 * Also replaces the native window.alert so a blocking browser dialog can never
 * interrupt an upload or a sync.
 *
 * Self-contained: no libraries, injects its own CSS on first use. The only
 * change from the original is that the accent color reads from config instead
 * of being hardcoded to the host page's gold.
 * ------------------------------------------------------------------------- */
(function () {
  if (window.uiModal) return;

  var CFG    = (window.STUDYOS_CONFIG || {});
  var ACCENT = (CFG.shell && CFG.shell.accent) || '#8D769A';
  // Accent at ~36% / ~22% alpha for borders and focus rings. Derived rather
  // than hardcoded so a themed build stays coherent.
  function tint(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  var CSS =
    '#uim-overlay{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(14,14,16,.66);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);padding:20px;box-sizing:border-box;}'
  + '#uim-overlay.show{display:flex;}'
  + '#uim-box{width:100%;max-width:370px;background:#2c2c31;border:1px solid #45454c;border-radius:9px;padding:26px 24px;box-shadow:0 30px 70px rgba(0,0,0,.48);box-sizing:border-box;font-family:\'Inter\',system-ui,-apple-system,sans-serif;animation:uimIn .16s ease;}'
  + '@keyframes uimIn{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}'
  + '#uim-title{font-family:\'Manrope\',system-ui,sans-serif;font-size:20px;font-weight:600;letter-spacing:-.2px;color:#f4f3f0;margin-bottom:8px;line-height:1.25;}'
  + '#uim-msg{font-size:13.5px;color:#adadb2;line-height:1.55;white-space:pre-wrap;margin-bottom:16px;}'
  + '.uim-field{display:block;margin-bottom:12px;}'
  + '.uim-label{display:block;font-size:10px;font-weight:500;letter-spacing:1.4px;text-transform:uppercase;color:#8d8d94;margin:0 0 7px;}'
  + '.uim-input{width:100%;box-sizing:border-box;background:#232327;border:1px solid #45454c;border-radius:6px;color:#f4f3f0;font-size:13.5px;font-weight:500;padding:10px 13px;outline:none;font-family:inherit;transition:border-color .18s;}'
  + '.uim-input:focus{border-color:' + ACCENT + ';}'
  + '#uim-err{font-size:12.5px;color:#dda398;font-weight:500;min-height:15px;margin-bottom:4px;}'
  + '#uim-btns{display:flex;gap:10px;margin-top:20px;justify-content:flex-end;}'
  + '#uim-btns button{border:1px solid #45454c;background:transparent;border-radius:6px;padding:9px 16px;font-size:11.5px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:border-color .18s,color .18s;}'
  + '#uim-cancel{color:#f4f3f0;}' + '#uim-cancel:hover{border-color:#adadb2;}';

  var queue = [], active = null;
  function el(id) { return document.getElementById(id); }

  function inject() {
    if (el('uim-overlay')) return;
    var st = document.createElement('style'); st.id = 'uim-style'; st.textContent = CSS; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.id = 'uim-overlay';
    ov.innerHTML = '<form id="uim-box" autocomplete="off">'
      + '<div id="uim-title"></div><div id="uim-msg"></div><div id="uim-fields"></div>'
      + '<div id="uim-err"></div>'
      + '<div id="uim-btns"><button type="button" id="uim-cancel"></button><button type="submit" id="uim-ok"></button></div></form>';
    document.body.appendChild(ov);
    el('uim-cancel').addEventListener('click', function () { close(active && active.kind === 'confirm' ? false : null); });
    el('uim-box').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    document.addEventListener('keydown', function (e) { if (active && e.key === 'Escape') { close(active.kind === 'confirm' ? false : null); } });
  }

  function render(cfg) {
    inject(); active = cfg;
    el('uim-title').textContent = cfg.title || ''; el('uim-title').style.display = cfg.title ? '' : 'none';
    el('uim-msg').textContent = cfg.message || ''; el('uim-msg').style.display = cfg.message ? '' : 'none';
    var fw = el('uim-fields'); fw.innerHTML = '';
    (cfg.fields || []).forEach(function (f) {
      var lab = document.createElement('label'); lab.className = 'uim-field';
      if (f.label) { var sp = document.createElement('span'); sp.className = 'uim-label'; sp.textContent = f.label; lab.appendChild(sp); }
      var inp = document.createElement('input'); inp.className = 'uim-input'; inp.type = f.type || 'text';
      inp.value = (f.value != null ? f.value : ''); if (f.placeholder) inp.placeholder = f.placeholder; inp.setAttribute('data-name', f.name);
      if (f.autocap === false) { inp.autocapitalize = 'off'; inp.setAttribute('autocorrect', 'off'); inp.spellcheck = false; }
      lab.appendChild(inp); fw.appendChild(lab);
    });
    el('uim-err').textContent = '';
    var ok = el('uim-ok'), ca = el('uim-cancel');
    ok.textContent = cfg.okLabel || 'OK';
    ok.style.background = 'transparent';
    ok.style.color = cfg.danger ? '#dda398' : ACCENT;
    ok.style.borderColor = cfg.danger ? 'rgba(214,138,124,.45)' : tint(ACCENT, .36);
    ca.textContent = cfg.cancelLabel || 'Cancel'; ca.style.display = (cfg.kind === 'alert') ? 'none' : '';
    el('uim-overlay').classList.add('show');
    setTimeout(function () { var fi = fw.querySelector('input'); if (fi) { fi.focus(); try { fi.select(); } catch (e) {} } else ok.focus(); }, 40);
  }

  function collect() {
    var o = {}; var ins = el('uim-fields').querySelectorAll('input');
    Array.prototype.forEach.call(ins, function (i) { o[i.getAttribute('data-name')] = i.value; });
    return o;
  }

  function submit() {
    if (!active) return; var cfg = active;
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
  window.uiAlert = function (m, o) { o = o || {}; return open({ kind: 'alert', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK' }); };
  window.uiConfirm = function (m, o) { o = o || {}; return open({ kind: 'confirm', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK', cancelLabel: o.cancelLabel || 'Cancel', danger: o.danger }); };
  window.uiPrompt = function (m, o) {
    o = o || {};
    return open({ kind: 'prompt', message: String(m == null ? '' : m), title: o.title, okLabel: o.okLabel || 'OK', cancelLabel: o.cancelLabel || 'Cancel',
      fields: [{ name: 'value', type: o.password ? 'password' : 'text', value: (o.default != null ? o.default : (o.value != null ? o.value : '')), placeholder: o.placeholder || '', autocap: o.autocap }] });
  };
  window.uiForm = function (cfg) {
    cfg = cfg || {};
    return open({ kind: 'form', title: cfg.title, message: cfg.message, okLabel: cfg.okLabel || 'Save', cancelLabel: cfg.cancelLabel || 'Cancel', danger: cfg.danger, fields: cfg.fields || [] });
  };
  try { window.alert = function (m) { window.uiAlert(m == null ? '' : String(m)); }; } catch (e) {}
})();
