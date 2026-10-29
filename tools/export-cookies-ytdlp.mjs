// export-cookies-ytdlp.mjs — 从 ego-browser 已登录会话导出 Netscape cookie 文件给 yt-dlp 用
// 用法：emd-config.json 里给 {"cookiesFor": ["https://www.youtube.com/", "https://x.com/"], "cookiesOut": "<绝对目录>"}
// cookiesOut 不写则默认任务目录（EMD_TASK_DIR / 工作目录下的 ego-task / 工作目录）。也可直接改下方 SITES。
//
// 【为什么需要】yt-dlp 的 --cookies-from-browser 读不了 ego lite 的 profile：
//   实测 `--cookies-from-browser "chrome:<ego User Data>"` 报
//   `Could not copy Chrome cookie database`（ego 用的是自己的加密/锁，且 Chromium 的
//   Cookies sqlite 在运行中被独占）。但 ego 自己的 CDP `Network.getCookies` 能直接拿到明文，
//   导出成 Netscape 格式给 yt-dlp --cookies 就完全可用。
//
// 【坑：Netscape 格式的 domain 前导点必须和 flag 一致】
//   python http.cookiejar 有断言 `domain_specified == initial_dot`：
//   domain 以 "." 开头 → 第 2 列必须是 TRUE；不带 "." → 必须是 FALSE。
//   旧脚本「domain 补点、flag 却按原始值」会触发
//   `AssertionError: domain_specified == initial_dot`，yt-dlp 直接崩。
//   → 正确写法：先算出最终 domain，再**用最终 domain 是否带点**来决定 flag。
import { writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";

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

let SITES = [];
let OUT_DIR = ENV.resolveTaskDir();
for (const c of ENV.configCandidates()) {
  try {
    const cfg = JSON.parse((await readFile(c, "utf8")).replace(/^\uFEFF/, ""));
    if (cfg.cookiesFor) SITES = cfg.cookiesFor;
    if (cfg.cookiesOut) OUT_DIR = cfg.cookiesOut;
    break;
  } catch (e) {}
}
if (!SITES.length) SITES = ["https://www.youtube.com/", "https://x.com/"];
await mkdir(OUT_DIR, { recursive: true });

const task = await taskSpace("emd-cookies");
const page = task.page("p1");

for (const site of SITES) {
  try {
    await page.goto(site, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    const { cookies } = await page.cdp("Network.getCookies", { urls: [site] });
    const lines = ["# Netscape HTTP Cookie File", "# generated from ego-browser session"];
    let n = 0;
    for (const c of cookies) {
      // 关键修复：domain 与 flag 必须自洽（initial_dot === domain_specified）
      const rawDomain = c.domain || "";
      const domain = rawDomain.startsWith(".") ? rawDomain : "." + rawDomain;
      const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
      const exp = Math.floor(c.expires && c.expires > 0 ? c.expires : Date.now() / 1000 + 86400 * 365);
      const value = String(c.value == null ? "" : c.value).replace(/[\t\r\n]/g, " ");
      const name = String(c.name || "").replace(/[\t\r\n]/g, " ");
      if (!name) continue;
      lines.push([domain, flag, c.path || "/", c.secure ? "TRUE" : "FALSE", exp, name, value].join("\t"));
      n++;
    }
    const host = new URL(site).hostname.replace(/^www\./, "");
    const outPath = `${OUT_DIR}\\ck-${host}.txt`;
    await writeFile(outPath, lines.join("\n") + "\n");
    const names = cookies.map(x => x.name).join(",");
    const login = /SID|__Secure-1PSID|auth_token|ct0|sessionid/i.test(names);
    console.log(`OK ${site} -> ${outPath} cookies=${n} loginHint=${login}`);
  } catch (e) {
    console.log(`ERR ${site}: ${e.message}`);
  }
}
