// ─────────────────────────────────────────────────────────────────────────────
// vault-pw.js — Vault extension · Passwords panel (read + autofill)
//
// Fetches the END-TO-END ENCRYPTED password vault through the `vault-pw-sync`
// Worker (the extension can't satisfy App Check, so it can't hit Firestore
// directly — same reason vault-sync.js uses keychain-sync). Decryption happens
// ENTIRELY LOCALLY with VaultCrypto after the user unlocks with their master
// password — the Worker only ever sees ciphertext.
//
// Autofill: clicking "Fill" injects a tiny function into the ACTIVE TAB (via
// chrome.scripting, gated by activeTab + a user gesture) that finds the login
// fields and types the credentials in. No persistent content script needed.
// ─────────────────────────────────────────────────────────────────────────────

const VaultPW = (() => {
  const WORKER_URL = "https://vault-pw-sync.av1.workers.dev/vault";
  const VAULT_KEY  = "vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK"; // same shared key as vault-sync.js

  let config = null, items = {}, dek = null, loaded = false;

  // ── data ───────────────────────────────────────────────────────────────────
  async function fetchVault() {
    const r = await fetch(WORKER_URL, { headers: { "X-Vault-Key": VAULT_KEY } });
    if (!r.ok) throw new Error("load " + r.status + " " + (await safeText(r)));
    const d = await r.json();
    config = d.config || null;
    items = d.items || {};
    loaded = true;
    return { hasVault: !!config };
  }
  async function ensureLoaded() { if (!loaded) await fetchVault(); }
  async function hasVault() { await ensureLoaded(); return !!config; }

  async function unlock(masterPassword) {
    await ensureLoaded();
    if (!config) throw new Error("no-vault");
    dek = await VaultCrypto.unlockWithPassword(config, masterPassword); // throws 'bad-password'
  }
  function isUnlocked() { return !!dek; }
  function lock() { dek = null; }

  // Decrypt all live login items.
  async function credentials() {
    if (!dek) throw new Error("locked");
    const out = [];
    for (const id of Object.keys(items)) {
      const doc = items[id];
      if (!doc || doc.deleted || doc.kind !== "login" || !doc.enc) continue;
      try { const body = await VaultCrypto.decrypt(dek, doc.enc); out.push(Object.assign({ id }, body)); }
      catch (e) { /* undecryptable — skip */ }
    }
    return out.sort((a, b) => (a.title || a.url || "").localeCompare(b.title || b.url || ""));
  }

  function hostFromUrl(u) {
    try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase().replace(/^www\./, ""); }
    catch { return String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
  }
  // Credentials whose saved URL matches the given page host (same registrable-ish domain).
  function matchDomain(creds, pageHost) {
    const host = String(pageHost || "").toLowerCase().replace(/^www\./, "");
    if (!host) return [];
    return creds.filter((c) => {
      const u = hostFromUrl(c.url || c.title || "");
      if (!u) return false;
      return host === u || host.endsWith("." + u) || u.endsWith("." + host);
    });
  }

  async function safeText(r) { try { return await r.text(); } catch { return ""; } }

  return { fetchVault, hasVault, unlock, lock, isUnlocked, credentials, matchDomain, hostFromUrl };
})();
if (typeof window !== "undefined") window.VaultPW = VaultPW;
if (typeof module !== "undefined" && module.exports) module.exports = VaultPW;

// ── UI: mounts into #panel-passwords ───────────────────────────────────────────
(function () {
  const VP = VaultPW;
  let currentHost = "";
  let panel = null;

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
    setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)"; }, 1400);
  }
  function copy(v, label) { navigator.clipboard.writeText(v || "").then(() => toast(label + " copied")); }
  function favicon(url) {
    const host = VP.hostFromUrl(url);
    const i = el("img", { class: "pw-fav", src: "https://www.google.com/s2/favicons?sz=32&domain=" + encodeURIComponent(host), width: 16, height: 16, alt: "" });
    i.addEventListener("error", () => { i.style.visibility = "hidden"; });
    return i;
  }

  async function getActiveHost() {
    return new Promise((res) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const url = tabs && tabs[0] && tabs[0].url; res(url ? VP.hostFromUrl(url) : "");
        });
      } catch (e) { res(""); }
    });
  }

  // Inject a fill into the active tab. Runs in the page context.
  async function fillActiveTab(cred) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs && tabs[0] && tabs[0].id;
        if (tabId == null) { toast("No active tab"); return resolve(false); }
        chrome.scripting.executeScript({
          target: { tabId },
          args: [cred.username || cred.email || "", cred.password || ""],
          func: pageFill,
        }, (results) => {
          const ok = results && results[0] && results[0].result;
          toast(ok ? "Filled ✓" : "No login fields found"); resolve(!!ok);
        });
      });
    });
  }
  // This function body is serialized and run inside the target page.
  function pageFill(username, password) {
    function setVal(input, val) {
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const pwFields = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]'))
      .filter((e) => e.offsetParent !== null);
    let filled = false;
    if (pwFields.length && password) { setVal(pwFields[0], password); filled = true; }
    if (username) {
      let userField = null;
      const pw = pwFields[0];
      if (pw && pw.form) {
        userField = pw.form.querySelector('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]');
      }
      if (!userField) {
        const cands = Array.prototype.slice.call(document.querySelectorAll('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[type="text"]'))
          .filter((e) => e.offsetParent !== null);
        userField = cands[0] || null;
      }
      if (userField) { setVal(userField, username); filled = true; }
    }
    return filled;
  }

  // ── renders ─────────────────────────────────────────────────────────────────
  function clear() { panel.innerHTML = ""; }

  async function render() {
    panel = document.getElementById("panel-passwords");
    if (!panel) return;
    if (typeof VaultCrypto === "undefined") { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["Crypto not loaded."])); return; }
    currentHost = await getActiveHost();
    let has;
    try { has = await VP.hasVault(); }
    catch (e) { clear(); panel.appendChild(el("div", { class: "pw-msg err" }, ["Couldn't reach your vault.", el("br"), "Check your connection."])); return; }
    if (!has) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["No vault yet. Create one in TaskHub → Vault first."])); return; }
    if (!VP.isUnlocked()) return renderUnlock();
    return renderList();
  }

  function renderUnlock() {
    clear();
    const pwIn = el("input", { type: "password", class: "pw-input", placeholder: "Master password", autocomplete: "current-password" });
    const err = el("div", { class: "pw-err" });
    const btn = el("button", { class: "pw-btn primary" }, ["Unlock"]);
    async function go() {
      err.textContent = ""; btn.disabled = true; btn.textContent = "Unlocking…";
      try { await VP.unlock(pwIn.value); renderList(); }
      catch (e) { err.textContent = e.message === "bad-password" ? "Incorrect master password." : ("Error: " + e.message); btn.disabled = false; btn.textContent = "Unlock"; }
    }
    btn.addEventListener("click", go);
    pwIn.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    clear();
    panel.appendChild(el("div", { class: "pw-lock" }, [
      el("div", { class: "pw-lock-icon", html: "🔐" }),
      el("div", { class: "pw-lock-title" }, ["Vault is locked"]),
      el("div", { class: "pw-lock-sub" }, ["Unlock to view and autofill your logins on this device."]),
      pwIn, err, btn,
    ]));
    setTimeout(() => pwIn.focus(), 60);
  }

  async function renderList() {
    clear();
    let creds;
    try { creds = await VP.credentials(); }
    catch (e) { return renderUnlock(); }
    const matches = VP.matchDomain(creds, currentHost);
    const matchIds = {}; matches.forEach((m) => (matchIds[m.id] = true));
    const others = creds.filter((c) => !matchIds[c.id]);

    // search
    const search = el("input", { class: "pw-search", placeholder: "Search logins…" });
    const listWrap = el("div", { class: "pw-list" });
    const lockBtn = el("button", { class: "pw-icon", title: "Lock", html: "🔒", onclick: () => { VP.lock(); renderUnlock(); } });
    panel.appendChild(el("div", { class: "pw-toolbar" }, [search, lockBtn]));
    panel.appendChild(listWrap);

    function draw(q) {
      q = (q || "").trim().toLowerCase();
      listWrap.innerHTML = "";
      const flt = (arr) => q ? arr.filter((c) => ((c.title || "") + " " + (c.url || "") + " " + (c.username || "") + " " + (c.email || "")).toLowerCase().includes(q)) : arr;
      const m = flt(matches), o = flt(others);
      if (!m.length && !o.length) { listWrap.appendChild(el("div", { class: "pw-msg" }, [q ? "No matches." : "No logins yet."])); return; }
      if (m.length) {
        listWrap.appendChild(el("div", { class: "pw-section-h" }, ["For this site · " + currentHost]));
        m.forEach((c) => listWrap.appendChild(row(c, true)));
      }
      if (o.length) {
        if (m.length) listWrap.appendChild(el("div", { class: "pw-section-h" }, ["All logins"]));
        o.forEach((c) => listWrap.appendChild(row(c, false)));
      }
    }
    search.addEventListener("input", () => draw(search.value));
    draw("");
    setTimeout(() => search.focus(), 60);
  }

  function row(c, isMatch) {
    let shown = false;
    const pwText = el("span", { class: "pw-dots" }, ["••••••••"]);
    const reveal = el("button", { class: "pw-icon", title: "Reveal", html: "👁", onclick: () => { shown = !shown; pwText.textContent = shown ? (c.password || "") : "••••••••"; } });
    const fillBtn = el("button", { class: "pw-fill", title: "Autofill this login on the page", onclick: () => fillActiveTab(c) }, ["Fill"]);
    return el("div", { class: "pw-row" + (isMatch ? " match" : "") }, [
      favicon(c.url || c.title),
      el("div", { class: "pw-main" }, [
        el("div", { class: "pw-title" }, [c.title || VP.hostFromUrl(c.url) || "(untitled)"]),
        el("div", { class: "pw-user" }, [c.username || c.email || "(no username)"]),
        el("div", { class: "pw-pw" }, [pwText]),
      ]),
      el("div", { class: "pw-actions" }, [
        (c.username || c.email) ? el("button", { class: "pw-icon", title: "Copy username", html: "👤", onclick: () => copy(c.username || c.email, "Username") }) : null,
        el("button", { class: "pw-icon", title: "Copy password", html: "🔑", onclick: () => copy(c.password, "Password") }),
        reveal,
        fillBtn,
      ]),
    ]);
  }

  // Expose a hook the popup calls when the Passwords tab is shown.
  window.VaultPWPanel = { render, lock: () => VaultPW.lock() };
})();
