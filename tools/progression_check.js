'use strict';
// Checks the leveling table and knockout rules in src/progression.js.
// Run: node tools/progression_check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const saves = [];
const ctx = {
  window: {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === 'save_progress') saves.push(args.json);
          return '';
        },
      },
    },
  },
  Math: Object.create(Math),
  console,
};
ctx.Math.random = () => 0.999;
vm.createContext(ctx);
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'progression.js'), 'utf8');
const P = vm.runInContext(code + '\nProgress;', ctx);
const I = P._internals;
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

(async () => {
  await P.init();
  assert.strictEqual(P.testMode, false);

  // Cost table.
  near(I.cost(1), 5);
  near(I.cost(10), 50);
  near(I.cost(11), 68.75);
  near(I.cost(19), 308.75);
  let total = 0;
  for (let n = 1; n < 20; n++) total += I.cost(n);
  near(total, 1868.75);
  near(I.cum[19] / I.GIB, 1868.75);
  near(I.cum[10] / I.GIB, 275);

  // Level from bytes.
  const L = (g) => I.levelFromBytes(g * I.GIB);
  assert.strictEqual(L(0), 1);
  assert.strictEqual(L(4.99), 1);
  assert.strictEqual(L(5), 2);
  assert.strictEqual(L(275), 11);
  assert.strictEqual(L(1868.74), 19);
  assert.strictEqual(L(1868.75), 20);
  assert.strictEqual(L(99999), 20);

  // Points math and spending.
  const red = { key: 'down', color: '#e53935' };
  const blue = { key: 'up', color: '#1e88e5' };
  I.extra.down.session = 275 * I.GIB; // level 11 = 10 points
  assert.strictEqual(P.level(red), 11);
  assert.strictEqual(P.unspent(red), 10);
  for (let i = 0; i < 10; i++) assert.strictEqual(P.spendPoint(red, 'speed'), true);
  assert.strictEqual(P.build(red).speed, 10);
  assert.strictEqual(P.unspent(red), 0);
  assert.strictEqual(P.spendPoint(red, 'speed'), false, 'no points left');
  I.extra.down.session = 2000 * I.GIB; // level 20 = 19 points
  assert.strictEqual(P.unspent(red), 9);
  assert.strictEqual(P.spendPoint(red, 'speed'), false, 'cap 10');
  assert.strictEqual(P.spendPoint(red, 'nonsense'), false);
  assert.strictEqual(P.spendPoint(red, 'strength'), true);
  assert(saves.length >= 11, 'each spend saves');

  // Knockout: loses a point, vanishing, protection.
  const before = { lvl: P.level(red), unspent: P.unspent(red), speed: P.build(red).speed, strength: P.build(red).strength };
  P.onKnockout(red, blue);
  const s = I.state.down;
  assert.strictEqual(s.lost, 1);
  assert.strictEqual(s.protectLeft, 15 * 60);
  assert.strictEqual(P.build(red).speed + P.build(red).strength, before.speed + before.strength - 1);
  assert.strictEqual(P.unspent(red), before.unspent, 'the point vanishes, unspent unchanged');
  assert.strictEqual(P.level(red), before.lvl);
  // random 0.999 picks the last stat with points (strength).
  assert.strictEqual(P.build(red).strength, before.strength - 1);

  // Protected: nothing happens.
  const sp = P.build(red).speed;
  P.onKnockout(red, blue);
  assert.strictEqual(s.lost, 1);
  assert.strictEqual(P.build(red).speed, sp);

  // Protection counts down with tick.
  P.tick(60);
  near(s.protectLeft, 14 * 60);
  P.tick(14 * 60 + 5);
  assert.strictEqual(s.protectLeft, 0);
  const n = saves.length;
  P.onKnockout(red, blue);
  assert.strictEqual(s.lost, 2);
  assert(saves.length > n, 'knockout saves at once');

  // Zero points: nothing lost, no protection.
  assert.strictEqual(P.build(blue).speed + P.build(blue).stamina + P.build(blue).strength, 0);
  P.onKnockout(blue, red);
  assert.strictEqual(I.state.up.lost, 0);
  assert.strictEqual(I.state.up.protectLeft, 0);

  // Periodic save every 30 s.
  const m = saves.length;
  P.tick(31);
  assert.strictEqual(saves.length, m + 1);

  // Saved JSON shape.
  const j = JSON.parse(saves[saves.length - 1]);
  assert.deepStrictEqual(Object.keys(j.down).sort(), ['build', 'bytes', 'lost', 'protectLeft']);

  console.log('progression_check: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
