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
  server.close();
}
console.log(`\nframe-sink: ${n} checks passed`);
