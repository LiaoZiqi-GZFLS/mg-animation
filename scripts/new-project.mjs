// Scaffold a film project: template + a copy of the kit, so the project runs standalone.
//   node new-project.mjs <dir> [--name "My film"] [--kit]
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node new-project.mjs <dir> [--name "My film"]');
  process.exit(1);
}
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = resolve(target);
if (existsSync(join(dir, 'src', 'film.js')) && !argv.includes('--force')) {
  console.error(`Error: ${dir} already has src/film.js (pass --force to overwrite the template files)`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
cpSync(join(SKILL, 'assets', 'template'), dir, { recursive: true, force: true });
cpSync(join(SKILL, 'assets', 'kit'), join(dir, 'kit'), { recursive: true, force: true });
mkdirSync(join(dir, 'analysis', 'out'), { recursive: true });
mkdirSync(join(dir, 'build'), { recursive: true });
const name = flag('name', 'My MG film');
writeFileSync(
  join(dir, 'film.config.json'),
  JSON.stringify(
    {
      title: name,
      design: { w: 1920, h: 1080 },
      renderFps: 30,
      supersample: 1.5,
      audio: null,
      lrc: null,
    },
    null,
    2
  ) + '\n',
  'utf8'
);
const idx = readFileSync(join(dir, 'index.html'), 'utf8').replace('<title>MG film</title>', `<title>${name}</title>`);
writeFileSync(join(dir, 'index.html'), idx, 'utf8');
console.log(`created ${dir}
  index.html          preview shell (loads kit/player.js)
  src/film.js         5 example shots — one per family
  kit/                the engine (copy it or edit in place)
  film.config.json    title, fps, audio path
  analysis/out/       put analyze.mjs output here

next:
  node ${join(SKILL, 'scripts', 'preview.mjs')} --project .
  node ${join(SKILL, 'scripts', 'render.mjs')} --project . --to 14.2`);
