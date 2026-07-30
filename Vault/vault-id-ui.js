/* ─────────────────────────────────────────────────────────────────────────────
 * vault-id-ui.js — Vault · ID Docs tab (PWA)
 *
 * Identity documents shown as a wallet of cards: a licence, a passport, an
 * insurance card, each with its expiry state on its face, opening into a
 * full-screen viewer with zoom, pan and swipe.
 *
 * ── How it plugs in ─────────────────────────────────────────────────────────
 * vault-ui.js owns the shell (tabs, lock screen, toolbar, sync status) and
 * hands this module a `host` context — see hostCtx() there. Everything below
 * goes through that contract, so there is exactly ONE session, ONE DEK and ONE
 * sync path in the app. This module never touches Firebase or the device store;
 * it can't even see them. It reaches crypto only through host.encryptBytes /
 * host.decryptBytes (via vault-id-files.js), which run inside the session — the
 * DEK is never handed out.
 *
 * ── Security posture ────────────────────────────────────────────────────────
 *  • Everything renders only while the vault is unlocked, and the shell's idle
 *    auto-lock tears this tab down like every other. reset() then revokes every
 *    decrypted object URL, so no plaintext image survives a lock.
 *  • Document numbers render masked (••••••••4321) with an eye to reveal, and
 *    re-mask themselves after AUTO_REMASK_MS — the same treatment a password
 *    gets next door.
 *  • Thumbnails render BLURRED in the grid until the document is opened, so a
 *    shoulder-surfer can't read a licence off a scrolling list.
 *  • Deleting a document or one of its scans requires host.verifyIdentity() —
 *    the same biometric-or-master-password check that gates deleting a card.
 *  • Attachment bytes are AES-256-GCM encrypted before upload; see
 *    vault-id-files.js for why the file host can hold them safely.
 *
 * ── No save button ──────────────────────────────────────────────────────────
 * The editor commits on its own: field edits debounce into one encrypted write,
 * uploads commit the instant they land, and closing flushes anything pending.
 * That's what makes "changes sync instantly across devices" literally true — a
 * document edited on a phone is on the desktop before the modal is closed.
 *
 * Depends on: vault-id.js (core), vault-id-files.js (bytes), vault-ui.js (host).
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.VaultIdUI) return;

  var VID = window.VaultId;
  var VIF = window.VaultIdFiles;
  var KIND = 'iddoc';
  var AUTO_REMASK_MS = 45 * 1000;   // a revealed document number re-hides itself
  var SAVE_DEBOUNCE_MS = 700;       // field edits coalesce into one encrypted write
  var SWIPE_MIN = 48;               // px before a horizontal drag counts as a swipe

  // View state. Deliberately module-level (not per-render) so a live sync from
  // another device repaints the grid without throwing away the user's filter.
  var _sort = 'added';
  var _filter = 'all';
  var _retryTimer = null;

  // ── helpers ───────────────────────────────────────────────────────────────
  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function isCoarse() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  }

  // The documents currently on screen, in the order they're on screen. The
  // viewer navigates this exact list, so ←/→ and swipe always match what the
  // grid shows rather than some hidden canonical order.
  function currentDocs(host) {
    var store = host.store();
    var q = host.query();
    var list = q ? store.search(q).filter(function (i) { return i.kind === KIND; }) : store.byKind(KIND);
    return VID.sortDocs(VID.filterDocs(list, _filter), _sort);
  }

  // ── list / grid ───────────────────────────────────────────────────────────
  function fillList(list, host) {
    injectStyles();
    list.innerHTML = '';
    if (!VID || !VIF) {
      list.appendChild(host.emptyState('ID Docs module not loaded — check the vault-id.js / vault-id-files.js includes.'));
      return;
    }
    var el = host.el;
    var all = host.store().byKind(KIND);
    var docs = currentDocs(host);

    list.appendChild(bigAddButton(host));
    if (all.length) list.appendChild(controls(host, all, docs));

    // A document whose bytes never made it up is worth calling out once, at the
    // top, rather than as a badge the user has to hunt for.
    var pending = all.filter(VID.hasPendingUpload);
    if (pending.length) list.appendChild(pendingBanner(host, pending));

    if (!docs.length) {
      list.appendChild(host.emptyState(
        host.query() ? 'No matching documents.'
          : _filter !== 'all' ? 'No documents in this category yet.'
            : 'No ID documents yet. Add your licence, passport, insurance card or anything else you need on hand — stored encrypted, same as your passwords.'));
      return;
    }

    var grid = el('div', { class: 'vid-grid', role: 'list' });
    docs.forEach(function (it, i) { grid.appendChild(docCard(it, host, i)); });
    list.appendChild(grid);
    scheduleRetry(host);
  }

  function render(panel, host) {
    injectStyles();
    var list = host.el('div', { class: 'vault-list' });
    fillList(list, host);
    panel.appendChild(list);
  }

  // The one large primary call to action the section is built around.
  function bigAddButton(host) {
    return host.el('button', {
      class: 'vid-add', type: 'button',
      html: icons.plus + '<span>Add ID Document</span>',
      onclick: function () { openTypePicker(host); },
    });
  }

  function controls(host, all, shown) {
    var el = host.el;
    var counts = VID.groupCounts(all);
    var chips = el('div', { class: 'vid-chips', role: 'group', 'aria-label': 'Filter by document type' });
    function chip(id, label, n) {
      var b = el('button', {
        class: 'vid-chip' + (_filter === id ? ' active' : ''), type: 'button',
        'aria-pressed': _filter === id ? 'true' : 'false',
        onclick: function () { _filter = id; host.refreshList(KIND); },
      }, [label + (n != null ? ' · ' + n : '')]);
      return b;
    }
    chips.appendChild(chip('all', 'All', all.length));
    VID.GROUPS.forEach(function (g) { if (counts[g.id]) chips.appendChild(chip(g.id, g.label, counts[g.id])); });

    var sel = el('select', { class: 'vid-sort', 'aria-label': 'Sort documents' });
    VID.SORTS.forEach(function (s) {
      var o = el('option', { value: s.id }, [s.label]);
      if (s.id === _sort) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { _sort = sel.value; host.refreshList(KIND); });

    return el('div', { class: 'vid-controls' }, [
      chips,
      el('div', { class: 'vid-sort-wrap' }, [el('span', { class: 'vid-sort-label' }, ['Sort']), sel]),
      el('div', { class: 'vid-count' }, [shown.length + ' of ' + all.length]),
    ]);
  }

  function pendingBanner(host, pending) {
    var el = host.el;
    var btn = el('button', { class: 'vid-banner-btn', type: 'button' }, ['Retry now']);
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Uploading…';
      flushPending(host, true).then(function (r) {
        host.toast(r.uploaded ? r.uploaded + ' file' + (r.uploaded === 1 ? '' : 's') + ' uploaded' : 'Still offline — will keep trying');
        host.refreshList(KIND);
      });
    });
    return el('div', { class: 'vid-banner', role: 'status' }, [
      el('span', { class: 'vid-banner-icon', html: icons.cloudOff }),
      el('div', { class: 'vid-banner-text' }, [
        pending.length + ' document' + (pending.length === 1 ? ' has' : 's have') + ' files waiting to upload. ' +
        'They are saved and encrypted on this device and will sync automatically.',
      ]),
      btn,
    ]);
  }

  // ── one card ──────────────────────────────────────────────────────────────
  function docCard(it, host, index) {
    var el = host.el;
    var s = VID.summarize(it);

    var media;
    if (s.cover && s.cover.thumb) {
      // Blurred until opened — the grid should say "this is your licence", not
      // show the licence. `alt` stays generic for the same reason.
      media = el('div', { class: 'vid-card-media' }, [
        el('img', { class: 'vid-thumb', src: s.cover.thumb, alt: '', loading: 'lazy', decoding: 'async' }),
        el('span', { class: 'vid-thumb-veil' }),
        el('span', { class: 'vid-thumb-glyph', html: typeGlyph(s.type.id) }),
      ]);
    } else {
      media = el('div', { class: 'vid-card-media empty' }, [
        el('span', { class: 'vid-card-glyph', html: typeGlyph(s.type.id) }),
      ]);
    }

    var badge = null;
    if (s.expiryState === 'expired') badge = el('span', { class: 'vid-badge bad' }, ['Expired']);
    else if (s.expiryState === 'expiring') badge = el('span', { class: 'vid-badge warn' }, ['Expires Soon']);
    else if (s.expiryState === 'valid') badge = el('span', { class: 'vid-badge ok' }, ['Valid']);

    var expiryBlock = s.expiration
      ? el('div', { class: 'vid-card-exp' }, [
        el('span', { class: 'vid-card-exp-label' }, ['Expires:']),
        el('span', { class: 'vid-card-exp-val' }, [s.expirationShort]),
      ])
      : null;

    var meta = el('div', { class: 'vid-card-meta' }, [
      el('div', { class: 'vid-card-type' }, [s.typeLabel]),
      el('div', { class: 'vid-card-title' }, [s.title]),
      s.subtitleFull ? el('div', { class: 'vid-card-sub' }, [s.subtitleFull]) : null,
      expiryBlock,
    ]);

    var foot = el('div', { class: 'vid-card-foot' }, [
      badge,
      s.attachments ? el('span', { class: 'vid-card-files' }, [
        el('span', { class: 'vid-card-files-icon', html: icons.paperclip }),
        el('span', {}, [String(s.attachments)]),
      ]) : el('span', { class: 'vid-card-files muted' }, ['No files']),
      s.pending ? el('span', { class: 'vid-card-pending', title: 'Waiting to upload', html: icons.cloudOff }) : null,
    ]);

    var card = el('div', {
      class: 'vid-card' + (s.expiryState === 'expired' ? ' expired' : ''),
      'data-id': it.id, role: 'listitem', tabindex: '0',
      'aria-label': s.typeLabel + ': ' + s.title + (s.expiration ? ', expires ' + s.expirationLabel : '') + (s.badge ? ', ' + s.badge : ''),
    }, [media, meta, foot]);

    function open() { openViewer(host, it.id, 0); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openEditor(it, host); }
    });

    // Edit is reachable without opening the viewer — a quick correction
    // shouldn't cost a full-screen transition.
    var editBtn = el('button', {
      class: 'vid-card-edit', type: 'button', 'aria-label': 'Edit ' + s.title,
      title: 'Edit', html: icons.pencil,
      onclick: function (e) { e.stopPropagation(); openEditor(it, host); },
    });
    card.appendChild(editBtn);
    return card;
  }

  // ── persistence ───────────────────────────────────────────────────────────
  // Every write funnels through here so normalisation can never be skipped and
  // id/createdAt always survive an edit.
  function save(host, item, patch) {
    var merged = Object.assign({}, item || {}, patch || {});
    var body = VID.normalize(merged);
    body.id = item && item.id;
    body.createdAt = (item && item.createdAt) || undefined;
    return host.store().save(body);
  }

  // ── queued-upload flush ───────────────────────────────────────────────────
  async function flushPending(host, force) {
    if (!VIF) return { uploaded: 0, failed: 0 };
    try {
      return await VIF.retryPending(host.store().byKind(KIND), host.session(), {
        onChanged: function (items) {
          // One batch → one repaint, one debounced cloud write.
          return host.store().saveMany(items.map(function (it) {
            var b = VID.normalize(it); b.id = it.id; b.createdAt = it.createdAt; return b;
          }));
        },
      });
    } catch (e) { return { uploaded: 0, failed: 0 }; }
  }
  // Retry on a timer, when the network comes back, and when the tab is shown —
  // between them, a queued upload gets its chance without the user doing a thing.
  function scheduleRetry(host) {
    if (_retryTimer) return;
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      flushPending(host).then(function (r) { if (r.uploaded) host.refreshList(KIND); });
    }, 4000);
    if (!scheduleRetry._bound) {
      scheduleRetry._bound = true;
      window.addEventListener('online', function () { flushPending(host).then(function (r) { if (r.uploaded) host.refreshList(KIND); }); });
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) flushPending(host).then(function (r) { if (r.uploaded) host.refreshList(KIND); });
      });
    }
  }

  // ── type picker ───────────────────────────────────────────────────────────
  function openTypePicker(host) {
    injectStyles();
    var el = host.el;
    var modal = openModal(host, {
      title: 'Add ID Document',
      sub: 'Pick a document type — the next screen asks only for the fields that type actually has.',
      wide: true,
    });
    var grid = el('div', { class: 'vid-typegrid' });
    VID.TYPES.forEach(function (t) {
      var b = el('button', {
        class: 'vid-typetile', type: 'button',
        onclick: function () { modal.close(); openEditor({ docType: t.id }, host); },
      }, [
        el('span', { class: 'vid-typetile-icon', html: typeGlyph(t.id) }),
        el('span', { class: 'vid-typetile-label' }, [t.label]),
      ]);
      grid.appendChild(b);
    });
    modal.body.appendChild(grid);
    modal.actions([el('button', { class: 'vault-btn', onclick: modal.close }, ['Cancel'])]);
    modal.mount();
    setTimeout(function () { var f = grid.querySelector('button'); if (f) f.focus(); }, 60);
  }

  // ── editor ────────────────────────────────────────────────────────────────
  // Auto-saving: there is no Save button anywhere in this flow. `draft` holds
  // the in-progress body, `commit()` encrypts + writes it, and every input
  // schedules a debounced commit. The first commit creates the item and adopts
  // its id, so uploads that follow attach to a real document.
  function openEditor(item, host) {
    injectStyles();
    var el = host.el;
    var isNew = !item || !item.id;
    var type = VID.typeOf(item);
    var draft = VID.normalize(item || { docType: type.id });
    if (item && item.id) { draft.id = item.id; draft.createdAt = item.createdAt; }
    // A brand-new document starts with the type's name so it is never "Untitled"
    // in the grid; the user overwrites it if they want.
    if (isNew && !item.title) draft.title = type.custom ? '' : type.label;

    var dirty = false, saving = false, saveTimer = null, closed = false;
    var statusEl = el('div', { class: 'vid-status', role: 'status', 'aria-live': 'polite' });

    function setStatus(text, tone) {
      statusEl.textContent = text || '';
      statusEl.className = 'vid-status' + (tone ? ' ' + tone : '');
    }
    async function commit(opts) {
      opts = opts || {};
      if (saving) { dirty = true; return; }
      if (!dirty && !opts.force) return;
      dirty = false; saving = true;
      setStatus('Saving…');
      try {
        var saved = await save(host, draft.id ? { id: draft.id, createdAt: draft.createdAt } : null, draft);
        if (saved && saved.id) { draft.id = saved.id; draft.createdAt = saved.createdAt; }
        setStatus('Saved · syncing', 'ok');
        host.refreshList(KIND);
      } catch (e) {
        dirty = true;
        setStatus('Could not save — retrying', 'bad');
        setTimeout(function () { if (!closed) commit({ force: true }); }, 3000);
      } finally { saving = false; }
      if (dirty) scheduleSave();
    }
    function scheduleSave() {
      dirty = true;
      setStatus('Editing…');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { commit(); }, SAVE_DEBOUNCE_MS);
    }
    function saveNow() { clearTimeout(saveTimer); return commit({ force: true }); }

    var modal = openModal(host, {
      title: (isNew ? 'Add ' : 'Edit ') + type.label,
      wide: true,
      onClose: function () {
        closed = true;
        clearTimeout(saveTimer);
        if (dirty) commit({ force: true });
        host.refreshList(KIND);
      },
    });

    // ── fields, driven entirely by the type registry ──
    var inputs = {};
    type.fields.forEach(function (key) {
      var label = VID.fieldLabel(type, key);
      var hint = VID.fieldHint(type, key);
      var node, input;
      if (VID.isLongField(key)) {
        input = el('textarea', { class: 'vault-input', value: draft[key] || '', placeholder: hint, rows: key === 'notes' ? '4' : '2' });
      } else if (VID.isDateField(key)) {
        input = el('input', { class: 'vault-input', type: 'date', value: draft[key] || '' });
      } else if (VID.isSecretField(key)) {
        input = el('input', { class: 'vault-input', type: 'password', value: draft[key] || '', placeholder: hint, autocomplete: 'off', spellcheck: 'false' });
      } else {
        input = el('input', { class: 'vault-input', type: 'text', value: draft[key] || '', placeholder: hint, autocomplete: 'off' });
      }
      input.id = 'vid-f-' + key;
      input.addEventListener('input', function () { draft[key] = input.value; scheduleSave(); });
      input.addEventListener('change', function () { draft[key] = input.value; scheduleSave(); });
      inputs[key] = input;

      var control = input;
      if (VID.isSecretField(key)) {
        var shown = false;
        var revBtn = el('button', {
          class: 'vault-icon', type: 'button', title: 'Show', 'aria-label': 'Show ' + label, html: host.icons.eye,
          onclick: function () {
            shown = !shown; input.type = shown ? 'text' : 'password';
            revBtn.innerHTML = shown ? host.icons.eyeOff : host.icons.eye;
            revBtn.setAttribute('aria-label', (shown ? 'Hide ' : 'Show ') + label);
          },
        });
        // A number being typed for the first time has nothing to hide yet.
        if (isNew) { input.type = 'text'; shown = true; revBtn.innerHTML = host.icons.eyeOff; }
        control = el('div', { class: 'vault-pw-input' }, [input, revBtn]);
      }
      node = el('div', { class: 'vault-field' }, [
        el('label', { class: 'vault-flabel', for: input.id }, [label]), control,
      ]);
      modal.body.appendChild(node);
    });

    // ── uploads ──
    var upWrap = el('div', { class: 'vid-uploads' });
    function renderUploads() {
      upWrap.innerHTML = '';
      if (type.sides >= 1) upWrap.appendChild(slotZone(host, draft, 'front', 'Front image', renderUploads, scheduleSaveAfterUpload));
      if (type.sides >= 2) upWrap.appendChild(slotZone(host, draft, 'back', 'Back image', renderUploads, scheduleSaveAfterUpload));
      if (type.attachments) upWrap.appendChild(extrasZone(host, draft, renderUploads, scheduleSaveAfterUpload));
    }
    // Uploads are never debounced — a file that took ten seconds to encrypt and
    // upload gets written to the vault the moment it lands.
    function scheduleSaveAfterUpload() { dirty = true; return saveNow(); }
    renderUploads();
    modal.body.appendChild(el('div', { class: 'vid-sec' }, ['Files']));
    modal.body.appendChild(upWrap);

    // ── details shared with the rest of Vault ──
    modal.body.appendChild(el('div', { class: 'vid-sec' }, ['Details']));
    var tagsIn = el('input', { class: 'vault-input', type: 'text', value: (draft.tags || []).join(', '), placeholder: 'travel, family', autocomplete: 'off' });
    tagsIn.addEventListener('input', function () {
      draft.tags = tagsIn.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean); scheduleSave();
    });
    modal.body.appendChild(el('div', { class: 'vault-field' }, [el('label', { class: 'vault-flabel' }, ['Tags (comma-separated)']), tagsIn]));

    var catSel = el('select', { class: 'vault-input' });
    host.categories.concat(['Identity']).filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (c) {
      var o = el('option', { value: c }, [c]); if ((draft.category || 'Identity') === c) o.selected = true; catSel.appendChild(o);
    });
    catSel.addEventListener('change', function () { draft.category = catSel.value; scheduleSave(); });
    modal.body.appendChild(el('div', { class: 'vault-field' }, [el('label', { class: 'vault-flabel' }, ['Category']), catSel]));

    var favCb = el('input', { type: 'checkbox' }); favCb.checked = !!draft.favorite;
    favCb.addEventListener('change', function () { draft.favorite = favCb.checked; scheduleSave(); });
    modal.body.appendChild(el('label', { class: 'vault-ack' }, [favCb, el('span', {}, ['Pin this document to the top'])]));

    // custom fields — same shape the rest of Vault uses
    var cfWrap = el('div', {});
    function renderCF() {
      cfWrap.innerHTML = '';
      (draft.customFields || []).forEach(function (cf, i) {
        var lbl = el('input', { class: 'vault-input', placeholder: 'Label', value: cf.label, style: 'margin:0' });
        var val = el('input', { class: 'vault-input', placeholder: 'Value', value: cf.value, style: 'margin:0' });
        lbl.addEventListener('input', function () { draft.customFields[i].label = lbl.value; scheduleSave(); });
        val.addEventListener('input', function () { draft.customFields[i].value = val.value; scheduleSave(); });
        var rm = el('button', {
          class: 'vault-icon', type: 'button', title: 'Remove', 'aria-label': 'Remove custom field', html: '&times;',
          onclick: function () { draft.customFields.splice(i, 1); renderCF(); scheduleSave(); },
        });
        cfWrap.appendChild(el('div', { class: 'vault-cf-row' }, [lbl, val, rm]));
      });
    }
    renderCF();
    modal.body.appendChild(el('div', { class: 'vault-field' }, [
      el('label', { class: 'vault-flabel' }, ['Custom fields']), cfWrap,
      el('button', {
        class: 'vault-btn', type: 'button', style: 'width:auto;margin:2px 0 0;padding:8px 12px',
        onclick: function () { draft.customFields = draft.customFields || []; draft.customFields.push({ label: '', value: '' }); renderCF(); },
      }, ['+ Add custom field']),
    ]));

    var warn = el('div', { class: 'vid-warn', role: 'status' });
    function refreshWarn() {
      var v = VID.validate(draft);
      warn.textContent = v.errors[0] || v.warnings[0] || '';
      warn.className = 'vid-warn' + (v.errors.length ? ' bad' : '');
    }
    modal.body.addEventListener('input', refreshWarn);
    modal.body.addEventListener('change', refreshWarn);
    refreshWarn();
    modal.body.appendChild(warn);
    modal.body.appendChild(statusEl);

    var acts = [el('button', { class: 'vault-btn primary', onclick: function () { modal.close(); } }, ['Done'])];
    if (!isNew) {
      acts.push(el('button', {
        class: 'vault-btn danger',
        onclick: function () { deleteDoc(host, draft, function () { modal.close(true); }); },
      }, ['Delete']));
    }
    modal.actions(acts);
    modal.body.appendChild(el('p', { class: 'vault-fine' }, ['Saves as you type · encrypted on this device before it syncs · AES-256-GCM']));
    modal.mount();
    setTimeout(function () { var f = modal.body.querySelector('input,textarea'); if (f) f.focus(); }, 60);
  }

  // ── delete ────────────────────────────────────────────────────────────────
  // Confirm, then prove identity — destroying an identity document is as
  // consequential as revealing a card number, and it takes its files with it.
  async function deleteDoc(host, item, onDone) {
    if (!item || !item.id) { if (onDone) onDone(); return; }
    var ok = await host.confirmUI('Delete this document and its files? This cannot be undone.',
      { title: 'Delete document', okLabel: 'Delete', danger: true });
    if (!ok) return;
    if (!(await host.verifyIdentity('delete this ID document'))) return;
    var atts = VID.allAttachments(item).map(function (e) { return e.att; });
    try { await host.store().remove(item.id); } catch (e) { host.toast('Delete failed'); return; }
    VIF.removeMany(atts);                       // best effort; orphaned ciphertext is unreadable
    host.toast('Deleted');
    host.refreshList(KIND);
    if (onDone) onDone();
  }

  // ── upload zones ──────────────────────────────────────────────────────────
  // One zone per slot. Handles: drag & drop (desktop), file picker, camera
  // capture and gallery (mobile), replace, delete, and a live progress bar.
  function slotZone(host, draft, slot, label, rerender, commit) {
    var el = host.el;
    var att = draft[slot];
    var box = el('div', { class: 'vid-slot' });
    box.appendChild(el('div', { class: 'vid-slot-label' }, [label]));
    if (att) box.appendChild(attachmentTile(host, draft, att, { slot: slot }, rerender, commit));
    else box.appendChild(dropZone(host, 'image/*', false, function (files) {
      addFiles(host, draft, files, { slot: slot }, rerender, commit);
    }, rerender));
    return box;
  }

  function extrasZone(host, draft, rerender, commit) {
    var el = host.el;
    var box = el('div', { class: 'vid-slot vid-slot-wide' });
    box.appendChild(el('div', { class: 'vid-slot-label' }, ['Attachments (images & PDFs)']));
    var listWrap = el('div', { class: 'vid-attlist' });
    (draft.attachments || []).forEach(function (a, i) {
      listWrap.appendChild(attachmentTile(host, draft, a, { slot: 'attachments', index: i }, rerender, commit));
    });
    box.appendChild(listWrap);
    box.appendChild(dropZone(host, VIF.ACCEPT, true, function (files) {
      addFiles(host, draft, files, { slot: 'attachments' }, rerender, commit);
    }, rerender));
    return box;
  }

  function dropZone(host, accept, multiple, onFiles, rerender) {
    var el = host.el;
    var picker = el('input', { type: 'file', accept: accept, style: 'display:none' });
    if (multiple) picker.setAttribute('multiple', 'multiple');
    picker.addEventListener('change', function () {
      var files = Array.prototype.slice.call(picker.files || []);
      picker.value = '';
      if (files.length) onFiles(files);
    });
    // A separate input, because `capture` is what opens the camera directly
    // instead of the OS file browser — the same input can't do both.
    var camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
    camera.addEventListener('change', function () {
      var files = Array.prototype.slice.call(camera.files || []);
      camera.value = '';
      if (files.length) onFiles(files);
    });

    var btns = el('div', { class: 'vid-zone-btns' }, [
      el('button', { class: 'vid-zone-btn', type: 'button', html: icons.folder + '<span>Choose file</span>', onclick: function (e) { e.stopPropagation(); picker.click(); } }),
      isCoarse() ? el('button', { class: 'vid-zone-btn', type: 'button', html: icons.camera + '<span>Take photo</span>', onclick: function (e) { e.stopPropagation(); camera.click(); } }) : null,
    ]);

    var zone = el('div', {
      class: 'vid-zone', tabindex: '0', role: 'button',
      'aria-label': 'Add a file — drag and drop, or activate to choose one',
    }, [
      el('span', { class: 'vid-zone-icon', html: icons.upload }),
      el('span', { class: 'vid-zone-text' }, [isCoarse() ? 'Add a photo or PDF' : 'Drag & drop, or choose a file']),
      btns, picker, camera,
    ]);
    zone.addEventListener('click', function () { picker.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    });
    return zone;
  }

  // Encrypt + upload, showing real progress, then write the descriptor onto the
  // draft and commit. A failure to reach the host is NOT a failure to save: the
  // ciphertext is already cached locally and the descriptor is marked pending.
  async function addFiles(host, draft, files, target, rerender, commit) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var prog = progressRow(host, file);
      var mountPoint = document.querySelector('.vid-uploads');
      if (mountPoint) mountPoint.appendChild(prog.node);
      try {
        var att = await VIF.attach(file, host.session(), {
          onStage: prog.stage, onProgress: prog.progress,
        });
        if (target.slot === 'attachments') {
          draft.attachments = draft.attachments || [];
          draft.attachments.push(att);
        } else {
          var old = draft[target.slot];
          draft[target.slot] = att;
          if (old) VIF.remove(old);            // replacing frees the old blob
        }
        await commit();
        if (att.pending) host.toast('Saved on this device — will upload when you are back online');
      } catch (e) {
        host.toast(e && e.tooLarge
          ? 'That file is over ' + VIF.humanSize(VIF.MAX_BYTES) + ' — try a smaller scan'
          : 'Could not add that file');
      } finally {
        prog.node.remove();
      }
    }
    rerender();
  }

  function progressRow(host, file) {
    var el = host.el;
    var bar = el('div', { class: 'vid-prog-fill' });
    var label = el('span', { class: 'vid-prog-stage' }, ['Preparing…']);
    var node = el('div', { class: 'vid-prog', role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'vid-prog-top' }, [
        el('span', { class: 'vid-prog-name' }, [file.name || 'file']),
        el('span', { class: 'vid-prog-size' }, [VIF.humanSize(file.size)]),
      ]),
      el('div', { class: 'vid-prog-track' }, [bar]),
      label,
    ]);
    return {
      node: node,
      progress: function (p) { bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; },
      stage: function (s) {
        label.textContent = s === 'encrypting' ? 'Encrypting on this device…'
          : s === 'uploading' ? 'Uploading…'
            : s === 'queued' ? 'Saved locally — will sync later' : 'Done';
      },
    };
  }

  function attachmentTile(host, draft, att, target, rerender, commit) {
    var el = host.el;
    var isImg = VID.isImage(att);
    var preview = isImg && att.thumb
      ? el('div', { class: 'vid-tile-img' }, [
        el('img', { src: att.thumb, alt: '', loading: 'lazy' }),
        el('span', { class: 'vid-thumb-veil' }),
      ])
      : el('div', { class: 'vid-tile-img empty' }, [el('span', { html: VID.isPdf(att) ? icons.pdf : icons.file })]);

    var replace = el('input', { type: 'file', accept: isImg ? 'image/*' : VIF.ACCEPT, style: 'display:none' });
    replace.addEventListener('change', function () {
      var f = replace.files && replace.files[0]; replace.value = '';
      if (f) addFiles(host, draft, [f], target, rerender, commit);
    });

    return el('div', { class: 'vid-tile' }, [
      preview,
      el('div', { class: 'vid-tile-main' }, [
        el('div', { class: 'vid-tile-name' }, [att.name || 'document']),
        el('div', { class: 'vid-tile-sub' }, [
          VIF.humanSize(att.size) + (att.pending ? ' · waiting to upload' : ''),
        ]),
      ]),
      el('div', { class: 'vid-tile-btns' }, [
        host.iconBtn('Replace', icons.swap, function () { replace.click(); }),
        host.iconBtn('Remove', icons.trash, async function () {
          if (!(await host.confirmUI('Remove this file from the document?', { title: 'Remove file', okLabel: 'Remove', danger: true }))) return;
          if (target.slot === 'attachments') draft.attachments.splice(target.index, 1);
          else draft[target.slot] = null;
          VIF.remove(att);
          await commit();
          rerender();
        }),
      ]),
      replace,
    ]);
  }

  // ── viewer ────────────────────────────────────────────────────────────────
  // A full-screen stage over a flattened page list: every attachment of every
  // document currently on screen, in grid order. ←/→ and swipe walk that list,
  // so paging past a licence's back image lands on the next document — which is
  // exactly what "swipe between documents" should feel like.
  function openViewer(host, itemId, pageIndexInDoc) {
    injectStyles();
    var el = host.el;
    var docs = currentDocs(host);
    var pages = [];
    docs.forEach(function (d) {
      var entries = VID.allAttachments(d);
      if (!entries.length) { pages.push({ item: d, entry: null }); return; }
      entries.forEach(function (e) { pages.push({ item: d, entry: e }); });
    });
    if (!pages.length) return;

    var idx = 0;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].item.id === itemId) { idx = i + Math.min(pageIndexInDoc || 0, 0); break; }
    }

    var lastFocus = document.activeElement;
    var overlay = el('div', {
      class: 'vid-viewer' + (prefersReducedMotion() ? ' noanim' : ''),
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Document viewer',
    });

    var stage = el('div', { class: 'vid-stage' });
    var titleEl = el('div', { class: 'vid-v-title' });
    var subEl = el('div', { class: 'vid-v-sub' });
    var counter = el('div', { class: 'vid-v-counter' });
    var metaWrap = el('div', { class: 'vid-v-meta' });
    var actionsWrap = el('div', { class: 'vid-v-actions' });

    var closeBtn = el('button', { class: 'vid-v-close', type: 'button', 'aria-label': 'Close viewer', title: 'Close (Esc)', html: icons.x, onclick: close });
    var prevBtn = el('button', { class: 'vid-v-nav prev', type: 'button', 'aria-label': 'Previous page', title: 'Previous (←)', html: icons.chevronL, onclick: function () { go(-1); } });
    var nextBtn = el('button', { class: 'vid-v-nav next', type: 'button', 'aria-label': 'Next page', title: 'Next (→)', html: icons.chevronR, onclick: function () { go(1); } });

    var zoomOut = el('button', { class: 'vid-v-zbtn', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (−)', html: icons.zoomOut, onclick: function () { setZoom(zoom / 1.4); } });
    var zoomIn = el('button', { class: 'vid-v-zbtn', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', html: icons.zoomIn, onclick: function () { setZoom(zoom * 1.4); } });
    var zoomLabel = el('span', { class: 'vid-v-zlabel' }, ['100%']);
    var zoomReset = el('button', { class: 'vid-v-zbtn', type: 'button', 'aria-label': 'Reset zoom', title: 'Reset zoom (0)', html: icons.target, onclick: function () { setZoom(1, true); } });
    var fsBtn = el('button', { class: 'vid-v-zbtn', type: 'button', 'aria-label': 'Full screen', title: 'Full screen (F)', html: icons.expand, onclick: toggleFullscreen });
    var zoomBar = el('div', { class: 'vid-v-zoom' }, [zoomOut, zoomLabel, zoomIn, zoomReset, fsBtn]);

    var head = el('div', { class: 'vid-v-head' }, [
      el('div', { class: 'vid-v-headmain' }, [titleEl, subEl]),
      counter, closeBtn,
    ]);
    var side = el('div', { class: 'vid-v-side' }, [metaWrap, actionsWrap]);
    var main = el('div', { class: 'vid-v-main' }, [stage, prevBtn, nextBtn, zoomBar]);

    overlay.appendChild(el('div', { class: 'vid-v-shell' }, [head, el('div', { class: 'vid-v-body' }, [main, side])]));

    // ── zoom + pan ──
    var zoom = 1, panX = 0, panY = 0, media = null;
    function applyTransform() {
      if (!media) return;
      media.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      media.style.cursor = zoom > 1 ? 'grab' : 'default';
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
      zoomOut.disabled = zoom <= 0.35;
      zoomIn.disabled = zoom >= 8;
    }
    function setZoom(z, reset) {
      zoom = Math.max(0.35, Math.min(8, z));
      if (reset || zoom <= 1) { panX = 0; panY = 0; }
      applyTransform();
    }
    function toggleFullscreen() {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else overlay.requestFullscreen();
      } catch (e) { host.toast('Full screen is not available here'); }
    }

    // ── page rendering ──
    async function draw() {
      var page = pages[idx];
      var it = page.item, entry = page.entry;
      var s = VID.summarize(it);
      titleEl.textContent = s.title;
      subEl.textContent = s.typeLabel + (s.subtitleFull ? ' · ' + s.subtitleFull : '');
      counter.textContent = (idx + 1) + ' / ' + pages.length;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === pages.length - 1;
      zoom = 1; panX = 0; panY = 0;

      buildMeta(host, metaWrap, it);
      buildActions(host, actionsWrap, it, entry, {
        close: close,
        refresh: function () { close(); openViewer(host, it.id, 0); },
      });

      stage.innerHTML = '';
      if (!entry) {
        stage.appendChild(el('div', { class: 'vid-stage-empty' }, [
          el('span', { class: 'vid-stage-glyph', html: typeGlyph(s.type.id) }),
          el('div', {}, ['No files on this document yet.']),
          el('button', { class: 'vault-btn primary', style: 'width:auto;margin-top:10px', onclick: function () { close(); openEditor(it, host); } }, ['Add a scan or photo']),
        ]));
        zoomBar.style.display = 'none';
        return;
      }
      zoomBar.style.display = '';
      var att = entry.att;
      var skel = el('div', { class: 'vid-skel' });
      stage.appendChild(skel);
      var url;
      try { url = await VIF.objectUrl(att, host.session()); }
      catch (e) {
        skel.remove();
        stage.appendChild(el('div', { class: 'vid-stage-empty' }, [
          el('span', { class: 'vid-stage-glyph', html: icons.cloudOff }),
          el('div', {}, [att.pending
            ? 'This file has not finished uploading and is not cached on this device yet.'
            : 'Could not load this file. Check your connection and try again.']),
        ]));
        return;
      }
      // The page may have moved on while we were decrypting.
      if (pages[idx] !== page) { return; }
      skel.remove();
      if (VID.isImage(att)) {
        media = el('img', { class: 'vid-media', src: url, alt: att.name || 'Document scan', draggable: 'false' });
        stage.appendChild(media);
        bindPan(media);
      } else if (VID.isPdf(att)) {
        media = null;
        zoomBar.style.display = 'none';
        stage.appendChild(el('iframe', { class: 'vid-pdf', src: url, title: att.name || 'PDF document' }));
      } else {
        media = null;
        zoomBar.style.display = 'none';
        stage.appendChild(el('div', { class: 'vid-stage-empty' }, [
          el('span', { class: 'vid-stage-glyph', html: icons.file }),
          el('div', {}, [att.name || 'File']),
          el('button', { class: 'vault-btn', style: 'width:auto;margin-top:10px', onclick: function () { downloadAtt(host, att); } }, ['Download']),
        ]));
      }
      applyTransform();
    }

    // Pointer-events pan/zoom: one code path for mouse, touch and pen. A
    // one-finger drag at 100% is a SWIPE between pages; once zoomed in it pans,
    // because at that point the user is reading, not navigating.
    function bindPan(node) {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
      node.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button > 0) return;
        dragging = true; moved = 0; sx = e.clientX; sy = e.clientY; ox = panX; oy = panY;
        try { node.setPointerCapture(e.pointerId); } catch (_) {}
      });
      node.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        if (zoom > 1) { panX = ox + dx; panY = oy + dy; applyTransform(); }
      });
      function end(e) {
        if (!dragging) return;
        dragging = false;
        try { node.releasePointerCapture(e.pointerId); } catch (_) {}
        if (zoom <= 1 && Math.abs(e.clientX - sx) > SWIPE_MIN && Math.abs(e.clientY - sy) < SWIPE_MIN * 1.5) {
          go(e.clientX < sx ? 1 : -1);
        }
      }
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', function () { dragging = false; });
      node.addEventListener('dblclick', function () { setZoom(zoom > 1 ? 1 : 2.5, zoom > 1); });
    }
    stage.addEventListener('wheel', function (e) {
      if (!media) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });

    // Pinch-to-zoom on touch, tracked as a raw two-pointer gesture so it works
    // even where the browser hands us no gesture events.
    var pts = {};
    var pinchStart = 0, pinchZoom = 1;
    stage.addEventListener('pointerdown', function (e) { pts[e.pointerId] = e; if (Object.keys(pts).length === 2) { pinchStart = pinchDist(); pinchZoom = zoom; } });
    stage.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      pts[e.pointerId] = e;
      if (Object.keys(pts).length === 2 && pinchStart) { var d = pinchDist(); if (d) setZoom(pinchZoom * (d / pinchStart)); }
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function (e) { delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pinchStart = 0; });
    });
    function pinchDist() {
      var k = Object.keys(pts); if (k.length < 2) return 0;
      var a = pts[k[0]], b = pts[k[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    // Swipe on the stage itself, so a PDF or an empty document is navigable too.
    var tsx = 0, tsy = 0;
    stage.addEventListener('touchstart', function (e) { if (e.touches.length === 1) { tsx = e.touches[0].clientX; tsy = e.touches[0].clientY; } }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (zoom > 1 || !e.changedTouches.length || !tsx) return;
      var dx = e.changedTouches[0].clientX - tsx, dy = e.changedTouches[0].clientY - tsy;
      if (Math.abs(dx) > SWIPE_MIN && Math.abs(dy) < SWIPE_MIN * 1.5) go(dx < 0 ? 1 : -1);
      tsx = 0;
    }, { passive: true });

    function go(step) {
      var next = idx + step;
      if (next < 0 || next >= pages.length) return;
      idx = next; draw();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.4); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom / 1.4); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1, true); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === 'Tab') trapFocus(e, overlay);
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
      overlay.classList.add('closing');
      var done = function () { overlay.remove(); };
      if (prefersReducedMotion()) done(); else setTimeout(done, 160);
      try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (_) {}
    }

    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    draw();
    setTimeout(function () { closeBtn.focus(); }, 40);
  }

  // The metadata column inside the viewer: masked number with an eye, dates,
  // issuer, everything the type declares — read-only, copyable.
  function buildMeta(host, wrap, it) {
    var el = host.el;
    var type = VID.typeOf(it);
    var s = VID.summarize(it);
    wrap.innerHTML = '';

    var badge = s.badge ? el('span', {
      class: 'vid-badge ' + (s.expiryState === 'expired' ? 'bad' : s.expiryState === 'expiring' ? 'warn' : 'ok'),
    }, [s.badge]) : null;
    wrap.appendChild(el('div', { class: 'vid-v-metahead' }, [
      el('span', { class: 'vid-v-metaicon', html: typeGlyph(type.id) }),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { class: 'vid-v-metatype' }, [type.label]),
        s.expiration ? el('div', { class: 'vid-v-metaexp' }, ['Expires ' + s.expirationLabel]) : null,
      ]),
      badge,
    ]));

    type.fields.forEach(function (key) {
      if (key === 'title') return;
      var raw = it[key];
      if (!raw) return;
      var label = VID.fieldLabel(type, key);
      if (VID.isSecretField(key)) { wrap.appendChild(secretLine(host, label, String(raw))); return; }
      var value = VID.isDateField(key) ? VID.formatDate(raw) : String(raw);
      wrap.appendChild(el('div', { class: 'vid-v-line' }, [
        el('div', { class: 'vid-v-lmain' }, [
          el('span', { class: 'vault-acc-flabel' }, [label]),
          el('span', { class: 'vid-v-lval' + (VID.isLongField(key) ? ' long' : '') }, [value]),
        ]),
        host.iconBtn('Copy ' + label, host.icons.copy, function () { host.copyText(value, label + ' copied'); }),
      ]));
    });

    (Array.isArray(it.customFields) ? it.customFields : []).forEach(function (cf) {
      if (!cf || (!cf.label && !cf.value)) return;
      wrap.appendChild(el('div', { class: 'vid-v-line' }, [
        el('div', { class: 'vid-v-lmain' }, [
          el('span', { class: 'vault-acc-flabel' }, [cf.label || 'Field']),
          el('span', { class: 'vid-v-lval' }, [cf.value || '']),
        ]),
        host.iconBtn('Copy ' + (cf.label || 'value'), host.icons.copy, function () { host.copyText(cf.value || '', (cf.label || 'Value') + ' copied'); }),
      ]));
    });

    if (Array.isArray(it.tags) && it.tags.length) {
      wrap.appendChild(el('div', { class: 'vid-v-tags' }, it.tags.map(function (t) { return el('span', { class: 'vault-tag' }, [t]); })));
    }
  }

  // A masked value with an eye — and a timer, so a revealed number doesn't sit
  // on a screen someone walked away from.
  function secretLine(host, label, value) {
    var el = host.el;
    var shown = false, timer = null;
    var valEl = el('span', { class: 'vid-v-lval mono' }, [VID.maskNumber(value)]);
    var btn = el('button', {
      class: 'vault-icon', type: 'button', title: 'Reveal ' + label,
      'aria-label': 'Reveal ' + label, html: host.icons.eye,
    });
    function set(on) {
      shown = on;
      valEl.textContent = on ? value : VID.maskNumber(value);
      btn.innerHTML = on ? host.icons.eyeOff : host.icons.eye;
      btn.title = (on ? 'Hide ' : 'Reveal ') + label;
      btn.setAttribute('aria-label', btn.title);
      clearTimeout(timer);
      if (on) timer = setTimeout(function () { set(false); }, AUTO_REMASK_MS);
    }
    btn.addEventListener('click', function () { set(!shown); });
    return el('div', { class: 'vid-v-line' }, [
      el('div', { class: 'vid-v-lmain' }, [el('span', { class: 'vault-acc-flabel' }, [label]), valEl]),
      btn,
      host.iconBtn('Copy ' + label, host.icons.copy, function () { host.copyText(value, label + ' copied'); }),
    ]);
  }

  function buildActions(host, wrap, it, entry, ctl) {
    var el = host.el;
    wrap.innerHTML = '';
    var att = entry && entry.att;

    function btn(label, icon, fn, cls) {
      return el('button', { class: 'vid-v-act' + (cls ? ' ' + cls : ''), type: 'button', html: icon + '<span>' + label + '</span>', onclick: fn });
    }

    if (att) {
      wrap.appendChild(btn('Open Full Size', icons.expand, async function () {
        try {
          var url = await VIF.objectUrl(att, host.session());
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (e) { host.toast('Could not open that file'); }
      }));
      wrap.appendChild(btn('Replace', icons.swap, function () { ctl.close(); openEditor(it, host); }));
      wrap.appendChild(btn('Download', icons.download, function () { downloadAtt(host, att); }));
    }
    wrap.appendChild(btn('Edit', icons.pencil, function () { ctl.close(); openEditor(it, host); }));
    if (att) {
      wrap.appendChild(btn('Delete file', icons.trash, async function () {
        if (!(await host.confirmUI('Delete this file from the document? This cannot be undone.', { title: 'Delete file', okLabel: 'Delete', danger: true }))) return;
        if (!(await host.verifyIdentity('delete this document file'))) return;
        var patch = {};
        if (entry.slot === 'attachments') {
          var list = (it.attachments || []).slice(); list.splice(entry.index, 1); patch.attachments = list;
        } else patch[entry.slot] = null;
        await save(host, it, patch);
        VIF.remove(att);
        host.toast('File deleted');
        host.refreshList(KIND);
        ctl.close();
      }, 'danger'));
    }
    wrap.appendChild(btn('Delete document', icons.trash, function () {
      deleteDoc(host, it, function () { ctl.close(); });
    }, 'danger'));
  }

  async function downloadAtt(host, att) {
    try {
      var blob = await VIF.blobFor(att, host.session());
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = att.name || 'document';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      host.toast('Downloaded');
    } catch (e) { host.toast('Could not download that file'); }
  }

  // ── modal scaffold ────────────────────────────────────────────────────────
  // A thin wrapper over Vault's own .vault-overlay/.vault-modal so this tab's
  // dialogs are the SAME object as every other dialog in the app — plus the
  // focus trap and Esc handling a document dialog needs.
  function openModal(host, opts) {
    var el = host.el;
    var lastFocus = document.activeElement;
    var overlay = el('div', { class: 'vault-overlay' });   // no backdrop-close — avoids losing in-progress edits
    var body = el('div', { class: 'vault-modal' + (opts.wide ? ' vid-modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', onclick: function (e) { e.stopPropagation(); } });
    body.appendChild(el('div', { class: 'vault-modal-title' }, [opts.title]));
    if (opts.sub) body.appendChild(el('p', { class: 'vault-sub', style: 'text-align:left' }, [opts.sub]));
    var actionsRow = el('div', { class: 'vault-modal-actions' });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') trapFocus(e, body);
    }
    function close(skipCallback) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (!skipCallback && opts.onClose) { try { opts.onClose(); } catch (_) {} }
      try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (_) {}
    }
    return {
      body: body,
      close: close,
      actions: function (kids) { kids.forEach(function (k) { if (k) actionsRow.appendChild(k); }); },
      mount: function () {
        body.appendChild(actionsRow);
        overlay.appendChild(body);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey, true);
      },
    };
  }

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapFocus(e, root) {
    var nodes = Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ── lock teardown ─────────────────────────────────────────────────────────
  // Called by the shell whenever the vault locks. Every decrypted object URL is
  // revoked, so nothing readable outlives the session.
  function reset() {
    try { if (VIF) VIF.revokeAll(); } catch (e) {}
    document.querySelectorAll('.vid-viewer').forEach(function (n) { n.remove(); });
    clearTimeout(_retryTimer); _retryTimer = null;
  }

  // ── icons (matching vault-ui.js's stroke style) ───────────────────────────
  function I(body, w) {
    return '<svg width="' + (w || 15) + '" height="' + (w || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var icons = {
    plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>', 17),
    pencil: I('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
    trash: I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    download: I('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    upload: I('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 20),
    swap: I('<path d="M17 2l4 4-4 4"/><path d="M3 6h18"/><path d="M7 22l-4-4 4-4"/><path d="M21 18H3"/>'),
    expand: I('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
    x: I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 18),
    chevronL: I('<path d="m15 18-6-6 6-6"/>', 22),
    chevronR: I('<path d="m9 18 6-6-6-6"/>', 22),
    zoomIn: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
    zoomOut: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>'),
    target: I('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>'),
    camera: I('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
    folder: I('<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/>'),
    file: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 22),
    pdf: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 15h1.5a1.5 1.5 0 0 0 0-3H8v6"/><path d="M14 18v-6h1.5a2 2 0 0 1 0 6z"/>', 22),
    paperclip: I('<path d="M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"/>', 13),
    cloudOff: I('<path d="M18.6 18.6A5 5 0 0 0 18 9h-1.3A8 8 0 0 0 6.3 6.3"/><path d="M4.2 8.2A8 8 0 0 0 8 21h10"/><path d="m2 2 20 20"/>'),
  };

  // Per-type glyphs. A licence should not look like a passport at a glance.
  var GLYPHS = {
    drivers_license: I('<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16.5c.6-1.4 1.8-2 3-2s2.4.6 3 2"/><path d="M14 10h5"/><path d="M14 13.5h5"/>', 22),
    passport: I('<path d="M5 3h11a3 3 0 0 1 3 3v15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><circle cx="11.5" cy="10" r="3"/><path d="M8.5 10h6"/><path d="M11.5 7a6 6 0 0 1 0 6"/><path d="M11.5 7a6 6 0 0 0 0 6"/><path d="M9 17h5"/>', 22),
    state_id: I('<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8.5" cy="10.5" r="2.2"/><path d="M5 16c.7-1.5 2-2.2 3.5-2.2S11.3 14.5 12 16"/><path d="M15 9h4"/><path d="M15 12.5h4"/><path d="M15 16h2.5"/>', 22),
    ssn_card: I('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 10h6"/><path d="M6 14h12"/><path d="M15 9.5h3"/>', 22),
    birth_certificate: I('<path d="M6 2h9l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M15 2v4h4"/><path d="M8 11h7"/><path d="M8 14.5h7"/><circle cx="15.5" cy="18" r="2"/>', 22),
    vehicle_registration: I('<path d="M4 16h16"/><path d="m5 16-1-4.5A2 2 0 0 1 6 9h12a2 2 0 0 1 2 2.5L19 16"/><path d="M6.5 9 8 5.5A2 2 0 0 1 9.8 4h4.4A2 2 0 0 1 16 5.5L17.5 9"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/>', 22),
    insurance_card: I('<path d="M12 21s7-3.6 7-9V5.5L12 3 5 5.5V12c0 5.4 7 9 7 9Z"/><path d="M12 8.5v6"/><path d="M9 11.5h6"/>', 22),
    student_id: I('<path d="m3 8 9-4 9 4-9 4Z"/><path d="M7 10.5V15c0 1.7 2.2 3 5 3s5-1.3 5-3v-4.5"/><path d="M21 8v5"/>', 22),
    work_id: I('<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M8 13h8"/><path d="M8 16.5h5"/>', 22),
    custom: I('<path d="M6 2h9l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M15 2v4h4"/><path d="M8 12h8"/><path d="M8 16h5"/>', 22),
  };
  function typeGlyph(typeId) { return GLYPHS[typeId] || GLYPHS.custom; }

  // ── styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('vault-id-styles')) return;
    var css = [
      // ── the big primary CTA ──
      '.vid-add{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;background:transparent;',
      '  border:1px solid var(--acl,rgba(224,184,116,.36));color:var(--acs,#e0b874);border-radius:var(--radius);',
      '  padding:16px;font-size:14px;font-weight:500;letter-spacing:.4px;font-family:inherit;cursor:pointer;',
      '  margin-bottom:14px;transition:border-color .18s,background .18s,transform .12s}',
      '.vid-add:hover{border-color:var(--ac);background:rgba(224,184,116,.05)}',
      '.vid-add:active{transform:translateY(1px)}',
      '.vid-add:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-add svg{display:block;flex-shrink:0}',
      // ── filter chips + sort ──
      '.vid-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
      '.vid-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0}',
      '.vid-chip{background:transparent;border:1px solid var(--bd);color:var(--txd);font-size:11px;font-weight:500;',
      '  letter-spacing:.6px;padding:0 11px;height:30px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;',
      '  white-space:nowrap;transition:border-color .18s,color .18s}',
      '.vid-chip:hover{color:var(--tx);border-color:var(--txd)}',
      '.vid-chip.active{color:var(--acs,#e0b874);border-color:var(--ac)}',
      '.vid-chip:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-sort-wrap{display:flex;align-items:center;gap:7px;flex-shrink:0}',
      '.vid-sort-label{font-size:9.5px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px}',
      '.vid-sort{background:var(--s1);border:1px solid var(--bd);color:var(--txd);border-radius:var(--radius-sm);',
      '  height:30px;padding:0 8px;font-size:12px;font-family:inherit;cursor:pointer;outline:none}',
      '.vid-sort:focus{border-color:var(--ac)}',
      '.vid-count{font-size:11px;color:var(--txm);flex-shrink:0;font-variant-numeric:tabular-nums}',
      // ── pending-upload banner ──
      '.vid-banner{display:flex;align-items:center;gap:11px;background:var(--s1);border:1px solid rgba(224,184,116,.3);',
      '  border-radius:var(--radius);padding:11px 13px;margin-bottom:12px}',
      '.vid-banner-icon{color:var(--ac);line-height:0;flex-shrink:0}',
      '.vid-banner-text{flex:1;min-width:0;font-size:12px;color:var(--txd);line-height:1.55}',
      '.vid-banner-btn{background:transparent;border:1px solid var(--bd);color:var(--txd);border-radius:var(--radius-sm);',
      '  height:30px;padding:0 12px;font-size:11px;font-family:inherit;cursor:pointer;flex-shrink:0}',
      '.vid-banner-btn:hover{border-color:var(--ac);color:var(--acs,#e0b874)}',
      // ── the card grid ──
      '.vid-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
      '.vid-card{position:relative;background:var(--s1);border:1px solid var(--bd);border-radius:var(--radius);',
      '  overflow:hidden;cursor:pointer;display:flex;flex-direction:column;',
      '  transition:border-color .18s,transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .18s}',
      '.vid-card:hover{border-color:var(--acl,rgba(224,184,116,.36));transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.4)}',
      '.vid-card:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-card.expired .vid-card-title{opacity:.72}',
      // Media band: the thumbnail is blurred until the document is opened.
      '.vid-card-media{position:relative;height:104px;background:var(--s2);overflow:hidden;display:flex;align-items:center;justify-content:center}',
      '.vid-thumb{width:100%;height:100%;object-fit:cover;filter:blur(9px) saturate(.85);transform:scale(1.15);display:block}',
      '.vid-thumb-veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(26,26,29,.35),rgba(26,26,29,.72))}',
      '.vid-thumb-glyph,.vid-card-glyph{position:relative;color:var(--ac);opacity:.9;line-height:0}',
      '.vid-thumb-glyph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}',
      '.vid-card-media.empty{background:linear-gradient(135deg,var(--s2),var(--s1))}',
      '.vid-card-media.empty .vid-card-glyph{opacity:.55}',
      '.vid-card-meta{padding:11px 13px 6px;flex:1;min-width:0}',
      '.vid-card-type{font-size:9.5px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px}',
      '.vid-card-title{font-size:14.5px;font-weight:500;color:var(--tx);margin-top:3px;line-height:1.3;',
      '  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.vid-card-sub{font-size:12px;color:var(--txd);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vid-card-exp{margin-top:8px;display:flex;flex-direction:column;gap:1px}',
      '.vid-card-exp-label{font-size:9.5px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px}',
      '.vid-card-exp-val{font-size:12.5px;color:var(--tx);font-variant-numeric:tabular-nums}',
      // min-height keeps the footer baseline identical whether or not the card
      // has an expiry badge, so a mixed grid doesn't look ragged along the bottom.
      '.vid-card-foot{display:flex;align-items:center;gap:8px;padding:8px 13px 11px;min-height:39px}',
      '.vid-card-files{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--txd);margin-left:auto}',
      '.vid-card-files.muted{color:var(--txm)}.vid-card-files-icon{line-height:0}',
      '.vid-card-pending{color:var(--ac);line-height:0}',
      '.vid-card-edit{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:var(--radius-sm);',
      '  background:rgba(26,26,29,.72);border:1px solid var(--bd);color:var(--txd);cursor:pointer;display:inline-flex;',
      '  align-items:center;justify-content:center;opacity:0;transition:opacity .18s,border-color .18s,color .18s}',
      '.vid-card:hover .vid-card-edit,.vid-card:focus-within .vid-card-edit{opacity:1}',
      '.vid-card-edit:hover{color:var(--acs,#e0b874);border-color:var(--ac)}',
      '.vid-card-edit:focus-visible{opacity:1;outline:2px solid var(--ac);outline-offset:1px}',
      // ── badges ──
      '.vid-badge{font-size:10.5px;font-weight:500;letter-spacing:.2px;padding:3px 9px;border-radius:5px;',
      '  flex-shrink:0;white-space:nowrap;border:1px solid transparent}',
      '.vid-badge.ok{border-color:rgba(164,185,134,.42);color:#a4b986}',
      '.vid-badge.warn{border-color:rgba(224,184,116,.42);color:#e0b874}',
      '.vid-badge.bad{border-color:rgba(214,138,124,.5);color:#d68a7c}',
      // ── type picker ──
      '.vid-modal-wide{width:620px}',
      '.vid-typegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:9px;margin-bottom:6px}',
      '.vid-typetile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;',
      '  background:var(--s2);border:1px solid var(--bd);color:var(--tx);border-radius:var(--radius);padding:18px 10px;',
      '  font-size:12.5px;font-weight:500;font-family:inherit;cursor:pointer;text-align:center;',
      '  transition:border-color .18s,transform .14s,color .18s}',
      '.vid-typetile:hover{border-color:var(--ac);color:var(--acs,#e0b874);transform:translateY(-2px)}',
      '.vid-typetile:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-typetile-icon{color:var(--ac);line-height:0}',
      '.vid-typetile-label{line-height:1.3}',
      // ── editor: sections, upload zones, tiles, progress ──
      '.vid-sec{font-size:11px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px;',
      '  margin:18px 0 10px;padding-top:12px;border-top:1px solid var(--bd)}',
      '.vid-uploads{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.vid-slot{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.vid-slot-wide{grid-column:1/-1}',
      '.vid-slot-label{font-size:10px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px}',
      '.vid-zone{border:1.5px dashed var(--bd);border-radius:var(--radius);padding:16px 12px;text-align:center;',
      '  cursor:pointer;color:var(--txm);display:flex;flex-direction:column;align-items:center;gap:8px;',
      '  transition:border-color .18s,color .18s,background .18s}',
      '.vid-zone:hover,.vid-zone.over{border-color:var(--ac);color:var(--acs,#e0b874);background:rgba(224,184,116,.04)}',
      '.vid-zone:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-zone-icon{line-height:0;color:inherit}',
      '.vid-zone-text{font-size:11.5px;line-height:1.4}',
      '.vid-zone-btns{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}',
      '.vid-zone-btn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--bd);',
      '  color:var(--txd);border-radius:var(--radius-sm);height:30px;padding:0 10px;font-size:11px;font-family:inherit;cursor:pointer}',
      '.vid-zone-btn:hover{border-color:var(--ac);color:var(--acs,#e0b874)}',
      '.vid-zone-btn svg{width:13px;height:13px;display:block}',
      '.vid-attlist{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}',
      '.vid-tile{display:flex;align-items:center;gap:10px;background:var(--s2);border:1px solid var(--bd);',
      '  border-radius:var(--radius-sm);padding:8px 10px}',
      '.vid-tile-img{position:relative;width:46px;height:34px;border-radius:5px;overflow:hidden;flex-shrink:0;background:var(--s3);',
      '  display:flex;align-items:center;justify-content:center;color:var(--txd)}',
      '.vid-tile-img img{width:100%;height:100%;object-fit:cover;filter:blur(5px);transform:scale(1.2)}',
      '.vid-tile-main{flex:1;min-width:0}',
      '.vid-tile-name{font-size:12.5px;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vid-tile-sub{font-size:10.5px;color:var(--txm);margin-top:2px}',
      '.vid-tile-btns{display:flex;gap:4px;flex-shrink:0}',
      '.vid-prog{background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius-sm);padding:9px 11px;',
      '  margin-top:8px;grid-column:1/-1}',
      '.vid-prog-top{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--txd);margin-bottom:6px}',
      '.vid-prog-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.vid-prog-size{flex-shrink:0;color:var(--txm)}',
      '.vid-prog-track{height:4px;background:var(--s3);border-radius:3px;overflow:hidden}',
      '.vid-prog-fill{height:100%;width:0;background:var(--ac);transition:width .25s ease}',
      '.vid-prog-stage{display:block;font-size:10.5px;color:var(--txm);margin-top:5px}',
      '.vid-warn{font-size:11.5px;color:#e0b874;min-height:15px;margin:4px 0;line-height:1.5}',
      '.vid-warn.bad{color:#d68a7c}',
      '.vid-status{font-size:11px;color:var(--txm);min-height:14px;margin-bottom:4px}',
      '.vid-status.ok{color:#a4b986}.vid-status.bad{color:#d68a7c}',
      // ── viewer ──
      '@keyframes vid-in{from{opacity:0}to{opacity:1}}',
      '@keyframes vid-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}',
      // No backdrop-filter here, unlike the modals: this surface already covers
      // the viewport at 96% opacity, so a blur would buy nothing visually while
      // forcing a full-screen backdrop layer to be re-rastered on every zoom and
      // pan frame — the one place in Vault where that cost is actually paid.
      '.vid-viewer{position:fixed;inset:0;z-index:99999;background:rgba(12,12,14,.96);display:flex;animation:vid-in .18s ease}',
      '.vid-viewer.closing{opacity:0;transition:opacity .16s ease}',
      '.vid-viewer.noanim{animation:none}',
      '.vid-v-shell{flex:1;display:flex;flex-direction:column;min-width:0;animation:vid-pop .2s cubic-bezier(.2,.7,.3,1);',
      '  padding:max(10px,env(safe-area-inset-top,0px)) max(10px,env(safe-area-inset-right,0px)) max(10px,env(safe-area-inset-bottom,0px)) max(10px,env(safe-area-inset-left,0px))}',
      '.vid-viewer.noanim .vid-v-shell{animation:none}',
      '.vid-v-head{display:flex;align-items:center;gap:12px;padding:6px 4px 10px;flex-shrink:0}',
      '.vid-v-headmain{flex:1;min-width:0}',
      '.vid-v-title{font-family:var(--display,inherit);font-size:17px;font-weight:600;color:var(--tx);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vid-v-sub{font-size:11.5px;color:var(--txd);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vid-v-counter{font-size:11.5px;color:var(--txm);font-variant-numeric:tabular-nums;flex-shrink:0}',
      '.vid-v-close{width:36px;height:36px;border-radius:var(--radius-sm);background:transparent;border:1px solid var(--bd);',
      '  color:var(--txd);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.vid-v-close:hover{color:var(--tx);border-color:var(--txd)}',
      '.vid-v-close:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-v-body{flex:1;display:flex;gap:12px;min-height:0}',
      '.vid-v-main{position:relative;flex:1;min-width:0;background:var(--s1);border:1px solid var(--bd);',
      '  border-radius:var(--radius);overflow:hidden;display:flex}',
      '.vid-stage{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;overflow:hidden;',
      '  touch-action:none;position:relative}',
      '.vid-media{max-width:100%;max-height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;',
      '  transform-origin:center center;transition:transform .12s ease-out;will-change:transform}',
      '.vid-viewer.noanim .vid-media{transition:none}',
      '.vid-pdf{width:100%;height:100%;border:0;background:#fff}',
      '.vid-stage-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--txd);font-size:13px;',
      '  text-align:center;padding:30px;line-height:1.6}',
      '.vid-stage-glyph{color:var(--ac);opacity:.6;line-height:0}',
      '@keyframes vid-shimmer{0%{background-position:-320px 0}100%{background-position:320px 0}}',
      '.vid-skel{width:min(70%,420px);height:min(60%,300px);border-radius:var(--radius);',
      '  background:linear-gradient(90deg,var(--s2) 25%,var(--s3) 50%,var(--s2) 75%);background-size:640px 100%;',
      '  animation:vid-shimmer 1.2s linear infinite}',
      '.vid-v-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:64px;border-radius:var(--radius);',
      '  background:rgba(26,26,29,.72);border:1px solid var(--bd);color:var(--txd);cursor:pointer;display:inline-flex;',
      '  align-items:center;justify-content:center;transition:opacity .18s,color .18s,border-color .18s}',
      '.vid-v-nav.prev{left:10px}.vid-v-nav.next{right:10px}',
      '.vid-v-nav:hover:not(:disabled){color:var(--acs,#e0b874);border-color:var(--ac)}',
      '.vid-v-nav:disabled{opacity:.22;cursor:default}',
      '.vid-v-nav:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-v-zoom{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;',
      '  background:rgba(26,26,29,.86);border:1px solid var(--bd);border-radius:var(--radius);padding:4px 6px}',
      '.vid-v-zbtn{width:32px;height:32px;border-radius:var(--radius-sm);background:transparent;border:none;color:var(--txd);',
      '  cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
      '.vid-v-zbtn:hover:not(:disabled){color:var(--acs,#e0b874)}.vid-v-zbtn:disabled{opacity:.3;cursor:default}',
      '.vid-v-zbtn:focus-visible{outline:2px solid var(--ac);outline-offset:1px}',
      '.vid-v-zlabel{font-size:11px;color:var(--txd);min-width:42px;text-align:center;font-variant-numeric:tabular-nums}',
      '.vid-v-side{width:308px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;',
      '  overscroll-behavior:contain;padding-right:2px}',
      '.vid-v-meta{background:var(--s1);border:1px solid var(--bd);border-radius:var(--radius);padding:12px}',
      '.vid-v-metahead{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:6px;border-bottom:1px solid var(--bd)}',
      '.vid-v-metaicon{color:var(--ac);line-height:0;flex-shrink:0}',
      '.vid-v-metatype{font-size:12.5px;font-weight:500;color:var(--tx)}',
      '.vid-v-metaexp{font-size:11px;color:var(--txd);margin-top:2px}',
      '.vid-v-line{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--bd)}',
      '.vid-v-line:first-of-type{border-top:none}',
      '.vid-v-lmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.vid-v-lval{font-size:13px;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.vid-v-lval.mono{font-family:ui-monospace,monospace;letter-spacing:.5px}',
      '.vid-v-lval.long{white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--txd);line-height:1.6}',
      '.vid-v-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}',
      '.vid-v-actions{display:flex;flex-direction:column;gap:6px}',
      '.vid-v-act{display:flex;align-items:center;gap:9px;background:var(--s1);border:1px solid var(--bd);color:var(--tx);',
      '  border-radius:var(--radius-sm);padding:11px 13px;font-size:12.5px;font-weight:500;font-family:inherit;cursor:pointer;',
      '  text-align:left;transition:border-color .18s,color .18s}',
      '.vid-v-act:hover{border-color:var(--ac);color:var(--acs,#e0b874)}',
      '.vid-v-act:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
      '.vid-v-act.danger{color:#d68a7c}.vid-v-act.danger:hover{border-color:#d68a7c;color:#d68a7c}',
      '.vid-v-act svg{flex-shrink:0}',
      // ── responsive: the same device ladder the rest of Vault uses ──
      '@media (max-width:1024px){',
      '  .vid-v-side{width:264px}',
      '  .vid-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}',
      '}',
      '@media (max-width:860px){',
      // Below this the side column is narrower than its own labels, so the
      // viewer becomes a single scrolling column: stage on top, details below.
      '  .vid-v-body{flex-direction:column;overflow-y:auto;overscroll-behavior:contain}',
      '  .vid-v-main{min-height:min(56vh,420px);flex:0 0 auto}',
      '  .vid-v-side{width:100%;overflow:visible}',
      '}',
      '@media (max-width:640px){',
      // Six wrapped chips would eat half a phone screen before the first card.
      // They scroll in one row instead — exactly what .vault-tabs does above.
      '  .vid-chips{flex:1 0 100%;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;',
      '    scrollbar-width:none;padding-bottom:2px}',
      '  .vid-chips::-webkit-scrollbar{display:none}',
      '  .vid-chip{flex:0 0 auto}',
      '  .vid-controls{margin-bottom:12px}',
      '  .vid-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
      '  .vid-card-media{height:82px}',
      '  .vid-card-title{font-size:13.5px}',
      '  .vid-card-meta{padding:10px 11px 5px}',
      '  .vid-card-foot{padding:7px 11px 10px}',
      '  .vid-card-edit{opacity:1}',           // no hover on touch — always show it
      '  .vid-uploads{grid-template-columns:1fr}',
      '  .vid-typegrid{grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px}',
      '  .vid-typetile{padding:14px 8px;font-size:12px}',
      '  .vid-controls{gap:8px}',
      '  .vid-count{display:none}',
      '  .vid-sort-wrap{margin-left:auto}',
      '  .vid-add{padding:15px;font-size:13.5px}',
      '  .vid-v-title{font-size:15px}',
      '  .vid-v-nav{width:38px;height:54px}',
      '  .vid-v-act{padding:13px}',
      '  .vid-banner{flex-wrap:wrap}',
      '  .vid-banner-btn{width:100%}',
      '}',
      '@media (max-width:380px){',
      '  .vid-grid{grid-template-columns:1fr}',
      '  .vid-card-media{height:92px}',
      '  .vid-typegrid{grid-template-columns:1fr 1fr}',
      '  .vid-v-zlabel{display:none}',
      '}',
      // Touch: ≥38px targets, and the hover-only affordances stop hiding.
      '@media (pointer:coarse){',
      '  .vid-chip{height:38px;padding:0 14px}',
      '  .vid-sort{height:38px}',
      '  .vid-zone{padding:20px 12px}',
      '  .vid-zone-btn{height:38px;padding:0 14px}',
      '  .vid-card-edit{width:38px;height:38px;opacity:1}',
      '  .vid-v-close{width:42px;height:42px}',
      '  .vid-v-zbtn{width:38px;height:38px}',
      '  .vid-banner-btn{height:38px}',
      '  .vid-card:hover{transform:none;box-shadow:none}',
      '  .vid-typetile:hover{transform:none}',
      '}',
      // Motion: everything above is decoration, so it all goes at once.
      '@media (prefers-reduced-motion:reduce){',
      '  .vid-card,.vid-typetile,.vid-media,.vid-prog-fill{transition:none}',
      '  .vid-card:hover,.vid-typetile:hover{transform:none}',
      '  .vid-skel{animation:none}',
      '  .vid-viewer,.vid-v-shell{animation:none}',
      '}',
      // High contrast / forced colours: keep every boundary visible when the OS
      // throws our palette away.
      '@media (forced-colors:active){',
      '  .vid-card,.vid-chip,.vid-zone,.vid-tile,.vid-v-act,.vid-badge{border:1px solid CanvasText}',
      '  .vid-thumb-veil{display:none}',
      '}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'vault-id-styles';
    s.innerHTML = css;
    document.head.appendChild(s);
  }

  window.VaultIdUI = {
    KIND: KIND,
    render: render, fillList: fillList,
    openEditor: openEditor, openTypePicker: openTypePicker, openViewer: openViewer,
    reset: reset, typeGlyph: typeGlyph,
    // test/debug hooks
    _state: function () { return { sort: _sort, filter: _filter }; },
    _setState: function (s) { if (s.sort) _sort = s.sort; if (s.filter) _filter = s.filter; },
  };
})();
