// Example film: five shots, one per MG family. Times are plain seconds because the demo has no audio;
// with analysis data, replace `at: 4.2` with `at: (T, {B}) => B('sec2', 4)`.
import { Prog } from '../kit/gl.js';
import { Cam, shapes, boxMesh, Geom } from '../kit/prims.js';
import { rgb, seg, clamp, lerp, ease, hash11, m4rotX, m4rotY, m4mul } from '../kit/math.js';
import * as C from '../kit/craft.js';

const N = 1 << 18;
const INK = rgb(C.THEME.ink);
const CY = rgb(C.THEME.primary, 0.17);
const OR = rgb(C.THEME.accent, 0.15);
const CY_HOT = rgb(C.THEME.primary, 0.95);
const HOT = rgb(C.THEME.hot);

export const config = {
  duration: 14.2,
  renderFps: 30,
  supersample: 1.5,
};

const BG_FS = `
uniform float uP;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=(uv-0.5)*vec2(uRes.x/uRes.y,1.0);
  float n=fbm(p*2.6+vec2(0.0,uT*0.06));
  float rings=0.5+0.5*sin((length(p)*7.0-uT*0.9)+n*3.0);
  vec3 col=mix(vec3(0.004,0.007,0.011),vec3(0.014,0.038,0.052),n*n);
  col+=vec3(0.10,0.30,0.34)*pow(rings,7.0)*smoothstep(0.0,0.4,uP);
  col*=1.0-0.55*dot(p*0.55,p*0.55);
  o=vec4(col,1.0);
}`;

const SOLID_FS = `
uniform vec3 uColA, uColB, uEye;
uniform float uP;
in vec3 vPos;
in vec3 vNrm;
out vec4 o;
void main(){
  vec3 n=normalize(vNrm);
  float d=max(dot(n,normalize(vec3(0.4,0.9,0.6))),0.0);
  float rim=pow(1.0-max(dot(n,normalize(uEye-vPos)),0.0),3.0);
  vec3 c=mix(uColA,uColB,0.5+0.5*n.y)*(0.25+0.85*d)+uColB*rim*0.9;
  o=vec4(c*smoothstep(0.0,0.25,uP),1.0);
}`;

const SOLID_VS = `
in vec3 aPos, aNrm;
uniform mat4 uVP, uModel;
out vec3 vPos;
out vec3 vNrm;
void main(){
  vec4 w=uModel*vec4(aPos,1.0);
  vPos=w.xyz;
  vNrm=mat3(uModel)*aNrm;
  gl_Position=uVP*vec4(aPos,1.0);
}`;

let bgProg = null, solidProg = null, boxGeom = null;

export default {
  id: 'demo',
  duration: 14.2,
  shots: [
    {
      // 1. Title card: shader backdrop + particles that settle into a ring + decode-reveal type.
      id: 'open',
      at: 0,
      draw(ctx) {
        bgProg ??= new Prog(ctx.gl, { fs: BG_FS, name: 'bg' });
        ctx.post.bloom = 0.35;
        ctx.post.vignette = 0.5;
        ctx.pass(bgProg, { uT: ctx.t, uP: ctx.p });

        const k = seg(ctx.lt, 0.35, 2.1);
        const cam = new Cam({ mode: 'persp', eye: [0, 0, 1300], target: [0, 0, 0] });
        ctx.cam = cam;
        ctx.swarm.render(ctx, {
          a: 'demo:grid',
          genA: () => shapes.grid(N, { w: 2100, h: 1150, seed: ctx.seed }),
          b: 'demo:ring',
          genB: () => shapes.circle(N, { r: 430, ring: 12 }),
          morph: ease.inOutCubic(k),
          spread: 0.6,
          arc: 140,
          noise: 22 * (1 - k),
          reveal: 0.1,
          size: 1.7,
          colA: CY,
          colB: OR,
          sparkle: 0.12 * k,
        });

        ctx.lines.begin();
        const rot = ctx.lt * 0.22;
        for (let i = 0; i < 64; i++) {
          const a0 = (i / 64) * Math.PI * 2 + rot;
          const a1 = ((i + 0.62) / 64) * Math.PI * 2 + rot;
          const r = 430;
          ctx.lines.segment([Math.cos(a0) * r, Math.sin(a0) * r, 0], [Math.cos(a1) * r, Math.sin(a1) * r, 0], {
            color: CY_HOT,
            width: 2.0,
            glow: 0.5,
          });
        }
        ctx.lines.render(ctx);

        ctx.text.scene.draw(() => {});
        C.heroWord(ctx.text.scene, 'SIGNAL LAYER', 960, 300, { t: ctx.t, start: 0.2, decode: 0.55, size: 148, color: '#c3d2da', glow: 12, glowColor: '#7ef0ff' });
        ctx.text.scene.text('01 / TITLE', 136, 940, { size: 20, weight: 600, family: C.THEME.mono, color: C.THEME.dim, baseline: 'middle' });
        ctx.text.scene.text('particles · type · glow lines', 136, 972, { size: 17, weight: 500, family: C.THEME.mono, color: C.THEME.faint, baseline: 'middle' });
        C.hudFrame(ctx.text.scene, { alpha: 0.4, label: 'OPEN', time: fmt(ctx.lt), beatPulse: ctx.rng(3) > 9 ? 0 : 0 });
      },
    },
    {
      // 2. Data-viz: staggered bars, an animated meter, a callout tracking the tallest bar.
      id: 'chart',
      at: 3.4,
      transitionIn: { type: 'wipe', dur: 0.22 },
      draw(ctx) {
        ctx.post.bloom = 0.5;
        ctx.post.grain = 0.02;
        ctx.cam = new Cam({ mode: 'ortho' });
        const labels = ['INGEST', 'INDEX', 'RANK', 'CACHE', 'RENDER', 'SHIP'];
        const vals = labels.map((_, i) => 0.25 + 0.7 * hash11(i * 3.7 + ctx.seed));
        const peak = vals.indexOf(Math.max(...vals));
        const x0 = 300, x1 = 1620, base = 780, gap = (x1 - x0) / labels.length;
        const bw = gap * 0.42;

        const W = C.px2world;
        ctx.lines.begin();
        ctx.lines.segment(W(x0, base), W(x1, base), { color: rgb(C.THEME.grid, 1.6), width: 2, glow: 0.2 });
        for (let i = 1; i <= 4; i++) {
          const y = base - i * 105;
          ctx.lines.segment(W(x0, y), W(x1, y), { color: rgb(C.THEME.grid, 0.9), width: 1.2, glow: 0 });
        }
        labels.forEach((l, i) => {
          const k = ease.outCubic(seg(ctx.lt, 0.25 + i * 0.09, 0.25 + i * 0.09 + 0.55));
          const h = (vals[i] * 420 + 40) * k;
          const cx = x0 + gap * (i + 0.5);
          const hot = i === peak;
          const col = (hot ? OR : CY).map((c) => c * (hot ? 1.5 : 1));
          ctx.lines.segment(W(cx, base), W(cx, base - h), { color: col, width: bw, glow: 0.9 });
          ctx.lines.segment(W(cx - bw * 0.62, base - h), W(cx + bw * 0.62, base - h), { color: col.map((c) => c * 1.8), width: 4, glow: 1 });
        });
        ctx.lines.render(ctx);

        const layer = ctx.text.scene;
        layer.text('THROUGHPUT BY STAGE', 136, 136, { size: 26, weight: 700, family: C.THEME.display, color: C.THEME.ink, baseline: 'middle' });
        layer.text('relative, normalised', 136, 168, { size: 17, weight: 500, family: C.THEME.mono, color: C.THEME.dim, baseline: 'middle' });
        labels.forEach((l, i) => {
          const cx = x0 + gap * (i + 0.5);
          const k = ease.outCubic(seg(ctx.lt, 0.25 + i * 0.09, 0.25 + i * 0.09 + 0.55));
          const h = (vals[i] * 420 + 40) * k;
          layer.text(l, cx, base + 34, { size: 18, weight: 600, family: C.THEME.mono, color: C.THEME.dim, align: 'center', baseline: 'middle' });
          layer.text(String(Math.round(vals[i] * 100 * k)), cx, base - h - 26, { size: 22, weight: 700, family: C.THEME.mono, color: i === peak ? C.THEME.accent : C.THEME.ink, align: 'center', baseline: 'middle', alpha: k });
        });
        C.callout(layer, [x0 + gap * (peak + 0.5), base - (vals[peak] * 420 + 40) - 40], [peak < 3 ? 1500 : 1560, 240], 'peak stage', { draw: seg(ctx.lt, 1.1, 1.7) });
        C.meter(layer, 136, 880, 380, 10, seg(ctx.lt, 0.4, 2.4), { color: C.THEME.primary, label: 'pipeline ready' });
        C.readout(layer, 1440, 150, [['stages', String(labels.length)], ['window', '2 s'], ['mode', 'rolling']], { align: 'right', cols: [0, 120] });
        C.hudFrame(layer, { alpha: 0.32, label: 'CHART', time: fmt(ctx.lt) });
      },
    },
    {
      // 3. Spatial: perspective camera, floor grid, a solid prop and particles that morph on a beat-free ramp.
      id: 'world',
      at: 6.4,
      transitionIn: { type: 'dissolve', dur: 0.45 },
      draw(ctx) {
        ctx.post.bloom = 0.42;
        ctx.post.ca = 0.1;
        const az = -0.5 + ctx.lt * 0.16;
        const cam = new Cam({ mode: 'persp', eye: [Math.sin(az) * 1500, 320 - ctx.lt * 40, Math.cos(az) * 1500], target: [0, -80, 0], fov: (40 * Math.PI) / 180 });
        ctx.cam = cam;

        bgProg ??= new Prog(ctx.gl, { fs: BG_FS, name: 'bg' });
        ctx.pass(bgProg, { uT: ctx.t, uP: 1 });

        ctx.lines.begin();
        C.floorGrid(ctx.lines, { y: -320, color: rgb(C.THEME.grid, 1.3) });
        for (let i = 0; i < 26; i++) {
          const z = -1800 + i * 120 + ((ctx.lt * 260) % 120);
          ctx.lines.segment([-2000, -318, z], [2000, -318, z], { color: CY.map((c) => c * 0.12), width: 1.2, glow: 0 });
        }
        ctx.lines.render(ctx);

        solidProg ??= new Prog(ctx.gl, { vs: SOLID_VS, fs: SOLID_FS, name: 'solid', uniforms: {} });
        boxGeom ??= new Geom(ctx.gl, boxMesh(420, 420, 420), solidProg);
        const spin = ctx.lt * 0.5;
        boxGeom.render(ctx, {
          uColA: rgb('#123244'),
          uColB: CY,
          uT: ctx.t,
          uP: clamp(ctx.lt / 0.6),
          uModel: m4mul(m4rotY(spin), m4rotX(spin * 0.55)),
        });

        const k = ease.inOutCubic(seg(ctx.lt, 0.6, 3.4));
        ctx.swarm.render(ctx, {
          a: 'world:sphere',
          genA: () => shapes.sphere(N, { r: 520, jitter: 0.05 }),
          b: 'world:curve',
          genB: () => shapes.curve(N, (x) => [(x - 0.5) * 1500, Math.sin(x * Math.PI * 3) * 180 + 260, -600 + x * 900]),
          morph: k,
          spread: 0.45,
          reveal: 0.22,
          size: 2.4,
          colA: OR,
          colB: CY,
          aperture: 0.0009,
          maxBlur: 18,
          sparkle: 0.35,
        });

        const layer = ctx.text.scene;
        C.heroWord(layer, 'DEPTH', 960, 200, { t: ctx.t, start: ctx.lt + 0.35, decode: 0.5, size: 120, color: C.THEME.ink, glow: 24, align: 'center' });
        C.dimLine(layer, [420, 700], [760, 700], { text: '340 px', color: C.THEME.dim });
        C.readout(layer, 1440, 820, [['cam', 'persp 40°'], ['orbit', `${(az * 57.3).toFixed(1)}°`], ['dof', 'on']], { align: 'right', cols: [0, 110] });
        C.hudFrame(layer, { alpha: 0.3, label: 'WORLD', time: fmt(ctx.lt) });
      },
    },
    {
      // 4. Code / terminal: typed lines inside a panel, mild glitch grade.
      id: 'code',
      at: 9.4,
      transitionIn: { type: 'glitch', dur: 0.24 },
      draw(ctx) {
        ctx.post.glitch = 0.06 * clamp(1 - ctx.lt / 0.5);
        ctx.post.scan = 0.16;
        ctx.post.sat = 0.92;
        ctx.cam = new Cam({ mode: 'ortho' });
        const layer = ctx.text.scene;
        C.panel(layer, 136, 180, 880, 620, { title: 'render.log' });
        const lines = [
          ['> build film --shots 5 --fps 30', C.THEME.ink],
          ['  compiling 12 programs            ok', C.THEME.dim],
          ['  prewarm 5 shots x 3 frames       ok', C.THEME.dim],
          ['> timeline: 14.20s  joins: 4', C.THEME.ink],
          ['  WARN grain above 0.05 in "world"', C.THEME.accent],
          ['> export frames 0..426', C.THEME.good],
          ['  68 ms/frame  ->  eta 29 s', C.THEME.dim],
          ['> mux audio + encode crf 16', C.THEME.good],
        ];
        const cps = 52;
        let shown = 0;
        const budget = (ctx.lt - 0.15) * cps;
        lines.forEach(([txt, color], i) => {
          const take = clamp(budget - shown, 0, txt.length);
          shown += txt.length;
          if (take > 0) {
            C.typeLine(layer, txt, 172, 250 + i * 40, { t: ctx.lt + i * 0.02, start: 0, cps: 1e9, size: 21, weight: 500, family: C.THEME.mono, color, to: take, caret: i === lines.length - 1 });
          }
        });
        C.readout(layer, 1100, 170, [
          ['shots', '5'],
          ['frames', '426'],
          ['budget', '33 ms'],
          ['grade', 'aces'],
          ['bloom', '0.75'],
        ], { size: 20, gap: 30 });
        ctx.lines.begin();
        for (let i = 0; i < 12; i++) {
          const y = 400 + i * 40;
          const v = 0.15 + 0.85 * hash11(i * 7.1 + ctx.seed);
          const k = seg(ctx.lt, 0.6 + i * 0.05, 1.1 + i * 0.05);
          ctx.lines.segment(C.px2world(1100, y), C.px2world(1100 + 620 * v * k, y), { color: CY.map((c) => c * (0.5 + v)), width: 5, glow: 0.8 });
        }
        ctx.lines.render(ctx);
        layer.text('activity', 1100, 340, { size: 17, weight: 600, family: C.THEME.mono, color: C.THEME.dim, baseline: 'middle' });
        C.hudFrame(layer, { alpha: 0.3, label: 'CODE', time: fmt(ctx.lt) });
      },
    },
    {
      // 5. Outro: everything collapses into a point, wordmark locks, fade to black.
      id: 'end',
      at: 12.4,
      transitionIn: { type: 'zoom', dur: 0.3 },
      draw(ctx) {
        ctx.cam = new Cam({ mode: 'persp', eye: [0, 0, 1300 + ctx.lt * 700], target: [0, 0, 0] });
        const k = ease.inCubic(seg(ctx.lt, 0.1, 1.35));
        ctx.swarm.render(ctx, {
          a: 'end:word',
          genA: () => shapes.text(N, 'MG', { size: 420, weight: 800, family: 'sans-serif' }).table,
          b: 'end:dot',
          genB: () => shapes.point([0, 0, 0], N),
          morph: k,
          reveal: 0.3,
          spread: 0.25,
          size: lerp(3.2, 1.4, k),
          colA: INK,
          colB: CY,
          sparkle: 0.6 * (1 - k),
        });
        const layer = ctx.text.scene;
        const inK = ease.outCubic(seg(ctx.lt, 0.2, 0.9));
        layer.text('made with the mg-animation kit', 960, 700, { size: 30, weight: 500, family: C.THEME.display, color: C.THEME.dim, align: 'center', baseline: 'middle', alpha: inK });
        layer.text('kit · webgl2 · code-generated', 960, 744, { size: 19, weight: 500, family: C.THEME.mono, color: C.THEME.faint, align: 'center', baseline: 'middle', alpha: inK });
        ctx.post.fade = seg(ctx.lt, ctx.dur - 0.6, ctx.dur - 0.05);
        ctx.post.vignette = 0.55;
      },
    },
  ],
};

const fmt = (lt) => C.timecode(lt, 30);
