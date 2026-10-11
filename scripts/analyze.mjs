#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BPM_MIN = 50, BPM_MAX = 200, NFFT = 1024, N_BANDS = 50, N_MEL = 16;

function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function parseArgs(argv) {
  const o = { input: null, out: path.join("analysis", "out"), bpm: null, fps: 60, sr: 48000, lrc: null, skipFeatures: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--bpm") o.bpm = Number(argv[++i]);
    else if (a === "--fps") o.fps = Number(argv[++i]);
    else if (a === "--sr") o.sr = Number(argv[++i]);
    else if (a === "--lrc") o.lrc = argv[++i];
    else if (a === "--skip-features") o.skipFeatures = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else if (!o.input) o.input = a;
    else fail(`unexpected argument ${a}`);
  }
  if (!o.input) fail("usage: node analyze.mjs <audio-file> [--out DIR] [--bpm N] [--fps 60] [--lrc FILE.lrc] [--skip-features]");
  if (!fs.existsSync(o.input)) fail(`input file not found: ${o.input}`);
  if (!(o.fps > 0)) o.fps = 60;
  if (!(o.sr > 0)) o.sr = 48000;
  if (o.bpm !== null && !(o.bpm > 0)) o.bpm = null;
  return o;
}

function decodePcm(input, sr) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", input, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", String(sr), "-"], { windowsHide: true });
    const chunks = [];
    let err = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "ffmpeg not found on PATH" : `failed to start ffmpeg: ${e.message}`)));
    p.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      const usable = buf.length - (buf.length % 4); // slice on 4-byte frames only; stragglers at chunk edges are already merged here
      if (usable < sr * 0.5 * 4) {
        const hint = err.split("\n").find((l) => l.trim()) || "";
        return reject(new Error(code !== 0 && usable === 0 ? `ffmpeg could not decode audio${hint ? ` (${hint.trim()})` : ""}` : "no audio stream or audio shorter than 0.5s"));
      }
      let fa = new Float32Array(buf.buffer, buf.byteOffset, usable / 4);
      if (buf.byteOffset % 4 !== 0) fa = Float32Array.from(fa);
      resolve(fa);
    });
  });
}

function createFft(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let k = 0; k < levels; k++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / n); sinT[i] = Math.sin((2 * Math.PI * i) / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cosT[k], s = -sinT[k];
          const tr = re[j + half] * c - im[j + half] * s;
          const ti = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

const movingMean = (a, w) => {
  const n = a.length, out = new Float64Array(n), half = Math.floor(w / 2);
  let sum = 0;
  for (let i = 0; i < Math.min(n, half); i++) sum += a[i];
  for (let i = 0; i < n; i++) {
    if (i - half - 1 >= 0) sum -= a[i - half - 1];
    if (i + half < n) sum += a[i + half];
    const cnt = Math.min(n - 1, i + half) - Math.max(0, i - half) + 1;
    out[i] = sum / cnt;
  }
  return out;
};

const median = (arr) => { const s = Float64Array.from(arr).sort(); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function logSpacedEdges(fmin, fmax, count) {
  const edges = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) edges[i] = fmin * Math.pow(fmax / fmin, i / count);
  return edges;
}
const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);

function buildMelFilters(nMels, fmin, fmax, binHz, nBins) {
  const lo = hzToMel(fmin), hi = hzToMel(fmax);
  const pts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) pts[i] = melToHz(lo + ((hi - lo) * i) / (nMels + 1));
  const filters = [];
  for (let m = 0; m < nMels; m++) {
    const a = pts[m] / binHz, b = pts[m + 1] / binHz, c = pts[m + 2] / binHz;
    const list = [];
    const b0 = Math.max(0, Math.floor(a)), b1 = Math.min(nBins - 1, Math.ceil(c));
    for (let k = b0; k <= b1; k++) {
      let w = 0;
      if (k >= a && k <= b && b > a) w = (k - a) / (b - a);
      else if (k > b && k <= c && c > b) w = (c - k) / (c - b);
      if (w > 0) list.push([k, w]);
    }
    filters.push(list);
  }
  return filters;
}

function runStft(x, sr, fps) {
  const hop = Math.max(1, Math.round(sr / fps));
  const half = NFFT >> 1;
  const nBins = half + 1;
  const frames = Math.max(1, Math.ceil(x.length / hop));
  const fft = createFft(NFFT);
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT); // periodic hann
  const binHz = sr / NFFT;

  const bandEdges = logSpacedEdges(30, Math.min(sr / 2, 16000), N_BANDS).map((f) => Math.max(1, Math.round(f / binHz)));
  for (let i = 1; i < bandEdges.length; i++) if (bandEdges[i] <= bandEdges[i - 1]) bandEdges[i] = bandEdges[i - 1] + 1;
  for (let i = bandEdges.length - 1; i > 0; i--) if (bandEdges[i] > nBins) bandEdges[i] = nBins;
  const melFilters = buildMelFilters(N_MEL, 30, Math.min(sr / 2, 16000), binHz, nBins);

  const rms = new Float64Array(frames), lowE = new Float64Array(frames), midE = new Float64Array(frames), highE = new Float64Array(frames);
  const centroid = new Float64Array(frames), flux = new Float64Array(frames);
  const mel = []; for (let m = 0; m < N_MEL; m++) mel.push(new Float64Array(frames));
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(nBins);
  const prevBand = new Float64Array(N_BANDS), curBand = new Float64Array(N_BANDS);

  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    let sumsq = 0;
    for (let i = 0; i < NFFT; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < x.length ? x[idx] : 0;
      sumsq += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumsq / NFFT);
    fft(re, im);
    for (let k = 0; k < nBins; k++) mag[k] = Math.hypot(re[k], im[k]);
    let wsum = 0, esum = 0;
    for (let k = 0; k < nBins; k++) { const hz = k * binHz; wsum += hz * mag[k]; esum += mag[k]; }
    centroid[f] = esum > 0 ? wsum / esum : 0;
    curBand.fill(0);
    for (let b = 0; b < N_BANDS; b++) {
      const b0 = Math.min(bandEdges[b], nBins - 1), b1 = Math.min(bandEdges[b + 1], nBins);
      let s = 0;
      for (let k = b0; k < b1; k++) s += Math.log1p(mag[k]);
      curBand[b] = s;
    }
    let fx = 0;
    for (let b = 0; b < N_BANDS; b++) { const d = curBand[b] - prevBand[b]; if (d > 0) fx += d; }
    flux[f] = f === 0 ? 0 : fx;
    prevBand.set(curBand);
    let lo = 0, mi = 0, hi2 = 0;
    for (let k = 0; k < nBins; k++) {
      const hz = k * binHz;
      if (hz >= 20 && hz < 160) lo += mag[k];
      else if (hz >= 160 && hz < 2000) mi += mag[k];
      else if (hz >= 2000 && hz <= 11000) hi2 += mag[k];
    }
    lowE[f] = lo; midE[f] = mi; highE[f] = hi2;
    for (let m = 0; m < N_MEL; m++) {
      let e = 0;
      for (const [k, w] of melFilters[m]) e += w * mag[k] * mag[k];
      mel[m][f] = Math.log1p(e);
    }
  }
  return { hop, frames, rms, lowE, midE, highE, centroid, flux, mel };
}

function buildOdf(flux, fps) {
  const smooth = movingMean(flux, 3);
  const trend = movingMean(smooth, Math.max(3, Math.round(fps * 2)));
  const odf = new Float64Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) odf[i] = Math.max(0, smooth[i] - trend[i]);
  return odf;
}

function autocorrTempo(odf, fps) {
  const minLag = Math.max(2, Math.ceil((60 / BPM_MAX) * fps));
  const maxLag = Math.floor((60 / BPM_MIN) * fps);
  const T = odf.length;
  const r = new Float64Array(maxLag + 1);
  if (T <= minLag + 2) return { lag: minLag, bpm: (60 * fps) / minLag, confidence: 0, minLag, maxLag, r };
  let mean = 0;
  for (const v of odf) mean += v;
  mean /= T;
  let varSum = 0;
  for (const v of odf) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / T);
  if (!(std > 1e-12)) return { lag: minLag, bpm: (60 * fps) / minLag, confidence: 0, minLag, maxLag, r };
  const d = new Float64Array(T);
  for (let i = 0; i < T; i++) d[i] = odf[i] - mean;
  let sumAll = 0, cntAll = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let t = 0; t + lag < T; t++) s += d[t] * d[t + lag];
    r[lag] = s / (T - lag);
    sumAll += r[lag]; cntAll++;
  }
  const meanR = sumAll / cntAll;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > r[bestLag]) bestLag = lag; // strict > keeps the shortest lag on ties (prefers faster tempo)
  while (bestLag % 2 === 0 && bestLag / 2 >= minLag && r[bestLag / 2] >= 0.9 * r[bestLag]) bestLag /= 2;
  let minR = Infinity, maxR = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) { if (r[lag] < minR) minR = r[lag]; if (r[lag] > maxR) maxR = r[lag]; }
  const confidence = maxR > minR ? clamp01((maxR - meanR) / (maxR - minR)) : 0;
  return { lag: bestLag, bpm: (60 * fps) / bestLag, confidence, minLag, maxLag, r };
}

function beatsFromForcedBpm(odf, fps, bpm) {
  const tau = Math.max(1, Math.round((60 * fps) / bpm));
  const T = odf.length;
  let bestPhase = 0, bestScore = -Infinity;
  for (let p = 0; p < tau; p++) {
    let s = 0;
    for (let t = p; t < T; t += tau) s += odf[t];
    if (s > bestScore) { bestScore = s; bestPhase = p; }
  }
  const beats = [];
  for (let t = bestPhase; t < T; t += tau) beats.push(t);
  return beats;
}

function beatsByDp(odf, fps, tau0) {
  const T = odf.length;
  const lo = Math.max(2, Math.round(tau0 * 0.75));
  const hi = Math.round(tau0 * 1.25);
  if (hi < lo || T <= lo) return [0];
  const D = hi - lo + 1;
  const PEN = 0.5;
  const dp = new Float64Array(T * D).fill(-Infinity);
  const bk = new Int32Array(T * D).fill(-1);
  for (let t = 0; t < T; t++) {
    for (let d = lo; d <= hi; d++) {
      const prev = t - d;
      if (prev < 0) { dp[t * D + (d - lo)] = odf[t]; continue; }
      let best = -Infinity, bestD = lo;
      for (let p = lo; p <= hi; p++) {
        const v = dp[prev * D + (p - lo)] - PEN * (d - p) * (d - p);
        if (v > best) { best = v; bestD = p; }
      }
      dp[t * D + (d - lo)] = odf[t] + best;
      bk[t * D + (d - lo)] = bestD;
    }
  }
  let bestT = 0, bestJ = 0, bestV = -Infinity;
  for (let t = Math.max(0, T - 2 * hi); t < T; t++) {
    for (let j = 0; j < D; j++) { const v = dp[t * D + j]; if (v > bestV) { bestV = v; bestT = t; bestJ = j; } }
  }
  const beats = [];
  let t = bestT, d = lo + bestJ;
  let guard = 0;
  while (t >= 0 && guard++ < T + 10) {
    beats.push(t);
    const pd = bk[t * D + (d - lo)];
    t -= d;
    if (pd < 0) break;
    d = pd;
  }
  return beats.reverse();
}

function snapBeats(beats, odf, fps) {
  const win = Math.max(1, Math.round(0.06 * fps)); // ±60 ms snap radius
  const T = odf.length;
  return beats.map((b) => {
    let best = b, bestV = -Infinity;
    for (let t = Math.max(0, b - win); t <= Math.min(T - 1, b + win); t++) {
      const isPeak = odf[t] >= (t > 0 ? odf[t - 1] : 0) && odf[t] >= (t < T - 1 ? odf[t + 1] : 0);
      if (isPeak && odf[t] > bestV) { bestV = odf[t]; best = t; }
    }
    return best;
  });
}

function constantGrid(snappedFrames, fps, T) {
  if (snappedFrames.length < 2) return snappedFrames.slice();
  const iois = [];
  for (let i = 1; i < snappedFrames.length; i++) iois.push(snappedFrames[i] - snappedFrames[i - 1]);
  iois.sort((a, b) => a - b);
  const beatLen = iois[Math.floor(iois.length / 2)] || 1;
  if (!(beatLen > 0)) return snappedFrames.slice();
  const first = snappedFrames[0];
  let phase = ((first % beatLen) + beatLen) % beatLen;
  const folded = snappedFrames.map((t) => { let p = t % beatLen; if (p - phase < -beatLen / 2) p += beatLen; else if (p - phase > beatLen / 2) p -= beatLen; return p; });
  folded.sort((a, b) => a - b);
  phase = ((folded[Math.floor(folded.length / 2)] % beatLen) + beatLen) % beatLen;
  const beats = [];
  for (let t = phase; t < T; t += beatLen) beats.push(t);
  return beats;
}

function findSections(rms, frames, hop, sr, fps) {
  const dur = (frames * hop) / sr;
  let medRms = median(rms);
  if (!(medRms > 0)) {
    const pos = [];
    for (const v of rms) if (v > 0) pos.push(v);
    medRms = pos.length ? median(pos) : 0;
  }
  const frameSec = hop / sr;
  if (!(medRms > 0)) return [{ id: "sec1", label: "full", start: 0, end: num(dur) }];
  const thr = 0.03 * medRms;
  const minGapFrames = Math.max(1, Math.round(0.35 / frameSec));
  const gaps = [];
  let run = -1;
  for (let i = 0; i < frames; i++) {
    const quiet = rms[i] < thr;
    if (quiet && run < 0) run = i;
    if ((!quiet || i === frames - 1) && run >= 0) {
      const end = quiet && i === frames - 1 ? i + 1 : i;
      if (end - run >= minGapFrames && !(run === 0 && end >= frames)) gaps.push([run, end]);
      run = -1;
    }
  }
  let chosen = gaps;
  if (gaps.length > 39) {
    const idx = gaps.map((g, i) => i).sort((a, b) => (gaps[b][1] - gaps[b][0]) - (gaps[a][1] - gaps[a][0])).slice(0, 39).sort((a, b) => gaps[a][0] - gaps[b][0]);
    chosen = idx.map((i) => gaps[i]);
  }
  const bounds = [];
  for (const [gs, ge] of chosen) bounds.push(((gs + ge) / 2) * frameSec);
  const raw = [];
  let prev = 0;
  for (const b of bounds) { if (b - prev > 0.05) raw.push([prev, b]); prev = b; }
  if (dur - prev > 0.05 || raw.length === 0) raw.push([prev, dur]);
  const sections = raw.filter(([s, e]) => e > s);
  if (sections.length === 0) return [{ id: "sec1", label: "full", start: 0, end: num(dur) }];
  let loudIdx = 0, loudV = -Infinity;
  sections.forEach(([s, e], i) => {
    let sum = 0, c = 0;
    for (let f = Math.floor(s / frameSec); f < Math.min(frames, Math.ceil(e / frameSec)); f++) { sum += rms[f]; c++; }
    const avg = c ? sum / c : 0;
    if (avg > loudV) { loudV = avg; loudIdx = i; }
  });
  return sections.map(([s, e], i) => ({
    id: `sec${i + 1}`,
    label: sections.length === 1 ? "full" : i === 0 ? "intro" : i === sections.length - 1 ? "outro" : i === loudIdx ? "chorus" : "verse",
    start: num(s), end: num(e),
  }));
}

function findOnsetPeaks(odf, lowE, midE, hop, sr) {
  const T = odf.length;
  let mean = 0; for (const v of odf) mean += v; mean /= Math.max(1, T);
  let vs = 0; for (const v of odf) vs += (v - mean) * (v - mean);
  const std = Math.sqrt(vs / Math.max(1, T));
  let maxV = 0; for (const v of odf) if (v > maxV) maxV = v;
  if (!(std > 1e-12) || !(maxV > 0)) return { all: [], low: [] };
  const thr = mean + 0.3 * std;
  const all = [], low = [];
  for (let t = 1; t < T - 1; t++) {
    if (odf[t] > odf[t - 1] && odf[t] >= odf[t + 1] && odf[t] > thr) {
      const strength = clamp01(odf[t] / maxV);
      const time = num((t * hop) / sr);
      all.push([num(time), strength]);
      if (midE[t] > 1e-9 && lowE[t] / midE[t] > 2) low.push([num(time), strength]);
    }
  }
  return { all, low };
}

function parseLrc(file, sections, duration) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const entries = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) {
      const frac = s[3] ? Number(("" + s[3]).padEnd(3, "0").slice(0, 3)) / 1000 : 0;
      const t = num(Number(s[1]) * 60 + Number(s[2]) + frac);
      const key = `${t.toFixed(3)}|${content}`;
      if (seen.has(key)) continue; // ignore duplicate timestamps gracefully
      seen.add(key);
      entries.push({ start: t, text: content });
    }
  }
  entries.sort((a, b) => a.start - b.start);
  const lines = entries.map((e, i) => {
    let end = i + 1 < entries.length ? entries[i + 1].start : duration;
    for (const s of sections) if (e.start >= s.start - 1e-6 && e.start < s.end) { end = Math.min(end, s.end); break; }
    if (end <= e.start) end = Math.min(duration, e.start + 0.001);
    const tokens = [];
    for (const w of e.text.split(/\s+/).filter(Boolean)) {
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(w)) for (const ch of w) tokens.push(ch);
      else tokens.push(w);
    }
    const n = Math.max(1, tokens.length);
    const words = tokens.map((tk, k) => ({ text: tk, start: num(e.start + ((end - e.start) * k) / n), end: num(e.start + ((end - e.start) * (k + 1)) / n) }));
    return { i, text: e.text, start: num(e.start), end: num(end), words };
  });
  return lines;
}

function normalizeChannels(channels, names, frames) {
  const stats = {};
  const out = new Float32Array(frames * names.length);
  for (let c = 0; c < names.length; c++) {
    const src = channels[c];
    const sorted = Float64Array.from(src).sort();
    const min = percentile(sorted, 0), p1 = percentile(sorted, 0.01), p99 = percentile(sorted, 0.99), max = percentile(sorted, 1);
    stats[names[c]] = { min: num(min), p1: num(p1), p99: num(p99), max: num(max) };
    const range = p99 - p1;
    for (let f = 0; f < frames; f++) {
      const v = range > 1e-12 ? clamp01((src[f] - p1) / range) : 0;
      out[f * names.length + c] = num(v);
    }
  }
  return { out, stats };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  return decodePcm(opt.input, opt.sr).then((x) => {
    fs.mkdirSync(opt.out, { recursive: true });
    const sr = opt.sr, fps = opt.fps, hop = Math.max(1, Math.round(sr / fps));
    const duration = num(x.length / sr);
    const st = runStft(x, sr, fps);
    const frames = st.frames;
    const odf = buildOdf(st.flux, fps);
    const onsetFeature = movingMean(odf, 3);

    const tempo = autocorrTempo(odf, fps);
    let bpmOut = num(tempo.bpm, 120), confOut = num(tempo.confidence), beatLen;
    let beatFrames;
    let variance = 0; { let m = 0; for (const v of odf) m += v; m /= Math.max(1, odf.length); for (const v of odf) variance += (v - m) * (v - m); variance /= Math.max(1, odf.length); }
    if (variance <= 1e-18 || !(bpmOut > 0)) {
      bpmOut = opt.bpm ?? 120; confOut = 0;
      beatLen = (60 / bpmOut) * fps;
      beatFrames = [];
      for (let t = 0; t < frames; t += beatLen) beatFrames.push(Math.round(t));
    } else if (opt.bpm) {
      bpmOut = opt.bpm;
      beatFrames = beatsFromForcedBpm(odf, fps, opt.bpm);
      beatLen = (60 / opt.bpm) * fps;
    } else {
      beatFrames = beatsByDp(odf, fps, tempo.lag);
      beatFrames = snapBeats(beatFrames, odf, fps);
      beatFrames = constantGrid(beatFrames, fps, frames);
      const iois = [];
      for (let i = 1; i < beatFrames.length; i++) iois.push(beatFrames[i] - beatFrames[i - 1]);
      beatLen = iois.length ? median(iois) : tempo.lag;
      if (!(beatLen > 0)) beatLen = tempo.lag;
      bpmOut = (60 * fps) / beatLen;
    }
    if (!beatFrames.length) { beatFrames = []; for (let t = 0; t < frames; t += Math.max(1, beatLen)) beatFrames.push(Math.round(t)); }
    const beats = beatFrames.map((f) => num((f * hop) / sr));
    const downIdx = (() => {
      let bestJ = 0, bestV = -Infinity;
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let i = j; i < beatFrames.length; i += 4) s += st.lowE[Math.min(frames - 1, beatFrames[i])];
        if (s > bestV) { bestV = s; bestJ = j; }
      }
      return bestJ;
    })();
    const downbeats = beats.filter((_, i) => i % 4 === downIdx);
    const secBeatLen = num(beatLen / fps);

    const { all: allOnsets, low: lowOnsets } = findOnsetPeaks(odf, st.lowE, st.midE, hop, sr);
    const sections = findSections(st.rms, frames, hop, sr, fps);
    const lines = opt.lrc ? parseLrc(opt.lrc, sections, duration) : [];

    const timing = {
      version: 1,
      source: path.basename(opt.input),
      tool: "analyze.mjs",
      audio: { sampleRate: sr, duration, channels: 1 },
      tempo: { bpm: num(bpmOut), beatLen: secBeatLen, confidence: num(clamp01(confOut)) },
      beats, downbeats, sections, lines,
      clockZero: 0,
    };
    fs.writeFileSync(path.join(opt.out, "timing.json"), JSON.stringify(timing, null, 2));
    fs.writeFileSync(path.join(opt.out, "onsets.json"), JSON.stringify({ all: allOnsets, low: lowOnsets, vocals: [] }, null, 2));

    let chCount = 0;
    if (!opt.skipFeatures) {
      const names = ["rms", "low", "mid", "high", "centroid", "flux", "onset"];
      const chans = [st.rms, st.lowE, st.midE, st.highE, st.centroid, st.flux, onsetFeature];
      for (let m = 0; m < N_MEL; m++) { names.push(`mel_${String(m).padStart(2, "0")}`); chans.push(st.mel[m]); }
      const { out, stats } = normalizeChannels(chans, names, frames);
      chCount = names.length;
      fs.writeFileSync(path.join(opt.out, "features.json"), JSON.stringify({
        fps, frames, duration,
        channels: names,
        layout: "little-endian float32, row-major [frames][channels]",
        normalization: "per-channel p1/p99 -> [0,1]",
        stats,
      }, null, 2));
      fs.writeFileSync(path.join(opt.out, "features.f32"), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    }

    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log([
      `analyze.mjs  ${path.basename(opt.input)}`,
      `  duration   ${duration.toFixed(2)} s @ ${sr} Hz mono`,
      `  tempo      ${bpmOut.toFixed(1)} bpm, beat ${secBeatLen.toFixed(3)} s, confidence ${clamp01(confOut).toFixed(2)}${opt.bpm ? " (forced)" : ""}`,
      `  beats      ${beats.length} (downbeats ${downbeats.length})`,
      `  sections   ${sections.length}, onsets ${allOnsets.length} (${lowOnsets.length} low/kick)`,
      opt.skipFeatures ? "  features   skipped (--skip-features)" : `  features   ${frames} frames x ${chCount} channels -> features.f32`,
      lines.length ? `  lrc        ${lines.length} lines` : null,
      `  out        ${path.resolve(opt.out)}  [${el}s]`,
    ].filter(Boolean).join("\n"));
  }).catch((e) => fail(e.message));
}

main();
