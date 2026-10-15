// POST /fuel/plan (Everwell's nutrition plan): the real fetch handler of
// worker.js against a fake upstream (ORCA + Gemini). No network.
//
// Run: node workers/personal-ai/fuel.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SP = mkdtempSync(join(tmpdir(), 'fueltest-'));
writeFileSync(SP + '/_w.mjs', readFileSync(new URL(process.env.PA_WORKER_FILE || './worker.js', import.meta.url), 'utf8'));

// Upstream script: each test sets ORCA(body) / GEMINI(body) to a response.
let ORCA = null, GEMINI = null;
const CALLS = [];
const resp = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, opts) => {
  const u = String(url), body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith('https://orca.vedapatel05.workers.dev/')) {
    const c = body.messages[0].content;
    CALLS.push({ to: 'orca', model: body.model, auth: opts.headers.Authorization, images: Array.isArray(c) ? c.filter((p) => p.type === 'image_url').length : 0, prompt: Array.isArray(c) ? c[0].text : c });
    return ORCA(body);
  }
  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    const parts = body.contents[0].parts;
    CALLS.push({ to: 'gemini', model: u.split('/models/')[1].split(':')[0], images: parts.filter((p) => p.inlineData).length, prompt: parts[0].text });
    return GEMINI(body);
  }
  throw new Error('unexpected fetch ' + u);
};
const mod = await import(pathToFileURL(SP + '/_w.mjs').href);
const worker = mod.default;

const ENV = { TONY_ORCA_KEY: 'orca_sk_test', TONY_GEMINI_KEY: 'gk_test' };
const PERSON = { name: 'Tony', stats: { sex: 'male', age: 27, heightIn: 70, weightLb: 175, goal: 'recomp', dayActivity: 'desk', diet: 'No pork' } };
const TRAINING = { perWeek: 5, minutes: 60, kind: 'weights', splits: ['Push', 'Pull', 'Legs'], routines: [{ name: 'Push', lines: ['Bench Press - 4 x 8', 'Overhead Press - 3 x 8'] }], circuits: [{ name: 'Core', minutes: 10 }], done21: { done: 12, planned: 15 } };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
const call = async (body, env = ENV) => {
  const r = await worker.fetch(new Request('https://personal-ai.av1.workers.dev/fuel/plan', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), env);
  return { status: r.status, body: await r.json() };
};
const GOOD = { calories: 2500, protein: 175, carbs: 270, fat: 78, fiber: 35, waterOz: 120, meals: 3, mealNames: ['Breakfast', 'Lunch', 'Dinner'], activity: 'active', notes: ['Protein at every meal.', '**Front-load** carbs around training.'] };
const orcaSays = (obj, model) => () => resp(200, { model: model || 'deepseek/free', choices: [{ message: { content: typeof obj === 'string' ? obj : 'Here you go:\n```json\n' + JSON.stringify(obj) + '\n```' } }] });
const geminiSays = (obj) => () => resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const reset = () => { CALLS.length = 0; ORCA = GEMINI = null; };

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 500) : '')); } };

console.log('\nGuard rails');
reset();
ok('profile must be tony', (await call({ profile: 'veda', person: PERSON })).status === 400 && CALLS.length === 0);
ok('missing stats are refused before any AI call', (await call({ profile: 'tony', person: { stats: { sex: 'male', age: 30 } } })).status === 400 && CALLS.length === 0);
ok('out-of-range numbers count as missing', (await call({ profile: 'tony', person: { stats: { sex: 'male', age: 30, heightIn: 300, weightLb: 170 } } })).status === 400);
const inp = mod.fuelInput({ person: { stats: Object.assign({}, PERSON.stats, { diet: 'x'.repeat(900), goal: 'bulk!!', dayActivity: 'nope' }) }, training: { perWeek: 99, splits: new Array(30).fill('S') }, photos: [PHOTO, 'data:text/html;base64,PGI+', PHOTO, PHOTO, PHOTO] });
ok('input is cleaned: capped text, unknown goal/activity fall back, at most 3 image photos', inp.stats.diet.length === 300 && inp.stats.goal === 'maintain' && inp.stats.dayActivity === 'desk' && inp.training.perWeek === 0 && inp.training.splits.length === 10 && inp.photos.length === 3 && inp.photos.every((p) => p.mimeType === 'image/jpeg'), inp);

console.log('\nThe estimate (Mifflin-St Jeor)');
const est = mod.fuelEstimate(PERSON.stats, TRAINING);
ok('BMR for a 27 y, 70 in, 175 lb man is ~1775 kcal', Math.abs(est.bmr - 1775) <= 3, est);
ok('training raises the factor (5 x 60 min) and recomp trims the target 5%', est.factor === 1.38 && est.target === Math.round(est.tdee * 0.95), est);
ok('a woman of the same size is 166 kcal lower', est.bmr - mod.fuelEstimate(Object.assign({}, PERSON.stats, { sex: 'female' }), TRAINING).bmr === 166);

console.log('\nORCA, text only (no photos): DeepSeek first');
reset(); ORCA = orcaSays(GOOD);
let r = await call({ profile: 'tony', person: PERSON, training: TRAINING });
ok('one ORCA call, to DeepSeek, with the ORCA key; nothing to Gemini', r.body.ok && r.body.via === 'orca' && CALLS.length === 1 && CALLS[0].model === 'deepseek/free' && CALLS[0].auth === 'Bearer orca_sk_test', { r, CALLS });
ok('the plan is clean: calories rounded, notes stripped of Markdown, meal names kept', r.body.plan.calories === 2500 && r.body.plan.notes[1] === 'Front-load carbs around training.' && r.body.plan.mealNames.join() === 'Breakfast,Lunch,Dinner' && r.body.plan.meals === 3, r.body.plan);
ok('the prompt carries the stats, the rotation, a routine, the completion rate and the JSON shape', /male, 27 years, 5 ft 10 in, 175 lb/.test(CALLS[0].prompt) && /Rotation: Push, Pull, Legs/.test(CALLS[0].prompt) && /Bench Press - 4 x 8/.test(CALLS[0].prompt) && /12 of 15 planned/.test(CALLS[0].prompt) && /Reply with JSON only/.test(CALLS[0].prompt) && /No pork/.test(CALLS[0].prompt));
ok('the answer carries the estimate, never a key', r.body.estimate && r.body.estimate.bmr > 0 && !JSON.stringify(r.body).includes('orca_sk_test') && !JSON.stringify(r.body).includes('gk_test'));

reset(); ORCA = orcaSays(GOOD);
r = await call({ profile: 'tony', person: Object.assign({}, PERSON, { notes: 'Lifting 5 days a week for about a year. Bad left knee, "no squats".' }), training: TRAINING });
ok('the person\'s own notes for the AI go in the prompt (quotes made safe)', /In their own words/.test(CALLS[0].prompt) && /about a year\. Bad left knee, 'no squats'\./.test(CALLS[0].prompt), CALLS[0] && CALLS[0].prompt);
reset(); ORCA = orcaSays(GOOD);
await call({ profile: 'tony', person: PERSON, training: TRAINING });
ok('no notes: no notes section, and never the word "null"', !/In their own words/.test(CALLS[0].prompt) && !/\bnull\b/.test(CALLS[0].prompt));

console.log('\nPhotos: the units that can see them go first');
reset(); ORCA = orcaSays(GOOD, 'chatgpt/free');
r = await call({ profile: 'tony', person: PERSON, training: TRAINING, photos: [PHOTO, PHOTO] });
ok('ChatGPT first, with both photos as image_url parts', r.body.ok && CALLS[0].model === 'chatgpt/free' && CALLS[0].images === 2 && r.body.sawPhotos === true, CALLS);
ok('the prompt asks to judge build only, never to comment on looks', /ONLY to judge build and body composition/.test(CALLS[0].prompt));
reset(); ORCA = (b) => b.model === 'chatgpt/free' ? resp(404, { error: 'no backend' }) : orcaSays(GOOD, b.model)();
r = await call({ profile: 'tony', person: PERSON, training: TRAINING, photos: [PHOTO] });
ok('ChatGPT unavailable → Gemini web, photos still attached', r.body.ok && CALLS.map((c) => c.model).join() === 'chatgpt/free,gemini_web/free' && CALLS[1].images === 1, CALLS.map((c) => c.model));
reset(); ORCA = (b) => (b.model === 'chatgpt/free' || b.model === 'gemini_web/free') ? resp(404, {}) : orcaSays(GOOD, b.model)();
r = await call({ profile: 'tony', person: PERSON, training: TRAINING, photos: [PHOTO] });
ok('no unit can see → the text chain from DeepSeek, without the photos (and no unit asked twice)', r.body.ok && CALLS.map((c) => c.model).join() === 'chatgpt/free,gemini_web/free,deepseek/free' && CALLS[2].images === 0 && !/photo/.test(CALLS[2].prompt) && r.body.sawPhotos === false, CALLS.map((c) => c.model));

console.log('\nAnswers are checked');
reset(); let n = 0;
ORCA = (b) => { n++; return n === 1 ? orcaSays(Object.assign({}, GOOD, { calories: 4200 }))() : n === 2 ? orcaSays(Object.assign({}, GOOD, { calories: 900 }))() : n === 3 ? orcaSays('I recommend about 2500 calories.')() : orcaSays(GOOD, b.model)(); };
r = await call({ profile: 'tony', person: PERSON, training: TRAINING });
ok('macros that do not add up, calories out of range, and prose are each refused; the next model answers', r.body.ok && CALLS.length === 4 && CALLS[3].model === 'grok/free', CALLS.map((c) => c.model));
ok('fuelPlan refuses calories far from the estimate (±40%)', mod.fuelPlan(Object.assign({}, GOOD, { calories: 4600, protein: 300, carbs: 500, fat: 140 }), null, est) === null);
ok('fuelPlan fixes a wrong number of meal names', mod.fuelPlan(Object.assign({}, GOOD, { meals: 4, mealNames: ['A'] }), null, est).mealNames.join() === 'Breakfast,Lunch,Snack,Dinner');
ok('fuelPlan reads JSON inside prose', !!mod.fuelPlan('Sure! {"calories":2500,"protein":175,"carbs":270,"fat":78,"waterOz":110,"meals":3,"mealNames":["B","L","D"],"notes":[]} hope it helps', null, est));

console.log('\nFallbacks');
reset(); ORCA = () => resp(503, { error: 'bridge away' }, { 'Retry-After': '60' }); GEMINI = geminiSays(GOOD);
r = await call({ profile: 'tony', person: PERSON, training: TRAINING, photos: [PHOTO] });
ok('ORCA 503 (the PC bridge is away) → straight to Gemini, one ORCA call', r.body.ok && r.body.via === 'gemini' && CALLS.filter((c) => c.to === 'orca').length === 1 && CALLS[1].to === 'gemini', CALLS.map((c) => c.to + ':' + c.model));
ok('Gemini gets the photo inline', CALLS[1].images === 1);
reset(); GEMINI = geminiSays(GOOD);
r = await call({ profile: 'tony', person: PERSON, training: TRAINING }, { TONY_GEMINI_KEY: 'gk_test' });
ok('no ORCA key → Gemini', r.body.ok && r.body.via === 'gemini' && CALLS.every((c) => c.to === 'gemini'));
reset(); ORCA = () => resp(401, {}); GEMINI = () => resp(429, {});
r = await call({ profile: 'tony', person: PERSON, training: TRAINING });
ok('everything fails → 503 { ok:false, error:"unavailable" }, no provider text', r.status === 503 && r.body.ok === false && r.body.error === 'unavailable' && Object.keys(r.body).length === 2, r);
reset(); ORCA = orcaSays(GOOD);
r = await call({ profile: 'tony', person: PERSON, training: TRAINING }, {});
ok('no keys at all → unavailable, nothing fetched', r.status === 503 && CALLS.length === 0);

console.log('\n/health');
const h = await (await worker.fetch(new Request('https://personal-ai.av1.workers.dev/health'), ENV)).json();
ok('/health lists "fuel" and the fuel models, no key material', h.features.includes('fuel') && h.fuelModels.orcaVision.join() === 'chatgpt/free,gemini_web/free' && !h.fuelModels.orca.some((m) => /claude/i.test(m)) && !JSON.stringify(h).includes('orca_sk_test'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
