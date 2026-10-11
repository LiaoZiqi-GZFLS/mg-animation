// Project defaults. A film overrides these in its own config object.

export const PROJECT = {
  id: 'film',
  title: 'Untitled MG film',
  /** All authoring coordinates are design pixels; every resolution is a uniform scale of this grid. */
  design: { w: 1920, h: 1080 },
  fps: 60,
  /** Offline export rate. 30 is the editorial default for MG; use 60 for fast camera work. */
  renderFps: 30,
  duration: 30,
  preroll: 0,
  /** Supersampling factor applied on top of the export size (1.5 gives visibly cleaner glow/line edges). */
  supersample: 1.5,
  fonts: {
    display: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Consolas", ui-monospace, monospace',
    cjk: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  },
  audio: null,
  /** ffmpeg export settings; crf 16 at 1080p is visually transparent for flat graphics. */
  encode: {
    master: { width: 3840, height: 2160, fps: 30, crf: 14, preset: 'slow', pixfmt: 'yuv444p10le' },
    hd: { width: 1920, height: 1080, fps: 30, crf: 16, preset: 'slow', pixfmt: 'yuv420p', maxrate: '24M' },
  },
};

/** Margins and sizes shared by every shot so cuts never shift the frame furniture. */
export const MARGIN = {
  inset: 44,
  bracket: 26,
  gutter: 96,
  safe: { x0: 96, x1: 1824, y0: 96, y1: 984 },
  lyricY: 968,
  lyricSize: 38,
  hudSize: 20,
  readoutX: 1480,
  readoutY: 150,
};

export function resolveConfig(filmConfig = {}, overrides = {}) {
  const c = { ...PROJECT, ...filmConfig };
  c.design = { ...PROJECT.design, ...(filmConfig.design || {}) };
  c.encode = { ...PROJECT.encode, ...(filmConfig.encode || {}) };
  c.fonts = { ...PROJECT.fonts, ...(filmConfig.fonts || {}) };
  return Object.assign(c, overrides);
}
