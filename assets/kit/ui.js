// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/ui.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications, relative to that commit:
//   1. Built for the author rather than the viewer: the bar carries shot ticks and join marks, a
//      one-frame step, a speed row, the shot/join/progress readout, the measured frame rate, the
//      height the controller picked and a badge over the engine's frame errors. The reference
//      player's boot screen, warning modal, chapter colour bands, subtitle menu, cover art and
//      volume slider are not reproduced here.
//   2. Styles are injected by the kit, so a film project's index.html needs no markup for the bar.
//   3. The menu drives this kit's quality presets, frame-rate setting and post-chain override;
//      choices persist in localStorage under the film's own prefix.
import { PRESETS } from './quality.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2v12H7zM19 6l-9 6 9 6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M15 6h2v12h-2zM5 6l9 6-9 6z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l-2.2-.6a7 7 0 00-.6-1.5l1.1-2-1.7-1.7-2 1.1a7 7 0 00-1.5-.6L13.5 3h-3l-.6 2.2a7 7 0 00-1.5.6l-2-1.1-1.7 1.7 1.1 2a7 7 0 00-.6 1.5L3 12.7v0l2.2.6a7 7 0 00.6 1.5l-1.1 2 1.7 1.7 2-1.1a7 7 0 001.5.6l.6 2.2h3l.6-2.2a7 7 0 001.5-.6l2 1.1 1.7-1.7-1.1-2a7 7 0 00.6-1.5L21 12.7z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zM20 4v6h-2V6h-4V4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/></svg>',
};
const CSS = `
.mg-bar{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:8px 14px calc(8px + env(safe-area-inset-bottom));
  background:linear-gradient(transparent,rgba(6,8,11,.86) 32%);color:#dbe6ee;font:600 12px/1.2 Consolas,monospace;
  opacity:0;transition:opacity .22s;pointer-events:none;z-index:5}
.mg-bar.on{opacity:1;pointer-events:auto}
.mg-bar button{all:unset;display:inline-grid;place-items:center;width:26px;height:26px;border-radius:5px;color:#9fb2c0;cursor:pointer}
.mg-bar button:hover{background:#182028;color:#eef4f8}
.mg-bar button svg{width:16px;height:16px;fill:currentColor}
.mg-bar button.on{color:#7fd1ff}
.mg-bar .mg-speeds,.mg-bar .row{display:flex;gap:4px}
.mg-bar .mg-speeds button{width:auto;padding:0 7px;background:#141c23;font:600 11px/1 Consolas,monospace}
.mg-time{white-space:nowrap;color:#8fa2b0}
.mg-seek{position:relative;flex:1;height:26px;cursor:pointer;touch-action:none}
.mg-seek i{position:absolute;top:11px;height:3px;background:#243039;border-right:1px solid #0b0f13}
.mg-seek .fill{position:absolute;top:11px;left:0;height:3px;background:#3d5866}
.mg-seek b{position:absolute;top:8px;width:2px;height:9px;background:#7fd1ff;transform:translateX(-1px)}
.mg-seek u{position:absolute;top:15px;width:5px;height:5px;border-radius:50%;background:#ffb454;transform:translateX(-2.5px);text-decoration:none}
.mg-seek .tip{position:absolute;bottom:22px;transform:translateX(-50%);background:#0b0f13cc;padding:2px 6px;border-radius:4px;white-space:nowrap;opacity:0}
.mg-seek:hover .tip{opacity:1}
.mg-read{color:#8fa2b0;white-space:nowrap}
.mg-read em{color:#dbe6ee;font-style:normal}
.mg-badge{padding:2px 6px;border:1px solid #243039;border-radius:4px;color:#8fa2b0;white-space:nowrap}
.mg-badge.warn{border-color:#7a4a2a;color:#ffb454}
.mg-err{color:#ff6b6b;cursor:help;white-space:nowrap}
.mg-menu{position:absolute;right:14px;bottom:46px;display:grid;gap:4px;min-width:190px;padding:10px;background:#0b0f13f2;border:1px solid #243039;border-radius:8px}
.mg-menu[hidden]{display:none}
.mg-menu p{margin:6px 0 2px;color:#5d6b76;font:600 10px/1 system-ui;letter-spacing:.08em;text-transform:uppercase}
.mg-menu .row{display:flex;flex-wrap:wrap;gap:4px}
.mg-menu .row button{width:auto;padding:0 8px;background:#141c23}
.mg-menu .stat{color:#5d6b76;font:500 11px/1.4 Consolas,monospace;white-space:normal;margin-top:8px}
.mg-toast{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);padding:6px 12px;background:#0b0f13ee;border:1px solid #243039;border-radius:6px;color:#ffb454;opacity:0;transition:opacity .2s;pointer-events:none;z-index:6}
.mg-toast.on{opacity:1}
body[data-ui=hidden] .mg-bar,body[data-ui=hidden] .mg-toast{display:none}
`;

const POST_SWITCHES = [
  ['bloom', '辉光 bloom'],
  ['grain', '颗粒 grain'],
  ['scan', '扫描线 scan'],
  ['vignette', '暗角 vignette'],
  ['ca', '色散 CA'],
];

export class UI {
  constructor({ engine, timeline, t, design = { w: 16, h: 9 }, store = null }) {
    Object.assign(this, { e: engine, tl: timeline, t, design, store, p: null });
    if (!document.getElementById('mg-ui-style')) {
      const s = document.createElement('style');
      s.id = 'mg-ui-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = document.body;
    this.bar = this.root.appendChild(el('div', 'mg-bar'));
    this.toast = this.root.appendChild(el('div', 'mg-toast'));
  }
  /** The transport exists only after the player was built, and the bar reads it while being built. */
  attach(player) {
    this.p = player;
    this.buildBar();
    // The bar carries the timecode, the shot and the frame rate; the plain status line underneath it
    // would only collide.
    const status = document.getElementById('status');
    if (status) status.style.display = 'none';
    this.poke();
    addEventListener('keydown', (e) => this.onKey(e));
    for (const ev of ['pointermove', 'pointerdown']) addEventListener(ev, () => this.poke(), { passive: true });
    return this;
  }
  /** The bar wakes for input and fades out again when the author stops reaching for it. */
  poke() {
    this.bar.classList.add('on');
    clearTimeout(this.hider);
    this.hider = setTimeout(() => this.bar.classList.remove('on'), 2600);
  }
  buildBar() {
    const b = this.bar;
    b.innerHTML = `
      <button class="pp" aria-label="${esc(this.t('playPause'))}">${ICON.play}</button>
      <button class="prev" aria-label="${esc(this.t('prevShot'))}">${ICON.prev}</button>
      <button class="next" aria-label="${esc(this.t('nextShot'))}">${ICON.next}</button>
      <span class="mg-speeds row"></span>
      <span class="mg-time">0:00.0 / ${fmt(this.p.end)}</span>
      <div class="mg-seek" role="slider" aria-label="${esc(this.t('seek'))}"><div class="secs"></div><div class="fill"></div><div class="tip"></div><b></b></div>
      <span class="mg-read"></span>
      <span class="mg-h mg-badge"></span>
      <span class="mg-fps mg-badge"></span>
      <span class="mg-err"></span>
      <button class="gear" aria-label="${esc(this.t('settings'))}">${ICON.gear}</button>
      ${document.fullscreenEnabled ? `<button class="fs" aria-label="${esc(this.t('fullscreen'))}">${ICON.fs}</button>` : ''}
      <div class="mg-menu" hidden></div>`;
    const $ = (q) => b.querySelector(q);
    this.$pp = $('.pp');
    this.$seek = $('.mg-seek');
    this.$read = $('.mg-read');
    const speeds = $('.mg-speeds');
    for (const r of [0.25, 0.5, 1, 2]) {
      const btn = el('button', r === 1 ? 'on' : '');
      btn.textContent = `${r}x`;
      btn.title = `${this.t('speed')} ${r}`;
      btn.onclick = () => {
        this.p.setRate(r);
        for (const s of speeds.children) s.classList.toggle('on', s === btn);
        this.poke();
      };
      speeds.appendChild(btn);
    }
    $('.pp').onclick = () => this.p.toggle();
    $('.prev').onclick = () => this.stepShot(-1);
    $('.next').onclick = () => this.stepShot(1);
    $('.gear').onclick = (ev) => {
      ev.stopPropagation();
      this.menu(this.menuOpen ? false : !this.menuOpen);
    };
    $('.fs')?.addEventListener('click', () => this.fullscreen());
    document.addEventListener('pointerdown', (ev) => {
      if (this.menuOpen && !b.contains(ev.target)) this.menu(false);
    });
    this.buildTicks();
    const at = (ev) => {
      const r = this.$seek.getBoundingClientRect();
      return Math.min(this.p.end, Math.max(0, ((ev.clientX - r.left) / r.width) * (this.p.end - this.p.start) + this.p.start));
    };
    this.$seek.addEventListener('pointerdown', (ev) => {
      this.$seek.setPointerCapture(ev.pointerId);
      this.dragging = true;
      this.p.scrub(true);
      this.last = at(ev);
      this.p.seek(this.last);
    });
    this.$seek.addEventListener('pointermove', (ev) => {
      const time = at(ev);
      const sel = this.e.timeline.at(time);
      this.$seek.querySelector('.tip').textContent = `${fmt(time)} · ${sel.b ? `${sel.a.id} → ${sel.b.id}` : sel.a.id}`;
      this.$seek.querySelector('.tip').style.left = `${(time / this.p.end) * 100}%`;
      if (this.dragging) {
        this.last = time;
        this.p.seek(time);
      }
    });
    const release = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.p.scrub(false);
      this.p.seek(this.last);
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.$seek.addEventListener(ev, release);
  }
  /** One tick per shot, and a mark where a join begins: the film's cut list, on the bar. */
  buildTicks() {
    const secs = this.$seek.querySelector('.secs');
    secs.innerHTML = '';
    const span = this.p.end - this.p.start || 1;
    const X = (t) => ((t - this.p.start) / span) * 100;
    for (const s of this.tl.shots) {
      const i = el('i');
      i.style.left = `${X(s.start)}%`;
      i.style.width = `${Math.max(0.15, X(s.end) - X(s.start))}%`;
      i.title = s.id;
      secs.appendChild(i);
      const prev = this.tl.shots[this.tl.shots.indexOf(s) - 1];
      if (s.join && s.start > this.p.start) {
        const win = Math.min(s.join.dur ?? 0.25, s.start - (prev?.start ?? s.start));
        const u = el('u');
        u.style.left = `${X(s.start - win)}%`;
        u.title = `${s.id} ${s.join.type}`;
        secs.appendChild(u);
      }
    }
  }
  menu(open) {
    this.menuOpen = open;
    const m = this.bar.querySelector('.mg-menu');
    m.hidden = !open;
    if (!open) return;
    const s = this.p.state();
    m.innerHTML = `
      <p>${esc(this.t('quality'))}</p>
      <div class="row">${PRESETS.map((p) => `<button data-q="${p}" class="${p === s.preset ? 'on' : ''}">${p === 'auto' ? esc(this.t('auto')) : p}</button>`).join('')}</div>
      <p>${esc(this.t('frameRate'))}</p>
      <div class="row">${['auto', 30, 60].map((f) => `<button data-f="${f}" class="${String(f) === String(s.fpsSetting) ? 'on' : ''}">${f === 'auto' ? esc(this.t('frameRateAuto')) : f}</button>`).join('')}</div>
      <p>${esc(this.t('post'))}</p>
      <div class="row">${POST_SWITCHES.map(([k, label]) => `<button data-p="${k}" class="${!(this.e.postOverride?.[k] === 0) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>
      <p class="stat">${esc(this.t('frameStep'))}</p>`;
    m.querySelectorAll('[data-q]').forEach((btn) => {
      btn.onclick = () => {
        this.p.setPreset(btn.dataset.q);
        this.menu(true);
      };
    });
    m.querySelectorAll('[data-f]').forEach((btn) => {
      btn.onclick = () => {
        this.p.setFps(btn.dataset.f === 'auto' ? 'auto' : +btn.dataset.f);
        this.menu(true);
      };
    });
    m.querySelectorAll('[data-p]').forEach((btn) => {
      btn.onclick = () => {
        const k = btn.dataset.p;
        const cur = this.e.postOverride ?? (this.e.postOverride = {});
        const off = cur[k] === 0;
        cur[k] = off ? undefined : 0;
        if (off) delete cur[k];
        btn.classList.toggle('on', off);
        this.p.dirty = true;
      };
    });
  }
  stepShot(dir) {
    const cur = this.e.timeline.shotAt(this.p.t);
    const i = Math.max(0, Math.min(this.tl.shots.length - 1, this.tl.shots.indexOf(cur) + dir));
    this.p.seek(this.tl.shots[i].start + 1 / 30);
  }
  onKey(e) {
    if (e.target?.closest?.('.mg-menu')) return;
    const t = this.p.t;
    const fps = this.p.q.fps;
    if (e.code === 'Space') {
      e.preventDefault();
      this.p.toggle();
    } else if (e.code === 'ArrowRight') this.p.seek(t + (e.shiftKey ? 5 : 1));
    else if (e.code === 'ArrowLeft') this.p.seek(t - (e.shiftKey ? 5 : 1));
    else if (e.key === ']') this.stepShot(1);
    else if (e.key === '[') this.stepShot(-1);
    else if (e.key === ',') this.p.seek(t - 1 / fps);
    else if (e.key === '.') this.p.seek(t + 1 / fps);
    else if (e.key === 'q') this.p.setPreset(this.p.q.preset === 'auto' ? `${this.e.H}p` : 'auto');
    else if (e.key === 'h') document.body.dataset.ui = document.body.dataset.ui === 'hidden' ? '' : 'hidden';
    else if (e.key === 'f') this.fullscreen();
    else return;
    this.poke();
  }
  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  /** Called by the transport for every drawn frame. */
  update(s) {
    this.$pp.innerHTML = s.playing ? ICON.pause : ICON.play;
    this.bar.querySelector('.mg-time').textContent = `${fmt(s.t)} / ${fmt(s.end)}`;
    this.bar.querySelector('.fill').style.width = `${(s.t / (s.end || 1)) * 100}%`;
    this.$seek.querySelector('b').style.left = `${(s.t / (s.end || 1)) * 100}%`;
    this.$read.innerHTML = s.next
      ? `<em>${esc(s.shot)}</em> → ${esc(s.next)} <em>${esc(s.join ?? 'join')}</em> p=${s.p.toFixed(2)}`
      : `<em>${esc(s.shot)}</em> lt=${(s.t - (this.tl.byId.get(s.shot)?.start ?? s.t)).toFixed(2)}`;
    const h = this.bar.querySelector('.mg-h');
    h.textContent = `${s.h}p ${s.preset === 'auto' ? this.t('auto') : this.t('locked')}`;
    h.classList.toggle('warn', s.h < this.design.h);
    this.bar.querySelector('.mg-fps').textContent = `${s.measuredFps ? s.measuredFps.toFixed(0) : '—'} / ${s.fps} fps`;
    this.bar.querySelector('.mg-err').textContent = s.errors ? `⚠ ${this.t('errors', { n: s.errors })}` : '';
    if (s.errors && !this.errShown) {
      this.errShown = true;
      this.notice(this.e.errors.at(-1) ?? 'frame error');
    }
    if (!s.errors) this.errShown = false;
  }
  notice(text, o) {
    this.toast.textContent = this.t.has?.(text) ? this.t(text, o) : String(text);
    this.toast.classList.add('on');
    clearTimeout(this.toaster);
    this.toaster = setTimeout(() => this.toast.classList.remove('on'), 3600);
  }
  progress(kind, p) {
    if (p < 1) this.notice(`${kind} ${Math.round(p * 100)}%`);
  }
  ended() {
    this.poke();
  }
  unsupported(key) {
    this.notice(this.t(key ?? 'unsupported'));
  }
}

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};
