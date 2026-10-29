// youtube-video.mjs — YouTube 下载（已验证，高清版）
// 用法：读取同目录 emd-config.json：{url, out, type, filter?}
//
// 核心结论（踩坑记录）：
//  1) googlevideo 直链是 IP 绑定签名 URL → Node/页面/XHR/原生下载全 403；只有浏览器自己的 <video>(MSE) 能收到流。
//     解法：hook MediaSource.addSourceBuffer / SourceBuffer.appendBuffer，收集浏览器实际缓冲的分片，再 ffmpeg 合并。
//  2) 分辨率必须靠“大视口 + 强制最高清晰度”：
//     YouTube ABR 按【播放器可视窗口】选分辨率，窗口 355x631 只会给 360x640。
//     先 Emulation.setDeviceMetricsOverride(1920x1080)，再 setPlaybackQuality(最高可用) + setPlaybackQualityRange(q,q)，
//     并清掉切换前积累的低清分片，才能拿到 2160x3840 这种真高清。
//  3) 大缓冲不能一次性 base64 回传（页面会卡死）→ 增量 drain（每批 ≤20 块）。
//  4) page.goto 要 waitUntil:"domcontentloaded"（播放页 load 事件常超 30s）。
//  5) 标题从卡片 #video-title 的 title 属性取，不能用 shorts 链接自身文本（那是缩略图）。
import { writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const FFMPEG = "C:\\ffmpeg\\bin\\ffmpeg.exe";

// 载入通用「多档择优」内核（cmd stdin 模式下相对 import 会解析到 ego 安装目录，必须用绝对 file://）
const Q = await (async () => {
  const cands = [
    "file:///F:/linshi/ego-task/_quality.mjs",
    "file:///C:/Users/LR/.agents/skills/ego-media-downloader/tools/_quality.mjs",
  ];
  for (const c of cands) { try { return await import(c); } catch (e) {} }
  throw new Error("无法加载 _quality.mjs（请与平台脚本一起复制到任务目录）");
})();

// YouTube 清晰度标签 → 高度。hd2160/hd1440/hd1080/hd720 走内核通用解析，
// highres(8K+)/hd4320 这类别名在这里补一下，保证「多档择优」时排序正确。
const YT_DEF_HEIGHT = (label) => {
  const s = String(label || "").toLowerCase();
  if (s === "highres") return 4320;
  if (s === "hd4320") return 4320;
  const m = s.match(/(\d{3,4})/);
  if (m) return parseInt(m[1], 10);
  return Q.defToHeight(s);
};

let PAGE_URL = process.env.EMD_URL || "";
let OUT_DIR = process.env.EMD_OUT || "";
let TYPE = process.env.EMD_TYPE || "all";
let FILTER = (process.env.EMD_FILTER || "").split("|").map(s => s.trim()).filter(Boolean);
for (const c of ["F:/linshi/ego-task/emd-config.json", new URL("./emd-config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]) {
  try {
    const cfg = JSON.parse(await readFile(c, "utf8"));
    PAGE_URL = PAGE_URL || cfg.url || "";
    OUT_DIR = OUT_DIR || cfg.out || "";
    TYPE = cfg.type || TYPE;
    if (cfg.filter) FILTER = String(cfg.filter).split("|").map(s => s.trim()).filter(Boolean);
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 EMD_URL / EMD_OUT（写 emd-config.json 或在脚本顶部设置）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const LOGFILE = OUT_DIR + "/_run.log";
async function LOG(...a) { const s = a.join(" ") + "\n"; process.stdout.write(s); try { await appendFile(LOGFILE, s); } catch (e) {} }

const task = await taskSpace("emd-yt");
const page = task.page("p1");

// 大视口（ABR 依据）——必须在打开页面前设置
try {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
} catch (e) {}

const HOOK = `
window.__bufs = []; let __bufId = 0;
window.__stats = function(){ return (window.__bufs||[]).map(b=>({mime:b.mime,n:b.chunks.length,bytes:b.chunks.reduce((a,c)=>a+(c.byteLength||0),0)})); };
window.__drain = function(kind){
  const c = (window.__bufs||[]).filter(b=>new RegExp(kind).test(b.mime));
  if(!c.length) return null;
  const sum = b => b.chunks.reduce((a,x)=>a+(x.byteLength||0),0);
  const t = c.sort((a,b)=>sum(b)-sum(a))[0];
  if(!t || !t.chunks.length) return null;
  const p = t.chunks.splice(0,20);
  return p.map(x=>{ const u8=new Uint8Array(x); let s=''; for(let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); });
};
window.__dropLowRes = function(){
  const vb=(window.__bufs||[]).filter(b=>/video/.test(b.mime));
  if (vb.length>1) for (const b of vb.slice(0,-1)) b.chunks.length = 0;
};
try{
  const MS = window.MediaSource || window.WebKitMediaSource;
  if (MS && MS.prototype){
    const oa = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function(type){
      const sb = oa.call(this, type);
      const e = { mime: type, chunks: [] };
      window.__bufs.push(e);
      const oab = sb.appendBuffer;
      sb.appendBuffer = function(d){
        try { let ab=(d instanceof ArrayBuffer)?d:(d&&d.buffer)?d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength):d; e.chunks.push(ab); } catch(_){}
        return oab.call(this, d);
      };
      return sb;
    };
  }
}catch(e){}
`;
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });

// ---------- 1. 收集目标视频 ----------
const single = /[?&]v=([\w-]+)/.exec(PAGE_URL) || /\/shorts\/([\w-]+)/.exec(PAGE_URL);
let filtered;

if (single) {
  const id = single[1];
  LOG("SINGLE video mode:", id);
  filtered = [{ id, title: id }];
} else {
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(4000);
  let prev = -1, stable = 0;
  for (let i = 0; i < 120; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const n = await page.evaluate(() => {
      const s = new Set();
      for (const a of document.querySelectorAll('a[href*="/shorts/"]')) { const m = a.href.match(/\/shorts\/([\w-]+)/); if (m) s.add(m[1]); }
      for (const a of document.querySelectorAll('a[href*="/watch?v="]')) { const m = a.href.match(/[?&]v=([\w-]+)/); if (m) s.add(m[1]); }
      return s.size;
    });
    if (n === prev) { stable++; if (stable >= 6) { LOG("stable at iter", i, "n=", n); break; } }
    else { stable = 0; prev = n; }
  }
  const items = await page.evaluate(() => {
    const map = new Map();
    const cards = document.querySelectorAll('ytd-rich-item-renderer, ytd-reel-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, a[href*="/shorts/"], a[href*="/watch?v="]');
    for (const c of cards) {
      const a = c.querySelector ? c.querySelector('a[href*="/shorts/"], a[href*="/watch?v="]') : c;
      if (!a) continue;
      const href = a.href; let id = null;
      let m = href.match(/\/shorts\/([\w-]+)/); if (m) id = m[1];
      if (!id) { m = href.match(/[?&]v=([\w-]+)/); if (m) id = m[1]; }
      if (!id || map.has(id)) continue;
      let title = "";
      const tEl = c.querySelector ? c.querySelector('#video-title, a#video-title') : null;
      if (tEl) title = (tEl.getAttribute('title') || tEl.textContent || "").trim();
      if (!title && c.getAttribute) title = (c.getAttribute('title') || c.textContent || "");
      map.set(id, { id, title: (title || "").replace(/\s+/g, ' ').trim() });
    }
    return [...map.values()];
  });
  LOG("COLLECTED", items.length, "videos");
  filtered = FILTER.length ? items.filter(it => FILTER.some(k => (it.title || "").includes(k))) : items;
  LOG("FILTERED", filtered.length, "by", JSON.stringify(FILTER));
}

// ---------- 2. 逐个抓取 + 合并 ----------
async function drainTo(kind, file) {
  for (let round = 0; round < 400; round++) {
    const b64 = await page.evaluate(k => window.__drain(k), kind);
    if (!b64 || !b64.length) { if (round > 4) break; else { await page.waitForTimeout(400); continue; } }
    for (const b of b64) await appendFile(file, Buffer.from(b, "base64"));
  }
}

await writeFile(OUT_DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution\n");
let ok = 0, fail = 0, skip = 0;
for (let i = 0; i < filtered.length; i++) {
  const { id, title } = filtered[i];
  const idx = String(i + 1).padStart(3, "0");
  const file = (filtered.length === 1 ? "001_" : idx + "_") + id + ".mp4";
  const outPath = OUT_DIR + "/" + file;
  if (existsSync(outPath)) { skip++; LOG(`[${idx}] ${id} EXISTS skip`); continue; }
  LOG(`[${idx}/${filtered.length}] ${id} ...`);
  try {
    for (const t of ["_v.tmp", "_a.tmp"]) { try { await unlink(OUT_DIR + "/" + t); } catch (e) {} }
    await page.goto("https://www.youtube.com/watch?v=" + id, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(2500);

    // 强制最高可用清晰度：反复重试直到播放器真的切过去（一次调用常不生效）
    // 档位顺序不硬编码，交给 _quality.mjs 的 defToHeight 统一排序（遵循「多档择优」铁律）
    let forced = 'none';
    for (let attempt = 0; attempt < 10; attempt++) {
      // 先拿可用档位，Node 侧排序
      const avail = await page.evaluate(() => {
        try {
          const p = document.getElementById('movie_player');
          return (p && p.getAvailableQualityLevels && p.getAvailableQualityLevels()) || [];
        } catch (e) { return []; }
      });
      if (!avail.length) { forced = 'no-avail'; await page.waitForTimeout(800); continue; }
      // YouTube 标签 → 高度由内核解析（hd2160→2160, highres→2160+ ...）
      const best = [...avail].sort((a, b) => {
        const ha = YT_DEF_HEIGHT(a), hb = YT_DEF_HEIGHT(b);
        return hb - ha;
      })[0];

      forced = await page.evaluate((pick) => {
        try {
          const p = document.getElementById('movie_player');
          if (!p) return 'no-player';
          if (p.setPlaybackQuality) p.setPlaybackQuality(pick);
          if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(pick, pick);
          const cur = p.getPlaybackQuality ? p.getPlaybackQuality() : '';
          return pick + '|cur=' + cur;
        } catch (e) { return 'err'; }
      }, best);
      // 已切到目标清晰度就停
      const [want, cur] = forced.split('|cur=');
      if (cur && (cur === want || want === 'none')) break;
      await page.waitForTimeout(800);
    }
    LOG("  quality:", forced);

    await page.evaluate(async () => { const v = document.querySelector('video'); if (v) { v.muted = true; try { await v.play(); } catch (e) {} } });
    await page.waitForTimeout(4000);
    // 丢弃切换前积累的低清分片（只保留最后新建的高清 buffer）
    await page.evaluate(() => window.__dropLowRes && window.__dropLowRes());

    let lastTotal = 0, stall = 0;
    for (let k = 0; k < 120; k++) {
      const total = await page.evaluate(() => (window.__bufs || []).reduce((a, b) => a + b.chunks.reduce((x, c) => x + (c.byteLength || 0), 0), 0));
      await drainTo("video", OUT_DIR + "/_v.tmp");
      await drainTo("audio", OUT_DIR + "/_a.tmp");
      const vz = (() => { try { return statSync(OUT_DIR + "/_v.tmp").size; } catch (e) { return 0; } })();
      const end = await page.evaluate(() => { const vv = document.querySelector('video'); return vv && vv.buffered.length ? vv.buffered.end(vv.buffered.length - 1) : 0; });
      const dur = await page.evaluate(() => { const vv = document.querySelector('video'); return vv ? vv.duration : 0; });
      if (end >= dur - 1 && vz > 0) { LOG("  buffered", end.toFixed(1), "/", dur.toFixed(1)); break; }
      if (total > 0 && total === lastTotal && stall > 10) { LOG("  stall"); break; }
      if (total === lastTotal) stall++; else stall = 0;
      lastTotal = total;
      await page.waitForTimeout(700);
    }
    await drainTo("video", OUT_DIR + "/_v.tmp");
    await drainTo("audio", OUT_DIR + "/_a.tmp");

    const vz = (() => { try { return statSync(OUT_DIR + "/_v.tmp").size; } catch (e) { return 0; } })();
    const az = (() => { try { return statSync(OUT_DIR + "/_a.tmp").size; } catch (e) { return 0; } })();
    if (vz === 0) { LOG("  NO VIDEO"); fail++; continue; }

    const vM4s = OUT_DIR + "/_v.m4s", aM4s = OUT_DIR + "/_a.m4s";
    try { await unlink(vM4s); } catch (e) {}
    try { await unlink(aM4s); } catch (e) {}
    const fs = await import("node:fs/promises");
    await fs.copyFile(OUT_DIR + "/_v.tmp", vM4s);
    if (az > 0) await fs.copyFile(OUT_DIR + "/_a.tmp", aM4s);

    const args = az > 0
      ? ["-y", "-i", vM4s, "-i", aM4s, "-c", "copy", outPath]
      : ["-y", "-i", vM4s, "-c", "copy", outPath];
    await execFileP(FFMPEG, args, { windowsHide: true });

    // 记录真实分辨率
    let res = "";
    try {
      const { stdout } = await execFileP("C:\\ffmpeg\\bin\\ffprobe.exe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", outPath],
        { windowsHide: true });
      res = stdout.trim();
    } catch (e) {}

    for (const t of ["_v.tmp", "_a.tmp", "_v.m4s", "_a.m4s"]) { try { await unlink(OUT_DIR + "/" + t); } catch (e) {} }

    const sz = statSync(outPath).size;
    const safeTitle = (title || "").replace(/[\n,]/g, " ");
    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${id},${safeTitle},${file},${sz},${res}\n`);
    LOG("  OK", sz, res, az > 0 ? "(+audio)" : "(no audio)");
    ok++;
  } catch (e) { LOG("  ERR", e.message); fail++; }
}
LOG(`DONE ok=${ok} fail=${fail} skip=${skip} total=${filtered.length}`);
