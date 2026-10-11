// Craft kit: the reusable editorial moves — kinetic type, HUD furniture, diagram helpers, theme.
// Design-pixel coordinates here are top-left origin with +y down (same as the text layers).
import { clamp, ease, seg, lerp, hash11, hash12, rgb } from './math.js';
import { MARGIN } from './config.js';

export const THEME = {
  bg: '#080a0d',
  ink: '#eef4f8',
  dim: '#7f8f9c',
  faint: '#33404a',
  primary: '#7ef0ff',
  accent: '#ffb36b',
  hot: '#ff5a6a',
  good: '#6cf0a8',
  grid: '#1b2530',
  display: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", Consolas, ui-monospace, monospace',
  cjk: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  lyricSize: MARGIN.lyricSize,
  lyricColor: '#ffffff',
  lyricGlow: 14,
};

export const easeByName = (name) => ease[name] ?? ease.linear;

/** `open(t, start)` — the standard 0..1 entrance curve for a shot's first beats. */
export function open(t, start, dur = 0.5, name = 'outCubic') {
  return easeByName(name)(seg(t, start, start + dur));
}

/** A pop that reads as weight: overshoot then settle, used after an element locks in. */
export function pop(age, amp = 0.12, tau = 0.05) {
  return 1 + amp * Math.exp(-age / tau);
}

/** Freshly-lit element flash (ticks, bars, rows): hot for a moment, then joins the rest. */
export function tickFlash(age, rate = 18) {
  return Math.exp(-age * rate);
}

/** Stagger: element i of n starts `span` seconds after element 0. */
export function stagger(i, n, { span = 0.28, from = 0, mode = 'linear' } = {}) {
  const k = mode === 'edge' ? 1 - Math.abs((i / Math.max(1, n - 1)) * 2 - 1) : i / Math.max(1, n);
  return from + span * k;
}

/** Per-word karaoke lyric line. Shots that stage their own text set `ownsLyrics: true`. */
export function drawLyrics(layer, T, t, opts = {}) {
  const line = T.lineAt(t, { hold: opts.hold ?? 0.35 });
  if (!line) return;
  const fadeOut = 1 - seg(t, line.end + 0.05, line.end + (opts.fade ?? 0.4));
  if (fadeOut <= 0.001) return;
  const size = opts.size ?? THEME.lyricSize;
  const o = {
    size,
    weight: opts.weight ?? 500,
    family: opts.family ?? THEME.cjk,
    color: opts.color ?? THEME.lyricColor,
    align: 'center',
    baseline: 'middle',
    glow: opts.glow ?? THEME.lyricGlow,
    glowColor: opts.glowColor ?? THEME.primary,
    alpha: fadeOut,
  };
  const words = line.words?.length ? line.words : [{ text: line.text, start: line.start, end: line.end }];
  const space = size * 0.26;
  const widths = words.map((w) => layer.measure(w.text, o));
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  let x = MARGIN.gutter + (MARGIN.safe.x1 - MARGIN.safe.x0 - total) / 2;
  words.forEach((w, i) => {
    const a = seg(t, w.start - 0.03, w.start + 0.09) * fadeOut;
    if (a > 0.01) layer.text(w.text, x, opts.y ?? MARGIN.lyricY, { ...o, alpha: a });
    x += widths[i] + space;
  });
}

/** Decode-reveal: glyphs churn, then lock left to right. The default way to introduce a key word. */
export function heroWord(layer, str, x, y, { t, start = 0, decode = 0.45, lock = 0.06, size = 160, color = THEME.ink, glow = 26, glowColor = THEME.primary, family = '"Space Grotesk", system-ui, sans-serif', weight = 800, align = 'center', churn = 'ABCDEFGHJKLMNPQRSTUVWXYZ#%&*01', alpha = 1 } = {}) {
  const chars = [...str];
  const o = { size, weight, family, align: 'left', baseline: 'middle' };
  const widths = chars.map((c) => layer.measure(c, o));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = x - (align === 'center' ? total / 2 : align === 'right' ? total : 0);
  chars.forEach((c, i) => {
    const lockT = start + decode * ((i + 1) / chars.length);
    const done = seg(t, lockT, lockT + lock);
    const shown = done >= 1;
    const glyph = shown ? c : churn[(hash11(i * 7.3 + Math.floor((t - start) * 24)) * churn.length) | 0];
    const age = t - lockT - lock;
    const sc = shown && age > 0 && age < 0.3 ? pop(age, 0.08, 0.06) : 1;
    const a = (shown ? 1 : 0.55 + 0.45 * done) * alpha;
    layer.text(glyph, cx + widths[i] / 2, y, {
      ...o,
      align: 'center',
      color: shown ? color : THEME.primary,
      alpha: a,
      glow,
      glowColor,
      scale: sc,
    });
    cx += widths[i];
  });
  return total;
}

/** Typewriter with caret: use for code, logs and panel fields. */
export function typeLine(layer, str, x, y, { t, cps = 22, start = 0, caret = true, caretColor = THEME.primary, ...o } = {}) {
  const n = clamp((t - start) * cps, 0, str.length) | 0;
  const w = layer.text(str.slice(0, n), x, y, o);
  if (caret && (n < str.length || Math.floor(t * 2) % 2 === 0)) {
    const cw = layer.measure(str.slice(0, n), o);
    const ox = o.align === 'center' ? -cw / 2 : o.align === 'right' ? -cw : 0;
    layer.text('▍', x + ox + cw + (o.size ?? 40) * 0.06, y, { ...o, color: caretColor, alpha: 0.85 });
  }
  return w;
}

/** Corner brackets + timecode bar: the film's frame furniture. Identical on every shot. */
export function hudFrame(layer, { W = 1920, H = 1080, inset = MARGIN.inset, len = MARGIN.bracket, color = THEME.dim, alpha = 0.5, label, time, beatPulse = 0, ticks = true } = {}) {
  const L = len * (1 + beatPulse * 0.25);
  layer.draw((g) => {
    g.save();
    g.strokeStyle = color;
    g.globalAlpha = alpha * (1 + beatPulse * 0.5);
    g.lineWidth = 2;
    const cs = [[inset, inset, 1, 1], [W - inset, inset, -1, 1], [inset, H - inset, 1, -1], [W - inset, H - inset, -1, -1]];
    for (const [x, y, sx, sy] of cs) {
      g.beginPath();
      g.moveTo(x + sx * L, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * L);
      g.stroke();
    }
    g.restore();
  });
  if (label) layer.text(label, inset, inset - 14, { size: MARGIN.hudSize, weight: 600, family: THEME.mono, color, alpha, baseline: 'bottom' });
  if (time) layer.text(time, W - inset, inset - 14, { size: MARGIN.hudSize, weight: 600, family: THEME.mono, color, alpha, align: 'right', baseline: 'bottom' });
  if (ticks) layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha * 0.55;
    g.fillStyle = color;
    for (let i = 0; i < 24; i++) {
      const x = inset + ((W - inset * 2) * i) / 23;
      g.fillRect(x - 0.75, H - inset + 6, 1.5, i % 6 === 0 ? 8 : 4);
    }
    g.restore();
  });
}

/** Key/value block: the cheapest way to make a frame look instrumented. */
export function readout(layer, x, y, rows, { size = 19, gap = 26, labelColor = THEME.dim, valueColor = THEME.ink, family = '"JetBrains Mono", monospace', align = 'left', alpha = 1, cols = [0, 150] } = {}) {
  rows.forEach((r, i) => {
    const yy = y + i * gap;
    const [k, v] = typeof r === 'string' ? ['', r] : r;
    if (k) layer.text(k, x + cols[0], yy, { size, weight: 500, family, color: labelColor, alpha, baseline: 'middle' });
    layer.text(String(v), x + (k ? cols[1] : 0), yy, { size, weight: 600, family, color: valueColor, alpha, baseline: 'middle', align: align === 'right' ? 'right' : 'left' });
  });
}

/** Engineering dimension line between two design points. */
export function dimLine(layer, a, b, { color = THEME.dim, text, alpha = 0.7, gap = 8, tick = 7 } = {}) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const off = (dx, dy) => [dx + nx * gap, dy + ny * gap];
  const [p0, p1] = [off(a[0], a[1]), off(b[0], b[1])];
  layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(p0[0], p0[1]);
    g.lineTo(p1[0], p1[1]);
    for (const [px, py, ex, ey] of [[p0[0], p0[1], a[0], a[1]], [p1[0], p1[1], b[0], b[1]]]) {
      g.moveTo(ex, ey);
      g.lineTo(px, py);
      g.moveTo(px - nx * tick, py - ny * tick);
      g.lineTo(px + nx * tick, py + ny * tick);
    }
    g.stroke();
    g.restore();
  });
  if (text) layer.text(text, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 - 6, { size: 18, weight: 600, family: THEME.mono, color, alpha, align: 'center', baseline: 'bottom' });
}

/** Dark backing so HUD stays readable over a busy shot. */
export function scrim(layer, x, y, w, h, { alpha = 0.5, radius = 8, blur = 14 } = {}) {
  layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha;
    g.filter = `blur(${blur}px)`;
    g.fillStyle = '#05070a';
    roundRect(g, x, y, w, h, radius);
    g.fill();
    g.restore();
  });
}

export function panel(layer, x, y, w, h, { stroke = THEME.grid, fill = 'rgba(8,11,15,0.62)', lineWidth = 1.5, radius = 10, alpha = 1, title, titleSize = 18, cornerTicks = true } = {}) {
  layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha;
    if (fill) {
      g.fillStyle = fill;
      roundRect(g, x, y, w, h, radius);
      g.fill();
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = lineWidth;
      roundRect(g, x, y, w, h, radius);
      g.stroke();
    }
    if (cornerTicks) {
      g.globalAlpha = alpha * 0.8;
      g.strokeStyle = stroke ?? THEME.dim;
      const L = 12;
      for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        g.beginPath();
        g.moveTo(cx + sx * L, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + sy * L);
        g.stroke();
      }
    }
    g.restore();
  });
  if (title) layer.text(title, x + 16, y + 20, { size: titleSize, weight: 600, family: THEME.mono, color: THEME.dim, baseline: 'middle' });
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Leader line from a design-space anchor to a label that appears once the draw-in finishes. */
export function callout(layer, from, to, text, { draw = 1, color = THEME.primary, textColor = THEME.ink, size = 22, alpha = 1 } = {}) {
  if (draw <= 0.001) return;
  const e = ease.outCubic(clamp(draw));
  const p = [lerp(from[0], to[0], e), lerp(from[1], to[1], e)];
  layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha * 0.9;
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(from[0], from[1]);
    g.lineTo(p[0], p[1]);
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.arc(from[0], from[1], 3.2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  });
  if (e > 0.6) layer.text(text, to[0] + (to[0] > from[0] ? 10 : -10), to[1], { size, weight: 600, family: THEME.display, color: textColor, align: to[0] > from[0] ? 'left' : 'right', baseline: 'middle', alpha: seg(e, 0.6, 1) * alpha, glow: 8, glowColor: color });
}

/** Dashed floor grid in world space (drawn with GlowLines so it blooms). */
export function floorGrid(lines, { y = -320, x0 = -2200, x1 = 2200, z0 = -2400, z1 = 1200, step = 200, color = rgb(THEME.grid, 1.1), width = 1.6, fade = 0.55 } = {}) {
  const n = Math.ceil((z1 - z0) / step);
  for (let i = 0; i <= n; i++) {
    const z = z0 + i * step;
    const k = clamp(1 - fade * (i / n));
    lines.segment([x0, y, z], [x1, y, z], { color: color.map((c) => c * k), width, glow: 0.3 });
  }
  const m = Math.ceil((x1 - x0) / step);
  for (let i = 0; i <= m; i++) {
    const x = x0 + i * step;
    lines.segment([x, y, z0], [x, y, z1], { color: color.map((c) => c * 0.7), width: width * 0.85, glow: 0.2 });
  }
}

/** Horizontal progress/meter bar in design px. */
export function meter(layer, x, y, w, h, v, { color = THEME.primary, track = THEME.grid, alpha = 1, glow = 12, label } = {}) {
  layer.draw((g) => {
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = track;
    g.fillRect(x, y, w, h);
    g.fillStyle = color;
    g.fillRect(x, y, w * clamp(v), h);
    g.restore();
  });
  if (label) layer.text(label, x, y - 8, { size: 17, weight: 600, family: THEME.mono, color: THEME.dim, alpha, baseline: 'bottom' });
}

/** Design px (top-left, +y down) -> world units (centre, +y up). The one bridge between the
 *  text layer and the GL primitives; use it instead of doing the subtraction by hand. */
export function px2world(x, y, z = 0) {
  return [x - 960, 540 - y, z];
}
export const world2px = (p) => [p[0] + 960, 540 - (p[1] ?? 0)];

/** `MM:SS.FF` timecode for the HUD. Frames, not decimals: editors read frames. */
export function timecode(lt, fps = 30) {
  const s = Math.max(0, lt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}.${pad(Math.floor((s % 1) * fps))}`;
}

/** Deterministic jitter for "hand-placed" layouts. */
export const jitter = (i, amp = 6, seed = 0) => (hash12(i * 3.17 + seed, i * 1.31 + seed) - 0.5) * 2 * amp;
