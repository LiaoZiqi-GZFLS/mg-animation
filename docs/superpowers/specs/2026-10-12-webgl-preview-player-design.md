# 本地实时预览播放器（从 world-execute-web 移植）

日期：2026-10-12 · 状态：待实施
上游：`third_party/world-execute-web` @ `29aefca50e40c14498420e1c6e1f3a1037727e17`（AGPL-3.0-or-later）

## 目标

技能现在只有"能动的预览"：`assets/kit/player.js` 用 `<Audio>.currentTime` 跟帧，rAF 每帧都画，
分辨率固定。三个后果——长片音画会漂、GPU 跟不上时整片变慢而不是掉帧、弱机预览只能手动 `?q=`。

本设计把上游 `src/player/` 的播放系统搬进来，让本地预览成为**满帧、不漂、自动降质、可逐镜调**的放映页，
同时导出路径（`?render=1` + `MG.frameAt`）逐字节不变。

## 范围

上游 `src/player/` 有 12 个文件。移植其中 9 个 + `src/subs/` 的 3 个数据模块；`main.js` 只作装配顺序的参考
（落到我们的 `kit/player.js`）；跳过 `vault.js` 与 `cost.json.js` 的数字。改我们自己的 3 个文件。

| 上游 | 到 | 关系 |
|---|---|---|
| `player/clock.js` (49) | `kit/clock.js` | 原样 |
| `player/pace.js` (7) | `kit/pace.js` | 原样 |
| `player/gputimer.js` (48) | `kit/gputimer.js` | 原样 |
| `player/quality.js` (233) | `kit/quality.js` | 衍生：`cost` 可为 null（无表时全用 `default` 行），`sizeFor` 按我们的设计比例 |
| `player/player.js` (369) | `kit/transport.js` | 衍生：去章节/运动模糊，接我们的 Engine+Timeline |
| `player/pick.js` (62) | `kit/quality.js` 内 `pickCalibration()` | 衍生：镜头 id 而非 `edit/name` |
| `player/ui.js` (466) | `kit/ui.js` | 衍生：作者向控制条 + 设置抽屉 |
| `player/config.js` 的 `makeText/t` | `kit/i18n.js` | 衍生：键位来自 `film.config.json.preview.text` |
| `player/subs.js` (59) + `src/subs/{schedule,style,rules}.js` (205) | `kit/subs.js` | 衍生：三合一，数据来自 `subs/<lang>.json`，渲染走我们的 `TextCanvas` |
| — | `scripts/calibrate.mjs` | 新增（我们自己的）：产出 `analysis/cost.json` |
| `assets/kit/player.js` | 同名 | 改：变成组装根 |
| `scripts/preview.mjs` | 同名 | 改：起页参数 + 快捷键说明 |
| `assets/template/index.html` | 同名 | 改：加 `#ui` 容器与样式 |

**不移植 `player/vault.js`。** 它是上游内容加密的客户端半边：向**他们的**密钥服务 POST ECDH 公钥、
unwrap AES-GCM 密钥、分片解密**他们服务器上**的 AAC。没有对应服务端它永远跑不通；唯一"跑得通"的用法
是取那首受版权的歌，那是绕过访问控制，AGPL 不授予。替代：预览直接 `fetch` 本地 `audio/track.mp3`
→ `decodeAudioData`。

**不移植 `player/cost.json.js` 的数据。** 它是上游那部片在 `Apple M5 · Chrome/154.0.8037.95` 上实测的
每镜头 `[固定ms, ms/百万像素]` 表。搬数字无意义，搬机制（`calibrate.mjs`）才有价值。

## 架构

```
index.html ─ kit/player.js (boot, 组装根)
                ├─ kit/clock.js      AudioClock      —— 时间唯一来源
                ├─ kit/pace.js       due/advance     —— vsync 节拍
                ├─ kit/gputimer.js   GpuTimer        —— 真实 GPU 耗时
                ├─ kit/quality.js    Quality + pickCalibration
                │                      ▲ 读 analysis/cost.json（可选）
                ├─ kit/transport.js  Transport      —— prepare/tick/play/pause/seek/simulate
                ├─ kit/ui.js         UI              —— 控制条、设置抽屉、错误红点
                ├─ kit/i18n.js       t()             —— zh/en 文案
                └─ kit/subs.js       Subtitles       —— ?subs=<lang> 时接管字幕
```

依赖单向：`transport` 拥有 `clock/pace/gputimer/quality`，`ui` 只读 `transport.state()` 并回调；
`player.js` 只做装配和 `window.MG` 门面。任何模块都不 import `player.js`。

## 关键接口

```js
new Transport({ engine, quality, ui, canvas, audioUrl })
  .prepare({ onProgress })   // 并行：prewarm 着色器 ‖ fetch+decode 音频；然后 calibrate 采样
  .play() .pause() .toggle() .seek(t) .scrub(on) .setVolume(v)
  .setPreset('auto'|'360p'…'4k') .setFps('auto'|30|60)
  .state() -> { t, playing, w, h, fps, measuredFps, preset, shot, start, end }
  .simulate({ slow, from, to, timer }) -> { frames, over2x, over150, maxMs, resizes, heights, at60, log }

new Quality({ cost, preset, fps, maxH, design })   // cost=null -> 纯反馈
  .onSelection(ids) -> h    .onFrame(ms, { ids, h, exact }) -> { height, reason } | null
  .learn(ms, …)  .guard(ms)  .calibrate(samples)  .restart()  .pick(ids, B)  .speed()  .scale

startOptions(q, { saved, presets, poster }) -> { preset, fps, t, resume }   // URL > localStorage > 默认
store / session                                                            // 带 try/catch 的两个 storage 门面
```

`MG` 门面新增 `MG.transport`、`MG.quality`、`MG.ui`、`MG.subs`；
`MG.info/draw/frameAt/prewarm/exportMode/play/pause/seek` 签名与语义**不变**（`play/pause/seek` 内部改走 Transport）。

## 行为决策

1. **时间只从 AudioClock 读**（`getOutputTimestamp()` 取已出声时刻），不累加 dt → 140 s 不漂。
2. **未到 vsync 的帧跳过**，不补画 → 掉帧时音画仍同步（现状：整片变慢）。
3. **自动降质只改渲染高度**，布局与后处理链完全一致 → 所见即所出，只是更糊。`?q=1080` 或档位 chip 锁定。
4. **WebGL 上下文丢失**：`webglcontextlost` → 记 `session.lost`，降一档带 `?t=…&resume` 重载；连续 3 次报"此设备不支持"。
5. **页面隐藏**（`visibilitychange`）自动暂停。
6. **自动帧率**：有 cost 表时按"1080p 是否进 60 fps 预算"一次定 60/30；某镜头 60 fps 会压到 720p 以下时，
   降 30 换两档以上分辨率。无表时固定 60 目标 + EMERGENCY 降级。
7. **字幕**：默认仍走 `.lrc`（`craft.drawLyrics`）；`?subs=zh` 且有 `subs/zh.json` 时由 `kit/subs.js` 接管。
8. **音频起播**受浏览器自动播放策略限制：首次点击/按键才 `ac.resume()`；在那之前画面停在 `?t` 指定帧。

## 导出不变量（必须守住）

- `?render=1`：不建 AudioContext、不建 UI、不接 Quality —— `MG.frameAt(i, fps)` 仍是唯一入口，
  尺寸由 `exportMode(W, H)` 定死。
- 证据：实施前把模板片 3 帧（第 0/210/419 帧）sha256 记入 `build/export-baseline.json`，
  每个切片完成后重渲比对，不一致即视为回归。
- `render.mjs` 不改动。

## 测试

| 切片 | 断言（进 `scripts/smoke.mjs`） |
|---|---|
| ① 内核 | `seek(12.3)` 后 `transport.state().t` 误差 < 1/30 s；`due/advance` 单测（跳帧不追帧）；无 `EXT_disjoint_timer_query_webgl2` 时 `GpuTimer.ok === false` 且回落到 CPU 计时 |
| ② 成本 | `calibrate.mjs` 在模板片产出 5 行 `cost.json`；`Quality.predict` 对未参与拟合的镜头误差 < 20%；`simulate({slow:3})` 报告 `heights` 随负载下降、`resizes` 有界 |
| ③ UI | 控制条存在且点击生效；`store` 往返（q/fps/lang）；`t()` 缺键回落到键名且只警告一次；`?render=1` 时 `#ui` 不存在 |
| ④ 字幕 | `?subs=zh` 画出一行且 `subtitleAt` 的 skip/silent/accent 三条规则各自命中 |
| 回归 | 原 15 项全过；导出基线逐字节一致 |

人工验收：`node scripts/preview.mjs --project mg-showcase` 用浏览器实开，截图看控制条，
并验证 seek 落点与 `render.mjs --thumb <id>@<t>` 同帧。

## 许可与署名

每个移植/衍生文件顶部：

```
// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/<file>` at commit 29aefca…, used under AGPL-3.0-or-later. See NOTICE.
```

`NOTICE` 为每个文件加一条：来源路径、pinned commit、改动清单（逐条，含"删去 X 因为 Y"）。
`kit/calibrate.mjs` 与 `kit/i18n.js` 的键位表是我们自己的，但仍整体随仓库按 AGPL 分发。
歌曲、歌词、封面、商标不在任何授予范围内：预览只加载用户自备的本地音频文件，字幕文本来自用户自备的
`.lrc` / `subs/*.json`，技能仓库不携带。

## 风险

1. 上游 `Quality` 以"切镜"为事件驱动 `restart()`，我们的 Engine 没有切镜回调 → 由 `timeline.at(t)` 的
   `[a.id, b.id]` 键变化推导（沿用上游 `this.key` 的做法）。
2. `sizeFor` 上游硬编码 16:9 → 改为按 `config.design` 比例，否则竖屏片降质后比例错。
3. `simulate()` 用虚拟时钟，`performance.now()` 仍是真实墙钟 → 它测的是"本机渲染成本 × slow"，
   不是墙钟时间；报告里要写清，避免误读为实时表现。
4. `decodeAudioData` 对 140 s MP3 约需几百毫秒且占内存（f32 ≈ 50 MB）→ 与 prewarm 并行，进度显示在 boot 屏。
