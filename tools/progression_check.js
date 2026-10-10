'use strict';
// Checks the leveling table and knockout rules in src/progression.js.
// Run: node tools/progression_check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// A fresh Progress instance. `file` is what load_progress returns; `opts.showcase`
// makes it a test mode; `opts.build` is the NETBATTLE_BUILD text.
function make(file, opts = {}) {
  const saves = [];
  const calls = [];
  const ctx = {
    window: {
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            calls.push(cmd);
            if (cmd === 'save_progress') saves.push(args.json);
            if (cmd === 'load_progress') return file == null ? '' : file;
            if (cmd === 'showcase') return opts.showcase || '';
            if (cmd === 'test_build') return opts.build || '';
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
  const P = vm.runInContext(code + '\nProgress;', ctx);
  return { P, I: P._internals, saves, calls, ctx };
}
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'progression.js'), 'utf8');
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const GIB = 1024 ** 3;
// Objects from the vm context have another prototype: compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const { P, I, saves } = make('');
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
  // Fighter objects as main.js builds them: slot and char (older code: key only).
  const red = { slot: 'down', char: 'red', color: '#e53935' };
  const blue = { slot: 'up', char: 'blue', color: '#1e88e5' };
  assert.strictEqual(P.char({ key: 'down' }), 'red', 'old key down maps to red');
  assert.strictEqual(P.char({ key: 'up' }), 'blue', 'old key up maps to blue');
  assert.strictEqual(P.level({ key: 'up' }), 1);
  I.extra.red.session = 275 * I.GIB; // level 11 = 10 points
  assert.strictEqual(P.level(red), 11);
  assert.strictEqual(P.unspent(red), 10);
  for (let i = 0; i < 10; i++) assert.strictEqual(P.spendPoint(red, 'speed'), true);
  assert.strictEqual(P.build(red).speed, 10);
  assert.strictEqual(P.unspent(red), 0);
  assert.strictEqual(P.spendPoint(red, 'speed'), false, 'no points left');
  I.extra.red.session = 2000 * I.GIB; // level 20 = 19 points
  assert.strictEqual(P.unspent(red), 9);
  assert.strictEqual(P.spendPoint(red, 'speed'), false, 'cap 10');
  assert.strictEqual(P.spendPoint(red, 'nonsense'), false);
  assert.strictEqual(P.spendPoint(red, 'strength'), true);
  assert(saves.length >= 11, 'each spend saves');

  // Knockout: loses a point, vanishing, protection.
  const before = { lvl: P.level(red), unspent: P.unspent(red), speed: P.build(red).speed, strength: P.build(red).strength };
  P.onKnockout(red, blue);
  const s = I.state.red;
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
  assert.strictEqual(I.state.blue.lost, 0);
  assert.strictEqual(I.state.blue.protectLeft, 0);

  // Periodic save every 30 s.
  const m = saves.length;
  P.tick(31);
  assert.strictEqual(saves.length, m + 1);

  // Saved JSON shape.
  const j = JSON.parse(saves[saves.length - 1]);
  assert.strictEqual(j.version, 2);
  assert.deepStrictEqual(Object.keys(j).sort(), ['bench', 'chars', 'slots', 'version']);
  assert.deepStrictEqual(Object.keys(j.chars).sort(), ['blue', 'red', 'thales']);
  assert.deepStrictEqual(Object.keys(j.chars.red).sort(), ['build', 'bytes', 'lost', 'protectLeft']);
  assert.deepStrictEqual(j.slots, { down: 'red', up: 'blue' });
  assert.deepStrictEqual(j.bench, ['thales']);
  assert.strictEqual(JSON.stringify(j).includes('red2'), false, 'the debug copy is never saved');


  // ---------- Per-character state ----------
  {
    const t = make('');
    await t.P.init();
    const R = { slot: 'down', char: 'red' };
    const B = { slot: 'up', char: 'blue' };
    const T = { slot: 'down', char: 'thales' };
    t.I.extra.red.session = 100 * GIB;
    t.I.extra.thales.session = 275 * GIB; // level 11
    t.P.spendPoint(R, 'speed');
    t.P.spendPoint(T, 'strength');
    assert.strictEqual(t.P.build(R).speed, 1);
    assert.strictEqual(t.P.build(T).speed, 0, 'thales has his own build');
    assert.strictEqual(t.P.build(T).strength, 1);
    assert.strictEqual(t.P.level(R), t.I.levelFromBytes(100 * GIB));
    assert.strictEqual(t.P.level(T), 11);
    assert.strictEqual(t.P.level(B), 1);
    // The same fighter object changes character: everything follows f.char.
    const f = { slot: 'down', char: 'red' };
    assert.strictEqual(t.P.level(f), t.P.level(R));
    f.char = 'thales';
    assert.strictEqual(t.P.level(f), 11);
    assert.strictEqual(t.P.build(f).strength, 1);
    assert.strictEqual(t.P.name(f), 'Thales');
    assert.strictEqual(t.P.roleOf(f), 'download');
    assert.strictEqual(t.P.roleOf(B), 'upload');
    // A knockout takes a point from the victim's character, in whichever slot.
    t.P.onKnockout(f, B);
    assert.strictEqual(t.I.state.thales.lost, 1);
    assert.strictEqual(t.I.state.red.lost, 0, 'red is untouched');
    assert.strictEqual(t.I.state.thales.protectLeft, 900);
    assert.strictEqual(t.I.state.red.protectLeft, 0);
    // Protection of a benched character still counts down.
    t.P.tick(100);
    near(t.I.state.thales.protectLeft, 800);
    // The debug copy has its own state and is not saved.
    const R2 = { slot: 'up', char: 'red2' };
    assert.strictEqual(t.P.level(R2), 1);
    assert.strictEqual(t.P.name(R2), 'Red 2');
    // An unknown char falls back to the old key map, never throws.
    assert.strictEqual(t.P.char({ char: 'nobody', slot: 'up' }), 'blue');
    assert.strictEqual(t.P.char({}), 'red');
    assert.strictEqual(t.P.char(null), 'red');
    // Test build text can set any character, including the copy.
    const tb = make('', { showcase: 'fight', build: 'red=3,2,1;blue=0,0,0;thales=10,0,0;red2=1,1,1;hover=left' });
    await tb.P.init();
    assert.strictEqual(tb.P.testMode, true);
    assert.deepStrictEqual(plain(tb.P.build({ char: 'red' })), { speed: 3, stamina: 2, strength: 1 });
    assert.strictEqual(tb.P.level({ char: 'red' }), 7);
    assert.strictEqual(tb.P.level({ char: 'thales' }), 11);
    assert.strictEqual(tb.P.level({ char: 'red2' }), 4);
    assert.strictEqual(tb.P.level({ char: 'blue' }), 1);
  }

  // ---------- A swap credits bytes to the right character ----------
  {
    const t = make('');
    await t.P.init();
    const gb = (g) => g * GIB;
    // Red (down) and blue (up) fight; cumulative totals per slot.
    t.P.onNet({ downTotal: gb(3), upTotal: gb(1) });
    near(t.I.totalBytes('red'), gb(3));
    near(t.I.totalBytes('blue'), gb(1));
    // Red is knocked out: thales enters the download slot. Totals keep growing.
    t.P.setSlot('down', 'thales');
    t.P.setBench(['red']);
    assert.deepStrictEqual(plain(t.P.slots()), { down: 'thales', up: 'blue' });
    assert.deepStrictEqual(plain(t.P.bench()), ['red']);
    t.P.onNet({ downTotal: gb(10), upTotal: gb(2) });
    near(t.I.totalBytes('red'), gb(3), 1, 'red keeps only what it earned on screen');
    near(t.I.totalBytes('thales'), gb(7), 1, 'thales gets only the growth after the swap');
    near(t.I.totalBytes('blue'), gb(2));
    // Blue is replaced by red on the upload slot (any character fights in either slot).
    t.P.setSlot('up', 'red');
    t.P.setBench(['blue']);
    t.P.onNet({ downTotal: gb(12), upTotal: gb(5) });
    near(t.I.totalBytes('thales'), gb(9));
    near(t.I.totalBytes('red'), gb(3 + 3), 1, 'red gets upload growth now');
    near(t.I.totalBytes('blue'), gb(2));
    // A repeated payload credits nothing; a counter that goes back re-bases.
    t.P.onNet({ downTotal: gb(12), upTotal: gb(5) });
    near(t.I.totalBytes('thales'), gb(9));
    t.P.onNet({ downTotal: gb(1), upTotal: gb(1) });
    near(t.I.totalBytes('thales'), gb(9), 1, 'a reset credits nothing');
    t.P.onNet({ downTotal: gb(2), upTotal: gb(1) });
    near(t.I.totalBytes('thales'), gb(10), 1, 'growth after the reset counts');
    // Garbage payloads never throw and never credit.
    for (const bad of [null, undefined, {}, { downTotal: 'x', upTotal: NaN }, { downTotal: -5, upTotal: Infinity }]) t.P.onNet(bad);
    near(t.I.totalBytes('thales'), gb(10), 1);
    // Level up goes to the occupant only.
    const t2 = make('');
    await t2.P.init();
    t2.P.onNet({ downTotal: gb(5), upTotal: 0 });
    assert.strictEqual(t2.P.level({ char: 'red' }), 2);
    assert.strictEqual(t2.P.level({ char: 'blue' }), 1);
    t2.P.setSlot('down', 'thales');
    t2.P.onNet({ downTotal: gb(10), upTotal: 0 });
    assert.strictEqual(t2.P.level({ char: 'thales' }), 2);
    assert.strictEqual(t2.P.level({ char: 'red' }), 2, 'red does not grow while benched');
    // The saved file keeps the order.
    t.P.tick(31);
    const saved = JSON.parse(t.saves[t.saves.length - 1]);
    assert.deepStrictEqual(saved.slots, { down: 'thales', up: 'red' });
    assert.deepStrictEqual(saved.bench, ['blue']);
    near(saved.chars.thales.bytes, gb(10), 1);
  }

  // ---------- Floating text anchors to the fighter standing in the slot ----------
  {
    const t = make('');
    const made = [];
    const mkEl = () => ({ style: {}, children: [], className: '', textContent: '', appendChild(c) { this.children.push(c); }, remove() { this.removed = true; } });
    t.ctx.document = { createElement: () => { const e = mkEl(); made.push(e); return e; }, body: mkEl() };
    const a = { slot: 'down', char: 'thales', x: 111 };
    const b = { slot: 'up', char: 'blue', x: 222 };
    t.ctx.fighters = [a, b];
    await t.P.init();
    t.P.setSlot('down', 'thales');
    t.P.onNet({ downTotal: 5 * GIB, upTotal: 0 });
    t.P.tick(0.1);
    const texts = made.filter((e) => e.textContent).map((e) => e.textContent);
    assert.deepStrictEqual(texts, ['LEVEL 2']);
    const holder = made.find((e) => e.className === 'float');
    assert(/translate\(111px/.test(holder.style.transform), 'anchored to the thales fighter object: ' + holder.style.transform);
    t.P.onKnockout(a, b); // no points: no text
    assert.strictEqual(made.filter((e) => e.textContent).length, 1);
  }

  // ---------- Bench and roster ----------
  {
    const t = make('');
    await t.P.init();
    // Default roster red,blue: no bench, no swap.
    assert.deepStrictEqual(plain(t.P.reconcile(['red', 'blue'])), { slots: { down: 'red', up: 'blue' }, bench: [] });
    // red,blue,thales: thales waits.
    assert.deepStrictEqual(plain(t.P.reconcile(['red', 'blue', 'thales'])).bench, ['thales']);
    // Debug roster with the copy.
    assert.deepStrictEqual(plain(t.P.reconcile(['red', 'blue', 'red2'])).bench, ['red2']);
    // First in, first out; the one who left goes to the end.
    t.P.setBench(['thales', 'red2']);
    t.P.setSlot('down', 'thales');
    assert.deepStrictEqual(plain(t.P.bench()), ['red2'], 'entering removes from the bench');
    t.P.setBench([...plain(t.P.bench()), 'red']);
    assert.deepStrictEqual(plain(t.P.bench()), ['red2', 'red']);
    // Bad input is ignored.
    t.P.setBench(['red2', 'nobody', 'red2', 7, null]);
    assert.deepStrictEqual(plain(t.P.bench()), ['red2']);
    t.P.setSlot('middle', 'red');
    t.P.setSlot('down', 'nobody');
    assert.deepStrictEqual(plain(t.P.slots()), { down: 'thales', up: 'blue' });
    // Reconcile drops characters that left the roster.
    const r = plain(t.P.reconcile(['blue', 'red']));
    assert.deepStrictEqual(r.slots, { down: 'red', up: 'blue' });
    assert.deepStrictEqual(r.bench, []);
  }

  // ---------- Migration from version 1 ----------
  {
    const v1 = JSON.stringify({
      version: 1,
      down: { bytes: 300 * GIB, build: { speed: 3, stamina: 2, strength: 1 }, lost: 2, protectLeft: 500 },
      up: { bytes: 100 * GIB, build: { speed: 0, stamina: 4, strength: 0 }, lost: 0, protectLeft: 0 },
    });
    const t = make(v1);
    await t.P.init();
    const R = { slot: 'down', char: 'red' };
    const B = { slot: 'up', char: 'blue' };
    near(t.I.totalBytes('red'), 300 * GIB, 1, 'no bytes lost (red)');
    near(t.I.totalBytes('blue'), 100 * GIB, 1, 'no bytes lost (blue)');
    assert.deepStrictEqual(plain(t.P.build(R)), { speed: 3, stamina: 2, strength: 1 });
    assert.deepStrictEqual(plain(t.P.build(B)), { speed: 0, stamina: 4, strength: 0 });
    assert.strictEqual(t.I.state.red.lost, 2);
    assert.strictEqual(t.I.state.red.protectLeft, 500);
    assert.strictEqual(t.P.level(R), t.I.levelFromBytes(300 * GIB));
    assert.strictEqual(t.I.totalBytes('thales'), 0);
    assert.strictEqual(t.P.level({ char: 'thales' }), 1, 'thales starts fresh');
    assert.deepStrictEqual(plain(t.P.slots()), { down: 'red', up: 'blue' });
    assert.deepStrictEqual(plain(t.P.bench()), ['thales']);
    // Next save is version 2 with the same numbers.
    t.P.tick(31);
    const out = JSON.parse(t.saves[t.saves.length - 1]);
    assert.strictEqual(out.version, 2);
    assert.strictEqual(out.chars.red.bytes, 300 * GIB);
    assert.strictEqual(out.chars.blue.bytes, 100 * GIB);
    assert.deepStrictEqual(out.chars.red.build, { speed: 3, stamina: 2, strength: 1 });
    assert.strictEqual(out.chars.red.lost, 2);
    assert.strictEqual(out.chars.thales.bytes, 0);
    assert.strictEqual('down' in out, false);
    // A version 1 file without a version field migrates too.
    const t0 = make(JSON.stringify({ down: { bytes: 7 * GIB } }));
    await t0.P.init();
    near(t0.I.totalBytes('red'), 7 * GIB, 1);
    // Round trip: the version 2 output loads back to the same state.
    const t2 = make(t.saves[t.saves.length - 1]);
    await t2.P.init();
    near(t2.I.totalBytes('red'), 300 * GIB, 1);
    assert.deepStrictEqual(plain(t2.P.build(R)), { speed: 3, stamina: 2, strength: 1 });
    // Version 2 with two equal slots falls back to the default slots.
    const v2 = JSON.stringify({
      version: 2,
      chars: {
        red: { bytes: 10 * GIB, build: { speed: 1, stamina: 0, strength: 0 }, lost: 0, protectLeft: 0 },
        blue: { bytes: 0, build: { speed: 0, stamina: 0, strength: 0 }, lost: 0, protectLeft: 0 },
        thales: { bytes: 300 * GIB, build: { speed: 0, stamina: 0, strength: 5 }, lost: 1, protectLeft: 60 },
      },
      bench: ['blue', 'red'],
      slots: { down: 'thales', up: 'thales' },
    });
    const t3 = make(v2);
    await t3.P.init();
    near(t3.I.totalBytes('thales'), 300 * GIB, 1);
    assert.strictEqual(t3.I.state.thales.build.strength, 5);
    assert.deepStrictEqual(plain(t3.P.slots()), { down: 'red', up: 'blue' });
    assert.deepStrictEqual(plain(t3.P.bench()), []);
    const v2b = JSON.stringify({ version: 2, chars: {}, bench: ['red', 'blue', 'thales', 'thales', 'zzz'], slots: { down: 'blue', up: 'thales' } });
    const t4 = make(v2b);
    await t4.P.init();
    assert.deepStrictEqual(plain(t4.P.slots()), { down: 'blue', up: 'thales' });
    assert.deepStrictEqual(plain(t4.P.bench()), ['red'], 'bench never lists a fighter on screen, nor duplicates, nor unknown names');
  }

  // ---------- Corrupted or odd files fall back to defaults ----------
  {
    const bad = [
      '{bad json',
      '',
      '   ',
      'null',
      '[]',
      '42',
      '"text"',
      'true',
      '{}',
      '{"version":2}',
      '{"version":2,"chars":null}',
      '{"version":2,"chars":[1,2]}',
      '{"version":2,"chars":"x","slots":7,"bench":"red"}',
      '{"version":2,"chars":{"red":5,"blue":"x","thales":null},"slots":null,"bench":null}',
      '{"version":99,"chars":{"red":{"bytes":"1e999"}}}',
      '{"version":1,"down":"x","up":[]}',
      '{"version":1,"down":null}',
      '{"version":2,"chars":{"__proto__":{"bytes":9},"constructor":{"bytes":9}},"slots":{"down":"__proto__","up":"constructor"}}',
    ];
    for (const text of bad) {
      const t = make(text);
      await t.P.init();
      const label = JSON.stringify(text).slice(0, 50);
      for (const c of ['red', 'blue', 'thales']) {
        assert.strictEqual(t.I.state[c].lost, 0, `lost 0 for ${c} after ${label}`);
        assert.strictEqual(t.P.level({ char: c }), 1, `level 1 for ${c} after ${label}`);
        assert.deepStrictEqual(plain(t.P.build({ char: c })), { speed: 0, stamina: 0, strength: 0 }, label);
      }
      assert.deepStrictEqual(plain(t.P.slots()), { down: 'red', up: 'blue' }, label);
      assert.deepStrictEqual(plain(t.P.bench()), ['thales'], label);
      t.P.onNet({ downTotal: GIB, upTotal: GIB });
      t.P.tick(31); // saving after a bad load must work
      const out = JSON.parse(t.saves[t.saves.length - 1]);
      assert.strictEqual(out.version, 2, label);
    }
    // Odd numbers inside an otherwise good file are clamped.
    const odd = JSON.stringify({
      version: 2,
      chars: {
        red: { bytes: 'x', build: { speed: 99, stamina: -4, strength: 'q' }, lost: -3, protectLeft: 'z' },
        blue: { bytes: -50, build: { speed: 2.9 }, lost: 1e9, protectLeft: 1e9 },
        thales: { bytes: 1e30, build: { speed: 10, stamina: 10, strength: 10 }, lost: 0, protectLeft: 0 },
      },
    });
    const t = make(odd);
    await t.P.init();
    const sum = (b) => b.speed + b.stamina + b.strength;
    assert.strictEqual(t.I.totalBytes('red'), 0);
    assert.strictEqual(t.P.build({ char: 'red' }).speed, 0, 'spending more than earned is undone');
    assert.strictEqual(t.P.build({ char: 'red' }).stamina, 0);
    assert.strictEqual(t.P.level({ char: 'thales' }), 20);
    assert.strictEqual(sum(t.P.build({ char: 'thales' })), 19 - t.I.state.thales.lost, 'cannot spend more than level 20 earned');
    assert(t.I.state.blue.protectLeft <= 900);
    assert(t.I.state.blue.lost <= 1000);
    assert(t.I.totalBytes('blue') >= 0);
    // A file that cannot be read (the load command throws) is a normal start.
    const t5 = make('');
    t5.ctx.window.__TAURI__.core.invoke = async (cmd) => {
      if (cmd === 'load_progress') throw new Error('disk');
      return '';
    };
    await t5.P.init();
    assert.strictEqual(t5.P.level({ char: 'red' }), 1);
    // No Tauri bridge at all: init, credit and save do not throw.
    const t6 = make('');
    delete t6.ctx.window.__TAURI__;
    await t6.P.init();
    t6.P.onNet({ downTotal: GIB, upTotal: 0 });
    t6.P.tick(40);
  }

  // ---------- Test modes never read or write the file ----------
  {
    for (const opts of [{ showcase: 'fight' }, { showcase: '1' }, { showcase: 'contact' }, { build: 'red=1,0,0' }]) {
      const t = make(JSON.stringify({ version: 2, chars: { red: { bytes: 500 * GIB } } }), opts);
      await t.P.init();
      const label = JSON.stringify(opts);
      assert.strictEqual(t.P.testMode, true, label);
      assert.strictEqual(t.calls.includes('load_progress'), false, 'test mode never reads ' + label);
      assert.strictEqual(t.I.totalBytes('red'), 0, 'file ignored');
      t.P.onNet({ downTotal: 50 * GIB, upTotal: 0 });
      t.P.setSlot('down', 'thales');
      t.P.setBench(['red']);
      t.P.onKnockout({ char: 'thales' }, { char: 'blue' });
      t.P.tick(100);
      assert.strictEqual(t.saves.length, 0, 'test mode never writes ' + label);
      assert.strictEqual(t.calls.includes('save_progress'), false);
      assert.strictEqual(t.I.totalBytes('red'), 0, 'no XP in test modes');
    }
  }

  console.log('progression_check: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
