# Shot families and how to build each one

Seven families cover most MG films. Each entry: what it's for, the kit calls, and the failure mode
that makes it look amateur.

---

## 1. Kinetic typography / title

**For:** openings, chapter cards, the one sentence a shot must deliver.

```js
draw(ctx) {
  const { lt, t } = ctx;
  ctx.post.bloom = 0.35;                       // type + bloom = blobs; keep it low
  C.heroWord(ctx.text.scene, 'SIGNAL LAYER', 960, 300, {
    t, start: 0.2, decode: 0.55, size: 148, color: '#c3d2da', glow: 12, glowColor: '#7ef0ff',
  });
  ctx.text.scene.text('01 / TITLE', 136, 940, { size: 20, weight: 600, family: C.THEME.mono, color: C.THEME.dim });
  C.typeLine(ctx.text.scene, 'code-generated · frame by frame', 136, 972, { t: lt, start: 0.9, cps: 26, size: 17, family: C.THEME.mono, color: C.THEME.faint });
}
```

Variants: `shapes.text(N, 'MG', {size:420})` feeds a Swarm so the word is *made of* particles and
can collapse (`end` shot in the template). For text welded to a 3D surface, project with
`cam.project(worldPoint, design)` and draw at the returned design px with `rot`/`scale`.

**Failure mode:** white text at full gain over a bloom threshold of 1.0 — the word becomes a glowing
cloud. Keep title fill around 0.75 linear and let a small `glow` do the work.

---

## 2. Data-viz (bars, gauges, charts, meters)

**For:** any "here is the evidence" beat.

```js
const W = C.px2world;
ctx.lines.begin();
ctx.lines.segment(W(x0, base), W(x1, base), { color: rgb('#1b2530', 1.6), width: 2, glow: 0.2 });
labels.forEach((l, i) => {
  const k = ease.outCubic(seg(lt, 0.25 + i * 0.09, 0.8 + i * 0.09));   // stagger, then grow
  const h = vals[i] * 420 * k;
  ctx.lines.segment(W(cx, base), W(cx, base - h), { color: col, width: bw, glow: 0.9 });
  ctx.lines.segment(W(cx - bw * .62, base - h), W(cx + bw * .62, base - h), { color: col.map(c => c * 1.8), width: 4 });
});
ctx.lines.render(ctx);
C.meter(ctx.text.scene, 136, 880, 380, 10, seg(lt, 0.4, 2.4), { color: C.THEME.primary, label: 'pipeline ready' });
C.readout(ctx.text.scene, 1480, 150, [['stages', '6'], ['window', '2 s']], { align: 'right' });
```

A thick `GlowLines` segment *is* a bar: the core is `exp(-d²·20)` so the middle ~40 % reads as a
solid fill and the edges as glow. For a hard-edged bar, draw a `Geom` quad or lower `glow` to 0.
Animate numbers by interpolating **checkpoint snapshots** (precompute the series once in `init()`,
lerp between stored states) so bars can grow *and* shrink without re-deriving data per frame.

**Failure mode:** labels colliding with the chart, or values that change while the viewer is still
reading the previous one. Hold ≥0.3 s after the last bar lands.

---

## 3. Diagrams, graphs and networks

**For:** architecture, flow, causality.

```js
init(ctx) {
  O.nodes = layout(nodes);                    // compute once
  O.edges = connect(O.nodes, { fanout: 3 });
}
draw(ctx) {
  const reveal = ease.outCubic(seg(ctx.lt, 0.2, 1.4));
  ctx.lines.begin();
  for (const e of O.edges) {
    const k = clamp((reveal * O.edges.length - e.i) | 0 ? 1 : reveal * O.edges.length - e.i);
    ctx.lines.polyline([W(...e.a), W(...e.b)], { color: CY, width: 2.5, draw: k });
  }
  ctx.lines.render(ctx);
  for (const n of O.nodes) {
    const a = seg(ctx.lt, n.order * 0.06, n.order * 0.06 + 0.25);
    ctx.lines.point(W(n.x, n.y), { color: colScale(CY, a), size: 14 * a });
    if (a > 0.6) ctx.text.scene.text(n.label, n.x, n.y - 26, { size: 18, family: C.THEME.mono, color: C.THEME.dim, align: 'center', alpha: a });
  }
  C.callout(ctx.text.scene, W(target.x, target.y), [1560, 240], 'peak stage', { draw: seg(ctx.lt, 1.1, 1.7) });
}
```

Draw-on by arc length (`polyline({draw})`) is the single most useful trick: it makes a static
diagram assemble in front of the viewer. `callout` reveals its label only past `draw > 0.6` so the
leader line arrives before the text.

**Failure mode:** everything visible at once. Reveal in reading order (left→right, top→bottom), and
keep at most one callout per shot.

---

## 4. Particles and morphs

**For:** matter, transformation, "many things becoming one thing".

```js
const k = ease.inOutCubic(seg(lt, 0.35, 2.1));
ctx.swarm.render(ctx, {
  a: 'open:grid', genA: () => shapes.grid(N, { w: 2100, h: 1150, seed: ctx.seed }),
  b: 'open:ring', genB: () => shapes.circle(N, { r: 430, ring: 12 }),
  morph: k,
  reveal: 0.12,          // fraction of the buffer actually drawn — control density here
  spread: 0.6,           // per-particle stagger of the morph (0 = everything moves at once)
  arc: 140,              // bulge along the travel path
  noise: 22 * (1 - k), noiseFreq: 30, noiseSpeed: 1,
  size: 1.7, minPx: 1.2, sparkle: 0.12 * k,
  colA: CY, colB: OR,
  aperture: 0.0009, maxBlur: 16,     // >0 gives real depth of field
});
```

Density rule of thumb: a full-frame field at 1080p wants **≤ 1 point per 12 px²**, i.e.
`reveal ≈ 12·1080² / (4·N)` for the default 262144-point buffer. More than that and the field
aliases into moiré that bloom then turns into white noise.

Shape tables are cached by a film-wide unique key; `shapes.sphere/ball/box/circle/grid/curve/along/text`
cover most needs, and `shapes.curve(N, fn)` handles anything parametric.

**Failure mode:** `reveal: 1` with a 2^18 buffer. Also forgetting `spread`, which makes a morph look
like a cross-fade instead of a migration.

---

## 5. Fullscreen shader / abstract backdrop

**For:** atmosphere, scale, transitions between literal subjects.

```js
const prog = O.bg ??= new Prog(gl, {
  fs: `uniform float uP;
    out vec4 o;
    void main(){
      vec2 uv=gl_FragCoord.xy/uRes;
      vec2 p=(uv-0.5)*vec2(uRes.x/uRes.y,1.0);
      float n=fbm(p*2.6+vec2(0.0,uT*0.06));
      vec3 col=mix(vec3(0.004,0.007,0.011),vec3(0.014,0.038,0.052),n*n);
      o=vec4(col,1.0);
    }`, name: 'bg',
});
ctx.pass(prog, { uP: ctx.p });
```

`uRes` and `uT` are pre-declared by the shared prelude — declaring them again is a compile error.
The prelude also provides `hash11/12/13`, `hash22/33`, `noise2`, `fbm`, `curl2`, `rot2`, `luma`,
`pal`, `sdSphere/sdBox/sdTorus/sdSeg/smin`, `aces`, `agxEuc`, `toSRGB`. Use those instead of
re-inventing them per shot.

**Failure mode:** backdrops brighter than 0.08 linear, which flatten everything in front of them.
Second: `sin`-based hashes on pixel coordinates — the kit's hashes are integer-based precisely
because `sin(fract(...))` degenerates into a visible lattice at large coordinates.

---

## 6. Code, terminal and glitch

**For:** process, evidence, "the machine is working".

```js
ctx.post.scan = 0.15;
ctx.post.sat = 0.92;
ctx.post.glitch = 0.06 * clamp(1 - lt / 0.5);
C.panel(ctx.text.scene, 136, 180, 880, 620, { title: 'render.log' });
let budget = (lt - 0.15) * 52;                       // characters available so far
lines.forEach(([txt, color], i) => {
  const take = clamp(budget, 0, txt.length); budget -= txt.length;
  if (take > 0) C.typeLine(ctx.text.scene, txt, 172, 250 + i * 40, { t: lt, cps: 1e9, to: take, size: 21, family: C.THEME.mono, color, caret: i === lines.length - 1 });
});
```

Real content sells it: run the actual command, paste its real output, wrap with `word-wrap` at
~62 columns. For a corrupted look, quantise positions in the Swarm vertex shader or reuse
`post.glitch` — both read as data damage without a second render pipeline.

**Failure mode:** monospace at 17 px or smaller (it dies in H.264), and typing that finishes long
before the shot ends, leaving a dead frame.

---

## 7. Spatial / camera moves

**For:** depth, scale, "zoom out to see the system".

```js
const az = -0.5 + lt * 0.16;
ctx.cam = new Cam({ mode: 'persp', eye: [Math.sin(az) * 1500, 320, Math.cos(az) * 1500], target: [0, -80, 0], fov: (40 * Math.PI) / 180 });
ctx.lines.begin();
C.floorGrid(ctx.lines, { y: -320, color: rgb('#1b2530', 1.3) });
ctx.lines.render(ctx);
box.render(ctx, { uModel: m4mul(m4rotY(spin), m4rotX(spin * 0.55)), uColA: rgb('#123244'), uColB: CY });
```

The default perspective camera sits at `z = 1300` (`FIT_DIST`) so the z=0 plane exactly fills the
frame — meaning world units still equal design px at that depth. Camera drift should be **linear**
in `lt`; eased camera moves look like a slideshow.

Label tracking: `cam.project(worldPt, design)` → draw at the returned px, and skip the label when
it returns `null` (behind the camera).

**Failure mode:** orbiting a bare cube. Depth reads from *relative* motion — grid, particles and
foreground furniture must move at different rates.

---

## Joins

Declared as data on the incoming shot: `transitionIn: { type, dur, bias }`.

| type | use |
|---|---|
| `fade` / `mix` | neutral, quiet continuation |
| `wipe` | next item in a list; `bias` shifts the seam |
| `dissolve` | scene change with noise + edge glow; one beat long |
| `iris` | closing a chapter, or "focus moves" |
| `glitch` | data/process films; keep displacement under ~10 % of width |
| `zoom` | punching into the next idea |
| `pixel` | resolution metaphor; block size collapses as the join completes |

A join must finish before the incoming shot's own entrance begins, otherwise the viewer sees two
animations competing. During a join the outgoing shot receives `ctx.exiting` with `lt > dur` and the
incoming one `ctx.entering` with `lt < 0` — `seg()`/`clamp()` handle both automatically, which is why
shot draws should map `lt` through them rather than comparing raw times.
