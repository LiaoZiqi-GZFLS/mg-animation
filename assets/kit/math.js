// Math, easing and deterministic randomness. World units are design pixels (see config.design).

export const TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const sat = (x) => (x < 0 ? 0 : x);
export const lerp = (a, b, k) => a + (b - a) * k;
export const inv = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
/** Normalised progress inside a time window: `seg(t, start, start+dur)`. */
export const seg = (t, a, b) => clamp((t - a) / (b - a || 1e-9));
export const mixc = lerp;

export const ease = {
  linear: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - (1 - x) ** 3,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  outSine: (x) => Math.sin((x * Math.PI) / 2),
  inExpo: (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
  outExpo: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  outBack: (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
  outElastic: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 2 ** (-9 * x) * Math.sin((x * 10 - 0.75) * TAU / 3) + 1),
};

/** Exponential ramp used for flashes, dim-outs and pulses: decays from 1 with `rate` per second. */
export const flash = (age, rate = 18) => Math.exp(-age * rate);

// --- deterministic hashing for CPU-side layout (the GLSL prelude has its own integer hashes) ---
export function hash11(n) {
  const x = Math.sin(n * 127.1) * 43758.5453123;
  return x - Math.floor(x);
}
export function hash12(x, y) {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return v - Math.floor(v);
}
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
/** Seeded, stateless noise source: `rng(k)` for any index k. Never keep a mutable PRNG across frames. */
export function makeRng(seed) {
  return (k) => hash12(seed * 631.31 + 17.7, (k + 1) * 91.7);
}

// --- vectors ---
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// --- 4x4 matrices (column-major, as WebGL expects) ---
export function m4id(o = new Float32Array(16)) {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}
export function m4mul(a, b, o = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
export function m4perspective(fovY, aspect, near, far, o = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}
export function m4ortho(l, r, b, t, n, f, o = new Float32Array(16)) {
  o.fill(0);
  o[0] = 2 / (r - l);
  o[5] = 2 / (t - b);
  o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l);
  o[13] = -(t + b) / (t - b);
  o[14] = -(f + n) / (f - n);
  o[15] = 1;
  return o;
}
export function m4lookAt(eye, target, up = [0, 1, 0], o = new Float32Array(16)) {
  const z = vnorm(vsub(eye, target));
  const x = vnorm(vcross(up, z));
  const y = vcross(z, x);
  o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
  o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
  o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
  o[12] = -vdot(x, eye); o[13] = -vdot(y, eye); o[14] = -vdot(z, eye); o[15] = 1;
  return o;
}
export const m4pos = (m) => [m[12], m[13], m[14]];
export function m4rotY(a, o = new Float32Array(16)) {
  m4id(o);
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
  return o;
}
export function m4rotX(a, o = new Float32Array(16)) {
  m4id(o);
  const c = Math.cos(a), s = Math.sin(a);
  o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
  return o;
}
export function m4trans(x, y, z, o = new Float32Array(16)) {
  m4id(o);
  o[12] = x; o[13] = y; o[14] = z;
  return o;
}

/** Orbit helper: spherical placement around a target, in design-pixel units. */
export function around(target, r, az, el) {
  const c = Math.cos(el) * r;
  return [target[0] + c * Math.sin(az), target[1] + Math.sin(el) * r, target[2] + c * Math.cos(az)];
}

// --- colour ---
/** #rgb / #rrggbb -> linear [r,g,b]; `gain` multiplies in linear space (HDR values > 1 allowed). */
export function rgb(hex, gain = 1) {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s.slice(0, 6), 16);
  const f = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4) * gain;
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
export const colScale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const colAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const toHex = (c) => '#' + c.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
