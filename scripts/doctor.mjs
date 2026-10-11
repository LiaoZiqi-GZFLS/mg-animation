// Environment check for the MG pipeline. Run this before the first render.
//   node doctor.mjs [--project DIR]
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.argv.slice(2).find((a) => a.startsWith('--project')) ? process.argv[process.argv.indexOf('--project') + 1] : '.');
const rows = [];
const ok = (k, v) => rows.push(['ok', k, v]);
const bad = (k, v, fix) => rows.push(['FAIL', k, v, fix]);

ok('node', process.version);

const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
ff.status === 0 ? ok('ffmpeg', ff.stdout.split('\n')[0].slice(0, 60)) : bad('ffmpeg', 'not on PATH', 'install ffmpeg and add it to PATH');

const browsers = [
  ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
];
const found = browsers.find(([, p]) => existsSync(p));
found ? ok(found[0], found[1]) : bad('browser', 'no Edge/Chrome', 'install Edge (usually present on Windows) or set MG_BROWSER');

const candidates = [join(project, 'node_modules', 'puppeteer-core'), join(SKILL, '..', 'node_modules', 'puppeteer-core')];
const ppc = candidates.find((p) => existsSync(p));
ppc ? ok('puppeteer-core', ppc) : bad('puppeteer-core', 'missing', `npm i puppeteer-core --prefix "${resolve(SKILL, '..')}"`);

for (const f of ['scripts/analyze.mjs', 'scripts/render.mjs', 'scripts/preview.mjs', 'assets/kit/engine.js', 'assets/template/src/film.js']) {
  existsSync(join(SKILL, f)) ? null : bad('skill file', `missing ${f}`, 'reinstall the skill');
}

if (existsSync(join(project, 'src', 'film.js'))) {
  ok('project', project);
  const has = existsSync(join(project, 'kit'));
  rows.push([has ? 'ok' : 'info', 'kit in project', has ? join(project, 'kit') : 'served from the skill (run new-project.mjs to copy it)']);
  const data = existsSync(join(project, 'analysis', 'out', 'timing.json'));
  rows.push([data ? 'ok' : 'info', 'audio analysis', data ? 'present' : 'absent — timing keys fall back to a uniform grid']);
} else {
  rows.push(['info', 'project', `${project} is not a film project — node scripts/new-project.mjs <dir>`]);
}

const w = Math.max(...rows.map((r) => r[1].length));
for (const [st, k, v, fix] of rows) console.log(`${st.padEnd(5)} ${k.padEnd(w)}  ${v ?? ''}${fix ? `\n      fix: ${fix}` : ''}`);
console.log(rows.some((r) => r[0] === 'FAIL') ? '\nsome checks failed' : '\nready: preview and export should work');
process.exit(rows.some((r) => r[0] === 'FAIL') ? 1 : 0);
