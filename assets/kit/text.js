// Text: a Canvas2D layer in design-pixel units, uploaded as a texture.
// Two layers per frame: `scene` (composited before bloom, so type glows) and `overlay` (after grading, exact colour).
import { texFromCanvas } from './gl.js';

export class TextCanvas {
  constructor(design = { w: 1920, h: 1080 }) {
    this.design = design;
    this.canvas = document.createElement('canvas');
    this.g = this.canvas.getContext('2d');
    this.dirty = false;
    this.tex = null;
    this.W = 0;
    this.H = 0;
    this.s = 1;
  }
  setSize(W, H, gl) {
    if (this.W === W && this.H === H) return this;
    this.W = W;
    this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.s = W / this.design.w;
    if (gl) this.tex = texFromCanvas(gl, this.canvas, this.tex);
    this.dirty = true;
    return this;
  }
  clear() {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    this.dirty = true;
    return this;
  }
  /** Everything inside runs with the design-pixel coordinate system active. */
  draw(fn) {
    const g = this.g;
    g.save();
    g.setTransform(this.s, 0, 0, this.s, 0, 0);
    fn(g);
    g.restore();
    this.dirty = true;
    return this;
  }
  font(o = {}) {
    const size = o.size ?? 40;
    const weight = o.weight ?? 600;
    const family = o.family ?? 'sans-serif';
    return `${o.italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
  }
  measure(str, o = {}) {
    const g = this.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = this.font(o);
    const w = g.measureText(str).width;
    g.restore();
    if (o.tracking) return w + Math.max(0, str.length - 1) * o.tracking;
    return w;
  }
  /**
   * @param o {size,weight,family,italic,color,alpha,align,baseline,tracking,glow,glowColor,stroke,strokeWidth,
   *            rot,scale,from,to,perChar:(ch,i)=>({alpha,scale,dx,dy,color}),shadow}
   */
  text(str, x, y, o = {}) {
    const s = String(str);
    const from = o.from ?? 0;
    const to = o.to ?? s.length;
    const slice = s.slice(from, to);
    if (!slice.length) return 0;
    const tracking = o.tracking ?? 0;
    const perChar = o.perChar;
    const widths = [];
    let total = 0;
    const g = this.g;
    g.save();
    g.setTransform(this.s, 0, 0, this.s, 0, 0);
    g.font = this.font(o);
    for (let i = 0; i < slice.length; i++) {
      const w = g.measureText(slice[i]).width + (i ? tracking : 0);
      widths.push(w);
      total += w;
    }
    const ox = o.align === 'center' ? -total / 2 : o.align === 'right' ? -total : 0;
    g.translate(x + (o.dx ?? 0), y + (o.dy ?? 0));
    if (o.rot || o.scale && o.scale !== 1) {
      if (o.rot) g.rotate(o.rot);
      if (o.scale && o.scale !== 1) g.scale(o.scale, o.scale);
    }
    g.textBaseline = o.baseline ?? 'alphabetic';
    g.textAlign = 'left';
    if (o.glow) {
      g.shadowColor = o.glowColor ?? o.color ?? '#fff';
      g.shadowBlur = o.glow;
    }
    let cx = ox;
    for (let i = 0; i < slice.length; i++) {
      const idx = from + i;
      const m = perChar ? perChar(slice[i], idx, i) : null;
      const alpha = (m && m.alpha !== undefined ? m.alpha : 1) * (o.alpha ?? 1);
      if (alpha > 0.002) {
        const sc = (m && m.scale) ?? 1;
        g.save();
        g.globalAlpha = clamp01(alpha);
        g.translate(cx + (m?.dx ?? 0), m?.dy ?? 0);
        if (sc !== 1) g.scale(sc, sc);
        const col = (m && m.color) || o.color || '#ffffff';
        if (o.stroke) {
          g.lineWidth = o.strokeWidth ?? 2;
          g.strokeStyle = o.stroke;
          g.strokeText(slice[i], 0, 0);
        }
        g.fillStyle = col;
        g.fillText(slice[i], 0, 0);
        g.restore();
      }
      cx += widths[i];
    }
    g.restore();
    this.dirty = true;
    return total;
  }
  upload(gl) {
    this.tex = texFromCanvas(gl, this.canvas, this.tex);
    return { __tex: true, tex: this.tex };
  }
  get handle() {
    return { __tex: true, tex: this.tex };
  }
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
