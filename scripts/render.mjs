// Offline frame-by-frame export: headless Edge/Chrome drives the same kit the preview uses,
// renders each frame at exactly i/fps, then ffmpeg assembles and muxes.
//
//   node render.mjs --project . --fps 30 --to 14.2 --height 1620 --crf 16
//   node render.mjs --thumb chart@4.1        # single QC frame
//   node render.mjs --shot world --jobs 3    # one shot, three parallel pages
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { startServer } from './serve.mjs';

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
  exportWidth: 'num', 'no-prewarm': 'bool', 'no-encode': 'bool', keep: 'bool', quiet: 'bool', 'gpu-null': 'bool',
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

const server = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, '..', 'assets', 'kit') });
const base = `${server.url}?render=1&hideUI=1&autoboot=on`;

const probe = await puppeteer.launch({
  executablePath: process.env.MG_BROWSER ?? exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-sandbox', ...(opts['gpu-null'] ? ['--use-gl=swiftshader'] : ['--use-gl=angle', '--use-angle=d3d11']), '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

async function newPage(W, H) {
  const page = await probe.newPage();
  page.setDefaultTimeout(180000);
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
const outDir = resolve(opts.out ?? join(project, 'build', 'frames'));
mkdirSync(outDir, { recursive: true });
if (!opts.quiet) {
  console.log(`film ${basename(project)} · ${total} frames ${f0}..${f1} @ ${fps}fps · render ${W}x${H} -> export ${targetW}x${targetH}`);
  if (info0.problems?.length) console.log(`timeline notes:\n  ${info0.problems.join('\n  ')}`);
}

const chunks = Array.from({ length: jobs }, (_, i) => [f0 + Math.floor((total * i) / jobs), f0 + Math.floor((total * (i + 1)) / jobs) - 1]);
const t0 = Date.now();
let done = 0;
let slowest = 0;

async function runChunk([a, b]) {
  if (b < a) return;
  const { page, errs } = await newPage(W, H);
  const el = await page.$('#screen');
  for (let i = a; i <= b; i++) {
    const s = Date.now();
    const r = await page.evaluate((i, fps) => window.MG.frameAt(i, fps), i, fps);
    const png = await el.screenshot({ type: 'png' });
    writeFileSync(join(outDir, `${String(i).padStart(5, '0')}.png`), png);
    const ms = Date.now() - s;
    slowest = Math.max(slowest, ms);
    done++;
    if (!opts.quiet && (done % 15 === 0 || done === total)) {
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`  ${done}/${total} frames  ${(1000 / Math.max(rate, 0.01)).toFixed(0)} ms/frame  eta ${((total - done) / rate).toFixed(0)}s\r`);
    }
    if (r.errors > 0 && !opts.quiet && done % 60 === 0) process.stdout.write(`\n  ! ${info0.errors.at(-1)}\n`);
  }
  if (errs.length) console.error(`\n  page errors (${errs.length}): ${errs.slice(0, 3).join(' | ')}`);
  await page.close();
}

await Promise.all(chunks.map(runChunk));
const secs = (Date.now() - t0) / 1000;
if (!opts.quiet) process.stdout.write(`\n  rendered ${total} frames in ${secs.toFixed(1)}s (${(total / secs).toFixed(1)} fps, slowest ${slowest} ms/frame)\n`);

if (opts['no-encode']) {
  await probe.close();
  server.server.close();
  console.log(`frames: ${outDir}`);
  process.exit(0);
}

const audio = opts.audio ?? null;
const down = W !== targetW || H !== targetH;
const out = join(project, 'build', `${basename(project)}_${targetW}x${targetH}_${fps}.mp4`);
mkdirSync(dirname(out), { recursive: true });
const pattern = join(outDir, '%05d.png').replace(/\\/g, '/');
const vf = down ? `scale=${targetW}:${targetH}:flags=lanczos` : 'null';
const enc = spawnSync(
  'ffmpeg',
  ['-y', '-v', 'error', '-stats', '-framerate', String(fps), '-start_number', String(f0), '-i', pattern, ...(audio ? ['-i', resolve(project, audio)] : []),
   '-map', '0:v', ...(audio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '256k'] : []),
   '-c:v', 'libx264', '-crf', String(opts.crf ?? 16), '-preset', opts.preset ?? 'slow', '-pix_fmt', 'yuv420p', '-vf', vf, '-r', String(fps), '-frames:v', String(total), out],
  { shell: false, stdio: 'inherit' }
);
if (enc.status !== 0) fail(`ffmpeg failed (exit ${enc.status}). Frames are in ${outDir}; encode by hand or pass --no-encode.`);
if (!opts.keep) {
  for (let i = f0; i <= f1; i++) rmSync(join(outDir, `${String(i).padStart(5, '0')}.png`), { force: true });
  if (!existsSync(outDir) || statSync(outDir).size === 0) rmSync(outDir, { recursive: true, force: true });
}
await probe.close();
server.server.close();
console.log(`  wrote ${out}`);
