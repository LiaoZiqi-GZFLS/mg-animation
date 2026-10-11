// Browser bootstrap: live preview + deterministic frame export hooks (window.MG).
// Loaded by index.html as <script type="module" src="kit/player.js">. Query knobs:
//   ?film=./src/film.js  &data=analysis/out  &t=12.3  &still=1  &render=1  &q=1080  &hideUI=1
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { Timing, keys } from './timing.js';
import { Features } from './features.js';
import { Prog } from './gl.js';
import { Cam } from './prims.js';
import * as M from './math.js';

const q = new URLSearchParams(location.search);

export async function boot() {
  const filmUrl = q.get('film') ?? './src/film.js';
  const dataDir = q.get('data') ?? 'analysis/out';
  const filmHref = new URL(filmUrl, location.href).href;
  const mod = await import(filmHref);
  const def = mod.default ?? mod.film;
  if (!def?.shots?.length) throw new Error(`${filmUrl} must default-export { shots: [...] }`);
  let file = {};
  try {
    file = await (await fetch(new URL('./film.config.json', location.href).href)).json();
  } catch {}
  const config = { ...file, ...(mod.config ?? {}), ...(def.config ?? {}) };
  if (file.audio && !def.audio) def.audio = file.audio;
  if (file.title && !def.title) def.title = file.title;
  let T;
  try {
    T = await Timing.load(`${dataDir}/timing.json`, `${dataDir}/onsets.json`);
  } catch {
    T = new Timing({ audio: { duration: def.duration ?? config.duration ?? 30 } }, {}, { duration: def.duration ?? config.duration ?? 30 });
  }
  const F = await Features.load(`${dataDir}/features.json`, `${dataDir}/features.f32`);
  const timeline = new Timeline(def, T);
  const canvas = document.getElementById('screen');
  const engine = new Engine({ canvas, def, timeline, timing: T, features: F, config });
  const design = engine.config.design;
  const target = Number(q.get('q')) || design.h;
  const setH = (h) => engine.setSize(Math.round((h * design.w) / design.h), h);
  setH(target);

  let audio = null;
  const audioUrl = def.audio ?? config.audio;
  if (audioUrl && !q.has('render')) {
    audio = new Audio(audioUrl);
    audio.preload = 'auto';
  }

  const MG = {
    engine,
    timeline,
    T,
    F,
    keys: keys(T),
    config: engine.config,
    playing: false,
    fps: engine.config.renderFps ?? 30,
    errors: [],
    setSize: setH,
    info() {
      return {
        duration: engine.duration,
        shots: timeline.shots.map((s) => ({ id: s.id, start: +s.start.toFixed(4), end: +s.end.toFixed(4), join: s.join?.type ?? null })),
        problems: engine.validate(),
        errors: engine.errors.slice(-6),
        gpu: engine.gl.getParameter(engine.gl.VERSION),
        size: [engine.W, engine.H],
      };
    },
    draw(t) {
      return engine.draw(t);
    },
    /** Export entry point: frame i renders at exactly i/fps. Call in ascending order. */
    frameAt(i, fps = MG.fps) {
      const t = i / fps;
      const r = engine.draw(t);
      return { i, t: +t.toFixed(5), ...r, errors: engine.errors.length };
    },
    seek(t) {
      const e = Math.max(0, Math.min(engine.duration, t));
      if (audio) audio.currentTime = e;
      engine.draw(e);
      status(e);
      return e;
    },
    prewarm() {
      engine.prewarm((p, id) => status(null, `prewarm ${Math.round(p * 100)}% ${id}`));
      status(0);
      return engine.validate();
    },
    play() {
      if (!audio) return null;
      audio.play();
      MG.playing = true;
      return MG.playing;
    },
    pause() {
      audio?.pause();
      MG.playing = false;
      return false;
    },
    /** In render mode the canvas CSS size must equal its backing size, or screenshots get resampled. */
    exportMode(W, H) {
      document.body.dataset.mode = 'export';
      if (W && H) engine.setSize(W, H);
      canvas.style.width = `${engine.W}px`;
      canvas.style.height = `${engine.H}px`;
      return [engine.W, engine.H];
    },
  };
  window.MG = MG;

  const el = document.getElementById('status');
  function status(t, note) {
    if (!el || document.body.dataset.mode === 'export') return;
    const r = t == null ? null : engine.timeline.at(t);
    el.textContent = note ?? `${t?.toFixed(2)}s · ${r?.b ? `${r.a.id} → ${r.b.id} p=${r.p.toFixed(2)}` : r?.a?.id ?? '—'} · ${(1000 / Math.max(dtAvg, 0.01)).toFixed(0)} fps`;
  }

  if (!q.has('render') && !q.has('hideUI')) {
    let last = performance.now(), acc = 0, dtAvg = 16.7;
    const loop = (now) => {
      const dt = now - last;
      last = now;
      acc += dt;
      if (acc > 250) {
        dtAvg = acc / 10;
        acc = 0;
      }
      if (MG.playing && audio) {
        const t = audio.currentTime;
        if (t >= engine.duration) {
          MG.pause();
        } else engine.draw(t);
        status(t);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    addEventListener('keydown', (e) => {
      const t = audio ? audio.currentTime : 0;
      if (e.code === 'Space') {
        e.preventDefault();
        MG.playing ? MG.pause() : MG.play();
      } else if (e.code === 'ArrowRight') MG.seek(t + (e.shiftKey ? 5 : 1));
      else if (e.code === 'ArrowLeft') MG.seek(t - (e.shiftKey ? 5 : 1));
      else if (e.key === ']' || e.key === '[') {
        const dir = e.key === ']' ? 1 : -1;
        const cur = timeline.shotAt(t);
        const i = timeline.shots.indexOf(cur) + dir;
        const s = timeline.shots[Math.max(0, Math.min(timeline.shots.length - 1, i))];
        MG.seek(s.start + 0.02);
      }
    });
    if (audio) audio.addEventListener('timeupdate', () => status(audio.currentTime));
  }

  const start = q.get('t');
  if (start != null) MG.seek(Number(start));
  else engine.draw(q.has('render') ? 0 : 0);
  status(Number(start) || 0, 'ready');
  document.body.dataset.ready = '1';
  return MG;
}

export { Engine, Timeline, Timing, Features, Prog, Cam, M, keys };

if (document.body.dataset.autoboot !== 'off') boot().catch((e) => {
  document.body.dataset.ready = 'error';
  const s = document.getElementById('status');
  if (s) s.textContent = `boot failed: ${e.message}`;
  console.error(e);
});
