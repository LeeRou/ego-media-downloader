// _env.mjs — 公共环境解析（工具目录 / 内核加载 / ffmpeg 定位 / 配置查找）
//
// 【为什么必须是「从 homedir 推导」而不是相对路径或环境变量】
//   ego-browser 用 `ego-browser nodejs < script.mjs`（cmd stdin）执行脚本时，实测：
//     - process.cwd()          = ego 安装目录（不是 cmd 的工作目录）
//     - import.meta.url        = .../Application/<ver>/[eval2]（不是脚本路径）
//     - process.argv           = [ego.exe]
//     - 宿主 PowerShell 新设的 $env: 变量 **不会** 透传到脚本（daemon 有独立环境）
//     - 但 %USERPROFILE% / %PATH% 这类登录期系统变量 **可以** 读到
//   所以「找模块」和「找配置」只能靠 %USERPROFILE% 推导 + 若干固定候选目录。
//
// 【工具目录候选顺序】
//   EMD_TOOLS_DIR（若恰好透传）> %USERPROFILE%\.agents\skills\ego-media-downloader\tools
//   > %USERPROFILE%\.ego-media-downloader\tools > %USERPROFILE%\ego-task
//   > cwd > cwd\ego-task > 本模块所在目录
//
// 【配置（emd-config.json）候选顺序】
//   EMD_CONFIG > %USERPROFILE%\.ego-media-downloader\emd-config.json
//   > <工具目录>\emd-config.json > <工具目录>\..\emd-config.json
//   > %USERPROFILE%\ego-task\emd-config.json > cwd\emd-config.json > cwd\ego-task\emd-config.json
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const HOME = homedir();

/** 本模块所在目录（[eval2] 下是垃圾值，故放候选末尾） */
function selfDir() {
  try { return dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); }
  catch (e) { return ""; }
}

/** 标准安装位置：<home>/.agents/skills/ego-media-downloader/tools */
export function homeToolsDir() {
  return join(HOME, ".agents", "skills", "ego-media-downloader", "tools");
}

/** 用户级数据目录：<home>/.ego-media-downloader（放 emd-config.json / cookie 导出） */
export function homeDataDir() {
  return join(HOME, ".ego-media-downloader");
}

/** 候选工具目录（去重、保序） */
export function toolsDirCandidates() {
  const cwd = process.cwd();
  const list = [
    process.env.EMD_TOOLS_DIR,
    homeToolsDir(),
    join(homeDataDir(), "tools"),
    join(HOME, "ego-task"),
    cwd,
    join(cwd, "ego-task"),
    selfDir(),
  ].filter(Boolean);
  return [...new Set(list)];
}

function isFile(p) { try { return statSync(p).isFile(); } catch (e) { return false; } }

/** 在候选目录里找第一个存在该文件的位置 */
export function findFile(name) {
  for (const d of toolsDirCandidates()) {
    const p = join(d, name);
    if (isFile(p)) return p;
  }
  return "";
}

/** 加载同目录的 .mjs 内核；找不到返回 null */
export async function tryKernel(name) {
  for (const d of toolsDirCandidates()) {
    const p = join(d, name);
    try {
      if (!isFile(p)) continue;
      return await import(pathToFileURL(p).href);
    } catch (e) {}
  }
  return null;
}

/** 加载同目录的 .mjs 内核；找不到直接抛错（错误信息带已尝试目录，便于排错） */
export async function loadKernel(name) {
  const m = await tryKernel(name);
  if (!m) {
    throw new Error(
      `无法加载 ${name}。请把它放在 ${homeToolsDir()}（标准位置），或在 <home>/.ego-media-downloader/tools 下。` +
      `已尝试：${toolsDirCandidates().join(" | ")}`
    );
  }
  return m;
}

/** 在 PATH 里找可执行文件（Windows 补 .exe/.cmd） */
function which(bin) {
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      if (isFile(join(d, n))) return join(d, n);
    }
  }
  return "";
}

/** ffmpeg / ffprobe：ENV > PATH > 工具目录 > 常见安装位置 > 裸名字 */
function resolveBin(envName, bin, commonPaths) {
  const fromEnv = process.env[envName];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fromPath = which(bin);
  if (fromPath) return fromPath;
  const local = findFile(bin + ".exe");
  if (local) return local;
  for (const p of commonPaths) if (isFile(p)) return p;
  return bin;
}

export const FFMPEG = resolveBin("FFMPEG_BIN", "ffmpeg", [
  "C:\\ffmpeg\\bin\\ffmpeg.exe", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg",
]);
export const FFPROBE = resolveBin("FFPROBE_BIN", "ffprobe", [
  "C:\\ffmpeg\\bin\\ffprobe.exe", "/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe",
]);

/** 配置文件候选路径（按优先级） */
export function configCandidates() {
  const cwd = process.cwd();
  const t = homeToolsDir();
  return [...new Set([
    process.env.EMD_CONFIG,
    join(homeDataDir(), "emd-config.json"),
    join(t, "emd-config.json"),
    join(t, "..", "emd-config.json"),
    join(HOME, "ego-task", "emd-config.json"),
    join(cwd, "emd-config.json"),
    join(cwd, "ego-task", "emd-config.json"),
  ].filter(Boolean))];
}

/** 读取第一个能解析成功的配置文件；返回 {cfg, path} 或 null */
export async function readConfig() {
  const { readFile } = await import("node:fs/promises");
  for (const c of configCandidates()) {
    try {
      const raw = await readFile(c, "utf8");
      // 去掉 UTF-8 BOM（PowerShell 5 的 Set-Content 会写 BOM，JSON.parse 会炸）
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, ""));
      return { cfg, path: c };
    } catch (e) {}
  }
  return null;
}

/** 任务目录：已有配置文件所在目录 > <home>/.ego-media-downloader > cwd */
export function resolveTaskDir() {
  if (process.env.EMD_TASK_DIR) return process.env.EMD_TASK_DIR;
  for (const c of configCandidates()) {
    const p = String(c).replace(/[\\/][^\\/]+$/, "");
    if (isFile(c)) return p;
  }
  const hd = homeDataDir();
  try { if (statSync(hd).isDirectory()) return hd; } catch (e) {}
  return hd;
}

/** 诊断信息（排错时打印一行就够） */
export function describeEnv() {
  return `home=${HOME} toolsDirs=${toolsDirCandidates().join("|")} ffmpeg=${FFMPEG} ffprobe=${FFPROBE} taskDir=${resolveTaskDir()}`;
}
