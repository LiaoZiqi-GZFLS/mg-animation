import { clamp } from './math.js';
// Shot timeline: flat ordered list of shots, absolute time, joins declared as data.
import { Timing, K } from './timing.js';

export class Timeline {
  /**
   * @param def {id, duration?, audio?, shots:[{id, at, dur?, transitionIn?, draw, init?, ownsLyrics?, editOnly?}]}
   * @param T   Timing
   */
  constructor(def, T) {
    this.def = def;
    this.T = T;
    this.problems = [];
    const shots = [];
    const seen = new Set();
    for (const s of def.shots) {
      if (!s.id) throw new Error('shot without id');
      if (seen.has(s.id)) throw new Error(`duplicate shot id "${s.id}"`);
      seen.add(s.id);
      if (s.editOnly) continue;
      if (typeof s.draw !== 'function') throw new Error(`shot ${s.id} has no draw(ctx) function`);
      shots.push({ ...s, start: resolve(s.at, T, s.id), dur: typeof s.dur === 'function' ? s.dur(T) : s.dur, join: s.transitionIn || null, shot: s });
    }
    shots.sort((a, b) => a.start - b.start);
    if (!shots.length) throw new Error('film has no shots');
    if (shots[0].start > 1e-6) this.problems.push(`first shot starts at ${shots[0].start.toFixed(3)}s, expected 0`);
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      s.end = i + 1 < shots.length ? shots[i + 1].start : def.duration ?? s.start + (s.dur ?? 4);
      if (s.dur != null && Math.abs(s.end - s.start - s.dur) > 0.02) {
        this.problems.push(`${s.id}: declared dur ${s.dur.toFixed(3)} != window ${(s.end - s.start).toFixed(3)}`);
      }
      if (i + 1 < shots.length && shots[i + 1].start - s.start < 1 / 30) this.problems.push(`${s.id}: shots closer than one frame`);
      if (!isFinite(s.start)) throw new Error(`shot ${s.id} has non-finite start — check the key function`);
    }
    this.shots = shots;
    this.duration = shots[shots.length - 1].end;
    this.byId = new Map(shots.map((s) => [s.id, s]));
  }

  shotAt(t) {
    const s = this.shots;
    let lo = 0, hi = s.length - 1, out = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (s[m].start <= t) { out = s[m]; lo = m + 1; } else hi = m - 1;
    }
    return out;
  }

  startOf(id) {
    const s = this.byId.get(id);
    if (!s) throw new Error(`unknown shot id "${id}" (used before it exists?)`);
    return s.start;
  }

  endOf(id) {
    return this.byId.get(id).end;
  }

  /** {a} outside a join, {a,b,p} inside one. A shot's transitionIn describes how it ENTERS,
   *  so the join belongs to the window just before the incoming shot starts. */
  at(t) {
    const cur = this.shotAt(t);
    if (!cur) return null;
    const next = this.nextOf(cur);
    if (next?.join) {
      const win = Math.min(next.join.dur ?? 0.25, next.start - cur.start);
      if (t >= next.start - win) {
        return { a: cur, b: next, p: clamp((t - (next.start - win)) / (win || 1e-9)), join: next.join };
      }
    }
    return { a: cur, b: null, p: 0, join: null };
  }

  prevOf(shot) {
    const i = this.shots.indexOf(shot);
    return i > 0 ? this.shots[i - 1] : null;
  }

  nextOf(shot) {
    const i = this.shots.indexOf(shot);
    return i + 1 < this.shots.length ? this.shots[i + 1] : null;
  }
}

function resolve(at, T, id) {
  if (typeof at === 'number') return at;
  if (typeof at === 'function') {
    const v = at(T instanceof Timing ? T : new Timing({}), K);
    if (typeof v !== 'number' || !isFinite(v)) throw new Error(`shot ${id}: at(T) returned ${v}`);
    return v;
  }
  if (Array.isArray(at)) return at[0] + (at[1] ?? 0);
  throw new Error(`shot ${id}: bad at (${at})`);
}

export { Timing, K };

/** Build {timeline, timing} from a film definition, loading audio analysis when present. */
export async function loadFilm(def, { timing, onsets, base = 'analysis/out' } = {}) {
  const T = timing instanceof Timing ? timing : await Timing.load(`${base}/timing.json`, `${base}/onsets.json`, timing, onsets);
  const tl = new Timeline(def, T);
  return { timeline: tl, T };
}
