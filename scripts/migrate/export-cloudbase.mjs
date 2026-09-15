/**
 * 从 CloudBase 只读导出存量数据与对象（不写线上任何东西）。
 *
 * 用法：node scripts/migrate/export-cloudbase.mjs [输出目录]
 * 凭据：D:\MyProjects\My TV\tools\keys\svc_import_user.txt / svc_import_pass.txt
 * 产物：<输出目录>/snapshot.json（表数据摘要 + 对象清单）与 <输出目录>/objects/（对象原文）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const keysDir = path.join("D:", "MyProjects", "My TV", "tools", "keys");
const HOST = "https://appletv-d5ge1bth794873f76.api.tcloudbasegateway.com";
const BUCKET = `${HOST}/v1/storages/object/hotupdate`;

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, ".migrate", new Date().toISOString().replace(/[:.]/g, "-"));
const objectsDir = path.join(outDir, "objects");
mkdirSync(objectsDir, { recursive: true });

function key(name) {
  const file = path.join(keysDir, name);
  if (!existsSync(file)) throw new Error(`缺少凭据文件 ${file}`);
  return readFileSync(file, "utf8").trim();
}

let token = "";

async function signin() {
  const response = await fetch(`${HOST}/auth/v1/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: key("svc_import_user.txt"), password: key("svc_import_pass.txt") }),
  });
  if (!response.ok) throw new Error(`signin HTTP ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error("signin 未返回 access_token");
  token = data.access_token;
}

async function rpc(name, payload = {}) {
  const response = await fetch(`${HOST}/v1/rdb/rest/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`rpc ${name} 返回非 JSON（HTTP ${response.status}）: ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`rpc ${name} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function rpcPaged(name, limit = 200) {
  const rows = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const page = await rpc(name, { p_limit: limit, p_offset: offset });
    if (page?.error) throw new Error(`${name}: ${JSON.stringify(page.error)}`);
    const chunk = page.rows || [];
    rows.push(...chunk);
    total = page.total ?? rows.length;
    if (!chunk.length || rows.length >= total) break;
    offset += chunk.length;
  }
  return rows;
}

function objectKeyFromUrl(url) {
  const marker = "/v1/storages/object/hotupdate/";
  const idx = String(url || "").indexOf(marker);
  return idx >= 0 ? decodeURIComponent(String(url).slice(idx + marker.length)) : "";
}

const objects = [];

async function downloadObject(keyName, required = false) {
  const safe = keyName.replace(/[\\/]/g, "_");
  const file = path.join(objectsDir, safe);
  const response = await fetch(`${BUCKET}/${keyName}`);
  if (!response.ok) {
    if (required) throw new Error(`对象 ${keyName} 下载失败 HTTP ${response.status}`);
    console.log(`  跳过 ${keyName}（HTTP ${response.status}）`);
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, buffer);
  const entry = {
    key: keyName,
    file: path.posix.join("objects", safe),
    size: buffer.byteLength,
  };
  objects.push(entry);
  console.log(`  ✓ ${keyName}（${(buffer.byteLength / 1048576).toFixed(1)} MB）`);
  return entry;
}

console.log(`导出目录：${outDir}`);
await signin();
console.log("signin ok");

console.log("· 卡密表");
const licenses = await rpcPaged("admin_license_v2_export");
console.log(`  ${licenses.length} 行`);

console.log("· 激活日志");
const activateLog = await rpcPaged("admin_license_v2_log_export");
console.log(`  ${activateLog.length} 行`);

console.log("· 热更包元数据");
const hotupdatePackages = await rpc("hotupdate_admin_list", { p_limit: 200, p_offset: 0 });
console.log(`  ${Array.isArray(hotupdatePackages) ? hotupdatePackages.length : 0} 行`);

console.log("· 热更上报日志");
const hotupdateLogs = await rpc("hotupdate_admin_logs", { p_limit: 500 });
console.log(`  ${Array.isArray(hotupdateLogs) ? hotupdateLogs.length : 0} 行`);

console.log("· 电视源");
const iptvList = await rpc("iptv_admin_list");
const iptvVersions = await rpc("iptv_admin_versions", { p_limit: 200 });
const iptvLogs = await rpc("iptv_admin_logs", { p_limit: 500 });
const iptvGroups = await rpc("iptv_admin_group_list");
const iptvMode = await rpc("iptv_admin_get_mode");
console.log(`  ${iptvList?.channels?.length || 0} 频道 / ${iptvVersions?.length || 0} 版本 / ${iptvGroups?.length || 0} 分组 / 模式 ${iptvMode?.mode}`);

console.log("· 公告 / 影视源");
const announcement = await rpc("announcement_admin_get");
const vodSources = await rpc("vod_source_admin_list");
console.log(`  公告 ${announcement?.ann ? "有" : "无"} / 影视源 ${vodSources?.drafts?.length || 0} 个（已发布 v${vodSources?.publishedVersion || 0}）`);

console.log("· 对象");
await downloadObject("iptv/iptv-latest.m3u", true);
await downloadObject("iptv/version.json");
for (const row of iptvVersions || []) {
  if (row.object_key) await downloadObject(row.object_key);
}
for (const row of Array.isArray(hotupdatePackages) ? hotupdatePackages : []) {
  const keyName = row.object_key || `backend-hu${row.hot_version_code}.zip`;
  await downloadObject(keyName);
}
for (const channel of iptvList?.channels || []) {
  const keyName = objectKeyFromUrl(channel.logo);
  if (keyName) await downloadObject(keyName);
}

const snapshot = {
  exportedAt: new Date().toISOString(),
  source: "cloudbase:appletv-d5ge1bth794873f76",
  licenses,
  activateLog,
  hotupdate: { packages: hotupdatePackages, logs: hotupdateLogs },
  iptv: {
    channels: iptvList?.channels || [],
    latest: iptvList?.latest || null,
    versions: iptvVersions || [],
    logs: iptvLogs || [],
    groups: iptvGroups || [],
    mode: iptvMode?.mode || "auto",
  },
  announcement: announcement?.ann || null,
  vod: { drafts: vodSources?.drafts || [], publishedVersion: vodSources?.publishedVersion || 0 },
  objects,
};
writeFileSync(path.join(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 1));
console.log(`\n完成：${licenses.length} 卡密 / ${objects.length} 对象 → ${path.join(outDir, "snapshot.json")}`);
