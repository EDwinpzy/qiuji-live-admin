// 本地预览：真实执行 dist/server/index.js（D1/R2 用本地模拟），行为与线上一致。
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../build.mjs";
import { createD1, createR2 } from "./emulate.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stateDir = path.join(root, ".dev-state");
mkdirSync(stateDir, { recursive: true });

function randomToken(bytes = 24) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loadEnv() {
  const envPath = path.join(stateDir, "env.json");
  const stored = existsSync(envPath) ? JSON.parse(readFileSync(envPath, "utf8")) : {};
  const passPath = path.join(stateDir, "admin_pass.txt");
  if (!existsSync(passPath)) writeFileSync(passPath, randomToken(4), "utf8");
  const secrets = {
    OTV_ADMIN_USER: stored.OTV_ADMIN_USER || "admin",
    OTV_ADMIN_PASS: stored.OTV_ADMIN_PASS || readFileSync(passPath, "utf8").trim(),
    OTV_ADMIN_SECRET: stored.OTV_ADMIN_SECRET || randomToken(),
    OTV_REFRESH_TOKEN: stored.OTV_REFRESH_TOKEN || randomToken(12),
  };
  // 固定密钥：重启后旧会话仍有效（私钥不进这份文件，按需从本机 keys/ 读或走环境变量）
  writeFileSync(envPath, JSON.stringify(secrets, null, 2));
  const localKey = path.join("D:", "MyProjects", "My TV", "tools", "keys", "private_key.pem");
  if (process.env.OTV_PRIV_KEY) secrets.OTV_PRIV_KEY = process.env.OTV_PRIV_KEY;
  else if (existsSync(localKey)) secrets.OTV_PRIV_KEY = readFileSync(localKey, "utf8");
  return secrets;
}

const dist = build();
const workerUrl = `${pathToFileURL(path.join(dist, "server/index.js")).href}?v=${Date.now()}`;
const worker = (await import(workerUrl)).default;

const env = {
  ...loadEnv(),
  DB: createD1(path.join(stateDir, "d1.sqlite"), path.join(root, "drizzle")),
  BUCKET: createR2(path.join(stateDir, "r2")),
};

const port = Number(process.env.PORT || 8791);
const host = "127.0.0.1";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://${host}:${port}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  try {
    // 提供最小 ctx：让 worker 的 waitUntil（每日自动刷新）在本机也能跑到
    const waits = [];
    const ctx = {
      waitUntil: (promise) => { const p = Promise.resolve(promise); waits.push(p); p.catch(() => {}); },
      passThroughOnException: () => {},
    };
    const response = await worker.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
    if (waits.length) {
      Promise.allSettled(waits).then(() => console.log(`[dev] ${waits.length} 个后台任务已收尾（waitUntil）`));
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dev server error: ${error.stack || error}`);
  }
});

server.listen(port, host, () => {
  console.log(`MyTV 云端（本地预览） http://${host}:${port}/`);
  console.log(`后台密码写在 .dev-state/admin_pass.txt（账号 ${env.OTV_ADMIN_USER}）`);
});
