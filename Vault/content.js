// ─────────────────────────────────────────────────────────────────────────────
// content.js — Vault extension · inline autofill dropdowns (logins + payments)
//
// Two independent offers share one Shadow-DOM popover:
//
//   LOGINS   — focus a username/password field → your saved logins for this
//              site. Unchanged from before, and still TOP-FRAME ONLY, so
//              enabling all_frames for payments cannot alter password
//              behaviour anywhere.
//   PAYMENTS — focus a card field on a checkout → your saved cards. Runs in
//              EVERY frame, because hosted card fields (Stripe/Braintree/Adyen)
//              live in their own iframes.
//
// ── What this script is trusted with ────────────────────────────────────────
// Logins keep their existing contract: the background hands over the specific
// username/password for the current domain, which this script writes into the
// page.
//
// Payments are stricter. This script NEVER receives a card number, CVV or
// billing address — only masked summaries (nickname, network, last 4, expiry)
// to draw the list. When you pick a card, it sends just the item id; the
// background decrypts and fills the fields itself (see vaultFillCard). So a
// compromised page context has nothing to steal here even mid-checkout.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (window.__vaultAutofillLoaded) return; window.__vaultAutofillLoaded = true;

  // NEVER offer autofill on the Vault app itself — filling the vault's own
  // master-password field would be a security hole.
  const VAULT_APP_HOSTS = ["anthonyn99.github.io"];
  if (VAULT_APP_HOSTS.some((h) => location.hostname === h || location.hostname.endsWith("." + h))) return;

  // Logins stay top-frame-only (exactly as before all_frames was enabled).
  let IS_TOP = true;
  try { IS_TOP = window.top === window; } catch (e) { IS_TOP = false; }

  const host = location.hostname.replace(/^www\./, "");
  let box = null, shadow = null, anchor = null, hideTimer = null, mode = "login";

  // Ask the background for live matches on EVERY focus (no persistent cache), so
  // a just-unlocked vault works without reloading and a lock takes effect on the
  // next focus. `chrome.storage.session.onChanged` does NOT fire in content
  // scripts (untrusted context), which is why we don't rely on it.
  function ask(msg, fallback) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError || !resp) return res(fallback);
          res(resp);
        });
      } catch (e) { res(fallback); }
    });
  }
  function getCreds() {
    return ask({ action: "vaultGetCreds", host }, { unlocked: false, creds: [] })
      .then((r) => ({ unlocked: !!r.unlocked, creds: r.creds || [] }));
  }
  function getCards() {
    return ask({ action: "vaultGetCards" }, { unlocked: false, cards: [] })
      .then((r) => ({ unlocked: !!r.unlocked, cvvFresh: !!r.cvvFresh, cards: r.cards || [] }));
  }
  // The popup broadcasts here when you unlock/lock so an OPEN dropdown updates
  // instantly (hide on lock; re-render on unlock if a field is focused).
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;

      if (msg.action === "vaultLockChanged") {
        if (!msg.unlocked) { hide(); return; }
        const active = document.activeElement;
        if (active && fieldMode(active)) show(active);
        return;
      }

      // The background decrypted a card and is handing it to this frame's
      // filler. The values go straight into fill() — nothing is retained here.
      //
      // A frame with no card fields answers NOTHING on purpose: the background
      // broadcasts to the whole tab for the popup's Fill button, so staying
      // silent is how the frame that actually owns the checkout wins the reply.
      if (msg.action === "vaultDoFillCard") {
        let out = { filled: 0, cvv: false };
        try { if (self.VaultCardFill) out = self.VaultCardFill.fill(msg.values); } catch (e) {}
        if (out && out.filled > 0) { sendResponse(out); hide(); return true; }
        return;
      }
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
  function isCardField(elm) {
    try { return !!(self.VaultCardFill && self.VaultCardFill.isCardField(elm)); } catch (e) { return false; }
  }
  // Which dropdown (if any) this field wants. Card fields are checked FIRST so a
  // CVV input that a site marked type="password" (with autocomplete="cc-csc")
  // offers cards rather than logins.
  function fieldMode(elm) {
    if (isCardField(elm)) return "payment";
    if (IS_TOP && isLoginField(elm)) return "login";
    return "";
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
  // Payments: we only send the id. The background decrypts and fills this frame.
  async function fillCard(card) {
    const wrap = shadow && shadow.getElementById("wrap");
    if (wrap) wrap.querySelectorAll(".v-item").forEach((n) => { n.style.opacity = ".5"; n.style.pointerEvents = "none"; });
    const r = await ask({ action: "vaultFillCard", id: card.id }, { ok: false });
    if (r.ok && !r.cvvFilled && r.cvvFresh === false) {
      // Everything but the security code went in — say so instead of failing.
      note("Filled without the security code — unlock Vault again to include it.");
      setTimeout(hide, 2600);
      return;
    }
    if (!r.ok) { note(r.locked ? "Vault locked — open the Vault popup to unlock." : "No card fields found here."); setTimeout(hide, 2200); return; }
    hide();
  }
  function note(text) {
    const wrap = shadow && shadow.getElementById("wrap");
    if (!wrap) return;
    wrap.innerHTML = '<div class="v-head">' + headIcon() + esc(mode === "payment" ? "Vault Payments" : "Vault Autofill") + '</div><div class="v-msg">' + esc(text) + "</div>";
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
      .v-mark{width:30px;height:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
      .v-mark svg{width:30px;height:20px;display:block}
      .v-txt{min-width:0;flex:1}
      .v-t{font-size:12.5px;font-weight:700;color:#ececf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .v-u{font-size:11px;color:#9898a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;font-variant-numeric:tabular-nums}
      .v-exp{font-size:10px;font-weight:700;color:#58586a;flex-shrink:0;font-variant-numeric:tabular-nums}
      .v-exp.warn{color:#e0a052}
      .v-exp.bad{color:#e05252}
      .v-star{color:#E0607A;font-size:10px;flex-shrink:0}
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
  function cardIconSVG() {
    return '<svg class="v-dot" viewBox="0 0 24 24" fill="none" stroke="#E0607A" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';
  }
  function headIcon() { return mode === "payment" ? cardIconSVG() : keyIconSVG(); }

  function renderLogins(state) {
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
    return html;
  }
  function renderCards(state) {
    let html = '<div class="v-head">' + cardIconSVG() + "Vault Payments</div>";
    if (state.unlocked && state.cards.length) {
      html += state.cards.map((c, i) => {
        const cls = c.expiryState === "expired" ? " bad" : c.expiryState === "expiring" ? " warn" : "";
        return '<div class="v-item" data-i="' + i + '"><span class="v-mark">' + (c.mark || "") + '</span><div class="v-txt"><div class="v-t">' +
          (c.favorite ? '<span class="v-star">★ </span>' : "") + esc(c.title) +
          '</div><div class="v-u">' + esc(c.masked || c.subtitle) + '</div></div>' +
          (c.expiry ? '<span class="v-exp' + cls + '">' + esc(c.expiryState === "expired" ? "EXP" : c.expiry) + "</span>" : "") + "</div>";
      }).join("");
      html += '<div class="v-foot">' + (state.cvvFresh ? "" : "Security code needs a fresh unlock · ") +
        state.cards.length + " card" + (state.cards.length === 1 ? "" : "s") + " · Vault</div>";
    } else if (state.unlocked) {
      html += '<div class="v-msg">No saved payment methods. Add one in <b>TaskHub → Vault → Payments</b>.</div>';
    } else {
      html += '<div class="v-msg">Vault is locked. Click the <b>Vault</b> toolbar icon → <b>Payments</b> to unlock, then reload.</div>';
    }
    return html;
  }
  function render(state) {
    ensureBox();
    const wrap = shadow.getElementById("wrap");
    wrap.innerHTML = mode === "payment" ? renderCards(state) : renderLogins(state);
    wrap.querySelectorAll(".v-item").forEach((n) => n.addEventListener("click", () => {
      const item = (mode === "payment" ? state.cards : state.creds)[+n.getAttribute("data-i")];
      if (item) (mode === "payment" ? fillCard : fill)(item);
    }));
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
    const m = fieldMode(elm);
    if (!m) { hide(); return; }
    mode = m; anchor = elm;
    if (m === "payment") {
      const state = await getCards();
      // Only interrupt a checkout when we have something to offer, or when the
      // field is unmistakably a card number and the vault just needs unlocking.
      const isNumber = self.VaultCardFill && self.VaultCardFill.classify(elm) === "cc-number";
      if (!state.cards.length && !isNumber) { hide(); return; }
      render(state); position();
      return;
    }
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
    if (fieldMode(t)) { clearTimeout(hideTimer); show(t); }
  }, true);
  document.addEventListener("focusout", () => { hideTimer = setTimeout(hide, 150); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  document.addEventListener("mousedown", (e) => { if (box && !box.contains(e.target) && e.target !== anchor) hide(); }, true);
  window.addEventListener("scroll", () => { if (anchor && box && box.style.display !== "none") position(); }, true);
  window.addEventListener("resize", () => { if (anchor && box && box.style.display !== "none") position(); });
})();
