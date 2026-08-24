// ─────────────────────────────────────────────────────────────────────────────
// content.js — Warden extension · inline autofill dropdowns (logins + payments)
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
//   ID DOCS  — focus a licence / passport / policy-number field, or a file
//              upload that takes an image or PDF → your saved ID documents.
//              Picking one fills the form's identity fields, or drops the
//              actual decrypted SCAN into the upload field.
//
// ── What this script is trusted with ────────────────────────────────────────
// Logins keep their existing contract: the background hands over the specific
// username/password for the current domain, which this script writes into the
// page.
//
// Payments are stricter. This script NEVER receives a card number, CVV or
// billing address — only masked summaries (nickname, network, last 4, expiry)
// to draw the list. When you pick a card, it sends just the item id; the
// background decrypts and fills the fields itself (see wardenFillCard). So a
// compromised page context has nothing to steal here even mid-checkout.
//
// ID documents follow the payments rule for TEXT — masked summaries only, and
// the background does the filling. The ONE exception is attaching a scan to an
// upload field: a File can only be built in the frame that owns the input, so
// those bytes do arrive here. They are turned into a File, written into the
// input, and dropped — and the page was going to receive them anyway, because
// handing the document to that form is exactly what the user chose to do.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (window.__wardenAutofillLoaded) return; window.__wardenAutofillLoaded = true;

  // NEVER offer autofill on the Warden app itself — filling the warden's own
  // master-password field would be a security hole.
  // Her Pages host. The overlay excludes Warden's own origin so it never
  // tries to autofill the vault into itself.
  const WARDEN_APP_HOSTS = [String((self.WARDEN_CFG || {}).BIO_RP_ID || "").replace(/^https?:\/\//, "")].filter(Boolean);
  if (WARDEN_APP_HOSTS.some((h) => location.hostname === h || location.hostname.endsWith("." + h))) return;

  // Logins stay top-frame-only (exactly as before all_frames was enabled).
  let IS_TOP = true;
  try { IS_TOP = window.top === window; } catch (e) { IS_TOP = false; }

  const host = location.hostname.replace(/^www\./, "");
  let box = null, shadow = null, anchor = null, hideTimer = null, mode = "login";

  // Ask the background for live matches on EVERY focus (no persistent cache), so
  // a just-unlocked warden works without reloading and a lock takes effect on the
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
    return ask({ action: "wardenGetCreds", host }, { unlocked: false, creds: [] })
      .then((r) => ({ unlocked: !!r.unlocked, creds: r.creds || [] }));
  }
  function getCards() {
    return ask({ action: "wardenGetCards" }, { unlocked: false, cards: [] })
      .then((r) => ({ unlocked: !!r.unlocked, cvvFresh: !!r.cvvFresh, cards: r.cards || [] }));
  }
  function getIdDocs() {
    return ask({ action: "wardenGetIdDocs" }, { unlocked: false, docs: [] })
      .then((r) => ({ unlocked: !!r.unlocked, authFresh: !!r.authFresh, docs: r.docs || [] }));
  }
  // The popup broadcasts here when you unlock/lock so an OPEN dropdown updates
  // instantly (hide on lock; re-render on unlock if a field is focused).
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;

      if (msg.action === "wardenLockChanged") {
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
      if (msg.action === "wardenDoFillCard") {
        let out = { filled: 0, cvv: false };
        try { if (self.WardenCardFill) out = self.WardenCardFill.fill(msg.values); } catch (e) {}
        if (out && out.filled > 0) { sendResponse(out); hide(); return true; }
        return;
      }

      // Same contract for ID documents: a frame with nothing to fill stays
      // SILENT, so the frame that owns the form wins the broadcast reply.
      if (msg.action === "wardenDoFillIdDoc") {
        let out = { filled: 0, number: false };
        try { if (self.WardenIdFill) out = self.WardenIdFill.fill(msg.values); } catch (e) {}
        if (out && out.filled > 0) { sendResponse(out); hide(); return true; }
        return;
      }

      // Attach a decrypted scan to this frame's upload field. Prefers the field
      // the dropdown is anchored to; otherwise the first upload field that will
      // accept the file's type.
      if (msg.action === "wardenDoAttachIdFile") {
        try {
          if (!self.WardenIdFill) return;
          const f = msg.file || {};
          const target = pickFileInput(f.mime, f.name);
          if (!target) return;                       // silent — another frame may have one
          const file = self.WardenIdFill.fileFromBase64(f.b64, f.name, f.mime);
          const ok = self.WardenIdFill.attachFile(target, file);
          sendResponse({ ok, error: ok ? null : "attach-failed" });
          if (ok) hide();
          return true;
        } catch (e) { return; }
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
    try { return !!(self.WardenCardFill && self.WardenCardFill.isCardField(elm)); } catch (e) { return false; }
  }
  function isIdField(elm) {
    try { return !!(self.WardenIdFill && self.WardenIdFill.isIdField(elm)); } catch (e) { return false; }
  }
  // An unmistakable identity field (a "Driver's licence number" box) is worth
  // telling the user their warden is locked; a maybe-field is not.
  function isStrongIdField(elm) {
    try { return !!(self.WardenIdFill && self.WardenIdFill.isStrong(self.WardenIdFill.classify(elm))); } catch (e) { return false; }
  }
  // Which dropdown (if any) this field wants. Card fields are checked FIRST so a
  // CVV input that a site marked type="password" (with autocomplete="cc-csc")
  // offers cards rather than logins. ID docs come next: warden-idfill.js already
  // refuses anything the card filler claimed, so a checkout's State/ZIP can
  // never be hijacked away from Payments.
  function fieldMode(elm) {
    if (isCardField(elm)) return "payment";
    if (isIdField(elm)) return "iddoc";
    if (IS_TOP && isLoginField(elm)) return "login";
    return "";
  }
  // The upload field a scan should go into: the one the dropdown is anchored to
  // if it takes this type, else the first visible one on the page that does.
  function pickFileInput(mime, name) {
    const IF = self.WardenIdFill;
    if (!IF) return null;
    if (anchor && IF.isIdFileField(anchor) && IF.fileAccepts(anchor, mime, name)) return anchor;
    const all = document.querySelectorAll('input[type="file"]');
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (!IF.isIdFileField(e) || !IF.fileAccepts(e, mime, name)) continue;
      if (e.offsetParent === null) {
        // File inputs are very often visually hidden behind a styled button;
        // a zero-size one is still the real target, so only skip display:none
        // that also has no rect.
        const r = e.getBoundingClientRect();
        if (!r.width && !r.height && getComputedStyle(e).display === "none" && !e.labels?.length) continue;
      }
      return e;
    }
    return null;
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
    const r = await ask({ action: "wardenFillCard", id: card.id }, { ok: false });
    if (r.ok && !r.cvvFilled && r.cvvFresh === false) {
      // Everything but the security code went in — say so instead of failing.
      note("Filled without the security code — unlock Warden again to include it.");
      setTimeout(hide, 2600);
      return;
    }
    if (!r.ok) { note(r.locked ? "Warden locked — open the Warden popup to unlock." : "No card fields found here."); setTimeout(hide, 2200); return; }
    hide();
  }
  // ID docs: like cards, we send only the id. For a text form the background
  // fills it; for an upload field it sends back the decrypted bytes to attach.
  async function useIdDoc(doc) {
    const wrap = shadow && shadow.getElementById("wrap");
    if (wrap) wrap.querySelectorAll(".v-item").forEach((n) => { n.style.opacity = ".5"; n.style.pointerEvents = "none"; });
    const wantsFile = !!(anchor && self.WardenIdFill && self.WardenIdFill.isIdFileField(anchor));
    if (wantsFile) {
      if (!doc.files) { note("That document has no scan saved yet."); setTimeout(hide, 2400); return; }
      note("Decrypting scan…");
      const r = await ask({ action: "wardenAttachIdFile", id: doc.id }, { ok: false });
      if (!r.ok) {
        note(r.locked ? "Warden locked — open the Warden popup to unlock."
          : r.error === "pending" ? "That scan hasn't finished uploading yet."
          : r.error === "too-large" ? "That scan is too large to attach."
          : "Couldn't attach that scan here.");
        setTimeout(hide, 2600);
        return;
      }
      hide();
      return;
    }
    const r = await ask({ action: "wardenFillIdDoc", id: doc.id }, { ok: false });
    if (r.ok && r.numberWithheld) {
      note("Filled without the number — unlock Warden again to include it.");
      setTimeout(hide, 2600);
      return;
    }
    if (!r.ok) { note(r.locked ? "Warden locked — open the Warden popup to unlock." : "No ID fields found here."); setTimeout(hide, 2200); return; }
    hide();
  }
  function note(text) {
    const wrap = shadow && shadow.getElementById("wrap");
    if (!wrap) return;
    wrap.innerHTML = '<div class="v-head">' + headIcon() + esc(headLabel()) + '</div><div class="v-msg">' + esc(text) + "</div>";
  }

  // ── dropdown UI (Shadow DOM, isolated from page CSS) ───────────────────────
  function ensureBox() {
    if (box) return;
    box = document.createElement("div");
    box.style.cssText = "position:absolute;z-index:2147483647;top:0;left:0;";
    shadow = box.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .v-wrap{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#26272A;border:1px solid #4A4B52;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;min-width:230px;max-width:340px}
      .v-head{display:flex;align-items:center;gap:6px;padding:8px 11px;border-bottom:1px solid #3D3E43;color:#8D769A;font-size:11px;font-weight:800;letter-spacing:.3px}
      .v-dot{width:14px;height:14px}
      .v-item{display:flex;align-items:center;gap:9px;padding:9px 11px;cursor:pointer;border-top:1px solid #303135}
      .v-item:first-of-type{border-top:none}
      .v-item:hover{background:#303135}
      .v-ic{width:18px;height:18px;border-radius:4px;background:#303135;flex-shrink:0}
      .v-mark{width:30px;height:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
      .v-mark svg{width:30px;height:20px;display:block}
      .v-idthumb{width:30px;height:21px;border-radius:4px;overflow:hidden;flex-shrink:0;background:#303135;position:relative}
      .v-idthumb img{width:100%;height:100%;object-fit:cover;filter:blur(4px);transform:scale(1.25)}
      .v-idthumb::after{content:"";position:absolute;inset:0;background:rgba(26,26,29,.32)}
      .v-txt{min-width:0;flex:1}
      .v-t{font-size:12.5px;font-weight:700;color:#ECECEE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .v-u{font-size:11px;color:#AFB0B5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;font-variant-numeric:tabular-nums}
      .v-exp{font-size:10px;font-weight:700;color:#76777C;flex-shrink:0;font-variant-numeric:tabular-nums}
      .v-exp.warn{color:#8D769A}
      .v-exp.bad{color:#E74C3C}
      .v-star{color:#8D769A;flex-shrink:0;line-height:0;display:inline-flex;margin-right:5px}.v-star svg{width:11px;height:11px;display:block}
      .v-msg{padding:11px;color:#AFB0B5;font-size:12px;line-height:1.5}
      .v-msg b{color:#ECECEE}
      .v-foot{padding:6px 11px;border-top:1px solid #3D3E43;color:#76777C;font-size:9.5px;text-align:right}
    `;
    shadow.appendChild(style);
    const wrap = document.createElement("div"); wrap.className = "v-wrap"; wrap.id = "wrap";
    shadow.appendChild(wrap);
    // keep focus in the page field while interacting
    box.addEventListener("mousedown", (e) => e.preventDefault());
    document.documentElement.appendChild(box);
  }
  function keyIconSVG() {
    return '<svg class="v-dot" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="#8D769A" stroke-width="2"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>';
  }
  function cardIconSVG() {
    return '<svg class="v-dot" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="#8D769A" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';
  }
  function idIconSVG() {
    return '<svg class="v-dot" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="#8D769A" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.3 1.8-2 3-2s2.4.7 3 2"/><path d="M14 10h5"/><path d="M14 13.5h5"/></svg>';
  }
  function headIcon() { return mode === "payment" ? cardIconSVG() : mode === "iddoc" ? idIconSVG() : keyIconSVG(); }
  function headLabel() { return mode === "payment" ? "Warden Payments" : mode === "iddoc" ? "Warden ID Docs" : "Warden Autofill"; }

  function renderLogins(state) {
    let html = '<div class="v-head">' + keyIconSVG() + "Warden Autofill</div>";
    if (state.unlocked && state.creds.length) {
      html += state.creds.map((c, i) =>
        '<div class="v-item" data-i="' + i + '"><img class="v-ic" src="' + (function(h){h=String(h||'').replace(/^www\./,'');if(!h)return '';var n=0;for(var i=0;i<h.length;i++)n=(n*31+h.charCodeAt(i))>>>0;var c=/^[a-z0-9]/i.test(h)?h.charAt(0).toUpperCase():'#';return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +'<rect width="64" height="64" rx="14" fill="'+['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6','#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'][n%16]+'"/>' +'<text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="600" fill="#2e2833" text-anchor="middle">'+c+'</text></svg>');})(host) + '" alt=""><div class="v-txt"><div class="v-t">' +
        esc(c.title || host) + '</div><div class="v-u">' + esc(c.username || "(no username)") + "</div></div></div>"
      ).join("");
      html += '<div class="v-foot">' + state.creds.length + " login" + (state.creds.length === 1 ? "" : "s") + " · Warden</div>";
    } else if (state.unlocked) {
      html += '<div class="v-msg">No saved logins for <b>' + esc(host) + "</b>.</div>";
    } else {
      html += '<div class="v-msg">Warden is locked. Click the <b>Warden</b> toolbar icon → <b>Passwords</b> to unlock, then reload.</div>';
    }
    return html;
  }
  function renderCards(state) {
    let html = '<div class="v-head">' + cardIconSVG() + "Warden Payments</div>";
    if (state.unlocked && state.cards.length) {
      html += state.cards.map((c, i) => {
        const cls = c.expiryState === "expired" ? " bad" : c.expiryState === "expiring" ? " warn" : "";
        return '<div class="v-item" data-i="' + i + '"><span class="v-mark">' + (c.mark || "") + '</span><div class="v-txt"><div class="v-t">' +
          (c.favorite ? '<span class="v-star"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/></svg></span>' : "") + esc(c.title) +
          '</div><div class="v-u">' + esc(c.masked || c.subtitle) + '</div></div>' +
          (c.expiry ? '<span class="v-exp' + cls + '">' + esc(c.expiryState === "expired" ? "EXP" : c.expiry) + "</span>" : "") + "</div>";
      }).join("");
      html += '<div class="v-foot">' + (state.cvvFresh ? "" : "Security code needs a fresh unlock · ") +
        state.cards.length + " card" + (state.cards.length === 1 ? "" : "s") + " · Warden</div>";
    } else if (state.unlocked) {
      html += '<div class="v-msg">No saved payment methods. Add one in the <b>Warden app → Payments</b>.</div>';
    } else {
      html += '<div class="v-msg">Warden is locked. Click the <b>Warden</b> toolbar icon → <b>Payments</b> to unlock, then reload.</div>';
    }
    return html;
  }
  // The scan is shown BLURRED here exactly as it is in the app and the popup —
  // a dropdown on a random web page is the last place a readable licence should
  // appear.
  function renderIdDocs(state, wantsFile) {
    let html = '<div class="v-head">' + idIconSVG() + "Warden ID Docs</div>";
    const list = wantsFile ? state.docs.filter((d) => d.files > 0) : state.docs;
    if (state.unlocked && list.length) {
      html += list.map((d) => {
        const cls = d.expiryState === "expired" ? " bad" : d.expiryState === "expiring" ? " warn" : "";
        const mark = d.thumb
          ? '<span class="v-idthumb"><img src="' + esc(d.thumb) + '" alt=""></span>'
          : '<span class="v-mark">' + idIconSVG() + "</span>";
        const sub = wantsFile
          ? d.files + " file" + (d.files === 1 ? "" : "s")
          : (d.masked || d.subtitle || d.typeLabel);
        return '<div class="v-item" data-id="' + esc(d.id) + '">' + mark +
          '<div class="v-txt"><div class="v-t">' + esc(d.title) + "</div>" +
          '<div class="v-u">' + esc(sub) + "</div></div>" +
          (d.expiry ? '<span class="v-exp' + cls + '">' + esc(d.expiryState === "expired" ? "EXP" : d.expiry) + "</span>" : "") +
          "</div>";
      }).join("");
      html += '<div class="v-foot">' + (wantsFile ? "Attaches the decrypted scan · " : "") +
        list.length + " document" + (list.length === 1 ? "" : "s") + " · Warden</div>";
    } else if (state.unlocked) {
      html += '<div class="v-msg">' + (wantsFile
        ? "None of your ID documents have a scan saved. Add one in the <b>Warden app → ID Docs</b>."
        : "No ID documents yet. Add one in the <b>Warden app → ID Docs</b>.") + "</div>";
    } else {
      html += '<div class="v-msg">Warden is locked. Click the <b>Warden</b> toolbar icon → <b>ID Docs</b> to unlock, then reload.</div>';
    }
    return html;
  }
  function render(state) {
    ensureBox();
    const wrap = shadow.getElementById("wrap");
    const wantsFile = !!(anchor && self.WardenIdFill && self.WardenIdFill.isIdFileField(anchor));
    wrap.innerHTML = mode === "payment" ? renderCards(state)
      : mode === "iddoc" ? renderIdDocs(state, wantsFile)
      : renderLogins(state);
    wrap.querySelectorAll(".v-item").forEach((n) => n.addEventListener("click", () => {
      if (mode === "iddoc") {
        const doc = state.docs.filter((d) => d.id === n.getAttribute("data-id"))[0];
        if (doc) useIdDoc(doc);
        return;
      }
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
    if (m === "iddoc") {
      const state = await getIdDocs();
      const wantsFile = !!(self.WardenIdFill && self.WardenIdFill.isIdFileField(elm));
      // Don't interrupt with an empty offer. An upload field is a weak signal —
      // most file inputs on the web are not asking for an ID — so it only opens
      // when there is actually a scan to hand over.
      if (wantsFile) {
        if (!state.unlocked || !state.docs.some((d) => d.files > 0)) { hide(); return; }
      } else if (!state.unlocked && !isStrongIdField(elm)) { hide(); return; }
      else if (state.unlocked && !state.docs.length) { hide(); return; }
      render(state); position();
      return;
    }
    if (m === "payment") {
      const state = await getCards();
      // Only interrupt a checkout when we have something to offer, or when the
      // field is unmistakably a card number and the warden just needs unlocking.
      const isNumber = self.WardenCardFill && self.WardenCardFill.classify(elm) === "cc-number";
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
