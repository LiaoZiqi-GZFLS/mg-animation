# 流式导出（raw 帧直灌 ffmpeg）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让离线导出把 GPU 帧缓冲直接流进 ffmpeg（每 chunk 一个 part，最后 concat），去掉"每帧编 PNG、几千张落盘"这条路径。

**Architecture:** 页面里 `readPixels` 取 RGBA → `POST /frame/<i>` 给技能自带的 dev server（只绑 127.0.0.1）→ node 按帧号路由到该帧所属 part 的 ffmpeg stdin。每 `--chunk` 帧编成 `build/parts/part-NNNN.mp4`，全部完成后 concat 并合音轨。页面 `await` 那个 POST，所以 ffmpeg 跟不上时页面就停在那一帧——背压是免费的。

**Tech Stack:** Node ≥ 20 ESM（无构建步骤）、puppeteer-core + headless Edge/Chrome（ANGLE/D3D11）、ffmpeg（libx264、rawvideo、concat）、WebGL2。

**Spec:** `docs/superpowers/specs/2026-10-12-streaming-export-design.md`（实测依据：GPU 7 ms/帧 vs PNG 编码 554 ms/帧；分片理由；验收判据）。

**对 spec 的一处修正：** spec §1 写的是"`readPixels` → 经 CDP 回 node → 写 ffmpeg stdin"。本计划改为**页面 POST 给本地 dev server**。理由：8.3 MB/帧过 CDP 要走 puppeteer 的序列化（实测只回传长度时是 7 ms，回传 8.3 MB 的成本未知且不可控），而 `fetch` 的 ArrayBufferView body 是浏览器直接发字节，且 `await` 天然给出背压。目标、分片、验收判据都不变。

## Global Constraints

- 不新增依赖：只有 Node 内建 + `puppeteer-core` + `ffmpeg`/`ffprobe`。禁止 sharp/canvas/pngjs/sharp 一类图像库。
- 导出的唯一渲染入口仍是 `window.MG.frameAt(i, fps)`；`?render=1` 仍不建 AudioContext、不建 UI、不接 Quality。
- `MG.frameRaw` 内部必须调用 `frameAt`，不得另起渲染路径——"两条路径同帧同像素"是验收项。
- 帧缓冲是 RGBA8、行序自下而上（GL 约定），一律由 ffmpeg 的 `vflip` 修正；node 侧不做逐像素转换。
- `W×H` 是渲染尺寸，`targetW×targetH` 是编码尺寸；不等时保留 Lanczos 缩放，且 `vflip` 在 `scale` 之前。
- 一个 part 内不换页（页面回收只服务 `--png` 路径）。
- 保留旧路径：`--png` 走现在的 PNG 落盘 + image2；`--thumb` 完全不动。
- 新脚本沿用现有约定：`arg({...})` 声明式参数、`fail(msg)` 退出、`--quiet` 静默、测试文件末尾打印 `N checks passed`。
- 每个 Task 一次提交；提交信息讲"为什么"。

---

### Task 1: 帧接收端 —— dev server 的 `/frame/<i>` sink 与 `MG.frameRaw`

**Files:**
- Modify: `scripts/serve.mjs:24-57`（`startServer` 增加可选 `onFrame`）
- Modify: `assets/kit/player.js`（`MG` 门面里加 `frameRaw`）
- Test: `scripts/frame-sink.test.mjs`（新建）

**Interfaces:**
- Consumes: `startServer({dir, kitFallback, port})`（现返回 `{server, port, url}`）；`window.MG.frameAt(i, fps)`。
- Produces:
  - `startServer({..., onFrame})`，`onFrame(i: number, req: IncomingMessage) => Promise<void>`；仅当传入时接受 `POST /frame/<i>`。
  - `MG.frameRaw(i: number, fps?: number) => Promise<{i, t, drawn, ...}>`：画第 i 帧 → 回读 → POST → POST 完成才 resolve。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/frame-sink.test.mjs`：

```js
// The frame sink must receive exactly the bytes the page drew, at the right size, and the page must
// not run ahead of it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const project = process.argv[2] ?? resolve(SKILL, 'assets/template');
const got = new Map();
const { server, url } = await startServer({
  dir: project,
  kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'),
  port: 0,
  onFrame: (i, req) =>
    new Promise((ok, no) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.set(i, Buffer.concat(chunks));
        ok();
      });
      req.on('error', no);
    }),
});
const puppeteer = (await import(pathToFileURL(join(SKILL, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: process.env.MG_BROWSER ?? exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
  await page.goto(`${url}?render=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 120000 });
  await page.evaluate((w, h) => window.MG.exportMode(w, h), 640, 360);
  const r = await page.evaluate(() => window.MG.frameRaw(7, 30));
  assert.equal(r.i, 7, 'the same frame the caller asked for');
  assert.equal(got.has(7), true, 'the sink received frame 7');
  assert.equal(got.get(7).length, 640 * 360 * 4, 'a raw frame arrives at full RGBA size, not encoded');
  assert.ok(got.get(7).some((b) => b !== 0), 'readPixels actually read something');
  ok('MG.frameRaw draws one frame and ships it as raw RGBA');
  // The POST is awaited: a sink that never finishes must hold the page.
  let release;
  const gate = new Promise((res) => (release = res));
  await Promise.all([
    page.evaluate(() => window.MG.frameRaw(8, 30)),
    (async () => {
      for (let i = 0; i < 200 && !got.has(8); i++) await new Promise((res) => setTimeout(res, 5));
      assert.ok(got.has(8), 'the second frame arrived too');
      release();
    })(),
  ]);
  await gate;
  ok('the page waits for the sink, which is the backpressure');
} finally {
  await browser.close();
  server.server.close();
}
console.log(`\nframe-sink: ${n} checks passed`);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node scripts/frame-sink.test.mjs`
Expected: FAIL — `window.MG.frameRaw is not a function`。

- [ ] **Step 3: 给 serve.mjs 加 sink**

签名改为 `export function startServer({ dir, kitFallback = null, port = 0, onFrame = null })`，在 handler 里 `let rel = decodeURIComponent(url.pathname);` 之后插入：

```js
    if (onFrame && req.method === 'POST' && rel.startsWith('/frame/')) {
      const i = Number(rel.slice('/frame/'.length));
      if (!Number.isInteger(i) || i < 0) {
        res.writeHead(400).end('bad frame index');
        return;
      }
      Promise.resolve(onFrame(i, req))
        .then(() => res.writeHead(204).end())
        .catch((e) => res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e?.message ?? e)));
      return;
    }
```

不传 `onFrame` 时行为与改动前逐字节一致；服务器已只绑 `127.0.0.1`（`serve.mjs:56`），POST 不新增可达面。

- [ ] **Step 4: 给 player.js 加 frameRaw**

在 `MG` 对象的 `frameAt` 之后加：

```js
    /** Export entry point that also ships the frame: draw i, read it back, POST it to the sink.
     *  Awaiting the POST is the backpressure — the page cannot run ahead of the encoder. */
    async frameRaw(i, fps = MG.fps) {
      const r = MG.frameAt(i, fps);
      const gl = engine.gl;
      const want = engine.W * engine.H * 4;
      if (!MG._px || MG._px.length !== want) MG._px = new Uint8Array(want);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, engine.W, engine.H, gl.RGBA, gl.UNSIGNED_BYTE, MG._px);
      const res = await fetch(`/frame/${i}`, { method: 'POST', body: MG._px });
      if (!res.ok) throw new Error(`frame sink ${res.status}`);
      return r;
    },
```

`MG._px` 复用同一块缓冲，避免每帧新分配 8.3 MB。

- [ ] **Step 5: 跑测试，确认通过**

Run: `node scripts/frame-sink.test.mjs`
Expected: `frame-sink: 2 checks passed`。

- [ ] **Step 6: 确认无回归**

Run: `node scripts/smoke.mjs`
Expected: `18/18 checks passed`。

- [ ] **Step 7: 提交**

```bash
git add scripts/serve.mjs assets/kit/player.js scripts/frame-sink.test.mjs
git commit -m "feat(scripts): a loopback frame sink, and MG.frameRaw that fills it"
```

---

### Task 2: 一个 part 的编码 —— raw stdin → libx264

**Files:**
- Create: `scripts/part.mjs`
- Test: `scripts/part.test.mjs`

**Interfaces:**
- Consumes: 无（纯 ffmpeg 子进程）。
- Produces:
  - `encodePart({path, W, H, targetW, targetH, fps, frames, crf, preset}) => {stdin: Writable, done: Promise<void>}`
  - `partPath(dir, n) => string`（`part-0003.mp4`）
  - `partFrames(n, f0, chunk, total = Infinity) => [first, last]`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/part.test.mjs`：

```js
// A part must be a decodable mp4 with the right size, frame count and orientation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePart, partPath, partFrames } from './part.mjs';

let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);
const dir = mkdtempSync(join(tmpdir(), 'mg-part-'));
const W = 64, H = 48, frames = 3;
const p = partPath(dir, 7);
const { stdin, done } = encodePart({ path: p, W, H, targetW: W, targetH: H, fps: 30, frames, crf: 16, preset: 'veryfast' });
// GL rows are bottom-up: mark the LAST row of the buffer so vflip must bring it to the top.
const px = Buffer.alloc(W * H * 4);
for (let x = 0; x < W; x++) {
  const o = ((H - 1) * W + x) * 4;
  px[o] = 255;
  px[o + 3] = 255;
}
for (let i = 0; i < frames; i++) stdin.write(px);
stdin.end();
await done;
const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8' });
const [sw, sh, sf] = probe.stdout.trim().split(/\r?\n/).map(Number);
assert.equal(sw, W, `width ${sw}`);
assert.equal(sh, H, `height ${sh}`);
assert.equal(sf, frames, `three frames in, ${sf} out`);
const corner = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'crop=1:1:0:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
assert.equal(corner.stdout[0], 255, 'the bottom-up marker landed on the top row: vflip is applied');
ok('a part decodes at the right size and frame count');
ok('vflip corrects GL row order');
assert.equal(partFrames(0, 100, 10)[0], 100, 'part 0 starts at the first frame');
assert.equal(partFrames(0, 100, 10)[1], 109, 'an open-ended part is a full chunk');
assert.deepEqual(partFrames(2, 100, 10, 25), [120, 124], 'the last part is short, not empty');
ok('partFrames covers the range and clamps the tail');
rmSync(dir, { recursive: true, force: true });
console.log(`\npart: ${n} checks passed`);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node scripts/part.test.mjs`
Expected: FAIL — `Cannot find module .../part.mjs`。

- [ ] **Step 3: 实现 part.mjs**

```js
// One part of an export: raw RGBA frames in on stdin, one x264 stream out. Parts are what make a
// long export resumable and parallel — each is a complete, independently decodable file.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const partPath = (dir, n) => join(dir, `part-${String(n).padStart(4, '0')}.mp4`);

/** The frame range part n covers, clamped to the last frame of the film. */
export const partFrames = (n, f0, chunk, total = Infinity) => [f0 + n * chunk, Math.min(f0 + (n + 1) * chunk - 1, f0 + total - 1)];

export function encodePart({ path, W, H, targetW, targetH, fps, frames, crf = 16, preset = 'slow' }) {
  const down = W !== targetW || H !== targetH;
  const vf = ['vflip', ...(down ? [`scale=${targetW}:${targetH}:flags=lanczos`] : [])].join(',');
  const ff = spawn(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(fps), '-i', '-',
      '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p', '-an', path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let err = '';
  ff.stderr.on('data', (d) => (err += d.toString()));
  const done = new Promise((ok, no) => {
    ff.on('error', no);
    ff.on('close', (code) => (code === 0 ? ok() : no(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`))));
  });
  return { stdin: ff.stdin, done };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node scripts/part.test.mjs`
Expected: `part: 3 checks passed`。

- [ ] **Step 5: 提交**

```bash
git add scripts/part.mjs scripts/part.test.mjs
git commit -m "feat(scripts): encode one export part straight from raw frames"
```

---

### Task 3: 把渲染循环接到 parts 上（含多 worker）

**Files:**
- Modify: `scripts/render.mjs:41-45`（参数）、`:74`（server 带 sink）、`:147-236`（循环与缺帧报告）
- Test: `scripts/render-parts.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `onFrame` sink、`MG.frameRaw`；Task 2 的 `encodePart/partPath/partFrames`。
- Produces:
  - `--chunk N`（默认 300）、`--png`（走旧路径）。
  - `build/parts/part-NNNN.mp4`；`parts: {n, first, last, path}[]`；`rendered: Set<number>`。
  - 帧号 → part 的路由由 `sink` 完成，多 worker 并发安全（不依赖任何"当前 part"单例）。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/render-parts.test.mjs`：

```js
// A streaming render must produce whole parts, in order, without touching the PNG path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);
const work = mkdtempSync(join(resolve(HERE, '..'), 'build-test-'));
const proj = join(work, 'film');
try {
  spawnSync(process.execPath, [join(HERE, 'new-project.mjs'), proj], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--to', '1', '--fps', '30', '--chunk', '10', '--height', '270'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `render failed: ${(r.stderr || r.stdout).slice(-500)}`);
  const parts = readdirSync(join(proj, 'build', 'parts')).filter((f) => /^part-\d+\.mp4$/.test(f));
  assert.deepEqual(parts, ['part-0000.mp4', 'part-0001.mp4', 'part-0002.mp4'], `30 frames at chunk 10 (got ${parts})`);
  ok('a streaming render writes whole parts, in order');
  assert.equal(existsSync(join(proj, 'build', 'frames')), false, 'no PNG directory on the streaming path');
  ok('the streaming path leaves no PNG files behind');
  const counts = parts.map((f) => +spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', join(proj, 'build', 'parts', f)], { encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(counts, [10, 10, 10], `each part holds its own chunk (${counts})`);
  ok('each part holds exactly its chunk of frames');
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nrender-parts: ${n} checks passed`);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node scripts/render-parts.test.mjs`
Expected: FAIL — `unknown flag --chunk`（`arg()` 拒绝未知参数并退出 1）。

- [ ] **Step 3: 参数与 parts 规划**

`arg({...})` 表里加 `chunk: 'num', png: 'bool'`。文件顶部加 `import { encodePart, partPath, partFrames } from './part.mjs';` 与 `import { createWriteStream } from 'node:fs'` 不需要（用子进程 stdin）。

在 `const jobs = ...`（:155）之后：

```js
const chunk = Math.max(1, +(opts.chunk ?? 300));
const partsDir = join(project, 'build', 'parts');
const parts = Array.from({ length: Math.ceil(total / chunk) }, (_, n) => {
  const [first, last] = partFrames(n, f0, chunk, total);
  return { n, first, last, path: partPath(partsDir, n) };
});
const rendered = new Set();
if (!opts.png) mkdirSync(partsDir, { recursive: true });
```

- [ ] **Step 4: sink 按帧号路由（多 worker 安全）**

`startServer`（:74）改为传入 sink：

```js
const active = new Map(); // part.n -> its ffmpeg stdin
const sink = async (i, req) => {
  const part = Math.floor((i - f0) / chunk);
  const stdin = active.get(part);
  if (!stdin) throw new Error(`no open part for frame ${i}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const want = W * H * 4;
  if (buf.length !== want) throw new Error(`frame ${i} arrived as ${buf.length} bytes, expected ${want}`);
  if (!stdin.write(buf)) await new Promise((res) => stdin.once('drain', res)); // backpressure into the page
};
const server = await startServer({ dir: project, kitFallback: ..., port: 0, onFrame: opts.png ? null : sink });
```

（`server` 变量名保持现状，`server.url` / `server.server.close()` 的用法不变。）

- [ ] **Step 5: 用 renderPart 取代 runChunk**

把 `chunks` 与 `runChunk`（:164-219）替换为下面的代码，**保留 `frameFile`（:163）**——`--png` 退路（Task 4）还要用它：

```js
const t0 = Date.now();
let done = 0, skipped = 0, failed = [], slowest = 0;

async function renderPart(part) {
  const frames = part.last - part.first + 1;
  const { stdin, done: encoded } = encodePart({ path: part.path, W, H, targetW, targetH, fps, frames, crf: +(opts.crf ?? 16), preset: opts.preset ?? 'slow' });
  active.set(part.n, stdin);
  const { page, errs } = await newPage(W, H);
  try {
    for (let i = part.first; i <= part.last; i++) {
      const s = Date.now();
      let r = null;
      for (let attempt = 1; ; attempt++) {
        try {
          r = await page.evaluate((i, fps) => window.MG.frameRaw(i, fps), i, fps);
          break;
        } catch (err) {
          if (attempt >= 3) {
            console.error(`\n  frame ${i} failed 3 times: ${String(err.message ?? err).slice(0, 120)}`);
            failed.push(i);
            break;
          }
          console.error(`\n  frame ${i} attempt ${attempt}: ${String(err.message ?? err).slice(0, 120)}, reopening the part`);
          await page.close().catch(() => {});
          active.delete(part.n);
          stdin.destroy();
          await encoded.catch(() => {});
          return renderPart(part); // a whole part again: a half-fed ffmpeg is worthless
        }
      }
      slowest = Math.max(slowest, Date.now() - s);
      done++;
      if (r?.errors > 0 && done % 60 === 0) process.stdout.write(`\n  ! ${info0.errors.at(-1)}\n`);
      if (!opts.quiet && done % 30 === 0) {
        const rate = done / Math.max((Date.now() - t0) / 1000, 1e-9);
        process.stdout.write(`  ${done}/${total} frames  ${(1000 / Math.max(rate, 0.01)).toFixed(0)} ms/frame  eta ${((total - done) / rate).toFixed(0)}s\r`);
      }
    }
    await page.close().catch(() => {});
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
  active.delete(part.n);
  stdin.end();
  await encoded;
  if (errs.length) console.error(`\n  part ${part.n} page errors (${errs.length}): ${errs.slice(0, 3).join(' | ')}`);
  rendered.add(part.n);
}

// Workers take whole parts, so ordering is structural: no shared cursor, no re-sorting.
const worker = (id) => parts.filter((_, i) => i % jobs === id).map((p) => p.n);
const queue = [...parts];
async function runWorker(id) {
  const mine = new Set(worker(id));
  for (const part of queue) {
    if (!mine.has(part.n)) continue;
    if (opts.resume && complete(part)) {
      rendered.add(part.n);
      skipped++;
      continue;
    }
    await renderPart(part);
  }
}
```

并在 `runWorker` 之前放占位实现，Task 4 会把它换成真的校验：

```js
const complete = () => false; // Task 4: a part is reusable only if it decodes to its own frame count
```

- [ ] **Step 6: 调度与缺 part 报告**

替换 :221-236：

```js
process.on('unhandledRejection', (err) => console.error(`\n  [page] ${String(err?.message ?? err).slice(0, 120)}`));
await Promise.all(Array.from({ length: jobs }, (_, id) => runWorker(id).catch((err) => console.error(`\n  worker ${id} aborted: ${String(err.message ?? err).slice(0, 160)}`))));
const secs = (Date.now() - t0) / 1000;
if (!opts.quiet) {
  process.stdout.write(`\n  rendered ${done}/${total} frames into ${rendered.size}/${parts.length} parts in ${secs.toFixed(1)}s (${(done / secs).toFixed(1)} fps, slowest ${slowest} ms/frame)`);
  process.stdout.write(skipped ? `  (${skipped} parts already complete, kept)\n` : '\n');
}
const missingParts = parts.filter((p) => !rendered.has(p.n) && !failed.some((i) => i >= p.first && i <= p.last));
if (failed.length || missingParts.length) {
  fail(`${failed.length} frames failed${missingParts.length ? ` and ${missingParts.length} parts are incomplete (${missingParts.slice(0, 12).map((p) => p.n).join(', ')})` : ''}. Re-run with --resume; parts are in ${partsDir}.`);
}
```

- [ ] **Step 7: 跑测试，确认通过**

Run: `node scripts/render-parts.test.mjs && node scripts/smoke.mjs`
Expected: `render-parts: 3 checks passed`；smoke 仍 `18/18`。

- [ ] **Step 8: 提交**

```bash
git add scripts/render.mjs scripts/render-parts.test.mjs
git commit -m "feat(scripts): stream frames into per-chunk parts instead of PNG files"
```

---

### Task 4: concat、音轨、`--resume` 校验、`--png` 退路

**Files:**
- Modify: `scripts/render.mjs:245-265`（编码段）
- Modify: `scripts/render.mjs`（`complete()` 实体）
- Modify: `scripts/smoke.mjs`（一条流式断言）
- Test: `scripts/render-parts.test.mjs`（追加续渲与成片）

**Interfaces:**
- Consumes: Task 3 的 `parts`、`partsDir`、`rendered`、`complete` 占位。
- Produces: `build/<film>_<targetW>x<targetH>_<fps>.mp4`（含 aac 音轨）；`--resume` = 跳过 ffprobe 校验通过的 part。

- [ ] **Step 1: 写失败的测试（成片 + 续渲）**

在 `scripts/render-parts.test.mjs` 的 `try` 内、`finally` 前追加：

```js
  const final = readdirSync(join(proj, 'build')).find((f) => f.endsWith('.mp4'));
  assert.ok(final, 'a final mp4 exists');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-show_entries', 'format=duration', '-of', 'default=nw=1', join(proj, 'build', final)], { encoding: 'utf8' });
  assert.match(probe.stdout, /nb_read_frames=30/, `all 30 frames survived the concat:\n${probe.stdout}`);
  ok('the parts concat into one complete film');
  assert.equal(existsSync(join(proj, 'build', 'parts')), false, 'parts are cleaned up after a successful concat');
  ok('parts are removed once the film is written');

  // Resume: delete one part's output and re-run; only that part must come back.
  spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--to', '1', '--fps', '30', '--chunk', '10', '--height', '270', '--keep'], { encoding: 'utf8' });
  const pd = join(proj, 'build', 'parts');
  rmSync(join(pd, 'part-0001.mp4'), { force: true });
  writeFileSync(join(pd, 'part-0002.mp4'), 'not an mp4');
  const before = statSync(join(pd, 'part-0000.mp4')).mtimeMs;
  const rr = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--to', '1', '--fps', '30', '--chunk', '10', '--height', '270', '--resume', '--keep'], { encoding: 'utf8' });
  assert.equal(rr.status, 0, `resume failed: ${(rr.stderr || rr.stdout).slice(-400)}`);
  assert.ok(existsSync(join(pd, 'part-0001.mp4')), 'the missing part was re-rendered');
  assert.notEqual(statSync(join(pd, 'part-0002.mp4')).size, 9, 'the corrupt part was re-rendered, not kept');
  assert.equal(statSync(join(pd, 'part-0000.mp4')).mtimeMs, before, 'a good part was left alone');
  ok('--resume re-renders only what is missing or corrupt');
```

测试文件顶部的 import 补 `writeFileSync` 与 `statSync`：

```js
import { existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node scripts/render-parts.test.mjs`
Expected: FAIL — 找不到 final mp4（Task 3 之后还没有 concat 步骤）。

- [ ] **Step 3: 实现 `complete()`**

把 Task 3 的占位换成：

```js
/** A part is reusable only if it exists and decodes to exactly the frames it owns. */
function complete(part) {
  if (!existsSync(part.path)) return false;
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', part.path], { encoding: 'utf8' });
  return +probe.stdout.trim() === part.last - part.first + 1;
}
```

- [ ] **Step 4: concat + mux，并把旧编码段留成 `--png` 分支**

替换 :245-265：

```js
const audio = opts.audio ?? null;
const out = join(project, 'build', `${basename(project)}_${targetW}x${targetH}_${fps}.mp4`);
mkdirSync(dirname(out), { recursive: true });
if (opts['no-encode'] && !opts.png) {
  await probe.close();
  server.server.close();
  console.log(`parts: ${partsDir}`);
  process.exit(0);
}
if (opts.png) {
  const pattern = join(outDir, '%05d.png').replace(/\\/g, '/');
  const down = W !== targetW || H !== targetH;
  const enc = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(f0), '-i', pattern, ...(audio ? ['-i', resolve(project, audio), '-map', '1:a'] : ['-map', '0:v']), '-c:v', 'libx264', '-crf', String(opts.crf ?? 16), '-preset', opts.preset ?? 'slow', '-pix_fmt', 'yuv420p', '-vf', down ? `scale=${targetW}:${targetH}:flags=lanczos` : 'null', '-r', String(fps), out], { stdio: 'inherit' });
  if (enc.status !== 0) fail(`ffmpeg failed (exit ${enc.status}). Frames are in ${outDir}.`);
  if (!opts.keep) for (let i = f0; i <= f1; i++) rmSync(frameFile(outDir, i), { force: true });
} else {
  const list = join(partsDir, 'list.txt');
  writeFileSync(list, parts.map((p) => `file '${p.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const cat = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...(audio ? ['-i', resolve(project, audio), '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k'] : []), '-c:v', 'copy', '-movflags', '+faststart', '-shortest', out], { stdio: 'inherit' });
  if (cat.status !== 0) fail(`concat failed (exit ${cat.status}). Parts are in ${partsDir}.`);
  if (!opts.keep) rmSync(partsDir, { recursive: true, force: true });
}
await probe.close();
server.server.close();
console.log(`  wrote ${out}`);
```

注意：`--png` 分支要求 `runWorker` 在 `opts.png` 时走原来的 `frameAt + el.screenshot + writeFileSync` 路径——把 Task 3 的取帧那一行改成：

```js
      const grab = async (i) => {
        if (opts.png) {
          const rr = await page.evaluate((i, fps) => window.MG.frameAt(i, fps), i, fps);
          const png = await (await page.$('#screen')).screenshot({ type: 'png' });
          if (!png?.length) throw new Error('empty screenshot');
          writeFileSync(frameFile(outDir, i), png);
          return rr;
        }
        return page.evaluate((i, fps) => window.MG.frameRaw(i, fps), i, fps);
      };
```

并把 `renderPart` 里 `page.evaluate(... frameRaw ...)` 换成 `grab(i)`；`active`/`encodePart` 只在 `!opts.png` 时创建（`if (!opts.png) { ...encodePart... }`），`--png` 时按 `--recycle` 换页（沿用现有 `since` 逻辑）。

- [ ] **Step 5: smoke 加一条流式断言**

`scripts/smoke.mjs` 里把现有"render.mjs encodes an MP4"之前插入：

```js
  const streamed = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--fps', '30', '--to', '2', '--chunk', '30', '--height', flag('height', 540)], { encoding: 'utf8' });
  const smp4 = (streamed.stdout || '').match(/(\S+\.mp4)/)?.[1];
  const sprobe = smp4 && existsSync(smp4) ? spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', smp4], { encoding: 'utf8' }).stdout.trim() : '';
  check('the streaming path encodes a decodable film', streamed.status === 0 && +sprobe === 60, sprobe ? `${sprobe} frames streamed` : (streamed.stderr || '').slice(0, 160));
```

- [ ] **Step 6: 跑全部测试**

Run: `node scripts/render-parts.test.mjs && node scripts/smoke.mjs && node scripts/part.test.mjs && node scripts/frame-sink.test.mjs`
Expected: 全绿（smoke 变成 19 项）。

- [ ] **Step 7: 提交**

```bash
git add scripts/render.mjs scripts/render-parts.test.mjs scripts/smoke.mjs
git commit -m "feat(scripts): concat parts, mux the track, and resume at part granularity"
```

---

### Task 5: 三条验收测量 + 文档重写

**Files:**
- Modify: `SKILL.md`（第 6 步"Render and encode"整段）
- Modify: `docs/superpowers/specs/2026-10-12-streaming-export-design.md`（状态 + 实测数字）

**Interfaces:**
- Consumes: 完成后的流式路径、`--png` 退路、`scripts/sheet.mjs`。
- Produces: 无新接口；产出是**写进 spec 的数字**。

- [ ] **Step 1: 同帧一致（判据 1）**

同一批帧分别用两条路径渲成裸数据与 PNG 视频，再逐像素比：

两条命令写的是**同一个** mp4 名（都由片名+尺寸+帧率推出），所以第一条跑完必须先改名，否则比的是自己和自己：

```bash
S="C:/Users/50354/Documents/Qoder/2026-10-12/c726d2de/mg-showcase"
cd "C:/Users/50354/.qoder-cn/skills/mg-animation/scripts"
node render.mjs --project "$S" --from 40 --to 41 --height 1080 --png --keep --quiet
mv "$S/build/mg-showcase_1920x1080_30.mp4" "$S/build/png-path.mp4"
node render.mjs --project "$S" --from 40 --to 41 --height 1080 --chunk 30 --keep --quiet
mv "$S/build/mg-showcase_1920x1080_30.mp4" "$S/build/raw-path.mp4"
python - "$S" <<'PY'
import sys, subprocess, numpy as np
S = sys.argv[1].replace('\', '/') + '/'
def grab(name, n=30):
    raw = S + 'build/' + name + '.raw'
    subprocess.run(['ffmpeg','-y','-v','error','-i',S+'build/'+name+'.mp4','-f','rawvideo','-pix_fmt','rgb24',raw], check=True)
    return np.fromfile(raw, np.uint8).reshape(n, 1080, 1920, 3).astype(np.int16)
a, b = grab('png-path'), grab('raw-path')
d = np.abs(a - b).max(axis=3)
print('compared', a.shape[0], 'frames | pixels differing >1 LSB:', int((d > 1).sum()), '| max delta', int(d.max()))
PY
```

（`--from 40 --to 41` 是 30 帧；若实际帧数不同，把 `reshape(n, ...)` 的 `n` 换成真实值。）

判据：**>1 LSB 的像素数为 0**。若出现 2 以上差异，先查 `vflip`、再查 `rgba→yuv420p` 的色彩范围（加 `-color_range tv`/`pc` 对齐），不许靠调阈值蒙过去。

- [ ] **Step 2: 接缝（判据 2）**

```bash
node render.mjs --project "$S" --from 40 --to 60 --height 1080 --chunk 300 --keep --quiet   # 无接缝（单 part）
node render.mjs --project "$S" --from 40 --to 60 --height 1080 --chunk 30  --keep --quiet   # 每 30 帧一段
```

对两条成片各跑 `ffmpeg -i x.mp4 -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -`，比较接缝帧（30 的倍数 ±2）与无接缝版的同帧 YAVG。判据：**边界跳变 < 1.5/255，且不大于该镜头自身相邻帧 YAVG 波动的 3σ**。过不了就走 spec 的退路（统一 `-g`，或单管顺序接力），并把实测数字与选择写进 spec 的"风险"节。

- [ ] **Step 3: 速度（判据 3）**

```bash
time node render.mjs --project "$S" --fps 30 --height 1080 --crf 16 --audio audio/track.mp3
```

记录 `rendered N/M frames ... in Xs` 原文；判据：**显著低于 2351 s**，且 `build/frames/` 不出现。若提升不到 5×，指出瓶颈转移到了哪一环（GPU 帧时 or x264），不要含糊收工。

- [ ] **Step 4: 崩得起（判据 4）**

整片渲到约 1/3 时 kill node，再 `--resume`；判据：**只重渲未完成的 part**（看 `skipped` 计数与 part 的 mtime），最终 `nb_read_frames=4200`、`duration=140.000000`。

- [ ] **Step 5: 重写 SKILL.md 第 6 步**

按新事实改：默认流式（帧不落盘）、`--chunk`/`--jobs`/`--resume` 的新语义、`--png` 是调试退路、时长预算从"~0.35 s/frame/page"改成实测值；保留"长导出必踩"那段，但把"frames are in build/frames"改为"parts are in build/parts"，并把"报告必须用实际完成数"的教训改写成 part 口径。

- [ ] **Step 6: 更新 spec 并提交**

把 spec 的"状态"改为已实施，插入 Task 5 三节的实测数字（一致、接缝、速度、崩溃恢复）。

```bash
git add SKILL.md docs/superpowers/specs/2026-10-12-streaming-export-design.md
git commit -m "docs(skill): the streaming export, with the measurements that came out of it"
```

- [ ] **Step 7: 全量回归**

Run: `node scripts/smoke.mjs && node scripts/player.test.mjs && node scripts/frame-sink.test.mjs && node scripts/part.test.mjs && node scripts/render-parts.test.mjs && node scripts/playcheck.mjs --project "$S"`
Expected: 全绿；`playcheck` 仍 13/13（导出改动不得影响预览）。
