// _quality.mjs — 通用「多档择优」内核（所有平台共用）
//
// 铁律：任何站点、任何媒体，只要同一个作品存在多个候选直链/多档清晰度，
// 就必须把候选全部收集起来，按「分辨率 → 码率 → 体积」降序取最高档，
// 绝不能拿第一个（play_addr.url_list[0] / video[0] / m4s 第一条 / srcset 第一项）
// 就当成品——那通常正是最低档。
//
// 本文件不自己跑浏览器，只导出纯函数；各 tools/*.mjs 用 `import { ... } from "./_quality.mjs"`。

// ---------- 1. 通用评分 ----------

// definition 文案 → 高度像素。覆盖各站叫法。
const DEF_TO_HEIGHT = {
  "8k": 4320, "4320p": 4320, "uhd8k": 4320,
  "4k": 2160, "2160p": 2160, "uhd": 2160, "hd2160": 2160, "origin": 2160,
  "1440p": 1440, "2k": 1440, "hd1440": 1440, "qhd": 1440,
  "1080p": 1080, "fhd": 1080, "hd1080": 1080, "fullhd": 1080, "1080p60": 1080,
  "720p": 720, "hd720": 720, "hd": 720, "720p60": 720,
  "540p": 540, "qhd540": 540,
  "480p": 480, "sd": 480,
  "360p": 360,
  "240p": 240, "144p": 144,
  // B站 qn 文案
  "超清": 1080, "高清": 720, "清晰": 480, "流畅": 360,
  // 抖音/头条 quality 字段
  "normal": 0, "low": 0, "high": 0,
};

/**
 * 把 definition / quality / qn / 任意文案解析成「高度像素」。
 * 认不出返回 0（不参与分辨率比较，退化为比码率/体积）。
 */
export function defToHeight(def) {
  if (def === null || def === undefined) return 0;
  if (typeof def === "number") return def > 0 ? def : 0;
  const s = String(def).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return 0;
  if (DEF_TO_HEIGHT[s] !== undefined) return DEF_TO_HEIGHT[s];
  // "1080p60" / "720P" / "hd1080" / "1080" 之类
  const m = s.match(/(\d{3,4})\s*p?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 144 && n <= 4320) return n;
  }
  return 0;
}

/**
 * 候选统一评分：返回 [像素数, 码率, 体积]，降序比较用。
 * 像素优先用真实宽高（最准）；只有高度时按 9:16 近似；都没有才退回 definition 文案。
 */
export function scoreOf(c) {
  if (!c) return [0, 0, 0];
  let px = 0;
  const w = Number(c.w || c.width || c.vwidth || 0);
  const h = Number(c.h || c.height || c.vheight || 0);
  if (w > 0 && h > 0) px = w * h;
  else if (h > 0) px = Math.round(h * h * 0.5625); // 只有高度：按 9:16 竖屏近似
  else {
    const hh = defToHeight(c.def || c.definition || c.quality || c.qn);
    px = hh > 0 ? hh * Math.round(hh * 0.5625) : 0;
  }
  const br = Number(c.br || c.bitrate || c.real_bitrate || 0) || 0;
  const size = Number(c.size || c.bytes || 0) || 0;
  return [px, br, size];
}

/** 比较函数：按 scoreOf 降序（给 Array.prototype.sort 用） */
export function byQualityDesc(a, b) {
  const sa = scoreOf(a), sb = scoreOf(b);
  for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
  return 0;
}

/**
 * 从候选数组里选最高档。空数组返回 null。
 * 返回**原对象**，但保证 `.url` 一定被填上（原始字段可能是 main_url/play_url/url_list）。
 * @param {Array} cands 候选，元素至少含 url/main_url/play_url/url_list
 * @returns {Object|null} 最高档候选
 */
export function pickBest(cands) {
  const list = (cands || []).filter((c) => c && (c.url || c.main_url || c.play_url || c.url_list || c.play_url_list));
  if (!list.length) return null;
  const best = [...list].sort(byQualityDesc)[0];
  const url = best.url || best.main_url || best.play_url || (best.url_list && best.url_list[0]) || (best.play_url_list && best.play_url_list[0]) || "";
  return { ...best, url };
}

/** 归一化候选对象：把各站不同字段名统一成 {url, def, w, h, br, size, ...rest} */
export function normCand(raw, extra) {
  if (!raw) return null;
  const url = raw.url || raw.main_url || raw.play_url || (raw.url_list && raw.url_list[0]) || (raw.play_url_list && raw.play_url_list[0]) || "";
  if (!url) return null;
  return {
    url,
    backup: raw.backup_url || raw.backup || "",
    def: raw.def || raw.definition || raw.quality || raw.gear_name || "",
    w: Number(raw.w || raw.width || raw.vwidth || 0) || 0,
    h: Number(raw.h || raw.height || raw.vheight || 0) || 0,
    br: Number(raw.br || raw.bitrate || raw.real_bitrate || 0) || 0,
    size: Number(raw.size || raw.bytes || 0) || 0,
    codec: raw.codec_type || raw.codec || raw.vtype || "",
    ...(extra || {}),
  };
}

/** 一批原始候选 → 归一化 + 去重（按 URL）+ 降序排序 */
export function rankCands(rawList, extra) {
  const seen = new Set();
  const out = [];
  for (const raw of rawList || []) {
    const c = normCand(raw, extra);
    if (!c) continue;
    const key = c.url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort(byQualityDesc);
}

// ---------- 2. B站 qn 码表 ----------

// B站清晰度代码。数值越大越清晰；DASH 下视频流文件名里带的就是 qn。
export const BILI_QN = {
  6: "240P 极速",
  16: "360P 流畅",
  32: "480P 清晰",
  64: "720P 高清",
  74: "720P60 高帧率",
  80: "1080P 高清",
  112: "1080P+ 高码率",
  116: "1080P60 高帧率",
  120: "4K 超清",
  125: "HDR 真彩色",
  126: "杜比视界",
  127: "8K 超高清",
};

// qn → 用于排序的高度（60 帧的档给一点点加成，靠 codec/fps 另算）
export function biliQnToHeight(qn) {
  const n = Number(qn) || 0;
  const map = { 6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320 };
  return map[n] || 0;
}

// B站 codecid：7=H.264（兼容性最好）12=HEVC 13=AV1。同分辨率下优先 H.264，
// 避免下到浏览器/播放器可能不支持的编码。
export const BILI_CODEC_PREF = { 7: 3, 12: 2, 13: 1 };
export const BILI_CODEC_NAME = { 7: "h264", 12: "hevc", 13: "av1" };

/**
 * 【首选】从 B站 playurl API 的 dash 数据里择优。
 * 这是**权威**档位来源：带真实 width/height/bandwidth/codecid，不用猜文件名。
 * 排序：分辨率(宽*高) → 编码偏好(H.264>HEVC>AV1) → 码率。
 * @param {Array} videoList dash.video[]，元素含 {id,baseUrl,backupUrl,bandwidth,width,height,codecid}
 * @param {Array} audioList dash.audio[]，元素含 {id,baseUrl,backupUrl,bandwidth}
 */
export function pickBiliDash(videoList, audioList) {
  const vids = (videoList || []).map((v) => ({
    url: v.baseUrl || v.url || "",
    backup: (v.backupUrl && v.backupUrl[0]) || v.backup || "",
    qn: v.id || 0,
    w: v.width || 0, h: v.height || 0,
    br: v.bandwidth || 0,
    codecid: v.codecid || 0,
    def: BILI_QN[v.id] || `qn${v.id}`,
  })).filter((v) => v.url);

  vids.sort((a, b) => {
    const pa = a.w * a.h, pb = b.w * b.h;
    if (pa !== pb) return pb - pa;
    const ca = BILI_CODEC_PREF[a.codecid] || 0, cb = BILI_CODEC_PREF[b.codecid] || 0;
    if (ca !== cb) return cb - ca;
    return (b.br || 0) - (a.br || 0);
  });

  const auds = (audioList || []).map((a) => ({
    url: a.baseUrl || a.url || "",
    backup: (a.backupUrl && a.backupUrl[0]) || a.backup || "",
    id: a.id || 0, br: a.bandwidth || 0,
  })).filter((a) => a.url);
  // 音频：码率优先，同码率按 id 偏好 30280 > 30232 > 30216
  const rankA = (a) => (/30280/.test(a.id) ? 3 : /30232/.test(a.id) ? 2 : /30216/.test(a.id) ? 1 : 0);
  auds.sort((x, y) => (y.br - x.br) || (rankA(y) - rankA(x)));

  return { video: vids[0] || null, audio: auds[0] || null, allVideo: vids, allAudio: auds };
}

/**
 * 从 B站 .m4s 直链里解析 qn（清晰度代码）。解析不出返回 0。
 *
 * B站有两种命名，都要认：
 *   1) 纯 qn：`<cid>-1-<qn>.m4s`，如 `-1-80.m4s`（1080P）、`-1-120.m4s`（4K）
 *   2) 30000 偏移：`<cid>-1-30080.m4s` = qn 80，`30064`=64，`30032`=32，`30016`=16，`30120`=120
 * 音频码 30216(64k) / 30232(132k) / 30280(192k) 不是 qn，返回 0（避免把音频当 4K 视频）。
 */
export function biliQnFromUrl(u) {
  if (!u) return 0;
  const m = String(u).match(/-(\d{2,5})\.m4s/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (n >= 30000 && n <= 30130) return n - 30000; // 30080 → 80
  if (n >= 6 && n <= 127) return n;               // 纯 qn
  return 0;                                        // 30216/30232/30280 = 音频
}

/** 从 B站候选里挑最高 qn 的 video 流 + 对应 audio 流 */
export function pickBiliStreams(videoUrls, audioUrls) {
  const vids = (videoUrls || [])
    .map((u) => {
      const qn = biliQnFromUrl(u);
      return { url: u, qn, h: biliQnToHeight(qn), def: BILI_QN[qn] || "" };
    })
    // qn 解析不出来的（多半是音频码 30216/30232/30280）不参与视频择优
    .filter((v) => v.qn > 0);
  const auds = (audioUrls || []).map((u) => ({ url: u }));
  const bestV = pickBest(vids);
  // 音频：优先 30280(192k)，其次 30232(132k)，再 30216(64k)
  const rankA = (u) => (/30280/.test(u) ? 3 : /30232/.test(u) ? 2 : /30216/.test(u) ? 1 : 0);
  const bestA = (auds || []).sort((x, y) => rankA(y.url) - rankA(x.url))[0] || null;
  return { video: bestV, audio: bestA, allVideo: vids.sort((a, b) => b.qn - a.qn) };
}

// ---------- 3. HTML/图片 srcset ----------

/** 解析 srcset，返回按宽度降序的 [{url, w}] */
export function parseSrcset(srcset) {
  if (!srcset) return [];
  const out = [];
  for (const part of String(srcset).split(",")) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const d = bits[1] || "";
    let w = 0;
    if (/^\d+w$/.test(d)) w = parseInt(d, 10);
    else if (/^\d+(\.\d+)?x$/.test(d)) w = Math.round(parseFloat(d) * 1000);
    out.push({ url: bits[0], w });
  }
  return out.sort((a, b) => b.w - a.w);
}

/**
 * 从图片 URL 里解析它**自身声明的**尺寸（最可信，优先于 naturalWidth）。
 * 覆盖：`@1280w`（小红书/微博）、`?w=800`、`_640x480`、Wikimedia/常见 CDN 的 `/<N>px-`。
 */
export function guessImgWidth(u) {
  if (!u) return 0;
  const s = String(u);
  // Wikimedia / 常见缩略图服务：/330px-Siam_lilacpoint.jpg
  let m = s.match(/\/(\d+)px-/i);
  if (m) return parseInt(m[1], 10) || 0;
  // 小红书 / 微博：...jpg@1280w_1l_2o_100sh.jpg
  m = s.match(/@(\d+)w/i);
  if (m) return parseInt(m[1], 10) || 0;
  // 通用 query：?w=800 / &width=800
  m = s.match(/[?&](?:w|width)=(\d+)/i);
  if (m) return parseInt(m[1], 10) || 0;
  // ..._640x480.jpg
  m = s.match(/_(\d+)x(\d+)\./i);
  if (m) return parseInt(m[1], 10) || 0;
  return 0;
}

/**
 * 图片「原图化」：去掉各站的尺寸/裁切后缀，得到可用于下载的原图 URL。
 * 小红书/微博：`...jpg@1280w_1l_2o_100sh` → `...jpg`
 * 淘宝：`...jpg_400x400.jpg` → `...jpg`
 * MediaWiki/Wikimedia：`/thumb/<a>/<b>/<Name>.jpg/330px-<Name>.jpg` → `/<a>/<b>/<Name>.jpg`
 *   （缩略图目录 `/thumb/` + `/Npx-` 段去掉就是原图，这是「多档择优」里最高的一档）
 */
export function originalImageUrl(u) {
  if (!u) return u;
  let s = String(u);
  // MediaWiki 缩略图 → 原图
  const mw = s.match(/^(.*?)\/thumb\/(.+?)\/(\d+)px-([^/?#]+)(\?[^#]*)?$/i);
  if (mw) {
    const [, host, dir, , , qs] = mw;
    return `${host}/${dir}${qs ? qs.replace(/[?&](utm_[^&]*|campaign|content)/g, "") : ""}`.replace(/\?&/, "?").replace(/\?$/, "");
  }
  // 去掉 @ 后面的尺寸/处理参数
  s = s.replace(/@[^/?#]*$/, "");
  // 去掉常见的 `_<w>x<h>.<ext>` 尺寸段（仅当它出现在扩展名之前）
  s = s.replace(/_\d+x\d+(\.(?:jpe?g|png|webp|gif|avif))$/i, "$1");
  return s;
}

/**
 * 图片「归组键」：把同一张图的不同尺寸变体归到同一个 key，便于组内择优。
 * 与 originalImageUrl 的区别：本函数会把 URL 里**内嵌的尺寸段**抹平（返回的 URL 可能已不存在），
 * 只用于分组，**不能**拿去下载。
 *   .../thumb/x/330px-Foo.jpg  → .../thumb/x/px-Foo.jpg
 *   .../Foo.jpg@1280w_1l        → .../Foo.jpg
 *   .../Foo_640x480.jpg         → .../Foo.jpg
 */
export function imgGroupKey(u) {
  if (!u) return "";
  let s = originalImageUrl(u);
  // Wikimedia 风格 /<N>px-
  s = s.replace(/\/\d+px-/i, "/px-");
  // 其它 CDN 的 -<N>x<N>. 或 _<N>w.
  s = s.replace(/[-_]\d+x\d+(\.(?:jpe?g|png|webp|gif|avif))/i, "$1");
  s = s.replace(/[-_]\d+w(\.(?:jpe?g|png|webp|gif|avif))/i, "$1");
  // 去掉尺寸类 query（保留签名类）
  try {
    const uu = new URL(s);
    for (const k of ["w", "width", "h", "height", "size", "resize", "thumbnail"]) uu.searchParams.delete(k);
    s = uu.href;
  } catch (e) {}
  return s.split("#")[0];
}

/**
 * 一批图片候选（含 srcset/src/data-src）→ 选最大。
 * 宽度可信度：URL 内嵌尺寸 > 显式 srcset 描述符 > naturalWidth（SVG 的 naturalWidth 常虚高，最不可信）。
 */
export function pickBestImage(cands) {
  const list = (cands || [])
    .filter((c) => c && c.url)
    .map((c) => {
      const fromUrl = guessImgWidth(c.url);
      const declared = Number(c.w || 0) || 0;
      // URL 里写明的尺寸最可信；否则用声明的（srcset Nw / 属性 / naturalWidth）
      const w = fromUrl || declared;
      return { ...c, w, wSrc: fromUrl ? "url" : (declared ? "declared" : "none") };
    });
  if (!list.length) return null;
  return list.sort((a, b) => (b.w || 0) - (a.w || 0) || (b.bytes || 0) - (a.bytes || 0))[0];
}

// ---------- 4. 通用媒体清单（浏览器内注入用） ----------

/**
 * 返回一段可注入页面的脚本字符串：收集页面上所有「多档候选」媒体。
 * 页面里会挂 window.__emdCands = { videos: [...], images: [...] }。
 * 注意：这是给 Page.addScriptToEvaluateOnNewDocument 的**字符串**，反斜杠要双写。
 */
export const DOM_SCAN_SOURCE = `
window.__emdCands = window.__emdCands || { videos: [], images: [] };
(function(){
  const C = window.__emdCands;
  const add = (kind, c) => { if (c && c.url) C[kind].push(c); };

  // <video> 的多 source
  for (const v of document.querySelectorAll('video')) {
    const cands = [];
    for (const s of v.querySelectorAll('source[src]')) {
      cands.push({ url: s.src, type: s.type || '', label: s.getAttribute('label') || s.getAttribute('data-quality') || '', h: parseInt(s.getAttribute('height') || 0, 10) || 0 });
    }
    if (v.currentSrc || v.src) cands.push({ url: v.currentSrc || v.src, h: v.videoHeight || 0, w: v.videoWidth || 0 });
    for (const c of cands) add('videos', c);
    // 记录 video 元素自身的真实分辨率，供同源候选补宽高
    v.setAttribute('data-emd-w', v.videoWidth || 0);
    v.setAttribute('data-emd-h', v.videoHeight || 0);
  }

  // 图片：srcset 全部档位 + src + data-src + 原图化
  const imgPush = (el) => {
    for (const c of (window.__emdParseSrcset ? window.__emdParseSrcset(el.getAttribute('srcset')) : [])) add('images', c);
    for (const attr of ['src', 'data-src', 'data-original', 'data-actualsrc']) {
      const raw = el.getAttribute(attr);
      if (raw) add('images', { url: raw, w: parseInt(el.getAttribute('width') || 0, 10) || 0 });
    }
    if (el.naturalWidth) add('images', { url: el.currentSrc || el.src, w: el.naturalWidth });
  };
  for (const img of document.querySelectorAll('img')) imgPush(img);
  for (const src of document.querySelectorAll('picture source[srcset]')) {
    for (const c of (window.__emdParseSrcset ? window.__emdParseSrcset(src.getAttribute('srcset')) : [])) add('images', c);
  }
  // 背景图
  for (const el of document.querySelectorAll('*')) {
    const bg = el.style && el.style.backgroundImage;
    if (bg) { const m = bg.match(/url\\(["']?([^"')]+)["']?\\)/); if (m) add('images', { url: m[1] }); }
  }
})();
`;
