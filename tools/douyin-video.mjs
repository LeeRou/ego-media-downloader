// douyin-video.mjs — 抖音视频批量下载（多档择优）
// 由 ego-browser 运行时执行。读取同目录 emd-config.json：{url, out, type}
//
// 【铁律】同一作品有多档清晰度时，必须全部收集后按「分辨率→码率→体积」取最高，
// 绝不能直接取 video.play_addr.url_list[0]（那是默认档，通常是最低清晰度）。
// 抖音的候选来源（都要合并）：
//   1) video.play_addr / play_addr_h264 / play_addr_265 / play_addr_bytevc1 的 url_list
//   2) video.bit_rate[]  —— 每个元素含 gear_name / bit_rate / play_addr.url_list / is_h265
//   3) video.download_addr —— 下载档（有时比 play_addr 高一档）
import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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

// 载入通用「多档择优」内核（由 _env.mjs 在候选目录里定位）
const Q = await ENV.loadKernel("_quality.mjs");
const { rankCands, pickBest } = Q;

let PAGE_URL = process.env.EMD_URL || "", OUT_DIR = process.env.EMD_OUT || "", TYPE = process.env.EMD_TYPE || "video";
for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    PAGE_URL = PAGE_URL || cfg.url || ""; OUT_DIR = OUT_DIR || cfg.out || ""; TYPE = cfg.type || TYPE;
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out（请写 emd-config.json）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-douyin");
const page = task.page("p1");

// 劫持 XHR 捕获 aweme 列表（页面用 XHR，直接 fetch 会被拒）
const hook = `
window.__aweme = [];
const __oOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__url=(u||''); return __oOpen.call(this,m,u,...rest); };
const __oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...rest) { const self=this;
  this.addEventListener('load', function(){
    try {
      if (self.__url && self.__url.indexOf('aweme/v1/web/aweme/post') > -1) {
        const j = JSON.parse(self.responseText);
        if (j && j.aweme_list) window.__aweme.push(...j.aweme_list);
      }
    } catch(e){}
  });
  return __oSend.call(this,...rest);
};
`;
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: hook });
await page.goto(PAGE_URL, { timeout: 40000 });
await page.waitForLoadState("load");
await page.waitForTimeout(4000);

// 作者名
let author = "";
try {
  author = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="user-info-nickname"]')
      || document.querySelector('.share-title')
      || document.querySelector('[class*="nickname"]');
    let t = el ? (el.innerText || "").trim() : "";
    if (!t) {
      const m = (document.title || "").match(/^(.+?)(?:的抖音|-\s*抖音)/);
      if (m) t = m[1].trim();
    }
    return t;
  });
} catch (e) {}
console.log("AUTHOR", author);

// 滚动内部真实容器翻页
let prev = -1, stable = 0;
for (let i = 0; i < 200; i++) {
  await page.evaluate(() => {
    let sc = null, best = 0;
    for (const el of document.querySelectorAll('*')) {
      const diff = el.scrollHeight - el.clientHeight;
      const lis = el.querySelectorAll('li').length;
      if (diff > 200 && lis >= 6 && diff > best) { best = diff; sc = el; }
    }
    if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 5000, bubbles: true })); }
  });
  await page.waitForTimeout(1200);
  const n = await page.evaluate(() => (window.__aweme || []).length);
  const txt = await page.evaluate(() => document.body.innerText || "");
  if (/暂时没有更多|没有更多了|没有更多/.test(txt)) { console.log("end text at iter", i); break; }
  if (n === prev) { stable++; if (stable >= 6) { console.log("stable at iter", i); break; } } else { stable = 0; prev = n; }
}

// 收集条目 + 全部候选（排序交给内核）
const raw = await page.evaluate(() => {
  const map = new Map();
  for (const a of (window.__aweme || [])) {
    if (!a || !a.aweme_id) continue;
    const vid = String(a.aweme_id);
    if (map.has(vid)) continue;
    const v = a.video || {};
    const cands = [];
    // 来源1：bit_rate[] 每档带 gear_name/bit_rate/play_addr，最全
    for (const br of (v.bit_rate || [])) {
      const pa = br.play_addr || {};
      for (const u of (pa.url_list || [])) {
        cands.push({
          url: u, def: br.gear_name || "", br: br.bit_rate || 0,
          size: br.play_addr && br.play_addr.data_size || 0,
          codec: br.is_h265 ? "h265" : "h264", src: "bit_rate",
        });
      }
    }
    // 来源2：各 play_addr 变体
    for (const [key, codec] of [["play_addr", ""], ["play_addr_h264", "h264"], ["play_addr_265", "h265"], ["play_addr_bytevc1", "bytevc1"]]) {
      const pa = v[key];
      for (const u of ((pa && pa.url_list) || [])) {
        cands.push({ url: u, def: "", br: v.bitrate || 0, size: (pa && pa.data_size) || 0, codec, src: key });
      }
    }
    // 来源3：download_addr（下载档）
    const da = v.download_addr;
    for (const u of ((da && da.url_list) || [])) {
      cands.push({ url: u, def: "", br: v.bitrate || 0, size: (da && da.data_size) || 0, src: "download_addr" });
    }
    map.set(vid, {
      vid, title: (a.desc || "").replace(/[\n,]/g, " "),
      srcW: v.width || 0, srcH: v.height || 0,
      duration: v.duration || 0,
      cands,
    });
  }
  // DOM 兜底
  const seen = new Set(map.keys());
  for (const a of document.querySelectorAll('a[href*="/video/"]')) {
    const m = a.href.match(/\/video\/(\d+)/); if (!m || seen.has(m[1])) continue;
    if (/source=/.test(a.href)) continue;
    seen.add(m[1]);
    map.set(m[1], { vid: m[1], title: "", srcW: 0, srcH: 0, duration: 0, cands: [] });
  }
  return [...map.values()];
});

const collected = raw.map((it) => {
  const ranked = rankCands(it.cands);
  const best = pickBest(ranked);
  return {
    vid: it.vid, title: it.title, srcW: it.srcW, srcH: it.srcH, duration: it.duration,
    def: best ? best.def : "", w: best ? best.w : 0, h: best ? best.h : 0,
    br: best ? best.br : 0, url: best ? best.url : "",
    nCand: ranked.length,
    allDefs: ranked.map((c) => c.def).filter(Boolean).join("|"),
  };
});

console.log("COLLECTED", collected.length);
await writeFile(OUT_DIR + "/_items.json", JSON.stringify(collected, null, 2));
if (!existsSync(OUT_DIR + "/manifest.csv")) {
  await writeFile(OUT_DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution,bitrate\n");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
let ok = 0, fail = 0, skip = 0;
for (let i = 0; i < collected.length; i++) {
  const it = collected[i];
  const idx = String(i + 1).padStart(3, "0");
  const file = idx + "_" + it.vid + ".mp4";
  const outPath = OUT_DIR + "/" + file;
  if (existsSync(outPath)) { skip++; continue; }
  process.stdout.write(`[${idx}/${collected.length}] ${it.vid} ${it.def || it.w + "x" + it.h} ... `);
  try {
    let src = it.url;
    if (!src) {
      await page.goto(`https://www.douyin.com/video/${it.vid}`, { timeout: 40000 });
      await page.waitForLoadState("load");
      for (let t = 0; t < 25; t++) {
        src = await page.evaluate(() => { const v = document.querySelector("video"); return (v && (v.currentSrc || v.src)) || ""; });
        if (src) break; await page.waitForTimeout(1000);
      }
    }
    if (!src) { console.log("NO SRC"); fail++; continue; }
    const resp = await fetch(src, { headers: { "User-Agent": UA, "Referer": "https://www.douyin.com/" } });
    if (!resp.ok) { console.log("HTTP", resp.status); fail++; continue; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) { console.log("BAD BODY"); fail++; continue; }
    await writeFile(outPath, buf);
    const res = it.w && it.h ? `${it.w}x${it.h}` : it.def;
    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${it.vid},${it.title},${file},${buf.length},${res},${it.br}\n`);
    console.log("OK", buf.length, res);
    ok++;
  } catch (e) { console.log("ERR", e.message); fail++; }
}
console.log(`DONE ok=${ok} fail=${fail} skip=${skip} total=${collected.length}`);
