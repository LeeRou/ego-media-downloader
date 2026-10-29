# ego-media-downloader — 跨会话状态 / 演化记忆

> 本文件是本 skill 的「长期记忆」。Hindsight 后端在当前环境无鉴权不可用，故状态直接落在 skill 目录内，随 skill 一起被读取、被进化。每次自动进化后由 agent 更新本文件（追加「演化日志」、刷新「已知平台 / 已知坑」）。

## 头号铁律：多档择优（所有站点，无例外）

**同一作品只要有多档清晰度/多个候选直链，就必须全部收集后按「分辨率 → 码率 → 体积」取最高，绝不能取第一个。**

统一内核：`tools/_quality.mjs`（所有平台脚本 `import` 它，不得各写一份排序）。单测：`tools/test_quality.mjs`（26 例）。
禁止写法：`play_addr.url_list[0]` / `captured.video[0]` / `currentSrc` 当唯一来源 / `<img>.src` 忽略 srcset / srcset 取第一个 / 带 `@1280w` 的缩略图。
验收：`manifest.csv` 必须含 `resolution`/`bitrate`（图片 `Nw`）；抽条 `ffprobe` 核对；`_items.json` 的 `nCand` = 候选档数。

## 已知平台

| 平台 | 脚本 | 状态 | 关键配方 |
|---|---|---|---|
| 抖音 douyin.com | tools/douyin-video.mjs | **已验证·多档择优** | XHR 劫持 `aweme/v1/web/aweme/post`；真滚动容器 `div.parent-route-container.route-sc`；**候选合并 `bit_rate[]`（档位最全）+ `play_addr`/`_h264`/`_265`/`_bytevc1` + `download_addr`** |
| 头条 toutiao.com | tools/toutiao-video.mjs | **已验证·多档择优** | XHR 劫持 `pc_profile_short_video`；`has_more` 一般不可信、手动重放签名 XHR 失败，靠自然滚动+稳定检测翻页；**候选合并 `play_addr_list[]` + `video_play_info.video_list[]`（后者带真实 vwidth/vheight）**；用户名取 `document.title` 的「XXX的头条主页」 |
| 小红书 xiaohongshu.com / xhslink.com | tools/xiaohongshu-media.mjs | 尽力而为（未实测） | 强反爬+登录墙，常遇滑块/加密，失败属预期；已接入 srcset 全档 + 原图化归组取最大 |
| 哔哩哔哩 bilibili.com（单条） | tools/bilibili-video.mjs | **已验证·多档择优** | **yt-dlp 优先**（一步拿 1920×1080 h264+aac，实测 17s），失败回退 `x/player/playurl?fnval=4048&fourk=1` 权威 dash 档位 → `pickBiliDash` 按「分辨率→编码偏好(h264>hevc>av1)→码率」择优 → ffmpeg 合并；**合并后 ffprobe 校验必须同时有 video+audio** |
| 哔哩哔哩 space.bilibili.com（UP 批量） | tools/bilibili-space.mjs | **已验证·多档择优** | 滚动收集全部 BV → 逐个取 bvid/cid → playurl → pickBiliDash → ffmpeg 合并 → 校验音轨 → 断点续传。实测 15/15 全 1920x1080 有音轨 |
| YouTube youtube.com（/@handle/shorts/channel/watch/playlist） | tools/youtube-video.mjs | **已验证（高清）** | googlevideo 直链 IP 绑定 403 → MSE 抓缓冲分片；**必须放大视口 1920x1080 + 反复强制最高清晰度并校验**，否则只给 360x640；档位排序走 `defToHeight`（不再硬编码）；支持 filter 按标题关键词筛 |
| X / Twitter x.com, twitter.com | tools/x-video.mjs | **已验证·多档择优** | SPA，`<video>.src` 是 blob 抓不到 → **XHR+fetch 双钩子抓所有 `/graphql/` 响应**，递归遍历 JSON 找 `video_info.variants[]`（同视频 4 档 480x270→1920x1080）交给 `rankCands` 择优；图片 `?name=orig` 取原图；**X 媒体 ID 是雪花 ID，BigInt 降序=最新在前**，支持 `limit` 只下最新 N 条 |
| 任意站点（兜底） | tools/generic-media.mjs | 尽力而为 | 多 `<source>` 择优、`srcset` 全档按宽度择优、图片原图化后归组取最大；**发现 m3u8 自动用 yt-dlp 下成真 mp4**；签名/登录/DRM 站点会失败 |
| 91吃瓜 91cg1.com（标签页/文章页） | tools/91cg1-video.mjs | **已验证** | 播放器配置在 `<div class="dplayer" data-config="...">` **属性**里（`<video>.src` 是 `blob:`、`<script>` 搜不到），`JSON.parse(getAttribute("data-config")).video.url` 即 HLS；m3u8 为 AES-128 单码率（`crypt.key` + `.ts`），`auth_key` 约 1~2h 过期需现场重取；**yt-dlp 优先**（`-S res,br,size -N 16`），回退 ts 分片 8 并发 + Node crypto 本地解密 + 分片级断点续传 + 连续 2 失败 fail-fast，全齐后拼接再 `ffmpeg -c copy`。实测 22 篇→34 视频/13.07GB/0 失败；yt-dlp 与自研产物 **SHA256 完全一致** |
| 其它站点（yt-dlp 原生支持） | tools/ytdlp-media.mjs | **已验证** | 直接把 URL 交给 yt-dlp 的 1755 个 extractor；`-S res,br,size -N 16 --download-archive`；退出码 0=成功/已跳过、2=有错、3=不支持→降级 generic |

## 双引擎架构（1.0.10 起）

**ego-browser 管发现，yt-dlp 管下载**。两者不可互换，混用会失败：

| 引擎 | 职责 | 实测边界 |
|---|---|---|
| ego-browser | 开页面、复用登录态、绕反爬、翻页枚举、从 DOM/属性/JS 发现真实地址 | 抖音/头条/91cg1/X 媒体页/YouTube 只有它能做 |
| yt-dlp | 把已知媒体地址或原生支持站点下成成品（分片并发/AES 解密/音轨合并/断点续传） | 91cg1 页面 / douyin / toutiao / x.com/<user>/media 全 Unsupported；YouTube 只返回 storyboard（PO token） |

- 内核：`tools/_ytdlp.mjs`（`findYtdlp` / `downloadWithYtdlp` / `probeWithYtdlp` / `isYtdlpFriendly`）
- 脚本内 `engine`：默认 `auto`（yt-dlp 优先、失败回退自研）；`builtin` 强制自研
- **无论走哪条路都要 ffprobe 复验**分辨率/时长/音轨，不信任工具自报

## 已知坑（已解决，勿再踩）

- **传参方式**：ego-browser 子进程读不到宿主 PowerShell 的 `$env:`，必须用脚本同目录的 `emd-config.json`（`{url,out,type}`）；env 仅兜底。
- **ego-browser 调用方式（Windows，2026-10-29 实测）**：
  - 直接 `& ego-browser.exe nodejs -e "..."` → `StandardErrorEncoding is only supported when standard error is redirected` 或 `拒绝访问`；PATH 软链版本还会 `Failed to connect to ego_cli bootstrap`。
  - `-e` 里的 `await import(...)` 被 PowerShell 丢引号拆散 → `await is not defined` / `SyntaxError: Unexpected end of input`；包 async IIFE 也救不回。
  - **可靠写法**：`Start-Process -FilePath "cmd.exe" -ArgumentList @('/c','"...ego-browser.exe" nodejs < 脚本.mjs > out.txt 2> err.txt') -NoNewWindow -Wait` —— 走 cmd 的 `<` 输入重定向，整个 `.mjs` 喂给 nodejs。
  - ego-browser 的 `console.log` 输出走 **stderr**，读 `err.txt`。
  - **必须无沙箱**：ego-browser 是 CLI，要通过**命名管道**连本机 ego lite daemon（`\\.\pipe\browser`、`\\.\pipe\mojo.CitroLabs.ego.<ver>`）。DSH 的两种受限模式都禁止程序打开命名管道 → 报 `Failed to connect to ego_cli bootstrap`（ego-browser 自己的报错也写着 "retry with Full Access"）。
    - 可行：①会话切「完全权限」或「自动审查」（两者都无沙箱）；②**更省事**：保持「工作区内修改」，每次调用单独加 `sandbox_permissions: danger-full-access` + `justification`，用户点同意即可（本会话实测：受限下失败 → 单次提权后立即成功）。
    - 不可行：仅可查看、工作区内修改。
    - 注意：「自动审查」在沙箱上等价于完全权限（都无沙箱），只是多了逐次模型审查 + 额外 token；要最小权限反而应该用「工作区内修改 + 单次提权」。
  - 脚本里 `import.meta.url` 在 cmd-stdin 模式下解析不可靠，配置读取要写成「同目录 emd-config.json → `F:/linshi/ego-task/emd-config.json`」两处兜底。
- **变量命名**：脚本内不要声明名为 `URL` 的局部变量，会遮蔽全局 `URL` 构造器 → `URL is not a constructor`。改用 `PAGE_URL`。
- **注入正则**：页面 `evaluate` 回调里写真斜杠正则 `/\/video\/(\d+)/`；双反斜杠只在注入到 Page 的 hook **字符串**里才需。
- **`_quality.mjs` 的 import 路径**：cmd stdin 模式下 ego-browser 把脚本当 `[eval2]` 执行，**相对 import 会解析到 ego 安装目录**（`C:\Program Files\Citro Labs\ego lite\Application\<ver>\_quality.mjs`）→ 报 `Cannot find module`。平台脚本必须用**绝对 `file://` 候选路径**动态 import，且 `_quality.mjs` 要跟平台脚本一起复制到任务目录。
- **B站致命坑（已修）**：不要靠 `.m4s` 文件名猜 codec。`-1-100026.m4s` 是 **AV1 视频流**（codecid 13），**不是音频**；`30216/30232/30280` 才是音频。旧配方把 `100026` 当音频 → 成品**完全没有音轨**（实测 15 个文件全无声）。正解：走 `x/player/playurl?fnval=4048&fourk=1` 拿 `dash.video[]`/`dash.audio[]`（带真实宽高/码率/codecid），用 `pickBiliDash` 择优；合并后必须 ffprobe 校验同时有 video+audio。
- **图片宽度可信度**：URL 内嵌尺寸（`/330px-`、`@1280w`、`?w=`）**最可信**；`naturalWidth` 对 SVG 会虚高（40px 的 SVG 缩略图报 2000），不能当首选依据。
- **MediaWiki 缩略图**：`/thumb/<a>/<b>/<Name>.jpg/330px-<Name>.jpg` → 去掉 `/thumb/` 和 `/Npx-` 段即原图，这是「多档择优」里最高的一档。
- **相对 URL**：页面 `evaluate` 里必须用 `new URL(u, location.href).href` 解析成绝对地址，否则 Node 侧 fetch 全失败（实测 107/170 失败）。
- **断点续传**：下载前 `existsSync(outPath)` 跳过；重跑不重复下。文件名 `NNN_<id>.<ext>`。
- **ego Page 没有 Playwright 的 `page.on("response")`**：`page.on` 不存在（TypeError: page.on is not a function）。想抓网络响应只能靠页面内 hook `fetch`/`XHR`（如 X 平台脚本那样），或从 DOM/属性里取。不要照抄 Playwright 的网络拦截代码。
- **HLS（AES-128）下载**：纯 `ffmpeg -i <m3u8> -c copy` 能跑通但有两个缺点——①不能分片级续传，中途断了整条重下；②长视频偶发 `Stream ends prematurely` / `Packet corrupt`。更稳的做法（参考 `kernel-video-sharing/crawler-91cg`）：自己解析 m3u8，ts 分片 8 并发下载 + `crypto.createDecipheriv("aes-128-cbc")` 本地解密落盘，已存在分片跳过，连续 2 失败 fail-fast，全齐后按序拼接再 `ffmpeg -c copy -bsf:a aac_adtstoasc`。实测同一条 688MB 视频：分片法 165s vs ffmpeg 直连 229s。IV 规则：playlist 有 `IV=0x..` 用它，否则用分片序号作 16 字节大端 IV。
- **完整性校验的期望时长**：不要用页面内 `fetch(m3u8).text()` 求 `#EXTINF` 和——部分页面会 `Failed to fetch` 返回 0，导致 `duration=0` 让校验静默失效。改在 Node 侧解析 playlist 时累加，最可靠。
- **yt-dlp 能做什么 / 不能做什么（2026-10-29 实测，务必记住）**：
  - ✅ 直链 `.m3u8`（含 AES-128）、B站单条、X 单条推文（配 cookies）、通用页面 `<video>`
  - ❌ **不能做发现**：91cg1 页面 URL、`douyin.com`、`toutiao.com`、`x.com/<user>/media` 全部 `Unsupported URL`
  - ❌ **YouTube 走不通**：即使带 cookies 也只返回 storyboard（PO token 限制），**YouTube 必须继续用 MSE 方案**
  - ✅ 档位语义等价：`-S res,br,size` = 分辨率→码率→体积，与 `_quality.mjs` 铁律一致；仍要显式传，防默认值变化
- **yt-dlp 读不了 ego 的 cookies**：`--cookies-from-browser "chrome:<ego User Data>"` 报
  `Could not copy Chrome cookie database`。必须用 `tools/export-cookies-ytdlp.mjs`（走 ego CDP `Network.getCookies`）导出 Netscape 文件。
- **Netscape cookie 格式断言**：第 2 列 flag 必须与 domain 是否带前导点**严格一致**（带 `.` → `TRUE`）。
  否则 python `http.cookiejar` 抛 `AssertionError: domain_specified == initial_dot`，yt-dlp 直接崩。
  旧导出脚本「domain 补点、flag 却按原始值」正是踩这个坑，已修。
- **ego 没有 Playwright 的 API**：`page.on("response")` 不存在（`TypeError: page.on is not a function`），
  `page.addInitScript` 也不存在。要注入首页脚本用 `page.cdp("Page.addScriptToEvaluateOnNewDocument", {source})`。
  generic-media.mjs 因此曾有启动即崩的 bug，1.0.10 已修。

## 用户明确不要

- 不安装 dsh-video-downloader 等外部插件（作用有限、且登录/翻页/发现仍需 ego-browser）。
- 不绕过 DRM / 登录墙 / 付费内容，遵守各站 TOS。

## 演化日志

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-28 | 1.0.0 | 初版：抖音/头条视频（已验证）+ 小红书图文视频 + 通用扫描（尽力而为）；确立自动进化机制（SKILL.md 第 8 步 + 本文件 + 平台路由更新 + version+0.0.1）。Hindsight 不可用，跨会话记忆改落本文件。 |
| 2026-10-28 | 1.0.1 | 进化：新增 B站配方 tools/bilibili-video.mjs（已验证）。发现 B站用 DASH 音视频分离 .m4s，需 hook fetch/XHR 抓直链 + ffmpeg 合并；页面无 __playinfo__ 脚本、video.src 为 blob。ego-browser 运行命令改为优先用 PATH 上的 `ego-browser`（版本无关软链），安装目录版本号仅作回退。SKILL.md 平台选择新增 bilibili 路由。 |
| 2026-10-28 | 1.0.2 | 进化：新增 B站 UP 主投稿批量下载 tools/bilibili-space.mjs（已验证）。滚动收集 space 页全部 BV → 逐条强播抓 m4s → ffmpeg 合并 + 断点续传。实测 UP「小仙若Rs_Cut」15 个视频全下（467 MB，0 失败）。SKILL.md 平台选择按 `/video/` 与 `space.bilibili.com` 分流路由。 |
| 2026-10-28 | 1.0.3 | 进化：新增 YouTube 平台 tools/youtube-video.mjs（已验证）。踩坑：googlevideo 直链 IP 绑定签名 → Node/页面/XHR/原生下载全 403；改用 MSE hook（addSourceBuffer/appendBuffer）抓浏览器实际缓冲的 audio+video 分片，增量 drain(base64) 落盘 + ffmpeg 合并。又踩：page.goto 等 load 会超时（改用 domcontentloaded）、标题要从 #video-title 的 title 属性取（不能用 shorts 链接自身文本）、大缓冲要增量 drain 否则卡死、最后 rename 漏 import。实测频道 @R-models/shorts 按"孙珍妮\|程儿\|敏敏"过滤下 12 个带声视频全成功（4.07 MB，0 失败）。 |
| 2026-10-28 | 1.0.4 | **高清修复**（用户反馈 360x640 太小）。根因：YouTube ABR 按播放器视口选分辨率，ego-browser 默认视口 ~355x631 → 只给 360p。修法三步：①打开页面前 `Emulation.setDeviceMetricsOverride(1920x1080)`；②轮询 `setPlaybackQuality`+`setPlaybackQualityRange` 并用 `getPlaybackQuality()` 校验真切换成功（一次调用常不生效）；③`__dropLowRes` 丢弃切换前低清分片。另：drain 目标从"块数最多"改为"累计字节最大"的 buffer；单视频链接（watch?v=/shorts/）走单条模式不再扫空；manifest 增 resolution 列。重下 12 个：2160x3840×4、1440x2560×1、1080x1920×7，共 91.3 MB，0 低清残留。**结论：yt-dlp 在本机不可用（需从 GitHub 下 ejs 求解器，域名被拦 + 无 SID 登录），MSE 方案是当前唯一可行且能拿 4K 的路子。** |
| 2026-10-29 | 1.0.5 | **头条高清修复 + 运行方式修正**。①高清：旧脚本取 `play_addr.url_list[0]`（默认档，常 480p）；改为合并 `play_addr_list[]` 与 `video_play_info.video_list[]`（后者带真实 `vwidth/vheight`），按 `[像素,码率,体积]` 取最高档，manifest 增 `resolution,bitrate`。②用户名：`[class*="name"]` 会先命中城市选择器 `span.ttp-city-selector-current-name`（拿到「西安」），改从 `document.title` 的 `^(.*?)的头条主页` 取。③验证无更高档：`fallback_api` 换 `ptoken=pgc_2160p/pgc_4k` 恒 200 但 `video_list` 空；单条页 `pc_profile_channel`(enable_dash=1) 也只到 1080p；页面内 fetch 该接口 CORS 失败。④`全部`/`小视频` tab 集合实测 `小视频 ⊆ 全部`（onlyShort=0），下小视频不漏。⑤运行方式：改用 `Start-Process cmd /c "... ego-browser.exe nodejs < 脚本.mjs"`，弃用 `-e`（PowerShell 丢引号）与直接 `&` 调用（编码重定向报错）；需 full-access。**实测「中国秀场」61 条全下：18×1080p(1080x1920) + 43×720p(720x1280)，109.1 MB，0 失败；ffprobe 逐条校验声明分辨率与实际一致 0 不符；重跑 skip=61 全跳过。** |
| 2026-10-29 | 1.0.6 | **「多档择优」从头条特例升级为全平台铁律**（用户明确要求：不能只限今日头条，所有网站都遵循）。抽出通用内核 `tools/_quality.mjs`（`defToHeight`/`scoreOf`/`byQualityDesc`/`pickBest`/`normCand`/`rankCands`/`BILI_QN`/`pickBiliDash`/`parseSrcset`/`guessImgWidth`/`imgGroupKey`/`originalImageUrl`/`pickBestImage`）+ 单测 `tools/test_quality.mjs`（32 例全绿）。**7 个平台脚本全部接入**：抖音合并 `bit_rate[]` + `play_addr{,_h264,_265,_bytevc1}` + `download_addr`；**B站改走 playurl API 取权威 dash 档位**；YouTube 档位排序不再硬编码、改走 `defToHeight`（`highres`→4320）；通用/小红书支持 `srcset` 全档 + 原图化归组取最大。**顺带修掉三个实测出来的真 bug**：①B站旧配方把 `-1-100026.m4s`（实为 AV1 视频流）当音频 → **成品全无声**（旧 15 个文件 15 个无音轨，新 15 个全部有声）；②图片 `naturalWidth` 对 SVG 虚高 → 40px 缩略图被当 2000w，改为 URL 内嵌尺寸优先；③页面相对 URL 未解析 → 107/170 张图下载失败，加 `new URL(u, location.href)`。**新踩坑**：cmd stdin 下脚本被当 `[eval2]`，相对 import 解析到 ego 安装目录 → 必须绝对 `file://` 动态 import + 同目录拷 `_quality.mjs`。**验证**：头条回归 skip=61（18×1080p/43×720p 不变）；维基百科 94 图 94 成功 0 失败、缩略图全换原图；B站单条 1920×1080 h264 有音轨；B站 UP 批量 15/15 全 1920×1080 有音轨 1018 MB。 |
| 2026-10-29 | 1.0.7 | **澄清沙箱/权限要求（修正 1.0.4 遗留的错误记录）**。旧记录写「运行时不能加 `sandbox_permissions`（审批已禁用）」——那是当年那次会话的临时状态，**是错的**，已删除。实测澄清：ego-browser 是 CLI，通过**命名管道**（`\\.\pipe\browser`、`\\.\pipe\mojo.CitroLabs.ego.<ver>`）连本机 ego lite daemon；DSH「仅可查看」「工作区内修改」都禁止打开命名管道 → `Failed to connect to ego_cli bootstrap`。**三种可行做法**：①会话「工作区内修改」+ 每条命令单次 `sandbox_permissions: danger-full-access`+`justification`（推荐，最小权限按需提权）；②会话切「完全权限」；③会话切「自动审查」（沙箱上等价于完全权限，额外多一层逐次模型审查 + 耗 token）。查证依据：`app.asar` 内 permission-presets 配置 `danger-full-access: {sandbox: danger-full-access, approval: never}`，以及 auto-review README「无沙箱运行」。 |
| 2026-10-29 | 1.0.8 | **新增第 8 个平台：X / Twitter（已验证·多档择优）** `tools/x-video.mjs`。核心发现：X 是 SPA，`<video>.src` 全是 `blob:` 抓不到直链；真正直链在 **GraphQL 响应的 `extended_entities.media[].video_info.variants[]`** 里，同一视频有 4 档 mp4（480x270 / 640x360 / 1280x720 / 1920x1080，路径含真实宽高 + `bitrate` 字段）。做法：**XHR + fetch 双钩子**抓所有 `/graphql/` 响应体 → 递归遍历 JSON 找 `video_info.variants` → `rankCands` 择优（跳过 `m3u8`）→ 最高档失败自动降级重试。图片用 `media_url_https + ?name=orig` 取原图。**新增 `--limit N` 参数**：X 媒体 ID 是雪花 ID（19 位），`BigInt` 降序 = 最新在前，`slice(0,limit)`。**实测 `x.com/Baobeinaibai/media`：解析出 90 条视频，取最新 10 条全部 1920×1080 / h264+aac / 4 分钟级，共 1.17 GB，10/10 成功 0 失败**（每条均"候选4档"选最高）。用户名取 `[data-testid="UserName"]` 首行「奶白迅猛龙」。 |
| 2026-10-29 | 1.0.9 | **新增第 9 个平台：91吃瓜网 91cg1.com（已验证）** `tools/91cg1-video.mjs`。①**结构**：标签页 `/tag/<标签>/` 列出全部 `a[href*="/archives/"]`（本例 22 篇、1/1 无分页）；文章页每篇 1~6 个 `<div class="dplayer" data-config="{...}">`，`video.url` 是 HLS `.m3u8`。`<video>.src` 是 `blob:`、`<script>` 里搜不到配置 → **只能读 `data-config` 属性**。②**档位**：m3u8 是 AES-128 加密单码率，本标签 34 个视频全 `nCand=1`（站点只给一档，正常）。③**下载器按用户给的 `kernel-video-sharing/crawler-91cg` 重写**：ts 分片 8 并发 + Node `crypto` 本地 AES-128-CBC 解密 + 分片级断点续传 + 连续 2 失败 fail-fast + 全齐拼接后 `ffmpeg -c copy`；同一条 688MB 视频 165s vs ffmpeg 直连 229s，且 ffmpeg 直连会出 `Stream ends prematurely`。④**踩坑**：`page.on("response")` 在 ego Page 上不存在（非 Playwright）→ 网络层抓包方案不可行；完整性校验的期望时长必须 Node 侧累加 `#EXTINF`（页面内 fetch 会 `Failed to fetch` 返回 0 → 校验静默失效）。⑤**实测**：`/tag/孙禾颐/` 22 篇 → **34 个视频 / 13.07 GB / 13.21 小时 / 0 失败 / 0 无音轨**；分辨率 720×1280×29、1080×1920×2、1280×720×2、1080×640×1；ffprobe 抽检 5 条声明分辨率与实际全部吻合。输出 `F:\linshi\孙禾颐\`（用户选定：G 盘仅剩 7.2GB 装不下 13GB）。 |
| 2026-10-29 | 1.0.10 | **引入 yt-dlp 作为第二引擎**（用户已装 yt-dlp 2026.10.26 并在 PATH）。架构定调：**ego-browser 管发现，yt-dlp 管下载**，两者不可互换——实测 yt-dlp 对 91cg1 页面 URL / douyin / toutiao / x.com/<user>/media 全部 `Unsupported URL`，对 YouTube 因 PO token 只返回 storyboard（带 cookies 也不行）。**落地 7 项**：①新增 `tools/_ytdlp.mjs` 内核（`findYtdlp`/`downloadWithYtdlp`/`probeWithYtdlp`/`isYtdlpFriendly`，显式 `-S res,br,size` 保持铁律）；②`91cg1-video.mjs` 改 yt-dlp 优先 + 自研分片器回退（`engine:auto|builtin`）——同一条 688MB 视频 **124s vs 165s，SHA256 完全一致**（721840587 bytes）；③`bilibili-video.mjs` 同样 yt-dlp 优先、playurl 回退，实测 1920×1080 有音轨 17s；④新增 `tools/ytdlp-media.mjs` 通用入口（1755 extractor），退出码 0=成功/已跳过、2=有错、3=不支持→降级 generic；⑤`generic-media.mjs` 发现 m3u8 时自动用 yt-dlp 下成真 mp4（旧版只把播放列表文本存成 .m3u8）；⑥新增 `tools/export-cookies-ytdlp.mjs` 解决 ego→yt-dlp 登录态桥接，**修掉 Netscape 格式 `domain_specified == initial_dot` 断言崩溃 bug**（flag 必须与 domain 前导点一致），实测 X 单条推文由此拿到 1080p；⑦**修掉 `generic-media.mjs` 启动即崩的 bug**：ego Page 无 `page.on` 也无 `addInitScript`，改用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入 fetch/XHR 钩子。**未做**：X 单条仍走原 GraphQL 方案（已可用，yt-dlp 无额外收益）、YouTube 保持 MSE（yt-dlp 走不通）。 |
