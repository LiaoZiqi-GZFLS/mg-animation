// Contact sheets: look at a whole film at once. Frames come from the engine (deterministic, no
// encode needed) or from an already-rendered MP4. Tiles are assembled by ffmpeg, so the skill needs
// no image library beyond what render.mjs already uses.
//
//   node scripts/sheet.mjs --project .                       # one frame every --every seconds
//   node scripts/sheet.mjs --project . --cuts                 # a frame either side of every cut
//   node scripts/sheet.mjs --project . --times 12.5,24.3      # exactly these times
//   node scripts/sheet.mjs --from build/film.mp4 --every 5.5  # sample the encoded file instead
//
// Writes build/sheet.png (or --out) plus build/sheet.txt, which says what each cell is: the sheet is
// only useful if you can find the frame again.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const isFlag = (k) => argv.includes('--' + k);
const fail = (m) => {
  console.error(`sheet: ${m}`);
  process.exit(1);
};

const project = resolve(opt('project', '.'));
const from = opt('from', null);
const every = +opt('every', 5);
const tile = +opt('tile', 480);
const cols = +opt('cols', 5);
const height = +opt('height', 540);
const outDir = join(project, 'build');
const out = resolve(project, opt('out', join('build', 'sheet.png')));
const tmp = join(outDir, 'sheet-frames');

const ff = (args) => spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
const tileSheet = (target) => {
  const rows = Math.ceil(plan.length / cols) || 1;
  const r = ff([
    '-framerate', '1', '-i', join(tmp, '%04d.png'),
    '-vf', `scale=${tile}:-2,tile=${cols}x${rows}:padding=6:margin=6:color=0x10141a`, '-frames:v', '1', target,
  ]);
  if (r.status !== 0) fail(`ffmpeg failed tiling the sheet:\n${r.stderr?.toString().slice(0, 500)}`);
};

let plan = [];
let meta = [];
if (from) {
  const src = resolve(project, from);
  if (!existsSync(src)) fail(`no such file: ${src}`);
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], { encoding: 'utf8' });
  const total = +dur.stdout.trim() || 0;
  if (isFlag('cuts')) fail('--cuts needs the engine (drop --from)');
  for (let t = 0; t < total; t += every) plan.push(+t.toFixed(2));
  meta = plan.map((t) => [t, '—', 'from ' + basename(src)]);
} else {
  if (!existsSync(join(project, 'index.html'))) fail(`no index.html in ${project} (pass --project, or --from build/x.mp4)`);
  const puppeteer = (await import(pathToFileURL(join(SKILL, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
  const exe = process.env.MG_BROWSER ?? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
  const { server, url } = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'), port: +opt('port', 0) });
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: height * (16 / 9), deviceScaleFactor: 1 });
    await page.goto(`${url}?render=1`, { waitUntil: 'load' });
    await page.waitForFunction('window.MG&&document.body.dataset.ready==="1"', { timeout: 120000 });
    const info = await page.evaluate(() => ({ fps: window.MG.fps, duration: window.MG.info().duration, shots: window.MG.info().shots }));
    if (isFlag('times')) plan = String(opt('times')).split(',').map(Number).filter(Number.isFinite);
    else if (isFlag('cuts')) {
      for (const s of info.shots) {
        if (!s.join) continue;
        plan.push(+Math.max(0, s.start - 0.35).toFixed(3), +Math.min(info.duration - 1 / info.fps, s.start + 0.35).toFixed(3));
      }
    } else for (let t = 0; t < info.duration; t += every) plan.push(+t.toFixed(2));
    const el = await page.$('#screen');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (let i = 0; i < plan.length; i++) {
      const t = plan[i];
      const r = await page.evaluate((t, fps) => window.MG.frameAt(Math.round(t * fps), fps), t, info.fps);
      await el.screenshot({ path: join(tmp, `${String(i).padStart(4, '0')}.png`), type: 'png' });
      meta.push([t, r.drawn, r.join ? `${r.join} p=${r.p.toFixed(2)}` : '']);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

if (!plan.length) fail('nothing to draw (a film with no joins and --cuts?)');
tileSheet(out);
const grid = meta.map(([t, shot, note], i) => `${String.fromCharCode(65 + Math.floor(i / cols))}${(i % cols) + 1}  ${t.toFixed(2).padStart(7)}s  ${shot}${note ? '  ' + note : ''}`);
writeFileSync(join(outDir, 'sheet.txt'), grid.join('\n') + '\n');
console.log(`  ${out}  (${cols}x${Math.ceil(plan.length / cols)}, left to right, top to bottom)`);
console.log(`  ${join(outDir, 'sheet.txt')}`);
console.log(grid.join('\n'));
