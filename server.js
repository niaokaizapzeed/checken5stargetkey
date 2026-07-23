/* ============================================================================
 * CHECKEN5STAR — key distribution platform
 *   /            homepage (catalog: video + description + Get Key button)
 *   /<slug>      product page (ads + checkpoint flow -> key)
 *   /login       admin login (URL only, no link on site)
 *   /admin       admin panel (manage site, categories, products, keys)
 * Everything is configurable from the admin panel and stored in DATA_DIR.
 * ==========================================================================*/
require('dotenv').config();
const express      = require('express');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT        = process.env.PORT || 3000;
const SECRET      = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL   = clampInt(process.env.TOKEN_TTL, 3600, 60, 86400);
const SESSION_TTL = clampInt(process.env.SESSION_TTL, 600, 10, 86400);   // whole run window (default 10 min)
const ADMIN_TTL   = clampInt(process.env.ADMIN_TTL, 86400, 300, 604800); // admin login lifetime
const ADMIN_USER  = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS || '';                        // MUST be set to enable admin login
const IS_PROD     = process.env.NODE_ENV === 'production';

const TURNSTILE_SITE_KEY   = process.env.TURNSTILE_SITE_KEY   || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_ENABLED    = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

const DATA_DIR   = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const KEYS_DIR   = path.join(DATA_DIR, 'keys');
const USED_FILE  = path.join(DATA_DIR, 'used_keys.txt');
const CLAIMED_FILE = path.join(DATA_DIR, 'claimed.json');

const RESERVED = new Set(['login','admin','api','health','ads','advertisement','adsbygoogle',
  'favicon.ico','robots.txt','index.html','product.html','admin.html','style.css',
  'home.js','product.js','admin.js','app.js']);

if (!process.env.SECRET_KEY) console.warn('[WARN] SECRET_KEY not set — sessions reset on restart. Set it in production!');
if (!ADMIN_PASS) console.warn('[WARN] ADMIN_PASS not set — admin login is DISABLED until you set it.');

// ---------------------------------------------------------------------------
// Data store (site + categories + products) and per-product key stock
// ---------------------------------------------------------------------------
let store = defaultStore();
let stocks = {};          // productId -> [keys]
let claimed = {};         // sid -> { slug, key }

function defaultStore() {
  return {
    site: {
      name: 'CHECKEN5STAR', logoUrl: '',
      banner: { imageUrl: '', linkUrl: '' },
      homeAds: { socialBar: '', popunder: '', nativeSrc: '', nativeContainer: '' },
    },
    categories: [
      { id: 'ios', name: 'IOS' },
      { id: 'android', name: 'ANDROID' },
      { id: 'pc', name: 'PC' },
    ],
    products: [],
  };
}
function loadStore() {
  try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { store = defaultStore(); saveStore(); }
  if (!store.site) store.site = defaultStore().site;
  if (!store.site.banner)   store.site.banner = { imageUrl: '', linkUrl: '' };
  if (!store.site.homeAds)  store.site.homeAds = { socialBar: '', popunder: '', nativeSrc: '', nativeContainer: '' };
  if (!Array.isArray(store.categories)) store.categories = [];
  if (!Array.isArray(store.products)) store.products = [];
}
function saveStore() { safeWrite(STORE_FILE, JSON.stringify(store, null, 2)); }

function keyFile(id) { return path.join(KEYS_DIR, id + '.txt'); }
function loadStocks() {
  stocks = {};
  try { fs.mkdirSync(KEYS_DIR, { recursive: true }); } catch {}
  for (const p of store.products) stocks[p.id] = readKeys(keyFile(p.id));
}
function readKeys(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); }
  catch { return []; }
}
function persistStock(id) { const a = stocks[id] || []; safeWrite(keyFile(id), a.join('\n') + (a.length ? '\n' : '')); }
function loadClaimed() { try { claimed = JSON.parse(fs.readFileSync(CLAIMED_FILE, 'utf8')) || {}; } catch { claimed = {}; } }
function persistClaimed() { safeWrite(CLAIMED_FILE, JSON.stringify(claimed)); }
function appendUsed(key, sid, slug) { try { fs.appendFileSync(USED_FILE, `${new Date().toISOString()}\t${slug}\t${sid}\t${key}\n`); } catch {} }
function safeWrite(f, d) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); } catch (e) { console.error('[write]', f, e.message); } }

// seed store on first run (e.g. fresh Volume)
if (!fs.existsSync(STORE_FILE)) { store = seedStore(); saveStore(); }
else loadStore();
loadStocks();
loadClaimed();
// make sure seeded products have key files
for (const p of store.products) if (!fs.existsSync(keyFile(p.id))) persistStock(p.id);

function seedStore() {
  const s = defaultStore();
  s.products = [{
    id: genId(), slug: 'proxy-uid', title: 'PROXY UID [Free Fire]',
    description: 'ตัวอย่างสินค้า — แก้ข้อความนี้ในหน้า /admin\nรองรับ Android',
    youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    category: 'android', checkpoints: 4, cooldown: 15,
    ads: { directLink: '', socialBar: '', popunder: '', nativeSrc: '', nativeContainer: '' },
    createdAt: Date.now(),
  }];
  return s;
}

let lock = Promise.resolve();
function withLock(fn) { const run = lock.then(fn, fn); lock = run.then(() => {}, () => {}); return run; }

// ---------------------------------------------------------------------------
// Tokens (HMAC-signed)
// ---------------------------------------------------------------------------
function sign(p) {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  const ttl = p.t === 'admin' ? ADMIN_TTL : TOKEN_TTL;
  if (!p.iat || (now() - p.iat) > ttl) return null;
  if (p.sat && (now() - p.sat) > SESSION_TTL) return null;
  return p;
}
function cookieOpts(ms) { return { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: ms, path: '/' }; }

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_ENABLED) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: String(token) });
    if (ip) form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const d = await r.json(); return Boolean(d && d.success);
  } catch (e) { console.error('[turnstile]', e.message); return false; }
}

// ---------------------------------------------------------------------------
// App + middleware
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '512kb' }));
app.use('/api/', rateLimit({ windowMs: 60000, limit: 80, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } }));
app.use('/api/', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const claimLimiter = rateLimit({ windowMs: 60000, limit: 15, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false });

// ad-block bait
app.get(['/ads.js', '/advertisement.js', '/adsbygoogle.js'], (_r, res) => res.type('application/javascript').send('window.__adProbe=true;'));
app.get('/health', (_r, res) => res.json({ status: 'ok', products: store.products.length }));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
app.get('/api/config', (_r, res) => res.json({ turnstile: { enabled: TURNSTILE_ENABLED, siteKey: TURNSTILE_SITE_KEY } }));
app.get('/api/site', (_r, res) => res.json({ site: store.site, categories: store.categories }));

app.get('/api/products', (req, res) => {
  const cat = req.query.category;
  const list = store.products
    .filter((p) => !cat || cat === 'all' || p.category === cat)
    .map((p) => publicProduct(p));
  res.json({ products: list, categories: store.categories, site: store.site });
});

app.get('/api/product/:slug', (req, res) => {
  const p = bySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json({
    product: publicProduct(p),
    checkpoints: clampInt(p.checkpoints, 4, 1, 12),
    cooldown: clampInt(p.cooldown, 15, 0, 600),
    ads: { socialBar: p.ads?.socialBar || '', popunder: p.ads?.popunder || '', nativeSrc: p.ads?.nativeSrc || '', nativeContainer: p.ads?.nativeContainer || '' },
  });
});

function publicProduct(p) {
  return { slug: p.slug, title: p.title, description: p.description || '', youtube: p.youtube || '',
    category: p.category || '', remaining: (stocks[p.id] || []).length };
}

// ---------------------------------------------------------------------------
// Get-Key flow (token carries the product slug)
// ---------------------------------------------------------------------------
app.post('/api/session/start', async (req, res) => {
  const slug = String(req.body?.slug || '');
  const p = bySlug(slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (req.body?.website) return res.status(400).json({ error: 'bot_detected' });
  if ((req.get('user-agent') || '').length < 10) return res.status(400).json({ error: 'bad_client' });
  if (!(await verifyTurnstile(req.body?.turnstileToken, req.ip))) return res.status(403).json({ error: 'turnstile_failed' });
  const sid = crypto.randomBytes(16).toString('hex');
  res.cookie('cp', sign({ t: 'progress', sid, slug, cp: 0, iat: now(), sat: now() }), cookieOpts(SESSION_TTL * 1000));
  res.json({ ok: true, current: 0, total: clampInt(p.checkpoints, 4, 1, 12) });
});

app.get('/api/progress', (req, res) => {
  const pr = verify(req.cookies.cp);
  if (!pr || pr.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  const p = bySlug(pr.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const c = claimed[pr.sid];
  res.json({ ok: true, slug: pr.slug, current: pr.cp, total: clampInt(p.checkpoints, 4, 1, 12),
    claimed: c ? { key: c.key } : null });
});

app.post('/api/checkpoint/start', (req, res) => {
  const pr = verify(req.cookies.cp);
  if (!pr || pr.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  const p = bySlug(pr.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const total = clampInt(p.checkpoints, 4, 1, 12);
  const next = pr.cp + 1;
  if (next > total) return res.status(400).json({ error: 'already_complete' });
  res.cookie('pend', sign({ t: 'pending', sid: pr.sid, slug: pr.slug, cp: next, iat: now(), n: crypto.randomBytes(6).toString('hex') }), cookieOpts(SESSION_TTL * 1000));
  res.json({ ok: true, checkpoint: next, total, cooldown: clampInt(p.cooldown, 15, 0, 600), adLink: p.ads?.directLink || '' });
});

app.post('/api/checkpoint/verify', (req, res) => {
  const pr = verify(req.cookies.cp), pend = verify(req.cookies.pend);
  if (!pr || pr.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  if (!pend || pend.t !== 'pending') return res.status(400).json({ error: 'no_pending' });
  if (pend.sid !== pr.sid || pend.slug !== pr.slug) return res.status(401).json({ error: 'mismatch' });
  if (pend.cp !== pr.cp + 1) return res.status(400).json({ error: 'out_of_order' });
  const p = bySlug(pr.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const cooldown = clampInt(p.cooldown, 15, 0, 600);
  const elapsed = now() - pend.iat;
  if (elapsed < cooldown) return res.status(429).json({ error: 'too_fast', wait: cooldown - elapsed });
  const total = clampInt(p.checkpoints, 4, 1, 12);
  res.clearCookie('pend', { path: '/' });
  res.cookie('cp', sign({ t: 'progress', sid: pr.sid, slug: pr.slug, cp: pend.cp, iat: now(), sat: pr.sat || now() }), cookieOpts(SESSION_TTL * 1000));
  res.json({ ok: true, current: pend.cp, total, done: pend.cp >= total });
});

app.post('/api/key/claim', claimLimiter, (req, res) => {
  const pr = verify(req.cookies.cp);
  if (!pr || pr.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  const p = bySlug(pr.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const total = clampInt(p.checkpoints, 4, 1, 12);
  if (pr.cp < total) return res.status(403).json({ error: 'not_complete' });

  withLock(() => {
    if (res.headersSent) return;
    res.clearCookie('cp', { path: '/' });        // one-time: session consumed after claim
    res.clearCookie('pend', { path: '/' });
    const prev = claimed[pr.sid];
    if (prev) return res.json({ ok: true, key: prev.key, cached: true });
    const st = stocks[p.id] || [];
    if (st.length === 0) return res.status(409).json({ error: 'out_of_stock' });
    const key = st.shift();
    claimed[pr.sid] = { slug: pr.slug, key };
    persistStock(p.id); persistClaimed(); appendUsed(key, pr.sid, pr.slug);
    res.json({ ok: true, key });
  }).catch((e) => { console.error('[claim]', e); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); });
});

// ---------------------------------------------------------------------------
// Admin auth + CMS
// ---------------------------------------------------------------------------
app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!ADMIN_PASS) return res.status(403).json({ error: 'admin_disabled' });
  const u = String(req.body?.user || ''), pw = String(req.body?.pass || '');
  const okU = safeEqual(u, ADMIN_USER), okP = safeEqual(pw, ADMIN_PASS);
  if (!okU || !okP) return res.status(401).json({ error: 'bad_credentials' });
  res.cookie('adm', sign({ t: 'admin', u: ADMIN_USER, iat: now() }), cookieOpts(ADMIN_TTL * 1000));
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_r, res) => { res.clearCookie('adm', { path: '/' }); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => { const a = verify(req.cookies.adm); if (!a || a.t !== 'admin') return res.status(401).json({ error: 'unauthorized' }); res.json({ ok: true, user: a.u }); });

function requireAdmin(req, res, next) { const a = verify(req.cookies.adm); if (!a || a.t !== 'admin') return res.status(401).json({ error: 'unauthorized' }); next(); }

app.get('/api/admin/store', requireAdmin, (_r, res) => {
  res.json({ store, keys: Object.fromEntries(store.products.map((p) => [p.id, (stocks[p.id] || []).length])) });
});

app.put('/api/admin/store', requireAdmin, (req, res) => {
  const incoming = req.body?.store;
  const err = validateStore(incoming);
  if (err) return res.status(400).json({ error: 'invalid', detail: err });
  return withLock(() => {
    // assign ids to new products, ensure key files
    for (const p of incoming.products) { if (!p.id) p.id = genId(); if (!p.createdAt) p.createdAt = Date.now(); }
    store = incoming; saveStore(); loadStocks();
    for (const p of store.products) if (!fs.existsSync(keyFile(p.id))) persistStock(p.id);
    res.json({ ok: true });
  });
});

app.get('/api/admin/keys/:id', requireAdmin, (req, res) => {
  if (!byId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, keys: (stocks[req.params.id] || []).join('\n'), count: (stocks[req.params.id] || []).length });
});
app.put('/api/admin/keys/:id', requireAdmin, (req, res) => {
  const p = byId(req.params.id); if (!p) return res.status(404).json({ error: 'not_found' });
  return withLock(() => {
    const arr = String(req.body?.keys || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    stocks[p.id] = arr; persistStock(p.id);
    res.json({ ok: true, count: arr.length });
  });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const pub = path.join(__dirname, 'public');
app.get('/', (_r, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/login', (_r, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/admin', (_r, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub));
// product slug pages (anything else that isn't /api and isn't a real file)
app.get(/^\/(?!api\/).+/, (req, res) => {
  const seg = req.path.split('/').filter(Boolean);
  if (seg.length === 1 && !RESERVED.has(seg[0])) return res.sendFile(path.join(pub, 'product.html'));
  res.status(404).sendFile(path.join(pub, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CHECKEN5STAR on :${PORT}  products=${store.products.length}  turnstile=${TURNSTILE_ENABLED}  adminLogin=${Boolean(ADMIN_PASS)}`);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function now() { return Math.floor(Date.now() / 1000); }
function genId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }
function bySlug(s) { return store.products.find((p) => p.slug === s); }
function byId(id) { return store.products.find((p) => p.id === id); }
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function clampInt(v, def, min, max) { const n = parseInt(v, 10); if (Number.isNaN(n)) return def; return Math.min(max, Math.max(min, n)); }
function validateStore(s) {
  if (!s || typeof s !== 'object') return 'store missing';
  if (!s.site || typeof s.site.name !== 'string') return 'site.name required';
  if (!Array.isArray(s.categories)) return 'categories must be array';
  if (!Array.isArray(s.products)) return 'products must be array';
  const catIds = new Set(s.categories.map((c) => c.id));
  const slugs = new Set();
  for (const p of s.products) {
    if (!p.slug || !/^[a-z0-9-]+$/.test(p.slug)) return `slug ต้องเป็น a-z 0-9 - เท่านั้น: "${p.slug}"`;
    if (RESERVED.has(p.slug)) return `slug ห้ามใช้คำสงวน: "${p.slug}"`;
    if (slugs.has(p.slug)) return `slug ซ้ำ: "${p.slug}"`;
    slugs.add(p.slug);
    if (!p.title) return 'title required';
    if (p.category && !catIds.has(p.category)) return `category ไม่ถูกต้อง: "${p.category}"`;
  }
  return null;
}