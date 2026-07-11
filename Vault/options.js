// Vault options — full CRUD over the shared Keychain connections.
//
// Vault edits group names, colours, and LINK items. Any other item types a
// connection carries (email / phone / username / info / doc) are preserved
// verbatim on every save, so editing here never destroys Keychain-only data.

const listEl   = document.getElementById("list");
const syncEl   = document.getElementById("sync");
const errEl    = document.getElementById("groupErr");
const CD = ['#a8d8c0','#a0c8e8','#f5e88a','#f0a8c8','#c4a0e8','#40d8a8','#40a8f0','#f5c800','#f04898','#f07020','#9b72cf','#50cc30','#10b8d0','#e03060','#ffd93d','#7b5ea7'];

let connections = [];
let colmap = null;
let saveTimer = null;

function setSync(state, text) {
  syncEl.className = "sync " + (state || "");
  syncEl.textContent = text || "";
}

// Debounced write-back to the shared doc.
function persist() {
  setSync("saving", "Saving…");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await VaultDB.save({ connections, colmap });
      setSync("saved", "Saved · synced to Keychain");
      setTimeout(() => { if (syncEl.classList.contains("saved")) setSync("", ""); }, 2500);
    } catch (e) {
      console.error(e);
      setSync("error", "Save failed — check connection");
    }
  }, 500);
}

// Only the link items are Vault-editable; keep the rest in original order.
function linkItems(conn)  { return (conn.items || []).filter(i => i && i.type === "link"); }
function otherItems(conn) { return (conn.items || []).filter(i => !i || i.type !== "link"); }

function render() {
  listEl.innerHTML = "";

  if (!connections.length) {
    listEl.innerHTML = `<div class="empty">No groups yet.<br />Create one above — it'll appear in Keychain too.</div>`;
    return;
  }

  connections.forEach((conn, ci) => {
    if (!Array.isArray(conn.items)) conn.items = [];
    const color = conn.color || CD[ci % CD.length];
    const links = linkItems(conn);
    const others = otherItems(conn);

    const block = document.createElement("div");
    block.className = "group";
    block.style.setProperty("--gc", color);

    // Head: name + reorder + delete
    const head = document.createElement("div");
    head.className = "group-head";

    const nameInput = document.createElement("input");
    nameInput.className = "group-name";
    nameInput.value = conn.name || "";
    nameInput.placeholder = "Group name (e.g. Trading, School)";
    nameInput.addEventListener("input", () => { conn.name = nameInput.value; persist(); });
    head.appendChild(nameInput);

    head.appendChild(iconBtn("↑", "Move up", ci === 0, () => moveGroup(ci, -1)));
    head.appendChild(iconBtn("↓", "Move down", ci === connections.length - 1, () => moveGroup(ci, 1)));
    const del = iconBtn("🗑", "Delete group", false, () => { connections.splice(ci, 1); persist(); render(); });
    del.classList.add("del");
    head.appendChild(del);
    block.appendChild(head);

    // Colour palette
    const pal = document.createElement("div");
    pal.className = "palette";
    CD.forEach(c => {
      const sw = document.createElement("div");
      sw.className = "swatch" + (c === color ? " sel" : "");
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener("click", () => { conn.color = c; persist(); render(); });
      pal.appendChild(sw);
    });
    block.appendChild(pal);

    // Existing links
    links.forEach(link => {
      const realIdx = conn.items.indexOf(link);
      const row = document.createElement("div");
      row.className = "link-row";

      const nm = document.createElement("input");
      nm.className = "l-name"; nm.value = link.name || ""; nm.placeholder = "Label";
      nm.addEventListener("input", () => { link.name = nm.value; persist(); });

      const url = document.createElement("input");
      url.className = "l-url"; url.value = link.url || ""; url.placeholder = "https://…";
      url.addEventListener("input", () => { link.url = url.value.trim(); persist(); });

      const d = iconBtn("✕", "Remove link", false, () => {
        conn.items.splice(realIdx, 1); persist(); render();
      });
      d.classList.add("del");

      row.append(nm, url, d);
      block.appendChild(row);
    });

    // Add-link form
    const add = document.createElement("div");
    add.className = "add-link";
    const aName = document.createElement("input");
    aName.className = "a-name"; aName.placeholder = "Label";
    const aUrl = document.createElement("input");
    aUrl.className = "a-url"; aUrl.placeholder = "https://…";
    const aBtn = document.createElement("button");
    aBtn.textContent = "+ Add Link";
    const doAdd = () => {
      const url = aUrl.value.trim();
      if (!url) { aUrl.focus(); return; }
      conn.items.push({ type: "link", name: aName.value.trim() || url, url });
      persist(); render();
    };
    aBtn.addEventListener("click", doAdd);
    [aName, aUrl].forEach(inp => inp.addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); }));
    add.append(aName, aUrl, aBtn);
    block.appendChild(add);

    // Note about Keychain-only items we preserve but don't edit
    if (others.length) {
      const note = document.createElement("div");
      note.className = "other-note";
      note.textContent = `+ ${others.length} other item${others.length > 1 ? "s" : ""} (emails, phones, docs…) managed in Keychain — preserved on save.`;
      block.appendChild(note);
    }

    listEl.appendChild(block);
  });
}

function iconBtn(txt, title, disabled, onClick) {
  const b = document.createElement("button");
  b.className = "icon-btn"; b.textContent = txt; b.title = title; b.disabled = disabled;
  if (!disabled) b.addEventListener("click", onClick);
  return b;
}

function moveGroup(ci, dir) {
  const t = ci + dir;
  if (t < 0 || t >= connections.length) return;
  [connections[ci], connections[t]] = [connections[t], connections[ci]];
  // colmap is index-aligned in Keychain; drop it so layout re-flows cleanly.
  colmap = null;
  persist(); render();
}

document.getElementById("addGroup").addEventListener("click", () => {
  connections.push({ name: "", color: CD[connections.length % CD.length], items: [] });
  colmap = null;
  persist(); render();
  const inputs = listEl.querySelectorAll(".group-name");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

// ── Initial load ──
(async () => {
  setSync("", "Loading…");
  try {
    const data = await VaultDB.load();
    connections = Array.isArray(data.connections) ? data.connections : [];
    colmap = Array.isArray(data.colmap) ? data.colmap : null;
    render();
    setSync("saved", "Synced with Keychain");
    setTimeout(() => { if (syncEl.classList.contains("saved")) setSync("", ""); }, 2000);
  } catch (e) {
    console.error(e);
    setSync("error", "Couldn't reach Keychain");
    listEl.innerHTML = `<div class="empty">Couldn't load from Keychain.<br />Check your connection and reload.</div>`;
  }
})();
