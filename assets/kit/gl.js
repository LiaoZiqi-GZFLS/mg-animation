// Thin WebGL2 layer: shader program wrapper with uniform cache, HDR render targets,
// fullscreen passes, and the GLSL prelude every shot shader is compiled against.

function withSourceLines(log, src) {
  const m = /ERROR:\s*\d+:(\d+):/.exec(log);
  if (!m) return log.slice(0, 400);
  const n = Number(m[1]);
  const lines = src.split('\n');
  const from = Math.max(0, n - 2);
  const body = lines.slice(from, n + 1).map((l, i) => `${from + i + 1}: ${l.trim().slice(0, 150)}`).join('\n');
  return `${log}\n${body}`;
}

export const COMMON = `precision highp float;
precision highp int;
#define PI 3.14159265359
#define TAU 6.28318530718
uint hash1u(uint x){x=((x>>uint(16))^x)*73244475u;x=((x>>uint(16))^x)*73244475u;return (x>>uint(16))^x;}
float hash1i(uint x){return float(hash1u(x))*(1.0/4294967296.0);}
float hash11(float p){return hash1i(floatBitsToUint(p*57.317+0.5));}
float hash12(vec2 p){ivec2 q=ivec2(floor(p));return hash1i(hash1u(uint(q.x))+31u*hash1u(uint(q.y)));}
float hash13(vec3 p){ivec3 q=ivec3(floor(p));return hash1i(hash1u(uint(q.x))+31u*(hash1u(uint(q.y))+31u*hash1u(uint(q.z))));}
vec2 hash22(vec2 p){ivec2 q=ivec2(floor(p));return vec2(hash1i(hash1u(uint(q.x))^0x9e3779b9u),hash1i(hash1u(uint(q.y))+7u*hash1u(uint(q.x))))*2.0-1.0;}
vec3 hash33(vec3 p){ivec3 q=ivec3(floor(p));uint h=hash1u(uint(q.x))+37u*hash1u(uint(q.y))+101u*hash1u(uint(q.z));return vec3(hash1i(h),hash1i(h+11u),hash1i(h+23u))*2.0-1.0;}
float noise2(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int k=0;k<5;k++){s+=a*noise2(p);p=mat2(1.6,1.2,-1.2,1.6)*p*1.01;a*=.5;}return s;}
vec2 curl2(vec2 p,float t){float e=.35;
  float n1=noise2(p+vec2(0.,t)),n2=noise2(p+vec2(0.,t)+vec2(0.,e));
  float n3=noise2(p+vec2(t,0.)),n4=noise2(p+vec2(t,0.)+vec2(e,0.));
  return vec2((n2-n1)/e,-(n4-n3)/e);}
mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
uniform vec2 uRes;
uniform float uT;
vec3 pal(float t,vec3 a,vec3 b,vec3 c,vec3 d){return a+b*cos(TAU*(c*t+d));}
float sdSphere(vec3 p,float r){return length(p)-r;}
float sdBox(vec3 p,vec3 b){vec3 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.);}
float sdTorus(vec3 p,vec2 r){vec2 q=vec2(length(p.xz)-r.x,p.y);return length(q)-r.y;}
float sdSeg(vec2 p,vec2 a,vec2 b,float r){vec2 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.))-r;}
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
vec3 agxEuc(vec3 x){x=max(x,0.);vec3 v=(x*(x+.037586)-.0038871)/(x*(.248242*x+.103053)+.0600462);return max(v,0.);}
vec3 toSRGB(vec3 c){return mix(c*12.92,1.055*pow(max(c,1e-6),vec3(1./2.4))-.055,step(0.0031308,c));}
vec3 fromSRGB(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(0.04045,c));}
`;

/** Compile a program; `fs` may omit the prelude (auto-prepended unless `raw`). */
/** Default vertex stage: the fullscreen triangle, no attributes. */
export const SCREEN_VS = `void main(){vec2 v=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(v*2.-1.,0.,1.);}`;

export class Prog {
  constructor(gl, { vs = SCREEN_VS, fs, uniforms = {}, raw = false, name = 'prog' }) {
    if (!fs) throw new Error(`${name}: no fragment source`);
    this.gl = gl;
    this.name = name;
    const pre = raw ? 'precision highp float;\nprecision highp int;\n' : COMMON;
    const shader = (type, src) => {
      const h = gl.createShader(type);
      gl.shaderSource(h, `#version 300 es\n${pre}${src}`);
      gl.compileShader(h);
      if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) {
        const log = String(gl.getShaderInfoLog(h) ?? '').trim();
        gl.deleteShader(h);
        throw new Error(`${name}: ${withSourceLines(log, `#version 300 es\n${pre}${src}`)}`);
      }
      return h;
    };
    const v = shader(gl.VERTEX_SHADER, vs);
    const f = shader(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: link ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    this.types = new Map();
    this.locs = new Map();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const u = gl.getActiveUniform(p, i);
      const base = u.name.replace(/\[0\]$/, '');
      this.types.set(base, u.type);
      this.locs.set(base, gl.getUniformLocation(p, u.name));
    }
    this.defaults = uniforms;
    this._unit = 0;
  }
  use() {
    this.gl.useProgram(this.prog);
    this._unit = 0;
    return this;
  }
  set(obj) {
    for (const k in obj) this.u(k, obj[k]);
    return this;
  }
  u(name, v) {
    const gl = this.gl;
    if (v === undefined || v === null) return this;
    const loc = this.locs.get(name);
    if (!loc) return this;
    const isTex = v && (v.__tex || (typeof WebGLTexture !== 'undefined' && v instanceof WebGLTexture));
    if (isTex) {
      gl.activeTexture(gl.TEXTURE0 + this._unit);
      gl.bindTexture(gl.TEXTURE_2D, v.tex);
      gl.uniform1i(loc, this._unit);
      this._unit++;
      return this;
    }
    const t = this.types.get(name);
    if (typeof v === 'number') {
      if (t === gl.INT || t === gl.BOOL) gl.uniform1i(loc, v);
      else gl.uniform1f(loc, v);
      return this;
    }
    if (v.length === undefined) return this;
    if (t === gl.FLOAT_VEC2) gl.uniform2fv(loc, v);
    else if (t === gl.FLOAT_VEC3) gl.uniform3fv(loc, v);
    else if (t === gl.FLOAT_VEC4) gl.uniform4fv(loc, v);
    else if (t === gl.FLOAT_MAT3) gl.uniformMatrix3fv(loc, false, v);
    else if (t === gl.FLOAT_MAT4) gl.uniformMatrix4fv(loc, false, v);
    else if (t === gl.FLOAT) gl.uniform1fv(loc, v);
    else if (t === gl.INT_VEC2) gl.uniform2iv(loc, v);
    else if (t === gl.INT_VEC3) gl.uniform3iv(loc, v);
    else if (t === gl.INT_VEC4) gl.uniform4iv(loc, v);
    else gl.uniform1fv(loc, v);
    return this;
  }
}


/** Fullscreen triangle drawn with no buffers; used by every screen-space pass. */
export class FsQuad {
  constructor(gl) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.check = false;
  }
  /** Fullscreen passes own their GL state: a shot may have left additive blending on,
   *  which would silently accumulate one frame into the next. */
  draw(prog, target = null, { clear = false, clearColor = [0, 0, 0, 1], blend = false } = {}) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    let w, h;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      w = target.w;
      h = target.h;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      w = gl.drawingBufferWidth;
      h = gl.drawingBufferHeight;
    }
    gl.viewport(0, 0, w, h);
    if (clear) {
      gl.clearColor(...clearColor);
      gl.clear(gl.COLOR_BUFFER_BIT | (target && target.depth ? gl.DEPTH_BUFFER_BIT : 0));
    }
    prog.use();
    prog.u('uRes', [w, h]);
    gl.disable(gl.DEPTH_TEST);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.check) {
      const err = gl.getError();
      if (err) console.warn(`[gl] pass "${prog.name}" -> ${target ? target.w + 'x' + target.h : 'canvas'} flagged 0x${err.toString(16)}`);
    }
    gl.bindVertexArray(null);
  }
}

/** HDR render target. Always pair with `setSize` on resize; dispose the old one. */
export class Target {
  constructor(gl, w, h, { hdr = true, depth = true, filter = gl.LINEAR } = {}) {
    this.gl = gl;
    this.resize(w, h, { hdr, depth, filter });
  }
  resize(w, h, { hdr = this.hdr, depth = this.hasDepth, filter = this.filter } = {}) {
    const gl = this.gl;
    this.dispose();
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.hdr = hdr;
    this.hasDepth = depth;
    this.filter = filter;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, this.w, this.h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (depth) {
      this.rbo = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbo);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.w, this.h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }
  get handle() {
    return { __tex: true, tex: this.tex };
  }
  dispose() {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.rbo) gl.deleteRenderbuffer(this.rbo);
    this.tex = this.fbo = this.rbo = null;
  }
}

/** Stale unit bindings make ANGLE report phantom framebuffer feedback loops. */
export function unbindTextures(gl, units = 4) {
  for (let u = 0; u < units; u++) {
    gl.activeTexture(gl.TEXTURE0 + u);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
}

export function makeContext(canvas, { antialias = false } = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias,
    depth: true,
    preserveDrawingBuffer: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 unavailable — check the browser/GPU flags');
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  gl.disable(gl.CULL_FACE);
  return gl;
}

/** Float data texture used for particle shape tables; data is padded to RGBA. */
export function dataTexture(gl, data, w, h, channels = 3) {
  const buf = channels === 4 ? data : new Float32Array(w * h * 4);
  if (channels !== 4) {
    for (let i = 0; i < w * h; i++) for (let c = 0; c < channels; c++) buf[i * 4 + c] = data[i * channels + c] || 0;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, buf);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, w, h, __tex: true };
}

/** Upload a Canvas2D layer; returns the raw WebGLTexture so it can be re-uploaded later. */
export function texFromCanvas(gl, canvas, tex = null) {
  const t = tex ?? canvas.__tex ?? gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  canvas.__tex = t;
  return t;
}

