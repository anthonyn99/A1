/* ─────────────────────────────────────────────────────────────────────────────
 * vault-apikey-ui.js — Vault · API Keys & Credentials tab (PWA)
 *
 * Developer credentials — API keys, tokens, client secrets, webhook secrets —
 * with the details that travel with them: provider, key ID, account, endpoint,
 * console link, environment, scopes, expiry, the .env variable name, custom
 * fields and free-form notes.
 *
 * ── How it plugs in ─────────────────────────────────────────────────────────
 * Exactly like vault-pay-ui.js: vault-ui.js owns the shell (tabs, lock screen,
 * toolbar, sync) and hands this module its `host` context (hostCtx() there).
 * Every read and write goes through host.store() — the ONE unlocked store —
 * so an API key is encrypted with the same DEK, synced through the same
 * dashboards/vault_pw document and listener, and locked by the same session as
 * everything else. This module never sees a key, a config or Firebase.
 *
 * ── Security posture ────────────────────────────────────────────────────────
 *  • Keys and secrets render masked ("sk-ant-••••••••a1B2"). Reveal is per
 *    field and re-masks itself after REMASK_MS.
 *  • Copies go through host.copyText(), which clears the clipboard after 30s.
 *  • Search never matches a key or secret (see vault-store.js scoreItem).
 *  • Hidden custom fields are masked like the key and excluded from search.
 *  • Links (endpoint / console) only open as http(s) — a stored
 *    `javascript:` URL can't run.
 *  • Changing a key keeps the previous one in `keyHistory` (capped), so a
 *    rotation doesn't strand deployments still using the old key.
 *
 * Depends on: vault-apikey.js (logic), vault-ui.js (host + shell).
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.VaultApiKeyUI) return;

  var AK = window.VaultApiKey;
  var KIND = 'apikey';
  var REMASK_MS = 45 * 1000;          // a revealed value hides itself again
  var _open = {};                     // id -> expanded (survives live re-renders)
  var _timers = [];                   // re-mask timers, cleared on lock

  function reset() {
    _open = {};
    _timers.forEach(clearTimeout); _timers = [];
  }

  // ── list ───────────────────────────────────────────────────────────────────
  function keys(host) {
    var store = host.store();
    var q = host.query();
    // A search result is already ranked by relevance; the full list uses the
    // manual / pinned / expiry order.
    return q ? store.search(q).filter(function (i) { return i.kind === KIND; }) : AK.sortKeys(store.byKind(KIND));
  }

  function fillList(list, host) {
    injectStyles();
    list.innerHTML = '';
    if (!AK) { list.appendChild(host.emptyState('API Keys module not loaded.')); return; }
    var items = keys(host);
    if (!items.length) {
      list.appendChild(host.query()
        ? host.emptyState('No matching API keys.')
        : emptyHero(host));
      return;
    }
    var searching = !!host.query();
    items.forEach(function (it) { list.appendChild(keyRow(it, host, searching)); });
    if (!searching && items.length > 1) {
      host.makeReorderable(list, function (orderedIds) { commitOrder(host, orderedIds); });
    }
  }

  function emptyHero(host) {
    var el = host.el;
    return el('div', { class: 'vault-empty vak-empty' }, [
      el('div', { class: 'vak-empty-title' }, ['No API keys yet']),
      el('div', {}, ['Store API keys, tokens and client secrets with their endpoint, account, scopes and notes — encrypted on this device before they sync.']),
      el('div', { class: 'vak-empty-actions' }, [
        el('button', { class: 'vault-btn primary sm', onclick: function () { openEditor(null, host); } }, ['+ Add API key']),
      ]),
      el('div', { class: 'vak-empty-fine' }, ['Have a .env file? Settings → Import / Export → Import .env.']),
    ]);
  }

  async function commitOrder(host, orderedIds) {
    var store = host.store();
    var current = store.byKind(KIND);
    var plan = AK.reorderPlan(orderedIds, current);
    if (!plan.length) return;
    var byId = {};
    current.forEach(function (c) { byId[c.id] = c; });
    var writes = plan.map(function (p) {
      var c = byId[p.id];
      var body = AK.normalize(c);
      body.id = c.id; body.createdAt = c.createdAt; body.order = p.order;
      return body;
    });
    try { await store.saveMany(writes); }
    catch (e) { host.toast('Could not save the new order'); host.refreshList(KIND); }
  }

  // ── one key ────────────────────────────────────────────────────────────────
  function keyRow(it, host, searching) {
    var el = host.el;
    var s = AK.summarize(it);
    var consoleHref = AK.safeHref(it.consoleUrl) || (s.provider && s.provider.console) || '';

    var chips = [];
    if (s.environment) chips.push(el('span', { class: 'vak-chip vak-env vak-env-' + (s.environment.replace(/[^a-z]/g, '') || 'x') }, [s.environmentLabel]));
    if (s.expiryState === 'expired') chips.push(el('span', { class: 'vak-chip bad' }, ['Expired']));
    else if (s.expiryState === 'expiring') chips.push(el('span', { class: 'vak-chip warn' }, [s.expiryLabel]));

    var star = el('button', {
      class: 'vault-icon vak-star' + (s.favorite ? ' vault-on' : ''), title: s.favorite ? 'Unpin' : 'Pin to top',
      html: (window.VaultIcons || {})[s.favorite ? 'starOn' : 'star'] || '',
      onclick: function (e) { e.stopPropagation(); togglePin(host, it); },
    });
    // The one action you want without expanding anything.
    var quickCopy = (s.hasKey || s.hasSecret) ? host.iconBtn(s.hasKey ? 'Copy API key' : 'Copy secret', host.icons.copy, function (e) {
      e.stopPropagation();
      host.copyText(s.hasKey ? it.key : it.secret, s.hasKey ? 'API key copied' : 'Secret copied');
    }) : null;
    if (quickCopy) quickCopy.classList.add('vak-quick');

    var head = el('div', { class: 'vault-row vak-head' }, [
      host.dragHandle(s.title, searching, function () { host.toast('Clear the search to reorder keys'); }),
      el('span', { class: 'vak-mark', html: AK.providerMark(s.provider) }),
      el('div', { class: 'vault-row-main' }, [
        el('div', { class: 'vault-row-title' }, [s.title]),
        el('div', { class: 'vault-row-sub' }, [s.subtitle]),
        s.masked ? el('div', { class: 'vak-masked' }, [s.masked]) : null,
      ]),
      chips.length ? el('div', { class: 'vak-chips' }, chips) : null,
      quickCopy,
      star,
      host.iconBtn('Edit', host.icons.edit, function (e) { e.stopPropagation(); openEditor(it, host); }),
    ]);

    // ── details ──
    var body = el('div', { class: 'vak-body vault-rowbody' });
    body.style.display = _open[it.id] ? '' : 'none';
    head.style.cursor = 'pointer';
    head.setAttribute('aria-expanded', _open[it.id] ? 'true' : 'false');
    head.addEventListener('click', function () {
      _open[it.id] = body.style.display === 'none';
      body.style.display = _open[it.id] ? '' : 'none';
      head.setAttribute('aria-expanded', _open[it.id] ? 'true' : 'false');
    });

    var grid = el('div', { class: 'vak-grid' });
    if (s.hasKey) grid.appendChild(secretLine(host, 'API key', it.key, 'API key copied'));
    if (s.hasSecret) grid.appendChild(secretLine(host, it.provider && /aws/i.test(it.provider) ? 'Secret access key' : 'Secret', it.secret, 'Secret copied'));
    if (it.keyId) grid.appendChild(plainLine(host, 'Key / client ID', it.keyId, { mono: true, copy: 'Key ID copied' }));
    if (it.account) grid.appendChild(plainLine(host, 'Account', it.account, { copy: 'Account copied' }));
    if (s.hasKey) grid.appendChild(plainLine(host, 'Env variable', s.envName, { mono: true, copyValue: AK.envLine(it), copyTitle: 'Copy as .env line', copy: '.env line copied' }));
    if (it.endpoint) grid.appendChild(plainLine(host, 'Endpoint', it.endpoint, { mono: true, copy: 'Endpoint copied', href: AK.safeHref(it.endpoint) }));
    if (s.providerLabel || s.keyTypeLabel) grid.appendChild(plainLine(host, 'Provider · type', [s.providerLabel, s.keyTypeLabel].filter(Boolean).join(' · ')));
    if (s.environmentLabel) grid.appendChild(plainLine(host, 'Environment', s.environmentLabel));
    if (it.scopes) grid.appendChild(plainLine(host, 'Scopes / permissions', it.scopes, { wrap: true, copy: 'Scopes copied' }));
    if (s.expiry) grid.appendChild(plainLine(host, 'Expires', s.expiry + (s.expiryLabel ? ' · ' + s.expiryLabel : ''), { tone: s.expiryState }));
    if (it.rotatedAt) grid.appendChild(plainLine(host, 'Last rotated', new Date(it.rotatedAt).toLocaleDateString()));
    (Array.isArray(it.customFields) ? it.customFields : []).forEach(function (cf) {
      if (!cf || (!cf.label && !cf.value)) return;
      grid.appendChild(cf.hidden
        ? secretLine(host, cf.label || 'Hidden field', cf.value || '', (cf.label || 'Value') + ' copied')
        : plainLine(host, cf.label || 'Field', cf.value || '', { copy: (cf.label || 'Value') + ' copied', wrap: true }));
    });
    body.appendChild(grid);

    if (it.notes && String(it.notes).trim()) {
      body.appendChild(el('div', { class: 'vak-notes' }, [
        el('div', { class: 'vault-acc-flabel' }, ['Notes']),
        el('div', { class: 'vault-note-text' }, [it.notes]),
      ]));
    }

    if (Array.isArray(it.keyHistory) && it.keyHistory.length) body.appendChild(historyBlock(host, it));

    // ── action bar ──
    var bar = el('div', { class: 'vak-actions' });
    if (s.hasKey) {
      bar.appendChild(actionBtn(host, host.icons.copy, 'Copy key', function () { host.copyText(it.key, 'API key copied'); }));
      bar.appendChild(actionBtn(host, envIcon(), 'Copy .env', function () { host.copyText(AK.envBlock(it), '.env copied'); }));
    }
    if (consoleHref) bar.appendChild(actionBtn(host, host.icons.ext, 'Open console', function () { window.open(consoleHref, '_blank', 'noopener'); }));
    bar.appendChild(actionBtn(host, (window.VaultIcons || {})[s.favorite ? 'starOn' : 'star'] || '', s.favorite ? 'Unpin' : 'Pin', function () { togglePin(host, it); }, 'vak-pin'));
    bar.appendChild(actionBtn(host, host.icons.edit, 'Edit', function () { openEditor(it, host); }));
    body.appendChild(bar);

    return el('div', {
      class: 'vault-site vak-site' + (s.expiryState === 'expired' ? ' vak-expired' : ''),
      'data-id': it.id,
    }, [head, body]);
  }

  function actionBtn(host, svg, label, fn, cls) {
    return host.el('button', { class: 'vault-btn sm vak-act' + (cls ? ' ' + cls : ''), type: 'button', html: svg + '<span>' + host.esc(label) + '</span>', onclick: fn });
  }

  // A masked value with its own reveal + copy.
  function secretLine(host, label, value, copied) {
    var el = host.el;
    var shown = false, timer = null;
    var masked = AK.maskKey(value) || '••••••••';
    var val = el('span', { class: 'vak-val vak-mono vak-secret' }, [masked]);
    var rev = el('button', { class: 'vault-icon', type: 'button', title: 'Reveal ' + label, 'aria-pressed': 'false', html: host.icons.eye });
    function set(on) {
      shown = on;
      val.textContent = on ? value : masked;
      val.classList.toggle('shown', on);
      rev.innerHTML = on ? host.icons.eyeOff : host.icons.eye;
      rev.title = (on ? 'Hide ' : 'Reveal ') + label;
      rev.setAttribute('aria-pressed', on ? 'true' : 'false');
      clearTimeout(timer);
      if (on) { timer = setTimeout(function () { set(false); }, REMASK_MS); _timers.push(timer); }
    }
    rev.addEventListener('click', function (e) { e.stopPropagation(); set(!shown); });
    return el('div', { class: 'vak-line' }, [
      el('div', { class: 'vault-acc-field' }, [el('span', { class: 'vault-acc-flabel' }, [label]), val]),
      el('div', { class: 'vak-line-btns' }, [
        rev,
        host.iconBtn('Copy ' + label, host.icons.copy, function (e) { e.stopPropagation(); host.copyText(value, copied); }),
      ]),
    ]);
  }

  function plainLine(host, label, value, o) {
    var el = host.el;
    o = o || {};
    var btns = [];
    if (o.href) btns.push(host.iconBtn('Open', host.icons.ext, function (e) { e.stopPropagation(); window.open(o.href, '_blank', 'noopener'); }));
    if (o.copy) btns.push(host.iconBtn(o.copyTitle || ('Copy ' + label), host.icons.copy, function (e) { e.stopPropagation(); host.copyText(o.copyValue != null ? o.copyValue : value, o.copy); }));
    var cls = 'vak-val' + (o.mono ? ' vak-mono' : '') + (o.wrap ? ' vak-wrap' : '') + (o.tone === 'expired' ? ' bad' : o.tone === 'expiring' ? ' warn' : '');
    return el('div', { class: 'vak-line' }, [
      el('div', { class: 'vault-acc-field' }, [el('span', { class: 'vault-acc-flabel' }, [label]), el('span', { class: cls }, [String(value)])]),
      btns.length ? el('div', { class: 'vak-line-btns' }, btns) : null,
    ]);
  }

  function historyBlock(host, it) {
    var el = host.el;
    var wrap = el('div', { class: 'vak-hist', style: 'display:none' });
    it.keyHistory.forEach(function (h) {
      if (!h || (!h.key && !h.secret)) return;
      // `at` is when that key was put in place (its own rotation, or creation).
      var when = h.at ? ' · since ' + new Date(h.at).toLocaleDateString() : '';
      if (h.key) wrap.appendChild(secretLine(host, 'Previous key' + when, h.key, 'Previous key copied'));
      if (h.secret) wrap.appendChild(secretLine(host, 'Previous secret' + when, h.secret, 'Previous secret copied'));
    });
    var toggle = el('button', { class: 'vault-link-btn vak-hist-toggle', type: 'button' }, ['Previous keys (' + it.keyHistory.length + ')']);
    toggle.addEventListener('click', function (e) { e.stopPropagation(); wrap.style.display = wrap.style.display === 'none' ? '' : 'none'; });
    return el('div', { class: 'vak-hist-wrap' }, [toggle, wrap]);
  }

  async function togglePin(host, it) {
    var patch = { favorite: !it.favorite };
    // With a manual order, pinning only means something if it moves the key.
    if (!it.favorite) {
      var top = AK.nextTopOrder(host.store().byKind(KIND));
      if (top !== undefined) patch.order = top;
    }
    try { await save(host, it, patch); host.refreshList(KIND); }
    catch (e) { host.toast('Could not save'); }
  }

  // ── persistence ────────────────────────────────────────────────────────────
  // Every write funnels through here so normalisation and key-rotation history
  // can never be skipped. `item` is the stored version (or null when new).
  function save(host, item, patch) {
    var merged = Object.assign({}, item || {}, patch || {});
    var body = AK.normalize(merged);
    if (item && item.id) body = AK.withRotation(item, body);
    body.id = item && item.id;
    body.createdAt = item && item.createdAt;
    return host.store().save(body);
  }

  // ── editor ─────────────────────────────────────────────────────────────────
  function openEditor(item, host) {
    injectStyles();
    var el = host.el;
    var isNew = !item || !item.id;
    item = item || {};

    var overlay = el('div', { class: 'vault-overlay' }); // no backdrop-close — avoids losing in-progress edits
    function close() { overlay.remove(); }

    // Keys must survive the phone keyboard untouched: no auto-capitalising the
    // first letter, no autocorrect, no spellcheck underline, no password-
    // manager "save this password?" prompt.
    var RAW = { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-1p-ignore': 'true', 'data-lpignore': 'true' };
    function input(value, opts) {
      opts = opts || {};
      var a = Object.assign({ class: 'vault-input' + (opts.mono ? ' vak-mono' : ''), type: opts.type || 'text', value: value == null ? '' : value, placeholder: opts.ph || '' }, opts.raw ? RAW : { autocomplete: 'off' });
      if (opts.list) a.list = opts.list;
      if (opts.inputmode) a.inputmode = opts.inputmode;
      return el(opts.textarea ? 'textarea' : 'input', a);
    }
    function field(label, inp, hint) {
      return el('div', { class: 'vault-field' }, [el('label', { class: 'vault-flabel' }, [label]), inp, hint || null]);
    }
    function select(options, selected) {
      var sel = el('select', { class: 'vault-input' });
      options.forEach(function (o) {
        var opt = el('option', { value: o.value }, [o.label]);
        if (String(o.value) === String(selected == null ? '' : selected)) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    }
    // A secret input with its own show/hide. New items start visible — you're
    // pasting it in, and nothing is saved yet to protect.
    function secretInput(value, ph) {
      var inp = input(value, { type: isNew ? 'text' : 'password', mono: true, raw: true, ph: ph });
      var shown = isNew;
      var btn = el('button', { class: 'vault-icon', type: 'button', title: shown ? 'Hide' : 'Show', html: shown ? host.icons.eyeOff : host.icons.eye });
      btn.addEventListener('click', function () {
        shown = !shown; inp.type = shown ? 'text' : 'password';
        btn.innerHTML = shown ? host.icons.eyeOff : host.icons.eye; btn.title = shown ? 'Hide' : 'Show';
      });
      return { input: inp, node: el('div', { class: 'vault-pw-input' }, [inp, btn]) };
    }

    var listId = 'vak-providers-' + Math.random().toString(36).slice(2, 8);
    var datalist = el('datalist', { id: listId }, AK.PROVIDERS.map(function (p) { return el('option', { value: p.label }); }));

    var title = input(item.title, { ph: 'e.g. OpenAI — production' });
    var provider = input(item.provider, { ph: 'Detected from the key, or type one', list: listId });
    var badge = el('span', { class: 'vak-mark vak-mark-lg', html: AK.providerMark(AK.providerOf(item)) });
    var keyType = select(AK.KEY_TYPES.map(function (t) { return { value: t.id, label: t.label }; }), item.keyType || 'api_key');
    var environment = select(AK.ENVIRONMENTS.map(function (t) { return { value: t.id, label: t.label }; }), item.environment || '');
    var key = secretInput(item.key, 'Paste the API key or token');
    var secret = secretInput(item.secret, 'Client secret, secret access key, signing secret… (optional)');
    var keyId = input(item.keyId, { mono: true, raw: true, ph: 'Access-key ID, client ID, app ID (optional)' });
    var account = input(item.account, { ph: 'Account, email or organisation', raw: true });
    var envVar = input(item.envVar, { mono: true, raw: true, ph: AK.envName(item) });
    var endpoint = input(item.endpoint, { raw: true, ph: 'https://api.example.com/v1', inputmode: 'url' });
    var consoleUrl = input(item.consoleUrl, { raw: true, ph: 'Where you manage / rotate this key', inputmode: 'url' });
    var scopes = input(item.scopes, { ph: 'e.g. read:org, repo, billing (optional)' });
    var expires = input(item.expiresAt, { type: 'date' });
    var cats = host.categories.concat(['Development']).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (item.category && cats.indexOf(item.category) < 0) cats.unshift(item.category);
    var category = select(cats.map(function (c) { return { value: c, label: c }; }), item.category || 'Development');
    var tags = input(Array.isArray(item.tags) ? item.tags.join(', ') : '', { ph: 'work, side-project' });
    var notes = input(item.notes, { textarea: true, ph: 'Rate limits, billing notes, which apps use it, rotation steps… anything.' });
    notes.classList.add('vak-notes-input');
    var favCb = el('input', { type: 'checkbox' }); favCb.checked = !!item.favorite;
    var detectHint = el('div', { class: 'vak-hint' });

    // Live provider detection from the key's format. Only overwrites the
    // provider box while it's empty or still holds a previous auto-guess.
    var autoProvider = '';
    function refreshDerived() {
      var draft = collect();
      var det = AK.detectProvider(key.input.value);
      if (det && (!provider.value.trim() || provider.value === autoProvider)) {
        provider.value = det.label; autoProvider = det.label;
      }
      var p = AK.providerOf(collect());
      badge.innerHTML = AK.providerMark(p);
      envVar.placeholder = AK.envName(Object.assign({}, draft, { envVar: '' }));
      detectHint.textContent = det ? 'Recognised as ' + det.label + (det.env ? ' · ' + det.env : '') : '';
      if (!consoleUrl.value && p.console) consoleUrl.placeholder = p.console;
      validateLive();
    }
    key.input.addEventListener('input', refreshDerived);
    provider.addEventListener('input', function () { autoProvider = ''; refreshDerived(); });
    title.addEventListener('input', function () { envVar.placeholder = AK.envName(Object.assign(collect(), { envVar: '' })); });

    // custom fields: label · value · hidden toggle
    var customFields = (Array.isArray(item.customFields) ? item.customFields : []).map(function (c) { return { label: c.label || '', value: c.value || '', hidden: !!c.hidden }; });
    var cfWrap = el('div', {});
    function renderCF() {
      cfWrap.innerHTML = '';
      customFields.forEach(function (cf, i) {
        var lbl = el('input', { class: 'vault-input', placeholder: 'Label', value: cf.label, style: 'margin:0' });
        var val = el('input', Object.assign({ class: 'vault-input vak-mono', placeholder: 'Value', value: cf.value, style: 'margin:0', type: cf.hidden ? 'password' : 'text' }, RAW));
        lbl.addEventListener('input', function () { customFields[i].label = lbl.value; });
        val.addEventListener('input', function () { customFields[i].value = val.value; });
        var hid = el('button', {
          class: 'vault-icon' + (cf.hidden ? ' vault-on' : ''), type: 'button',
          title: cf.hidden ? 'Hidden — masked like a key. Click to show plainly' : 'Shown plainly. Click to mask it like a key',
          html: cf.hidden ? host.icons.lock : host.icons.eye,
          onclick: function () { customFields[i].hidden = !customFields[i].hidden; renderCF(); },
        });
        var rm = el('button', { class: 'vault-icon', type: 'button', title: 'Remove', html: '&times;', onclick: function () { customFields.splice(i, 1); renderCF(); } });
        cfWrap.appendChild(el('div', { class: 'vault-cf-row' }, [lbl, val, hid, rm]));
      });
    }
    renderCF();

    var err = el('div', { class: 'vault-err' });
    var warn = el('div', { class: 'vak-warn' });
    function collect() {
      return {
        title: title.value, provider: provider.value, keyType: keyType.value, environment: environment.value,
        key: key.input.value, secret: secret.input.value, keyId: keyId.value, account: account.value,
        envVar: envVar.value, endpoint: endpoint.value, consoleUrl: consoleUrl.value, scopes: scopes.value,
        expiresAt: expires.value, category: category.value, tags: tags.value, notes: notes.value,
        favorite: favCb.checked, order: item.order,
        customFields: customFields.filter(function (c) { return (c.label || '').trim() || (c.value || '').trim(); }),
      };
    }
    function validateLive() {
      var v = AK.validate(collect());
      err.textContent = v.ok ? '' : (err.textContent ? v.errors[0] : '');
      warn.textContent = v.warnings[0] || '';
    }
    [title, envVar, endpoint, consoleUrl, expires].forEach(function (i) { i.addEventListener('input', validateLive); i.addEventListener('change', validateLive); });

    var saveBtn = el('button', { class: 'vault-btn primary' }, [isNew ? 'Add API key' : 'Save']);
    saveBtn.addEventListener('click', async function () {
      var out = collect();
      var v = AK.validate(out);
      if (!v.ok) { err.textContent = v.errors[0]; return; }
      // New keys join the top of a manually ordered list; an unordered list
      // keeps its pinned / expiry / name sort.
      if (isNew) {
        var top = AK.nextTopOrder(host.store().byKind(KIND));
        if (top !== undefined) out.order = top;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Encrypting…';
      try {
        var saved = await save(host, isNew ? null : item, out);
        if (saved && saved.id) _open[saved.id] = true;
        close(); host.refreshList(KIND); host.toast(isNew ? 'API key added' : 'Saved');
      } catch (e) {
        err.textContent = 'Save failed: ' + (e.message || e);
        saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Add API key' : 'Save';
      }
    });
    var actions = [saveBtn, el('button', { class: 'vault-btn', type: 'button', onclick: close }, ['Cancel'])];
    if (!isNew) {
      actions.push(el('button', {
        class: 'vault-btn danger', type: 'button', onclick: async function () {
          if (!(await host.confirmUI('Delete "' + (item.title || 'this API key') + '"? The key and its history are removed from every device. This cannot be undone.', { title: 'Delete API key', okLabel: 'Delete', danger: true }))) return;
          try { await host.store().remove(item.id); delete _open[item.id]; close(); host.refreshList(KIND); host.toast('Deleted'); }
          catch (e) { err.textContent = 'Delete failed: ' + (e.message || e); }
        },
      }, ['Delete']));
    }

    var box = el('div', { class: 'vault-modal vak-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'vault-modal-title vak-modal-title' }, [badge, el('span', {}, [isNew ? 'Add API key' : 'Edit API key'])]),
      field('Name', title),
      field('API key / token', key.node, detectHint),
      el('div', { class: 'vak-grid2' }, [field('Provider', provider), field('Type', keyType)]),
      datalist,
      field('Secret', secret.node),
      el('div', { class: 'vak-grid2' }, [field('Key / client ID', keyId), field('Account', account)]),
      el('div', { class: 'vak-sec' }, ['Usage']),
      el('div', { class: 'vak-grid2' }, [field('Environment', environment), field('Expires', expires)]),
      field('Env variable name', envVar, el('div', { class: 'vak-hint' }, ['Used by "Copy .env". Leave blank for the suggestion shown.'])),
      field('Endpoint / base URL', endpoint),
      field('Console URL', consoleUrl),
      field('Scopes / permissions', scopes),
      el('label', { class: 'vault-ack' }, [favCb, el('span', {}, ['Pin this key to the top'])]),
      el('div', { class: 'vak-sec' }, ['Details']),
      el('div', { class: 'vak-grid2' }, [field('Category', category), field('Tags (comma-separated)', tags)]),
      field('Notes', notes),
      el('div', { class: 'vault-field' }, [
        el('label', { class: 'vault-flabel' }, ['Custom fields']), cfWrap,
        el('button', { class: 'vault-btn', type: 'button', style: 'width:auto;margin:2px 0 0;padding:8px 12px', onclick: function () { customFields.push({ label: '', value: '', hidden: false }); renderCF(); } }, ['+ Add custom field']),
      ]),
      err, warn,
      el('div', { class: 'vault-modal-actions' }, actions),
      el('p', { class: 'vault-fine' }, ['Encrypted on this device before it syncs · AES-256-GCM · zero-knowledge']),
    ]);
    overlay.appendChild(box); document.body.appendChild(overlay);
    refreshDerived();
    err.textContent = '';
    setTimeout(function () { (isNew ? key.input : title).focus(); }, 50);
  }

  // ── icons ──────────────────────────────────────────────────────────────────
  function envIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2"/><path d="M12 15h5"/></svg>'; }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('vault-apikey-styles')) return;
    var css = [
      '.vak-site.vak-expired .vault-row-title{opacity:.7}',
      '.vak-mark{width:30px;height:30px;flex-shrink:0;display:flex;border-radius:8px;overflow:hidden}',
      '.vak-mark svg{width:100%;height:100%;display:block}',
      '.vak-mark-lg{width:28px;height:28px}',
      '.vak-masked{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--txm);margin-top:3px;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vak-chips{display:flex;gap:6px;flex-shrink:0;align-items:center}',
      '.vak-chip{font-size:10.5px;font-weight:500;letter-spacing:.2px;padding:3px 9px;border-radius:5px;white-space:nowrap;border:1px solid var(--bd);color:var(--txd)}',
      '.vak-chip.warn{border-color:rgba(224,184,116,.36);color:#e0b874}.vak-chip.bad{border-color:rgba(214,138,124,.45);color:#d68a7c}',
      '.vak-env-production{border-color:rgba(214,138,124,.4);color:#e7a597}',
      '.vak-env-staging{border-color:rgba(224,184,116,.36);color:#e0b874}',
      '.vak-env-development{border-color:rgba(143,201,156,.4);color:#8fc99c}',
      '.vak-env-test{border-color:rgba(138,175,226,.4);color:#8aafe2}',
      '.vak-body{border-top:1px solid var(--bd);padding:14px;display:flex;flex-direction:column;gap:12px}',
      '.vak-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px 18px}',
      '.vak-line{display:flex;align-items:center;gap:8px;min-width:0}',
      '.vak-line-btns{display:flex;gap:4px;flex-shrink:0}',
      '.vak-val{font-size:13px;color:var(--tx);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.vak-val.vak-wrap{white-space:pre-wrap;word-break:break-word}',
      '.vak-val.warn{color:#e0b874}.vak-val.bad{color:#d68a7c}',
      '.vak-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.2px}',
      '.vak-secret{color:var(--txd)}',
      // A revealed key wraps instead of truncating — you're reading it to type
      // or verify it, so every character must be on screen.
      '.vak-secret.shown{color:var(--acs,#e0b874);white-space:normal;word-break:break-all;user-select:all}',
      '.vak-notes .vault-note-text{margin-top:6px}',
      '.vak-hist-wrap{display:flex;flex-direction:column;gap:8px}',
      '.vak-hist-toggle{align-self:flex-start;padding:2px 0}',
      '.vak-hist{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px dashed var(--bd);border-radius:var(--radius-sm)}',
      '.vak-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;padding-top:2px}',
      '.vak-act{padding:8px 12px;font-size:12.5px}',
      '.vak-act svg{width:14px;height:14px}',
      '.vak-empty{display:flex;flex-direction:column;align-items:center;gap:10px}',
      '.vak-empty-title{font-size:15px;font-weight:600;color:var(--tx)}',
      '.vak-empty-actions{margin-top:4px}',
      '.vak-empty-fine{font-size:11.5px;color:var(--txm)}',
      // editor
      '.vak-modal{width:560px}',
      '.vak-modal-title{display:flex;align-items:center;gap:10px}',
      '.vak-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}',
      '.vak-hint{font-size:11px;color:var(--txm);margin-top:6px;min-height:0}',
      '.vak-hint:empty{display:none}',
      '.vak-warn{color:#e0b874;font-size:11.5px;min-height:14px;margin:-4px 0 4px;line-height:1.5}',
      '.vak-notes-input{min-height:96px}',
      '.vak-sec{font-size:11px;font-weight:800;color:var(--txm);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 10px;padding-top:12px;border-top:1px solid var(--bd)}',
      '.vault-cf-row .vault-icon.vault-on{color:var(--acs,#e0b874);border-color:var(--ac)}',
      // ── responsive ──
      '@media (max-width:900px){',
      '  .vak-chips .vak-env{display:none}',             // environment also reads in the subtitle
      '}',
      '@media (max-width:640px){',
      '  .vak-head{gap:8px;padding:11px 10px}',
      '  .vak-chips,.vak-star{display:none}',             // expiry + pin live in the body on phones
      '  .vak-body{padding:12px}',
      '  .vak-grid{grid-template-columns:1fr;gap:10px}',
      '  .vak-grid2{grid-template-columns:1fr}',
      '  .vak-actions{justify-content:stretch}',
      '  .vak-act{flex:1 1 calc(50% - 6px);justify-content:center}',
      '  .vak-mark{width:28px;height:28px}',
      '}',
      '@media (min-width:641px){.vak-pin{display:none}}', // the head's star covers it on desktop
      '@media (max-width:380px){',
      '  .vak-mark{display:none}',
      '  .vak-act{flex:1 1 100%}',
      '}',
    ].join('');
    var s = document.createElement('style'); s.id = 'vault-apikey-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  window.VaultApiKeyUI = { render: fillList, fillList: fillList, openEditor: openEditor, reset: reset, KIND: KIND };
})();
