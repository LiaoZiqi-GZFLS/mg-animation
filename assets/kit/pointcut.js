// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Derived from world-execute-web `src/engine/pointcut.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE for terms.
//
// The idea and the motion math are theirs: both pictures shatter into a grid of square tiles,
// the tiles fly into one rotating ball of points, and the ball unfolds into the incoming frame.
//
// Modifications for this kit:
//   - three.js removed: the Points object, BufferGeometry and OrthographicCamera are replaced by a
//     single drawArrays(GL_POINTS) that derives its grid cell from gl_VertexID, and by this kit's
//     Prog/FsQuad wrappers. No dependency, no build step.
//   - their COMMON prelude provided hash11/hash31/rot2/luma; this kit's prelude provides hash11/
//     rot2/luma, so hash31f() is defined locally here instead.
//   - the ball colour came from their THEME.pointcut.ball; it is now a per-call option so a join can
//     take the incoming shot's palette.
//   - the two passes are driven by this kit's render targets and GL state helpers.
import { Prog, SCREEN_VS } from './gl.js';

const MAX_COLS = 640;
const MAX_ROWS = 360;

const BG_FS = `
uniform sampler2D tA, tB;
uniform float uP;
out vec4 o;
void main(){
  // the outgoing picture hands over its points at the start, the incoming one takes over at the end
  o=vec4(texture(tA,gl_FragCoord.xy/uRes).rgb*(1.0-smoothstep(0.0,.14,uP))
        +texture(tB,gl_FragCoord.xy/uRes).rgb*smoothstep(.86,1.0,uP),1.0);
}`;

const PT_VS = `
uniform sampler2D tA, tB;
uniform vec2 uGrid;
uniform float uP, uAspect, uStep, uSeed, uRadius, uGain;
uniform vec3 uBall;
out vec3 vCol;
out float vRound;
vec3 hash31f(float x){ return vec3(hash11(x), hash11(x*1.7+13.1), hash11(x*2.3+41.7)); }
void main(){
  float i = float(gl_VertexID);
  vec2 g = vec2(mod(i, uGrid.x), floor(i / uGrid.x)), uv = (g + .5) / uGrid, home = uv * 2. - 1.;
  vec3 a = texture(tA, uv).rgb, b = texture(tB, uv).rgb;
  float h = hash11(i * .754877 + uSeed), h2 = hash11(i * 1.3247 + 7.1 + uSeed);
  float r0 = length(home * vec2(uAspect, 1.)) / length(vec2(uAspect, 1.));        // 0 centre, 1 corners
  // each point leaves its place (centre first), joins the ball, then leaves for its new place (centre last)
  float d1 = r0 * .14 + h * .10, d2 = (1. - r0) * .10 + h2 * .10;
  float k1 = smoothstep(d1, d1 + .36, uP), k2 = smoothstep(.42 + d2, .80 + d2, uP);
  float inBall = k1 * (1. - k2);
  // its slot in the ball: a point on a sphere, turning slowly
  vec3 s = normalize(hash31f(i * 1.618 + uSeed) - .5) * pow(hash11(i * 2.71 + uSeed), .4);
  s.xz = rot2(uP * 2.2) * s.xz;
  vec2 ball = vec2(s.x / uAspect, s.y) * uRadius;
  vec2 pos = mix(mix(home, ball, k1), home, k2);
  // on the way in and out the points spiral around the centre
  float sw = (k1 * (1. - k1) - k2 * (1. - k2)) * 2.6;
  pos = vec2(1. / uAspect, 1.) * (rot2(sw) * (pos * vec2(uAspect, 1.)));
  gl_Position = vec4(pos, 0., 1.);
  float swap = smoothstep(.44, .56, uP);
  float vis = mix(smoothstep(.015, .09, luma(a)), smoothstep(.015, .09, luma(b)), swap);
  // the ball keeps a fixed share of points whatever the pictures' brightness, so it never thins out
  vis = mix(vis, step(hash11(i * 3.17 + uSeed), .42), inBall);
  // in the ball every point carries the subject colour: the pictures' own levels would burn it out
  vec3 col = mix(mix(a, b, swap), uBall * (.35 + .9 * h), inBall);
  float on = smoothstep(0., .14, uP) * (1. - smoothstep(.86, 1., uP));
  vCol = col * vis * on * mix(1., uGain, inBall);
  vRound = smoothstep(0., .25, max(k1 * (1. - k1), k2 * (1. - k2)) * 4. + inBall);
  gl_PointSize = uStep * mix(1., 1.9, vRound);
}`;

const PT_FS = `
in vec3 vCol;
in float vRound;
out vec4 o;
void main(){
  // at rest a point is a square tile of the picture; in flight a soft round spark of the same energy
  float r = length(gl_PointCoord - .5) * 2.;
  float soft = exp(-r * r * 3.2) * (1. - smoothstep(.8, 1., r)) * .85;
  o = vec4(vCol * mix(1., soft, vRound), 1.);
}`;

/** The "both frames shatter into one ball of points" join. */
export class PointCut {
  constructor(gl) {
    this.gl = gl;
    this.bg = new Prog(gl, { vs: SCREEN_VS, fs: BG_FS, name: 'pointcut:bg' });
    this.pts = new Prog(gl, { vs: PT_VS, fs: PT_FS, name: 'pointcut:pts' });
    this.vao = gl.createVertexArray();
  }
  /**
   * @param p join progress 0..1
   * @param o {radius of the ball in frame heights, gain, seed, colour [r,g,b] linear}
   */
  render(fsq, texA, texB, p, target, W, H, o = {}) {
    const gl = this.gl;
    fsq.draw(this.bg.use().set({ tA: texA, tB: texB, uP: p }), target, {});
    const step = Math.max(2, Math.round(H / 360));
    const cols = Math.min(MAX_COLS, Math.ceil(W / step));
    const rows = Math.min(MAX_ROWS, Math.ceil(H / step));
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    this.pts.use().set({
      tA: texA,
      tB: texB,
      uGrid: [cols, rows],
      uP: p,
      uAspect: W / H,
      uStep: Math.max(W / cols, H / rows),
      uSeed: o.seed ?? 0,
      uRadius: (o.radius ?? 0.2) * 2,
      uGain: o.gain ?? 0.5,
      uBall: o.color ?? [0.5, 0.9, 1.0],
    });
    gl.drawArrays(gl.POINTS, 0, cols * rows);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
