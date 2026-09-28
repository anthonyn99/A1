/* ============================================================================
 * StudyOS — progress: weak spots, streak freezes, bosses  (engagement 2.3/5.x)
 * ============================================================================
 * One synced document, dashboards/studyos_progress, through synced.js.
 *
 * ── WEAK SPOTS ────────────────────────────────────────────────────────────
 * Every miss — a card graded Again, a wrong quiz answer, a failed drill —
 * counts against its TOPIC. "Practice weak spots" then builds a session from
 * the topics with the worst recent record.
 *
 * Counters are per-DEVICE (a grow-only counter): record = { dev: { <id>:
 * {a, m, t} } }, merged by keeping each device's larger count. Two devices
 * missing the same topic on the same afternoon both count; a plain
 * newest-wins merge would silently drop one of them.
 *
 * Record shapes (all carry `type`):
 *   topic:  { id:'tp|<classId>|<topic>', type:'topic', classId, topic, dev }
 *   freeze: { id:'fz|<day>', type:'freeze', day }            (5.1)
 *   boss:   { id:'bs|<classId>|<moduleId>', type:'boss', ... }  (5.2)
 * ------------------------------------------------------------------------- */

import { syncedList } from './synced.js';

const DEV_KEY = 'studyos_device_id';

export function deviceId() {
  try {
    let id = localStorage.getItem(DEV_KEY);
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem(DEV_KEY, id);
    }
    return id;
  } catch (e) { return 'dx'; }
}

/** Merge two copies of one record. Returns `a` itself when b adds nothing,
 *  which is what lets synced.js skip a pointless write-back. */
function merge(a, b) {
  if (a.type !== 'topic' || b.type !== 'topic' || a.deleted || b.deleted) {
    return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
  }
  let changed = false;
  const dev = { ...(a.dev || {}) };
  for (const [id, c] of Object.entries(b.dev || {})) {
    const mine = dev[id];
    if (!mine || (c.a || 0) > (mine.a || 0)) { dev[id] = c; changed = true; }
  }
  return changed ? { ...a, dev, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0) } : a;
}

const store = syncedList({
  kind: 'progress', lsKey: 'studyos_progress', docPath: 'dashboards/studyos_progress', merge,
});

export function connect() { store.connect(); }
export function _store() { return store; }

export const normTopic = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();
const topicId = (classId, topic) => `tp|${classId || ''}|${normTopic(topic)}`;

/**
 * Record one attempt at a topic. `miss` is 0..1 (a Hard card counts half).
 */
export function recordAttempt(classId, topic, miss, now = Date.now()) {
  const t = normTopic(topic);
  if (!t) return null;
  const id = topicId(classId, t);
  const cur = store.get(id) || { id, type: 'topic', classId: classId || '', topic: String(topic).trim(), dev: {} };
  const me = deviceId();
  const c = cur.dev[me] || { a: 0, m: 0, t: 0 };
  const next = {
    ...cur,
    dev: { ...cur.dev, [me]: { a: c.a + 1, m: Math.round((c.m + Math.max(0, Math.min(1, miss))) * 100) / 100, t: miss > 0 ? now : c.t } },
  };
  store.upsert(next);
  return next;
}

/** Summed across devices. */
export function topicStats(classId) {
  return store.all()
    .filter((r) => r.type === 'topic' && (!classId || r.classId === classId))
    .map((r) => {
      let a = 0, m = 0, last = 0;
      for (const c of Object.values(r.dev || {})) { a += c.a || 0; m += c.m || 0; last = Math.max(last, c.t || 0); }
      return { classId: r.classId, topic: r.topic, attempts: a, misses: m, lastMiss: last, rate: a ? m / a : 0 };
    });
}

/**
 * Weakest topics first. Score = smoothed miss rate × recency: a topic missed
 * 3/4 times this week outranks one missed 5/40 times a month ago. Smoothing
 * (+1 attempt) keeps one unlucky miss from topping the list forever.
 */
export function weakTopics(classId, n = 3, now = Date.now()) {
  return topicStats(classId)
    .filter((s) => s.misses >= 1)
    .map((s) => {
      const days = s.lastMiss ? (now - s.lastMiss) / 86400000 : 60;
      const recency = Math.pow(0.5, days / 14);
      return { ...s, score: (s.misses / (s.attempts + 1)) * (0.4 + 0.6 * recency) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// ── Streak freezes (5.1) ────────────────────────────────────────────────────
export function freezes() {
  return store.all().filter((r) => r.type === 'freeze').map((r) => r.day).sort();
}
export function addFreeze(day) {
  store.upsert({ id: 'fz|' + day, type: 'freeze', day });
}

// ── Bosses (5.2) ────────────────────────────────────────────────────────────
export function bosses(classId) {
  return store.all().filter((r) => r.type === 'boss' && (!classId || r.classId === classId));
}
export function recordBoss(classId, moduleId, fields) {
  const id = `bs|${classId}|${moduleId}`;
  const prev = store.get(id) || {};
  store.upsert({ ...prev, ...fields, id, type: 'boss', classId, moduleId });
}

export default {
  deviceId, connect, normTopic, recordAttempt, topicStats, weakTopics,
  freezes, addFreeze, bosses, recordBoss,
};
