// 本地预览用样例数据（只写 .dev-state 的本地库，不触碰线上）。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createD1, createR2 } from "./emulate.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stateDir = path.join(root, ".dev-state");
mkdirSync(stateDir, { recursive: true });

const db = createD1(path.join(stateDir, "d1.sqlite"), path.join(root, "drizzle"));
const r2 = createR2(path.join(stateDir, "r2"));
const now = Date.now();
const iso = (offsetDays = 0, offsetHours = 0) => new Date(now + offsetDays * 86_400_000 + offsetHours * 3_600_000).toISOString();

function ticketFor(code, plan, days, issued) {
  const nonce = "0000000000000000";
  return JSON.stringify({ v: 1, code, plan, days, issued, nonce, sig: "PREVIEW" });
}

await db.exec("DELETE FROM licenses; DELETE FROM activate_log; DELETE FROM hotupdate_pkg; DELETE FROM hotupdate_log;");
await db.exec("DELETE FROM announcements; DELETE FROM iptv_channel; DELETE FROM iptv_line; DELETE FROM iptv_version;");
await db.exec("DELETE FROM iptv_admin_log; DELETE FROM iptv_config; DELETE FROM iptv_group;");
await db.exec("DELETE FROM vod_source_drafts; DELETE FROM vod_source_versions;");

const licenses = [
  ["OTV-2K7QH-9WX4M", "yearly", 365, "active", "[]", "首发批次", iso(-31), iso(-31), null, null],
  ["OTV-5RTYD-3BNPZ", "monthly", 30, "active", JSON.stringify(["a1b2c3d4".repeat(8)]), "首发批次", iso(-20), iso(-19), iso(-19), iso(11)],
  ["OTV-8GHKM-6VQSL", "quarterly", 90, "active", JSON.stringify(["ffeeddcc".repeat(8), "11223344".repeat(8)]), "微博团购", iso(-9), iso(-8), iso(-8), iso(82)],
  ["OTV-4ZXCV-7PLMN", "monthly", 30, "banned", JSON.stringify(["99887766".repeat(8)]), "退款封禁", iso(-6), iso(-2), iso(-5), iso(-5)],
  ["OTV-3QWE7-2ASDF", "yearly", 365, "active", "[]", "待发卡", iso(-2), iso(-2), null, null],
  ["OTV-9HKM2-7PQRS", "lifetime", 0, "active", "[]", "自用", iso(-1), iso(-1), null, null],
];
for (const [code, plan, days, status, devices, note, createdAt, updatedAt, activatedAt, expireAt] of licenses) {
  await db.prepare(
    `INSERT INTO licenses (code, plan, days, status, max_dev, devices, note, ticket,
       sold_at, activated_at, expire_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code, plan, days, status, devices, note,
    ticketFor(code, plan, days, createdAt.slice(0, 10)),
    activatedAt ? createdAt : null, activatedAt, expireAt, createdAt, updatedAt,
  );
}

for (const [code, device, result, at] of [
  ["OTV-5RTYD-3BNPZ", "a1b2c3d4".repeat(8), "activate_ok", iso(-19)],
  ["OTV-8GHKM-6VQSL", "ffeeddcc".repeat(8), "activate_ok", iso(-8)],
  ["OTV-4ZXCV-7PLMN", "99887766".repeat(8), "banned", iso(-2)],
  ["OTV-4ZXCV-7PLMN", "99887766".repeat(8), "verify_ok", iso(0, -5)],
]) {
  await db.prepare(
    "INSERT INTO activate_log (code, device_id, ip, result, at) VALUES (?, ?, ?, ?, ?)",
  ).run(code, device, "203.0.113.7", result, at);
}

await db.prepare(
  `INSERT INTO hotupdate_pkg (hot_version_code, hot_version_name, object_key, file_size, sha256,
     notes, force_apply, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
).run(16, "1.25-hot16", "backend-hu16.zip", 36_512_004, "a".repeat(64), "影视多源池 + 解密池自愈", "published", iso(-7), iso(-7));
await db.prepare(
  `INSERT INTO hotupdate_pkg (hot_version_code, hot_version_name, object_key, file_size, sha256,
     notes, force_apply, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
).run(15, "1.24-hot15", "backend-hu15.zip", 35_998_112, "b".repeat(64), "上一版（已下线）", "offline", iso(-12), iso(-9));

for (const [device, apk, from, to, result, at] of [
  ["cafe0000".repeat(8), 25, 15, 16, "applied", iso(0, -3)],
  ["beef1111".repeat(8), 25, 16, 16, "applied", iso(0, -1)],
]) {
  await db.prepare(
    `INSERT INTO hotupdate_log (device, apk_version, from_version, to_version, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, '', ?)`,
  ).run(device, apk, from, to, result, at);
}

await db.prepare(
  "INSERT INTO announcements (title, content, status, created_at, updated_at) VALUES (?, ?, 'published', ?, ?)",
).run("电视源已更新", "本次更新替换了 12 个失效线路，重进电视页自动生效。", iso(-1), iso(-1));

const channels = [
  ["CCTV-1 综合", "央视", 0, ["http://1.2.3.4/live/cctv1.m3u8", "http://1.2.3.5/live/cctv1b.m3u8"]],
  ["CCTV-5 体育", "央视", 1, ["http://1.2.3.4/live/cctv5.m3u8"]],
  ["湖南卫视", "卫视", 0, ["http://1.2.3.4/live/hunan.m3u8", "http://1.2.3.5/live/hunan-b.m3u8"]],
  ["东方卫视", "卫视", 1, ["http://1.2.3.4/live/dongfang.m3u8"]],
  ["广东体育", "体育", 0, ["http://1.2.3.4/live/gdty.m3u8"]],
  ["凤凰中文台", "港澳台", 0, ["http://1.2.3.4/live/ifeng.m3u8"]],
  ["北京纪实", "地方", 0, ["http://1.2.3.4/live/bjjs.m3u8"]],
];
for (const [name, group, sort, lines] of channels) {
  const result = await db.prepare(
    `INSERT INTO iptv_channel (name, group_name, logo, sort_order, enabled, note, created_at, updated_at)
     VALUES (?, ?, '', ?, 1, '', ?, ?)`,
  ).run(name, group, sort, iso(-14), iso(-3));
  const channelId = Number(result.meta.last_row_id);
  for (const [index, url] of lines.entries()) {
    await db.prepare(
      `INSERT INTO iptv_line (channel_id, url, sort_order, enabled, note, created_at)
       VALUES (?, ?, ?, 1, '', ?)`,
    ).run(channelId, url, index, iso(-14));
  }
}

for (const [name, sort] of [["央视", 0], ["卫视", 1], ["体育", 2], ["地方", 3], ["港澳台", 4]]) {
  await db.prepare("INSERT INTO iptv_group (name, sort, created_at) VALUES (?, ?, ?)").run(name, sort, iso(-14));
}

await db.prepare(
  `INSERT INTO iptv_version (version, object_key, file_size, sha256, channels, lines, notes, status, created_at)
   VALUES (7, 'iptv/iptv-v7.m3u', 4096, ?, 7, 9, '手动发布', 'published', ?)`,
).run("c".repeat(64), iso(-3));
await db.prepare(
  "INSERT INTO iptv_config (key, value, updated_at) VALUES ('mode', 'manual', ?) ON CONFLICT(key) DO UPDATE SET value = 'manual', updated_at = excluded.updated_at",
).run(iso(-3));
for (const [action, detail, at] of [
  ["import", "merge 模式：新增 7 更新 0 线路 9", iso(-14)],
  ["publish", "v7（7 频道 9 线）手动发布", iso(-3)],
]) {
  await db.prepare("INSERT INTO iptv_admin_log (action, detail, created_at) VALUES (?, ?, ?)").run(action, detail, at);
}

const m3u = [
  "#EXTM3U",
  ...channels.flatMap(([name, group, , lines]) => lines.flatMap((url) => [
    `#EXTINF:-1 tvg-logo="" group-title="${group}",${name}`,
    url,
  ])),
  "",
].join("\n");
await r2.put("iptv/iptv-latest.m3u", m3u, { httpMetadata: { contentType: "audio/x-mpegurl" } });
await r2.put("iptv/iptv-v7.m3u", m3u, { httpMetadata: { contentType: "audio/x-mpegurl" } });
await r2.put(
  "iptv/version.json",
  JSON.stringify({ ret: 0, mode: "manual", updatedAt: iso(-3), version: 7, notes: "手动发布" }),
  { httpMetadata: { contentType: "application/json" } },
);

const vodSources = [
  ["10000000-0000-0000-0000-000000000001", "好好看", "https://www.haohankan.com", "", "hhkan", 10],
  ["10000000-0000-0000-0000-000000000002", "暴风", "https://bfzyapi.com", "https://bfzyapi.com/api.php/provide/vod/", "macms_json", 20],
  ["10000000-0000-0000-0000-000000000003", "极速", "https://jszyapi.com", "https://jszyapi.com/api.php/provide/vod/", "macms_json", 30],
  ["10000000-0000-0000-0000-000000000004", "金鹰", "https://jyzyapi.com", "https://jyzyapi.com/provide/vod/from/jinyingm3u8/", "macms_json", 40],
];
for (const [id, name, site, api, adapter, sort] of vodSources) {
  await db.prepare(
    `INSERT INTO vod_source_drafts (id, name, site_url, api_url, adapter_type, enabled, sort_order, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)`,
  ).run(id, name, site, api, adapter, sort, iso(-5));
}
await db.prepare(
  "INSERT INTO vod_source_versions (version, config, sha256, published_at) VALUES (1, ?, ?, ?)",
).run(JSON.stringify({ schema: 1, version: 1, sources: vodSources.length }), "d".repeat(64), iso(-5));

console.log("本地样例数据已写入 .dev-state/d1.sqlite 与 .dev-state/r2");
db.close();
