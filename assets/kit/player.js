// Browser bootstrap: live preview + deterministic frame export hooks (window.MG).
// Loaded by index.html as <script type="module" src="kit/player.js">. Query knobs:
//   ?film=./src/film.js  &data=analysis/out  &t=12.3  &still=1  &render=1  &q=1080  &hideUI=1
// In render mode nothing below touches the clock, the quality controller or the UI: a frame is
// engine.draw(i/fps) and nothing else, which is what makes an exported film reproducible.
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { Timing, keys } from './timing.js';
import { Features } from './features.js';
import { Prog } from './gl.js';
import { Cam } from './prims.js';
import * as M from './math.js';
import { PRESETS, Quality } from './quality.js';
import { Transport, makeSession, makeStore, startOptions } from './transport.js';
import { UI } from './ui.js';
import { makeText } from './i18n.js';

const q = new URLSearchParams(location.search);
const RENDER = q.has('render');

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

  const audioUrl = def.audio ?? config.audio;

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
      if (MG.transport) MG.transport.seek(e);
      else engine.draw(e);
      status(e);
      return e;
    },
    prewarm() {
      engine.prewarm((p, id) => status(null, `prewarm ${Math.round(p * 100)}% ${id}`));
      status(0);
      return engine.validate();
    },
    play() {
      return MG.transport?.play() ?? null;
    },
    pause() {
      MG.transport?.pause();
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
    const s = MG.transport?.state();
    const r = t == null ? null : engine.timeline.at(t);
    const fps = s?.measuredFps ?? 0;
    el.textContent =
      note ??
      `${(t ?? s?.t ?? 0).toFixed(2)}s · ${r?.b ? `${r.a.id} → ${r.b.id} p=${r.p.toFixed(2)}` : r?.a?.id ?? s?.shot ?? '—'} · ${fps.toFixed(0)} fps · ${s?.h ?? engine.H}p`;
  }

  if (!RENDER) {
    const store = makeStore(`mg.${def.id ?? 'film'}.player`);
    let cost = null;
    try {
      cost = await (await fetch(new URL(`${dataDir}/cost.json`, location.href).href)).json();
    } catch {
      cost = null; // never calibrated: the controller learns from the frames it draws
    }
    const quality = new Quality({ cost, design, preset: store.get('q', 'auto'), fps: store.get('fps', 'auto') });
    const ui = q.has('hideUI') ? null : new UI({ engine, timeline, t: makeText(config.preview), design, store });
    const transport = new Transport({ canvas, engine, quality, ui, store, session: makeSession(`mg.${def.id ?? 'film'}`) });
    ui?.attach(transport);
    Object.assign(MG, { transport, quality, ui, playing: false });
    const start = startOptions(q, { saved: { q: store.get('q', 'auto'), fps: store.get('fps', 'auto') }, presets: PRESETS });
    quality.setPreset(start.preset);
    quality.setFps(start.fps);
    await transport.prepare({ audioUrl, onProgress: (s, p) => status(null, `${s} ${Math.round(p * 100)}%`) });
    transport.seek(Number.isFinite(+q.get('t')) ? +q.get('t') : start.t);
    if (q.get('autoplay') === '1') transport.play();
    if (!ui) {
      // A bar-less preview keeps the keyboard contract the reference player has.
      addEventListener('keydown', (e) => {
        const t = transport.t;
        if (e.code === 'Space') {
          e.preventDefault();
          transport.toggle();
        } else if (e.code === 'ArrowRight') transport.seek(t + (e.shiftKey ? 5 : 1));
        else if (e.code === 'ArrowLeft') transport.seek(t - (e.shiftKey ? 5 : 1));
        else if (e.key === ']' || e.key === '[') {
          const dir = e.key === ']' ? 1 : -1;
          const i = timeline.shots.indexOf(timeline.shotAt(t)) + dir;
          const s = timeline.shots[Math.max(0, Math.min(timeline.shots.length - 1, i))];
          transport.seek(s.start + 0.02);
        }
      });
    }
  }

  if (RENDER) {
    const start = q.get('t');
    if (start != null) MG.seek(Number(start));
    else engine.draw(0);
    status(Number(start) || 0, 'ready');
  }
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
