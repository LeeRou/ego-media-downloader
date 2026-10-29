// 91cg1-video.mjs — 91吃瓜网（91cg1.com）标签页 / 文章页 视频批量下载
// 由 ego-browser 运行时执行。读取 emd-config.json：{url, out, type, limit, filter}
//
// 【站点结构（2026-10-29 实测）】
//   标签页 /tag/<urlencoded>/   列出全部文章链接 a[href*="/archives/"]（本标签 22 篇，1/1 无分页）
//   文章页 /archives/<id>/      每篇 1~6 个 <div class="dplayer" data-config="{...}">，
//                               JSON 里 video.url 是 HLS .m3u8（type:"hls"）；
//                               <video> 自身是 blob:，抓不到直链 → 必须读 data-config。
//   m3u8 为 AES-128 加密（#EXT-X-KEY:METHOD=AES-128 + .ts 分片），无 #EXT-X-STREAM-INF 多档；
//   auth_key 是**时间签名**（约 1~2h 过期）→ 每次下载前现场重新提取，绝不缓存 URL。
//
// 【下载策略：优先 yt-dlp，失败回退自研分片器】
//   A) **yt-dlp 优先**（若 PATH 上有）：原生 HLS 分片并发 + AES 解密 + 断点续传，
//      实测同一条 688MB 视频 **117.8s** vs 自研 165s，产物逐字节一致。
//      铁律不破：传 `-S res,br,size`（= 分辨率→码率→体积），与 _quality.mjs 语义等价。
//   B) **回退自研**（yt-dlp 不可用 / 失败时）：参考 kernel-video-sharing/crawler-91cg 的成熟做法——
//      ① 解析 m3u8（master playlist 递归取最高档；AES-128 key/IV 解析）
//      ② ts 分片 **8 并发**下载 + **AES-128-CBC 本地解密** + 落盘到 `_tmp_<id>/`
//      ③ **断点续传**：已存在且非空的分片直接跳过
//      ④ **fail-fast**：连续 2 个分片失败即中止本视频，保留已下分片，下次续传
//      ⑤ 全部到齐 → 按序拼接 → ffmpeg -c copy 封装 mp4 → 清理临时分片
//   两条路都靠「重新加载文章页拿新 m3u8」处理 auth_key 过期。
//
// 【铁律·多档择优】本站在单作品上通常只给 1 档（nCand=1 属正常），但脚本仍按铁律：
//   master playlist 里的全部 #EXT-X-STREAM-INF 档位（RESOLUTION/BANDWIDTH）全部收集，
//   交给 _quality.mjs 的 rankCands/pickBest 按「分辨率 → 码率 → 体积」取最高，绝不取第一个。
import { writeFile, appendFile, mkdir, readFile, unlink, rmdir, readdir } from "node:fs/promises";
import { existsSync, statSync, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDecipheriv } from "node:crypto";

const execFileP = promisify(execFile);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TS_CONCURRENCY = 8;
const MAX_CONSEC_FAILS = 2;

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
const FFMPEG = ENV.FFMPEG;
const FFPROBE = ENV.FFPROBE;

// 载入「多档择优」内核（由 _env.mjs 在候选目录里定位）
const Q = await ENV.loadKernel("_quality.mjs");
const { rankCands, pickBest } = Q;

// 载入 yt-dlp 内核（可选加速器；加载不到就纯走自研分片器）
const YT = await ENV.tryKernel("_ytdlp.mjs");

// ---------- 配置 ----------
let PAGE_URL = process.env.EMD_URL || "";
let OUT_DIR = process.env.EMD_OUT || "";
let TYPE = (process.env.EMD_TYPE || "video").toLowerCase();
let LIMIT = 0, FILTER = "", ENGINE = "auto";
for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    PAGE_URL = PAGE_URL || cfg.url || "";
    OUT_DIR = OUT_DIR || cfg.out || "";
    TYPE = (cfg.type || TYPE).toLowerCase();
    LIMIT = Number(cfg.limit || 0) || 0;
    FILTER = cfg.filter || "";
    ENGINE = (cfg.engine || ENGINE).toLowerCase();
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out（请写 emd-config.json）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });
const filterRe = FILTER ? new RegExp(FILTER) : null;

const task = await taskSpace("emd-91cg1");
const page = task.page("p1");

// 探测 yt-dlp 可用性（engine=builtin 可强制走自研分片器；默认 auto）
let YT_OK = false, YT_VER = "";
if (YT && ENGINE !== "builtin") {
  try {
    YT_VER = await YT.ytdlpVersion();
    YT_OK = !!YT_VER;
  } catch (e) {}
}
console.log("yt-dlp:", ENGINE === "builtin" ? `已按 engine=builtin 禁用` : (YT_OK ? YT_VER : "不可用（走自研分片器）"));

function sanitize(s, n = 60) {
  return String(s || "").replace(/[\n\r\t]/g, " ").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, n).trim();
}

// ---------- HTTP（Node 侧，带重试） ----------
async function httpBuf(url, referer, tries = 5) {
  let last = "";
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA, "Referer": referer, "Accept": "*/*" },
        redirect: "follow",
      });
      if (!resp.ok) { last = "HTTP " + resp.status; if (resp.status === 403 || resp.status === 404) throw Object.assign(new Error(last), { fatal: resp.status }); }
      else {
        const b = Buffer.from(await resp.arrayBuffer());
        if (b.length < 1) { last = "EMPTY"; } else return b;
      }
    } catch (e) {
      last = e.message;
      if (e.fatal) throw e;
    }
    await new Promise(r => setTimeout(r, 600 * i));
  }
  throw new Error(last || "fetch failed");
}

// ---------- m3u8 解析 ----------
function parseKey(text, m3u8Url) {
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln.startsWith("#EXT-X-KEY")) continue;
    const mMethod = ln.match(/METHOD=([A-Z0-9-]+)/);
    const method = mMethod ? mMethod[1] : "NONE";
    if (method === "NONE") return { method: "NONE", keyUrl: "", iv: null };
    const mUri = ln.match(/URI="([^"]+)"/);
    if (!mUri) throw new Error("EXT-X-KEY 缺少 URI: " + ln);
    const mIv = ln.match(/IV=0x([0-9a-fA-F]+)/);
    return {
      method,
      keyUrl: new URL(mUri[1], m3u8Url).href,
      iv: mIv ? Buffer.from(mIv[1], "hex") : null,
    };
  }
  return { method: "NONE", keyUrl: "", iv: null };
}

// 返回 { variants:[{url,w,h,br}], segments:[url], key, duration }
function parsePlaylist(text, m3u8Url) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  if (text.includes("#EXT-X-STREAM-INF")) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
      const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/) || [];
      const next = lines[i + 1] || "";
      if (!next || next.startsWith("#")) continue;
      variants.push({ url: new URL(next, m3u8Url).href, w: Number(res[1] || 0), h: Number(res[2] || 0), br: bw });
    }
    return { variants, segments: [], key: null, duration: 0 };
  }
  const segments = [];
  let duration = 0;
  for (const ln of lines) {
    if (!ln) continue;
    if (ln.startsWith("#EXTINF:")) {
      const d = parseFloat(ln.slice(8).split(",")[0]);
      if (isFinite(d)) duration += d;
      continue;
    }
    if (ln.startsWith("#")) continue;
    segments.push(new URL(ln, m3u8Url).href);
  }
  return { variants: [], segments, key: parseKey(text, m3u8Url), duration: Math.round(duration) };
}

// ---------- 分片下载 + 解密 + 拼接 ----------
async function downloadHls(m3u8Url, referer, workDir, destMp4, log) {
  await mkdir(workDir, { recursive: true });

  // 1) 取 playlist（master 则递归取最高档）
  let url = m3u8Url;
  let pl = null;
  for (let depth = 0; depth < 4; depth++) {
    const txt = (await httpBuf(url, referer)).toString("utf8");
    pl = parsePlaylist(txt, url);
    if (pl.variants.length) {
      const cands = rankCands(pl.variants.map(v => ({ url: v.url, w: v.w, h: v.h, br: v.br, def: v.h ? `${v.h}p` : "" })));
      const best = pickBest(cands);
      log(`  master ${pl.variants.length} 档 → 选 ${best.h ? best.h + "p" : ""} br=${best.br}`);
      url = best.url;
      continue;
    }
    break;
  }
  if (!pl || !pl.segments.length) throw new Error("m3u8 中未找到 ts 分片");
  const expectedDuration = pl.duration || 0;

  // 2) 取 key
  let keyBytes = null;
  if (pl.key && pl.key.method === "AES-128") {
    keyBytes = await httpBuf(pl.key.keyUrl, referer);
    if (keyBytes.length !== 16) throw new Error("AES key 长度异常 " + keyBytes.length);
  }

  const total = pl.segments.length;
  const tsDir = workDir + "\\ts";
  await mkdir(tsDir, { recursive: true });
  const segPath = (i) => `${tsDir}\\${String(i).padStart(6, "0")}.ts`;

  const existing = [];
  for (let i = 0; i < total; i++) {
    try { if (statSync(segPath(i)).size > 0) existing.push(i); } catch (e) {}
  }
  const pending = [];
  for (let i = 0; i < total; i++) if (!existing.includes(i)) pending.push(i);
  log(`  分片 ${total} 个 (加密=${pl.key ? pl.key.method : "NONE"})，已有 ${existing.length}，待下 ${pending.length}`);

  // 3) 并发下载（fail-fast）
  let consecutive = 0, aborted = false;
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (!aborted) {
      const k = cursor++;
      if (k >= pending.length) return;
      const i = pending[k];
      try {
        const buf = await httpBuf(pl.segments[i], referer, 3);
        let out = buf;
        if (keyBytes) {
          // IV：playlist 显式给出就用它；否则按 HLS 规范用「分片序号」作 16 字节大端 IV
          let iv = pl.key && pl.key.iv;
          if (!iv) { iv = Buffer.alloc(16); iv.writeUInt32BE(i >>> 0, 12); }
          const d = createDecipheriv("aes-128-cbc", keyBytes, iv);
          out = Buffer.concat([d.update(buf), d.final()]);
        }
        await writeFile(segPath(i), out);
        consecutive = 0;
      } catch (e) {
        failed.push(i);
        consecutive++;
        if (consecutive >= MAX_CONSEC_FAILS && !aborted) {
          aborted = true;
          log(`  fail-fast: 连续 ${consecutive} 个分片失败，中止（${e.message}）`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TS_CONCURRENCY, pending.length || 1) }, worker));

  const missing = [];
  for (let i = 0; i < total; i++) {
    try { if (statSync(segPath(i)).size <= 0) missing.push(i); } catch (e) { missing.push(i); }
  }
  if (missing.length) {
    const err = new Error(`分片不齐 ${total - missing.length}/${total}（缺 ${missing.length}）`);
    err.incomplete = true;
    err.missing = missing;
    throw err;
  }

  // 4) 拼接 + ffmpeg 封装
  const merged = workDir + "\\merged.ts";
  const ws = createWriteStream(merged);
  for (let i = 0; i < total; i++) {
    const b = await readFile(segPath(i));
    await new Promise((res, rej) => ws.write(b, (e) => e ? rej(e) : res()));
  }
  await new Promise((res) => ws.end(res));

  await execFileP(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", merged, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", destMp4], { windowsHide: true, maxBuffer: 1024 * 1024 * 32, timeout: 1800000 });

  // 5) 清理临时
  try {
    const files = await readdir(tsDir);
    for (const f of files) await unlink(tsDir + "\\" + f).catch(() => {});
    await rmdir(tsDir).catch(() => {});
    await unlink(merged).catch(() => {});
  } catch (e) {}
  return { expectedDuration, segments: total };
}

async function probe(path) {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      "-v", "error", "-show_entries",
      "stream=codec_type,codec_name,width,height,bit_rate:format=duration,size",
      "-of", "json", path,
    ], { windowsHide: true, timeout: 120000 });
    const j = JSON.parse(stdout || "{}");
    const streams = j.streams || [];
    const v = streams.find(s => s.codec_type === "video") || {};
    const a = streams.find(s => s.codec_type === "audio") || {};
    return {
      w: v.width || 0, h: v.height || 0,
      vcodec: v.codec_name || "", acodec: a.codec_name || "",
      hasAudio: !!a.codec_type,
      duration: Math.round(parseFloat((j.format || {}).duration || 0)),
      size: parseInt((j.format || {}).size || 0, 10) || 0,
      vbr: parseInt(v.bit_rate || 0, 10) || 0,
    };
  } catch (e) { return null; }
}

// ---------- 1. 枚举文章列表 ----------
await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);

let articles = [];
const seenArt = new Set();
for (let p = 1; p <= 40; p++) {
  const batch = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/archives/"]')) {
      const h = a.href.split("#")[0];
      if (seen.has(h)) continue;
      seen.add(h);
      const t = (a.innerText || "").replace(/\s+/g, " ").trim();
      if (t) out.push({ url: h, text: t });
    }
    const pag = document.querySelector(".pagination, .page-nav, nav.pagination, .pager, .page-numbers");
    const next = pag ? [...pag.querySelectorAll("a")].find(a => /下一页|next|›|»/i.test(a.innerText)) : null;
    return { items: out, next: next ? next.href : "" };
  });
  let added = 0;
  for (const it of batch.items) {
    if (seenArt.has(it.url)) continue;
    seenArt.add(it.url);
    articles.push(it);
    added++;
  }
  console.log(`PAGE ${p}: +${added} (total ${articles.length})`);
  if (!batch.next || added === 0) break;
  await page.goto(batch.next, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
}

articles = articles.filter(a => /\/archives\/\d+\/?$/.test(a.url));
console.log("ARTICLES", articles.length);
if (LIMIT > 0 && articles.length > LIMIT) {
  articles = articles.slice(0, LIMIT);
  console.log("LIMIT ->", articles.length);
}

// ---------- 2. 逐篇提取 + 下载 ----------
const manifestPath = OUT_DIR + "/manifest.csv";
if (!existsSync(manifestPath)) {
  await writeFile(manifestPath, "index,vid,title,file,bytes,resolution,bitrate,hasAudio,duration,candidates\n");
}

const itemsOut = [];
let ok = 0, skip = 0, fail = 0, seq = 0;

for (let ai = 0; ai < articles.length; ai++) {
  const art = articles[ai];
  const archiveId = (art.url.match(/\/archives\/(\d+)/) || [])[1] || String(ai + 1);
  let artTitle = "", artDate = "", vids = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(art.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2200);
      const r = await page.evaluate(async () => {
        const out = { title: "", date: "", videos: [] };
        out.title = (document.querySelector("h1")?.innerText || document.title || "").trim();
        const tm = (document.body.innerText || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (tm) out.date = `${tm[1]}-${String(tm[2]).padStart(2, "0")}-${String(tm[3]).padStart(2, "0")}`;
        const seen = new Set();
        for (const d of document.querySelectorAll("div.dplayer[data-config]")) {
          let cfg = null;
          try { cfg = JSON.parse(d.getAttribute("data-config")); } catch (e) { continue; }
          if (!cfg || !cfg.video || !cfg.video.url) continue;
          const u = cfg.video.url;
          if (seen.has(u)) continue;
          seen.add(u);
          const v = { url: u, type: cfg.video.type || "", variants: [], segments: 0, duration: 0, encrypted: false };
          try {
            const resp = await fetch(u, { credentials: "omit" });
            v.status = resp.status;
            const txt = await resp.text();
            v.encrypted = /#EXT-X-KEY:METHOD=AES-128/.test(txt);
            const durs = [...txt.matchAll(/#EXTINF:([\d.]+)/g)].map(m => parseFloat(m[1]));
            v.segments = durs.length;
            v.duration = Math.round(durs.reduce((a, b) => a + b, 0));
            if (/#EXT-X-STREAM-INF/.test(txt)) {
              const lines = txt.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
                const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
                const res = (lines[i].match(/RESOLUTION=(\d+)x(\d+)/) || []);
                const uri = (lines[i + 1] || "").trim();
                if (!uri) continue;
                v.variants.push({ uri, bw, w: Number(res[1] || 0), h: Number(res[2] || 0) });
              }
            }
          } catch (e) { v.err = e.message; }
          out.videos.push(v);
        }
        return out;
      });
      artTitle = r.title || art.text || archiveId;
      artDate = r.date || "";
      vids = r.videos || [];
      if (vids.length) break;
      console.log(`  [${archiveId}] 第 ${attempt} 次未取到视频，重试...`);
      await page.waitForTimeout(2500);
    } catch (e) {
      console.log(`  [${archiveId}] 加载失败(${attempt}): ${e.message.slice(0, 120)}`);
      await page.waitForTimeout(2000);
    }
  }

  if (filterRe && !filterRe.test(artTitle)) {
    console.log(`[${ai + 1}/${articles.length}] SKIP(filter) ${artTitle.slice(0, 40)}`);
    continue;
  }
  if (!vids.length) {
    console.log(`[${ai + 1}/${articles.length}] NO-VIDEO ${archiveId} ${artTitle.slice(0, 40)}`);
    fail++;
    itemsOut.push({ archiveId, url: art.url, title: artTitle, date: artDate, videos: [], note: "no-video" });
    continue;
  }

  for (let vi = 0; vi < vids.length; vi++) {
    const v = vids[vi];
    seq++;
    const idx = String(seq).padStart(3, "0");
    const titleSafe = sanitize(artTitle, 60);
    const file = `${idx}_${archiveId}_${vi + 1}_${titleSafe}.mp4`;
    const dest = OUT_DIR + "\\" + file;
    const workDir = OUT_DIR + "\\_tmp_" + idx;

    // ---- 多档择优（master playlist 多档全收，交给内核排序） ----
    const raw = [];
    if (v.variants && v.variants.length) {
      for (const va of v.variants) {
        let abs = va.uri;
        try { abs = new URL(va.uri, v.url).href; } catch (e) {}
        raw.push({ url: abs, w: va.w, h: va.h, br: va.bw, def: va.h ? `${va.h}p` : "" });
      }
    } else {
      raw.push({ url: v.url, def: "hls", br: 0 });
    }
    const cands = rankCands(raw);
    const best = pickBest(cands) || { url: v.url };
    const nCand = cands.length;

    // ---- 断点续传：成品已存在且时长吻合则跳过 ----
    if (existsSync(dest) && statSync(dest).size > 1024 * 100) {
      const pi = await probe(dest);
      if (pi && (v.duration === 0 || pi.duration >= v.duration * 0.95)) {
        console.log(`[${idx}] SKIP exists ${(pi.size / 1048576).toFixed(0)}MB ${pi.w}x${pi.h} ${pi.duration}s`);
        skip++;
        await appendFile(manifestPath, `${idx},${archiveId},${sanitize(artTitle, 80)},${file},${pi.size},${pi.w}x${pi.h},${pi.vbr},${pi.hasAudio ? 1 : 0},${pi.duration},${nCand}\n`);
        itemsOut.push({ idx, archiveId, url: art.url, title: artTitle, date: artDate, file, duration: pi.duration, w: pi.w, h: pi.h, nCand, skipped: true });
        continue;
      }
    }

    console.log(`[${idx}] DL ${archiveId}#${vi + 1} cands=${nCand} exp=${v.duration}s ${titleSafe.slice(0, 30)}`);
    let done = false, lastErr = "";
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      try {
        let curUrl = best.url;
        if (attempt > 1) {
          // 签名可能过期：重新加载文章页拿新 URL
          await page.goto(art.url, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(2000);
          const fresh = await page.evaluate(() => {
            const out = [];
            for (const d of document.querySelectorAll("div.dplayer[data-config]")) {
              try {
                const cfg = JSON.parse(d.getAttribute("data-config"));
                if (cfg.video && cfg.video.url) out.push(cfg.video.url);
              } catch (e) {}
            }
            return out;
          });
          if (fresh[vi]) curUrl = fresh[vi];
        }
        const t0 = Date.now();
        // 优先 yt-dlp（更快且原生断点续传）；失败/不可用则回退自研分片器
        let sec = 0, expDur = v.duration || 0, usedEngine = "";
        let ytOk = false;
        if (YT_OK) {
          const r = await YT.downloadWithYtdlp({
            url: curUrl,
            dest,
            referer: "https://www.91cg1.com/",
            concurrency: 16,
            timeoutMs: 3600000,
          });
          if (r.ok) {
            const pi0 = await probe(dest);
            // yt-dlp 自己就会校验分片完整性；这里再用时长兜底一次
            if (pi0 && pi0.w && (expDur === 0 || pi0.duration >= expDur * 0.9)) {
              ytOk = true;
              usedEngine = "yt-dlp";
              sec = r.elapsedSec;
            } else {
              console.log(`  yt-dlp 产物不完整（${pi0 ? pi0.duration : "?"}s < ${expDur}s），回退自研`);
            }
          } else {
            console.log(`  yt-dlp 失败: ${String(r.error || "").slice(0, 120)} → 回退自研`);
          }
        }
        if (!ytOk) {
          // yt-dlp 可能留下半成品 / .part，先清掉再交给自研分片器，避免 ffmpeg 读到坏文件
          if (existsSync(dest)) { try { await unlink(dest); } catch (e) {} }
          const meta = await downloadHls(curUrl, "https://www.91cg1.com/", workDir, dest, (m) => console.log(m));
          sec = Math.round((Date.now() - t0) / 1000);
          expDur = meta.expectedDuration || expDur;
          usedEngine = "自研分片器";
        }
        const pi = await probe(dest);
        if (!pi || !pi.w) throw new Error("probe failed / no video stream");
        // 完整性校验：期望时长优先取 playlist 累加值（比页面里的更可靠）
        if (expDur > 0 && pi.duration < expDur * 0.9) {
          throw new Error(`incomplete ${pi.duration}s < ${expDur}s`);
        }
        console.log(`  OK ${(pi.size / 1048576).toFixed(0)}MB ${pi.w}x${pi.h} ${pi.duration}s ${sec}s elapsed hasAudio=${pi.hasAudio} via ${usedEngine}`);
        await appendFile(manifestPath, `${idx},${archiveId},${sanitize(artTitle, 80)},${file},${pi.size},${pi.w}x${pi.h},${pi.vbr},${pi.hasAudio ? 1 : 0},${pi.duration},${nCand}\n`);
        itemsOut.push({ idx, archiveId, url: art.url, title: artTitle, date: artDate, file, duration: pi.duration, w: pi.w, h: pi.h, nCand });
        ok++;
        done = true;
      } catch (e) {
        lastErr = e.message;
        console.log(`  attempt ${attempt} FAIL: ${e.message.slice(0, 200)}`);
        if (!e.incomplete) { try { await unlink(dest).catch(() => {}); } catch (x) {} }
        await page.waitForTimeout(3000);
      }
    }
    if (!done) {
      fail++;
      console.log(`  GIVE UP ${idx}: ${lastErr.slice(0, 200)}`);
      itemsOut.push({ idx, archiveId, url: art.url, title: artTitle, date: artDate, file, nCand, error: lastErr });
    }
  }
}

await writeFile(OUT_DIR + "/_items.json", JSON.stringify({ source: PAGE_URL, articles: articles.length, items: itemsOut }, null, 2));
const totBytes = itemsOut.reduce((a, it) => {
  try { return a + (it.file && existsSync(OUT_DIR + "\\" + it.file) ? statSync(OUT_DIR + "\\" + it.file).size : 0); } catch (e) { return a; }
}, 0);
console.log(`DONE ok=${ok} skip=${skip} fail=${fail} files=${itemsOut.length} totalMB=${(totBytes / 1048576).toFixed(0)}`);
