/* ============================================================================
 * StudyOS — styles for the topic breakdown, lesson reader and AI settings
 * ============================================================================
 * Injected once, from JS, so the three views stay one self-contained feature
 * (and the page costs nothing extra when they never render). Uses the app's
 * own tokens (--bg2, --text2, --accent …), which are scoped to #study-root —
 * everything here renders inside it.
 * ------------------------------------------------------------------------- */

const CSS = `
/* ── Topics under a document ─────────────────────────────────────────── */
.sos-topics { margin: -2px 0 10px 18px; padding: 8px 0 4px 14px; border-left: 2px solid var(--border2); }
.sos-topics[hidden] { display: none; }
.sos-topics .bd-status { font-size: 12px; color: var(--text3); font-family: var(--mono); padding: 2px 0 8px; line-height: 1.5; }
.sos-topics .bd-status.err { color: #F2AFAF; }
.sos-topics .bd-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.sos-topics .bd-row:hover { background: var(--bg3); }
.sos-topics .bd-row.off { cursor: default; opacity: .7; }
.sos-topics .bd-row.off:hover { background: none; }
.sos-topics .bd-num { flex: 0 0 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; font-family: var(--mono); color: var(--text2); border: 1px solid var(--border2); }
.sos-topics .bd-num.done { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.sos-topics .bd-main { flex: 1; min-width: 0; }
.sos-topics .bd-title { font-size: 13.5px; color: var(--text); line-height: 1.35; }
.sos-topics .bd-sum { font-size: 12px; color: var(--text3); line-height: 1.45; margin-top: 2px; }
.sos-topics .bd-badge { flex-shrink: 0; font-size: 10.5px; font-family: var(--mono); color: var(--text3); padding-top: 3px; white-space: nowrap; }
.sos-topics .bd-badge.fail { color: #F2AFAF; }
.sos-topics .bd-head { display: flex; align-items: flex-start; gap: 10px; }
.sos-topics .bd-head .bd-status { flex: 1; min-width: 0; }
.sos-topics .bd-head .bd-imp { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; margin-bottom: 6px;
  border-radius: 6px; border: 1px solid var(--accent); background: var(--bg2); color: var(--accent2, var(--accent));
  font-family: var(--sans, inherit); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.sos-topics .bd-head .bd-imp:hover { background: var(--accent); color: #fff; }
.sos-topics .bd-boxes { flex-shrink: 0; display: flex; gap: 6px; align-items: center; }
.sos-topics .bd-row .bd-box { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px;
  border-radius: 6px; background: var(--bg2); font-family: var(--sans, inherit); font-size: 12px; font-weight: 600; white-space: nowrap; }
.sos-topics .bd-row .bd-box svg { flex-shrink: 0; }
.sos-topics .bd-row .bd-box:disabled { opacity: .4; cursor: default; border-color: var(--border2); color: var(--text2); }
.sos-topics .bd-row .bd-sugg { padding: 4px 9px; color: var(--text3); }
.sos-topics .bd-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent2, var(--accent)); }
@media (max-width: 600px) { .sos-topics .bd-row { flex-wrap: wrap; } .sos-topics .bd-boxes { margin-left: 32px; } }
.sos-topics .bd-info { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 12px; padding: 0 4px; }
.sos-topics .bd-detail { font-size: 11px; color: var(--text3); line-height: 1.55; margin: 4px 0 8px; }
.sos-topics .bd-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0 4px; }
.sos-topics .bd-actions button, .sos-topics .bd-row button { font-size: 11px; font-family: var(--mono); padding: 4px 10px;
  border-radius: 4px; border: 1px solid var(--border2); background: none; color: var(--text2); cursor: pointer; }
.sos-topics .bd-actions button:hover, .sos-topics .bd-row button:hover { border-color: var(--accent); color: var(--accent2); }
.sos-topics .bd-actions .quiet { border-color: transparent; color: var(--text3); }

/* ── Lesson reader ───────────────────────────────────────────────────── */
#sos-lesson-root { max-width: 760px; margin: 0 auto; padding-bottom: 60px; }
.sl-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
.sl-back { background: none; border: none; color: var(--text3); font-size: 12px; font-family: var(--mono); cursor: pointer; padding: 4px 0; max-width: 60%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.sl-back:hover { color: var(--accent2); }
.sl-crumb { font-size: 11px; color: var(--text3); font-family: var(--mono); letter-spacing: .3px; }
.sl-title { font-family: var(--font-accent); font-size: 28px; line-height: 1.2; color: var(--text); margin: 0 0 6px; font-weight: 600; }
.sl-sub { font-size: 13px; color: var(--text3); margin-bottom: 16px; line-height: 1.5; }
.sl-bar { height: 3px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
.sl-bar > div { height: 100%; background: var(--accent); transition: width .25s; }
.sl-count { font-size: 11px; color: var(--text3); font-family: var(--mono); margin: 8px 0 14px; display: flex; justify-content: space-between; }
.sl-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 26px 28px; min-height: 240px; }
.sl-card.example { border-left: 3px solid var(--accent); }
.sl-kind { font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--accent2); font-family: var(--mono); margin-bottom: 6px; }
.sl-card h2 { font-size: 19px; color: var(--text); margin: 0 0 14px; font-weight: 700; line-height: 1.3; }
.sl-prose { font-size: 15.5px; line-height: 1.72; color: var(--text2); }
.sl-prose p { margin: 0 0 14px; }
.sl-prose h3, .sl-prose h4 { color: var(--text); margin: 20px 0 8px; font-size: 16px; }
.sl-prose strong { color: var(--text); }
.sl-prose ul, .sl-prose ol { margin: 0 0 14px; padding-left: 22px; }
.sl-prose li { margin: 4px 0; }
.sl-prose code { font-family: var(--mono); font-size: 13px; background: var(--bg4); padding: 1px 5px; border-radius: 4px; color: var(--text); }
.sl-prose pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; overflow-x: auto; margin: 0 0 14px; }
.sl-prose pre code { background: none; padding: 0; font-size: 13px; line-height: 1.55; white-space: pre; }
.sl-prose blockquote { margin: 0 0 14px; padding: 8px 14px; border-left: 3px solid var(--accent); background: var(--bg3); border-radius: 0 6px 6px 0; }
.sl-prose .md-table { overflow-x: auto; margin: 0 0 14px; }
.sl-prose table { border-collapse: collapse; font-size: 13.5px; min-width: 100%; }
.sl-prose th, .sl-prose td { border: 1px solid var(--border2); padding: 7px 10px; text-align: left; vertical-align: top; }
.sl-prose th { background: var(--bg3); color: var(--text); }
.sl-fig { margin: 0 0 14px; }
.sl-fig img { display: block; max-width: 100%; height: auto; margin: 0 auto; border: 1px solid var(--border2); border-radius: 6px; background: #fff; }
.sl-fig img.drawn { width: 100%; max-height: 70vh; padding: 10px; box-sizing: border-box; }
.sl-fig figcaption { margin-top: 6px; }
.sl-fig figcaption .sl-link { font-size: 12px; padding: 0; }
.sl-fig-slot { padding: 24px; text-align: center; border: 1px dashed var(--border2); border-radius: 6px; }
.sl-step { display: flex; gap: 14px; padding: 12px 0; border-top: 1px solid var(--border); }
.sl-step:first-of-type { border-top: none; }
.sl-step-n { flex: 0 0 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--bg); display: grid; place-items: center;
  font-weight: 700; font-size: 13px; }
.sl-step-t { color: var(--text); font-weight: 700; font-size: 15px; margin: 3px 0 6px; }
.sl-q { margin-bottom: 20px; }
.sl-q-stem { color: var(--text); font-size: 15px; line-height: 1.55; margin-bottom: 8px; }
.sl-choice { display: block; width: 100%; text-align: left; background: var(--bg3); border: 1px solid var(--border2); color: var(--text2);
  padding: 10px 12px; border-radius: 6px; margin: 6px 0; font-size: 14px; cursor: pointer; font-family: inherit; line-height: 1.4; }
.sl-choice:hover { border-color: var(--accent); }
.sl-choice.picked { border-color: var(--accent); color: var(--text); background: rgba(141,118,154,.14); }
.sl-choice.right { border-color: #A8DCC0; background: rgba(111,191,142,.14); color: var(--text); }
.sl-choice.wrong { border-color: #F2AFAF; background: rgba(217,128,128,.12); }
.sl-choice:disabled { cursor: default; }
.sl-expl { font-size: 13.5px; line-height: 1.6; color: var(--text2); background: var(--bg3); border-radius: 6px; padding: 10px 12px; margin-top: 8px; }
.sl-verdict { font-size: 13px; font-family: var(--mono); color: var(--text2); margin-top: 6px; }
.sl-nav { display: flex; justify-content: space-between; gap: 10px; margin-top: 16px; }
.sl-nav button, .sl-inline-btn { font-size: 13px; padding: 9px 16px; border-radius: 6px; border: 1px solid var(--border2); background: var(--bg2);
  color: var(--text); cursor: pointer; font-family: inherit; }
.sl-nav button.primary, .sl-inline-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 700; }
.sl-nav button:disabled { opacity: .4; cursor: default; }
.sl-topicnav { display: flex; justify-content: space-between; gap: 12px; margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border); }
.sl-topicnav button { background: none; border: none; color: var(--text3); font-size: 12px; cursor: pointer; max-width: 48%; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: inherit; }
.sl-topicnav button:last-child { text-align: right; }
.sl-topicnav button:hover { color: var(--accent2); }
.sl-add { text-decoration: none !important; opacity: .45; margin-left: 4px; white-space: nowrap; }
li:hover > .sl-add, .sl-add:focus { opacity: 1; }
@media (hover: none) { .sl-add { opacity: .7; } }
.sl-muted { font-size: 12px; color: var(--text3); line-height: 1.5; }
.sl-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.sl-link { background: none; border: none; color: var(--text3); font-size: 11px; font-family: var(--mono); cursor: pointer; text-decoration: underline; padding: 0; }
@media (max-width: 640px) {
  .sl-card { padding: 18px 16px; }
  .sl-title { font-size: 23px; }
  .sl-prose { font-size: 15px; }
}

/* ── AI settings ─────────────────────────────────────────────────────── */
#sos-ai-root { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
.ais-top { display: flex; flex-direction: column; gap: 6px; }
.ais-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 1.8px; text-transform: uppercase; color: var(--pink, #F0B3CB); }
.ais-h { font-family: var(--display, 'Lora', serif); font-size: 32px; font-weight: 600; letter-spacing: -.5px; color: #F4EEF8; margin: 0; }
.ais-lead { font-size: 14.5px; color: var(--text2); line-height: 1.6; max-width: 62ch; margin: 0; }
.ais-sec { background: linear-gradient(180deg, rgba(31, 30, 37, .78), rgba(26, 25, 31, .78)); border: 1px solid var(--border); border-radius: 20px; padding: 22px; display: flex; flex-direction: column; gap: 18px; }
.ais-sec-hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.ais-sec-hd h2 { font-family: var(--display, 'Lora', serif); font-size: 20px; font-weight: 600; color: #F1EAF6; margin: 0 0 3px; }
.ais-sec-hd p { font-size: 13.5px; color: var(--text3); margin: 0; }
.ais-now { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12px; font-weight: 800; color: var(--mint, #A8DCC0); background: rgba(168, 220, 192, .12); }
.ais-now::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ais-now:empty { display: none; }
.ais-prov { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.ais-prov button {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left;
  background: rgba(228, 214, 242, .03); border: 1px solid var(--border2); border-radius: 16px; padding: 14px 14px 13px; cursor: pointer;
  color: var(--text); font-family: inherit; transition: border-color .18s, background .18s, transform .18s;
}
.ais-prov button:hover { border-color: var(--border3); transform: translateY(-1px); }
.ais-prov-ic { width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--lav, #C9B4D8); background: rgba(201, 180, 216, .12); }
.ais-prov-ic svg { width: 18px; height: 18px; }
.ais-prov-t { font-size: 14px; font-weight: 800; line-height: 1.3; padding-right: 22px; }
.ais-prov button small { display: block; color: var(--text3); font-size: 12px; line-height: 1.45; }
.ais-prov-tick { position: absolute; top: 12px; right: 12px; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #1a181e; background: transparent; border: 1.5px solid var(--border3); transition: background .18s, border-color .18s; }
.ais-prov-tick svg { width: 11px; height: 11px; opacity: 0; }
.ais-prov button.on { border-color: rgba(240, 179, 203, .55); background: linear-gradient(160deg, rgba(240, 179, 203, .1), rgba(201, 180, 216, .06)); }
.ais-prov button.on .ais-prov-ic { color: var(--pink, #F0B3CB); background: rgba(240, 179, 203, .14); }
.ais-prov button.on .ais-prov-tick { background: linear-gradient(135deg, #C9B4D8, #F0B3CB); border-color: transparent; }
.ais-prov button.on .ais-prov-tick svg { opacity: 1; }
.ais-panel { display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 16px; background: rgba(10, 9, 12, .3); border: 1px solid var(--border); }
.ais-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ais-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ais-field { min-width: 0; }
.ais-field label { display: block; font-size: 11px; font-weight: 800; color: var(--text2); letter-spacing: 1.1px; margin-bottom: 7px; text-transform: uppercase; }
.ais-field input:not([type=checkbox]) { width: 100%; box-sizing: border-box; height: 44px; background: rgba(10, 9, 12, .45); border: 1px solid var(--border2); color: var(--text);
  border-radius: 11px; padding: 0 14px; font-size: 14px; font-family: var(--sans, inherit); font-weight: 600; outline: none; transition: border-color .18s, box-shadow .18s; }
.ais-field input:focus { border-color: rgba(201, 180, 216, .6); box-shadow: 0 0 0 3px rgba(201, 180, 216, .2); }
#ais-key, #ais-base, #ais-model { font-family: var(--mono); font-size: 13px; }
.ais-hint { font-size: 12px; color: var(--text3); margin-top: 7px; line-height: 1.45; }
.ais-keyrow { display: flex; gap: 8px; }
.ais-keyrow input, .ais-keyrow .sosc-trigger { flex: 1; min-width: 0; }
.ais-keyrow .btn { height: 44px; flex-shrink: 0; }
.ais-note { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--text2); line-height: 1.6; background: rgba(201, 180, 216, .06); border: 1px solid rgba(201, 180, 216, .14); border-radius: 12px; padding: 12px 14px; margin: 0; }
.ais-note b { color: var(--text); }
.ais-note code { font-family: var(--mono); font-size: 12px; background: rgba(228, 214, 242, .08); padding: 1px 6px; border-radius: 6px; color: #E7D9F0; }
.ais-note-ic { flex-shrink: 0; color: var(--lav, #C9B4D8); margin-top: 1px; }
.ais-note-ic svg { width: 16px; height: 16px; display: block; }
.ais-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ais-msg { font-size: 13px; font-weight: 700; line-height: 1.5; color: var(--text3); }
.ais-msg:empty { display: none; }
.ais-actions .ais-msg { margin-left: 6px; }
.ais-msg.ok { color: var(--mint, #A8DCC0); }
.ais-msg.err { color: var(--rose, #F2AFAF); }
.ais-switches { display: flex; flex-direction: column; border-top: 1px solid var(--border); margin-top: 4px; }
.ais-switch-row { display: flex; align-items: center; gap: 16px; padding: 14px 2px; cursor: pointer; border-bottom: 1px solid var(--border); }
.ais-switch-row:last-child { border-bottom: none; }
.ais-switch-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ais-switch-txt b { font-size: 14px; font-weight: 700; color: var(--text); }
.ais-switch-txt small { font-size: 12.5px; color: var(--text3); line-height: 1.45; }
#study-root .ais-switch { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.ais-switch-ui { position: relative; width: 44px; height: 26px; flex: 0 0 44px; border-radius: 999px; background: rgba(228, 214, 242, .12); border: 1px solid var(--border2); transition: background .22s, border-color .22s; }
.ais-switch-ui::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #EFECF3; box-shadow: 0 2px 6px rgba(0, 0, 0, .35); transition: transform .22s cubic-bezier(.2, .8, .2, 1); }
.ais-switch:checked + .ais-switch-ui { background: linear-gradient(135deg, #C9B4D8, #F0B3CB); border-color: transparent; }
.ais-switch:checked + .ais-switch-ui::after { transform: translateX(18px); }
.ais-switch:focus-visible + .ais-switch-ui { box-shadow: 0 0 0 3px rgba(201, 180, 216, .3); }
@media (max-width: 720px) {
  .ais-grid, .ais-grid.three { grid-template-columns: 1fr; }
  .ais-sec { padding: 16px; border-radius: 18px; }
  .ais-panel { padding: 14px; }
  .ais-h { font-size: 26px; }
  .ais-prov { grid-template-columns: 1fr 1fr; }
}
`;

export function ensureStyle() {
  if (document.getElementById('sos-study-style')) return;
  const el = document.createElement('style');
  el.id = 'sos-study-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export default { ensureStyle };
