// Offline frame-by-frame export: headless Edge/Chrome drives the same kit the preview uses,
// renders each frame at exactly i/fps, then ffmpeg assembles and muxes.
//
//   node render.mjs --project . --fps 30 --to 14.2 --height 1620 --crf 16
//   node render.mjs --thumb chart@4.1        # single QC frame
//   node render.mjs --shot world --jobs 3    # one shot, three parallel pages
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { startServer } from './serve.mjs';
import { encodePart, partPath, partFrames } from './part.mjs';

const SKILL = dirname(fileURLToPath(import.meta.url));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function arg(spec, argv = process.argv.slice(2)) {
  const out = {};
  const types = spec;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k in types) {
      const t = types[k];
      out[k] = t === 'bool' ? true : t === 'list' ? (argv[++i] ?? '').split(',') : argv[++i];
    } else {
      console.error(`unknown flag --${k}`);
      process.exit(1);
    }
  }
  for (const k in types) if (types[k] === 'bool') out[k] ??= false;
  return out;
}

const opts = arg({
  project: 'str', out: 'str', fps: 'num', from: 'num', to: 'num', height: 'num', width: 'num',
  supersample: 'num', crf: 'num', preset: 'str', jobs: 'num', audio: 'str', shot: 'str', thumb: 'str',
  exportWidth: 'num', resume: 'bool', recycle: 'num', 'no-prewarm': 'bool', 'no-encode': 'bool', keep: 'bool', quiet: 'bool', 'gpu-null': 'bool',
  chunk: 'num', png: 'bool',
});

const project = resolve(opts.project ?? '.');
const indexHtml = join(project, 'index.html');
if (!existsSync(indexHtml)) fail(`no index.html in ${project} — run new-project.mjs first`);

async function loadPuppeteer() {
  try {
    return (await import(pathToFileURL(join(project, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'entrypoints', 'main.js')).href)).default;
  } catch {}
  try {
    return (await import(pathToFileURL(join(SKILL, '..', 'node_modules', 'puppeteer-core', 'lib', 'esm', 'entrypoints', 'main.js')).href)).default;
  } catch {}
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    fail('puppeteer-core is missing. Install it next to the skill:  npm i puppeteer-core --prefix ' + resolve(SKILL, '..'));
  }
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const puppeteer = await loadPuppeteer();
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) fail('no Edge/Chrome found. Install Edge/Chrome or pass a browser path via MG_BROWSER env.');

// A drain that never arrives (dead ffmpeg, wedged pipe) must not hold the page's POST until
// puppeteer's 240 s protocol timeout: race the backpressure wait against the stream's death.
function waitDrain(stdin) {
  return new Promise((ok, no) => {
    const settle = (err) => {
      stdin.off('drain', onDrain);
      stdin.off('error', onGone);
      stdin.off('close', onGone);
      err ? no(err) : ok();
    };
    const onDrain = () => settle(null);
    const onGone = (err) => settle(err instanceof Error ? err : new Error('part encoder is gone'));
    stdin.once('drain', onDrain);
    stdin.once('error', onGone);
    stdin.once('close', onGone);
  });
}

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
  if (stdin.destroyed) throw new Error('part encoder is gone'); // fail the frame now; the retry path restarts the part
  if (!stdin.write(buf)) await waitDrain(stdin); // backpressure into the page
};
const server = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, '..', 'assets', 'kit'), port: 0, onFrame: opts.png ? null : sink });
const base = `${server.url}?render=1&hideUI=1&autoboot=on`;

const probe = await puppeteer.launch({
  executablePath: process.env.MG_BROWSER ?? exe,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', ...(opts['gpu-null'] ? ['--use-gl=swiftshader'] : ['--use-gl=angle', '--use-angle=d3d11']), '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

async function newPage(W, H) {
  const page = await probe.newPage();
  page.setDefaultTimeout(90000);
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 120000 });
  await page.evaluate((w, h) => window.MG.exportMode(w, h), W, H);
  if (!opts['no-prewarm']) {
    // Each page has its own GL context: compile every shader and build every point table once,
    // so the first exported frame costs the same as the rest.
    const t0 = Date.now();
    await page.evaluate(() => window.MG.prewarm());
    if (!opts.quiet) console.log(`  prewarm ${(Date.now() - t0) / 1000}s`);
  }
  return { page, errs, size: [W, H] };
}

// Read film metadata from inside the page so config/analysis always come from the project itself.
const info0 = await (async () => {
  const { page, errs } = await newPage(1920, 1080);
  const info = await page.evaluate(() => window.MG.info());
  await page.close();
  if (errs.length) console.error('page errors:', errs.slice(0, 4).join(' | '));
  return info;
})();

const duration = opts.to != null ? +opts.to : info0.duration;
const from = opts.from != null ? +opts.from : 0;
const design = { w: 1920, h: 1080 };
const fps = +(opts.fps ?? 30);
const supersample = +(opts.supersample ?? (opts.height ? 1 : 1.5));
const aspect = info0.size?.[1] ? info0.size[0] / info0.size[1] : design.w / design.h;
const even = (v) => Math.round(v / 2) * 2;
const H = +(opts.height ?? Math.round(design.h * supersample));
const W = +(opts.width ?? even(H * aspect));
// The encoded file always keeps the design aspect: render above it for supersampling, encode at it.
const exportH = +opts.height > design.h ? design.h : Math.min(H, design.h);
const exportW = +(opts.exportWidth ?? even(exportH * aspect));
const targetW = exportW, targetH = exportH;

if (opts.thumb) {
  const [id, t] = opts.thumb.split('@');
  const shot = info0.shots.find((s) => s.id === id);
  if (!shot) fail(`no shot "${id}". ids: ${info0.shots.map((s) => s.id).join(', ')}`);
  const time = t == null ? shot.start + 0.4 : +t;
  const out = join(project, 'build', 'qc');
  mkdirSync(out, { recursive: true });
  const { page, errs } = await newPage(W, H);
  const r = await page.evaluate((tt) => window.MG.draw(tt), time);
  const png = await (await page.$('#screen')).screenshot({ type: 'png' });
  const file = join(out, `${id}_${time.toFixed(2)}.png`);
  writeFileSync(file, png);
  console.log(`${file}  drawn=${r.drawn}${errs.length ? '  console=' + errs.length : ''}`);
  await probe.close();
  server.server.close();
  process.exit(0);
}

let ranges = [[Math.ceil(from * fps), Math.floor(duration * fps) - 1]];
if (opts.shot) {
  const shot = info0.shots.find((s) => s.id === opts.shot);
  if (!shot) fail(`no shot "${opts.shot}"`);
  ranges = [[Math.floor(shot.start * fps), Math.floor(shot.end * fps) - 1]];
}
const [f0, f1] = ranges[0];
const total = Math.max(1, f1 - f0 + 1);
const jobs = Math.max(1, Math.min(+(opts.jobs ?? 1), total));
const chunk = Math.max(1, +(opts.chunk ?? 300));
const partsDir = join(project, 'build', 'parts');
const parts = Array.from({ length: Math.ceil(total / chunk) }, (_, n) => {
  const [first, last] = partFrames(n, f0, chunk, total);
  return { n, first, last, path: partPath(partsDir, n) };
});
const rendered = new Set();
if (!opts.png) mkdirSync(partsDir, { recursive: true });
const outDir = resolve(opts.out ?? join(project, 'build', 'frames'));
if (opts.png) mkdirSync(outDir, { recursive: true }); // the streaming path must not create build/frames
if (!opts.quiet) {
  console.log(`film ${basename(project)} · ${total} frames ${f0}..${f1} @ ${fps}fps · render ${W}x${H} -> export ${targetW}x${targetH}`);
  if (info0.problems?.length) console.log(`timeline notes:\n  ${info0.problems.join('\n  ')}`);
}

const frameFile = (outDir, i) => join(outDir, `${String(i).padStart(5, '0')}.png`);
const t0 = Date.now();
let done = 0, skipped = 0, failed = [], slowest = 0;
const frameTries = new Map(); // frame -> tries so far: the 3-strike cap must outlive a part restart
const recycle = Math.max(0, +(opts.recycle ?? 400)); // --png only: the screenshot path reopens its page on schedule

async function renderPart(part) {
  const frames = part.last - part.first + 1;
  let stdin = null;
  let encoded = Promise.resolve();
  if (!opts.png) {
    ({ stdin, done: encoded } = encodePart({ path: part.path, W, H, targetW, targetH, fps, frames, crf: +(opts.crf ?? 16), preset: opts.preset ?? 'slow' }));
    active.set(part.n, stdin);
    stdin.on('error', () => {}); // a dead ffmpeg must surface through `encoded`, not crash node
  }
  let { page, errs } = await newPage(W, H);
  let since = 0;
  // --png falls back to the old grab: draw the frame with frameAt, screenshot the canvas to disk.
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
  try {
    for (let i = part.first; i <= part.last; i++) {
      // Parts are not the unit of work on the PNG path: resume means "this PNG is already on disk".
      if (opts.png && opts.resume && existsSync(frameFile(outDir, i))) { skipped++; continue; }
      const s = Date.now();
      let r = null;
      for (let attempt = 1; ; attempt++) {
        try {
          r = await grab(i);
          break;
        } catch (err) {
          const n = (frameTries.get(i) ?? 0) + 1;
          frameTries.set(i, n);
          if (n >= 3) {
            console.error(`\n  frame ${i} failed ${n} times: ${String(err.message ?? err).slice(0, 120)}`);
            failed.push(i);
            // Give up on the whole part: a half-fed ffmpeg is worthless. Without rendered.add it
            // stays incomplete, and the failed frame exempts it from missingParts below.
            await page.close().catch(() => {});
            if (stdin) { active.delete(part.n); stdin.destroy(); await encoded.catch(() => {}); }
            return;
          }
          console.error(`\n  frame ${i} attempt ${n}: ${String(err.message ?? err).slice(0, 120)}, reopening the part`);
          await page.close().catch(() => {});
          if (stdin) { active.delete(part.n); stdin.destroy(); await encoded.catch(() => {}); }
          done -= i - part.first; // this part re-renders from scratch; un-count the frames it thought it had
          return renderPart(part); // a whole part again: a half-fed ffmpeg is worthless
        }
      }
      since++;
      slowest = Math.max(slowest, Date.now() - s);
      done++;
      if (!opts.quiet && r?.errors > 0 && done % 60 === 0) process.stdout.write(`\n  ! ${info0.errors.at(-1)}\n`);
      if (!opts.quiet && done % 30 === 0) {
        const rate = done / Math.max((Date.now() - t0) / 1000, 1e-9);
        process.stdout.write(`  ${done}/${total} frames  ${(1000 / Math.max(rate, 0.01)).toFixed(0)} ms/frame  eta ${((total - done) / rate).toFixed(0)}s\r`);
      }
      if (opts.png && recycle > 0 && since >= recycle && i < part.last) {
        await page.close().catch(() => {});
        ({ page, errs } = await newPage(W, H));
        since = 0;
      }
    }
    await page.close().catch(() => {});
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
  if (stdin) { active.delete(part.n); stdin.end(); await encoded; }
  if (errs.length) console.error(`\n  part ${part.n} page errors (${errs.length}): ${errs.slice(0, 3).join(' | ')}`);
  rendered.add(part.n);
}

/** A part is reusable only if it exists and decodes to exactly the frames it owns. */
function complete(part) {
  if (!existsSync(part.path)) return false;
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', part.path], { encoding: 'utf8' });
  return +probe.stdout.trim() === part.last - part.first + 1;
}

// Workers take whole parts, so ordering is structural: no shared cursor, no re-sorting.
const worker = (id) => parts.filter((_, i) => i % jobs === id).map((p) => p.n);
const queue = [...parts];
async function runWorker(id) {
  const mine = new Set(worker(id));
  for (const part of queue) {
    if (!mine.has(part.n)) continue;
    if (!opts.png && opts.resume && complete(part)) {
      rendered.add(part.n);
      skipped++;
      continue;
    }
    await renderPart(part);
  }
}

process.on('unhandledRejection', (err) => console.error(`\n  [page] ${String(err?.message ?? err).slice(0, 120)}`));
await Promise.all(Array.from({ length: jobs }, (_, id) => runWorker(id).catch((err) => console.error(`\n  worker ${id} aborted: ${String(err.message ?? err).slice(0, 160)}`))));
const secs = (Date.now() - t0) / 1000;
if (!opts.quiet) {
  process.stdout.write(`\n  rendered ${done}/${total} frames${opts.png ? '' : ` into ${rendered.size}/${parts.length} parts`} in ${secs.toFixed(1)}s (${(done / secs).toFixed(1)} fps, slowest ${slowest} ms/frame)`);
  process.stdout.write(skipped ? `  (${skipped} ${opts.png ? 'frames already on disk' : 'parts already complete'}, kept)\n` : '\n');
}
if (opts.png) {
  // Frame-level completeness: on the PNG path a part is not the unit of work.
  const missing = [];
  for (let i = f0; i <= f1; i++) if (!existsSync(frameFile(outDir, i))) missing.push(i);
  if (missing.length) {
    const show = missing.slice(0, 12).join(', ') + (missing.length > 12 ? `, ... (${missing.length} total)` : '');
    fail(`${missing.length} of ${total} frames are missing (${show}). Re-run with --resume to fill only the gaps; frames are in ${outDir}.`);
  }
} else {
  const missingParts = parts.filter((p) => !rendered.has(p.n) && !failed.some((i) => i >= p.first && i <= p.last));
  if (failed.length || missingParts.length) {
    fail(`${failed.length} frames failed${missingParts.length ? ` and ${missingParts.length} parts are incomplete (${missingParts.slice(0, 12).map((p) => p.n).join(', ')})` : ''}. Re-run with --resume; parts are in ${partsDir}.`);
  }
}

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
  const enc = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(f0), '-i', pattern, ...(audio ? ['-i', resolve(project, audio), '-map', '0:v', '-map', '1:a'] : ['-map', '0:v']), '-c:v', 'libx264', '-crf', String(opts.crf ?? 16), '-preset', opts.preset ?? 'slow', '-pix_fmt', 'yuv420p', '-vf', down ? `scale=${targetW}:${targetH}:flags=lanczos` : 'null', '-r', String(fps), out], { stdio: 'inherit' });
  if (enc.status !== 0) fail(`ffmpeg failed (exit ${enc.status}). Frames are in ${outDir}.`);
  if (!opts.keep) for (let i = f0; i <= f1; i++) rmSync(frameFile(outDir, i), { force: true });
} else {
  const list = join(partsDir, 'list.txt');
  writeFileSync(list, parts.map((p) => `file '${p.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const cat = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...(audio ? ['-i', resolve(project, audio), '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k'] : []), '-c:v', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
  if (cat.status !== 0) fail(`concat failed (exit ${cat.status}). Parts are in ${partsDir}.`);
  if (!opts.keep) rmSync(partsDir, { recursive: true, force: true });
}
await probe.close();
server.server.close();
console.log(`  wrote ${out}`);
