// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/subs.js`, `src/subs/schedule.js` and `src/subs/style.js`
// at commit 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications, relative to those files:
//   1. The three are one module, without the bundler's `__exportAll` runtime.
//   2. `src/subs/rules.js` is a film's own code in the reference project (an accent-per-section
//      function and rows that something else occupies). Nothing here can ship that: the accent map,
//      the skip sections, the silent lines and the busy rows all come from the translation file as
//      data, and `rows` is a list of [from, to] pairs rather than a function of the Timing.
//   3. No font is fetched: the reference player loads the one its project ships. This kit names the
//      faces the page already has and takes a `font` block from the film's config if it wants other.
//   4. Drawing goes through this kit's TextCanvas, so a subtitle enters the same overlay pass as the
//      film's own text and is graded with it, rather than being a second canvas in the page.
//   5. `designWidth` is the film's own design size, passed in as `design`.

/** How a subtitle behaves, not how it looks: the reference project's defaults. */
export const SUBS = Object.freeze({ fadeIn: 0.1, fadeOut: 0.2, hold: 1 });

/**
 * The subtitles in order: [{ i, text, start, end, fadeIn, fadeOut, row, accent }].
 *   T      this kit's Timing: lines with i, start, end; sections
 *   lines  { [i]: text }: the translation (a missing or empty entry: that line gets no subtitle)
 *   o      { skip: [section ids], silent: [line indices], rows: [[from, to]], accent: { [sectionId]: colour },
 *          hold, fadeIn, fadeOut }
 *          skip: sections a subtitle may not run into (instrumentals); silent: lines the film does not
 *          subtitle even though the translation has them; rows: time ranges where something else sits on
 *          the subtitles' row (a subtitle mostly inside one drops a row); accent: the colour of the
 *          style's mark inside a section (its own colour where a section is not listed).
 */
export function subtitleEvents(T, lines, o = {}) {
  const S = { ...SUBS, ...o };
  const silent = new Set(o.silent ?? []);
  const shown = T.lines.filter((l, k) => lines[l.i ?? k] != null && lines[l.i ?? k] !== '' && !silent.has(l.i ?? k));
  const stops = (o.skip ?? []).map((id) => T.section(id).start);
  const busy = (o.rows ?? []).map((r) => (typeof r === 'function' ? r(T) : r));
  const ev = shown.map((l, k) => {
    const key = l.i ?? k;
    const next = shown[k + 1]?.start ?? Infinity;
    let end = Math.min(next, l.end + S.hold);
    for (const s of stops) if (s > l.start && s < end) end = s;
    const over = busy.reduce((m, [a, b]) => Math.max(m, Math.min(b, end) - Math.max(a, l.start)), 0);
    return {
      i: key,
      text: lines[key],
      start: l.start,
      end,
      fadeOut: end < next,
      row: over > (end - l.start) / 2 ? 1 : 0,
      accent: o.accent?.[T.sectionAt(l.start)?.id] ?? null,
    };
  });
  ev.forEach((e, k) => {
    e.fadeIn = k === 0 || ev[k - 1].end < e.start;
  });
  return ev;
}

/** The subtitle on screen at song time t: { i, text, row, accent, alpha }, or null. */
export function subtitleAt(ev, t, o = {}) {
  const S = { ...SUBS, ...o };
  let lo = 0,
    hi = ev.length - 1,
    k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ev[m].start <= t) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  const e = ev[k];
  if (!e || t >= e.end) return null;
  const ramp = (d, len) => (d >= len - 1e-9 ? 1 : d / len);
  const a = (e.fadeIn ? ramp(t - e.start, S.fadeIn) : 1) * (e.fadeOut ? ramp(e.end - t, S.fadeOut) : 1);
  return a > 0 ? { i: e.i, text: e.text, row: e.row, accent: e.accent, alpha: a } : null;
}

/** What a subtitle picture depends on: frames with the same key look the same. */
export const subtitleKey = (s) => (s ? `L${s.i}_${s.row}_${Math.round(s.alpha * 255)}` : 'empty');

/** The reference project's subtitle layout, in design pixels, with this kit's own faces. */
export const STYLE = Object.freeze({
  font: { family: 'system-ui', weight: 500 },
  align: 'left',
  x: 146,
  base: 984,
  drop: 52,
  size: 38,
  ink: [170, 180, 200],
  alpha: 0.86,
  shadow: [0.8, 0.5],
  mark: { text: '//', font: 'monospace', weight: 500, size: 30, gap: 12, color: '#aab4c8', alpha: 0.8 },
});

/**
 * Draw subtitle s (from subtitleAt; null clears) on a 2D context whose transform already maps design
 * pixels, at `scale` canvas pixels per design pixel and showing the area whose top left is `origin`.
 * `clear` wipes the whole canvas first — true on a canvas the subtitles own, false when they are
 * painted beside a shot's own text.
 */
export function drawSubtitle(g, s, style, scale = 1, origin = { x: 0, y: 0 }, clear = true) {
  if (clear) g.clearRect(0, 0, g.canvas.width / scale, g.canvas.height / scale);
  if (!s) return;
  const St = { ...STYLE, ...style }, S = scale, m = St.mark;
  const x = (St.x - origin.x) * S,
    y = (St.base + s.row * St.drop - origin.y) * S;
  const font = `${St.font.weight} ${St.size * S}px "${St.font.family}"`;
  const mfont = m && `${m.weight ?? 500} ${m.size * S}px "${m.font}"`;
  g.save();
  g.textBaseline = 'alphabetic';
  g.font = font;
  const w = g.measureText(s.text).width;
  const left = St.align === 'center' ? x - w / 2 : St.align === 'right' ? x - w : x;
  const OFF = 2e4;
  g.globalAlpha = s.alpha;
  for (const [blur, a] of [
    [6 * S, St.shadow[0]],
    [16 * S, St.shadow[1]],
  ]) {
    g.shadowColor = `rgba(0,0,0,${a})`;
    g.shadowBlur = blur;
    g.shadowOffsetX = OFF;
    g.font = font;
    g.textAlign = 'left';
    g.fillText(s.text, left - OFF, y);
    if (m) {
      g.font = mfont;
      g.textAlign = 'right';
      g.fillText(m.text, left - m.gap * S - OFF, y);
    }
  }
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  g.shadowOffsetX = 0;
  if (m) {
    g.font = mfont;
    g.textAlign = 'right';
    g.fillStyle = s.accent ?? m.color;
    g.globalAlpha = s.alpha * m.alpha;
    g.fillText(m.text, left - m.gap * S, y);
  }
  g.font = font;
  g.textAlign = 'left';
  g.fillStyle = `rgb(${St.ink.join(',')})`;
  g.globalAlpha = s.alpha * St.alpha;
  g.fillText(s.text, left, y);
  g.restore();
}

export class Subtitles {
  /**
   * translations { [lang]: { lines, skip?, silent?, rows?, accent? } } — one file per language, the
   * film's own rows and accents for the schedule. A language whose events cannot be made is left out
   * with a warning: subtitles are an extra, and one bad file must not stop the film.
   */
  constructor(T, translations, { style = null, design = { w: 1920, h: 1080 } } = {}) {
    this.T = T;
    this.style = { ...STYLE, ...(style ?? {}) };
    this.design = design;
    this.events = {};
    for (const [lang, tr] of Object.entries(translations)) {
      try {
        this.events[lang] = subtitleEvents(T, tr.lines ?? {}, {
          skip: tr.skip ?? [],
          silent: tr.silent ?? [],
          rows: tr.rows ?? [],
          accent: tr.accent ?? null,
        });
      } catch (e) {
        console.warn(`subtitles '${lang}' left out: ${e?.message ?? e}`);
      }
    }
    this.ready = Promise.resolve();
  }
  get langs() {
    return Object.keys(this.events);
  }
  at(lang, t) {
    return this.events[lang] ? subtitleAt(this.events[lang], t) : null;
  }
  /** Paint the subtitle of `lang` at t onto a TextCanvas, beside whatever the shot already drew there. */
  paint(layer, lang, t) {
    const s = this.at(lang, t);
    if (!s) return null;
    layer.draw((g) => {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      drawSubtitle(g, s, this.style, layer.s, { x: 0, y: 0 }, false);
      g.restore();
    });
    return s;
  }
}
