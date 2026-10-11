#!/usr/bin/env node
// Committed smoke test for analyze.mjs: synthesises a 12 s 120-BPM WAV, runs the analyzer, asserts beat accuracy.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SR = 48000, FPS = 60, DUR = 10, GAP_START = 10, BPM = 120;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function synth() {
  const n = Math.floor((GAP_START + 2) * SR);
  const x = new Float64Array(n);
  const beat = 60 / BPM;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x3fffffff) - 1; };
  for (let k = 0; k * beat < GAP_START; k++) {
    const t0 = Math.round(k * beat * SR);
    for (let i = 0; i < Math.min(t0 + Math.floor(0.15 * SR), n) - t0; i++) {
      const s = t0 + i;
      if (s >= GAP_START * SR) break;
      const env = Math.exp(-i / (SR * 0.035));
      const attack = i < 0.004 * SR ? 0.6 * rnd() : 0;
      x[s] += 0.9 * env * Math.sin(2 * Math.PI * 62 * i / SR) + attack * env; // 60 Hz kick + broadband click attack
    }
  }
  for (let k = 0; k * beat + beat / 2 < GAP_START; k++) {
    const t0 = Math.round((k * beat + beat / 2) * SR);
    for (let i = 0; i < Math.floor(0.06 * SR) && t0 + i < n; i++) {
      const s = t0 + i;
      if (s >= GAP_START * SR) break;
      x[s] += 0.25 * Math.exp(-i / (SR * 0.012)) * rnd(); // hi-hat noise burst on the off-beat
    }
  }
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    data.writeInt16LE(Math.round(v * 32767 * 0.85), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-selftest-"));
const wav = path.join(tmp, "test120.wav");
fs.writeFileSync(wav, synth());
const out = path.join(tmp, "out");

const started = process.hrtime.bigint();
const run = spawnSync(process.execPath, [path.join(__dirname, "analyze.mjs"), wav, "--out", out, "--fps", String(FPS)], { encoding: "utf8" });
const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
if (run.stdout) process.stdout.write(run.stdout);
if (run.status !== 0) {
  console.error(`analyze.mjs exited ${run.status}: ${run.stderr}`);
  process.exit(1);
}

const timing = JSON.parse(fs.readFileSync(path.join(out, "timing.json"), "utf8"));
const features = JSON.parse(fs.readFileSync(path.join(out, "features.json"), "utf8"));
const f32 = fs.readFileSync(path.join(out, "features.f32"));

check(`bpm within 2% of ${BPM}`, Math.abs(timing.tempo.bpm - BPM) / BPM < 0.02, `detected ${timing.tempo.bpm.toFixed(2)} bpm`);
check("beats[] count >= 20", timing.beats.length >= 20, `${timing.beats.length} beats`);

let maxErrMs = 0;
const trueBeats = [];
for (let t = 0; t < DUR - 1e-9; t += 60 / BPM) trueBeats.push(t);
for (const tb of trueBeats) {
  let best = Infinity;
  for (const db of timing.beats) best = Math.min(best, Math.abs(db - tb));
  maxErrMs = Math.max(maxErrMs, best * 1000);
}
check("every true beat matched within 25 ms", maxErrMs <= 25, `max error ${maxErrMs.toFixed(1)} ms over ${trueBeats.length} true beats`);
check("tempo confidence > 0.3", timing.tempo.confidence > 0.3, `confidence ${timing.tempo.confidence.toFixed(3)}`);
check("features.f32 size == frames*channels*4", f32.length === features.frames * features.channels.length * 4, `${f32.length} bytes, ${features.frames}x${features.channels.length}`);

const chNames = features.channels;
const onsetIdx = chNames.indexOf("onset");
const rmsIdx = chNames.indexOf("rms");
const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
const frames = features.frames, nch = chNames.length;
const onsetCol = new Float64Array(frames), rmsCol = new Float64Array(frames);
for (let f = 0; f < frames; f++) { onsetCol[f] = view.getFloat32((f * nch + onsetIdx) * 4, true); rmsCol[f] = view.getFloat32((f * nch + rmsIdx) * 4, true); }

const ind = new Float64Array(frames);
for (const tb of trueBeats) { const f = Math.round(tb * FPS); for (let d = -1; d <= 1; d++) if (f + d >= 0 && f + d < frames) ind[f + d] = 1; } // click time ±1 frame (STFT window quantisation)
const pearson = (a, b) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; saa += da * da; sbb += db * db; sab += da * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};
const corr = pearson(onsetCol, ind);
check("onset channel correlates with kick times > 0.6", corr > 0.6, `pearson r = ${corr.toFixed(3)}`);

let rmsAtK = 0, nK = 0, rmsOther = 0, nO = 0;
for (let f = 0; f < Math.min(frames, GAP_START * FPS); f++) {
  const near = trueBeats.some((tb) => Math.abs(f / FPS - tb) < 0.03);
  if (near) { rmsAtK += rmsCol[f]; nK++; } else { rmsOther += rmsCol[f]; nO++; }
}
const ratio = nK && nO ? (rmsAtK / nK) / (rmsOther / nO) : 0;
check("rms rises at kick frames", ratio > 1.2, `mean normalised rms kick/other = ${(rmsAtK / Math.max(1, nK)).toFixed(3)}/${(rmsOther / Math.max(1, nO)).toFixed(3)}`);

const noNaN = ["bpm", "beatLen", "confidence"].every((k) => Number.isFinite(timing.tempo[k])) && timing.beats.every(Number.isFinite);
check("no NaN in timing.json", noNaN);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`runtime for 12 s track: ${(runtimeMs / 1000).toFixed(2)} s`);
if (failures) { console.error(`${failures} assertion(s) failed`); process.exit(1); }
