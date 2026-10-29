// xiaohongshu-media.mjs — 小红书图文 + 视频（多档择优，尽力而为）
// 由 ego-browser 运行时执行。读取同目录 emd-config.json：{url, out, type}
//
// 【铁律】同一张图/同一条视频有多档候选时必须取最高档：
//   图片：srcset 全档 + data-src/src/data-original，先「原图化」去掉 `@1280w_1l` 之类尺寸后缀，
//         再把同一张图的各尺寸归为一组取最大宽度
//   视频：<video> 的多个 <source> + currentSrc，按 height/码率择优
import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// 载入通用「多档择优」内核（cmd stdin 模式下相对 import 会解析到 ego 安装目录，必须用绝对 file://）
const Q = await (async () => {
  const cands = [
    "file:///F:/linshi/ego-task/_quality.mjs",
    "file:///C:/Users/LR/.agents/skills/ego-media-downloader/tools/_quality.mjs",
  ];
  for (const c of cands) { try { return await import(c); } catch (e) {} }
  throw new Error("无法加载 _quality.mjs（请与平台脚本一起复制到任务目录）");
})();
const { pickBestImage, originalImageUrl, guessImgWidth, pickBest, imgGroupKey } = Q;

let PAGE_URL = process.env.EMD_URL || "", OUT_DIR = process.env.EMD_OUT || "", TYPE = (process.env.EMD_TYPE || "all").toLowerCase();
for (const c of ["F:/linshi/ego-task/emd-config.json", new URL("./emd-config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]) {
  try {
    const cfg = JSON.parse(await readFile(c, "utf8"));
    PAGE_URL = PAGE_URL || cfg.url || ""; OUT_DIR = OUT_DIR || cfg.out || ""; TYPE = (cfg.type || TYPE).toLowerCase();
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out（请写 emd-config.json）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-xhs");
const page = task.page("p1");
await page.goto(PAGE_URL, { timeout: 40000 });
await page.waitForLoadState("load");
await page.waitForTimeout(4000);

// 作者名（尽力而为）
let author = "";
try {
  author = await page.evaluate(() => {
    const el = document.querySelector('.username, [class*="user-name"], [class*="nickname"]');
    let t = el ? (el.innerText || "").trim() : "";
    if (!t) { const m = (document.title || "").match(/^(.+?)\s*[-–]\s*小红书/); if (m) t = m[1].trim(); }
    return t;
  });
} catch (e) {}
console.log("AUTHOR", author);

// 是否单篇笔记
const isNote = /\/(explore|discovery)\/|xhslink\.com\//.test(PAGE_URL) || await page.evaluate(() => !!document.querySelector('[data-xhs-note-id]'));
let noteUrls = [PAGE_URL];
if (!isNote) {
  let prevN = -1, stable = 0;
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const n = await page.evaluate(() => {
      const s = new Set();
      for (const a of document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/"]')) {
        const m = a.href.match(/\/(explore|discovery)\/(\w+)/); if (m) s.add("https://www.xiaohongshu.com/explore/" + m[2]);
      }
      return s.size;
    });
    if (n === prevN) { stable++; if (stable >= 5) break; } else { stable = 0; prevN = n; }
  }
  noteUrls = await page.evaluate(() => {
    const s = new Set();
    for (const a of document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/"]')) {
      const m = a.href.match(/\/(explore|discovery)\/(\w+)/); if (m) s.add("https://www.xiaohongshu.com/explore/" + m[2]);
    }
    return [...s];
  });
}
console.log("NOTES", noteUrls.length);

// 逐篇收集原始候选（不排序）
const perNote = [];
let nid = 0;
for (const u of noteUrls) {
  nid++;
  await page.goto(u, { timeout: 40000 });
  await page.waitForLoadState("load");
  await page.waitForTimeout(2500);
  for (let t = 0; t < 5; t++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(800); }
  const media = await page.evaluate(() => {
    const videos = [], images = [];
    for (const v of document.querySelectorAll('video')) {
      for (const s of v.querySelectorAll('source[src]')) {
        videos.push({ url: s.src, def: s.getAttribute('label') || s.getAttribute('data-quality') || '', h: parseInt(s.getAttribute('height') || 0, 10) || 0 });
      }
      const cur = v.currentSrc || v.src;
      if (cur) videos.push({ url: cur, h: v.videoHeight || 0, w: v.videoWidth || 0 });
    }
    for (const img of document.querySelectorAll('img')) {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        for (const part of srcset.split(',')) {
          const bits = part.trim().split(/\s+/);
          if (!bits[0]) continue;
          const d = bits[1] || '';
          const w = /^\d+w$/.test(d) ? parseInt(d, 10) : 0;
          images.push({ url: bits[0], w });
        }
      }
      for (const attr of ['data-src', 'src', 'data-original']) {
        const raw = img.getAttribute(attr);
        if (raw) images.push({ url: raw, w: parseInt(img.getAttribute('width') || 0, 10) || 0 });
      }
      if (img.naturalWidth) images.push({ url: img.currentSrc || img.src, w: img.naturalWidth });
    }
    return { videos, images };
  });
  perNote.push({ note: nid, url: u, ...media });
}

// 内核择优：每篇笔记内，视频按档位选最高、图片按原图化归组后选最大
const items = [];
for (const n of perNote) {
  // 视频：按归一化 URL 去重后择优
  const seenV = new Set();
  const vList = [];
  for (const v of n.videos) {
    const k = v.url.split('#')[0].split('?')[0];
    if (seenV.has(k)) continue; seenV.add(k);
    vList.push(v);
  }
  const vBest = pickBest(vList);
  if (vBest) items.push({ type: "video", url: vBest.url, note: n.note, h: vBest.h || 0 });

  // 图片：原图化 → 按内核 imgGroupKey 归组 → 组内取最大宽度
  const groups = new Map();
  for (const c of n.images) {
    const orig = originalImageUrl(c.url);
    if (!/\.(jpg|jpeg|png|webp|gif|avif)/i.test(orig)) continue;
    const key = imgGroupKey(c.url);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, url: orig });
  }
  for (const [, g] of groups) {
    const best = pickBestImage(g);
    if (best) items.push({ type: "image", url: best.url, note: n.note, w: best.w || guessImgWidth(best.url) });
  }
}

console.log("COLLECTED", items.length, "media");
await writeFile(OUT_DIR + "/_items.json", JSON.stringify(items, null, 2));
if (!existsSync(OUT_DIR + "/manifest.csv")) {
  await writeFile(OUT_DIR + "/manifest.csv", "index,note,type,file,bytes,quality\n");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
let ok = 0, fail = 0, skip = 0;
for (let i = 0; i < items.length; i++) {
  const { url, type, note } = items[i];
  if (TYPE === "video" && type !== "video") continue;
  if (TYPE === "image" && type !== "image") continue;
  const ext = type === "video" ? ".mp4" : ".jpg";
  const idx = String(i + 1).padStart(3, "0");
  const file = idx + "_n" + note + "_" + (url.split('/').pop().split('?')[0].slice(-12) || i) + ext;
  const outPath = OUT_DIR + "/" + file;
  if (existsSync(outPath)) { skip++; continue; }
  process.stdout.write(`[${idx}] ${type} ... `);
  try {
    const resp = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://www.xiaohongshu.com/" }, redirect: "follow" });
    if (!resp.ok) { console.log("HTTP", resp.status); fail++; continue; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 512) { console.log("BAD BODY"); fail++; continue; }
    await writeFile(outPath, buf);
    const q = type === "video" ? (items[i].h ? `${items[i].h}p` : "") : (items[i].w ? `${items[i].w}w` : "");
    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${note},${type},${file},${buf.length},${q}\n`);
    console.log("OK", buf.length, q);
    ok++;
  } catch (e) { console.log("ERR", e.message); fail++; }
}
console.log(`DONE ok=${ok} fail=${fail} skip=${skip} total=${items.length}`);
