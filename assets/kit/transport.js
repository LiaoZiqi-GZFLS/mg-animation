// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/player.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications, relative to that commit:
//   1. Drives this kit's Engine (a flat shot list, `engine.draw(t)`) instead of the reference
//      engine's chapters, motion blur and `outFps`/`mbCap` frame-rate coupling.
//   2. The song comes from a file the project already has (`audioUrl`), fetched and decoded
//      locally. The reference player's key service is not part of this kit, and nothing here
//      talks to it.
//   3. Adds `setRate`: any rate other than 1 plays silently off a virtual clock, because an
//      author slows the picture down to look at it, not to hear it.
//   4. Calibration runs only when the film ships a measured cost table (scripts/calibrate.mjs);
//      without one the controller learns from the frames it draws, as kit/quality.js describes.
//   5. The storage prefix is per-film (the project's own id), so two films in one browser keep
//      their own quality choices.
import { AudioClock } from './clock.js';
import { GpuTimer } from './gputimer.js';
import { advance, due } from './pace.js';
import { sizeFor } from './quality.js';

const LOWER = ['1440p', '1080p', '720p', '540p', '360p'];

/** What the viewer chose (quality, frame rate, volume): kept in this browser. */
export const makeStore = (prefix) => ({
  get(k, d) {
    try {
      return localStorage.getItem(`${prefix}.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`${prefix}.${k}`, v);
    } catch {}
  },
});

/** What belongs to this visit (a reload in the same tab is the same visit): the context losses so far. */
export const makeSession = (prefix) => ({
  get(k, d) {
    try {
      return sessionStorage.getItem(`${prefix}.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(`${prefix}.${k}`, v);
    } catch {}
  },
  remove(k) {
    try {
      sessionStorage.removeItem(`${prefix}.${k}`);
    } catch {}
  },
});

/**
 * What to start with, from the address (?q= quality, ?fps=, ?t= film time, ?rate=, ?resume) and the
 * saved settings. A value that is not valid is ignored (the next source, then the default), so a typo
 * in a link never reaches the player as NaN.
 */
export function startOptions(q, { saved = {}, presets = [], poster = 0 } = {}) {
  const preset = [q.get('q'), saved.q].find((v) => presets.includes(v)) ?? 'auto';
  const fps = [q.get('fps'), saved.fps].find((v) => v === 'auto' || v === '30' || v === '60') ?? 'auto';
  const t = q.get('t');
  const rate = q.get('rate');
  return {
    preset,
    fps: fps === 'auto' ? 'auto' : +fps,
    t: t != null && t.trim() !== '' && Number.isFinite(+t) ? +t : poster,
    rate: rate != null && Number.isFinite(+rate) && +rate > 0 ? +rate : 1,
    resume: q.has('resume'),
  };
}

/**
 * The real-time playback loop: an audio-led clock, vsync pacing, a GPU timer that feeds the quality
 * controller, and a recovery path for the one failure a long preview really has — a lost context.
 */
export class Transport {
  constructor({ canvas, engine, quality, ui = null, store = null, session = null }) {
    Object.assign(this, { canvas, e: engine, q: quality, ui: ui ?? quietUI, store: store ?? makeStore('mg.player'), session: session ?? makeSession('mg') });
    this.gl = engine.gl;
    this.gpu = new GpuTimer(this.gl);
    this.design = engine.config.design;
    this.start = 0;
    this.end = engine.duration;
    this.t = 0;
    this.rate = 1;
    this.ready = false;
    this.key = '';
    this.last = 0;
    this.next = 0;
    this.prev = 0;
    this.fpsAvg = 0;
    this.dirty = true;
    this.steady = false;
    this.resizes = 0;
    this.started = false;
    this.scrubbing = false;
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.lost = true;
      this.clock?.pause();
      const n = +this.session.get('lost', 0) || 0;
      this.session.set('lost', n + 1);
      if (n >= 2) return this.ui.unsupported('contextLostFinal');
      const preset = n >= 1 ? '360p' : LOWER.find((p) => parseInt(p, 10) < this.e.H) ?? '360p';
      this.ui.notice('noticeContextLost');
      const at = this.started ? `t=${(this.clock?.now() ?? this.t).toFixed(2)}&` : '';
      setTimeout(() => {
        location.search = `?${at}q=${preset}${this.started ? '&resume' : ''}`;
      }, 800);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
  }
  /** The audio drives the picture only while it is playing at one times speed, and only if there is audio. */
  get audioLed() {
    return !!this.clock && this.rate === 1;
  }
  /** Prewarm the shaders while the song downloads and decodes beside it. */
  async prepare({ audioUrl = null, onProgress = () => {} } = {}) {
    const bytes = audioUrl
      ? fetch(audioUrl).then((r) => {
          if (!r.ok) throw new Error(`audio ${r.status}`);
          return r.arrayBuffer();
        })
      : Promise.resolve(null);
    bytes.catch(() => {});
    await this.e.prewarm((d, n) => onProgress('warm', d / n));
    try {
      const buf = await bytes;
      if (buf) {
        this.ac = new AudioContext({ latencyHint: 'playback' });
        this.clock = new AudioClock(this.ac, await this.ac.decodeAudioData(buf));
        this.end = Math.min(this.e.duration, this.clock.buffer.duration);
      }
    } catch (err) {
      this.audioError = String(err.message ?? err);
      this.ui.notice('noticeAudio', { error: this.audioError });
    }
    onProgress('audio', 1);
    if (this.q.costHasTable) this.calibrate();
    this.ready = true;
    this.dirty = true;
    const loop = (now) => {
      requestAnimationFrame(loop);
      try {
        this.tick(now);
      } catch (e) {
        if (!this.failed) {
          this.failed = true;
          console.error(e);
          this.ui.notice('noticeFrameFailed', { error: String(e.message ?? e) });
        }
      }
    };
    requestAnimationFrame(loop);
    return this.state();
  }
  /**
   * Time a few frames at 540p to learn how fast this device is against the cost table, so the first
   * real pick is already the right one. The shots are the table's own extremes (kit/quality.js:
   * pickCalibration), so the two factors can be told apart.
   */
  calibrate() {
    const px = new Uint8Array(4);
    const [w, h] = sizeFor(540, this.design);
    const samples = [];
    this.e.setSize(w, h);
    for (const { t } of this.q.calibrationShots(this.e.timeline.shots, { from: this.start, to: this.e.duration, h })) {
      const sel = this.e.timeline.at(t);
      const ids = [sel.a.id, sel.b?.id].filter(Boolean);
      this.e.draw(t);
      this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      this.e.draw(t);
      this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
      samples.push({ ids, h, ms: performance.now() - t0 });
    }
    this.q.calibrate(samples);
    this.calibrated = this.q.speed();
    this.key = '';
  }
  get playing() {
    return this.ready && (this.audioLed ? !!this.clock.playing : this.isPlay);
  }
  async play() {
    if (!this.ready) return;
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (this.ac && this.ac.state !== 'running') await this.ac.resume();
    this.started = true;
    if (this.t >= this.end - 0.05) this.t = this.start;
    if (this.audioLed) this.clock.play(this.t);
    this.isPlay = true;
    this.dirty = true;
    this.steady = false;
    this.next = 0;
  }
  pause() {
    if (!this.playing) return;
    if (this.clock?.playing) {
      this.clock.pause();
      this.t = this.clock.now();
    }
    this.isPlay = false;
    this.dirty = true;
  }
  toggle() {
    this.playing ? this.pause() : this.play();
  }
  seek(t) {
    if (!Number.isFinite(t)) return;
    const wasPlaying = this.playing;
    this.t = Math.min(this.end, Math.max(this.start, t));
    this.q.restart();
    this.key = '';
    this.dirty = true;
    this.steady = false;
    if (wasPlaying && this.t >= this.end - 0.001) return this.finish();
    if (this.clock) this.clock.seek(this.t);
  }
  /** Any rate but one plays silently off a virtual clock: the author is looking at the motion. */
  setRate(r) {
    const wasPlaying = this.playing;
    if (wasPlaying && this.clock?.playing) {
      this.clock.pause();
      this.t = this.clock.now();
    }
    this.rate = Number.isFinite(+r) && +r > 0 ? +r : 1;
    if (wasPlaying) {
      this.isPlay = true;
      if (this.audioLed) this.clock.play(this.t);
    }
    this.dirty = true;
    return this.rate;
  }
  /** The film is over: the clock stops, the last frame stays. */
  finish() {
    this.pause();
    this.t = this.end;
    this.dirty = true;
    this.ui.ended();
  }
  /** While the seek bar is dragged the size holds (no re-pick per frame); the release seeks once more and re-picks. */
  scrub(on) {
    this.scrubbing = on;
    if (!on) this.seek(this.t);
  }
  setVolume(v) {
    this.clock?.setVolume(v);
    this.store.set('volume', v);
  }
  setPreset(p) {
    this.q.setPreset(p);
    this.q.restart();
    this.store.set('q', p);
    this.key = '';
    this.dirty = true;
  }
  setFps(f) {
    this.q.setFps(f);
    this.store.set('fps', f);
    this.key = '';
    this.dirty = true;
  }
  resize(h) {
    const [w] = sizeFor(h, this.design);
    if (this.e.H !== h) {
      this.e.setSize(w, h);
      this.resizes++;
    }
  }
  /** Pick the size for t (re-picked at cuts and seeks), draw t; returns the CPU ms and what was drawn. */
  draw(t) {
    const sel = this.e.timeline.at(t);
    const ids = [sel.a.id, sel.b?.id].filter(Boolean);
    const key = ids.join('|');
    if (key !== this.key) {
      this.key = key;
      if (!this.scrubbing) this.resize(this.q.onSelection(ids));
      else this.q.ids = ids;
    }
    const t0 = performance.now();
    const r = this.e.draw(t);
    return { cpu: performance.now() - t0, tag: { ids, h: this.e.H }, drawn: r };
  }
  apply(r) {
    if (!r) return;
    this.resize(r.height);
    if (r.reason === 'watchdog') this.ui.notice('noticeWatchdog', { height: r.height });
  }
  tick(now) {
    const refresh = now - this.prev;
    this.prev = now;
    if (!this.ready || this.lost) return;
    if (document.hidden) {
      this.pause();
      return;
    }
    if (this.playing) {
      this.t = this.audioLed ? this.clock.now() : Math.min(this.end, this.t + (refresh / 1000) * this.rate);
      if (this.t >= this.end - 0.001) this.finish();
    }
    if (!this.dirty && (!this.playing || !due(now, this.next, refresh))) return;
    const interval = now - this.last;
    this.last = now;
    this.next = advance(now, this.next, 1e3 / this.q.fps);
    this.dirty = false;
    this.q.setMaxHeight(Math.min(this.design.h, Math.round(this.canvas.clientHeight * (devicePixelRatio || 1))));
    this.gpu.begin(null);
    const { cpu, tag } = this.draw(Math.max(this.start, this.t));
    this.gpu.end();
    if (this.gpu.pending.length) this.gpu.pending[this.gpu.pending.length - 1].tag = { ...tag, cpu };
    const steady = this.steady && this.playing;
    this.steady = this.playing;
    if (steady && interval < 1e3) this.fpsAvg = this.fpsAvg ? this.fpsAvg * 0.9 + (1e3 / interval) * 0.1 : 1e3 / interval;
    if (this.gpu.ok) {
      for (const { ms, tag: g } of this.gpu.poll()) if (g) this.q.learn(Math.max(ms, g.cpu), { ids: g.ids, h: g.h, exact: true });
    } else if (steady) this.q.learn(Math.max(cpu, interval), { exact: false });
    if (steady) this.apply(this.q.guard(Math.max(cpu, interval)));
    this.ui.update(this.state());
  }
  state() {
    const sel = this.e.timeline.at(this.t);
    return {
      t: this.t,
      playing: this.playing,
      rate: this.rate,
      w: this.e.W,
      h: this.e.H,
      fps: this.q.fps,
      preset: this.q.preset,
      fpsSetting: this.q.fpsSetting,
      measuredFps: this.fpsAvg,
      shot: sel.a.id,
      next: sel.b?.id ?? null,
      p: sel.p,
      join: sel.join?.type ?? null,
      start: this.start,
      end: this.end,
      errors: this.e.errors.length,
      audio: this.clock ? 'ready' : this.audioError ? 'failed' : 'none',
    };
  }
  /**
   * Play [from, to) on a virtual clock that advances by each frame's measured cost x slow (a slower
   * device). timer: false feeds Quality frame intervals instead of exact times, as a browser without
   * GPU timer queries. It measures this machine's cost, not wall-clock playback.
   */
  async simulate({ slow = 1, from = this.start, to = this.end, timer = true } = {}) {
    const px = new Uint8Array(4);
    const log = [];
    const heights = {};
    let t = from;
    this.key = '';
    this.resizes = 0;
    this.q.restart();
    for (let i = 0; t < to; i++) {
      const t0 = performance.now();
      const { tag } = this.draw(t);
      this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
      const ms = (performance.now() - t0) * slow;
      const interval = Math.max(ms, 1e3 / this.q.fps);
      this.apply(this.q.onFrame(timer ? ms : interval, { ids: tag.ids, h: tag.h, exact: timer }));
      log.push([+t.toFixed(3), +ms.toFixed(1), tag.h, this.q.fps]);
      heights[tag.h] = (heights[tag.h] ?? 0) + 1;
      t += interval / 1e3;
      if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
    }
    return {
      frames: log.length,
      over2x: log.filter((f) => f[1] > 2 * (1e3 / f[3]) * 0.8).length,
      over150: log.filter((f) => f[1] > 150).length,
      maxMs: Math.max(...log.map((f) => f[1])),
      resizes: this.resizes,
      heights,
      at60: log.filter((f) => f[3] === 60).length,
      fps: this.q.fps,
      scale: this.q.scale,
      log,
    };
  }
}

const quietUI = {
  update() {},
  notice() {},
  ended() {},
  progress() {},
  unsupported() {},
};
