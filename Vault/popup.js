// Vault popup — reads the shared Keychain document, renders each connection as
// a group, and launches links (a single link or a whole group). Link editing
// lives entirely in TaskHub → Keychain; Vault only displays and opens.

const groupsEl  = document.getElementById("groups");
const loadingEl = document.getElementById("loading");
const syncEl    = document.getElementById("sync");
const toastEl   = document.getElementById("toast");

// TaskHub PWA, deep-linked straight to the Keychain program. Opens in the
// installed desktop app if the browser routes it there, otherwise a browser tab.
const TASKHUB_KEYCHAIN_URL = "https://anthonyn99.github.io/A1/#keychain";

// Same palette Keychain uses for connection colours, for a consistent look.
const CD = ['#a8d8c0','#a0c8e8','#f5e88a','#f0a8c8','#c4a0e8','#40d8a8','#40a8f0','#f5c800','#f04898','#f07020','#9b72cf','#50cc30','#10b8d0','#e03060','#ffd93d','#7b5ea7'];

let connections = [];

const COPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function openUrls(urls) {
  const clean = urls.filter(Boolean);
  if (!clean.length) return;
  chrome.runtime.sendMessage({ action: "openLinks", urls: clean }, () => window.close());
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.opacity = "1";
  toastEl.style.transform = "translateX(-50%) translateY(0)";
  setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateX(-50%) translateY(20px)";
  }, 1300);
}

function render() {
  loadingEl.style.display = "none";
  groupsEl.innerHTML = "";

  if (!connections.length) {
    groupsEl.innerHTML = `<div class="empty">No groups yet.<br />Add links in TaskHub → Keychain (⚙) — they sync here automatically.</div>`;
    return;
  }

  connections.forEach((conn, ci) => {
    const color = conn.color || CD[ci % CD.length];
    const links = VaultDB.linksOf(conn);

    const card = document.createElement("div");
    card.className = "card";
    card.style.setProperty("--card-accent", color);

    const linkRows = links.length
      ? links.map(l => `
          <div class="link-row">
            <span class="link-name" title="${esc(l.url)}">${esc(l.name)}</span>
            <button class="icon-btn visit" data-url="${esc(l.url)}">Visit</button>
            <button class="icon-btn copy" data-copy="${esc(l.url)}" title="Copy link">${COPY_SVG}</button>
          </div>`).join("")
      : `<div class="no-links">No links in this group.</div>`;

    card.innerHTML = `
      <div class="card-top">
        <div class="card-name"><span class="card-dot"></span><span>${esc(conn.name || "Untitled")}</span></div>
        <button class="open-group" data-group="${ci}" ${links.length ? "" : "disabled"}>
          ${links.length ? `Open ${links.length} tab${links.length > 1 ? "s" : ""}` : "Empty"}
        </button>
      </div>
      ${linkRows}`;
    groupsEl.appendChild(card);
  });

  openAllEl.classList.toggle("hidden", !anyLink);

  // Wire buttons (CSP-safe: no inline handlers).
  groupsEl.querySelectorAll(".icon-btn.visit").forEach(b =>
    b.addEventListener("click", () => openUrls([b.dataset.url])));
  groupsEl.querySelectorAll(".icon-btn.copy").forEach(b =>
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Copied!"));
    }));
  groupsEl.querySelectorAll(".open-group").forEach(b =>
    b.addEventListener("click", () => {
      const links = VaultDB.linksOf(connections[+b.dataset.group]);
      openUrls(links.map(l => l.url));
    }));
}

openAllEl.addEventListener("click", () => {
  const all = connections.flatMap(c => VaultDB.linksOf(c)).map(l => l.url);
  openUrls(all);
});

// ── Tabs ──
document.querySelectorAll(".tab").forEach(tab =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-links").classList.toggle("hidden", tab.dataset.panel !== "links");
    document.getElementById("panel-passwords").classList.toggle("hidden", tab.dataset.panel !== "passwords");
  }));

document.getElementById("gear").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── Load from the shared Keychain doc ──
(async () => {
  try {
    const data = await VaultDB.load();
    connections = Array.isArray(data.connections) ? data.connections : [];
    render();
    syncEl.textContent = "Synced with Keychain";
  } catch (e) {
    console.error(e);
    loadingEl.style.display = "none";
    groupsEl.innerHTML = `<div class="empty">Couldn't reach Keychain.<br />Check your connection and reopen.</div>`;
    syncEl.textContent = "Offline";
    syncEl.classList.add("error");
  }
})();
