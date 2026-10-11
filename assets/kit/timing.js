// Beat/lyric timing: reads analysis/out/timing.json + onsets.json produced by scripts/analyze.mjs.

export class Timing {
  constructor(json = {}, onsets = {}, opts = {}) {
    this.duration = json.audio?.duration ?? opts.duration ?? 60;
    this.bpm = json.tempo?.bpm ?? opts.bpm ?? 120;
    this.beatLen = json.tempo?.beatLen ?? 60 / this.bpm;
    this.confidence = json.tempo?.confidence ?? 0;
    this.beats = json.beats?.length ? json.beats : grid(this.duration, this.beatLen, opts.preroll ?? 0);
    this.downbeats = json.downbeats?.length ? json.downbeats : this.beats.filter((_, i) => i % 4 === 0);
    this.sections = json.sections ?? [];
    this.lines = json.lines ?? [];
    this.clockZero = json.clockZero ?? 0;
    this.onsets = { all: onsets.all ?? [], low: onsets.low ?? [], vocals: onsets.vocals ?? [] };
    this.sampleRate = json.audio?.sampleRate ?? 48000;
  }

  /** Fractional beat index at time t (works outside the detected range by extrapolation). */
  beatAt(t) {
    const b = this.beats;
    if (b.length < 2) return t / this.beatLen;
    if (t <= b[0]) return (t - b[0]) / this.beatLen;
    if (t >= b[b.length - 1]) return b.length - 1 + (t - b[b.length - 1]) / this.beatLen;
    let lo = 0, hi = b.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m] <= t) lo = m; else hi = m;
    }
    return lo + (t - b[lo]) / (b[hi] - b[lo]);
  }

  /** Time of fractional beat index x. */
  beatTime(x) {
    const b = this.beats;
    if (!b.length) return x * this.beatLen;
    const i = Math.floor(x), f = x - i;
    if (i < 0) return b[0] + x * this.beatLen;
    if (i >= b.length - 1) return b[b.length - 1] + (x - (b.length - 1)) * this.beatLen;
    return b[i] + f * (b[i + 1] - b[i]);
  }

  barAt(t) { return this.beatAt(t) / 4; }
  barTime(n) { return this.beatTime(n * 4); }
  beatPhase(t) { const x = this.beatAt(t); return x - Math.floor(x); }
  barPhase(t) { const x = this.barAt(t); return x - Math.floor(x); }

  /** Decaying flash on every beat: 1 exactly on the beat, ~0 just before the next. */
  pulse(t, k = 6, div = 1) { return Math.exp(-this.beatPhase(t * div) * k); }
  barPulse(t, k = 4) { return Math.exp(-this.barPhase(t) * k); }
  snapBeat(t, div = 1) { return Math.round(this.beatAt(t) / div) * div; }

  /** Nearest *measured* onset of kind ('all'|'low'|'vocals') within tol, or null. */
  onsetNear(kind, t, tol = 0.06) {
    const arr = this.onsets[kind] ?? this.onsets.all;
    if (!arr.length) return null;
    let best = null;
    for (const e of arr) {
      const d = Math.abs(e[0] - t);
      if (d <= tol && (!best || d < Math.abs(best[0] - t))) best = e;
      if (e[0] - t > tol) break;
    }
    return best;
  }

  section(id) {
    const s = this.sections.find((x) => x.id === id || x.label === id);
    if (!s) throw new Error(`no section "${id}" — ids: ${this.sections.map((x) => x.id).join(', ') || '(none)'}`);
    return s;
  }
  sectionAt(t) { return this.sections.find((s) => t >= s.start && t < s.end) ?? null; }
  sectionStart(id) { return this.section(id).start; }

  lineAt(t, { hold = 0 } = {}) {
    if (!this.lines.length) return null;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (t >= l.start - 0.001 && t <= l.end + hold) return l;
    }
    return null;
  }
  wordAt(t) {
    const l = this.lineAt(t, { hold: 0.4 });
    if (!l) return null;
    return (l.words ?? []).find((w) => t >= w.start && t < w.end) ?? null;
  }
  /** Exact lyric lookup: a typo must fail loudly instead of silently dropping a caption. */
  findLine(text, nth = 0) {
    const hits = this.lines.filter((l) => norm(l.text).includes(norm(text)));
    if (!hits.length) throw new Error(`findLine("${text}"): found 0 lines`);
    if (nth >= hits.length) throw new Error(`findLine("${text}", ${nth}): found ${hits.length}`);
    return hits[nth];
  }
  findWord(text, lineText, nth = 0) {
    const l = this.findLine(lineText, nth);
    const w = (l.words ?? []).find((x) => norm(x.text).includes(norm(text)));
    if (!w) throw new Error(`findWord("${text}") not in line "${l.text}"`);
    return w;
  }
  linesIn(a, b) { return this.lines.filter((l) => l.end >= a && l.start <= b); }

  static async load(timingUrl, onsetsUrl, timingJson, onsetsJson) {
    const j = timingJson ?? (await (await fetch(timingUrl)).json());
    const o = onsetsJson ?? (await (await fetch(onsetsUrl)).json().catch(() => ({})));
    return new Timing(j, o);
  }
}

const norm = (s) => (s ?? '').toString().toLowerCase().replace(/\s+/g, '');
const grid = (dur, beatLen, from = 0) => {
  const out = [];
  for (let t = from; t < dur + beatLen; t += beatLen) out.push(+t.toFixed(6));
  return out;
};

/** Authoring key helpers: every cut and cue is expressed against measured audio, never a hand-typed float.
 *  `secOrT` accepts a section id/label, a number of seconds, or a fractional beat index via {beat:n}. */
export const K = {
  /** B(T,'sec3',2) = 2 beats after the first beat at or after the anchor. */
  B(T, secOrT, beat = 0) {
    const t = anchor(T, secOrT);
    return T.beatTime(Math.ceil(T.beatAt(t)) + beat);
  },
  /** Snap to the nearest downbeat at or after the anchor. */
  BAR(T, secOrT, bar = 0) {
    const x = Math.ceil(T.barAt(anchor(T, secOrT)));
    return T.barTime(x + bar);
  },
  /** Measured hit at or after the grid beat, nudged one frame early so the picture lands with the sound. */
  HIT(T, secOrT, beat = 0, { tol = 0.12, lead = 1 / 30, kind = 'low' } = {}) {
    const g = K.B(T, secOrT, beat);
    const arr = T.onsets[kind] ?? T.onsets.all;
    let best = null;
    for (const e of arr) {
      if (e[0] < g - tol) continue;
      if (e[0] > g + tol) break;
      if (!best || e[0] < best[0]) best = e;
    }
    const t = best ? best[0] : g;
    return t - lead;
  },
  /** First word of line i (or word j of line i). */
  W(T, line, word = 0) {
    const l = typeof line === 'number' ? T.lines[line] : T.findLine(line);
    if (!l) throw new Error(`W(${line}): no such line`);
    const w = (l.words ?? [])[word];
    return (w ? w.start : l.start) - 1 / 60;
  },
  VOX(T, line, word = 0, { tol = 0.15, lead = 1 / 30 } = {}) {
    const g = K.W(T, line, word);
    const hit = T.onsetNear('vocals', g + tol / 2, tol);
    return (hit ? hit[0] : g) - lead;
  },
  /** Explicit seconds — allowed, but say so in the shot's comment. */
  AT(_T, t) { return t; },
};

export const keys = (T) => ({
  B: (s, b = 0) => K.B(T, s, b),
  BAR: (s, n = 0) => K.BAR(T, s, n),
  HIT: (s, b = 0, o) => K.HIT(T, s, b, o),
  W: (i, j = 0) => K.W(T, i, j),
  VOX: (i, j = 0, o) => K.VOX(T, i, j, o),
  AT: (t) => t,
});

function anchor(T, secOrT) {
  if (typeof secOrT === 'number') return secOrT;
  if (typeof secOrT === 'string') return T.section(secOrT).start;
  throw new Error(`bad anchor ${secOrT}`);
}
