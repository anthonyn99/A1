#!/usr/bin/env node
/**
 * Class Resources regression tests.
 *
 * WHY THIS FILE EXISTS
 * The launch feature spans four files that must agree with each other, and two
 * of those agreements are invisible at any single edit site:
 *
 *   1. THE PATH REGEX. index.html, shield.html and V1/js/studyos.js each hold
 *      their own copy of _isLocalPath. A string one file calls a local path and
 *      another calls a URL either opens a dead browser tab or silently launches
 *      nothing - and nothing in either app errors when it happens. The first
 *      draft of the studyos.js copy was mangled so the UNC branch stopped
 *      matching network paths, and it looked completely fine in review.
 *
 *   2. RESOURCES MUST NOT RIDE ON MIRROR ITEMS. TaskHub's reconcile signature
 *      hashes exactly [_sosId, title, done, time, _sosClassName]. A resource
 *      blob attached to an item would not change that signature, so the
 *      reconcile would conclude nothing changed and DROP the edit. The side
 *      table exists solely to avoid that, and the property is easy to undo by
 *      accident later.
 *
 * Run: node tests/class-resources.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL ' + name); }
}
function section(s) { console.log('\n' + s); }

const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const INDEX   = R('index.html');
const SHIELD  = R('shield.html');
const STUDYOS = R('V1/js/studyos.js');
const MIRROR  = R('V1/js/taskmirror.js');

// ---------------- Part 1: the path regex must be byte-identical -------------
section('Path classifier is byte-identical across all three copies');

// These files are CRLF on disk, so the line breaks around the body must be
// matched as \r?\n - anchoring on \n alone silently yields null for ALL THREE
// bodies, and the equality assertions below then "pass" as null === null. That
// is why each extractor is asserted non-null before any comparison runs.
// Line endings are then normalised so a future LF/CRLF difference between the
// files is not reported as a regex mismatch.
function body(src, fnName) {
  const m = new RegExp('function ' + fnName + '\\(u\\)\\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}').exec(src);
  return m ? m[1].replace(/\r\n/g, '\n') : null;
}
const bIndex   = body(INDEX,   '_isLocalPath');
const bShield  = body(SHIELD,  'isLocalPath');
const bStudyos = body(STUDYOS, '_sosIsLocalPath');

t('index.html defines _isLocalPath',    bIndex   !== null);
t('shield.html defines isLocalPath',    bShield  !== null);
t('studyos.js defines _sosIsLocalPath', bStudyos !== null);
t('index.html and shield.html agree',   bIndex === bShield,
  'These two already had to match; a drift breaks local links, not just resources.');
t('studyos.js matches the other two',   bIndex === bStudyos,
  'StudyOS decides kind:app vs kind:web at save time. If its regex disagrees,\n' +
  '      a path is stored as a URL (dead tab) or a URL as a path (never launches).');

// Behavioural check: run the real body against known inputs.
if (bStudyos) {
  const isLocal = new Function('u', bStudyos);
  t('classifies https:// as NOT local', isLocal('https://example.com') === false);
  t('classifies http:// as NOT local',  isLocal('http://example.com') === false);
  t('classifies drive-backslash path as local',
    isLocal('C:\\Program Files\\MATLAB\\bin\\matlab.exe') === true);
  t('classifies drive-forwardslash path as local',
    isLocal('C:/Program Files/app.exe') === true);
  t('classifies UNC path as local', isLocal('\\\\fileserver\\share\\app.exe') === true,
    'The mangling that actually happened halved the escaped backslashes and\n' +
    '      silently stopped matching every network path.');
  // A bare host matches neither branch, so it is neither a URL nor a path.
  // saveResource() must therefore reject it explicitly rather than assuming
  // "not local" means "safe to open as a URL" - otherwise it would be stored
  // as kind:web and open a dead tab.
  t('bare "google.com" is NOT local (and is not a URL either)',
    isLocal('google.com') === false);
  t('saveResource rejects a target that is neither a URL nor a path',
    /!local\s*&&\s*!\/\^https\?:\\\/\\\/\/i\.test\(target\)/.test(STUDYOS),
    'Without this check a bare host is saved as kind:web and opens nothing.');
  t('non-string input is safe', isLocal(undefined) === false && isLocal(null) === false);
}

// ---------------- Part 2: transport shape -----------------------------------
section('Resources travel as a side table, never on mirror items');

t('buildClasses() exists in taskmirror', /function buildClasses\s*\(/.test(MIRROR));

t('mirror write includes the classes side table',
  /setDoc\(mirrorRef,\s*\{\s*items,\s*classes:\s*cls,/.test(MIRROR),
  'The classes key is what keeps resources out of the TaskHub data map.');

t('change-compare spans items AND classes',
  /JSON\.stringify\(\[items,\s*cls\]\)/.test(MIRROR),
  'Keyed on items alone, a pure-resource edit (no task touched) looks unchanged\n' +
  '      and is never written at all.');

t('items carry _sosClassId for the class lookup',
  (MIRROR.match(/_sosClassId:\s*c\s*\?\s*c\.id\s*:\s*''/g) || []).length === 2,
  'Expected on both the task and the event builder.');

t('reconcile signature is unchanged (5 fields)',
  /\[t\._sosId,t\.title,t\.done,t\.time\|\|"",t\._sosClassName\|\|""\]/.test(INDEX),
  'If a resource field is ever added here, every label edit triggers a full\n' +
  '      strip-and-re-add of every StudyOS row plus a whole-document write.');

t('resource payload is NOT attached to mirror items',
  !/items\[sid\]\s*=\s*\{[\s\S]{0,400}?resources:/.test(MIRROR),
  'Attaching resources to an item makes the edit invisible to sig() and it gets\n' +
  '      silently dropped. Use the classes side table.');

section('Native paths never reach the phone-visible mirror');

t('buildClasses omits r.path',
  !/\{\s*id:\s*r\.id,\s*kind:\s*'app',[^}]*path/.test(MIRROR),
  'App paths belong only in the Shield-only class-apps document.');

t('a separate class-apps document is written',
  /setDoc\(appsRef,\s*\{\s*apps,/.test(MIRROR) && /classAppsDoc/.test(MIRROR));

t('class-apps has its own change-compare', /lastAppsSerialized/.test(MIRROR),
  'App paths change about once a semester; they must not rewrite on task churn.');

// ---------------- Part 3: TaskHub read path stays read-only -----------------
section('TaskHub launch path never writes');

const sosBlock = (INDEX.match(/const \[sosResMap,setSosResMap\][\s\S]{0,2000}?const sosMirrorSigRef/) || [''])[0];
t('sosResMap block exists', sosBlock.length > 0);
t('sosResMap never calls setData/setDataBg',
  sosBlock.length > 0 && !/setData\s*\(|setDataBg\s*\(/.test(sosBlock),
  'This is display state only. A write here would replay stale state over the\n' +
  '      good cloud document - and if it ever must write, it is setDataBg, never setData.');

t('_sosMirrorClasses is set after the fromCache guard',
  /fromCache\)\s*return;[\s\S]{0,900}?window\._sosMirrorClasses\s*=/.test(INDEX),
  'Set before the guard, it would carry cached-doc data on a phone open.');

const lh = /window\._sosLaunchClass\s*=\s*function[\s\S]*?\n};/.exec(INDEX);
t('launch handler exists', !!lh);

/* Order-sensitive assertions must run against CODE ONLY.
 *
 * This bit them twice. The handler's own doc comment necessarily spells out
 * the very calls being asserted on ("window.open('', NAME)", "_tnOpenTab"),
 * and a plain text scan cannot tell prose from code - so a comment near the
 * top of the function satisfied the "opens tabs first" ordering no matter
 * where the real call sat. A mutation that hoisted the protocol navigation
 * above the entire open loop still passed. Blanking comments first is what
 * makes these assertions mean anything. Offsets are preserved (comments are
 * replaced with spaces, not deleted) so every index below stays comparable. */
const codeOnly = s => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
const LH = lh ? codeOnly(lh[0]) : '';

/* THE SHIELD HANDOFF COMES FIRST, and returns.
 *
 * A browser grants one new tab per user gesture - measured in Brave and Edge:
 * three consecutive window.open('', name) calls in one click return a window,
 * null, null, and a real anchor click and a trusted CDP click do the same. It
 * is not the popup blocker (reproduced with pop-ups allowed and shields off).
 * So the page CANNOT open a two-site class by itself, and the only thing that
 * opens them all is handing the class to Shield, which is not a page.
 *
 * If a future edit moves the tab loop above this handoff, every Shield user
 * gets a stray browser tab before the agent opens the same site again. */
const shieldIdx = LH.indexOf("'shieldopen:class/");
const fallbackIdx = LH.search(/var\s+blocked\s*=\s*0/);
t('the shield handoff exists', shieldIdx >= 0);
t('shield is tried before the browser fallback',
  shieldIdx >= 0 && fallbackIdx >= 0 && shieldIdx < fallbackIdx,
  'Opening tabs first would double-open every site on a machine with Shield.');
t('the shield path returns instead of falling through',
  /return\s*\{[^}]*via:\s*'shield'/.test(LH),
  'Falling through would run the browser opens as well.');

/* Within the FALLBACK, the old ordering rule still holds: the protocol call
 * for native apps can raise a dialog that ends the gesture, so any tab not yet
 * requested when it fires is refused. Measure from the fallback's start so the
 * early shield handoff does not satisfy this by accident. */
const FB = fallbackIdx >= 0 ? LH.slice(fallbackIdx) : '';
const firstOpen = (function(){
  const m = /window\.open\s*\(/.exec(FB);
  return m ? m.index : -1;
})();
t('fallback opens tabs with a real window.open', firstOpen >= 0,
  'If this stops matching, the assertion below is comparing -1 and passes for free.');
t('fallback requests tabs before the protocol navigation',
  firstOpen >= 0 && FB.indexOf("'shieldopen:class/") >= 0 &&
  firstOpen < FB.indexOf("'shieldopen:class/"),
  'The protocol call can raise a dialog that ends the user gesture, blocking\n' +
  '      every tab that had not been requested yet.');
t('launch handler defers nothing out of the user gesture',
  !!lh && !/setTimeout|requestAnimationFrame|\.then\(/.test(lh[0]),
  'Anything asynchronous here is guaranteed to be popup-blocked.\n' +
  '      NOTE: this greps the whole function body, comments included, so do not\n' +
  '      write those names in prose in here either.');

// ---- The browser fallback's blank-first open -------------------------------
// The fallback still cannot beat the one-tab-per-gesture cap - only Shield
// does - but the blank-first shape is still load-bearing there: an open with
// an EMPTY url re-targets a tab that already exists without navigating it,
// which is not a new tab and so is never refused. That is what makes a repeat
// press re-focus a class's whole set once the tabs exist. Fusing the two
// passes back into open-and-navigate-per-url loses that.
//
// Anchor on PASS 1 specifically - the open inside the slots mapping. Testing
// merely that some window.open('',...) exists is not enough: the blocked-path
// re-probe is also a blank open, so a pass 1 regressed to
// window.open(r.url, name) would still satisfy it. Verified by mutation.
const pass1 = /slots\s*=\s*web\.map\(function[\s\S]*?\n\s*\}\);/.exec(FB);
t('pass 1 exists as a web.map over the resources', !!pass1,
  'If this stops matching, the blank-open assertion below passes for free.');
t('all tabs are claimed blank before any url is assigned',
  !!pass1 && /window\.open\s*\(\s*''\s*,/.test(pass1[0]) && !/window\.open\s*\([^'")]*r\.url/.test(pass1[0]),
  'A url passed to the FIRST open spends the popup budget on one site and every\n' +
  '      other resource silently fails to open - the original bug.');
t('navigation happens by assigning to a held handle',
  !!lh && /\.location\.href\s*=\s*r\.url|\.location\.replace\s*\(\s*r\.url/.test(lh[0]),
  'Pass 2 must navigate the window objects pass 1 returned.');
t('the blocked count comes from re-probing, not from a.click()',
  !!lh && /a\.click\(\)[\s\S]{0,400}?window\.open\s*\(\s*''\s*,[\s\S]{0,200}?blocked\+\+/.test(lh[0]),
  'a.click() never throws when a blocker drops the navigation, so a refused\n' +
  '      tab is indistinguishable from a successful one. Only the presence of the\n' +
  '      named tab afterwards is a trustworthy signal.');

// The happy path must stay silent. A dialog on every launch would defeat the
// one-click goal just as thoroughly as the tabs not opening.
const lc = /window\._sosLaunchClassClick\s*=\s*function[\s\S]*?\n};/.exec(INDEX);
t('a click wrapper exists', !!lc);
t('the wrapper only speaks up when tabs were actually blocked',
  !!lc && /if\s*\(\s*!r\s*\|\|\s*!r\.blocked\s*\)\s*return/.test(lc[0]),
  'Any prompt on the success path defeats the point of one-click launch.');
t('every play button routes through the wrapper',
  (INDEX.match(/_sosLaunchClassClick\s*&&\s*window\._sosLaunchClassClick\(/g) || []).length === 4 &&
  !/onClick:[^}]*window\._sosLaunchClass\(/.test(INDEX),
  'A card still calling _sosLaunchClass directly would swallow the blocked count.');

section('StudyOS editor persists through the supported path');

t('saveResource calls persist()',          /function saveResource\(\)[\s\S]*?persist\(\);/.test(STUDYOS));
t('saveResource nudges the task mirror',   /function saveResource\(\)[\s\S]*?_vedaUpdateTask/.test(STUDYOS),
  'persist() alone never rebuilds the mirror, so the change would not reach TaskHub.');
t('deleteResource nudges the task mirror', /function deleteResource\(id\)[\s\S]*?_vedaUpdateTask/.test(STUDYOS));
t('editing app to web clears the stale path',
  /delete r\.path/.test(STUDYOS) && /delete r\.url/.test(STUDYOS),
  'A leftover path would still be launched by Shield.');

/* ── The Shield launch path, end to end ─────────────────────────────────────
 * Websites reach Shield through FOUR files that must agree, and a break in any
 * one of them is silent — the click still "works", it just opens fewer sites,
 * which is indistinguishable from the bug this whole path exists to fix:
 *
 *   taskmirror.js  puts urls in the class-apps doc
 *   shield.html    forwards them into the agent's link map
 *   proc.rs        opens an http(s) url instead of rejecting it as "notfound"
 *   lib.rs         calls the url-aware opener for class resources
 *
 * A browser cannot do this itself: one user gesture buys one new tab (measured
 * in Brave and Edge; not the popup blocker), so the page can never open a
 * two-site class on its own. */
section('Class websites reach Shield');

const PROC = R('desktop/shield/src-tauri/src/proc.rs');
const LIB  = R('desktop/shield/src-tauri/src/lib.rs');

t('the desktop doc carries websites, not just native apps',
  /kind === 'app'[\s\S]{0,200}?url:\s*r\.url/.test(MIRROR),
  'buildClassApps filtering to kind==="app" again is what silently strips every\n' +
  '      website back out of the desktop path.');

t('shield.html forwards http(s) resources to the agent',
  /https\?:\\\/\\\//.test(SHIELD) && /out\['cls:'[\s\S]{0,120}?r\.url/.test(SHIELD),
  'Without this the urls sit in the document and never reach local_links.');
t('shield.html still gates on scheme before forwarding',
  /_classAppsListen[\s\S]*?\/\^https\?:\\\/\\\/\/i\.test\(r\.url\)/.test(SHIELD),
  'Forwarding an arbitrary scheme would hand file:/custom-protocol targets to\n' +
  '      the shell via `start`.');

t('class resources refresh on their OWN document, not navorder',
  /_classAppsListen[\s\S]{0,400}?onSnapshot\(doc\(db, 'dashboards\/studyos_class_apps'\)/.test(SHIELD),
  'They used to refresh only inside the navorder snapshot, so a resource added without touching dashboards/navorder never reached the agent -- the class opened its apps but never its sites.');
t('both link sources are pushed together',
  /_pushLinks[\s\S]{0,400}?_lastNavLinks[\s\S]{0,200}?_lastClsLinks/.test(SHIELD),
  'sh_set_links REPLACES the whole map, so pushing one source alone deletes the other.');
t('each listener records its own half before pushing',
  /_lastClsLinks = out;[\s\S]{0,80}?_pushLinks\(\)/.test(SHIELD) &&
  /_lastNavLinks = links;[\s\S]{0,80}?_pushLinks\(\)/.test(SHIELD),
  'A listener that pushes without recording its half publishes a stale map.');
t('the StudyOS class page opens from the play button',
  /_sosStudyOsClassUrl\(classId\)[\s\S]{0,300}?_tnOpenTab\(sosUrl, window\._sosStudyOsTabKey\(\)\)/.test(LH),
  'Pressing play should open the class in StudyOS as well as its sites/apps.');
t('the StudyOS tab is opened BEFORE the shieldopen navigation',
  LH.indexOf("_tnOpenTab(sosUrl, 'studyos')") < LH.indexOf("'shieldopen:class/'"),
  'The protocol navigation can raise a dialog that ends the user gesture, and',
  'anything opened after it is refused.');
t('an unconfigured StudyOS url changes nothing',
  /if \(sosUrl\)/.test(LH) && /if \(sosUrlB\)/.test(LH),
  'Both call sites must guard on a truthy url, so with none configured the play button behaves exactly as before.');
t('StudyOS is counted in the browser fallback, not special-cased',
  /web = \[\{ id: '_studyos'[\s\S]{0,80}?\]\.concat\(web\)/.test(LH),
  'Opening it outside the slots accounting would report success for a tab that',
  'a hard blocker actually refused.');
t('a StudyOS resource is dropped so it does not open a second tab',
  /window\._sosIsSameStudyOs\(r\.url, sosClassUrl\)/.test(LH),
  'The button already opens StudyOS at this class; keeping the resource opens a second tab at StudyOS in general.');
t('the drop happens at the split, so BOTH launch paths get it',
  LH.indexOf('_sosIsSameStudyOs(r.url, sosClassUrl)') < LH.indexOf("'shieldopen:class/'"),
  'Filtering after the split would leave the Shield path still opening it.');
t('the resource is kept when no StudyOS url is configured',
  /sosClassUrl && window\._sosIsSameStudyOs/.test(LH),
  'With no class url available the resource is the only thing that opens StudyOS -- swallowing it would lose the tab.');
// _sosIsSameStudyOs is defined OUTSIDE _sosLaunchClass, so it is not in LH --
// assert against the whole file for this one.
t('same-app matching ignores query, hash and trailing slash',
  /_sosIsSameStudyOs[\s\S]{0,500}?x\.origin \+ path/.test(INDEX) &&
  INDEX.indexOf(String.raw`index\.html?$`) > 0,
  'The resource and the generated link are never byte-identical, so a plain string compare would never match.');
// The tab-key helper lives OUTSIDE _sosLaunchClass, so assert against INDEX.
t('the StudyOS tab reuses the header link window name',
  /_sosStudyOsTabKeyValue = 'link_' \+ profile \+ '_' \+ list\[i\]\.id/.test(INDEX),
  'A key derived from studyos can never re-target a tab opened as link_veda_<id>, so the play button would open a SECOND, class-less StudyOS tab.');
t('both launch paths use that key, not a hardcoded one',
  /_tnOpenTab\(sosUrl, window\._sosStudyOsTabKey\(\)\)/.test(LH) &&
  /_tabKey: window\._sosStudyOsTabKey\(\)/.test(LH),
  'Either path left on a fixed key still opens a duplicate tab.');
t('the browser fallback honours _tabKey',
  /var key = r\._tabKey \|\|/.test(LH),
  'Without this the synthetic StudyOS row falls back to a per-resource key and opens its own tab.');
t('the tab key resets on every resolve',
  /_sosStudyOsTabKeyValue = 'studyos';[\s\S]{0,200}?try \{/.test(INDEX),
  'A stale link key would leak into a later call that resolved a different url.');
/* index.html's script blocks are NON-STRICT and top level, so `var x` there IS
   window.x. Naming the backing variable the same as the accessor meant every
   resolve overwrote window._sosStudyOsTabKey with a string; the next call threw
   "not a function", and because both call sites wrap it in try/catch the
   StudyOS tab was silently swallowed and simply stopped opening. */
t('the tab-key accessor is not clobbered by its own backing variable',
  !/^\s*var _sosStudyOsTabKey\s*=/m.test(INDEX) &&
  /window\._sosStudyOsTabKey = function\(\)\{ return _sosStudyOsTabKeyValue; \}/.test(INDEX),
  'A top-level `var _sosStudyOsTabKey` would overwrite the accessor of the same name.');
t('the agent has a url-aware opener', /pub fn open_target/.test(PROC));
t('open_target refuses non-http(s) schemes',
  /fn is_web_url[\s\S]*?starts_with\("http:\/\/"\)[\s\S]*?starts_with\("https:\/\/"\)/.test(PROC),
  '`start` resolves EVERY registered protocol, so an unrestricted target could\n' +
  '      reach file: or shieldopen: itself.');
t('open_target rejects control characters',
  /fn is_web_url[\s\S]*?is_control\(\)/.test(PROC),
  'A \\r or \\n would split the target into extra cmd arguments.');
t('class resources are opened with open_target, not open_path',
  /open_from_link[\s\S]*?proc::open_target/.test(LIB),
  'open_path requires Path::exists(), so every website would be dropped as\n' +
  '      "notfound" and only the native apps would open.');

/* ---------- Part 5: file drag-out can't silently no-op ----------------------
   Dragging a resource onto Gemini/NotebookLM's upload box highlighted the box
   and then dropped NOTHING, with no error anywhere. The cause is structural:
   a File built in script is not serialised across browsing contexts, so a
   cross-page drop reads an empty dataTransfer.files. Nothing here can fix
   that, so the row must offer a route that does cross origins (clipboard, or
   a real file on disk) and must SAY so when a drag is refused - otherwise the
   only feedback is a highlight that lies. */
section('Drag-out degrades loudly, not silently');
t('a refused drag tells the user why',
  /dropEffect === 'none'\) _sosDragOutHint\(\)/.test(STUDYOS),
  'Without this the failed cross-page drop is indistinguishable from a\n' +
  '      successful one - the box highlights either way.');
t('the hint fires at most once per session',
  /_sosDragHintShown\) return;\s*\n\s*_sosDragHintShown = true;/.test(STUDYOS),
  'A notification on every retry would bury the advice it is giving.');
t('_sosDragOutHint takes no argument its caller stopped passing',
  /function _sosDragOutHint\(\)/.test(STUDYOS),
  'The call site passes nothing; a named parameter here would read undefined.');
t('rows offer a clipboard route out',
  /item\.appendChild\(cpBtn\);/.test(STUDYOS) &&
  /async function sosCopyFileToClipboard/.test(STUDYOS),
  'The clipboard is the ONLY transfer that reaches another origin, so without\n' +
  '      this button the drag failure leaves no working path at all.');
t('a clipboard type the OS refuses falls back to a download',
  /const ok = await sosCopyFileToClipboard\(f\);[\s\S]{0,600}?\} else \{[\s\S]{0,900}?sosDownloadFile\(f\)/.test(STUDYOS),
  'ClipboardItem rejects PDF/DOCX - the common case here - so a bare copy\n' +
  '      would fail for most resources with nothing to fall back on.');
t('the clipboard write is guarded for browsers without ClipboardItem',
  /typeof ClipboardItem === 'undefined'\) return false/.test(STUDYOS),
  'An unguarded reference throws a ReferenceError instead of falling back.');
t('the row tooltip no longer promises drag works into any app',
  !/drag out to copy into another app/.test(STUDYOS),
  'That wording is what sent the user retrying the drag into Gemini.');
t('DownloadURL is still set, so dragging to Explorer keeps working',
  /setData\('DownloadURL', mime \+ ':' \+ f\.name \+ ':' \+ _dragUrl\)/.test(STUDYOS),
  'The OS-shell drop is a real, working path and must not be lost in the fix.');

/* ---------- Part 6: the native drag path (desktop shell) --------------------
   The browser CANNOT hand a file to another app, so the Tauri shell in
   V1/StudyOS/desktop does it natively. Two things must hold or the feature
   silently reverts to the broken behaviour it was built to replace:
   the native path must be feature-detected (so the browser build is untouched),
   and the HTML5 drag must be OFF in the shell (a drag already in flight fights
   startDrag for the same gesture and the native drag never begins). */
section('Native drag-out is gated and does not collide with the HTML5 drag');
t('the native path is feature-detected, not assumed',
  /const SOS_NATIVE_DRAG = !!\(typeof window !== 'undefined' && window\.__TAURI__ && window\.__TAURI__\.drag\)/.test(STUDYOS),
  'Referencing window.__TAURI__.drag unguarded throws in a plain browser and\n' +
  '      takes the whole resource list down with it.');
t('the shell turns the HTML5 drag OFF',
  /if \(SOS_NATIVE_DRAG\) \{\s*\n\s*item\.draggable = false;/.test(STUDYOS),
  'startDrag seizes the pointer. Leaving draggable=true means an HTML5 drag is\n' +
  '      already in flight for the same gesture and the native drag never starts.');
t('the native drag is armed from a pointer gesture, not dragstart',
  /if \(SOS_NATIVE_DRAG\)[\s\S]{0,900}?addEventListener\('mousedown'[\s\S]{0,900}?sosStartNativeDrag/.test(STUDYOS),
  'dragstart never fires once draggable is false, so wiring it there would\n' +
  '      leave the shell with no drag at all.');
t('a plain click still opens the file rather than starting a drag',
  /Math\.abs\(mv\.clientX - x0\) < 5 && Math\.abs\(mv\.clientY - y0\) < 5\) return;/.test(STUDYOS),
  'Without a movement threshold every click begins a drag and the row stops\n' +
  '      opening.');
t('row buttons are not drag handles',
  /ev\.target\.closest\('button, a'\)\) return;/.test(STUDYOS),
  'Otherwise pressing Copy or Download starts a file drag instead.');
t('the browser-only hint is suppressed in the shell',
  /if \(SOS_NATIVE_DRAG\) return;\s*\n\s*if \(_sosDragHintShown\) return;/.test(STUDYOS),
  'The hint explains a cross-origin limit the shell does not have — showing it\n' +
  '      there would be actively wrong.');
t('staging is keyed and cached so hover does not re-encode on every pass',
  /_sosStagedPaths\.has\(key\)\) return _sosStagedPaths\.get\(key\)/.test(STUDYOS),
  'mouseenter fires constantly; re-reading and base64-ing a large PDF each\n' +
  '      time would stall the list.');
t('a failed staging is evicted so it can be retried',
  /_sosStagedPaths\.delete\(key\);/.test(STUDYOS),
  'Caching a rejected promise makes one transient failure permanent for the\n' +
  '      rest of the session.');
t('the blob is base64-ed in chunks',
  /const CHUNK = 0x8000;/.test(STUDYOS),
  'String.fromCharCode(...bytes) on a whole PDF exceeds the argument limit and\n' +
  '      throws, so every large file would fail to stage.');

// ---------------------------- summary ---------------------------------------
console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' class-resources: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
