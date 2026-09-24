// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-models.live.js       Screenshots: %TEMP%/magi-live-shots
//
// Phase 11B end to end on the REAL accounts (Claude Pro with usage credits
// off; Codex on a free ChatGPT account). Every setting it changes is put
// back in `finally`.
//   1. row       the model row shows Claude and Codex on Auto with a usage meter.
//   2. auto      typing changes what Auto would pick (a hard brief → Opus 5.5,
//                not Fable, because credits are off; a question → Sonnet 5, low).
//   3. sheet     the Claude sheet lists the account's models; Fable is disabled
//                with the credits reason; choosing a model and an effort sticks
//                (the engine says so) and the row follows; back to Auto.
//   4. caps      a cap below today's usage stops the agent: the row, the chip,
//                the popup and /agents all say so, and a real task skips Claude
//                with the cap as the reason (nothing is spent); Off releases it.
//                The same for Codex's 30-day window.
//   5. toast     a warning popup renders, links to the sheet, and dismisses.
//   6. phone     at 390px: the row, the sheet and the popup fit.
//   7. run       (opt-in, spends a little) Fable chosen by hand: the task runs
//                on Auto's pick instead and says why in the transcript.
//   8. veda      (opt-in) a second engine for Veda on :8001 keeps its own
//                choices and caps; Tony's are untouched.
//   9. update    the CLI card shows each version; Auto-update toggles on the
//                engine; (opt-in) a REAL Codex update through the engine --
//                npm reinstalls the latest, Codex sits out meanwhile, and
//                stays signed in afterwards.
// LIVE_ONLY=row,auto,sheet,caps,toast,phone,run,veda  (run and veda are opt-in)
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Served by the engine: since Phase 14 a file:// page (Origin "null") is refused.
const URL = 'http://127.0.0.1:8000/';
const API = 'http://127.0.0.1:8000/api/code';
const A1 = path.resolve(__dirname, '..', '..');
const A1_PID = 'proj_60d8f14fbc1c';
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(400);
  }
  return false;
};
const api = async (p, body, base = API) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                           body: JSON.stringify(body) } : undefined);
  return r.json();
};
const OPT_IN = new Set(['run', 'veda', 'update']);
const want = (k) => (process.env.LIVE_ONLY ? process.env.LIVE_ONLY.split(',').includes(k) : !OPT_IN.has(k));
const rowText = (c, a) => evalJs(c, `(document.querySelector('.code-model[data-agent="${a}"]')||{}).textContent || ""`);
const type = (c, text) => evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); return 1;`);
const sheetOpen = '!!document.querySelector(".model-box .model-opt")';
const click = (c, sel) => evalJs(c, `document.querySelector(${JSON.stringify(sel)}).click(); return 1;`);
// Every open sheet: a stale one left underneath would answer the next query.
const closeSheet = (c) => evalJs(c, 'for (const x of document.querySelectorAll(".model-box .repo-x")) x.click(); return 1;');

async function restore() {
  for (const a of ['claude', 'codex']) {
    await api('/models/choice', { agent: a, model: 'auto', effort: 'auto' }).catch(() => {});
  }
  const st = await api('/models').catch(() => null);
  for (const a of ['claude', 'codex']) {
    for (const w of Object.keys(((st && st.agents[a]) || {}).caps || {})) {
      await api('/models/cap', { agent: a, window: w, percent: null }).catch(() => {});
    }
  }
  await api('/models/warn', { percent: 80 }).catch(() => {});
  await api('/updates/auto', { on: true }).catch(() => {});
}

(async () => {
  const before = await api('/models');
  if (!before.ok) { console.error('engine has no /models', before); process.exit(2); }
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(3000);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(A1_PID)})); return 1;`);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('Code Mode loaded with models', await waitFor(c, '!!(CODE.state && CODE.agents && CODE.models)', 25000));

  try {
    if (want('row')) {
      console.log('\nThe model row');
      ok('Claude and Codex each have a model button', await waitFor(c, 'document.querySelectorAll(".code-model").length === 2', 8000));
      ok('both start on Auto', /Auto/.test(await rowText(c, 'claude')) && /Auto/.test(await rowText(c, 'codex')));
      await evalJs(c, 'codeUsageRefresh(); return 1;');
      ok('each shows a usage meter', await waitFor(c, 'document.querySelectorAll(".code-model .code-model-m").length === 2', 15000),
        `${await rowText(c, 'claude')} | ${await rowText(c, 'codex')}`);
      await shot(c, 'models-row');
    }

    if (want('auto')) {
      console.log('\nAuto, as you type');
      await type(c, 'Think hard: design a new sync protocol from scratch');
      // The strongest Opus this account AND this Claude Code can run (Opus 5.5
      // needs Claude Code 2.1.280+; on an older CLI Auto takes Opus 5).
      const opus = (await api('/models')).agents.claude.slots[0].models
        .find((m) => m.family === 'opus' && m.available);
      ok(`a hard brief: Claude → ${opus.label} at extra-high effort (Fable needs credits, off)`,
        await waitFor(c, `new RegExp(${JSON.stringify(opus.label.replace('.', '\\.') + '.*extra high')}).test(document.querySelector('.code-model[data-agent="claude"]').textContent)`, 6000), await rowText(c, 'claude'));
      ok('and Codex → its strongest, extra high', /extra high/.test(await rowText(c, 'codex')), await rowText(c, 'codex'));
      await type(c, 'what does tasks.py do?');
      ok('a question: Claude → Sonnet 5, low effort',
        await waitFor(c, `/Sonnet 5.*low/.test(document.querySelector('.code-model[data-agent="claude"]').textContent)`, 6000), await rowText(c, 'claude'));
      const t0 = Date.now();
      const pv = await api('/models/preview', { prompt: 'Refactor the scheduler', mode: 'read' });
      ok('the preview is local and fast', pv.ok && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
      await shot(c, 'models-auto-preview');
      await type(c, '');
    }

    if (want('sheet')) {
      console.log('\nThe Claude sheet');
      await click(c, '.code-model[data-agent="claude"]');
      ok('it opens with the account\'s models', await waitFor(c, sheetOpen, 15000));
      const acct = await evalJs(c, 'document.querySelector(".model-acct").textContent');
      ok('it says the plan and that credits are off', /Pro plan/.test(acct) && /usage credits off/.test(acct), acct);
      const fable = await evalJs(c, `(()=>{const b=document.querySelector('.model-opt[data-model="claude-fable-5-1"]'); return b ? {dis: b.disabled, t: b.textContent} : null;})()`.replace(/^/, 'return '));
      ok('Fable 5.1 is listed but cannot be chosen, with the reason', fable && fable.dis && /usage credits/.test(fable.t), fable && fable.t.slice(0, 120));
      ok('Auto is selected and recommended', await evalJs(c, `document.querySelector('.model-opt[data-model="auto"]').classList.contains("on")`));
      await shot(c, 'models-sheet-desktop');
      await click(c, '.model-opt[data-model="claude-sonnet-5"]');
      ok('choosing Sonnet 5 is saved on the engine', await waitFor(c, 'CODE.models.agents.claude.choice.model === "claude-sonnet-5"', 8000));
      ok('the engine agrees', (await api('/models')).agents.claude.choice.model === 'claude-sonnet-5');
      ok('the row follows', /Sonnet 5/.test(await rowText(c, 'claude')) && !/Auto/.test(await rowText(c, 'claude')), await rowText(c, 'claude'));
      const maxDis = await evalJs(c, `document.querySelector('.model-seg-b[data-effort="max"]').disabled`);
      const sonnet = (await api('/models')).agents.claude.slots[0].models.find((m) => m.id === 'claude-sonnet-5');
      ok('efforts the model does not support are greyed', maxDis === !(sonnet.efforts || []).includes('max'), `max disabled=${maxDis}`);
      await click(c, '.model-seg-b[data-effort="high"]');
      ok('an effort is saved', await waitFor(c, 'CODE.models.agents.claude.choice.effort === "high"', 8000));
      ok('and shown in the row', /high/.test(await rowText(c, 'claude')));
      await click(c, '.model-opt[data-model="auto"]');
      ok('back to Auto (effort back to Auto too)', await waitFor(c, 'CODE.models.agents.claude.choice.model === "auto" && CODE.models.agents.claude.choice.effort === "auto"', 8000));
      await closeSheet(c);
    }

    if (want('caps')) {
      console.log('\nCaps');
      await evalJs(c, 'localStorage.removeItem(lsKey("usage.seen")); document.getElementById("usageToasts")?.remove(); return 1;');
      const u = await api('/usage');
      const sess = ((u.usage['claude:system'] || {}).five_hour || {}).utilization || 0;
      ok('Claude has used some of its session', sess > 0.01, `${Math.round(sess * 100)}%`);
      const low = Math.max(1, Math.floor(sess * 100) - 1);
      await click(c, '.code-model[data-agent="claude"]');
      await waitFor(c, sheetOpen, 15000);
      // A preset below today's usage if there is one, else set it through the API.
      await api('/models/cap', { agent: 'claude', window: 'five_hour', percent: low });
      await evalJs(c, 'codeModelsLoad().then(()=>{codeUsageRefresh(); codeModelsRedraw();}); return 1;');
      await closeSheet(c);
      await click(c, '.code-model[data-agent="claude"]');
      ok('the sheet says Claude is stopped and until when', await waitFor(c, `/Stopped at your ${low}% cap/.test((document.querySelector(".model-box .model-capped")||{}).textContent||"")`, 15000));
      ok('the bar carries a cap marker', await waitFor(c, '!!document.querySelector(\'.use-row[data-window="five_hour"] .use-cap\')', 8000));
      await shot(c, 'models-capped-sheet');
      await closeSheet(c);
      ok('the row says capped', await waitFor(c, `/capped/.test(document.querySelector('.code-model[data-agent="claude"]').textContent)`, 15000), await rowText(c, 'claude'));
      ok('a popup says it stopped at your cap', await waitFor(c, `/stopped at your ${low}% cap/.test((document.querySelector(".usage-toast")||{}).textContent||"")`, 15000));
      await shot(c, 'models-capped-toast');
      const ag = await api('/agents');
      const sys = ag.cli.find((x) => x.agent === 'claude').slots.find((s) => s.slot === 'system');
      ok('/agents reports the cap', !!(sys.capped && sys.capped.until));
      await evalJs(c, 'codeLoad(true); return 1;');
      await waitFor(c, `/capped/.test((document.querySelector('.code-chip[data-agent="claude-cli"]')||{}).textContent||"")`, 20000);
      ok('the Claude CLI chip says capped', /capped/.test(await evalJs(c, `(document.querySelector('.code-chip[data-agent="claude-cli"]')||{}).textContent||""`)));
      // A real task: only Claude CLI ticked, so the cap is the whole story.
      await evalJs(c, 'CODE.picks = { on: ["claude-cli"], known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;');
      await type(c, 'Reply with the single word OK.');
      await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
      ok('the task ends without using Claude', await waitFor(c, '!!(CODE.task && CODE.task.done)', 60000));
      const log = await evalJs(c, '(document.querySelector(".code-log")||{}).textContent||""');
      ok('the transcript names the cap as the reason', new RegExp(`Skipped Claude: Stopped at your ${low}% cap`).test(log), log.slice(0, 200));
      await shot(c, 'models-capped-task');
      await click(c, '.code-model[data-agent="claude"]');
      await waitFor(c, sheetOpen, 15000);
      await click(c, '.use-row[data-window="five_hour"] .use-cap-b[data-cap="off"]');
      ok('Off releases it', await waitFor(c, '!CODE.models.agents.claude.caps.five_hour', 8000));
      await closeSheet(c);
      await evalJs(c, 'codeUsageRefresh(); return 1;');
      ok('the row is no longer capped', await waitFor(c, `!/capped/.test(document.querySelector('.code-model[data-agent="claude"]').textContent)`, 15000));
      ok('and Claude is available again', (await api('/agents')).cli.find((x) => x.agent === 'claude').slots.find((s) => s.slot === 'system').capped === null);

      // Codex: its free account has one 30-day window.
      const cx = (await api('/usage')).usage['codex:codex1'] || {};
      const win = Object.keys(cx)[0];
      const used = Math.round(((cx[win] || {}).utilization || 0) * 100);
      await click(c, '.code-model[data-agent="codex"]');
      ok('the Codex sheet offers a cap on the window its plan has', await waitFor(c, `!!document.querySelector('.use-row[data-window="${win}"] .use-cap-b')`, 15000), win);
      await api('/models/cap', { agent: 'codex', window: win, percent: Math.max(1, used - 1) });
      const a2 = await api('/agents');
      ok('a Codex cap below its usage stops Codex', !!a2.cli.find((x) => x.agent === 'codex').slots[0].capped, `${used}% used`);
      await api('/models/cap', { agent: 'codex', window: win, percent: null });
      ok('and Off releases it', !(await api('/agents')).cli.find((x) => x.agent === 'codex').slots[0].capped);
      await closeSheet(c);
      await evalJs(c, 'CODE.task = null; CODE.picks = null; renderCodeView(); return 1;');
    }

    if (want('toast')) {
      console.log('\nThe warning popup');
      await evalJs(c, `document.getElementById("usageToasts")?.remove(); codeUsageAlerts([{key: "live-test-" + Date.now(), agent: "claude", slot: "system", label: "system", window: "seven_day", window_label: "weekly", used: 84, cap: null, resets_at: Date.now()/1000 + 86400*3, level: "warn"}]); return 1;`);
      ok('a warning appears in the corner', await waitFor(c, '/Claude is at 84% of the weekly limit/.test((document.querySelector(".usage-toast")||{}).textContent||"")', 3000));
      const box = await evalJs(c, 'return (()=>{const r=document.querySelector(".usage-toast").getBoundingClientRect(); return {r: Math.round(innerWidth - r.right), b: Math.round(innerHeight - r.bottom), w: Math.round(r.width)};})()');
      ok('small and out of the way (bottom-right, ≤360px)', box.r <= 24 && box.b <= 24 && box.w <= 360, JSON.stringify(box));
      await shot(c, 'models-toast-desktop');
      await evalJs(c, 'document.querySelector(".usage-toast .usage-toast-b").click(); return 1;');
      ok('"Limits" opens the Claude sheet', await waitFor(c, sheetOpen, 15000));
      await closeSheet(c);
      await evalJs(c, `codeUsageAlerts([{key: "live-test-x-" + Date.now(), agent: "codex", slot: "codex1", label: "codex1", window: "30d", window_label: "30-day", used: 91, cap: 95, resets_at: null, level: "near_cap"}]); return 1;`);
      await waitFor(c, '!!document.querySelector(".usage-toast")', 3000);
      await evalJs(c, 'document.querySelector(".usage-toast .usage-toast-x").click(); return 1;');
      ok('× dismisses it', await waitFor(c, '!document.querySelector(".usage-toast")', 3000));
      const seen = await evalJs(c, 'usageSeen().length');
      await evalJs(c, 'codeUsageAlerts([{key: usageSeen()[0], agent: "claude", slot: "system", window: "seven_day", window_label: "weekly", used: 84, level: "warn"}]); return 1;');
      ok('an alert already seen is not shown again', !(await evalJs(c, '!!document.querySelector(".usage-toast")')) && seen > 0);
    }

    if (want('phone')) {
      console.log('\nPhone, 390px');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(600);
      await evalJs(c, 'renderCodeView(); return 1;');
      await sleep(300);
      ok('Code Mode fits', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      const rows = await evalJs(c, 'return [...document.querySelectorAll(".code-model")].map(b=>{const r=b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];})');
      ok('each model button is full width and tappable', rows.length === 2 && rows.every(([w, h]) => w >= 330 && h >= 36), JSON.stringify(rows));
      await shot(c, 'models-row-phone');
      await click(c, '.code-model[data-agent="claude"]');
      await waitFor(c, sheetOpen, 15000);
      ok('the sheet fits', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      const minOpt = await evalJs(c, 'Math.min(...[...document.querySelectorAll(".model-opt")].map(b=>b.getBoundingClientRect().height))');
      ok('model options are thumb-sized (≥44px)', minOpt >= 44, `${minOpt}px`);
      await shot(c, 'models-sheet-phone');
      await evalJs(c, 'document.querySelector(".model-box .repo-body").scrollTop = 9999; return 1;');
      await sleep(200);
      await shot(c, 'models-sheet-phone-caps');
      await closeSheet(c);
      await evalJs(c, `codeUsageAlerts([{key: "live-test-p-" + Date.now(), agent: "claude", slot: "system", label: "system", window: "five_hour", window_label: "session (5h)", used: 81, cap: null, resets_at: Date.now()/1000 + 3600, level: "warn"}]); return 1;`);
      await waitFor(c, '!!document.querySelector(".usage-toast")', 3000);
      const tb = await evalJs(c, 'return (()=>{const r=document.querySelector(".usage-toast").getBoundingClientRect(); return {l: Math.round(r.left), r: Math.round(innerWidth-r.right)};})()');
      ok('the popup spans the phone with a margin', tb.l >= 8 && tb.r >= 8 && tb.l <= 16, JSON.stringify(tb));
      await shot(c, 'models-toast-phone');
      await evalJs(c, 'document.querySelector(".usage-toast .usage-toast-x").click(); return 1;');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }

    if (want('run')) {
      console.log('\nA chosen model that needs credits (a real task)');
      await api('/models/choice', { agent: 'claude', model: 'claude-fable-5-1', effort: 'auto' });
      await evalJs(c, 'codeModelsLoad().then(codeModelsRedraw); CODE.task = null; CODE.picks = { on: ["claude-cli"], known: codeMembers().map(m=>m.id) }; renderCodeView(); return 1;');
      await type(c, 'Reply with the single word OK. Do not read any files.');
      await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
      ok('the task finishes', await waitFor(c, '!!(CODE.task && CODE.task.done)', 180000));
      const log = await evalJs(c, '(document.querySelector(".code-log")||{}).textContent||""');
      ok('it says Fable needs credits and Auto stood in', /Fable 5\.1.*usage credits.*Auto chose instead/.test(log), log.slice(0, 260));
      ok('the transcript names the model it ran on', /Sonnet 5|Opus 5/.test(log));
      ok('and the answer came back', (await evalJs(c, 'CODE.task.result && CODE.task.result.outcome')) === 'ok');
      await shot(c, 'models-run-fallback');
      await api('/models/choice', { agent: 'claude', model: 'auto', effort: 'auto' });
      await evalJs(c, 'CODE.task = null; CODE.picks = null; renderCodeView(); return 1;');
    }

    if (want('card') || want('update')) {
      console.log('\nThe CLI card');
      await click(c, '.code-model[data-agent="codex"]');
      await waitFor(c, sheetOpen, 15000);
      ok('the Codex sheet ends with its CLI card', await waitFor(c, '!!document.querySelector(\'.cli-card[data-cli="codex"] .cli-ver\')', 15000));
      const ver = await evalJs(c, 'document.querySelector(\'.cli-card[data-cli="codex"]\').textContent');
      const st = (await api('/updates')).cli.codex;
      ok('it shows the installed version and whether it is current', ver.includes(st.installed) && /up to date|available/.test(ver), ver.slice(0, 90));
      const was = (await api('/updates')).auto_update;
      await click(c, '.cli-card [data-act="auto"]');
      ok('Auto-update flips', await waitFor(c, `CODE.models.auto_update === ${!was}`, 8000));
      ok('the engine agrees', (await api('/updates')).auto_update === !was);
      ok('and the button says so', await waitFor(c, `/Auto-update: ${was ? 'off' : 'on'}/.test(document.querySelector('.cli-card [data-act="auto"]').textContent)`, 4000));
      await click(c, '.cli-card [data-act="auto"]');
      ok('and flips back', await waitFor(c, `CODE.models.auto_update === ${was}`, 8000) && (await api('/updates')).auto_update === was);
      await shot(c, 'models-cli-card');
      await closeSheet(c);
    }

    if (want('update')) {
      console.log('\nA real Codex update through the engine');
      const before = (await api('/updates')).cli.codex.installed;
      const r = await api('/updates/codex', {});
      ok('the engine starts it', r.ok && r.job.state === 'running', JSON.stringify(r).slice(0, 160));
      let job = null;
      for (let i = 0; i < 120; i++) {
        job = (await api('/updates')).cli.codex.job;
        if (job && job.state !== 'running') break;
        await sleep(2000);
      }
      ok('it finishes', job && job.state === 'done', job && job.text);
      ok('Codex is current afterwards', (await api('/updates?check=1')).cli.codex.outdated === false);
      const after = await api('/agents');
      ok('and still signed in', after.cli.find((x) => x.agent === 'codex').slots.every((s) => s.signed_in),
        `${before} → ${job && job.after}`);
    }

    if (want('veda')) {
      console.log('\nVeda\'s engine keeps her own');
      const PY = path.join(A1, 'magi', '.venv', 'Scripts', 'python.exe');
      const veda = spawn(PY, ['-m', 'magi', 'serve', '--profile', 'veda', '--port', '8001', '--no-browser'],
                         { cwd: A1, stdio: 'ignore', windowsHide: true });
      const VAPI = 'http://127.0.0.1:8001/api/code';
      try {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) {
          try { up = (await (await fetch('http://127.0.0.1:8001/api/health')).json()).profile === 'veda'; } catch {}
          if (!up) await sleep(1000);
        }
        ok('a veda engine is up on :8001', up);
        const vm = await api('/models', null, VAPI);
        ok('Veda starts from her own defaults', vm.ok && vm.agents.claude.choice.model === 'auto' && !Object.keys(vm.agents.claude.caps).length);
        await api('/models/cap', { agent: 'claude', window: 'seven_day', percent: 60 }, VAPI);
        await api('/models/choice', { agent: 'claude', model: 'claude-opus-5', effort: 'high' }, VAPI);
        const tm = await api('/models');
        ok('Tony\'s engine is untouched', tm.agents.claude.choice.model === 'auto' && !tm.agents.claude.caps.seven_day);
        const vf = path.join(A1, 'magi', 'data', 'veda', 'code_models.json');
        ok('Veda\'s settings live in her own folder', fs.existsSync(vf) && JSON.parse(fs.readFileSync(vf, 'utf8')).caps.claude.seven_day === 60);
      } finally {
        await api('/models/cap', { agent: 'claude', window: 'seven_day', percent: null }, VAPI).catch(() => {});
        await api('/models/choice', { agent: 'claude', model: 'auto', effort: 'auto' }, VAPI).catch(() => {});
        veda.kill();
      }
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await restore();
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch(async (e) => { console.error(e); await restore(); process.exit(2); });
