// test_quality.mjs — 纯函数单测（node test_quality.mjs）
import assert from "node:assert/strict";
import {
  defToHeight, scoreOf, byQualityDesc, pickBest, normCand, rankCands,
  biliQnToHeight, biliQnFromUrl, pickBiliStreams, pickBiliDash,
  parseSrcset, guessImgWidth, originalImageUrl, pickBestImage, imgGroupKey,
} from "./_quality.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.log("FAIL", name, "->", e.message); }
};

// ---- defToHeight ----
t("defToHeight 基本档位", () => {
  assert.equal(defToHeight("1080p"), 1080);
  assert.equal(defToHeight("720P"), 720);
  assert.equal(defToHeight("480p"), 480);
  assert.equal(defToHeight("4k"), 2160);
  assert.equal(defToHeight("2160p"), 2160);
  assert.equal(defToHeight("8k"), 4320);
  assert.equal(defToHeight("1440p"), 1440);
  assert.equal(defToHeight("1080p60"), 1080);
  assert.equal(defToHeight("hd1080"), 1080);
});
t("defToHeight 中文/未知", () => {
  assert.equal(defToHeight("超清"), 1080);
  assert.equal(defToHeight("高清"), 720);
  assert.equal(defToHeight("流畅"), 360);
  assert.equal(defToHeight("normal"), 0);      // 无信息，不参与分辨率比较
  assert.equal(defToHeight(""), 0);
  assert.equal(defToHeight(null), 0);
  assert.equal(defToHeight("bogus"), 0);
});
t("defToHeight 裸数字字符串", () => {
  assert.equal(defToHeight("1080"), 1080);
  assert.equal(defToHeight("720"), 720);
});

// ---- scoreOf / byQualityDesc / pickBest ----
t("scoreOf 真实宽高优先", () => {
  assert.deepEqual(scoreOf({ w: 1080, h: 1920, br: 2000000 }), [1080 * 1920, 2000000, 0]);
});
t("scoreOf 无宽高用 definition", () => {
  const s = scoreOf({ def: "1080p", br: 3000000 });
  assert.equal(s[0], 1080 * 608); // 1080 * round(1080*0.5625)
  assert.equal(s[1], 3000000);
});
t("pickBest 1080 > 720 > 480", () => {
  const cands = [
    { url: "a", def: "480p", br: 900000 },
    { url: "b", def: "1080p", br: 3000000 },
    { url: "c", def: "720p", br: 2000000 },
  ];
  assert.equal(pickBest(cands).url, "b");
});
t("pickBest 同档比码率", () => {
  const cands = [
    { url: "lo", def: "1080p", br: 2000000 },
    { url: "hi", def: "1080p", br: 4000000 },
  ];
  assert.equal(pickBest(cands).url, "hi");
});
t("pickBest 真实宽高胜过 definition 文案", () => {
  // 有的站把 2160x3840 标成 1080p，真实宽高必须优先
  const cands = [
    { url: "labeled1080", def: "1080p", w: 1080, h: 1920, br: 5000000 },
    { url: "real4k", def: "1080p", w: 2160, h: 3840, br: 3000000 },
  ];
  assert.equal(pickBest(cands).url, "real4k");
});
t("pickBest 空/无效返回 null", () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest([{ def: "1080p" }]), null); // 没有 url
  assert.equal(pickBest(null), null);
});
t("pickBest 不修改原数组顺序", () => {
  const cands = [{ url: "a", def: "480p" }, { url: "b", def: "1080p" }];
  pickBest(cands);
  assert.equal(cands[0].url, "a");
});
t("pickBest 支持 main_url / play_url / url_list", () => {
  assert.equal(pickBest([{ main_url: "m", def: "720p" }]).url, "m");
  assert.equal(pickBest([{ play_url: "p", def: "720p" }]).url, "p");
  assert.equal(pickBest([{ url_list: ["u"], def: "720p" }]).url, "u");
});

// ---- normCand / rankCands ----
t("normCand 字段归一", () => {
  const c = normCand({ main_url: "x", video_meta: undefined, definition: "720p", vwidth: 720, vheight: 1280, bitrate: 1234, size: 999 });
  assert.equal(c.url, "x");
  assert.equal(c.def, "720p");
  assert.equal(c.w, 720);
  assert.equal(c.h, 1280);
  assert.equal(c.br, 1234);
  assert.equal(c.size, 999);
});
t("normCand 无 url 返回 null", () => {
  assert.equal(normCand({ def: "720p" }), null);
  assert.equal(normCand(null), null);
});
t("rankCands 去重 + 降序", () => {
  const r = rankCands([
    { url: "u1", def: "480p", br: 1 },
    { url: "u2", def: "1080p", br: 2 },
    { url: "u1", def: "480p", br: 1 }, // 重复
    { url: "u3", def: "720p", br: 3 },
  ]);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.url), ["u2", "u3", "u1"]);
});

// ---- B站 ----
t("biliQnToHeight 码表", () => {
  assert.equal(biliQnToHeight(120), 2160);
  assert.equal(biliQnToHeight(80), 1080);
  assert.equal(biliQnToHeight(64), 720);
  assert.equal(biliQnToHeight(127), 4320);
  assert.equal(biliQnToHeight(999), 0);
});
t("biliQnFromUrl 解析 qn", () => {
  // 纯 qn 形式
  assert.equal(biliQnFromUrl("https://xy.com/v/123-1-120.m4s"), 120);
  assert.equal(biliQnFromUrl("https://xy.com/v/123-1-80.m4s"), 80);
  // 30000 偏移形式
  assert.equal(biliQnFromUrl("https://xy.com/v/43011867987-1-30080.m4s"), 80);
  assert.equal(biliQnFromUrl("https://xy.com/v/43011867987-1-30120.m4s"), 120);
  // 音频码不是 qn，必须返回 0
  assert.equal(biliQnFromUrl("https://xy.com/a/123-1-30232.m4s"), 0);
  assert.equal(biliQnFromUrl("https://xy.com/a/123-1-30280.m4s"), 0);
  assert.equal(biliQnFromUrl("https://xy.com/a/123_t2-1-30216.m4s"), 0);
  assert.equal(biliQnFromUrl("https://xy.com/nope.m4s"), 0);
});
t("pickBiliStreams 选最高 qn 而非第一条", () => {
  const { video, audio } = pickBiliStreams(
    [
      "https://x/1-1-30016.m4s",  // 360p 低档，排第一条
      "https://x/1-1-30120.m4s",  // 4K，不是第一条
      "https://x/1-1-30080.m4s",  // 1080p
    ],
    ["https://x/a_t2-1-30216.m4s", "https://x/a_t2-1-30280.m4s"],
  );
  assert.match(video.url, /-30120\.m4s$/);
  assert.match(audio.url, /30280/);
});
t("pickBiliStreams 音频不会混进视频候选", () => {
  const { video } = pickBiliStreams(["https://x/1-1-30232.m4s"], []);
  assert.equal(video, null);
});

// ---- B站 playurl dash（权威来源，首选） ----
t("pickBiliDash 按分辨率择优，不取第一条", () => {
  const { video, audio } = pickBiliDash(
    [
      { id: 80, baseUrl: "https://x/1080p-av1.m4s", bandwidth: 1193986, width: 1920, height: 1080, codecid: 13 },
      { id: 80, baseUrl: "https://x/1080p-h264.m4s", bandwidth: 3066485, width: 1920, height: 1080, codecid: 7 },
      { id: 64, baseUrl: "https://x/720p.m4s", bandwidth: 1643654, width: 1280, height: 720, codecid: 7 },
      { id: 32, baseUrl: "https://x/480p.m4s", bandwidth: 883462, width: 852, height: 480, codecid: 7 },
    ],
    [
      { id: 30216, baseUrl: "https://x/a64k.m4s", bandwidth: 65615 },
      { id: 30232, baseUrl: "https://x/a132k.m4s", bandwidth: 96698 },
    ],
  );
  // 同分辨率下应选 H.264(codecid 7)，不是排第一的 AV1
  assert.match(video.url, /1080p-h264/);
  assert.equal(video.qn, 80);
  assert.equal(audio.id, 30232);
});
t("pickBiliDash 4K 胜过 1080p", () => {
  const { video } = pickBiliDash(
    [
      { id: 80, baseUrl: "https://x/1080p.m4s", bandwidth: 3000000, width: 1920, height: 1080, codecid: 7 },
      { id: 120, baseUrl: "https://x/4k.m4s", bandwidth: 2000000, width: 3840, height: 2160, codecid: 12 },
    ],
    [],
  );
  assert.match(video.url, /4k/);
  assert.equal(video.qn, 120);
});
t("pickBiliDash 空输入返回 null", () => {
  const r = pickBiliDash([], []);
  assert.equal(r.video, null);
  assert.equal(r.audio, null);
});
t("pickBiliStreams 无视频返回 null", () => {
  const { video } = pickBiliStreams([], ["https://x/a.m4s"]);
  assert.equal(video, null);
});

// ---- 图片 ----
t("parseSrcset 降序", () => {
  const r = parseSrcset("a.jpg 320w, b.jpg 1280w, c.jpg 640w");
  assert.deepEqual(r.map((x) => x.url), ["b.jpg", "c.jpg", "a.jpg"]);
});
t("parseSrcset 支持 x 描述符", () => {
  const r = parseSrcset("a.jpg 1x, b.jpg 2x");
  assert.equal(r[0].url, "b.jpg");
});
t("parseSrcset 空值", () => {
  assert.deepEqual(parseSrcset(""), []);
  assert.deepEqual(parseSrcset(null), []);
});
t("guessImgWidth", () => {
  assert.equal(guessImgWidth("https://x/a.jpg@1280w_1l.jpg"), 1280);
  assert.equal(guessImgWidth("https://x/a.jpg?w=800"), 800);
  assert.equal(guessImgWidth("https://x/a_640x480.jpg"), 640);
  // Wikimedia 缩略图
  assert.equal(guessImgWidth("https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Foo.jpg/330px-Foo.jpg"), 330);
  assert.equal(guessImgWidth("https://x/40px-Symbol.svg.png"), 40);
  assert.equal(guessImgWidth("https://x/a.jpg"), 0);
});
t("originalImageUrl 剥离尺寸后缀", () => {
  assert.equal(originalImageUrl("https://x/a.jpg@1280w_1l_2o_100sh.jpg"), "https://x/a.jpg");
  assert.equal(originalImageUrl("https://x/a_640x480.jpg"), "https://x/a.jpg");
  assert.equal(originalImageUrl("https://x/a.jpg"), "https://x/a.jpg");
});
t("originalImageUrl MediaWiki 缩略图 → 原图", () => {
  assert.equal(
    originalImageUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Siam_lilacpoint.jpg/330px-Siam_lilacpoint.jpg"),
    "https://upload.wikimedia.org/wikipedia/commons/2/25/Siam_lilacpoint.jpg",
  );
  // 带 utm 参数也要清掉
  const r = originalImageUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Foo.svg/40px-Foo.svg.png?utm_source=en.wikipedia.org&utm_campaign=parser&utm_content=thumbnail");
  assert.equal(r, "https://upload.wikimedia.org/wikipedia/commons/8/87/Foo.svg");
});
t("imgGroupKey 同图不同尺寸归同一组", () => {
  // Wikimedia 的 330px / 800px 缩略图是同一张图
  assert.equal(
    imgGroupKey("https://upload.wikimedia.org/x/thumb/8/87/Foo.jpg/330px-Foo.jpg"),
    imgGroupKey("https://upload.wikimedia.org/x/thumb/8/87/Foo.jpg/800px-Foo.jpg"),
  );
  // 小红书的 @尺寸后缀
  assert.equal(
    imgGroupKey("https://x/a.jpg@640w_1l.jpg"),
    imgGroupKey("https://x/a.jpg@1920w_1l.jpg"),
  );
  // 不同图不能归一组
  assert.notEqual(imgGroupKey("https://x/a.jpg"), imgGroupKey("https://x/b.jpg"));
});
t("pickBestImage 选最大", () => {
  const r = pickBestImage([
    { url: "small.jpg", w: 320 },
    { url: "big.jpg", w: 1920 },
    { url: "mid.jpg", w: 800 },
  ]);
  assert.equal(r.url, "big.jpg");
});
t("pickBestImage 用 URL 猜宽度", () => {
  const r = pickBestImage([
    { url: "https://x/a.jpg@640w.jpg" },
    { url: "https://x/a.jpg@1920w.jpg" },
  ]);
  assert.equal(r.url, "https://x/a.jpg@1920w.jpg");
});
t("pickBestImage URL 内嵌尺寸优先于 naturalWidth", () => {
  // Wikimedia 的 SVG 缩略图 naturalWidth 会报成内在宽度(2000)，但 URL 写的是 40px
  const r = pickBestImage([
    { url: "https://x/40px-Symbol.svg.png", w: 2000 },   // naturalWidth 虚高
    { url: "https://x/800px-Siam.jpg", w: 800 },
  ]);
  assert.equal(r.url, "https://x/800px-Siam.jpg");
  assert.equal(r.w, 800);
  assert.equal(r.wSrc, "url");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
