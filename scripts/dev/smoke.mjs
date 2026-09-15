// 端到端冒烟：真实调用本地预览的 Worker（后台接口 + 设备接口）。
// 用法：npm run dev 后另开一个终端 npm run smoke
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const base = process.env.BASE || "http://127.0.0.1:8791";
const adminPass = readFileSync(path.join(root, ".dev-state/admin_pass.txt"), "utf8").trim();

let cookie = "";
let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` · ${detail}` : ""}`);
}

async function call(pathname, { method = "POST", body, raw, headers = {}, session = true } = {}) {
  const init = { method, headers: { ...headers } };
  if (session && cookie) init.headers.cookie = cookie;
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + pathname, init);
  const setCookie = response.headers.getSetCookie?.() || [];
  if (setCookie.length) cookie = setCookie[0].split(";")[0];
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

const deviceA = "aa11bb22".repeat(8);
const deviceB = "cc33dd44".repeat(8);
const deviceC = "ee55ff66".repeat(8);

// ---- 后台门禁 ----
const page = await call("/", { method: "GET", session: false });
check("GET / 返回管理界面", page.status === 200 && String(page.data).includes("<title>"), `status=${page.status}`);

const anon = await call("/api/whoami", { session: false });
check("未登录时 whoami 401", anon.status === 401);

const badLogin = await call("/api/login", { body: { user: "admin", pass: "wrong" }, session: false });
check("错误密码被拒", badLogin.status === 401);

const login = await call("/api/login", { body: { user: "admin", pass: adminPass }, session: false });
check("正确密码登录成功", login.status === 200 && login.data.ok === true && cookie.length > 0);

const whoami = await call("/api/whoami");
check("登录后 whoami ok", whoami.status === 200 && whoami.data.ok === true);

// ---- 后台数据接口 ----
const stats = await call("/api/stats", { body: {} });
const unsold = (stats.data.plans || []).find((p) => p.plan === "monthly");
check("总览统计", Array.isArray(stats.data.plans) && unsold?.total >= 2, JSON.stringify(stats.data.plans?.[0] || {}));

const licenses = await call("/api/licenses", { body: { limit: 10, offset: 0, sort: "updated_at", dir: "desc" } });
check(
  "卡密列表",
  licenses.data.total >= 6 && Array.isArray(licenses.data.rows[0].devices),
  `total=${licenses.data.total}`,
);

const filtered = await call("/api/licenses", { body: { limit: 50, status: "banned" } });
check("卡密按封禁筛选", filtered.data.rows.length === 1 && filtered.data.rows[0].status === "banned");

const logs = await call("/api/logs", { body: { limit: 50 } });
check("激活日志", Array.isArray(logs.data.rows) && logs.data.rows.length >= 4);

const huList = await call("/api/hu_list", { body: { limit: 50 } });
check("热更包列表", huList.data.rows.length === 2 && huList.data.rows[0].hot_version_code === 16);

const huLogs = await call("/api/hu_logs", { body: { limit: 50 } });
check("热更上报日志", Array.isArray(huLogs.data.rows));

const ann = await call("/api/ann_get", { body: {} });
check("公告读取", ann.data.ann?.title === "电视源已更新");

const health = await call("/api/health", { body: {} });
check("激活链路健康探测", health.data.ok === true, `${health.data.latency_ms}ms`);

const huHealth = await call("/api/hu_health", { body: {} });
check("热更链路健康探测", huHealth.data.ok === true && huHealth.data.blackout === false);

const iptv = await call("/api/iptv_list", { body: {} });
check(
  "电视源列表",
  iptv.data.channels.length === 7 && iptv.data.mode === "manual",
  `channels=${iptv.data.channels.length} mode=${iptv.data.mode}`,
);

const groups = await call("/api/iptv_group_list", { body: {} });
check("电视源分组", Array.isArray(groups.data) && groups.data.length === 5);

const versions = await call("/api/iptv_versions", { body: { limit: 20 } });
check("电视源版本历史", versions.data.rows.length >= 1 && versions.data.rows[0].version === 7);

const latest = await call("/api/iptv_latest", { body: {} });
check("线上 latest 探针", latest.data.channels === 7 && latest.data.managed === true, `channels=${latest.data.channels}`);

const vod = await call("/api/vod_source_list", { body: {} });
check(
  "影视源草稿",
  vod.data.drafts.length === 4 && vod.data.publishedVersion === 1,
  `drafts=${vod.data.drafts.length} published=${vod.data.publishedVersion}`,
);

// ---- 卡密运维动作 ----
const unbind = await call("/api/unbind", { body: { code: "OTV-8GHKM-6VQSL", device: "ffeeddcc".repeat(8) } });
check("解绑单台设备", unbind.data.ok === true && unbind.data.n === 1);
const afterUnbind = await call("/api/licenses", { body: { q: "OTV-8GHKM-6VQSL", limit: 5 } });
check("解绑后设备数下降", afterUnbind.data.rows[0].devices.length === 1);

const sold = await call("/api/mark_sold", { body: { code: "OTV-2K7QH-9WX4M", sold: true } });
const afterSold = await call("/api/licenses", { body: { q: "OTV-2K7QH-9WX4M", limit: 5 } });
check("标记出售", sold.data.ok === true && Boolean(afterSold.data.rows[0].sold_at));

const banned = await call("/api/set_status", { body: { code: "OTV-2K7QH-9WX4M", status: "banned" } });
const afterBan = await call("/api/licenses", { body: { q: "OTV-2K7QH-9WX4M", limit: 5 } });
check("封禁卡密", banned.data.ok === true && afterBan.data.rows[0].status === "banned");
await call("/api/set_status", { body: { code: "OTV-2K7QH-9WX4M", status: "active" } });

const gen = await call("/api/gen", { body: { plan: "monthly", count: 2, note: "冒烟测试" } });
check(
  "云端补货（私钥签发）",
  gen.data.imported === 2 && Boolean(gen.data.batch) && String(gen.data.csv_text).includes("OTV-"),
  `batch=${gen.data.batch}`,
);
if (gen.data.csv_text) {
  const fs = await import("node:fs");
  fs.writeFileSync(
    path.join(root, ".dev-state/last-batch.json"),
    JSON.stringify({
      batch: gen.data.batch,
      csv: gen.data.csv_text,
      codes: [...String(gen.data.csv_text).matchAll(/OTV-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/g)].map((m) => m[0]),
    }, null, 2),
  );
}

// ---- 设备端协议 ----
const activate = await call("/activate", { body: { protocol: 2, action: "activate", code: "OTV-3QWE7-2ASDF", deviceId: deviceA }, session: false });
check("设备激活", activate.data.ret === 0 && activate.data.ticket?.code === "OTV-3QWE7-2ASDF", `expireAt=${activate.data.expireAt}`);

const verifyOther = await call("/activate", { body: { protocol: 2, action: "verify", code: "OTV-3QWE7-2ASDF", deviceId: deviceB }, session: false });
check("未绑定设备复验被拒（406）", verifyOther.data.ret === 406);

const activateSecond = await call("/activate", { body: { protocol: 2, action: "activate", code: "OTV-3QWE7-2ASDF", deviceId: deviceB }, session: false });
check("第二台设备绑定", activateSecond.data.ret === 0);

const activateThird = await call("/activate", { body: { protocol: 2, action: "activate", code: "OTV-3QWE7-2ASDF", deviceId: deviceC }, session: false });
check("第三台设备被拒（402 device_full）", activateThird.data.ret === 402);

const verify = await call("/activate", { body: { protocol: 2, action: "verify", code: "OTV-3QWE7-2ASDF", deviceId: deviceA }, session: false });
check("已绑定设备复验通过", verify.data.ret === 0 && Boolean(verify.data.serverNow));

const renew = await call("/activate", { body: { protocol: 2, action: "renew", code: "OTV-9HKM2-7PQRS", currentCode: "OTV-3QWE7-2ASDF", deviceId: deviceA }, session: false });
check("续费（终身卡 → expireAt 置空）", renew.data.ret === 0 && renew.data.expireAt === null, `expireAt=${renew.data.expireAt}`);

const reuseRenewal = await call("/activate", { body: { protocol: 2, action: "renew", code: "OTV-9HKM2-7PQRS", currentCode: "OTV-3QWE7-2ASDF", deviceId: deviceA }, session: false });
check("续费卡不可重复使用（409）", reuseRenewal.data.ret === 409);

const bannedCard = await call("/activate", { body: { protocol: 2, action: "verify", code: "OTV-4ZXCV-7PLMN", deviceId: "99887766".repeat(8) }, session: false });
check("封禁卡复验被拒（403）", bannedCard.data.ret === 403);

const badProtocol = await call("/activate", { body: { protocol: 1, action: "activate", code: "OTV-3QWE7-2ASDF", deviceId: deviceA }, session: false });
check("协议版本不匹配（426）", badProtocol.data.ret === 426);

// ---- 设备端热更 / 公告 / 影视源 ----
const checkHot = await call("/hotupdate/check", { body: { hotVersion: 15, apkVersion: 25, deviceId: deviceA }, session: false });
check(
  "热更检查（有更新 + 下载地址）",
  checkHot.data.hasUpdate === true && String(checkHot.data.pkg?.url || "").includes("/objects/backend-hu16.zip"),
  checkHot.data.pkg?.url,
);

const noUpdate = await call("/hotupdate/check", { body: { hotVersion: 16, apkVersion: 25, deviceId: deviceA }, session: false });
check("已是最新时无更新", noUpdate.data.hasUpdate === false);

const badApk = await call("/hotupdate/check", { body: { hotVersion: 0, apkVersion: 0, deviceId: deviceA }, session: false });
check("非法 apkVersion 被拒（400）", badApk.data.ret === 400);

const report = await call("/hotupdate/report", {
  body: { deviceId: deviceA, apkVersion: 25, fromVersion: 15, toVersion: 16, result: "applied" },
  session: false,
});
check("热更上报", report.data.ret === 0);

const announce = await call("/announce", { method: "GET", session: false });
check("设备端公告", announce.data.ann?.title === "电视源已更新");

const vodCheck = await call("/vod-sources/check", { body: { deviceId: deviceA, version: 0 }, session: false });
check("影视源检查有更新", vodCheck.data.hasUpdate === true && vodCheck.data.version === 1);

const iptvLatest = await call("/iptv/latest", { method: "GET", session: false });
check("设备端拉取 latest.m3u", String(iptvLatest.data).startsWith("#EXTM3U"));

const iptvStatus = await call("/iptv/status", { method: "GET", session: false });
check("电视源状态", iptvStatus.data.mode === "manual" && iptvStatus.data.version === 7);

const obj = await call("/objects/iptv/iptv-latest.m3u", { method: "GET", session: false });
check("对象直读（Range 兼容路径）", obj.status === 200 && String(obj.data).includes("#EXTM3U"));

// ---- 电视源发布 / 回滚 ----
const publish = await call("/api/iptv_publish", { body: { notes: "冒烟测试发布" } });
check(
  "电视源发布",
  publish.data.ret === 0 && publish.data.version === 8 && publish.data.channels === 7,
  `v${publish.data.version} ${publish.data.channels} 频道 ${publish.data.lines} 线`,
);
const rollback = await call("/api/iptv_rollback", { body: { version: 7 } });
check("电视源回滚", rollback.data.ret === 0 && rollback.data.version === 9, `新版本 v${rollback.data.version}`);
const modeAuto = await call("/api/iptv_mode", { body: { mode: "auto" } });
const modeBack = await call("/api/iptv_mode", { body: { mode: "manual" } });
check("模式切换", modeAuto.data.mode === "auto" && modeBack.data.mode === "manual");

// ---- 登录限速：失败计数必须落 D1（线上每个请求可能是全新 isolate，内存计数不算数）----
const guardStatuses = [];
for (let i = 0; i < 5; i += 1) {
  const attempt = await call("/api/login", { body: { user: "admin", pass: `wrong-${i}` }, session: false });
  guardStatuses.push(attempt.status);
}
const lockedRightPass = await call("/api/login", { body: { user: "admin", pass: adminPass }, session: false });
check(
  "连续失败 5 次后锁定（正确密码也 429）",
  guardStatuses.every((status) => status === 401) && lockedRightPass.status === 429,
  `前五次=${guardStatuses.join("/")} 第六次=${lockedRightPass.status}`,
);

const guardDb = new DatabaseSync(path.join(root, ".dev-state/d1.sqlite"));
const guardRows = guardDb.prepare("SELECT scope, fails, locked_until FROM login_guard").all();
guardDb.prepare("DELETE FROM login_guard").run();
guardDb.close();
const lockedRow = guardRows.find((row) => row.scope === "all");
check(
  "锁定记录落在 D1（跨 isolate / 重启仍生效）",
  Boolean(lockedRow) && Number(lockedRow.locked_until) > Date.now(),
  `scopes=${guardRows.map((row) => `${row.scope}#${row.fails}`).join(",")}`,
);

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
