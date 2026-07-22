// PriceWatch popup — settings + activity. All real work lives in the service
// worker; this only reads/writes pw_cfg and shows the log.
"use strict";

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function when(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

async function refresh() {
  const st = await send({ type: "PW_GET_STATE" });
  if (!st || !st.ok) return;

  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  $("domains").innerHTML = st.domains
    .map((d) => '<span class="chip">' + d + "</span>").join("");

  $("gap").value = String(st.cfg.minIntervalHours);
  $("every").value = String(st.cfg.autoEveryMin);
  $("auto").checked = !!st.cfg.autoEnabled;

  $("log").innerHTML = st.log.length
    ? st.log.map((e) =>
        "<div><time>" + when(e.at) + "</time>" +
        e.msg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) +
        "</div>").join("")
    : '<div class="empty">Nothing yet.</div>';
}

$("gap").onchange = () => send({ type: "PW_SET_CFG", patch: { minIntervalHours: +$("gap").value } });
$("every").onchange = () => send({ type: "PW_SET_CFG", patch: { autoEveryMin: +$("every").value } });
$("auto").onchange = () => send({ type: "PW_SET_CFG", patch: { autoEnabled: $("auto").checked } });

$("clear").onclick = async (e) => {
  e.target.disabled = true;
  const r = await send({ type: "PW_CLEAR_LIMITS" });
  e.target.textContent = "Cleared " + ((r && r.cleared) || 0) + " cooldown(s)";
  setTimeout(() => { e.target.textContent = "Clear cooldowns"; e.target.disabled = false; }, 1800);
};

// This opens real tabs, so the button stays busy until the run finishes.
$("run").onclick = async (e) => {
  e.target.disabled = true;
  e.target.textContent = "Checking… (tabs will open)";
  const r = await send({ type: "PW_RUN_NOW" });
  e.target.textContent = (r && r.ok) ? "Checked " + r.ran + " item(s)" : "Failed — see log";
  await refresh();
  setTimeout(() => { e.target.textContent = "Run a check now"; e.target.disabled = false; }, 2200);
};

refresh();
