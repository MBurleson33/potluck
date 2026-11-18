// Holiday Potluck API — one Vercel serverless function.
// Storage: Upstash Redis REST (shares an existing Vercel → Storage → Upstash database).
// Env vars: FAMILY_CODE, ADMIN_PIN, KV_REST_API_URL / KV_REST_API_TOKEN (Vercel adds these
// when you connect the database), optional KEY_PREFIX (default "pl:") and TIMEZONE.
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FAMILY = (process.env.FAMILY_CODE || '').trim().toLowerCase();
const ADMIN = (process.env.ADMIN_PIN || '').trim();
const P = process.env.KEY_PREFIX || 'pl:';
const TZ = process.env.TIMEZONE || 'America/Chicago';

const K = {
  settings: P + 'settings',
  people: P + 'people',
  pins: P + 'pins',
  fails: id => P + 'fail:' + id,
  event: ev => P + 'ev:' + ev,
  dishes: ev => P + 'dish:' + ev,
  rsvp: ev => P + 'rsvp:' + ev,
};

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
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

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
const pinHash = (id, pin) => sha(FAMILY + ':' + id + ':' + pin);
const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a))), Buffer.from(sha(String(b))));
const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNote = (s, max) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, max);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

const DEFAULT_SETTINGS = { mode: 'auto', holiday: 'thanksgiving', siteName: 'Family Potluck' };
const DEFAULT_EVENT = { title: '', dateOverride: '', time: '', location: '', host: '', notes: '', targets: {} };

async function loadSettings() {
  const [s] = await redis([['GET', K.settings]]);
  return { ...DEFAULT_SETTINGS, ...parse(s, {}) };
}

function holidayList(now) {
  return HOLIDAYS.map(h => ({ id: h.id, name: h.name, date: occurrence(h, now).date }));
}

async function fullState(settings) {
  const now = today();
  const hol = activeHoliday(settings, now);
  const ev = hol.key;
  const [people, pins, event, dishes, rsvp] = await redis([
    ['HGETALL', K.people], ['HKEYS', K.pins], ['GET', K.event(ev)],
    ['HGETALL', K.dishes(ev)], ['HGETALL', K.rsvp(ev)],
  ]);
  const pinSet = new Set(pins || []);
  const ppl = Object.values(pairs(people)).map(p => parse(p, null)).filter(Boolean)
    .map(p => ({ id: p.id, name: p.name, hasPin: pinSet.has(p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    today: now,
    settings,
    holiday: hol,
    holidays: holidayList(now),
    categories: CATEGORIES,
    tags: TAGS,
    event: { ...DEFAULT_EVENT, ...parse(event, {}) },
    people: ppl,
    dishes: Object.values(pairs(dishes)).map(d => parse(d, null)).filter(Boolean)
      .sort((a, b) => a.ts - b.ts),
    rsvps: Object.fromEntries(Object.entries(pairs(rsvp)).map(([k, v]) => [k, parse(v, {})])),
  };
}

async function checkPerson(personId, pin) {
  if (!personId || !/^\d{4}$/.test(String(pin || ''))) fail(401, 'Please sign in again.');
  const [stored, fails] = await redis([['HGET', K.pins, personId], ['GET', K.fails(personId)]]);
  if (Number(fails) >= 5) fail(429, 'Too many wrong PINs. Try again in 10 minutes, or ask the organizer to reset your PIN.');
  if (!stored || !safeEq(stored, pinHash(personId, pin))) {
    await redis([['INCR', K.fails(personId)], ['EXPIRE', K.fails(personId), 600]]);
    fail(401, 'That PIN doesn\'t match.');
  }
}
const isAdmin = pin => ADMIN && pin && safeEq(String(pin).trim(), ADMIN);
function requireAdmin(b) { if (!isAdmin(b.adminPin)) fail(401, 'Organizer PIN is incorrect.'); }

function dishFrom(b, existing) {
  const name = clean(b.name, 80);
  if (!name) fail(400, 'Give your dish a name.');
  const cat = CATEGORIES.some(c => c.id === b.cat) ? b.cat : 'side';
  const tags = Array.isArray(b.tags) ? b.tags.filter(t => TAGS.includes(t)) : [];
  return { ...existing, name, cat, tags, note: cleanNote(b.note, 200), serves: clean(b.serves, 20) };
}

/* ---------- Actions ---------- */
const actions = {
  // No family code needed: just enough to theme the sign-in screen.
  async peek() {
    const settings = await loadSettings();
    const hol = activeHoliday(settings);
    return { holiday: hol, siteName: settings.siteName };
  },

  async state(b) { return fullState(await loadSettings()); },

  async signin(b) {
    const name = clean(b.name, 40);
    const pin = String(b.pin || '');
    if (!name) fail(400, 'Enter your name.');
    if (!/^\d{4}$/.test(pin)) fail(400, 'Your PIN should be 4 digits.');
    const [people] = await redis([['HGETALL', K.people]]);
    const list = Object.values(pairs(people)).map(p => parse(p, null)).filter(Boolean);
    let person = list.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (person) {
      const [stored] = await redis([['HGET', K.pins, person.id]]);
      if (stored) await checkPerson(person.id, pin);
      else await redis([['HSET', K.pins, person.id, pinHash(person.id, pin)]]);
      await redis([['DEL', K.fails(person.id)]]);
      return { person: { id: person.id, name: person.name }, created: false };
    }
    if (b.mustExist) fail(404, 'No one by that name yet.');
    person = { id: newId(), name };
    await redis([
      ['HSET', K.people, person.id, JSON.stringify(person)],
      ['HSET', K.pins, person.id, pinHash(person.id, pin)],
    ]);
    return { person, created: true };
  },

  async saveDish(b) {
    const settings = await loadSettings();
    const ev = activeHoliday(settings).key;
    const admin = isAdmin(b.adminPin);
    if (!admin) await checkPerson(b.personId, b.pin);
    let existing = null;
    if (b.id) {
      const [raw] = await redis([['HGET', K.dishes(ev), b.id]]);
      existing = parse(raw, null);
      if (!existing) fail(404, 'That dish was already removed.');
      if (!admin && existing.personId !== b.personId) fail(403, 'You can only change your own dishes.');
    } else {
      const [count] = await redis([['HLEN', K.dishes(ev)]]);
      if (count >= 300) fail(400, 'This list is full.');
      existing = { id: newId(), personId: b.personId, ts: Date.now() };
    }
    const dish = dishFrom(b, existing);
    await redis([['HSET', K.dishes(ev), dish.id, JSON.stringify(dish)]]);
    return { ok: true, dish };
  },

  async removeDish(b) {
    const settings = await loadSettings();
    const ev = activeHoliday(settings).key;
    const admin = isAdmin(b.adminPin);
    if (!admin) await checkPerson(b.personId, b.pin);
    const [raw] = await redis([['HGET', K.dishes(ev), b.id]]);
    const dish = parse(raw, null);
    if (!dish) return { ok: true };
    if (!admin && dish.personId !== b.personId) fail(403, 'You can only remove your own dishes.');
    await redis([['HDEL', K.dishes(ev), b.id]]);
    return { ok: true };
  },

  async rsvp(b) {
    const settings = await loadSettings();
    const ev = activeHoliday(settings).key;
    await checkPerson(b.personId, b.pin);
    const status = ['yes', 'maybe', 'no'].includes(b.status) ? b.status : 'yes';
    const r = { status, adults: status === 'no' ? 0 : int(b.adults, 0, 30), kids: status === 'no' ? 0 : int(b.kids, 0, 30) };
    await redis([['HSET', K.rsvp(ev), b.personId, JSON.stringify(r)]]);
    return { ok: true };
  },

  async adminCheck(b) { requireAdmin(b); return { ok: true }; },

  async setHoliday(b) {
    requireAdmin(b);
    const settings = await loadSettings();
    if (b.mode === 'auto') settings.mode = 'auto';
    else {
      if (!HOLIDAY_IDS.has(b.holiday)) fail(400, 'Unknown holiday.');
      settings.mode = 'fixed';
      settings.holiday = b.holiday;
      if (b.holiday === 'custom' && (b.newCustom || !settings.customKey)) settings.customKey = 'custom-' + newId();
    }
    if (b.siteName !== undefined) settings.siteName = clean(b.siteName, 40) || DEFAULT_SETTINGS.siteName;
    await redis([['SET', K.settings, JSON.stringify(settings)]]);
    return { ok: true };
  },

  async setEvent(b) {
    requireAdmin(b);
    const settings = await loadSettings();
    const ev = activeHoliday(settings).key;
    const targets = {};
    for (const c of CATEGORIES) { const n = int((b.targets || {})[c.id], 0, 50); if (n) targets[c.id] = n; }
    const dateOverride = /^\d{4}-\d{2}-\d{2}$/.test(b.dateOverride || '') ? b.dateOverride : '';
    const event = {
      title: clean(b.title, 60), dateOverride, time: clean(b.time, 30),
      location: clean(b.location, 120), host: clean(b.host, 60), notes: cleanNote(b.notes, 600), targets,
    };
    await redis([['SET', K.event(ev), JSON.stringify(event)]]);
    return { ok: true };
  },

  async resetPin(b) {
    requireAdmin(b);
    await redis([['HDEL', K.pins, b.personId], ['DEL', K.fails(b.personId)]]);
    return { ok: true };
  },

  async removePerson(b) {
    requireAdmin(b);
    const settings = await loadSettings();
    const ev = activeHoliday(settings).key;
    const [dishes] = await redis([['HGETALL', K.dishes(ev)]]);
    const mine = Object.values(pairs(dishes)).map(d => parse(d, null)).filter(d => d && d.personId === b.personId);
    const cmds = [['HDEL', K.people, b.personId], ['HDEL', K.pins, b.personId], ['HDEL', K.rsvp(ev), b.personId]];
    for (const d of mine) cmds.push(['HDEL', K.dishes(ev), d.id]);
    await redis(cmds);
    return { ok: true };
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') fail(405, 'Use POST.');
    if (!DB_URL || !DB_TOKEN) fail(500, 'The database isn\'t connected yet. Connect Upstash in Vercel → Storage.');
    if (!FAMILY) fail(500, 'FAMILY_CODE isn\'t set in Vercel yet.');
    let b = req.body;
    if (typeof b === 'string') b = parse(b, {});
    b = b || {};
    const fn = actions[b.action];
    if (!fn) fail(400, 'Unknown action.');
    if (b.action !== 'peek') {
      const code = String(b.family || '').trim().toLowerCase();
      if (!code || !safeEq(code, FAMILY)) fail(401, 'That family code isn\'t right.');
    }
    res.status(200).json(await fn(b));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500 && !e.status) console.error(e);
    res.status(status).json({ error: e.status ? e.message : 'Something went wrong. Try again.' });
  }
};
module.exports._test = { HOLIDAYS, occurrence, activeHoliday, easter };
