/**
 * 每日电视源自动重建（替代原 CloudBase iptv-rebuild 定时函数）。
 *
 * 用法：node scripts/ops/iptv-refresh.mjs
 * 令牌：环境变量 OTV_REFRESH_TOKEN，或密钥文件（默认 My TV/tools/keys/mytv_cloud_refresh_token.txt）
 * 站点：环境变量 SITE_URL，默认 https://mytv-cloud.pengzhiyuan0724.chatgpt.site
 *
 * 托管模式（后台手动发布过）下服务端会直接跳过，不会覆盖手工列表。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_SITE = "https://mytv-cloud.pengzhiyuan0724.chatgpt.site";
const TOKEN_FILE = path.join("D:", "MyProjects", "My TV", "tools", "keys", "mytv_cloud_refresh_token.txt");

const site = (process.env.SITE_URL || DEFAULT_SITE).replace(/\/$/, "");
let token = process.env.OTV_REFRESH_TOKEN || "";
if (!token && existsSync(TOKEN_FILE)) token = readFileSync(TOKEN_FILE, "utf8").trim();
if (!token) {
  console.error(`缺少刷新令牌：设置 OTV_REFRESH_TOKEN 或写入 ${TOKEN_FILE}`);
  process.exit(2);
}

// 站点在切域名前仍是私有的：置 OAI_SITES_AUTHORIZATION 可让本机脚本穿过 ChatGPT 登录门禁
const bypass = process.env.OAI_SITES_AUTHORIZATION || "";
const headers = bypass ? { "oai-sites-authorization": `Bearer ${bypass}` } : {};

const response = await fetch(`${site}/iptv/refresh?token=${encodeURIComponent(token)}`, { method: "POST", headers });
const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = text;
}

if (response.status !== 200) {
  console.error(`刷新失败 HTTP ${response.status}: ${String(text).slice(0, 200)}`);
  process.exitCode = 1;
} else if (data.skipped) {
  console.log(`已跳过：当前是托管模式（${data.mode}），手动发布的列表不会被覆盖`);
} else if (data.error) {
  console.error(`刷新失败：${data.error}`);
  process.exitCode = 1;
} else {
  console.log(`自动重建完成：v${data.version} · ${data.channels} 频道 / ${data.lines} 活线 · 测 ${data.probed} 条 · ${(data.elapsedMs / 1000).toFixed(1)}s`);
}
