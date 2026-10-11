// Per-frame audio features (rms / bands / onset …) sampled by linear interpolation at song time.

export class Features {
  constructor(meta = null, data = null) {
    this.meta = meta;
    this.data = data;
    this.names = meta?.channels ?? [];
    this.index = new Map(this.names.map((n, i) => [n, i]));
    this.fps = meta?.fps ?? 60;
    this.missing = !meta || !data;
  }

  /** Channel value at song time t, interpolated between analysis frames. Silent/missing → 0. */
  get(name, t) {
    if (this.missing) return 0;
    const c = this.index.get(name);
    if (c === undefined) return 0;
    const x = t * this.fps;
    const i = Math.floor(x);
    const a = this.sample(i, c);
    const b = this.sample(i + 1, c);
    return a + (b - a) * (x - i);
  }

  sample(i, c) {
    const n = this.meta.frames;
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    const v = this.data[i * this.names.length + c];
    return Number.isFinite(v) ? v : 0;
  }

  /** Decay peak-hold envelope: reads as loudness without flicker. Deterministic (no per-frame state). */
  env(name, t, release = 0.25) {
    if (this.missing) return 0;
    const c = this.index.get(name);
    if (c === undefined) return 0;
    const fps = this.fps;
    const now = Math.min(this.meta.frames - 1, Math.max(0, Math.floor(t * fps)));
    const back = Math.ceil(release * 8 * fps);
    let out = 0;
    for (let i = now; i >= Math.max(0, now - back); i--) {
      const w = Math.exp(-((now - i) / fps) / release);
      const v = this.sample(i, c) * w;
      if (v > out) out = v;
      else if (w < 1e-3) break;
    }
    return out;
  }

  bands(t, out = []) {
    for (let i = 0; i < 16; i++) out[i] = this.get(`mel_${String(i).padStart(2, '0')}`, t);
    return out;
  }

  static async load(jsonUrl, binUrl) {
    try {
      const meta = await (await fetch(jsonUrl)).json();
      const buf = await (await fetch(binUrl)).arrayBuffer();
      return new Features(meta, new Float32Array(buf));
    } catch {
      return new Features();
    }
  }
}
