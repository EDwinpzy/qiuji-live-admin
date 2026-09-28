/**
 * 本机上传热更包：不需要浏览器的「选目录」，默认直接取 app 工程里 build_backend_zip.py 的产物。
 *
 * 用法：
 *   node scripts/ops/hu-upload.mjs                       默认路径 + 立即发布
 *   node scripts/ops/hu-upload.mjs --offline             只上传（下线态），不推给设备
 *   node scripts/ops/hu-upload.mjs --file <zip 路径>      换文件
 *   node scripts/ops/hu-upload.mjs --name "1.27-fix1" --notes "运维备注" --force
 *   node scripts/ops/hu-upload.mjs --version 22          显式指定热更版本号（缺省 max+1）
 *   node scripts/ops/hu-upload.mjs --scheduled 2026-09-16T09:00
 *   node scripts/ops/hu-upload.mjs --dry-run             只登录 + 看要传什么，不传
 *
 * 站点：必须用 --site <后台地址> 或环境变量 SITE_URL 显式指定，**没有默认值**。
 *       CloudBase 已于 2026-09-24 退役；若这里保留一个内置默认站点，AGENTS.md 里
 *       「裸跑本脚本」的标准发布流程就会把热更静默发回那个已下线的云端，
 *       而且日志看起来一切正常。宁可失败，也不要猜目标。
 * 账号：OTV_ADMIN_USER（默认 admin）
 * 密码：OTV_ADMIN_PASS；未设置时读本机密钥文件（默认 My TV/tools/keys/admin_pass.txt）
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PASS_FILE = path.join("D:", "MyProjects", "My TV", "tools", "keys", "admin_pass.txt");
const CHUNK = 4 * 1024 * 1024;

/** 默认路径：build_backend_zip.py 的产物在 app 工程的 assets 里（internal/mobile 下是同一份镜像）。 */
const DEFAULT_FILES = [
  path.join("D:", "MyProjects", "My TV", "android", "app", "src", "main", "assets", "backend", "python-backend.zip"),
  path.join("D:", "MyProjects", "My TV", "internal", "mobile", "app", "src", "main", "assets", "backend", "python-backend.zip"),
];

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const rawSite = arg("site") || process.env.SITE_URL || "";
if (!rawSite) {
  console.error(
    "缺少发布站点：请用 --site <后台地址> 或设置 SITE_URL 环境变量。\n" +
      "本脚本不再内置默认站点——CloudBase 已退役，猜错目标会把热更发到错误的地方。\n" +
      "例：node scripts/ops/hu-upload.mjs --site https://<正式域名>/admin --name \"1.27-fix1\"",
  );
  process.exit(2);
}
const site = rawSite.replace(/\/$/, "");
const user = process.env.OTV_ADMIN_USER || "admin";
const dryRun = flag("dry-run");
const scheduled = arg("scheduled");
const status = scheduled ? "scheduled" : flag("offline") ? "offline" : "published";
const name = arg("name");
// 备注用本机时间（toISOString 是 UTC，会在后台列表里差 8 小时）
const localStamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
})();
const notes = arg("notes") || `本机上传 ${localStamp}`;
const force = flag("force");
// 显式版本号：切换云端基座时库里最高版本低于设备端已装热更版本，自动 max+1 会被设备忽略
const explicitVersion = arg("version");
if (explicitVersion && !/^[1-9][0-9]{0,7}$/.test(explicitVersion)) {
  console.error(`--version 必须是 1–99999999 的整数，收到「${explicitVersion}」`);
  process.exit(2);
}

const requested = arg("file");
const candidates = requested ? [path.resolve(requested)] : DEFAULT_FILES;
const file = candidates.find((p) => existsSync(p));
if (!file) {
  console.error(
    `找不到热更包：\n  ${candidates.join("\n  ")}\n` +
      `先跑一次 python tools/build_backend_zip.py，或用 --file <zip 路径> 指定。`,
  );
  process.exit(2);
}
const size = statSync(file).size;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

let password = process.env.OTV_ADMIN_PASS || "";
if (!password && existsSync(PASS_FILE)) password = readFileSync(PASS_FILE, "utf8").trim();
if (!password) {
  console.error(`缺少后台密码：设置 OTV_ADMIN_PASS 或写入 ${PASS_FILE}`);
  process.exit(2);
}

const statusText = status === "published" ? "立即发布（设备下次启动生效）"
  : status === "scheduled" ? `定时发布（${scheduled}）`
  : "仅上传（下线态，不推给设备）";

console.log(`站点    ${site}`);
console.log(`文件    ${file}（${mb(size)}）`);
console.log(`发布    ${statusText}`);
if (explicitVersion) console.log(`版本    指定 v${explicitVersion}（缺省为站点当前最高版本 +1）`);

const login = await fetch(`${site}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ user, pass: password }),
});
if (!login.ok) {
  console.error(`登录失败 HTTP ${login.status}：${(await login.text()).slice(0, 200)}`);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.()[0] || "").split(";")[0];
if (!cookie) {
  console.error("登录未返回会话 Cookie");
  process.exit(1);
}

async function postJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { cookie, ...(init.headers || {}) } });
  const text = await response.text();
  try {
    return { ok: response.ok, data: JSON.parse(text) };
  } catch {
    return { ok: false, data: { error: `HTTP ${response.status}：${text.slice(0, 160)}` } };
  }
}

if (dryRun) {
  const state = await postJson(`${site}/api/hu_list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 1 }),
  });
  const latest = state.data?.rows?.[0]?.hot_version_code ?? "?";
  console.log(`\n--dry-run：已登录，未上传。站点当前最新热更版本 v${latest}。`);
} else {
  const buffer = readFileSync(file);
  const uid = randomUUID().replace(/-/g, "").slice(0, 16);
  const total = Math.max(1, Math.ceil(size / CHUNK));

  for (let i = 0; i < total; i += 1) {
    const part = buffer.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, size));
    process.stdout.write(`\r上传分片 ${i + 1}/${total}（${Math.round((i * CHUNK) / size * 100)}%）…`);
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const query = new URLSearchParams({ uid, seq: String(i) });
      const result = await postJson(`${site}/api/hu_upload_chunk?${query}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: part,
      });
      if (result.data.ok) { lastError = null; break; }
      lastError = result.data.error || "未知错误";
    }
    if (lastError) {
      process.stdout.write("\n");
      console.error(`分片 ${i + 1}/${total} 三次重试仍失败：${lastError}`);
      process.exit(1);
    }
  }
  process.stdout.write("\r");

  const meta = new URLSearchParams({
    uid,
    total: String(total),
    size: String(size),
    status,
    name: name || "",
    notes,
    force: force ? "true" : "false",
    publishAt: scheduled || "",
  });
  if (explicitVersion) meta.set("version", explicitVersion);
  const commit = await postJson(`${site}/api/hu_upload_commit?${meta}`, { method: "POST" });
  if (commit.data.error) {
    console.error(`上传失败：${commit.data.error}`);
    process.exit(1);
  }
  const doneText = status === "published" ? "已发布" : status === "scheduled" ? "已定时" : "已上传（下线态）";
  console.log(`\n热更包 v${commit.data.version} ${doneText} · ${mb(commit.data.size)} · SHA-256 ${commit.data.sha256}`);
  if (status === "offline") console.log("要推给设备时，到后台「热更新」页点该版本的「上线」。");
}
