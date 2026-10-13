---
name: mg-animation
description: Author motion-graphics (MG) animation films entirely in code — timeline-driven WebGL2 scenes with kinetic typography, data-viz, particle morphs and beat-synced cuts, exported frame-by-frame to MP4. Use when asked to 做MG动画 / 动效视频 / 科普动画 / 踩点视频 / motion graphics, to turn notes or data into an animated explainer, to build a code-generated title sequence or music-video-style film, or to render an existing src/film.js project to video.
---

# MG animation (code-generated films)

## Overview

A film is a JavaScript file: an ordered list of **shots**, each a `draw(ctx)` function rendered at a
known song time. The kit resolves the timeline, grades the picture, joins shots and exports every
frame deterministically, so a 30 s clip is 900 identical renders rather than a screen recording.

Deliverable of a successful run: `build/<name>_1920x1080_30.mp4` plus the `src/film.js` that generated it.

## Pipeline

```
brief → storyboard → analyze audio → scaffold project → author shots → QC frames (look!) → render → encode
```

### 0. Check the toolchain once

```
node <skill>/scripts/doctor.mjs --project <dir>
```
Needs Node ≥ 20, ffmpeg on PATH, Edge or Chrome, and `puppeteer-core` installed next to this skill
(`npm i puppeteer-core --prefix <skill-dir>`). Ask before installing anything.

### 1. Brief, then the treatment, then the table

Pin down: subject, length, aspect, whether there is music/narration, and 3–8 shots.

**Write `TREATMENT.md` in the project first** — the idea in one paragraph, the tone, the palette per
act with the reason it changes where it does, which face speaks which voice, and the plate table.
[`references/treatment.md`](references/treatment.md) is the template with a filled example. It costs
an hour and it is the only place a decision is recorded where a later shot can answer to it; every
palette hue, caption rule and headline in the film should be traceable to a line of it.

Then the shot table — one row per shot:

| id | at | dur | family | key elements | join in |
|---|---|---|---|---|---|
| open | 0 | 3.4 | title | hero word, particle ring, HUD | — |
| chart | 3.4 | 3.0 | data-viz | 6 bars, callout, meter | wipe .22 |

Family names refer to `references/shot-recipes.md`. A shot shorter than ~1.2 s reads as a mistake;
a shot longer than ~8 s needs internal beats.

### 2. Analyse the audio (if there is any)

```
node <skill>/scripts/analyze.mjs track.mp3 --out <proj>/analysis/out --lrc lines.lrc
```
Writes `timing.json` (beats, downbeats, sections, lyric words), `onsets.json` (measured hits),
`features.json` + `features.f32` (60 fps channels: rms, low/mid/high, centroid, flux, mel_00..15).
Pure Node + ffmpeg, ~0.2 s per 12 s of audio. Without this the timeline falls back to a uniform
grid at 120 BPM, so authoring can start before the music exists.

Key shots to the audio instead of typing floats:

```js
import { keys } from '../kit/timing.js';
const { B, HIT, W } = keys(T);
shots: [
  { id: 'open', at: 0 },
  { id: 'chart', at: (T) => HIT(T, 'sec2', 4) },        // measured hit, one frame early
  { id: 'world', at: (T) => B('sec3', 8) },             // 8 beats into section 3
  { id: 'code',  at: (T) => W(T, 'line text', 0) },     // first word of a lyric line
]
```

### 3. Scaffold

```
node <skill>/scripts/new-project.mjs ./my-film --name "My film"
```
Copies the template and a local `kit/` so the project runs standalone. Edit `src/film.js`; the
engine rarely needs changes.

### 4. Author the shots

Every shot receives one object and must be a pure function of it:

```js
{
  id: 'chart',
  at: 3.4,
  transitionIn: { type: 'wipe', dur: 0.22 },   // how this shot ENTERS
  ownsLyrics: false,
  init(ctx) { /* build once: programs, geometry, point tables */ },
  draw(ctx) {
    const { t, lt, p, T, F, post, text, lines, swarm, cam, rng, seed, s, W, H } = ctx;
    ctx.cam = new Cam({ mode: 'persp', eye: [0, 0, 1300], target: [0, 0, 0] });
    ctx.pass(bgProg, { uP: p });                       // fullscreen shader
    lines.begin();
    lines.segment(C.px2world(300, 780), C.px2world(1620, 780), { color: rgb('#1b2530', 1.6), width: 2 });
    lines.polyline(pts, { color: CY, width: 4, draw: ease.outCubic(seg(lt, 0.25, 0.9)) });
    lines.render(ctx);
    swarm.render(ctx, { a: 'chart:grid', genA: () => shapes.grid(N, {}), b: 'chart:ring',
      genB: () => shapes.circle(N, { r: 420 }), morph: ease.inOutCubic(seg(lt, .35, 2.1)), reveal: 0.12 });
    C.heroWord(text.scene, 'SIGNAL', 960, 300, { t, start: 0.2, decode: 0.55, size: 148 });
    C.hudFrame(text.scene, { alpha: 0.35, label: 'CHART', time: fmt(lt) });
    post.bloom = 0.4; post.vignette = 0.5;             // per-shot grade
  },
}
```

`references/engine-api.md` is the full surface; `references/shot-recipes.md` has a worked example
per family; `references/craft.md` holds the numbers worth copying.

### 5. QC loop — look at frames, do not trust the code

```
node <skill>/scripts/render.mjs --project . --thumb chart@4.9 --height 1080
```
Writes `build/qc/chart_4.90.png`. **Open the PNG and read it.** For each shot check: type legible
and inside the safe margins, elements not colliding, brightness settling mid-grey rather than
white, motion readable at that instant. Then render a frame *inside* every join
(`start - dur/2`) to confirm the transition looks intentional. Never report a shot as done from
geometry or exit codes alone.

One image for the whole film, which is how you see what a page of numbers cannot tell you — a frame
either side of every cut, or an even stride, or straight off the encoded MP4:

```
node <skill>/scripts/sheet.mjs --project . --cuts        # or: --every 5.5 | --from build/film.mp4
```
Writes `build/sheet.png` and `build/sheet.txt`, which names the shot and join progress in each cell so
any cell can be found again at full size. Read the sheet against the treatment's plate table: every row
should be visible, every cell should say what its row claims.

Sweep the whole film for shot errors and exposure before committing to a long export — it draws every
1.5 s in one page and reports black frames, blowouts and the dark-red error screen:

```
node <skill>/scripts/sweep.mjs <project-dir>
```

Live review while authoring:

```
node <skill>/scripts/preview.mjs --project .        # space play, ←/→ seek, [ ] shot step
```

The preview plays on a WebAudio output clock, so a 140 s film cannot drift; frames not yet due at
vsync are skipped rather than caught up on, so a stall costs dropped pictures instead of slow motion;
and an adaptive ladder walks 360p…2160p to hold the frame rate on the machine in front of it. Only the
render height moves — layout and the whole post chain stay as the export has them, so what you see is
what you get, only softer. A bar fades up over the film: play/pause, shot step, 0.25x–2x, a scrubber
carrying every shot tick and join mark, the `type → audio p=0.42` readout, the height it settled on and
the measured frame rate; ⚙ opens quality, frame rate and post-chain switches (turn bloom off to see the
design under it). Keys: space, ←/→ (shift 5 s), `[`/`]` shot, `,`/`.` frame, `q` lock or release the
height, `h` hide the bar, `f` fullscreen. `?q=720p` starts locked, `?fps=30` locked to 30, `?rate=0.25`
plays silently at quarter speed, `?hideUI=1` keeps the keyboard and drops the bar, and `?render=1`
builds none of it. A translated caption track is a data file, not code: `subs/zh.json` with
`{ lines: { [i]: text }, skip, silent, rows, accent }` over the film's own measured lines, shown by
`?subs=zh` (it works in render mode too, to burn captions into an export).

```
node <skill>/scripts/playcheck.mjs --project .      # the player itself, 17 checks
```

A film whose frames cost a few milliseconds does not need this, and the preview finds its height on its
own within a second. When it matters — a heavy film, a weak machine — measure it once:

```
node <skill>/scripts/calibrate.mjs --project .      # per-shot [fixed, per-Mpx] ms -> analysis/out/cost.json
```
The player then predicts the right rung before the first frame instead of learning it from dropped
ones, and can trade 60 fps for two rungs of resolution where a shot cannot hold both.

### 6. Render and encode

```
node <skill>/scripts/render.mjs --project . --fps 30 --height 1620 --jobs 2 --crf 16
```

Rendering is streaming: each frame is read back as raw RGBA, POSTed to the local server and piped
straight into ffmpeg — no PNG touches the disk. The export is cut into parts, one part per `--chunk`
frames (default 300) and one ffmpeg process each, written to `build/parts/part-NNNN.mp4`; the final
concat joins them and muxes the track in the same pass (`--audio track.mp3`). `--jobs N` renders N
parts in parallel (whole parts per worker); `--resume` re-renders only what is missing — on the
streaming path that means a part whose `ffprobe -count_frames` disagrees with the frames it owns
(under `--png`: a frame not yet on disk), and finished work is kept and reported as "N parts already
complete". A frame that fails three times abandons its whole part — a half-fed ffmpeg is worthless —
and the run then refuses to concat and names the incomplete parts, which live in `build/parts/`.
`--no-encode` is a streaming-path early exit: it stops after the parts are written and prints their
directory (under `--png` it encodes as usual). Report the absolute path, duration, resolution and
size.

`--height 1620` renders 2880×1620 and Lanczos-downscales to 1920×1080 — visibly cleaner glow and
line edges for ~2× the time. Each page pre-warms (compiles every shader, builds every point table) so
frame one costs what frame two costs; `--no-prewarm` skips it. Budget ~0.7 s/frame at 1080p-class
content on this machine as measured on the 140 s showcase (4200 frames in 3074 s at defaults;
`--jobs 4` ran a 300-frame slice at 0.42 s/frame) — the cost is moving each 8.3 MB frame from the
page to node, not the GPU (~5 ms) or x264 (~20 ms). `--shot id` re-renders one shot; `--from/--to` a
range; `--keep` keeps the parts after the film is written. `--png` is the debugging fallback: it
draws each frame, screenshots the canvas to `build/frames/*.png` and only then encodes from those
PNGs — slower, but the frames stay inspectable (`--recycle N`, default 400, swaps the page every N
frames there).

**Long exports (more than a few minutes) outlive one browser page.** A headless GPU context that runs
for thousands of frames eventually wedges: `Runtime.callFunctionOn timed out`, an empty screenshot, a
dead renderer. Parts are the unit this survives on: every part renders on its own fresh page, a
failing frame is retried up to 3 times on a fresh page, and the run refuses to encode a partial
sequence — it prints `rendered N/M frames into R/P parts` from the parts actually finished and names
the incomplete ones. Recover with:

```
node <skill>/scripts/render.mjs --project . --resume        # renders only the parts not finished
```

Never trust a progress line as proof of output: probe the film itself (`ffprobe -count_frames`) or
count the parts (`ls build/parts`) before reporting a film as done, and `--height 1080 --jobs 1` is
the stable setting for a multi-minute run — several 2880×1620 pages is where long exports die first.

## Hard rules

1. **A frame must render from `t` alone.** No mutable module state across frames; use `ctx.rng(k)`
   (seeded from the shot id) and `hash11/hash12`. `init()` may build objects, `draw()` may not mutate them.
   Per-frame flicker seeds on the **frame index** (`Math.round(t * fps)`), never on continuous `t`: a hash
   of `t` changes inside one frame, so it double-exposes the moment anything averages over a shutter.
2. **Two coordinate systems.** Text layers: design px, origin top-left, +y down. GL world: origin
   centred, +y up, 1 unit = 1 design px. Bridge them with `C.px2world(x, y)` — never hand-subtract.
3. **HDR discipline.** Base surfaces stay under 1.0 linear (`rgb(hex, 0.2)` for fills, `0.5` for
   mid-tones); only things that should glow go above 1.0. The bloom threshold is 1.0 by default, so
   a full-white title blooms into a blob.
4. **Fullscreen passes own their GL state.** Never rely on blending being off; shot code that
   enables it (lines, swarm) does so inside its own render call.
5. **`transitionIn` belongs to the incoming shot** and covers the window *before* its start.
6. **Shape-cache keys are film-wide.** `swarm.shape('world:sphere', …)` — prefix with the shot id.
7. **No per-frame allocation** in `draw()`: hoist programs, geometry and point tables into `init()`
   or lazy `x ??= …`, and reuse `ctx.lines` / `ctx.swarm`.
8. **Fail loudly.** The timeline throws on duplicate ids, bad lyric lookups and non-finite starts;
   a throwing shot paints the frame dark red with the message. Fix the cause, never silence it.
9. **Cuts land one frame early** (`HIT`/`VOX` already subtract `lead`) so the picture arrives with
   the sound rather than after it.
10. **Re-render after every change** — QC PNGs are the only evidence that counts.

## Resources

- `references/treatment.md` — the style-bible and plate-table template to copy into a new project.
- `references/craft.md` — durations, easings, margins, grade defaults, stagger, sync and the six type rules.
- `references/shot-recipes.md` — seven shot families with the kit calls that produce each look.
- `references/engine-api.md` — every kit module: signatures, uniforms, and the traps found building it.
- `assets/kit/` — the engine (13 ES modules, no dependencies, no build step).
- `NOTICE` — what was taken from upstream, at which commit, and what was changed.
- `assets/template/` — `index.html` + a 5-shot `src/film.js`, one shot per family.
- `scripts/analyze.mjs` — audio → beats/onsets/features; `scripts/.selftest.mjs` verifies it.
- `scripts/smoke.mjs` — end-to-end check: scaffold, analyse, render, assert the frames are real.
- `scripts/sweep.mjs` — whole-film error and brightness sweep, ~1 s per 90 frames.

## Provenance

The architecture and the shot techniques studied here come from
[world-execute-web](https://github.com/FrostNovaOrg/world-execute-web) (AGPL-3.0), a web player for a
fully code-generated music video. Look at its `src/engine/` and `src/ch/` when a technique is unclear
— how a join probes the outgoing camera, how a chapter keeps its own palette, how a shot table drives
cut points. Copying its code is allowed under AGPL-3.0-or-later **with obligations**: keep the copyright line,
record the pinned commit, state what changed, and keep the derived file under AGPL — `NOTICE` is
where that lives, and `assets/kit/pointcut.js` plus the preview player's eight files
(`clock/pace/gputimer/quality/transport/ui/i18n/subs`) are the worked examples. What is *not* licensed is the
song, its lyrics (including the official Chinese translation), the cover art and the Claude logo:
never put any of that in a file you author. Render lyric captions from a `.lrc` the user supplies at
run time, and keep example wording generic.
- `scripts/new-project.mjs`, `preview.mjs`, `render.mjs`, `sheet.mjs`, `sweep.mjs`, `playcheck.mjs`,
  `calibrate.mjs`, `analyze.mjs`, `doctor.mjs`, `serve.mjs`.
