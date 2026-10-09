'use strict';

// Leveling and skill points (see docs/leveling-spec.md). The combat code in
// main.js reads builds only through Progress.build(f). This file owns the XP
// table, the save file, the info panel contents and the floating text.
const Progress = (() => {
  const GIB = 1024 ** 3;
  const MAX_LEVEL = 20;
  const STAT_CAP = 10;
  const PROTECT_SECONDS = 15 * 60;
  const SAVE_EVERY = 30; // seconds
  const STATS = ['speed', 'stamina', 'strength'];
  const STAT_NAMES = { speed: 'Speed', stamina: 'Stamina', strength: 'Strength' };
  const KEYS = ['down', 'up'];
  const FLOAT_SECONDS = 2;

  // Cost to finish level n, in GiB.
  const cost = (n) => (n <= 10 ? 5 * n : 5 * n * (1 + 0.25 * (n - 10)));
  // cum[k] = bytes needed to finish level k (so to reach level k + 1).
  const cum = [0];
  for (let n = 1; n < MAX_LEVEL; n++) cum.push(cum[n - 1] + cost(n) * GIB);

  const fresh = () => ({ bytes: 0, build: { speed: 0, stamina: 0, strength: 0 }, lost: 0, protectLeft: 0 });
  const state = { down: fresh(), up: fresh() };
  // Per fighter, not saved: bytes loaded from the file, bytes counted this
  // session, the last knockout, and the level a test build forces.
  const extra = {
    down: { base: 0, session: 0, lastKo: null, testLevel: 0 },
    up: { base: 0, session: 0, lastKo: null, testLevel: 0 },
  };

  const totalBytes = (key) => extra[key].base + extra[key].session;
  const levelFromBytes = (bytes) => {
    let level = 1;
    while (level < MAX_LEVEL && bytes >= cum[level]) level++;
    return level;
  };
  const spent = (key) => STATS.reduce((a, s) => a + state[key].build[s], 0);
  const levelOf = (key) => extra[key].testLevel || levelFromBytes(totalBytes(key));
  const unspentOf = (key) => Math.max(0, levelOf(key) - 1 - state[key].lost - spent(key));

  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  let testMode = false;
  let sinceSave = 0;

  function snapshot() {
    const out = { version: 1 };
    for (const key of KEYS) {
      const s = state[key];
      out[key] = { bytes: totalBytes(key), build: { ...s.build }, lost: s.lost, protectLeft: s.protectLeft };
    }
    return JSON.stringify(out);
  }

  function save() {
    sinceSave = 0;
    if (testMode) return;
    try {
      invoke('save_progress', { json: snapshot() }).catch(() => {});
    } catch (err) {
      // No Tauri bridge (unit check): nothing to save to.
    }
  }

  function load(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return;
    }
    for (const key of KEYS) {
      const d = data && data[key];
      if (!d) continue;
      const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : 0));
      extra[key].base = num(d.bytes, 0, Number.MAX_SAFE_INTEGER);
      for (const s of STATS) state[key].build[s] = Math.floor(num(d.build && d.build[s], 0, STAT_CAP));
      state[key].lost = Math.floor(num(d.lost, 0, 1000));
      state[key].protectLeft = num(d.protectLeft, 0, PROTECT_SECONDS);
      // Guard against a hand-edited file spending more than was earned.
      while (unspentOf(key) === 0 && levelOf(key) - 1 < state[key].lost + spent(key)) {
        const s = STATS.find((n) => state[key].build[n] > 0);
        if (!s) break;
        state[key].build[s]--;
      }
    }
  }

  // "red=10,0,0;blue=0,10,5" -> builds (speed, stamina, strength).
  function parseTestBuild(text) {
    for (const part of text.split(';')) {
      const [who, nums] = part.split('=');
      const key = { red: 'down', blue: 'up' }[(who || '').trim()];
      if (!key || !nums) continue;
      const [speed, stamina, strength] = nums.split(',').map((n) => Math.max(0, Math.min(STAT_CAP, parseInt(n, 10) || 0)));
      state[key].build = { speed, stamina, strength };
      extra[key].testLevel = 1 + speed + stamina + strength;
    }
  }

  // ---------- Floating text (DOM overlay) ----------
  const floats = [];
  let layer = null;

  function floatText(f, text, kind) {
    if (typeof document === 'undefined') return;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'floats';
      document.body.appendChild(layer);
    }
    const el = document.createElement('div');
    el.className = 'float';
    const span = document.createElement('span');
    span.className = kind;
    span.textContent = text;
    el.appendChild(span);
    layer.appendChild(el);
    floats.push({ f, el, age: 0 });
  }

  function placeFloats(dt) {
    const mine = new Map();
    for (let i = floats.length - 1; i >= 0; i--) {
      const fl = floats[i];
      fl.age += dt;
      if (fl.age >= FLOAT_SECONDS) {
        fl.el.remove();
        floats.splice(i, 1);
        continue;
      }
    }
    for (const fl of floats) {
      const n = mine.get(fl.f) || 0;
      mine.set(fl.f, n + 1);
      // Same anchor as the speed label: above the sprite's bounds, minus the
      // window's offset from the top of the work area.
      const top = typeof bounds === 'function' && fl.f.sk ? bounds(fl.f.sk).y - view.top : 40;
      const x = fl.f.sk ? fl.f.sk.hip.x : fl.f.x;
      fl.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(top - 26 - n * 20)}px)`;
    }
  }

  // ---------- Rules ----------
  function spendPoint(f, stat) {
    const key = f.key;
    if (!STATS.includes(stat)) return false;
    if (unspentOf(key) < 1 || state[key].build[stat] >= STAT_CAP) return false;
    state[key].build[stat]++;
    save();
    return true;
  }

  function onKnockout(victim, attacker) {
    const key = victim.key;
    const s = state[key];
    const by = attacker && attacker.key === 'down' ? 'Red' : 'Blue';
    if (s.protectLeft > 0 || spent(key) === 0) {
      extra[key].lastKo = { stat: null, by };
      return;
    }
    const pool = STATS.filter((n) => s.build[n] > 0);
    const stat = pool[Math.floor(Math.random() * pool.length)];
    s.build[stat]--;
    s.lost++;
    s.protectLeft = PROTECT_SECONDS;
    extra[key].lastKo = { stat, by };
    floatText(victim, `-1 ${STAT_NAMES[stat]}`, 'loss');
    save();
  }

  function addBytes(key, total) {
    const before = levelOf(key);
    extra[key].session = Math.max(0, total);
    const after = levelOf(key);
    if (after > before) return after;
    return 0;
  }

  // ---------- Panel ----------
  const gib = (b) => (b / GIB).toFixed(b >= 10 * GIB ? 1 : 2);
  const mmss = (sec) => {
    const s = Math.ceil(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  let lastHtml = '';

  // info: { name, style, role, traffic, pct, status, record }, from main.js.
  function renderPanel(el, f, info) {
    const key = f.key;
    const s = state[key];
    const level = levelOf(key);
    const unspent = unspentOf(key);
    const r = info.record;
    let xp;
    if (level >= MAX_LEVEL) {
      xp = `<div class="label">Level ${level} <span class="soon">MAX</span></div><div class="bar"><i style="width:100%"></i></div>`;
    } else {
      const used = Math.max(0, totalBytes(key) - cum[level - 1]);
      const need = cost(level) * GIB;
      xp = `<div class="label">Level ${level} <span class="soon">${gib(used)} / ${gib(need)} GiB</span></div><div class="bar"><i style="width:${Math.min(100, (100 * used) / need).toFixed(1)}%"></i></div>`;
    }
    // Stamina bar slot: filled when the combat code exposes f.stamina and f.staminaMax.
    const stamina =
      Number.isFinite(f.stamina) && Number.isFinite(f.staminaMax) && f.staminaMax > 0
        ? `<div class="row"><span>Stamina now</span><b>${Math.round(f.stamina)} / ${Math.round(f.staminaMax)}</b></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, (100 * f.stamina) / f.staminaMax)).toFixed(0)}%"></i></div>`
        : '';
    const stats = STATS.map((n) => {
      const v = s.build[n];
      const can = unspent > 0 && v < STAT_CAP;
      return `<div class="stat"><span>${STAT_NAMES[n]}</span><div class="pips">${'<i class="on"></i>'.repeat(v)}${'<i></i>'.repeat(STAT_CAP - v)}</div><button data-stat="${n}" ${can ? '' : 'disabled'} aria-label="Add a point to ${STAT_NAMES[n]}">+</button></div>`;
    }).join('');
    const ko = extra[key].lastKo;
    const koLine = ko
      ? ko.stat
        ? `Last knockout: lost 1 ${STAT_NAMES[ko.stat]} (by ${ko.by})`
        : `Last knockout: by ${ko.by}, no point lost`
      : s.lost > 0
        ? `Points lost to knockouts: ${s.lost}`
        : 'No knockouts yet';
    const html = `
    <div class="head">
      <span class="dot"></span><strong>${info.name}</strong>
      <span class="sub">${info.style}, ${info.role}</span>
      <button class="x" data-close aria-label="Close">&times;</button>
    </div>
    <div class="row"><span>Traffic</span><b>${info.traffic}</b></div>
    <div class="bar" title="Power ${info.pct}%"><i style="width:${info.pct}%"></i></div>
    <div class="row"><span>Status</span><b>${info.status}</b></div>
    <div class="label">This session</div>
    <div class="grid">
      <div><b>${r.thrown}</b><span>thrown</span></div>
      <div><b>${r.landed}</b><span>landed</span></div>
      <div><b>${r.blocked}</b><span>blocked</span></div>
      <div><b>${r.knockdowns}</b><span>knockdowns</span></div>
    </div>
    ${xp}
    ${stamina}<!-- STAMINA BAR SLOT: the combat agent exposes f.stamina and f.staminaMax -->
    <div class="row"><span>Points to spend</span><b>${unspent}</b></div>
    ${stats}
    ${s.protectLeft > 0 ? `<div class="note prot">Protected ${mmss(s.protectLeft)}</div>` : ''}
    <div class="note">${koLine}</div>`;
    if (html === lastHtml && el.dataset.f === key) return;
    lastHtml = html;
    el.dataset.f = key;
    el.style.setProperty('--accent', f.color);
    el.innerHTML = html;
  }

  // Click on a + button spends a point; the close button calls onClose.
  function panelClick(e, f, onClose, rerender) {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !f) return;
    if (b.hasAttribute('data-close')) {
      onClose();
    } else if (b.dataset.stat && !b.disabled) {
      if (spendPoint(f, b.dataset.stat)) {
        lastHtml = '';
        rerender();
      }
    }
  }

  return {
    get testMode() {
      return testMode;
    },
    set testMode(v) {
      testMode = !!v;
    },
    async init() {
      try {
        // Any showcase mode is a test mode: the file is never read or written.
        const mode = await invoke('showcase');
        if (mode) testMode = true;
      } catch (err) {
        // No bridge: treat as a normal start.
      }
      try {
        const text = await invoke('test_build');
        if (text) {
          parseTestBuild(text);
          testMode = true;
        }
      } catch (err) {
        // No test build.
      }
      if (testMode) return;
      try {
        const text = await invoke('load_progress');
        if (text) load(text);
      } catch (err) {
        // No file yet: everyone starts at level 1.
      }
    },
    build: (f) => state[f.key].build,
    level: (f) => levelOf(f.key),
    unspent: (f) => unspentOf(f.key),
    spendPoint,
    onKnockout,
    // Called from the 'net' listener with the payload's cumulative totals.
    onNet(p) {
      if (testMode || !p) return;
      const d = addBytes('down', +p.downTotal || 0);
      const u = addBytes('up', +p.upTotal || 0);
      if (d && typeof red !== 'undefined') floatText(red, `LEVEL ${d}`, 'level');
      if (u && typeof blue !== 'undefined') floatText(blue, `LEVEL ${u}`, 'level');
      if (d || u) save();
    },
    // Real seconds since the last call.
    tick(dt) {
      for (const key of KEYS) {
        if (state[key].protectLeft > 0) state[key].protectLeft = Math.max(0, state[key].protectLeft - dt);
      }
      sinceSave += dt;
      if (sinceSave >= SAVE_EVERY) save();
      if (floats.length) placeFloats(dt);
    },
    panel: { render: renderPanel, click: panelClick },
    // For tools/progression_check.js.
    _internals: { cost, cum, levelFromBytes, state, extra, unspentOf, GIB, MAX_LEVEL, PROTECT_SECONDS },
  };
})();
