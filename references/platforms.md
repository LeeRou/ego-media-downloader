# 平台抓取配方（ego-media-downloader）

## 铁律：多档择优（**所有站点，无例外**）

> 任何站点、任何媒体，只要同一作品存在多个候选直链或多档清晰度，就必须把候选**全部**收集起来，
> 按「分辨率 → 码率 → 体积」降序取最高档。**绝不能拿第一个候选当成品。**

统一由 `tools/_quality.mjs` 实现，各平台脚本只负责「把该站所有档位来源塞进候选数组」，排序交给内核：

| 导出 | 用途 |
|---|---|
| `rankCands(rawList)` | 归一化 + 按 URL 去重 + 降序排序 |
| `pickBest(cands)` | 取最高档；真实宽高 > definition 文案 > 码率 > 体积 |
| `scoreOf(c)` / `byQualityDesc(a,b)` / `defToHeight(def)` | 底层评分与档位解析 |
| `pickBestImage(cands)` / `originalImageUrl(u)` / `parseSrcset(s)` / `guessImgWidth(u)` | 图片多档 |
| `pickBiliStreams(videoUrls, audioUrls)` / `BILI_QN` / `biliQnFromUrl(u)` | B站**猜 m4s 文件名**的旧方案（保留兼容，已非首选） |
| `pickBiliDash(videoList, audioList)` / `BILI_CODEC_PREF` | **B站首选**：playurl API 的 dash 数据择优（分辨率→编码偏好→码率） |

**各平台必须合并的档位来源**（漏一个就可能下到低清）：

- **头条**：`video.play_addr_list[]` + `video_play_info.video_list[]`（后者是 JSON 字符串，`video_meta` 带真实 `vwidth/vheight`）
- **抖音**：`video.bit_rate[]`（`gear_name`/`bit_rate`/`play_addr.url_list`）+ `play_addr` / `play_addr_h264` / `play_addr_265` / `play_addr_bytevc1` 各变体 + `download_addr`
- **B站**：hook 到的**全部** `.m4s`（按 qn 码表排序，见下），不能取第一条
- **YouTube**：`getAvailableQualityLevels()` 全部档位，按 `hd2160/hd1440/highres` 等标签解析高度后选最高
- **图片（小红书/通用）**：`srcset` 全部 `Nw` 档 + `src`/`data-src`/`data-original` + `naturalWidth`，先「原图化」再去重归组取最大

**为什么不能偷懒**：以下写法都会静默下到低清，且**不报错**，只能靠 ffprobe 事后才发现——
`play_addr.url_list[0]`（头条默认档常 480p）、`captured.video[0]`（B站首个请求档）、
`<video>.currentSrc` 当唯一来源（播放器可能仍在低档）、`<img>.src`（忽略 srcset）、
`srcset` 第一个（顺序不可靠）、带 `@1280w_1l` 后缀的缩略图 URL。

**验收**：`manifest.csv` 里必须有 `resolution`/`bitrate`（图片为 `Nw`）列；抽几条用 `ffprobe` 核对实际分辨率应等于声明值；
`_items.json` 里 `nCand` 是候选档数（=1 表示站点只提供单档，正常）。

每个配方是一个独立的 `.mjs`，由 ego-browser 运行时执行。脚本从**同目录的 `emd-config.json`** 读取配置（ego-browser 子进程可能读不到宿主 PowerShell 的 `$env:`，故不用 env）：

- `url` — 目标地址（主页 / 合集 / 单条）
- `out` — **最终输出文件夹路径**（已包含用户名或日期，工具只负责把媒体下进去，并确保该目录存在）
- `type` — `video` / `image` / `all`（视频类配方忽略它；图文/通用配方会用到）

运行方式（Windows / PowerShell，**实测可靠**）：
```powershell
# 1) 把对应脚本**和 `_quality.mjs`** 一起复制到任务目录
Copy-Item "C:\Users\LR\.agents\skills\ego-media-downloader\tools\_quality.mjs" "F:\linshi\ego-task\_quality.mjs" -Force
Copy-Item "C:\Users\LR\.agents\skills\ego-media-downloader\tools\toutiao-video.mjs" "F:\linshi\ego-task\toutiao-video.mjs" -Force
# 2) 写 emd-config.json（用 pwsh 的 Set-Content 写 UTF8 即可）
@{ url = "https://..."; out = "G:\我的云端硬盘\视频\用户名"; type = "video" } | ConvertTo-Json -Compress | Set-Content "F:\linshi\ego-task\emd-config.json" -Encoding UTF8
# 3) 运行：必须走 cmd stdin，不要用 -e
Start-Process -FilePath "cmd.exe" -ArgumentList @('/c','"C:\Program Files\Citro Labs\ego lite\Application\0.6.1.13\ego-browser.exe" nodejs < F:\linshi\ego-task\toutiao-video.mjs > F:\linshi\ego-task\out.txt 2> F:\linshi\ego-task\err.txt') -NoNewWindow -Wait
Get-Content F:\linshi\ego-task\err.txt -Tail 20   # ego-browser 的 console.log 走 stderr
```
**为什么不用 `-e`**：PowerShell 调原生程序会丢掉 `-e` 参数里的双引号，`await import(...)` 被拆成多段，报 `await is not defined` / `SyntaxError: Unexpected end of input`；包成 async IIFE 也救不回来。cmd 的 `<` 输入重定向把整个 `.mjs` 喂给 `nodejs`，无引号问题。
**为什么用 `Start-Process cmd /c`**：直接 `& ego-browser.exe ...` 会让 PowerShell 报 `StandardErrorEncoding is only supported when standard error is redirected` / `拒绝访问`。
**沙箱（重要）**：ego-browser 是 CLI，通过**命名管道**连本机 ego lite daemon（`\\.\pipe\browser`、`\\.\pipe\mojo.CitroLabs.ego.<ver>`）。DSH 的「仅可查看」「工作区内修改」两种受限模式都禁止程序打开命名管道 → 报 `Failed to connect to ego_cli bootstrap`。所以：
- **推荐**：会话保持「工作区内修改」，运行 ego-browser 那一条命令单独加 `sandbox_permissions: danger-full-access` + `justification`，用户点同意即可（最小权限，只在需要时提权）。
- **或者**：整个会话切「完全权限」/「自动审查」（两者都无沙箱；自动审查额外多一层逐次模型审查、耗 token，但沙箱权限上等价于完全权限）。
- 「仅可查看」下无法运行。
**中文只放文件内，绝不放进命令行参数。**
**`_quality.mjs` 必须与平台脚本同目录**：cmd stdin 模式下脚本被当作 `[eval2]` 执行，相对 `import` 会解析到 ego 安装目录，所以平台脚本用「绝对 `file://` 候选路径」动态 import；漏拷会报 `Cannot find module ...\_quality.mjs`。

---

## 一、抖音 Douyin（视频，已验证）

- 接口：`/aweme/v1/web/aweme/post`（页面用 XHR 请求，必须劫持 XHR，直接 `fetch` 会被拒）。
- 拦截方式：覆盖 `XMLHttpRequest.prototype.open/send`，在 `load` 事件里把 `aweme_list` 推入 `window.__aweme`。
- 翻页：页面 body 不滚动（`window.scrollY` 恒为 0）。**真正的滚动容器**是内部 `div.parent-route-container.route-sc`。每轮：
  1. 在页面里找出「`scrollHeight-clientHeight` 最大且 `<li>` 数量 ≥ 6」的元素；
  2. 设 `sc.scrollTop = sc.scrollHeight`，并派发 `new WheelEvent('wheel',{deltaY:5000,bubbles:true})`；
  3. 计数稳定（连续 N 轮无新增）或页面出现「暂时没有更多 / 没有更多了」文本 → 停止。
- **直链（多档择优）**：不要只取 `video.play_addr.url_list[0]`（默认档）。要合并三处来源：
  1. `video.bit_rate[]` —— 每个元素含 `gear_name`（清晰度标签）、`bit_rate`、`is_h265`、`play_addr.url_list[]`；**档位最全**；
  2. `video.play_addr` / `play_addr_h264` / `play_addr_265` / `play_addr_bytevc1` —— 各 codec 变体；
  3. `video.download_addr` —— 下载档，有时比 play 档高一档。
  全部塞进候选数组，交 `_quality.mjs` 的 `rankCands`/`pickBest` 排序（抖音多数档位无宽高，靠 `gear_name` 解析 + 码率兜底）。
- 兜底：若某条没任何直链，打开 `https://www.douyin.com/video/<vid>` 取 `<video>.currentSrc`（仅兜底，不是首选）。
- 下载头：`Referer: https://www.douyin.com/`、`User-Agent: Mozilla/5.0 ... Chrome/...`。
- 用户名提取（尽力而为）：`[data-e2e="user-info-nickname"]` / `.share-title` / `[class*="nickname"]` / `document.title` 的 `^(.+?)(?:的抖音|-\s*抖音)`；失败回退日期。

---

## 二、头条 Toutiao（视频，已验证 · 高清优先）

- 接口：`https://www.toutiao.com/api/pc/list/user/feed?category=pc_profile_short_video&token=<token>&max_behot_time=0`，**带 `msToken` + `a_bogus` 签名**。
- `has_more` 一般不可信，**手动重放签名 XHR 也会失败**。所以不要靠游标翻页，改为「自然滚动触发页面自己的请求」。（2026-10-29 实测该账号 `has_more` 恰好可信：[true,true,true,false]，但不要依赖。）
- 拦截方式同抖音，筛选 URL 含 `pc_profile_short_video`，把响应 JSON 推入 `window.__feeds`。
- 翻页：滚动到真实容器底部（找 `scrollHeight-clientHeight` 最大且 `<li>` ≥ 6 的元素）+ 派发 wheel 事件；连续 8–10 轮 DOM 视频链接数稳定即停。
- **【重要】高清：不要只取 `play_addr.url_list[0]`** —— 那是默认档，常常只是 480p。要合并两个来源并按分辨率排序取最高：
  1. `it.video.play_addr_list[]`：每档 `{definition, bitrate, size, vtype, play_url_list[0]}`，**没有宽高**，只能用 `definition`（1080p/720p/540p/480p）排序。
  2. `it.video_play_info`（**是 JSON 字符串，要 `JSON.parse`**）→ `.video_list[]`：每档 `main_url` + `.video_meta{definition, vwidth, vheight, bitrate, size, fps}`，**有真实宽高**，排序最准。
  - 排序键：`[vwidth*vheight, bitrate, size]` 降序；无宽高时用 `definition` 映射成像素近似值。
  - 实测该账号 61 条：18 条有 1080p（1080x1920）、43 条最高只有 720p（720x1280）。**站上不存在 >1080p 的档**（源 2160x3840 的条目，可选档也只有 1080p/720p）。
- 兜底：某条没直链时打开 `https://www.toutiao.com/video/<vid>/` 取 `<video>.currentSrc`（单条页走 xgplayer，直接给可下载的 mp4）。
- 下载头：`Referer: https://www.toutiao.com/`、`User-Agent: Mozilla/5.0 ... Chrome/...`。
- **用户名提取**：`document.title` 的 `^(.*?)的头条主页` —— 最可靠。**不要**用 `[class*="name"]`：它会先命中城市选择器的 `span.ttp-city-selector-current-name`（如「西安」）。
- 失败/无效的路子（别再试）：
  - `video_play_info.fallback_api.fallback_api` 换 `ptoken=pgc_2160p/pgc_4k/...` → 恒返回 200 但 `video_list` 为空。
  - 单条页的 `pc_profile_channel` feed（`enable_dash=1`）→ 档位仍只到 1080p，`hasDash` 为 false。
  - 页面内 `fetch` fallback_api → CORS `Failed to fetch`；Node 侧 `fetch` 可通但同样空结果。
- `tab` 说明：`全部` 与 `小视频` 两个 tab 的视频集合，实测 `小视频` 是 `全部` 的子集（61 ⊂ 61，`onlyShort=0`），所以下 `小视频` 不会漏。

---

## 三、小红书 Xiaohongshu（图文 + 视频，尽力而为，未实测）

- 站点强反爬 + 登录墙，需复用已登录会话。
- 笔记页：打开单条或主页，滚动加载，从页面里读取笔记数据（笔记 JSON 通常挂在 `window.__INITIAL_STATE__` 或 DOM 的 `data-xhs-...` / `<img data-src>` / `<video src>`）。
- 图片：优先 `data-src`，其次 `src`；过滤占位图（含 `xhscdn` 的封面缩略图按原图 URL 取）、`@` 尺寸后缀可去掉拿原图。
- 视频：`<video>` 的 `src` / `currentSrc`；或笔记 JSON 里的 `video.media.stream.h264[].master_url`。
- 主页批量：滚动到底 + 稳定检测；从 `a[href*="/explore/"]` / `/user/profile/` 卡片收集笔记链接，再逐条进笔记页取媒体。
- 失败常见原因：登录失效、滑块验证、接口加密。遇到即停并报告，不要硬闯。

---

## 三（续）、哔哩哔哩 Bilibili（视频，已验证 · 多档择优）

- 适用：单条视频页 `bilibili.com/video/BVxxxx`，或 UP 主投稿页（批量下见下）。
- **【首选方案】走 playurl API 拿权威档位**（2026-10-29 实测，取代早期的「猜 .m4s 文件名」）：
  ```js
  // 页面内执行，credentials:include 带上登录态
  const s = window.__INITIAL_STATE__ || {};
  const bvid = s.bvid || s.videoData?.bvid;
  const cid  = s.cid  || s.videoData?.cid;
  const r = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1`, { credentials: "include" });
  const d = (await r.json()).data;
  d.dash.video  // [{ id(qn), baseUrl, backupUrl[], bandwidth, width, height, codecid, frameRate }]
  d.dash.audio  // [{ id(30216/30232/30280), baseUrl, bandwidth }]
  d.dash.dolby.audio  // 杜比音轨（有时比普通音频码率高）
  d.accept_description // ["高清 1080P60","高清 1080P",...] 人类可读档位
  ```
  排序用 `pickBiliDash(video, [...audio, ...dolby])`：**分辨率(宽*高) → 编码偏好(H.264>HEVC>AV1) → 码率**；
  音频按码率降序、同码率偏好 `30280 > 30232 > 30216`。
- **【严重坑】不要靠 .m4s 文件名猜 codec**：
  - `-1-100026.m4s` 是 **AV1 视频流**（codecid 13），**不是音频**；
  - `30232` / `30280` / `30216` 才是音频（132k/192k/64k）；
  - 早期配方把 `100026` 当音频、`30232` 当视频 → 结果**成品完全没有音轨**（实测 15 个文件全无声）。现已弃用该方案。
- 视频流 qn 有两种写法：纯 qn（`-1-80.m4s`）和 **30000 偏移**（`-1-30080.m4s` = qn 80）；`biliQnFromUrl` 两种都认，但仍以 playurl 的 `id` 为准。
- 合并：选中的 video + audio 用 ffmpeg `-c copy` 合并——不合并会得到无声文件。
- **必做校验**：合并后用 ffprobe 检查 `codec_type` 同时含 `video` 和 `audio`，把 `hasAudio` 写进 manifest。
- 下载头：`Referer: https://www.bilibili.com/`、`Origin: https://www.bilibili.com`、`User-Agent: Mozilla/5.0`；
  `baseUrl` 失败时用 `backupUrl[0]` 重试。
- 用户名提取：`.up-name` 或 `#INITIAL_STATE__` 的 `upData.name` / `videoData.owner.name`；
  视频 id 用 URL 里的 `BVxxxx`；UP 的 mid 可从 `a[href*="space.bilibili.com"]` 取。
- manifest 列：`index,vid,title,file,bytes,resolution,qn,codec,hasAudio`。
- 失败：未登录/地区限制/付费内容时 `dash` 为空 → 报告需登录。

### UP 主投稿批量（tools/bilibili-space.mjs）
- 打开 `space.bilibili.com/<mid>` → 点「投稿/视频」标签 → 滚动加载全部卡片 → 收集所有 `BVxxxx`（DOM 卡片 `a[href*="/video/BV"]`）。
- 逐个 `bilibili.com/video/<BV>`：取 `bvid/cid` → 调 playurl → `pickBiliDash` 择优 → ffmpeg 合并 → 落盘（已存在跳过=断点续传）。
- **实测（2026-10-29）**：UP「小仙若Rs_Cut」15 个视频，全部 1920×1080、**全部有音轨**、1018 MB、0 失败；
  每个视频的 qn 候选数 8~12 个（同分辨率还有 h264/hevc/av1 三档），说明择优确实在起作用。
  对比：旧脚本下同样 15 个文件**全部无音轨**。

---

## 三（续）、YouTube（已验证）

- 适用：频道页（`/@handle`、`/@handle/shorts`、`/channel/...`）、播放列表、`/watch` 单条。支持过滤：emd-config.json 加 `"filter":"关键词1|关键词2"`（按视频标题含关键词筛选；空=全下）。
- **关键发现**：YouTube 的 `googlevideo.com/videoplayback` 直链是 **IP 绑定的签名 URL**——Node 侧 `fetch`、页面 `fetch`、XHR、甚至原生下载都被 403 拒绝（URL 里嵌了 `ip=`）。但浏览器自己的 `<video>`（走 MSE）能正常收到音视频分片。
- **解法（MSE 抓取法，已验证可行）**：hook `MediaSource.prototype.addSourceBuffer` 与 `SourceBuffer.prototype.appendBuffer`，把浏览器实际缓冲的 video/audio 分片收集进 `window.__bufs`（按 mime 区分 audio/webm、video/mp4）。再 `window.__drain(kind)` 增量 pop（每批≤20块、base64 传回 Node 落盘，避免大缓冲卡死页面）。全部缓冲完成后用 **ffmpeg 合并** `_v.m4s` + `_a.m4s`（`-c copy`）。
### 【重要】拿到真高清（最大坑）
- **根因**：YouTube 的 ABR 按【播放器可视窗口大小】选分辨率。ego-browser 默认视口只有 ~355×631，于是只给 **360×640** 的流——文件小、模糊，就是这个问题。
- **解法三步**（缺一不可）：
  1. **打开页面前先放大视口**：`Emulation.setDeviceMetricsOverride({width:1920,height:1080,mobile:false})`。
  2. **反复强制最高清晰度直到生效**：读 `movie_player.getAvailableQualityLevels()` 拿**全部**档位，按 `defToHeight` 解析标签高度（`highres`/`hd4320`→4320、`hd2160`→2160、`hd1440`→1440、`hd1080`→1080、`hd720`→720）降序取最高（不再硬编码档位顺序），调 `setPlaybackQuality(q)` + `setPlaybackQualityRange(q,q)`；**并用 `getPlaybackQuality()` 校验真的切过去了，没切就重试**（一次调用常常不生效，会继续 ABR 给低清）。
  3. **丢弃切换前积累的低清分片**（`__dropLowRes`：只保留最后新建的 video buffer），再开始 drain。
- 实测效果：同一批 shorts，360×640 → 2160×3840 / 1440×2560 / 1080×1920，体积从 0.3MB 涨到 2~29MB。
- 注意：YouTube 用**多**个 SourceBuffer（ABR 切换清晰度会新建 buffer），取每个 kind 里**累计字节最大**的那个（= 最高清晰度），不是块数最多。
- 标题提取：卡片 `#video-title` 的 `title` 属性（或卡片整体文本）；注意不能用 `a[href*="/shorts/"]` 自身的 textContent（它是缩略图，无标题）。
- 翻页/加载：滚动到底 + 稳定检测；`page.goto` 用 `waitUntil:"domcontentloaded"`（YouTube 播放页 load 事件 30s 内常不触发，等 load 会超时）。
- 失败：登录墙/地区限制/风控时缓冲为空 → 报告。

---

## 三（续）、X / Twitter（视频 + 图片，已验证 · 多档择优）

- 适用：`x.com/<user>/media`（媒体页）、用户时间线、单条推文。
- **核心机制**：X 是 SPA，`<video>.src` 全是 `blob:`，**抓不到直链**。真正的直链在 **GraphQL 响应的 `extended_entities.media[].video_info.variants[]`** 里。
- **抓取方式**：注入 **XHR + fetch 双钩子**，把所有 `/graphql/` 响应体存进 `window.__xApi`；滚动加载到底（稳定检测 8 次），然后**递归遍历 JSON**，找 `video_info.variants` 与 `type==='photo'`。
- **多档择优（关键）**：`variants` 里同一视频有 4 档 mp4（`480x270` / `640x360` / `1280x720` / `1920x1080`，路径里带真实宽高，`bitrate` 字段也有）。必须**全部收集**交给 `rankCands()` 择优——只取 `variants[0]` 会拿到最低档。`content_type` 含 `m3u8` 的跳过（那是 HLS 播放列表不是文件）。
- **图片**：`media_url_https` + `?name=orig` 拿原图（`name=large` 是 1024 缩略、`name=orig` 才是原始尺寸）。
- **取最新 N 条**：X 媒体 ID 是**雪花 ID**（19 位数字），**数值越大越新**。按 `BigInt(key)` 降序即"最新在前"，再 `slice(0, limit)`。
- **文件名**：`NNN_<媒体ID>.mp4`；`<媒体ID>` 从 `amplify_video/<id>` 或 `ext_tw_video/<id>` 里正则提取。
- 用户名：`[data-testid="UserName"]` 的首行文本（如「奶白迅猛龙」），拿不到回退 URL slug。
- 实测：`x.com/Baobeinaibai/media` 取最新 10 条，全部 **1920×1080 / h264+aac / 4 分钟级**，共 1.17 GB，10/10 成功。
- 注意：X 单页滚动有上限，媒体特别多时需反复滚动较久；`__xApi` 会累积几十个响应，遍历时注意去重（用媒体 ID 做 key）。

---

## 四、91吃瓜网 91cg1.com（视频，已验证 · 批量 + 分片并发）

- 适用：`91cg1.com/tag/<标签>/`（标签专题页，一页列全部文章）、`91cg1.com/archives/<id>/`（单篇文章）。
- **页面结构**：标签页里文章链接是 `a[href*="/archives/"]`；本标签 22 篇、分页显示 `1/1`（无分页）。文章页每篇 1~6 个
  `<div class="dplayer" data-config="{...}">`，JSON 里的 `video.url` 是 HLS `.m3u8`（`type:"hls"`）。
  ⚠️ `<video>` 元素的 `src` 是 **`blob:`**，`<script>` 里也搜不到播放器配置（配置在 `data-config` **属性**里，不是 JS 变量），
  所以只能 `JSON.parse(el.getAttribute("data-config"))`，别去爬 `window.DPlayer`。
- **档位**：m3u8 是 **AES-128 加密的单码率 playlist**（`#EXT-X-KEY:METHOD=AES-128,URI=".../crypt.key?auth_key=..."` + `.ts` 分片），
  实测本标签 34 个视频**全部 nCand=1**（站点只给一档）。仍按铁律实现：若 master playlist 出现 `#EXT-X-STREAM-INF`，
  全收 `RESOLUTION`/`BANDWIDTH` 交 `rankCands`/`pickBest` 择优后再递归。
- **签名过期**：`auth_key` 是时间签名（约 1~2h）。**每次下载前现场重新读 `data-config`**，绝不缓存 URL；
  分片 403 时重新 `page.goto` 文章页拿新 m3u8 再续传。
- **下载器（关键，别只用 ffmpeg 直连）**：参考 `github.com/kernel-video-sharing/crawler-91cg` 的成熟做法——
  ts 分片 **8 并发** + Node `crypto` **本地 AES-128-CBC 解密** + 落盘 `_tmp_NNN/ts/NNNNNN.ts`：
  1. **断点续传**：已存在且非空的分片直接跳过（比 ffmpeg 单流重下强得多）；
  2. **fail-fast**：连续 2 个分片失败即中止本视频，保留已下分片，下次续传；
  3. 全齐后按序拼接 → `ffmpeg -c copy -bsf:a aac_adtstoasc` 封装 mp4 → 删临时目录。
  IV 规则：playlist 显式给了 `IV=0x...` 就用；没给则按 HLS 规范用**分片序号**作 16 字节大端 IV。
  实测：688MB/39 分钟的视频 165s 下完（8 并发），纯 ffmpeg 直连同一条要 229s 且中途出现 `Stream ends prematurely`。
- **完整性校验**：`exp` 时长要用**解析 m3u8 的 `#EXTINF` 累加**得到（页面内 `fetch` 求和在部分页面会 `Failed to fetch` 返回 0，
  导致校验被跳过）；成品 `ffprobe` 时长 < playlist 时长 ×0.9 判为不完整并重试。
- **用户名**：从标签页 `h1` / `document.title` 的「XXX - 最新爆料与原创精选 | 91吃瓜网」取标签名（本例「孙禾颐」）。
- 脚本：`tools/91cg1-video.mjs`。实测本标签 22 篇 → **34 个视频 / 13.07 GB / 13.21 小时，0 失败、0 无音轨**；
  分辨率分布 720×1280×29、1080×1920×2、1280×720×2、1080×640×1（站点本身只提供这些档，非择优失败）。
- **yt-dlp 加速（1.0.10 起）**：同一套 m3u8 交给 `yt-dlp -N 16 -S res,br,size` 更快——688MB 那条
  **117.8s vs 自研 165s**，且产物 **SHA256 完全一致**（721840587 bytes）。脚本默认 `engine=auto`
  先试 yt-dlp，产物不完整/失败自动回退自研分片器；`"engine":"builtin"` 可强制走自研（调试用）。
  两条路都经过实测验证。

---

## 六、yt-dlp 通用入口（其它站点第一顺位）

- 脚本：`tools/ytdlp-media.mjs`，内核：`tools/_ytdlp.mjs`。
- 用途：把 URL 直接交给 yt-dlp 的 1755 个 extractor；覆盖 Vimeo/TikTok/大量自建 m3u8 站等。
- **定位**：ego-browser 负责发现，yt-dlp 负责下载。**不要让 yt-dlp 做发现**——抖音/头条/91cg1/X 媒体页/YouTube 全部实测失败。
- 参数：`-S res,br,size`（= 分辨率→码率→体积，与铁律等价）、`-N 16`（分片并发）、
  `--download-archive`（跨次去重）、`--merge-output-format mp4`、`-f bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b`。
- 退出码：`0`=成功或已全部跳过（`ALL_SKIPPED`）；`2`=有报错；`3`=不支持/无产出 → 调用方降级到 generic。
- 批量：URL 是频道/播放列表时 yt-dlp 自己翻页枚举（`--yes-playlist`）；`"playlist":false` 强制只下单条；
  `limit` → `--playlist-end`；`filter` → `--match-filter "title ~= \"...\""`。
- manifest 由脚本扫新文件 + `ffprobe` 生成（不信任工具自报）。

### cookie 桥（ego 登录态 → yt-dlp）

- yt-dlp 的 `--cookies-from-browser` **读不了 ego 的 profile**：
  `Could not copy Chrome cookie database`（ego 自己的加密/锁 + Chromium Cookies sqlite 运行中独占）。
- 正解：`tools/export-cookies-ytdlp.mjs` 用 ego CDP `Network.getCookies` 拿明文，写成 Netscape 文件，
  再 `yt-dlp --cookies <file>`。实测 X 单条推文由此拿到 1080p。
- ⚠️ **Netscape 格式铁律**：第 2 列 flag 必须与 domain 是否带前导点**严格一致**（带 `.` → `TRUE`）。
  否则 python `http.cookiejar` 断言 `domain_specified == initial_dot` 失败，yt-dlp 直接崩。这是旧脚本的原有 bug，已修。

---

## 五、通用站点 Generic（多档择优，尽力而为）
- 适用：任意未在上面列表里的网站；也用于「单条媒体直链 / 单条帖子」。
- **视频择优**：一个 `<video>` 的**全部** `<source src>` + `currentSrc` 都是同一作品的不同档，必须全收进候选，
  按 `height` / `label`(data-quality) / 码率择优；`<a href="*.mp4/webm/m3u8/mov">` 直链也作为候选。
- **m3u8 处理（1.0.10 起）**：发现 `.m3u8` 时**自动调用 yt-dlp 下成真 mp4**，不再把播放列表文本存成成品
  （旧行为产出无法播放的 `.m3u8` 文件，只在末尾提示用户自己处理）。
- **图片择优**：
  1. `srcset` 的**全部** `Nw` / `Nx` 档（顺序不可靠，必须按描述符排序）；
  2. `src` / `data-src` / `data-original` / `data-actualsrc` / `data-lazy-src` / `naturalWidth`；
  3. **原图化**：去掉 `@1280w_1l_2o_100sh` 这类尺寸后缀、`_640x480` 这类尺寸段；
  4. 同一张图的不同尺寸按「原图 URL」归组，组内取宽度最大。
- 内联 `background-image:url(...)`、图片型 `<a href="*.jpg/png/webp/gif/avif">` 也收。
- 去重（按 URL 规范化，去掉 query 里易变的尺寸/签名参数后再判重）。
- 逐条下载：浏览器 UA + 探测到的 `Referer`（同源）；`<512` 字节视为坏响应。
- manifest 列：`index,type,file,bytes,quality`（视频写 `720p` 之类，图片写 `1920w`）。
- **网络层捕获**：ego 的 Page **没有** `page.on("response")`（调用即 `TypeError: page.on is not a function`）。
  改用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入 fetch/XHR 钩子，把 URL 收集到 `window.__emdNet` 再 drain。
  这是 1.0.10 修掉的崩溃 bug（旧版 generic 脚本一启动就崩）。
- 局限：签名直链、登录墙、DRM、需要 JS 解密的站点会失败——属预期，报告即可。

---

## 通用纪律

- **多档择优（铁律）**：见文首。所有脚本必须走 `_quality.mjs`，不得自己取 `[0]`。
- **断点续传**：下载前 `existsSync(outPath)`，存在则跳过。
- 文件名：`NNN_<id>.<ext>`（保留 URL 扩展名，缺省 `.mp4`/`.jpg`）。
- 每轮产出 `manifest.csv`（视频含 `resolution,bitrate`，图片含 `quality` 宽度）与 `_items.json`（含 `nCand`/`allDefs` 供核验）。
- 登录态失效不要绕过；签名直链每次现场重取。
- 不安装外部 dsh-video-downloader；登录/翻页/发现全部交给 ego-browser。
- **改动 `_quality.mjs` 后必须跑单测**：`cd tools; node test_quality.mjs`（26 例全绿才算通过）。

---

## 演化日志（每次进化追加一条）

| 日期 | 版本 | 变更 | 影响平台 |
|---|---|---|---|
| 2026-10-28 | 1.0.0 | 初版：抖音视频、头条小视频（已验证）、小红书图文/视频与通用扫描（尽力而为）。确立「自动进化」机制。 | 全部 |
| 2026-10-29 | 1.0.5 | 头条配方升级为**高清优先**：直链不再取 `play_addr.url_list[0]`，改为合并 `play_addr_list[]` + `video_play_info.video_list[]`（后者带真实 vwidth/vheight）按 `[像素, 码率, 体积]` 取最高档；manifest 增 `resolution,bitrate` 列。用户名改从 `document.title` 的 `^(.*?)的头条主页` 提取（`[class*="name"]` 会误命中城市选择器）。记录三条无效高清路子（fallback_api 换 ptoken、detail 页 pc_profile_channel dash、页面内 fetch CORS）。实测「中国秀场」61 条：18×1080p + 43×720p，109 MB，0 失败，重跑全跳过。 | 头条 |
| 2026-10-29 | 1.0.6 | **「多档择优」升级为全平台铁律**（用户要求：不能只限头条）。抽出通用内核 `tools/_quality.mjs` + 单测 `test_quality.mjs`。**7 个平台脚本全部接入内核**：抖音合并 `bit_rate[]`+各 `play_addr_*`+`download_addr`；B站改走 playurl API 取权威 dash 档位；YouTube 档位排序不再硬编码、改走 `defToHeight`；通用/小红书支持 `srcset` 全档 + 原图化归组取最大。**同时修掉 B站致命老 bug**：旧配方把 `-1-100026.m4s`（实为 **AV1 视频流** codecid 13）当音频、把 `30232`（实为 132k 音频）当视频，导致成品**完全没有音轨**——实测旧脚本 15 个文件 15 个无声，新脚本 15 个全部有声。**新增踩坑**：cmd stdin 模式下脚本被当作 `[eval2]` 执行，相对 `import` 解析到 ego 安装目录 → 必须绝对 `file://` 动态 import，`_quality.mjs` 要与平台脚本一起拷到任务目录。**验证**：头条回归 skip=61（18×1080p/43×720p 不变）；通用站点（维基百科）94 张图 94 成功 0 失败、缩略图全部替换为原图；B站单条 1920×1080 h264 有音轨；B站 UP 批量 15/15 全 1920×1080 有音轨 1018MB。 | 全部 |
| 2026-10-29 | 1.0.9 | **新增第 9 个平台：91吃瓜网 91cg1.com（已验证）** `tools/91cg1-video.mjs`。核心发现：播放器配置在 `<div class="dplayer" data-config="...">` **属性**里（`<video>.src` 是 `blob:`、`<script>` 里搜不到），只能 `JSON.parse(getAttribute("data-config"))` 拿 `video.url`（HLS）。m3u8 是 **AES-128 加密单码率**（`crypt.key` + `.ts`），`auth_key` 约 1~2h 过期 → 每次现场重取。**下载器参照用户给的 `kernel-video-sharing/crawler-91cg` 重写**：ts 分片 8 并发 + Node `crypto` 本地 AES-128-CBC 解密 + 分片级断点续传 + 连续 2 失败 fail-fast，全齐后拼接再 `ffmpeg -c copy` 封装——比纯 ffmpeg 直连快 30%（165s vs 229s / 688MB）且能续传。**踩坑**：完整性校验的期望时长必须用 m3u8 `#EXTINF` 累加（页面内 fetch 求和会 `Failed to fetch` 返回 0 → 校验被跳过）；`page.on("response")` 在 ego Page 上**不存在**（非 Playwright），网络层抓包方案不可用，候选只能来自 `data-config` + master playlist。实测本标签 22 篇 → **34 个视频 / 13.07 GB / 13.21 小时 / 0 失败 / 0 无音轨**，ffprobe 抽检 5 条声明分辨率全部吻合。 | 91cg1 |
| 2026-10-29 | 1.0.10 | **引入 yt-dlp 作为第二引擎**（用户已装 yt-dlp 2026.10.26 并在 PATH）。架构定调：**ego-browser 管发现，yt-dlp 管下载**，两者不可互换——实测 yt-dlp 对 91cg1 页面/抖音/头条/X 媒体页全部 Unsupported，对 YouTube 因 PO token 只返回 storyboard。**具体落地**：①新增 `tools/_ytdlp.mjs` 内核（`findYtdlp`/`downloadWithYtdlp`/`probeWithYtdlp`/`isYtdlpFriendly`，显式 `-S res,br,size` 保持铁律）；②`91cg1-video.mjs` 改为 yt-dlp 优先、自研分片器回退（`engine:auto|builtin`）——同一条 688MB 视频 **124s vs 165s，SHA256 完全一致**；③`bilibili-video.mjs` 同样 yt-dlp 优先、playurl 回退，实测 1920×1080 有音轨 17s；④新增 `tools/ytdlp-media.mjs` 通用入口（1755 extractor），退出码 0/2/3 供降级判断；⑤`generic-media.mjs` 发现 m3u8 时自动用 yt-dlp 下成真 mp4（旧版只存播放列表文本）；⑥新增 `tools/export-cookies-ytdlp.mjs` 解决 ego→yt-dlp 登录态桥接，**修掉 Netscape 格式 `domain_specified == initial_dot` 断言崩溃 bug**（flag 必须与 domain 前导点一致），实测 X 单条推文由此拿到 1080p；⑦**修掉 `generic-media.mjs` 的启动崩溃 bug**：ego Page 无 `page.on("response")`，改用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入 fetch/XHR 钩子。 | 全部 |

---

## 跨会话记忆（EVOLUTION.md）

本 skill 的长期状态与演化记忆落在 **`EVOLUTION.md`**（与 SKILL.md 同级）。新会话加载本 skill 时应先读该文件回读最新状态，避免从零摸索。
（本环境 Hindsight 后端无鉴权不可用，故状态直接落在本文件内，不依赖外部记忆服务。）

当前已沉淀的关键认知（也见上方各平台小节）：
- 抖音：XHR 劫持 `aweme/v1/web/aweme/post`；真滚动容器 `div.parent-route-container.route-sc`；直链 `video.play_addr.url_list[0]`。**已验证**。
- 头条：XHR 劫持 `pc_profile_short_video`；靠自然滚动稳定检测翻页；**高清要合并 `play_addr_list` + `video_play_info.video_list`（后者带真实宽高）取最高档，默认 `play_addr.url_list[0]` 常只是 480p**；用户名从 `document.title` 的「XXX的头条主页」取。**已验证**。
- 通用坑：ego-browser 子进程读不到宿主 `$env:`，必须用 `emd-config.json`；运行时要能开命名管道（受限沙箱下会连不上 bootstrap，见上文「沙箱」）。
- **ego-browser 调用方式（Windows）**：`ego-browser` 在 PATH 上的软链从沙箱里跑会「拒绝访问 / Failed to connect to ego_cli bootstrap」，且 PowerShell 的 `&` 调用会因为编码重定向报错。可靠做法：用 `Start-Process cmd.exe /c "... ego-browser.exe nodejs < 脚本.mjs > out 2> err"`，脚本走 **cmd stdin**（`nodejs < file.mjs`）而不是 `-e`（`-e` 会被 PowerShell 拆引号 / 报 `await is not defined`）。
- 未实测：小红书（强反爬）、任意站点通用扫描——失败多为登录/滑块/签名，属预期。

