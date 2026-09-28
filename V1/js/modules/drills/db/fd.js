/* ============================================================================
 * StudyOS drills — functional dependencies & normalization  (Kroenke ch. 3)
 * ============================================================================
 * Pure functions, so every drill question can be GENERATED and GRADED by the
 * same code — no answer key to get wrong.
 *
 * Attributes are strings ('A', 'SKU', 'Buyer'); a set of attributes is a
 * sorted, de-duplicated array. An FD is { lhs: [...], rhs: [...] }.
 *
 * Normal forms follow the course's definitions:
 *   2NF  no non-key (non-prime) attribute depends on PART of a candidate key
 *   3NF  …and no transitive dependency: for every nontrivial X→A, X is a
 *        superkey or A is prime (part of some candidate key)
 *   BCNF every determinant is a candidate key (X→A nontrivial ⇒ X superkey)
 * ------------------------------------------------------------------------- */

export const set = (xs) => [...new Set((xs || []).map(String))].sort();
const has = (s, x) => s.includes(x);
export const subset = (a, b) => a.every((x) => b.includes(x));
export const eq = (a, b) => a.length === b.length && subset(a, b);
const minus = (a, b) => a.filter((x) => !b.includes(x));
const union = (a, b) => set([...a, ...b]);
export const fmt = (s) => (s.every((x) => x.length === 1) ? s.join('') : s.join(', '));
export const fmtFD = (f) => `${fmt(f.lhs)} → ${fmt(f.rhs)}`;

/**
 * "AB" -> [A, B] in LETTER mode; "SKU, Buyer" -> [Buyer, SKU] in NAME mode.
 * The mode cannot be read off one token ("SKU" vs "AB"), so it is decided
 * once per input: any lowercase letter or underscore means names.
 */
const letterMode = (text) => !/[a-z_]/.test(String(text || ''));

export function parseAttrs(text, letters = letterMode(text)) {
  const s = String(text || '').trim();
  if (!s) return [];
  const tokens = s.split(/[\s,]+/).filter(Boolean);
  return set(letters ? tokens.flatMap((t) => t.split('')) : tokens);
}

export function parseFDs(text, { letters = letterMode(text) } = {}) {
  return String(text || '').split(/[;\n]+/).map((line) => {
    const m = /(.+?)(?:->|→)(.+)/.exec(line);
    if (!m) return null;
    const lhs = parseAttrs(m[1], letters), rhs = parseAttrs(m[2], letters);
    return lhs.length && rhs.length ? { lhs, rhs } : null;
  }).filter(Boolean);
}

/** X+ under fds. */
export function closure(attrs, fds) {
  let c = set(attrs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of fds) {
      if (subset(f.lhs, c) && !subset(f.rhs, c)) { c = union(c, f.rhs); grew = true; }
    }
  }
  return c;
}

export const isSuperkey = (x, R, fds) => subset(R, closure(x, fds));

/**
 * All candidate keys of R. Attributes on no right-hand side must be in EVERY
 * key; attributes only ever on the right are in NO key; only the rest are
 * searched, smallest combinations first, keeping the minimal ones.
 */
export function candidateKeys(R, fds) {
  R = set(R);
  const onRight = set(fds.flatMap((f) => minus(f.rhs, f.lhs)));
  const onLeft = set(fds.flatMap((f) => f.lhs));
  const core = R.filter((a) => !has(onRight, a));
  if (isSuperkey(core, R, fds)) return [core];
  const middle = R.filter((a) => has(onRight, a) && has(onLeft, a));
  const keys = [];
  const n = middle.length;
  for (let size = 1; size <= n; size++) {
    const combo = (start, pick) => {
      if (pick.length === size) {
        const k = union(core, pick);
        if (!keys.some((key) => subset(key, k)) && isSuperkey(k, R, fds)) keys.push(k);
        return;
      }
      for (let i = start; i < n; i++) combo(i + 1, [...pick, middle[i]]);
    };
    combo(0, []);
  }
  return keys.sort((a, b) => a.length - b.length || fmt(a).localeCompare(fmt(b)));
}

export const primeAttrs = (R, fds) => set(candidateKeys(R, fds).flat());

/** Split right-hand sides, drop extraneous LHS attributes, drop redundant FDs. */
export function minimalCover(fds) {
  let g = fds.flatMap((f) => f.rhs.filter((a) => !has(f.lhs, a)).map((a) => ({ lhs: set(f.lhs), rhs: [a] })));
  g = g.map((f) => {
    let lhs = f.lhs;
    for (const a of f.lhs) {
      const smaller = minus(lhs, [a]);
      if (smaller.length && subset(f.rhs, closure(smaller, g))) lhs = smaller;
    }
    return { lhs, rhs: f.rhs };
  });
  const out = [];
  const seen = new Set();
  for (const f of g) { const k = fmtFD(f); if (!seen.has(k)) { seen.add(k); out.push(f); } }
  for (let i = out.length - 1; i >= 0; i--) {
    const rest = out.filter((_, j) => j !== i);
    if (subset(out[i].rhs, closure(out[i].lhs, rest))) out.splice(i, 1);
  }
  return out;
}

/** FDs that hold on a projection S of R: X → (X+ ∩ S) for X ⊆ S. */
export function project(S, fds) {
  S = set(S);
  const out = [];
  const n = S.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const X = S.filter((_, i) => mask & (1 << i));
    const rhs = minus(closure(X, fds).filter((a) => has(S, a)), X);
    if (rhs.length) out.push({ lhs: X, rhs });
  }
  return minimalCover(out);
}

/**
 * The highest normal form R is in, and why not the next one.
 * @returns {{ nf: '1NF'|'2NF'|'3NF'|'BCNF', keys, violations: [{fd, rule, why}] }}
 */
export function normalForm(R, fds) {
  R = set(R);
  const keys = candidateKeys(R, fds);
  const prime = set(keys.flat());
  const cover = minimalCover(fds).filter((f) => subset(f.lhs, R) && subset(f.rhs, R));
  const partial = [], transitive = [], bcnf = [];
  for (const f of cover) {
    const a = f.rhs[0];
    const superkey = isSuperkey(f.lhs, R, fds);
    if (superkey) continue;
    bcnf.push({ fd: f, rule: 'BCNF', why: `${fmt(f.lhs)} is a determinant but not a candidate key` });
    if (has(prime, a)) continue;
    const partOfKey = keys.some((k) => subset(f.lhs, k) && f.lhs.length < k.length);
    if (partOfKey) partial.push({ fd: f, rule: '2NF', why: `${a} depends on part of the key ${fmt(keys.find((k) => subset(f.lhs, k)))}` });
    else transitive.push({ fd: f, rule: '3NF', why: `${a} depends on the non-key ${fmt(f.lhs)} (a transitive dependency)` });
  }
  const nf = partial.length ? '1NF' : transitive.length ? '2NF' : bcnf.length ? '3NF' : 'BCNF';
  const violations = nf === '1NF' ? partial : nf === '2NF' ? transitive : nf === '3NF' ? bcnf : [];
  return { nf, keys, violations };
}

/** BCNF decomposition by repeated splitting on a violating FD. */
export function bcnfDecompose(R, fds) {
  const out = [];
  const todo = [set(R)];
  while (todo.length) {
    const S = todo.pop();
    const local = project(S, fds);
    const bad = local.find((f) => !isSuperkey(f.lhs, S, local));
    if (!bad) { out.push(S); continue; }
    const X = bad.lhs;
    const Xplus = closure(X, local).filter((a) => has(S, a));
    todo.push(Xplus, union(X, minus(S, Xplus)));
  }
  // Drop any relation contained in another.
  return out.filter((s, i) => !out.some((t, j) => j !== i && subset(s, t) && (s.length < t.length || j < i)));
}

/** Lossless-join test (the chase) for a decomposition of R. */
export function isLossless(R, parts, fds) {
  R = set(R);
  const rows = parts.map((p, i) => Object.fromEntries(R.map((a) => [a, has(p, a) ? 'a' : 'b' + i])));
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fds) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (!f.lhs.every((x) => rows[i][x] === rows[j][x])) continue;
          for (const a of f.rhs) {
            if (rows[i][a] === rows[j][a]) continue;
            const keep = rows[i][a] === 'a' || rows[j][a] === 'a' ? 'a' : rows[i][a];
            const drop = keep === rows[i][a] ? rows[j][a] : rows[i][a];
            for (const r of rows) if (r[a] === drop) r[a] = keep;
            changed = true;
          }
        }
      }
    }
    if (rows.some((r) => R.every((a) => r[a] === 'a'))) return true;
  }
  return rows.some((r) => R.every((a) => r[a] === 'a'));
}

/** Is every FD still enforceable inside a single part? (Checked via closures.) */
export function preservesDependencies(parts, fds) {
  const lost = [];
  for (const f of minimalCover(fds)) {
    let z = set(f.lhs);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of parts) {
        const add = closure(z.filter((a) => has(p, a)), fds).filter((a) => has(p, a));
        if (!subset(add, z)) { z = union(z, add); grew = true; }
      }
    }
    if (!subset(f.rhs, z)) lost.push(f);
  }
  return { ok: lost.length === 0, lost };
}

/**
 * Grade a proposed decomposition: covers R, lossless, every part in `target`
 * form, and (reported, not required for BCNF) dependency preservation.
 */
export function checkDecomposition(R, fds, parts, target = 'BCNF') {
  R = set(R);
  parts = parts.map(set).filter((p) => p.length);
  const problems = [];
  const covered = set(parts.flat());
  const missing = minus(R, covered);
  const extra = minus(covered, R);
  if (missing.length) problems.push(`Attribute${missing.length > 1 ? 's' : ''} ${fmt(missing)} ${missing.length > 1 ? 'are' : 'is'} in no relation.`);
  if (extra.length) problems.push(`${fmt(extra)} ${extra.length > 1 ? 'are' : 'is'} not in the original relation.`);
  if (!missing.length && !isLossless(R, parts, fds)) problems.push('The join is lossy: joining these back together would invent rows. Split on a determinant so its relation keeps the determinant as a key.');
  const rank = { '1NF': 1, '2NF': 2, '3NF': 3, BCNF: 4 };
  for (const p of parts) {
    const local = project(p, fds);
    const nf = normalForm(p, local);
    if (rank[nf.nf] < rank[target]) {
      problems.push(`${fmt(p)} is only in ${nf.nf}: ${nf.violations[0] ? nf.violations[0].why : ''}.`);
    }
  }
  const dep = preservesDependencies(parts, fds);
  return { ok: problems.length === 0, problems, preserves: dep.ok, lost: dep.lost };
}

// ── Question generation ─────────────────────────────────────────────────────
/** Deterministic PRNG so a question can be re-created from its seed. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * A random relation with 4–6 attributes and 3–5 FDs that is interesting:
 * not trivially BCNF unless `wantNF` asks for it, and not keyed by everything.
 */
export function randomRelation(seed, { wantNF } = {}) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const r = rng(seed * 7919 + attempt);
    const n = 4 + Math.floor(r() * 3);
    const R = 'ABCDEF'.slice(0, n).split('');
    const k = 3 + Math.floor(r() * 3);
    const fds = [];
    for (let i = 0; i < k; i++) {
      const lhsSize = 1 + (r() < 0.35 ? 1 : 0);
      const lhs = set([...Array(lhsSize)].map(() => R[Math.floor(r() * n)]));
      const rhsPool = R.filter((a) => !lhs.includes(a));
      const rhs = [rhsPool[Math.floor(r() * rhsPool.length)]];
      fds.push({ lhs, rhs });
    }
    const cover = minimalCover(fds);
    if (cover.length < 2) continue;
    const keys = candidateKeys(R, cover);
    if (keys.length === 1 && keys[0].length === n) continue;
    const { nf } = normalForm(R, cover);
    if (wantNF ? nf !== wantNF : nf === 'BCNF') continue;
    return { R, fds: cover, seed };
  }
  return { R: ['A', 'B', 'C', 'D'], fds: parseFDs('A->B; B->C; C->D'), seed };
}

export default {
  set, subset, eq, fmt, fmtFD, parseAttrs, parseFDs, closure, isSuperkey, candidateKeys, primeAttrs,
  minimalCover, project, normalForm, bcnfDecompose, isLossless, preservesDependencies,
  checkDecomposition, rng, randomRelation,
};
