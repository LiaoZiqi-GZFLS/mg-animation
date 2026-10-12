// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/quality.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications, relative to that commit:
//   1. `cost` is optional: with no cost table the controller keeps every guard and the learning
//      loop and simply has nothing to predict from, so a film that was never calibrated still
//      adapts (upstream required the table its own film ships).
//   2. `sizeFor`/`megapixels` take the film's design aspect instead of a hardcoded 16:9, so a
//      vertical film scales vertically.
//   3. The `4k` mbCap/motion-blur coupling of the reference player is not part of this file.
//   4. Names, argument order and the ladder, budgets and thresholds are kept as published.
//   5. `calibrate()` refuses a two-factor fit its samples cannot support: the reference player tests
//      only for an exactly singular system, which is enough for its raymarched shots (tens of
//      milliseconds, a real slope) but lets a film whose frames cost two milliseconds fit noise as a
//      slope and start the preview two rungs too low. Now the fit needs the two columns to be
//      genuinely distinct (det > 1e-3 * aa * bb) and otherwise fits the single scale the data does
//      identify.
//   6. Also carries `midTime`, `shotMs` and `pickCalibration`, derived from
//      world-execute-web `src/player/pick.js` at the same commit: `midTime` reads this kit's
//      `shot.join` (upstream's `shot.transitionIn`) and defaults `dur`/`bias` the way
//      `timeline.at()` does, and the cost terms take an optional design aspect.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The rungs the controller may stand on, in design pixels of height. */
export const LADDER = [360, 432, 540, 648, 720, 900, 1080, 1260, 1440, 1800, 2160];
/** What the viewer may pick: `auto` lets the controller choose, a name locks a rung. */
export const PRESETS = ['auto', '360p', '540p', '720p', '1080p', '1440p', '4k'];

const UP = 0.85; // an upscale must fit this share of the budget, so a pick that barely fits does not oscillate
const CLIMB = 2; // rungs an upscale may gain per cut, once the first pick is spent
const ALPHA = 0.08; // how hard one measured frame pulls the device factors
const DRIFT = 0.998; // a frame too cheap to be evidence still relaxes the factors a little
const FLOOR = 0.7; // never learn the device as faster than this multiple of its calibrated best
const EMERGENCY = { k: 2, frames: 3 }; // frames over k x the budget in a row step the mode down
const WATCHDOG = { ms: 150, frames: 4 }; // frames over this wall-clock ms do the same in every mode

export const sizeFor = (h, design = { w: 16, h: 9 }) => [Math.round((h * design.w) / design.h / 2) * 2, h];
export const megapixels = (h, design) => {
  const [w] = sizeFor(h, design);
  return (w * h) / 1e6;
};
/** A frame rate's drawing budget: 80% of its interval, leaving the rest to the browser. */
export const budgetMs = (fps) => (1e3 / fps) * 0.8;
const presetHeight = (p) => (p === '4k' ? 2160 : parseInt(p, 10));
/** [fixed, pixel] ms of a shot on the machine the table was made on (the table's default when it does not list it). */
export const shotTerms = (cost, id) => cost?.shots?.[id] ?? cost?.default ?? [0, 0];
/** The predicted frame time of a shot at height h on the machine the table was made on. */
export const shotMs = (cost, id, h = 1080, design) => {
  const [a, b] = shotTerms(cost, id);
  return a + b * megapixels(h, design);
};
/**
 * A time inside shot i where only that shot is on screen: the middle of the stretch after its own join
 * window and before the next shot's (`timeline.at()` blends two shots inside one), kept inside [from, to].
 * A shot with no such stretch gives the middle of its stretch of the film; null when none of it is inside.
 */
export function midTime(shots, i, from = -Infinity, to = Infinity) {
  const s = shots[i], n = shots[i + 1], j = i > 0 ? s.join : null, k = n?.join;
  const lo = Math.max(from, s.start), hi = Math.min(to, s.end);
  if (!(hi > lo)) return null;
  const pa = Math.max(lo, j ? s.start + (j.dur ?? 0.25) * (1 - (j.bias ?? 0.5)) : -Infinity);
  const pb = Math.min(hi, k ? n.start - (k.dur ?? 0.25) * (k.bias ?? 0.5) : Infinity);
  return pb - pa > 0.05 ? (pa + pb) / 2 : (lo + hi) / 2;
}
/**
 * The shots to time when playback starts, so the two factors of the device model (fixed cost and
 * per-pixel cost) can be told apart: the shot dearest in pixels, a middling one, and the one dearest
 * in fixed cost. [{ id, t }, …] in that order. Shots the table does not list are used only when it
 * lists too few. count: how many (at most).
 */
export function pickCalibration(cost, shots, { from = 0, to = Infinity, h = 540, count = 3, design } = {}) {
  const here = shots.map((s, i) => ({ s, t: midTime(shots, i, from, to) })).filter((r) => r.t != null);
  const known = here.filter((r) => cost?.shots?.[r.s.id]);
  const pool = (known.length >= Math.min(2, count) ? known : here).map((r) => ({
    ...r,
    a: shotTerms(cost, r.s.id)[0],
    b: shotTerms(cost, r.s.id)[1],
    ms: shotMs(cost, r.s.id, h, design),
  }));
  const out = [];
  const taken = new Set();
  const take = (r) => {
    if (r && !taken.has(r)) {
      taken.add(r);
      out.push({ id: r.s.id, t: r.t });
    }
  };
  const dearest = (key) => pool.filter((r) => !taken.has(r)).sort((x, y) => y[key] - x[key] || x.s.start - y.s.start)[0];
  const byMs = [...pool].sort((x, y) => x.ms - y.ms || x.s.start - y.s.start);
  const middling = () => {
    const m = (byMs.length - 1) >> 1;
    for (let d = 0; d < byMs.length; d++) for (const i of [m - d, m + d]) if (byMs[i] && !taken.has(byMs[i])) return byMs[i];
    return null;
  };
  take(dearest('b'));
  take(middling());
  take(dearest('a'));
  return out.slice(0, count);
}

export class Quality {
  /**
   * cost: null (learn only from what this device measures) or { default: [fixedMs, msPerMpx],
   * shots: { [id]: [fixedMs, msPerMpx] } } as scripts/calibrate.mjs writes it.
   * design: the film's design size, which fixes the aspect every rung is scaled at.
   */
  constructor({ cost = null, preset = 'auto', fps = 'auto', maxH = 2160, design = { w: 16, h: 9 } } = {}) {
    this.cost = cost ?? { default: [0, 0], shots: {} };
    /** Whether there is anything to predict from; without a table the controller only reacts. */
    this.costHasTable = !!cost && !!cost.default;
    this.design = design;
    this.preset = PRESETS.includes(preset) ? preset : 'auto';
    this.fpsSetting = fps;
    this.setMaxHeight(maxH);
    this.setSpeed([1, 1]);
    this.manualH = this.preset === 'auto' ? null : presetHeight(this.preset);
    this.h = 540;
    this.ids = [];
    this.slow = 0;
    this.dog = 0;
    this.fresh = true;
    this.shotFps = 60;
  }
  get fps() {
    if (this.fpsSetting !== 'auto') return +this.fpsSetting;
    return this.device60() ? this.shotFps : 30;
  }
  /** Can this device hold 60 fps at 1080p on a typical shot? Decided once, and re-decided by calibration. */
  device60() {
    return (this.autoFps ??= this.predict([], 1080) <= budgetMs(60) ? 60 : 30) === 60;
  }
  /** [fixed, pixel] ms of the dearest of `ids` at height h on this device (k = [1, 1]: on the machine the table was made on). */
  terms(ids, h, k = [this.kf, this.kp]) {
    const mp = megapixels(h, this.design);
    let best = [0, 0];
    for (const id of ids.length ? ids : ['']) {
      const [a, b] = this.cost.shots[id] ?? this.cost.default;
      const t = [k[0] * a, k[1] * b * mp];
      if (t[0] + t[1] > best[0] + best[1]) best = t;
    }
    return best;
  }
  predict(ids, h) {
    const [f, p] = this.terms(ids, h);
    return f + p;
  }
  speed() {
    return [this.kf, this.kp];
  }
  setSpeed([kf, kp]) {
    this.kf = clamp(kf, 0.05, 200);
    this.kp = clamp(kp, 0.05, 200);
    this.floor = [this.kf * FLOOR, this.kp * FLOOR];
  }
  /** One number for logs: how much slower than the table this device runs a typical shot at 1080p. */
  get scale() {
    const [a, b] = this.cost.default;
    const mp = megapixels(1080, this.design);
    return (this.kf * a + this.kp * b * mp) / (a + b * mp || 1);
  }
  /** The next pick is free (playback start, seek): otherwise an upscale climbs at most CLIMB rungs per cut. */
  restart() {
    this.fresh = true;
  }
  /** The highest rung whose prediction fits budget B (upscales: with headroom, and at most CLIMB rungs per cut). */
  pick(ids, B) {
    const top = this.fresh ? Infinity : LADDER.findIndex((h) => h >= this.h) + CLIMB;
    let pick = LADDER[0];
    for (const [i, h] of LADDER.entries()) {
      if (h <= this.maxH && i <= top && this.predict(ids, h) <= B * (h > this.h ? UP : 1)) pick = h;
    }
    return pick;
  }
  /**
   * A cut (or a seek): the height to draw the new selection at. On a 60 fps device, a shot that 60 fps
   * would push below 720p plays at 30 fps instead when that buys two or more rungs.
   */
  onSelection(ids) {
    this.ids = ids;
    this.slow = 0;
    this.shotFps = 60;
    if (this.manualH) return (this.h = this.manualH);
    let h = this.pick(ids, budgetMs(this.fps));
    if (this.fpsSetting === 'auto' && this.device60() && h < 720) {
      const h30 = this.pick(ids, budgetMs(30));
      if (LADDER.indexOf(h30) >= LADDER.indexOf(h) + 2) {
        h = h30;
        this.shotFps = 30;
      }
    }
    this.fresh = false;
    return (this.h = h);
  }
  /** A measured frame: learn the device's scale (exact: GPU time; else a frame interval) and guard (below). */
  onFrame(ms, { ids = this.ids, h = this.h, exact = true } = {}) {
    this.learn(ms, { ids, h, exact });
    return this.guard(ms);
  }
  /** Learn how much slower than the table this device is. Never steps. */
  learn(ms, { ids = this.ids, h = this.h, exact = true } = {}) {
    const [f, px] = this.terms(ids, h);
    const p = f + px;
    if (!(p > 0)) return; // no table, no prediction to be wrong about: the guards alone decide
    const share = px / p;
    const interval = 1e3 / this.fps;
    const r = exact ? clamp(ms / p, 0.25, 4) : ms > interval * 1.5 ? clamp(ms / Math.max(p, interval), 1, 4) : 0;
    if (r) {
      this.kf = clamp(this.kf * r ** (ALPHA * (1 - share)), 0.05, 200);
      this.kp = clamp(this.kp * r ** (ALPHA * share), 0.05, 200);
    } else {
      this.kf = Math.max(this.floor[0], this.kf * DRIFT);
      this.kp = Math.max(this.floor[1], this.kp * DRIFT);
    }
  }
  /**
   * A frame's wall time (what the viewer sees): the watchdog steps any mode down after 4 frames over 150 ms,
   * an emergency steps auto down (first from 60 to 30 fps) after 3 frames over twice the budget.
   */
  guard(ms) {
    this.dog = ms > WATCHDOG.ms ? this.dog + 1 : 0;
    if (this.dog >= WATCHDOG.frames) {
      this.dog = 0;
      return this.stepDown('watchdog');
    }
    if (this.manualH) return null;
    this.slow = ms > budgetMs(this.fps) * EMERGENCY.k ? this.slow + 1 : 0;
    if (this.slow >= EMERGENCY.frames) {
      this.slow = 0;
      if (this.fpsSetting === 'auto' && this.fps === 60) {
        this.autoFps = 30;
        return { height: this.h, reason: 'fps' };
      }
      return this.stepDown('emergency');
    }
    return null;
  }
  stepDown(reason) {
    let i = LADDER.length - 1;
    while (i >= 0 && LADDER[i] >= this.h) i--;
    if (i < 0) return null;
    this.h = LADDER[i];
    if (this.manualH) this.manualH = this.h;
    return { height: this.h, reason };
  }
  setPreset(p) {
    this.preset = PRESETS.includes(p) ? p : 'auto';
    this.manualH = this.preset === 'auto' ? null : presetHeight(this.preset);
  }
  setFps(f) {
    this.fpsSetting = f === 'auto' ? 'auto' : +f;
  }
  setMaxHeight(px) {
    this.maxH = LADDER.find((h) => h >= px) ?? 2160;
  }
  /** The shots to time at start-up, chosen so the device's two cost factors can be told apart. */
  calibrationShots(shots, { from = 0, to = Infinity, h = 540 } = {}) {
    return pickCalibration(this.cost, shots, { from, to, h, design: this.design });
  }
  /**
   * Weighted least squares of the two device factors against measured frames (ms^-2 weights: relative
   * error). Two unknowns need data that varies in two directions: if the samples do not separate a
   * fixed cost from a per-pixel one, say so and fit the one factor the data does identify.
   */
  calibrate(samples) {
    const rows = samples.map((s) => [...this.terms(s.ids, s.h, [1, 1]), s.ms]);
    let fit = null;
    if (rows.length >= 2) {
      let aa = 0, ab = 0, bb = 0, am = 0, bm = 0;
      for (const [A, B, m] of rows) {
        const w = 1 / (m * m);
        aa += w * A * A;
        ab += w * A * B;
        bb += w * B * B;
        am += w * A * m;
        bm += w * B * m;
      }
      const det = aa * bb - ab * ab;
      // det / (aa*bb) is 1 - cos^2 between the two columns: below a thousandth they are the same
      // direction, and the slope it fits is noise dressed as a number.
      const separable = aa > 0 && bb > 0 && det > 1e-3 * aa * bb;
      if (separable) {
        const kf = (am * bb - bm * ab) / det;
        const kp = (bm * aa - am * ab) / det;
        if (kf > 0 && kp > 0) fit = [kf, kp];
      }
    }
    if (!fit && rows.length) {
      const r = rows.map(([A, B, m]) => m / (A + B)).sort((x, y) => x - y)[rows.length >> 1];
      fit = [r, r];
    }
    if (fit) this.setSpeed(fit);
    this.autoFps = null;
  }
}
