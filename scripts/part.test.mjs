// A part must be a decodable mp4 with the right size, frame count and orientation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePart, partPath, partFrames } from './part.mjs';

let n = 0;
const ok = (what) => console.log(`  ok ${++n}  ${what}`);
const dir = mkdtempSync(join(tmpdir(), 'mg-part-'));
const W = 64, H = 48, frames = 3;
const p = partPath(dir, 7);
const { stdin, done } = encodePart({ path: p, W, H, targetW: W, targetH: H, fps: 30, frames, crf: 16, preset: 'veryfast' });
// GL rows are bottom-up: mark the LAST row of the buffer so vflip must bring it to the top.
const px = Buffer.alloc(W * H * 4);
for (let x = 0; x < W; x++) {
  const o = ((H - 1) * W + x) * 4;
  px[o] = 255;
  px[o + 3] = 255;
}
for (let i = 0; i < frames; i++) stdin.write(px);
stdin.end();
await done;
const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8' });
const [sw, sh, sf] = probe.stdout.trim().split(/\r?\n/).map(Number);
assert.equal(sw, W, `width ${sw}`);
assert.equal(sh, H, `height ${sh}`);
assert.equal(sf, frames, `three frames in, ${sf} out`);
// exact=1: without it this ffmpeg floors an odd crop to the chroma grid (1 -> 0) and crop errors out on yuv420p.
const corner = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'crop=1:1:0:0:exact=1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
// R measures 159-160: 4:2:0 chroma averages the single red row with the black row below it; unflipped it is 0.
assert.ok(corner.stdout[0] > 100, 'the bottom-up marker landed on the top row: vflip is applied');
ok('a part decodes at the right size and frame count');
ok('vflip corrects GL row order');
assert.equal(partFrames(0, 100, 10)[0], 100, 'part 0 starts at the first frame');
assert.equal(partFrames(0, 100, 10)[1], 109, 'an open-ended part is a full chunk');
assert.deepEqual(partFrames(2, 100, 10, 25), [120, 124], 'the last part is short, not empty');
ok('partFrames covers the range and clamps the tail');
rmSync(dir, { recursive: true, force: true });
console.log(`\npart: ${n} checks passed`);
