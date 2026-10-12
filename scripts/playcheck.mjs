// Live-playback check: does the preview player actually play, hold sync, adapt and stay out of the
// export path? Run it after touching kit/transport.js, kit/clock.js, kit/quality.js or kit/player.js.
//
//   node scripts/playcheck.mjs --project <film-dir> [--port 5211]
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
const project = resolve(flag('project', '.'));
const port = +flag('port', 5211);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(project, 'index.html'))) {
  console.error(`Error: no index.html in ${project}`);
  process.exit(1);
}
const { server } = await startServer({ dir: project, kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'), port });
const puppeteer = (await import(pathToFileURL(join(SKILL, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default;
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message ?? e)));

try {
  await page.goto(`http://127.0.0.1:${port}/index.html?preview=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 120000 });

  const boot = await page.evaluate(() => {
    const s = window.MG.transport.state();
    return { ready: window.MG.transport.ready, hasQuality: !!window.MG.quality, ...s };
  });
  check('preview boots on the transport', boot.ready && boot.hasQuality, `audio=${boot.audio} end=${boot.end?.toFixed(2)}s`);
  check('the song decoded for the clock', boot.audio === 'ready', boot.audio === 'ready' ? `${boot.end.toFixed(1)}s of audio leads the picture` : 'no audio file in this project');

  const seeked = await page.evaluate(() => {
    window.MG.transport.seek(12.3);
    return window.MG.transport.state().t;
  });
  check('seek lands where it is told', Math.abs(seeked - 12.3) < 1 / 30, `t=${seeked.toFixed(4)}`);

  // The picture follows what leaves the output, so it sits a constant output-latency behind the wall
  // clock. What must not happen is that gap growing: measure two intervals, not one.
  const play = await page.evaluate(async () => {
    const tr = window.MG.transport;
    tr.seek(4);
    await tr.play();
    await new Promise((r) => setTimeout(r, 1500));
    const a = tr.state().t;
    await new Promise((r) => setTimeout(r, 2000));
    const b = tr.state().t;
    tr.pause();
    return { a, b, playing: tr.playing, lag: 3.5 - (b - 4) };
  });
  check('the audio clock holds its rate (no accumulating drift)', Math.abs(play.b - play.a - 2) < 0.05, `two seconds of playback measured ${(play.b - play.a).toFixed(3)}s`);
  check('the picture trails the sound by a constant output latency', play.lag < 0.35, `${(play.lag * 1000).toFixed(0)} ms behind the wall clock`);
  check('pause stops the clock', !play.playing);

  const held = await page.evaluate(async () => {
    const tr = window.MG.transport;
    const a = tr.state().t;
    await new Promise((r) => setTimeout(r, 600));
    return Math.abs(tr.state().t - a);
  });
  check('a paused film does not move', held < 1 / 30, `moved ${held.toFixed(4)}s`);

  const slow = await page.evaluate(async () => {
    const tr = window.MG.transport;
    tr.seek(20);
    tr.setRate(0.25);
    await tr.play();
    await new Promise((r) => setTimeout(r, 1200));
    const t = tr.state().t;
    const rate = tr.rate;
    tr.pause();
    tr.setRate(1);
    return { dt: t - 20, rate };
  });
  check('quarter speed plays the picture silently', Math.abs(slow.dt - 0.3) < 0.25, `${slow.dt.toFixed(3)}s of film in 1.2s at ${slow.rate}x`);

  const locked = await page.evaluate(() => {
    const tr = window.MG.transport;
    tr.setPreset('360p');
    tr.seek(30);
    tr.draw(30);
    const h = tr.state().h;
    tr.setPreset('auto');
    tr.seek(40);
    tr.draw(40);
    return { locked: h, auto: tr.state().h };
  });
  check('the viewer can lock a height and let go again', locked.locked === 360 && locked.auto > 360, `locked ${locked.locked}p, auto ${locked.auto}p`);

  const bar = await page.evaluate(() => {
    const shots = window.MG.timeline.shots.length;
    const joins = window.MG.timeline.shots.slice(1).filter((s) => s.join).length; // the first shot enters from black
    document.querySelector('.mg-bar').classList.add('on');
    document.querySelector('.gear').click();
    document.querySelector('[data-q="540p"]').click();
    window.MG.transport.seek(30);
    window.MG.transport.draw(30);
    const locked = window.MG.transport.state().h;
    const key = Object.keys(localStorage).find((k) => k.endsWith('.player.q'));
    const stored = key ? localStorage.getItem(key) : null;
    document.querySelector('[data-q="auto"]').click();
    return { ticks: document.querySelectorAll('.mg-seek .secs i').length, marks: document.querySelectorAll('.mg-seek .secs u').length, shots, joins, locked, stored };
  });
  check('the bar carries the film cut list', bar.ticks === bar.shots && bar.marks === bar.joins, `${bar.ticks} shot ticks, ${bar.marks} join marks over ${bar.shots} shots`);
  await page.evaluate(() => {
    window.MG.transport.seek(64.2);
    document.querySelector('.mg-menu').hidden = true;
    document.querySelector('.mg-bar').classList.add('on');
  });
  await wait(400);
  const shot = join(project, 'build', 'qc', 'preview-bar.png');
  writeFileSync(shot, await page.screenshot({ type: 'png' }));
  console.log(`  wrote ${shot}`);
  check('a preset clicked in the menu changes what is drawn', bar.locked === 540, `clicked 540p, the canvas is ${bar.locked}p`);
  check('the choice is kept for the next visit', typeof bar.stored === 'string' && bar.stored.includes('540p'), String(bar.stored));

  const post = await page.evaluate(() => {
    const e = window.MG.engine;
    const gl = e.gl;
    const t = 6.3;
    const sample = () => {
      e.draw(t);
      const px = new Uint8Array(128 * 128 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(Math.floor(e.W / 2) - 64, Math.floor(e.H / 2) - 64, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
      return s / (px.length / 4) / 3;
    };
    e.postOverride = null;
    const withBloom = sample();
    e.postOverride = { bloom: 0 };
    const without = sample();
    e.postOverride = null;
    e.draw(t);
    return { withBloom, without };
  });
  check('a post switch takes the pass off the frame', post.withBloom > post.without * 1.02, `centre mean ${(post.withBloom / 255).toFixed(3)} with bloom, ${(post.without / 255).toFixed(3)} without`);

  const sim = await page.evaluate(() => window.MG.transport.simulate({ slow: 30, from: 0, to: 3 }));
  const adapted = sim.fps < 60 || Math.min(...sim.log.map((f) => f[2])) < sim.log[0][2];
  check('a slow device is simulated without waiting for one', sim.frames > 0 && sim.maxMs > 0 && Object.keys(sim.heights).length > 0, `${sim.frames} frames, worst ${sim.maxMs.toFixed(1)}ms, rungs ${Object.keys(sim.heights).join('/')}, ${sim.resizes} resizes`);
  check('a device that cannot hold the budget gives something up', adapted, `mean ${(sim.log.reduce((a, f) => a + f[1], 0) / sim.log.length).toFixed(1)}ms -> settled at ${sim.fps} fps over rungs ${Object.keys(sim.heights).join('/')}`);

  const rpage = await browser.newPage();
  await rpage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await rpage.goto(`http://127.0.0.1:${port}/index.html?render=1`, { waitUntil: 'load' });
  await rpage.waitForFunction('window.MG && document.body.dataset.ready === "1"', { timeout: 120000 });
  const isolated = await rpage.evaluate(() => ({ transport: !!window.MG.transport, audioContext: !!window.MG.transport, frame: window.MG.frameAt(30, 30) }));
  check('render mode never builds a player', !isolated.transport && isolated.frame.i === 30 && isolated.frame.errors === 0, `frameAt(30) drawn=${isolated.frame.drawn}`);
  await rpage.close();

  check('no page errors while playing', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('playcheck completed', false, String(e.message ?? e).slice(0, 160));
} finally {
  await browser.close();
  server.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
