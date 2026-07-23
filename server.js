/* ============================================================================
 * Checkpoint Key System  —  server.js
 * ----------------------------------------------------------------------------
 * Flow:
 *   1) Client loads /  -> ad-block detection runs client side (blocked = no access)
 *   2) POST /api/session/start        -> issues a signed "progress" token (cp = 0)
 *   3) POST /api/checkpoint/start     -> issues a signed "pending" token + ad link
 *   4) (user views Adsterra ad, waits the cooldown)
 *   5) POST /api/checkpoint/verify    -> checks elapsed time, advances progress
 *   6) repeat until cp == TOTAL_CHECKPOINTS
 *   7) POST /api/key/claim            -> dispenses ONE key from keys.txt (idempotent)
 *
 * Security:
 *   - All state lives in HMAC-signed tokens (stateless, unforgeable).
 *   - Checkpoints are strictly sequential (cp N+1 requires a valid cp N token).
 *   - A minimum cooldown per checkpoint blocks instant skipping / scripting.
 *   - Rate limiting + honeypot + basic UA checks block bot floods.
 *   - Key claim is idempotent per session, so refresh/replay can't drain stock.
 * ==========================================================================*/

require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const cookieParser= require('cookie-parser');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');

// ---------------------------------------------------------------------------
// Config (override any of these via environment variables on Railway)
// ---------------------------------------------------------------------------
const PORT               = process.env.PORT || 3000;
const SECRET             = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');
const TOTAL_CHECKPOINTS  = clampInt(process.env.TOTAL_CHECKPOINTS, 4, 1, 12);
const CHECKPOINT_COOLDOWN= clampInt(process.env.CHECKPOINT_COOLDOWN, 15, 0, 600);   // seconds on the ad
const TOKEN_TTL          = clampInt(process.env.TOKEN_TTL, 3600, 60, 86400);        // token lifetime (s)
const ADMIN_TOKEN        = process.env.ADMIN_TOKEN || '';                           // for /api/admin/reload
const IS_PROD            = process.env.NODE_ENV === 'production';

// Cloudflare Turnstile (free CAPTCHA). Leave both blank to disable — the flow
// then works exactly as before. Set both to require a human check at the gate.
const TURNSTILE_SITE_KEY   = process.env.TURNSTILE_SITE_KEY   || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_ENABLED    = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

// Adsterra Direct Link (Smartlink) opened by the checkpoint buttons.
// Override anytime via ADSTERRA_LINKS (comma-separated = one link per checkpoint, cycled).
const DEFAULT_DIRECT_LINK = 'https://www.effectivecpmnetwork.com/cvw0xnrf?key=9845f7ac3d7228bfed6058a593bf1cbc';
const ADSTERRA_LINKS = (process.env.ADSTERRA_LINKS || process.env.ADSTERRA_DIRECT_LINK || DEFAULT_DIRECT_LINK)
  .split(',').map(s => s.trim()).filter(Boolean);

// Data location. Point DATA_DIR to a Railway Volume for persistence across deploys.
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const KEYS_DIR      = path.join(DATA_DIR, 'keys');          // one <programId>.txt per program
const PROGRAMS_FILE = path.join(DATA_DIR, 'programs.json'); // program list + display names
const USED_FILE     = path.join(DATA_DIR, 'used_keys.txt');
const CLAIMED_FILE  = path.join(DATA_DIR, 'claimed.json');

if (!process.env.SECRET_KEY) {
  console.warn('[WARN] SECRET_KEY is not set — using a random secret. All sessions/keys reset on restart. Set SECRET_KEY in Railway!');
}

// If DATA_DIR is a volume and is empty, seed it from the repo's keys/ + programs.json.
try {
  if (DATA_DIR !== __dirname) {
    if (!fs.existsSync(KEYS_DIR)) {
      fs.mkdirSync(KEYS_DIR, { recursive: true });
      const seedDir = path.join(__dirname, 'keys');
      if (fs.existsSync(seedDir)) {
        for (const f of fs.readdirSync(seedDir)) fs.copyFileSync(path.join(seedDir, f), path.join(KEYS_DIR, f));
      }
    }
    const seedPrograms = path.join(__dirname, 'programs.json');
    if (!fs.existsSync(PROGRAMS_FILE) && fs.existsSync(seedPrograms)) {
      fs.copyFileSync(seedPrograms, PROGRAMS_FILE);
    }
  }
} catch (e) { console.error('[seed] failed:', e.message); }

// ---------------------------------------------------------------------------
// Multi-program key stock (each program has its own key file + stock)
// ---------------------------------------------------------------------------
let programs = [];   // [{ id, name, desc }]
let stocks   = {};   // id -> [keys...]
let claimed  = {};   // sid -> { program, key }   (idempotent claims)

function readKeyFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
  } catch { return []; }
}

function loadPrograms() {
  // Prefer programs.json (controls names + order); otherwise auto-discover keys/*.txt
  let defined = null;
  try { defined = JSON.parse(fs.readFileSync(PROGRAMS_FILE, 'utf8')); } catch { defined = null; }

  if (Array.isArray(defined) && defined.length) {
    programs = defined
      .filter(p => p && p.id)
      .map(p => ({ id: String(p.id), name: p.name || prettify(p.id), desc: p.desc || '' }));
  } else {
    let files = [];
    try { files = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.txt')); } catch { files = []; }
    programs = files.map(f => { const id = f.replace(/\.txt$/, ''); return { id, name: prettify(id), desc: '' }; });
  }

  stocks = {};
  for (const p of programs) stocks[p.id] = readKeyFile(path.join(KEYS_DIR, p.id + '.txt'));
}

function loadClaimed() {
  try { claimed = JSON.parse(fs.readFileSync(CLAIMED_FILE, 'utf8')) || {}; }
  catch { claimed = {}; }
}
function persistStock(id) {
  const arr = stocks[id] || [];
  safeWrite(path.join(KEYS_DIR, id + '.txt'), arr.join('\n') + (arr.length ? '\n' : ''));
}
function persistClaimed() { safeWrite(CLAIMED_FILE, JSON.stringify(claimed)); }
function appendUsed(key, sid, programId) {
  try { fs.appendFileSync(USED_FILE, `${new Date().toISOString()}\t${programId}\t${sid}\t${key}\n`); }
  catch (e) { console.error('[used] append failed:', e.message); }
}
function safeWrite(file, data) {
  try { fs.writeFileSync(file, data); }
  catch (e) { console.error('[persist] write failed for', file, '-', e.message); }
}
function programById(id) { return programs.find(p => p.id === id); }
function totalStock()    { return programs.reduce((n, p) => n + (stocks[p.id] || []).length, 0); }
function prettify(id) {
  return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

loadPrograms();
loadClaimed();

// Simple async mutex so concurrent claims never hand out the same key.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run;
}

// ---------------------------------------------------------------------------
// Token helpers  (compact HMAC-signed tokens, JWT-like but minimal)
// ---------------------------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { return null; }
  if (!payload.iat || (now() - payload.iat) > TOKEN_TTL) return null;   // expired
  return payload;
}

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: maxAgeMs, path: '/' };
}

// ---------------------------------------------------------------------------
// App + middleware
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);                    // Railway sits behind a proxy
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,               // Adsterra injects scripts; CSP would break ads
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '16kb' }));

// Global API rate limit (per IP). Tune to taste.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000, limit: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
}));
const claimLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

// Never let API responses (tokens, keys) be cached by browsers/proxies/CDNs.
app.use('/api/', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Verify a Cloudflare Turnstile token server-side (returns true if disabled).
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_ENABLED) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: String(token) });
    if (ip) form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = await r.json();
    return Boolean(data && data.success);
  } catch (e) {
    console.error('[turnstile] verify error:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ad-block bait  — these paths are commonly blocked by ad blockers.
// If the client can't load /ads.js the global flag never gets set => detected.
// ---------------------------------------------------------------------------
app.get(['/ads.js', '/advertisement.js', '/adsbygoogle.js'], (_req, res) => {
  res.type('application/javascript').send('window.__adProbe = true;');
});

// Health check for Railway
app.get('/health', (_req, res) => res.json({ status: 'ok', programs: programs.length, stock: totalStock() }));

// Public stock counter — total across all programs (used by the UI header)
app.get('/api/stock', (_req, res) => res.json({ remaining: totalStock() }));

// Public runtime config for the client (e.g. Turnstile site key — safe to expose)
app.get('/api/config', (_req, res) => {
  res.json({ turnstile: { enabled: TURNSTILE_ENABLED, siteKey: TURNSTILE_SITE_KEY } });
});

// Current progress for this session (used by URL-based checkpoint pages)
app.get('/api/progress', (req, res) => {
  const prog = verify(req.cookies.cp_progress);
  if (!prog || prog.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  const c = claimed[prog.sid];
  res.json({
    ok: true,
    current: prog.cp,
    total: TOTAL_CHECKPOINTS,
    claimed: c ? { program: c.program, programName: (programById(c.program) || {}).name || c.program, key: c.key } : null,
  });
});

// Public program list + per-program remaining count (used by the picker)
app.get('/api/programs', (_req, res) => {
  res.json({
    programs: programs.map(p => ({
      id: p.id, name: p.name, desc: p.desc, remaining: (stocks[p.id] || []).length,
    })),
  });
});

// ---------------------------------------------------------------------------
// 1) Start a session
// ---------------------------------------------------------------------------
app.post('/api/session/start', async (req, res) => {
  // Honeypot: a hidden field bots tend to fill in.
  if (req.body && typeof req.body.website === 'string' && req.body.website.length > 0) {
    return res.status(400).json({ error: 'bot_detected' });
  }
  // Basic client sanity check.
  const ua = req.get('user-agent') || '';
  if (ua.length < 10) return res.status(400).json({ error: 'bad_client' });

  // Cloudflare Turnstile human check (skipped automatically if not configured).
  const ok = await verifyTurnstile(req.body && req.body.turnstileToken, req.ip);
  if (!ok) return res.status(403).json({ error: 'turnstile_failed' });

  const sid   = crypto.randomBytes(16).toString('hex');
  const token = sign({ t: 'progress', sid, cp: 0, iat: now() });
  res.cookie('cp_progress', token, cookieOpts(TOKEN_TTL * 1000));
  res.json({ ok: true, current: 0, total: TOTAL_CHECKPOINTS });
});

// ---------------------------------------------------------------------------
// 2) Start a checkpoint  -> returns the ad link + cooldown, issues pending token
// ---------------------------------------------------------------------------
app.post('/api/checkpoint/start', (req, res) => {
  const prog = verify(req.cookies.cp_progress);
  if (!prog || prog.t !== 'progress') return res.status(401).json({ error: 'no_session' });

  const next = prog.cp + 1;
  if (next > TOTAL_CHECKPOINTS) return res.status(400).json({ error: 'already_complete' });

  const pending = sign({ t: 'pending', sid: prog.sid, cp: next, iat: now(), n: crypto.randomBytes(6).toString('hex') });
  res.cookie('cp_pending', pending, cookieOpts(TOKEN_TTL * 1000));

  res.json({
    ok: true,
    checkpoint: next,
    total: TOTAL_CHECKPOINTS,
    cooldown: CHECKPOINT_COOLDOWN,
    adLink: pickAdLink(next),
  });
});

// ---------------------------------------------------------------------------
// 3) Verify a checkpoint  -> enforces cooldown, advances progress
// ---------------------------------------------------------------------------
app.post('/api/checkpoint/verify', (req, res) => {
  const prog = verify(req.cookies.cp_progress);
  const pend = verify(req.cookies.cp_pending);
  if (!prog || prog.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  if (!pend || pend.t !== 'pending')  return res.status(400).json({ error: 'no_pending' });
  if (pend.sid !== prog.sid)          return res.status(401).json({ error: 'session_mismatch' });
  if (pend.cp !== prog.cp + 1)        return res.status(400).json({ error: 'out_of_order' });

  const elapsed = now() - pend.iat;
  if (elapsed < CHECKPOINT_COOLDOWN) {
    return res.status(429).json({ error: 'too_fast', wait: CHECKPOINT_COOLDOWN - elapsed });
  }

  const advanced = sign({ t: 'progress', sid: prog.sid, cp: pend.cp, iat: now() });
  res.clearCookie('cp_pending', { path: '/' });
  res.cookie('cp_progress', advanced, cookieOpts(TOKEN_TTL * 1000));
  res.json({ ok: true, current: pend.cp, total: TOTAL_CHECKPOINTS, done: pend.cp >= TOTAL_CHECKPOINTS });
});

// ---------------------------------------------------------------------------
// 4) Claim the key  -> dispenses from the CHOSEN program's stock; idempotent per session
//    Body: { program: "<programId>" }
// ---------------------------------------------------------------------------
app.post('/api/key/claim', claimLimiter, (req, res) => {
  const prog = verify(req.cookies.cp_progress);
  if (!prog || prog.t !== 'progress') return res.status(401).json({ error: 'no_session' });
  if (prog.cp < TOTAL_CHECKPOINTS) {
    return res.status(403).json({ error: 'not_complete', current: prog.cp, total: TOTAL_CHECKPOINTS });
  }

  const programId = String((req.body && req.body.program) || '');

  withLock(() => {
    if (res.headersSent) return;

    // Already claimed this session -> always return the same key (no double dispense).
    const prev = claimed[prog.sid];
    if (prev) {
      const p = programById(prev.program);
      return res.json({ ok: true, program: prev.program, programName: p ? p.name : prev.program, key: prev.key, cached: true });
    }

    const p = programById(programId);
    if (!p) return res.status(400).json({ error: 'invalid_program' });

    const st = stocks[programId] || [];
    if (st.length === 0) return res.status(409).json({ error: 'out_of_stock' });

    const key = st.shift();
    claimed[prog.sid] = { program: programId, key };
    persistStock(programId);
    persistClaimed();
    appendUsed(key, prog.sid, programId);
    res.json({ ok: true, program: programId, programName: p.name, key, remaining: st.length });
  }).catch(err => {
    console.error('[claim] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });
});

// ---------------------------------------------------------------------------
// Admin: reload programs + stock from disk after editing files (header: x-admin-token)
// ---------------------------------------------------------------------------
app.post('/api/admin/reload', (req, res) => {
  if (!ADMIN_TOKEN || (req.get('x-admin-token') || '') !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return withLock(() => {
    loadPrograms();
    res.json({ ok: true, programs: programs.length, remaining: totalStock() });
  });
});

// ---------------------------------------------------------------------------
// Static site (served last so API routes win)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Fallback: any other GET path (e.g. /checkpoint1, /checkpoint4) serves the app.
// This does NOT let anyone skip — progress lives in a signed server cookie, so a
// typed URL just lands the user on the page at their real checkpoint.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Checkpoint Key System running on :${PORT}`);
  console.log(`  checkpoints=${TOTAL_CHECKPOINTS}  cooldown=${CHECKPOINT_COOLDOWN}s  programs=${programs.length}  stock=${totalStock()}  adLinks=${ADSTERRA_LINKS.length}  turnstile=${TURNSTILE_ENABLED}`);
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function now() { return Math.floor(Date.now() / 1000); }
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function pickAdLink(checkpointNumber) {
  if (ADSTERRA_LINKS.length === 0) return '';
  return ADSTERRA_LINKS[(checkpointNumber - 1) % ADSTERRA_LINKS.length];
}
