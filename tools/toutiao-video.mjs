// toutiao-video.mjs — 头条小视频批量下载（多档择优）
// 由 ego-browser 运行时执行；配置来自脚本同目录 emd-config.json（绝对路径兜底）
//
// 【铁律】同一作品有多档清晰度时，必须全部收集后按「分辨率→码率→体积」取最高，
// 绝不能直接用 play_addr.url_list[0]（那是默认档，常只有 480p）。
// 候选来源两处，都要合并：
//   1) video.play_addr_list[]      —— 有 definition/bitrate/size，无宽高
//   2) video_play_info.video_list[] —— 是 JSON 字符串，video_meta 里有真实 vwidth/vheight（最准）
import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// ---- 公共环境模块（cmd stdin 下相对 import 不可靠，用多候选目录定位）----
// 注意：ego-browser 用 cmd stdin 跑脚本时，脚本被当作 [eval2] 执行，
// 相对 import 会解析到 ego 安装目录而不是脚本所在目录 —— 故由 _env.mjs 用候选目录定位。
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

// 配置读取：由 _env.mjs 给出候选路径（EMD_CONFIG / 任务目录 / 工作目录）
let PAGE_URL = process.env.EMD_URL || "", OUT_DIR = process.env.EMD_OUT || "", TYPE = process.env.EMD_TYPE || "video";
for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    PAGE_URL = PAGE_URL || cfg.url || ""; OUT_DIR = OUT_DIR || cfg.out || ""; TYPE = cfg.type || TYPE;
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-toutiao-dl");
const page = task.page("p1");

const hook = `
window.__feeds = [];
const __oOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__url=(u||''); return __oOpen.call(this,m,u,...rest); };
const __oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...rest) { const self=this;
  this.addEventListener('load', function(){ try { if (self.__url && self.__url.indexOf('pc_profile_short_video')>-1) window.__feeds.push(JSON.parse(self.responseText)); }catch(e){} });
  return __oSend.call(this,...rest);
};
`;
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: hook });
await page.goto(PAGE_URL, { timeout: 40000 });
await page.waitForLoadState("load");
await page.waitForTimeout(5000);

// 作者名：从 document.title 的「XXX的头条主页」取（不要用 [class*="name"]，会命中城市选择器）
let author = "";
try {
  author = await page.evaluate(() => {
    const t = document.title || "";
    const m = t.match(/^(.*?)的头条主页/);
    if (m && m[1]) return m[1].trim();
    const el = document.querySelector(".name");
    return el ? (el.innerText || "").trim() : "";
  });
} catch (e) {}
console.log("AUTHOR", author);

// 滚动枚举全部
let prev = -1, stable = 0;
for (let i = 0; i < 200; i++) {
  await page.evaluate(() => {
    let sc = null, best = 0;
    for (const el of document.querySelectorAll('*')) {
      const diff = el.scrollHeight - el.clientHeight;
      const lis = el.querySelectorAll('li').length;
      if (diff > 200 && lis >= 6 && diff > best) { best = diff; sc = el; }
    }
    if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 8000, bubbles: true })); }
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1800);
  const n = await page.evaluate(() => {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/"]')) { const m = a.href.match(/\/video\/(\d+)/); if (m) seen.add(m[1]); }
    return seen.size;
  });
  if (n === prev) { stable++; if (stable >= 8) { console.log("stable at iter", i, "n=", n); break; } } else { stable = 0; prev = n; }
}

// 收集条目 + 原始候选（不在页面里排序，排序交给内核）
const raw = await page.evaluate(() => {
  const map = new Map();
  for (const f of (window.__feeds || [])) {
    for (const it of (f.data || [])) {
      const vid = it.group_id_str || it.item_id_str || String(it.id);
      if (!vid || map.has(vid)) continue;
      const v = it.video || {};
      const cands = [];
      // 来源1：play_addr_list（无宽高）
      for (const p of (v.play_addr_list || [])) {
        cands.push({
          url: (p.play_url_list || [])[0] || "", def: p.definition || "", quality: p.quality || "",
          br: p.bitrate || 0, size: p.size || 0, codec: p.codec_type || "", src: "play_addr_list",
        });
      }
      // 来源2：video_play_info.video_list（有真实 vwidth/vheight，最准）
      let info = null;
      try { info = JSON.parse(it.video_play_info || "null"); } catch (e) {}
      if (info && info.video_list) {
        for (const g of info.video_list) {
          const m = g.video_meta || {};
          cands.push({
            url: g.main_url || "", backup: g.backup_url || "",
            def: m.definition || "", quality: m.quality || "",
            w: m.vwidth || 0, h: m.vheight || 0,
            br: m.bitrate || m.real_bitrate || 0, size: m.size || 0,
            codec: m.codec_type || "", src: "play_info",
          });
        }
      }
      // 最后兜底：只有默认档时也放进来（内核会正常处理单候选）
      if (!cands.length && v.play_addr && v.play_addr.url_list && v.play_addr.url_list.length) {
        cands.push({ url: v.play_addr.url_list[0], def: "", br: v.bitrate || 0, size: v.size || 0, w: v.width || 0, h: v.height || 0, src: "play_addr" });
      }
      map.set(vid, {
        vid, title: (it.title || "").replace(/[\n,]/g, " "),
        srcW: v.width || 0, srcH: v.height || 0, duration: v.duration || 0,
        cands,
      });
    }
  }
  // DOM 兜底：只有链接没有数据的条目
  const seen = new Set(map.keys());
  for (const a of document.querySelectorAll('a[href*="/video/"]')) {
    const m = a.href.match(/\/video\/(\d+)/); if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    map.set(m[1], { vid: m[1], title: "", srcW: 0, srcH: 0, duration: 0, cands: [] });
  }
  return [...map.values()];
});

// 内核择优
const collected = raw.map((it) => {
  const ranked = rankCands(it.cands);
  const best = pickBest(ranked);
  return {
    vid: it.vid, title: it.title, srcW: it.srcW, srcH: it.srcH, duration: it.duration,
    def: best ? best.def : "", w: best ? best.w : 0, h: best ? best.h : 0,
    br: best ? best.br : 0, url: best ? best.url : "", backup: best ? best.backup : "",
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
      await page.goto(`https://www.toutiao.com/video/${it.vid}/`, { timeout: 40000 });
      await page.waitForLoadState("load");
      for (let t = 0; t < 25; t++) {
        src = await page.evaluate(() => { const v = document.querySelector("video"); return (v && (v.currentSrc || v.src)) || ""; });
        if (src) break; await page.waitForTimeout(1000);
      }
    }
    if (!src) { console.log("NO SRC"); fail++; continue; }
    let buf = null;
    for (const u of [src, it.backup].filter(Boolean)) {
      const resp = await fetch(u, { headers: { "User-Agent": UA, "Referer": "https://www.toutiao.com/" } });
      if (!resp.ok) { console.log("HTTP", resp.status); continue; }
      buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length >= 1024) break;
      buf = null;
    }
    if (!buf) { console.log("BAD BODY"); fail++; continue; }
    await writeFile(outPath, buf);
    const res = it.w && it.h ? `${it.w}x${it.h}` : it.def;
    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${it.vid},${it.title},${file},${buf.length},${res},${it.br}\n`);
    console.log("OK", buf.length, res);
    ok++;
  } catch (e) { console.log("ERR", e.message); fail++; }
}
console.log(`DONE ok=${ok} fail=${fail} skip=${skip} total=${collected.length}`);
