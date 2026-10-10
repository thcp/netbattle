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
  // Slots carry the traffic role; characters carry the progress (docs/roster-spec.md).
  const SLOTS = ['down', 'up'];
  const ROLE = { down: 'download', up: 'upload' };
  // Characters whose progress is saved. 'red2' is a debug copy of red: it has
  // state in memory, but is never written to the file.
  const SAVED_CHARS = ['red', 'blue', 'thales'];
  const CHARS = [...SAVED_CHARS, 'red2'];
  const CHAR_NAMES = { red: 'Red', blue: 'Blue', thales: 'Thales', red2: 'Red 2' };
  // Before main.js sets f.char: the old fighter key stands for its character.
  const LEGACY_CHAR = { down: 'red', up: 'blue' };
  const FLOAT_SECONDS = 2;

  // Cost to finish level n, in GiB.
  const cost = (n) => (n <= 10 ? 5 * n : 5 * n * (1 + 0.25 * (n - 10)));
  // cum[k] = bytes needed to finish level k (so to reach level k + 1).
  const cum = [0];
  for (let n = 1; n < MAX_LEVEL; n++) cum.push(cum[n - 1] + cost(n) * GIB);

  const fresh = () => ({ bytes: 0, build: { speed: 0, stamina: 0, strength: 0 }, lost: 0, protectLeft: 0 });
  const state = {};
  // Per character, not saved: bytes loaded from the file, bytes counted this
  // session, the last knockout, and the level a test build forces.
  const extra = {};
  for (const c of CHARS) {
    state[c] = fresh();
    extra[c] = { base: 0, session: 0, lastKo: null, testLevel: 0 };
  }
  // Who stands in each slot, who waits (first in, first out), and the last
  // cumulative traffic total seen per slot (so a swap does not double count).
  const slots = { down: 'red', up: 'blue' };
  let bench = ['thales'];
  const baseline = { down: 0, up: 0 };

  // The character of a fighter object (or of a bare char / slot name).
  function charOf(f) {
    if (typeof f === 'string') return CHARS.includes(f) ? f : LEGACY_CHAR[f] || 'red';
    if (!f) return 'red';
    if (CHARS.includes(f.char)) return f.char;
    return LEGACY_CHAR[f.slot || f.key] || 'red';
  }
  const slotOfFighter = (f) => (f && (f.slot || f.key)) || 'down';

  const totalBytes = (c) => extra[c].base + extra[c].session;
  const levelFromBytes = (bytes) => {
    let level = 1;
    while (level < MAX_LEVEL && bytes >= cum[level]) level++;
    return level;
  };
  const spent = (c) => STATS.reduce((a, s) => a + state[c].build[s], 0);
  const levelOf = (c) => extra[c].testLevel || levelFromBytes(totalBytes(c));
  const unspentOf = (c) => Math.max(0, levelOf(c) - 1 - state[c].lost - spent(c));

  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  let testMode = false;
  let sinceSave = 0;

  function snapshot() {
    const chars = {};
    for (const c of SAVED_CHARS) {
      const st = state[c];
      chars[c] = { bytes: totalBytes(c), build: { ...st.build }, lost: st.lost, protectLeft: st.protectLeft };
    }
    return JSON.stringify({ version: 2, chars, bench: bench.filter((c) => SAVED_CHARS.includes(c)), slots: { ...slots } });
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

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : 0));

  // One character's saved entry: {bytes, build, lost, protectLeft}. Odd values
  // are clamped, never thrown on.
  function loadEntry(c, d) {
    if (!isObj(d)) return;
    extra[c].base = num(d.bytes, 0, Number.MAX_SAFE_INTEGER);
    for (const s of STATS) state[c].build[s] = Math.floor(num(isObj(d.build) ? d.build[s] : 0, 0, STAT_CAP));
    state[c].lost = Math.floor(num(d.lost, 0, 1000));
    state[c].protectLeft = num(d.protectLeft, 0, PROTECT_SECONDS);
    // Guard against a hand-edited file spending more than was earned.
    while (unspentOf(c) === 0 && levelOf(c) - 1 < state[c].lost + spent(c)) {
      const s = STATS.find((n) => state[c].build[n] > 0);
      if (!s) break;
      state[c].build[s]--;
    }
  }

  // Version 2: {version, chars:{red,blue,thales}, bench:[...], slots:{down,up}}.
  // Version 1: {version, down:{...}, up:{...}}; down is red and up is blue,
  // nothing is lost. Anything else leaves the defaults in place.
  function load(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return;
    }
    if (!isObj(data)) return;
    if (isObj(data.chars)) {
      for (const c of SAVED_CHARS) loadEntry(c, data.chars[c]);
      const sl = data.slots;
      if (isObj(sl) && SAVED_CHARS.includes(sl.down) && SAVED_CHARS.includes(sl.up) && sl.down !== sl.up) {
        slots.down = sl.down;
        slots.up = sl.up;
      }
      // A bench that is not a list falls back to the default.
      const list = Array.isArray(data.bench) ? data.bench : ['thales'];
      bench = [];
      for (const c of list) if (SAVED_CHARS.includes(c) && c !== slots.down && c !== slots.up && !bench.includes(c)) bench.push(c);
    } else {
      loadEntry('red', data.down);
      loadEntry('blue', data.up);
      bench = ['thales'];
    }
  }

  // "red=10,0,0;blue=0,10,5;thales=..." -> builds (speed, stamina, strength).
  function parseTestBuild(text) {
    for (const part of text.split(';')) {
      const [who, nums] = part.split('=');
      const c = (who || '').trim();
      if (!CHARS.includes(c) || !nums) continue;
      const [speed, stamina, strength] = nums.split(',').map((n) => Math.max(0, Math.min(STAT_CAP, parseInt(n, 10) || 0)));
      state[c].build = { speed, stamina, strength };
      extra[c].testLevel = 1 + speed + stamina + strength;
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
    const c = charOf(f);
    if (!STATS.includes(stat)) return false;
    if (unspentOf(c) < 1 || state[c].build[stat] >= STAT_CAP) return false;
    state[c].build[stat]++;
    save();
    return true;
  }

  // The victim's character loses the point, whatever slot it stands in.
  function onKnockout(victim, attacker) {
    const c = charOf(victim);
    const s = state[c];
    const by = CHAR_NAMES[charOf(attacker)];
    if (s.protectLeft > 0 || spent(c) === 0) {
      extra[c].lastKo = { stat: null, by };
      return;
    }
    const pool = STATS.filter((n) => s.build[n] > 0);
    const stat = pool[Math.floor(Math.random() * pool.length)];
    s.build[stat]--;
    s.lost++;
    s.protectLeft = PROTECT_SECONDS;
    extra[c].lastKo = { stat, by };
    floatText(victim, `-1 ${STAT_NAMES[stat]}`, 'loss');
    save();
  }

  // Credits the growth of one slot's cumulative total to the character that
  // stands in that slot now. Returns the new level when it rose, else 0.
  function creditSlot(slot, total) {
    const c = slots[slot];
    total = Number.isFinite(total) ? Math.max(0, total) : 0;
    let delta = total - baseline[slot];
    baseline[slot] = total;
    if (delta <= 0) return 0; // counter went back (reset): re-base, credit nothing
    const before = levelOf(c);
    extra[c].session += delta;
    const after = levelOf(c);
    return after > before ? after : 0;
  }

  // The fighter object standing in a slot (for floating text).
  function occupant(slot) {
    if (typeof fighters === 'undefined') return null;
    return fighters.find((f) => f.slot === slot) || fighters.find((f) => !f.slot && f.key === slot) || null;
  }

  // ---------- Panel ----------
  const gib = (b) => (b / GIB).toFixed(b >= 10 * GIB ? 1 : 2);
  const mmss = (sec) => {
    const s = Math.ceil(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  let lastHtml = '';

  // info: { name, style, role, traffic, pct, status, record }, from main.js.
  // role is the slot's traffic role ('download' or 'upload').
  function renderPanel(el, f, info) {
    const c = charOf(f);
    const s = state[c];
    const level = levelOf(c);
    const unspent = unspentOf(c);
    const r = info.record;
    let xp;
    if (level >= MAX_LEVEL) {
      xp = `<div class="label">Level ${level} <span class="soon">MAX</span></div><div class="bar"><i style="width:100%"></i></div>`;
    } else {
      const used = Math.max(0, totalBytes(c) - cum[level - 1]);
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
    const ko = extra[c].lastKo;
    const koLine = ko
      ? ko.stat
        ? `Last knockout: lost 1 ${STAT_NAMES[ko.stat]} (by ${ko.by})`
        : `Last knockout: by ${ko.by}, no point lost`
      : s.lost > 0
        ? `Points lost to knockouts: ${s.lost}`
        : 'No knockouts yet';
    const html = `
    <div class="role">${info.role}</div>
    <div class="head">
      <span class="dot"></span><strong>${info.name}</strong><span class="lv">Lv ${level}</span>
      <span class="sub">${info.style}</span>
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
    if (html === lastHtml && el.dataset.f === c) return;
    lastHtml = html;
    el.dataset.f = c;
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
    build: (f) => state[charOf(f)].build,
    level: (f) => levelOf(charOf(f)),
    unspent: (f) => unspentOf(charOf(f)),
    char: charOf,
    name: (f) => CHAR_NAMES[charOf(f)],
    roleOf: (f) => ROLE[slotOfFighter(f)] || 'download',
    spendPoint,
    onKnockout,
    // Who stands in each slot now: {down, up}. After init() this is the saved
    // order (red and blue by default). A copy, so callers cannot edit it.
    slots: () => ({ ...slots }),
    // main.js calls this on every swap, and once at the start for each slot.
    setSlot(slot, char) {
      if (!SLOTS.includes(slot) || !CHARS.includes(char)) return;
      slots[slot] = char;
      bench = bench.filter((c) => c !== char);
      save();
    },
    // The waiting characters, first in line first. A copy.
    bench: () => bench.slice(),
    setBench(list) {
      bench = [];
      for (const c of Array.isArray(list) ? list : []) if (CHARS.includes(c) && !bench.includes(c)) bench.push(c);
      save();
    },
    // At start: fits the saved slots and bench to the roster in use. Characters
    // missing from the roster drop out; roster members not placed join the end
    // of the bench. Returns {slots, bench} and stores them.
    reconcile(roster) {
      const list = (Array.isArray(roster) ? roster : []).filter((c, i, a) => CHARS.includes(c) && a.indexOf(c) === i);
      let d = list.includes(slots.down) ? slots.down : null;
      let u = list.includes(slots.up) && slots.up !== d ? slots.up : null;
      for (const c of list) {
        if (!d && c !== u) d = c;
        else if (!u && c !== d) u = c;
      }
      slots.down = d || slots.down;
      slots.up = u || slots.up;
      const placed = [slots.down, slots.up];
      bench = bench.filter((c, i) => list.includes(c) && !placed.includes(c) && bench.indexOf(c) === i);
      for (const c of list) if (!placed.includes(c) && !bench.includes(c)) bench.push(c);
      return { slots: { ...slots }, bench: bench.slice() };
    },
    // Called from the 'net' listener with the payload's cumulative totals per slot.
    onNet(p) {
      if (testMode || !p) return;
      const up = [];
      for (const slot of SLOTS) {
        const lv = creditSlot(slot, +p[slot + 'Total']);
        if (lv) up.push([slot, lv]);
      }
      for (const [slot, lv] of up) {
        const f = occupant(slot);
        if (f) floatText(f, `LEVEL ${lv}`, 'level');
      }
      if (up.length) save();
    },
    // Real seconds since the last call. Every character's protection runs,
    // on screen or on the bench.
    tick(dt) {
      for (const c of CHARS) {
        if (state[c].protectLeft > 0) state[c].protectLeft = Math.max(0, state[c].protectLeft - dt);
      }
      sinceSave += dt;
      if (sinceSave >= SAVE_EVERY) save();
      if (floats.length) placeFloats(dt);
    },
    panel: { render: renderPanel, click: panelClick },
    // For tools/progression_check.js.
    _internals: { cost, cum, levelFromBytes, state, extra, slots, baseline, snapshot, unspentOf, totalBytes, GIB, MAX_LEVEL, PROTECT_SECONDS },
  };
})();
