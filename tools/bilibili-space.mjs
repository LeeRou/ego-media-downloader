// bilibili-space.mjs — B站 UP主投稿 批量下载（多档择优 · 走 playurl API 取权威档位）
// 由 ego-browser 运行时执行。读取同目录 emd-config.json：{url, out, type}
// 流程：打开 UP 主页 → 滚动加载全部视频卡片 → 收集 BV id → 逐个打开视频页、
//       调 playurl API 拿全部 dash 档位 → 内核按「分辨率→编码偏好→码率」择优 → ffmpeg 合并 → 落盘（已存在跳过）。
//
// 【为什么不猜 .m4s 文件名】实测 `-1-100026.m4s` 是 AV1 视频流（codecid 13）不是音频；
//   `30232` 是 132k 音频。靠文件名猜会把视频当音频 → 成品没音轨。playurl 才是权威来源。
import { writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const FFMPEG = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "C:\\ffmpeg\\bin\\ffprobe.exe";

// 载入通用「多档择优」内核（cmd stdin 模式下相对 import 会解析到 ego 安装目录，必须用绝对 file://）
const Q = await (async () => {
  const cands = [
    "file:///F:/linshi/ego-task/_quality.mjs",
    "file:///C:/Users/LR/.agents/skills/ego-media-downloader/tools/_quality.mjs",
  ];
  for (const c of cands) { try { return await import(c); } catch (e) {} }
  throw new Error("无法加载 _quality.mjs（请与平台脚本一起复制到任务目录）");
})();
const { pickBiliDash, BILI_QN, BILI_CODEC_NAME } = Q;

let PAGE_URL = process.env.EMD_URL || "", OUT_DIR = process.env.EMD_OUT || "", TYPE = process.env.EMD_TYPE || "all";
for (const c of ["F:/linshi/ego-task/emd-config.json", new URL("./emd-config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]) {
  try {
    const cfg = JSON.parse(await readFile(c, "utf8"));
    PAGE_URL = PAGE_URL || cfg.url || ""; OUT_DIR = OUT_DIR || cfg.out || ""; TYPE = cfg.type || TYPE;
    console.log("CONFIG", c);
    break;
  } catch (e) {}
}
if (!PAGE_URL || !OUT_DIR) { console.log("缺少 url / out（请写 emd-config.json）"); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-bili-space");
const page = task.page("p1");

// 抓流 hook（音频/视频分类规则见 bilibili-video.mjs 注释）
const STREAM_HOOK = `
window.__m4s = { video: [], audio: [] };
const pushM4s = (u) => {
  if (!u || !/\\.m4s(\\?|$)/.test(u)) return;
  const isAudioCode = /-(30216|30232|30280)\\.m4s/.test(u);
  if (/_t\\d+-1-/.test(u) || isAudioCode) {
    if (!window.__m4s.audio.includes(u)) window.__m4s.audio.push(u);
  } else {
    if (!window.__m4s.video.includes(u)) window.__m4s.video.push(u);
  }
};
const __oOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m,u,...r){ this.__u=(u||''); return __oOpen.call(this,m,u,...r); };
const __oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...r){ const self=this; pushM4s(self.__u); return __oSend.call(this,...r); };
const __of = window.fetch;
window.fetch = function(u,o){ const s=(u&&u.url)||String(u); pushM4s(s); return __of.call(this,u,o); };
`;

// 1) 收集全部 BV id（不需要 m4s hook，档位走 playurl API）
await page.goto(PAGE_URL, { timeout: 40000 });
await page.waitForLoadState("load");
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const t = [...document.querySelectorAll('*')].find(e => /^(投稿|视频)$/.test((e.textContent || '').trim()) && e.children.length === 0);
  if (t && t.click) t.click();
});
await page.waitForTimeout(1500);
let prev = -1, stable = 0;
for (let i = 0; i < 80; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  const n = await page.evaluate(() => {
    const s = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) { const m = a.href.match(/\/video\/(BV[\w]+)/); if (m) s.add(m[1]); }
    return s.size;
  });
  if (n === prev) { stable++; if (stable >= 5) { console.log("stable at iter", i, "n=", n); break; } } else { stable = 0; prev = n; }
}
const ids = await page.evaluate(() => {
  const s = new Set();
  for (const a of document.querySelectorAll('a[href*="/video/BV"]')) { const m = a.href.match(/\/video\/(BV[\w]+)/); if (m) s.add(m[1]); }
  return [...s];
});
console.log("COLLECTED", ids.length, "BV ids");

// 下载：接受候选对象 {url, backup}（也兼容纯字符串）
async function dl(cand, dest) {
  const urls = (typeof cand === "string") ? [cand] : [cand.url, cand.backup].filter(Boolean);
  let lastErr = "";
  for (const src of urls) {
    try {
      const resp = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com" }, redirect: "follow" });
      if (!resp.ok) { lastErr = "HTTP " + resp.status; continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1024) { lastErr = "BAD BODY"; continue; }
      await writeFile(dest, buf);
      return buf.length;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr || "all urls failed");
}

// 抓一个 BV 的全部档位（走 playurl API，权威）
async function fetchStreams(bv) {
  await page.goto("https://www.bilibili.com/video/" + bv + "/", { timeout: 40000 });
  await page.waitForLoadState("load");
  await page.waitForTimeout(2500);
  return await page.evaluate(async (bvArg) => {
    const s = window.__INITIAL_STATE__ || {};
    const vd = s.videoData || {};
    const bvid = s.bvid || vd.bvid || bvArg || (location.href.match(/BV[\w]+/) || [""])[0];
    let cid = s.cid || vd.cid || 0;
    if (!cid) {
      const m = document.documentElement.innerHTML.match(/"cid"\s*:\s*(\d+)/);
      if (m) cid = Number(m[1]);
    }
    if (!bvid || !cid) return { err: "no bvid/cid", bvid, cid };
    for (const fnval of [4048, 16]) {
      try {
        const resp = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=${fnval}&fourk=1`, { credentials: "include" });
        const j = await resp.json();
        const d = j.data || {};
        const dash = d.dash || {};
        if (dash.video && dash.video.length) {
          return {
            bvid, cid,
            accept: d.accept_description || [],
            video: dash.video.map(v => ({ id: v.id, baseUrl: v.baseUrl, backupUrl: v.backupUrl, bandwidth: v.bandwidth, width: v.width, height: v.height, codecid: v.codecid })),
            audio: (dash.audio || []).map(a => ({ id: a.id, baseUrl: a.baseUrl, backupUrl: a.backupUrl, bandwidth: a.bandwidth })),
            dolby: dash.dolby && dash.dolby.audio ? dash.dolby.audio.map(a => ({ id: a.id, baseUrl: a.baseUrl, bandwidth: a.bandwidth })) : [],
          };
        }
      } catch (e) {}
    }
    return { err: "no dash", bvid, cid };
  }, bv);
}

if (!existsSync(OUT_DIR + "/manifest.csv")) {
  await writeFile(OUT_DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution,qn,codec,hasAudio\n");
}
let ok = 0, fail = 0, skip = 0;
for (let i = 0; i < ids.length; i++) {
  const bv = ids[i];
  const idx = String(i + 1).padStart(3, "0");
  const file = idx + "_" + bv + ".mp4";
  const outPath = OUT_DIR + "/" + file;
  if (existsSync(outPath)) { skip++; console.log(`[${idx}] ${bv} EXISTS skip`); continue; }
  process.stdout.write(`[${idx}/${ids.length}] ${bv} ... `);
  try {
    const ms = await fetchStreams(bv);
    if (!ms.video || !ms.video.length) { console.log("NO DASH", ms.err || ""); fail++; continue; }
    const { video: vBest, audio: aBest, allVideo } = pickBiliDash(ms.video, [...(ms.audio || []), ...(ms.dolby || [])]);
    if (!vBest) { console.log("NO VIDEO"); fail++; continue; }
    const vTmp = OUT_DIR + "/_v.m4s", aTmp = OUT_DIR + "/_a.m4s";
    await dl(vBest, vTmp);
    let az = 0;
    if (aBest) az = await dl(aBest, aTmp);
    await execFileP(FFMPEG, ["-y", "-i", vTmp, ...(az > 0 ? ["-i", aTmp] : []), "-c", "copy", outPath], { windowsHide: true });
    try { await unlink(vTmp); if (az > 0) await unlink(aTmp); } catch (e) {}
    const sz = statSync(outPath).size;
    const def = BILI_QN[vBest.qn] || `qn${vBest.qn}`;
    // 校验音轨
    let streams = "";
    try {
      const { stdout } = await execFileP(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", outPath], { windowsHide: true });
      streams = stdout.trim();
    } catch (e) {}
    const hasAudio = /aac|audio/i.test(streams);
    await appendFile(OUT_DIR + "/manifest.csv", `${idx},${bv},,${file},${sz},${vBest.w}x${vBest.h},${vBest.qn},${BILI_CODEC_NAME[vBest.codecid] || vBest.codecid},${hasAudio ? 1 : 0}\n`);
    console.log("OK", sz, `${vBest.w}x${vBest.h}`, `qn候选${allVideo.length}`, "hasAudio=" + hasAudio);
    ok++;
  } catch (e) { console.log("ERR", e.message); fail++; }
}
console.log(`DONE ok=${ok} fail=${fail} skip=${skip} total=${ids.length}`);
