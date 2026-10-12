// Sweep a whole film at speed: draw every step-th frame, flag the ones that are black, blown out,
// or painted in the engine's error red, and report the brightness range. Read-only — it never writes.
//
//   node scripts/sweep.mjs <project-dir> [--step 1.5] [--fps 30] [--height 540]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const project = resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const step = +flag('step', 1.5);
const height = +flag('height', 540);
if (!existsSync(join(project, 'index.html'))) {
  console.error(`Error: no index.html in ${project}`);
  process.exit(1);
}

const puppeteer = (await import(pathToFileURL(join(SKILL, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
const exe = process.env.MG_BROWSER ?? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const { server, url } = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'), port: +flag('port', 0) });
const b = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});
const pg = await b.newPage();
pg.on('pageerror', (e) => console.log('[pageerror] ' + String(e.message).slice(0, 160)));
await pg.setViewport({ width: Math.round((height * 16) / 9), height, deviceScaleFactor: 1 });
await pg.goto(`${url}?render=1`, { waitUntil: 'load' });
await pg.waitForFunction('window.MG&&document.body.dataset.ready==="1"', { timeout: 120000 });

const t0 = Date.now();
const rep = await pg.evaluate(async (step) => {
  const e = window.MG.engine;
  e.prewarm();
  const gl = e.gl;
  const buf = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  const rows = [];
  for (let t = 0; t <= e.duration; t += step) {
    const r = e.draw(t);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0,
      red = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
      if (buf[i] > 90 && buf[i + 1] < 30 && buf[i + 2] < 40) red++;
    }
    const n = buf.length / 4;
    rows.push({ t: +t.toFixed(1), shot: r.drawn, mean: +(sum / n).toFixed(1), err: red / n > 0.25 });
  }
  return { rows, errors: e.errors, problems: e.validate() };
}, step);
await b.close();
server.close();

const bad = rep.rows.filter((r) => r.err || r.mean < 1.5 || r.mean > 248);
console.log(`swept ${rep.rows.length} frames of ${existsSync(project) ? project : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('mean brightness  min', Math.min(...rep.rows.map((r) => r.mean)), 'max', Math.max(...rep.rows.map((r) => r.mean)));
console.log('shot errors:', rep.errors.length ? rep.errors.join(' | ') : 'none');
console.log('validator:', rep.problems.length ? rep.problems.join('; ') : 'clean');
console.log('suspect frames:', bad.length ? bad.map((r) => `${r.t}s ${r.shot} mean=${r.mean}${r.err ? ' ERROR-FRAME' : ''}`).join('\n  ') : 'none');
process.exit(bad.length || rep.errors.length ? 1 : 0);
