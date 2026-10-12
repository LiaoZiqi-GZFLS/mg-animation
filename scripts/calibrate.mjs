// Measure what this machine costs per shot, so the preview player can pick a height before it plays
// rather than after it has dropped a few frames. Writes the cost table kit/quality.js predicts from.
//
//   node scripts/calibrate.mjs --project . [--reps 5] [--sizes 640x360,1280x720] [--out analysis/out/cost.json]
//
// A shot's frame is modelled as `fixed + pixel * megapixels`, so two sizes are enough to tell the two
// apart: the first is the cost of the passes that do not care about resolution, the second's slope is
// the per-pixel work. Each is the median of --reps timed draws, after one warm-up draw of the same
// frame (a first draw at a new time builds text and point caches that are not part of a frame's cost).
import { existsSync, writeFileSync } from 'node:fs';
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
const has = (k) => argv.includes('--' + k);
const project = resolve(flag('project', '.'));
const port = +flag('port', 5213);
const reps = Math.max(3, +flag('reps', 5));
const out = resolve(project, flag('out', join('analysis', 'out', 'cost.json')));
const sizes = flag('sizes', '640x360,1280x720')
  .split(',')
  .map((s) => s.split('x').map(Number))
  .filter((s) => s.length === 2 && s.every(Number.isFinite));

if (!existsSync(join(project, 'index.html'))) {
  console.error(`Error: no index.html in ${project}`);
  process.exit(1);
}
if (sizes.length < 2) {
  console.error('calibration needs at least two sizes to separate fixed from per-pixel cost');
  process.exit(1);
}

const { server } = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'), port });
const puppeteer = (await import(pathToFileURL(join(SKILL, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-renderer-backgrounding'],
});
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/index.html?render=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 120000 });

  const film = await page.evaluate(() => ({
    design: window.MG.engine.config.design,
    duration: window.MG.engine.duration,
    shots: window.MG.timeline.shots.map((s) => ({ id: s.id, start: s.start, end: s.end, join: s.join ?? null })),
    gpu: window.MG.engine.gl.getParameter(window.MG.engine.gl.VERSION),
    renderer: (() => {
      const gl = window.MG.engine.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })(),
  }));
  const points = await page.evaluate(
    async (dur) => {
      const { midTime } = await import(new URL('kit/quality.js', location.href).href);
      const shots = window.MG.timeline.shots;
      return shots.map((s, i) => ({ id: s.id, t: midTime(shots, i, 0, dur) })).filter((p) => p.t != null);
    },
    film.duration
  );
  console.log(`  ${film.shots.length} shots, ${points.length} measurable · ${film.renderer}`);

  const measured = {};
  for (const [w, h] of sizes) {
    const ms = await page.evaluate(      async ({ w, h, points, reps }) => {
        const { sizeFor } = await import(new URL('kit/quality.js', location.href).href);
        const e = window.MG.engine;
        const gl = e.gl;
        const [W, H] = sizeFor(h, e.config.design);
        e.setSize(W, H);
        const px = new Uint8Array(4);
        const read = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const out = {};
        for (const { id, t } of points) {
          e.draw(t);
          read();
          const runs = [];
          for (let i = 0; i < reps; i++) {
            const t0 = performance.now();
            e.draw(t);
            read(); // the frame is not finished until the GPU has answered something
            runs.push(performance.now() - t0);
          }
          runs.sort((a, b) => a - b);
          out[id] = runs[runs.length >> 1];
        }
        return out;
      },
      { w, h, points, reps }
    );
    for (const [id, v] of Object.entries(ms)) (measured[id] ??= []).push(v);
    console.log(`  measured ${Object.keys(ms).length} shots at ${w}x${h}`);
  }

  // Solve ms_i = fixed + pixel * mpx_i for each shot: two sizes, two unknowns. Megapixels follow the
  // same rounding kit/quality.js predicts with, so the table and the prediction agree by construction.
  const mpx = sizes.map(([, h]) => {
    const W = Math.round((h * film.design.w) / film.design.h / 2) * 2;
    return (W * h) / 1e6;
  });
  const shots = {};
  const errs = [];
  for (const { id } of points) {
    const m = measured[id];
    if (!m || m.length < 2 || m.some((v) => !Number.isFinite(v))) continue;
    const [m1, m2] = m;
    let pixel = (m2 - m1) / (mpx[1] - mpx[0]);
    let fixed = m1 - pixel * mpx[0];
    if (pixel < 0 || fixed < 0) {
      // A shot whose cost does not grow with pixels (or grows less than the noise): one number, no slope.
      pixel = Math.max(0, pixel);
      fixed = Math.max(0, Math.min(m1, m2));
    }
    shots[id] = [+fixed.toFixed(3), +pixel.toFixed(3)];
    for (let i = 2; i < m.length; i++) {
      const pred = fixed + pixel * mpx[i];
      errs.push([Math.abs(pred - m[i]) / Math.max(m[i], 0.1), pred - m[i], id]);
    }
  }
  const sorted = Object.values(shots).sort((a, b) => a[0] - b[0]);
  const sortedP = Object.values(shots).sort((a, b) => a[1] - b[1]);
  const def = [sorted[sorted.length >> 1][0], sortedP[sortedP.length >> 1][1]];
  const table = {
    ref: `${film.renderer} · ${film.gpu}`,
    date: new Date().toISOString().slice(0, 10),
    design: [film.design.w, film.design.h],
    sizes,
    reps,
    shots,
    default: def,
    measured,
  };
  writeFileSync(out, JSON.stringify(table, null, 2) + '\n');
  console.log(`  wrote ${out}`);
  console.log(`  ${Object.keys(shots).length} shots · default [${def[0]}, ${def[1]}] ms`);
  if (sizes.length > 2) {
    // The fit above used the first two sizes; how well does it predict a size it never saw?
    const rel = errs.map((e) => e[0]);
    const byAbs = [...errs].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    console.log(`  the two-size model predicts ${sizes.slice(2).map((s) => `${s[0]}x${s[1]}`).join(', ')} to within ${(Math.max(...rel) * 100).toFixed(1)}% (worst ${Math.abs(byAbs[1]).toFixed(2)} ms, on ${byAbs[2]})`);
  } else {
    console.log('  (pass a third --sizes entry to check the model against a size it was not fitted to)');
  }
  const dear = Object.entries(shots).sort((a, b) => b[1][0] + b[1][1] * mpx[1] - (a[1][0] + a[1][1] * mpx[1]))[0];
  if (dear) console.log(`  dearest at ${sizes[1][0]}x${sizes[1][1]}: ${dear[0]} (${(dear[1][0] + dear[1][1] * mpx[1]).toFixed(1)} ms/frame)`);
} finally {
  await browser.close();
  server.close();
}
