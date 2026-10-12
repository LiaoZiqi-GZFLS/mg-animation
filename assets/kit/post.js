// Grading pipeline: conservative defaults, HDR bloom pyramid, the uber output pass, and joins.
import { Prog, Target, FsQuad, SCREEN_VS } from './gl.js';
import { clamp, lerp } from './math.js';

/** Editorial defaults. Deliberately mild: a shot should look finished because of layout and timing, not filters. */
export const POST_DEFAULTS = {
  exposure: 1,
  bloom: 0.5,
  threshold: 1.0,
  knee: 0.4,
  radius: 1.0,
  ca: 0.18,
  glitch: 0,
  scan: 0.06,
  vignette: 0.34,
  grain: 0.035,
  sat: 1.0,
  contrast: 1.0,
  lift: 0.0,
  gamma: 1.0,
  gain: 1.0,
  tint: [1, 1, 1],
  fade: 0,
  fadeCol: [0, 0, 0],
  tonemap: 1, // 0 none, 1 ACES, 2 AgX-ish
  zoom: 1,
  textGain: 1,
  dither: 1,
};

export const lerpPost = (a, b, k) => {
  const out = {};
  for (const key in POST_DEFAULTS) {
    const va = a?.[key] ?? POST_DEFAULTS[key];
    const vb = b?.[key] ?? POST_DEFAULTS[key];
    out[key] = Array.isArray(va) ? va.map((x, i) => lerp(x, vb[i], k)) : lerp(va, vb, k);
  }
  return out;
};

const BRIGHT_FS = `
uniform sampler2D uTex;
uniform float uThreshold, uKnee;
out vec4 o;
void main(){
  vec3 c=texture(uTex,gl_FragCoord.xy/uRes).rgb;
  float l=max(max(c.r,c.g),c.b);
  o=vec4(c*smoothstep(uThreshold-uKnee,uThreshold+uKnee,l),1.0);
}`;

const DOWN_FS = `
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy*uTexel;
  vec3 c=(texture(uTex,uv+uTexel*vec2(-0.5,-0.5)).rgb+texture(uTex,uv+uTexel*vec2(0.5,-0.5)).rgb
        + texture(uTex,uv+uTexel*vec2(-0.5,0.5)).rgb+texture(uTex,uv+uTexel*vec2(0.5,0.5)).rgb)*0.25;
  o=vec4(c,1.0);
}`;

const BLUR_FS = `
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uRadius;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 d=uDir*uRadius/uRes;
  vec3 c=texture(uTex,uv).rgb*0.2270270270;
  c+=(texture(uTex,uv+d*1.3846153846).rgb+texture(uTex,uv-d*1.3846153846).rgb)*0.3162162162;
  c+=(texture(uTex,uv+d*3.2307692308).rgb+texture(uTex,uv-d*3.2307692308).rgb)*0.0702702703;
  o=vec4(c,1.0);
}`;

const ADD_FS = `
uniform sampler2D uBase, uWide;
uniform float uGain;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  o=vec4(texture(uBase,uv).rgb+texture(uWide,uv).rgb*uGain,1.0);
}`;

/** Two-radius HDR bloom on double buffers: no pass ever reads the texture it writes. */
export class Bloom {
  constructor(gl) {
    this.gl = gl;
    this.brightP = new Prog(gl, { fs: BRIGHT_FS, name: 'bloom:bright' });
    this.downP = new Prog(gl, { fs: DOWN_FS, name: 'bloom:down' });
    this.blurP = new Prog(gl, { fs: BLUR_FS, name: 'bloom:blur' });
    this.addP = new Prog(gl, { fs: ADD_FS, name: 'bloom:add' });
    this.fsq = new FsQuad(gl);
    const half = () => new Target(gl, 8, 8, { hdr: true, depth: false });
    this.t = [half(), half(), half(), half()];
    this.final = this.t[1];
  }
  setSize(w, h) {
    const hw = Math.max(2, Math.round(w / 2)), hh = Math.max(2, Math.round(h / 2));
    const qw = Math.max(2, Math.round(w / 4)), qh = Math.max(2, Math.round(h / 4));
    this.t[0].resize(hw, hh); this.t[1].resize(hw, hh);
    this.t[2].resize(qw, qh); this.t[3].resize(qw, qh);
    return this;
  }
  /** Returns the half-resolution glow texture the uber pass adds. */
  render(src, w, h, p) {
    const gl = this.gl;
    const [A, B, C, D] = this.t;
    const [t0, t1] = [A, B];
    const H = (a, b, r) => this.fsq.draw(this.blurP.use().set({ uTex: h2(a), uDir: [1, 0], uRadius: r }), b);
    const V = (a, b, r) => this.fsq.draw(this.blurP.use().set({ uTex: h2(a), uDir: [0, 1], uRadius: r }), b);
    this.fsq.draw(this.brightP.use().set({ uTex: h2(src), uThreshold: p.threshold, uKnee: p.knee }), t0, { clear: true });
    H(t0, t1, 2.2); V(t1, t0, 2.2);
    H(t0, t1, 5.5); V(t1, t0, 5.5);
    this.fsq.draw(this.downP.use().set({ uTex: h2(t0), uTexel: [1 / C.w, 1 / C.h] }), C, { clear: true });
    H(C, D, 3.0); V(D, C, 3.0);
    H(C, D, 7.0); V(D, C, 7.0);
    this.fsq.draw(this.addP.use().set({ uBase: h2(t0), uWide: h2(C), uGain: 0.5 * (p.radius ?? 1) }), t1, { clear: true });
    return t1;
  }
}

const h2 = (t) => (t?.__tex ? t : t?.tex ? { __tex: true, tex: t.tex } : { __tex: true, tex: t });

const UBER_FS = `
uniform sampler2D uTex, uBloom, uText;
uniform float uExposure, uBloomGain, uCA, uGlitch, uScan, uVignette, uGrain, uSat, uContrast;
uniform float uLift, uGamma, uGain, uTonemap, uZoom, uFade, uTextGain, uDither;
uniform vec3 uTint, uFadeCol;
out vec4 o;
vec2 warp(vec2 uv){ return (uv-0.5)*(1.0/uZoom)+0.5; }
float rowNoise(float y){ return hash12(vec2(floor(y*220.0),floor(uT*24.0))); }
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=warp(uv);
  float g=uGlitch;
  if(g>0.0){
    float r=rowNoise(uv.y);
    p.x+= (r-0.5)*0.14*g*step(0.55,r);
    p=clamp(p,0.0,1.0);
  }
  vec3 c;
  if(uCA>0.001){
    vec2 d=(p-0.5)*uCA*0.006*(1.0+uGlitch*2.0);
    c=vec3(texture(uTex,p+d).r,texture(uTex,p).g,texture(uTex,p-d).b);
  } else c=texture(uTex,p).rgb;
  c+=texture(uBloom,warp(uv)).rgb*uBloomGain;
  c*=uExposure;
  if(uTonemap>0.5&&uTonemap<1.5) c=aces(c);
  else if(uTonemap>1.5) c=agxEuc(c*1.35);
  c=pow(max(c,0.0),vec3(1.0/uGamma));
  c=c*uGain+uLift;
  c*=uTint;
  float l=luma(c);
  c=mix(vec3(l),c,uSat);
  c=(c-0.5)*uContrast+0.5;
  vec2 q=(uv-0.5);
  c*=mix(1.0,clamp(1.0-dot(q,q)*1.6,0.0,1.0),uVignette);
  float sc=0.5+0.5*sin(uv.y*uRes.y*3.14159);
  c*=1.0-uScan*0.16*sc;
  c=mix(c,vec3(1.0),0.0);
  c=mix(c,uFadeCol,uFade);
  c=toSRGB(clamp(c,0.0,1.0));
  vec4 t=texture(uText,p);
  c=mix(c,t.rgb*vec3(uTextGain),t.a*step(0.001,uTextGain));
  if(uGrain>0.001){
    vec2 gp=floor(gl_FragCoord.xy/2.0);
    float n=hash12(gp+floor(uT*30.0));
    c+=(n-0.5)*uGrain*0.16;
  }
  if(uDither>0.5){
    float tp=(hash12(floor(gl_FragCoord.xy))+hash12(floor(gl_FragCoord.xy)+vec2(0.5,0.5)))-1.0;
    c+=tp/510.0;
  }
  o=vec4(c,1.0);
}`;

/** The single output pass: everything a frame needs to look like a finished picture. */
export class Uber {
  constructor(gl) {
    this.prog = new Prog(gl, { vs: SCREEN_VS, fs: UBER_FS, name: 'uber' });
  }
  apply(mat, p, extra) {
    mat.use().set({
      uExposure: p.exposure,
      uBloomGain: p.bloom,
      uCA: p.ca,
      uGlitch: p.glitch,
      uScan: p.scan,
      uVignette: p.vignette,
      uGrain: p.grain,
      uSat: p.sat,
      uContrast: p.contrast,
      uLift: p.lift,
      uGamma: p.gamma,
      uGain: p.gain,
      uTint: p.tint,
      uTonemap: p.tonemap,
      uZoom: p.zoom,
      uFade: p.fade,
      uFadeCol: p.fadeCol,
      uTextGain: p.textGain,
      uDither: p.dither,
      ...extra,
    });
    return this;
  }
}

/** Joins declared as data: {type, dur, bias}. Each body mixes two frame textures. */
export const TRANSITIONS = {
  fade: `o=vec4(mix(a,b,sm),1.0);`,
  mix: `o=vec4(mix(a,b,sm),1.0);`,
  dissolve: `float n=fbm(uv*7.0+uSeed*3.3);
    float m=smoothstep(n-0.18,n+0.18,sm);
    vec3 edge=a*(1.0-m)+b*m;
    // A rim on the advancing noise front, tinted by the picture: a wide flat white band would put
    // +0.3 linear over most of the frame at mid-progress, and a bright shot would read as a flash.
    float glow=smoothstep(0.09,0.0,abs(n-sm))*0.45;
    o=vec4(edge+glow*(edge+vec3(0.22)),1.0);`,
  wipe: `float x=sm*(1.0+2.0*uBias)-uBias;
    float e=smoothstep(x+0.02,x-0.02,uv.x);
    vec3 edge=mix(a,b,e);
    float seam=exp(-pow((uv.x-x)*40.0,2.0))*0.8;
    o=vec4(edge+seam*vec3(0.6,0.9,1.0),1.0);`,
  iris: `float r=mix(1.25,0.0,sm);
    float d=length((uv-0.5)*vec2(uAspect,1.0));
    float m=smoothstep(r+0.06,r-0.06,d);
    o=vec4(mix(a,b,m)+vec3(smoothstep(0.12,0.0,abs(d-r))*0.5)*(1.0-m*0.5),1.0);`,
  glitch: `float r=hash12(vec2(floor(uv.y*46.0),floor(sm*24.0)));
    float k=clamp(sm*1.6-0.3,0.0,1.0);
    float shift=(r-0.5)*0.09*k*(1.0-k)*4.0;
    vec2 ua=clamp(uv+vec2(shift,0.0),0.0,1.0), ub=clamp(uv-vec2(shift,0.0),0.0,1.0);
    vec3 ca=vec3(texture(uA,ua+vec2(shift*0.35,0.0)).r,texture(uA,ua).g,texture(uA,ua-vec2(shift*0.35,0.0)).b);
    o=vec4(mix(ca,b,k),1.0);`,
  zoom: `float k=sm*sm;
    vec2 ua=0.5+(uv-0.5)*mix(1.0,1.9,k);
    vec2 ub=0.5+(uv-0.5)*mix(2.2,1.0,k);
    vec3 A=ua.x>=0.0&&ua.x<=1.0&&ua.y>=0.0&&ua.y<=1.0?texture(uA,ua).rgb:b;
    vec3 B=ub.x>=0.0&&ub.x<=1.0&&ub.y>=0.0&&ub.y<=1.0?texture(uB,ub).rgb:a;
    o=vec4(mix(A,B,smoothstep(0.35,0.75,sm)),1.0);`,
  pixel: `float s=mix(1.0,64.0,1.0-sm);
    vec2 g=floor(uv*vec2(s,s))/max(vec2(s,s),vec2(1.0))+0.5/max(vec2(s,s),vec2(1.0));
    o=vec4(mix(texture(uA,g).rgb,texture(uB,g).rgb,step(0.5,sm)),1.0);`,
};

const TRANS_FS = `
uniform sampler2D uA, uB;
uniform float uP, uBias, uSeed, uAspect;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  float p=clamp(uP,0.0,1.0);
  float sm=p*p*(3.0-2.0*p);
  vec3 a=texture(uA,uv).rgb;
  vec3 b=texture(uB,uv).rgb;
  BODY
}`;

export function transitionProg(gl, type = 'fade') {
  const body = TRANSITIONS[type];
  if (!body) throw new Error(`unknown transition "${type}" — use one of ${Object.keys(TRANSITIONS).join(', ')}`);
  return new Prog(gl, { vs: SCREEN_VS, fs: TRANS_FS.replace('BODY', body), name: `transition:${type}` });
}

/** Entry/exit light ramps: a short exposure flash that hides the cut and lands the eye. */
export function applyRamps(post, { lt, dur, frames = 6, fps = 30, rampIn = true, rampOut = false, punch = 0 }) {
  const win = frames / fps;
  if (rampIn) {
    const k = clamp(1 - lt / win);
    post.exposure *= 1 + k * k * 1.6;
  }
  if (rampOut) {
    const k = clamp(1 - (dur - lt) / win);
    post.exposure *= 1 + k * k * 1.2;
  }
  if (punch) {
    const k = clamp(1 - lt / (8 / fps));
    post.zoom = 1 + punch * k * k;
  }
  return post;
}
