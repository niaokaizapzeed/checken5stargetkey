/* Checkpoint Key System — client logic (URL-based checkpoints)
 * Routes:  /              -> start session, then redirect to /checkpoint1
 *          /checkpointN   -> checkpoint N (full page load = ads reload each step)
 *          /unlock        -> choose program + reveal key
 * Skipping is impossible: progress lives in a signed server cookie, and landing
 * on the wrong /checkpointN just redirects you to your real one.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const RING_C = 2 * Math.PI * 52;
  const state = { current: 0, total: 4, cooldown: 15, busy: false, started: false };

  // ---- API helpers --------------------------------------------------------
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {}; try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }
  async function getJSON(path) {
    try { const r = await fetch(path, { credentials: 'same-origin' }); return { ok: r.ok, status: r.status, data: await r.json() }; }
    catch { return { ok: false, status: 0, data: {} }; }
  }

  // ---- routing ------------------------------------------------------------
  function getRoute() {
    const p = (location.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    const m = p.match(/^\/checkpoint(\d+)$/);
    if (m) return { type: 'checkpoint', n: parseInt(m[1], 10) };
    if (p === '/unlock') return { type: 'unlock' };
    return { type: 'start' };
  }

  // ---- ad-block detection -------------------------------------------------
  async function isAdBlockActive() {
    let blocked = false;
    const bait = document.createElement('div');
    bait.className = 'ad ads adsbox ad-banner adsbygoogle banner_ad sponsor';
    bait.style.cssText = 'position:absolute!important;left:-9999px;top:-9999px;height:12px;width:12px;pointer-events:none;';
    document.body.appendChild(bait);
    await new Promise((r) => setTimeout(r, 120));
    const cs = getComputedStyle(bait);
    if (bait.offsetHeight === 0 || bait.offsetParent === null || cs.display === 'none' || cs.visibility === 'hidden') blocked = true;
    bait.remove();
    if (typeof window.__adProbe === 'undefined') blocked = true;
    try { await fetch('/advertisement.js?_=' + Date.now(), { cache: 'no-store' }); } catch { blocked = true; }
    return blocked;
  }

  // ---- small ui helpers ---------------------------------------------------
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function buildTumblers() {
    const wrap = $('tumblers'); wrap.innerHTML = '';
    for (let i = 1; i <= state.total; i++) {
      const t = document.createElement('div'); t.className = 'tumbler'; t.dataset.i = i; wrap.appendChild(t);
    }
    document.querySelectorAll('.tumbler').forEach((t) => {
      const i = Number(t.dataset.i);
      t.classList.toggle('done', i <= state.current);
      t.classList.toggle('active', i === state.current + 1);
    });
  }
  function showError(msg) { const e = $('cp-error'); e.textContent = msg; show('cp-error'); }
  function showPickerError(msg) { const e = $('picker-error'); e.textContent = msg; show('picker-error'); }
  async function refreshStock() {
    const r = await getJSON('/api/stock');
    if (r.ok && typeof r.data.remaining === 'number') $('stock-n').textContent = r.data.remaining;
  }
  function showBlocked(title, msg) {
    hide('gate'); show('blocked');
    if (title) $('blocked').querySelector('h1').textContent = title;
    if (msg) $('blocked').querySelector('p').textContent = msg;
  }

  // ---- countdown ring -----------------------------------------------------
  function runCountdown(seconds, onDone) {
    const fg = $('ring-fg'), num = $('ring-num');
    fg.style.transition = 'none';
    fg.style.strokeDasharray = RING_C; fg.style.strokeDashoffset = RING_C;
    void fg.getBoundingClientRect();
    fg.style.transition = `stroke-dashoffset ${seconds}s linear`;
    fg.style.strokeDashoffset = '0';
    let left = seconds; num.textContent = left; $('verify').disabled = true;
    const iv = setInterval(() => { left -= 1; num.textContent = Math.max(0, left); if (left <= 0) { clearInterval(iv); onDone(); } }, 1000);
  }
  function enableVerify() { $('ring-num').textContent = '✓'; $('verify').disabled = false; }

  // ---- checkpoint page ----------------------------------------------------
  function renderCheckpoint(n, total) {
    state.total = total; state.current = n - 1;
    hide('gate'); hide('blocked'); show('app');
    buildTumblers();
    hide('picker-card'); hide('key-card'); show('cp-card');

    $('cp-num').textContent = n;
    $('cp-total').textContent = total;
    document.querySelectorAll('.cp-inline').forEach((el) => (el.textContent = n));
    $('cp-title').textContent = n === 1 ? 'เริ่มด่านแรก' : `ด่านที่ ${n}`;
    hide('verify-wrap'); hide('cp-error');
    const go = $('go'); go.disabled = false; show('go');
    go.onclick = () => startCheckpoint(n, total);
    $('verify').onclick = () => verifyCheckpoint(n, total);
    refreshStock();
  }

  async function startCheckpoint(n, total) {
    if (state.busy) return; state.busy = true; $('go').disabled = true;
    const { ok, data } = await api('/api/checkpoint/start');
    if (!ok) { state.busy = false; $('go').disabled = false; showError(errText(data.error)); return; }
    state.cooldown = data.cooldown != null ? data.cooldown : 15;
    if (data.adLink) window.open(data.adLink, '_blank', 'noopener');
    hide('go'); show('verify-wrap'); hide('cp-error'); state.busy = false;
    if (state.cooldown <= 0) enableVerify(); else runCountdown(state.cooldown, enableVerify);
  }

  async function verifyCheckpoint(n, total) {
    if (state.busy) return; state.busy = true; $('verify').disabled = true;
    const { ok, data } = await api('/api/checkpoint/verify');
    state.busy = false;
    if (!ok) {
      if (data.error === 'too_fast') { showError(`เร็วเกินไป กรุณารออีก ${data.wait} วินาที`); runCountdown(data.wait || 3, enableVerify); return; }
      showError(errText(data.error)); $('verify').disabled = false; return;
    }
    // Full navigation so the next page reloads Adsterra scripts (ads every checkpoint).
    if (data.done) location.href = '/unlock';
    else location.href = '/checkpoint' + (data.current + 1);
  }

  // ---- unlock page (program picker + key) ---------------------------------
  function showUnlockPage(progress) {
    state.total = progress.total; state.current = progress.total;
    hide('gate'); hide('blocked'); show('app');
    buildTumblers();
    hide('cp-card');
    if (progress.claimed && progress.claimed.key) { showKey(progress.claimed); return; }
    showPicker();
  }

  async function showPicker() {
    hide('picker-error'); hide('key-card');
    const list = $('program-list'); list.innerHTML = '<p class="muted">กำลังโหลดรายการ…</p>';
    show('picker-card');
    const r = await getJSON('/api/programs');
    const programs = (r.data && r.data.programs) || [];
    list.innerHTML = '';
    if (programs.length === 0) { list.innerHTML = '<p class="muted">ยังไม่มีโปรแกรมให้เลือก</p>'; return; }
    const anyStock = programs.some((p) => p.remaining > 0);
    programs.forEach((p) => {
      const out = !(p.remaining > 0);
      const btn = document.createElement('button');
      btn.className = 'program-btn' + (out ? ' out' : ''); btn.type = 'button'; btn.disabled = out;
      btn.innerHTML =
        `<span class="p-name">${esc(p.name)}</span>` +
        (p.desc ? `<span class="p-desc">${esc(p.desc)}</span>` : '') +
        `<span class="p-meta">${out ? 'หมดสต็อก' : 'คงเหลือ ' + p.remaining}</span>`;
      if (!out) btn.addEventListener('click', () => claimKey(p.id, btn));
      list.appendChild(btn);
    });
    if (!anyStock) showPickerError('ตอนนี้คีย์หมดทุกโปรแกรม กรุณากลับมาใหม่ภายหลัง');
  }

  async function claimKey(programId, btn) {
    if (state.busy) return; state.busy = true; if (btn) btn.disabled = true; hide('picker-error');
    const { ok, data } = await api('/api/key/claim', { program: programId });
    state.busy = false;
    if (ok && data.key) { showKey(data); }
    else if (data.error === 'out_of_stock') { showPickerError('โปรแกรมนี้คีย์เพิ่งหมด กรุณาเลือกตัวอื่น'); showPicker(); }
    else if (data.error === 'invalid_program') { showPickerError('ไม่พบโปรแกรมนี้ กรุณารีเฟรช'); }
    else { showPickerError(errText(data.error)); if (btn) btn.disabled = false; }
  }

  function showKey(obj) {
    hide('picker-card');
    $('key-value').textContent = obj.key;
    $('key-program').textContent = obj.programName || '—';
    refreshStock();
    show('key-card');
    $('copy').onclick = copyKey;
  }

  function copyKey() {
    const val = $('key-value').textContent;
    const done = () => { show('copied'); setTimeout(() => hide('copied'), 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(done).catch(fallback);
    else fallback();
    function fallback() { const ta = document.createElement('textarea'); ta.value = val; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch {} ta.remove(); }
  }

  function errText(code) {
    const map = {
      no_session: 'เซสชันหมดอายุ กรุณารีเฟรชหน้า',
      already_complete: 'คุณทำครบทุกด่านแล้ว',
      no_pending: 'ยังไม่ได้เริ่มด่านนี้ กรุณากดปุ่มไปยัง Checkpoint',
      out_of_order: 'ลำดับด่านไม่ถูกต้อง กรุณารีเฟรช',
      session_mismatch: 'เซสชันไม่ตรงกัน กรุณารีเฟรช',
      too_many_requests: 'ทำรายการถี่เกินไป กรุณารอสักครู่',
      bot_detected: 'ตรวจพบพฤติกรรมผิดปกติ',
      bad_client: 'ไคลเอนต์ไม่ถูกต้อง',
      turnstile_failed: 'ยืนยันตัวตนไม่ผ่าน กรุณารีเฟรชหน้าแล้วลองใหม่',
      not_complete: 'ยังทำ checkpoint ไม่ครบ',
      server_error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่',
    };
    return map[code] || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  }

  // ---- session start (with optional Turnstile) ----------------------------
  async function startFlow() {
    let cfg = { turnstile: { enabled: false } };
    const c = await getJSON('/api/config'); if (c.ok) cfg = c.data;
    if (cfg.turnstile && cfg.turnstile.enabled && cfg.turnstile.siteKey) renderTurnstileThenStart(cfg.turnstile.siteKey);
    else doSessionStart(null);
  }
  function renderTurnstileThenStart(siteKey) {
    const box = $('turnstile-box');
    $('gate-spinner').classList.add('hidden');
    $('gate-text').textContent = 'ยืนยันว่าคุณไม่ใช่บอท';
    box.classList.remove('hidden');
    loadTurnstileScript(() => {
      if (!window.turnstile) { doSessionStart(null); return; }
      try {
        window.turnstile.render(box, {
          sitekey: siteKey,
          callback: (token) => doSessionStart(token),
          'error-callback': () => { $('gate-text').textContent = 'ยืนยันไม่สำเร็จ กรุณารีเฟรชหน้า'; },
        });
      } catch { doSessionStart(null); }
    });
  }
  function loadTurnstileScript(cb) {
    if (window.turnstile) return cb();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true; s.onload = cb; s.onerror = () => cb();
    document.head.appendChild(s);
  }
  async function doSessionStart(token) {
    if (state.started) return; state.started = true;
    const hp = $('hp-website');
    const body = { website: hp ? hp.value : '' };
    if (token) body.turnstileToken = token;
    const { ok, data } = await api('/api/session/start', body);
    if (!ok) { state.started = false; showBlocked('ไม่สามารถเริ่มเซสชันได้', errText(data.error)); return; }
    location.replace('/checkpoint1');
  }

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    const route = getRoute();

    const blocked = await isAdBlockActive();
    if (blocked) { hide('gate'); show('blocked'); return; }

    const pr = await getJSON('/api/progress');
    const hasSession = pr.ok && pr.data && typeof pr.data.current === 'number';

    if (!hasSession) { startFlow(); return; }   // any deep link with no session -> start

    const progress = pr.data;
    const cur = progress.current, total = progress.total;

    if (cur >= total) {
      if (route.type !== 'unlock') { location.replace('/unlock'); return; }
      showUnlockPage(progress);
      return;
    }

    const shouldBe = cur + 1;
    if (route.type === 'checkpoint' && route.n === shouldBe) renderCheckpoint(shouldBe, total);
    else location.replace('/checkpoint' + shouldBe);   // wrong/skip -> real checkpoint
  }

  $('retry').addEventListener('click', () => location.reload());
  window.addEventListener('DOMContentLoaded', boot);
})();
