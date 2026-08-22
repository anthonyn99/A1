// ─────────────────────────────────────────────────────────────────────────────
// warden-pay.js panel — Warden extension · Payments panel UI (popup)
//
// The payments twin of warden-pw.js. Same data layer (warden-pw-core.js), same
// unlocked session, same 30-minute idle window — unlocking on the Passwords tab
// unlocks this one too, because there is only ONE warden.
//
// ── What's stricter here than for passwords ─────────────────────────────────
// Cards are masked by default. Revealing a full number or a CVV — and copying
// either — requires a FRESH credential check (WardenPWCore.authFresh()): a
// master password or biometric presented within the last 5 minutes. Merely
// having an unlocked session is not enough, so a laptop left open on the
// Payments tab still can't surrender a security code.
//
// Revealed values re-hide themselves automatically, and copied secrets are
// wiped from the clipboard after 30 seconds.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const VP = self.WardenPWCore;
  const PAY = self.WardenPay;
  let panel = null;
  let revealed = {};          // id -> true, cleared on every re-render/lock
  const REVEAL_MS = 30000;    // auto re-mask a revealed card after 30s

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
    setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)"; }, 1600);
  }
  // Copy, then clear the clipboard 30s later if it still holds the secret —
  // the same protection the PWA applies to passwords.
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
        (tabs || []).forEach((t) => { if (t && t.id != null) { try { chrome.tabs.sendMessage(t.id, { action: "wardenLockChanged", unlocked: unlocked }, () => void chrome.runtime.lastError); } catch (e) {} } });
      });
    } catch (e) {}
  }
  function clear() { panel.innerHTML = ""; revealed = {}; }

  // ── entry point ────────────────────────────────────────────────────────────
  async function render() {
    panel = document.getElementById("panel-payments");
    if (!panel) return;
    if (typeof WardenCrypto === "undefined" || !VP || !PAY) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["Payments module not loaded."])); return; }
    let has;
    try { has = await VP.hasWarden(); }
    catch (e) { clear(); panel.appendChild(el("div", { class: "pw-msg err" }, ["Couldn't reach Warden.", el("br"), "Check your connection."])); return; }
    if (!has) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["No vault yet. Set one up in the Warden app first."])); return; }
    if (!VP.isUnlocked()) { try { await VP.restoreSession(); } catch (e) {} }
    if (!VP.isUnlocked()) return renderUnlock();
    return renderList();
  }

  // ── unlock (identical flow to the Passwords tab — one warden, one session) ──
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
      const bioBtn = el("button", { class: "pw-btn", html: (window.WardenIcons || {}).unlock + '<span>Unlock with ' + label + '</span>' });
      bioBtn.addEventListener("click", async () => {
        err.textContent = "";
        try { await VP.unlockWithBiometric(); broadcastLockState(true); renderList(); }
        catch (e) { if (e.message !== "cancelled") err.textContent = label + " unlock failed — use your password."; }
      });
      kids.splice(2, 0, bioBtn);
    }
    panel.appendChild(el("div", { class: "pw-lock" }, [
      el("div", { class: "pw-lock-icon", html: (window.WardenIcons || {}).card }),
      el("div", { class: "pw-lock-title" }, ["Warden is locked"]),
      el("div", { class: "pw-lock-sub" }, ["Unlock to view and autofill your saved cards. Stays unlocked for 30 min of activity."]),
      ...kids,
    ]));
    setTimeout(() => pwIn.focus(), 60);
  }

  // ── step-up auth for revealing / copying a full number or CVV ──────────────
  // Resolves true only on a successful FRESH credential check. Already-fresh
  // sessions short-circuit, so you aren't re-prompted for every field.
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
        const bioBtn = el("button", { class: "pw-btn", html: (window.WardenIcons || {}).unlock + '<span>Use ' + label + '</span>' });
        // Only ever on click — the OS prompt never fires by itself, so the
        // password field stays an equal route through.
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
    let cards;
    try { cards = await VP.payments(); } catch (e) { return renderUnlock(); }
    VP.touchSession();

    const search = el("input", { class: "pw-search", placeholder: "Search cards…" });
    const listWrap = el("div", { class: "pw-list" });
    const lockBtn = el("button", { class: "pw-icon", title: "Lock now", html: (window.WardenIcons || {}).lock, onclick: async () => { await VP.lock(); broadcastLockState(false); renderUnlock(); } });
    panel.appendChild(el("div", { class: "pw-toolbar" }, [search, lockBtn]));
    panel.appendChild(listWrap);

    function draw(q) {
      listWrap.innerHTML = "";
      const list = PAY.filterCards(cards, q);
      if (!list.length) {
        listWrap.appendChild(el("div", { class: "pw-msg" }, [q ? "No matches." : "No payment methods yet. Add one in the Warden app → Payments."]));
        return;
      }
      list.forEach((c) => listWrap.appendChild(row(c)));
    }
    search.addEventListener("input", () => { VP.touchSession(); draw(search.value); });
    draw("");
    setTimeout(() => search.focus(), 60);
  }

  function row(c) {
    const s = PAY.summarize(c);
    const numText = el("span", { class: "pay-num" }, [s.masked]);
    let revBtn, hideTimer = null;

    function setRevealed(on) {
      revealed[c.id] = on;
      numText.textContent = on ? PAY.formatNumber(c.number, s.network) : s.masked;
      numText.classList.toggle("shown", on);
      if (revBtn) revBtn.innerHTML = on ? ((window.WardenIcons || {}).eyeOff || '') : ((window.WardenIcons || {}).eye || '');
      clearTimeout(hideTimer);
      if (on) hideTimer = setTimeout(() => setRevealed(false), REVEAL_MS);
    }
    revBtn = el("button", {
      class: "pw-icon", title: "Reveal card number", html: (window.WardenIcons || {}).eye,
      onclick: async () => {
        VP.touchSession();
        if (revealed[c.id]) { setRevealed(false); return; }
        if (!c.number) { toast("No card number saved"); return; }
        if (!(await stepUp("reveal this card number"))) return;
        setRevealed(true);
      },
    });

    const fillBtn = el("button", { class: "pw-fill", title: "Autofill this card on the page", onclick: () => fillActiveTab(c) }, ["Fill"]);

    const actions = [
      el("button", {
        class: "pw-icon", title: "Copy card number", html: (window.WardenIcons || {}).copy,
        onclick: async () => {
          if (!c.number) { toast("No card number saved"); return; }
          if (!(await stepUp("copy this card number"))) return;
          copySecret(c.number, "Card number");
        },
      }),
    ];
    if (s.hasCvv) {
      actions.push(el("button", {
        class: "pw-icon", title: "Copy security code", html: (window.WardenIcons || {}).shield,
        onclick: async () => { if (!(await stepUp("copy this security code"))) return; copySecret(c.cvv, "Security code"); },
      }));
    }
    if (s.hasBilling) {
      actions.push(el("button", {
        class: "pw-icon", title: "Copy billing address", html: (window.WardenIcons || {}).home,
        onclick: () => { VP.touchSession(); copySecret(PAY.formatAddress(c.billing), "Billing address"); },
      }));
    }
    actions.push(revBtn, fillBtn);

    const expCls = s.expiryState === "expired" ? " bad" : s.expiryState === "expiring" ? " warn" : "";
    const sub = [s.typeLabel, s.cardholder].filter(Boolean).join(" · ");

    return el("div", { class: "pw-row pay-row" + (s.expiryState === "expired" ? " expired" : "") }, [
      el("span", { class: "pay-mark", html: PAY.brandMark(s.network) }),
      el("div", { class: "pw-main" }, [
        el("div", { class: "pw-title" }, [s.title]),
        el("div", { class: "pw-user" }, [sub || s.networkLabel]),
        el("div", { class: "pay-numline" }, [numText, s.expiry ? el("span", { class: "pay-exp" + expCls }, [s.expiry]) : null]),
      ]),
      el("div", { class: "pw-actions" }, actions),
    ]);
  }

  // ── autofill into the active tab ───────────────────────────────────────────
  // Routed through the background so the decrypted card is never handled here:
  // it goes straight from the service worker into the page's filler.
  function fillActiveTab(c) {
    VP.touchSession();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      if (tabId == null) return toast("No active tab");
      chrome.runtime.sendMessage({ action: "wardenFillCard", id: c.id, tabId }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) return toast("No payment fields found on this page");
        if (!r.cvvFilled && r.cvvFresh === false) return toast("Filled \u2014 unlock again to include the security code");
        toast("Filled " + r.filled + " field" + (r.filled === 1 ? "" : "s"));
      });
    });
  }

  window.WardenPayPanel = { render, lock: () => VP.lock() };
})();
