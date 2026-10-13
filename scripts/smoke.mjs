// End-to-end smoke test for the whole pipeline: audio analysis, scaffold, engine boot, joins,
// per-shot rendering and the export CLI. Run it after changing anything in kit/ or scripts/.
//
//   node scripts/smoke.mjs [--keep] [--height 540]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k, d) => (argv.includes('--' + k) ? argv[argv.indexOf('--' + k) + 1] : d);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'mg-smoke-'));
let browser = null;
try {
  const self = spawnSync(process.execPath, [join(HERE, '.selftest.mjs')], { encoding: 'utf8' });
  const fails = (self.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
  check('analyze.mjs selftest', self.status === 0 && !fails.length, fails[0] ?? `exit ${self.status}`);

  const proj = join(work, 'film');
  const scaffold = spawnSync(process.execPath, [join(HERE, 'new-project.mjs'), proj], { encoding: 'utf8' });
  check('scaffold project', scaffold.status === 0 && existsSync(join(proj, 'src', 'film.js')) && existsSync(join(proj, 'kit', 'engine.js')), scaffold.stderr?.slice(0, 80));

  const lrc = join(work, 'lines.lrc');
  writeFileSync(lrc, ['[00:01.00]line one', '[00:02.00]line two', '[00:03.00]line three', '[00:04.00]line four'].join('\n') + '\n');
  mkdirSync(join(proj, 'subs'), { recursive: true });
  writeFileSync(join(proj, 'subs', 'test.json'), JSON.stringify({ lines: { 0: 'ALPHA', 1: 'BETA', 2: 'GAMMA', 3: 'DELTA' }, skip: [], silent: [2] }));

  const wav = join(work, 'click.wav');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'aevalsrc=0.8*sin(140*2*PI*t)*gt(mod(t\\,0.5)\\,0.03):d=6:s=48000', wav], { encoding: 'utf8' });
  const an = ff.status === 0 && spawnSync(process.execPath, [join(HERE, 'analyze.mjs'), wav, '--out', join(proj, 'analysis', 'out'), '--lrc', lrc], { encoding: 'utf8' });
  check('analyse synthetic 120 BPM track', an?.status === 0 && existsSync(join(proj, 'analysis', 'out', 'features.f32')), an?.stdout?.match(/tempo\s+([\d.]+) bpm/)?.[1] + ' bpm');

  const puppeteer = (await import(pathToFileURL(join(HERE, '..', 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
  const exe = process.env.MG_BROWSER ?? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
  if (!exe) throw new Error('no Edge/Chrome');
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  const { startServer } = await import(pathToFileURL(join(HERE, 'serve.mjs')).href);
  const server = await startServer({ dir: proj });
  await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
  await page.goto(server.url + '?render=1', { waitUntil: 'load' });
  await page.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 90000 });

  const boot = await page.evaluate(() => window.MG.info());
  check('film boots with analysis present', boot.shots.length === 5 && boot.errors.length === 0, `${boot.shots.length} shots, gpu=${String(boot.gpu).slice(0, 28)}`);
  const keyed = await page.evaluate(() => {
    const T = window.MG.T;
    return { B: window.MG.keys.B('sec1', 8), HIT: window.MG.keys.HIT(T.beats[6], 0), W: T.beats.length };
  });
  check('key helpers land on measured beats', Math.abs(keyed.B - 4.0) < 0.35 && keyed.HIT < keyed.B && keyed.W > 8, `B=${keyed.B.toFixed(3)} HIT=${keyed.HIT.toFixed(3)} beats=${keyed.W}`);
  check('audio features are readable', await page.evaluate(() => window.MG.F.get('rms', 1) > 0));

  const frames = await page.evaluate(async () => {
    const e = window.MG.engine;
    e.prewarm();
    const gl = e.gl;
    const px = () => {
      const buf = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0, white = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const v = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
        sum += v;
        if (v > 250) white++;
      }
      return { mean: sum / (buf.length / 4), white: white / (buf.length / 4) };
    };
    const out = [];
    for (const t of [1.2, 3.3, 4.5, 6.3, 9.3, 11.0, 13.4]) {
      const r = e.draw(t);
      out.push({ t, ...px(), drawn: r.drawn, join: r.join, p: r.p });
    }
    return { out, errors: e.errors, problems: e.validate() };
  });
  const bad = frames.out.filter((f) => f.mean < 2 || f.mean > 245 || f.white > 0.55);
  check('every sampled frame is a real picture', bad.length === 0, frames.out.map((f) => `${f.t}s mean=${f.mean.toFixed(0)}`).join(' '));
  check('ported points join renders', frames.out.some((f) => f.join === 'points'), frames.out.filter((f) => f.join === 'points').map((f) => `${f.t}s p=${f.p.toFixed(2)}`).join(' ') || 'no points join sampled');
  check('joins fire on the incoming shot', frames.out.filter((f) => f.join).length >= 3 && frames.out.every((f) => !f.join || (f.p > 0 && f.p < 1)), frames.out.filter((f) => f.join).map((f) => `${f.drawn}:${f.join}@p${f.p.toFixed(2)}`).join(', '));
  check('no shot errors during export sweep', frames.errors.length === 0, frames.errors.slice(0, 2).join(' | '));
  check('validator reports, does not throw', Array.isArray(frames.problems), frames.problems.join('; ') || 'clean');
  const subPage = await browser.newPage();
  await subPage.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
  await subPage.goto(server.url + '?render=1&subs=test', { waitUntil: 'load' });
  await subPage.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 90000 });
  const subs = await subPage.evaluate(() => {
    const e = window.MG.engine;
    const band = () => {
      const c = e.text.overlay;
      const s = c.s;
      const d = c.g.getImageData(Math.round(140 * s), Math.round(940 * s), Math.round(500 * s), Math.round(60 * s)).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
      return ink;
    };
    e.draw(1.4);
    const withSubs = band();
    e.subs = null;
    e.draw(1.4);
    const without = band();
    return { langs: window.MG.subs?.langs ?? [], at: window.MG.subs?.at('test', 1.4)?.text ?? null, silent: window.MG.subs?.at('test', 3.4)?.text ?? null, withSubs, without };
  });
  await subPage.close();
  check('translated captions load and paint', subs.langs.join() === 'test' && subs.at === 'ALPHA' && subs.withSubs > subs.without + 50, `${subs.at} on screen: ${subs.withSubs} inked px vs ${subs.without} without`);
  check('a silent line never subtitles, and the line before keeps its room', subs.silent === 'BETA', `over line three the screen still reads ${subs.silent}`);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  server.server.close();
  await browser.close();
  browser = null;

  const sheet = spawnSync(process.execPath, [join(HERE, 'sheet.mjs'), '--project', proj, '--cuts', '--tile', '240'], { encoding: 'utf8' });
  const png = join(proj, 'build', 'sheet.png');
  check('sheet.mjs tiles a whole film into one image', sheet.status === 0 && existsSync(png) && statSync(png).size > 30000, existsSync(png) ? `${Math.round(statSync(png).size / 1024)} KB, ` + String(sheet.stdout.split('\n').filter((l) => /^\s*[A-Z]\d\s/.test(l)).length) + ` cells labelled` : sheet.stderr?.slice(0, 120));

  const thumb = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--thumb', 'chart@4.5', '--height', flag('height', 540)], { encoding: 'utf8' });
  const file = (thumb.stdout || '').match(/(\S+\.png)/)?.[1];
  check('render.mjs --thumb writes a PNG', thumb.status === 0 && file && existsSync(file) && statSync(file).size > 20000, file ? `${Math.round(statSync(file).size / 1024)} KB` : thumb.stderr?.slice(0, 100));

  const clip = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--to', '2', '--height', '360', '--fps', '30', '--crf', '24'], { encoding: 'utf8' });
  const mp4 = (clip.stdout || '').match(/(\S+\.mp4)/)?.[1];
  check('render.mjs encodes an MP4', clip.status === 0 && mp4 && existsSync(mp4) && statSync(mp4).size > 50000, mp4 ? `${Math.round(statSync(mp4).size / 1024)} KB` : clip.stderr?.slice(0, 120));
  if (mp4) {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', mp4], { encoding: 'utf8' });
    const [w, h, n] = (probe.stdout || '').trim().split(',');
    check('encoded stream is 16:9 and complete', w === '640' && h === '360' && +n === 60, `${w}x${h} ${n} frames`);
  }
} catch (err) {
  check('smoke run completed', false, String(err.message ?? err).slice(0, 200));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (!argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — ' + failed.map((f) => f.name).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
