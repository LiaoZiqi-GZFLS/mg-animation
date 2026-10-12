// Engine: owns GL state, resolves the timeline into a per-frame shot context, renders joins and grades.
import { Prog, Target, FsQuad, makeContext, unbindTextures, SCREEN_VS } from './gl.js';
import { Timeline } from './timeline.js';
import { Cam, GlowLines, Swarm } from './prims.js';
import { TextCanvas } from './text.js';
import { PointCut } from './pointcut.js';
import { Bloom, Uber, POST_DEFAULTS, lerpPost, applyRamps, transitionProg } from './post.js';
import { resolveConfig, MARGIN } from './config.js';
import { makeRng, clamp, hashString } from './math.js';
import { drawLyrics } from './craft.js';

const TEXTCOMP_FS = `
uniform sampler2D uScene, uText;
uniform float uGain;
out vec4 o;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec4 t=texture(uText,uv);
  o=vec4(texture(uScene,uv).rgb+t.rgb*t.a*uGain,1.0);
}`;

export const FULLSCREEN = SCREEN_VS;

export class Engine {
  constructor({ canvas, def, timing: T, features: F = null, config = {}, timeline = null }) {
    if (!T) throw new Error('Engine needs a Timing instance (run scripts/analyze.mjs, or pass timing: new Timing({duration}) )');
    this.gl = makeContext(canvas);
    this.config = resolveConfig(config);
    this.design = this.config.design;
    this.T = T;
    this.F = F ?? { get: () => 0, env: () => 0, bands: () => [] };
    this.timeline = timeline ?? new Timeline(def, T);
    this.fsq = new FsQuad(this.gl);
    this.fsq.check = !!this.config.debugGl;
    this.uber = new Uber(this.gl);
    this.bloom = new Bloom(this.gl);
    this.textComp = new Prog(this.gl, { vs: FULLSCREEN, fs: TEXTCOMP_FS, name: 'textcomp' });
    this.transProgs = new Map();
    // scene[i] holds shot i's picture, comp[i] holds it after its text layer, join holds the mix.
    this.rt = { scene: [new Target(this.gl, 8, 8), new Target(this.gl, 8, 8)], comp: [new Target(this.gl, 8, 8), new Target(this.gl, 8, 8)], join: new Target(this.gl, 8, 8) };
    this.text = { scene: new TextCanvas(this.design), overlay: new TextCanvas(this.design) };
    this.lines = new GlowLines(this.gl, 9000);
    this.swarm = new Swarm(this.gl, { count: this.config.particleCount ?? 1 << 18 });
    this.W = 0;
    this.H = 0;
    this.s = 1;
    this.sizeVersion = 0;
    this.errors = [];
    this.lastDrawn = null;
    this._ovq = [];
    this.setSize(canvas.width || this.design.w, canvas.height || this.design.h);
  }

  get duration() {
    return this.timeline.duration;
  }

  setSize(W, H) {
    const gl = this.gl;
    W = Math.max(64, Math.round(W));
    H = Math.max(64, Math.round(H));
    if (W === this.W && H === this.H) return this;
    this.W = W;
    this.H = H;
    this.s = W / this.design.w;
    const c = gl.canvas;
    c.width = W;
    c.height = H;
    for (const t of [...this.rt.scene, ...this.rt.comp, this.rt.join]) t.resize(W, H);
    this.bloom.setSize(W, H);
    this.text.scene.setSize(W, H, gl);
    this.text.overlay.setSize(W, H, gl);
    this.sizeVersion++;
    return this;
  }

  /** The object a shot's draw() receives. Everything a shot may touch per frame. */
  makeCtx(shot, t, extra = {}) {
    const lt = t - shot.start;
    const dur = shot.end - shot.start;
    const post = { ...POST_DEFAULTS };
    const self = this;
    const ctx0 = {
      gl: this.gl,
      engine: self,
      T: this.T,
      F: this.F,
      design: this.design,
      margin: MARGIN,
      shot: shot.id,
      def: shot,
      t,
      lt,
      dur,
      p: clamp(lt / (dur || 1e-9)),
      frame: Math.round(t * (this.config.renderFps ?? 30)),
      W: this.W,
      H: this.H,
      s: this.s,
      sizeVersion: this.sizeVersion,
      seed: Math.round(hashString(shot.id) * 1e6),
      rng: makeRng(Math.round(hashString(shot.id) * 1e6)),
      post,
      text: this.text,
      lines: this.lines.begin(),
      swarm: this.swarm,
      cam: extra.cam ?? new Cam({ mode: 'ortho' }),
      entering: !!extra.entering,
      exiting: !!extra.exiting,
      joinP: extra.joinP ?? 0,
      /** Run a fullscreen shader into the current frame. */
      pass(prog, uniforms = {}) {
        self.fsq.draw(prog.use().set({ uRes: [self.W, self.H], uT: ctx0.t, uS: self.s, uP: ctx0.p, ...uniforms }), self._target, {});
      },
      clear(color = [0, 0, 0]) {
        const gl = self.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, self._target.fbo);
        gl.viewport(0, 0, self.W, self.H);
        gl.clearColor(color[0], color[1], color[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      /** Draw after the grade, at exact colour: engine-level captions, or type that must not bloom. */
      defer(fn) {
        self._ovq.push(fn);
      },
      /** Draw into the glowing text layer. */
      scene(fn) {
        self.text.scene.draw(fn);
      },
    };
    return ctx0;
  }

  /** Render one frame at song time t. */
  draw(t) {
    const at = this.timeline.at(t);
    if (!at) throw new Error(`no shot covers t=${t.toFixed(3)}s`);
    const gl = this.gl;
    const { a, b, p, join } = at;
    let frame;
    this._ovq = [];
    this.text.overlay.clear();
    if (b) {
      const ta = this._renderShot(a, t, 0, { exiting: true, joinP: p });
      const tb = this._renderShot(b, t, 1, { entering: true, joinP: p });
      frame = this.rt.join;
      const hA = { __tex: true, tex: ta.tex }, hB = { __tex: true, tex: tb.tex };
      if (join.type === 'points') {
        this.pointcut ??= new PointCut(gl);
        this.pointcut.render(this.fsq, hA, hB, p, frame, this.W, this.H, {
          radius: join.radius,
          gain: join.gain,
          seed: join.seed ?? Math.floor(clamp(hashString(a.id + b.id)) * 1e6),
          color: join.color,
        });
      } else {
        const key = join?.type ?? 'fade';
        if (!this.transProgs.has(key)) this.transProgs.set(key, transitionProg(gl, key));
        const mat = this.transProgs.get(key).use();
        mat.set({ uA: hA, uB: hB, uRes: [this.W, this.H], uP: p, uBias: join?.bias ?? 0, uSeed: clamp(hashString(a.id + b.id)), uAspect: this.W / this.H });
        this.fsq.draw(mat, frame, { clear: true });
      }
    } else {
      frame = this._renderShot(a, t, 0, {});
    }

    // Frame-level overlay pass: queued shot draws + default lyric line.
    const main = b ? a : a;
    if (this.T.lines?.length && !main.ownsLyrics && !this.config.lyricsOff) {
      this._ovq.push((layer) => drawLyrics(layer, this.T, t, this.config.lyrics ?? {}));
    }
    if (this._ovq.length) {
      this.text.overlay.draw(() => {});
      for (const fn of this._ovq) {
        try {
          fn(this.text.overlay);
        } catch (err) {
          this._fail(main.id, err);
        }
      }
      this.text.overlay.upload(gl);
    }
    this._ovq = [];

    const post = b ? lerpPost(a.postGrade ?? {}, b.postGrade ?? {}, p) : { ...POST_DEFAULTS, ...(a.postGrade ?? {}) };
    // Preview-only: an author may switch a pass off to see the design underneath it. The exporter
    // never sets it, so a rendered frame always carries the film's own grade.
    if (this.postOverride) Object.assign(post, this.postOverride);
    const glow = post.bloom > 0.001 ? this.bloom.render(frame.tex, this.W, this.H, post) : (this._clearTarget(this.bloom.t[0]), this.bloom.t[0]);

    unbindTextures(gl);
    if (this.subs && this.subLang) this.subs.paint(this.text.overlay, this.subLang, t);
    const mat = this.uber.prog.use();
    mat.set({ uTex: { __tex: true, tex: frame.tex }, uBloom: glow.handle ?? { __tex: true, tex: glow.tex }, uText: this.text.overlay.upload(gl), uRes: [this.W, this.H], uT: t });
    this.uber.apply(mat, post, {});
    this.fsq.draw(mat, null, { clear: true });
    this.lastDrawn = b ? `${a.id} -> ${b.id}` : a.id;
    return { a: a.id, b: b?.id ?? null, p: b ? p : 0, join: b ? join?.type ?? 'fade' : null, drawn: this.lastDrawn };
  }

  _clearTarget(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** @param slot 0 or 1 — a join renders two shots at once, each into its own pair of targets. */
  _renderShot(shot, t, slot = 0, extra = {}) {
    const gl = this.gl;
    const ctx = this.makeCtx(shot, t, extra);
    const lt = t - shot.start;
    const target = this.rt.scene[slot];
    const comp = this.rt.comp[slot];
    this._target = target;
    this.text.scene.clear();
    if (shot.init && !shot.__inited) {
      shot.__inited = true;
      try {
        shot.init?.(ctx);
      } catch (err) {
        this._fail(shot.id, err);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | (target.hasDepth ? gl.DEPTH_BUFFER_BIT : 0));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    unbindTextures(gl);
    try {
      shot.draw(ctx);
      const r = shot.ramp ?? {};
      const first = this.timeline.shots[0] === shot;
      applyRamps(ctx.post, {
        lt,
        dur: shot.end - shot.start,
        frames: r.frames ?? 6,
        fps: this.config.renderFps ?? 30,
        rampIn: r.in ?? !first,
        rampOut: r.out ?? false,
        punch: r.punch ?? 0,
      });
    } catch (err) {
      this._fail(shot.id, err);
    }
    const tex = this.text.scene.upload(gl);
    unbindTextures(gl);
    const mat = this.textComp.use();
    mat.set({ uScene: { __tex: true, tex: target.tex }, uText: tex, uRes: [this.W, this.H] });
    mat.u('uGain', ctx.post.textGain ?? 1);
    this.fsq.draw(mat, comp, { clear: false });
    shot.postGrade = ctx.post;
    this._target = null;
    return comp;
  }

  _fail(id, err) {
    const msg = `${id}: ${err?.message ?? err}`;
    this.errors.push(msg);
    if (this.errors.length > 24) this.errors.shift();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.17, 0.0, 0.02, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.text.overlay.clear().draw((g) => {
      g.font = '600 30px monospace';
      g.fillStyle = '#ff6b6b';
      g.fillText(msg.slice(0, 120), 40, 80);
    });
    this.text.overlay.upload(gl);
  }

  /** Compile every shader before playback: 3 tiny frames per shot. Keeps first cuts from stalling. */
  prewarm(onProgress, { width = 256, height = 144 } = {}) {
    const keep = [this.W, this.H];
    this.setSize(width, height);
    const shots = this.timeline.shots;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      for (const f of [0.001, 0.5, 0.999]) this.draw(s.start + (s.end - s.start) * f);
      const j = this.timeline.shots[i + 1];
      if (j?.join) this.draw(j.start - (j.join.dur ?? 0.25) * 0.5);
      onProgress?.((i + 1) / shots.length, s.id);
    }
    this.setSize(keep[0], keep[1]);
    return this;
  }

  /** QC helper: one shot, one frame, into an offscreen target. */
  renderShot(id, t, slot = 0) {
    const shot = this.timeline.byId.get(id);
    if (!shot) throw new Error(`no shot "${id}"`);
    return this._renderShot(shot, t, slot);
  }

  /** Problems worth telling the author about before rendering 3000 frames. */
  validate() {
    const out = [...this.timeline.problems];
    if (this.timeline.duration > (this.T.duration ?? Infinity) + 0.5) out.push(`film runs past the audio (${this.T.duration?.toFixed(2)}s)`);
    if (Math.abs(this.timeline.duration - (this.config.duration ?? this.timeline.duration)) > 0.5) {
      out.push(`config.duration ${this.config.duration} != timeline ${this.timeline.duration.toFixed(2)}`);
    }
    for (const s of this.timeline.shots) {
      if (s.end - s.start < 0.5) out.push(`${s.id}: under half a second`);
      if (s.join && s.join.dur > 0.34 * (s.end - s.start)) out.push(`${s.id}: join ${(s.join.dur ?? 0).toFixed(2)}s is long for a ${(s.end - s.start).toFixed(2)}s shot`);
    }
    return out;
  }
}
