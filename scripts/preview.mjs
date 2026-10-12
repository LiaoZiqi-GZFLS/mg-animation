// Live preview: serve the project and open an on-screen browser window with audio + scrubbing.
//   node preview.mjs --project . [--port 5173] [--t 12.3] [--no-browser]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const project = resolve(flag('project', '.'));
if (!existsSync(join(project, 'index.html'))) {
  console.error(`Error: no index.html in ${project}`);
  process.exit(1);
}
const port = +(flag('port', 5173));
const t = flag('t', null);
const url = `${`http://127.0.0.1:${port}/index.html`}?preview=1${t ? `&t=${t}` : ''}`;
const { server } = await startServer({
  dir: project,
  kitFallback: existsSync(join(project, 'kit')) ? null : join(SKILL, 'assets', 'kit'),
  port,
});
console.log(`preview ${url}`);
console.log('keys: space play/pause · ←/→ 1s (shift 5s) · [ ] shot step · QC stills: node render.mjs --thumb shotId@t');
if (!argv.includes('--no-browser')) {
  const exes = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  const exe = exes.find((p) => existsSync(p));
  if (exe) spawn(exe, ['--app=' + url, '--start-maximized', '--user-data-dir=' + resolve(process.env.TEMP ?? '/tmp', 'mg-preview-profile')], { detached: true, stdio: 'ignore' }).unref();
  else console.log('no Edge/Chrome found — open the URL manually');
}
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
