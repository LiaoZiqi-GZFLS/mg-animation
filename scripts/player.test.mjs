// Node unit tests for the browser-side playback modules that need no DOM.
//   node scripts/player.test.mjs
import { strict as assert } from 'node:assert';
import { due, advance } from '../assets/kit/pace.js';
import { LADDER, Quality, budgetMs, sizeFor } from '../assets/kit/quality.js';

let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);

// --- pace: a frame is due at vsync, and a stall restarts the schedule rather than bursting ---
assert.equal(due(100, 100, 16.7), true, 'exactly due');
assert.equal(due(108, 100, 16.7), true, 'late is due');
assert.equal(due(92, 100, 16.7), true, 'within half a refresh it is already due');
assert.equal(due(80, 100, 16.7), false, 'too early is not due');
ok('due() gates on the vsync interval, not on the wall clock');
assert.ok(Math.abs(advance(100, 85, 16.7) - 101.7) < 1e-9, 'a normal step queues the next frame from the schedule');
assert.ok(Math.abs(advance(500, 100, 16.7) - 516.7) < 1e-9, 'after a stall the next frame is one interval from now, not a burst');
ok('advance() never catches up by bursting');

// --- sizeFor follows the film's own design aspect, not a hardcoded 16:9 ---
const q169 = new Quality({ design: { w: 1920, h: 1080 } });
assert.deepEqual(sizeFor(1080, q169.design), [1920, 1080]);
assert.deepEqual(sizeFor(540, q169.design), [960, 540]);
const q916 = new Quality({ design: { w: 1080, h: 1920 } });
assert.deepEqual(sizeFor(720, q916.design), [406, 720], 'a vertical film downscales vertically');
ok('sizeFor() keeps the design aspect instead of assuming 16:9');

// --- the ladder and the budget ---
assert.ok(LADDER.length >= 8 && LADDER[0] === 360 && LADDER[LADDER.length - 1] === 2160);
assert.ok(Math.abs(budgetMs(60) - 13.333) < 0.01, 'a 60 fps budget leaves 20% of the frame');
ok('the resolution ladder and the fps budget match the reference player');

// --- predictive pick from a cost table ---
const cost = {
  default: [2, 1],
  shots: { heavy: [3, 9], light: [1, 0.2] },
};
const qp = new Quality({ cost, design: { w: 1920, h: 1080 } });
qp.setSpeed([1, 1]);
const mp1080 = (1920 * 1080) / 1e6;
assert.ok(Math.abs(qp.predict(['heavy'], 1080) - (3 + 9 * mp1080)) < 1e-9, 'the dearest of the selected shots sets the cost');
assert.ok(Math.abs(qp.predict(['light', 'heavy'], 1080) - (3 + 9 * mp1080)) < 1e-9, 'a join costs what its dearest side costs');
assert.equal(qp.pick(['light'], budgetMs(60)), LADDER[LADDER.length - 1], 'a cheap shot fills the ladder');
assert.ok(qp.pick(['heavy'], budgetMs(60)) < qp.pick(['light'], budgetMs(60)), 'the expensive shot gets fewer rungs');
assert.ok(qp.pick(['heavy'], budgetMs(60)) < 1080, 'a shot over the 60 fps budget at 1080p never picks 1080p');
ok('pick() reads the table: the highest rung whose prediction fits the budget');

// --- an upscale needs headroom and climbs at most two rungs per cut ---
const qc = new Quality({ cost: { default: [0, 0.9], shots: { heavy: [500, 0] } }, design: { w: 1920, h: 1080 } });
qc.setSpeed([1, 1]);
qc.restart();
assert.equal(qc.onSelection(['heavy']), 360, 'a shot no rung can afford sits at the bottom of the ladder');
qc.onSelection(['x']);
assert.ok(LADDER.indexOf(qc.h) <= 2, `one cut climbs at most two rungs (now ${qc.h})`);
qc.restart();
assert.equal(qc.onSelection(['x']), 2160, 'after restart() the pick is free to jump straight to the top');
ok('CLIMB throttles upscales across cuts; a seek spends the throttle');

// --- the emergency guard: three frames over twice the budget steps auto down ---
const qg = new Quality({ cost: { default: [1, 0], shots: {} }, design: { w: 1920, h: 1080 }, fps: 60 });
qg.onSelection(['x']);
const h0 = qg.h;
for (let i = 0; i < 3; i++) qg.onFrame(budgetMs(60) * 3, { ids: ['x'], h: h0, exact: true });
assert.ok(qg.h < h0 || qg.fps < 60, `three slow frames must step down (h ${h0} -> ${qg.h}, fps ${qg.fps})`);
ok('EMERGENCY: sustained overrun drops quality or frame rate');

// --- the watchdog steps a locked preset down too ---
const qw = new Quality({ cost: { default: [1, 0], shots: {} }, design: { w: 1920, h: 1080 }, preset: '1080p' });
qw.onSelection(['x']);
assert.equal(qw.h, 1080, 'a locked preset picks its own rung');
for (let i = 0; i < 4; i++) qw.onFrame(200, { ids: ['x'], h: 1080, exact: true });
assert.ok(qw.h < 1080, 'four frames over 150 ms step even a locked preset down');
ok('WATCHDOG protects the page even when the viewer picked a height');

// --- learning: a device slower than the table must not keep picking the same height ---
const ql = new Quality({ cost: { default: [2, 1], shots: {} }, design: { w: 1920, h: 1080 } });
ql.setSpeed([1, 1]);
const slowBefore = ql.pick(['x'], budgetMs(60));
for (let i = 0; i < 40; i++) ql.learn(ql.predict(['x'], 1080) * 2, { ids: ['x'], h: 1080, exact: true });
assert.ok(ql.pick(['x'], budgetMs(60)) < slowBefore, 'measured overruns raise the device factors and lower the pick');
const fastBefore = ql.speed();
for (let i = 0; i < 40; i++) ql.learn(ql.predict(['x'], 1080) * 0.2, { ids: ['x'], h: 1080, exact: true });
assert.ok(ql.speed()[0] < fastBefore[0], 'measured headroom pulls the factors back down');
ok('learn() fits the device factors by exponential moving average');

// --- calibrate() fits both factors from samples at two sizes ---
const qk = new Quality({ cost: { default: [10, 5], shots: {} }, design: { w: 1920, h: 1080 } });
qk.setSpeed([1, 1]);
const obs = (h, kf, kp) => {
  const [A, B] = qk.terms(['x'], h, [1, 1]);
  return kf * A + kp * B;
};
qk.calibrate([
  { ids: ['x'], h: 360, ms: obs(360, 3, 2) },
  { ids: ['x'], h: 1080, ms: obs(1080, 3, 2) },
]);
const [kf, kp] = qk.speed();
assert.ok(Math.abs(kf - 3) < 0.35 && Math.abs(kp - 2) < 0.35, `the fit recovers the factors (got ${kf.toFixed(2)}, ${kp.toFixed(2)})`);
ok('calibrate() separates fixed from per-pixel cost from two sizes');

// --- a locked preset never auto-changes on its own, and setPreset round-trips ---
const qs = new Quality({ cost: { default: [1, 1], shots: {} }, design: { w: 1920, h: 1080 }, preset: '540p' });
assert.equal(qs.onSelection(['x']), 540);
qs.setPreset('auto');
assert.equal(qs.preset, 'auto');
assert.notEqual(qs.onSelection(['x']), 540, 'auto resumes once the viewer releases the lock');
qs.setPreset('nonsense');
assert.equal(qs.preset, 'auto', 'an unknown preset falls back to auto rather than NaN');
ok('presets round-trip and bad input degrades to auto');

console.log(`\nplayer: ${n} checks passed`);
