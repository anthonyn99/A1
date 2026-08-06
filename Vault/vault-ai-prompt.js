// ─────────────────────────────────────────────────────────────────────────────
// vault-ai-prompt.js — types a prompt into an AI chat site and SUBMITS it.
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
  if (window.__vaultAiPromptLoaded) return; window.__vaultAiPromptLoaded = true;
  // Top frame only — the composer is never in a subframe, and all_frames would
  // otherwise run this in every ad/embed iframe on the page.
  try { if (window.top !== window) return; } catch (e) { return; }

  var COMPOSER_WAIT_MS = 30000;   // cold AI page + auth redirect can be slow
  var POLL_MS          = 250;
  var PULL_TRIES       = 6;       // × PULL_GAP_MS — covers a late tab-id registration
  var PULL_GAP_MS      = 400;
  var TYPE_TRIES       = 3;       // re-type if execCommand silently no-ops
  var SEND_TRIES       = 24;      // × SEND_GAP_MS ≈ 17s of trying to fire the send control
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
    try {
      if (el.tagName === 'TEXTAREA') { el.select(); }
      else {
        var range = document.createRange(); range.selectNodeContents(el);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    } catch (e) {}
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok && el.tagName === 'TEXTAREA') {
      // Last resort for a textarea: the native value setter bypasses React's
      // property override, and the input event tells React to re-read it.
      try {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        ok = true;
      } catch (e) {}
    }
    return ok;
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

  // The ONLY reliable proof the prompt went: the composer no longer holds it.
  // Checked against both the element we typed into and whatever the live
  // composer is now, because these sites routinely swap the node out on submit.
  function stillHoldingPrompt(profile, el, head) {
    if (el && el.isConnected && composerText(el).slice(0, 40) === head) return true;
    var live = findComposer(profile);
    if (live && live !== el && composerText(live).slice(0, 40) === head) return true;
    return false;
  }

  async function fireSend(profile, el, head) {
    for (var i = 0; i < SEND_TRIES; i++) {
      if (!stillHoldingPrompt(profile, el, head)) return true;

      var btn = findSend(profile);
      if (btn) { try { btn.click(); } catch (e) {} }

      // No button (or clicking it isn't taking) → the form's own submit path,
      // then a synthetic Enter. Enter is last because ProseMirror-based
      // composers usually ignore an untrusted key event.
      if (!btn || i >= 2) {
        var live = (el && el.isConnected) ? el : (findComposer(profile) || el);
        submitForm(live);
        try { live.focus(); } catch (e) {}
        pressEnter(live);
      }
      await wait(SEND_GAP_MS);
    }
    return !stillHoldingPrompt(profile, el, head);
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
    if (!el) { console.warn('[Vault] AI prompt: no composer found on ' + location.hostname); return false; }

    // Type, then CONFIRM the text actually landed. execCommand silently no-ops
    // when the composer never took focus, and sending an empty box does nothing
    // — this is the other half of "it opened but nothing happened".
    var head = text.trim().slice(0, 40);
    var typed = false;
    for (var t = 0; t < TYPE_TRIES && !typed; t++) {
      typeInto(el, text);
      await wait(250);
      typed = composerText(el).slice(0, 40) === head;
      if (!typed) { el = findComposer(profile) || el; }
    }
    if (!typed) { console.warn('[Vault] AI prompt: could not type into the composer on ' + location.hostname); return false; }

    if (!(await fireSend(profile, el, head))) {
      console.warn('[Vault] AI prompt: typed it in, but no send control fired — press Enter yourself. ' +
                   'Send button found: ' + !!findSend(profile));
      return false;   // stays pending, so a reload retries
    }
    // Only now tell the background it's done — a failed attempt must stay
    // pending so the next document (or a reload) can have another go.
    report();
    console.log('[Vault] AI prompt submitted on ' + profile.name);
    return true;
  }

  function report() {
    try { chrome.runtime.sendMessage({ action: 'vaultAiPromptDone' }, function () { void chrome.runtime.lastError; }); }
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
  function pull() { return ask({ action: 'vaultAiPromptPending' }); }

  // Launcher path: tell the background this tab carries the #tbauto marker, so
  // it fetches the selected TradeHub Analysis prompt and registers it for us
  // (which also arms the same retry-on-reload machinery as the TradeHub path).
  function claimAutoLaunch() { return ask({ action: 'vaultAiAutoSubmit' }); }

  (async function () {
    if (isAutoLaunch) {
      var auto = await claimAutoLaunch();
      if (auto) {
        console.log('[Vault] AI prompt: auto-launch marker — ' + auto.length + ' chars from the Analysis config');
        deliver(auto);
        return;
      }
      console.warn('[Vault] AI prompt: #tbauto marker present but no Analysis prompt was available.');
    }
    for (var i = 0; i < PULL_TRIES; i++) {
      var text = await pull();
      if (text) {
        console.log('[Vault] AI prompt: ' + text.length + ' chars pending for this tab');
        deliver(text);
        return;
      }
      await wait(PULL_GAP_MS);
    }
  })();
})();
