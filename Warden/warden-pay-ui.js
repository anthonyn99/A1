/* ─────────────────────────────────────────────────────────────────────────────
 * warden-pay-ui.js — Warden · Payments tab (PWA)
 *
 * The Google-Wallet-flavoured half of Warden: saved cards shown as card faces,
 * masked by default, revealed only after an identity check. Passwords stay
 * Google-Password-Manager-flavoured next door; both are the same warden.
 *
 * ── How it plugs in ─────────────────────────────────────────────────────────
 * warden-ui.js owns the shell (tabs, lock screen, toolbar, sync status) and
 * hands this module a `host` context — see hostCtx() there. Everything below
 * goes through that contract, so there is exactly ONE session, ONE DEK and ONE
 * sync path in the app. This module never touches crypto, Firebase or the
 * device store; it can't even see them.
 *
 * ── Security posture ────────────────────────────────────────────────────────
 *  • Cards render masked (•••• •••• •••• 1234). The full number and the CVV are
 *    only ever put on screen after host.verifyIdentity() — the SAME biometric-
 *    or-master-password check the warden already uses for rotating a recovery
 *    key or disabling biometrics.
 *  • One check opens a short grace window (REVEAL_GRACE_MS) so reading a card
 *    off the screen isn't a five-prompt ordeal, then it snaps shut.
 *  • Revealed values auto-re-mask, and copies clear the clipboard after 30s via
 *    host.copyText().
 *  • Deleting a card also requires the identity check.
 *
 * Depends on: warden-pay.js (payment logic), warden-ui.js (host + shell).
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.WardenPayUI) return;

  var PAY = window.WardenPay;
  var KIND = 'payment';
  var REVEAL_GRACE_MS = 2 * 60 * 1000;  // one identity check covers 2 minutes
  var AUTO_REMASK_MS = 45 * 1000;       // a revealed card re-hides itself
  var _graceUntil = 0;
  var _open = {};                       // id -> expanded in the list

  // A single identity check, reused for a couple of minutes. Anything that puts
  // a full number or a CVV on screen (or destroys a card) goes through here.
  async function requireIdentity(host, reason) {
    if (Date.now() < _graceUntil) return true;
    var ok = await host.verifyIdentity(reason);
    if (ok) _graceUntil = Date.now() + REVEAL_GRACE_MS;
    return ok;
  }
  // Locking the warden must also close the grace window — otherwise a re-unlock
  // would inherit an identity check made before it.
  function resetGrace() { _graceUntil = 0; _open = {}; }

  // ── list ───────────────────────────────────────────────────────────────────
  function cards(host) {
    var store = host.store();
    var q = host.query();
    var list = q ? store.search(q).filter(function (i) { return i.kind === KIND; }) : store.byKind(KIND);
    return PAY.sortCards(list);
  }

  function fillList(list, host) {
    injectStyles();
    list.innerHTML = '';
    var items = cards(host);
    if (!items.length) {
      list.appendChild(host.emptyState(host.query()
        ? 'No matching cards.'
        : 'No payment methods yet. Add a card, or import one from Settings → Import / Export.'));
      return;
    }
    // Reordering a FILTERED list would be a lie: positions 0..n of a search
    // result aren't positions in the wallet. So drag is only live on the full
    // list, and the handle explains itself when it isn't.
    var searching = !!host.query();
    items.forEach(function (it) { list.appendChild(cardRow(it, host, searching)); });
    if (!searching && items.length > 1) {
      host.makeReorderable(list, function (orderedIds) { commitOrder(host, orderedIds); });
    }
  }

  // ── manual order ───────────────────────────────────────────────────────────
  // Persist a new sequence. Only the cards whose position actually moved are
  // re-encrypted and written, and they go out as ONE batch → one repaint, one
  // debounced Firestore write, and other devices pick it up on the same
  // real-time listener that already carries every other warden change.
  async function commitOrder(host, orderedIds) {
    var store = host.store();
    var current = store.byKind(KIND);
    var plan = PAY.reorderPlan(orderedIds, current);
    if (!plan.length) return;
    var byId = {};
    current.forEach(function (c) { byId[c.id] = c; });
    var writes = plan.map(function (p) {
      var c = byId[p.id];
      var body = PAY.normalize(c);
      body.id = c.id; body.createdAt = c.createdAt; body.order = p.order;
      return body;
    });
    try { await store.saveMany(writes); }
    catch (e) { host.toast('Could not save the new order'); host.refreshList(KIND); }
  }

  function render(panel, host) {
    injectStyles();
    var list = host.el('div', { class: 'warden-list' });
    fillList(list, host);
    panel.appendChild(list);
  }

  // Drag-to-reorder is the shell's shared engine (host.makeReorderable, defined
  // in warden-ui.js) so Payments and Sensitive Info stay one behaviour, not two.
  // Contract: each list child is a `.warden-site[data-id]` carrying a
  // `.warden-drag` handle and a `.warden-rowbody` that collapses mid-drag.

  // ── one card ───────────────────────────────────────────────────────────────
  function cardRow(it, host, searching) {
    var el = host.el;
    var s = PAY.summarize(it);
    var revealed = false, remaskTimer = null;

    // ── the Wallet-style face ──
    var numEl = el('div', { class: 'vpay-face-num' }, [s.masked || '•••• •••• •••• ••••']);
    var face = el('div', { class: 'vpay-face vpay-net-' + s.network }, [
      el('div', { class: 'vpay-face-top' }, [
        el('span', { class: 'vpay-face-mark', html: PAY.brandMark(s.network) }),
        s.favorite ? el('span', { class: 'vpay-face-star', title: 'Pinned', html: (window.WardenIcons || {}).starOn || '' }) : null,
      ]),
      el('div', { class: 'vpay-face-chip' }),
      numEl,
      el('div', { class: 'vpay-face-bot' }, [
        el('span', { class: 'vpay-face-name' }, [s.cardholder || '—']),
        el('span', { class: 'vpay-face-exp' }, [s.expiry || '—']),
      ]),
    ]);

    // ── expiry chip ──
    var chip = null;
    if (s.expiryState === 'expired') chip = el('span', { class: 'vpay-chip bad' }, ['Expired']);
    else if (s.expiryState === 'expiring') chip = el('span', { class: 'vpay-chip warn' }, [s.expiryLabelLong]);

    // ── header row ──
    var star = el('button', {
      class: 'warden-icon' + (s.favorite ? ' vpay-on' : ''), title: s.favorite ? 'Unpin' : 'Pin to top',
      html: (window.WardenIcons || {})[s.favorite ? 'starOn' : 'star'] || '',
      onclick: async function (e) {
        e.stopPropagation();
        var patch = { favorite: !it.favorite };
        // Once a wallet has a manual order, favouriting no longer moves
        // anything on its own — so make "Pin to top" do what it says and
        // actually send the card to position 0.
        if (!it.favorite) {
          var top = PAY.nextTopOrder(host.store().byKind(KIND));
          if (top !== undefined) patch.order = top;
        }
        await save(host, it, patch);
        host.refreshList(KIND);
      },
    });
    var handle = host.dragHandle(s.title, searching, function () { host.toast('Clear the search to reorder cards'); });

    var head = el('div', { class: 'warden-row vpay-head' }, [
      handle,
      el('span', { class: 'vpay-mark', html: PAY.brandMark(s.network) }),
      el('div', { class: 'warden-row-main' }, [
        el('div', { class: 'warden-row-title' }, [s.title]),
        el('div', { class: 'warden-row-sub' }, [s.subtitle + (s.expiry ? ' · ' + s.expiry : '')]),
      ]),
      chip,
      star,
      host.iconBtn('Edit', host.icons.edit, function (e) { e.stopPropagation(); openEditor(it, host); }),
    ]);

    // ── details body ──
    // .warden-rowbody lets the shared drag engine collapse this while reordering.
    var body = el('div', { class: 'vpay-body warden-rowbody' });
    body.style.display = _open[it.id] ? '' : 'none';
    head.style.cursor = 'pointer';
    head.addEventListener('click', function () {
      _open[it.id] = body.style.display === 'none';
      body.style.display = _open[it.id] ? '' : 'none';
    });

    function setRevealed(on) {
      revealed = on;
      numEl.textContent = on ? PAY.formatNumber(it.number, s.network) : (s.masked || '•••• •••• •••• ••••');
      numEl.classList.toggle('shown', on);
      cvvVal.textContent = on && it.cvv ? it.cvv : (it.cvv ? '•••' : '—');
      revBtn.innerHTML = on ? host.icons.eyeOff : host.icons.eye;
      revBtn.title = on ? 'Hide card details' : 'Reveal card details';
      clearTimeout(remaskTimer);
      if (on) remaskTimer = setTimeout(function () { setRevealed(false); }, AUTO_REMASK_MS);
    }

    var cvvVal = el('span', { class: 'warden-acc-pw' }, [it.cvv ? '•••' : '—']);
    var revBtn = el('button', {
      class: 'warden-icon', title: 'Reveal card details', html: host.icons.eye,
      onclick: async function () {
        if (revealed) { setRevealed(false); return; }
        if (!it.number && !it.cvv) { host.toast('Nothing to reveal on this card'); return; }
        if (!(await requireIdentity(host, 'reveal this card'))) return;
        setRevealed(true);
      },
    });

    function line(label, value, muted) {
      return el('div', { class: 'warden-acc-line' }, [
        el('div', { class: 'warden-acc-field' }, [
          el('span', { class: 'warden-acc-flabel' }, [label]),
          el('span', { class: 'warden-acc-val' + (muted ? ' muted' : '') }, [value]),
        ]),
      ]);
    }

    var main = el('div', { class: 'warden-acc-main' }, [
      line('Cardholder', s.cardholder || '(none)', !s.cardholder),
      line('Type', s.typeLabel + ' · ' + s.networkLabel),
      el('div', { class: 'warden-acc-line' }, [
        el('div', { class: 'warden-acc-field' }, [
          el('span', { class: 'warden-acc-flabel' }, ['Security code']), cvvVal,
        ]),
      ]),
    ]);
    if (s.expiry) main.appendChild(line('Expires', s.expiry + (s.expiryLabelLong ? ' · ' + s.expiryLabelLong : '')));
    if (s.hasBilling) main.appendChild(line('Billing address', PAY.formatAddress(it.billing)));
    if (it.notes) main.appendChild(line('Notes', it.notes));
    (Array.isArray(it.customFields) ? it.customFields : []).forEach(function (cf) {
      if (!cf || (!cf.label && !cf.value)) return;
      main.appendChild(el('div', { class: 'warden-acc-line' }, [
        el('div', { class: 'warden-acc-field' }, [el('span', { class: 'warden-acc-flabel' }, [cf.label || 'Field']), el('span', { class: 'warden-acc-val' }, [cf.value || ''])]),
        host.iconBtn('Copy ' + (cf.label || 'value'), host.icons.copy, function () { host.copyText(cf.value || '', (cf.label || 'Value') + ' copied'); }),
      ]));
    });

    // ── quick actions ──
    var actions = el('div', { class: 'warden-acc-actions' });
    if (it.number) {
      actions.appendChild(host.iconBtn('Copy card number', host.icons.copy, async function () {
        if (!(await requireIdentity(host, 'copy this card number'))) return;
        host.copyText(it.number, 'Card number copied');
      }));
    }
    if (it.cvv) {
      actions.appendChild(host.iconBtn('Copy security code', cvvIcon(), async function () {
        if (!(await requireIdentity(host, 'copy this security code'))) return;
        host.copyText(it.cvv, 'Security code copied');
      }));
    }
    if (s.cardholder) actions.appendChild(host.iconBtn('Copy cardholder name', host.icons.user, function () { host.copyText(it.cardholder, 'Cardholder copied'); }));
    if (s.hasBilling) {
      actions.appendChild(host.iconBtn('Copy billing address', homeIcon(), function () { host.copyText(PAY.formatAddress(it.billing), 'Billing address copied'); }));
      if (it.billing && it.billing.postal) actions.appendChild(host.iconBtn('Copy ZIP / postal code', pinIcon(), function () { host.copyText(it.billing.postal, 'Postal code copied'); }));
    }
    actions.appendChild(revBtn);
    actions.appendChild(host.iconBtn('Edit', host.icons.edit, function () { openEditor(it, host); }));

    body.appendChild(el('div', { class: 'vpay-detail' }, [face, el('div', { class: 'vpay-detail-main' }, [main, actions])]));

    return el('div', {
      class: 'warden-site vpay-site' + (s.expiryState === 'expired' ? ' vpay-expired' : ''),
      'data-id': it.id,
    }, [head, body]);
  }

  // ── persistence ────────────────────────────────────────────────────────────
  // Every write funnels through here so normalisation (and therefore the
  // derived network/last4) can never be skipped. `id`/`createdAt` are carried
  // across because WardenPay.normalize() only shapes the BODY.
  function save(host, item, patch) {
    var merged = Object.assign({}, item, patch || {});
    var body = PAY.normalize(merged);
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
    var billing = PAY.normalizeAddress(item.billing);

    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    function close() { overlay.remove(); }

    function field(label, value, opts) {
      opts = opts || {};
      var input = el(opts.textarea ? 'textarea' : 'input', {
        class: 'warden-input', type: opts.type || 'text', value: value == null ? '' : value,
        placeholder: opts.ph || '', autocomplete: 'off', inputmode: opts.inputmode || null, maxlength: opts.max || null,
      });
      return { input: input, node: el('div', { class: 'warden-field' }, [el('label', { class: 'warden-flabel' }, [label]), input]) };
    }
    function selectField(label, options, selected) {
      var sel = el('select', { class: 'warden-input' });
      options.forEach(function (o) {
        var opt = el('option', { value: o.value }, [o.label]);
        if (String(o.value) === String(selected)) opt.selected = true;
        sel.appendChild(opt);
      });
      return { input: sel, node: el('div', { class: 'warden-field' }, [el('label', { class: 'warden-flabel' }, [label]), sel]) };
    }

    var nickname = field('Card nickname', item.nickname, { ph: 'e.g. Chase Sapphire' });
    var type = selectField('Card type', PAY.CARD_TYPES.map(function (t) { return { value: t.id, label: t.label }; }), item.type || 'credit');
    var holder = field('Cardholder name', item.cardholder, { ph: 'Name as printed on the card' });

    // Card number — live network detection, live grouping, masked until revealed.
    var numInput = el('input', { class: 'warden-input', type: 'password', value: PAY.formatNumber(item.number) || '', placeholder: '1234 5678 9012 3456', autocomplete: 'off', inputmode: 'numeric' });
    var netBadge = el('span', { class: 'vpay-netbadge', html: PAY.brandMark(PAY.networkOf(item).id) });
    var numShown = false;
    var numRev = el('button', {
      class: 'warden-icon', type: 'button', title: 'Show', html: host.icons.eye,
      onclick: async function () {
        if (!numShown && !isNew && item.number) { if (!(await requireIdentity(host, 'view this card number'))) return; }
        numShown = !numShown; numInput.type = numShown ? 'text' : 'password';
        numRev.innerHTML = numShown ? host.icons.eyeOff : host.icons.eye;
      },
    });
    // New cards start visible — you're typing them in, and there's nothing
    // saved yet to protect.
    if (isNew) { numInput.type = 'text'; numShown = true; numRev.innerHTML = host.icons.eyeOff; }
    numInput.addEventListener('input', function () {
      var caretAtEnd = numInput.selectionStart === numInput.value.length;
      var d = PAY.digits(numInput.value).slice(0, 19);
      var net = PAY.detectNetwork(d);
      netBadge.innerHTML = PAY.brandMark(net.id);
      cvvInput.setAttribute('maxlength', String(net.cvv));
      if (numShown) { numInput.value = PAY.formatNumber(d, net.id); if (caretAtEnd) numInput.setSelectionRange(numInput.value.length, numInput.value.length); }
      else numInput.value = d;
      validateLive();
    });

    var months = [{ value: '', label: 'MM' }];
    for (var m = 1; m <= 12; m++) months.push({ value: PAY.padMonth(m), label: PAY.padMonth(m) });
    var thisYear = new Date().getFullYear();
    var years = [{ value: '', label: 'YYYY' }];
    for (var y = thisYear; y <= thisYear + 20; y++) years.push({ value: String(y), label: String(y) });
    var expMonth = selectField('Expiry month', months, PAY.padMonth(item.expMonth));
    var expYear = selectField('Expiry year', years, PAY.fullYear(item.expYear));

    var cvvInput = el('input', { class: 'warden-input', type: 'password', value: item.cvv || '', placeholder: '•••', autocomplete: 'off', inputmode: 'numeric', maxlength: String(PAY.cvvLength(item)) });
    var cvvShown = false;
    var cvvRev = el('button', {
      class: 'warden-icon', type: 'button', title: 'Show', html: host.icons.eye,
      onclick: async function () {
        if (!cvvShown && !isNew && item.cvv) { if (!(await requireIdentity(host, 'view this security code'))) return; }
        cvvShown = !cvvShown; cvvInput.type = cvvShown ? 'text' : 'password';
        cvvRev.innerHTML = cvvShown ? host.icons.eyeOff : host.icons.eye;
      },
    });
    if (isNew) { cvvInput.type = 'text'; cvvShown = true; cvvRev.innerHTML = host.icons.eyeOff; }
    cvvInput.addEventListener('input', function () { cvvInput.value = cvvInput.value.replace(/\D/g, ''); validateLive(); });

    var line1 = field('Billing address', billing.line1, { ph: 'Street address' });
    var line2 = field('Address line 2', billing.line2, { ph: 'Apartment, suite, unit (optional)' });
    var city = field('City', billing.city, { ph: 'City' });
    var region = field('State / Province', billing.region, { ph: 'State' });
    var postal = field('ZIP / Postal code', billing.postal, { ph: '78701' });
    var country = field('Country', billing.country, { ph: 'United States' });

    var category = selectField('Category', host.categories.concat(['Payments']).filter(uniq).map(function (c) { return { value: c, label: c }; }), item.category || 'Payments');
    var tags = field('Tags (comma-separated)', Array.isArray(item.tags) ? item.tags.join(', ') : '', { ph: 'travel, business' });
    var notes = field('Notes', item.notes, { textarea: true, ph: 'Anything else worth remembering…' });

    var favCb = el('input', { type: 'checkbox' }); favCb.checked = !!item.favorite;

    // custom fields (same shape the rest of Warden uses)
    var customFields = (Array.isArray(item.customFields) ? item.customFields : []).map(function (c) { return { label: c.label || '', value: c.value || '' }; });
    var cfWrap = el('div', {});
    function renderCF() {
      cfWrap.innerHTML = '';
      customFields.forEach(function (cf, i) {
        var lbl = el('input', { class: 'warden-input', placeholder: 'Label', value: cf.label, style: 'margin:0' });
        var val = el('input', { class: 'warden-input', placeholder: 'Value', value: cf.value, style: 'margin:0' });
        lbl.addEventListener('input', function () { customFields[i].label = lbl.value; });
        val.addEventListener('input', function () { customFields[i].value = val.value; });
        var rm = el('button', { class: 'warden-icon', type: 'button', title: 'Remove', html: '&times;', onclick: function () { customFields.splice(i, 1); renderCF(); } });
        cfWrap.appendChild(el('div', { class: 'warden-cf-row' }, [lbl, val, rm]));
      });
    }
    renderCF();

    var err = el('div', { class: 'warden-err' });
    var warn = el('div', { class: 'vpay-warn' });
    function collect() {
      return {
        method: 'card', type: type.input.value,
        nickname: nickname.input.value, cardholder: holder.input.value,
        number: PAY.digits(numInput.value),
        expMonth: expMonth.input.value, expYear: expYear.input.value,
        cvv: cvvInput.value,
        billing: { line1: line1.input.value, line2: line2.input.value, city: city.input.value, region: region.input.value, postal: postal.input.value, country: country.input.value },
        category: category.input.value,
        tags: tags.input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        notes: notes.input.value,
        favorite: favCb.checked,
        customFields: customFields.filter(function (c) { return (c.label || '').trim() || (c.value || '').trim(); }),
      };
    }
    function validateLive() {
      var v = PAY.validate(collect());
      err.textContent = v.errors[0] || '';
      warn.textContent = v.errors.length ? '' : (v.warnings[0] || '');
    }

    var saveBtn = el('button', { class: 'warden-btn primary' }, [isNew ? 'Add card' : 'Save']);
    saveBtn.addEventListener('click', async function () {
      var out = collect();
      var v = PAY.validate(out);
      if (!v.ok) { err.textContent = v.errors[0]; return; }
      // A new card joins at the top of a manually-ordered wallet (undefined on
      // an unordered one, which keeps the favourite/expiry heuristic).
      if (isNew) {
        var top = PAY.nextTopOrder(host.store().byKind(KIND));
        if (top !== undefined) out.order = top;
      }
      if (!out.nickname && !out.number && !out.cardholder) { err.textContent = 'Give the card a nickname or a number.'; return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Encrypting…';
      try {
        await save(host, item, out);
        close(); host.refreshList(KIND); host.toast(isNew ? 'Card added' : 'Saved');
      } catch (e) {
        err.textContent = 'Save failed: ' + (e.message || e);
        saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Add card' : 'Save';
      }
    });

    var actions = [saveBtn, el('button', { class: 'warden-btn', onclick: close }, ['Cancel'])];
    if (!isNew) {
      actions.push(el('button', {
        class: 'warden-btn danger', onclick: async function () {
          if (!(await host.confirmUI('Delete this payment method? This cannot be undone.', { title: 'Delete card', okLabel: 'Delete', danger: true }))) return;
          if (!(await requireIdentity(host, 'delete this card'))) return;
          await host.store().remove(item.id);
          close(); host.refreshList(KIND); host.toast('Deleted');
        },
      }, ['Delete']));
    }

    var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'warden-modal-title' }, [isNew ? 'Add payment method' : 'Edit payment method']),
      nickname.node, type.node, holder.node,
      el('div', { class: 'warden-field' }, [
        el('label', { class: 'warden-flabel' }, ['Card number']),
        el('div', { class: 'warden-pw-input' }, [numInput, netBadge, numRev]),
      ]),
      el('div', { class: 'vpay-grid3' }, [expMonth.node, expYear.node,
        el('div', { class: 'warden-field' }, [
          el('label', { class: 'warden-flabel' }, ['Security code']),
          el('div', { class: 'warden-pw-input' }, [cvvInput, cvvRev]),
        ]),
      ]),
      el('label', { class: 'warden-ack' }, [favCb, el('span', {}, ['Pin this card to the top'])]),
      el('div', { class: 'vpay-sec' }, ['Billing address']),
      line1.node, line2.node,
      el('div', { class: 'vpay-grid3' }, [city.node, region.node, postal.node]),
      country.node,
      el('div', { class: 'vpay-sec' }, ['Details']),
      category.node, tags.node, notes.node,
      el('div', { class: 'warden-field' }, [
        el('label', { class: 'warden-flabel' }, ['Custom fields']), cfWrap,
        el('button', { class: 'warden-btn', type: 'button', style: 'width:auto;margin:2px 0 0;padding:8px 12px', onclick: function () { customFields.push({ label: '', value: '' }); renderCF(); } }, ['+ Add custom field']),
      ]),
      err, warn,
      el('div', { class: 'warden-modal-actions' }, actions),
      el('p', { class: 'warden-fine' }, ['Encrypted on this device before it syncs · AES-256-GCM · zero-knowledge']),
    ]);
    overlay.appendChild(box); document.body.appendChild(overlay);
    validateLive();
    setTimeout(function () { nickname.input.focus(); }, 50);
  }

  function uniq(v, i, a) { return a.indexOf(v) === i; }

  // ── icons (matching warden-ui.js's stroke style) ───────────────────────────
  function cvvIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V8a5 5 0 0 1 10 0v3"/></svg>'; }
  function homeIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>'; }
  function pinIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'; }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('warden-pay-styles')) return;
    var css = [
      '.vpay-site.vpay-expired .warden-row-title{opacity:.7}',
      '.vpay-mark{width:34px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center}',
      '.vpay-mark svg{width:34px;height:22px;display:block}',
      '.vpay-chip{font-size:10.5px;font-weight:500;letter-spacing:.2px;padding:3px 9px;border-radius:5px;flex-shrink:0;white-space:nowrap}',
      '.vpay-chip.warn{background:transparent;border:1px solid rgba(141,118,154,.36);color:#8D769A}.vpay-chip.bad{background:transparent;border:1px solid rgba(214,138,124,.45);color:#E74C3C}',
      '.warden-icon.vpay-on{color:var(--ac);border-color:var(--ac)}',
      '.vpay-body{border-top:1px solid var(--bd)}',
      // Drag-to-reorder styling lives with the shared engine in warden-ui.js
      // (.warden-drag / .warden-reordering / .warden-rowbody).
      '.vpay-detail{display:flex;gap:16px;padding:14px;align-items:flex-start}',
      '.vpay-detail-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}',
      // the card face
      '.vpay-face{width:236px;flex-shrink:0;aspect-ratio:1.586;border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;color:#fff;',
      '  background:linear-gradient(135deg,#3A3B40,#303135);box-shadow:0 6px 18px rgba(0,0,0,.45);position:relative;overflow:hidden}',
      '.vpay-face::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 110% -10%,rgba(255,255,255,.16),transparent 60%);pointer-events:none}',
      '.vpay-net-visa{background:linear-gradient(135deg,#2b3a8f,#141a52)}',
      '.vpay-net-mastercard{background:linear-gradient(135deg,#8c2f2a,#2a1414)}',
      '.vpay-net-amex{background:linear-gradient(135deg,#1F72CD,#0d3a6b)}',
      '.vpay-net-discover{background:linear-gradient(135deg,#c2591a,#3a1c08)}',
      '.vpay-net-diners{background:linear-gradient(135deg,#0079BE,#062f4a)}',
      '.vpay-net-jcb{background:linear-gradient(135deg,#0B4EA2,#08203f)}',
      '.vpay-net-unionpay{background:linear-gradient(135deg,#8f1524,#1c0a0f)}',
      '.vpay-net-maestro{background:linear-gradient(135deg,#4a49a0,#1a1a3a)}',
      '.vpay-face-top{display:flex;align-items:flex-start;justify-content:space-between;position:relative;z-index:1}',
      '.vpay-face-mark svg{width:38px;height:25px;display:block}',
      '.vpay-face-star{color:#f4d795;line-height:0;display:inline-flex}.vpay-face-star svg{width:14px;height:14px;display:block}',
      '.vpay-face-chip{width:31px;height:23px;border-radius:5px;margin:10px 0 8px;position:relative;z-index:1;',
      '  background:linear-gradient(135deg,#e6c878,#b8922f);box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}',
      '.vpay-face-num{font-family:ui-monospace,monospace;font-size:14.5px;letter-spacing:1.2px;font-weight:600;position:relative;z-index:1;',
      '  text-shadow:0 1px 2px rgba(0,0,0,.4);word-break:break-all}',
      '.vpay-face-num.shown{color:#ffe9ef}',
      '.vpay-face-bot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:auto;padding-top:8px;position:relative;z-index:1}',
      '.vpay-face-name{font-size:10.5px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;opacity:.92;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.vpay-face-exp{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;opacity:.92;flex-shrink:0}',
      // editor
      '.vpay-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}',
      '.vpay-sec{font-size:11px;font-weight:800;color:var(--txm);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--bd)}',
      '.vpay-netbadge{display:flex;align-items:center;flex-shrink:0}.vpay-netbadge svg{width:34px;height:22px;display:block}',
      '.vpay-warn{color:#8D769A;font-size:11.5px;min-height:14px;margin:-4px 0 4px;text-align:left;line-height:1.5}',
      // ── responsive ──
      // The face is a fixed-ratio object, so it gets a width that tracks the
      // viewport instead of a hard 236px that would overflow a narrow phone.
      '@media (max-width:900px){',
      '  .vpay-detail{gap:12px}',
      '  .vpay-face{width:min(236px,42vw)}',
      '}',
      '@media (max-width:640px){',
      // Below this the two-column detail is narrower than the card face itself,
      // so the face goes on top at a comfortable reading size.
      '  .vpay-detail{flex-direction:column;gap:12px;padding:12px}',
      '  .vpay-face{width:100%;max-width:300px;align-self:center}',
      '  .vpay-face-num{font-size:clamp(13px,4.2vw,16px)}',
      '  .vpay-grid3{grid-template-columns:1fr 1fr}',
      '  .vpay-chip{display:none}',       // the expiry also reads in the subtitle
      '  .vpay-head{gap:8px;padding:11px 10px}',
      '  .vpay-mark,.vpay-mark svg{width:30px;height:20px}',
      '  .vpay-sec{margin:12px 0 8px}',
      '}',
      '@media (max-width:380px){',
      '  .vpay-grid3{grid-template-columns:1fr}',
      '  .vpay-mark{display:none}',       // the brand is already on the face
      '  .vpay-face{max-width:none}',
      '}',
    ].join('');
    var s = document.createElement('style'); s.id = 'warden-pay-styles'; s.innerHTML = css;
    document.head.appendChild(s);
  }

  window.WardenPayUI = { render: render, fillList: fillList, openEditor: openEditor, resetGrace: resetGrace, KIND: KIND };
})();
