// ─────────────────────────────────────────────────────────────────────────────
// warden-pw.js — Warden extension · Passwords panel UI (popup)
//
// Thin UI over warden-pw-core.js (the DOM-free data layer). Resumes a recent
// unlock from the 30-minute idle session so you don't retype your master
// password every time the popup opens. Autofill = inject into the active tab.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const VP = self.WardenPWCore;
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
  function copy(v, label) { VP.touchSession(); navigator.clipboard.writeText(v || "").then(() => toast(label + " copied")); }
  function favicon(url) {
    const host = VP.hostFromUrl(url);
    // Drawn locally — see the note in warden-ui.js's faviconUrl().
    const i = el("img", { class: "pw-fav", src: (function(h){h=String(h||'').replace(/^www\./,'');if(!h)return '';var n=0;for(var i=0;i<h.length;i++)n=(n*31+h.charCodeAt(i))>>>0;var c=/^[a-z0-9]/i.test(h)?h.charAt(0).toUpperCase():'#';return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +'<rect width="64" height="64" rx="14" fill="'+['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6','#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'][n%16]+'"/>' +'<text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="600" fill="#2e2833" text-anchor="middle">'+c+'</text></svg>');})(host), width: 16, height: 16, alt: "" });
    i.addEventListener("error", () => { i.style.visibility = "hidden"; });
    return i;
  }
  // Tell every tab's content script the lock state changed, so open Autofill
  // dropdowns update instantly (no page reload).
  function broadcastLockState(unlocked) {
    try {
      chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((t) => { if (t && t.id != null) { try { chrome.tabs.sendMessage(t.id, { action: "wardenLockChanged", unlocked: unlocked }, () => void chrome.runtime.lastError); } catch (e) {} } });
      });
    } catch (e) {}
  }
  async function getActiveHost() {
    return new Promise((res) => {
      try { chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const u = tabs && tabs[0] && tabs[0].url; res(u ? VP.hostFromUrl(u) : ""); }); }
      catch (e) { res(""); }
    });
  }

  async function fillActiveTab(cred) {
    VP.touchSession();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      if (tabId == null) return toast("No active tab");
      chrome.scripting.executeScript({
        target: { tabId }, args: [cred.username || cred.email || "", cred.password || ""], func: pageFill,
      }, (results) => { toast(results && results[0] && results[0].result ? "Filled" : "No login fields found"); });
    });
  }
  function pageFill(username, password) {
    function setVal(input, val) {
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const pwFields = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter((e) => e.offsetParent !== null);
    let filled = false;
    if (pwFields.length && password) { setVal(pwFields[0], password); filled = true; }
    if (username) {
      let userField = null; const pw = pwFields[0];
      if (pw && pw.form) userField = pw.form.querySelector('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]');
      if (!userField) userField = Array.prototype.slice.call(document.querySelectorAll('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[type="text"]')).filter((e) => e.offsetParent !== null)[0] || null;
      if (userField) { setVal(userField, username); filled = true; }
    }
    return filled;
  }

  function clear() { panel.innerHTML = ""; }

  async function render() {
    panel = document.getElementById("panel-passwords");
    if (!panel) return;
    if (typeof WardenCrypto === "undefined" || !VP) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["Crypto not loaded."])); return; }
    currentHost = await getActiveHost();
    let has;
    try { has = await VP.hasWarden(); }
    catch (e) { clear(); panel.appendChild(el("div", { class: "pw-msg err" }, ["Couldn't reach Warden.", el("br"), "Check your connection."])); return; }
    if (!has) { clear(); panel.appendChild(el("div", { class: "pw-msg" }, ["No vault yet. Set one up in the Warden app first."])); return; }
    // Resume a recent unlock (30-min idle) so we don't re-prompt every open.
    if (!VP.isUnlocked()) { try { await VP.restoreSession(); } catch (e) {} }
    if (!VP.isUnlocked()) return renderUnlock();
    return renderList();
  }

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
    // Biometric unlock — only offered when this device already has biometrics
    // registered for the warden in the Warden app; reuses that same
    // Windows Hello / Touch ID / Face ID / fingerprint credential.
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
      // Never fire on its own — the OS prompt only appears when this button is
      // pressed, so the password field below stays a first-class choice.
      kids.splice(2, 0, bioBtn);
    }
    panel.appendChild(el("div", { class: "pw-lock" }, [
      el("div", { class: "pw-lock-icon", html: (window.WardenIcons || {}).shield }),
      el("div", { class: "pw-lock-title" }, ["Warden is locked"]),
      el("div", { class: "pw-lock-sub" }, ["Unlock to view and autofill your logins. Stays unlocked for 30 min of activity."]),
      ...kids,
    ]));
    setTimeout(() => pwIn.focus(), 60);
  }

  async function renderList() {
    clear();
    let creds;
    try { creds = await VP.credentials(); } catch (e) { return renderUnlock(); }
    VP.touchSession();
    const matches = VP.matchDomain(creds, currentHost);
    const matchIds = {}; matches.forEach((m) => (matchIds[m.id] = true));
    const others = creds.filter((c) => !matchIds[c.id]);

    const search = el("input", { class: "pw-search", placeholder: "Search logins…" });
    const listWrap = el("div", { class: "pw-list" });
    const lockBtn = el("button", { class: "pw-icon", title: "Lock now", html: (window.WardenIcons || {}).lock, onclick: async () => { await VP.lock(); broadcastLockState(false); renderUnlock(); } });
    panel.appendChild(el("div", { class: "pw-toolbar" }, [search, lockBtn]));
    panel.appendChild(listWrap);

    function draw(q) {
      q = (q || "").trim().toLowerCase();
      listWrap.innerHTML = "";
      const flt = (arr) => q ? arr.filter((c) => ((c.title || "") + " " + (c.url || "") + " " + (c.username || "") + " " + (c.email || "")).toLowerCase().includes(q)) : arr;
      const m = flt(matches), o = flt(others);
      if (!m.length && !o.length) { listWrap.appendChild(el("div", { class: "pw-msg" }, [q ? "No matches." : "No logins yet."])); return; }
      if (m.length) { listWrap.appendChild(el("div", { class: "pw-section-h" }, ["For this site · " + currentHost])); m.forEach((c) => listWrap.appendChild(row(c, true))); }
      if (o.length) { if (m.length) listWrap.appendChild(el("div", { class: "pw-section-h" }, ["All logins"])); o.forEach((c) => listWrap.appendChild(row(c, false))); }
    }
    search.addEventListener("input", () => { VP.touchSession(); draw(search.value); });
    draw("");
    setTimeout(() => search.focus(), 60);
  }

  function row(c, isMatch) {
    let shown = false;
    const pwText = el("span", { class: "pw-dots" }, ["••••••••"]);
    const reveal = el("button", { class: "pw-icon", title: "Reveal", html: (window.WardenIcons || {}).eye, onclick: () => { VP.touchSession(); shown = !shown; pwText.textContent = shown ? (c.password || "") : "••••••••"; } });
    const fillBtn = el("button", { class: "pw-fill", title: "Autofill on the page", onclick: () => fillActiveTab(c) }, ["Fill"]);
    return el("div", { class: "pw-row" + (isMatch ? " match" : "") }, [
      favicon(c.url || c.title),
      el("div", { class: "pw-main" }, [
        el("div", { class: "pw-title" }, [c.title || VP.hostFromUrl(c.url) || "(untitled)"]),
        el("div", { class: "pw-user" }, [c.username || c.email || "(no username)"]),
        el("div", { class: "pw-pw" }, [pwText]),
      ]),
      el("div", { class: "pw-actions" }, [
        (c.username || c.email) ? el("button", { class: "pw-icon", title: "Copy username", html: (window.WardenIcons || {}).user, onclick: () => copy(c.username || c.email, "Username") }) : null,
        el("button", { class: "pw-icon", title: "Copy password", html: (window.WardenIcons || {}).key, onclick: () => copy(c.password, "Password") }),
        reveal, fillBtn,
      ]),
    ]);
  }

  window.WardenPWPanel = { render, lock: () => VP.lock() };
})();
