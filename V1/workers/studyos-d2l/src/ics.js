/* ═══════════════════════════════════════════════════════════════════════════
 * ics.js — the RFC 5545 subset a Brightspace calendar feed actually uses.
 * ---------------------------------------------------------------------------
 * PURE. No Workers APIs, no fetch, no crypto, no globals. That is deliberate:
 * scripts/test-d2l-ics.mjs imports this file directly under node, so the
 * trickiest part of the integration is testable without deploying anything.
 *
 * Why hand-rolled instead of an npm parser: ical.js ships a timezone database
 * (~200 KB) and node-ical needs rrule + moment-timezone and is not
 * Workers-compatible unbundled. V1 has no bundler — scripts/build.mjs is a
 * file copy — so adding one would mean wrangler bundling a dependency tree,
 * which is the same class of change that already broke CI once (see the
 * wrangler v3/v4 note in .github/workflows/deploy-v1-workers.yml). The subset
 * below is ~150 lines and every branch in it is covered by a test.
 *
 * What this deliberately does NOT do: expand RRULE. See parseICS below.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* RFC 5545 §3.1: lines longer than 75 octets are folded — split with CRLF plus
 * one leading space or tab, which the parser must remove before anything else.
 *
 * The bare-\n case is not paranoia: proxies, and some tenants' own gateways,
 * normalize CRLF to LF in transit. A feed that unfolds under one rule and not
 * the other produces course names chopped mid-word, which is the single most
 * likely cause of a garbled import. */
export function unfold(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .replace(/\r[ \t]/g, '');
}

/* Split one content line into { name, params, value }.
 *
 * The delimiter is the FIRST colon that is not inside a quoted param value.
 * A naive split(':') breaks on URL:https://host/path — a real property in D2L
 * feeds — and on any TZID="X:Y". Params are ;-separated K=V, values optionally
 * double-quoted. */
export function parseLine(line) {
  const s = String(line == null ? '' : line);
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return { name: s.toUpperCase().trim(), params: {}, value: '' };

  const head = s.slice(0, colon);
  const value = s.slice(colon + 1);

  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (ch === ';' && !q) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  const name = (parts.shift() || '').toUpperCase().trim();
  const params = {};
  parts.forEach((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) { params[p.toUpperCase().trim()] = ''; return; }
    const k = p.slice(0, eq).toUpperCase().trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    params[k] = v;
  });

  return { name, params, value };
}

/* RFC 5545 §3.3.11 TEXT unescaping.
 *
 * Order matters, and the obvious order is wrong: unescaping \\ first turns a
 * literal backslash-then-n into a newline, mangling any Windows path in a
 * DESCRIPTION. Walking the string once, consuming the escape and its target
 * together, sidesteps the ordering problem entirely. */
export function unescapeText(v) {
  const s = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[i + 1];
    if (n === undefined) { out += '\\'; break; }
    i++;
    if (n === 'n' || n === 'N') out += '\n';
    else if (n === ',') out += ',';
    else if (n === ';') out += ';';
    else if (n === '\\') out += '\\';
    else out += n;
  }
  return out;
}

/* DTSTART / DTEND come in three shapes and they must be distinguished, never
 * coerced into one:
 *
 *   VALUE=DATE:20260114              all-day. Brightspace uses this for most
 *                                    assignment due dates.
 *   20260114T143000Z                 UTC.
 *   TZID=America/New_York:2026...    floating local time.
 *
 * Note what is NOT here: any conversion. A Worker runs in UTC and has no idea
 * where the student is, so this returns the raw parts and lets the browser
 * finish the job with Intl. Converting here would silently shift every due
 * date for anyone outside the Worker's timezone. */
export function parseDateValue(value, params) {
  const raw = String(value == null ? '' : value).trim();
  const p = params || {};
  const isDateOnly = String(p.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(raw);

  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;

  const y = m[1], mo = m[2], d = m[3], hh = m[4], mm = m[5], ss = m[6], z = m[7];
  return {
    date: y + '-' + mo + '-' + d,
    time: (isDateOnly || !hh) ? '' : hh + ':' + mm,
    allDay: !!isDateOnly || !hh,
    isUtc: z === 'Z',
    tzid: p.TZID || '',
    dtRaw: raw,
    seconds: ss || '00',
  };
}

/* Parse a whole feed into { calName, events }.
 *
 * Component nesting is tracked with a stack rather than by scanning for
 * BEGIN:VEVENT. Brightspace feeds carry VTIMEZONE blocks whose STANDARD and
 * DAYLIGHT sub-components each have their OWN DTSTART (dated 1970, no less),
 * so a flat scan invents phantom events at the Unix epoch.
 *
 * RRULE is captured verbatim but NOT expanded. Correct expansion means
 * COUNT + UNTIL + BYDAY + BYMONTHDAY + EXDATE + RDATE interacting, which is a
 * project in itself and a rich source of off-by-one-week bugs. A weekly
 * lecture therefore imports as one item, and the UI says so plainly. StudyOS
 * has its own repeat model (repeat / repeatDays / repeatEndDate) that a later
 * version could map simple FREQ=WEEKLY rules onto directly. */
export function parseICS(text) {
  const lines = unfold(text).split(/\r\n|\n|\r/);
  const events = [];
  const stack = [];
  let calName = '';
  let cur = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    const name = parsed.name, params = parsed.params, value = parsed.value;

    if (name === 'BEGIN') {
      const comp = value.toUpperCase().trim();
      stack.push(comp);
      // Only a VEVENT directly inside the VCALENDAR is a real event.
      if (comp === 'VEVENT' && stack.length === 2) {
        cur = {
          uid: '', summary: '', description: '', location: '',
          start: null, end: null, rrule: '', sequence: 0,
          lastModified: '', categories: [], url: '', xprops: {},
        };
      }
      continue;
    }

    if (name === 'END') {
      const comp = value.toUpperCase().trim();
      if (comp === 'VEVENT' && stack.length === 2 && cur) {
        // A VEVENT without a UID has no stable identity, so it cannot be
        // reconciled across syncs — it would duplicate on every import.
        // Dropping it is the only safe option.
        if (cur.uid && cur.start) events.push(cur);
        cur = null;
      }
      stack.pop();
      continue;
    }

    if (!cur) {
      if (name === 'X-WR-CALNAME' && stack.length === 1) calName = unescapeText(value);
      continue;
    }
    // Inside a VTIMEZONE or any other nested component: ignore entirely.
    if (stack.length !== 2 || stack[1] !== 'VEVENT') continue;

    switch (name) {
      case 'UID':           cur.uid = value.trim(); break;
      case 'SUMMARY':       cur.summary = unescapeText(value); break;
      case 'DESCRIPTION':   cur.description = unescapeText(value); break;
      case 'LOCATION':      cur.location = unescapeText(value); break;
      case 'URL':           cur.url = value.trim(); break;
      case 'DTSTART':       cur.start = parseDateValue(value, params); break;
      case 'DTEND':         cur.end = parseDateValue(value, params); break;
      case 'RRULE':         cur.rrule = value.trim(); break;
      case 'SEQUENCE':      cur.sequence = parseInt(value, 10) || 0; break;
      case 'LAST-MODIFIED': cur.lastModified = value.trim(); break;
      case 'CATEGORIES':
        cur.categories = unescapeText(value).split(',').map(s => s.trim()).filter(Boolean);
        break;
      default:
        if (name.indexOf('X-') === 0) cur.xprops[name] = unescapeText(value);
        break;
    }
  }

  return { calName: calName, events: events };
}
