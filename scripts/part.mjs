// One part of an export: raw RGBA frames in on stdin, one x264 stream out. Parts are what make a
// long export resumable and parallel — each is a complete, independently decodable file.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const partPath = (dir, n) => join(dir, `part-${String(n).padStart(4, '0')}.mp4`);

/** The frame range part n covers, clamped to the last frame of the film. */
export const partFrames = (n, f0, chunk, total = Infinity) => [f0 + n * chunk, Math.min(f0 + (n + 1) * chunk - 1, f0 + total - 1)];

export function encodePart({ path, W, H, targetW, targetH, fps, frames, crf = 16, preset = 'slow' }) {
  const down = W !== targetW || H !== targetH;
  const vf = ['vflip', ...(down ? [`scale=${targetW}:${targetH}:flags=lanczos`] : [])].join(',');
  const ff = spawn(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(fps), '-i', '-',
      '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p', '-an', path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let err = '';
  ff.stderr.on('data', (d) => (err += d.toString()));
  const done = new Promise((ok, no) => {
    ff.on('error', no);
    ff.on('close', (code) => (code === 0 ? ok() : no(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`))));
  });
  return { stdin: ff.stdin, done };
}
