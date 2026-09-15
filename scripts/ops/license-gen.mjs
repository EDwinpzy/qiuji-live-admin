/**
 * 本机补货：直接把卡密写进自建站点（D1），替代 CloudBase 时代的
 * `license_gen.py`（本地签发）+ `db_import.py`（写 PG）两步。
 *
 * 用法：
 *   node scripts/ops/license-gen.mjs --plan monthly --count 10 [--note "第二批"] [--out 目录]
 *
 * 站点：环境变量 SITE_URL，默认 https://mytv-cloud.pengzhiyuan0724.chatgpt.site
 * 账号：OTV_ADMIN_USER（默认 admin）
 * 密码：OTV_ADMIN_PASS；未设置时读本机密钥文件（默认 My TV/tools/keys/admin_pass.txt）
 * 产出：out/license/<批次>/cards.csv（发卡平台导入文件）+ 屏幕摘要
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_SITE = "https://mytv-cloud.pengzhiyuan0724.chatgpt.site";
const PASS_FILE = path.join("D:", "MyProjects", "My TV", "tools", "keys", "admin_pass.txt");
const PLANS = ["weekly", "monthly", "quarterly", "yearly", "lifetime"];

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

const plan = arg("plan");
const count = Number(arg("count", "0"));
const note = arg("note", "") || `本机补货 ${new Date().toISOString().slice(0, 10)}`;
const site = (arg("site") || process.env.SITE_URL || DEFAULT_SITE).replace(/\/$/, "");
const outRoot = path.resolve(arg("out") || path.join(process.cwd(), "out", "license"));
const user = process.env.OTV_ADMIN_USER || "admin";

if (!PLANS.includes(plan) || !Number.isInteger(count) || count < 1 || count > 500) {
  console.error(`用法：node scripts/ops/license-gen.mjs --plan <${PLANS.join("|")}> --count <1-500> [--note 备注] [--out 目录] [--site 站点地址]`);
  process.exit(64);
}

let password = process.env.OTV_ADMIN_PASS || "";
if (!password && existsSync(PASS_FILE)) password = readFileSync(PASS_FILE, "utf8").trim();
if (!password) {
  console.error(`缺少后台密码：设置 OTV_ADMIN_PASS 或写入 ${PASS_FILE}`);
  process.exit(2);
}

const login = await fetch(`${site}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ user, pass: password }),
});
if (!login.ok) {
  console.error(`登录失败 HTTP ${login.status}：${(await login.text()).slice(0, 160)}`);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.()[0] || "").split(";")[0];
if (!cookie) {
  console.error("登录未返回会话 Cookie");
  process.exit(1);
}

const response = await fetch(`${site}/api/gen`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ plan, count, note }),
});
const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = { error: String(text).slice(0, 200) };
}
if (!response.ok || data.error) {
  console.error(`补货失败：${data.error || `HTTP ${response.status}`}`);
  process.exit(1);
}

const dir = path.join(outRoot, String(data.batch || "batch"));
mkdirSync(dir, { recursive: true });
let csvPath = "";
if (data.csv_text) {
  csvPath = path.join(dir, "cards.csv");
  writeFileSync(csvPath, data.csv_text, "utf8");
}

console.log(`补货完成：${data.batch} · ${data.imported} 张 ${plan} 卡已写入站点 D1（${site}）`);
if (csvPath) console.log(`发卡文件：${csvPath}`);
