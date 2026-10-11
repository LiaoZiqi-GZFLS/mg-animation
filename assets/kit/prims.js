// World primitives: camera, additive glow lines, GPU particle swarm, point-table shapes, raw geometry.
// Convention: 1 world unit = 1 design pixel, +y up, and the z=0 plane fills the frame at fov 45 (FIT_DIST).
import { Prog, dataTexture } from './gl.js';
import { vsub, vnorm, vcross, vlen, m4perspective, m4ortho, m4lookAt, m4mul, m4rotY, m4rotX, clamp, TAU, hash11 } from './math.js';

export const FIT_DIST = 540 / Math.tan((45 * Math.PI) / 360);

export class Cam {
  constructor(o = {}) {
    this.mode = o.mode ?? 'persp';
    this.eye = o.eye ?? [0, 0, FIT_DIST];
    this.target = o.target ?? [0, 0, 0];
    this.up = o.up ?? [0, 1, 0];
    this.fov = o.fov ?? (45 * Math.PI) / 180;
    this.orthoH = o.orthoH ?? 1080;
    this.near = o.near ?? 1;
    this.far = o.far ?? 30000;
    this.roll = o.roll ?? 0;
    this.shift = o.shift ?? [0, 0];
    this.zoom = o.zoom ?? 1;
  }
  clone(o = {}) {
    return new Cam({ mode: this.mode, target: [...this.target], up: [...this.up], eye: [...this.eye], fov: this.fov, orthoH: this.orthoH, near: this.near, far: this.far, roll: this.roll, shift: [...this.shift], zoom: this.zoom, ...o });
  }
  /** Orbit the camera around its target without leaving the design grid. */
  orbit(az, el, r = vlen(vsub(this.eye, this.target))) {
    const t = this.target;
    return this.clone({ eye: [t[0] + r * Math.cos(el) * Math.sin(az), t[1] + r * Math.sin(el), t[2] + r * Math.cos(el) * Math.cos(az)] });
  }
  matrices(W, H) {
    const aspect = W / H;
    let up = this.up;
    if (this.roll) {
      const f = vnorm(vsub(this.target, this.eye));
      const r = vnorm(vcross(f, up)), l = vcross(r, f);
      const c = Math.cos(this.roll), s = Math.sin(this.roll);
      up = [l[0] * c + r[0] * s, l[1] * c + r[1] * s, l[2] * c + r[2] * s];
    }
    const view = m4lookAt(this.eye, this.target, up);
    const proj =
      this.mode === 'ortho'
        ? m4ortho(-((this.orthoH / 2) / this.zoom) * aspect, ((this.orthoH / 2) / this.zoom) * aspect, -(this.orthoH / 2) / this.zoom, (this.orthoH / 2) / this.zoom, -10000, 10000)
        : m4perspective(this.fov / this.zoom, aspect, this.near, this.far);
    if (this.shift[0] || this.shift[1]) {
      proj[8] += (this.shift[0] / 960) * proj[0];
      proj[9] += (this.shift[1] / 540) * proj[5];
    }
    return { view, proj, vp: m4mul(proj, view) };
  }
  focal() {
    return this.mode === 'ortho' ? 1e9 : vlen(vsub(this.eye, this.target));
  }
  /** World point -> design pixels (y down) + clip w, or null when behind the camera. */
  project(p, design) {
    const { vp } = this.matrices(design.w, design.h);
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (w <= 1e-6) return null;
    const cx = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w;
    const cy = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w;
    return { x: ((cx + 1) / 2) * design.w, y: ((1 - cy) / 2) * design.h, depth: w };
  }
}

const LINES_VS = `
in vec2 aCorner;
in vec3 aA, aB, aColor;
in vec2 aMeta;
uniform mat4 uVP;
uniform float uScale;
out vec2 vT;
out vec3 vColor;
out float vGlow;
void main(){
  vec4 ca=uVP*vec4(aA,1.0), cb=uVP*vec4(aB,1.0);
  if(ca.w<=1e-4&&cb.w<=1e-4){gl_Position=vec4(0.0,0.0,2.0,1.0);vT=vec2(0.0);vColor=vec3(0.0);vGlow=0.0;return;}
  float t=aCorner.x;
  vec4 clip=mix(ca,cb,t);
  vec2 dd=(cb.xy/cb.w)-(ca.xy/ca.w);
  vec2 n=normalize(vec2(-dd.y,dd.x)+vec2(1e-7));
  float wpx=max(aMeta.x*uScale,1.0);
  vec2 off=n*((aCorner.y*2.0-1.0)*0.5*wpx)*(2.0/uRes);
  gl_Position=vec4(clip.xy+off*clip.w,clip.z,clip.w);
  vT=vec2(t,aCorner.y*2.0-1.0);
  vColor=aColor;
  vGlow=aMeta.y;
}`;

const LINES_FS = `
in vec2 vT;
in vec3 vColor;
in float vGlow;
out vec4 o;
void main(){
  float d=abs(vT.y);
  float core=exp(-d*d*20.0);
  float halo=exp(-d*2.6)*0.4*vGlow;
  float ends=smoothstep(0.0,0.05,vT.x)*smoothstep(0.0,0.05,1.0-vT.x);
  o=vec4(vColor*(core+halo)*mix(0.4,1.0,ends),1.0);
}`;

const STRIDE = 11; // ax ay az bx by bz r g b widthPx glow

/** Additive instanced quads: wireframes, graphs, ticks, outlines, dimension lines. */
export class GlowLines {
  constructor(gl, maxSegments = 6000, name = 'lines') {
    this.gl = gl;
    this.max = maxSegments;
    this.prog = new Prog(gl, { vs: LINES_VS, fs: LINES_FS, name });
    this.data = new Float32Array(maxSegments * STRIDE);
    this.n = 0;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.buf = buf;
    const loc = (a) => gl.getAttribLocation(this.prog.prog, a);
    const attr = (a, size, offset, divisor) => {
      const l = loc(a);
      if (l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
      if (divisor) gl.vertexAttribDivisor(l, divisor);
    };
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const cl = loc('aCorner');
    gl.enableVertexAttribArray(cl);
    gl.vertexAttribPointer(cl, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    attr('aA', 3, 0, 1);
    attr('aB', 3, 3, 1);
    attr('aColor', 3, 6, 1);
    attr('aMeta', 2, 9, 1);
    gl.bindVertexArray(null);
  }
  begin() {
    this.n = 0;
    return this;
  }
  /** a,b are world [x,y,z]; color is linear HDR (values > 1 glow through bloom). */
  segment(a, b, { color = [1, 1, 1], width = 6, glow = 1 } = {}) {
    if (this.n >= this.max) return this;
    const o = this.n++ * STRIDE;
    const d = this.data;
    d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2] ?? 0;
    d[o + 3] = b[0]; d[o + 4] = b[1]; d[o + 5] = b[2] ?? 0;
    d[o + 6] = color[0]; d[o + 7] = color[1]; d[o + 8] = color[2];
    d[o + 9] = width; d[o + 10] = glow;
    return this;
  }
  point(p, { color, size = 8 } = {}) {
    return this.segment([p[0] - 0.01, p[1], p[2] ?? 0], [p[0] + 0.01, p[1], p[2] ?? 0], { color, width: size, glow: 0.2 });
  }
  /** Progressive reveal along arc length: draw-on is the default way to introduce a diagram. */
  polyline(pts, { color, width, glow, draw = 1, close = false } = {}) {
    if (pts.length < 2) return this;
    const seq = close ? [...pts, pts[0]] : pts;
    const cum = [];
    let total = 0;
    for (let i = 1; i < seq.length; i++) {
      total += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1], (seq[i][2] ?? 0) - (seq[i - 1][2] ?? 0));
      cum.push(total);
    }
    const upto = total * clamp(draw);
    let acc = 0;
    for (let i = 1; i < seq.length; i++) {
      if (upto <= acc) break;
      const L = cum[i - 1] - acc;
      const k = clamp((upto - acc) / (L || 1e-6));
      const p0 = seq[i - 1], p1 = seq[i];
      this.segment(p0, [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k, (p0[2] ?? 0) + ((p1[2] ?? 0) - (p0[2] ?? 0)) * k], { color, width, glow });
      acc += L;
    }
    return this;
  }
  render(ctx, opts = {}) {
    const gl = this.gl;
    if (!this.n) return this;
    const { vp } = (opts.cam ?? ctx.cam).matrices(ctx.W, ctx.H);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * STRIDE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    this.prog.use().set({ uVP: vp, uRes: [ctx.W, ctx.H], uScale: ctx.s });
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.bindVertexArray(null);
    return this;
  }
}

const SWARM_VS = `
in vec2 aUv;
uniform sampler2D uA, uB;
uniform mat4 uVP, uView;
uniform float uMorph, uSpread, uArc, uNoise, uNoiseFreq, uNoiseSpeed;
uniform float uReveal, uRevealByW, uWave, uSize, uMinPx, uFocal, uAperture, uMaxBlur, uSparkle, uScale;
uniform vec3 uWaveOrigin, uColA, uColB;
out vec3 vColor;
out float vAlpha;
out float vSpark;
void main(){
  vec4 A=texture(uA,aUv), B=texture(uB,aUv);
  vec3 a=A.xyz, b=B.xyz;
  float r=hash12(aUv*97.31+7.7);
  float k=clamp(uMorph*(1.0+uSpread)-uSpread*r,0.0,1.0);
  k=k*k*(3.0-2.0*k);
  vec3 d=b-a, p=mix(a,b,k);
  float dl=length(d);
  vec3 perp=normalize(cross(d,vec3(0.0,1.0,0.0))+vec3(0.0,0.001,0.0));
  p+=perp*sin(k*PI)*min(dl*0.3,uArc);
  vec3 nz=sin(vec3(aUv.x*7.0+uT*uNoiseSpeed,aUv.y*11.0-uT*uNoiseSpeed*0.7,(aUv.x+aUv.y)*5.0+uT*0.3));
  p+=nz*uNoise*k*(1.0-k)*uNoiseFreq;
  float order=mix(hash12(aUv.yx*13.7+1.1),B.w,uRevealByW);
  if(uReveal<1.0&&order>uReveal+1e-4){gl_Position=vec4(0.0,0.0,2.0,1.0);vColor=vec3(0.0);vAlpha=0.0;vSpark=0.0;return;}
  if(uWave>0.0&&uWave<1.0){
    float span=dl+length(p)+1200.0;
    if(length(p-uWaveOrigin)>uWave*span){gl_Position=vec4(0.0,0.0,2.0,1.0);vColor=vec3(0.0);vAlpha=0.0;vSpark=0.0;return;}
  }
  vec4 clip=uVP*vec4(p,1.0);
  float z=max(-(uView*vec4(p,1.0)).z,1.0);
  float coc=clamp(abs(z-uFocal)*uAperture,0.0,uMaxBlur);
  gl_PointSize=max(uSize*(uFocal/z)*uScale+coc*uScale,uMinPx);
  gl_Position=clip;
  float soften=1.0/(1.0+coc*coc*0.012);
  vColor=mix(uColA,uColB,clamp(order,0.0,1.0))*soften;
  vAlpha=mix(1.0,0.6,clamp(coc/max(uMaxBlur,1e-3),0.0,1.0));
  vSpark=uSparkle*step(0.986,hash11(aUv.x*311.0+aUv.y*117.0+floor(uT*12.0)));
}`;

const SWARM_FS = `
in vec3 vColor;
in float vAlpha;
in float vSpark;
out vec4 o;
void main(){
  vec2 q=gl_PointCoord*2.0-1.0;
  float d=dot(q,q);
  if(d>1.0) discard;
  float a=exp(-d*3.2)+vSpark*exp(-d*20.0)*3.0;
  o=vec4(vColor*a*vAlpha,1.0);
}`;

/** GPU particle morph engine: count = k*k points sampled from float data textures. */
export class Swarm {
  constructor(gl, { count = 1 << 18, name = 'swarm' } = {}) {
    const k = Math.round(Math.sqrt(count));
    if (k * k !== count) throw new Error(`Swarm count must be a perfect square: use ${k * k}`);
    this.gl = gl;
    this.k = k;
    this.count = count;
    this.prog = new Prog(gl, { vs: SWARM_VS, fs: SWARM_FS, name });
    const uv = new Float32Array(count * 2);
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { uv[(y * k + x) * 2] = (x + 0.5) / k; uv[(y * k + x) * 2 + 1] = (y + 0.5) / k; }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const l = gl.getAttribLocation(this.prog.prog, 'aUv');
    gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.shapes = new Map();
    this.blank = dataTexture(gl, new Float32Array(count * 4), k, k, 4);
  }
  /** Cache point tables by a film-wide unique key. */
  shape(key, gen) {
    let s = this.shapes.get(key);
    if (!s) {
      const data = typeof gen === 'function' ? gen() : gen;
      if (data.length !== this.count * 4) throw new Error(`shape "${key}": expected ${this.count * 4} floats, got ${data.length}`);
      s = dataTexture(this.gl, data, this.k, this.k, 4);
      this.shapes.set(key, s);
    }
    return s;
  }
  render(ctx, p = {}) {
    const gl = this.gl;
    const cam = p.cam ?? ctx.cam;
    const a = p.a ? this.shape(p.a, p.genA ?? (() => new Float32Array(this.count * 4))) : this.blank;
    const b = p.b ? this.shape(p.b, p.genB ?? (() => new Float32Array(this.count * 4))) : a;
    const { vp, view } = cam.matrices(ctx.W, ctx.H);
    const focal = p.focal ?? cam.focal();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    this.prog
      .use()
      .set({
        uA: a,
        uB: b,
        uVP: vp,
        uView: view,
        uRes: [ctx.W, ctx.H],
        uScale: ctx.s,
        uMorph: p.morph ?? 0,
        uSpread: p.spread ?? 0.35,
        uArc: p.arc ?? 0,
        uNoise: p.noise ?? 0,
        uNoiseFreq: p.noiseFreq ?? 30,
        uNoiseSpeed: p.noiseSpeed ?? 1,
        uT: p.t ?? ctx.t,
        uReveal: p.reveal ?? 1,
        uRevealByW: p.revealByW ?? 0,
        uWave: p.wave ?? 0,
        uWaveOrigin: p.waveOrigin ?? [0, 0, 0],
        uSize: p.size ?? 3,
        uMinPx: p.minPx ?? 1.5,
        uFocal: focal,
        uAperture: p.aperture ?? 0,
        uMaxBlur: p.maxBlur ?? 14,
        uColA: p.colA ?? [1, 1, 1],
        uColB: p.colB ?? p.colA ?? [1, 1, 1],
        uSparkle: p.sparkle ?? 0,
      });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
    return this;
  }
}

/** Point-table generators, each returning Float32Array(count*4) = [x,y,z,w]. */
export const shapes = {
  point(p, count, w = 0) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) o.set([p[0], p[1], p[2] ?? 0, w], i * 4);
    return o;
  },
  /** One point per cell: cols/rows default to a density that matches `count`, so nothing clumps. */
  grid(count, { w = 1400, h = 800, cols = 0, rows = 0, jitter = 0.5, seed = 1 } = {}) {
    const o = new Float32Array(count * 4);
    if (!cols || !rows) {
      cols = Math.max(1, Math.round(Math.sqrt(count * (w / h))));
      rows = Math.max(1, Math.round(count / cols));
    }
    for (let i = 0; i < count; i++) {
      const c = i % cols, r = (i / cols) | 0;
      const fx = (c + hash11(i * 3.1 + seed)) / cols;
      const fy = (r + hash11(i * 7.7 + seed)) / rows;
      o[i * 4] = (fx - 0.5) * w + (hash11(i * 1.3 + seed) - 0.5) * jitter;
      o[i * 4 + 1] = (0.5 - fy) * h + (hash11(i * 9.1 + seed) - 0.5) * jitter;
      o[i * 4 + 3] = fy;
    }
    return o;
  },
  circle(count, { r = 300, cx = 0, cy = 0, cz = 0, ring = 0, seed = 2 } = {}) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const rr = r + (hash11(i * 1.7 + seed) - 0.5) * ring;
      o[i * 4] = cx + Math.cos(a) * rr;
      o[i * 4 + 1] = cy + Math.sin(a) * rr;
      o[i * 4 + 2] = cz;
      o[i * 4 + 3] = i / count;
    }
    return o;
  },
  /** Fibonacci sphere — even coverage, no clustering at the poles. */
  sphere(count, { r = 300, jitter = 0, seed = 3 } = {}) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count, ph = Math.acos(1 - 2 * t), th = TAU * i * 0.6180339887498949;
      const rr = r * (1 + (hash11(i + seed) - 0.5) * jitter);
      o[i * 4] = rr * Math.sin(ph) * Math.cos(th);
      o[i * 4 + 1] = rr * Math.cos(ph);
      o[i * 4 + 2] = rr * Math.sin(ph) * Math.sin(th);
      o[i * 4 + 3] = t;
    }
    return o;
  },
  ball(count, { r = 300, seed = 4 } = {}) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, z = 0;
      for (let t = 0; t < 8 && Math.hypot(x, y, z) >= 1; t++) {
        x = hash11(i * 12.9 + t * 3.1 + seed) * 2 - 1;
        y = hash11(i * 71.3 + t * 9.7 + seed) * 2 - 1;
        z = hash11(i * 17.1 + t * 5.3 + seed) * 2 - 1;
      }
      o[i * 4] = x * r; o[i * 4 + 1] = y * r; o[i * 4 + 2] = z * r;
      o[i * 4 + 3] = Math.min(1, Math.hypot(x, y, z));
    }
    return o;
  },
  box(count, { w = 600, h = 400, d = 300, seed = 5 } = {}) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const face = (hash11(i * 3.7 + seed) * 6) | 0;
      let x = hash11(i * 11.1 + seed) * 2 - 1, y = hash11(i * 23.3 + seed) * 2 - 1, z = hash11(i * 41.7 + seed) * 2 - 1;
      if (face < 2) x = face ? 1 : -1;
      else if (face < 4) y = face === 2 ? -1 : 1;
      else z = face === 4 ? -1 : 1;
      o[i * 4] = (x * w) / 2; o[i * 4 + 1] = (y * h) / 2; o[i * 4 + 2] = (z * d) / 2;
      o[i * 4 + 3] = (x + 1) / 2;
    }
    return o;
  },
  curve(count, fn, { domain = [0, 1] } = {}) {
    const o = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const k = i / (count - 1 || 1), x = domain[0] + (domain[1] - domain[0]) * k;
      const p = fn(x, k) ?? [0, 0, 0];
      o[i * 4] = p[0]; o[i * 4 + 1] = p[1]; o[i * 4 + 2] = p[2] ?? 0; o[i * 4 + 3] = k;
    }
    return o;
  },
  along(count, pts, { seed = 7 } = {}) {
    const o = new Float32Array(count * 4);
    const cum = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(total);
    }
    for (let i = 0; i < count; i++) {
      const target = (i / count) * total;
      let s = 0;
      while (s < cum.length - 1 && cum[s] < target) s++;
      const a = pts[s], b = pts[s + 1] ?? a;
      const prev = s ? cum[s - 1] : 0;
      const k = clamp((target - prev) / ((cum[s] ?? 1) - prev || 1e-6));
      const j = (hash11(i * 5.3 + seed) - 0.5) * 4;
      o[i * 4] = a[0] + (b[0] - a[0]) * k + j;
      o[i * 4 + 1] = a[1] + (b[1] - a[1]) * k + j;
      o[i * 4 + 3] = i / count;
    }
    return o;
  },
  /** Rasterise a string, then sample its lit pixels: the standard "type made of matter" shot. */
  text(count, str, { size = 220, weight = 800, family = 'sans-serif', cx = 0, cy = 0, threshold = 0.4, seed = 8 } = {}) {
    const m = textMask(str, { size, weight, family });
    const o = new Float32Array(count * 4);
    const lit = [];
    for (let py = 0; py < m.h; py += 1) for (let px = 0; px < m.w; px += 1) if (m.data[(py * m.w + px) * 4 + 3] / 255 > threshold) lit.push([px, py]);
    if (!lit.length) return { table: o, w: m.w, h: m.h };
    for (let i = 0; i < count; i++) {
      const c = lit[(hash11(i * 13.3 + seed) * lit.length) | 0] ?? lit[0];
      o[i * 4] = cx + c[0] - m.w / 2;
      o[i * 4 + 1] = cy - c[1] + m.h / 2;
      o[i * 4 + 3] = i / count;
    }
    return { table: o, w: m.w, h: m.h };
  },
};

const maskCanvas = () => (textMask.canvas ?? (textMask.canvas = document.createElement('canvas')));

/** Canvas2D raster of a string, used for point sampling and for any silhouette a shot needs. */
export function textMask(str, { size = 220, weight = 800, family = 'sans-serif', pad = 0.18 } = {}) {
  const c = maskCanvas();
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = `${weight} ${size}px ${family}`;
  const w = Math.max(8, Math.ceil(g.measureText(str || ' ').width + size * pad * 2));
  const h = Math.max(8, Math.ceil(size * 1.42));
  c.width = w;
  c.height = h;
  g.font = `${weight} ${size}px ${family}`;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(str, size * pad, h / 2);
  return { data: g.getImageData(0, 0, w, h).data, w, h };
}

/** Raw triangle soup with an author-supplied program (attributes aPos, aNrm). */
export class Geom {
  constructor(gl, { positions, normals, indices }, prog) {
    this.gl = gl;
    this.prog = prog;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attr = (data, size, name) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog.prog, name);
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
    };
    attr(positions, 3, 'aPos');
    attr(normals ?? new Array(positions.length).fill(0), 3, 'aNrm');
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    this.count = indices.length;
    gl.bindVertexArray(null);
  }
  render(ctx, uniforms = {}) {
    const gl = this.gl;
    const cam = uniforms.cam ?? ctx.cam;
    const { view, proj, vp } = cam.matrices(ctx.W, ctx.H);
    const model = uniforms.uModel ?? null;
    if (model) uniforms = { ...uniforms, uVP: m4mul(vp, model), uModel: model };
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.prog.use().set({ uView: view, uProj: proj, uVP: vp, uEye: cam.eye, uRes: [ctx.W, ctx.H], uScale: ctx.s, ...uniforms });
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}

/** Axis-aligned box, six separately-normalled faces. */
export function boxMesh(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z], [1, 0, 0]],
    [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z], [-1, 0, 0]],
    [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z], [0, 1, 0]],
    [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z], [0, -1, 0]],
    [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]],
    [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]],
  ];
  const positions = [], normals = [], indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(f[i][0], f[i][1], f[i][2]);
      normals.push(f[4][0], f[4][1], f[4][2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}
