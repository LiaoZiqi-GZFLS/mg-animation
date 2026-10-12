# 流式导出：把帧直接喂给 ffmpeg，不再经过 PNG

日期：2026-10-12 · 状态：待评审
参考：[pdoom-video](https://github.com/mexicat/pdoom-video)（MIT）的 `render.ts video`——两个 headless Chrome 渲块，raw 帧经 WebSocket 流给一个 ffmpeg，内存 1 GB + 磁盘 20 GB 缓冲。

## 为什么要做（实测，不是推测）

在展示片的重镜头段（t=40…100 s，1080p，24 帧中位数）：

| 阶段 | 每帧耗时 |
|---|---|
| 提交绘制（`frameAt`，不等待） | 4 ms |
| + 1×1 `readPixels`（强制 flush，即真实 GPU 帧时） | **7 ms** |
| + 全帧 `readPixels` 8.3 MB 经 CDP 回 node | **7 ms** |
| + 元素 `screenshot({png})` | **554 ms** |

也就是说：**渲染根本不是瓶颈，PNG 编码才是**。整片 4200 帧实测用了 2351 s，其中 GPU 只需约 30 s。
x264（CRF 16 / preset slow）单独跑时是 81 fps ≈ 12 ms/帧，与渲染并行后就是新的上限。

预期：4200 帧从 **2351 s → 约 60–120 s**（含编码），并且 `build/frames/` 里那 6 GB 临时 PNG 彻底消失。

顺带解锁的是运动模糊：pdoom 的 `--samples auto` 会在快门里画 4/12/36/108/324 个子帧。按现在的成本结构，
12 个子帧就是 6.6 s/帧——不可能；按流式的成本结构，它只是把 GPU 那 7 ms 乘以 N，仍然便宜。

## 设计

### 1. 传输：raw RGBA，不做任何图像编码

```
page: gl.readPixels(0,0,W,H, RGBA/UNSIGNED_BYTE)  →  8.3 MB/帧 (1080p)
node: 直接写入 ffmpeg stdin
ffmpeg: -f rawvideo -pix_fmt rgba -s WxH -i - -vf vflip[,scale] -c:v libx264 …
```

- `readPixels` 的行序是自下而上，用 `-vf vflip` 修正（放在 scale 之前）。
- 不做 node 侧 RGBA→RGB 转换：ffmpeg 直接吃 `rgba`。
- 超采样路径（`--height 1620` → 缩到 1080）不变，只是喂进去的是 raw；14 MB/帧仍在同一量级。
- 回读发生在绘制任务之后的另一个 CDP 调用里，所以要求 `preserveDrawingBuffer: true` —— `makeContext` 已经是这么建的（`gl.js:236`），探针也正是这样跑通的。

### 2. 分片：每段自己编成 part，最后 concat

不做"一根管子从头灌到尾"——那样一崩就全丢，也没法续。改成：

```
build/parts/part-0000.mp4   ← 帧 0…299      （一个 chunk = 一个 part）
build/parts/part-0001.mp4   ← 帧 300…599
…
concat → mg-showcase_1920x1080_30.mp4（+ 音轨）
```

- `--chunk 300`（默认）；part 边界与页面回收（`--recycle`）对齐，一个 part 内不换页，换页时正好换 part。
- **续渲**：part 存在且 `ffprobe` 报的帧数 = 该段应有帧数 → 跳过；否则重编这一段。崩了最多丢一个 chunk。
- **并行**：`--jobs N` 时每个 worker 领整段 part，天然有序、无需 spool 或排序缓冲（pdoom 那套 1 GB+20 GB 缓冲是为单管设计的，我们用不上）。
- 接缝质量是这套方案的唯一代价：每个 part 是独立 x264 码流，CRF 下码率自适应会在段界重新起跳。验收必须**量**它，见下。

### 3. 背压

`stdin.write()` 返回 false 就 await `'drain'`，不排队堆积。若编码成为瓶颈（渲染快过编码），
提示降 `--preset`（`slow`→`medium`）或加 `--jobs`，而不是让 node 吃内存。

### 4. 保留的东西

- `--keep` / `--png`：仍走 PNG 落盘，用于调试与 `--thumb`；两条路径必须产出同样的帧。
- `--resume` 的语义从"跳过已存在的 PNG"变成"跳过已完成的 part"；缺帧报告保留，但报的是缺哪些 part。
- 导出不变量：`MG.frameAt(i, fps)` 仍是唯一入口，`?render=1` 仍不建播放器。

## 改动面

- `scripts/render.mjs`：帧循环改为 `readPixels` + 写 stdin；按 chunk 开/关 ffmpeg；结尾 concat + 合音轨。约 ±150 行。
- `scripts/sweep.mjs` / `sheet.mjs`：不受影响（它们不编码）。
- `SKILL.md`：第 6 步的时长预算与 `--chunk/--jobs` 说明重写。

## 验收

1. **同帧一致**：同一影片分别用 PNG 路径与 raw 路径各渲 60 帧，解码后逐像素比，差异必须 ≤1 LSB 且只出现在 dither 级；否则说明 vflip/行序/色彩范围有一处错了。
2. **接缝**：渲一部含快速运动的短片（用展示片 40–100 s 段），在 part 边界 ±2 帧处取点亮度/色度，与无接缝的同参数单次编码比较；边界跳变必须 < 1.5/255（ΔYAVG，取该镜头整体帧间波动的 3σ 以下），否则改用 `-x264-params mbtree`/统一 `-g` 或退化为单管。
3. **速度**：整片 4200 帧的墙钟必须显著低于 2351 s，且 `build/frames/` 不再产生文件（除非 `--keep`）。
4. **崩得起**：渲到一半 kill 进程，再 `--resume`，必须只补没完成的 part，最终成片帧数与时长正确。
5. `smoke.mjs` 增加一条：流式路径产出的 mp4 可解码、帧数正确、时长正确。

## 风险

- **CDP 大负载**：每帧 8.3 MB 过协议。实测中位数没有额外开销，但长跑稳定性未验证（这正是以前卡死的地方）。缓解：`--chunk` 边界本来就重建页面，暴露面被 chunk 限住；真出现退化就按行分块回读（每次 256 行），而不是退回 `toBlob`——那等于又把编码请回来。
- **内存**：node 侧一次只持有一帧（8.3 MB）+ ffmpeg 自己的缓冲；`--jobs N` 时是 N 帧。默认 1，安全。
- **色彩**：PNG 路径带的是浏览器已合成的 sRGB 像素；raw 回读拿到的是同一帧缓冲，理论一致，但 `--png`/raw 必须做第 1 条比对来证明，不能假设。
- 若第 2 条接缝测试过不了，退路是"单管 + 每 part 一个进程顺序接力"（牺牲并行，保接缝），spec 里先不实现。
