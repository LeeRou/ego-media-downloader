// _ytdlp.mjs — yt-dlp 下载内核（可选加速器，供各平台脚本复用）
//
// 【定位】ego-browser 负责「发现」（不可替代：抖音/头条/91cg1/X 媒体页/YouTube 都靠它），
//   yt-dlp 负责「下载」（更强：原生 HLS 分片并发、AES 解密、断点续传、多档择优一步到位）。
//   **不要让 yt-dlp 去做页面发现**——实测它不支持这些站点（见下），强上会全盘失败。
//
// 【实测能力边界（2026-10-29，yt-dlp 2026.10.26）】
//   ✅ 直链 .m3u8（含 AES-128 加密）：完美。91cg1 同一条 688MB 视频 yt-dlp 117.8s vs 自研分片脚本 165s，
//      产物 **逐字节一致**（721840587 bytes），音视频轨完全吻合。
//   ✅ B站单条（bilibili.com/video/BVxxx）：直接 1080p，无需登录。
//   ✅ X 单条推文（配 ego 导出的 cookies）：1080p，且比 GraphQL 方案多给一个 http-10368 直链档。
//   ✅ 通用页面里的 <video>：能发现，但常拿不到分辨率（NA），择优质量不如自研 DOM 扫描。
//   ❌ 91cg1 页面级 URL：Unsupported（必须先用 ego 读 data-config 拿 m3u8）
//   ❌ 抖音 douyin.com：Unsupported
//   ❌ 头条 toutiao.com：generic 404
//   ❌ X 媒体页 /<user>/media：Unsupported（必须先由 ego 枚举出具体推文 URL）
//   ❌ YouTube：即使带 cookies 也只返回 storyboard（PO token 限制），拿不到真实视频格式
//   ❌ B站 space 主页批量：flat-playlist 返回空
//
// 【多档择优】yt-dlp 的 `-S res,br,size` 语义与本站铁律「分辨率 → 码率 → 体积」**完全等价**
//   （实测 4 档 X 视频与 3 档 HLS 均正确选到最高档）。默认行为也已按此排序，
//   但为防 yt-dlp 未来改默认值，一律显式传 `-S`。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";

const execFileP = promisify(execFile);

let _cached = null;

/** yt-dlp 可执行文件路径（PATH 里找；找不到返回 ""）。结果缓存。 */
export async function findYtdlp() {
  if (_cached !== null) return _cached;
  const cands = ["yt-dlp", "yt-dlp.exe"];
  for (const bin of cands) {
    try {
      const { stdout } = await execFileP(bin, ["--version"], { windowsHide: true, timeout: 30000 });
      if (/\d{4}\.\d{2}\.\d{2}/.test(stdout || "")) {
        _cached = bin;
        return bin;
      }
    } catch (e) {}
  }
  _cached = "";
  return "";
}

/** yt-dlp 是否可用 */
export async function hasYtdlp() {
  return !!(await findYtdlp());
}

/** 版本号（不可用返回 ""） */
export async function ytdlpVersion() {
  const bin = await findYtdlp();
  if (!bin) return "";
  try {
    const { stdout } = await execFileP(bin, ["--version"], { windowsHide: true, timeout: 30000 });
    return (stdout || "").trim();
  } catch (e) { return ""; }
}

/**
 * 用 yt-dlp 下载一个媒体 URL。
 * @param {Object} opts
 * @param {string} opts.url        媒体直链（m3u8 / mp4 / yt-dlp 支持的页面 URL）
 * @param {string} opts.dest       目标文件绝对路径（含扩展名，如 ...\001_x.mp4）
 * @param {string} [opts.referer]  Referer 头
 * @param {string} [opts.cookies]  Netscape cookie 文件路径
 * @param {number} [opts.concurrency=16] 分片并发数
 * @param {string} [opts.archive]  --download-archive 文件路径（跨次运行去重）
 * @param {number} [opts.timeoutMs=3600000]
 * @returns {Promise<{ok:boolean, bytes:number, elapsedSec:number, stderr:string, error?:string}>}
 */
export async function downloadWithYtdlp(opts) {
  const bin = await findYtdlp();
  if (!bin) return { ok: false, bytes: 0, elapsedSec: 0, stderr: "", error: "yt-dlp 不可用" };

  const { url, dest, referer, cookies, concurrency = 16, archive, timeoutMs = 3600000 } = opts;
  const dir = dest.replace(/[\\/][^\\/]+$/, "");
  const base = dest.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

  const args = [
    "--no-warnings",
    "--no-playlist",
    "--newline",
    "-N", String(concurrency),
    // 铁律：显式指定「分辨率 → 码率 → 体积」降序，与 _quality.mjs 语义一致
    "-S", "res,br,size",
    // 优先 mp4/m4a，拿不到再退回任意容器（避免 iamf 等冷门 codec 把成品搞坏）
    "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "-o", `${dir}\\${base}.%(ext)s`,
  ];
  if (referer) args.push("--add-header", `Referer:${referer}`);
  if (cookies && existsSync(cookies)) args.push("--cookies", cookies);
  if (archive) args.push("--download-archive", archive);
  args.push(url);

  const t0 = Date.now();
  let stderr = "";
  try {
    const r = await execFileP(bin, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 64,
      timeout: timeoutMs,
    });
    stderr = (r.stderr || "") + (r.stdout || "");
  } catch (e) {
    stderr = (e.stderr || "") + (e.stdout || "") || e.message;
    // 超时/被杀的进程也可能已经产出了完整文件，交由调用方 probe 判定
    if (!existsSync(dest)) {
      return { ok: false, bytes: 0, elapsedSec: Math.round((Date.now() - t0) / 1000), stderr, error: e.message.slice(0, 300) };
    }
  }

  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  if (!existsSync(dest)) {
    return { ok: false, bytes: 0, elapsedSec, stderr, error: "产物不存在" };
  }
  const bytes = statSync(dest).size;
  if (bytes < 1024 * 10) {
    return { ok: false, bytes, elapsedSec, stderr, error: "产物过小" };
  }
  return { ok: true, bytes, elapsedSec, stderr };
}

/**
 * 用 yt-dlp 探测媒体信息（不下载）。
 * @returns {Promise<Object|null>} JSON 元数据，失败返回 null
 */
export async function probeWithYtdlp(url, { referer, cookies, timeoutMs = 180000 } = {}) {
  const bin = await findYtdlp();
  if (!bin) return null;
  const args = ["--no-warnings", "--no-playlist", "--skip-download", "--dump-json", "-S", "res,br,size"];
  if (referer) args.push("--add-header", `Referer:${referer}`);
  if (cookies && existsSync(cookies)) args.push("--cookies", cookies);
  args.push(url);
  try {
    const { stdout } = await execFileP(bin, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 32, timeout: timeoutMs });
    const line = (stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 该 URL 是否值得交给 yt-dlp 直接下载（直链类，或 yt-dlp 原生支持且已实测可用的站点）。
 * 页面发现类站点（抖音/头条/91cg1 页面/X 媒体页/YouTube）一律返回 false，必须先经 ego 发现。
 */
export function isYtdlpFriendly(url) {
  const u = String(url || "");
  if (/\.(m3u8|mp4|webm|mov|m4v)(\?|#|$)/i.test(u)) return true;
  if (/bilibili\.com\/video\//i.test(u)) return true;
  if (/(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(u)) return true;
  return false;
}
