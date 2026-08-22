// ─────────────────────────────────────────────────────────────────────────────
// warden-ai-prompt.js — types a prompt into an AI chat site and SUBMITS it.
//
// WHY THIS EXISTS
// TradeHub's "Launch Analysis" button used to only copy the prompt and open
// ChatGPT — you still had to press Ctrl+V + Enter yourself. A web page can't
// type into another site (cross-origin), which is exactly why the Trading Auto
// Launch (Python) used to drive it with OS-level keystrokes. A content script
// CAN, because it runs inside the AI page. So the prompt is handed to this
// script, which does the typing and the sending.
//
// TWO WAYS WORK ARRIVES
//   1. TradeHub's Launch Analysis button → background registers the prompt
//      against the new tab's id; we pull it on load.
//   2. Trading Auto Launch (launch.py) → it opens the AI tab with a #tbauto
//      marker in the URL. We can't be handed a tab id by a Python process, so
//      the marker tells the background "fetch the selected Analysis prompt from
//      the trade-dashboard worker and register it for my tab". From there it is
//      the same path as (1) — including the retry-on-reload behaviour.
//
// DELIVERY IS A PULL, NOT A PUSH
// The background can't reliably message a tab that may not have loaded yet, so
// this script asks ("anything pending for my tab?") on load and retries a few
// times to cover the case where the tab id was registered a beat after the tab
// was created. The background releases the prompt only once a submit is
// CONFIRMED, so an auth interstitial that dies mid-flight doesn't swallow it.
//
// TYPING METHOD
// Every one of these composers is a framework-controlled editor (ProseMirror,
// Quill, controlled React textarea). Writing .value or .textContent leaves the
// framework's own state empty, so the send button stays disabled and Enter
// sends nothing. document.execCommand('insertText') is routed through the
// browser's real editing pipeline and fires the same events a human keystroke
// does, so it works on all of them — plain textarea included.
//
// SENDING METHOD
// "It pasted but didn't send" is the failure this file is built around, so the
// send is a LOOP over three escalating mechanisms (button click → the form's
// own submit → synthetic Enter), re-finding the controls every round, and it
// only stops when the composer has actually emptied. One fire-and-hope click is
// never enough: the send button often hasn't mounted yet when the text lands,
// is disabled for a beat while the site registers the input, or ignores an
// untrusted click and responds only to its form's submit.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (window.__wardenAiPromptLoaded) return; window.__wardenAiPromptLoaded = true;
  // Top frame only — the composer is never in a subframe, and all_frames would
  // otherwise run this in every ad/embed iframe on the page.
  try { if (window.top !== window) return; } catch (e) { return; }

  var COMPOSER_WAIT_MS = 30000;   // cold AI page + auth redirect can be slow
  var POLL_MS          = 250;
  var PULL_TRIES       = 6;       // × PULL_GAP_MS — covers a late tab-id registration
  var PULL_GAP_MS      = 400;
  var TYPE_TRIES       = 3;       // re-type if execCommand silently no-ops
  var TYPE_ROUNDS      = 4;       // full clear → type → send cycles (see deliver)
  var SEND_READY_MS    = 4500;    // wait for the site to ENABLE its send control after typing
  var SEND_TRIES       = 10;      // × SEND_GAP_MS = 7s of firing, per round
  var SEND_GAP_MS      = 700;
  var VISIBLE_WAIT_MS  = 20000;   // background tab: let it come to the front before typing

  // The launcher's marker (launch.py opens e.g. https://chatgpt.com/#tbauto).
  // Read once at load: these SPAs rewrite the URL as soon as they boot.
  var AUTO_MARK = /(^|[#&?])tbauto\b/i;
  var isAutoLaunch = false;
  try { isAutoLaunch = AUTO_MARK.test(location.hash || '') || AUTO_MARK.test(location.search || ''); } catch (e) {}

  // Per-site selectors. First match wins; the generic finder below is the
  // safety net when a site ships a redesign, so a stale selector degrades to
  // "still works" rather than "does nothing".
  var PROFILES = [
    { name: 'ChatGPT',    test: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i,
      input: ['#prompt-textarea', 'div[contenteditable="true"]#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[data-id]'],
      send:  ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'form button[type="submit"]'] },
    { name: 'Claude',     test: /(^|\.)claude\.ai$/i,
      input: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][aria-label*="prompt" i]'],
      send:  ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]'] },
    { name: 'Gemini',     test: /(^|\.)gemini\.google\.com$/i,
      input: ['rich-textarea div[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
      send:  ['button.send-button', 'button[aria-label*="Send" i]'] },
    { name: 'Perplexity', test: /(^|\.)perplexity\.ai$/i,
      input: ['#ask-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
      send:  ['button[aria-label="Submit"]', 'button[data-testid="submit-button"]', 'button[aria-label*="Submit" i]'] },
    { name: 'Grok',       test: /(^|\.)grok\.com$|(^|\.)x\.com$/i,
      input: ['textarea[aria-label]', 'textarea', 'div[contenteditable="true"]'],
      send:  ['button[type="submit"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'] },
    { name: 'Copilot',    test: /(^|\.)copilot\.microsoft\.com$|(^|\.)bing\.com$/i,
      input: ['textarea#userInput', 'textarea[placeholder]', 'div[contenteditable="true"]'],
      send:  ['button[title*="Submit" i]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'] },
    { name: 'DeepSeek',   test: /(^|\.)deepseek\.com$/i,
      input: ['textarea#chat-input', 'textarea'],
      send:  ['div[role="button"][aria-disabled="false"]', 'button[type="submit"]'] },
    { name: 'Mistral',    test: /(^|\.)mistral\.ai$/i,
      input: ['textarea', 'div[contenteditable="true"]'],
      send:  ['button[type="submit"]', 'button[aria-label*="Send" i]'] },
  ];

  // Controls that sit right next to the send button and must NEVER be clicked.
  // Clicking the mic opens voice mode (and swallows the prompt); clicking stop
  // aborts the very answer we just asked for.
  var SEND_DENY = /speech|voice|dictat|microphone|(^|[^a-z])mic([^a-z]|$)|attach|upload|stop|cancel|abort|record/i;

  function profileFor(host) {
    for (var i = 0; i < PROFILES.length; i++) if (PROFILES[i].test.test(host)) return PROFILES[i];
    return { name: host, input: [], send: [] };
  }

  function visible(el, minW, minH) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    // minW/minH default to composer-sized. Send buttons MUST pass a much smaller
    // floor: ChatGPT's is a ~36px circular icon, so a 40px minimum silently
    // rejected it and we fell through to synthetic Enter, which ProseMirror
    // ignores — the prompt got typed in and just sat there.
    if (r.width < (minW == null ? 40 : minW) || r.height < (minH == null ? 12 : minH)) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function editable(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    return el.isContentEditable;
  }

  // Fallback composer finder for when a site's selectors have gone stale:
  // the biggest visible editable box, preferring ones that announce themselves
  // as a message/prompt input.
  function findComposerGeneric() {
    var all = [];
    try { all = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')); }
    catch (e) { return null; }
    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!editable(el) || !visible(el)) continue;
      var r = el.getBoundingClientRect();
      var hint = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' +
                  (el.getAttribute('data-testid') || '') + ' ' + (el.id || '')).toLowerCase();
      var score = r.width * r.height;
      if (/message|prompt|ask|chat|question|input/.test(hint)) score *= 4;
      if (/search|url|address/.test(hint)) score *= 0.1;   // site search box, not the composer
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function findComposer(profile) {
    for (var i = 0; i < profile.input.length; i++) {
      var list;
      try { list = document.querySelectorAll(profile.input[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) if (editable(list[j]) && visible(list[j])) return list[j];
    }
    return findComposerGeneric();
  }

  function label(el) {
    return ((el.getAttribute && (el.getAttribute('aria-label') || '')) + ' ' +
            (el.getAttribute && (el.getAttribute('title') || '')) + ' ' +
            (el.getAttribute && (el.getAttribute('data-testid') || '')) + ' ' +
            (el.id || '')).toLowerCase();
  }

  function clickable(el) {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (SEND_DENY.test(label(el))) return false;   // mic / attach / stop — never these
    return visible(el, 10, 10);
  }

  function findSend(profile) {
    var sels = profile.send.concat([
      'button[data-testid="send-button"]', 'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]', 'button[title*="Send" i]',
      'button[title*="Submit" i]', 'form button[type="submit"]',
    ]);
    for (var i = 0; i < sels.length; i++) {
      var list;
      try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) if (clickable(list[j])) return list[j];
    }
    return null;
  }

  function composerText(el) {
    if (!el) return '';
    return (el.tagName === 'TEXTAREA' ? (el.value || '') : (el.innerText || el.textContent || '')).trim();
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(fn, timeout) {
    var deadline = Date.now() + timeout;
    return new Promise(function (resolve) {
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) {}
        if (v) return resolve(v);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, POLL_MS);
      })();
    });
  }

  // Write the prompt the way a keyboard would. Selecting first means a draft
  // the composer restored from a previous session is replaced, not appended to.
  function typeInto(el, text) {
    try { el.focus(); el.click(); } catch (e) {}
    selectAll(el);
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok && el.tagName === 'TEXTAREA') {
      // Last resort for a textarea: the native value setter bypasses React's
      // property override, and the input event tells React to re-read it.
      try {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, text);
        ok = true;
      } catch (e) {}
    }
    notifyInput(el);
    return ok;
  }

  // Whitespace-normalised compare. Inserting a multi-line prompt into a
  // contenteditable turns newlines into block elements, and innerText serialises
  // those back with a DIFFERENT number of newlines than the source had. An exact
  // prefix compare therefore reports "typing failed" on text that is plainly
  // sitting in the box — which is exactly how the send got skipped entirely.
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // Put the text in and confirm something actually landed. The bar is NON-EMPTY,
  // not character-identical: a composer holding the prompt should be sent even if
  // the site reformatted it. Only a still-empty box counts as a typing failure —
  // that is the one case where there is genuinely nothing to send.
  async function ensureTyped(profile, el, text) {
    var want = norm(text).slice(0, 60);
    for (var t = 0; t < TYPE_TRIES; t++) {
      typeInto(el, text);
      await wait(250);
      var live = (el && el.isConnected) ? el : (findComposer(profile) || el);
      if (composerText(live)) {
        if (norm(composerText(live)).slice(0, 60) !== want) {
          console.warn('[Warden] AI prompt: composer text does not match the prompt exactly ' +
                       '(site reformatting or another extension) — sending what is there anyway');
        }
        return live;
      }
      el = findComposer(profile) || el;
    }
    return null;
  }

  // Nudge the framework into re-reading the DOM. execCommand already fires a
  // native input event, but a composer that mounted mid-insert can miss it —
  // and a React state that never saw the text keeps its send button disabled.
  function notifyInput(el) {
    if (!el) return;
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: null })); }
    catch (e) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {} }
  }

  function selectAll(el) {
    try {
      if (el.tagName === 'TEXTAREA') { el.focus(); el.select(); return; }
      el.focus();
      var range = document.createRange(); range.selectNodeContents(el);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } catch (e) {}
  }

  // Empty the composer so the next round starts clean. Going through
  // execCommand('delete') keeps the framework in sync — blanking .textContent
  // would leave its state holding the old value.
  function clearComposer(el) {
    if (!el || !el.isConnected) return;
    selectAll(el);
    try { document.execCommand('delete'); } catch (e) {}
    if (el.tagName === 'TEXTAREA') {
      try {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, '');
      } catch (e) {}
    }
    notifyInput(el);
  }

  function pressEnter(el) {
    if (!el) return;
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) {}
  }

  function submitForm(el) {
    var form = null;
    try { form = el && el.closest ? el.closest('form') : null; } catch (e) {}
    if (!form) return false;
    try {
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) { return false; }
  }

  // PROOF OF SENDING — read this before changing it.
  // The obvious test, "the composer's text no longer matches the prompt", is WRONG
  // and was the bug: ProseMirror re-normalises whitespace after an insert, and an
  // extension living in the same box (Grammarly, in Tony's Brave) rewrites its DOM
  // outright. Either makes the text "not match" while nothing has been sent — so
  // the send loop concluded it was already done, never clicked, and reported
  // success with the prompt still sitting there. Whether Grammarly had finished
  // its pass yet is a race, which is why it alternated run to run.
  //
  // Only two things actually prove a send: the composer went EMPTY, or the app
  // navigated to the new conversation (chatgpt.com/ → /c/<id>). Both are states
  // the site only produces after accepting the message.
  var startPath = location.pathname;

  function composerEmpty(profile, el) {
    var live = (el && el.isConnected) ? el : findComposer(profile);
    if (!live) return true;                 // composer gone entirely → it went
    return composerText(live).length === 0; // placeholders are CSS ::before, not innerText
  }

  function looksSent(profile, el) {
    if (location.pathname !== startPath) return true;
    return composerEmpty(profile, el);
  }

  // A plain .click() is enough for most React buttons, but some composers commit
  // on pointerdown/mousedown and never see a bare click. Fire the whole sequence.
  function clickHard(btn) {
    try { btn.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    var r = { left: 0, top: 0, width: 0, height: 0 };
    try { r = btn.getBoundingClientRect(); } catch (e) {}
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse',
    };
    var down = Object.assign({}, base, { buttons: 1 });
    var up   = Object.assign({}, base, { buttons: 0 });
    try { btn.dispatchEvent(new PointerEvent('pointerdown', down)); } catch (e) {}
    try { btn.dispatchEvent(new MouseEvent('mousedown', down)); } catch (e) {}
    try { btn.dispatchEvent(new PointerEvent('pointerup', up)); } catch (e) {}
    try { btn.dispatchEvent(new MouseEvent('mouseup', up)); } catch (e) {}
    try { btn.click(); } catch (e) {}
  }

  async function fireSend(profile, el) {
    // Never return "sent" before we have actually tried something — that single
    // guard is what stops a false read of the composer from silently skipping the
    // whole send.
    var tried = false;
    for (var i = 0; i < SEND_TRIES; i++) {
      if (tried && looksSent(profile, el)) return true;

      var btn = findSend(profile);
      if (btn) {
        if (i === 0) console.log('[Warden] AI prompt: clicking send —', (btn.getAttribute('data-testid') || btn.id || btn.getAttribute('aria-label') || btn.tagName));
        clickHard(btn); tried = true;
      }

      // No button (or clicking it isn't taking) → the form's own submit path,
      // then a synthetic Enter. Enter is last because ProseMirror-based
      // composers usually ignore an untrusted key event.
      if (!btn || i >= 2) {
        var live = (el && el.isConnected) ? el : (findComposer(profile) || el);
        submitForm(live);
        try { live.focus(); } catch (e) {}
        pressEnter(live);
        tried = true;
      }
      await wait(SEND_GAP_MS);
    }
    return looksSent(profile, el);
  }

  async function deliver(text) {
    var profile = profileFor(location.hostname);

    // A background tab can have a composer that hasn't laid out yet, and
    // execCommand needs a focused editable to write into. Give the tab a chance
    // to come forward, but never block on it forever — some flows legitimately
    // submit from the background.
    if (document.hidden) {
      await waitFor(function () { return !document.hidden || null; }, VISIBLE_WAIT_MS);
    }

    var el = await waitFor(function () { return findComposer(profile); }, COMPOSER_WAIT_MS);
    // Returning false leaves the prompt pending in the background, so a reload
    // (or the real app document, if this one was an auth interstitial) retries.
    if (!el) { console.warn('[Warden] AI prompt: no composer found on ' + location.hostname); return false; }

    // Let hydration finish before the first insert. The loop below recovers from
    // typing into a half-mounted composer, but each recovery costs ~10s, so it's
    // worth not walking into it.
    if (document.readyState !== 'complete') {
      await waitFor(function () { return document.readyState === 'complete' || null; }, 10000);
    }
    await wait(400);

    // WHY THIS IS A LOOP OVER *TYPING*, NOT JUST OVER SENDING
    // These composers are a DOM tree (ProseMirror) driven by a framework's own
    // copy of the text. execCommand writes the DOM and normally the framework
    // follows — but if the insert lands while the page is still hydrating, the
    // framework's state stays EMPTY while the text is plainly visible. Its send
    // button then stays disabled forever, and Enter is a no-op because the
    // handler asks the framework (not the DOM) whether there's anything to send.
    // That is the "it pasted but didn't send" state exactly, and it's a race, so
    // it hits roughly every other run. No amount of re-clicking send escapes it
    // — the only way out is to clear and type again. So each round: type, wait
    // for the site to prove it noticed by ENABLING its send control, then send.
    for (var round = 0; round < TYPE_ROUNDS; round++) {
      var last = (round === TYPE_ROUNDS - 1);

      el = findComposer(profile) || el;
      var typed = await ensureTyped(profile, el, text);
      if (!typed) {
        console.warn('[Warden] AI prompt: composer is still empty after typing (round ' + (round + 1) + ')');
        await wait(400);
        continue;
      }
      el = typed;

      // The readiness proof. On the last round we go ahead regardless, so a site
      // with no send button at all still gets the Enter path rather than nothing.
      var ready = await waitFor(function () { return findSend(profile); }, SEND_READY_MS);
      if (!ready && !last) {
        console.warn('[Warden] AI prompt: text is in the box but ' + profile.name +
                     ' never enabled its send control — clearing and retyping (round ' + (round + 1) + ')');
        clearComposer(el);
        await wait(350);
        continue;
      }

      if (await fireSend(profile, el)) {
        // Only now tell the background it's done — a failed attempt must stay
        // pending so the next document (or a reload) can have another go.
        report();
        console.log('[Warden] AI prompt submitted on ' + profile.name + ' (round ' + (round + 1) + ')');
        return true;
      }
      if (!last) {
        console.warn('[Warden] AI prompt: send did not take on round ' + (round + 1) + ' — retyping');
        clearComposer(el);
        await wait(350);
      }
    }

    console.warn('[Warden] AI prompt: typed it in, but no send control fired — press Enter yourself. ' +
                 'Send button found: ' + !!findSend(profile));
    return false;   // stays pending, so a reload retries
  }

  function report() {
    try { chrome.runtime.sendMessage({ action: 'wardenAiPromptDone' }, function () { void chrome.runtime.lastError; }); }
    catch (e) {}
  }

  function ask(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp && resp.text ? String(resp.text) : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Ask the background whether this tab was opened to receive a prompt.
  function pull() { return ask({ action: 'wardenAiPromptPending' }); }

  // Launcher path: tell the background this tab carries the #tbauto marker, so
  // it fetches the selected TradeHub Analysis prompt and registers it for us
  // (which also arms the same retry-on-reload machinery as the TradeHub path).
  function claimAutoLaunch() { return ask({ action: 'wardenAiAutoSubmit' }); }

  // Stamp the build into the console. "Did the extension reload?" has cost real
  // debugging time — this answers it at a glance, in the same place as everything
  // else this script logs.
  function ver() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  }

  (async function () {
    if (isAutoLaunch) {
      var auto = await claimAutoLaunch();
      if (auto) {
        console.log('[Warden v' + ver() + '] AI prompt: auto-launch marker — ' + auto.length + ' chars from the Analysis config');
        deliver(auto);
        return;
      }
      console.warn('[Warden] AI prompt: #tbauto marker present but no Analysis prompt was available.');
    }
    for (var i = 0; i < PULL_TRIES; i++) {
      var text = await pull();
      if (text) {
        console.log('[Warden v' + ver() + '] AI prompt: ' + text.length + ' chars pending for this tab');
        deliver(text);
        return;
      }
      await wait(PULL_GAP_MS);
    }
  })();
})();
