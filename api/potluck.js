// Holiday Potluck API — one Vercel serverless function.
// Storage: Upstash Redis REST (shares an existing Vercel → Storage → Upstash database).
//
// Anyone can start their own potluck group from the front page. Each group has its own
// code, organizer PIN, holiday, menu, people and RSVPs, stored under pl:g:<groupId>:...
// The group set up with the GROUP_CODE env var keeps its data under the original pl: keys.
//
// Env vars:
//   KV_REST_API_URL / KV_REST_API_TOKEN  added by Vercel when you connect the database
//   GROUP_CODE (or FAMILY_CODE)          optional: code for the original group
//   ADMIN_PIN                            organizer PIN for the original group, and the site
//                                        owner's master PIN that opens any group's settings
//   SITE_NAME     optional, front-page name (default "Holiday Potluck")
//   MAX_GROUPS    optional, cap on groups that can be created (default 1000)
//   KEY_PREFIX    optional (default "pl:"), TIMEZONE optional (default America/Chicago)
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const LEGACY_CODE = (process.env.GROUP_CODE || process.env.FAMILY_CODE || '').trim().toLowerCase();
const OWNER = (process.env.ADMIN_PIN || '').trim();
const P = process.env.KEY_PREFIX || 'pl:';
const TZ = process.env.TIMEZONE || 'America/Chicago';
const SITE_NAME = process.env.SITE_NAME || 'Holiday Potluck';
const MAX_GROUPS = Number(process.env.MAX_GROUPS) || 1000;

// Site-wide keys
const G = {
  codes: P + 'codes',              // hash: code -> groupId
  groups: P + 'groups',            // hash: groupId -> {id, name, created}
  rate: (kind, ip) => P + 'rl:' + kind + ':' + ip,
};
// Per-group keys. g.prefix is "pl:" for the original group, "pl:g:<id>:" for the rest.
const K = g => ({
  settings: g.prefix + 'settings',
  people: g.prefix + 'people',
  pins: g.prefix + 'pins',
  tokens: g.prefix + 'tokens',     // hash: personId -> [hashes of device sign-in tokens]
  fails: id => g.prefix + 'fail:' + id,
  event: ev => g.prefix + 'ev:' + ev,
  dishes: ev => g.prefix + 'dish:' + ev,
  rsvp: ev => g.prefix + 'rsvp:' + ev,
});
const CATEGORIES = [
  { id: 'main', name: 'Main dishes' },
  { id: 'side', name: 'Sides' },
  { id: 'app', name: 'Appetizers' },
  { id: 'salad', name: 'Salads' },
  { id: 'bread', name: 'Bread & rolls' },
  { id: 'dessert', name: 'Desserts' },
  { id: 'drink', name: 'Drinks' },
  { id: 'supply', name: 'Plates, ice & supplies' },
];
const TAGS = ['Vegetarian', 'Vegan', 'Gluten-free', 'Dairy-free', 'Contains nuts', 'Spicy'];

/* ---------- Holiday dates ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based
function nthWeekday(y, m, wd, n) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return ymd(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y, m, wd) {
  const lastDay = new Date(Date.UTC(y, m + 1, 0));
  const back = (lastDay.getUTCDay() - wd + 7) % 7;
  return ymd(y, m, lastDay.getUTCDate() - back);
}
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month - 1, day);
}
const HOLIDAYS = [
  { id: 'newyear', name: "New Year's Day", date: y => ymd(y, 0, 1) },
  { id: 'valentines', name: "Valentine's Day", date: y => ymd(y, 1, 14) },
  { id: 'easter', name: 'Easter', date: easter },
  { id: 'memorial', name: 'Memorial Day', date: y => lastWeekday(y, 4, 1) },
  { id: 'july4', name: 'Fourth of July', date: y => ymd(y, 6, 4) },
  { id: 'labor', name: 'Labor Day', date: y => nthWeekday(y, 8, 1, 1) },
  { id: 'halloween', name: 'Halloween', date: y => ymd(y, 9, 31) },
  { id: 'thanksgiving', name: 'Thanksgiving', date: y => nthWeekday(y, 10, 4, 4) },
  { id: 'christmas', name: 'Christmas', date: y => ymd(y, 11, 25) },
  { id: 'custom', name: 'Special gathering', date: null },
];
const HOLIDAY_IDS = new Set(HOLIDAYS.map(h => h.id));

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
// The next occurrence of a holiday. It stays "current" through the day after, so
// people can still see the list while cleaning up leftovers.
function occurrence(h, now = today()) {
  const year = Number(now.slice(0, 4));
  if (!h.date) return { date: '', year, key: `custom-${year}` };
  for (let y = year - 1; y <= year + 1; y++) {
    const d = h.date(y);
    if (addDays(d, 1) >= now) return { date: d, year: y, key: `${h.id}-${y}` };
  }
}
function activeHoliday(settings, now = today()) {
  if (settings.mode === 'fixed' && HOLIDAY_IDS.has(settings.holiday)) {
    const h = HOLIDAYS.find(x => x.id === settings.holiday);
    const o = occurrence(h, now);
    // A custom gathering keeps one list until the organizer starts a new one.
    if (h.id === 'custom') o.key = settings.customKey || o.key;
    return { id: h.id, name: h.name, ...o };
  }
  let best = null;
  for (const h of HOLIDAYS) {
    if (!h.date) continue;
    const o = occurrence(h, now);
    if (!best || o.date < best.date) best = { id: h.id, name: h.name, ...o };
  }
  return best;
}


/* ---------- Helpers ---------- */
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const fail = (status, msg, code) => { throw new HttpError(status, msg, code); };

async function redis(cmds) {
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) fail(502, 'Database error (' + r.status + ')');
  const out = await r.json();
  return out.map(x => { if (x.error) fail(502, 'Database error: ' + x.error); return x.result; });
}
const pairs = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a))), Buffer.from(sha(String(b))));
const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNote = (s, max) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, max);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const normCode = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '-');
const pinHash = (g, id, pin) => sha(g.salt + ':' + id + ':' + pin);
const adminHash = (gid, pin) => sha('admin:' + gid + ':' + String(pin).trim());

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
// Counts an attempt; fails once the limit is reached within the window.
async function limit(kind, ip, max, seconds, msg) {
  const [n] = await redis([['INCR', G.rate(kind, ip)], ['EXPIRE', G.rate(kind, ip), seconds]]);
  if (n > max) fail(429, msg);
}
async function peekLimit(kind, ip, max, msg) {
  const [n] = await redis([['GET', G.rate(kind, ip)]]);
  if (Number(n) >= max) fail(429, msg);
}

function validCode(raw) {
  const code = normCode(raw);
  if (code.length < 5) fail(400, 'Make your group code at least 5 characters, so it\'s hard to guess.');
  if (code.length > 30) fail(400, 'Keep your group code to 30 characters or fewer.');
  if (!/^[a-z0-9-]+$/.test(code)) fail(400, 'Use only letters, numbers and dashes in the group code.');
  if (LEGACY_CODE && code === normCode(LEGACY_CODE)) fail(409, 'That group code is taken. Try another.');
  return code;
}

async function resolveGroup(rawCode, ip) {
  const code = normCode(rawCode);
  if (!code) fail(401, 'Enter your group code.');
  if (LEGACY_CODE && safeEq(code, normCode(LEGACY_CODE))) {
    return { id: 'main', prefix: P, salt: LEGACY_CODE, legacy: true, code, name: '' };
  }
  await peekLimit('code', ip, 15, 'Too many tries. Wait 10 minutes and try your group code again.');
  const [gid] = await redis([['HGET', G.codes, code]]);
  const [metaRaw] = gid ? await redis([['HGET', G.groups, gid]]) : [null];
  const meta = parse(metaRaw, null);
  if (!meta) {
    await limit('code', ip, 1e9, 600, '');
    fail(401, 'We couldn\'t find a group with that code. Check the spelling, or start a new potluck.');
  }
  return { id: meta.id, prefix: P + 'g:' + meta.id + ':', salt: meta.id, legacy: false, code: meta.code, name: meta.name, meta };
}

const DEFAULT_SETTINGS = { mode: 'auto', holiday: 'thanksgiving', siteName: SITE_NAME };
const DEFAULT_EVENT = { title: '', dateOverride: '', time: '', location: '', host: '', notes: '', targets: {} };

async function loadSettings(g) {
  const [s] = await redis([['GET', K(g).settings]]);
  return { ...DEFAULT_SETTINGS, ...(g.name ? { siteName: g.name } : {}), ...parse(s, {}) };
}
function holidayList(now) {
  return HOLIDAYS.map(h => ({ id: h.id, name: h.name, date: occurrence(h, now).date }));
}

async function fullState(g, settings) {
  const now = today();
  const hol = activeHoliday(settings, now);
  const ev = hol.key, k = K(g);
  const prevKey = hol.id === 'custom' ? null : `${hol.id}-${hol.year - 1}`;
  const [people, pins, event, dishes, rsvp, prev] = await redis([
    ['HGETALL', k.people], ['HKEYS', k.pins], ['GET', k.event(ev)],
    ['HGETALL', k.dishes(ev)], ['HGETALL', k.rsvp(ev)], ['GET', prevKey ? k.event(prevKey) : k.event('none')],
  ]);
  const prevEvent = parse(prev, null);
  const pinSet = new Set(pins || []);
  const ppl = Object.values(pairs(people)).map(p => parse(p, null)).filter(Boolean)
    .map(p => ({ id: p.id, name: p.name, hasPin: pinSet.has(p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    today: now,
    group: { code: g.code, legacy: g.legacy },
    settings,
    holiday: hol,
    holidays: holidayList(now),
    categories: CATEGORIES,
    tags: TAGS,
    event: { ...DEFAULT_EVENT, ...parse(event, {}) },
    eventSaved: !!event,
    // Last year's setup for this holiday, offered to the organizer when this year's is blank.
    lastYear: !event && prevEvent ? { year: hol.year - 1, ...prevEvent } : null,
    people: ppl,
    dishes: Object.values(pairs(dishes)).map(d => parse(d, null)).filter(Boolean).sort((a, b) => a.ts - b.ts),
    rsvps: Object.fromEntries(Object.entries(pairs(rsvp)).map(([k, v]) => [k, parse(v, {})])),
  };
}

const tokenHash = (g, tok) => sha(g.salt + ':tok:' + tok);
async function issueToken(g, personId) {
  const k = K(g), tok = crypto.randomBytes(18).toString('base64url');
  const [raw] = await redis([['HGET', k.tokens, personId]]);
  const list = parse(raw, []).slice(-9);
  list.push(tokenHash(g, tok));
  await redis([['HSET', k.tokens, personId, JSON.stringify(list)]]);
  return tok;
}
// A person proves who they are with this device's sign-in token, or with their PIN.
async function checkPerson(g, personId, pin, token) {
  const k = K(g);
  if (!personId) fail(401, 'Please sign in again.', 'signin');
  if (token) {
    const [raw] = await redis([['HGET', k.tokens, personId]]);
    const h = tokenHash(g, String(token));
    if (parse(raw, []).some(x => safeEq(x, h))) return;
    if (!pin) fail(401, 'Please sign in again.', 'signin');
  }
  if (!/^\d{4}$/.test(String(pin || ''))) fail(401, 'Please sign in again.', 'signin');
  const [stored, fails] = await redis([['HGET', k.pins, personId], ['GET', k.fails(personId)]]);
  if (Number(fails) >= 5) fail(429, 'Too many wrong PINs. Try again in 10 minutes, or ask the organizer to reset your PIN.');
  if (!stored || !safeEq(stored, pinHash(g, personId, pin))) {
    await redis([['INCR', k.fails(personId)], ['EXPIRE', k.fails(personId), 600]]);
    fail(401, 'That PIN doesn\'t match.', 'bad_pin');
  }
}
function isAdmin(g, pin) {
  if (!pin) return false;
  pin = String(pin).trim();
  if (OWNER && safeEq(pin, OWNER)) return true;              // site owner's master PIN
  if (g.legacy) return false;
  return !!g.meta.adminHash && safeEq(adminHash(g.id, pin), g.meta.adminHash);
}
async function requireAdmin(g, b, ip) {
  await peekLimit('admin', ip, 10, 'Too many wrong organizer PINs. Wait 10 minutes and try again.');
  if (!isAdmin(g, b.adminPin)) {
    await limit('admin', ip, 1e9, 600, '');
    fail(401, 'Organizer PIN is incorrect.');
  }
}

function dishFrom(b, existing) {
  const name = clean(b.name, 80);
  if (!name) fail(400, 'Give your dish a name.');
  const cat = CATEGORIES.some(c => c.id === b.cat) ? b.cat : 'side';
  const tags = Array.isArray(b.tags) ? b.tags.filter(t => TAGS.includes(t)) : [];
  return { ...existing, name, cat, tags, note: cleanNote(b.note, 200), serves: clean(b.serves, 20) };
}

/* ---------- Actions that don't need a group ---------- */
const open = {
  // Front page: theme it for the next holiday.
  async peek() {
    return { holiday: activeHoliday(DEFAULT_SETTINGS), siteName: SITE_NAME };
  },

  async createGroup(b, ip) {
    if (b.website) fail(400, 'Something went wrong. Try again.');   // honeypot for bots
    const name = clean(b.groupName, 40);
    if (name.length < 2) fail(400, 'Give your group a name.');
    const code = validCode(b.code);
    const pin = String(b.adminPin || '').trim();
    if (pin.length < 4 || pin.length > 20) fail(400, 'Your organizer PIN should be 4 to 20 characters.');
    const [count] = await redis([['HLEN', G.groups]]);
    if (count >= MAX_GROUPS) fail(503, 'We\'re not taking new groups right now. Please check back later.');
    await peekLimit('create', ip, 5, 'You\'ve started several groups today. Try again tomorrow.');
    const id = newId();
    const [ok] = await redis([['HSETNX', G.codes, code, id]]);
    if (!ok) fail(409, 'That group code is taken. Try another.');
    const meta = { id, name, code, adminHash: adminHash(id, pin), created: Date.now() };
    await redis([
      ['HSET', G.groups, id, JSON.stringify(meta)],
      ['SET', P + 'g:' + id + ':settings', JSON.stringify({ ...DEFAULT_SETTINGS, siteName: name })],
      ['INCR', G.rate('create', ip)], ['EXPIRE', G.rate('create', ip), 86400],
    ]);
    return { ok: true, code };
  },
};

/* ---------- Actions inside a group ---------- */
const actions = {
  async state(g) { return fullState(g, await loadSettings(g)); },

  // Sign in with just a name. This device gets a token so it stays signed in.
  // A PIN is only needed to sign in as the same person on another device.
  async signin(g, b) {
    const k = K(g);
    const name = clean(b.name, 40);
    const pin = String(b.pin || '').trim();
    if (!name) fail(400, 'Enter your name.');
    if (pin && !/^\d{4}$/.test(pin)) fail(400, 'Your PIN should be 4 digits.');
    const [people, tokens] = await redis([['HGETALL', k.people], ['HKEYS', k.tokens]]);
    const list = Object.values(pairs(people)).map(p => parse(p, null)).filter(Boolean);
    let person = list.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (person) {
      const [stored] = await redis([['HGET', k.pins, person.id]]);
      if (stored) {
        if (!pin) fail(401, `Welcome back, ${person.name}! Enter your PIN to sign in on this device.`, 'pin_required');
        await checkPerson(g, person.id, pin);
      } else if ((tokens || []).includes(person.id)) {
        fail(409, `Someone named ${person.name} already signed in on another device. If that's you, ask the organizer to reset your sign-in. Otherwise, add a last initial to your name.`, 'name_taken');
      } else if (pin) {
        await redis([['HSET', k.pins, person.id, pinHash(g, person.id, pin)]]);
      }
      await redis([['DEL', k.fails(person.id)]]);
      return { person: { id: person.id, name: person.name }, token: await issueToken(g, person.id), created: false, hasPin: !!(stored || pin) };
    }
    if (list.length >= 300) fail(400, 'This group is full.');
    person = { id: newId(), name };
    const cmds = [['HSET', k.people, person.id, JSON.stringify(person)]];
    if (pin) cmds.push(['HSET', k.pins, person.id, pinHash(g, person.id, pin)]);
    await redis(cmds);
    return { person, token: await issueToken(g, person.id), created: true, hasPin: !!pin };
  },

  // Set or change your PIN so you can sign in on another device.
  async setPin(g, b) {
    await checkPerson(g, b.personId, b.pin, b.token);
    const pin = String(b.newPin || '').trim();
    if (!/^\d{4}$/.test(pin)) fail(400, 'Your PIN should be 4 digits.');
    await redis([['HSET', K(g).pins, b.personId, pinHash(g, b.personId, pin)]]);
    return { ok: true };
  },

  async copyLastYear(g, b, ip) {
    await requireAdmin(g, b, ip);
    const hol = activeHoliday(await loadSettings(g));
    if (hol.id === 'custom') fail(400, 'Nothing to copy for a special gathering.');
    const k = K(g);
    const [prev] = await redis([['GET', k.event(`${hol.id}-${hol.year - 1}`)]]);
    const ev = parse(prev, null);
    if (!ev) fail(404, 'There\'s no setup from last year to copy.');
    await redis([['SET', k.event(hol.key), JSON.stringify({ ...ev, dateOverride: '' })]]);
    return { ok: true };
  },

  async saveDish(g, b) {
    const k = K(g), ev = activeHoliday(await loadSettings(g)).key;
    const admin = isAdmin(g, b.adminPin);
    if (!admin) await checkPerson(g, b.personId, b.pin, b.token);
    let existing = null;
    if (b.id) {
      const [raw] = await redis([['HGET', k.dishes(ev), b.id]]);
      existing = parse(raw, null);
      if (!existing) fail(404, 'That dish was already removed.');
      if (!admin && existing.personId !== b.personId) fail(403, 'You can only change your own dishes.');
    } else {
      if (!b.personId) fail(401, 'Please sign in again.');
      const [count] = await redis([['HLEN', k.dishes(ev)]]);
      if (count >= 300) fail(400, 'This list is full.');
      existing = { id: newId(), personId: b.personId, ts: Date.now() };
    }
    const dish = dishFrom(b, existing);
    await redis([['HSET', k.dishes(ev), dish.id, JSON.stringify(dish)]]);
    return { ok: true, dish };
  },

  async removeDish(g, b) {
    const k = K(g), ev = activeHoliday(await loadSettings(g)).key;
    const admin = isAdmin(g, b.adminPin);
    if (!admin) await checkPerson(g, b.personId, b.pin, b.token);
    const [raw] = await redis([['HGET', k.dishes(ev), b.id]]);
    const dish = parse(raw, null);
    if (!dish) return { ok: true };
    if (!admin && dish.personId !== b.personId) fail(403, 'You can only remove your own dishes.');
    await redis([['HDEL', k.dishes(ev), b.id]]);
    return { ok: true };
  },

  async rsvp(g, b) {
    const k = K(g), ev = activeHoliday(await loadSettings(g)).key;
    await checkPerson(g, b.personId, b.pin, b.token);
    const status = ['yes', 'maybe', 'no'].includes(b.status) ? b.status : 'yes';
    const r = { status, adults: status === 'no' ? 0 : int(b.adults, 0, 30), kids: status === 'no' ? 0 : int(b.kids, 0, 30) };
    await redis([['HSET', k.rsvp(ev), b.personId, JSON.stringify(r)]]);
    return { ok: true };
  },

  async adminCheck(g, b, ip) { await requireAdmin(g, b, ip); return { ok: true }; },

  async setHoliday(g, b, ip) {
    await requireAdmin(g, b, ip);
    const settings = await loadSettings(g);
    if (b.mode === 'auto') settings.mode = 'auto';
    else {
      if (!HOLIDAY_IDS.has(b.holiday)) fail(400, 'Unknown holiday.');
      settings.mode = 'fixed';
      settings.holiday = b.holiday;
      if (b.holiday === 'custom' && (b.newCustom || !settings.customKey)) settings.customKey = 'custom-' + newId();
    }
    if (b.siteName !== undefined) settings.siteName = clean(b.siteName, 40) || g.name || SITE_NAME;
    await redis([['SET', K(g).settings, JSON.stringify(settings)]]);
    return { ok: true };
  },

  async setEvent(g, b, ip) {
    await requireAdmin(g, b, ip);
    const ev = activeHoliday(await loadSettings(g)).key;
    const targets = {};
    for (const c of CATEGORIES) { const n = int((b.targets || {})[c.id], 0, 50); if (n) targets[c.id] = n; }
    const dateOverride = /^\d{4}-\d{2}-\d{2}$/.test(b.dateOverride || '') ? b.dateOverride : '';
    const event = {
      title: clean(b.title, 60), dateOverride, time: clean(b.time, 30),
      location: clean(b.location, 120), host: clean(b.host, 60), notes: cleanNote(b.notes, 600), targets,
    };
    await redis([['SET', K(g).event(ev), JSON.stringify(event)]]);
    return { ok: true };
  },

  async setCode(g, b, ip) {
    await requireAdmin(g, b, ip);
    if (g.legacy) fail(400, 'This group\'s code is set in Vercel (GROUP_CODE). Change it there.');
    const code = validCode(b.code);
    if (code === g.code) return { ok: true, code };
    const [ok] = await redis([['HSETNX', G.codes, code, g.id]]);
    if (!ok) fail(409, 'That group code is taken. Try another.');
    await redis([['HDEL', G.codes, g.code], ['HSET', G.groups, g.id, JSON.stringify({ ...g.meta, code })]]);
    return { ok: true, code };
  },

  async setAdminPin(g, b, ip) {
    await requireAdmin(g, b, ip);
    if (g.legacy) fail(400, 'This group\'s organizer PIN is set in Vercel (ADMIN_PIN). Change it there.');
    const pin = String(b.newPin || '').trim();
    if (pin.length < 4 || pin.length > 20) fail(400, 'The organizer PIN should be 4 to 20 characters.');
    await redis([['HSET', G.groups, g.id, JSON.stringify({ ...g.meta, adminHash: adminHash(g.id, pin) })]]);
    return { ok: true };
  },

  async deleteGroup(g, b, ip) {
    await requireAdmin(g, b, ip);
    if (g.legacy) fail(400, 'The original group can\'t be deleted from here.');
    let cursor = '0', keys = [];
    do {
      const [res] = await redis([['SCAN', cursor, 'MATCH', g.prefix + '*', 'COUNT', 500]]);
      cursor = String(res[0]); keys = keys.concat(res[1]);
    } while (cursor !== '0');
    const cmds = keys.map(key => ['DEL', key]);
    cmds.push(['HDEL', G.codes, g.code], ['HDEL', G.groups, g.id]);
    await redis(cmds);
    return { ok: true };
  },

  async resetPin(g, b, ip) {
    await requireAdmin(g, b, ip);
    const k = K(g);
    await redis([['HDEL', k.pins, b.personId], ['HDEL', k.tokens, b.personId], ['DEL', k.fails(b.personId)]]);
    return { ok: true };
  },

  async removePerson(g, b, ip) {
    await requireAdmin(g, b, ip);
    const k = K(g), ev = activeHoliday(await loadSettings(g)).key;
    const [dishes] = await redis([['HGETALL', k.dishes(ev)]]);
    const mine = Object.values(pairs(dishes)).map(d => parse(d, null)).filter(d => d && d.personId === b.personId);
    const cmds = [['HDEL', k.people, b.personId], ['HDEL', k.pins, b.personId], ['HDEL', k.tokens, b.personId], ['HDEL', k.rsvp(ev), b.personId]];
    for (const d of mine) cmds.push(['HDEL', k.dishes(ev), d.id]);
    await redis(cmds);
    return { ok: true };
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') fail(405, 'Use POST.');
    if (!DB_URL || !DB_TOKEN) fail(500, 'The database isn\'t connected yet. Connect Upstash in Vercel → Storage.');
    let b = req.body;
    if (typeof b === 'string') b = parse(b, {});
    b = b || {};
    const ip = clientIp(req);
    if (open[b.action]) return res.status(200).json(await open[b.action](b, ip));
    const fn = actions[b.action];
    if (!fn) fail(400, 'Unknown action.');
    const g = await resolveGroup(b.family, ip);
    res.status(200).json(await fn(g, b, ip));
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error(e);
    res.status(status).json({ error: e.status ? e.message : 'Something went wrong. Try again.', code: e.code });
  }
};
module.exports._test = { HOLIDAYS, occurrence, activeHoliday, easter, normCode };
