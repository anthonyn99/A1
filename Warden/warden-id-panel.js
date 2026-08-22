// ─────────────────────────────────────────────────────────────────────────────
// warden-id-panel.js — Warden extension · ID Docs panel UI (popup)
//
// The identity-document twin of warden-pay-panel.js. Same data layer
// (warden-pw-core.js), same unlocked session, same 30-minute idle window —
// unlocking on any tab unlocks this one too, because there is only ONE warden.
//
// ── What you can do here ────────────────────────────────────────────────────
//   Fill      write the document's number / state / country / dates into the
//             page you're on (a rental form, a visa application, an I-9).
//   Attach    drop the actual SCAN into a page's "upload your ID" field — the
//             reason for carrying documents in a browser at all.
//   Save      download the scan to this computer.
//   Copy      the document number, to paste anywhere.
//
// ── What's stricter here than for passwords ─────────────────────────────────
// Document numbers render masked (••••••4321). Revealing, copying or filling
// the number of a SENSITIVE document — a Social Security card — requires a
// FRESH credential check (WardenPWCore.authFresh()): a master password or
// biometric presented in the last 5 minutes, exactly as a card's CVV does.
// A driver's licence number fills on an unlocked session, because being asked
// for it on a rental form is routine.
//
// Revealed numbers re-mask themselves, and copied numbers are wiped from the
// clipboard after 30 seconds.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const VP = self.WardenPWCore;
  const VID = self.WardenId;
  let panel = null;
  let revealed = {};
  const REVEAL_MS = 30000;       // auto re-mask a revealed number after 30s
  const MAX_ATTACH_BYTES = 12 * 1024 * 1024; // sane ceiling for a runtime message

  function el(tag, attrs, kids) {
    const e = document.createElement(tag); attrs = attrs || {};
    for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k === "style") e.style.cssText = attrs[k];
      else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => { if (c == null) return; e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function toast(msg) {
    const t = document.getElementById("toast"); if (!t) return;
    t.textContent = msg; t.style.opacity = "1"; t.style.transform = "translateX(-50%) translateY(0)";
    setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)"; }, 1900);
  }
  function copySecret(v, label) {
    VP.touchSession();
    navigator.clipboard.writeText(v || "").then(() => {
      toast(label + " copied — clears in 30s");
      setTimeout(() => {
        navigator.clipboard.readText().then((cur) => { if (cur === v) navigator.clipboard.writeText(""); }).catch(() => {});
      }, 30000);
    }).catch(() => toast("Copy failed"));
  }
  function broadcastLockState(unlocked) {
    try {
      chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((t) => { if (t && t.id != null) { try { chrome.tabs.sendMessage(t.id, { action: "wardenLockChanged", unlocked }, () => void chrome.runtime.lastError); } catch (e) {} } });
      });
    } catch (e) {}
  }
  function clear() { panel.innerHTML = ""; revealed = {}; }

  // ── entry point ────────────────────────────────────────────────────────────
  async function render() {
    panel = document.getElementById("panel-iddocs");
    if (!panel) return;
    if (typeof WardenCrypto === "undefined" || !VP || !VID) {
      clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["ID Docs module not loaded."])); return;
    }
    let has;
    try { has = await VP.hasWarden(); }
    catch (e) { clear(); panel.appendChild(el("div", { class: "pw-msg err" }, ["Couldn't reach Warden.", el("br"), "Check your connection."])); return; }
    if (!has) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["No vault yet. Set one up in the Warden app first."])); return; }
    if (!VP.isUnlocked()) { try { await VP.restoreSession(); } catch (e) {} }
    if (!VP.isUnlocked()) return renderUnlock();
    return renderList();
  }

  // ── unlock (identical flow to the other tabs — one warden, one session) ─────
  async function renderUnlock() {
    clear();
    const pwIn = el("input", { type: "password", class: "pw-input", placeholder: "Master password", autocomplete: "current-password" });
    const err = el("div", { class: "pw-err" });
    const btn = el("button", { class: "pw-btn primary" }, ["Unlock"]);
    async function go() {
      err.textContent = ""; btn.disabled = true; btn.textContent = "Unlocking…";
      try { await VP.unlock(pwIn.value); broadcastLockState(true); renderList(); }
      catch (e) { err.textContent = e.message === "bad-password" ? "Incorrect master password." : ("Error: " + e.message); btn.disabled = false; btn.textContent = "Unlock"; }
    }
    btn.addEventListener("click", go);
    pwIn.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

    const kids = [pwIn, err, btn];
    let hasBio = false;
    try { hasBio = await VP.biometricAvailable(); } catch (e) {}
    if (hasBio) {
      const link = await VP.getBioLink();
      const label = VP.biometricLabel(link);
      const bioBtn = el("button", { class: "pw-btn", html: (window.WardenIcons || {}).unlock + "<span>Unlock with " + label + "</span>" });
      bioBtn.addEventListener("click", async () => {
        err.textContent = "";
        try { await VP.unlockWithBiometric(); broadcastLockState(true); renderList(); }
        catch (e) { if (e.message !== "cancelled") err.textContent = label + " unlock failed — use your password."; }
      });
      kids.splice(2, 0, bioBtn);
    }
    panel.appendChild(el("div", { class: "pw-lock" }, [
      el("div", { class: "pw-lock-icon", html: idIcon() }),
      el("div", { class: "pw-lock-title" }, ["Warden is locked"]),
      el("div", { class: "pw-lock-sub" }, ["Unlock to view, fill and download your ID documents. Stays unlocked for 30 min of activity."]),
      ...kids,
    ]));
    setTimeout(() => pwIn.focus(), 60);
  }

  // ── step-up auth (shared shape with the Payments panel) ───────────────────
  function stepUp(reason) {
    if (VP.authFresh()) return Promise.resolve(true);
    return new Promise(async (resolve) => {
      const overlay = el("div", { class: "pay-overlay" });
      const done = (v) => { overlay.remove(); resolve(v); };
      const pwIn = el("input", { type: "password", class: "pw-input", placeholder: "Master password", autocomplete: "current-password" });
      const err = el("div", { class: "pw-err" });
      const ok = el("button", { class: "pw-btn primary" }, ["Confirm"]);
      async function go() {
        if (!pwIn.value) { err.textContent = "Required"; return; }
        ok.disabled = true; ok.textContent = "Checking…";
        try { await VP.reauth(pwIn.value); done(true); }
        catch (e) { err.textContent = "Incorrect master password."; ok.disabled = false; ok.textContent = "Confirm"; }
      }
      ok.addEventListener("click", go);
      pwIn.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

      const kids = [
        el("div", { class: "pay-modal-title" }, ["Confirm it's you"]),
        el("div", { class: "pw-lock-sub", style: "margin-bottom:10px" }, ["Verify to " + reason + "."]),
      ];
      let hasBio = false;
      try { hasBio = await VP.biometricAvailable(); } catch (e) {}
      if (hasBio) {
        const label = VP.biometricLabel(await VP.getBioLink());
        const bioBtn = el("button", { class: "pw-btn", html: (window.WardenIcons || {}).unlock + "<span>Use " + label + "</span>" });
        bioBtn.addEventListener("click", async () => {
          err.textContent = "";
          try { await VP.unlockWithBiometric(); done(true); }
          catch (e) { if (e.message !== "cancelled") err.textContent = label + " check failed — use your password."; }
        });
        kids.push(bioBtn);
      }
      kids.push(pwIn, err, el("div", { class: "pay-modal-actions" }, [ok, el("button", { class: "pw-btn", onclick: () => done(false) }, ["Cancel"])]));
      overlay.appendChild(el("div", { class: "pay-modal" }, kids));
      document.body.appendChild(overlay);
      setTimeout(() => pwIn.focus(), 50);
    });
  }

  // ── list ───────────────────────────────────────────────────────────────────
  async function renderList() {
    clear();
    let docs;
    try { docs = await VP.idDocs(); } catch (e) { return renderUnlock(); }
    VP.touchSession();

    const search = el("input", { class: "pw-search", placeholder: "Search ID documents…" });
    const listWrap = el("div", { class: "pw-list" });
    const lockBtn = el("button", { class: "pw-icon", title: "Lock now", html: (window.WardenIcons || {}).lock, onclick: async () => { await VP.lock(); broadcastLockState(false); renderUnlock(); } });
    panel.appendChild(el("div", { class: "pw-toolbar" }, [search, lockBtn]));
    panel.appendChild(listWrap);

    function matches(d, q) {
      if (!q) return true;
      q = q.toLowerCase();
      const s = VID.summarize(d);
      return [s.title, s.typeLabel, d.issuer, d.region, d.country, d.notes, d.description,
        VID.yearOf(d.expirationDate)].some((v) => String(v || "").toLowerCase().includes(q)) ||
        // Partial document number, 3+ chars — same floor the web app's search uses.
        (q.length >= 3 && String(d.number || "").toLowerCase().includes(q));
    }
    function draw(q) {
      listWrap.innerHTML = "";
      const list = docs.filter((d) => matches(d, q));
      if (!list.length) {
        listWrap.appendChild(el("div", { class: "pw-msg" }, [q ? "No matches." : "No ID documents yet. Add one in the Warden app → ID Docs."]));
        return;
      }
      list.forEach((d) => listWrap.appendChild(row(d)));
    }
    search.addEventListener("input", () => { VP.touchSession(); draw(search.value); });
    draw("");
    setTimeout(() => search.focus(), 60);
  }

  function row(d) {
    const s = VID.summarize(d);
    const sensitive = VID.isSensitive(d);
    const numText = el("span", { class: "pay-num" }, [s.number ? s.masked : "—"]);
    let revBtn, hideTimer = null;

    function setRevealed(on) {
      revealed[d.id] = on;
      numText.textContent = on ? s.number : (s.number ? s.masked : "—");
      numText.classList.toggle("shown", on);
      if (revBtn) revBtn.innerHTML = on ? ((window.WardenIcons || {}).eyeOff || "") : ((window.WardenIcons || {}).eye || "");
      clearTimeout(hideTimer);
      if (on) hideTimer = setTimeout(() => setRevealed(false), REVEAL_MS);
    }
    revBtn = el("button", {
      class: "pw-icon", title: "Reveal document number", html: (window.WardenIcons || {}).eye,
      onclick: async () => {
        VP.touchSession();
        if (revealed[d.id]) { setRevealed(false); return; }
        if (!s.number) { toast("No number saved on this document"); return; }
        // Only the sensitive types cost a re-auth; a licence number does not.
        if (sensitive && !(await stepUp("reveal this " + s.typeLabel.toLowerCase()))) return;
        setRevealed(true);
      },
    });

    const actions = [];
    if (s.number) {
      actions.push(el("button", {
        class: "pw-icon", title: "Copy document number", html: (window.WardenIcons || {}).copy,
        onclick: async () => {
          if (sensitive && !(await stepUp("copy this " + s.typeLabel.toLowerCase()))) return;
          copySecret(s.number, s.typeLabel + " number");
        },
      }));
      actions.push(revBtn);
    }
    // Files: attach the scan to an upload field, or save it to this computer.
    if (s.attachments) {
      actions.push(el("button", {
        class: "pw-icon", title: "Attach the scan to an upload field on this page",
        html: (window.WardenIcons || {}).upload || paperclipIcon(),
        onclick: () => attachToActiveTab(d),
      }));
      actions.push(el("button", {
        class: "pw-icon", title: "Save the scan to this computer", html: downloadIcon(),
        onclick: (e) => saveScan(d, e.currentTarget),
      }));
    }
    actions.push(el("button", { class: "pw-fill", title: "Fill this document's details on the page", onclick: () => fillActiveTab(d) }, ["Fill"]));

    const expCls = s.expiryState === "expired" ? " bad" : s.expiryState === "expiring" ? " warn" : "";
    const sub = [s.typeLabel, s.subtitleFull].filter(Boolean).join(" · ");

    // A blurred thumbnail, exactly as the web app shows it: enough to recognise
    // the document, not enough to read it off a screen someone can see.
    const mark = s.cover && s.cover.thumb
      ? el("span", { class: "idp-thumb" }, [el("img", { src: s.cover.thumb, alt: "" })])
      : el("span", { class: "idp-mark", html: glyphFor(s.type.id) });

    return el("div", { class: "pw-row pay-row" + (s.expiryState === "expired" ? " expired" : "") }, [
      mark,
      el("div", { class: "pw-main" }, [
        el("div", { class: "pw-title" }, [s.title]),
        el("div", { class: "pw-user" }, [sub || s.typeLabel]),
        el("div", { class: "pay-numline" }, [
          numText,
          s.expiration ? el("span", { class: "pay-exp" + expCls }, [s.expiryState === "expired" ? "EXPIRED" : s.expirationShort]) : null,
        ]),
      ]),
      el("div", { class: "pw-actions" }, actions),
    ]);
  }

  // ── actions against the active tab ─────────────────────────────────────────
  // Every one of these routes through the background so the decrypted document
  // is never handled in this popup's own variables longer than it must be.
  function withActiveTab(fn) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      if (tabId == null) return toast("No active tab");
      fn(tabId);
    });
  }
  async function fillActiveTab(d) {
    VP.touchSession();
    // A sensitive number needs fresh auth BEFORE we ask the background for it,
    // so the prompt appears here rather than the fill silently omitting it.
    if (VID.isSensitive(d) && !VP.authFresh()) {
      if (!(await stepUp("fill this " + VID.typeLabel(d).toLowerCase()))) return;
    }
    withActiveTab((tabId) => {
      chrome.runtime.sendMessage({ action: "wardenFillIdDoc", id: d.id, tabId }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) return toast("No ID fields found on this page");
        if (r.numberWithheld) return toast("Filled — unlock again to include the number");
        toast("Filled " + r.filled + " field" + (r.filled === 1 ? "" : "s"));
      });
    });
  }
  function attachToActiveTab(d) {
    VP.touchSession();
    withActiveTab((tabId) => {
      toast("Attaching…");
      chrome.runtime.sendMessage({ action: "wardenAttachIdFile", id: d.id, tabId }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) {
          return toast(r && r.error === "no-field" ? "No file-upload field found on this page"
            : r && r.error === "too-large" ? "That scan is too large to attach"
              : r && r.error === "rejected" ? "This page won't accept that file type"
                : "Couldn't attach the scan");
        }
        toast("Attached " + r.name);
      });
    });
  }

  // ── save a scan to this computer ───────────────────────────────────────────
  // chrome.downloads when the permission is granted (it survives the popup
  // closing, which an <a download> click does not always do); otherwise a plain
  // anchor, which works fine while the popup is open.
  async function saveScan(d, btn) {
    const entries = VID.allAttachments(d);
    if (!entries.length) { toast("No files on this document"); return; }
    if (btn) btn.disabled = true;
    let saved = 0;
    try {
      for (const entry of entries) {
        const att = entry.att;
        const bytes = await VP.attachmentBytes(att);
        const blob = new Blob([bytes], { type: att.mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const name = safeName(att.name || "document");
        const ok = await triggerDownload(url, name);
        // Revoke late: the download reads from the blob URL asynchronously.
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
        if (ok) saved++;
      }
      toast(saved ? (saved === 1 ? "Saved " + safeName(entries[0].att.name || "document") : "Saved " + saved + " files") : "Couldn't save");
    } catch (e) {
      toast(e && e.message === "locked" ? "Warden is locked" : "Couldn't download that scan");
    } finally { if (btn) btn.disabled = false; }
  }
  function safeName(n) { return String(n || "document").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120); }
  function triggerDownload(url, filename) {
    return new Promise((resolve) => {
      if (chrome.downloads && chrome.downloads.download) {
        try {
          chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
            if (chrome.runtime.lastError || id == null) return resolve(anchorFallback(url, filename));
            resolve(true);
          });
          return;
        } catch (e) { /* fall through */ }
      }
      resolve(anchorFallback(url, filename));
    });
  }
  function anchorFallback(url, filename) {
    try {
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.style.display = "none";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      return true;
    } catch (e) { return false; }
  }

  // ── icons ──────────────────────────────────────────────────────────────────
  function svg(body, w) {
    return '<svg width="' + (w || 15) + '" height="' + (w || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }
  function idIcon() { return svg('<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.3 1.8-2 3-2s2.4.7 3 2"/><path d="M14 10h5"/><path d="M14 13.5h5"/>', 28); }
  function downloadIcon() { return svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'); }
  function paperclipIcon() { return svg('<path d="M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"/>'); }
  const GLYPHS = {
    drivers_license: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.3 1.8-2 3-2s2.4.7 3 2"/><path d="M14 10h5"/><path d="M14 13.5h5"/>',
    passport: '<path d="M5 3h11a3 3 0 0 1 3 3v15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><circle cx="11.5" cy="10" r="3"/><path d="M9 17h5"/>',
    state_id: '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8.5" cy="10.5" r="2.2"/><path d="M15 9h4"/><path d="M15 12.5h4"/>',
    ssn_card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 10h6"/><path d="M6 14h12"/>',
    birth_certificate: '<path d="M6 2h9l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M15 2v4h4"/><path d="M8 11h7"/><circle cx="15.5" cy="18" r="2"/>',
    vehicle_registration: '<path d="M4 16h16"/><path d="m5 16-1-4.5A2 2 0 0 1 6 9h12a2 2 0 0 1 2 2.5L19 16"/><path d="M6.5 9 8 5.5A2 2 0 0 1 9.8 4h4.4A2 2 0 0 1 16 5.5L17.5 9"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/>',
    insurance_card: '<path d="M12 21s7-3.6 7-9V5.5L12 3 5 5.5V12c0 5.4 7 9 7 9Z"/><path d="M12 8.5v6"/><path d="M9 11.5h6"/>',
    student_id: '<path d="m3 8 9-4 9 4Z"/><path d="M7 10.5V15c0 1.7 2.2 3 5 3s5-1.3 5-3v-4.5"/>',
    work_id: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M8 13h8"/>',
    custom: '<path d="M6 2h9l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M15 2v4h4"/><path d="M8 12h8"/>',
  };
  function glyphFor(id) { return svg(GLYPHS[id] || GLYPHS.custom, 22); }

  window.WardenIdPanel = { render, lock: () => VP.lock() };
})();
