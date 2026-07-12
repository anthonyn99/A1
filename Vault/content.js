// ─────────────────────────────────────────────────────────────────────────────
// content.js — Vault extension · inline autofill dropdown
//
// When you focus a username/password field on any page, this shows a small
// "Vault Autofill" dropdown anchored to the field, listing your saved logins
// for the current site. Click one to fill. Credentials are decrypted by the
// background service worker using the 30-minute idle session — this content
// script never has the master password or the vault key, only the specific
// username/password strings for the current domain (fetched on demand).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (window.__vaultAutofillLoaded) return; window.__vaultAutofillLoaded = true;

  const host = location.hostname.replace(/^www\./, "");
  let box = null, shadow = null, anchor = null, hideTimer = null;

  // Ask the background for live matches on EVERY focus (no persistent cache), so
  // a just-unlocked vault works without reloading and a lock takes effect on the
  // next focus. `chrome.storage.session.onChanged` does NOT fire in content
  // scripts (untrusted context), which is why we don't rely on it.
  function getCreds() {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ action: "vaultGetCreds", host }, (resp) => {
          if (chrome.runtime.lastError || !resp) return res({ unlocked: false, creds: [] });
          res({ unlocked: !!resp.unlocked, creds: resp.creds || [] });
        });
      } catch (e) { res({ unlocked: false, creds: [] }); }
    });
  }
  // The popup broadcasts here when you unlock/lock so an OPEN dropdown updates
  // instantly (hide on lock; re-render on unlock if a field is focused).
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.action !== "vaultLockChanged") return;
      if (!msg.unlocked) { hide(); return; }
      const active = document.activeElement;
      if (active && isLoginField(active)) show(active);
    });
  } catch (e) {}

  // ── field detection ────────────────────────────────────────────────────────
  function isLoginField(elm) {
    if (!elm || elm.tagName !== "INPUT") return false;
    const t = (elm.type || "text").toLowerCase();
    if (t === "password") return true;
    if (t === "email") return true;
    if (t === "text") {
      const hay = ((elm.name || "") + " " + (elm.id || "") + " " + (elm.autocomplete || "") + " " + (elm.placeholder || "")).toLowerCase();
      if (/user|email|login|account|phone/.test(hay)) return true;
      // a text field that shares a form with a password field is likely the username
      if (elm.form && elm.form.querySelector('input[type="password"]')) return true;
    }
    return false;
  }
  function fieldsFor(elm) {
    const scope = elm.form || document;
    const pw = scope.querySelector('input[type="password"]');
    let user = scope.querySelector('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]');
    if (!user) {
      const texts = Array.prototype.slice.call(scope.querySelectorAll('input[type="text"], input:not([type])')).filter((e) => e.offsetParent !== null);
      user = texts[0] || null;
    }
    return { user, pw };
  }
  function setVal(input, val) {
    if (!input) return;
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, val);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fill(cred) {
    const f = fieldsFor(anchor);
    if (f.user && cred.username) setVal(f.user, cred.username);
    if (f.pw && cred.password) setVal(f.pw, cred.password);
    hide();
  }

  // ── dropdown UI (Shadow DOM, isolated from page CSS) ───────────────────────
  function ensureBox() {
    if (box) return;
    box = document.createElement("div");
    box.style.cssText = "position:absolute;z-index:2147483647;top:0;left:0;";
    shadow = box.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .v-wrap{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#141418;border:1px solid #323240;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;min-width:230px;max-width:340px}
      .v-head{display:flex;align-items:center;gap:6px;padding:8px 11px;border-bottom:1px solid #252530;color:#E0607A;font-size:11px;font-weight:800;letter-spacing:.3px}
      .v-dot{width:14px;height:14px}
      .v-item{display:flex;align-items:center;gap:9px;padding:9px 11px;cursor:pointer;border-top:1px solid #1c1c22}
      .v-item:first-of-type{border-top:none}
      .v-item:hover{background:#1e1e26}
      .v-ic{width:18px;height:18px;border-radius:4px;background:#202028;flex-shrink:0}
      .v-txt{min-width:0;flex:1}
      .v-t{font-size:12.5px;font-weight:700;color:#ececf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .v-u{font-size:11px;color:#9898a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
      .v-msg{padding:11px;color:#9898a8;font-size:12px;line-height:1.5}
      .v-msg b{color:#ececf0}
      .v-foot{padding:6px 11px;border-top:1px solid #252530;color:#58586a;font-size:9.5px;text-align:right}
    `;
    shadow.appendChild(style);
    const wrap = document.createElement("div"); wrap.className = "v-wrap"; wrap.id = "wrap";
    shadow.appendChild(wrap);
    // keep focus in the page field while interacting
    box.addEventListener("mousedown", (e) => e.preventDefault());
    document.documentElement.appendChild(box);
  }
  function keyIconSVG() {
    return '<svg class="v-dot" viewBox="0 0 24 24" fill="none" stroke="#E0607A" stroke-width="2"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>';
  }
  function render(state) {
    ensureBox();
    const wrap = shadow.getElementById("wrap");
    let html = '<div class="v-head">' + keyIconSVG() + "Vault Autofill</div>";
    if (state.unlocked && state.creds.length) {
      html += state.creds.map((c, i) =>
        '<div class="v-item" data-i="' + i + '"><img class="v-ic" src="https://www.google.com/s2/favicons?sz=32&domain=' + encodeURIComponent(host) + '" alt=""><div class="v-txt"><div class="v-t">' +
        esc(c.title || host) + '</div><div class="v-u">' + esc(c.username || "(no username)") + "</div></div></div>"
      ).join("");
      html += '<div class="v-foot">' + state.creds.length + " login" + (state.creds.length === 1 ? "" : "s") + " · Vault</div>";
    } else if (state.unlocked) {
      html += '<div class="v-msg">No saved logins for <b>' + esc(host) + "</b>.</div>";
    } else {
      html += '<div class="v-msg">Vault is locked. Click the <b>Vault</b> toolbar icon → <b>Passwords</b> to unlock, then reload.</div>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll(".v-item").forEach((n) => n.addEventListener("click", () => fill(state.creds[+n.getAttribute("data-i")])));
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function position() {
    if (!box || !anchor) return;
    const r = anchor.getBoundingClientRect();
    box.style.top = (window.scrollY + r.bottom + 4) + "px";
    box.style.left = (window.scrollX + r.left) + "px";
    box.style.display = "block";
  }
  function hide() { if (box) box.style.display = "none"; anchor = null; }

  async function show(elm) {
    anchor = elm;
    const state = await getCreds();
    // Don't pop up on unrelated text fields when locked or no matches — only for
    // password fields (always) or when we actually have matches.
    const isPw = (elm.type || "").toLowerCase() === "password";
    if (!isPw && (!state.unlocked || !state.creds.length)) { hide(); return; }
    if (state.unlocked && !state.creds.length && !isPw) { hide(); return; }
    render(state);
    position();
  }

  // ── events ─────────────────────────────────────────────────────────────────
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (isLoginField(t)) { clearTimeout(hideTimer); show(t); }
  }, true);
  document.addEventListener("focusout", () => { hideTimer = setTimeout(hide, 150); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  document.addEventListener("mousedown", (e) => { if (box && !box.contains(e.target) && e.target !== anchor) hide(); }, true);
  window.addEventListener("scroll", () => { if (anchor && box && box.style.display !== "none") position(); }, true);
  window.addEventListener("resize", () => { if (anchor && box && box.style.display !== "none") position(); });
})();
