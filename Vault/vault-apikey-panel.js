// ─────────────────────────────────────────────────────────────────────────────
// vault-apikey-panel.js — Vault extension · API Keys panel UI (popup)
//
// The API-key twin of vault-pw.js. Same data layer (vault-pw-core.js), same
// unlocked session, same 30-minute idle window — unlocking on any tab unlocks
// this one too, because there is only ONE vault. It reads the vault document
// the popup has already fetched, so opening this tab costs no extra Worker
// call and no extra Firestore read.
//
// ── What you can do here ────────────────────────────────────────────────────
//   Copy      the key, its secret, key ID, account, endpoint, a ready-made
//             .env line, any custom field — copies are wiped from the
//             clipboard after 30s while the popup stays open.
//   Fill      write the key into the field you last clicked on the page (a
//             dashboard's "API key" box, a settings form). With no field
//             focused it matches fields by their labels instead: "secret" gets
//             the secret, "client ID" / "key ID" the key ID, "API key" /
//             "token" the key. Each detail line can fill its own value too.
//   Match     keys for the site you're on (by console / endpoint URL or the
//             provider's own domain) are listed first.
//
// Keys render masked; the page only ever receives the one value you chose to
// fill, injected by an explicit click through chrome.scripting — exactly the
// path Passwords already uses.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const VP = self.VaultPWCore;
  const AK = self.VaultApiKey;
  let panel = null;
  let currentHost = "";
  let openRow = {};              // id -> expanded, cleared on lock
  const REVEAL_MS = 30000;
  const I = () => window.VaultIcons || {};

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
    clearTimeout(t._akh);
    t._akh = setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)"; }, 1700);
  }
  function copySecret(v, label) {
    VP.touchSession();
    navigator.clipboard.writeText(v || "").then(() => {
      toast(label + " copied");
      setTimeout(() => {
        navigator.clipboard.readText().then((cur) => { if (cur === v) navigator.clipboard.writeText(""); }).catch(() => {});
      }, 30000);
    }).catch(() => toast("Copy failed"));
  }
  function broadcastLockState(unlocked) {
    try {
      chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((t) => { if (t && t.id != null) { try { chrome.tabs.sendMessage(t.id, { action: "vaultLockChanged", unlocked }, () => void chrome.runtime.lastError); } catch (e) {} } });
      });
    } catch (e) {}
  }
  function getActiveHost() {
    return new Promise((res) => {
      try { chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const u = tabs && tabs[0] && tabs[0].url; res(u ? VP.hostFromUrl(u) : ""); }); }
      catch (e) { res(""); }
    });
  }
  function clear() { panel.innerHTML = ""; }

  // ── entry point ────────────────────────────────────────────────────────────
  async function render() {
    panel = document.getElementById("panel-apikeys");
    if (!panel) return;
    if (typeof VaultCrypto === "undefined" || !VP || !AK) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["API Keys module not loaded."])); return; }
    currentHost = await getActiveHost();
    let has;
    try { has = await VP.hasVault(); }
    catch (e) { clear(); panel.appendChild(el("div", { class: "pw-msg err" }, ["Couldn't reach your vault.", el("br"), "Check your connection."])); return; }
    if (!has) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["No vault yet. Create one in the Vault app first."])); return; }
    if (!VP.isUnlocked()) { try { await VP.restoreSession(); } catch (e) {} }
    if (!VP.isUnlocked()) return renderUnlock();
    return renderList();
  }

  // ── unlock (the same flow as every other tab — one vault, one session) ─────
  async function renderUnlock() {
    clear(); openRow = {};
    const pwIn = el("input", { type: "password", class: "pw-input", placeholder: "Master password", autocomplete: "current-password" });
    const err = el("div", { class: "pw-err" });
    const btn = el("button", { class: "pw-btn primary" }, ["Unlock"]);
    async function go() {
      if (!pwIn.value) { err.textContent = "Enter your master password."; return; }
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
      const label = VP.biometricLabel(await VP.getBioLink());
      const bioBtn = el("button", { class: "pw-btn", html: (I().unlock || "") + "<span>Unlock with " + label + "</span>" });
      bioBtn.addEventListener("click", async () => {
        err.textContent = "";
        try { await VP.unlockWithBiometric(); broadcastLockState(true); renderList(); }
        catch (e) { if (e.message !== "cancelled") err.textContent = label + " unlock failed — use your password."; }
      });
      kids.splice(2, 0, bioBtn);
    }
    panel.appendChild(el("div", { class: "pw-lock" }, [
      el("div", { class: "pw-lock-icon", html: codeIcon() }),
      el("div", { class: "pw-lock-title" }, ["Vault is locked"]),
      el("div", { class: "pw-lock-sub" }, ["Unlock to copy or autofill your API keys. Stays unlocked for 30 min of activity."]),
      ...kids,
    ]));
    setTimeout(() => pwIn.focus(), 60);
  }

  // ── list ───────────────────────────────────────────────────────────────────
  async function renderList() {
    clear();
    let keys;
    try { keys = await VP.apiKeys(); } catch (e) { return renderUnlock(); }
    VP.touchSession();
    const matches = AK.matchHost(keys, currentHost);
    const matchIds = {}; matches.forEach((m) => (matchIds[m.id] = true));
    const others = keys.filter((k) => !matchIds[k.id]);

    const search = el("input", { class: "pw-search", placeholder: "Search API keys…", autocomplete: "off", spellcheck: "false" });
    const listWrap = el("div", { class: "pw-list" });
    const lockBtn = el("button", { class: "pw-icon", title: "Lock now", html: I().lock, onclick: async () => { await VP.lock(); broadcastLockState(false); renderUnlock(); } });
    panel.appendChild(el("div", { class: "pw-toolbar" }, [search, lockBtn]));
    panel.appendChild(listWrap);

    function draw(q) {
      listWrap.innerHTML = "";
      const m = AK.filterKeys(matches, q), o = AK.filterKeys(others, q);
      if (!m.length && !o.length) {
        listWrap.appendChild(el("div", { class: "pw-msg" }, [q ? "No matches." : "No API keys yet. Add one in the Vault app → API Keys."]));
        return;
      }
      if (m.length) { listWrap.appendChild(el("div", { class: "pw-section-h" }, ["For this site · " + currentHost])); m.forEach((k) => listWrap.appendChild(row(k, true))); }
      if (o.length) { if (m.length) listWrap.appendChild(el("div", { class: "pw-section-h" }, ["All API keys"])); o.forEach((k) => listWrap.appendChild(row(k, false))); }
    }
    search.addEventListener("input", () => { VP.touchSession(); draw(search.value); });
    draw("");
    setTimeout(() => search.focus(), 60);
  }

  function row(k, isMatch) {
    const s = AK.summarize(k);
    const expCls = s.expiryState === "expired" ? " bad" : s.expiryState === "expiring" ? " warn" : "";
    const primary = s.hasKey ? k.key : k.secret;

    const actions = [];
    if (primary) {
      actions.push(el("button", {
        class: "pw-icon", title: s.hasKey ? "Copy API key" : "Copy secret", html: I().copy,
        onclick: (e) => { e.stopPropagation(); copySecret(primary, s.hasKey ? "API key" : "Secret"); },
      }));
      actions.push(el("button", {
        class: "pw-fill", title: "Fill into the field you last clicked on the page (or matching fields by label)",
        onclick: (e) => { e.stopPropagation(); fill(k, "auto"); },
      }, ["Fill"]));
    }

    const details = el("div", { class: "ak-details" });
    details.hidden = !openRow[k.id];
    const head = el("div", { class: "ak-head", role: "button", tabindex: "0", "aria-expanded": String(!!openRow[k.id]) }, [
      el("span", { class: "ak-mark", html: AK.providerMark(s.provider) }),
      el("div", { class: "pw-main" }, [
        el("div", { class: "pw-title" }, [s.title]),
        el("div", { class: "pw-user" }, [s.subtitle]),
        el("div", { class: "pay-numline" }, [
          s.masked ? el("span", { class: "pay-num" }, [s.masked]) : null,
          s.expiryState === "expired" || s.expiryState === "expiring" ? el("span", { class: "pay-exp" + expCls }, [s.expiryState === "expired" ? "Expired" : s.expiryLabel]) : null,
        ]),
      ]),
      el("div", { class: "pw-actions" }, actions),
    ]);
    function toggle() {
      VP.touchSession();
      openRow[k.id] = details.hidden;
      details.hidden = !details.hidden;
      head.setAttribute("aria-expanded", String(!details.hidden));
      if (!details.hidden && !details.firstChild) buildDetails(k, s, details);
    }
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); toggle(); } });
    if (openRow[k.id]) buildDetails(k, s, details);

    return el("div", { class: "pw-row ak-row" + (isMatch ? " match" : "") + (s.expiryState === "expired" ? " expired" : "") }, [head, details]);
  }

  // Details are built on first expand only — nothing secret sits in the DOM
  // for rows you never opened.
  function buildDetails(k, s, box) {
    const lines = [];
    if (s.hasKey) lines.push(detail("API key", k.key, { secret: true, fillAs: "key" }));
    if (s.hasSecret) lines.push(detail("Secret", k.secret, { secret: true, fillAs: "secret" }));
    if (k.keyId) lines.push(detail("Key / client ID", k.keyId, { mono: true, fillAs: "keyId" }));
    if (k.account) lines.push(detail("Account", k.account, { fillAs: "account" }));
    if (s.hasKey) lines.push(detail(".env", AK.envLine(k), { secret: true, mono: true, masked: s.envName + "=" + (s.masked || "••••"), copyLabel: ".env line" }));
    if (k.endpoint) lines.push(detail("Endpoint", k.endpoint, { mono: true, fillAs: "endpoint" }));
    if (s.environmentLabel || s.keyTypeLabel) lines.push(detail("Type", [s.keyTypeLabel, s.environmentLabel].filter(Boolean).join(" · "), { noCopy: true }));
    if (k.scopes) lines.push(detail("Scopes", k.scopes, {}));
    if (s.expiry) lines.push(detail("Expires", s.expiry + (s.expiryLabel ? " · " + s.expiryLabel : ""), { noCopy: true }));
    (Array.isArray(k.customFields) ? k.customFields : []).forEach((cf) => {
      if (!cf || (!cf.label && !cf.value)) return;
      lines.push(detail(cf.label || "Field", cf.value || "", { secret: !!cf.hidden, fillAs: "custom", raw: true }));
    });
    if (k.notes && String(k.notes).trim()) lines.push(detail("Notes", k.notes, { wrap: true }));
    const consoleHref = AK.safeHref(k.consoleUrl) || (s.provider && s.provider.console) || "";
    if (consoleHref) {
      lines.push(el("button", {
        class: "pw-btn ak-console", html: extIcon() + "<span>Open " + (s.providerLabel || "provider") + " console</span>",
        onclick: () => { VP.touchSession(); chrome.tabs.create({ url: consoleHref }); },
      }));
    }
    lines.forEach((l) => box.appendChild(l));
  }

  function detail(label, value, o) {
    o = o || {};
    let shown = !o.secret, timer = null;
    const masked = o.masked || AK.maskKey(value) || "••••••••";
    const val = el("span", { class: "ak-val" + (o.mono || o.secret ? " mono" : "") + (o.wrap ? " wrap" : "") }, [o.secret ? masked : value]);
    const btns = [];
    if (o.secret) {
      const rev = el("button", { class: "pw-icon", title: "Reveal", html: I().eye });
      const set = (on) => {
        shown = on; val.textContent = on ? value : masked; val.classList.toggle("shown", on);
        rev.innerHTML = on ? (I().eyeOff || "") : (I().eye || ""); rev.title = on ? "Hide" : "Reveal";
        clearTimeout(timer); if (on) timer = setTimeout(() => set(false), REVEAL_MS);
      };
      rev.addEventListener("click", (e) => { e.stopPropagation(); VP.touchSession(); set(!shown); });
      btns.push(rev);
    }
    if (!o.noCopy) btns.push(el("button", { class: "pw-icon", title: "Copy " + (o.copyLabel || label), html: I().copy, onclick: (e) => { e.stopPropagation(); copySecret(value, o.copyLabel || label); } }));
    if (o.fillAs) btns.push(el("button", { class: "pw-icon ak-fill1", title: "Fill " + label + " into the page", html: fillIcon(), onclick: (e) => { e.stopPropagation(); fillValue(value, o.raw ? "custom" : o.fillAs, label); } }));
    return el("div", { class: "ak-line" }, [
      el("div", { class: "ak-line-main" }, [el("div", { class: "ak-label" }, [label]), val]),
      btns.length ? el("div", { class: "pw-actions" }, btns) : null,
    ]);
  }

  // ── autofill ───────────────────────────────────────────────────────────────
  function withActiveTab(fn) {
    VP.touchSession();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return toast("No active tab");
      if (!/^https?:|^file:/i.test(tab.url || "")) return toast("Can't fill on this page");
      fn(tab.id);
    });
  }
  function report(results, what) {
    void chrome.runtime.lastError;
    const r = results && results[0] && results[0].result;
    if (!r || !r.filled) return toast("Click the field on the page first, then Fill");
    toast(r.focused ? what + " filled" : "Filled " + r.filled + " field" + (r.filled === 1 ? "" : "s"));
  }
  // Whole item: the focused field gets the key; with nothing focused, fields
  // are matched by their labels.
  function fill(k, mode) {
    const v = AK.fillValues(k);
    withActiveTab((tabId) => {
      chrome.scripting.executeScript({ target: { tabId }, args: [v, mode], func: pageFillApiKey }, (res) => report(res, "API key"));
    });
  }
  // One value → the focused field (or the first field whose label matches).
  function fillValue(value, as, label) {
    const v = { key: "", secret: "", keyId: "", account: "", endpoint: "" };
    const slot = ["key", "secret", "keyId", "account", "endpoint"].indexOf(as) >= 0 ? as : "key";
    v[slot] = value;
    withActiveTab((tabId) => {
      chrome.scripting.executeScript({ target: { tabId }, args: [v, slot], func: pageFillApiKey }, (res) => report(res, label));
    });
  }

  // Runs IN THE PAGE (isolated world). Must be self-contained.
  function pageFillApiKey(v, mode) {
    function deepActive() {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a;
    }
    const TEXTY = /^(text|password|search|url|email|tel|)$/i;
    function editable(e) {
      if (!e || e.disabled || e.readOnly) return false;
      if (e.tagName === "TEXTAREA") return true;
      if (e.tagName === "INPUT") return TEXTY.test(e.getAttribute("type") || "");
      return !!e.isContentEditable;
    }
    function visible(e) { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; }
    function setVal(e, val) {
      if (e.isContentEditable && e.tagName !== "INPUT" && e.tagName !== "TEXTAREA") {
        e.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, val);
        return;
      }
      const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(e, val);
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function hints(e) {
      let t = [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.getAttribute("autocomplete"), e.getAttribute("data-testid")].join(" ");
      try { if (e.labels) Array.prototype.forEach.call(e.labels, (l) => { t += " " + l.textContent; }); } catch (_) {}
      const lb = e.getAttribute("aria-labelledby");
      if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) t += " " + n.textContent; });
      return t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    }
    function classify(e) {
      // A search / filter box ("Search API keys…") is never a credential field.
      if ((e.getAttribute("type") || "").toLowerCase() === "search" || e.getAttribute("role") === "searchbox") return "";
      const h = hints(e);
      if (/search|filter|\bquery\b|\bfind\b/.test(h)) return "";
      if (/secret/.test(h)) return "secret";
      if (/(key|client|access|app|account)[\s_-]*id\b|\bsid\b/.test(h)) return "keyId";
      if (/api[\s_-]*key|apikey|token|access[\s_-]*key|bearer|\bkey\b|credential/.test(h)) return "key";
      if (/endpoint|base[\s_-]*url|api[\s_-]*url|\bhost\b|server/.test(h)) return "endpoint";
      if (/account|e-?mail|org/.test(h)) return "account";
      return "";
    }

    const primary = mode === "auto" ? (v.key || v.secret) : v[mode];
    const focused = deepActive();
    if (primary && editable(focused)) { setVal(focused, primary); return { filled: 1, focused: true }; }

    const fields = Array.prototype.slice.call(document.querySelectorAll("input, textarea")).filter((e) => editable(e) && visible(e));
    let filled = 0;
    if (mode === "auto") {
      const used = {};
      fields.forEach((e) => {
        const c = classify(e);
        if (!c || used[c] || !v[c] || e.value) return;
        if (c === "account" && !(v.key && filled)) return; // never fill just an account
        setVal(e, v[c]); used[c] = true; filled++;
      });
    } else if (primary) {
      const target = fields.find((e) => classify(e) === mode && !e.value);
      if (target) { setVal(target, primary); filled = 1; }
    }
    return { filled, focused: false };
  }

  // ── icons ──────────────────────────────────────────────────────────────────
  function codeIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 5-3 14"/></svg>'; }
  function fillIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h11"/><path d="m11 8 4 4-4 4"/><path d="M19 5v14"/></svg>'; }
  function extIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>'; }

  window.VaultApiKeyPanel = { render, lock: () => VP.lock(), _pageFill: pageFillApiKey };
})();
