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
.sos-topics .bd-status.err { color: #ef9f9f; }
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
.sos-topics .bd-badge.fail { color: #ef9f9f; }
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
.sl-choice.right { border-color: #6fbf8e; background: rgba(111,191,142,.14); color: var(--text); }
.sl-choice.wrong { border-color: #d98080; background: rgba(217,128,128,.12); }
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
.sl-flip { background: var(--bg3); border: 1px solid var(--border2); border-radius: 10px; min-height: 170px; padding: 24px; cursor: pointer;
  display: flex; flex-direction: column; justify-content: center; text-align: center; font-size: 17px; line-height: 1.55; color: var(--text); }
.sl-flip .side { font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text3); font-family: var(--mono); margin-bottom: 10px; }
.sl-flip.back { border-color: var(--accent); }
.sl-muted { font-size: 12px; color: var(--text3); line-height: 1.5; }
.sl-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.sl-link { background: none; border: none; color: var(--text3); font-size: 11px; font-family: var(--mono); cursor: pointer; text-decoration: underline; padding: 0; }
@media (max-width: 640px) {
  .sl-card { padding: 18px 16px; }
  .sl-title { font-size: 23px; }
  .sl-prose { font-size: 15px; }
}

/* ── AI settings ─────────────────────────────────────────────────────── */
#sos-ai-root { max-width: 640px; }
.ais-h { font-family: var(--font-accent); font-size: 24px; color: var(--text); margin: 0 0 6px; }
.ais-lead { font-size: 13px; color: var(--text3); line-height: 1.55; margin-bottom: 20px; }
.ais-prov { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 18px; }
.ais-prov button { text-align: left; background: var(--bg2); border: 1px solid var(--border2); border-radius: 8px; padding: 10px 12px; cursor: pointer;
  color: var(--text2); font-family: inherit; font-size: 13px; line-height: 1.35; }
.ais-prov button small { display: block; color: var(--text3); font-size: 11px; margin-top: 3px; }
.ais-prov button.on { border-color: var(--accent); background: rgba(141,118,154,.12); color: var(--text); }
.ais-field { margin-bottom: 14px; }
.ais-field label { display: block; font-size: 11px; font-family: var(--mono); color: var(--text3); letter-spacing: .4px; margin-bottom: 5px; text-transform: uppercase; }
.ais-field input { width: 100%; box-sizing: border-box; background: var(--bg2); border: 1px solid var(--border2); color: var(--text);
  border-radius: 6px; padding: 9px 11px; font-size: 13px; font-family: var(--mono); }
.ais-keyrow { display: flex; gap: 6px; }
.ais-keyrow input { flex: 1; }
.ais-note { font-size: 12px; color: var(--text3); line-height: 1.55; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin: 16px 0; }
.ais-msg { font-size: 12px; font-family: var(--mono); margin-top: 10px; min-height: 16px; line-height: 1.5; }
.ais-msg.ok { color: #8fd6ad; }
.ais-msg.err { color: #ef9f9f; }
`;

export function ensureStyle() {
  if (document.getElementById('sos-study-style')) return;
  const el = document.createElement('style');
  el.id = 'sos-study-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export default { ensureStyle };
