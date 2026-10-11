# Kit API reference

`assets/kit/` — 12 ES modules, no dependencies, no build step. Served straight to the browser.
A project gets its own copy from `new-project.mjs`; edit it freely.

```
math.js    easing, hashing, vec/mat, colour
config.js  PROJECT defaults, MARGIN, resolveConfig
gl.js      Prog (uniform-cached program), Target (HDR RT), FsQuad, textures, GLSL prelude
timeline.js Timeline + shot/join resolution
timing.js  Timing (beats/sections/lyrics) + K/keys authoring helpers
features.js Features (per-frame audio channels, envelope follower)
text.js    TextCanvas — design-px Canvas2D layer uploaded as a texture
prims.js   Cam, GlowLines, Swarm, shapes, Geom, textMask, boxMesh
post.js    POST_DEFAULTS, lerpPost, Bloom, Uber, TRANSITIONS, transitionProg, applyRamps
craft.js   THEME, heroWord, typeLine, drawLyrics, hudFrame, readout, panel, meter, callout,
           dimLine, floorGrid, scrim, stagger, open, pop, tickFlash, px2world
engine.js  Engine — the frame pipeline
player.js  browser bootstrap: live preview + window.MG export hooks
```

## Film definition

```js
export default {
  id: 'demo', duration: 14.2, audio: 'track.mp3',   // duration optional (last shot end wins)
  shots: [
    { id: 'open', at: 0, draw(ctx) {} },
    { id: 'next', at: (T) => T.beatTime(16), transitionIn: { type: 'wipe', dur: 0.22 }, draw(ctx) {} },
  ],
};
export const config = { renderFps: 30, supersample: 1.5 };
```

`at` accepts seconds, `(T, K) => seconds`, or `[seconds, offset]`. Shot fields: `id`, `at`, `dur?`,
`transitionIn?`, `init?(ctx)`, `draw(ctx)`, `ownsLyrics?`, `editOnly?` (skipped unless an edit keeps it).
`Timeline` throws on duplicate ids, non-finite starts, shots closer than one frame, and warns (via
`engine.validate()`) on sub-second shots, over-long joins and a film that outlives the audio.

## ctx (per shot, per frame)

| field | meaning |
|---|---|
| `t` | absolute song time, seconds |
| `lt` | time since this shot's start — **negative while entering, past `dur` while exiting** |
| `dur`, `p` | shot length, `clamp(lt/dur)` |
| `frame` | `round(t * renderFps)` |
| `T`, `F` | Timing, Features |
| `W`, `H`, `s`, `design`, `margin` | render size, design→render scale, design grid, MARGIN |
| `seed`, `rng(k)` | shot-hash seed and a stateless seeded noise source |
| `post` | mutable grade, starts at `POST_DEFAULTS` |
| `text` | `{ scene, overlay }` TextCanvas pair |
| `lines`, `swarm` | shared GlowLines / Swarm (already `begin()`ed) |
| `cam` | active Cam; assign a new one to move the camera |
| `pass(prog, uniforms)` | fullscreen shader into the current target |
| `clear(color)` | clear the current target |
| `defer(fn)` | draw at overlay time, after the grade: `defer(layer => layer.text(...))` |
| `scene(fn)` | shorthand for `text.scene.draw(fn)` |
| `entering`, `exiting`, `joinP` | join state |

## Timing (`T`) and keys

```
beatAt(t) beatTime(x) barAt(t) barTime(n) beatPhase(t) barPhase(t)
pulse(t, k=6, div=1)  barPulse(t, k=4)  snapBeat(t, div)
onsetNear('all'|'low'|'vocals', t, tol=0.06)
section(id|label) sectionAt(t) lineAt(t,{hold}) wordAt(t) findLine(text,nth) findWord(w,line,nth) linesIn(a,b)
isCaps(text)
```

`keys(T)` returns bound `B, BAR, HIT, W, VOX, AT`. `HIT`/`VOX` snap to *measured* onsets and subtract
one frame of lead; `findLine` throws when the text matches nothing or too many, so a typo can never
silently drop a caption.

`F.get(channel, t)` interpolates; `F.env(channel, t, release=0.25)` is a decay peak-hold (use this
for anything visible); `F.bands(t, out)` fills 16 mel values. Missing analysis ⇒ every read is 0.

## TextCanvas

```js
layer.text(str, x, y, { size, weight, family, italic, color, alpha, align, baseline, tracking,
                        rot, scale, glow, glowColor, stroke, strokeWidth, from, to, perChar })
layer.measure(str, opts) -> design px
layer.draw(g => {})      // raw Canvas2D, already scaled to design units
layer.clear() / layer.upload(gl)
```

`perChar(ch, index, i)` returns `{alpha, scale, dx, dy, color}` — that is how decode reveals,
wave-typing and per-letter pops are done. Coordinates are design px, origin top-left, +y down.
`ctx.text.scene` is composited **before** bloom (so it glows); `ctx.text.overlay` **after** grading
(exact colour, no bloom).

## GlowLines / Swarm / shapes / Geom / Cam

```js
lines.begin()
lines.segment(a, b, { color: [r,g,b] linear HDR, width: design px, glow: 0..1 })
lines.point(p, { color, size })
lines.polyline(pts, { color, width, glow, draw: 0..1, close })   // draw-on by arc length
lines.render(ctx, { cam })

swarm.render(ctx, { a: key, genA, b: key, genB, morph, reveal, spread, arc, noise, noiseFreq,
  noiseSpeed, size, minPx, colA, colB, sparkle, aperture, maxBlur, focal, wave, waveOrigin, cam })

shapes.point|grid|circle|sphere|ball|box|curve|along|text(count, opts) -> Float32Array(count*4)
textMask(str, {size, weight, family}) -> {data, w, h}
new Geom(gl, boxMesh(w,h,d), prog).render(ctx, { uModel, ...uniforms })

new Cam({ mode:'persp'|'ortho', eye, target, up, fov, orthoH, zoom, shift:[x,y], roll })
cam.clone(o) cam.orbit(az, el, r) cam.matrices(W,H) cam.project(worldPt, design) cam.focal()
```

Swarm `count` must be a perfect square (default 1<<18). Point tables are RGBA32F textures cached by
key — prefix keys with the shot id. `shapes.grid` auto-derives cols/rows from `count` so one point
fills one cell; overriding `cols`/`rows` with a small count clumps particles into visible rows.

## Grade and joins

`POST_DEFAULTS`: exposure, bloom, threshold, knee, radius, ca, glitch, scan, vignette, grain, sat,
contrast, lift, gamma, gain, tint, fade, fadeCol, tonemap (0 none / 1 ACES / 2 AgX), zoom, textGain,
dither. Shots mutate `ctx.post`; the engine lerps the two shots' grades across a join.

`TRANSITIONS`: fade, mix, wipe, dissolve, iris, glitch, zoom, pixel. `applyRamps(post, {lt, dur,
frames, fps, rampIn, rampOut, punch})` adds the entry flash and the 8-frame punch settle.

The uber pass order is fixed: zoom → glitch → CA → bloom add → exposure → tonemap → grade →
vignette → scan → fade → sRGB → overlay text → grain → TPDF dither. Text is therefore graded
*sRGB-space-last*: it stays exactly the colour you specified, and nothing you add later can tint it.

## Engine

```js
const e = new Engine({ canvas, def, timing: T, features: F, config });
e.setSize(W, H); e.draw(t) -> {a, b, p, drawn}; e.prewarm(onProgress); e.validate() -> string[];
e.renderShot(id, t, slot); e.duration; e.errors;
```

Pipeline per frame: resolve shots → render each into its own scene target → composite its scene text
→ join the two if in a transition window → queue overlay draws + default lyrics → bloom → uber to
canvas. A throwing shot paints the frame dark red and pushes to `e.errors`; never swallow it.

## window.MG (player.js)

```
MG.info() -> {duration, shots[], problems[], errors[], gpu, size}
MG.draw(t)  MG.frameAt(i, fps)  MG.seek(t)  MG.play()  MG.pause()
MG.setSize(h)  MG.prewarm()  MG.exportMode(W, H)   // CSS size = backing size, hides the UI
```

Query knobs: `?film=./src/film.js` `&data=analysis/out` `&t=12.3` `&q=1080` `&render=1` `&hideUI=1`.
`frameAt` must be called in ascending order — the export path relies on it.

## Traps worth knowing (all of these cost a debugging session)

- **Fullscreen passes must own GL state.** A shot that enables additive blending leaves it on, and
  the next composite pass then *accumulates* onto the previous frame instead of replacing it.
- **Never read the texture you are writing.** `FsQuad.draw(prog, null)` must bind the default
  framebuffer explicitly, or the final pass writes into whatever target was bound last.
- **Canvas2D is top-left, GL is bottom-left.** Upload text layers with `UNPACK_FLIP_Y_WEBGL`, and
  bridge coordinates with `px2world`.
- **Uniforms must be declared once.** `uRes` and `uT` come from the shared prelude; re-declaring
  them in a shot shader is a compile error. `Prog.u()` silently ignores unknown names, so a typo in
  a `set({...})` key is invisible — check the shader instead of the JS.
- **`readPixels` on an RGBA16F target with UNSIGNED_BYTE returns zeros.** Inspect HDR buffers by
  drawing them to the canvas with a copy program.
- **HDR discipline:** the bloom threshold is 1.0, so anything at full white blooms. Author base
  surfaces below 1.0 and reserve >1.0 for things that should glow.
- **Shader hashes must be integer-based.** `sin`-based hashes on pixel-scale coordinates degenerate
  into a regular lattice once bloom amplifies them.
