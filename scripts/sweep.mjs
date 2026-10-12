import puppeteer from 'file:///C:/Users/50354/.qoder-cn/skills/mg-animation/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { startServer } from 'file:///C:/Users/50354/.qoder-cn/skills/mg-animation/scripts/serve.mjs';

const s = await startServer({ dir: process.argv[2] ?? '.' });
const b = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});
const pg = await b.newPage();
pg.on('pageerror', (e) => console.log('[pageerror] ' + String(e.message).slice(0, 160)));
await pg.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
await pg.goto(s.url + '?render=1', { waitUntil: 'load' });
await pg.waitForFunction('window.MG&&document.body.dataset.ready==="1"', { timeout: 90000 });
const t0 = Date.now();
const rep = await pg.evaluate(async () => {
  const e = window.MG.engine;
  e.prewarm();
  const gl = e.gl;
  const buf = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  const rows = [];
  for (let t = 0; t <= 140; t += 1.5) {
    const r = e.draw(t);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, red = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
      if (buf[i] > 90 && buf[i + 1] < 30 && buf[i + 2] < 40) red++;
    }
    const n = buf.length / 4;
    rows.push({ t: +t.toFixed(1), shot: r.drawn, mean: +(sum / n).toFixed(1), err: red / n > 0.25 });
  }
  return { rows, errors: e.errors, problems: e.validate() };
});
const bad = rep.rows.filter((r) => r.err || r.mean < 1.5 || r.mean > 248);
console.log(`swept ${rep.rows.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('mean brightness  min', Math.min(...rep.rows.map((r) => r.mean)), 'max', Math.max(...rep.rows.map((r) => r.mean)));
console.log('shot errors:', rep.errors.length ? rep.errors.join(' | ') : 'none');
console.log('validator:', rep.problems.length ? rep.problems.join('; ') : 'clean');
console.log('suspect frames:', bad.length ? bad.map((r) => `${r.t}s ${r.shot} mean=${r.mean}${r.err ? ' ERROR-FRAME' : ''}`).join('\n  ') : 'none');
await b.close();
s.server.close();
