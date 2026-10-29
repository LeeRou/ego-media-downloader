# ego-media-downloader

用 **ego-browser**（复用你已登录的浏览器会话）自动下载网页上的视频 / 图片，并在目标目录里
以博主用户名建文件夹归档。支持整页/主页批量下载与单条媒体链接。

**所有网站统一遵循「多档择优」**：同一作品只要存在多档清晰度或多个候选直链，就全部收集后
按 `分辨率 → 码率 → 体积` 降序取最高档，**绝不取第一个候选**。

---

## 双引擎架构

本 skill 有两条腿，职责严格分开：

| 引擎 | 负责 | 不可替代性 |
|---|---|---|
| **ego-browser** | 开页面、复用登录态、绕反爬、翻页枚举、从 DOM/属性/JS 里**发现**真实媒体地址 | 抖音/头条/91cg1/X 媒体页/YouTube 只能靠它发现 |
| **yt-dlp**（可选，装了就自动用） | 把**已知的媒体地址或原生支持的站点**下成成品（分片并发、AES 解密、音轨合并、断点续传） | 更快，且原生支持上千站点 |

> **核心原则：让 yt-dlp 做下载，不要让 yt-dlp 做发现。**
> 实测 yt-dlp 对 91cg1 页面 URL / 抖音 / 头条 / X 媒体页全部 `Unsupported URL`，
> 对 YouTube 因 PO token 只返回 storyboard。yt-dlp 不可用时自动回退自研方案。

---

## 安装

### 1. 放置 skill

把本目录放到 agent 的 skills 目录，例如：

```
C:\Users\<你>\.agents\skills\ego-media-downloader\
```

### 2. 依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| **ego-browser（ego lite）** | **必需** | 所有平台发现都靠它；且必须能在**无沙箱**下运行（它通过命名管道连本机 daemon） |
| **ffmpeg / ffprobe** | **必需** | 音视频合并与成品校验；脚本默认找 `C:\ffmpeg\bin\` |
| **yt-dlp** | 可选 | PATH 里有就自动启用加速；没有则全程走自研方案 |
| **Node.js** | 必需 | ego-browser 自带运行脚本能力，无需另装 |

改动 `tools/_quality.mjs` 后必须跑单测：

```powershell
cd tools
node test_quality.mjs    # 32 例全绿才算通过
```

---

## 用法

```
/ego-media-downloader <url> [--dir 目录] [--type video|image|all] [--name 用户名] [--limit N]
```

- `<url>`：创作者主页 / 合集页 / 标签页，或单条媒体、帖子链接
- `--dir`：显式指定根目录（给了它时视频和图片都进 `<dir>/<用户名>/`）
- `--type`：`video` / `image` / `all`（默认 `all`）
- `--name`：强制覆盖自动识别的博主名
- `--limit`：只下最新 N 条

不给 `--dir` 时默认输出到：

- 视频：`G:\我的云端硬盘\视频\<用户名>\`
- 图片：`G:\我的云端硬盘\图片\<用户名>\`

---

## 已支持平台

| 平台 | 脚本 | 状态 |
|---|---|---|
| 抖音 | `tools/douyin-video.mjs` | 已验证 · 多档择优 |
| 今日头条 | `tools/toutiao-video.mjs` | 已验证 · 多档择优 |
| 哔哩哔哩（单条） | `tools/bilibili-video.mjs` | 已验证（yt-dlp 优先 + playurl 回退） |
| 哔哩哔哩（UP 批量） | `tools/bilibili-space.mjs` | 已验证 |
| YouTube | `tools/youtube-video.mjs` | 已验证（MSE 方案，可拿 4K） |
| X / Twitter | `tools/x-video.mjs` | 已验证 · 多档择优 |
| 小红书 | `tools/xiaohongshu-media.mjs` | 尽力而为 |
| 91吃瓜网 | `tools/91cg1-video.mjs` | 已验证（yt-dlp 优先 + ts 分片回退） |
| 其它站点 | `tools/ytdlp-media.mjs` → `tools/generic-media.mjs` | yt-dlp 优先，兜底 DOM 扫描 |

---

## 运行方式（Windows，实测可靠）

ego-browser 必须走 cmd 的 stdin 重定向，且需要**无沙箱**（要走命名管道）：

```powershell
Start-Process -FilePath "cmd.exe" -ArgumentList @('/c','"...\ego-browser.exe" nodejs < F:\path\to\<脚本>.mjs > out.txt 2> err.txt') -NoNewWindow -Wait
```

- **不要用 `-e`**：PowerShell 会丢双引号，`await import(...)` 被拆散
- **不要直接 `& ego-browser.exe`**：报 `StandardErrorEncoding is only supported...`
- ego-browser 的 `console.log` 输出走 **stderr**，读 `err.txt`
- **中文只放文件内**，绝不放进命令行参数

配置走脚本同目录的 `emd-config.json`（ego-browser 子进程读不到宿主 `$env:`）：

```json
{
  "url": "目标地址",
  "out": "输出文件夹绝对路径",
  "type": "video",
  "limit": 0,
  "filter": "可选的正则关键词"
}
```

可选字段：`engine: "auto" | "builtin"`（是否用 yt-dlp 加速）、`cookies`（Netscape cookie 文件）、
`playlist: false`（只下单条）、`cookiesFor` / `cookiesOut`（给 cookie 导出脚本用）。

---

## 登录态桥接（ego → yt-dlp）

yt-dlp 的 `--cookies-from-browser` **读不了 ego 的 profile**（会报 `Could not copy Chrome cookie database`）。
用 `tools/export-cookies-ytdlp.mjs` 走 ego CDP 导出 Netscape 格式，再交给 yt-dlp：

```json
{"cookiesFor": ["https://x.com/"], "cookiesOut": "F:\\linshi\\ego-task"}
```

```powershell
yt-dlp --cookies F:\linshi\ego-task\ck-x.com.txt ...
```

> ⚠️ Netscape 格式里第 2 列 flag 必须与 domain 是否带前导点**严格一致**（带 `.` → `TRUE`），
> 否则 python `http.cookiejar` 断言 `domain_specified == initial_dot` 失败，yt-dlp 直接崩。

---

## 产出

每次运行在输出目录写：

- `manifest.csv` — `index,vid,title,file,bytes,resolution,bitrate,hasAudio,duration,candidates`
- `_items.json` — 含 `nCand`（候选档数）/ `allDefs`，供事后核验

**验收标准**：抽几条用 `ffprobe` 核对实际分辨率，应等于 manifest 声明值；
音视频分离的站点还必须核对**同时存在 video 和 audio 流**。

---

## 断点续传

- 成品已存在且时长吻合 → 跳过
- 分片级断点续传（91cg1 自研路径）：已下分片保留，重跑只补缺
- yt-dlp 路径用 `--download-archive` 做跨次去重

---

## 安全与边界

- **不绕过 DRM / 登录墙 / 付费内容**，遵守各站 TOS
- 不安装外部 dsh-video-downloader 插件；媒体发现 / 登录 / 翻页全部交给 ego-browser
- 签名直链会过期：每次运行都现场重新从页面提取，已下文件跳过不重下
- 登录态失效时用你已登录的 ego 上下文；被拦则停止并报告，不绕过
- **本仓库不包含任何下载的媒体文件，也不包含任何 cookie / 凭据**

---

## 目录结构

```
ego-media-downloader/
├── SKILL.md                  # skill 主文档（触发/参数/工作流/路由）
├── EVOLUTION.md              # 跨会话记忆：已知平台、已知坑、演化日志
├── references/
│   └── platforms.md          # 各平台抓取配方 + 演化日志
└── tools/
    ├── _quality.mjs          # 「多档择优」内核（所有脚本共用）
    ├── _ytdlp.mjs            # yt-dlp 下载内核（可选加速器）
    ├── test_quality.mjs      # 内核单测（32 例）
    ├── export-cookies-ytdlp.mjs
    ├── 91cg1-video.mjs
    ├── bilibili-video.mjs
    ├── bilibili-space.mjs
    ├── douyin-video.mjs
    ├── toutiao-video.mjs
    ├── x-video.mjs
    ├── xiaohongshu-media.mjs
    ├── youtube-video.mjs
    ├── ytdlp-media.mjs
    └── generic-media.mjs
```

`EVOLUTION.md` 是本项目的长期记忆——每次踩到新坑、新增平台，都会把它写回该文件，
新会话读它即可继承经验，不必从零摸索。

---

## License

MIT
