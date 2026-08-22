// Connection-card drag-to-reorder for the Warden Launcher popup.
//
// Deliberately the same mechanic as the Keychain card DnD in the Warden app
// (warden.html, kc card pointer handlers): a dashed placeholder takes the card's
// slot in the flow, a `position:fixed` clone follows the pointer, and on drop
// the placeholder position decides the new order. Pointer events cover mouse,
// pen and touch with one code path.
//
// The one addition over the web app is edge auto-scroll: the popup's list is a
// short scroll box, so a drag that reaches its top or bottom edge has to scroll
// or the cards below are unreachable.
//
// The caller owns persistence — this module reports the new order and the
// column map and does not touch storage.
//
// NOTE: this is the CARD drag module, separate from warden-drag.js (which
// reorders header buttons and tab bars in the web app and is not loaded here).

const WardenCardDrag = (() => {
  const SCROLL_ZONE = 34;     // px from an edge where auto-scroll kicks in
  const SCROLL_STEP = 9;      // px per frame at the very edge

  function enable(listEl, opts) {
    const o = opts || {};
    const drag = { active: false };

    function cards() {
      return [...listEl.querySelectorAll(".col")].flatMap(c => [...c.querySelectorAll(".card")]);
    }

    function bind() {
      listEl.querySelectorAll('[data-role="card-grip"]').forEach(h => {
        h.addEventListener("pointerdown", onDown);
      });
    }

    function onDown(e) {
      if (o.isEnabled && !o.isEnabled()) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      const card = e.currentTarget.closest(".card");
      if (!card) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      start(e, card);
    }

    function start(e, card) {
      const rect = card.getBoundingClientRect();
      const ph = document.createElement("div");
      ph.className = "card-placeholder";
      ph.style.height = rect.height + "px";
      card.parentNode.insertBefore(ph, card);
      card.remove();

      const clone = card.cloneNode(true);
      clone.classList.add("card-fly");
      clone.style.width = rect.width + "px";
      clone.style.left = rect.left + "px";
      clone.style.top = rect.top + "px";
      document.body.appendChild(clone);

      drag.active = true;
      drag.card = card; drag.clone = clone; drag.ph = ph;
      drag.offX = e.clientX - rect.left; drag.offY = e.clientY - rect.top;
      drag.lastY = e.clientY;
      drag.raf = requestAnimationFrame(autoScroll);

      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp, { once: true });
      document.addEventListener("pointercancel", onUp, { once: true });
    }

    // Scroll the popup's list while a card is held near its top/bottom edge.
    function autoScroll() {
      if (!drag.active) return;
      const sc = o.scroller;
      if (sc) {
        const r = sc.getBoundingClientRect();
        let dy = 0;
        if (drag.lastY < r.top + SCROLL_ZONE) dy = -SCROLL_STEP * (1 - (drag.lastY - r.top) / SCROLL_ZONE);
        else if (drag.lastY > r.bottom - SCROLL_ZONE) dy = SCROLL_STEP * (1 - (r.bottom - drag.lastY) / SCROLL_ZONE);
        if (dy) sc.scrollTop += dy;
      }
      drag.raf = requestAnimationFrame(autoScroll);
    }

    function onMove(e) {
      if (!drag.active) return;
      e.preventDefault();
      drag.lastY = e.clientY;
      drag.clone.style.left = (e.clientX - drag.offX) + "px";
      drag.clone.style.top = (e.clientY - drag.offY) + "px";

      const cols = [...listEl.querySelectorAll(".col")];
      if (!cols.length) return;

      // Column under the pointer; otherwise the nearest one horizontally.
      let target = null;
      for (const col of cols) {
        const r = col.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) { target = col; break; }
      }
      if (!target) {
        let best = Infinity;
        for (const col of cols) {
          const r = col.getBoundingClientRect();
          const d = Math.min(Math.abs(e.clientX - r.left), Math.abs(e.clientX - r.right));
          if (d < best) { best = d; target = col; }
        }
      }
      if (!target) return;

      let before = null;
      for (const c of target.querySelectorAll(".card")) {
        const r = c.getBoundingClientRect();
        if (e.clientY < r.top + r.height * 0.5) { before = c; break; }
      }
      if (before) target.insertBefore(drag.ph, before);
      else target.appendChild(drag.ph);
    }

    function onUp() {
      if (!drag.active) return;
      document.removeEventListener("pointermove", onMove);
      if (drag.raf) cancelAnimationFrame(drag.raf);
      const { card, clone, ph } = drag;
      drag.active = false;
      clone.remove();

      if (!ph.parentNode) { ph.remove(); return; }
      ph.parentNode.insertBefore(card, ph);
      ph.remove();

      // New order, expressed as the ORIGINAL indices in DOM order, plus the
      // column each card ended up in — keyed by the card's NEW index, which is
      // exactly the shape dashboards/warden_links stores (colmap[connIdx] = col).
      const dom = cards();
      const order = dom.map(el => parseInt(el.dataset.ci, 10));
      if (order.some(Number.isNaN)) { if (o.onDrop) o.onDrop(null); return; }

      dom.forEach((el, i) => { el.dataset.ci = String(i); });
      const colmap = [];
      [...listEl.querySelectorAll(".col")].forEach((col, ci) => {
        col.querySelectorAll(".card").forEach(el => { colmap[parseInt(el.dataset.ci, 10)] = ci; });
      });

      bind();
      if (o.onDrop) o.onDrop({ order, colmap });
    }

    bind();
    return { rebind: bind };
  }

  return { enable };
})();

if (typeof globalThis !== "undefined") globalThis.WardenCardDrag = WardenCardDrag;
