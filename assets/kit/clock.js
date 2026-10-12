// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/clock.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications: none — the file is reproduced as published, with this header added.

/**
 * The film's clock, told from the audio actually leaving the output: `now()` is where the song is,
 * so a stalled frame costs dropped pictures rather than drift.
 */
export class AudioClock {
  constructor(ac, buffer) {
    this.ac = ac;
    this.buffer = buffer;
    this.gain = ac.createGain();
    this.gain.connect(ac.destination);
    this.playing = false;
    this.t = 0;
  }
  _ctxNow() {
    const ts = this.ac.getOutputTimestamp?.();
    return ts && ts.contextTime > 0 ? ts.contextTime : this.ac.currentTime - (this.ac.outputLatency || 0);
  }
  now() {
    return this.playing ? Math.min(this.buffer.duration, this.t0 + (this._ctxNow() - this.c0)) : this.t;
  }
  play(t) {
    if (this.playing) this.pause();
    if (t >= this.buffer.duration) {
      this.t = this.buffer.duration;
      return;
    }
    const src = this.ac.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    this.c0 = this.ac.currentTime + 0.05;
    this.t0 = t;
    src.start(this.c0 + Math.max(0, -t), Math.max(0, t));
    this.src = src;
    this.playing = true;
  }
  pause() {
    if (!this.playing) return;
    this.t = this.now();
    this.src.stop();
    this.src.disconnect();
    this.playing = false;
  }
  seek(t) {
    if (this.playing) this.play(t);
    else this.t = t;
  }
  setVolume(v) {
    this.gain.gain.value = v;
  }
}
