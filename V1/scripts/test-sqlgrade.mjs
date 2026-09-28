// Tests for the SQL drills: js/modules/drills/db/{sqlengine,grade,challenges}.js,
// run against the REAL vendored sql.js (SQLite compiled to WASM) in Node.
//
//   "every challenge's own answer passes"
//       A challenge whose model answer fails its own grader is a broken
//       exercise she would fight for ten minutes. Caught here, not by her.
//   "right data, any column order, any tie order"
//   "wrong data fails, and says why" — duplicates, missing rows, wrong sort
//   "her textbook's TOP n works" — the course writes SQL Server syntax
//
// Run with:  npm run test:sqlgrade
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vendor = resolve(here, '../vendor/sqljs-1.14.2/');
// package.json says "type": "module", so require() would load this UMD file as
// ESM and its `module.exports = initSqlJs` branch would never run. Evaluate it
// with a CommonJS wrapper instead — the same bytes the browser loads.
const { readFileSync } = await import('node:fs');
const sqlPath = resolve(vendor, 'sql-wasm.js');
const cjs = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', readFileSync(sqlPath, 'utf8'))(
  cjs, cjs.exports, require, vendor, sqlPath);
const initSqlJs = cjs.exports;

const imp = (p) => import(new URL(p, import.meta.url).href);
const engine = await imp('../js/modules/drills/db/sqlengine.js');
const { compare } = await imp('../js/modules/drills/db/grade.js');
const { CHALLENGES } = await imp('../js/modules/drills/db/challenges.js');
engine.setSqlFactory(() => initSqlJs({ locateFile: (f) => resolve(vendor, f) }));

async function result(sql) {
  const db = await engine.openDataset('capecodd');
  try { return engine.run(db, sql); } finally { db.close(); }
}
async function grade(ch, sql) {
  return compare(await result(ch.solution), await result(sql), ch);
}
const byId = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));

console.log('\nthe dataset');
{
  const r = await result('SELECT COUNT(*) FROM SKU_DATA');
  t('loads, with 9 SKUs', r.rows[0][0] === 9, r);
  const bad = await result('SELECT COUNT(*) FROM ORDER_ITEM WHERE Quantity * Price <> ExtendedPrice');
  t('has exactly one mispriced line (for sql16)', bad.rows[0][0] === 1);
  const never = await result('SELECT COUNT(*) FROM SKU_DATA WHERE SKU NOT IN (SELECT SKU FROM ORDER_ITEM)');
  t('has an unordered SKU (for sql27)', never.rows[0][0] === 1);
}

console.log('\nevery challenge passes its own answer');
t('at least 15 challenges', CHALLENGES.length >= 15, CHALLENGES.length);
t('ids are unique', new Set(CHALLENGES.map((c) => c.id)).size === CHALLENGES.length);
for (const ch of CHALLENGES) {
  let r;
  try { r = await grade(ch, ch.solution); } catch (e) { r = { ok: false, reason: 'threw: ' + e.message }; }
  const exp = await result(ch.solution).catch(() => ({ rows: [] }));
  t(`${ch.id} (${ch.topic}) self-passes and is non-empty`, r.ok && exp.rows.length > 0, [r, exp.rows.length]);
  t(`${ch.id} has three hints`, Array.isArray(ch.hints) && ch.hints.length === 3);
}

console.log('\nforgiving where it should be');
{
  t('columns in a different order pass',
    (await grade(byId.sql01, 'SELECT Department, SKU, SKU_Description FROM SKU_DATA')).ok);
  t('a JOIN answer to a subquery challenge passes',
    (await grade(byId.sql21, "SELECT SUM(OI.ExtendedPrice) FROM ORDER_ITEM OI JOIN SKU_DATA S ON OI.SKU = S.SKU WHERE S.Department = 'Water Sports'")).ok);
  t('a LEFT JOIN … IS NULL anti-join passes the NOT IN challenge',
    (await grade(byId.sql27, 'SELECT S.SKU, S.SKU_Description FROM SKU_DATA S LEFT JOIN ORDER_ITEM OI ON S.SKU = OI.SKU WHERE OI.SKU IS NULL')).ok);
  t('SQL Server TOP 3 passes (translated to LIMIT)',
    (await grade(byId.sql03, 'SELECT TOP 3 * FROM ORDER_ITEM ORDER BY ExtendedPrice DESC;')).ok);
  t('trailing semicolons and comments are fine',
    (await grade(byId.sql04, "/* water */ SELECT * FROM SKU_DATA -- the table\n WHERE Department = 'Water Sports';")).ok);
  t('OR instead of IN passes',
    (await grade(byId.sql07, "SELECT SKU, SKU_Description, Department FROM SKU_DATA WHERE Department='Camping' OR Department='Climbing'")).ok);
  t('ties may come back in any order',
    (await grade(byId.sql09, 'SELECT * FROM ORDER_ITEM WHERE ExtendedPrice BETWEEN 100 AND 200 ORDER BY ExtendedPrice, OrderNumber DESC')).ok);
  t('lowercase keywords pass', (await grade(byId.sql05, 'select sku, sku_description from sku_data where sku > 200000')).ok);
}

console.log('\nstrict where it should be');
{
  const dup = await grade(byId.sql02, 'SELECT Buyer, Department FROM SKU_DATA');
  t('forgetting DISTINCT fails', !dup.ok);
  t('...and suggests DISTINCT', /DISTINCT/.test(dup.reason), dup.reason);
  const cols = await grade(byId.sql01, 'SELECT * FROM SKU_DATA');
  t('extra columns fail with a count', !cols.ok && /Expected 3 columns, got 4/.test(cols.reason), cols.reason);
  const order = await grade(byId.sql24, 'SELECT S.Buyer, SUM(OI.ExtendedPrice) AS Revenue FROM ORDER_ITEM OI JOIN SKU_DATA S ON OI.SKU=S.SKU GROUP BY S.Buyer ORDER BY Revenue ASC');
  t('the wrong sort direction fails', !order.ok && /wrong order/.test(order.reason), order.reason);
  const miss = await grade(byId.sql04, "SELECT * FROM SKU_DATA WHERE Department = 'Camping'");
  t('the wrong filter fails', !miss.ok, miss.reason);
  const alias = await grade(byId.sql13, 'SELECT SUM(OrderTotal) FROM RETAIL_ORDER');
  t('a required alias is enforced', !alias.ok && /OrderSum/.test(alias.reason), alias.reason);
  const inner = await grade(byId.sql26, 'SELECT B.BuyerName, COUNT(S.SKU) FROM BUYER B JOIN SKU_DATA S ON B.BuyerName = S.Buyer GROUP BY B.BuyerName');
  t('an INNER join fails the outer-join challenge', !inner.ok, inner.reason);
  const wrongRow = await grade(byId.sql05, 'SELECT SKU, SKU_Description FROM SKU_DATA WHERE SKU >= 100200');
  t('a row-count mismatch is named', /Expected \d+ rows?, got \d+/.test(wrongRow.reason), wrongRow.reason);
  const sameCountWrong = await grade(byId.sql10, "SELECT * FROM SKU_DATA WHERE SKU_Description LIKE '%Dive%' OR SKU_Description LIKE '%Harness%' ");
  t('same row count, wrong rows -> names a missing row', /Missing a row like/.test(sameCountWrong.reason), sameCountWrong.reason);
}

console.log('\nthe dialect');
{
  t('TOP n becomes LIMIT n', /LIMIT 5$/.test(engine.translate('SELECT TOP 5 Buyer FROM SKU_DATA').sql));
  t('DISTINCT TOP keeps DISTINCT', /^SELECT DISTINCT Buyer.*LIMIT 2$/.test(engine.translate('SELECT DISTINCT TOP 2 Buyer FROM SKU_DATA').sql));
  t('TOP … PERCENT is refused with an explanation', /PERCENT/.test(engine.translate('SELECT TOP 75 PERCENT * FROM SKU_DATA').error || ''));
  t("'+' concatenation gets a note", engine.translate("SELECT Buyer + ' in ' + Department FROM SKU_DATA").notes.some((n) => /\|\|/.test(n)));
  let err = '';
  try { await result('SELECT nope FROM SKU_DATA'); } catch (e) { err = e.message; }
  t('a bad column is a readable error', /no such column: nope/.test(err), err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
