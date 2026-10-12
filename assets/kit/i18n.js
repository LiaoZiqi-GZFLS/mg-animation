// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/config.js` (the `makeText` half) at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications, relative to that commit:
//   1. Reads a film's `preview.text` from this kit's film.config.json instead of the reference
//      project's whole web.config.json, and ships a default wording so a film that says nothing
//      still gets a labelled interface.
//   2. The paragraph forms (`t.paras`, `t.list`) are dropped: the preview has no body text, only
//      button labels and one-line notices.

const DEFAULTS = {
  en: {
    playPause: 'play / pause',
    seek: 'seek',
    prevShot: 'previous shot',
    nextShot: 'next shot',
    frameStep: 'one frame back / forward: , and .',
    speed: 'speed',
    quality: 'quality',
    frameRate: 'frame rate',
    frameRateAuto: 'auto',
    fullscreen: 'fullscreen',
    hide: 'hide the bar (h)',
    errors: (n) => `${n} frame error${n === 1 ? '' : 's'}`,
    noticeContextLost: 'the graphics context was lost; reloading at a lower quality',
    noticeWatchdog: (o) => `frames over 150 ms: drawing at ${o?.height}p`,
    noticeAudio: (o) => `the song did not load (${o?.error}); the picture plays silently`,
    noticeFrameFailed: (o) => `a frame failed: ${o?.error}`,
    unsupported: 'this browser cannot run the preview',
    locked: 'locked',
    auto: 'auto',
    post: 'post chain',
    settings: 'settings',
  },
  zh: {
    playPause: '播放 / 暂停',
    seek: '进度',
    prevShot: '上一镜',
    nextShot: '下一镜',
    frameStep: '逐帧：, 和 .',
    speed: '倍速',
    quality: '画质',
    frameRate: '帧率',
    frameRateAuto: '自动',
    fullscreen: '全屏',
    hide: '隐藏控制条（h）',
    errors: (n) => `${n} 个帧错误`,
    noticeContextLost: 'WebGL 上下文丢失，正在以较低画质重新载入',
    noticeWatchdog: (o) => `有帧超过 150 ms，改画 ${o?.height}p`,
    noticeAudio: (o) => `音轨载入失败（${o?.error}），画面静默播放`,
    noticeFrameFailed: (o) => `某一帧渲染失败：${o?.error}`,
    unsupported: '此浏览器无法预览',
    locked: '已锁定',
    auto: '自动',
    post: '后处理',
    settings: '设置',
  },
};

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/**
 * The interface text of one film's preview. `t(key, vars)` gives the string in the configured language
 * (English where that language lacks the key) with {name} filled from vars; a function entry is called
 * with vars instead. A key nobody wrote comes back as itself and is reported once.
 * cfg: { lang, text: { en: {...}, zh: {...} } } — the film's `preview` block, merged over the defaults.
 */
export function makeText(cfg = {}, warn = console.warn) {
  const lang = cfg.lang ?? 'zh';
  const set = { ...DEFAULTS.en, ...(cfg.text?.en ?? {}), ...DEFAULTS[lang], ...(cfg.text?.[lang] ?? {}) };
  const said = new Set();
  const get = (key) => {
    if (set[key] == null && !said.has(key)) {
      said.add(key);
      warn(`preview.text: no '${key}' for '${lang}'`);
    }
    return set[key] ?? key;
  };
  const t = (key, vars) => {
    const s = get(key);
    if (typeof s === 'function') return s(vars);
    return typeof s === 'string' ? fill(s, vars) : String(s);
  };
  t.lang = lang;
  t.has = (key) => set[key] != null;
  return t;
}
