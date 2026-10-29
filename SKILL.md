---
name: ego-media-downloader
description: 自动调用 ego-browser，从指定 URL 下载视频或图片，**所有网站统一遵循「多档择优」：同一作品有多档清晰度/多个候选直链时，全部收集后按分辨率→码率→体积取最高，绝不取第一个候选**。会在指定目录（未指定时视频默认 G:\我的云端硬盘\视频、图片默认 G:\我的云端硬盘\图片）下，新建「以博主用户名为名」的文件夹并下载全部媒体；拿不到用户名则用日期 YYYY-MM-DD 作文件夹名。支持整页/主页批量下载与单条媒体链接。**双引擎：ego-browser 负责发现（登录态/反爬/翻页），yt-dlp 负责下载（分片并发/AES 解密/断点续传/上千站点原生支持）**，yt-dlp 不可用时自动回退自研方案（抖音/头条/B站/YouTube/X/91吃瓜有验证配方，小红书及通用站点尽力而为）。
argument-hint: "<url> [--dir 目录] [--type video|image|all] [--name 用户名] [--limit N]"
version: "1.0.10"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# ego-media-downloader

自动用 **ego-browser**（复用你已登录的会话）去你指定的地址下载视频或图片，并在目标目录里以博主用户名新建文件夹、把媒体放进去。

## 铁律：多档择优（适用于**所有**网站，无例外）

> **任何站点、任何媒体，只要同一个作品存在多个候选直链或多档清晰度，就必须把候选全部收集起来，
> 按「分辨率 → 码率 → 体积」降序取最高档。绝不能拿第一个候选当成品。**

这条不是某个平台的技巧，是本 skill 的**全局约定**。违反它的典型写法（都不允许）：

| ❌ 错误写法 | 为什么错 |
|---|---|
| `video.play_addr.url_list[0]` | 头条/抖音的默认档，常只有 480p |
| `captured.video[0]` / `.m4s` 第一条 | B站首个被请求的往往是低档 |
| 靠 `.m4s` 文件名猜 codec | `-1-100026.m4s` 是 **AV1 视频流**不是音频；猜错会让成品**完全没音轨** |
| `<video>.currentSrc` 当唯一来源 | 播放器可能仍在低档 |
| `<img>.src` 当唯一来源 | 忽略 `srcset` 里的更大档 |
| 取 `srcset` 第一个 | `srcset` 顺序不可靠，必须按 `Nw` 描述符排序 |
| 图片 URL 带 `@1280w_1l` / `/330px-` 直接用 | 那是缩略图，去掉后缀才是原图 |
| 用 `naturalWidth` 判断图片大小 | SVG 会虚高（40px 缩略图报 2000） |

**实现方式（统一走内核，不要各写一份）**：所有平台脚本都 `import` `tools/_quality.mjs`：

- `rankCands(rawList)` — 归一化 + 按 URL 去重 + 降序排序
- `pickBest(cands)` — 取最高档（真实宽高 > definition 文案 > 码率 > 体积）
- `pickBestImage(cands)` / `originalImageUrl(url)` / `imgGroupKey(url)` / `parseSrcset(s)` / `guessImgWidth(url)` — 图片多档
- `pickBiliDash(videoList, audioList)` — **B站首选**，playurl API 的 dash 数据择优（分辨率→编码偏好→码率）
- `pickBiliStreams(videoUrls, audioUrls)` — B站旧方案（猜 m4s 文件名），保留兼容
- `defToHeight(def)` / `scoreOf(c)` / `byQualityDesc(a,b)` — 底层评分

**各平台必须收集的档位来源**（漏一个就可能下到低清/无声）：

| 平台 | 候选来源 |
|---|---|
| 头条 | `video.play_addr_list[]` + `video_play_info.video_list[]`（JSON 字符串，`video_meta` 带真实 `vwidth/vheight`） |
| 抖音 | `video.bit_rate[]`（`gear_name`/`bit_rate`/`play_addr`）+ `play_addr{,_h264,_265,_bytevc1}` + `download_addr` |
| B站 | **`x/player/playurl?fnval=4048&fourk=1` 的 `dash.video[]`/`dash.audio[]`/`dash.dolby.audio[]`**（权威，带真实宽高/codecid）；不要猜 `.m4s` 文件名 |
| YouTube | `getAvailableQualityLevels()` 全部档位，按标签解析高度后选最高 |
| 图片 | `srcset` 全部 `Nw` 档 + `src`/`data-src`/`data-original` + 原图化（去 `@1280w`、`/330px-`）+ 同图归组取最大 |

**每个平台脚本都必须做三件事**：
1. 把该站所有可能的档位来源**全部**塞进候选数组（含 fallback / backup / 不同 codec 变体）；
2. 用内核排序，**不要**自己写 `sort` 或直接取 `[0]`；
3. 把选中的 `resolution` / `bitrate`（或图片 `Nw`）写进 `manifest.csv`，便于事后核验。

**验收标准**：抽几条用 `ffprobe` 核对实际分辨率，应等于 manifest 里声明的最高档；
音视频分离的站点（B站/YouTube）还必须核对**同时存在 video 和 audio 流**（manifest 有 `hasAudio` 列）；
若某条站点只提供单档，`_items.json` 里 `nCand` 会是 1，这是正常的。

## 触发

- `/ego-media-downloader <url> [--dir 目录] [--type video|image|all] [--name 用户名] [--limit N]`
- 自然语言：如「把这个博主的视频下到 G:\...」「下载这个链接里的图片」「把那个头条号的小视频全下了」「只要最新 10 条」。

## 参数

- `<url>`（必填）：创作者主页 / 合集页，或单条媒体 / 帖子链接。
- `--dir <目录>`（可选）：显式指定根目录。给了它时，**视频和图片都进 `<dir>/<用户名>/` 一个文件夹**。
- `--type <video|image|all>`（可选，默认 `all`）。
- `--name <用户名>`（可选）：强制覆盖自动识别的博主名（不想让脚本自己猜时用）。
- `--limit <N>`（可选，默认 0=全部）：只下**最新 N 条**。按平台时间序取最新（X 用雪花 ID 降序；其它站点按页面顺序）。

## 工作流（按此执行）

1. **解析参数**：`url`、`dir`、`type`、`name`。
2. **解析输出根**：
   - 给了 `--dir`：`根 = <dir>`，视频+图片都进 `<根>/<用户名>/`。
   - 没给：视频根 `G:\我的云端硬盘\视频`，图片根 `G:\我的云端硬盘\图片`；按 `type` 分别建 `<用户名>/`（type=all 时两个根各建一个）。
3. **确定作者名**（优先级）：`--name` > 平台资料页提取 > 页面 `<title>` / URL slug > 日期 `YYYY-MM-DD`。
4. **组装输出路径**：`<根>/<作者名>/`，记到变量 `OUT_DIR`。
5. **选配方**：按 URL 域名挑 `tools/*.mjs`（见下「平台选择」）。把**平台脚本和 `_quality.mjs` 两个文件**一起复制到 `F:\linshi\ego-task\`，并在**同一目录**写一个 `emd-config.json`：
   ```json
   { "url": "这里填目标地址", "out": "这里填最终文件夹路径（已含用户名/日期）", "type": "video|image|all", "limit": 0 }
   ```
   （`limit` 可选，0 或不写=全部；`filter` 可选，按标题关键词筛，如 `"filter":"孙珍妮|程儿"`）
   ⚠️ **`_quality.mjs` 必须一起复制**：ego-browser 用 cmd stdin 跑脚本时，脚本被当作 `[eval2]` 执行，**相对 import 会解析到 ego 安装目录**而不是脚本目录，所以平台脚本里用的是「绝对 `file://` 候选路径」动态 import。漏了 `_quality.mjs` 会报 `Cannot find module ...\_quality.mjs`。
   然后运行（**Windows 实测可靠写法**）：
   ```
   # 用 cmd 的 stdin 重定向把 .mjs 喂给 nodejs；必须包在 Start-Process cmd /c 里
   Start-Process -FilePath "cmd.exe" -ArgumentList @('/c','"C:\Program Files\Citro Labs\ego lite\Application\<VERSION>\ego-browser.exe" nodejs < F:\linshi\ego-task\<脚本>.mjs > F:\linshi\ego-task\out.txt 2> F:\linshi\ego-task\err.txt') -NoNewWindow -Wait
   ```
   - **不要用 `-e`**：PowerShell 会丢双引号，`await import(...)` 被拆散 → `await is not defined` / `SyntaxError: Unexpected end of input`。
   - **不要直接 `& ego-browser.exe ...`**：报 `StandardErrorEncoding is only supported when standard error is redirected`。
   - **必须能开命名管道**：ego-browser 通过 `\\.\pipe\browser` 等命名管道连本机 ego lite daemon；「仅可查看」「工作区内修改」都禁止打开命名管道 → 报 `Failed to connect to ego_cli bootstrap`。
     - **推荐**：会话保持「工作区内修改」，只给这一条命令加 `sandbox_permissions: danger-full-access` + `justification`（最小权限，按需提权）。
     - 或者整个会话切「完全权限」/「自动审查」（都无沙箱）。
   - **中文只放文件内，绝不放进命令行参数。**
   - 配置优先级：`emd-config.json` 为可靠方式（ego-browser 子进程读不到宿主 PowerShell 的 `$env:`）；env 仅作兜底。
   - 脚本按「`F:/linshi/ego-task/emd-config.json` → 脚本同目录」两处找配置。
6. **脚本会自动**：注入 XHR 钩子 → 打开页面（已登录）→ 滚动 / 翻页枚举媒体 → **收集该站全部档位候选 → 交给 `_quality.mjs` 按分辨率/码率/体积取最高档** → 逐条下载（**已存在则跳过 = 断点续传**）→ 写 `manifest.csv`（`index,vid,title,file,bytes,resolution,bitrate`）与 `_items.json`（含 `nCand`/`allDefs` 供核验）。
7. **汇报**：下载数量、总大小、**分辨率分布**、失败项、输出目录。若有条目最高档明显低于源分辨率，说明站点本身没有更高档，要点明。
8. **自动进化（每次运行后必做，见下「自动进化」）**：若本次遇到 **新平台 / 新坑 / 需要新建的站点专用脚本**，必须当场把成果融合回本 skill（新建 `tools/<平台>-<类型>.mjs`、补 `references/platforms.md` 配方与演化日志、更新下方「平台选择」路由、更新 `EVOLUTION.md`），使跨会话也能继承。

## 双引擎：ego-browser（发现） + yt-dlp（下载）

本 skill 有**两条腿**，职责严格分开，不要混用：

| 引擎 | 负责 | 不可替代性 |
|---|---|---|
| **ego-browser** | 打开页面、复用登录态、绕过反爬、枚举列表、从 DOM/属性/JS 里**发现**真实媒体地址 | 抖音/头条/91cg1/X 媒体页/YouTube 都只能靠它发现 |
| **yt-dlp**（若 PATH 上有） | 把**已知的媒体地址或原生支持的站点 URL** 下成成品（分片并发、AES 解密、音轨合并、断点续传） | 更快的下载 + 上千站点原生支持 |

**核心原则：让 yt-dlp 做下载，不要让 yt-dlp 做发现。** 实测它做发现会直接失败（见下表）。

### yt-dlp 实测能力边界（2026-10-29 / yt-dlp 2026.10.26）

| 场景 | 结果 | 说明 |
|---|---|---|
| 直链 `.m3u8`（含 AES-128 加密） | ✅ 完美 | 91cg1 同一条 688MB：yt-dlp 117.8s vs 自研分片 165s，**SHA256 完全相同** |
| B站单条 `bilibili.com/video/BV…` | ✅ 1080p 有音轨 | 17s 一步到位（自动选 f30080+30280 再合并） |
| X 单条推文（配 ego cookies） | ✅ 1080p | 比 GraphQL 方案多给一个 `http-10368` 直链档 |
| 通用页面 `<video>` | ⚠️ 能发现但拿不到分辨率 | 择优质量不如自研 DOM 扫描 |
| 91cg1 页面级 URL | ❌ Unsupported | 必须先用 ego 读 `data-config` 拿 m3u8 |
| 抖音 `douyin.com` | ❌ Unsupported | 只能走 `douyin-video.mjs` |
| 头条 `toutiao.com` | ❌ generic 404 | 只能走 `toutiao-video.mjs` |
| X 媒体页 `/<user>/media` | ❌ Unsupported | 必须由 ego 先枚举出具体推文 URL |
| YouTube | ❌ 只返回 storyboard | PO token 限制，带 cookies 也没用；继续走 MSE 方案 |

### 登录态：ego → yt-dlp 的 cookie 桥

```powershell
# 1) 从 ego 已登录会话导出 Netscape cookie（yt-dlp 读不了 ego 的 profile 数据库）
#    emd-config.json: {"cookiesFor":["https://x.com/"],"cookiesOut":"F:\\linshi\\ego-task"}
#    然后跑 tools/export-cookies-ytdlp.mjs
# 2) 交给 yt-dlp
yt-dlp --cookies F:\linshi\ego-task\ck-x.com.txt ...
```

⚠️ **Netscape 格式铁律**：`domain` 的第 2 列 flag 必须与「domain 是否带前导点」**严格一致**
（带 `.` → `TRUE`；不带 → `FALSE`）。否则 python `http.cookiejar` 触发
`AssertionError: domain_specified == initial_dot`，yt-dlp 直接崩。旧脚本正是踩了这个坑。

### 下载引擎选择（脚本内约定）

- 不传 `engine`（默认 `auto`）：先用 yt-dlp，失败/产物不完整自动回退自研方案
- `"engine": "builtin"`：强制走自研方案（调试或 yt-dlp 行为异常时用）
- 无论走哪条路，**都必须**：`ffprobe` 校验分辨率/时长/有无音轨，再写 manifest —— 不信任工具自报

## 平台选择

**所有平台都遵循上方「铁律：多档择优」**，各脚本均已接入 `tools/_quality.mjs`。

- URL 含 `douyin.com` → `tools/douyin-video.mjs`（视频，已验证；合并 `bit_rate[]` + 各 `play_addr_*` 变体 + `download_addr` 择优）
- URL 含 `toutiao.com` → `tools/toutiao-video.mjs`（视频，已验证；合并 `play_addr_list` + `video_play_info.video_list` 择优）
- URL 含 `bilibili.com/video/` → `tools/bilibili-video.mjs`（单条视频，已验证；**yt-dlp 优先**一步拿 1080p+音轨，失败回退 playurl dash 方案）
- URL 含 `space.bilibili.com` → `tools/bilibili-space.mjs`（UP 主投稿批量，已验证；同上，实测 15/15 全 1920×1080 有音轨）
- URL 含 `youtube.com`（/@handle、/@handle/shorts、/channel、/watch、/playlist） → `tools/youtube-video.mjs`（已验证·高清；MSE 抓缓冲分片 + 强制最高 ABR 档；支持 filter 按标题关键词筛）
- URL 含 `xiaohongshu.com` / `xhslink.com` → `tools/xiaohongshu-media.mjs`（图文+视频，尽力而为；srcset 全档 + 原图化后取最大）
- URL 含 `x.com` / `twitter.com` → `tools/x-video.mjs`（视频+图片，已验证·多档择优；解析 GraphQL `video_info.variants` 全档；支持 `--limit N` 只下最新 N 条）
- URL 含 `91cg1.com` → `tools/91cg1-video.mjs`（视频，已验证；标签页/文章页批量，读 `div.dplayer[data-config]` 的 HLS 地址，**yt-dlp 优先**，回退 ts 分片 8 并发 + AES-128 本地解密 + 断点续传 + fail-fast）
- **其它（先试 yt-dlp）** → `tools/ytdlp-media.mjs`：把 URL 直接交给 yt-dlp 的 1755 个 extractor（Vimeo/TikTok/大量自建站等）。退出码 `0`=成功或已全部跳过、`2`=有报错、`3`=yt-dlp 不支持/无产出 → 此时**再**降级到 `tools/generic-media.mjs`
- URL 已被识别为直链（`.m3u8`/`.mp4`）→ 优先 `tools/ytdlp-media.mjs`，不要用 generic 存播放列表文本
- 兜底 → `tools/generic-media.mjs`（扫描 video/img，尽力而为；多 `<source>` 择优、`srcset` 按宽度择优、图片原图化；**发现 m3u8 时自动调用 yt-dlp 下成 mp4**）

**新增平台脚本时**：必须 `import` `_quality.mjs` 并走 `rankCands`/`pickBest`，不得自己取 `[0]`。
下载环节优先复用 `_ytdlp.mjs`（`downloadWithYtdlp` / `isYtdlpFriendly`），并保留一条自研回退路径。

具体抓取细节、用户名提取方式、常见坑见 `references/platforms.md`。

## 内核自测

```powershell
cd "C:\Users\LR\.agents\skills\ego-media-downloader\tools"; node test_quality.mjs
```
纯函数单测（32 例），覆盖档位解析、真实宽高优先、B站 qn 码表/30000 偏移/音频码排除/`pickBiliDash` 编码偏好、srcset、原图化、MediaWiki 原图、图片归组、`naturalWidth` 陷阱。
改动 `_quality.mjs` 后必须跑一遍，全绿才算通过。

## 断点续传 / 验收

- 文件已存在则跳过；重跑不会重复下载。
- 验收：用已下过的博主重跑，应「全部跳过、0 新增」，且 `manifest.csv` 完整。

## 安全与边界

- 不绕过 DRM / 登录墙 / 付费内容，遵守各站 TOS。
- 本 skill **不安装** dsh-video-downloader 等外部插件；媒体发现 / 登录 / 翻页全部交给 ego-browser。
- 签名直链可能过期：每次运行都现场重新从页面提取；已下文件跳过不重下。
- 登录态失效时 ego-browser 用你的已登录上下文；若被拦则停止并报告，不绕过。

## 自动进化（核心机制）

本 skill 不是静态的——**它会在每次运行后把"踩到的坑、新建的平台脚本、验证过的配方"融合回自身**，并且**跨会话继承记忆**。具体规则：

1. **新平台**：遇到任何 URL 域名没有对应 `tools/*.mjs` 且 generic 兜底失败时，**新建专用脚本** `tools/<平台>-<video|media>.mjs`（命名小写、连字符），实现该站点的媒体发现 + 下载 + 用户名提取。
2. **新坑 / 修复**：某站点改版、签名参数变化、反爬升级等导致失败，修复后**把修复写回对应 `tools/*.mjs`**，并把"症状 → 原因 → 修复"记进 `references/platforms.md` 的「演化日志」。
3. **路由更新**：每新增/变更一个平台脚本，必须更新上方「平台选择」列表，把域名映射到新脚本，并标注 `已验证` / `尽力而为`。
4. **配方沉淀**：把可用的最新抓取配方（接口、翻页容器、直链字段、Referer、用户名提取位置）写进 `references/platforms.md` 对应平台小节，旧方案保留为「历史」供回滚参考。
5. **跨会话记忆**：本 skill 的长期状态落在 `EVOLUTION.md`（该文件属于本 skill 目录，随 skill 一起被读取）。每次进化后必须更新 `EVOLUTION.md`（刷新「已知平台 / 已知坑 / 演化日志」）。新会话加载本 skill 时应先读 `EVOLUTION.md`，避免从零摸索。
   - 备注：本环境 Hindsight 后端无鉴权（401），故不依赖它；若日后 Hindsight 可用，可额外同步一条同名知识页，但不作为唯一真相来源。
6. **版本号**：`SKILL.md` frontmatter 的 `version` 在每次实质性进化时 +0.0.1，`references/platforms.md` 顶部「演化日志」追加一条（日期 + 变更 + 影响平台）。

> 注意：进化由 agent 在该技能工作流第 8 步主动执行；skill 文件本身不含自修改代码，所有变更由 agent 通过 Read/Write/Edit 落到本目录文件与 `EVOLUTION.md`。
