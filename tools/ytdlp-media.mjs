// ytdlp-media.mjs — 通用 yt-dlp 入口：把 URL 交给 yt-dlp 原生支持的上千站点
// 由 ego-browser 运行时执行（需要 taskSpace 只是为了沿用统一运行方式；本脚本其实不操作页面）。
// 读取 emd-config.json：{url, out, type, limit, filter, cookies, playlist}
//
// 【为什么需要这个脚本】
//   抖音/头条/91cg1/X 媒体页 这类站点 yt-dlp **不支持**，必须走各自的 ego 配方；
//   但 Vimeo、TikTok、SoundCloud、Bilibili、大量成人站/自建 m3u8 站 等 1755 个 extractor
//   yt-dlp 原生支持，且比手写 DOM 扫描可靠得多。这个脚本就是「其它站点」的第一顺位。
//
// 【多档择优】显式传 `-S res,br,size`（= 分辨率 → 码率 → 体积），与 _quality.mjs 铁律等价，
//   不依赖 yt-dlp 的默认排序（防止未来版本改默认值悄悄降档）。
//
// 【批量】URL 是频道/播放列表时，yt-dlp 会自己翻页枚举；`playlist:false` 可强制只下单条。
import { writeFile, appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---- 公共环境模块（cmd stdin 下相对 import 不可靠，用多候选目录定位）----
const ENV = await (async () => {
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const roots = [process.env.EMD_TOOLS_DIR, process.cwd(), join(process.cwd(), "ego-task"),
    join(homedir(), ".agents", "skills", "ego-media-downloader", "tools")].filter(Boolean);
  for (const r of roots) {
    try { return await import(pathToFileURL(join(r, "_env.mjs")).href); } catch (e) {}
  }
  throw new Error("无法加载 _env.mjs（请与本脚本放在同一目录，或设置 EMD_TOOLS_DIR）");
})();
const FFPROBE = ENV.FFPROBE;

// 载入 yt-dlp 内核
const YT = await ENV.loadKernel("_ytdlp.mjs");

// ---------- 配置 ----------
let PAGE_URL = process.env.EMD_URL || "";
let OUT_DIR = process.env.EMD_OUT || "";
let COOKIES = "", FILTER = "", PLAYLIST = true, LIMIT = 0;
for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    PAGE_URL = PAGE_URL || cfg.url || "";
    OUT_DIR = OUT_DIR || cfg.out || "";
    COOKIES = cfg.cookies || COOKIES;
    FILTER = cfg.filter || FILTER;
    LIMIT = Number(cfg.limit || 0) || 0;
    if (cfg.playlist === false) PLAYLIST = false;
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out（请写 emd-config.json）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const bin = await YT.ytdlpVersion();
if (!bin) { console.log("NO_YTDLP"); process.exit(3); }
console.log("yt-dlp", bin);

// ---------- 下载 ----------
// 输出模板：013_<标题> [<id>].mp4（序号用 playlist_index，单条时退化为 001）
const OUT_TMPL = `${OUT_DIR}\\%(playlist_index|001)03d_%(title).80B [%(id)s].%(ext)s`;
const ARCHIVE = OUT_DIR + "\\_ytdlp-archive.txt";

const args = [
  "--no-warnings",
  "--newline",
  "--ignore-errors",
  "-N", "16",
  "-S", "res,br,size",                       // 铁律：分辨率 → 码率 → 体积
  "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
  "--merge-output-format", "mp4",
  "--download-archive", ARCHIVE,
  "-o", OUT_TMPL,
  "--trim-filenames", "150",
];
if (PLAYLIST) args.push("--yes-playlist"); else args.push("--no-playlist");
if (LIMIT > 0) args.push("--playlist-end", String(LIMIT));
if (FILTER) { args.push("--match-filter", `title ~= "${FILTER}"`); }
if (COOKIES && existsSync(COOKIES)) args.push("--cookies", COOKIES);
args.push(PAGE_URL);

const before = new Set(existsSync(OUT_DIR) ? (await readdir(OUT_DIR)).filter(f => /\.(mp4|mkv|webm|m4a|mp3)$/i.test(f)) : []);
const t0 = Date.now();
let stderr = "";
try {
  const r = await execFileP("yt-dlp", args, { windowsHide: true, maxBuffer: 1024 * 1024 * 128, timeout: 7200000 });
  stderr = (r.stderr || "") + (r.stdout || "");
} catch (e) {
  stderr = (e.stderr || "") + (e.stdout || "") || e.message;
}
const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(stderr.split(/\r?\n/).filter(l => /\[download\]|\[Merger\]|ERROR|WARNING/.test(l)).slice(-30).join("\n"));

// ---------- 验收：扫新文件 + ffprobe 写 manifest ----------
const after = (await readdir(OUT_DIR)).filter(f => /\.(mp4|mkv|webm|m4a|mp3)$/i.test(f));
const fresh = after.filter(f => !before.has(f)).sort();
if (!fresh.length) {
  // 已经下过（archive 命中）→ 正常跳过，不算失败
  if (/already been recorded in the archive/.test(stderr)) {
    console.log("ALL_SKIPPED");
    process.exit(0);
  }
  console.log("NO_NEW_FILE");
  process.exit(stderr.includes("ERROR") ? 2 : 3);
}

const mf = OUT_DIR + "/manifest.csv";
if (!existsSync(mf)) await writeFile(mf, "index,file,bytes,resolution,duration,hasAudio\n");
let ok = 0;
for (const f of fresh) {
  const p = OUT_DIR + "\\" + f;
  let w = 0, h = 0, dur = 0, hasAudio = 0;
  try {
    const { stdout } = await execFileP(FFPROBE, [
      "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
      "-of", "json", p,
    ], { windowsHide: true, timeout: 60000 });
    const j = JSON.parse(stdout || "{}");
    const v = (j.streams || []).find(s => s.codec_type === "video") || {};
    hasAudio = (j.streams || []).some(s => s.codec_type === "audio") ? 1 : 0;
    w = v.width || 0; h = v.height || 0;
    dur = Math.round(parseFloat((j.format || {}).duration || 0));
  } catch (e) {}
  const bytes = statSync(p).size;
  await appendFile(mf, `${String(ok + 1).padStart(3, "0")},${f},${bytes},${w}x${h},${dur},${hasAudio}\n`);
  console.log(`OK ${(bytes / 1048576).toFixed(1)}MB ${w}x${h} ${dur}s hasAudio=${hasAudio} ${f.slice(0, 60)}`);
  ok++;
}
console.log(`DONE ok=${ok} elapsed=${elapsed}s`);
