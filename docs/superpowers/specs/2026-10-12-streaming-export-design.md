# 流式导出：把帧直接喂给 ffmpeg，不再经过 PNG

日期：2026-10-12 · 状态：已实施（2026-10-13 验收；"验收"与"风险"两节为 Task 5 的实测。同日修复轮把两处缺陷——`player.js` 的帧 POST 改 Blob body、concat 去掉 `-shortest`——修掉并复测通过；最终修复轮（同日）补齐 `--png` 臂的 `-frames:v` 与 aac 256k，并给 smoke 的流式断言加上时长项）
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
**实测（2026-10-13，Task 5）：未达成**——流式整片用了 3074.3 s，比 PNG 基线还慢 1.31×。瓶颈既不是 GPU 也不是 x264，而是页→node 的整帧 POST 传输（`fetch(body: Uint8Array)` 实测 ~30 MB/s；同载荷换 `Blob` body ~9× 快，全循环 38–41 ms/帧，外推整片 ~172 s）。**同日修复轮**（2026-10-13）把 POST body 换成 Blob 后复测：整片 4200 帧 **229.7 s**（18.3 fps），显著低于 2351 s 基线；原 60–120 s 预测仍未达，剩余成本见"验收·速度"与"风险"。
（'build/frames/ 不出现'一项达成：流式路径不写任何 PNG。）

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

## 验收（2026-10-13 实测，原始输出在 `.superpowers/sdd/2026-10-12-streaming-export/task-5-evidence/`）

1. **同帧一致** —— **帧级通过**。真实流式运行的 30 帧 POST 载荷与 PNG 运行落在盘上的同 30 帧逐一比：**>1 LSB 的通道值 0 个**（最大差 1 LSB；186,624,000 个通道值中 2,343 个（0.001255%）差恰好 1 LSB，集中在 27/30 帧、每帧 18–118 个；前 3 帧位位相同）。vflip 与 rgba→yuv420p 均验证无误：两臂给定同一源的 YUV 缓冲位位一致，把 png 路径的 PNG 经 raw 臂（rgba + vflip）重编，输出与 `png-path.mp4` **位位相同**（`cmp` 通过）；未翻转对比则是全帧级差异（max 235）。按本节最初写法（两条路径各自编码、解码后逐像素比）实测 10,766,014 个 >1 LSB、max 41：根因是两次运行间**被抓像素本身**有 ≤1 LSB 的抖动（readPixels 跨运行位位稳定；偏差出现在 Chrome 的截图/合成路径，~0.005% 样本），被 x264 的 lookahead/mb-tree 帧间耦合放大到整个 part——**任何"两路径各编码一次再比解码结果"的实现都过不了 0 阈值，除非两次抓帧位位一致**。故判据一以帧级数字记录：0 个 >1 LSB。
2. **接缝** —— **通过，无需退路**。20 个 part（`--chunk 30`，f=1200…1799）对 600 帧单 part 参照逐帧比 YAVG：19 个边界的**最大跳变 0.1168**（判据 <1.5，13× 余量），且远小于 3σ=5.2333（σ=1.7444，为该镜头 600 帧相邻帧 |ΔYAVG| 的标准差，逐帧波动均值 0.286）；边界 ±2 帧内与参照的最大偏差 0.0927。统一 `-g` / 单管接力等退路不需要。
3. **速度** —— **通过（2026-10-13 修复轮复测）**。修复 = `assets/kit/player.js` 一行 `body: new Blob([MG._px])`（首测同一 8.3 MB POST：Uint8Array body 中位 204 ms、Blob body 中位 **23 ms**；Blob 复刻真实循环 38–41 ms/帧）。修复后整片 4200 帧：`rendered 4200/4200 frames into 14/14 parts in 229.7s (18.3 fps, slowest 442 ms/frame)`，比 2351 s 基线**快 10.2×**（"显著低于 2351 s"达成）；`build/frames/` 未产生任何新文件（达成）。端到端稳定 50–61 ms/帧（均值 ~55 ms/帧）：页→node Blob POST ~23 ms + GPU 绘制/回读 ~5 ms + x264 ~20 ms + 每 part 换页 prewarm ~0.6–0.8 s。修复前的 3074.3 s（1.4 fps；页内 `fetch` Uint8Array body 中位 204–274 ms、整帧周期 685–757 ms、`--jobs 4` 0.42 s/帧外推 ~1770 s）自此成为历史记录。
4. **崩得起** —— **通过（2026-10-13 修复轮复测）**。整片渲到 5 个 part 文件（part-0000…0003 完成 = 1200 帧；part-0004 收尾中）时只 kill render.mjs 自己的 node PID（PowerShell CIM 按 `render.mjs` 且 `mg-showcase` 双重过滤取 PID 50152，Stop-Process 单独一发；随后 chrome 随其调试管道关闭自行全退、ffmpeg 随 stdin EOF 退出，两次核查均 0 残留）。part-0004 在 kill 前恰好收满 300 帧（4,316,641 字节）。`--resume` 重跑：`rendered 2700/4200 frames into 14/14 parts in 131.9s (20.5 fps, slowest 367 ms/frame)  (5 parts already complete, kept)`——**只重渲未完成的 9 个 part**；part-0000…0004 的 mtime 在 resume 期间逐次快照不变（17:46:48 / 17:47:04 / 17:47:19 / 17:47:34 / 17:47:48），part-0005…0013 均以新 mtime 重写，成功后 parts 目录删除。修复后的最终成片 ffprobe：**4200 帧 / 140.000000 s / h264+aac**（修复 = concat 去掉 `-shortest`，见"风险"）。
5. `smoke.mjs` 的流式断言已实现，覆盖本判据的三项（可解码、帧数正确、时长正确）：60 帧流式短片同时断言 `nb_read_frames=60` 与 `format=duration=2.000000`（时长一项为 2026-10-13 最终修复轮补上）。Task 4 起 19 项全绿；Task 5 的全量回归：smoke 19/19、player/frame-sink/part/render-parts 全绿、playcheck 17/17（新加 MG_BROWSER 钩子后）。修复轮（2026-10-13）复跑同样全绿：smoke 19/19、player 17、frame-sink 2/2、part 3/3、render-parts 7/7、playcheck 17/17。最终修复轮（同日）复跑：smoke 19/19、player 17、frame-sink 2/2、part 3/3、render-parts 8/8（新增 PNG 臂帧范围回归）、playcheck 17/17。

## 风险（验收后更新）

- **页→node 的整帧 POST（2026-10-13 已修复）**：`fetch` 带 `Uint8Array` body 在 Chrome 里曾实测 ~30 MB/s（8.3 MB 中位 204–274 ms，整帧周期 ~0.73 s）；换成 `Blob` body（`assets/kit/player.js` 一行 `body: new Blob([MG._px])`，2026-10-13 实施）后同一 POST 中位 23 ms，整片 229.7 s，1080p 整片预算 ~0.055 s/帧。残留注意：修复后两次整跑中首跑有一次判据 3 被页侧瞬态 `Failed to fetch` 中止（帧 63 同一帧连续三次 part 尝试都撞上，3-strike 弃掉该 part；帧 363 同类失败两次后在第三次 part 尝试收下；两次抖动都发生在所在 part 的第 64 帧——part 内偏移 63，即整片帧 63 与 363；干净重跑 0 失败）。`--resume` 可收拾，代价是整体重渲该 part（约 13 s），单帧连续失败次数由 3-strike 上限兜住。原先担心的"CDP 大负载"没有成真——readPixels 在页内只要 3–4 ms，真正的大负载是 POST 传输本身。
- **`-shortest` 截断（2026-10-13 已修复）**：流式 concat 的 `-shortest` 遇上 139.991270 s 的音轨曾把成片截到 **4199 帧 / 139.991270 s**（首测 ffprobe；验收要求是 4200 / 140.000000），最后一帧被拦腰砍掉；PNG 分支从来没有这个 flag。修复 = `scripts/render.mjs` concat 去掉 `-shortest`（2026-10-13 实施）；修复后干净整跑与 kill+resume 的最终成片都是 **4200 帧 / 140.000000 s / h264+aac**。
- **内存**：node 侧一次只持有一帧（8.3 MB）+ ffmpeg 自己的缓冲；`--jobs N` 时是 N 帧。默认 1，安全。
- **色彩**：已由判据一证明——帧级 0 个 >1 LSB、两编码臂给定同一源位位一致，色彩范围与行序不再挂账。
- 接缝退路（统一 `-g` / 单管接力）不需要：实测最大边界跳变 0.1168（见"验收"第 2 条）。
