/**
 * 把 export-cloudbase.mjs 的快照导入已部署的 Sites 站点（需要在后台登录一次取会话）。
 *
 * 用法：
 *   node scripts/migrate/import-to-site.mjs <快照目录> [站点地址]
 * 密码：读 .dev-state/admin_pass.txt（本地预览密码），或环境变量 OTV_ADMIN_PASS
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const snapshotDir = process.argv[2] ? path.resolve(process.argv[2]) : "";
const base = (process.argv[3] || process.env.SITE_URL || "").replace(/\/$/, "");
if (!snapshotDir || !base) {
  console.error("用法：node scripts/migrate/import-to-site.mjs <快照目录> <站点地址>");
  process.exit(64);
}

const snapshot = JSON.parse(readFileSync(path.join(snapshotDir, "snapshot.json"), "utf8"));
const password = process.env.OTV_ADMIN_PASS
  || readFileSync(path.join(root, ".dev-state/admin_pass.txt"), "utf8").trim();

let cookie = "";

// 站点若开启了 ChatGPT 登录门禁（私有站点），用 OAI-Sites-Authorization 绕过门禁，
// 后台自身的账号密码门禁照旧——这个头只是让脚本能到达 Worker。
const bypass = process.env.OAI_SITES_AUTHORIZATION || "";
function gateHeaders() {
  return bypass ? { "oai-sites-authorization": `Bearer ${bypass}` } : {};
}

async function login() {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...gateHeaders() },
    body: JSON.stringify({ user: process.env.OTV_ADMIN_USER || "admin", pass: password }),
  });
  if (!response.ok) throw new Error(`登录失败 HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  cookie = (response.headers.getSetCookie?.()[0] || "").split(";")[0];
  if (!cookie) throw new Error("登录未返回会话 Cookie");
}

async function post(pathname, { body, raw, contentType } = {}) {
  const headers = { cookie, ...gateHeaders() };
  let payload;
  if (raw) {
    headers["content-type"] = contentType || "application/octet-stream";
    payload = raw;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(base + pathname, { method: "POST", headers, body: payload });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}: ${String(text).slice(0, 200)}`);
  return data;
}

console.log(`目标站点：${base}`);
await login();
console.log("登录成功");

console.log("· 导入表数据");
const result = await post("/api/import_snapshot", { body: snapshot });
if (!result.ok) throw new Error(`导入失败：${JSON.stringify(result).slice(0, 300)}`);
console.log(`  ${JSON.stringify(result.stats)}`);

console.log("· 导入对象");
for (const entry of snapshot.objects || []) {
  const file = path.join(snapshotDir, entry.file);
  if (!existsSync(file)) {
    console.log(`  跳过 ${entry.key}（本地缺少 ${entry.file}）`);
    continue;
  }
  const buffer = readFileSync(file);
  const type = entry.key.endsWith(".zip")
    ? "application/zip"
    : entry.key.endsWith(".m3u")
      ? "audio/x-mpegurl"
      : entry.key.endsWith(".png")
        ? "image/png"
        : entry.key.endsWith(".json")
          ? "application/json"
          : "application/octet-stream";
  const out = await post(`/api/import_object?key=${encodeURIComponent(entry.key)}&type=${encodeURIComponent(type)}`, {
    raw: buffer,
    contentType: type,
  });
  if (!out.ok) throw new Error(`${entry.key} 导入失败：${JSON.stringify(out)}`);
  console.log(`  ✓ ${entry.key}（${(out.size / 1048576).toFixed(1)} MB）`);
}

console.log("\n导入完成。注意：设备仍指向旧域名时，两套数据会各自变化——切域名前建议再跑一次同步。");
