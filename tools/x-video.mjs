// x-video.mjs — X (Twitter) 视频/图片批量下载（已验证配方）
// 读取同目录 emd-config.json：{url, out, type, filter?}
//
// 核心机制：
//  X 是 SPA，视频 src 是 blob，无法直接取。真正的直链在 GraphQL 响应的
//  `extended_entities.media[].video_info.variants[]` 里，同一视频有多档 mp4
//  （如 480x270 / 640x360 / 1280x720 / 1920x1080）。必须全部收集后择优，取最高。
//  图片在 `media[].media_url_https`，可用 `?name=orig` 拿原图。
//
// 做法：XHR 钩子抓所有 /graphql/ 响应 → 解析出 media 列表 → 按 _quality 择优 → 下载。
import { writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { rankCands, pickBest, guessImgWidth } from "./_quality.mjs";

let PAGE_URL = process.env.EMD_URL || "";
let OUT_DIR = process.env.EMD_OUT || "";
let TYPE = process.env.EMD_TYPE || "all";
let FILTER = (process.env.EMD_FILTER || "").split("|").map(s => s.trim()).filter(Boolean);
let LIMIT = Number(process.env.EMD_LIMIT || 0) || 0;
try {
  const cfg = JSON.parse(await readFile(new URL("./emd-config.json", import.meta.url), "utf8"));
  PAGE_URL = PAGE_URL || cfg.url || "";
  OUT_DIR = OUT_DIR || cfg.out || "";
  TYPE = cfg.type || TYPE;
  if (cfg.filter) FILTER = String(cfg.filter).split("|").map(s => s.trim()).filter(Boolean);
  if (cfg.limit) LIMIT = Number(cfg.limit) || 0;
} catch (e) {}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 EMD_URL / EMD_OUT"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const LOGFILE = OUT_DIR + "/_run.log";
async function LOG(...a) { const s = a.join(" ") + "\n"; process.stdout.write(s); try { await appendFile(LOGFILE, s); } catch (e) {} }

const task = await taskSpace("emd-x");
const page = task.page("p1");

// XHR + fetch 双钩子，抓所有 graphql 响应
const HOOK = `
window.__xApi = [];
const grab = (u, body) => {
  if (!body || body.length < 200) return;
  if (!/graphql/i.test(u || '')) return;
  window.__xApi.push({ url: u, body });
};
const __oOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m,u,...r){ this.__u=(u||''); return __oOpen.call(this,m,u,...r); };
const __oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...r){
  const self=this;
  this.addEventListener('load', function(){ try { grab(self.__u, self.responseText); } catch(e){} });
  return __oSend.call(this,...r);
};
const __of = window.fetch;
window.fetch = function(u, o){
  const s = (u && u.url) || String(u);
  const p = __of.call(this, u, o);
  if (/graphql/i.test(s)) { try { p.then(r => r.clone().text().then(t => grab(s, t)).catch(()=>{})).catch(()=>{}); } catch(e){} }
  return p;
};
`;
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000);

// 滚动加载全部
let prev = -1, stable = 0;
for (let i = 0; i < 200; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1600);
  const n = await page.evaluate(() => (window.__xApi || []).length);
  if (n === prev) { stable++; if (stable >= 8) { LOG("scroll stable iter", i, "apiCount", n); break; } }
  else { stable = 0; prev = n; }
}

// 从所有 GraphQL 响应里解析 media
const parsed = await page.evaluate(() => {
  const apis = window.__xApi || [];
  const videos = [];   // {key, variants:[{url,w,h,br}], poster, tweetId}
  const images = [];   // {key, url, w}
  const seenV = new Set(), seenI = new Set();

  const walk = (obj, depth) => {
    if (!obj || depth > 40 || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const x of obj) walk(x, depth + 1); return; }
    // 视频：video_info.variants
    if (obj.video_info && Array.isArray(obj.video_info.variants)) {
      const variants = [];
      for (const v of obj.video_info.variants) {
        if (!v || !v.url) continue;
        if (!/mp4/i.test(v.content_type || v.url)) continue; // 跳过 m3u8
        const m = String(v.url).match(/\/(\d+)x(\d+)\//);
        variants.push({ url: v.url, w: m ? +m[1] : 0, h: m ? +m[2] : 0, br: v.bitrate || 0 });
      }
      if (variants.length) {
        // 用 poster/expanded_url 或首个 variant 路径做 key
        const idm = String(obj.media_url_https || (variants[0] && variants[0].url) || '').match(/(?:amplify_video|ext_tw_video)\/(\d+)/);
        const key = idm ? idm[1] : (obj.id_str || String(variants[0].url).slice(0, 80));
        if (!seenV.has(key)) { seenV.add(key); videos.push({ key, variants, poster: obj.media_url_https || '' }); }
      }
    }
    // 图片：type=photo
    if (obj.type === 'photo' && obj.media_url_https) {
      const u = obj.media_url_https;
      const base = u.split('?')[0];
      if (!seenI.has(base)) { seenI.add(base); images.push({ key: base, url: base }); }
    }
    for (const k in obj) { if (k === 'video_info') continue; const v = obj[k]; if (v && typeof v === 'object') walk(v, depth + 1); }
  };

  for (const a of apis) {
    try { walk(JSON.parse(a.body), 0); } catch (e) {}
  }
  return { videos, images, apiCount: apis.length };
});

LOG("API responses:", parsed.apiCount, "| videos:", parsed.videos.length, "| images:", parsed.images.length);

// X 的媒体 ID 是雪花 ID（snowflake），数字越大 = 越新。按 ID 降序 = 最新在前。
const isSnowflake = (k) => /^\d{15,20}$/.test(String(k || ""));
parsed.videos.sort((a, b) => {
  const sa = isSnowflake(a.key) ? BigInt(a.key) : 0n;
  const sb = isSnowflake(b.key) ? BigInt(b.key) : 0n;
  return sb > sa ? 1 : sb < sa ? -1 : 0;
});
if (LIMIT > 0) {
  LOG(`LIMIT: 只取最新 ${LIMIT} 条（原 ${parsed.videos.length} 条）`);
  parsed.videos = parsed.videos.slice(0, LIMIT);
}

// 用户名
let userName = "";
try {
  userName = await page.evaluate(() => {
    const h = document.querySelector('[data-testid="UserName"]');
    if (h) { const t = h.innerText.split("\n").map(s=>s.trim()).filter(Boolean); return t[0] || ""; }
    return "";
  });
} catch (e) {}
if (!userName) {
  const m = PAGE_URL.match(/(?:x|twitter)\.com\/([^/?#]+)/);
  userName = m ? m[1] : new Date().toISOString().slice(0, 10);
}
userName = userName.replace(/[\\/:*?"<>|]/g, "_").trim() || new Date().toISOString().slice(0, 10);
LOG("USER:", userName);

// 输出子目录：<out>/<用户名>/
const DIR = OUT_DIR + "/" + userName;
await mkdir(DIR, { recursive: true });
LOG("OUT:", DIR);

await writeFile(DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution,bitrate\n");

async function dl(url, dest) {
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://x.com/" }, redirect: "follow" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

let ok = 0, fail = 0, skip = 0, idx = 0;
const doVideo = TYPE === "all" || TYPE === "video";
const doImage = TYPE === "all" || TYPE === "image";

if (doVideo) {
  for (const v of parsed.videos) {
    idx++;
    const n = String(idx).padStart(3, "0");
    const file = n + "_" + v.key + ".mp4";
    const outPath = DIR + "/" + file;
    // 多档择优（铁律：不取第一个）
    const ranked = rankCands(v.variants);
    const best = ranked[0];
    if (!best) { LOG(`[${n}] ${v.key} NO CANDIDATE`); fail++; continue; }
    if (existsSync(outPath)) { skip++; LOG(`[${n}] ${v.key} EXISTS skip (${best.w}x${best.h})`); continue; }
    process.stdout.write(`[${n}] ${v.key} ${best.w}x${best.h} ... `);
    try {
      let size = 0, used = best;
      for (const c of ranked) {   // 最高档失败就降级重试
        try { size = await dl(c.url, outPath); used = c; break; }
        catch (e) { LOG(`  fallback ${c.w}x${c.h}: ${e.message}`); }
      }
      if (!size) { LOG("ALL CANDIDATES FAILED"); fail++; continue; }
      await appendFile(DIR + "/manifest.csv", `${n},${v.key},,${file},${size},${used.w}x${used.h},${used.br}\n`);
      LOG(`OK ${size} ${used.w}x${used.h} (候选${ranked.length}档)`);
      ok++;
    } catch (e) { LOG("ERR " + e.message); fail++; }
  }
}

if (doImage) {
  for (const im of parsed.images) {
    idx++;
    const n = String(idx).padStart(3, "0");
    const base = im.url.split("/").pop() || "img";
    const ext = (base.match(/\.(jpe?g|png|webp|gif)$/i) || [".jpg"])[0];
    const file = n + "_" + base.replace(/[^\w.-]/g, "").slice(0, 40) + ext;
    const outPath = DIR + "/" + file;
    if (existsSync(outPath)) { skip++; continue; }
    // 原图：?name=orig 是推特最高档
    const orig = im.url + "?name=orig";
    try {
      const size = await dl(orig, outPath);
      await appendFile(DIR + "/manifest.csv", `${n},${im.key},,${file},${size},orig,\n`);
      LOG(`IMG OK ${size} ${file}`);
      ok++;
    } catch (e) { LOG("IMG ERR " + e.message); fail++; }
  }
}

LOG(`DONE ok=${ok} fail=${fail} skip=${skip}`);
