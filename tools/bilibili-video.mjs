// bilibili-video.mjs — B站 单条视频下载（多档择优 · 走 playurl API 取权威档位）
// 由 ego-browser 运行时执行。读取同目录 emd-config.json：{url, out, type}
//
// 【为什么用 playurl API 而不是猜 .m4s 文件名】
//   实测 `-1-100026.m4s` 是 **AV1 视频流**（codecid 13），不是音频；`30232` 是 132k 音频。
//   靠文件名猜 qn/codec 极易把视频当音频，导致成品**没有音轨**（历史 bug）。
//   `x/player/playurl?fnval=4048&fourk=1` 直接返回 dash.video[]/dash.audio[]，
//   带真实 width/height/bandwidth/codecid —— 这才是权威档位来源。
//
// 【铁律】dash.video 里有多档（qn 16/32/64/80/112/116/120/125/126/127，且每档有 h264/hevc/av1 三种 codec），
//   必须按「分辨率 → 编码偏好 → 码率」择优，绝不能取第一个。
import { writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const FFMPEG = ENV.FFMPEG;
const FFPROBE = ENV.FFPROBE;

// 载入通用「多档择优」内核（由 _env.mjs 在候选目录里定位）
const Q = await ENV.loadKernel("_quality.mjs");
const { pickBiliDash, BILI_QN, BILI_CODEC_NAME } = Q;

// 载入 yt-dlp 内核（可选加速器）。B站实测：yt-dlp 一步拿到 1920×1080 h264+aac，
// 自动挑最高码率并合并音轨，比「playurl 取 dash → 下 m4s → ffmpeg 合并」更省事；
// 失败则回退原有 playurl 方案（两条路都经过验证）。
const YT = await ENV.tryKernel("_ytdlp.mjs");
let YT_OK = false;
if (YT) { try { YT_OK = !!(await YT.ytdlpVersion()); } catch (e) {} }

let PAGE_URL = process.env.EMD_URL || "", OUT_DIR = process.env.EMD_OUT || "", TYPE = process.env.EMD_TYPE || "all";
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

const task = await taskSpace("emd-bili");
const page = task.page("p1");
await page.goto(PAGE_URL, { timeout: 40000 });
await page.waitForLoadState("load");
await page.waitForTimeout(4000);

// 从页面拿 bvid/cid，然后调 playurl 取全部档位
const info = await page.evaluate(async () => {
  const s = window.__INITIAL_STATE__ || {};
  const vd = s.videoData || {};
  let bvid = s.bvid || vd.bvid || (location.href.match(/BV[\w]+/) || [""])[0];
  let cid = s.cid || vd.cid || 0;
  // 兜底：从 DOM/URL 再找一次
  if (!cid) {
    const m = document.documentElement.innerHTML.match(/"cid"\s*:\s*(\d+)/);
    if (m) cid = Number(m[1]);
  }
  if (!bvid || !cid) return { err: "no bvid/cid", bvid, cid };
  const out = { bvid, cid, title: (document.querySelector("h1")?.textContent || document.title || "").trim(), up: (document.querySelector(".up-name")?.textContent || "").trim() };
  for (const fnval of [4048, 16]) {
    try {
      const resp = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=${fnval}&fourk=1`, { credentials: "include" });
      const j = await resp.json();
      const d = (j.data) || {};
      const dash = d.dash || {};
      if (dash.video && dash.video.length) {
        out.code = j.code;
        out.accept = d.accept_description || [];
        out.video = dash.video.map(v => ({ id: v.id, baseUrl: v.baseUrl, backupUrl: v.backupUrl, bandwidth: v.bandwidth, width: v.width, height: v.height, codecid: v.codecid, frameRate: v.frameRate }));
        out.audio = (dash.audio || []).map(a => ({ id: a.id, baseUrl: a.baseUrl, backupUrl: a.backupUrl, bandwidth: a.bandwidth, codecid: a.codecid }));
        out.dolby = dash.dolby && dash.dolby.audio ? dash.dolby.audio.map(a => ({ id: a.id, baseUrl: a.baseUrl, bandwidth: a.bandwidth })) : [];
        break;
      } else {
        out["err" + fnval] = { code: j.code, msg: j.message };
      }
    } catch (e) { out["err" + fnval] = e.message; }
  }
  return out;
});

console.log("BVID", info.bvid, "CID", info.cid, "|", info.title);
if (!info.video || !info.video.length) {
  console.log("NO DASH — 可能需登录/地区限制/付费内容。", JSON.stringify(info).slice(0, 500));
  process.exit(2);
}
console.log("ACCEPT:", (info.accept || []).join(" | "));

// 内核择优（含 dolby 音轨一起参与音频择优）
const { video: vBest, audio: aBest, allVideo } = pickBiliDash(info.video, [...(info.audio || []), ...(info.dolby || [])]);
console.log("QN CANDIDATES:", allVideo.map((v) => `${v.qn}(${v.def}/${BILI_CODEC_NAME[v.codecid] || v.codecid}/${v.w}x${v.h})`).join(" > "));
console.log("PICKED:", vBest.qn, BILI_QN[vBest.qn] || "", `${vBest.w}x${vBest.h}`, BILI_CODEC_NAME[vBest.codecid] || vBest.codecid, "br", vBest.br);

const id = info.bvid || (PAGE_URL.match(/BV[\w]+/) || [Date.now().toString()])[0];
const title = (info.title || "bilibili").replace(/[\n,/\\:*?"<>|]/g, " ").slice(0, 80);
const file = "001_" + id + ".mp4";
const outPath = OUT_DIR + "/" + file;
if (existsSync(outPath)) { console.log("EXISTS skip"); process.exit(0); }

// ---------- 路径 A：yt-dlp（优先；一步拿最高档 + 自动合并音轨） ----------
if (YT_OK) {
  try {
    console.log("尝试 yt-dlp ...");
    const r = await YT.downloadWithYtdlp({
      url: PAGE_URL,
      dest: outPath,
      referer: "https://www.bilibili.com/",
      concurrency: 16,
      timeoutMs: 1800000,
    });
    if (r.ok) {
      // 校验：必须同时有 video + audio
      let streams = "";
      try {
        const { stdout } = await execFileP(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", outPath], { windowsHide: true });
        streams = stdout.trim();
      } catch (e) {}
      const hasAudio = /\baac\b|audio/i.test(streams);
      const hasVideo = /video/i.test(streams);
      const res = (streams.match(/,(\d+),(\d+)/) || []);
      const sz = statSync(outPath).size;
      if (hasVideo && hasAudio) {
        await writeFile(OUT_DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution,qn,codec,hasAudio\n");
        await appendFile(OUT_DIR + "/manifest.csv",
          `001,${id},${title},${file},${sz},${res[1] || ""}x${res[2] || ""},,auto,1\n`);
        console.log("OK(yt-dlp)", sz, `${res[1] || "?"}x${res[2] || "?"}`, "hasAudio=true", `${r.elapsedSec}s`);
        process.exit(0);
      }
      console.log("yt-dlp 产物缺音轨/视频流，回退 playurl 方案");
      try { await unlink(outPath); } catch (e) {}
    } else {
      console.log("yt-dlp 失败:", String(r.error || "").slice(0, 120), "→ 回退 playurl");
    }
  } catch (e) {
    console.log("yt-dlp 异常:", e.message.slice(0, 120), "→ 回退 playurl");
  }
}

async function dl(cand, dest) {
  const urls = [cand.url, cand.backup].filter(Boolean);
  let lastErr = "";
  for (const u of urls) {
    try {
      const resp = await fetch(u, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com" },
        redirect: "follow",
      });
      if (!resp.ok) { lastErr = "HTTP " + resp.status; continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1024) { lastErr = "BAD BODY"; continue; }
      await writeFile(dest, buf);
      return buf.length;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr || "all urls failed");
}

try {
  const vTmp = OUT_DIR + "/_v.m4s", aTmp = OUT_DIR + "/_a.m4s";
  console.log("DL video ..."); const vz = await dl(vBest, vTmp);
  let az = 0;
  if (aBest) { console.log("DL audio ..."); az = await dl(aBest, aTmp); }
  console.log("MERGE ...");
  const args = az > 0
    ? ["-y", "-i", vTmp, "-i", aTmp, "-c", "copy", outPath]
    : ["-y", "-i", vTmp, "-c", "copy", outPath];
  await execFileP(FFMPEG, args, { windowsHide: true });
  try { await unlink(vTmp); if (az > 0) await unlink(aTmp); } catch (e) {}

  // 校验：必须既有视频流又有音频流
  let streams = "";
  try {
    const { stdout } = await execFileP(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", outPath], { windowsHide: true });
    streams = stdout.trim();
  } catch (e) {}
  const hasAudio = /\baac\b|audio/i.test(streams);
  const hasVideo = /video/i.test(streams);
  const sz = statSync(outPath).size;

  await writeFile(OUT_DIR + "/manifest.csv", "index,vid,title,file,bytes,resolution,qn,codec,hasAudio\n");
  await appendFile(OUT_DIR + "/manifest.csv",
    `001,${id},${title},${file},${sz},${vBest.w}x${vBest.h},${vBest.qn},${BILI_CODEC_NAME[vBest.codecid] || vBest.codecid},${hasAudio ? 1 : 0}\n`);
  console.log("OK", sz, `${vBest.w}x${vBest.h}`, "hasVideo=" + hasVideo, "hasAudio=" + hasAudio);
  if (!hasAudio) console.log("WARN: 成品没有音轨，请检查 audio 档位是否拿到");
} catch (e) { console.log("ERR", e.message); process.exit(4); }
