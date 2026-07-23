/* Checkpoint Key System — client logic */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const RING_C = 2 * Math.PI * 52; // ~326.7

  const state = { current: 0, total: 4, cooldown: 15, busy: false, started: false };

  // ---- tiny API helper ----------------------------------------------------
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, data };
  }

  // ---- ad-block detection -------------------------------------------------
  async function isAdBlockActive() {
    let blocked = false;

    // (a) bait element with commonly blocked class names
    const bait = document.createElement('div');
    bait.className = 'ad ads adsbox ad-banner adsbygoogle banner_ad sponsor';
    bait.style.cssText = 'position:absolute!important;left:-9999px;top:-9999px;height:12px;width:12px;pointer-events:none;';
    document.body.appendChild(bait);
    await new Promise((r) => setTimeout(r, 120));
    const cs = getComputedStyle(bait);
    if (bait.offsetHeight === 0 || bait.offsetParent === null || cs.display === 'none' || cs.visibility === 'hidden') {
      blocked = true;
    }
    bait.remove();

    // (b) probe script flag (set by /ads.js — blockers eat this request)
    if (typeof window.__adProbe === 'undefined') blocked = true;

    // (c) fetch a bait path; a network/blocker error also counts
    try {
      await fetch('/advertisement.js?_=' + Date.now(), { cache: 'no-store' });
    } catch {
      blocked = true;
    }

    return blocked;
  }

  // ---- UI helpers ---------------------------------------------------------
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  function buildTumblers() {
    const wrap = $('tumblers');
    wrap.innerHTML = '';
    for (let i = 1; i <= state.total; i++) {
      const t = document.createElement('div');
      t.className = 'tumbler';
      t.dataset.i = i;
      wrap.appendChild(t);
    }
    updateTumblers();
  }

  function updateTumblers() {
    document.querySelectorAll('.tumbler').forEach((t) => {
      const i = Number(t.dataset.i);
      t.classList.toggle('done', i <= state.current);
      t.classList.toggle('active', i === state.current + 1);
    });
  }

  function setCheckpointCard() {
    const next = state.current + 1;
    $('cp-num').textContent = next;
    $('cp-total').textContent = state.total;
    document.querySelectorAll('.cp-inline').forEach((el) => (el.textContent = next));
    $('cp-title').textContent = next === 1 ? 'เริ่มด่านแรก' : `ด่านที่ ${next}`;
    hide('verify-wrap');
    hide('cp-error');
    const go = $('go');
    go.disabled = false;
    show('go');
  }

  function showError(msg) {
    const e = $('cp-error');
    e.textContent = msg;
    show('cp-error');
  }

  // ---- countdown ring -----------------------------------------------------
  function runCountdown(seconds, onDone) {
    const fg = $('ring-fg');
    const num = $('ring-num');
    fg.style.transition = 'none';
    fg.style.strokeDasharray = RING_C;
    fg.style.strokeDashoffset = RING_C;
    void fg.getBoundingClientRect(); // reflow
    fg.style.transition = `stroke-dashoffset ${seconds}s linear`;
    fg.style.strokeDashoffset = '0';

    let left = seconds;
    num.textContent = left;
    $('verify').disabled = true;

    const iv = setInterval(() => {
      left -= 1;
      num.textContent = Math.max(0, left);
      if (left <= 0) {
        clearInterval(iv);
        onDone();
      }
    }, 1000);
  }

  function enableVerify() {
    $('ring-num').textContent = '✓';
    $('verify').disabled = false;
  }

  // ---- flow ---------------------------------------------------------------
  async function startCheckpoint() {
    if (state.busy) return;
    state.busy = true;
    $('go').disabled = true;

    const { ok, data } = await api('/api/checkpoint/start');
    if (!ok) {
      state.busy = false;
      $('go').disabled = false;
      showError(errText(data.error));
      return;
    }

    state.cooldown = data.cooldown ?? state.cooldown;

    // open the Adsterra ad in a new tab (if a link is configured)
    if (data.adLink) {
      window.open(data.adLink, '_blank', 'noopener');
    }

    hide('go');
    show('verify-wrap');
    hide('cp-error');
    state.busy = false;

    if (state.cooldown <= 0) enableVerify();
    else runCountdown(state.cooldown, enableVerify);
  }

  async function verifyCheckpoint() {
    if (state.busy) return;
    state.busy = true;
    $('verify').disabled = true;

    const { ok, data } = await api('/api/checkpoint/verify');
    state.busy = false;

    if (!ok) {
      if (data.error === 'too_fast') {
        showError(`เร็วเกินไป กรุณารออีก ${data.wait} วินาที`);
        runCountdown(data.wait || 3, enableVerify);
        return;
      }
      showError(errText(data.error));
      $('verify').disabled = false;
      return;
    }

    state.current = data.current;
    updateTumblers();

    if (data.done) {
      await showPicker();
    } else {
      setCheckpointCard();
    }
  }

  async function showPicker() {
    hide('cp-card');
    hide('picker-error');
    const list = $('program-list');
    list.innerHTML = '<p class="muted">กำลังโหลดรายการ…</p>';
    show('picker-card');

    let data = {};
    try {
      const res = await fetch('/api/programs', { credentials: 'same-origin' });
      data = await res.json();
    } catch { /* ignore */ }

    const programs = (data && data.programs) || [];
    list.innerHTML = '';

    if (programs.length === 0) {
      list.innerHTML = '<p class="muted">ยังไม่มีโปรแกรมให้เลือก</p>';
      return;
    }

    const anyStock = programs.some((p) => p.remaining > 0);
    programs.forEach((p) => {
      const out = !(p.remaining > 0);
      const btn = document.createElement('button');
      btn.className = 'program-btn' + (out ? ' out' : '');
      btn.type = 'button';
      btn.disabled = out;
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
    if (state.busy) return;
    state.busy = true;
    if (btn) btn.disabled = true;
    hide('picker-error');

    const { ok, data } = await api('/api/key/claim', { program: programId });
    state.busy = false;

    if (ok && data.key) {
      hide('picker-card');
      $('key-value').textContent = data.key;
      $('key-program').textContent = data.programName || '—';
      refreshStock();
      show('key-card');
    } else if (data.error === 'out_of_stock') {
      showPickerError('โปรแกรมนี้คีย์เพิ่งหมด กรุณาเลือกตัวอื่น');
      showPicker();               // refresh counts
    } else if (data.error === 'invalid_program') {
      showPickerError('ไม่พบโปรแกรมนี้ กรุณารีเฟรช');
    } else {
      showPickerError(errText(data.error));
      if (btn) btn.disabled = false;
    }
  }

  function showPickerError(msg) {
    const e = $('picker-error');
    e.textContent = msg;
    show('picker-error');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function copyKey() {
    const val = $('key-value').textContent;
    const done = () => { show('copied'); setTimeout(() => hide('copied'), 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(done).catch(fallbackCopy);
    } else fallbackCopy();
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      ta.value = val; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch {}
      ta.remove();
    }
  }

  function errText(code) {
    const map = {
      no_session: 'เซสชันหมดอายุ กรุณารีเฟรชหน้า',
      already_complete: 'คุณทำครบทุกด่านแล้ว',
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

  async function refreshStock() {
    try {
      const res = await fetch('/api/stock', { credentials: 'same-origin' });
      const d = await res.json();
      if (typeof d.remaining === 'number') $('stock-n').textContent = d.remaining;
    } catch {}
  }

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    const blocked = await isAdBlockActive();
    if (blocked) {
      hide('gate');
      show('blocked');
      return;
    }

    let cfg = { turnstile: { enabled: false } };
    try {
      const res = await fetch('/api/config', { credentials: 'same-origin' });
      cfg = await res.json();
    } catch { /* proceed without */ }

    if (cfg && cfg.turnstile && cfg.turnstile.enabled && cfg.turnstile.siteKey) {
      renderTurnstileThenStart(cfg.turnstile.siteKey);
    } else {
      startSession(null);
    }
  }

  function renderTurnstileThenStart(siteKey) {
    const box = $('turnstile-box');
    $('gate-spinner').classList.add('hidden');
    $('gate-text').textContent = 'ยืนยันว่าคุณไม่ใช่บอท';
    box.classList.remove('hidden');

    loadTurnstileScript(() => {
      if (!window.turnstile) { startSession(null); return; }   // script blocked -> let server decide
      try {
        window.turnstile.render(box, {
          sitekey: siteKey,
          callback: (token) => startSession(token),
          'error-callback': () => { $('gate-text').textContent = 'ยืนยันไม่สำเร็จ กรุณารีเฟรชหน้า'; },
        });
      } catch {
        startSession(null);
      }
    });
  }

  function loadTurnstileScript(cb) {
    if (window.turnstile) return cb();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = cb;
    s.onerror = () => cb();
    document.head.appendChild(s);
  }

  async function startSession(turnstileToken) {
    if (state.started) return;          // Turnstile can fire its callback more than once
    state.started = true;

    const hp = $('hp-website');
    const body = { website: hp ? hp.value : '' };
    if (turnstileToken) body.turnstileToken = turnstileToken;

    const { ok, data } = await api('/api/session/start', body);
    if (!ok) {
      state.started = false;            // allow a retry (e.g. failed turnstile)
      hide('gate');
      show('blocked');
      $('blocked').querySelector('h1').textContent = 'ไม่สามารถเริ่มเซสชันได้';
      $('blocked').querySelector('p').textContent = errText(data.error);
      return;
    }

    state.current = data.current || 0;
    state.total = data.total || 4;

    hide('gate');
    show('app');
    buildTumblers();
    setCheckpointCard();
    refreshStock();

    $('go').addEventListener('click', startCheckpoint);
    $('verify').addEventListener('click', verifyCheckpoint);
    $('copy').addEventListener('click', copyKey);
  }

  $('retry').addEventListener('click', () => location.reload());
  window.addEventListener('DOMContentLoaded', boot);
})();
