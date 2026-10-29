// generic-media.mjs — 任意站点媒体扫描（增强版，支持网络拦截 + 列表页跟进）
// 由 ego-browser 运行时执行。读取同目录 emd-config.json：{url, out, type, limit}
//
// 【铁律】同一媒体有多档候选时必须取最高档，不能取第一个
import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

// 载入公共环境模块（cmd stdin 下相对 import 不可靠，用多候选目录定位）
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

// 载入通用「多档择优」内核
const Q = await ENV.loadKernel("_quality.mjs");
const { pickBest, pickBestImage, originalImageUrl, parseSrcset, guessImgWidth, imgGroupKey } = Q;

// 载入 yt-dlp 内核（可选）：m3u8 / 原生支持站点直接下成 mp4，而不是存播放列表文本
const YT = await ENV.tryKernel("_ytdlp.mjs");
let YT_OK = false;
if (YT) { try { YT_OK = !!(await YT.ytdlpVersion()); } catch (e) {} }

let PAGE_URL = process.env.EMD_URL || "";
let OUT_DIR = process.env.EMD_OUT || "";
let TYPE = (process.env.EMD_TYPE || "all").toLowerCase();
let LIMIT = 0;

for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    PAGE_URL = PAGE_URL || cfg.url || "";
    OUT_DIR = OUT_DIR || cfg.out || "";
    TYPE = (cfg.type || TYPE).toLowerCase();
    LIMIT = cfg.limit || LIMIT || 0;
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}

if (!PAGE_URL || !OUT_DIR) {
  console.log("缺少 url / out（请写 emd-config.json）");
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-generic");
const page = task.page("p1");

// ========== 网络拦截：捕获 m3u8 / mp4 ==========
// 【注意】ego 的 Page **没有** Playwright 式的 page.on("response")（调用会 TypeError），
// 所以改为在页面内 hook fetch / XMLHttpRequest，把请求过的媒体 URL 收集到 window.__emdNet。
const netMedia = [];
const NET_HOOK = `
window.__emdNet = window.__emdNet || [];
(function(){
  const push = (u) => { try { if (u && /\\.(m3u8|mp4|webm|mov)(\\?|$)/i.test(u)) window.__emdNet.push(u); } catch(e){} };
  if (!window.__emdFetchHooked) {
    window.__emdFetchHooked = true;
    const of = window.fetch;
    window.fetch = function(...a){ try { push(typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url)); } catch(e){} return of.apply(this, a); };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u, ...rest){ try { push(u); } catch(e){} return oo.call(this, m, u, ...rest); };
  }
})();
`;
// 用 CDP 在「每个新文档创建前」注入 hook（ego 没有 Playwright 的 page.addInitScript，
// 但有 page.cdp()，可走 Page.addScriptToEvaluateOnNewDocument）
try {
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: NET_HOOK });
} catch (e) {
  // 兜底：至少给当前文档装上（后续 goto 会丢，但首屏有效）
  try { await page.evaluate(NET_HOOK); } catch (e2) {}
}
async function drainNetMedia() {
  try {
    const urls = await page.evaluate(() => (window.__emdNet || []).slice());
    for (const u of urls) {
      if (!netMedia.some(n => n.url === u)) {
        netMedia.push({ url: u, type: /\.m3u8/i.test(u) ? "m3u8" : "video", status: 200 });
      }
    }
  } catch (e) {}
}

await page.goto(PAGE_URL, { timeout: 60000 });
await page.waitForLoadState("load");
await page.waitForTimeout(4000);

// 更充分的滚动，触发懒加载
for (let i = 0; i < 18; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);
}
await page.waitForTimeout(2000);
await drainNetMedia();

// ========== 页面 DOM 扫描 ==========
const raw = await page.evaluate(() => {
  const videos = [], images = [];
  const abs = (u) => {
    if (!u) return "";
    try { return new URL(u, location.href).href; } catch (e) { return ""; }
  };
  const pushV = (c) => { if (c && c.url) videos.push(c); };
  const pushI = (c) => { if (c && c.url) images.push(c); };

  // video 标签
  for (const v of document.querySelectorAll("video")) {
    const sources = [...v.querySelectorAll("source[src]")].map((s) => ({
      url: abs(s.getAttribute("src")),
      def: s.getAttribute("label") || s.getAttribute("data-quality") || s.getAttribute("res") || "",
      h: parseInt(s.getAttribute("height") || 0, 10) || 0,
      type: s.type || "",
    }));
    if (v.currentSrc || v.src) {
      sources.push({
        url: abs(v.currentSrc || v.src),
        h: v.videoHeight || 0,
        w: v.videoWidth || 0,
        def: ""
      });
    }
    for (const s of sources) pushV(s);
  }

  // 直接媒体链接
  for (const a of document.querySelectorAll("a[href]")) {
    const h = abs(a.getAttribute("href"));
    if (/\.(mp4|webm|m3u8|mov)(\?|$)/i.test(h)) {
      pushV({ url: h, def: a.getAttribute("data-quality") || "" });
    }
  }

  // 图片
  const pushImgEl = (el) => {
    const srcset = el.getAttribute && el.getAttribute("srcset");
    if (srcset) {
      for (const part of srcset.split(",")) {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) continue;
        const d = bits[1] || "";
        const w = /^\d+w$/.test(d) ? parseInt(d, 10) : (/^\d+(\.\d+)?x$/.test(d) ? Math.round(parseFloat(d) * 1000) : 0);
        pushI({ url: abs(bits[0]), w });
      }
    }
    for (const attr of ["src", "data-src", "data-original", "data-actualsrc", "data-lazy-src", "data-url"]) {
      const u = abs(el.getAttribute && el.getAttribute(attr));
      if (u) pushI({ url: u, w: parseInt((el.getAttribute && el.getAttribute("width")) || 0, 10) || 0 });
    }
    if (el.naturalWidth) pushI({ url: abs(el.currentSrc || el.src), w: el.naturalWidth });
  };
  for (const img of document.querySelectorAll("img")) pushImgEl(img);
  for (const s of document.querySelectorAll("picture source[srcset]")) pushImgEl(s);

  // 背景图
  for (const el of document.querySelectorAll("*")) {
    const bg = el.style && el.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) pushI({ url: abs(m[1]) });
    }
  }

  // 图片型链接
  for (const a of document.querySelectorAll("a[href]")) {
    const h = abs(a.getAttribute("href"));
    if (/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(h)) pushI({ url: h });
  }

  // 尝试收集可能的详情页链接（列表页用）
  const detailLinks = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const h = abs(a.getAttribute("href"));
    if (!h || h === location.href) continue;
    // 简单过滤：同域名、路径较深、不像静态资源
    try {
      const u = new URL(h);
      if (u.origin === location.origin &&
          u.pathname.length > 5 &&
          !/\.(css|js|png|jpg|jpeg|gif|svg|woff|ttf|ico)(\?|$)/i.test(u.pathname) &&
          !h.includes("#")) {
        detailLinks.push(h);
      }
    } catch (e) {}
  }

  return { videos, images, detailLinks: [...new Set(detailLinks)].slice(0, 30) };
});

// 合并网络捕获的媒体
for (const n of netMedia) {
  raw.videos.push({ url: n.url, def: n.type === "m3u8" ? "m3u8" : "", h: 0 });
}

// ========== 视频去重 + 择优 ==========
const videoBest = [];
{
  const seen = new Set();
  for (const c of raw.videos) {
    const key = c.url.split("#")[0].split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    videoBest.push(c);
  }
}

// ========== 图片归组 + 择优 ==========
const imgGroups = new Map();
for (const c of raw.images) {
  const orig = originalImageUrl(c.url);
  const key = imgGroupKey(c.url);
  if (!key) continue;
  if (!imgGroups.has(key)) imgGroups.set(key, []);
  imgGroups.get(key).push({ ...c, url: orig });
}
const imageBest = [];
for (const [, group] of imgGroups) {
  const best = pickBestImage(group);
  if (best) imageBest.push({ url: best.url, w: best.w || guessImgWidth(best.url), wSrc: best.wSrc });
}

// ========== 如果当前页视频很少，尝试进入部分详情页 ==========
const detailResults = [];
if ((TYPE === "video" || TYPE === "all") && videoBest.length < 3 && raw.detailLinks.length > 0) {
  const maxVisit = LIMIT > 0 ? Math.min(LIMIT, 8) : 6; // 默认最多跟 6 个详情页，避免太慢
  console.log(`列表页视频较少，尝试进入前 ${maxVisit} 个详情页...`);

  for (let i = 0; i < Math.min(maxVisit, raw.detailLinks.length); i++) {
    const link = raw.detailLinks[i];
    try {
      console.log(`  → 详情页 ${i + 1}: ${link}`);
      await page.goto(link, { timeout: 45000 });
      await page.waitForLoadState("load");
      await page.waitForTimeout(3500);

      // 再滚一下
      for (let s = 0; s < 6; s++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(600);
      }

      const detailRaw = await page.evaluate(() => {
        const vs = [];
        const abs = (u) => {
          if (!u) return "";
          try { return new URL(u, location.href).href; } catch (e) { return ""; }
        };
        for (const v of document.querySelectorAll("video")) {
          if (v.currentSrc || v.src) vs.push({ url: abs(v.currentSrc || v.src), h: v.videoHeight || 0 });
          for (const s of v.querySelectorAll("source[src]")) {
            vs.push({ url: abs(s.getAttribute("src")), def: s.getAttribute("label") || "" });
          }
        }
        for (const a of document.querySelectorAll("a[href]")) {
          const h = abs(a.getAttribute("href"));
          if (/\.(mp4|webm|m3u8)(\?|$)/i.test(h)) vs.push({ url: h });
        }
        return vs;
      });

      for (const d of detailRaw) {
        videoBest.push(d);
      }
      // 网络拦截的也会继续累积
    } catch (e) {
      console.log(`  详情页失败: ${e.message}`);
    }
  }
}

// 最终去重
const finalVideos = [];
{
  const seen = new Set();
  for (const c of videoBest) {
    const key = c.url.split("#")[0].split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    finalVideos.push(c);
  }
}

const uniq = [];
if (TYPE === "video" || TYPE === "all") {
  for (const v of finalVideos) {
    // blob:/data: 是播放器内部地址，抢不到内容，直接过滤（否则每页都刷一条 "ERR fetch failed" 噪声）
    if (!v.url || /^(blob:|data:|mediastream:)/i.test(v.url)) continue;
    uniq.push({ type: "video", url: v.url, h: v.h || 0, def: v.def || "" });
  }
}
if (TYPE === "image" || TYPE === "all") {
  for (const i of imageBest) {
    uniq.push({ type: "image", url: i.url, w: i.w || 0 });
  }
}

console.log("SCANNED", uniq.length, `(video ${finalVideos.length}, image ${imageBest.length}, net ${netMedia.length})`);
await writeFile(OUT_DIR + "/_items.json", JSON.stringify({ items: uniq, netMedia }, null, 2));

if (!existsSync(OUT_DIR + "/manifest.csv")) {
  await writeFile(OUT_DIR + "/manifest.csv", "index,type,file,bytes,quality\n");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
let ok = 0, fail = 0, skip = 0;

// ffprobe 读真实分辨率（用于 yt-dlp 分支写 manifest）
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execFileP = promisify(execFile);
const FFPROBE = ENV.FFPROBE;
async function probeResolution(path) {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
    ], { windowsHide: true, timeout: 60000 });
    const m = (stdout || "").trim().match(/(\d+),(\d+)/);
    return m ? `${m[1]}x${m[2]}` : "";
  } catch (e) { return ""; }
}

for (let i = 0; i < uniq.length; i++) {
  const item = uniq[i];
  const { url, type } = item;

  // 【关键】m3u8 / yt-dlp 支持的站点：交给 yt-dlp 下成真正的 mp4，
  // 而不是把播放列表文本当成品存下来（旧行为会产出无法播放的 .m3u8 文件）。
  const useYtdlp = type === "video" && YT && YT_OK && YT.isYtdlpFriendly(url);
  if (useYtdlp) {
    const idx = String(i + 1).padStart(3, "0");
    const base = (url.split("/").filter(Boolean).pop() || String(i)).split("?")[0].slice(-24);
    const file = `${idx}_${base}.mp4`;
    const outPath = OUT_DIR + "/" + file;
    if (existsSync(outPath) && statSync(outPath).size > 1024 * 10) { skip++; continue; }
    process.stdout.write(`[${idx}] video(yt-dlp) ... `);
    const referer = (() => { try { return new URL(url).origin + "/"; } catch { return PAGE_URL; } })();
    const r = await YT.downloadWithYtdlp({
      url, dest: outPath, referer, concurrency: 16,
      archive: OUT_DIR + "/.ytdlp-archive.txt",
    });
    if (r.ok) {
      // 用 ffprobe 读真实分辨率写进 manifest（比 item.h / "m3u8" 之类占位文案可靠）
      const q = await probeResolution(outPath) || (item.h ? `${item.h}p` : "");
      await appendFile(OUT_DIR + "/manifest.csv", `${idx},video,${file},${r.bytes},${q}\n`);
      console.log("OK", r.bytes, q, "via yt-dlp", `${r.elapsedSec}s`);
      ok++;
    } else {
      console.log("yt-dlp FAIL:", String(r.error || "").slice(0, 120));
      fail++;
    }
    continue;
  }

  const ext = type === "video"
    ? (/\.m3u8/i.test(url) ? "m3u8" : "mp4")
    : (url.match(/\.(\w{2,4})(\?|$)/i)?.[1] || "jpg");

  const idx = String(i + 1).padStart(3, "0");
  const file = `${idx}_${(url.split("/").pop().split("?")[0].slice(-20) || i)}.${ext}`;
  const outPath = OUT_DIR + "/" + file;

  if (existsSync(outPath)) {
    skip++;
    continue;
  }

  process.stdout.write(`[${idx}] ${type} ... `);
  try {
    const referer = (() => {
      try { return new URL(url).origin + "/"; } catch { return PAGE_URL; }
    })();

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": referer },
      redirect: "follow"
    });

    if (!resp.ok) {
      console.log("HTTP", resp.status);
      fail++;
      continue;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 200) {
      console.log("BAD BODY");
      fail++;
      continue;
    }

    await writeFile(outPath, buf);
    const q = type === "video"
      ? (item.h ? `${item.h}p` : item.def || "")
      : (item.w ? `${item.w}w` : "");

    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${type},${file},${buf.length},${q}\n`);
    console.log("OK", buf.length, q);
    ok++;
  } catch (e) {
    console.log("ERR", e.message);
    fail++;
  }
}

console.log(`DONE ok=${ok} fail=${fail} skip=${skip} total=${uniq.length}`);
if (!YT_OK) console.log("提示：yt-dlp 不可用，若下到的是 .m3u8 文件需另行用 ffmpeg 转换。");