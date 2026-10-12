# mg-animation

Author motion-graphics films **entirely in code**: a shot timeline in plain JavaScript, WebGL2
rendering, beat-synced cuts, and frame-by-frame export to MP4. No After Effects, no timeline GUI,
no build step.

A film is a list of shots; each shot is a pure `draw(ctx)` function of the frame it is given. The
same code runs in a live preview browser while you author, and headless frame-by-frame when you
export — so what you reviewed is exactly what ships.

```
brief → storyboard → analyse audio → author shots → QC frames → render → encode
```

## Requirements

- Node.js ≥ 20
- `ffmpeg` on `PATH`
- Microsoft Edge or Google Chrome (drives the renderer; the real GPU is used, not SwiftShader)
- `npm i puppeteer-core` (already covered if you installed this as a Qoder skill)

Check everything with:

```bash
node scripts/doctor.mjs --project .
```

## Quick start

```bash
npm i puppeteer-core                                   # once, in this folder
node scripts/new-project.mjs ./my-film --name "My film"
cd my-film

# optional: key the film to music (and captions to a .lrc file)
node ../mg-animation/scripts/analyze.mjs track.mp3 --out analysis/out --lrc lines.lrc

node ../mg-animation/scripts/preview.mjs --project .   # live: space play, ←/→ seek, [ ] shot step
node ../mg-animation/scripts/render.mjs --project . --thumb chart@4.5   # one QC still to look at
node ../mg-animation/scripts/render.mjs --project . --fps 30 --height 1620 --crf 16
```

Output lands in `build/<name>_1920x1080_30.mp4`. Mux the soundtrack afterwards with
`ffmpeg -i build/clip.mp4 -i track.mp3 -c copy -shortest build/final.mp4`, or pass `--audio track.mp3`.

## A shot

```js
import { Cam, shapes } from '../kit/prims.js';
import { ease, seg, rgb } from '../kit/math.js';
import * as C from '../kit/craft.js';

export default {
  id: 'demo',
  duration: 14.2,
  shots: [
    {
      id: 'chart',
      at: (T, { HIT }) => HIT(T, 'sec2', 4),        // the measured kick, one frame early
      transitionIn: { type: 'wipe', dur: 0.22 },    // how this shot ENTERS
      draw(ctx) {
        const { lt, t, lines, text, post } = ctx;
        ctx.cam = new Cam({ mode: 'ortho' });
        lines.begin();
        for (let i = 0; i < 6; i++) {
          const k = ease.outCubic(seg(lt, 0.25 + i * 0.09, 0.8 + i * 0.09));   // stagger, then grow
          lines.segment(C.px2world(300 + i * 220, 780), C.px2world(300 + i * 220, 780 - 420 * k),
            { color: rgb('#7ef0ff', 0.4), width: 92, glow: 0.9 });
        }
        lines.render(ctx);
        C.heroWord(text.scene, 'THROUGHPUT', 960, 300, { t, start: 0.2, decode: 0.55, size: 148 });
        C.hudFrame(text.scene, { alpha: 0.35, label: 'CHART', time: C.timecode(lt) });
        post.bloom = 0.4;
      },
    },
  ],
};
```

## What's inside

| Path | Contents |
|---|---|
| `assets/kit/` | the engine: 12 dependency-free ES modules (timeline, timing, features, camera, glow lines, GPU particle swarm, Canvas2D text layers, HDR bloom + grading uber pass, 8 joins, craft helpers) |
| `assets/template/` | `index.html` plus a 5-shot `src/film.js` — one shot per family |
| `scripts/analyze.mjs` | audio → beats, downbeats, onsets, sections, 23 per-frame feature channels |
| `scripts/new-project.mjs` | scaffold a standalone film project |
| `scripts/preview.mjs` | serve + open a scrubbable live preview |
| `scripts/render.mjs` | headless frame-by-frame export + ffmpeg encode (supersampling, parallel pages, per-shot and QC modes) |
| `scripts/doctor.mjs` | environment check |
| `scripts/smoke.mjs` | 14-check end-to-end test of everything above |
| `SKILL.md`, `references/` | the authoring workflow, craft numbers, shot recipes, full API |

Used as a [Qoder](https://qoder.com) CLI skill, drop this folder into `~/.qoder-cn/skills/` and
invoke it with `/mg-animation`. It works standalone without Qoder too — the scripts are plain Node.

## Verified

`node scripts/smoke.mjs` → 14/14: analysis self-test, scaffold, boot on a real 120 BPM track, beat
keys landing on measured onsets, every sampled frame a real picture, joins firing on the incoming
shot, clean export sweep, PNG QC stills, MP4 encode at the right aspect and frame count.

Throughput on an RTX 5070 Ti: ~0.35 s/frame at 2880×1620 supersampled with particles and bloom,
2 parallel pages — a 14 s film in about 2.5 minutes.

## Attribution and licence

The architecture — shots as data, absolute song time, joins declared on the incoming shot, text
layers composited before and after grading, analysis-driven key functions — was studied in
[world-execute-web](https://github.com/FrostNovaOrg/world-execute-web), an AGPL-3.0 web player for a
code-generated music video. **No code, text or asset from that repository is included here**; this
engine was written from scratch, and the example film uses only generic placeholder wording.

Copyright © 2026 LiaoZiqi-GZFLS. Licensed under the GNU Affero General Public License v3.0 or later.

`assets/kit/pointcut.js` is **derived from** `src/engine/pointcut.js` in
[world-execute-web](https://github.com/FrostNovaOrg/world-execute-web) (Copyright © 2026 FrostNova,
AGPL-3.0-or-later), pinned at commit `29aefca50e40c14498420e1c6e1f3a1037727e17`; it is a port to raw
WebGL2 with the three.js dependency removed. See [`NOTICE`](NOTICE) for the full statement of what
came from where and what was changed. Everything else here is original work.

Music, lyrics, cover art and branding from that project are not included and are not covered by its
licence. Lyric captions in a film are rendered at run time from a `.lrc` file the user supplies; no
lyric text is stored in this repository. Fonts are not bundled either — the template falls back to
whatever the system provides.
