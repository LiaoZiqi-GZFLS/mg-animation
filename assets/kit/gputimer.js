// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/gputimer.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications: none — the file is reproduced as published, with this header added.

/**
 * Wall-clock cost of the GPU's work, from the timer-query extension. Where the browser has no
 * extension (`ok` is false) the caller falls back to frame intervals, which measure the whole
 * pipeline rather than the part that ran on the GPU.
 */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.cur = null;
  }
  get ok() {
    return !!this.ext;
  }
  begin(tag) {
    if (!this.ext || this.cur) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.cur = { q, tag };
  }
  end() {
    if (!this.cur) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.cur);
    this.cur = null;
  }
  poll() {
    const gl = this.gl;
    const out = [];
    if (!this.ext) return out;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length && gl.getQueryParameter(this.pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, tag } = this.pending.shift();
      if (!disjoint) out.push({ ms: gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, tag });
      gl.deleteQuery(q);
    }
    while (this.pending.length > 8) this.gl.deleteQuery(this.pending.shift().q);
    return out;
  }
  reset() {
    this.pending = [];
    this.cur = null;
  }
}
