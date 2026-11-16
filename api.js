// Feather Courier API: shared parcel tracking for the flock.
// SQLite storage for parcels and their movement log.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'courier.db'));
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS parcels (
  code TEXT PRIMARY KEY,
  bird TEXT NOT NULL,
  to_bird TEXT NOT NULL,
  item TEXT NOT NULL,
  from_place TEXT DEFAULT '',
  to_place TEXT DEFAULT '',
  status TEXT DEFAULT 'sealed',
  note TEXT DEFAULT '',
  created TEXT DEFAULT '',
  updated TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  by_bird TEXT DEFAULT '',
  place TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS event_code ON events(code);`);

const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const STATUSES = ['sealed', 'picked up', 'in flight', 'arrived', 'opened', 'returned'];
const nextStatus = {
  'sealed': 'picked up',
  'picked up': 'in flight',
  'in flight': 'arrived',
  'arrived': 'opened',
  'opened': null,
  'returned': null
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
  });
}

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return 'FC-' + s;
}

function parcelRow(r) {
  const events = db.prepare('SELECT * FROM events WHERE code = ? ORDER BY created ASC').all(r.code);
  return {
    code: r.code, bird: r.bird, to_bird: r.to_bird, item: r.item,
    from_place: r.from_place, to_place: r.to_place, status: r.status,
    note: r.note, created: r.created, updated: r.updated,
    next: nextStatus[r.status] || null,
    events: events.map(e => ({
      status: e.status, by_bird: e.by_bird, place: e.place,
      note: e.note, created: e.created
    }))
  };
}

module.exports = function handler(req, res, route) {
  route = Array.isArray(route) ? route.join('/') : String(route || '');
  const seg = route.split('/').filter(Boolean);

  if (req.method === 'GET' && (route === '' || route === 'parcels')) {
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const status = (u.searchParams.get('status') || '').trim().toLowerCase();
    let rows = db.prepare('SELECT * FROM parcels ORDER BY created DESC').all();
    if (q) rows = rows.filter(r =>
      [r.code, r.bird, r.to_bird, r.item, r.from_place, r.to_place, r.note]
        .join(' ').toLowerCase().includes(q));
    if (status) rows = rows.filter(r => String(r.status).toLowerCase() === status);
    return json(res, 200, { count: rows.length, parcels: rows.map(parcelRow), statuses: STATUSES });
  }

  if (req.method === 'GET' && seg[0] === 'parcel' && seg[1]) {
    const r = db.prepare('SELECT * FROM parcels WHERE code = ?').get(seg[1].toUpperCase());
    if (!r) return json(res, 404, { error: 'no such parcel' });
    return json(res, 200, { parcel: parcelRow(r) });
  }

  if (req.method === 'GET' && route === 'stats') {
    const total = db.prepare('SELECT COUNT(*) AS n FROM parcels').get().n;
    const inFlight = db.prepare("SELECT COUNT(*) AS n FROM parcels WHERE status NOT IN ('opened','returned')").get().n;
    const delivered = db.prepare("SELECT COUNT(*) AS n FROM parcels WHERE status = 'opened'").get().n;
    const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM parcels GROUP BY status').all();
    return json(res, 200, { total, inFlight, delivered, byStatus });
  }

  if (req.method === 'POST' && route === 'parcel') {
    return readBody(req).then(b => {
      const bird = String(b.bird || '').trim().slice(0, 40);
      const toBird = String(b.to_bird || '').trim().slice(0, 40);
      const item = String(b.item || '').trim().slice(0, 120);
      if (!bird || !toBird || !item) {
        return json(res, 400, { error: 'a parcel needs a sender, a receiver and an item' });
      }
      let code = code4();
      while (db.prepare('SELECT code FROM parcels WHERE code = ?').get(code)) code = code4();
      const t = now();
      db.prepare(`INSERT INTO parcels
        (code,bird,to_bird,item,from_place,to_place,status,note,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        code, bird, toBird, item,
        String(b.from_place || '').slice(0, 120),
        String(b.to_place || '').slice(0, 120),
        'sealed',
        String(b.note || '').slice(0, 400),
        t, t);
      db.prepare('INSERT INTO events (id,code,status,by_bird,place,note,created) VALUES (?,?,?,?,?,?,?)')
        .run(rid(), code, 'sealed', bird, String(b.from_place || '').slice(0, 120), 'parcel sealed', t);
      return json(res, 200, { ok: true, parcel: parcelRow(db.prepare('SELECT * FROM parcels WHERE code = ?').get(code)) });
    });
  }

  if (req.method === 'POST' && route === 'move') {
    return readBody(req).then(b => {
      const code = String(b.code || '').trim().toUpperCase();
      const by = String(b.by_bird || '').trim().slice(0, 40);
      const p = db.prepare('SELECT * FROM parcels WHERE code = ?').get(code);
      if (!p) return json(res, 404, { error: 'no such parcel' });
      if (!by) return json(res, 400, { error: 'who is moving it?' });
      let status = String(b.status || '').trim().toLowerCase();
      if (!status) status = nextStatus[p.status] || '';
      if (!STATUSES.includes(status)) return json(res, 400, { error: 'unknown status' });
      if (status === p.status) return json(res, 400, { error: 'it is already ' + status });
      const t = now();
      db.prepare('UPDATE parcels SET status = ?, updated = ? WHERE code = ?').run(status, t, code);
      db.prepare('INSERT INTO events (id,code,status,by_bird,place,note,created) VALUES (?,?,?,?,?,?,?)')
        .run(rid(), code, status, by, String(b.place || '').slice(0, 120), String(b.note || '').slice(0, 240), t);
      return json(res, 200, { ok: true, parcel: parcelRow(db.prepare('SELECT * FROM parcels WHERE code = ?').get(code)) });
    });
  }

  return json(res, 404, { error: 'not found' });
};
