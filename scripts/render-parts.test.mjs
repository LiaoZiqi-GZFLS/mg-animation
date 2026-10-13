// A streaming render must produce whole parts, in order, without touching the PNG path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);
const work = mkdtempSync(join(resolve(HERE, '..'), 'build-test-'));
const proj = join(work, 'film');
try {
  spawnSync(process.execPath, [join(HERE, 'new-project.mjs'), proj], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', proj, '--to', '1', '--fps', '30', '--chunk', '10', '--height', '270'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `render failed: ${(r.stderr || r.stdout).slice(-500)}`);
  const parts = readdirSync(join(proj, 'build', 'parts')).filter((f) => /^part-\d+\.mp4$/.test(f));
  assert.deepEqual(parts, ['part-0000.mp4', 'part-0001.mp4', 'part-0002.mp4'], `30 frames at chunk 10 (got ${parts})`);
  ok('a streaming render writes whole parts, in order');
  assert.equal(existsSync(join(proj, 'build', 'frames')), false, 'no PNG directory on the streaming path');
  ok('the streaming path leaves no PNG files behind');
  const counts = parts.map((f) => +spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', join(proj, 'build', 'parts', f)], { encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(counts, [10, 10, 10], `each part holds its own chunk (${counts})`);
  ok('each part holds exactly its chunk of frames');
  // A frame that fails persistently must end the run, not restart its part forever.
  const failing = join(work, 'failing');
  spawnSync(process.execPath, [join(HERE, 'new-project.mjs'), failing], { encoding: 'utf8' });
  const idx = join(failing, 'index.html');
  const inject = `<script>
    const patch = setInterval(() => {
      if (!window.MG) return;
      clearInterval(patch);
      const orig = window.MG.frameRaw.bind(window.MG);
      window.MG.frameRaw = (i, fps) => { if (i === 3) throw new Error('injected frame failure'); return orig(i, fps); };
    }, 10);
  </script>
</body>`;
  writeFileSync(idx, readFileSync(idx, 'utf8').replace('</body>', inject), 'utf8');
  const rf = spawnSync(process.execPath, [join(HERE, 'render.mjs'), '--project', failing, '--to', '1', '--fps', '30', '--chunk', '10', '--height', '270'], { encoding: 'utf8', timeout: 180000 });
  assert.equal(rf.status, 1, `a persistent frame failure must end the run: status ${rf.status}\n${(rf.stdout + rf.stderr).slice(-500)}`);
  assert.match(rf.stdout + rf.stderr, /frames failed/);
  ok('a persistent frame failure ends the run instead of looping forever');
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nrender-parts: ${n} checks passed`);
