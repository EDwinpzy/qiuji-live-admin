/**
 * MyTV 云端（Sites 版）——单文件 Worker。
 *
 * 覆盖能力（与原 CloudBase 环境等价，数据自持）：
 *   后台管理   /api/*（登录门禁 + 总览/卡密/日志/补货/热更/公告/电视源/影视源）
 *   卡密授权   POST /activate（协议 v2：activate / verify / renew）
 *   热更分发   POST /hotupdate/check|report、GET /hotupdate/announce、POST /hotupdate/vod-sources/check
 *   电视源     GET /iptv/latest|/iptv/status、POST /iptv/refresh（外部定时器调用）
 *   对象分发   GET /objects/<key>（R2，支持 Range 断点续传）
 *
 * 绑定：DB = D1；BUCKET = R2。
 * 运行环境密钥（Sites 站点密钥）：
 *   OTV_ADMIN_USER（默认 admin）/ OTV_ADMIN_PASS（必填）/ OTV_ADMIN_SECRET（必填，会话签名）
 *   OTV_PRIV_KEY（PKCS8 PEM，填了才能云端补货）/ OTV_REFRESH_TOKEN（外部触发令牌，可选）
 *   OTV_HU_OFF = "1" 时全局紧急停更
 *
 * 资源占位符由 scripts/build.mjs 在构建时注入（后台 HTML 与品牌图）。
 */

const ADMIN_HTML = __ADMIN_HTML__;
const LOGO_B64 = __LOGO_B64__;

const COOKIE_NAME = "otv_admin_sess";
const SESSION_TTL = 12 * 3600;
const CODE_RE = /^OTV-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const DEVICE_RE = /^[a-f0-9]{64}$/;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PLANS = {
  weekly: { days: 7, price: "0" },
  monthly: { days: 30, price: "9.9" },
  quarterly: { days: 90, price: "29.9" },
  yearly: { days: 365, price: "99.9" },
  lifetime: { days: 0, price: "128" },
};

const HU_MAX_BYTES = 220 * 1024 * 1024;
const HU_BUFFER_MAX = 96 * 1024 * 1024;
const HU_CHUNK_MAX = 4 * 1024 * 1024;
const HU_DIRECT_MAX = 5 * 1024 * 1024;
const HU_UPLOAD_UID_RE = /^[0-9a-f]{8,32}$/;
const HU_REQUIRED_ENTRIES = [
  "proxy.py", "hhkan.py", "scraper.py", "team_backdrop.py", "decrypt_stream.js",
  "douban_catalog.py", "douban_snapshot.json", "vod_api.py",
  "vod_sources.py", "vod_sources.default.json",
];

const IPTV_KEY_LATEST = "iptv/iptv-latest.m3u";
const IPTV_KEY_META = "iptv/version.json";
const IPTV_LOGO_MAX = 2 * 1024 * 1024;
const IPTV_FETCH_MAX = 16 * 1024 * 1024;
const IPTV_UPSTREAMS = [
  "https://gh-proxy.com/raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u",
  "https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u",
  "https://gh-proxy.com/raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u",
];

// ---------------- 基础工具 ----------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function textResponse(body, status = 200, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store", ...extraHeaders },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function isoFrom(ms) {
  return new Date(ms).toISOString();
}

function parseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const t = Date.parse(String(value).replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
}

function toInt(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function base64Bytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function sha256Hex(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function esc(value) {
  return String(value ?? "");
}

function left(value, max) {
  return String(value ?? "").slice(0, max);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

// ---------------- 会话（HMAC 签名 Cookie） ----------------

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

function timingSafeEqual(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return `${exp}.${await hmacHex(env.OTV_ADMIN_SECRET || "", String(exp))}`;
}

async function checkSession(env, token) {
  if (!token || !env.OTV_ADMIN_SECRET) return false;
  const idx = token.indexOf(".");
  if (idx <= 0) return false;
  const exp = Number.parseInt(token.slice(0, idx), 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const sig = await hmacHex(env.OTV_ADMIN_SECRET, String(exp));
  return timingSafeEqual(sig, token.slice(idx + 1));
}

async function sessionOk(request, env) {
  return checkSession(env, parseCookies(request.headers.get("cookie"))[COOKIE_NAME]);
}

function sessionCookie(token, secure) {
  let cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`;
  if (secure) cookie += "; Secure";
  return cookie;
}

// 登录限速：内存快路径 + D1 持久计数。
// Workers 每个请求可能是全新 isolate（实测线上纯内存计数永远不触发），
// 所以判定以 D1 为准：单 IP 60s 内 5 次失败锁定，另有全局兜底上限。
const loginGuard = new Map();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_GLOBAL_LIMIT = 40;

function guardSpecs(peer) {
  // 拿不到客户端 IP 时（平台没给 cf-connecting-ip / x-forwarded-for）退化成单一全局桶，
  // 但仍按单 IP 的 5 次阈值收口，不能让失败的 IP 判定形同虚设。
  if (!peer || peer === "unknown") return [{ scope: "all", limit: LOGIN_FAIL_LIMIT }];
  return [
    { scope: `ip:${peer}`, limit: LOGIN_FAIL_LIMIT },
    { scope: "all", limit: LOGIN_GLOBAL_LIMIT },
  ];
}

async function loginTooBusy(env, peer) {
  const now = Date.now();
  const cached = loginGuard.get(peer);
  if (cached && cached[1] > now) return true;
  const scopes = guardSpecs(peer).map((spec) => spec.scope);
  try {
    const marks = scopes.map(() => "?").join(", ");
    const rows = await dbAll(
      env,
      `SELECT scope, locked_until FROM login_guard WHERE scope IN (${marks})`,
      scopes,
    );
    for (const row of rows) {
      if (Number(row.locked_until) > now) {
        loginGuard.set(peer, [LOGIN_FAIL_LIMIT, Number(row.locked_until)]);
        return true;
      }
    }
  } catch {
    /* D1 异常时不阻断登录，退回内存判定 */
  }
  return false;
}

async function bumpGuard(env, scope, limit, now) {
  const row = await dbFirst(env, "SELECT fails, window_start FROM login_guard WHERE scope = ?", [scope]);
  const sameWindow = Boolean(row) && Number(row.window_start) + LOGIN_WINDOW_MS > now;
  const fails = sameWindow ? Number(row.fails) + 1 : 1;
  const windowStart = sameWindow ? Number(row.window_start) : now;
  const lockedUntil = fails >= limit ? now + LOGIN_WINDOW_MS : 0;
  await dbRun(
    env,
    `INSERT INTO login_guard (scope, fails, window_start, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       fails = excluded.fails,
       window_start = excluded.window_start,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
    [scope, fails, windowStart, lockedUntil, nowIso()],
  );
}

async function noteLogin(env, peer, ok) {
  const now = Date.now();
  const specs = guardSpecs(peer);
  const scopes = specs.map((spec) => spec.scope);
  const marks = scopes.map(() => "?").join(", ");
  if (ok) {
    loginGuard.delete(peer);
    try {
      await dbRun(env, `DELETE FROM login_guard WHERE scope IN (${marks})`, scopes);
    } catch {
      /* 清理失败不影响登录 */
    }
    return;
  }
  const [fails] = loginGuard.get(peer) || [0, 0];
  const next = fails + 1;
  if (loginGuard.size > 1000) loginGuard.clear();
  loginGuard.set(peer, [next, next >= LOGIN_FAIL_LIMIT ? now + LOGIN_WINDOW_MS : 0]);
  try {
    for (const spec of specs) {
      await bumpGuard(env, spec.scope, spec.limit, now);
    }
    if (Math.random() < 0.05) {
      await dbRun(env, "DELETE FROM login_guard WHERE updated_at < ?", [
        isoFrom(now - 24 * 60 * 60 * 1000),
      ]);
    }
  } catch {
    /* 限速写入失败不阻断登录流程 */
  }
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown"
  );
}

// ---------------- D1 访问 ----------------

function sqlParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

async function dbAll(env, sql, params = []) {
  const result = await env.DB.prepare(sql).bind(...sqlParams(params)).all();
  return result.results || [];
}

async function dbFirst(env, sql, params = []) {
  return (await env.DB.prepare(sql).bind(...sqlParams(params)).first()) || null;
}

async function dbRun(env, sql, params = []) {
  return env.DB.prepare(sql).bind(...sqlParams(params)).run();
}

async function dbBatch(env, statements) {
  return env.DB.batch(statements.map(([sql, params]) => env.DB.prepare(sql).bind(...sqlParams(params || []))));
}

async function iptvLog(env, action, detail = "") {
  await dbRun(env, "INSERT INTO iptv_admin_log (action, detail, created_at) VALUES (?, ?, ?)", [
    left(action, 40), left(detail, 800), nowIso(),
  ]);
}

// ---------------- R2 访问 ----------------

async function putObject(env, key, body, contentType) {
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType, cacheControl: "public, max-age=60" },
  });
}

async function getObjectBytes(env, key, maxBytes = 32 * 1024 * 1024) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > maxBytes) return buf.slice(0, maxBytes);
  return buf;
}

async function deleteObject(env, key) {
  try {
    await env.BUCKET.delete(key);
  } catch {
    /* 尽力清理 */
  }
}

function objectUrl(request, key) {
  return `${new URL(request.url).origin}/objects/${key}`;
}

// ---------------- 卡密签发（ECDSA P-256 / SHA-256，输出 DER 与本地 license_gen.py 一致） ----------------

let cachedSignKey = null;

async function privateKey(env) {
  if (cachedSignKey) return cachedSignKey;
  const pem = String(env.OTV_PRIV_KEY || "").replace(/\\n/g, "\n").trim();
  if (!pem || !pem.includes("BEGIN PRIVATE KEY")) return null;
  const der = base64Bytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  cachedSignKey = await crypto.subtle.importKey(
    "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  return cachedSignKey;
}

/** WebCrypto 输出裸 r||s；客户端用 Java SHA256withECDSA（DER）与 WebCrypto(derToP1363) 校验，统一转 DER。 */
function rawSignatureToDer(raw) {
  const bytes = new Uint8Array(raw);
  const half = bytes.length / 2;
  const trimInt = (part) => {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start += 1;
    let out = part.slice(start);
    if (out[0] & 0x80) out = new Uint8Array([0, ...out]);
    return out;
  };
  const r = trimInt(bytes.slice(0, half));
  const s = trimInt(bytes.slice(half));
  const body = new Uint8Array([0x02, r.length, ...r, 0x02, s.length, ...s]);
  return new Uint8Array([0x30, body.length, ...body]);
}

function canonicalTicket(code, plan, days, issued, nonce) {
  return `1|${code}|${plan}|${days}|${issued}|${nonce}`;
}

function genCode() {
  const raw = new Uint8Array(10);
  crypto.getRandomValues(raw);
  let body = "";
  for (let i = 0; i < 10; i += 1) body += ALPHABET[raw[i] % ALPHABET.length];
  return `OTV-${body.slice(0, 5)}-${body.slice(5)}`;
}

async function signTicket(env, code, plan, days, issued, nonce) {
  const key = await privateKey(env);
  if (!key) throw new Error("云端未配置签发私钥（OTV_PRIV_KEY）");
  const raw = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key,
    encoder.encode(canonicalTicket(code, plan, days, issued, nonce)),
  );
  return bytesBase64(rawSignatureToDer(raw));
}

// ---------------- 卡密数据层（对齐 PG RPC 的返回形状） ----------------

function licenseRowToJson(row) {
  return {
    code: row.code,
    plan: row.plan,
    days: row.days,
    status: row.status,
    max_dev: row.max_dev,
    devices: JSON.parse(row.devices || "[]"),
    note: row.note,
    sold_at: row.sold_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    activated_at: row.activated_at,
    expire_at: row.expire_at,
    redeemed_at: row.redeemed_at,
    redeemed_to: row.redeemed_to,
  };
}

const LICENSE_STATUS_FILTERS = {
  active: "status = 'active' AND activated_at IS NOT NULL AND redeemed_at IS NULL",
  redeemed: "redeemed_at IS NOT NULL",
  sold: "status = 'active' AND activated_at IS NULL AND sold_at IS NOT NULL AND redeemed_at IS NULL",
  unsold: "status = 'active' AND activated_at IS NULL AND sold_at IS NULL AND redeemed_at IS NULL",
  banned: "status = 'banned'",
};

const LICENSE_SORTS = {
  code: "code",
  plan: "plan",
  status: "status",
  created_at: "created_at",
  sold_at: "sold_at",
  devices: "LENGTH(devices)",
  updated_at: "updated_at",
};

async function rpcAdminStats(env) {
  const plans = await dbAll(
    env,
    `SELECT plan,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' AND activated_at IS NULL AND sold_at IS NULL THEN 1 ELSE 0 END) AS unsold,
            SUM(CASE WHEN status = 'active' AND activated_at IS NULL AND sold_at IS NOT NULL THEN 1 ELSE 0 END) AS sold,
            SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned
       FROM licenses GROUP BY plan ORDER BY plan`,
  );
  const row = await dbFirst(
    env,
    "SELECT COUNT(*) AS n FROM activate_log WHERE at > ?",
    [isoFrom(Date.now() - 24 * 3600 * 1000)],
  );
  return {
    plans: plans.map((p) => ({
      plan: p.plan, total: p.total, unsold: p.unsold || 0, sold: p.sold || 0, banned: p.banned || 0,
    })),
    log24h: row?.n || 0,
  };
}

async function rpcAdminLicenses(env, params) {
  const q = String(params.p_q || "").trim().toUpperCase();
  const plan = String(params.p_plan || "").trim();
  const status = String(params.p_status || "").trim();
  const limit = clamp(toInt(params.p_limit, 50) ?? 50, 1, 200);
  const offset = Math.max(toInt(params.p_offset, 0) ?? 0, 0);
  const sort = LICENSE_SORTS[String(params.p_sort || "updated_at")] || "updated_at";
  const dir = String(params.p_dir || "desc") === "asc" ? "ASC" : "DESC";

  const where = [];
  const args = [];
  if (q) {
    where.push("code LIKE ?");
    args.push(`%${q}%`);
  }
  if (plan) {
    where.push("plan = ?");
    args.push(plan);
  }
  if (status && LICENSE_STATUS_FILTERS[status]) where.push(LICENSE_STATUS_FILTERS[status]);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await dbFirst(env, `SELECT COUNT(*) AS n FROM licenses ${whereSql}`, args);
  const rows = await dbAll(
    env,
    `SELECT * FROM licenses ${whereSql} ORDER BY ${sort} ${dir}, updated_at DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  return { total: totalRow?.n || 0, rows: rows.map(licenseRowToJson) };
}

async function rpcAdminSetStatus(env, code, status) {
  const row = await dbFirst(env, "SELECT code FROM licenses WHERE code = ?", [code]);
  if (!row) return { ok: false, msg: "not_found" };
  await dbRun(env, "UPDATE licenses SET status = ?, updated_at = ? WHERE code = ?", [status, nowIso(), code]);
  return { ok: true };
}

async function rpcAdminUnbind(env, code, device) {
  const row = await dbFirst(env, "SELECT devices FROM licenses WHERE code = ?", [code]);
  if (!row) return { ok: false, msg: "not_found" };
  const devices = JSON.parse(row.devices || "[]");
  const next = device ? devices.filter((d) => d !== device) : [];
  const removed = devices.length - next.length;
  if (device && removed === 0) return { ok: false, msg: "device_not_bound" };
  await dbRun(env, "UPDATE licenses SET devices = ?, updated_at = ? WHERE code = ?", [
    JSON.stringify(next), nowIso(), code,
  ]);
  await dbRun(
    env,
    "INSERT INTO activate_log (code, device_id, ip, result, at) VALUES (?, ?, ?, ?, ?)",
    [code, device || null, null, device ? "admin_unbind" : "admin_unbind_all", nowIso()],
  );
  return { ok: true, n: removed, devices: next.length };
}

async function rpcAdminMarkSold(env, code, sold) {
  const row = await dbFirst(env, "SELECT code FROM licenses WHERE code = ?", [code]);
  if (!row) return { ok: false, msg: "not_found" };
  const stamp = sold ? nowIso() : null;
  await dbRun(env, "UPDATE licenses SET sold_at = ?, updated_at = ? WHERE code = ?", [stamp, nowIso(), code]);
  await dbRun(
    env,
    "INSERT INTO activate_log (code, device_id, ip, result, at) VALUES (?, ?, ?, ?, ?)",
    [code, null, null, sold ? "admin_sold" : "admin_unsold", nowIso()],
  );
  return { ok: true };
}

async function rpcAdminLogs(env, code, limit) {
  const rows = code
    ? await dbAll(
      env,
      "SELECT code, device_id, ip, result, at FROM activate_log WHERE code = ? ORDER BY at DESC, id DESC LIMIT ?",
      [code, limit],
    )
    : await dbAll(
      env,
      "SELECT code, device_id, ip, result, at FROM activate_log ORDER BY at DESC, id DESC LIMIT ?",
      [limit],
    );
  return { rows };
}

// ---------------- 热更新数据层 ----------------

function huRowToJson(row) {
  return {
    id: row.id,
    hot_version_code: row.hot_version_code,
    hot_version_name: row.hot_version_name,
    apk_min_version: row.apk_min_version,
    apk_max_version: row.apk_max_version,
    object_key: row.object_key,
    file_size: row.file_size,
    sha256: row.sha256,
    notes: row.notes,
    force_apply: Boolean(row.force_apply),
    status: row.status,
    publish_at: row.publish_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function rpcHuList(env, limit, offset) {
  const rows = await dbAll(
    env,
    "SELECT * FROM hotupdate_pkg ORDER BY hot_version_code DESC LIMIT ? OFFSET ?",
    [limit, offset],
  );
  return { rows: rows.map(huRowToJson) };
}

async function rpcHuLogs(env, limit) {
  const rows = await dbAll(
    env,
    `SELECT device, apk_version, from_version, to_version, result, detail, created_at
       FROM hotupdate_log ORDER BY created_at DESC, id DESC LIMIT ?`,
    [limit],
  );
  return { rows };
}

async function rpcHuSetStatus(env, version, status) {
  const result = await dbRun(
    env,
    "UPDATE hotupdate_pkg SET status = ?, publish_at = NULL, updated_at = ? WHERE hot_version_code = ?",
    [status, nowIso(), version],
  );
  if (!result.meta?.changes) return { error: "not_found" };
  return { ret: 0 };
}

async function rpcHuDelete(env, version) {
  const result = await dbRun(env, "DELETE FROM hotupdate_pkg WHERE hot_version_code = ?", [version]);
  if (!result.meta?.changes) return { error: "not_found" };
  await deleteObject(env, `backend-hu${version}.zip`);
  return { ret: 0 };
}

async function rpcHuUpsert(env, pkg) {
  const stamp = nowIso();
  await dbRun(
    env,
    `INSERT INTO hotupdate_pkg
       (hot_version_code, hot_version_name, apk_min_version, apk_max_version, object_key,
        file_size, sha256, notes, force_apply, status, publish_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hot_version_code) DO UPDATE SET
       hot_version_name = excluded.hot_version_name,
       apk_min_version  = excluded.apk_min_version,
       apk_max_version  = excluded.apk_max_version,
       object_key       = excluded.object_key,
       file_size        = excluded.file_size,
       sha256           = excluded.sha256,
       notes            = excluded.notes,
       force_apply      = excluded.force_apply,
       status           = excluded.status,
       publish_at       = excluded.publish_at,
       updated_at       = excluded.updated_at`,
    [
      pkg.hot_version_code, pkg.hot_version_name || "", pkg.apk_min_version ?? 0,
      pkg.apk_max_version ?? 2147483647, pkg.object_key, pkg.file_size, pkg.sha256,
      pkg.notes || "", pkg.force_apply ? 1 : 0, pkg.status, pkg.publish_at || null, stamp, stamp,
    ],
  );
  return { ret: 0 };
}

async function rpcHotupdateCheck(env, hotVersion, apkVersion) {
  const row = await dbFirst(
    env,
    `SELECT * FROM hotupdate_pkg
      WHERE (status = 'published' OR (status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?))
        AND ? BETWEEN apk_min_version AND apk_max_version
        AND hot_version_code > ?
      ORDER BY hot_version_code DESC LIMIT 1`,
    [nowIso(), apkVersion, hotVersion],
  );
  if (!row) return { ret: 0, hasUpdate: false };
  return {
    ret: 0,
    hasUpdate: true,
    pkg: {
      hotVersionCode: row.hot_version_code,
      hotVersionName: row.hot_version_name,
      objectKey: row.object_key,
      fileSize: row.file_size,
      sha256: row.sha256,
      notes: row.notes,
      forceApply: Boolean(row.force_apply),
    },
  };
}

async function rpcHotupdateReport(env, payload) {
  await dbRun(
    env,
    `INSERT INTO hotupdate_log (device, apk_version, from_version, to_version, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      left(payload.device, 64), payload.apkVersion, payload.fromVersion, payload.toVersion,
      left(payload.result, 32), left(payload.detail, 500), nowIso(),
    ],
  );
  return { ret: 0 };
}

// ---------------- 公告数据层 ----------------

async function rpcAnnouncementLatest(env) {
  const row = await dbFirst(
    env,
    "SELECT id, title, content, updated_at FROM announcements WHERE status = 'published' ORDER BY id DESC LIMIT 1",
  );
  if (!row) return { ret: 0, ann: null };
  return { ret: 0, ann: { id: row.id, title: row.title, content: row.content, updatedAt: row.updated_at } };
}

async function rpcAnnouncementAdminGet(env) {
  const row = await dbFirst(env, "SELECT * FROM announcements ORDER BY id DESC LIMIT 1");
  if (!row) return { ret: 0, ann: null };
  return {
    ret: 0,
    ann: { id: row.id, title: row.title, content: row.content, status: row.status, updatedAt: row.updated_at },
  };
}

async function rpcAnnouncementPublish(env, title, content, status) {
  const stamp = nowIso();
  if (status === "published") {
    await dbRun(
      env,
      "INSERT INTO announcements (title, content, status, created_at, updated_at) VALUES (?, ?, 'published', ?, ?)",
      [title.trim(), content, stamp, stamp],
    );
  } else {
    await dbRun(
      env,
      "UPDATE announcements SET status = 'offline', updated_at = ? WHERE status = 'published'",
      [stamp],
    );
  }
  const row = await dbFirst(env, "SELECT MAX(id) AS id FROM announcements");
  return { ret: 0, id: row?.id || 0 };
}

// ---------------- 影视源数据层 ----------------

async function rpcVodSourceList(env) {
  const drafts = await dbAll(env, "SELECT * FROM vod_source_drafts ORDER BY sort_order, id");
  const maxVersion = await dbFirst(env, "SELECT COALESCE(MAX(version), 0) AS v FROM vod_source_versions");
  return {
    drafts: drafts.map((d) => ({
      id: d.id, name: d.name, site_url: d.site_url, api_url: d.api_url,
      adapter_type: d.adapter_type, enabled: Boolean(d.enabled), sort_order: d.sort_order,
      revision: d.revision, updated_at: d.updated_at,
    })),
    publishedVersion: maxVersion?.v || 0,
  };
}

async function rpcVodSourceSave(env, draft) {
  const stamp = nowIso();
  const existing = draft.id ? await dbFirst(env, "SELECT id FROM vod_source_drafts WHERE id = ?", [draft.id]) : null;
  const id = existing?.id || draft.id || crypto.randomUUID();
  if (existing) {
    await dbRun(
      env,
      `UPDATE vod_source_drafts SET name = ?, site_url = ?, api_url = ?, adapter_type = ?,
              enabled = ?, sort_order = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`,
      [
        draft.name, draft.site_url, draft.api_url, draft.adapter_type,
        draft.enabled ? 1 : 0, draft.sort_order || 0, stamp, id,
      ],
    );
  } else {
    await dbRun(
      env,
      `INSERT INTO vod_source_drafts (id, name, site_url, api_url, adapter_type, enabled, sort_order, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, draft.name, draft.site_url, draft.api_url, draft.adapter_type, draft.enabled ? 1 : 0, draft.sort_order || 0, stamp],
    );
  }
  return { ok: true, id };
}

async function rpcVodSourceDelete(env, id) {
  const result = await dbRun(env, "DELETE FROM vod_source_drafts WHERE id = ?", [id]);
  return { ok: Boolean(result.meta?.changes) };
}

async function rpcVodSourcePublish(env) {
  const enabled = await dbFirst(env, "SELECT COUNT(*) AS n FROM vod_source_drafts WHERE enabled = 1");
  if (!enabled?.n) return { error: "至少需要一个启用中的影视源" };
  const rows = await dbAll(env, "SELECT * FROM vod_source_drafts ORDER BY sort_order, id");
  const maxRow = await dbFirst(env, "SELECT COALESCE(MAX(version), 0) AS v FROM vod_source_versions");
  const version = (maxRow?.v || 0) + 1;
  const config = {
    schema: 1,
    version,
    sources: rows.map((d) => ({
      id: d.id, name: d.name, site_url: d.site_url, api_url: d.api_url,
      adapter_type: d.adapter_type, enabled: Boolean(d.enabled), revision: d.revision,
    })),
  };
  const text = JSON.stringify(config);
  const sha = await sha256Hex(text);
  await dbRun(
    env,
    "INSERT INTO vod_source_versions (version, config, sha256, published_at) VALUES (?, ?, ?, ?)",
    [version, text, sha, nowIso()],
  );
  return { ok: true, version, sha256: sha, config };
}

async function rpcVodSourcePublicCheck(env, version) {
  const row = await dbFirst(env, "SELECT version, config, sha256 FROM vod_source_versions ORDER BY version DESC LIMIT 1");
  if (!row) return { ret: 0, hasUpdate: false, version: 0 };
  const hasUpdate = row.version !== version;
  return {
    ret: 0,
    hasUpdate,
    version: row.version,
    sha256: row.sha256,
    config: hasUpdate ? JSON.parse(row.config) : null,
  };
}

// ---------------- 电视源数据层 ----------------

async function rpcIptvList(env) {
  const channels = await dbAll(env, "SELECT * FROM iptv_channel ORDER BY group_name, sort_order, id");
  const lines = await dbAll(env, "SELECT * FROM iptv_line ORDER BY sort_order, id");
  const byChannel = new Map();
  for (const line of lines) {
    if (!byChannel.has(line.channel_id)) byChannel.set(line.channel_id, []);
    byChannel.get(line.channel_id).push({
      id: line.id, url: line.url, sort: line.sort_order, enabled: Boolean(line.enabled), note: line.note,
    });
  }
  const latest = await dbFirst(
    env,
    `SELECT version, channels, lines, notes, status, created_at FROM iptv_version
      WHERE status = 'published' ORDER BY version DESC LIMIT 1`,
  );
  const modeRow = await dbFirst(env, "SELECT value FROM iptv_config WHERE key = 'mode'");
  return {
    channels: channels.map((c) => ({
      id: c.id, name: c.name, group: c.group_name, logo: c.logo, sort: c.sort_order,
      enabled: Boolean(c.enabled), note: c.note, lines: byChannel.get(c.id) || [],
    })),
    latest: latest
      ? {
        version: latest.version, channels: latest.channels, lines: latest.lines,
        notes: latest.notes, status: latest.status, createdAt: latest.created_at,
      }
      : null,
    mode: modeRow?.value || "auto",
  };
}

async function iptvFindOrCreateGroup(env, name) {
  const group = String(name || "").trim();
  if (!group) return;
  const row = await dbFirst(env, "SELECT id FROM iptv_group WHERE name = ?", [group]);
  if (row) return;
  const maxRow = await dbFirst(env, "SELECT COALESCE(MAX(sort), -1) AS s FROM iptv_group");
  await dbRun(env, "INSERT INTO iptv_group (name, sort, created_at) VALUES (?, ?, ?)", [
    left(group, 24), (maxRow?.s ?? -1) + 1, nowIso(),
  ]);
}

async function rpcIptvUpsertChannel(env, payload) {
  const stamp = nowIso();
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const cleanLines = lines
    .map((line) => (typeof line === "string" ? { url: line } : line || {}))
    .filter((line) => /^https?:\/\//.test(String(line.url || "")) && String(line.url).length >= 5 && String(line.url).length <= 500);

  let id = toInt(payload.id, null);
  if (id) {
    const row = await dbFirst(env, "SELECT id FROM iptv_channel WHERE id = ?", [id]);
    if (!row) return { error: "not_found" };
    await dbRun(
      env,
      `UPDATE iptv_channel SET name = ?, group_name = ?, logo = ?, sort_order = ?, enabled = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      [
        payload.name, payload.group || "其他", payload.logo || "", payload.sort || 0,
        payload.enabled === false ? 0 : 1, payload.note || "", stamp, id,
      ],
    );
    await dbRun(env, "DELETE FROM iptv_line WHERE channel_id = ?", [id]);
  } else {
    if (!cleanLines.length) return { error: "no_lines" };
    const result = await dbRun(
      env,
      `INSERT INTO iptv_channel (name, group_name, logo, sort_order, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name, payload.group || "其他", payload.logo || "", payload.sort || 0,
        payload.enabled === false ? 0 : 1, payload.note || "", stamp, stamp,
      ],
    );
    id = result.meta?.last_row_id;
  }
  for (const [index, line] of cleanLines.entries()) {
    await dbRun(
      env,
      `INSERT INTO iptv_line (channel_id, url, sort_order, enabled, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id, String(line.url), toInt(line.sort, index) ?? index,
        line.enabled === false ? 0 : 1, left(line.note || "", 200), stamp,
      ],
    );
  }
  await iptvFindOrCreateGroup(env, payload.group || "其他");
  await iptvLog(env, "save", `编辑 ${payload.name}（${cleanLines.length} 线）`);
  return { ret: 0, id };
}

async function rpcIptvDeleteChannel(env, id) {
  const row = await dbFirst(env, "SELECT name FROM iptv_channel WHERE id = ?", [id]);
  if (!row) return { error: "not_found" };
  await dbRun(env, "DELETE FROM iptv_line WHERE channel_id = ?", [id]);
  await dbRun(env, "DELETE FROM iptv_channel WHERE id = ?", [id]);
  await iptvLog(env, "delete", row.name);
  return { ret: 0 };
}

async function rpcIptvBatch(env, ops) {
  let affected = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    const id = toInt(op?.id, null);
    if (!id) continue;
    if (op.op === "enable" || op.op === "disable") {
      const result = await dbRun(env, "UPDATE iptv_channel SET enabled = ?, updated_at = ? WHERE id = ?", [
        op.op === "enable" ? 1 : 0, nowIso(), id,
      ]);
      affected += result.meta?.changes || 0;
    } else if (op.op === "delete") {
      await dbRun(env, "DELETE FROM iptv_line WHERE channel_id = ?", [id]);
      const result = await dbRun(env, "DELETE FROM iptv_channel WHERE id = ?", [id]);
      affected += result.meta?.changes || 0;
    } else if (op.op === "move") {
      if (op.sort !== undefined) {
        const result = await dbRun(env, "UPDATE iptv_channel SET sort_order = MAX(?, 0), updated_at = ? WHERE id = ?", [
          toInt(op.sort, 0), nowIso(), id,
        ]);
        affected += result.meta?.changes || 0;
      } else if (op.delta !== undefined) {
        const result = await dbRun(
          env,
          "UPDATE iptv_channel SET sort_order = MAX(sort_order + ?, 0), updated_at = ? WHERE id = ?",
          [toInt(op.delta, 0), nowIso(), id],
        );
        affected += result.meta?.changes || 0;
      }
    }
  }
  await iptvLog(env, "batch", `${affected} 项`);
  return { ret: 0, affected };
}

async function rpcIptvImport(env, channels, mode) {
  const list = Array.isArray(channels) ? channels : [];
  if (!list.length) return { error: "empty" };
  if (list.length > 3000) return { error: "too_many" };
  if (mode === "replace") {
    await dbRun(env, "DELETE FROM iptv_line");
    await dbRun(env, "DELETE FROM iptv_channel");
  }
  let added = 0;
  let updated = 0;
  let lineCount = 0;
  const stamp = nowIso();
  for (const channel of list) {
    const name = String(channel?.name || "").trim();
    if (!name) continue;
    const group = String(channel?.group || "").trim() || "其他";
    const logo = String(channel?.logo || "").trim();
    const rawLines = Array.isArray(channel?.lines) ? channel.lines : [];
    const urls = [];
    for (const item of rawLines) {
      const url = typeof item === "string" ? item : String(item?.url || "");
      if (/^https?:\/\//.test(url) && url.length >= 5 && url.length <= 500) urls.push(url);
    }
    const existing = await dbFirst(env, "SELECT id, group_name, logo FROM iptv_channel WHERE name = ? LIMIT 1", [name]);
    let id;
    if (existing) {
      id = existing.id;
      await dbRun(
        env,
        "UPDATE iptv_channel SET group_name = ?, logo = ?, updated_at = ? WHERE id = ?",
        [group || existing.group_name, logo || existing.logo, stamp, id],
      );
      updated += 1;
    } else {
      const result = await dbRun(
        env,
        `INSERT INTO iptv_channel (name, group_name, logo, sort_order, enabled, note, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, '', ?, ?)`,
        [name, group, logo, stamp, stamp],
      );
      id = result.meta?.last_row_id;
      added += 1;
    }
    if (mode === "replace") await dbRun(env, "DELETE FROM iptv_line WHERE channel_id = ?", [id]);
    if (urls.length) {
      const seen = new Set();
      const rows = [];
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        rows.push([id, url, 0, 1, "", stamp]);
      }
      if (rows.length) {
        await dbBatch(env, rows.map((row) => [
          "INSERT INTO iptv_line (channel_id, url, sort_order, enabled, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          row,
        ]));
        lineCount += rows.length;
      }
    }
  }
  await iptvLog(env, "import", `${mode} 模式：新增 ${added} 更新 ${updated} 线路 ${lineCount}`);
  return { ret: 0, added, updated, lines: lineCount };
}

async function rpcIptvExport(env) {
  const channels = await dbAll(
    env,
    "SELECT * FROM iptv_channel WHERE enabled = 1 ORDER BY group_name, sort_order, id",
  );
  const lines = await dbAll(env, "SELECT channel_id, url FROM iptv_line WHERE enabled = 1 ORDER BY sort_order, id");
  const byChannel = new Map();
  for (const line of lines) {
    if (!byChannel.has(line.channel_id)) byChannel.set(line.channel_id, []);
    byChannel.get(line.channel_id).push(line.url);
  }
  return {
    channels: channels.map((c) => ({
      name: c.name, group: c.group_name, logo: c.logo, lines: byChannel.get(c.id) || [],
    })),
  };
}

async function rpcIptvPublishBegin(env, notes) {
  const row = await dbFirst(env, "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM iptv_version");
  const version = row?.v || 1;
  await dbRun(
    env,
    "INSERT INTO iptv_version (version, notes, status, created_at) VALUES (?, ?, 'pending', ?)",
    [version, notes || "", nowIso()],
  );
  return { ret: 0, version };
}

async function rpcIptvPublishConfirm(env, payload) {
  const row = await dbFirst(env, "SELECT notes FROM iptv_version WHERE version = ?", [payload.version]);
  if (!row) return { error: "not_found" };
  await dbRun(
    env,
    "UPDATE iptv_version SET status = 'offline' WHERE status = 'published' AND version <> ?",
    [payload.version],
  );
  await dbRun(
    env,
    `UPDATE iptv_version SET object_key = ?, sha256 = ?, file_size = ?, channels = ?, lines = ?, status = ?
      WHERE version = ?`,
    [
      payload.object_key || "", payload.sha256 || "", payload.file_size || 0,
      payload.channels || 0, payload.lines || 0, payload.status || "published", payload.version,
    ],
  );
  if (payload.status !== "failed") {
    await iptvLog(
      env, "publish",
      `v${payload.version}（${payload.channels || 0} 频道 ${payload.lines || 0} 线）${row.notes || ""}`,
    );
  }
  return { ret: 0 };
}

async function rpcIptvVersions(env, limit) {
  const rows = await dbAll(
    env,
    `SELECT version, object_key, file_size, sha256, channels, lines, notes, status, created_at
       FROM iptv_version ORDER BY version DESC LIMIT ?`,
    [limit],
  );
  return { rows };
}

async function rpcIptvRollbackBegin(env, target) {
  const src = await dbFirst(env, "SELECT * FROM iptv_version WHERE version = ?", [target]);
  if (!src) return { error: "not_found" };
  const row = await dbFirst(env, "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM iptv_version");
  const version = row?.v || 1;
  await dbRun(
    env,
    `INSERT INTO iptv_version (version, object_key, file_size, sha256, channels, lines, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      version, src.object_key, src.file_size, src.sha256, src.channels, src.lines,
      `回滚自 v${target}（${src.notes || ""}）`, nowIso(),
    ],
  );
  await iptvLog(env, "rollback", `v${version} ← v${target}`);
  return { ret: 0, version };
}

async function rpcIptvLogs(env, limit) {
  const rows = await dbAll(
    env,
    "SELECT id, action, detail, created_at FROM iptv_admin_log ORDER BY id DESC LIMIT ?",
    [limit],
  );
  return { rows };
}

async function rpcIptvGetMode(env) {
  const row = await dbFirst(env, "SELECT value FROM iptv_config WHERE key = 'mode'");
  return { ret: 0, mode: row?.value || "auto" };
}

async function rpcIptvSetMode(env, mode) {
  await dbRun(
    env,
    `INSERT INTO iptv_config (key, value, updated_at) VALUES ('mode', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [mode, nowIso()],
  );
  await iptvLog(env, "mode", mode);
  return { ret: 0, mode };
}

async function rpcIptvGroupList(env) {
  const rows = await dbAll(
    env,
    `SELECT g.id, g.name, g.sort,
            (SELECT COUNT(*) FROM iptv_channel c WHERE c.group_name = g.name) AS channels,
            (SELECT COUNT(*) FROM iptv_channel c WHERE c.group_name = g.name AND c.enabled = 1) AS enabled
       FROM iptv_group g ORDER BY g.sort, g.id`,
  );
  return rows;
}

async function rpcIptvGroupCreate(env, name) {
  const clean = String(name || "").trim();
  if (!clean || clean.length > 24) return { error: "bad_name" };
  if (clean === "未分组") return { error: "reserved" };
  await iptvFindOrCreateGroup(env, clean);
  await iptvLog(env, "group_create", clean);
  return { ret: 0, name: clean };
}

async function rpcIptvGroupRename(env, id, name) {
  const clean = String(name || "").trim();
  if (!clean || clean.length > 24) return { error: "bad_name" };
  if (clean === "未分组") return { error: "reserved" };
  const row = await dbFirst(env, "SELECT name FROM iptv_group WHERE id = ?", [id]);
  if (!row) return { error: "not_found" };
  if (row.name === "未分组") return { error: "reserved" };
  await dbRun(env, "UPDATE iptv_group SET name = ? WHERE id = ?", [clean, id]);
  await dbRun(env, "UPDATE iptv_channel SET group_name = ?, updated_at = ? WHERE group_name = ?", [
    clean, nowIso(), row.name,
  ]);
  await iptvLog(env, "group_rename", `${row.name} → ${clean}`);
  return { ret: 0, name: clean };
}

async function rpcIptvGroupDelete(env, id, moveTo) {
  const row = await dbFirst(env, "SELECT name FROM iptv_group WHERE id = ?", [id]);
  if (!row) return { error: "not_found" };
  const target = String(moveTo || "未分组").trim() || "未分组";
  if (target === row.name) return { error: "bad_move_to" };
  const countRow = await dbFirst(env, "SELECT COUNT(*) AS n FROM iptv_channel WHERE group_name = ?", [row.name]);
  const moved = countRow?.n || 0;
  if (moved > 0) {
    if (target !== "未分组") {
      const targetRow = await dbFirst(env, "SELECT id FROM iptv_group WHERE name = ?", [target]);
      if (!targetRow) return { error: "bad_move_to" };
    } else {
      await iptvFindOrCreateGroup(env, "未分组");
    }
    await dbRun(env, "UPDATE iptv_channel SET group_name = ?, updated_at = ? WHERE group_name = ?", [
      target, nowIso(), row.name,
    ]);
  }
  await dbRun(env, "DELETE FROM iptv_group WHERE id = ?", [id]);
  await iptvLog(env, "group_delete", `${row.name}（${moved} 个频道移入 ${target}）`);
  return { ret: 0, moved, move_to: target };
}

async function rpcIptvGroupMove(env, id, delta) {
  const result = await dbRun(env, "UPDATE iptv_group SET sort = MAX(sort + ?, 0) WHERE id = ?", [delta || 0, id]);
  if (!result.meta?.changes) return { error: "not_found" };
  return { ret: 0 };
}

// ---------------- M3U 解析 / 序列化 ----------------

function parseM3uToChannels(text) {
  const out = [];
  const byKey = new Map();
  let name = "";
  let group = "";
  let logo = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF")) {
      const comma = line.lastIndexOf(",");
      name = comma >= 0 ? line.slice(comma + 1).trim() : "";
      const logoMatch = /tvg-logo="([^"]*)"/.exec(line);
      logo = logoMatch ? logoMatch[1] : "";
      const groupMatch = /group-title="([^"]*)"/.exec(line);
      group = groupMatch ? groupMatch[1].trim() : "";
    } else if (/^https?:\/\//.test(line)) {
      if (!name) continue;
      const key = `${group}|${name}`;
      let channel = byKey.get(key);
      if (!channel) {
        channel = { name, group: group || "其他", logo, lines: [] };
        byKey.set(key, channel);
        out.push(channel);
      }
      if (channel.lines.length < 24 && !channel.lines.includes(line)) channel.lines.push(line);
      name = "";
      group = "";
      logo = "";
    }
  }
  return out;
}

function serializeM3u(channels) {
  const parts = ["#EXTM3U"];
  for (const channel of channels || []) {
    const logo = String(channel.logo || "").replace(/"/g, "");
    const group = String(channel.group || "其他").replace(/"/g, "");
    for (const url of channel.lines || []) {
      parts.push(`#EXTINF:-1 tvg-logo="${logo}" group-title="${group}",${channel.name}`);
      parts.push(url);
    }
  }
  return `${parts.join("\n")}\n`;
}

function assertPublicHttps(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("URL 不合法");
  }
  if (parsed.protocol !== "https:") throw new Error("仅允许 https URL");
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost"
    || host === "0.0.0.0"
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith(".local")
    || host.endsWith(".internal")
  ) {
    throw new Error("目标不是公网地址");
  }
  return parsed;
}

async function fetchTextFollow(url, maxBytes, maxHops = 3) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    assertPublicHttps(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 OptimalTV-admin" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} 无 Location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("内容过大");
    return decoder.decode(buffer);
  }
  throw new Error("重定向次数过多");
}

/** 单线测活：清单可拉 + m3u8 首分片 Range 探测（与 iptv-rebuild 云函数同语义）。 */
async function probeLine(url, timeoutMs = 6000) {
  const started = Date.now();
  try {
    const head = await fetchWithTimeout(url, { headers: { "user-agent": "Mozilla/5.0 OptimalTV-probe" } }, timeoutMs);
    if (!head.ok) return null;
    const body = decoder.decode(await readBodyLimited(head, 4096));
    if (body.slice(0, 64).includes("#EXTM3U")) {
      const segment = body.split(/\r?\n/).map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      if (segment) {
        const absolute = new URL(segment, url).toString();
        const part = await fetchWithTimeout(
          absolute,
          { headers: { "user-agent": "Mozilla/5.0 OptimalTV-probe", range: "bytes=0-8192" } },
          timeoutMs,
        );
        if (!part.ok && part.status !== 206) return null;
      }
    }
    return Date.now() - started;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

async function readBodyLimited(response, maxBytes) {
  const buffer = await response.arrayBuffer();
  return buffer.byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length).fill(null);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function writeIptvMeta(env, mode, extra) {
  const meta = { ret: 0, mode, updatedAt: nowIso(), ...extra };
  await putObject(env, IPTV_KEY_META, JSON.stringify(meta), "application/json");
}

// ---------------- zip 结构校验（读中央目录，防误传任意 zip） ----------------

function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const length = view.byteLength;
  const scanStart = Math.max(0, length - 66_000);
  let eocd = -1;
  for (let i = length - 22; i >= scanStart; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("zip 中央目录损坏");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameBytes = new Uint8Array(bytes.buffer || bytes, (bytes.byteOffset || 0) + offset + 46, nameLength);
    names.push(decoder.decode(nameBytes));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function validateHotupdateZip(bytes) {
  let names;
  try {
    names = listZipEntries(bytes);
  } catch {
    return { error: "不是有效的 zip 文件" };
  }
  const missing = HU_REQUIRED_ENTRIES.filter((entry) => !names.includes(entry));
  if (missing.length) return { error: `zip 缺少必备条目: ${missing.join(", ")}` };
  if (!names.some((n) => n.startsWith("www/"))) return { error: "zip 缺少 www/ 资源目录" };
  return { ok: true, names };
}

// ---------------- 卡密授权协议 v2（设备端） ----------------

async function logActivate(env, code, device, ip, result) {
  await dbRun(
    env,
    "INSERT INTO activate_log (code, device_id, ip, result, at) VALUES (?, ?, ?, ?, ?)",
    [code || null, device || null, ip || null, left(result, 64), nowIso()],
  );
}

function licenseResponse(row, serverNow) {
  return {
    ret: 0,
    ticket: JSON.parse(row.ticket),
    licenseCode: row.code,
    activatedAt: row.activated_at,
    expireAt: row.expire_at,
    serverNow,
  };
}

async function activateCode(env, payload, ip) {
  const code = String(payload.code || "").trim().toUpperCase();
  const device = String(payload.deviceId || "").trim().toLowerCase();
  const action = String(payload.action || "").trim().toLowerCase();
  const currentCode = String(payload.currentCode || "").trim().toUpperCase();
  const nowMs = Date.now();
  const serverNow = isoFrom(nowMs);

  if (toInt(payload.protocol, 0) !== 2) {
    await logActivate(env, code, device, ip, "protocol_upgrade_required");
    return { ret: 426, msg: "upgrade_required" };
  }
  if (!CODE_RE.test(code) || !DEVICE_RE.test(device) || !["activate", "verify", "renew"].includes(action)) {
    await logActivate(env, code, device, ip, "bad_request");
    return { ret: 400, msg: "bad_request" };
  }

  if (action === "renew") {
    if (!CODE_RE.test(currentCode) || currentCode === code) {
      return { ret: 400, msg: "bad_current_code" };
    }
    const current = await dbFirst(env, "SELECT * FROM licenses WHERE code = ?", [currentCode]);
    const renewal = await dbFirst(env, "SELECT * FROM licenses WHERE code = ?", [code]);
    if (!current || !renewal) return { ret: 404, msg: "not_found" };
    if (current.status === "banned" || renewal.status === "banned") return { ret: 403, msg: "banned" };
    const devices = JSON.parse(current.devices || "[]");
    if (!current.activated_at || !devices.includes(device)) return { ret: 406, msg: "device_unbound" };
    if (renewal.redeemed_at || renewal.redeemed_to) return { ret: 409, msg: "already_redeemed" };
    if (renewal.activated_at || JSON.parse(renewal.devices || "[]").length > 0) {
      return { ret: 409, msg: "renewal_card_already_used" };
    }
    if (!current.expire_at) return { ret: 410, msg: "already_lifetime" };

    const currentExpire = parseTime(current.expire_at) ?? nowMs;
    const nextExpire = renewal.days === 0
      ? null
      : isoFrom(Math.max(currentExpire, nowMs) + renewal.days * 86_400_000);
    const stamp = nowIso();
    await dbBatch(env, [
      ["UPDATE licenses SET expire_at = ?, updated_at = ? WHERE code = ?", [nextExpire, stamp, currentCode]],
      ["UPDATE licenses SET redeemed_at = ?, redeemed_to = ?, updated_at = ? WHERE code = ?", [
        stamp, currentCode, stamp, code,
      ]],
    ]);
    await logActivate(env, currentCode, device, ip, `renew_ok:${code}`);
    const updated = { ...current, expire_at: nextExpire };
    return licenseResponse(updated, serverNow);
  }

  const card = await dbFirst(env, "SELECT * FROM licenses WHERE code = ?", [code]);
  if (!card) {
    await logActivate(env, code, device, ip, "not_found");
    return { ret: 404, msg: "not_found" };
  }
  if (card.status === "banned") {
    await logActivate(env, code, device, ip, "banned");
    return { ret: 403, msg: "banned" };
  }
  if (card.redeemed_at || card.redeemed_to) {
    await logActivate(env, code, device, ip, "already_redeemed");
    return { ret: 409, msg: "already_redeemed" };
  }

  const devices = JSON.parse(card.devices || "[]");
  if (action === "verify") {
    if (!card.activated_at) {
      await logActivate(env, code, device, ip, "not_activated");
      return { ret: 404, msg: "not_activated" };
    }
    if (card.expire_at && (parseTime(card.expire_at) ?? 0) <= nowMs) {
      await logActivate(env, code, device, ip, "expired");
      return { ret: 405, msg: "expired", expireAt: card.expire_at, serverNow };
    }
    if (!devices.includes(device)) {
      await logActivate(env, code, device, ip, "device_unbound");
      return { ret: 406, msg: "device_unbound" };
    }
    await logActivate(env, code, device, ip, "verify_ok");
    return licenseResponse(card, serverNow);
  }

  let activatedAt = card.activated_at;
  let expireAt = card.expire_at;
  if (!activatedAt) {
    activatedAt = serverNow;
    expireAt = card.days === 0 ? null : isoFrom(nowMs + card.days * 86_400_000);
  } else if (expireAt && (parseTime(expireAt) ?? 0) <= nowMs) {
    await logActivate(env, code, device, ip, "expired");
    return { ret: 405, msg: "expired", expireAt, serverNow };
  }

  const nextDevices = [...devices];
  if (!nextDevices.includes(device)) {
    if (nextDevices.length >= (card.max_dev ?? 2)) {
      await logActivate(env, code, device, ip, "device_full");
      return { ret: 402, msg: "device_full" };
    }
    nextDevices.push(device);
  }
  const stamp = nowIso();
  await dbRun(
    env,
    `UPDATE licenses SET activated_at = ?, expire_at = ?, devices = ?, sold_at = COALESCE(sold_at, ?), updated_at = ?
      WHERE code = ?`,
    [activatedAt, expireAt, JSON.stringify(nextDevices), stamp, stamp, code],
  );
  await logActivate(env, code, device, ip, "activate_ok");
  return licenseResponse({ ...card, activated_at: activatedAt, expire_at: expireAt, devices: JSON.stringify(nextDevices) }, serverNow);
}

// ---------------- 电视源重建（自动模式 / 外部定时器） ----------------

/**
 * 上游聚合源 → 测活剔死 → 写 latest。
 * 托管模式（mode=manual）下自动任务必须跳过：手动发布的列表不能被每日推流覆盖
 * （与旧 iptv-rebuild 云函数读 version.json 的语义一致）；后台「自动重建」按钮走 force=true。
 */
async function rebuildIptv(env, { mode = "auto", budgetMs = 0, maxProbes = 0, force = false } = {}) {
  const budget = budgetMs || toInt(env.OTV_IPTV_BUDGET_MS, 45_000) || 45_000;
  const probeLimit = maxProbes || toInt(env.OTV_IPTV_PROBES, 60) || 60;
  const currentMode = (await rpcIptvGetMode(env)).mode || "auto";
  if (!force && currentMode === "manual") {
    return { ret: 0, skipped: true, reason: "manual_mode", mode: currentMode };
  }
  const deadline = Date.now() + budget;
  let channels = [];
  let sourceUsed = "";
  for (const upstream of IPTV_UPSTREAMS) {
    try {
      const raw = await fetchTextFollow(upstream, IPTV_FETCH_MAX, 3);
      if (!raw.includes("#EXTM3U")) continue;
      const parsed = parseM3uToChannels(raw);
      if (parsed.length) {
        channels = parsed;
        sourceUsed = upstream;
        break;
      }
    } catch {
      /* 换下一个上游 */
    }
  }
  if (!channels.length) return { error: "上游聚合源全部不可达" };

  // 广度优先取每条频道的前若干线路，控制子请求总数
  const candidates = [];
  for (let round = 0; round < 8 && candidates.length < probeLimit; round += 1) {
    for (const channel of channels) {
      if (channel.lines.length > round && candidates.length < probeLimit) candidates.push(channel.lines[round]);
    }
  }
  const unique = [...new Set(candidates)];
  const scores = new Map();
  await mapWithConcurrency(unique, 12, async (url) => {
    if (Date.now() > deadline) return null;
    const ms = await probeLine(url, 6000);
    scores.set(url, ms);
    return ms;
  });

  const usable = [];
  let alive = 0;
  for (const channel of channels) {
    const lines = channel.lines.filter((url) => scores.get(url) != null);
    if (!lines.length) continue;
    lines.sort((a, b) => scores.get(a) - scores.get(b));
    alive += lines.length;
    usable.push({ ...channel, lines: lines.slice(0, 8) });
  }
  if (!usable.length) return { error: "测活后无可用频道（上游源质量异常）" };

  const m3u = serializeM3u(usable);
  const lineCount = usable.reduce((sum, c) => sum + c.lines.length, 0);
  const sha = await sha256Hex(m3u);
  const begin = await rpcIptvPublishBegin(env, "自动重建（云端触发）");
  const version = begin.version;
  const key = `iptv/iptv-v${version}.m3u`;
  try {
    await putObject(env, key, m3u, "audio/x-mpegurl");
    await putObject(env, IPTV_KEY_LATEST, m3u, "audio/x-mpegurl");
    await writeIptvMeta(env, mode, {
      version, channels: usable.length, lines: lineCount, notes: "auto-rebuild", source: "cloud",
    });
  } catch (error) {
    await rpcIptvPublishConfirm(env, {
      version, object_key: key, sha256: sha, file_size: m3u.length,
      channels: usable.length, lines: lineCount, status: "failed",
    });
    return { error: `对象上传失败: ${error.message || error}` };
  }
  await rpcIptvPublishConfirm(env, {
    version, object_key: key, sha256: sha, file_size: m3u.length,
    channels: usable.length, lines: lineCount, status: "published",
  });
  return {
    ret: 0, version, channels: usable.length, lines: lineCount,
    probed: scores.size, alive, upstream: sourceUsed, elapsedMs: budget - Math.max(deadline - Date.now(), 0),
  };
}

// ---------------- 后台管理端处理函数（对齐 admin_server.py 的返回形状） ----------------

async function huAllocVersion(env) {
  const row = await dbFirst(env, "SELECT MAX(hot_version_code) AS v FROM hotupdate_pkg");
  return (row?.v || 0) + 1;
}

function huParseMeta(query) {
  const status = query.get("status") || "published";
  if (!["published", "offline", "scheduled"].includes(status)) throw new Error("bad_status");
  let publishAt = null;
  if (status === "scheduled") {
    const raw = (query.get("publishAt") || "").trim();
    const parsed = parseTime(raw);
    if (!parsed) throw new Error("定时发布时间格式不合法");
    if (parsed <= Date.now()) throw new Error("定时发布时间必须晚于当前时间");
    publishAt = isoFrom(parsed);
  }
  return {
    status,
    publishAt,
    name: (query.get("name") || "").trim(),
    notes: (query.get("notes") || "").trim(),
    force: query.get("force") === "true",
  };
}

async function huPublish(env, raw, version, meta) {
  const bytes = new Uint8Array(raw);
  if (!bytes.byteLength || bytes.byteLength > HU_MAX_BYTES) {
    return { error: `zip 大小不合法（1B–${HU_MAX_BYTES / 1048576}MB）` };
  }
  const check = validateHotupdateZip(bytes);
  if (check.error) return { error: check.error };

  const sha = await sha256Hex(bytes);
  const key = `backend-hu${version}.zip`;
  try {
    await putObject(env, key, bytes, "application/zip");
  } catch (error) {
    return { error: `对象上传失败: ${error.message || error}` };
  }
  try {
    await rpcHuUpsert(env, {
      hot_version_code: version,
      hot_version_name: meta.name,
      apk_min_version: 0,
      apk_max_version: 2147483647,
      object_key: key,
      file_size: bytes.byteLength,
      sha256: sha,
      notes: meta.notes,
      force_apply: meta.force,
      status: meta.status,
      publish_at: meta.publishAt,
    });
  } catch (error) {
    return { error: `元数据入库失败（对象已上传，可在同版本号重试）: ${error.message || error}` };
  }
  return {
    ok: true, version, size: bytes.byteLength, sha256: sha, key, status: meta.status,
  };
}

async function huUploadDirect(env, query, raw) {
  let version = toInt(query.get("version"), 0) ?? 0;
  let meta;
  try {
    if (version < 1) version = await huAllocVersion(env);
    meta = huParseMeta(query);
  } catch (error) {
    return { error: error.message };
  }
  return huPublish(env, raw, version, meta);
}

async function huUploadChunk(env, query, raw) {
  const uid = query.get("uid") || "";
  const seq = toInt(query.get("seq"), -1);
  if (!HU_UPLOAD_UID_RE.test(uid)) return { error: "bad_uid" };
  if (seq < 0 || seq > 2047) return { error: "bad_seq" };
  if (!raw.byteLength || raw.byteLength > HU_CHUNK_MAX) {
    return { error: `分片大小不合法（1B–${HU_CHUNK_MAX / 1048576}MB）` };
  }
  try {
    await putObject(env, `hu-uploads/${uid}/part-${String(seq).padStart(4, "0")}`, raw, "application/octet-stream");
  } catch (error) {
    return { error: `分片暂存失败: ${error.message || error}` };
  }
  return { ok: true, seq, size: raw.byteLength };
}

async function huUploadCommit(env, query) {
  const uid = query.get("uid") || "";
  const total = toInt(query.get("total"), 0) ?? 0;
  const size = toInt(query.get("size"), 0) ?? 0;
  if (!HU_UPLOAD_UID_RE.test(uid)) return { error: "bad_uid" };
  if (total < 1 || total > 2048 || size < 1 || size > HU_MAX_BYTES) return { error: "bad_total_or_size" };
  if (size > HU_BUFFER_MAX) {
    return { error: `该环境单次重组上限 ${HU_BUFFER_MAX / 1048576}MB（当前 ${(size / 1048576).toFixed(1)}MB）：请走本地补货流程或拆分包体` };
  }
  const keys = [];
  const parts = [];
  for (let i = 0; i < total; i += 1) {
    const key = `hu-uploads/${uid}/part-${String(i).padStart(4, "0")}`;
    keys.push(key);
    const part = await getObjectBytes(env, key, HU_CHUNK_MAX + 1);
    if (!part) return { error: `缺少第 ${i + 1} 个分片——请重新上传` };
    parts.push(new Uint8Array(part));
  }
  const assembled = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    assembled.set(part, offset);
    offset += part.byteLength;
  }
  if (assembled.byteLength !== size) {
    for (const key of keys) await deleteObject(env, key);
    return { error: `重组尺寸不符（期望 ${size}，实得 ${assembled.byteLength}）——请重新上传` };
  }
  let version;
  let meta;
  try {
    version = await huAllocVersion(env);
    meta = huParseMeta(query);
  } catch (error) {
    for (const key of keys) await deleteObject(env, key);
    return { error: error.message };
  }
  const out = await huPublish(env, assembled, version, meta);
  for (const key of keys) await deleteObject(env, key);
  return out;
}

async function iptvPublishLatest(env, { notes }) {
  const exported = await rpcIptvExport(env);
  const usable = (exported.channels || []).filter((channel) => channel.lines?.length);
  if (!usable.length) return { error: "频道表为空（先导入或添加频道）" };
  const m3u = serializeM3u(usable);
  const lineCount = usable.reduce((sum, c) => sum + c.lines.length, 0);
  const sha = await sha256Hex(m3u);
  const begin = await rpcIptvPublishBegin(env, notes);
  const version = begin.version;
  if (!version) return { error: `发布登记失败: ${JSON.stringify(begin)}` };
  const key = `iptv/iptv-v${version}.m3u`;
  try {
    await putObject(env, key, m3u, "audio/x-mpegurl");
    await putObject(env, IPTV_KEY_LATEST, m3u, "audio/x-mpegurl");
    await writeIptvMeta(env, "manual", {
      version, channels: usable.length, lines: lineCount, notes, source: "admin",
    });
  } catch (error) {
    await rpcIptvPublishConfirm(env, {
      version, object_key: key, sha256: sha, file_size: m3u.length,
      channels: usable.length, lines: lineCount, status: "failed",
    });
    return { error: `对象上传失败: ${error.message || error}` };
  }
  await rpcIptvSetMode(env, "manual");
  const out = await rpcIptvPublishConfirm(env, {
    version, object_key: key, sha256: sha, file_size: m3u.length,
    channels: usable.length, lines: lineCount, status: "published",
  });
  if (out.ret !== 0) return out;
  return {
    ret: 0, version, channels: usable.length, lines: lineCount, sha256: sha, size: m3u.length,
  };
}

async function iptvRollback(env, target) {
  const begin = await rpcIptvRollbackBegin(env, target);
  if (!begin.version) return { error: `回滚登记失败: ${JSON.stringify(begin)}` };
  const version = begin.version;
  const sourceKey = `iptv/iptv-v${target}.m3u`;
  let raw;
  try {
    raw = await getObjectBytes(env, sourceKey, 32 * 1024 * 1024);
    if (!raw) throw new Error(`归档对象 ${sourceKey} 不存在`);
    await putObject(env, IPTV_KEY_LATEST, new Uint8Array(raw), "audio/x-mpegurl");
    const versionRow = await dbFirst(env, "SELECT * FROM iptv_version WHERE version = ?", [target]);
    await writeIptvMeta(env, "manual", {
      version, rollbackFrom: target, source: "admin",
    });
    await rpcIptvSetMode(env, "manual");
    const out = await rpcIptvPublishConfirm(env, {
      version,
      object_key: sourceKey,
      sha256: versionRow?.sha256 || "",
      file_size: versionRow?.file_size || raw.byteLength,
      channels: versionRow?.channels || 0,
      lines: versionRow?.lines || 0,
      status: "published",
    });
    if (out.ret !== 0) return out;
    return { ret: 0, version, rollbackFrom: target };
  } catch (error) {
    return { error: `对象复制失败: ${error.message || error}` };
  }
}

async function iptvLatestProbe(env, request) {
  try {
    const raw = await getObjectBytes(env, IPTV_KEY_LATEST, 2 * 1024 * 1024);
    if (!raw) return { error: "latest 对象不存在（从未发布过）" };
    const text = decoder.decode(raw);
    const channels = parseM3uToChannels(text);
    const managed = channels.some((c) => c.group !== "其他");
    let meta = {};
    try {
      const metaRaw = await getObjectBytes(env, IPTV_KEY_META, 65536);
      if (metaRaw) meta = JSON.parse(decoder.decode(metaRaw));
    } catch {
      meta = {};
    }
    return {
      channels: channels.length,
      lines: channels.reduce((sum, c) => sum + c.lines.length, 0),
      managed,
      mode: meta.mode,
      updatedAt: meta.updatedAt,
      head: text.slice(0, 400),
      url: objectUrl(request, IPTV_KEY_LATEST),
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

const VOD_ADAPTERS = ["hhkan", "macms_json", "macms_xml"];

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[\s·:：\-—_（）()【】\[\]]/g, "");
}

function firstMaccmsPreview(raw) {
  for (const group of String(raw?.vod_play_url || "").split("$$$")) {
    for (const episode of group.split("#")) {
      const value = episode.split("$").pop().trim();
      if (/^https?:\/\//.test(value)) return value;
    }
  }
  return "";
}

function vodGrade(score) {
  return score >= 80 ? "优秀" : score >= 60 ? "良好" : score >= 40 ? "一般" : "不可用";
}

async function maccmsSearch(source, title) {
  const base = String(source.api_url || "").replace(/\/$/, "");
  if (!base) throw new Error("该源未配置 API 地址");
  const url = `${base}?ac=detail&wd=${encodeURIComponent(title)}`;
  const response = await fetchWithTimeout(url, { headers: { "user-agent": "Mozilla/5.0 OptimalTV-admin" } }, 12_000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (source.adapter_type === "macms_xml" || text.trim().startsWith("<")) {
    const items = [];
    const blocks = text.split(/<video>/i).slice(1);
    for (const block of blocks) {
      const pick = (tag) => {
        const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(block);
        return match ? match[1].trim() : "";
      };
      items.push({ vod_name: pick("name"), vod_year: pick("year"), vod_play_url: pick("dl/-dd") });
    }
    return items;
  }
  const data = JSON.parse(text);
  return Array.isArray(data?.list) ? data.list : [];
}

async function vodSourceTest(env, payload) {
  const title = String(payload.title || "").trim().slice(0, 120);
  if (!title) return { error: "请输入影片名称" };
  const year = String(payload.year || "").trim().slice(0, 4);
  const source = payload.source && typeof payload.source === "object" ? payload.source : payload;
  const started = Date.now();
  let match = 0;
  let preview = "";
  let detail = "";
  try {
    if (String(source.adapter_type || "").startsWith("macms")) {
      const items = await maccmsSearch(source, title);
      const target = normalizeTitle(title);
      let best = null;
      for (const item of items) {
        const name = normalizeTitle(item.vod_name || item.name);
        if (!name) continue;
        const base = name === target ? 100 : name.includes(target) || target.includes(name) ? 80 : 0;
        const itemYear = String(item.vod_year || "");
        const score = base > 0 ? Math.min(100, base + (year && itemYear === year ? 0 : -5)) : 0;
        if (!best || score > best.score) best = { score, item };
      }
      if (best) {
        match = best.score;
        preview = firstMaccmsPreview(best.item);
      }
      detail = `命中 ${items.length} 条`;
    } else {
      const site = String(source.site_url || "").replace(/\/$/, "");
      if (!site) throw new Error("该源未配置站点地址");
      const response = await fetchWithTimeout(
        `${site}/search?k=${encodeURIComponent(title)}&p=1`,
        { headers: { "user-agent": "Mozilla/5.0 OptimalTV-admin" } },
        12_000,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const hits = (html.match(/\/detail\/\d+\.html/g) || []).length;
      match = hits ? 90 : 0;
      detail = `页面命中 ${hits} 个详情链接（云端不做端侧解析，播放验证在设备端完成）`;
    }
  } catch (error) {
    return {
      grade: "不可用", score: 0,
      summary: String(error.message || error).slice(0, 160),
      matched: false, preview_url: "",
    };
  }
  const elapsed = Date.now() - started;
  const speed = elapsed <= 1000 ? 100 : elapsed <= 3000 ? 80 : elapsed <= 6000 ? 55 : 30;
  const score = preview ? Math.round(match * 0.6 + speed * 0.4) : Math.min(39, Math.round(match * 0.4));
  return {
    grade: vodGrade(score),
    score,
    summary: `${preview ? "可试看" : "未取得可播放地址"}，匹配度 ${match}，响应 ${elapsed}ms${detail ? ` · ${detail}` : ""}`,
    matched: match >= 60,
    preview_url: preview,
  };
}

async function vodSourceDiscover(env, siteUrl) {
  const site = String(siteUrl || "").trim();
  assertPublicHttps(site);
  const response = await fetchWithTimeout(site, { headers: { "user-agent": "Mozilla/5.0 OptimalTV-admin" } }, 12_000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const origin = new URL(site).origin;
  const candidates = [...html.matchAll(/["'](https?:\/\/[^"']*?\/api\.php\/provide\/vod\/?)["']/gi)]
    .map((m) => m[1]);
  const apiMatch = html.match(/["'](https?:\/\/[^"']*?\/api\.php\/provide\/vod\/?)["']/i);
  const apiUrl = apiMatch ? apiMatch[1] : "";
  const adapter = apiUrl ? (apiUrl.includes("xml") ? "macms_xml" : "macms_json") : "hhkan";
  const name = (html.match(/<title>([^<]{1,60})<\/title>/i)?.[1] || new URL(site).hostname).trim();
  return {
    ok: true,
    source: {
      id: null,
      name: name.slice(0, 40),
      site_url: site,
      api_url: apiUrl || `${origin}/api.php/provide/vod/`,
      adapter_type: adapter,
      enabled: true,
      revision: 1,
      candidates: candidates.length,
    },
  };
}

/** 迁移导入：把 CloudBase 导出快照写进新库（幂等，按主键 upsert；只由登录会话调用）。 */
async function importSnapshot(env, snapshot) {
  const stamp = nowIso();
  const stats = { licenses: 0, activateLog: 0, hotupdatePkg: 0, hotupdateLog: 0, channels: 0, lines: 0, versions: 0, groups: 0, vod: 0 };
  const chunk = async (rows, size, toStatement) => {
    for (let i = 0; i < rows.length; i += size) {
      const slice = rows.slice(i, i + size);
      await dbBatch(env, slice.map(toStatement));
    }
  };

  const licenses = Array.isArray(snapshot.licenses) ? snapshot.licenses : [];
  await chunk(licenses, 40, (row) => [
    `INSERT INTO licenses (code, plan, days, status, max_dev, devices, note, ticket,
        sold_at, activated_at, expire_at, redeemed_at, redeemed_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       plan = excluded.plan, days = excluded.days, status = excluded.status,
       max_dev = excluded.max_dev, devices = excluded.devices, note = excluded.note,
       ticket = excluded.ticket, sold_at = excluded.sold_at, activated_at = excluded.activated_at,
       expire_at = excluded.expire_at, redeemed_at = excluded.redeemed_at,
       redeemed_to = excluded.redeemed_to, updated_at = excluded.updated_at`,
    [
      row.code, row.plan, row.days ?? 0, row.status || "active", row.max_dev ?? 2,
      typeof row.devices === "string" ? row.devices : JSON.stringify(row.devices || []),
      row.note || "", typeof row.ticket === "string" ? row.ticket : JSON.stringify(row.ticket || {}),
      row.sold_at || null, row.activated_at || null, row.expire_at || null,
      row.redeemed_at || null, row.redeemed_to || null,
      row.created_at || stamp, row.updated_at || row.created_at || stamp,
    ],
  ]);
  stats.licenses = licenses.length;

  const logs = Array.isArray(snapshot.activateLog) ? snapshot.activateLog : [];
  await dbRun(env, "DELETE FROM activate_log");
  await chunk(logs, 60, (row) => [
    "INSERT INTO activate_log (code, device_id, ip, result, at) VALUES (?, ?, ?, ?, ?)",
    [row.code || null, row.device_id || null, row.ip || null, left(row.result, 64), row.at || stamp],
  ]);
  stats.activateLog = logs.length;

  const packages = Array.isArray(snapshot.hotupdate?.packages) ? snapshot.hotupdate.packages : [];
  await chunk(packages, 40, (row) => [
    `INSERT INTO hotupdate_pkg (hot_version_code, hot_version_name, apk_min_version, apk_max_version,
        object_key, file_size, sha256, notes, force_apply, status, publish_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hot_version_code) DO UPDATE SET
       hot_version_name = excluded.hot_version_name, apk_min_version = excluded.apk_min_version,
       apk_max_version = excluded.apk_max_version, object_key = excluded.object_key,
       file_size = excluded.file_size, sha256 = excluded.sha256, notes = excluded.notes,
       force_apply = excluded.force_apply, status = excluded.status, publish_at = excluded.publish_at,
       updated_at = excluded.updated_at`,
    [
      row.hot_version_code, row.hot_version_name || "", row.apk_min_version ?? 0,
      row.apk_max_version ?? 2147483647, row.object_key, row.file_size ?? 0, row.sha256 || "",
      row.notes || "", row.force_apply ? 1 : 0, row.status || "offline", row.publish_at || null,
      row.created_at || stamp, row.updated_at || row.created_at || stamp,
    ],
  ]);
  stats.hotupdatePkg = packages.length;

  const huLogs = Array.isArray(snapshot.hotupdate?.logs) ? snapshot.hotupdate.logs : [];
  await dbRun(env, "DELETE FROM hotupdate_log");
  await chunk(huLogs, 60, (row) => [
    `INSERT INTO hotupdate_log (device, apk_version, from_version, to_version, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.device || "unknown", row.apk_version ?? null, row.from_version ?? null, row.to_version ?? null,
      row.result || "", row.detail || "", row.created_at || stamp,
    ],
  ]);
  stats.hotupdateLog = huLogs.length;

  const channels = Array.isArray(snapshot.iptv?.channels) ? snapshot.iptv.channels : [];
  for (const channel of channels) {
    const existing = await dbFirst(env, "SELECT id FROM iptv_channel WHERE name = ? LIMIT 1", [channel.name]);
    let id = existing?.id;
    if (id) {
      await dbRun(
        env,
        "UPDATE iptv_channel SET group_name = ?, logo = ?, sort_order = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?",
        [
          channel.group || "其他", channel.logo || "", channel.sort ?? 0,
          channel.enabled === false ? 0 : 1, channel.note || "", stamp, id,
        ],
      );
      await dbRun(env, "DELETE FROM iptv_line WHERE channel_id = ?", [id]);
    } else {
      const result = await dbRun(
        env,
        `INSERT INTO iptv_channel (name, group_name, logo, sort_order, enabled, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          channel.name, channel.group || "其他", channel.logo || "", channel.sort ?? 0,
          channel.enabled === false ? 0 : 1, channel.note || "", stamp, stamp,
        ],
      );
      id = result.meta?.last_row_id;
    }
    const lines = Array.isArray(channel.lines) ? channel.lines : [];
    if (lines.length) {
      await dbBatch(env, lines.map((line, index) => [
        `INSERT INTO iptv_line (channel_id, url, sort_order, enabled, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id, String(line.url || line), line.sort ?? index,
          line.enabled === false ? 0 : 1, line.note || "", stamp,
        ],
      ]));
    }
    stats.channels += 1;
    stats.lines += lines.length;
  }

  const versions = Array.isArray(snapshot.iptv?.versions) ? snapshot.iptv.versions : [];
  await chunk(versions, 40, (row) => [
    `INSERT INTO iptv_version (version, object_key, file_size, sha256, channels, lines, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version) DO UPDATE SET
       object_key = excluded.object_key, file_size = excluded.file_size, sha256 = excluded.sha256,
       channels = excluded.channels, lines = excluded.lines, notes = excluded.notes, status = excluded.status`,
    [
      row.version, row.object_key || "", row.file_size ?? 0, row.sha256 || "",
      row.channels ?? 0, row.lines ?? 0, row.notes || "", row.status || "offline", row.created_at || stamp,
    ],
  ]);
  stats.versions = versions.length;

  const groups = Array.isArray(snapshot.iptv?.groups) ? snapshot.iptv.groups : [];
  for (const [index, group] of groups.entries()) {
    await dbRun(
      env,
      `INSERT INTO iptv_group (name, sort, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET sort = excluded.sort`,
      [group.name, group.sort ?? index, stamp],
    );
  }
  stats.groups = groups.length;

  const iptvLogs = Array.isArray(snapshot.iptv?.logs) ? snapshot.iptv.logs : [];
  if (iptvLogs.length) {
    await dbRun(env, "DELETE FROM iptv_admin_log");
    await chunk(iptvLogs, 60, (row) => [
      "INSERT INTO iptv_admin_log (action, detail, created_at) VALUES (?, ?, ?)",
      [left(row.action, 40), left(row.detail, 800), row.created_at || stamp],
    ]);
  }
  const mode = snapshot.iptv?.mode;
  if (mode === "auto" || mode === "manual") {
    await dbRun(
      env,
      `INSERT INTO iptv_config (key, value, updated_at) VALUES ('mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [mode, stamp],
    );
  }

  if (snapshot.announcement) {
    await dbRun(env, "DELETE FROM announcements");
    await dbRun(
      env,
      "INSERT INTO announcements (title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [
        left(snapshot.announcement.title, 60), left(snapshot.announcement.content, 600),
        snapshot.announcement.status || "published", stamp, stamp,
      ],
    );
  }

  const drafts = Array.isArray(snapshot.vod?.drafts) ? snapshot.vod.drafts : [];
  if (drafts.length) {
    await dbRun(env, "DELETE FROM vod_source_drafts");
    await chunk(drafts, 40, (row) => [
      `INSERT INTO vod_source_drafts (id, name, site_url, api_url, adapter_type, enabled, sort_order, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.name, row.site_url, row.api_url || "", row.adapter_type,
        row.enabled === false ? 0 : 1, row.sort_order ?? 0, row.revision ?? 1, row.updated_at || stamp,
      ],
    ]);
    stats.vod = drafts.length;
    const published = toInt(snapshot.vod?.publishedVersion, 0) ?? 0;
    if (published > 0) {
      const existing = await dbFirst(env, "SELECT version FROM vod_source_versions WHERE version = ?", [published]);
      if (!existing) {
        const config = {
          schema: 1,
          version: published,
          sources: drafts.map((d) => ({
            id: d.id, name: d.name, site_url: d.site_url, api_url: d.api_url || "",
            adapter_type: d.adapter_type, enabled: d.enabled !== false, revision: d.revision ?? 1,
          })),
        };
        const text = JSON.stringify(config);
        await dbRun(
          env,
          "INSERT INTO vod_source_versions (version, config, sha256, published_at) VALUES (?, ?, ?, ?)",
          [published, text, await sha256Hex(text), stamp],
        );
      }
    }
  }
  return stats;
}

function cardsCsv(rows) {
  const header = "code,plan,days,price,note";
  const body = rows.map((r) => `${r.code},${r.plan},${r.days},${r.price},"${String(r.note || "").replace(/"/g, '""')}"`);
  return `\uFEFF${[header, ...body].join("\n")}\n`;
}

async function hHealth(env) {
  const started = Date.now();
  try {
    await dbFirst(env, "SELECT 1 AS ok");
    const probe = new Uint8Array([0x00]);
    await env.BUCKET.put("healthz.tmp", probe);
    await env.BUCKET.delete("healthz.tmp");
    return { ok: true, latency_ms: Date.now() - started };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, detail: String(error.message || error).slice(0, 120) };
  }
}

async function hHuHealth(env) {
  const started = Date.now();
  try {
    await dbFirst(env, "SELECT 1 AS ok");
    return {
      ok: true,
      blackout: String(env.OTV_HU_OFF || "") === "1",
      ret: 400,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, detail: String(error.message || error).slice(0, 120) };
  }
}

async function hGen(env, body) {
  const plan = String(body.plan || "").trim();
  const note = String(body.note || "").trim() || "后台补货";
  const count = toInt(body.count, 0) ?? 0;
  if (!PLANS[plan]) return { error: "套餐不合法" };
  if (count < 1 || count > 500) return { error: "数量需在 1–500 之间" };
  const key = await privateKey(env);
  if (!key) return { error: "未配置签发私钥（OTV_PRIV_KEY），无法在云端补货——请改用本机 license_gen.py" };

  const days = PLANS[plan].days;
  const issued = new Date().toISOString().slice(0, 10);
  const stamp = nowIso();
  const rows = [];
  const statements = [];
  for (let i = 0; i < count; i += 1) {
    let code;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      code = genCode();
      const exists = await dbFirst(env, "SELECT code FROM licenses WHERE code = ?", [code]);
      if (!exists) break;
      code = null;
    }
    if (!code) return { error: "卡密生成冲突（请重试）" };
    const nonce = randomHex(8);
    const sig = await signTicket(env, code, plan, days, issued, nonce);
    const ticket = { v: 1, code, plan, days, issued, nonce, sig };
    statements.push([
      `INSERT INTO licenses (code, plan, days, ticket, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, plan, days, JSON.stringify(ticket), note, stamp, stamp],
    ]);
    rows.push({ code, plan, days, price: PLANS[plan].price, note });
  }
  await dbBatch(env, statements);
  const batch = `${issued.replace(/-/g, "")}-${plan}-${count}`;
  return { batch, imported: rows.length, csv: `${batch}/cards.csv`, csv_text: cardsCsv(rows) };
}

async function hIptvSync(env, mode) {
  let lastError = null;
  for (const upstream of IPTV_UPSTREAMS) {
    try {
      const raw = await fetchTextFollow(upstream, IPTV_FETCH_MAX, 3);
      if (!raw.includes("#EXTM3U")) continue;
      const channels = parseM3uToChannels(raw);
      if (!channels.length) continue;
      const out = await rpcIptvImport(env, channels, mode);
      if (out.ret === 0) return { ...out, src: upstream, parsed: channels.length };
      lastError = out;
    } catch (error) {
      lastError = { error: String(error.message || error) };
    }
  }
  return lastError || { error: "全部上游不可达" };
}

async function hIptvLogoUpload(env, request, query, raw) {
  const bytes = new Uint8Array(raw);
  if (!bytes.byteLength || bytes.byteLength > IPTV_LOGO_MAX) return { error: "图片大小不合法（1B–2MB）" };
  let ext;
  let contentType;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    ext = "png";
    contentType = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    ext = "jpg";
    contentType = "image/jpeg";
  } else if (decoder.decode(bytes.slice(0, 4)) === "RIFF" && decoder.decode(bytes.slice(8, 12)) === "WEBP") {
    ext = "webp";
    contentType = "image/webp";
  } else {
    return { error: "仅支持 PNG / JPG / WEBP 图片（按文件内容识别）" };
  }
  const name = query.get("name") || "logo";
  const slug = (await sha256Hex(name)).slice(0, 10);
  const key = `iptv/logos/${slug}-${Date.now()}.${ext}`;
  try {
    await putObject(env, key, bytes, contentType);
  } catch (error) {
    return { error: `上传失败: ${error.message || error}` };
  }
  return { ret: 0, url: objectUrl(request, key), key, size: bytes.byteLength };
}

async function hIptvImportBody(env, body) {
  const mode = body.mode === "replace" ? "replace" : "merge";
  let text = String(body.m3u || "").trim();
  const url = String(body.url || "").trim();
  if (url) {
    try {
      text = await fetchTextFollow(url, IPTV_FETCH_MAX, 3);
    } catch (error) {
      return { error: `拉取失败: ${error.message || error}` };
    }
  }
  if (!text || (!text.includes("#EXTM3U") && !text.includes("://"))) return { error: "内容为空或不是 M3U" };
  const channels = parseM3uToChannels(text);
  if (!channels.length) return { error: "未解析到任何频道" };
  const out = await rpcIptvImport(env, channels, mode);
  if (out.ret === 0) out.parsed = channels.length;
  return out;
}

// ---------------- 路由 ----------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

async function readRawBody(request, maxBytes) {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  return buffer;
}

async function handleLogin(request, env, url) {
  const ip = clientIp(request);
  if (await loginTooBusy(env, ip)) {
    return jsonResponse({ error: "尝试过于频繁，请 1 分钟后再试" }, 429);
  }
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ error: "请求体不是 JSON" }, 400);
  const user = String(body.user || "");
  const pass = String(body.pass || "");
  const ok = timingSafeEqual(user, env.OTV_ADMIN_USER || "admin")
    && timingSafeEqual(pass, env.OTV_ADMIN_PASS || "");
  await noteLogin(env, ip, ok);
  if (!ok) return jsonResponse({ error: "账号或密码错误" }, 401);
  const token = await makeSession(env);
  const secure = url.protocol === "https:";
  return jsonResponse({ ok: true }, 200, { "set-cookie": sessionCookie(token, secure) });
}

function adminConfigError(env) {
  const missing = [];
  if (!env.OTV_ADMIN_PASS) missing.push("OTV_ADMIN_PASS");
  if (!env.OTV_ADMIN_SECRET) missing.push("OTV_ADMIN_SECRET");
  return missing.length ? `后台未配置：${missing.join("、")}` : null;
}

async function handleAdminApi(request, env, url) {
  const path = url.pathname;
  if (path === "/api/login") {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const configError = adminConfigError(env);
    if (configError) return jsonResponse({ error: configError }, 503);
    return handleLogin(request, env, url);
  }
  if (path === "/api/whoami") {
    const ok = await sessionOk(request, env);
    return jsonResponse({ ok }, ok ? 200 : 401);
  }
  const configError = adminConfigError(env);
  if (configError) return jsonResponse({ error: configError }, 503);
  if (!(await sessionOk(request, env))) {
    return jsonResponse({ error: "未登录或会话已过期" }, 401);
  }
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const query = url.searchParams;
  const route = path.replace(/^\/api\//, "");

  // 原始字节直传（zip / m3u / 台标）
  if (route === "hu_upload") {
    const raw = await readRawBody(request, HU_DIRECT_MAX);
    if (!raw) return jsonResponse({ error: `包体超过网关直传上限（${HU_DIRECT_MAX / 1048576}MB），请使用分片上传` });
    return jsonResponse(await huUploadDirect(env, query, raw));
  }
  if (route === "hu_upload_chunk") {
    const raw = await readRawBody(request, HU_CHUNK_MAX);
    if (!raw) return jsonResponse({ error: `分片过大（≤${HU_CHUNK_MAX / 1048576}MB）` });
    return jsonResponse(await huUploadChunk(env, query, raw));
  }
  if (route === "hu_upload_commit") {
    return jsonResponse(await huUploadCommit(env, query));
  }
  if (route === "iptv_upload") {
    const raw = await readRawBody(request, 32 * 1024 * 1024);
    if (!raw) return jsonResponse({ error: "文件过大（≤32MB）" });
    return jsonResponse(await hIptvImportBody(env, { m3u: decoder.decode(raw), mode: query.get("mode") || "merge" }));
  }
  if (route === "iptv_logo_upload") {
    const raw = await readRawBody(request, IPTV_LOGO_MAX);
    if (!raw) return jsonResponse({ error: "图片过大（≤2MB）" });
    return jsonResponse(await hIptvLogoUpload(env, request, query, raw));
  }
  if (route === "import_object") {
    const key = String(query.get("key") || "");
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(key) || key.includes("..")) {
      return jsonResponse({ error: "bad_key" });
    }
    const raw = await readRawBody(request, HU_BUFFER_MAX);
    if (!raw) return jsonResponse({ error: `对象过大（≤${HU_BUFFER_MAX / 1048576}MB）` });
    const bytes = new Uint8Array(raw);
    try {
      await putObject(env, key, bytes, String(query.get("type") || "application/octet-stream"));
    } catch (error) {
      return jsonResponse({ error: `对象写入失败: ${error.message || error}` });
    }
    return jsonResponse({ ok: true, key, size: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  if (route === "delete_object") {
    const key = String(query.get("key") || "");
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(key) || key.includes("..")) {
      return jsonResponse({ error: "bad_key" });
    }
    await deleteObject(env, key);
    return jsonResponse({ ok: true, key });
  }

  const body = await readJsonBody(request);
  if (body === null) return jsonResponse({ error: "请求体不是 JSON" }, 400);

  switch (route) {
    case "stats":
      return jsonResponse(await rpcAdminStats(env));
    case "health":
      return jsonResponse(await hHealth(env));
    case "hu_health":
      return jsonResponse(await hHuHealth(env));
    case "licenses": {
      const limit = clamp(toInt(body.limit, 50) ?? 50, 1, 200);
      const offset = Math.max(toInt(body.offset, 0) ?? 0, 0);
      const sort = ["code", "plan", "status", "created_at", "sold_at", "devices", "updated_at"].includes(String(body.sort))
        ? String(body.sort)
        : "updated_at";
      return jsonResponse(await rpcAdminLicenses(env, {
        p_q: body.q, p_plan: body.plan, p_status: body.status,
        p_limit: limit, p_offset: offset, p_sort: sort, p_dir: body.dir,
      }));
    }
    case "set_status": {
      const code = String(body.code || "").trim().toUpperCase();
      const status = String(body.status || "").trim();
      if (!CODE_RE.test(code)) return jsonResponse({ error: "bad_code" });
      if (!["active", "banned"].includes(status)) return jsonResponse({ error: "bad_status" });
      return jsonResponse(await rpcAdminSetStatus(env, code, status));
    }
    case "unbind": {
      const code = String(body.code || "").trim().toUpperCase();
      const device = String(body.device || "").trim();
      if (!CODE_RE.test(code)) return jsonResponse({ error: "bad_code" });
      if (device && !/^[A-Za-z0-9_-]{8,64}$/.test(device)) return jsonResponse({ error: "bad_device" });
      return jsonResponse(await rpcAdminUnbind(env, code, device));
    }
    case "mark_sold": {
      const code = String(body.code || "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return jsonResponse({ error: "bad_code" });
      return jsonResponse(await rpcAdminMarkSold(env, code, Boolean(body.sold)));
    }
    case "logs": {
      const limit = clamp(toInt(body.limit, 100) ?? 100, 1, 500);
      return jsonResponse(await rpcAdminLogs(env, String(body.code || "").trim() || null, limit));
    }
    case "gen":
      return jsonResponse(await hGen(env, body));
    case "hu_list": {
      const limit = clamp(toInt(body.limit, 100) ?? 100, 1, 200);
      const offset = Math.max(toInt(body.offset, 0) ?? 0, 0);
      return jsonResponse(await rpcHuList(env, limit, offset));
    }
    case "hu_logs": {
      const limit = clamp(toInt(body.limit, 100) ?? 100, 1, 500);
      return jsonResponse(await rpcHuLogs(env, limit));
    }
    case "hu_set_status": {
      const version = toInt(body.version, 0) ?? 0;
      const status = String(body.status || "");
      if (version < 1) return jsonResponse({ error: "bad_version" });
      if (!["published", "offline"].includes(status)) return jsonResponse({ error: "bad_param" });
      return jsonResponse(await rpcHuSetStatus(env, version, status));
    }
    case "hu_delete": {
      const version = toInt(body.version, 0) ?? 0;
      if (version < 1) return jsonResponse({ error: "bad_version" });
      return jsonResponse(await rpcHuDelete(env, version));
    }
    case "ann_get":
      return jsonResponse(await rpcAnnouncementAdminGet(env));
    case "ann_publish": {
      const title = String(body.title || "").trim();
      const content = String(body.content || "").trim();
      const status = String(body.status || "published");
      if (title.length < 1 || title.length > 60) return jsonResponse({ error: "标题需 1–60 字" });
      if (content.length > 600) return jsonResponse({ error: "正文最长 600 字" });
      if (!["published", "offline"].includes(status)) return jsonResponse({ error: "bad_status" });
      return jsonResponse(await rpcAnnouncementPublish(env, title, content, status));
    }
    case "iptv_list":
      return jsonResponse(await rpcIptvList(env));
    case "iptv_save": {
      const lines = Array.isArray(body.lines)
        ? body.lines
        : (Array.isArray(body.urls) ? body.urls.map((url) => ({ url })) : []);
      const name = String(body.name || "").trim();
      if (!name || name.length > 60) return jsonResponse({ error: "bad_name" });
      return jsonResponse(await rpcIptvUpsertChannel(env, {
        id: body.id, name, group: String(body.group || "").trim() || "其他",
        logo: String(body.logo || "").trim(), sort: toInt(body.sort, 0) ?? 0,
        enabled: body.enabled !== false, note: String(body.note || "").trim(), lines,
      }));
    }
    case "iptv_delete":
      return jsonResponse(await rpcIptvDeleteChannel(env, toInt(body.id, 0) ?? 0));
    case "iptv_batch":
      return jsonResponse(await rpcIptvBatch(env, body.ops || []));
    case "iptv_import":
      return jsonResponse(await hIptvImportBody(env, body));
    case "iptv_sync":
      return jsonResponse(await hIptvSync(env, body.mode === "replace" ? "replace" : "merge"));
    case "iptv_auto_run": {
      const starts = Date.now();
      const out = await rebuildIptv(env, { mode: "auto", force: true });
      if (out.error) return jsonResponse(out);
      return jsonResponse({ ...out, elapsedMs: Date.now() - starts });
    }
    case "iptv_probe": {
      const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 24);
      if (!lines.length) return jsonResponse({ error: "bad_lines" });
      const results = await mapWithConcurrency(lines, 8, async (url) => ({
        url, ms: await probeLine(url, 5000),
      }));
      return jsonResponse({ ret: 0, results });
    }
    case "iptv_publish":
      return jsonResponse(await iptvPublishLatest(env, { notes: String(body.notes || "").trim() }));
    case "iptv_rollback":
      return jsonResponse(await iptvRollback(env, toInt(body.version, 0) ?? 0));
    case "iptv_versions": {
      const limit = clamp(toInt(body.limit, 50) ?? 50, 1, 200);
      return jsonResponse(await rpcIptvVersions(env, limit));
    }
    case "iptv_logs": {
      const limit = clamp(toInt(body.limit, 200) ?? 200, 1, 500);
      return jsonResponse(await rpcIptvLogs(env, limit));
    }
    case "iptv_mode": {
      const mode = String(body.mode || "").trim();
      if (!["auto", "manual"].includes(mode)) return jsonResponse(await rpcIptvGetMode(env));
      const out = await rpcIptvSetMode(env, mode);
      try {
        await writeIptvMeta(env, mode, { source: "admin" });
      } catch {
        /* meta 失败不影响模式切换结果 */
      }
      return jsonResponse(out);
    }
    case "iptv_latest":
      return jsonResponse(await iptvLatestProbe(env, request));
    case "iptv_group_list":
      return jsonResponse(await rpcIptvGroupList(env));
    case "iptv_group_create":
      return jsonResponse(await rpcIptvGroupCreate(env, body.name));
    case "iptv_group_rename":
      return jsonResponse(await rpcIptvGroupRename(env, toInt(body.id, 0) ?? 0, body.name));
    case "iptv_group_delete":
      return jsonResponse(await rpcIptvGroupDelete(env, toInt(body.id, 0) ?? 0, body.moveTo));
    case "iptv_group_move":
      return jsonResponse(await rpcIptvGroupMove(env, toInt(body.id, 0) ?? 0, toInt(body.delta, 0) ?? 0));
    case "iptv_refresh_token":
      return jsonResponse({ token: String(env.OTV_REFRESH_TOKEN || "") });
    case "vod_source_list":
      return jsonResponse(await rpcVodSourceList(env));
    case "vod_source_save": {
      const name = String(body.name || "").trim().slice(0, 80);
      const siteUrl = String(body.site_url || "").trim();
      const apiUrl = String(body.api_url || "").trim();
      const adapter = String(body.adapter_type || "").trim();
      if (!name || !VOD_ADAPTERS.includes(adapter)) return jsonResponse({ error: "名称或适配器类型不合法" });
      try {
        assertPublicHttps(siteUrl);
        if (apiUrl) assertPublicHttps(apiUrl);
      } catch (error) {
        return jsonResponse({ error: String(error.message || error) });
      }
      return jsonResponse(await rpcVodSourceSave(env, {
        id: body.id || null, name, site_url: siteUrl, api_url: apiUrl, adapter_type: adapter,
        enabled: body.enabled !== false, sort_order: toInt(body.sort_order, 0) ?? 0,
      }));
    }
    case "vod_source_delete":
      if (!body.id) return jsonResponse({ error: "缺少影视源 ID" });
      return jsonResponse(await rpcVodSourceDelete(env, String(body.id)));
    case "vod_source_discover":
      try {
        return jsonResponse(await vodSourceDiscover(env, body.site_url));
      } catch (error) {
        return jsonResponse({ error: String(error.message || error).slice(0, 180) });
      }
    case "vod_source_test":
      return jsonResponse(await vodSourceTest(env, body));
    case "vod_source_publish":
      return jsonResponse(await rpcVodSourcePublish(env));
    case "import_snapshot":
      return jsonResponse({ ok: true, stats: await importSnapshot(env, body) });
    case "export_snapshot": {
      const [licensesRows, activateRows, packages, huLogs, iptvList, iptvVersions, iptvLogs, groups, announcement, vod] =
        await Promise.all([
          dbAll(env, "SELECT * FROM licenses ORDER BY code"),
          dbAll(env, "SELECT code, device_id, ip, result, at FROM activate_log ORDER BY at"),
          dbAll(env, "SELECT * FROM hotupdate_pkg ORDER BY hot_version_code"),
          dbAll(env, "SELECT * FROM hotupdate_log ORDER BY created_at"),
          rpcIptvList(env),
          rpcIptvVersions(env, 200),
          rpcIptvLogs(env, 500),
          rpcIptvGroupList(env),
          rpcAnnouncementAdminGet(env),
          rpcVodSourceList(env),
        ]);
      return jsonResponse({
        exportedAt: nowIso(),
        licenses: licensesRows.map(licenseRowToJson),
        activateLog: activateRows,
        hotupdate: { packages: packages.map(huRowToJson), logs: huLogs },
        iptv: {
          channels: iptvList.channels, latest: iptvList.latest,
          versions: iptvVersions.rows, logs: iptvLogs.rows, groups, mode: iptvList.mode,
        },
        announcement: announcement.ann,
        vod: { drafts: vod.drafts, publishedVersion: vod.publishedVersion },
      });
    }
    default:
      return jsonResponse({ error: "not found" }, 404);
  }
}

async function handleDevice(request, env, url) {
  const path = url.pathname;
  const cacheHeaders = {
    "cache-control": "public, max-age=60, stale-while-revalidate=300",
    ...CORS_HEADERS,
  };

  if (path === "/activate" || path === "/") {
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse({ ret: 400, msg: "bad_json" }, 200, CORS_HEADERS);
    const out = await activateCode(env, body, clientIp(request));
    return jsonResponse(out, 200, CORS_HEADERS);
  }

  if (request.method === "GET" && (path === "/announce" || path === "/hotupdate/announce")) {
    const out = await rpcAnnouncementLatest(env);
    return jsonResponse(out, 200, cacheHeaders);
  }

  if (request.method === "GET" && path === "/iptv/latest") {
    const raw = await getObjectBytes(env, IPTV_KEY_LATEST, 32 * 1024 * 1024);
    if (!raw) return textResponse("not found", 404, "text/plain; charset=utf-8", CORS_HEADERS);
    return new Response(raw, {
      headers: {
        "content-type": "audio/x-mpegurl; charset=utf-8",
        "cache-control": "public, max-age=60",
        ...CORS_HEADERS,
      },
    });
  }
  if (request.method === "GET" && (path === "/iptv/status" || path === "/iptv/meta")) {
    const metaRaw = await getObjectBytes(env, IPTV_KEY_META, 65536);
    const meta = metaRaw ? JSON.parse(decoder.decode(metaRaw)) : { mode: null };
    const mode = await rpcIptvGetMode(env);
    return jsonResponse({ ret: 0, ...meta, mode: meta.mode || mode.mode }, 200, CORS_HEADERS);
  }
  if (request.method === "POST" && (path === "/iptv/refresh" || path === "/iptv/rebuild")) {
    const expected = String(env.OTV_REFRESH_TOKEN || "");
    const provided = url.searchParams.get("token") || request.headers.get("x-otv-token") || "";
    if (!expected) return jsonResponse({ ret: 403, msg: "refresh_token_not_configured" }, 403, CORS_HEADERS);
    if (!timingSafeEqual(provided, expected)) return jsonResponse({ ret: 403, msg: "forbidden" }, 403, CORS_HEADERS);
    const out = await rebuildIptv(env, { mode: "auto" });
    return jsonResponse(out, 200, CORS_HEADERS);
  }

  if (path === "/objects/" || path.startsWith("/objects/")) {
    const key = decodeURIComponent(path.slice("/objects/".length));
    if (!key) return textResponse("not found", 404);
    const rangeHeader = request.headers.get("range") || "";
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    const options = {};
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : undefined;
      options.range = end === undefined ? { offset: start } : { offset: start, length: end - start + 1 };
    }
    const object = await env.BUCKET.get(key, options);
    if (!object) return textResponse("not found", 404);
    const headers = {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=300",
      etag: object.httpEtag,
      "accept-ranges": "bytes",
      ...CORS_HEADERS,
    };
    if (options.range) {
      const start = options.range.offset;
      const length = options.range.length ?? object.size;
      headers["content-range"] = `bytes ${start}-${start + length - 1}/${object.size}`;
    }
    return new Response(object.body, { status: options.range ? 206 : 200, headers });
  }

  if (request.method === "POST" && (path === "/check" || path === "/hotupdate/check" || path === "/hotupdate")) {
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse({ ret: 400, msg: "bad_json" }, 200, CORS_HEADERS);
    const apkVersion = toInt(body.apkVersion, 0) ?? 0;
    if (apkVersion <= 0) return jsonResponse({ ret: 400, msg: "bad_apk" }, 200, CORS_HEADERS);
    if (String(env.OTV_HU_OFF || "") === "1") {
      return jsonResponse({ ret: 0, hasUpdate: false, blackout: true }, 200, CORS_HEADERS);
    }
    const out = await rpcHotupdateCheck(env, toInt(body.hotVersion, 0) ?? 0, apkVersion);
    if (out.hasUpdate && out.pkg?.objectKey) {
      out.pkg.url = objectUrl(request, out.pkg.objectKey);
    }
    return jsonResponse(out, 200, CORS_HEADERS);
  }

  if (request.method === "POST" && (path === "/report" || path === "/hotupdate/report")) {
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse({ ret: 400, msg: "bad_json" }, 200, CORS_HEADERS);
    const device = String(body.deviceId || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) {
      return jsonResponse({ ret: 400, msg: "bad_device" }, 200, CORS_HEADERS);
    }
    const out = await rpcHotupdateReport(env, {
      device,
      apkVersion: toInt(body.apkVersion, null),
      fromVersion: toInt(body.fromVersion, null),
      toVersion: toInt(body.toVersion, null),
      result: String(body.result || ""),
      detail: String(body.detail || ""),
    });
    return jsonResponse(out, 200, CORS_HEADERS);
  }

  if (request.method === "POST" && (path === "/vod-sources/check" || path === "/hotupdate/vod-sources/check")) {
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse({ ret: 400, msg: "bad_json" }, 200, CORS_HEADERS);
    const device = String(body.deviceId || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) {
      return jsonResponse({ ret: 400, msg: "bad_device" }, 200, CORS_HEADERS);
    }
    const out = await rpcVodSourcePublicCheck(env, toInt(body.version, 0) ?? 0);
    return jsonResponse(out, 200, CORS_HEADERS);
  }

  return jsonResponse({ ret: 404, msg: "not_found" }, 200, CORS_HEADERS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/healthz") {
      return jsonResponse({ ok: true, time: nowIso() });
    }

    if (path === "/logo.png" || path === "/favicon.ico") {
      return new Response(base64Bytes(LOGO_B64), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(ADMIN_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (path.startsWith("/api/")) {
      return handleAdminApi(request, env, url);
    }

    return handleDevice(request, env, url);
  },
};
