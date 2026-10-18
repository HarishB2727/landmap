// Land Map - simple server. No extra packages needed: run with `node server.js` (Node 18+).
// Stores everything in ./data (db.json + uploads/).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB_FILE = path.join(DATA, 'db.json');
const MAX_BODY = 25 * 1024 * 1024; // 25 MB (photos are sent as base64)

fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- tiny JSON database ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPassword(pw, user) {
  const h = crypto.scryptSync(String(pw), user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
const newId = () => crypto.randomBytes(8).toString('hex');

const DEFAULT_SETTINGS = {
  appName: 'Land Map',
  showSurvey: true,          // survey-number layer available to users
  surveyOnByDefault: true,
  tabs: { listings: true, measure: true, sketch: true },
  googleKey: '',
  center: [17.31, 78.13],
  zoom: 14,
  cadUrl: 'https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wms/',
  cadLayer: 'cadastral:cadastral_india'
};

let db;
function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings, { tabs: Object.assign({}, DEFAULT_SETTINGS.tabs, (db.settings || {}).tabs) });
    db.users ||= []; db.listings ||= []; db.sketches ||= [];
    return;
  }
  const admin = { id: newId(), username: 'admin', name: 'Admin', role: 'admin', ...hashPassword('admin123'), createdAt: Date.now() };
  const test = { id: newId(), username: 'test', name: 'Test User', role: 'user', ...hashPassword('test123'), createdAt: Date.now() };
  db = {
    settings: { ...DEFAULT_SETTINGS },
    users: [admin, test],
    listings: [{
      id: newId(), name: 'Example: 5 acre farm near Chevella', survey: '123/A', village: 'Example village', mandal: 'Chevella', district: 'Ranga Reddy',
      status: 'available', ask: '4500000', neg: '4200000', final: '', contact: '98xxxxxx00', description: 'Sample listing so you can see how it looks. Edit or delete it in the admin screen.',
      adminNotes: '', published: true, coords: [[17.3112, 78.1290], [17.3114, 78.1318], [17.3096, 78.1320], [17.3094, 78.1292]],
      files: [], createdAt: Date.now(), updatedAt: Date.now()
    }],
    sketches: []
  };
  saveDb();
  console.log('Created data/db.json with accounts  admin / admin123  and  test / test123  (change these passwords!)');
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}
loadDb();

// ---------- sessions ----------
const sessions = new Map(); // sid -> { userId, expires }
const SESSION_MS = 30 * 24 * 3600 * 1000;
function getUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { sessions.delete(m && m[1]); return null; }
  return db.users.find(u => u.id === s.userId) || null;
}
const publicUser = u => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt });

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.heic': 'image/heic' };
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}
const clean = (v, max = 2000) => String(v ?? '').slice(0, max);
const LISTING_FIELDS = ['name', 'survey', 'village', 'mandal', 'district', 'status', 'ask', 'neg', 'final', 'contact', 'description', 'adminNotes'];
function listingForUser(l) { const { adminNotes, published, ...rest } = l; return rest; }
function validCoords(c) {
  return Array.isArray(c) && c.length >= 3 && c.length <= 500 && c.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && isFinite(n)));
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname, method = req.method;
  const user = getUser(req);

  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const u = db.users.find(x => x.username.toLowerCase() === clean(b.username, 100).toLowerCase());
    if (!u || !checkPassword(b.password || '', u)) return send(res, 401, { error: 'Wrong username or password.' });
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { userId: u.id, expires: Date.now() + SESSION_MS });
    return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
  }
  if (p === '/api/logout' && method === 'POST') {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (!user) return send(res, 401, { error: 'Please log in.' });
  const isAdmin = user.role === 'admin';
  const adminOnly = () => { if (!isAdmin) { send(res, 403, { error: 'Admins only.' }); return true; } return false; };

  if (p === '/api/me' && method === 'GET') return send(res, 200, { user: publicUser(user), settings: db.settings });
  if (p === '/api/me/password' && method === 'POST') {
    const b = await readBody(req);
    if (!checkPassword(b.current || '', user)) return send(res, 400, { error: 'Current password is wrong.' });
    if (String(b.password || '').length < 6) return send(res, 400, { error: 'New password needs at least 6 characters.' });
    Object.assign(user, hashPassword(b.password)); saveDb(); return send(res, 200, { ok: true });
  }

  // settings
  if (p === '/api/settings' && method === 'PUT') {
    if (adminOnly()) return; const b = await readBody(req); const s = db.settings;
    if ('appName' in b) s.appName = clean(b.appName, 60) || 'Land Map';
    for (const k of ['showSurvey', 'surveyOnByDefault']) if (k in b) s[k] = !!b[k];
    if (b.tabs) for (const k of ['listings', 'measure', 'sketch']) if (k in b.tabs) s.tabs[k] = !!b.tabs[k];
    if ('googleKey' in b) s.googleKey = clean(b.googleKey, 200).trim();
    if (Array.isArray(b.center) && b.center.length === 2 && b.center.every(n => typeof n === 'number' && isFinite(n))) s.center = b.center;
    if (typeof b.zoom === 'number' && b.zoom >= 3 && b.zoom <= 20) s.zoom = b.zoom;
    if ('cadUrl' in b) s.cadUrl = clean(b.cadUrl, 300).trim() || DEFAULT_SETTINGS.cadUrl;
    if ('cadLayer' in b) s.cadLayer = clean(b.cadLayer, 120).trim() || DEFAULT_SETTINGS.cadLayer;
    saveDb(); return send(res, 200, { settings: s });
  }

  // users (admin)
  if (p === '/api/users' && method === 'GET') { if (adminOnly()) return; return send(res, 200, { users: db.users.map(publicUser) }); }
  if (p === '/api/users' && method === 'POST') {
    if (adminOnly()) return; const b = await readBody(req);
    const username = clean(b.username, 40).trim();
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return send(res, 400, { error: 'Username: 3-40 letters, numbers, dot, dash or underscore.' });
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return send(res, 400, { error: 'That username is taken.' });
    if (String(b.password || '').length < 6) return send(res, 400, { error: 'Password needs at least 6 characters.' });
    const u = { id: newId(), username, name: clean(b.name, 80) || username, role: b.role === 'admin' ? 'admin' : 'user', ...hashPassword(b.password), createdAt: Date.now() };
    db.users.push(u); saveDb(); return send(res, 200, { user: publicUser(u) });
  }
  let m = p.match(/^\/api\/users\/([a-f0-9]+)$/);
  if (m) {
    if (adminOnly()) return; const u = db.users.find(x => x.id === m[1]); if (!u) return send(res, 404, { error: 'User not found.' });
    if (method === 'DELETE') {
      if (u.id === user.id) return send(res, 400, { error: 'You cannot delete your own account.' });
      db.users = db.users.filter(x => x.id !== u.id); db.sketches = db.sketches.filter(s => s.userId !== u.id);
      for (const [sid, s] of sessions) if (s.userId === u.id) sessions.delete(sid);
      saveDb(); return send(res, 200, { ok: true });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      if (b.password !== undefined) { if (String(b.password).length < 6) return send(res, 400, { error: 'Password needs at least 6 characters.' }); Object.assign(u, hashPassword(b.password)); }
      if (b.name !== undefined) u.name = clean(b.name, 80) || u.username;
      if (b.role !== undefined && u.id !== user.id) u.role = b.role === 'admin' ? 'admin' : 'user';
      saveDb(); return send(res, 200, { user: publicUser(u) });
    }
  }

  // listings
  if (p === '/api/listings' && method === 'GET') {
    return send(res, 200, { listings: isAdmin ? db.listings : db.listings.filter(l => l.published).map(listingForUser) });
  }
  if (p === '/api/listings' && method === 'POST') {
    if (adminOnly()) return; const b = await readBody(req);
    if (!validCoords(b.coords)) return send(res, 400, { error: 'Draw the plot boundary first (at least 3 corners).' });
    const l = { id: newId(), files: [], published: !!b.published, coords: b.coords, createdAt: Date.now(), updatedAt: Date.now() };
    for (const f of LISTING_FIELDS) l[f] = clean(b[f]);
    if (!['available', 'hold', 'sold'].includes(l.status)) l.status = 'available';
    db.listings.push(l); saveDb(); return send(res, 200, { listing: l });
  }
  m = p.match(/^\/api\/listings\/([a-f0-9]+)$/);
  if (m) {
    if (adminOnly()) return; const l = db.listings.find(x => x.id === m[1]); if (!l) return send(res, 404, { error: 'Listing not found.' });
    if (method === 'PUT') {
      const b = await readBody(req);
      for (const f of LISTING_FIELDS) if (f in b) l[f] = clean(b[f]);
      if (!['available', 'hold', 'sold'].includes(l.status)) l.status = 'available';
      if ('published' in b) l.published = !!b.published;
      if ('coords' in b) { if (!validCoords(b.coords)) return send(res, 400, { error: 'Invalid boundary.' }); l.coords = b.coords; }
      l.updatedAt = Date.now(); saveDb(); return send(res, 200, { listing: l });
    }
    if (method === 'DELETE') {
      for (const f of l.files) fs.rm(path.join(UPLOADS, f.stored), () => {});
      db.listings = db.listings.filter(x => x.id !== l.id); saveDb(); return send(res, 200, { ok: true });
    }
  }
  m = p.match(/^\/api\/listings\/([a-f0-9]+)\/files$/);
  if (m && method === 'POST') {
    if (adminOnly()) return; const l = db.listings.find(x => x.id === m[1]); if (!l) return send(res, 404, { error: 'Listing not found.' });
    const b = await readBody(req);
    const dm = /^data:([\w/+.-]+);base64,(.+)$/.exec(b.data || '');
    if (!dm) return send(res, 400, { error: 'Bad file.' });
    const ext = (path.extname(clean(b.name, 200)).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
    const fid = newId(), stored = fid + ext;
    fs.writeFileSync(path.join(UPLOADS, stored), Buffer.from(dm[2], 'base64'));
    const f = { id: fid, name: clean(b.name, 200) || 'file' + ext, type: dm[1], stored, public: b.public !== false };
    l.files.push(f); l.updatedAt = Date.now(); saveDb(); return send(res, 200, { file: f, listing: l });
  }
  m = p.match(/^\/api\/listings\/([a-f0-9]+)\/files\/([a-f0-9]+)$/);
  if (m && method === 'DELETE') {
    if (adminOnly()) return; const l = db.listings.find(x => x.id === m[1]); if (!l) return send(res, 404, { error: 'Listing not found.' });
    const f = l.files.find(x => x.id === m[2]); if (f) fs.rm(path.join(UPLOADS, f.stored), () => {});
    l.files = l.files.filter(x => x.id !== m[2]); saveDb(); return send(res, 200, { listing: l });
  }

  // sketches (each user sees their own)
  if (p === '/api/sketches' && method === 'GET') return send(res, 200, { sketches: db.sketches.filter(s => s.userId === user.id) });
  if (p === '/api/sketches' && method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.items) || JSON.stringify(b.items).length > 3e6) return send(res, 400, { error: 'Sketch is empty or too large.' });
    let s = b.id && db.sketches.find(x => x.id === b.id && x.userId === user.id);
    if (s) { s.items = b.items; s.name = clean(b.name, 80) || s.name; s.view = b.view; s.updatedAt = Date.now(); }
    else { s = { id: newId(), userId: user.id, name: clean(b.name, 80) || 'Sketch', items: b.items, view: b.view, createdAt: Date.now(), updatedAt: Date.now() }; db.sketches.push(s); }
    saveDb(); return send(res, 200, { sketch: s });
  }
  m = p.match(/^\/api\/sketches\/([a-f0-9]+)$/);
  if (m && method === 'DELETE') { db.sketches = db.sketches.filter(s => !(s.id === m[1] && s.userId === user.id)); saveDb(); return send(res, 200, { ok: true }); }

  return send(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/files/')) {
      const user = getUser(req); if (!user) return send(res, 401, 'Please log in.');
      const stored = path.basename(url.pathname);
      const owner = db.listings.find(l => l.files.some(f => f.stored === stored));
      if (!owner || (user.role !== 'admin' && !owner.published)) return send(res, 404, 'Not found');
      return serveFile(res, path.join(UPLOADS, stored), { 'Cache-Control': 'private, max-age=86400' });
    }
    // pages
    const user = getUser(req);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(302, { Location: user ? (user.role === 'admin' ? '/admin' : '/app') : '/login' }); return res.end();
    }
    if (url.pathname === '/login') return serveFile(res, path.join(PUBLIC, 'login.html'));
    if (url.pathname === '/app') { if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); } return serveFile(res, path.join(PUBLIC, 'app.html')); }
    if (url.pathname === '/admin') {
      if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      if (user.role !== 'admin') { res.writeHead(302, { Location: '/app' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC, 'admin.html'));
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    return serveFile(res, file);
  } catch (e) {
    console.error(e);
    send(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'File is too large (25 MB max).' : 'Something went wrong with that request.' });
  }
});
server.listen(PORT, () => console.log(`Land Map running at http://localhost:${PORT}`));
