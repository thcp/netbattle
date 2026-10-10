'use strict';

// NetBattle: red fights for download, blue fights for upload.
// Each fighter's own traffic sets how fast and how hard it fights. The busier
// side is the leader: it wins the exchanges and chases the other when they are
// apart, while the slower side catches its breath until the leader arrives.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---------- Tuning ----------
const Z = 1.35; // fighter size; body lengths and fighting distances scale with it
const IDLE_BPS = 2048; // below this total traffic, nobody fights
const LEAD_RATIO = 1.25; // one side needs this much more traffic to lead
const ENGAGE = 105 * Z; // px between fighters: closer than this, they fight (pro jabs land from ~125 px)
const GRAVITY = 1800; // px/s^2
const FRICTION = 8; // ground slide decay per second
const MARGIN = 40; // keep fighters this far from the screen edges
const RISE_TIME = 0.8; // seconds to get up after a knockdown, about human speed
const ALLOW_JUMPS = false; // flips, flying moves and the cartwheel kick
const POLL_MS = 100; // cursor polling for click-through (each poll is an IPC round trip)
// A timer, not requestAnimationFrame: rAF fires at the monitor refresh rate
// (240 Hz measured) and cost a quarter of a CPU core even when skipping frames.
const FPS = 60;

// ---------- Sprites ----------
// Each fighter draws into its own small canvas that moves with it. A single
// screen-sized canvas cost about half a CPU core in repaints; small moving
// canvases only repaint the area around each fighter.
const PIX = 2; // screen pixels per art pixel
const SPRITE_W = 320; // sprite sizes are multiples of PIX
const SPRITE_H = 260;
const SPRITE_ABOVE_HIP = 166; // room for a high kick and the speed label
let W = 0;
let H = 0;
let dpr = 1;
let ctx = null; // the sprite currently being drawn

function makeSprite() {
  const c = document.createElement('canvas');
  c.className = 'sprite';
  document.body.appendChild(c);
  const art = document.createElement('canvas'); // low-resolution pixel art, never shown directly
  return { c, ctx: c.getContext('2d'), art, actx: art.getContext('2d', { willReadFrequently: true }), aw: 0, ah: 0, ox: NaN, oy: NaN };
}

// The window is a strip along the floor, or the whole work area while a
// fighter is dragged or thrown. Game coordinates are work-area CSS pixels;
// view.top is where the window's top edge sits in them.
let view = { top: 0, width: 0, height: 0 };
let viewFull = false;
let viewBusy = false;
let collapseIn = 0;

async function setView(full) {
  if (viewBusy || full === viewFull) return;
  viewBusy = true;
  // Hidden until the next frame draws them at the new offset, so they do
  // not jump while the window resizes.
  for (const f of fighters) f.sprite.c.style.visibility = 'hidden';
  try {
    view = await invoke('set_view', { full });
    viewFull = full;
    W = view.width;
    H = view.height;
  } catch (err) {
    console.error(err);
  }
  for (const f of fighters) {
    f.sprite.ox = NaN;
    f.sprite.c.style.visibility = '';
  }
  viewBusy = false;
}

// Back to the strip once nobody is held or flying.
function updateView(dt) {
  if (!viewFull || drag || panelF || fighters.some((f) => f.airborne)) {
    collapseIn = 0.3;
    return;
  }
  collapseIn -= dt;
  if (collapseIn <= 0) setView(false);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  for (const f of fighters) {
    const s = f.sprite;
    s.c.width = Math.round(SPRITE_W * dpr);
    s.c.height = Math.round(SPRITE_H * dpr);
    s.c.style.width = SPRITE_W + 'px';
    s.c.style.height = SPRITE_H + 'px';
    s.aw = s.art.width = SPRITE_W / PIX;
    s.ah = s.art.height = SPRITE_H / PIX;
  }
}
const ground = () => H - 1;

// ---------- Skeleton and poses ----------
// Limb angles are degrees from straight down, positive means toward the
// direction the fighter faces. Torso angle is from straight up, positive leans
// forward. "f" = front limb, "b" = back limb; "u"/"f" on arms = upper/fore.
// dx = weight shift forward in px (planted feet stay put), sh = shoulder
// rotation in px (positive brings the front shoulder forward), spin = turn
// around the vertical axis in degrees (180 = back to the opponent).
// stab = how much the head stays upright while the torso leans (0..1); a
// person keeps their eyes level, a stunned body does not. roll = rotation of
// the whole body around the hip in degrees, positive tips forward (flips).
const BONE = Object.fromEntries(Object.entries({ thigh: 17, shin: 17, torso: 24, neck: 3, head: 7, uarm: 13, farm: 13 }).map(([k, v]) => [k, v * Z]));
const KEYS = ['t', 'h', 'fu', 'ff', 'bu', 'bf', 'ft', 'fs', 'bt', 'bs', 'lift', 'dx', 'sh', 'spin', 'stab', 'roll'];
const P = (o) => {
  const p = {};
  for (const k of KEYS) p[k] = 0;
  p.stab = 0.6;
  return Object.assign(p, o);
};

const POSES = {
  guard: P({ t: 12, fu: 25, ff: 165, bu: 15, bf: 172, ft: 28, fs: 2, bt: -28, bs: -12 }),
  guardLow: P({ t: 16, fu: 32, ff: 160, bu: 22, bf: 168, ft: 36, fs: -6, bt: -18, bs: -32 }),
  jab: P({ t: 18, fu: 88, ff: 90, bu: 25, bf: 160, ft: 35, fs: 2, bt: -35, bs: -15, dx: 6, sh: 4 }),
  cross: P({ t: 28, fu: 30, ff: 160, bu: 88, bf: 90, ft: 40, fs: 6, bt: -36, bs: -24, dx: 10, sh: -5 }),
  palm: P({ t: 20, fu: 85, ff: 95, bu: 80, bf: 100, ft: 38, fs: 4, bt: -38, bs: -20, dx: 12, sh: 2 }),
  crouch: P({ t: 30, fu: 50, ff: 140, bu: 10, bf: 60, ft: 55, fs: -15, bt: -15, bs: -55 }),
  uppercut: P({ t: 0, h: -10, fu: 40, ff: 150, bu: 110, bf: 178, ft: 30, fs: 0, bt: -30, bs: -10, dx: 4, sh: -4, lift: 3 }),
  chamber: P({ t: -8, fu: 55, ff: 150, bu: 15, bf: 140, ft: 105, fs: 10, bt: -5, bs: -5 }),
  frontKick: P({ t: -20, fu: 50, ff: 150, bu: 10, bf: 140, ft: 95, fs: 92, bt: -6, bs: -6, dx: 3 }),
  highKick: P({ stab: 0.2, t: -40, h: 20, fu: -10, ff: 40, bu: 60, bf: 120, ft: 135, fs: 138, bt: -15, bs: -10 }),
  spinTurn: P({ t: -5, fu: 40, ff: 150, bu: 20, bf: 160, ft: 90, fs: 10, bt: -5, bs: -5, spin: 180 }),
  spinKick: P({ stab: 0.2, t: -35, h: 15, fu: 20, ff: 100, bu: 70, bf: 120, ft: 105, fs: 108, bt: -15, bs: -10, spin: 360 }),
  sweep: P({ t: 35, fu: 60, ff: 130, bu: -20, bf: 10, ft: 78, fs: 84, bt: 25, bs: -85, dx: 4 }),
  flyingKick: P({ stab: 0.3, t: -15, fu: 120, ff: 150, bu: -30, bf: 10, ft: 95, fs: 95, bt: 30, bs: -75, lift: 24 }),
  block: P({ t: -8, fu: 70, ff: 175, bu: 55, bf: 170, ft: 25, fs: 5, bt: -35, bs: -15, dx: -3 }),
  blockLow: P({ t: 20, fu: 60, ff: 30, bu: 50, bf: 40, ft: 40, fs: -10, bt: -25, bs: -35 }),
  sway: P({ stab: 0.2, t: -30, h: -5, fu: 30, ff: 150, bu: 10, bf: 150, ft: 20, fs: 15, bt: -30, bs: -30, dx: -8 }),
  duck: P({ t: 45, h: 20, fu: 50, ff: 150, bu: 30, bf: 150, ft: 65, fs: -25, bt: -10, bs: -70 }),
  hop: P({ t: 5, fu: 70, ff: 160, bu: 40, bf: 150, ft: 80, fs: -40, bt: 30, bs: -80, lift: 20 }),
  hit: P({ stab: 0, t: -28, h: -25, fu: 5, ff: 60, bu: -45, bf: -15, ft: 22, fs: 10, bt: -30, bs: -15, dx: -4 }),
  down: P({ stab: 0, t: -88, fu: -100, ff: -95, bu: -80, bf: -60, ft: 75, fs: 95, bt: 60, bs: 100 }),
  rest: P({ stab: 0, t: 60, h: 25, fu: -23, ff: -23, bu: -20, bf: -25, ft: 35, fs: -10, bt: -5, bs: -5 }),
  run1: P({ t: 25, fu: -40, ff: 30, bu: 50, bf: 130, ft: 55, fs: 0, bt: -30, bs: -80 }),
  run2: P({ t: 25, fu: 50, ff: 130, bu: -40, bf: 30, ft: -30, fs: -80, bt: 55, bs: 0 }),
  fall: P({ stab: 0, t: -5, fu: 150, ff: 170, bu: 140, bf: 165, ft: 25, fs: -20, bt: -20, bs: -40 }),
  dangle1: P({ stab: 0, t: 0, h: 10, fu: 25, ff: 10, bu: -15, bf: -5, ft: 20, fs: -10, bt: -10, bs: 0 }),
  bend: P({ stab: 0.3, t: -75, h: 10, fu: -40, ff: -20, bu: -60, bf: -40, ft: 60, fs: -30, bt: 40, bs: -40, dx: -2 }),
  // Close-range and finishing strikes.
  elbow: P({ t: 25, fu: 95, ff: -70, bu: 20, bf: 165, ft: 38, fs: 2, bt: -36, bs: -18, dx: 9, sh: 5 }),
  knee: P({ t: -5, fu: 80, ff: 100, bu: 75, bf: 105, ft: 115, fs: -10, bt: -5, bs: -5, dx: 6 }),
  teep: P({ t: -28, fu: 25, ff: 165, bu: 20, bf: 170, ft: 92, fs: 90, bt: -10, bs: -10, dx: -2 }),
  lowKick: P({ t: -12, fu: 30, ff: 160, bu: 40, bf: 150, ft: 72, fs: 78, bt: -12, bs: -8 }),
  spinFist: P({ t: 5, h: 5, fu: 30, ff: 160, bu: 92, bf: 92, ft: 30, fs: 0, bt: -30, bs: -10, spin: 360 }),
  groundPunch: P({ stab: 0.3, t: 55, fu: 40, ff: 20, bu: 20, bf: 150, ft: 70, fs: -40, bt: 15, bs: -90 }),
  stomp: P({ t: -5, fu: 30, ff: 160, bu: 40, bf: 150, ft: 40, fs: 15, bt: -10, bs: -10 }),
  // Scenes: throws, takedown and arm lock.
  loadHigh: P({ t: 55, fu: 100, ff: 120, bu: 60, bf: 100, ft: 45, fs: -25, bt: -25, bs: -45, spin: 180 }),
  reapIn: P({ t: 15, fu: 90, ff: 95, bu: 40, bf: 150, ft: 55, fs: 45, bt: -15, bs: -10, dx: 8 }),
  reap: P({ t: 25, fu: 90, ff: 95, bu: 40, bf: 150, ft: -45, fs: -70, bt: 10, bs: -5, dx: 6 }),
  grab: P({ t: 15, fu: 95, ff: 100, bu: 40, bf: 150, ft: 40, fs: 5, bt: -30, bs: -20, dx: 6 }),
  load: P({ t: 35, fu: 80, ff: 90, bu: 60, bf: 100, ft: 40, fs: -20, bt: -30, bs: -40, spin: 180 }),
  throwEnd: P({ t: 45, fu: 120, ff: 140, bu: 30, bf: 60, ft: 35, fs: -10, bt: -40, bs: -30, spin: 180 }),
  over: P({ stab: 0, t: 55, h: 20, fu: 60, ff: 80, bu: 20, bf: 40, ft: -10, fs: -10, bt: 10, bs: -20 }),
  lockHold: P({ t: 15, fu: 70, ff: 40, bu: 80, bf: 60, ft: 40, fs: 0, bt: -30, bs: -20, dx: 4 }),
  locked: P({ stab: 0.2, t: 70, h: 30, fu: -120, ff: -150, bu: 20, bf: 10, ft: 70, fs: -60, bt: 20, bs: -90 }),
  tuck: P({ stab: 0, t: 30, fu: 60, ff: 140, bu: 50, bf: 140, ft: 100, fs: -20, bt: 90, bs: -30 }),
  dangle2: P({ stab: 0, t: 0, h: -10, fu: -10, ff: -5, bu: 20, bf: 10, ft: -10, fs: 0, bt: 20, bs: -10 }),
  // Tai chi flow for quiet networks.
  tc1: P({ t: 2, fu: 20, ff: 60, bu: 15, bf: 55, ft: 20, fs: -5, bt: -20, bs: -15 }),
  tc2: P({ t: 5, fu: 60, ff: 110, bu: 35, bf: 70, ft: 35, fs: -8, bt: -25, bs: -25, dx: 3 }),
  tc3: P({ t: 0, fu: 90, ff: 95, bu: -70, bf: -80, ft: 40, fs: 10, bt: -40, bs: -30, dx: 5 }),
  tc4: P({ t: -3, fu: 140, ff: 160, bu: 15, bf: 40, ft: 90, fs: -10, bt: -3, bs: -3 }),
};
POSES.guardS = { ...POSES.guard, spin: 360 };
const TAICHI = ['tc1', 'tc2', 'tc3', 'tc1', 'tc4'];

function mix(a, b, k) {
  const r = {};
  for (const key of KEYS) r[key] = a[key] + (b[key] - a[key]) * k;
  return r;
}

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (s) => s * s * (3 - 2 * s);
const limb = (o, a, len, f) => ({ x: o.x + Math.sin(rad(a)) * len * f, y: o.y + Math.cos(rad(a)) * len });

// Joint positions with the hip at (0, 0). f is the horizontal scale: the
// facing direction times cos(spin), so a spin narrows and mirrors the body.
function skeleton(p, f) {
  const hip = { x: 0, y: 0 };
  const neck = { x: Math.sin(rad(p.t)) * BONE.torso * f, y: -Math.cos(rad(p.t)) * BONE.torso };
  const hr = BONE.neck + BONE.head;
  const ha = rad(p.t * (1 - p.stab) + p.h);
  const head = { x: neck.x + Math.sin(ha) * hr * f, y: neck.y - Math.cos(ha) * hr };
  const fs = { x: neck.x + p.sh * Z * f, y: neck.y + 2 * Z };
  const bs = { x: neck.x - p.sh * Z * 0.6 * f, y: neck.y + 2 * Z };
  const fk = limb(hip, p.ft, BONE.thigh, f);
  const bk = limb(hip, p.bt, BONE.thigh, f);
  const fe = limb(fs, p.fu, BONE.uarm, f);
  const be = limb(bs, p.bu, BONE.uarm, f);
  const sk = {
    hip, neck, head, fs, bs, fk, bk, fe, be,
    ffoot: limb(fk, p.fs, BONE.shin, f),
    bfoot: limb(bk, p.bs, BONE.shin, f),
    fh: limb(fe, p.ff, BONE.farm, f),
    bh: limb(be, p.bf, BONE.farm, f),
  };
  if (Math.abs(p.roll) > 0.01) {
    const a = rad(p.roll) * (f >= 0 ? 1 : -1);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    for (const k in sk) sk[k] = { x: sk[k].x * c - sk[k].y * sn, y: sk[k].x * sn + sk[k].y * c };
  }
  return sk;
}

function shift(sk, dx, dy) {
  for (const k in sk) sk[k] = { x: sk[k].x + dx, y: sk[k].y + dy };
  return sk;
}

function lowestY(sk) {
  let y = sk.head.y + BONE.head;
  for (const k in sk) y = Math.max(y, sk[k].y);
  return y;
}

// Two-bone IK: knee position for a leg from hip to foot. bend picks which
// side the knee points to. An unreachable foot is pulled toward the hip.
function ik(hip, foot, a, b, bend) {
  let dx = foot.x - hip.x;
  let dy = foot.y - hip.y;
  let d = Math.hypot(dx, dy) || 0.001;
  const max = a + b - 0.01;
  if (d > max) {
    foot.x = hip.x + (dx / d) * max;
    foot.y = hip.y + (dy / d) * max;
    dx = foot.x - hip.x;
    dy = foot.y - hip.y;
    d = max;
  }
  const ang = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const k = Math.atan2(dy, dx) + ang * bend;
  return { x: hip.x + Math.cos(k) * a, y: hip.y + Math.sin(k) * a };
}

function bounds(sk) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k in sk) {
    const p = sk[k];
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  y0 -= BONE.head;
  return { x: x0 - BONE.head, y: y0, w: x1 - x0 + BONE.head * 2, h: y1 - y0 };
}

// ---------- Moves ----------
// dur is a real human duration in seconds: traffic changes how often and how
// hard a fighter attacks, never how fast a move plays. Times are fractions of dur. knock = slide distance in px on a clean hit at
// normal strength; launch = upward speed; low = knocks the target down.
// defend = the ways a defender can answer this move. aim = where on the
// opponent the striking hand or foot reaches for.
const MOVES = {
  jab: { aim: 'head', dur: 0.38, hitAt: 0.45, reach: 56, knock: 5, limb: 'fh', defend: ['block', 'sway'],
    keys: [[0, 'guard'], [0.4, 'jab'], [0.6, 'jab'], [1, 'guard']] },
  cross: { aim: 'head', dur: 0.48, hitAt: 0.5, reach: 58, knock: 12, limb: 'bh', defend: ['block', 'sway', 'duck', 'bend'],
    keys: [[0, 'guard'], [0.15, 'guardLow'], [0.5, 'cross'], [0.65, 'cross'], [1, 'guard']] },
  palm: { aim: 'chest', dur: 0.5, hitAt: 0.55, reach: 60, knock: 26, limb: 'fh', defend: ['block'],
    keys: [[0, 'guard'], [0.3, 'crouch'], [0.55, 'palm'], [0.75, 'palm'], [1, 'guard']] },
  uppercut: { aim: 'chin', dur: 0.5, hitAt: 0.55, reach: 46, knock: 18, limb: 'bh', defend: ['block', 'sway'],
    keys: [[0, 'guard'], [0.3, 'crouch'], [0.55, 'uppercut'], [0.7, 'uppercut'], [1, 'guard']] },
  frontKick: { aim: 'chest', dur: 0.7, hitAt: 0.5, reach: 62, knock: 28, limb: 'ffoot', defend: ['block', 'sway'],
    keys: [[0, 'guard'], [0.28, 'chamber'], [0.5, 'frontKick'], [0.65, 'frontKick'], [0.82, 'chamber'], [1, 'guard']] },
  sweep: { aim: 'ankle', dur: 0.8, hitAt: 0.5, reach: 62, knock: 14, low: true, limb: 'ffoot', defend: ['blockLow'],
    keys: [[0, 'guard'], [0.3, 'crouch'], [0.5, 'sweep'], [0.7, 'sweep'], [1, 'guard']] },
  highKick: { aim: 'head', dur: 0.9, hitAt: 0.5, reach: 64, knock: 55, limb: 'ffoot', defend: ['duck', 'block', 'bend'],
    keys: [[0, 'guard'], [0.3, 'chamber'], [0.5, 'highKick'], [0.68, 'highKick'], [1, 'guard']] },
  spinKick: { aim: 'head', dur: 1.0, hitAt: 0.6, reach: 66, knock: 80, limb: 'ffoot', defend: ['duck', 'block', 'bend'],
    keys: [[0, 'guard'], [0.32, 'spinTurn'], [0.6, 'spinKick'], [0.78, 'spinKick'], [1, 'guardS']] },
  elbow: { aim: 'head', dur: 0.45, hitAt: 0.5, reach: 40, knock: 14, limb: 'fe', defend: ['block', 'sway'],
    keys: [[0, 'guard'], [0.45, 'elbow'], [0.65, 'elbow'], [1, 'guard']] },
  knee: { aim: 'chest', dur: 0.6, hitAt: 0.5, reach: 38, knock: 20, limb: 'fk', defend: ['block'],
    keys: [[0, 'guard'], [0.5, 'knee'], [0.7, 'knee'], [1, 'guard']] },
  teep: { aim: 'chest', dur: 0.7, hitAt: 0.5, reach: 64, knock: 50, limb: 'ffoot', defend: ['block', 'sway'],
    keys: [[0, 'guard'], [0.3, 'chamber'], [0.5, 'teep'], [0.65, 'teep'], [1, 'guard']] },
  lowKick: { aim: 'thigh', dur: 0.65, hitAt: 0.5, reach: 56, knock: 8, limb: 'ffoot', defend: ['blockLow'],
    keys: [[0, 'guard'], [0.45, 'lowKick'], [0.6, 'lowKick'], [1, 'guard']] },
  spinFist: { aim: 'head', dur: 0.7, hitAt: 0.6, reach: 56, knock: 40, limb: 'bh', defend: ['duck', 'block', 'bend'],
    keys: [[0, 'guard'], [0.3, 'spinTurn'], [0.6, 'spinFist'], [0.75, 'spinFist'], [1, 'guardS']] },
  // Saenchai's cartwheel kick: red's signature finisher, always in slow motion.
  cartwheel: { aim: 'head', dur: 1.5, hitAt: 0.62, reach: 70, knock: 40, low: true, limb: 'ffoot', defend: ['duck', 'block', 'bend'],
    keys: [[0, 'guard'], [0.25, 'crouch'], [0.55, 'highKick'], [0.75, 'highKick'], [1, 'guard']] },
  // Finishing strikes on an opponent lying on the floor.
  groundPunch: { aim: 'chest', ground: true, dur: 0.5, hitAt: 0.55, reach: 50, knock: 0, limb: 'fh', defend: [],
    keys: [[0, 'guard'], [0.35, 'crouch'], [0.55, 'groundPunch'], [0.75, 'groundPunch'], [1, 'guard']] },
  stomp: { aim: 'chest', ground: true, dur: 0.6, hitAt: 0.6, reach: 50, knock: 0, limb: 'ffoot', defend: [],
    keys: [[0, 'guard'], [0.35, 'chamber'], [0.6, 'stomp'], [0.75, 'stomp'], [1, 'guard']] },
  flyingKick: { aim: 'chest', dur: 1.0, hitAt: 0.55, reach: 72, knock: 110, launch: 320, dash: 260, limb: 'ffoot', defend: ['duck', 'block', 'bend'],
    keys: [[0, 'guard'], [0.2, 'crouch'], [0.45, 'flyingKick'], [0.7, 'flyingKick'], [0.9, 'crouch'], [1, 'guard']] },
};

for (const m of Object.values(MOVES)) {
  m.reach *= Z;
  m.knock *= Z;
  if (m.dash) m.dash *= Z;
}

// w = [weight for a fighter with little traffic, weight with a lot]. range =
// the distance a combo is thrown from; elbows and knees up close, punches in
// the middle, kicks further out.
const COMBOS = [
  { seq: ['elbow'], range: 'close', w: [2, 1] },
  { seq: ['jab', 'elbow'], range: 'close', w: [1, 1.5] },
  { seq: ['elbow', 'knee'], range: 'close', w: [0.5, 1.5] },
  { seq: ['knee'], range: 'close', w: [1.5, 1] },
  { seq: ['cross', 'elbow'], range: 'close', w: [0.5, 1.5] },
  { seq: ['elbow', 'uppercut'], range: 'close', w: [0.3, 1.2] },
  { seq: ['uppercut'], range: 'close', w: [1, 0.8] },
  { seq: ['jab'], range: 'mid', w: [3, 0.3] },
  { seq: ['jab', 'cross'], range: 'mid', w: [2, 1.5] },
  { seq: ['jab', 'jab', 'cross'], range: 'mid', w: [0.5, 1.5] },
  { seq: ['palm'], range: 'mid', w: [1.5, 0.8] },
  { seq: ['cross', 'uppercut'], range: 'mid', w: [0.5, 1.2] },
  { seq: ['lowKick'], range: 'mid', w: [1.5, 1] },
  { seq: ['jab', 'lowKick'], range: 'mid', w: [0.8, 1.2] },
  { seq: ['jab', 'cross', 'lowKick'], range: 'mid', w: [0.2, 1.3] },
  { seq: ['spinFist'], range: 'mid', w: [0.3, 1] },
  { seq: ['jab', 'cross', 'spinFist'], range: 'mid', w: [0, 1] },
  { seq: ['sweep'], range: 'mid', w: [1, 1] },
  { seq: ['frontKick'], range: 'far', w: [2, 0.8] },
  { seq: ['teep'], range: 'far', w: [1.5, 1.2] },
  { seq: ['jab', 'frontKick'], range: 'far', w: [0.5, 1.2] },
  { seq: ['highKick'], range: 'far', w: [0.5, 1.2] },
  { seq: ['jab', 'cross', 'highKick'], range: 'far', w: [0, 1.3] },
  { seq: ['spinKick'], range: 'far', w: [0.2, 1.2] },
  { seq: ['teep', 'spinKick'], range: 'far', w: [0, 0.8] },
];

const rangeOf = (d) => (d < 41 * Z ? 'close' : d < 54 * Z ? 'mid' : 'far');

function keyPose(keys, u) {
  for (let k = 1; k < keys.length; k++) {
    if (u <= keys[k][0]) {
      const [t0, p0] = keys[k - 1];
      const [t1, p1] = keys[k];
      return mix(POSES[p0], POSES[p1], smooth(Math.min(1, (u - t0) / (t1 - t0 || 1))));
    }
  }
  return POSES[keys[keys.length - 1][1]];
}

// Range window around a strike's ideal distance: a little closer still lands
// (on the guard), further would hit air. Real fighters only throw what reaches.
// Strikes aim to land LAND_AT px past the opponent's front-most pixel (its
// guard); the window allows 6 px either way: on the glove or the face, never
// through the body.
const LAND_AT = 4;
const DUCK_ROOM = 64 * Z; // hip distance below which a duck would hit the attacker
const SKIDDING = 15; // px/s: an opponent sliding faster is not a set target yet
const RANGE_NEAR = 12;
const RANGE_FAR = 12;
// During the wind-up the attacker inches the last few px to the target with
// its lead foot, as fighters do, at most INCH_MAX px at INCH_SPEED px/s.
const INCH_MAX = 16;
const INCH_SPEED = 90;
const BLOCK_PULL_MAX = 24; // px of extra inching allowed to follow a block back

// How far past the opponent's guard this strike would land if thrown now,
// predicted from where both fighters are drawn this frame: the anchor foot
// stays where the current rear heel is (see paintSheet), the tip extends from
// it as in the clip's impact frame. Null when there is nothing drawn yet.
// The target's front edge as drawn: the guard (front-most pixel) for strikes
// to the body and head, the lead foot's toe for low kicks and sweeps.
const LEG_AIMS = new Set(['thigh', 'ankle']);
function targetFront(o, m) {
  const e = m && LEG_AIMS.has(m.aim) && o.frame.low ? o.frame.low[1] : o.frame.reach;
  return o.xw + (o.face < 0 ? o.frame.img.width - 1 - e : e) * PIX;
}

// How far a block pulls the defender's front edge back by the moment of
// impact, in screen px. The block starts 0.3 s before impact and holds 0.22 s
// after it (see stepAttack), so at impact it is BLOCK_AT of the way through.
const BLOCK_AT = 0.3 / (0.3 + 0.22);
function blockPullback(opp, defense, leg) {
  const clip = clipFrames(opp, defense === 'blockLow' ? 'check' : 'block');
  if (!clip) return 0;
  const i = Math.min(clip.frames.length - 1, Math.floor(BLOCK_AT * clip.frames.length));
  const edge = (fr) => (leg && fr.low ? fr.low[1] : fr.reach);
  return Math.max(0, (edge(clip.frames[0]) - clip.pins[0] - (edge(clip.frames[i]) - clip.pins[i])) * PIX);
}

function predictPast(me, opp, clip, m) {
  const o = opp.lastDraw;
  if (!clip || me.lastRear == null || !o || !o.frame || o.face === me.face) return null;
  const imp = clip.impact;
  const anchorW = me.lastRear + me.face * (clip.pins[0] - clip.rearPins[0]) * PIX;
  const tip = anchorW + me.face * (clip.frames[imp].reach - clip.pins[imp]) * PIX;
  return me.face * (tip - targetFront(o, m));
}

// Hip distance at which this strike lands LAND_AT past the guard: measured
// live when possible, else from the reference stance.
function strikeIdeal(me, opp, name) {
  const clip = clipFrames(me, MOVE_CLIPS[name]);
  const past = predictPast(me, opp, clip, MOVES[name]);
  const live = past != null ? Math.abs(opp.x - me.x) - (past - LAND_AT) : null;
  // Bodies drawn overlapping give no usable edge (the estimate goes below
  // the closest the bodies may stand): fall back to the reference stance.
  if (live != null && live >= MIN_GAP) return live;
  return idealDistance(me, opp, clip);
}
function inRange(me, opp, name, d) {
  const ideal = strikeIdeal(me, opp, name);
  return ideal == null || (d >= ideal - RANGE_NEAR && d <= ideal + RANGE_FAR);
}

// Variety: a strike just thrown is less likely to come again straight away.
function repeatFactor(me, name) {
  const r = (me && me.recent) || [];
  return name === r[0] ? 0.2 : r.includes(name) ? 0.55 : 1;
}

// Null when, with sprites, no strike reaches from distance d.
function pickCombo(power, d, me, opp) {
  const range = rangeOf(d);
  const weights = COMBOS.map((c) => {
    if (me && opp && !inRange(me, opp, c.seq[0], d)) return 0;
    const base = (c.w[0] + (c.w[1] - c.w[0]) * power) * repeatFactor(me, c.seq[0]);
    // With sprites, prefer combos whose first strike fits the current
    // distance, as real fighters do: jab from range, hooks and knees up close.
    const ideal = me && opp ? idealDistance(me, opp, clipFrames(me, MOVE_CLIPS[c.seq[0]])) : null;
    if (ideal != null) return base * Math.exp(-(((ideal - d) / (30 * Z)) ** 2)) + 0.02 * base;
    return base * (c.range === range ? 1 : 0.15);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < COMBOS.length; i++) if (weights[i] > 0 && (r -= weights[i]) <= 0) return COMBOS[i].seq;
  return COMBOS[weights.findIndex((w) => w > 0)].seq;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Combos: real fighters chain whatever reaches. After each strike the planned
// follow-up is thrown if it reaches, else another strike that does; while the
// opponent still staggers from a hit, the attacker waits up to COMBO_WAIT s.
const COMBO_WAIT = 0.5;
const COMBO_SLACK = RANGE_NEAR + INCH_MAX * 0.75;
// How far out of range a follow-up may start: the inching in its wind-up
// closes the rest, and a fast strike (a jab lands 0.14 s after it starts)
// has little time to do it.
function comboSlack(me, name) {
  const m = MOVES[name];
  const clip = clipFrames(me, MOVE_CLIPS[name]);
  const hitAt = clip && clip.impact > 0 ? (clip.impact + 0.5) / clip.frames.length : m.hitAt;
  // Speed points (and tiredness) scale the strike time; the inching speed
  // scales with it (see stepAttack), so the reach of the inching stays put.
  const t = tempo(me);
  const inch = Math.min(INCH_MAX, INCH_SPEED * t * hitAt * (m.dur / t));
  return Math.min(COMBO_SLACK, RANGE_NEAR + 0.8 * inch);
}
const STRIKES = [...new Set(COMBOS.flatMap((c) => c.seq))];
const KICKS = new Set(['ffoot', 'bfoot', 'fk', 'bk']);
const isKick = (name) => !!name && KICKS.has(MOVES[name].limb);

// How many strikes follow the first: more with more traffic, more for the leader.
function comboExtra(me, opp, planned) {
  if (outclassed(me, opp)) return 0;
  const p = 0.2 + 0.45 * power(me) + (me === leader ? 0.15 : 0) - (opp === leader ? 0.1 : 0);
  let n = planned;
  while (n < 4 && Math.random() < p) n++;
  return n;
}

function followUp(me, opp, planned) {
  const d = Math.abs(opp.x - me.x);
  const last = (me.recent || [])[0];
  const opts = [];
  for (const name of STRIKES) {
    const ideal = strikeIdeal(me, opp, name);
    if (ideal == null || Math.abs(d - ideal) > comboSlack(me, name)) continue;
    let w = (name === planned ? 4 : 1) * repeatFactor(me, name);
    if (isKick(name) !== isKick(last)) w *= 1.6; // hands then legs, legs then hands
    w *= Math.exp(-(((ideal - d) / (12 * Z)) ** 2)) + 0.1;
    opts.push([name, w]);
  }
  let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
  for (const [name, w] of opts) if ((r -= w) <= 0) return name;
  return null;
}

// Sprites: the strike a fighter means to throw next, by the same weights as
// the combos; its footwork then works toward that strike's distance, so every
// strike gets its turn, not only the ones that reach from where it stands.
function plannedStrike(me, opp) {
  const p = power(me);
  const opts = COMBOS.map((c) => [c.seq[0], (c.w[0] + (c.w[1] - c.w[0]) * p) * repeatFactor(me, c.seq[0])]);
  let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
  for (const [name, w] of opts) if ((r -= w) <= 0) return strikeIdeal(me, opp, name) != null ? name : null;
  return null;
}

// Pause after a combo before the next attack decision.
function restAfterCombo(me, opp) {
  me.queue = [];
  me.comboLeft = 0;
  me.comboUntil = 0;
  const pace = outclassed(me, opp) ? 3 : outclassed(opp, me) ? 0.55 : me === leader ? 0.7 : opp === leader ? 1.6 : 1;
  let cool = Math.max(0.4, (1.5 - 0.8 * power(me)) * pace * (0.7 + Math.random() * 0.6));
  // Uneven rhythm: sometimes a snap follow-up, now and then a stare-down.
  const r = Math.random();
  if (r < 0.2) cool = Math.max(0.4, cool * 0.5);
  else if (r < 0.3) cool *= 1.8;
  me.cool = cool / tempo(me); // Speed points shorten the pause
}

// Between two strikes of a combo: throw the next one once the opponent is set,
// step in once if it drifted out of reach, or give up when the time runs out.
// True while the combo is still going.
function continueCombo(me, opp) {
  if (!me.comboUntil) return false;
  const lost = opp.state === 'attack' || opp.state === 'down' || opp.airborne || opp.state === 'drag' || opp.state === 'scene';
  if (lost || me.gassed || fightClock > me.comboUntil) {
    restAfterCombo(me, opp);
    return false;
  }
  if (opp.state === 'step' || Math.abs(opp.vx) > SKIDDING) return true; // wait until it is set
  const name = followUp(me, opp, me.queue[0]);
  if (name) {
    me.queue.shift();
    me.comboLeft--;
    me.comboUntil = 0;
    startMove(me, opp, MOVES[name]);
    return true;
  }
  const d = Math.abs(opp.x - me.x);
  if (canStep(me) && !me.comboStepped && stepInFits(me, opp, d)) {
    me.comboStepped = true;
    me.comboUntil = fightClock + STEP_TIME / tempo(me) + COMBO_WAIT;
    startStep(me, 1);
    return true;
  }
  restAfterCombo(me, opp);
  return false;
}

// ---------- Network traffic ----------
// Each fighter is driven by its own traffic: red by download, blue by upload.
// power: 0 at 1 KB/s or less, 1 at 10 MB/s, log scale. Sets attack speed and
//   combo length.
// share: this side's part of the total traffic, 0..1. Sets hit strength and
//   how often attacks get defended, so the busier side wins the exchanges.
const speed = { down: 0, up: 0 };
let leader = null;

const powerOf = (bps) => clamp((Math.log10(bps + 1) - 3) / 4, 0, 1);
const power = (me) => powerOf(speed[me.key]);
function share(me) {
  const total = speed.down + speed.up;
  return total > 0 ? speed[me.key] / total : 0.5;
}
const idle = () => speed.down + speed.up < IDLE_BPS;
const strength = (me) => 0.4 + 1.2 * share(me); // 0.4 (no traffic) .. 1.6 (all of it)
// Outclassed: the opponent has about 8 times more traffic or more (MB/s against
// KB/s). An outclassed fighter attacks rarely and slowly, and almost every
// attempt gets dodged, often in slow motion, or countered.
const OUTCLASS = 0.9; // log10 of the traffic ratio
const outclassed = (me, opp) => Math.log10((speed[opp.key] + 1024) / (speed[me.key] + 1024)) >= OUTCLASS;
const EVADES = new Set(['sway', 'duck', 'hop', 'bend']);

function updateLeader() {
  const before = leader;
  if (idle()) leader = null;
  else if (speed.down > speed.up * LEAD_RATIO) leader = red;
  else if (speed.up > speed.down * LEAD_RATIO) leader = blue;
  else leader = null;
  // A long cooldown from the old balance (an outclassed fighter waits up to
  // ~5 s) must not keep the new leader idle: the change shows right away.
  if (leader !== before) for (const f of fighters) f.cool = Math.min(f.cool, 0.6);
}

function fmt(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1024 * 1024) return Math.round(bps / 1024) + ' KB/s';
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
}

// ---------- Fighters ----------
function makeFighter(color, shade, arrow, key, face) {
  const zero = P({});
  return {
    color, shade, arrow, key, face,
    x: 0, y: 0, vx: 0, vy: 0, airborne: false,
    state: 'guard', timer: 0, cool: 0.5 + Math.random(), flash: 0,
    clock: Math.random() * 10, phase: 0,
    move: null, queue: [], atkT: 0, atkDur: 0, hitDone: false, defense: null, defCued: false,
    pose: { ...POSES.guard }, vel: zero, sk: null, sprite: makeSprite(),
    tails: null, trail: [], feet: null, flipT: 0, want: 46, wantT: 0, groundDone: false, reaches: [], scenePose: null, sceneRoll: null, sceneFree: false, ghosts: [], ghostIn: 0, tailDt: 1 / 60, aimAt: null, hipVx: 0, lastHipX: NaN,
    // Stamina (see stepStamina); staminaMax 0 means "fill on the first frame".
    stamina: 0, staminaMax: 0, gassed: false, spent: 0, taken: 0, koExtra: 0, riseTime: RISE_TIME, stepTime: 0, atkTempo: 1,
  };
}
const red = makeFighter('#e53935', '#a32420', '↓', 'down', 1);
const blue = makeFighter('#1e88e5', '#11589c', '↑', 'up', -1);
const fighters = [red, blue];

// ---------- Stats: speed, stamina, strength ----------
// The numbers are from docs/leveling-spec.md. Builds are read only through
// Progress.build(f); a fresh fighter (0 points) has tempo 1, 100 stamina and
// hits with strMult 1.
const NO_BUILD = { speed: 0, stamina: 0, strength: 0 };
function buildOf(f) {
  try {
    return (typeof Progress !== 'undefined' && Progress.build(f)) || NO_BUILD;
  } catch (err) {
    return NO_BUILD;
  }
}
function fighterLevel(f) {
  try {
    return (typeof Progress !== 'undefined' && Progress.level(f)) || 1;
  } catch (err) {
    return 1;
  }
}
const TIRED = 0.3; // under this stamina ratio: slower and worse defence
const GASSED_UNTIL = 0.2; // a gassed fighter attacks again from this ratio
// Tuned from the spec's starting values with test fights: at those values a
// fresh fighter emptied in about 30 s and the fight stalled. COST_SCALE
// multiplies the own costs (steps, strikes), DRAIN_SCALE what blocked and
// landed strikes take, REGEN is per second in guard (plus REGEN_PT per
// Stamina point).
const COST_SCALE = 0.5;
const DRAIN_SCALE = 0.6;
const REGEN = 12;
const REGEN_PT = 1.2;
const STEP_COST = 1.5 * COST_SCALE;
const STRIKE_COST = Object.fromEntries(Object.entries({ jab: 4, cross: 4, palm: 4, uppercut: 4, spinFist: 4, elbow: 6, knee: 6, lowKick: 7, sweep: 7, frontKick: 7, teep: 7, highKick: 9, spinKick: 9 }).map(([k, v]) => [k, v * COST_SCALE]));
const BLOCK_DRAIN = 5 * DRAIN_SCALE; // times the attacker's strMult
const hitDrain = (m) => (10 + 0.2 * m.knock) * DRAIN_SCALE; // times strMult
// Knockout window: the defender is at under KO_BELOW of its stamina. The whole
// gassed period (until 20% is back) gave 6 to 8 knockouts per 3 minutes in
// the test fights, far past the protection cap; exactly 0 gave none.
const KO_BELOW = 0.05; // a knockout needs the defender at under this share of its stamina
const koWindow = (f) => f.stamina < Math.max(1, KO_BELOW * f.staminaMax);
const staminaRatio = (f) => (f.staminaMax > 0 ? f.stamina / f.staminaMax : 1);
// Speed points make every move play faster; a tired fighter slows down.
function tempo(f) {
  const t = 1 + 0.025 * buildOf(f).speed;
  return staminaRatio(f) < TIRED ? t * 0.8 : t;
}
// What Strength does. Spec start 0.12 per point: at 10 against 0 the weak
// side lost stamina 4 times faster and was knocked out 10 times in 3 minutes;
// at 0.08 and at 0.06, 1.9 to 2.7 times faster (target: 1.5 or more) and 6 to 8
// knockouts: the knockout count comes from the gassed window, not from this.
const STR_PT = 0.06;
const strMult = (f) => 1 + STR_PT * buildOf(f).strength;
// Speed in even exchanges: chance per point of difference that a block
// becomes an evasion. Spec start 0.03 (cap 0.30): a defender blocks only about
// a third of even strikes, so Speed 10 against 0 evaded about 10%, the target's edge.
const SPEED_EVADE_PT = 0.05;
const SPEED_EVADE_MAX = 0.5;
// Full regeneration in guard and at rest, half while stepping or running,
// none while attacking, defending or hit. Lying down and getting up count as
// rest: without it a knocked-out fighter got up still gassed and was knocked
// out again (26 knockouts in 3 minutes in a Speed 10 against 0 fight).
const REGEN_FULL = new Set(['guard', 'rest', 'taichi', 'down', 'rise']);
const REGEN_HALF = new Set(['step', 'run']);
function stepStamina(f, dt) {
  const st = buildOf(f).stamina;
  const max = 100 + 10 * st;
  if (!f.staminaMax) f.stamina = max; // starts full
  else if (max > f.staminaMax) f.stamina += max - f.staminaMax; // a new point fills its share
  f.staminaMax = max;
  const k = REGEN_FULL.has(f.state) ? 1 : REGEN_HALF.has(f.state) ? 0.5 : 0;
  f.stamina = Math.min(max, f.stamina + (REGEN + REGEN_PT * st) * k * dt);
  if (f.gassed && f.stamina / max >= GASSED_UNTIL) f.gassed = false;
}
// Own effort (strikes, steps).
function spendStamina(f, n) {
  f.stamina = Math.max(0, f.stamina - n);
  f.spent += n;
  if (f.stamina <= 0) f.gassed = true;
}
// Taken from the opponent's blocked or landed strikes.
function drainStamina(f, n) {
  f.stamina = Math.max(0, f.stamina - n);
  f.taken += n; // nominal, so the drain rate reads the same at 0
  if (f.stamina <= 0) f.gassed = true;
}

const runSpeed = (me) => (150 + 60 * power(me)) * Z; // jogging pace, about 3 m/s
const DEFENSES = ['block', 'blockLow', 'sway', 'duck', 'hop', 'bend'];

// Bullet time: the fight slows to BULLET_SPEED for about 1.4 s of real time,
// easing in and out, and the bodies leave afterimages. At most once every
// BULLET_GAP seconds so it stays special.
const BULLET_SPEED = 0.2;
const BULLET_LEN = 1.4;
const BULLET_GAP = 10;
const DODGE_GAP = 6; // slow-motion dodges of an outclassed fighter's attack
const FINISHERS = new Set([MOVES.highKick, MOVES.spinKick, MOVES.flyingKick]);
let bullet = -1; // seconds since bullet time started, -1 when off
let lastBullet = -Infinity;

function startBulletTime(gap = BULLET_GAP) {
  if (SHOWCASE) return;
  const now = performance.now() / 1000;
  if (now - lastBullet < gap) return;
  lastBullet = now;
  bullet = 0;
}

function timeScale(realDt) {
  if (bullet < 0) return 1;
  bullet += realDt;
  if (bullet >= BULLET_LEN) { bullet = -1; return 1; }
  const ease = Math.min(smooth(clamp(bullet / 0.15, 0, 1)), smooth(clamp((BULLET_LEN - bullet) / 0.35, 0, 1)));
  return 1 - (1 - BULLET_SPEED) * ease;
}

// Afterimages: snapshots of the painted fighter, kept while the fight is slowed.
const GHOST_LIFE = 0.4; // real seconds
function stepGhosts(me, realDt, slowed) {
  for (const g of me.ghosts) g.age += realDt;
  me.ghosts = me.ghosts.filter((g) => g.age < GHOST_LIFE);
  me.ghostIn -= realDt;
  if (!slowed || me.ghostIn > 0 || !me.sk) return;
  me.ghostIn = 0.04;
  me.ghostDue = true; // render() snapshots the painted pixel art
}

// Hit stop: the whole fight freezes for a few frames on impact.
let stop = 0;
const hitstop = (t) => { stop = Math.max(stop, t); };

// Turning around runs through the spin key, so it animates instead of snapping.
function setFace(me, dir) {
  if (dir === me.face) return;
  me.face = dir;
  if (me.feet) me.feet.reverse();
  me.pose.spin += 180;
  if (me.pose.spin > 180) me.pose.spin -= 360;
}

function update(me, opp, dt) {
  me.clock += dt;
  me.flash -= dt;
  stepStamina(me, dt);
  if (me.state === 'drag' || me.state === 'scene') return;

  if (me.airborne) {
    me.vy += GRAVITY * dt;
    me.x += me.vx * dt;
    me.y += me.vy * dt;
    if (me.x < MARGIN) { me.x = MARGIN; me.vx = Math.abs(me.vx) * 0.4; }
    if (me.x > W - MARGIN) { me.x = W - MARGIN; me.vx = -Math.abs(me.vx) * 0.4; }
    if (me.y < 0) { me.y = 0; me.vy = Math.abs(me.vy) * 0.3; }
    if (me.y < ground()) return;
    me.y = ground();
    me.airborne = false;
    me.vy = 0;
    me.vx *= 0.3;
    dust(me, me.x, me.y, 6);
    if (me.state === 'flip') { me.pose.roll = 0; me.vel.roll = 0; }
    if (me.state === 'hit') { me.state = 'down'; me.timer = 0.6; }
    else { me.state = 'land'; me.timer = 0.22; }
    return;
  }

  me.y = ground();
  me.x += me.vx * dt;
  me.vx *= Math.exp(-FRICTION * dt);
  me.x = clamp(me.x, MARGIN, W - MARGIN);

  if (me.state === 'attack') return stepAttack(me, opp, dt);
  if (me.timer > 0) {
    me.timer -= dt;
    if (me.timer > 0) return;
    if (me.state === 'down') {
      // A knockout adds koExtra to the time it takes to get up.
      me.state = 'rise';
      me.riseTime = RISE_TIME + (me.koExtra || 0);
      me.koExtra = 0;
      me.timer = me.riseTime;
      return;
    }
  }
  if (SHOWCASE) { me.state = 'guard'; return; }
  me.cool -= dt;
  decide(me, opp, dt);
}

function decide(me, opp, dt) {
  const d = Math.abs(opp.x - me.x);
  const oppFree = opp.state !== 'drag';
  setFace(me, Math.sign(opp.x - me.x) || me.face);

  if (idle()) { me.state = 'taichi'; return; }

  if (d > ENGAGE) {
    // Just out of range, fighters close the gap with push-steps; they only
    // run when far apart.
    if (canStep(me) && d < ENGAGE * 2 && oppFree && (leader === me || leader === null)) {
      me.state = 'guard';
      if (Math.random() < dt * 4 && stepInFits(me, opp, d)) startStep(me, 1);
      return;
    }
    if (leader === me && oppFree) {
      me.state = 'run';
      me.x += me.face * runSpeed(me) * dt;
      me.cool = 0; // strike on arrival
    } else if (leader === opp && d > ENGAGE * 1.6) {
      me.state = 'rest';
      me.cool = Math.max(me.cool, 0.6);
    } else {
      me.state = 'guard'; // gets up as the leader closes in
    }
    return;
  }

  me.state = 'guard';
  if (opp.state !== 'down') me.groundDone = false;
  // Finish a downed opponent with a ground punch or a stomp, once per knockdown.
  if (opp.state === 'down' && oppFree && !me.groundDone && !me.gassed && !outclassed(me, opp) && me.cool <= 0.3) {
    if (canStep(me)) {
      // Sprites never glide: close in with a push-step, or skip the finish
      // when no step fits (the bodies may not overlap).
      if (d > 50 * Z + 8) {
        if ((me.stepRest || 0) > 0) return;
        if (stepInFits(me, opp, d)) startStep(me, 1);
        else me.groundDone = true;
        return;
      }
    } else if (d > 34 * Z) { me.x += me.face * Math.min(130 * dt, d - 34 * Z); return; }
    me.groundDone = true;
    me.queue = [];
    startMove(me, opp, Math.random() < 0.5 ? MOVES.groundPunch : MOVES.stomp);
    return;
  }
  if (continueCombo(me, opp)) return;
  if (!oppFree || opp.airborne || opp.state === 'down') return;
  // While a strike is coming, hold the ground: defence is the block, check,
  // sway and duck animations. A step away would leave the strike hitting air.
  if (canStep(me) && opp.state === 'attack') return;
  // No jumping out of corners: when the opponent's back is near a screen
  // edge, the fighter pressing it gives ground so the fight drifts to open space.
  const oppWall = opp.face > 0 ? opp.x - MARGIN : W - MARGIN - opp.x;
  if (oppWall < 120 * Z) {
    if (canStep(me)) { if ((me.stepRest || 0) <= 0 && Math.random() < dt * 3) startStep(me, -1); }
    else me.x -= me.face * 45 * dt;
  }
  // Footwork: every 1 to 2.5 s pick a new distance to work from. The stronger
  // side presses in; an outclassed side keeps away.
  me.wantT -= dt;
  if (me.wantT <= 0) {
    me.wantT = 1 + Math.random() * 1.5;
    const r = Math.random();
    const planned = canStep(me) && !outclassed(me, opp) ? plannedStrike(me, opp) : null;
    if (planned) me.want = Math.max(MIN_GAP + 4 * Z, strikeIdeal(me, opp, planned));
    else if (outclassed(opp, me)) me.want = (r < 0.6 ? 34 : 46) * Z;
    else if (outclassed(me, opp)) me.want = (r < 0.6 ? 58 : 46) * Z;
    else me.want = [34, 46, 46, 58][Math.floor(r * 4)] * Z;
  }
  const want = me.want + 3 * Z * Math.sin(me.clock * 1.6);
  me.stepRest = (me.stepRest || 0) - dt;
  if (canStep(me) && me.stepRest <= 0) {
    // Sprites move only by stepping: one step when the distance is off by
    // more than STEP_MIN, after a short human reaction delay.
    if (Math.abs(d - want) > STEP_MIN && Math.random() < dt * 3) {
      const dir = d > want ? 1 : -1;
      if (dir < 0 || stepInFits(me, opp, d)) {
        startStep(me, dir);
        return;
      }
    } else if (opp.state !== 'attack' && Math.random() < dt * 0.8) {
      // Rhythm: fighters never stand frozen; they step in and out around
      // their distance, as boxers do between exchanges.
      const dir = d > want ? 1 : -1;
      if (dir < 0 || stepInFits(me, opp, d)) {
        startStep(me, dir);
        return;
      }
    }
  } else if (!canStep(me)) {
    // Only the procedural fighters glide; sprites move by stepping alone.
    me.x += me.face * clamp((d - want) * 3, -70, 70) * dt;
  }
  if (me.cool > 0 || opp.state === 'attack' || opp.state === 'scene') return;
  // Gassed (stamina hit 0): no new attack until GASSED_UNTIL is back.
  if (me.gassed) return;
  // Grappling scenes need their own clips; with sprites they stay off for now.
  if (!SHEETS[me.key] && sceneReady() && opp.state === 'guard') {
    const sc = pickScene(me, opp, d);
    if (sc) {
      startScene(sc.kind, me, opp, sc.opts);
      return;
    }
  }
  // Red's signature: the Saenchai cartwheel kick when clearly winning.
  // Off for now: it leaves the floor, and the user wants no jumps.
  if (ALLOW_JUMPS && me.key === 'down' && me === leader && strength(me) >= 1.2 && rangeOf(d) !== 'close' && Math.random() < 0.08) {
    me.queue = [];
    startMove(me, opp, MOVES.cartwheel);
    return;
  }
  // Strike only at a set target: not while the opponent is mid-step, when
  // its distance is about to change.
  if (canStep(me) && (opp.state === 'step' || Math.abs(opp.vx) > SKIDDING)) return;
  const seq = pickCombo(power(me), d, me, opp);
  if (!seq) {
    // Nothing reaches from here: step toward the closest strike's range, or
    // keep the guard up and wait. Never throw at air.
    if (canStep(me)) {
      let best = null;
      for (const c of COMBOS) {
        const ideal = strikeIdeal(me, opp, c.seq[0]);
        if (ideal != null && (best === null || Math.abs(d - ideal) < Math.abs(d - best))) best = ideal;
      }
      if (best !== null && d > best) { if (stepInFits(me, opp, d)) startStep(me, 1); }
      else if (best !== null) startStep(me, -1);
    }
    return;
  }
  me.queue = outclassed(me, opp) ? [] : seq.slice(1); // no combos when outclassed
  me.comboLeft = comboExtra(me, opp, me.queue.length);
  me.comboStepped = false;
  startMove(me, opp, MOVES[seq[0]]);
}

// 40% of attack decisions become a scene when one fits.
function pickScene(me, opp, d) {
  if (Math.random() > 0.4) return null;
  const options = [];
  const room = (x) => x > MARGIN + 10 && x < W - MARGIN - 10;
  if (me === leader && strength(me) >= 1.1) {
    if (room(opp.x - me.face * 52 * Z)) {
      options.push({ kind: 'throw', w: 1 });
      options.push({ kind: 'throw', opts: { high: true }, w: 0.8 });
    }
    if (room(opp.x + me.face * 20 * Z)) options.push({ kind: 'reap', w: d < 50 * Z ? 1.2 : 0.5 });
    options.push({ kind: 'clinch', w: d < 44 * Z ? 1.5 : 0.5 });
  }
  if (power(me) > 0.1 && power(opp) > 0.1 && !outclassed(me, opp)) options.push({ kind: 'exchange', w: 1.5 });
  let r = Math.random() * options.reduce((a, o) => a + o.w, 0);
  for (const o of options) if ((r -= o.w) <= 0) return o;
  return null;
}

// Steps: dir +1 toward the opponent, -1 away. The body moves by the clip's own
// foot travel (see paintSheet), so the legs always carry the movement.
const STEP_TIME = 0.45; // seconds per push-step, about human speed
const STEP_MIN = 14 * Z; // px off the wanted distance before a step is taken
const canStep = (me) => !!(SHEETS[me.key] && SHEETS[me.key].stepF && SHEETS[me.key].stepB);
const MIN_GAP = 38 * Z; // hip-to-hip px below which the bodies would overlap

// Screen px one push-step covers: how much the stance widens while the lead
// foot steps out (the rear foot then only closes the gap).
const STEP_LEN = {};
function stepLength(me) {
  if (STEP_LEN[me.key] != null) return STEP_LEN[me.key];
  const c = SHEETS[me.key].stepF;
  const width = (fr) => fr.low[1] - fr.low[0];
  const widen = c.filter((fr) => fr.pin === 0);
  const last = widen.length ? widen[widen.length - 1] : c[Math.floor(c.length / 2)];
  return (STEP_LEN[me.key] = Math.max(0, (width(last) - width(c[0])) * PIX));
}

// A forward step is allowed only if the opponent is not stepping in at the
// same moment and the bodies will not overlap afterwards.
function stepInFits(me, opp, d) {
  if (opp.state === 'step' && opp.stepDir > 0) return false;
  if (opp.state === 'attack') return false; // never walk into a strike already coming
  return d - stepLength(me) >= MIN_GAP;
}

function startStep(me, dir) {
  const to = me.x + me.face * dir * stepLength(me);
  if (to < MARGIN || to > W - MARGIN) return;
  // Speed points (and tiredness) change the step time; the 0.3 to 0.9 s
  // settle between footwork steps stays (strikes and closing steps ignore it).
  me.stepTime = STEP_TIME / tempo(me);
  me.stepRest = me.stepTime + 0.3 + Math.random() * 0.6;
  me.state = 'step';
  me.stepDir = dir;
  me.timer = me.stepTime;
  spendStamina(me, STEP_COST);
  me.stepClip = null; // a step right after a step starts fresh
  me.stepFrame = -1;
}

const FLIP_TIME = 2 * 560 / GRAVITY; // seconds in the air for vy = -560

function startFlip(me, landX) {
  me.state = 'flip';
  me.flipT = 0;
  me.airborne = true;
  me.vy = -560;
  me.vx = (landX - me.x) / FLIP_TIME;
  me.queue = [];
}

function startMove(me, opp, m) {
  me.state = 'attack';
  me.move = m;
  me.atkT = 0;
  const weak = outclassed(me, opp);
  // An outclassed fighter is a little slower; Speed points make it faster,
  // tiredness slower (tempo). The inching in stepAttack scales with it.
  me.atkTempo = tempo(me);
  me.atkDur = (m.dur * (weak ? 1.15 : 1)) / me.atkTempo;
  spendStamina(me, STRIKE_COST[moveName(m)] || 0);
  // With sprite clips, the hit lands in the middle of the clip's furthest-reaching frame.
  const clip = clipFrames(me, MOVE_CLIPS[moveName(m)]);
  me.hitAt = clip && clip.impact > 0 ? (clip.impact + 0.5) / clip.frames.length : m.hitAt;
  me.idealD = m.ground ? null : idealDistance(me, opp, clip);
  if (FIGHT_TEST && me.idealD != null) {
    const past = predictPast(me, opp, clip, m);
    const ideal = past != null ? Math.abs(opp.x - me.x) - (past - LAND_AT) : me.idealD;
    const d = Math.abs(opp.x - me.x);
    invoke('showcase_mark', { label: `STRIKE ${me.key} ${moveName(m)} d=${d.toFixed(0)} ideal=${ideal.toFixed(0)} off=${(d - ideal).toFixed(0)} past=${past == null ? '?' : past.toFixed(0)}` }).catch(() => {});
  }
  if (!m.ground) me.recent = [moveName(m), ...(me.recent || [])].slice(0, 3);
  if (me.record && !m.ground) me.record.thrown++;
  me.hitDone = false;
  me.inched = 0;
  me.defCued = false;
  me.trail = [];
  // Aim where the opponent is now; if it ducks or sways, the strike misses.
  const t = aimPoint(opp, m.aim);
  me.aimAt = { dx: t.x - opp.x, y: t.y };
  // The defender's share of traffic decides how well it defends; Speed points
  // help, tiredness hurts.
  const defChance = (weak ? 0.95 : 0.2 + 0.6 * share(opp)) + 0.01 * buildOf(opp).speed - (staminaRatio(opp) < TIRED ? 0.25 : 0);
  me.defense = !m.ground && Math.random() < defChance ? pick(m.defend) || null : null;
  // The leader can parry a hand strike and counter (elbow, knee, shove), or
  // catch a punch and turn it into an arm lock.
  if (!SHEETS[opp.key] && (ARMS[m.limb] || m.limb === 'fe') && opp === leader && sceneReady()) {
    const r = Math.random();
    if (r < (weak ? 0.3 : 0.15)) me.defense = 'counter';
    else if (r < (weak ? 0.45 : 0.3) && (m === MOVES.jab || m === MOVES.cross)) me.defense = 'catch';
  }
  // Against an outclassed attacker, prefer a dodge, in slow motion when allowed.
  if (weak && me.defense && me.defense !== 'counter' && me.defense !== 'catch') {
    const evades = m.defend.filter((x) => EVADES.has(x));
    if (m.aim === 'head' && !evades.includes('bend')) evades.push('bend');
    if (evades.length) me.defense = SHEETS[opp.key] && m.aim === 'head' ? 'duck' : pick(evades);
    if (EVADES.has(me.defense)) startBulletTime(DODGE_GAP);
  }
  // Up close there is no room to duck: the crouch would put the body into
  // the attacker. Sway back instead; ducks stay for strikes thrown from range.
  // With sprites, strikes land: in an even exchange every evasion becomes a
  // block. Only an outclassed attacker gets dodged (the slow-motion rule):
  // a sway against punches, a duck only under a head kick from range.
  if (SHEETS[opp.key] && (me.defense === 'duck' || me.defense === 'bend' || me.defense === 'sway')) {
    if (!weak) {
      me.defense = m.defend.find((x) => x === 'block' || x === 'blockLow') || 'block';
    } else if (me.defense !== 'sway' && (!LEGS[m.limb] || Math.abs(opp.x - me.x) < DUCK_ROOM)) {
      me.defense = 'sway';
    }
  }
  // Speed: in an even exchange a faster defender turns some blocks into
  // evasions, by the same rules as above (a sway, a duck only under a head
  // kick from range); a strike with no evasion in its list stays blocked.
  if (SHEETS[opp.key] && !weak && (me.defense === 'block' || me.defense === 'blockLow')
    && Math.random() < clamp(SPEED_EVADE_PT * (buildOf(opp).speed - buildOf(me).speed), 0, SPEED_EVADE_MAX)) {
    const evades = m.defend.filter((x) => EVADES.has(x));
    if (evades.length || m.aim === 'head') {
      me.defense = m.aim === 'head' && LEGS[m.limb] && Math.abs(opp.x - me.x) >= DUCK_ROOM ? 'duck' : 'sway';
    }
  }
  // Aim where a blocking guard will be at impact, not where it is now.
  me.pullback = SHEETS[opp.key] && (me.defense === 'block' || me.defense === 'blockLow')
    ? Math.min(BLOCK_PULL_MAX, blockPullback(opp, me.defense, LEG_AIMS.has(m.aim))) : 0;
  if (m.dash) me.vx = me.face * m.dash;
  if (m === MOVES.cartwheel) startBulletTime(4);
  // Bullet time for a big kick that will land, or for a Neo backbend dodge.
  if (me.defense === 'bend' || (FINISHERS.has(m) && !me.defense && strength(me) >= 1)) startBulletTime();
}

function stepAttack(me, opp, dt) {
  const m = me.move;
  me.atkT += dt;
  const hitTime = me.hitAt * me.atkDur;
  // Press forward while striking so combos keep contact.
  const d = Math.abs(opp.x - me.x);
  if (!SHEETS[me.key] && !m.dash && d > m.reach - 10 * Z && me.atkT < hitTime) me.x += me.face * Math.min(110 * dt, d - (m.reach - 10 * Z));
  // Sprites: inch toward the target, measured live against the defender as
  // it is drawn now (a block pulls the guard back), so the strike lands.
  if (canStep(me) && !m.ground && me.atkT < hitTime && me.curClip && me.lastDraw && opp.lastDraw && opp.lastDraw.face !== me.face) {
    const c = me.curClip;
    const col = (fr, e) => (me.face < 0 ? fr.img.width - 1 - e : e);
    const anchorW = me.lastDraw.xw + col(me.lastDraw.frame, c.pins[me.curFrame]) * PIX;
    const tip = anchorW + me.face * (c.frames[c.impact].reach - c.pins[c.impact]) * PIX;
    // Until the block starts, add how far it will pull the guard back.
    const front = targetFront(opp.lastDraw, m) + (me.defCued ? 0 : me.face * (me.pullback || 0));
    const err = LAND_AT - me.face * (tip - front);
    const room = INCH_MAX + (me.pullback || 0) - Math.abs(me.inched || 0);
    // The wind-up is shorter at a higher tempo: inch faster by the same factor.
    const inch = INCH_SPEED * (me.atkTempo || 1) * dt;
    const step = clamp(err, -Math.min(inch, room), Math.min(inch, room));
    if (Math.abs(err) > 1 && room > 0) {
      me.x += me.face * step;
      me.inched = (me.inched || 0) + step;
    }
  }
  // With sprites, ease toward the distance where this strike just touches,
  // at walking speed, so strikes neither clip through nor whiff in the air.
  if (!canStep(me) && me.idealD != null && me.atkT < hitTime && !opp.airborne && opp.state !== 'drag') {
    me.x += me.face * clamp(d - me.idealD, -160 * dt, 160 * dt);
  }

  const canDefend = !opp.airborne && (opp.state === 'guard' || DEFENSES.includes(opp.state));
  if ((me.defense === 'catch' || me.defense === 'counter') && me.atkT >= hitTime - 0.05 && canDefend && sceneReady()) {
    startScene(me.defense === 'catch' ? 'lock' : 'parry', opp, me);
    return;
  }
  // Sprite defenders react earlier, as the strike starts to come: the
  // attacker's inching then aims at the guard as it will be at impact.
  const cueAt = hitTime - (SHEETS[opp.key] ? 0.3 : 0.14);
  if (me.defense && me.defense !== 'catch' && me.defense !== 'counter' && !me.defCued && me.atkT >= cueAt && canDefend) {
    me.defCued = true;
    opp.state = me.defense;
    opp.timer = hitTime - me.atkT + (me.defense === 'bend' ? 0.4 : 0.22);
  }
  if (!me.hitDone && me.atkT >= hitTime) {
    me.hitDone = true;
    if (CONTACT || FIGHT_TEST) {
      // Where the strike actually lands, as drawn: tip past the opponent's
      // front-most pixel (its guard), in screen px. Expected: 3 art px.
      const edge = (f, e) => f.xw + (f.face < 0 ? f.frame.img.width - 1 - e : e) * PIX;
      const clip = clipFrames(me, MOVE_CLIPS[moveName(m)]);
      let info = '';
      if (clip && me.lastDraw && opp.lastDraw) {
        const tip = edge(me.lastDraw, clip.frames[clip.impact].reach);
        const guard = targetFront(opp.lastDraw, m);
        info = ` past=${(me.face * (tip - guard)).toFixed(0)} anchor=${clip.anchor} shown=${me.lastDraw.frame === clip.frames[clip.impact]} opp=${opp.state} def=${me.defense || '-'} weak=${outclassed(me, opp)}`;
      }
      invoke('showcase_mark', { label: `IMPACT ${CONTACT ? show.label : me.key + ' ' + moveName(m)}${info}` }).catch(() => {});
      if (CONTACT) stop = Math.max(stop, 0.5);
    }
    impact(me, opp, m);
  }
  if (me.atkT < me.atkDur) return;

  if (me.pose.spin > 180) me.pose.spin -= 360;
  // A combo goes on with whatever reaches once the opponent is set (see
  // continueCombo); a hit's stagger no longer ends it.
  me.state = 'guard';
  if (me.comboLeft > 0 && opp.state !== 'drag' && !opp.airborne && opp.state !== 'down') {
    me.comboUntil = fightClock + COMBO_WAIT;
    me.cool = 0;
    return;
  }
  restAfterCombo(me, opp);
}

// Sprite fighters stagger a short way: a full knockback slid them about
// 100 px on both feet.
const KNOCK_SPRITE = 0.35;

// Where the strike meets the opponent, as drawn: the front edge of its guard
// (or lead toe for leg strikes), at the height aimed at.
function contactPoint(me, opp, m) {
  const o = opp.lastDraw;
  if (!SHEETS[me.key] || !o || !o.frame || o.face === me.face) return me.sk[m.limb];
  return { x: targetFront(o, m), y: aimPoint(opp, m.aim).y };
}

// How a landed strike feels: a starburst at the contact point, sparks thrown
// along the strike, a freeze that grows with the weight of the strike, a shove
// of the picture for the defender, a small kick forward for
// the attacker. Kicks and knees weigh more than punches.
const HAND_LIMBS = new Set(['fh', 'bh', 'fe']);
function impactFeel(me, opp, m, kind) {
  const at = contactPoint(me, opp, m);
  const heavy = clamp((m.knock * strength(me)) / 80, 0, 1);
  const kick = !HAND_LIMBS.has(m.limb);
  const dir = me.face;
  if (kind === 'block') {
    star(me, at, '#cfe8ff', 0.4);
    fan(me, at, '#ffffff', 7, dir, 0.8);
    ring(me, at, '#ffffff');
    hitstop(0.06 + (kick ? 0.02 : 0));
    jolt(opp, dir * 5 * Z, 0, 0.16);
    jolt(me, -dir * 2 * Z, 0, 0.12);
    return;
  }
  star(me, at, me.color, 0.6 + heavy);
  fan(me, at, me.color, 10 + Math.round(10 * heavy), dir);
  fan(me, at, '#ffffff', 4, dir, 1.3);
  ring(me, at, me.color);
  hitstop((kick ? 0.08 : 0.06) + 0.08 * heavy);
  jolt(opp, dir * (7 + 9 * heavy) * Z, (kick ? -1 : 1) * (1 + 2 * heavy) * Z, 0.24);
  jolt(me, dir * 3 * Z, 0, 0.14);
  if (heavy > 0.4) dust(opp, opp.x, ground(), 3 + Math.round(4 * heavy));
  // Light hits make the defender sweat; hits of 30 or more (knock times
  // strength) draw blood.
  const bloody = m.knock * strength(me) >= 30;
  const head = m.aim === 'head' || m.aim === 'chin';
  drops(opp, at, dir, bloody, bloody ? 4 + Math.round(6 * heavy) + (head ? 3 : 0) : 2 + Math.round(3 * heavy) + (head ? 2 : 0));
}

function impact(me, opp, m) {
  const inReach = (d) => (me.idealD != null ? Math.abs(d - me.idealD) <= 14 * Z : d <= m.reach + 8);
  if (m.ground) {
    if (opp.state !== 'down' || Math.abs(opp.x - me.x) > m.reach + 10) return;
    const at = me.sk[m.limb];
    opp.flash = 0.08;
    sparks(me, at, me.color, 8);
    ring(me, at, me.color);
    dust(opp, opp.x, ground(), 3);
    hitstop(0.05);
    opp.timer = Math.min(opp.timer + 0.3, 1.2);
    return;
  }
  if (!inReach(Math.abs(opp.x - me.x)) || opp.airborne || ['drag', 'down', 'scene'].includes(opp.state)) return;
  const at = me.sk[m.limb];
  if (opp.state === 'sway' || opp.state === 'duck' || opp.state === 'hop' || opp.state === 'bend') {
    opp.cool = Math.min(opp.cool, 0.15); // a clean dodge opens a counter
    return;
  }
  const str = strength(me);
  if (opp.state === 'block' || opp.state === 'blockLow') {
    // Sprite fighters absorb a blocked strike in place: a pushback would
    // slide both feet across the floor.
    opp.vx = SHEETS[opp.key] ? 0 : me.face * m.knock * str * 0.35 * FRICTION;
    if (SHEETS[me.key]) impactFeel(me, opp, m, 'block');
    else {
      sparks(me, at, '#ffffff', 6);
      ring(me, at, '#ffffff');
      hitstop(0.035);
    }
    if (opp.record) opp.record.blocked++;
    drainStamina(opp, BLOCK_DRAIN * strMult(me)); // blocking still costs: Strength makes it cost more
    // A clean block opens a counter: the defender fires back as soon as the
    // strike is over, and the attacker's combo often stops there.
    if (SHEETS[opp.key] && !outclassed(opp, me) && Math.random() < 0.25 + 0.5 * share(opp)) {
      opp.cool = Math.min(opp.cool, 0);
      if (Math.random() < 0.6) me.comboLeft = 0;
    }
    return;
  }
  opp.flash = 0.08;
  if (me.record) me.record.landed++;
  if (SHEETS[me.key]) impactFeel(me, opp, m, 'hit');
  else {
    sparks(me, at, me.color, 8 + Math.round(8 * str));
    ring(me, at, me.color);
    hitstop(0.03 + 0.05 * Math.min(1, (m.knock * str) / 80));
  }
  // Knockout: a heavy hit (the blood rule) or a low strike that lands while
  // the defender is out of stamina (see koWindow) always knocks down, and it
  // gets up 0.6 s later.
  const ko = koWindow(opp) && (m.low || m.knock * str >= 30);
  // A low strike knocks down with probability 1 - 0.05 * stamina points *
  // stamina ratio: always for a fresh fighter, as before stamina existed.
  const p = m.low ? 1 - 0.05 * buildOf(opp).stamina * staminaRatio(opp) : 0;
  const downed = ko || (m.low && Math.random() < p);
  drainStamina(opp, hitDrain(m) * strMult(me));
  if (FIGHT_TEST && (m.low || ko)) {
    invoke('showcase_mark', { label: `LOWHIT victim=${opp.key} attacker=${me.key} move=${moveName(m)} low=${m.low ? 1 : 0} p=${p.toFixed(2)} down=${downed ? 1 : 0} ko=${ko ? 1 : 0} st=${opp.stamina.toFixed(0)}` }).catch(() => {});
  }
  if (ko) {
    opp.koExtra = 0.6;
    // A knockout ends the gassed state (a second wind): otherwise a strike
    // while it gets up knocked it out again a second later.
    opp.stamina = Math.max(opp.stamina, GASSED_UNTIL * opp.staminaMax);
    opp.gassed = false;
    if (FIGHT_TEST) invoke('showcase_mark', { label: `KO victim=${opp.key} attacker=${me.key} move=${moveName(m)}` }).catch(() => {});
    try {
      if (typeof Progress !== 'undefined') Progress.onKnockout(opp, me);
    } catch (err) {
      console.error(err);
    }
  }
  if (downed) {
    if (me.record) me.record.knockdowns++;
    opp.state = 'down';
    opp.timer = 0.7;
    opp.vx = me.face * m.knock * str * FRICTION * (SHEETS[opp.key] ? KNOCK_SPRITE : 1);
    dust(opp, opp.x, opp.y, 6);
    return;
  }
  opp.state = 'hit';
  opp.timer = 0.2 + (m.knock * str) / 450;
  if (m.launch && str >= 0.9) {
    opp.airborne = true;
    opp.vy = -m.launch * str;
    opp.vx = me.face * m.knock * str * 3;
  } else {
    opp.vx = me.face * m.knock * str * FRICTION * (SHEETS[opp.key] ? KNOCK_SPRITE : 1);
    if (m.knock * str >= 20) dust(opp, opp.x, opp.y, 4);
  }
}

// ---------- Scenes ----------
// Scripted moments where both fighters move as one: a parry exchange, a hip
// throw and an arm lock. While a scene runs, it sets both fighters' poses,
// positions and hand or foot targets every frame.
let scene = null;
let sceneReadyAt = 0; // clock time when the next scene may start
let fightClock = 0;
const sceneReady = () => !scene && fightClock >= sceneReadyAt;

function startScene(kind, a, b, opts) {
  for (const f of [a, b]) {
    f.state = 'scene';
    f.queue = [];
    f.trail = [];
    f.reaches = [];
    f.vx = 0;
    f.scenePose = { ...f.pose };
  }
  setFace(a, Math.sign(b.x - a.x) || a.face);
  setFace(b, Math.sign(a.x - b.x) || b.face);
  scene = { kind, a, b, t: 0, ...SCENES[kind].init(a, b, opts || {}) };
}

function endScene() {
  const sc = scene;
  scene = null;
  sceneReadyAt = fightClock + 2.5;
  for (const f of [sc.a, sc.b]) {
    f.reaches = [];
    f.sceneRoll = null;
    f.sceneFree = false;
    if (f.state !== 'scene') continue;
    f.state = 'guard';
    if (f.y < ground() - 1) { f.state = 'air'; f.airborne = true; f.vy = 0; }
  }
  sc.a.cool = 0.6;
  sc.b.cool = 0.9;
}

function stepScene(dt) {
  if (!scene) return;
  scene.t += dt;
  if (SCENES[scene.kind].step(scene, dt)) endScene();
}

// A clean hit outside the normal move system.
function landHit(me, opp, at, knock, down) {
  const str = strength(me);
  opp.flash = 0.08;
  opp.reaches = [];
  opp.sceneRoll = null;
  opp.sceneFree = false;
  sparks(me, at, me.color, 8 + Math.round(8 * str));
  ring(me, at, me.color);
  hitstop(0.05 + 0.04 * Math.min(1, (knock * str) / 60));
  if (down) {
    opp.state = 'down';
    opp.timer = 0.9;
    dust(opp, opp.x, ground(), 8);
  } else {
    opp.state = 'hit';
    opp.timer = 0.2 + (knock * str) / 450;
    opp.vx = me.face * knock * str * FRICTION;
  }
}

// A hit inside a scene: the receiver stays in the scene.
function sceneStrike(a, b, at) {
  b.flash = 0.08;
  sparks(a, at, a.color, 8 + Math.round(6 * strength(a)));
  ring(a, at, a.color);
  hitstop(0.04);
}

const lerp = (a, b, k) => a + (b - a) * k;
const chest = (f) => ({ x: lerp(f.sk.neck.x, f.sk.hip.x, 0.25), y: lerp(f.sk.neck.y, f.sk.hip.y, 0.25) });

const SCENES = {
  // Rapid strikes, each met by a parrying hand. The side with the bigger share
  // of traffic strikes more often; if there is a leader, it lands the last beat.
  exchange: {
    init(a, b) {
      const avg = (power(a) + power(b)) / 2;
      const n = 6 + Math.round(6 * avg);
      const pa = share(a);
      const strikers = [];
      while (strikers.length < n) {
        const s = Math.random() < pa ? a : b;
        const run = 1 + Math.floor(Math.random() * 3); // 1-3 strikes in a row
        for (let i = 0; i < run && strikers.length < n; i++) strikers.push(s);
      }
      const finisher = leader === a || leader === b;
      if (finisher) strikers[n - 1] = leader;
      return { n, beat: 0.34 - 0.04 * avg, strikers, finisher, contact: -1 };
    },
    step(sc) {
      const i = Math.floor(sc.t / sc.beat);
      if (i >= sc.n) return true;
      const u = (sc.t - i * sc.beat) / sc.beat;
      const s = sc.strikers[i];
      const d = s === sc.a ? sc.b : sc.a;
      if (s.state !== 'scene' || d.state !== 'scene') return true;
      // Hold a tight 40 px apart around the middle.
      const mid = (sc.a.x + sc.b.x) / 2;
      const side = Math.sign(sc.b.x - sc.a.x) || 1;
      sc.a.x = lerp(sc.a.x, mid - side * 20 * Z, 0.2);
      sc.b.x = lerp(sc.b.x, mid + side * 20 * Z, 0.2);

      const hand = i % 2 ? 'bh' : 'fh';
      const last = sc.finisher && i === sc.n - 1;
      const high = i % 3 !== 0;
      const contact = { x: d.x + d.face * 15 * Z, y: high ? d.sk.head.y + 2 * Z : d.sk.neck.y + 8 * Z };
      const w = bell(u, 0.5, 0.5);
      s.scenePose = mix(POSES.guardLow, hand === 'fh' ? POSES.jab : POSES.cross, 0.7 * w);
      d.scenePose = mix(POSES.guardLow, POSES.block, 0.35);
      d.scenePose.t -= 8 * w;
      s.reaches = [{ limb: hand, target: last ? { x: d.sk.head.x, y: d.sk.head.y } : contact, w }];
      d.reaches = last ? [] : [{ limb: hand === 'fh' ? 'bh' : 'fh', target: contact, w: 0.95 * bell(u, 0.5, 0.45) }];
      if (u >= 0.5 && sc.contact < i) {
        sc.contact = i;
        if (last) landHit(s, d, s.sk[hand], 30, false);
        else sparks(s, contact, '#ffffff', 3);
      }
      return false;
    },
  },

  // Grab the neck, step in, turn the back, and throw the opponent over the
  // hip onto its back on the other side.
  throw: {
    init(a, b, opts) {
      const high = !!opts.high; // shoulder throw: higher arc, deeper bend
      return { dur: high ? 1.6 : 1.4, face: a.face, ax: a.x, bx: b.x, landed: false, liftX: 0,
        high, load: high ? POSES.loadHigh : POSES.load, arc: (high ? 64 : 42) * Z };
    },
    step(sc) {
      const { a, b, face } = sc;
      const u = sc.t / sc.dur;
      if (a.state !== 'scene') return true;
      if (u < 0.3) {
        const k = smooth(u / 0.3);
        a.x = lerp(sc.ax, sc.bx - face * 18 * Z, k);
        a.scenePose = mix(POSES.guard, POSES.grab, k);
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: k }];
        b.scenePose = mix(POSES.guard, POSES.hit, 0.5 * k);
      } else if (u < 0.45) {
        const k = smooth((u - 0.3) / 0.15);
        a.scenePose = mix(POSES.grab, sc.load, k);
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: 1 }];
        b.scenePose = mix(POSES.hit, POSES.over, k);
        b.x = lerp(sc.bx, a.x + face * 10 * Z, k);
        sc.liftX = b.x;
      } else if (!sc.landed && b.state === 'scene') {
        const k = clamp((u - 0.45) / 0.4, 0, 1);
        const e = smooth(k);
        a.scenePose = mix(sc.load, POSES.throwEnd, e);
        if (sc.high && !sc.slow) { sc.slow = true; startBulletTime(); }
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: 1 - e }];
        b.sceneFree = true;
        b.scenePose = POSES.tuck;
        b.x = lerp(sc.liftX, a.x - face * 34 * Z, e);
        b.y = ground() - Math.sin(Math.PI * k) * sc.arc;
        b.sceneRoll = -90 * e;
        if (k >= 1) {
          sc.landed = true;
          b.y = ground();
          b.face = face; // it now lies on the far side, facing the thrower
          b.pose = { ...POSES.down };
          b.vel = P({});
          b.feet = null;
          landHit(a, b, { x: b.x, y: ground() - 6 }, 0, true);
        }
      }
      if (u < 1) return false;
      // The thrower has turned its back to where it started; make that its facing.
      a.face = -a.face;
      a.pose.spin -= 180;
      return true;
    },
  },

  // Parry a hand strike aside, then elbow, knee and shove. a = the defender.
  parry: {
    init(a, b) {
      return { dur: 1.3, hand: b.move && ARMS[b.move.limb] ? b.move.limb : 'fh', marks: {} };
    },
    step(sc) {
      const { a, b } = sc;
      const u = sc.t / sc.dur;
      if (a.state !== 'scene' || b.state !== 'scene') return true;
      const wrist = { ...b.sk[sc.hand] };
      if (u < 0.22) {
        const k = smooth(u / 0.22);
        b.scenePose = sc.hand === 'bh' ? POSES.cross : POSES.jab;
        a.scenePose = mix(POSES.guard, POSES.block, 0.5 * k);
        a.reaches = [{ limb: 'bh', target: { x: wrist.x, y: wrist.y + 4 }, w: k }];
        if (u > 0.15 && !sc.marks.parry) { sc.marks.parry = true; sparks(a, wrist, '#ffffff', 4); }
      } else if (u < 0.45) {
        const k = (u - 0.22) / 0.23;
        a.x = lerp(a.x, b.x - a.face * 32 * Z, 0.2);
        a.scenePose = mix(POSES.guard, POSES.elbow, bell(k, 0.55, 0.55));
        a.reaches = [];
        if (k > 0.55 && !sc.marks.elbow) { sc.marks.elbow = true; sceneStrike(a, b, { ...a.sk.fe }); b.scenePose = POSES.hit; }
      } else if (u < 0.72) {
        const k = (u - 0.45) / 0.27;
        a.x = lerp(a.x, b.x - a.face * 28 * Z, 0.2);
        a.scenePose = mix(POSES.grab, POSES.knee, bell(k, 0.6, 0.6));
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: 1 }, { limb: 'bh', target: { ...b.sk.neck }, w: 1 }];
        b.scenePose = POSES.over;
        if (k > 0.6 && !sc.marks.knee) { sc.marks.knee = true; sceneStrike(a, b, { ...a.sk.fk }); }
      } else {
        const k = (u - 0.72) / 0.28;
        a.scenePose = mix(POSES.knee, POSES.palm, smooth(clamp(k * 2, 0, 1)));
        a.reaches = [];
        if (k > 0.4 && !sc.marks.shove) { sc.marks.shove = true; landHit(a, b, { ...a.sk.fh }, 40, false); }
      }
      return u >= 1;
    },
  },

  // Grab the back of the neck with both hands, drive in knees, then shove.
  clinch: {
    init(a) {
      return { dur: 1.9, knees: 0, shoved: false };
    },
    step(sc) {
      const { a, b } = sc;
      const u = sc.t / sc.dur;
      if (a.state !== 'scene' || b.state !== 'scene') return true;
      a.x = lerp(a.x, b.x - a.face * 28 * Z, 0.15);
      const neck = { ...b.sk.neck };
      if (u < 0.15) {
        const k = smooth(u / 0.15);
        a.scenePose = mix(POSES.guard, POSES.grab, k);
        a.reaches = [{ limb: 'fh', target: neck, w: k }, { limb: 'bh', target: neck, w: k }];
        b.scenePose = mix(POSES.guard, POSES.over, k);
      } else if (u < 0.8) {
        const beat = ((u - 0.15) / 0.65) * 3;
        const i = Math.floor(beat);
        const k = beat - i;
        a.scenePose = mix(POSES.grab, POSES.knee, bell(k, 0.5, 0.5));
        a.reaches = [{ limb: 'fh', target: neck, w: 1 }, { limb: 'bh', target: neck, w: 1 }];
        b.scenePose = POSES.over;
        if (k > 0.5 && sc.knees <= i) { sc.knees = i + 1; sceneStrike(a, b, { ...a.sk.fk }); }
      } else {
        a.scenePose = mix(POSES.grab, POSES.palm, smooth((u - 0.8) / 0.2));
        a.reaches = [];
        if (u > 0.88 && !sc.shoved) { sc.shoved = true; landHit(a, b, neck, 45, false); }
      }
      return u >= 1;
    },
  },

  // Step in, push the chest, reap the leg: the opponent falls on its back.
  reap: {
    init(a, b) {
      return { dur: 1.2, face: a.face, bx: b.x, landed: false };
    },
    step(sc) {
      const { a, b, face } = sc;
      const u = sc.t / sc.dur;
      if (a.state !== 'scene') return true;
      if (u < 0.3) {
        const k = smooth(u / 0.3);
        a.x = lerp(a.x, b.x - face * 20 * Z, 0.2);
        a.scenePose = mix(POSES.guard, POSES.reapIn, k);
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: k }];
        b.scenePose = mix(POSES.guard, POSES.hit, 0.3 * k);
        sc.bx = b.x;
      } else if (!sc.landed && b.state === 'scene') {
        const k = clamp((u - 0.3) / 0.4, 0, 1);
        const e = smooth(k);
        a.scenePose = mix(POSES.reapIn, POSES.reap, e);
        a.reaches = [{ limb: 'fh', target: { ...b.sk.neck }, w: 1 - 0.5 * e }];
        b.sceneFree = true;
        b.scenePose = POSES.hit;
        b.sceneRoll = -90 * e * e;
        b.x = lerp(sc.bx, sc.bx + face * 14 * Z, e);
        b.y = ground();
        if (k >= 1) {
          sc.landed = true;
          b.pose = { ...POSES.down };
          b.vel = P({});
          b.feet = null;
          landHit(a, b, { x: b.x, y: ground() - 6 }, 0, true);
        }
      } else {
        a.scenePose = mix(POSES.reap, POSES.guard, smooth(clamp((u - 0.7) / 0.3, 0, 1)));
        a.reaches = [];
      }
      return u >= 1;
    },
  },

  // Catch a punch, twist the arm behind the back, force the attacker down and
  // strike the back of the neck. a = the one who catches.
  lock: {
    init(a, b) {
      return { dur: 1.5, hand: b.move ? b.move.limb : 'fh', hit: false };
    },
    step(sc) {
      const { a, b, hand } = sc;
      const u = sc.t / sc.dur;
      if (a.state !== 'scene') return true;
      const wrist = { ...b.sk[hand] };
      const elbow = { ...b.sk[hand === 'fh' ? 'fe' : 'be'] };
      const bHolds = b.state === 'scene';
      if (u < 0.25) {
        const k = smooth(u / 0.25);
        a.scenePose = mix(POSES.guard, POSES.lockHold, 0.5 * k);
        a.reaches = [{ limb: 'fh', target: wrist, w: k }];
        if (bHolds) {
          b.scenePose = hand === 'fh' ? POSES.jab : POSES.cross;
          b.reaches = [];
        }
        if (u >= 0.12 && !sc.caught) { sc.caught = true; sparks(a, wrist, '#ffffff', 4); }
      } else if (u < 0.6) {
        const k = smooth((u - 0.25) / 0.35);
        a.scenePose = mix(POSES.guard, POSES.lockHold, 0.5 + 0.5 * k);
        a.reaches = [{ limb: 'fh', target: wrist, w: 1 }, { limb: 'bh', target: elbow, w: k }];
        if (bHolds) {
          b.scenePose = mix(hand === 'fh' ? POSES.jab : POSES.cross, POSES.locked, k);
          b.reaches = [{ limb: hand, target: { x: b.x - b.face * 10 * Z, y: b.sk.neck.y - 16 * Z }, w: k }];
        }
      } else if (bHolds) {
        const k = clamp((u - 0.6) / 0.2, 0, 1);
        a.scenePose = mix(POSES.lockHold, POSES.palm, bell(k, 0.6, 0.6));
        a.reaches = [{ limb: 'fh', target: wrist, w: 1 - k }, { limb: 'bh', target: { ...b.sk.neck }, w: bell(k, 0.6, 0.6) }];
        b.scenePose = POSES.locked;
        if (k >= 0.6 && !sc.hit) {
          sc.hit = true;
          landHit(a, b, { ...b.sk.neck }, 10, true);
        }
      } else {
        a.scenePose = POSES.guard;
        a.reaches = [];
      }
      return u >= 1;
    },
  },
};

// Grounded fighters never stand inside each other.
function separate() {
  if (scene || red.airborne || blue.airborne || red.state === 'drag' || blue.state === 'drag') return;
  const dx = blue.x - red.x;
  const gap = (SHEETS.down ? MIN_GAP * 0.8 : 34 * Z) - Math.abs(dx);
  if (gap <= 0) return;
  const s = Math.sign(dx) || 1;
  // Sprites ease apart 1 px per frame; a snap would jump both bodies.
  const push = SHEETS.down ? Math.min(gap, 1) : gap;
  red.x -= (s * push) / 2;
  blue.x += (s * push) / 2;
}

// ---------- Animation ----------
// Every pose value follows its target through a spring: [stiffness, damping
// ratio]. Below 1 the limb overshoots a little and settles, which gives
// strikes their snap and follow-through.
const SPRING = {
  attack: [1000, 0.55], hit: [420, 0.4], down: [300, 0.6], rise: [250, 0.75],
  block: [550, 0.7], blockLow: [550, 0.7], bend: [300, 0.7], sway: [450, 0.65], duck: [450, 0.65], hop: [500, 0.6],
  run: [700, 0.75], rest: [120, 0.8], taichi: [35, 1], drag: [70, 0.18], air: [200, 0.5],
  land: [350, 0.6], guard: [220, 0.7], flip: [600, 0.7], scene: [700, 0.6],
};

function targetPose(me) {
  const c = me.clock;
  switch (me.state) {
    case 'drag': {
      // Limbs trail behind the mouse movement.
      const p = mix(POSES.dangle1, POSES.dangle2, 0.5 + 0.5 * Math.sin(c * 9));
      const swing = clamp(-(drag ? drag.vx : 0) * 0.06, -70, 70) * me.face;
      p.fu += swing; p.bu += swing; p.ff += swing * 1.2; p.bf += swing * 1.2;
      p.ft += swing * 0.7; p.bt += swing * 0.7; p.fs += swing; p.bs += swing; p.t += swing * 0.2;
      return p;
    }
    case 'run': return mix(POSES.run1, POSES.run2, 0.5 + 0.5 * Math.sin(me.phase));
    case 'rest': {
      const p = { ...POSES.rest };
      p.t += 4 * Math.sin(c * 6);
      p.h += 5 * Math.sin(c * 6 + 1);
      return p;
    }
    case 'attack': return keyPose(me.move.keys, me.atkT / me.atkDur);
    case 'land':
    case 'rise': return POSES.crouch;
    case 'air': return POSES.fall;
    case 'flip': return POSES.tuck;
    case 'scene': return me.scenePose || POSES.guard;
    case 'taichi': {
      // Shared clock, so both fighters flow in step like sparring partners.
      const u = performance.now() / 1000 / 2.4;
      const i = Math.floor(u);
      return mix(POSES[TAICHI[i % TAICHI.length]], POSES[TAICHI[(i + 1) % TAICHI.length]], smooth(u - i));
    }
    case 'guard': {
      // Bounce on the toes and roll the hands; both get faster with traffic.
      const w = 3 + 7 * power(me);
      const p = mix(POSES.guard, POSES.guardLow, 0.5 + 0.5 * Math.sin(c * w));
      p.fu += 6 * Math.sin(c * 3);
      p.ff += 8 * Math.sin(c * 3 + 1);
      p.bu += 6 * Math.sin(c * 3 + 2);
      p.bf += 8 * Math.sin(c * 3 + 3);
      p.t += 3 * Math.sin(c * 1.3);
      return p;
    }
    default: return POSES[me.state] || POSES.guard;
  }
}

function animate(me, dt) {
  // How long the fighter has been in its current state, for one-shot clips.
  if (me.state !== me.lastState) { me.lastState = me.state; me.stateAge = 0; }
  else me.stateAge += dt;
  if (me.state === 'run') {
    const before = Math.floor(me.phase / Math.PI);
    me.phase += (dt * runSpeed(me)) / 20;
    if (Math.floor(me.phase / Math.PI) !== before) dust(me, me.x - me.face * 4, me.y, 2);
  }
  const target = targetPose(me);
  const [k, z] = SPRING[me.state] || SPRING.guard;
  const damp = 2 * z * Math.sqrt(k);
  for (let left = dt; left > 0; left -= 1 / 120) {
    const h = Math.min(left, 1 / 120);
    for (const key of KEYS) {
      me.vel[key] += (k * (target[key] - me.pose[key]) - damp * me.vel[key]) * h;
      me.pose[key] += me.vel[key] * h;
    }
  }
  if (me.state === 'flip') {
    // The rotation is scripted so the flip always completes as it lands.
    me.flipT += dt;
    me.pose.roll = 360 * smooth(clamp(me.flipT / FLIP_TIME, 0, 1));
    me.vel.roll = 0;
  }
  if (me.sceneRoll != null) {
    me.pose.roll = me.sceneRoll;
    me.vel.roll = 0;
  }
}

function aimPoint(opp, aim) {
  const s = opp.sk;
  if (!s) return { x: opp.x, y: opp.y - 50 };
  if (aim === 'head') return { x: s.head.x, y: s.head.y };
  if (aim === 'chin') return { x: s.head.x, y: s.head.y + 4 };
  if (aim === 'ankle') return { x: s.ffoot.x, y: s.ffoot.y - 4 };
  if (aim === 'thigh') return { x: s.fk.x, y: s.fk.y };
  return { x: s.neck.x + (s.hip.x - s.neck.x) * 0.3, y: s.neck.y + (s.hip.y - s.neck.y) * 0.3 };
}

// Move one limb end toward a target by weight w (0..1), then solve the middle
// joint with IK. The end never goes beyond the limb's reach.
function reach(sk, root, mid, end, target, w, a, b, bend) {
  if (w <= 0.001) return;
  const r = sk[root];
  let gx = sk[end].x + (target.x - sk[end].x) * w;
  let gy = sk[end].y + (target.y - sk[end].y) * w;
  const d = Math.hypot(gx - r.x, gy - r.y) || 0.001;
  const max = a + b - 0.5;
  if (d > max) {
    gx = r.x + ((gx - r.x) / d) * max;
    gy = r.y + ((gy - r.y) / d) * max;
  }
  sk[end] = { x: gx, y: gy };
  sk[mid] = ik(r, { x: gx, y: gy }, a, b, bend);
}

const bell = (u, at, width) => smooth(clamp(1 - Math.abs(u - at) / width, 0, 1));
const ARMS = { fh: ['fs', 'fe', 'fh'], bh: ['bs', 'be', 'bh'] };
const LEGS = { ffoot: ['hip', 'fk', 'ffoot'], bfoot: ['hip', 'bk', 'bfoot'] };

// Strikes reach for their aim point around the moment of impact; blocks put
// the forearm where the incoming hand or foot is.
function aimLimbs(me, opp, sk, fx) {
  const armBend = fx >= 0 ? 1 : -1; // elbows point down
  const legBend = fx >= 0 ? -1 : 1; // knees point forward
  if (me.state === 'attack' && me.aimAt) {
    const m = me.move;
    const w = bell(me.atkT / me.atkDur, me.hitAt, 0.22);
    const target = { x: opp.x + me.aimAt.dx, y: me.aimAt.y };
    // Elbows and knees strike with the middle joint and need no reach.
    if (ARMS[m.limb]) reach(sk, ...ARMS[m.limb], target, w, BONE.uarm, BONE.farm, armBend);
    else if (LEGS[m.limb]) reach(sk, ...LEGS[m.limb], target, w * 0.9, BONE.thigh, BONE.shin, legBend);
  }
  if (me.state === 'scene') {
    for (const r of me.reaches) {
      if (ARMS[r.limb]) reach(sk, ...ARMS[r.limb], r.target, r.w, BONE.uarm, BONE.farm, armBend);
      else reach(sk, ...LEGS[r.limb], r.target, r.w, BONE.thigh, BONE.shin, legBend);
    }
  }
  if ((me.state === 'block' || me.state === 'blockLow') && opp.state === 'attack' && opp.sk) {
    const incoming = opp.sk[opp.move.limb];
    const w = 0.75 * bell(opp.atkT / opp.atkDur, opp.move.hitAt, 0.3);
    const meet = { x: incoming.x - fx * 4, y: incoming.y };
    reach(sk, ...ARMS.fh, meet, w, BONE.uarm, BONE.farm, armBend);
  }
}

// Footwork: in most states each foot stays planted on the floor and takes a
// quick arcing step when the pose wants it somewhere else. A knocked-back
// fighter skids on planted feet and steps to catch its balance.
const STEP_AT = 9 * Z; // px between a planted foot and where the pose wants it
const FREE_STATES = new Set(['run', 'drag', 'air', 'down', 'rise', 'flip']);

function footwork(me, sk, desired, dt, fx) {
  const floor = me.y;
  const legBend = fx >= 0 ? -1 : 1;
  if (!me.feet) {
    me.feet = desired.map((d) => ({ x: d.x, y: Math.min(d.y, floor), mode: d.y < floor - 3 ? 'free' : 'planted', t: 0, sx: 0, dur: 0.15, h: 5 }));
  }
  const keys = [['fk', 'ffoot'], ['bk', 'bfoot']];
  me.feet.forEach((F, i) => {
    const D = desired[i];
    const other = me.feet[1 - i];
    if (D.y < floor - 3) {
      // Kicks, chambers and jumps: the foot follows the pose.
      F.mode = 'free';
      F.x = D.x;
      F.y = D.y;
    } else if (F.mode === 'free') {
      F.mode = 'planted';
      F.x = D.x;
      F.y = floor;
    } else if (F.mode === 'step') {
      F.t += dt / F.dur;
      const k = smooth(Math.min(1, F.t));
      const lead = clamp(me.hipVx * F.dur * 0.5, -10, 10);
      F.x = F.sx + (D.x + lead - F.sx) * k;
      F.y = floor - Math.sin(Math.PI * Math.min(1, F.t)) * F.h;
      if (F.t >= 1) { F.mode = 'planted'; F.y = floor; }
    } else {
      F.y = floor;
      const err = Math.abs(D.x - F.x);
      if (err > STEP_AT && (other.mode !== 'step' || err > 24 * Z)) {
        F.mode = 'step';
        F.t = 0;
        F.sx = F.x;
        F.dur = clamp(0.17 - 0.06 * power(me) - err / 600, 0.08, 0.17);
        F.h = (3 + Math.min(6, err * 0.2)) * Z;
      }
    }
    const foot = { x: F.x, y: F.y };
    const knee = ik(sk.hip, foot, BONE.thigh, BONE.shin, legBend);
    // A planted foot beyond the leg's reach gets dragged: a skid.
    if (F.mode === 'planted' && Math.abs(foot.x - F.x) > 0.5) {
      if (Math.abs(foot.x - F.x) > 3 && Math.random() < 0.3) dust(me, foot.x, floor, 1);
      F.x = foot.x;
    }
    sk[keys[i][0]] = knee;
    sk[keys[i][1]] = foot;
  });
}

function layout(me, opp, dt) {
  const fx = me.face * Math.cos(rad(me.pose.spin));
  const sk = skeleton(me.pose, fx);
  if (me.state === 'drag') {
    // Held by the top of the head.
    shift(sk, drag.x - sk.head.x, drag.y + BONE.head - 2 - sk.head.y);
    me.x = sk.hip.x;
    me.y = lowestY(sk);
    me.feet = null;
  } else {
    shift(sk, me.x, me.y - lowestY(sk) - me.pose.lift * Z);
    if (me.airborne || FREE_STATES.has(me.state) || me.sceneFree) {
      me.feet = null;
      me.lastHipX = NaN;
    } else {
      // Where the pose puts the feet, before the lunge moves the hips.
      const desired = [{ ...sk.ffoot }, { ...sk.bfoot }];
      const dx = me.pose.dx * Z * fx;
      for (const j of ['hip', 'neck', 'head', 'fs', 'bs', 'fe', 'be', 'fh', 'bh']) sk[j] = { x: sk[j].x + dx, y: sk[j].y };
      const hx = sk.hip.x;
      me.hipVx = Number.isFinite(me.lastHipX) ? me.hipVx * 0.8 + ((hx - me.lastHipX) / Math.max(dt, 0.001)) * 0.2 : 0;
      me.lastHipX = hx;
      footwork(me, sk, desired, dt, fx);
    }
    aimLimbs(me, opp, sk, fx);
  }
  me.sk = sk;
}

// Headband tails: two short verlet chains hanging from the back of the head.
function stepTails(me, dt) {
  const fx = me.face * Math.cos(rad(me.pose.spin));
  const anchor = { x: me.sk.head.x - fx * 5 * Z, y: me.sk.head.y - 2 * Z };
  if (!me.tails) {
    me.tails = [0, 1].map(() => Array.from({ length: 5 }, () => ({ x: anchor.x, y: anchor.y, px: anchor.x, py: anchor.y })));
  }
  const wind = (-me.face * 260 + Math.sin(me.clock * 7) * 80) * dt * dt;
  const gravity = 140 * dt * dt;
  const carry = 0.9 * (dt / (me.tailDt || dt)); // keeps speed right when dt changes
  me.tailDt = dt || me.tailDt;
  me.tails.forEach((chain, ci) => {
    const seg = (ci ? 3.2 : 3.8) * Z;
    chain[0].x = anchor.x;
    chain[0].y = anchor.y + ci * 1.5;
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i];
      const vx = (p.x - p.px) * carry;
      const vy = (p.y - p.py) * carry;
      p.px = p.x;
      p.py = p.y;
      p.x += vx + wind;
      p.y += vy + gravity;
    }
    for (let it = 0; it < 3; it++) {
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1];
        const b = chain[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const k = (d - seg) / d;
        b.x -= dx * k;
        b.y -= dy * k;
      }
    }
  });
}

// Motion trail behind the striking hand or foot.
const TRAIL_LIFE = 0.1;
function stepTrail(me, dt) {
  for (const p of me.trail) p.age += dt;
  me.trail = me.trail.filter((p) => p.age < TRAIL_LIFE);
  if (me.state !== 'attack') return;
  const m = me.move;
  const u = me.atkT / me.atkDur;
  if (u > me.hitAt - 0.25 && u < me.hitAt + 0.12) {
    const p = me.sk[m.limb];
    me.trail.push({ x: p.x, y: p.y, age: 0 });
  }
}

// ---------- Particles ----------
// Each particle is drawn on its owner's sprite.
const particles = [];
function sparks(owner, at, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 80 + Math.random() * 180;
    particles.push({ type: 'spark', owner, x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.3, max: 0.3, color });
  }
}
// A fan of sparks thrown the way the strike travelled (dir = +1 or -1).
function fan(owner, at, color, n, dir, speed = 1) {
  for (let i = 0; i < n; i++) {
    const a = (Math.random() - 0.5) * 1.8; // about 100 degrees of spread
    const v = (140 + Math.random() * 220) * speed;
    particles.push({ type: 'spark', owner, x: at.x, y: at.y, vx: Math.cos(a) * v * dir, vy: Math.sin(a) * v - 40, life: 0.32, max: 0.32, color });
  }
}
// Drops thrown off a landed hit, on the defender's picture: sweat from light
// hits, blood from heavy ones. They fly the way the strike travelled, fall
// with gravity and leave a small splat on the floor for a moment.
const SWEAT = ['#d6efff', '#9fd4f5'];
const BLOOD = ['#b3141c', '#7a0d14'];
function drops(owner, at, dir, blood, n) {
  for (let i = 0; i < n; i++) {
    const v = (50 + Math.random() * (blood ? 210 : 140));
    particles.push({
      type: 'drop', owner, x: at.x + (Math.random() - 0.5) * 6, y: at.y + (Math.random() - 0.5) * 6,
      vx: dir * v * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 40, vy: -(50 + Math.random() * 170),
      life: 0.9, max: 0.9, color: pick(blood ? BLOOD : SWEAT), floor: ground(), landed: false,
    });
  }
}
// A starburst at the contact point: a small core, then rays in the strike colour.
function star(owner, at, color, size) {
  particles.push({ type: 'star', owner, x: at.x, y: at.y, vx: 0, vy: 0, life: 0.2, max: 0.2, color, size });
}
function ring(owner, at, color) {
  particles.push({ type: 'ring', owner, x: at.x, y: at.y, vx: 0, vy: 0, life: 0.18, max: 0.18, color });
}
function dust(owner, x, y, n) {
  for (let i = 0; i < n; i++) {
    particles.push({ type: 'dust', owner, x: x + (Math.random() - 0.5) * 10, y: y - 2,
      vx: (Math.random() - 0.5) * 60, vy: -10 - Math.random() * 25, life: 0.45, max: 0.45, color: '#bdbdbd' });
  }
}
// Jolt: a short render-only shove of a fighter's picture when a strike lands,
// out along the strike and back with a small overshoot. It moves the picture,
// not the fighter, so feet and distances are untouched. Time stands still
// during the hit freeze, so the peak shows for the whole freeze.
function jolt(f, ax, ay, T) {
  f.jolt = { ax, ay, t: 0, T };
}
function stepJolt(f, dt) {
  if (f.jolt && (f.jolt.t += dt) >= f.jolt.T) f.jolt = null;
}
function joltOffset(f) {
  const j = f.jolt;
  if (!j) return [0, 0];
  const p = j.t / j.T;
  const k = (1 - p) * (1 - p) * Math.cos(p * Math.PI * 2.5);
  return [Math.round((j.ax * k) / PIX) * PIX, Math.round((j.ay * k) / PIX) * PIX];
}

function stepParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.type === 'spark') p.vy += 400 * dt;
    if (p.type === 'drop' && !p.landed) {
      p.vy += 900 * dt;
      if (p.y >= p.floor) {
        p.y = p.floor;
        p.vx = 0;
        p.vy = 0;
        p.landed = true;
        p.life = Math.min(p.life, 0.35 + Math.random() * 0.25);
        p.max = p.life;
      }
    }
    if (p.type === 'dust') { p.vx *= 0.95; p.vy *= 0.95; }
  }
}

// ---------- Pixel art ----------
// Each fighter is painted onto a small canvas at 1 art pixel per PIX screen
// pixels: limbs as outlined, 3-tone shaded strokes in back-to-front order,
// then every pixel is snapped to the costume's palette so edges stay hard.
// Heads are hand-drawn pixel maps. The result is scaled up without smoothing.
const OUT = '#121016';

// Costumes. Tones are [light, base, shadow]; light falls from the upper left.
const LOOKS = {
  down: {
    style: 'muaythai',
    skin: ['#f3b98a', '#d98a57', '#a35a31'],
    shorts: ['#ef5350', '#c62828', '#7a1513'],
    wrap: ['#f5f2e8', '#d4cfbd', '#9e9886'],
    hair: '#1d1612',
    band: ['#e53935', '#9c1f1b'],
    trail: '#ff8a80',
    head: [
      '...KKKKK...',
      '..KHHHHHK..',
      '.KHHHHHHHK.',
      '.KBBBBBBBBK',
      '.KbbbbbbbbK',
      '.KHHsSSSESK',
      '.KHsSSSSSSK',
      '.KHsSSSLSSK',
      '..KsSSSSSK.',
      '..KKsSSSK..',
      '...KKKKK...',
    ],
  },
  up: {
    style: 'gi',
    skin: ['#f8d6b3', '#e5ae85', '#b57b53'],
    gi: ['#7fb0f5', '#2f74d6', '#1a4791'],
    belt: '#1b1b22',
    hair: '#4b2f1d',
    band: ['#f5f2e8', '#c9c4b2'],
    trail: '#90caf9',
    head: [
      '..KK.KKK...',
      '.KHHKHHHKK.',
      '.KHHHHHHHHK',
      '.KBBBBBBBBK',
      '.KbbbbbbbbK',
      '.KHHsSSSESK',
      '.KHsSSSSSSK',
      '.KssSSSLSK.',
      '..KsSSSSK..',
      '...KKKKK...',
    ],
  },
};

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

for (const look of Object.values(LOOKS)) {
  const cloth = look.shorts || look.gi;
  look.headColors = { K: OUT, E: OUT, H: look.hair, B: look.band[0], b: look.band[1], S: look.skin[1], s: look.skin[2], L: look.skin[0] };
  const colors = [OUT, ...look.skin, ...cloth, ...look.band, look.hair, ...(look.wrap || []), ...(look.belt ? [look.belt] : [])];
  look.palette = colors.map(hexRgb);
  look.snapCache = new Map();
}

function nearest(look, r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let hit = look.snapCache.get(key);
  if (hit) return hit;
  let best = look.palette[0];
  let bestD = Infinity;
  for (const c of look.palette) {
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  look.snapCache.set(key, best);
  return best;
}

const off = (p, nx, ny, d) => ({ x: p.x + nx * d, y: p.y + ny * d });

// A limb as a chain of points with one width per segment: all outlines first,
// then shadow, base and light, so the joints stay seamless.
function limbPaint(a, pts, widths, tones, outline = true) {
  a.lineCap = 'round';
  a.lineJoin = 'round';
  const passes = [];
  if (outline) passes.push([OUT, 1, 2, 0]);
  passes.push([tones[2], 1, 0, 0], [tones[1], 0.75, 0, 0.12], [tones[0], 0.35, 0, 0.3]);
  for (const [color, scale, extra, shift] of passes) {
    a.strokeStyle = color;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      const w = widths[i - 1];
      let nx = -(q.y - p.y);
      let ny = q.x - p.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if (nx * -0.6 + ny * -0.8 < 0) { nx = -nx; ny = -ny; } // toward the light
      a.lineWidth = w * scale + extra;
      a.beginPath();
      const p2 = off(p, nx, ny, w * shift);
      const q2 = off(q, nx, ny, w * shift);
      a.moveTo(p2.x, p2.y);
      a.lineTo(q2.x, q2.y);
      a.stroke();
    }
  }
}

function blob(a, p, r, tones) {
  a.fillStyle = OUT;
  a.beginPath();
  a.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
  a.fill();
  a.fillStyle = tones[2];
  a.beginPath();
  a.arc(p.x, p.y, r, 0, Math.PI * 2);
  a.fill();
  a.fillStyle = tones[1];
  a.beginPath();
  a.arc(p.x - r * 0.15, p.y - r * 0.2, r * 0.75, 0, Math.PI * 2);
  a.fill();
}

const at = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });

// Foot: points forward from the ankle, square to the shin.
function footPaint(a, knee, ankle, fx, tones) {
  const dx = ankle.x - knee.x;
  const dy = ankle.y - knee.y;
  const len = Math.hypot(dx, dy) || 1;
  const s = fx >= 0 ? 1 : -1;
  const tip = { x: ankle.x + (-dy / len) * 3.2 * -s, y: ankle.y + (dx / len) * 3.2 * -s };
  limbPaint(a, [ankle, tip], [2.6], tones);
}

function paintLeg(a, look, hip, knee, ankle, fx) {
  if (look.style === 'gi') {
    footPaint(a, knee, ankle, fx, look.skin);
    limbPaint(a, [hip, knee, at(knee, ankle, 0.9)], [6, 5.4], look.gi);
  } else {
    footPaint(a, knee, ankle, fx, look.skin);
    limbPaint(a, [hip, knee, ankle], [5.2, 4.2], look.skin);
    limbPaint(a, [at(knee, ankle, 0.72), ankle], [4.8], look.wrap);
    limbPaint(a, [hip, at(hip, knee, 0.62)], [7.4], look.shorts);
  }
}

function paintArm(a, look, shoulder, elbow, hand) {
  if (look.style === 'gi') {
    limbPaint(a, [shoulder, elbow, at(elbow, hand, 0.72)], [4.6, 4.2], look.gi);
    blob(a, hand, 2.1, look.skin);
  } else {
    limbPaint(a, [shoulder, elbow, hand], [4, 3.4], look.skin);
    limbPaint(a, [at(elbow, hand, 0.55), hand], [3.9], look.wrap);
    blob(a, hand, 2.3, look.wrap);
  }
}

function paintTorso(a, look, hip, neck, head) {
  limbPaint(a, [neck, at(neck, head, 0.6)], [3], look.skin);
  if (look.style === 'gi') {
    limbPaint(a, [hip, at(hip, neck, 0.5), neck], [7.6, 8.6], look.gi);
    // Skin at the collar and a belt across the waist.
    a.strokeStyle = look.skin[1];
    a.lineWidth = 2;
    a.beginPath();
    const v = at(neck, hip, 0.22);
    a.moveTo(neck.x, neck.y);
    a.lineTo(v.x, v.y);
    a.stroke();
    const b = at(hip, neck, 0.14);
    const dx = neck.x - hip.x;
    const dy = neck.y - hip.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * 4.4;
    const py = (dx / len) * 4.4;
    a.strokeStyle = look.belt;
    a.lineWidth = 1.8;
    a.beginPath();
    a.moveTo(b.x - px, b.y - py);
    a.lineTo(b.x + px, b.y + py);
    a.moveTo(b.x, b.y);
    a.lineTo(b.x + px * 0.3 + (dx / len) * -3, b.y + py * 0.3 + (dy / len) * -3);
    a.stroke();
  } else {
    limbPaint(a, [hip, at(hip, neck, 0.5), neck], [6.6, 8.2], look.skin);
    limbPaint(a, [hip, at(hip, neck, 0.2)], [8], look.shorts);
  }
}

// Hand-drawn head, mirrored for facing and turned in quarter steps with the
// neck so a lying fighter's head lies down too.
function paintHead(a, look, neck, head, fx) {
  const map = look.head;
  const rows = map.length;
  const cols = map[0].length;
  const ang = Math.atan2(head.x - neck.x, -(head.y - neck.y));
  const q = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
  const cx = Math.round(head.x);
  const cy = Math.round(head.y);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ch = map[j][i];
      if (ch === '.') continue;
      let dx = i - (cols - 1) / 2;
      let dy = j - (rows - 1) / 2;
      if (fx < 0) dx = -dx;
      for (let r = 0; r < q; r++) [dx, dy] = [-dy, dx];
      a.fillStyle = look.headColors[ch];
      a.fillRect(Math.round(cx + dx), Math.round(cy + dy), 1, 1);
    }
  }
}

function paintTails(a, look, tails) {
  a.lineCap = 'round';
  a.lineJoin = 'round';
  for (const [color, w] of [[OUT, 3], [look.band[0], 1.4]]) {
    a.strokeStyle = color;
    a.lineWidth = w;
    a.beginPath();
    for (const chain of tails) {
      a.moveTo(chain[0].x, chain[0].y);
      for (let i = 1; i < chain.length; i++) a.lineTo(chain[i].x, chain[i].y);
    }
    a.stroke();
  }
}

// Paint the fighter into its art canvas. ox, oy = the sprite's screen origin.
function paintFighter(me, sp) {
  const a = sp.actx;
  const look = LOOKS[me.key];
  a.clearRect(0, 0, sp.aw, sp.ah);
  const T = (p) => ({ x: (p.x - sp.ox) / PIX, y: (p.y - sp.oy) / PIX });
  const s = {};
  for (const k in me.sk) s[k] = T(me.sk[k]);
  const fx = me.face * Math.cos(rad(me.pose.spin));

  if (me.tails) paintTails(a, look, me.tails.map((c) => c.map(T)));
  paintLeg(a, look, s.hip, s.bk, s.bfoot, fx);
  paintArm(a, look, s.bs, s.be, s.bh);
  paintTorso(a, look, s.hip, s.neck, s.head);
  paintHead(a, look, s.neck, s.head, fx);
  paintLeg(a, look, s.hip, s.fk, s.ffoot, fx);
  paintArm(a, look, s.fs, s.fe, s.fh);

  // Snap the figure's area to the palette: no soft edges, no blended colours.
  const b = bounds(me.sk);
  const x0 = clamp(Math.floor((b.x - sp.ox) / PIX) - 6, 0, sp.aw);
  const y0 = clamp(Math.floor((b.y - sp.oy) / PIX) - 6, 0, sp.ah);
  const x1 = clamp(Math.ceil((b.x + b.w - sp.ox) / PIX) + 6, 0, sp.aw);
  const y1 = clamp(Math.ceil((b.y + b.h - sp.oy) / PIX) + 6, 0, sp.ah);
  if (x1 <= x0 || y1 <= y0) return;
  const img = a.getImageData(x0, y0, x1 - x0, y1 - y0);
  const d = img.data;
  const flash = me.flash > 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 110) { d[i + 3] = 0; continue; }
    const c = nearest(look, d[i], d[i + 1], d[i + 2]);
    const white = flash && c !== look.palette[0];
    d[i] = white ? 255 : c[0];
    d[i + 1] = white ? 255 : c[1];
    d[i + 2] = white ? 255 : c[2];
    d[i + 3] = 255;
  }
  a.putImageData(img, x0, y0);
}

// Effects go on top of the snapped figure as whole art pixels.
function paintEffects(me, sp) {
  const a = sp.actx;
  const look = LOOKS[me.key];
  const px = (x, y, size = 1) => a.fillRect(Math.round((x - sp.ox) / PIX), Math.round((y - sp.oy) / PIX), size, size);
  a.fillStyle = look.trail;
  for (const p of me.trail) {
    a.globalAlpha = 0.7 * (1 - p.age / TRAIL_LIFE);
    px(p.x, p.y, 2);
  }
  for (const p of particles) {
    if (p.owner !== me) continue;
    const life = p.life / p.max;
    a.globalAlpha = life;
    a.fillStyle = p.color;
    if (p.type === 'spark') {
      px(p.x, p.y, 1);
      px(p.x - p.vx * 0.012, p.y - p.vy * 0.012, 1);
    } else if (p.type === 'drop') {
      a.globalAlpha = Math.min(1, life * 2);
      const big = p.color === BLOOD[0] || p.color === BLOOD[1];
      if (p.landed) px(p.x - PIX, p.y - PIX, big ? 3 : 2); // splat
      else {
        px(p.x, p.y, big ? 2 : 1);
        px(p.x - p.vx * 0.012, p.y - p.vy * 0.012, 1); // short streak behind it
      }
    } else if (p.type === 'star') {
      // Rays grow fast and fade; the first 40% has a solid core.
      const t = 1 - life;
      const len = 3 + t * 16 * p.size; // art px
      a.fillStyle = p.color;
      a.globalAlpha = life < 0.35 ? life / 0.35 : 1;
      if (t < 0.4) {
        const c = 1;
        for (let dx = -c; dx <= c; dx++) for (let dy = -c; dy <= c; dy++) if (Math.abs(dx) + Math.abs(dy) <= c + 1) px(p.x + dx * PIX, p.y + dy * PIX, 1);
      }
      for (let k = 0; k < 8; k++) {
        const t8 = (k / 8) * Math.PI * 2;
        const long = k % 2 === 0 ? 1 : 0.6; // alternate long and short rays
        for (let r = 3; r < len * long; r += 1) px(p.x + Math.cos(t8) * r * PIX, p.y + Math.sin(t8) * r * PIX, 1);
      }
    } else if (p.type === 'ring') {
      const r = (3 + (1 - life) * 15) * Z;
      for (let k = 0; k < 14; k++) {
        const t = (k / 14) * Math.PI * 2;
        px(p.x + Math.cos(t) * r, p.y + Math.sin(t) * r, 1);
      }
    } else {
      a.globalAlpha = life * 0.6;
      px(p.x, p.y, life > 0.5 ? 1 : 2);
    }
  }
  a.globalAlpha = 1;
}

// ---------- Sprite sheets ----------
// Hand-drawn frames (made with PixelLab) in src/sprites/<fighter>/<clip>/<n>.png,
// listed in src/sprites/manifest.json. All frames face right (east); facing
// left mirrors them. Until a fighter's frames are loaded it is painted by the
// procedural pixel renderer instead.
const SHEETS = {}; // fighter key -> { clipName: [{ img, foot }] }

// Which clip plays for each move. Moves without their own clip borrow the
// closest one.
// Muay Thai set: jab, straight, hook, knee, low, mid and high kick.
const MOVE_CLIPS = {
  jab: 'jabPro', groundPunch: 'jabPro', cross: 'straightPro', palm: 'straightPro',
  elbow: 'hookPro2', uppercut: 'hookPro2', spinFist: 'hookPro2',
  knee: 'knee', stomp: 'knee', flyingKick: 'knee',
  frontKick: 'frontKick', teep: 'teep', highKick: 'highKick', spinKick: 'highKick',
  lowKick: 'lowKick', sweep: 'lowKick', cartwheel: 'cartwheelKick',
};
// When a clip is not made yet, the closest one that exists plays instead.
const CLIP_FALLBACK = {
  jabPro: ['jab'], straightPro: ['straight', 'jab'], hookPro2: ['hook', 'straight', 'jab'],
  straight: ['jab'], hook: ['straight', 'jab'], knee: ['midKick', 'highKick'],
  lowKick: ['midKick', 'highKick'], midKick: ['highKick', 'lowKick'], highKick: ['midKick'],
  cartwheelKick: ['highKick'],
  frontKick: ['midKick', 'highKick'], teep: ['midKick', 'highKick'],
};
const LOOP_FPS = { stance: 8, run: 12, hit: 10 };

// Frames to play, in order, for clips whose raw frames hold the extended arm
// too long: a punch fires, lands and snaps straight back to guard.
// Only clearly different key poses, as in classic pixel fighting games. Per
// fighter, because each fighter's clips were generated separately.
const CLIP_FRAMES = {
  down: {
    jabPro: [0, 3, 7, 8],
    straightPro: [0, 2, 4, 7, 8],
    hookPro2: [0, 1, 4, 6, 8],
    lowKickV2: [0, 4, 6, 7, 8],
    midKickV2: [0, 2, 3, 7, 8],
    downV2: [0, 3, 4, 5, 6, 8],
    highKickV3: [0, 1, 4, 6, 7, 8],
    teep: [0, 2, 4, 7, 8],
    hit: [0, 3, 4, 5, 6, 8],
    getUp: [0, 2, 3, 4, 5, 6],
    block: [0, 2, 4, 6, 8],
    check: [0, 3, 5, 7, 8],
    sway: [0, 2, 4, 7, 8],
    duck: [0, 2, 3, 5, 7, 8],
  },
  up: {
    jabPro: [0, 2, 3, 0],
    straightPro: [0, 3, 4, 8],
    hookPro4: [0, 1, 2, 4, 7, 8],
    lowKickV2: [0, 4, 6, 7, 8],
    kneeV2: [0, 2, 3, 7, 8],
    downV2: [0, 2, 3, 4, 5, 8],
    highKickV3: [0, 2, 4, 6, 7, 8],
    midKickV3: [0, 2, 3, 5, 7, 8],
    gyakuZuki: [0, 3, 5, 8],
    maeGeri: [0, 3, 4, 6, 8],
    yokoGeri: [0, 3, 6, 7, 8],
    shuto: [0, 2, 5, 8],
    hit: [0, 4, 5, 6, 7, 8],
    getUp: [0, 2, 3, 4, 5, 6],
    block: [0, 2, 4, 7, 8],
    check: [0, 3, 5, 7, 8],
    sway: [0, 4, 5, 6, 8],
    duck: [0, 4, 5, 6, 8],
  },
};

// A fighter's own version of a shared clip name.
const CLIP_ALIAS = {
  // Red: Muay Thai. The front kick is his body roundhouse; the teep is its own clip.
  down: { lowKick: 'lowKickV2', midKick: 'midKickV2', frontKick: 'midKickV2', highKick: 'highKickV3', down: 'downV2' },
  // Blue: karate. Gyaku-zuki for straights, shuto for hooks and elbows,
  // mae-geri for front kicks, yoko-geri for push kicks, mawashi-geri otherwise.
  up: {
    straightPro: 'gyakuZuki', hookPro2: 'shuto', frontKick: 'maeGeri', teep: 'yokoGeri',
    lowKick: 'lowKickV2', midKick: 'midKickV3', highKick: 'highKickV3', knee: 'kneeV2', down: 'downV2',
  },
};

// First and last non-transparent rows: the top of the head and where the
// feet touch the floor.
function rows(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const filled = (y) => {
    for (let x = 0; x < img.width; x++) if (d[(y * img.width + x) * 4 + 3] >= 128) return true;
    return false;
  };
  let top = 0;
  while (top < img.height - 1 && !filled(top)) top++;
  let foot = img.height - 1;
  while (foot > 0 && !filled(foot)) foot--;
  // Frames face east. rear = leftmost and front = rightmost pixel touching the
  // floor (two lowest rows); reach = rightmost pixel anywhere (the strike).
  let rear = img.width - 1;
  let front = 0;
  for (const y of [foot, foot - 1]) {
    if (y < 0) continue;
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3] >= 128) { rear = Math.min(rear, x); front = Math.max(front, x); }
    }
  }
  let reach = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) reach = Math.max(reach, ((i - 3) / 4) % img.width);
  // Feet on the floor as separate patches (column runs in the two lowest rows),
  // each kept as [left, right] edges.
  const onFloor = [];
  for (let x = 0; x < img.width; x++) {
    onFloor[x] = [foot, foot - 1].some((y) => y >= 0 && d[(y * img.width + x) * 4 + 3] >= 128);
  }
  const feet = [];
  for (let x = 0; x < img.width; x++) {
    if (!onFloor[x]) continue;
    let e = x;
    while (e + 1 < img.width && (onFloor[e + 1] || (e + 2 < img.width && onFloor[e + 2]))) e++;
    feet.push([x, e]);
    x = e;
  }
  // low: [rear, front] edges over the lowest 4 rows, steadier for footwork.
  const low = [img.width - 1, 0];
  for (let y = Math.max(0, foot - 3); y <= foot; y++) {
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3] >= 128) { low[0] = Math.min(low[0], x); low[1] = Math.max(low[1], x); }
    }
  }
  return { top, foot, rear, front, reach, feet, low };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Per fighter: the clip whose frames widen the stance, and the frames used.
// widen: the lead foot steps out (rear foot planted).
// close: the rear foot follows (lead foot planted), ending on the stance.
// The generated close clips drift after frame 2 (red widens again, blue turns
// to the camera), so only their clean frames play; frame 8 is the stance.
const PUSH_STEP = {
  down: { widen: 'stepF', close: 'stepClose', closeFrames: [1, 2, 8] },
  up: { widen: 'stepB', close: 'stepClose', closeFrames: [1, 2, 8] },
};

async function loadSheets() {
  let manifest;
  try {
    manifest = await (await fetch('sprites/manifest.json')).json();
  } catch (err) {
    return; // no sprites yet: the procedural renderer stays
  }
  for (const [key, clips] of Object.entries(manifest)) {
    const sheet = {};
    for (const [name, count] of Object.entries(clips)) {
      try {
        const imgs = await Promise.all(Array.from({ length: count }, (_, i) => loadImage(`sprites/${key}/${name}/${i}.png`)));
        sheet[name] = imgs.map((img) => ({ img, ...rows(img) }));
      } catch (err) {
        console.error('sprite clip failed', key, name, err);
      }
    }
    // Newer clips start and end on the character's reference pose, so they
    // chain with every strike without a seam; they replace the old templates.
    for (const name of ['stance', 'hit', 'getUp']) if (sheet[name + 'V2']) sheet[name] = sheet[name + 'V2'];
    // Steps are a boxer's push-step: the stance widens (one foot slides out)
    // and closes again (the other foot follows). The clip that widens from
    // the reference stance differs per fighter.
    const ps = PUSH_STEP[key];
    if (ps && sheet[ps.widen] && sheet[ps.close]) {
      // Each frame records which foot is planted while it plays: 0 = rear
      // (lead foot moving), 1 = lead (rear foot moving). Copies, so the
      // source clips stay untouched.
      const widen = sheet[ps.widen].map((fr) => ({ ...fr, pin: 0 }));
      const close = ps.closeFrames.map((i) => ({ ...sheet[ps.close][i], pin: 1 }));
      sheet.stepF = widen.concat(close);
      sheet.stepB = sheet.stepF.slice().reverse(); // rear foot back first, then the lead follows
    }
    if (sheet.stance) SHEETS[key] = sheet;
  }
}

// The frames a fighter plays for a clip name, after its alias, fallbacks and
// chosen frame order, plus two facts measured from those frames:
//   anchor - the foot that stays on the floor ('rear' for punches, 'front' for
//            rear-leg kicks), which is the one pinned while the clip plays
//   impact - index of the frame where the strike reaches furthest forward
const CLIP_CACHE = new Map();
// Clips whose planted foot is not the one that moves least. Blue's duck steps
// the rear foot back while the body drops: holding the front foot keeps his
// body behind his own guard (holding the rear heel threw him into the
// attacker by up to 36 px).
const CLIP_ANCHOR = { up: { duck: 'front', block: 'front' } };
function clipFrames(me, name) {
  const sheet = SHEETS[me.key];
  if (!sheet || !name) return null;
  name = (CLIP_ALIAS[me.key] || {})[name] || name;
  const found = [name, ...(CLIP_FALLBACK[name] || [])].find((n) => sheet[n]);
  if (!found) return null;
  const key = me.key + ':' + found;
  if (CLIP_CACHE.has(key)) return CLIP_CACHE.get(key);
  const all = sheet[found];
  const order = ((CLIP_FRAMES[me.key] || {})[found] || []).filter((i) => i < all.length);
  const frames = order.length ? order.map((i) => all[i]) : all;
  // Follow one foot through the clip: each frame takes the floor patch nearest
  // to where that foot was in the previous frame.
  // The pin is the patch's outer edge: the heel for the rear foot, the toe for
  // the front foot. Outer edges stay put even when both feet merge into one patch.
  // When merged feet split into separate patches, the rear foot is the
  // leftmost patch and the front foot the rightmost (frames face east).
  const track = (start, edge) => {
    let cur = start;
    let prevCount = 0;
    return frames.map((f) => {
      if (f.feet.length) {
        const split = prevCount === 1 && f.feet.length > 1;
        const best = split
          ? (edge === 0 ? f.feet[0] : f.feet[f.feet.length - 1])
          : f.feet.reduce((a, b) => (Math.abs(b[edge] - cur) < Math.abs(a[edge] - cur) ? b : a));
        cur = best[edge];
        prevCount = f.feet.length;
      }
      return cur;
    });
  };
  const f0 = frames[0].feet;
  const rearTrack = track(f0.length ? f0[0][0] : frames[0].rear, 0);
  const frontTrack = track(f0.length ? f0[f0.length - 1][1] : frames[0].front, 1);
  const spread = (t) => Math.max(...t) - Math.min(...t);
  const forced = (CLIP_ANCHOR[me.key] || {})[found];
  const anchor = forced || (spread(rearTrack) <= spread(frontTrack) ? 'rear' : 'front');
  const pins = anchor === 'rear' ? rearTrack : frontTrack;
  // Impact is the furthest-reaching frame before recovery starts (first 60%).
  let impact = 0;
  const lastActive = Math.max(1, Math.ceil(frames.length * 0.6) - 1);
  frames.forEach((f, i) => { if (i <= lastActive && f.reach > frames[impact].reach) impact = i; });
  const clip = { frames, anchor, impact, pins, rearPins: rearTrack, frontPins: frontTrack };
  CLIP_CACHE.set(key, clip);
  return clip;
}

const moveName = (m) => Object.keys(MOVES).find((k) => MOVES[k] === m);

// Hip-to-hip distance at which this fighter's strike just touches the
// opponent: how far the fist or foot reaches past the hip at impact (with the
// planted foot pinned as drawn), plus how far the opponent's guard sticks out
// in front of its own hip. Null without sprites.
function idealDistance(me, opp, clip) {
  const mine = SHEETS[me.key];
  const theirs = SHEETS[opp.key];
  if (!clip || !mine || !theirs) return null;
  const base = mine.stance[0];
  const f = clip.frames[clip.impact];
  const k = clip.anchor === 'front' ? 'front' : 'rear';
  const ref = base.feet.length ? (k === 'front' ? base.feet[base.feet.length - 1][1] : base.feet[0][0]) : base[k];
  const tip = ref - base.img.width / 2 - clip.pins[clip.impact] + f.reach;
  const oppBase = theirs.stance[0];
  const guard = oppBase.reach - oppBase.img.width / 2;
  return (tip + guard - 3) * PIX; // overlap by 3 art px so the strike visibly lands
}

// [clip, frame] for the fighter's current state.
function pickFrame(me, sheet) {
  me.curClip = null; // set below by once(); loops are tracked through loopClip
  const loop = (name) => {
    const frames = sheet[name] || sheet.stance;
    const i = Math.floor(me.clock * (LOOP_FPS[name] || 8)) % frames.length;
    // Loops pin the foot tracked through the clip, so the planted foot never switches.
    const clip = clipFrames(me, sheet[name] ? name : 'stance');
    // The rear heel's outer edge over the lowest rows: steadier than the
    // tracked patch when the feet merge (which jumped the body 2 art px).
    if (clip) { me.loopAnchor = 'rear'; me.loopPin = frames[i].low ? frames[i].low[0] : clip.rearPins[i]; me.loopClip = clip; }
    return frames[i];
  };
  const once = (name, u) => {
    const clip = clipFrames(me, name);
    if (!clip) return null;
    const i = clamp(Math.floor(u * clip.frames.length), 0, clip.frames.length - 1);
    me.anchor = clip.anchor;
    me.pinX = clip.pins[i];
    me.rearPinX = clip.rearPins[i];
    me.curClip = clip;
    me.curFrame = i;
    return clip.frames[i];
  };
  switch (me.state) {
    case 'attack':
      return once(MOVE_CLIPS[moveName(me.move)], me.atkT / me.atkDur) || loop('stance');
    case 'run':
      return (sheet.run || sheet.stance)[Math.floor(me.phase / (Math.PI / 3)) % (sheet.run || sheet.stance).length];
    case 'hit':
      return once('hit', me.stateAge / 0.3) || loop('stance');
    case 'step':
      return once(me.stepDir > 0 ? 'stepF' : 'stepB', me.stateAge / (me.stepTime || STEP_TIME)) || loop('stance');
    // Defence plays once across the state's duration (elapsed + remaining).
    case 'block':
      return once('block', me.stateAge / (me.stateAge + me.timer)) || loop('stance');
    case 'blockLow':
      return once('check', me.stateAge / (me.stateAge + me.timer)) || loop('stance');
    case 'sway':
    case 'bend': {
      // Leaning back reads clearly against kicks; against punches to the
      // head the duck is what a viewer can actually see.
      const opp = me === red ? blue : red;
      // Duck only under a head kick from range; a duck under punches or up
      // close drops the body into the attacker.
      const headKick = opp.move && opp.move.aim === 'head' && LEGS[opp.move.limb];
      const roomToDuck = Math.abs(opp.x - me.x) >= DUCK_ROOM;
      return once(headKick && roomToDuck ? 'duck' : 'sway', me.stateAge / (me.stateAge + me.timer)) || loop('stance');
    }
    case 'duck': {
      const opp = me === red ? blue : red;
      const roomToDuck = Math.abs(opp.x - me.x) >= DUCK_ROOM;
      return once(roomToDuck ? 'duck' : 'sway', me.stateAge / (me.stateAge + me.timer)) || loop('stance');
    }
    case 'down':
      return once('down', me.stateAge / 0.4) || once('hit', 1) || loop('stance');
    case 'rise':
      return once('getUp', me.stateAge / (me.riseTime || RISE_TIME)) || loop('stance');
    case 'flip':
      return once('backflip', clamp(me.flipT / FLIP_TIME, 0, 1)) || loop('stance');
    case 'scene':
      if (scene && scene.a === me) return loop(sheet.jab ? 'jab' : 'stance');
      return loop(sheet.hit ? 'hit' : 'stance');
    default:
      return loop('stance');
  }
}

// Push-step placement. Stepping in: the lead foot slides out while the rear
// foot stays planted, then the rear foot slides up while the lead foot stays
// planted. Stepping back is the mirror: rear foot out first, lead follows.
// The planted foot is held at its exact screen position, so the body only
// moves through the legs.
function stepPlacement(me, sp, f, xPinned, mirrored) {
  const c = me.curClip;
  const i = me.curFrame;
  const mid = (c.frames.length - 1) / 2;
  const col = (fr, e) => (mirrored ? fr.img.width - 1 - e : e);
  const edge = c.frames[i].pin != null ? c.frames[i].pin : (me.stepDir > 0) === (i <= mid) ? 0 : 1; // 0 = rear foot, 1 = lead foot
  // Positions are kept in world px: the art canvas itself follows the hip.
  if (me.stepClip !== c) {
    me.stepClip = c;
    // Start from where the previous frame actually drew the feet (a stance,
    // or the end of the step before), so chained steps never pop.
    const chained = me.lastDraw && me.lastDraw.face === me.face && me.lastDraw.frame.low;
    me.stepXw = chained ? me.lastDraw.xw : sp.ox + xPinned * PIX;
    me.stepPrev = chained ? me.lastDraw.frame : f;
    me.stepEdge = null;
  }
  if (me.stepEdge !== edge) {
    // The planted foot changes: hold it where the last drawn frame put it.
    me.stepEdge = edge;
    me.stepWorld = me.stepXw + col(me.stepPrev, me.stepPrev.low[edge]) * PIX;
  }
  const x = Math.round((me.stepWorld - sp.ox) / PIX - col(f, f.low[edge]));
  const xw = sp.ox + x * PIX;
  me.x += xw - me.stepXw;
  me.stepXw = xw;
  me.stepPrev = f;
  return x;
}

// Draw the fighter's frame into its art canvas (1 sprite pixel = 1 art pixel).
function paintSheet(me, sp, sheet) {
  const a = sp.actx;
  a.clearRect(0, 0, sp.aw, sp.ah);
  const f = pickFrame(me, sheet);
  const { img, foot, top } = f;
  const fx = me.face; // sprites turn only by facing; the procedural spin never mirrors them
  if (me.state !== 'step') me.stepClip = null; // each step starts fresh
  const floorY = me.state === 'drag' || me.airborne ? lowestY(me.sk) : me.y;
  let x = Math.round((me.sk.hip.x - sp.ox) / PIX - img.width / 2);
  // During strikes and hits, the foot that stays on the floor is pinned where
  // that same foot stood in the stance; the clip's own motion moves the rest of
  // the body, so the fighter never floats or slides.
  // The stance is pinned by its rear foot too, so hand-overs between clips
  // never shift the body.
  const oneShot = ['attack', 'hit', 'down', 'rise', 'block', 'blockLow', 'sway', 'bend', 'duck', 'step'].includes(me.state)
    && !!me.curClip;
  if (!oneShot) {
    me.anchor = 'rear';
    me.pinX = me.loopPin != null ? me.loopPin : f.rear;
    me.rearPinX = me.pinX;
    me.curClip = me.loopClip;
  }
  const pinned = oneShot || ['guard', 'block', 'blockLow', 'sway', 'duck', 'bend', 'taichi', 'rest', 'land'].includes(me.state);
  const base = sheet.stance[0];
  if (pinned && base && !me.airborne) {
    const k = me.anchor === 'front' ? 'front' : 'rear';
    // The fighter's own position, not the procedural skeleton's hip: that
    // hip lunges with the old stick-figure poses, and the sprite clips carry
    // their own body motion.
    const hipArt = (me.x - sp.ox) / PIX;
    const mirrored = fx < 0;
    const ref = base.feet.length ? (k === 'front' ? base.feet[base.feet.length - 1][1] : base.feet[0][0]) : base[k];
    const stanceFoot = hipArt - base.img.width / 2 + (mirrored ? base.img.width - 1 - ref : ref);
    x = Math.round(stanceFoot - (mirrored ? img.width - 1 - me.pinX : me.pinX));
    // Whenever the playing clip changes (stance to strike, strike to stance,
    // knockdown to getting up, ...), the rear heel stays exactly where the
    // previous frame left it: the fighter's position absorbs the difference,
    // so no hand-over can make the body jump.
    const rearWorld = (fx0, frame) => sp.ox + (fx0 + (mirrored ? frame.img.width - 1 - me.rearPinX : me.rearPinX)) * PIX;
    if (me.curClip !== me.lastClip && me.lastRear != null) {
      const shift = me.lastRear - rearWorld(x, f);
      if (Math.abs(shift) < 60 * Z) {
        me.x += shift;
        x = Math.round(x + shift / PIX);
      }
    }
    if (me.state === 'step') x = stepPlacement(me, sp, f, x, mirrored);
    me.lastDraw = { xw: sp.ox + x * PIX, frame: f, face: me.face };
    me.lastRear = rearWorld(x, f);
    me.lastClip = me.curClip;
  } else if (me.state === 'run' && !me.airborne) {
    // Running is centred on the hip (the legs cycle), but its rear heel is
    // remembered so stopping hands over to the stance without a jump.
    const heel = f.feet.length ? f.feet[0][0] : f.rear;
    me.rearPinX = heel;
    me.lastRear = sp.ox + (x + (fx < 0 ? img.width - 1 - heel : heel)) * PIX;
    me.lastClip = 'run';
  } else {
    me.lastRear = null;
    me.lastClip = null;
  }
  if (!pinned || !base || me.airborne) me.lastDraw = null;
  const y = Math.round((floorY - sp.oy) / PIX - foot - 1);
  me.labelY = sp.oy + (y + top) * PIX; // speed label sits above the sprite
  if (FIGHT_TEST && f.low) {
    // Foot trace for validation: world x of both foot edges as drawn.
    const col = (e) => (fx < 0 ? img.width - 1 - e : e);
    const r = sp.ox + (x + col(f.low[0])) * PIX;
    const q = sp.ox + (x + col(f.low[1])) * PIX;
    footTrace.push(`${me.key[0]},${me.state},${Math.round(fightClock * 1000)},${Math.round(Math.min(r, q))},${Math.round(Math.max(r, q))},${me.curClip ? me.curFrame : -1}`);
  }
  a.save();
  if (fx < 0) {
    a.translate(x * 2 + img.width, 0);
    a.scale(-1, 1);
  }
  a.drawImage(img, x, y);
  a.restore();
}

// When the fighters stand close, labels split apart from the midpoint so
// they never overlap.
const STAMINA_BAR_W = 44;
function drawLabel(me, opp, box) {
  const text = me.arrow + ' ' + fmt(speed[me.key]) + '  Lv ' + fighterLevel(me);
  let x = me.sk.hip.x;
  ctx.textAlign = 'center';
  if (Math.abs(opp.x - me.x) < 100) {
    const mid = (me.x + opp.x) / 2;
    const left = me.x < opp.x || (me.x === opp.x && me === red);
    x = left ? mid - 4 : mid + 4;
    ctx.textAlign = left ? 'right' : 'left';
  }
  const y = box.y - 6;
  ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = me.color;
  ctx.fillText(text, x, y);
  // Thin stamina bar under the label, aligned like the text: green, amber
  // under half, red under 30%, flashing while gassed (it hit 0).
  const r = staminaRatio(me);
  const bx = ctx.textAlign === 'center' ? x - STAMINA_BAR_W / 2 : ctx.textAlign === 'right' ? x - STAMINA_BAR_W : x;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(bx - 1, y + 2, STAMINA_BAR_W + 2, 4);
  if (!me.gassed || Math.floor(performance.now() / 250) % 2) {
    ctx.fillStyle = r < TIRED ? '#e53935' : r < 0.5 ? '#ffb300' : '#43a047';
    ctx.fillRect(bx, y + 3, Math.max(me.gassed ? 2 : 0, Math.round(STAMINA_BAR_W * r)), 2);
  }
}

function render() {
  for (const f of fighters) {
    const s = f.sprite;
    // Whole art pixels only, so the picture does not shimmer as it moves.
    const ox = Math.round((f.sk.hip.x - SPRITE_W / 2) / PIX) * PIX;
    const oy = Math.round((f.sk.hip.y - SPRITE_ABOVE_HIP) / PIX) * PIX;
    const [jx, jy] = joltOffset(f);
    if (ox !== s.ox || oy !== s.oy || jx !== s.jx || jy !== s.jy) {
      s.ox = ox;
      s.oy = oy;
      s.jx = jx;
      s.jy = jy;
      s.c.style.transform = `translate(${ox + jx}px, ${oy + jy - view.top}px)`;
    }
    s.c.style.zIndex = f.state === 'attack' || f.state === 'scene' ? '2' : '1';
    if (SHEETS[f.key]) paintSheet(f, s, SHEETS[f.key]);
    else paintFighter(f, s);
    if (f.ghostDue) {
      f.ghostDue = false;
      const c = document.createElement('canvas');
      c.width = s.aw;
      c.height = s.ah;
      c.getContext('2d').drawImage(s.art, 0, 0);
      f.ghosts.push({ c, ox, oy, age: 0 });
    }
    paintEffects(f, s);

    ctx = s.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
    ctx.imageSmoothingEnabled = false;
    for (const g of f.ghosts) {
      ctx.globalAlpha = 0.3 * (1 - g.age / GHOST_LIFE);
      ctx.drawImage(g.c, g.ox - ox, g.oy - oy, SPRITE_W, SPRITE_H);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(s.art, 0, 0, SPRITE_W, SPRITE_H);
    ctx.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr);
    const box = bounds(f.sk);
    if (SHEETS[f.key] && f.labelY) box.y = Math.min(box.y, f.labelY - 2);
    drawLabel(f, f === red ? blue : red, box);
    if (SHOWCASE && f === red) {
      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffeb3b';
      ctx.fillText(show.label, f.sk.hip.x - 150, ground() - 200);
    }
  }
}

// ---------- Dragging and click-through ----------
// The window ignores the mouse except while the cursor is over a fighter.
let drag = null;
let passThrough = true;
const setCursor = (c) => { document.documentElement.style.cursor = c; };

function fighterAt(x, y) {
  for (const f of [red, blue]) {
    if (!f.sk) continue;
    const b = bounds(f.sk);
    if (x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6) return f;
  }
  return null;
}

window.addEventListener('pointerdown', (e) => {
  if (panel.contains(e.target)) return;
  const f = fighterAt(e.clientX, e.clientY + view.top);
  if (!f) return;
  if (scene && (scene.a === f || scene.b === f)) endScene();
  document.documentElement.setPointerCapture(e.pointerId);
  f.state = 'drag';
  f.queue = [];
  f.airborne = false;
  f.vx = f.vy = 0;
  f.timer = 0;
  drag = { f, x: e.clientX, y: e.clientY + view.top, t: performance.now(), vx: 0, vy: 0 };
  setCursor('grabbing');
  setView(true);
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const now = performance.now();
  const dt = Math.max(1, now - drag.t) / 1000;
  drag.vx = drag.vx * 0.5 + ((e.clientX - drag.x) / dt) * 0.5;
  const y = e.clientY + view.top;
  if (viewBusy) return; // the offset is changing; skip one sample
  drag.vy = drag.vy * 0.5 + ((y - drag.y) / dt) * 0.5;
  drag.x = e.clientX;
  drag.y = y;
  drag.t = now;
});

function release() {
  if (!drag) return;
  const f = drag.f;
  // A mouse that stopped before letting go should not throw.
  const still = performance.now() - drag.t > 80;
  f.state = 'air';
  f.airborne = true;
  f.vx = still ? 0 : clamp(drag.vx, -1500, 1500);
  f.vy = still ? 0 : clamp(drag.vy, -1500, 1500);
  drag = null;
  setCursor('grab');
}
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

// ---------- Hover and info panel ----------
// Mouse over a fighter: the fight eases into slow motion. Keep it there for
// HOVER_OPEN_MS and an info panel opens above that fighter: live traffic and
// this session's record. Level, XP and stats are rendered by Progress.panel
// (src/progression.js), which also handles the + buttons.
const PANEL_REFRESH_MS = 500;
const HOVER_SLOW = 0.25;
const HOVER_OPEN_MS = 2000;
const PANEL_CLOSE_MS = 600;
const PANEL_SWITCH_MS = 500; // rest on the other fighter this long to switch the open panel to it
const panel = document.getElementById('info');
let hoverF = null;
let hoverSince = 0;
let hoverBlocked = false; // after closing, the mouse must leave before it reopens
let hoverScale = 1;
let overPanel = false;
let panelF = null;
let panelAwaySince = 0;
let panelTimer = 0;

// This session's record per fighter, counted in impact().
for (const f of fighters) f.record = { thrown: 0, landed: 0, blocked: 0, knockdowns: 0 };

const STYLE = { down: 'Muay Thai', up: 'Karate' };

function renderPanel() {
  const f = panelF;
  Progress.panel.render(panel, f, {
    name: f === red ? 'Red' : 'Blue',
    style: STYLE[f.key],
    role: f === red ? 'download' : 'upload',
    traffic: fmt(speed[f.key]),
    pct: Math.round(100 * power(f)),
    status: f === leader ? 'Leading' : leader ? 'Trailing' : 'Even',
    record: f.record,
  });
}

panel.addEventListener('click', (e) => Progress.panel.click(e, panelF, closePanel, renderPanel));

// The panel needs room above the fighter, so the window grows to full height
// while it is open.
// Test modes log panel events, so the hover panel can be checked from a log.
const panelMark = (text) => {
  if (HOVER_FAKE) invoke('showcase_mark', { label: `PANEL ${text}` }).catch(() => {});
};

function openPanel(f) {
  panelMark(`open ${f.key}`);
  panelF = f;
  renderPanel();
  panel.hidden = false;
  panelAwaySince = performance.now();
  clearInterval(panelTimer);
  panelTimer = setInterval(() => panelF && renderPanel(), PANEL_REFRESH_MS);
  setView(true);
}

function closePanel() {
  panelMark('close');
  panelF = null;
  clearInterval(panelTimer);
  panel.hidden = true;
  overPanel = false;
  hoverBlocked = true;
}

function placePanel() {
  if (!panelF || !panelF.sk) return;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const x = clamp(panelF.sk.hip.x - w / 2, 8, W - w - 8);
  const y = Math.max(8, bounds(panelF.sk).y - view.top - h - 22);
  panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function inRect(r, x, y, pad) {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

// Test hook: NETBATTLE_BUILD="hover=left" or "hover=right" holds a fake cursor
// on the fighter standing on that side of the screen, so the hover panel can
// be checked without a mouse.
let HOVER_FAKE = null;
const fakeStart = performance.now();
function fakeCursor() {
  const [a, b] = red.x <= blue.x ? [red, blue] : [blue, red];
  // 'swap': left for the first 7 s (the panel opens), then right.
  const f = HOVER_FAKE === 'left' || (HOVER_FAKE === 'swap' && performance.now() < 7000 + fakeStart) ? a : b;
  return [f.x, ground() - 60 - view.top];
}

async function pollCursor() {
  try {
    if (!drag) {
      const p = HOVER_FAKE ? fakeCursor() : await invoke('cursor_pos');
      if (p) {
        const now = performance.now();
        const f = fighterAt(p[0], p[1] + view.top);
        overPanel = !panel.hidden && inRect(panel.getBoundingClientRect(), p[0], p[1], 6);
        if (f !== hoverF) {
          hoverF = f;
          hoverSince = now;
          hoverBlocked = false; // moving to another fighter (or off) lifts the block
        }
        if (hoverF && !hoverBlocked && !panelF && !viewBusy && now - hoverSince >= HOVER_OPEN_MS) openPanel(hoverF);
        if (panelF) {
          // Resting on the other fighter moves the panel to it.
          if (hoverF && hoverF !== panelF && now - hoverSince >= PANEL_SWITCH_MS) {
            panelF = hoverF;
            renderPanel();
            panelMark(`switch to ${panelF.key}`);
          }
          if (hoverF || overPanel) panelAwaySince = now;
          else if (now - panelAwaySince > PANEL_CLOSE_MS) closePanel();
        }
        const over = !!f || overPanel;
        setCursor(f ? 'grab' : 'default');
        if (over === passThrough) {
          passThrough = !over;
          await invoke('set_click_through', { enabled: passThrough });
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
  setTimeout(pollCursor, POLL_MS);
}

// ---------- Showcase (debug) ----------
// Set NETBATTLE_SHOWCASE=1 before starting the app: red performs every move,
// then blue, each from a fixed distance with no defence, so every animation
// (and the hit, knockdown and getting up it causes) can be captured and checked.
let SHOWCASE = false;
// NETBATTLE_SHOWCASE=fight: the normal fight, with fixed fake traffic that
// cycles every 15 s (red dominant, blue dominant, close race).
let FIGHT_TEST = false;
const fightTest = { mark: 0 };
const footTrace = [];
// Why a fighter is not acting: its cooldown, combo timer, footwork target and
// the closest strike distance.
function dbgFighter(f) {
  const o = f === red ? blue : red;
  const ideals = STRIKES.map((n) => strikeIdeal(f, o, n)).filter((v) => v != null);
  const best = ideals.length ? Math.min(...ideals) : NaN;
  const hb = bounds(f.sk); const at = fighterAt(f.x, ground() - 60);
  return `${f.key}[hit=${at ? at.key : 'none'} box=${Math.round(hb.x)}..${Math.round(hb.x + hb.w)} x=${Math.round(f.x)} cool=${f.cool.toFixed(1)} combo=${f.comboUntil ? (f.comboUntil - fightClock).toFixed(1) : '-'} want=${(+f.want).toFixed(0)} rest=${(f.stepRest || 0).toFixed(1)} minIdeal=${best.toFixed(0)}]`;
}
function stepFightTest(dt) {
  const phase = Math.floor(fightClock / 15) % 3;
  const [down, up] = [[2e6, 5e4], [5e4, 2e6], [4e5, 3e5]][phase];
  speed.down = down;
  speed.up = up;
  updateLeader();
  fightTest.mark -= dt;
  if (fightTest.mark <= 0) {
    fightTest.mark = 3;
    const info = canStep(red) && canStep(blue) ? ` d=${Math.abs(red.x - blue.x).toFixed(0)} engage=${ENGAGE.toFixed(0)} len=${stepLength(red).toFixed(0)}/${stepLength(blue).toFixed(0)} states=${red.state}/${blue.state} leader=${leader ? leader.key : 'none'} x=${red.x.toFixed(0)}/${blue.x.toFixed(0)} W=${W} ${fighters.map(dbgFighter).join(' ')}` : ' nostep';
    invoke('showcase_mark', { label: `BOTH ${['red-leads', 'blue-leads', 'close'][phase]}${info}` }).catch(() => {});
    invoke('showcase_mark', { label: `TRACE ${footTrace.splice(0).join(';')}` }).catch(() => {});
    // Stamina per fighter; spent (own strikes and steps) and taken (from the
    // opponent's strikes) are cumulative, for tools/leveling_check.py.
    const st = (f) => {
      const b = buildOf(f);
      return `${f.key}[st=${f.stamina.toFixed(0)}/${f.staminaMax} r=${staminaRatio(f).toFixed(2)} g=${f.gassed ? 1 : 0} b=${b.speed},${b.stamina},${b.strength} lv=${fighterLevel(f)} spent=${f.spent.toFixed(0)} taken=${f.taken.toFixed(0)}]`;
    };
    invoke('showcase_mark', { label: `STAMINA ${fighters.map(st).join(' ')}` }).catch(() => {});
  }
}
const SHOW_MOVES = ['jab', 'cross', 'elbow', 'uppercut', 'knee', 'lowKick', 'frontKick', 'teep', 'highKick', 'spinKick', 'sweep', 'palm', 'spinFist'];
// NETBATTLE_SHOWCASE=contact: the showcase, but every strike starts from its
// contact distance and the picture freezes at impact for capture.
let CONTACT = false;
const show = { i: -1, t: 0, label: '' };

function stepShowcase(dt) {
  speed.down = speed.up = 2e6;
  leader = null;
  if (show.pending && (show.wait -= dt) <= 0) {
    const { attacker, target, m } = show.pending;
    if (CONTACT && !show.placed) {
      // Move to the live contact distance, then let one guard frame draw
      // there before striking (the hand-over keeps the drawn rear heel).
      const name = moveName(m);
      const d = Math.abs(target.x - attacker.x);
      attacker.x += attacker.face * (d - strikeIdeal(attacker, target, name));
      attacker.lastRear = null;
      attacker.lastDraw = null;
      show.placed = true;
      show.wait = 0.15;
      return;
    }
    show.placed = false;
    show.pending = null;
    startMove(attacker, target, m);
    attacker.defense = null;
  }
  show.t -= dt;
  if (show.t > 0) return;
  show.i = (show.i + 1) % (SHOW_MOVES.length * 2);
  const attacker = show.i < SHOW_MOVES.length ? red : blue;
  const target = attacker === red ? blue : red;
  const name = SHOW_MOVES[show.i % SHOW_MOVES.length];
  const m = MOVES[name];
  red.x = W - 320;
  blue.x = red.x + clamp(m.reach - 8 * Z, 34 * Z, 60 * Z);
  // Contact mode: start near the strike's reference contact distance; it is
  // refined from the drawn pose just before the strike (see above).
  if (CONTACT) {
    const ideal = idealDistance(attacker, target, clipFrames(attacker, MOVE_CLIPS[name]));
    if (ideal != null) blue.x = red.x + ideal;
  }
  for (const f of fighters) {
    f.state = 'guard'; f.timer = 0; f.vx = 0; f.queue = []; f.cool = 99; f.airborne = false; f.flash = 0;
  }
  red.face = 1;
  blue.face = -1;
  // Stand in guard for half a second first, so the stance-to-strike hand-over
  // is part of what gets recorded and checked.
  show.pending = { attacker, target, m };
  show.wait = 0.5;
  show.label = `${attacker === red ? 'RED' : 'BLUE'} ${name}`;
  invoke('showcase_mark', { label: show.label }).catch(() => {});
  show.t = (m.low ? 3.6 : 2.0) + 0.5;
}

// ---------- Start ----------
window.addEventListener('resize', resize);
resize();

listen('net', (e) => {
  Progress.onNet(e.payload); // XP from the cumulative byte totals
  if (FIGHT_TEST || SHOWCASE) return; // test modes set their own traffic
  // Smooth over about two seconds so the leader does not flicker.
  speed.down += (e.payload.down - speed.down) * 0.3;
  speed.up += (e.payload.up - speed.up) * 0.3;
  updateLeader();
});

let last = 0;
let frameErrors = 0;
function frame() {
  try {
    frameBody();
  } catch (err) {
    // Report the first few errors to the app log (stderr), not every frame.
    if (frameErrors++ < 5) invoke('showcase_mark', { label: `ERROR ${err && err.stack ? err.stack : err}` }).catch(() => {});
  }
}
function frameBody() {
  const now = performance.now();
  const realDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Hovering slows the fight; bullet time can slow it further.
  const slowTarget = (hoverF || overPanel || panelF) && !drag ? HOVER_SLOW : 1;
  hoverScale += (slowTarget - hoverScale) * Math.min(1, realDt * 6);
  const scale = Math.min(timeScale(realDt), hoverScale);
  const dt = realDt * scale;
  Progress.tick(realDt);
  const frozen = stop > 0;
  if (frozen) {
    stop -= dt;
  } else {
    fightClock += dt;
    if (SHOWCASE) stepShowcase(dt);
    if (FIGHT_TEST) stepFightTest(dt);
    stepScene(dt);
    update(red, blue, dt);
    update(blue, red, dt);
    separate();
  }
  for (const f of fighters) {
    if (!frozen || f.state === 'drag') animate(f, dt);
    layout(f, f === red ? blue : red, dt);
    stepTails(f, dt);
    stepTrail(f, dt);
    stepGhosts(f, realDt, bullet >= 0);
    if (!frozen) stepJolt(f, dt);
  }
  stepParticles(dt);
  updateView(realDt);
  render();
  placePanel();
}

(async function start() {
  await Progress.init();
  try {
    HOVER_FAKE = ((await invoke('test_build')).match(/hover=(left|right|swap)/) || [])[1] || null;
  } catch (err) {
    HOVER_FAKE = null;
  }
  try {
    const mode = await invoke('showcase');
    FIGHT_TEST = mode === 'fight';
    CONTACT = mode === 'contact';
    SHOWCASE = !!mode && !FIGHT_TEST;
  } catch (err) {
    SHOWCASE = false;
  }
  // A solid backdrop makes showcase screen captures easy to analyse.
  if (SHOWCASE || FIGHT_TEST) document.body.style.background = '#1e1e1e';
  viewFull = true; // force the first setView to apply
  await setView(false);
  red.x = W - 280;
  blue.x = W - 205;
  red.y = blue.y = ground();
  loadSheets();
  last = performance.now();
  setInterval(frame, 1000 / FPS);
  pollCursor();
})();
