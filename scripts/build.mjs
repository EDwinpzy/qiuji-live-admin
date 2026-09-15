import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function build() {
  const dist = path.join(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(path.join(dist, "server"), { recursive: true });
  mkdirSync(path.join(dist, ".openai"), { recursive: true });

  const html = readFileSync(path.join(root, "assets/admin.html"), "utf8");
  const logo = readFileSync(path.join(root, "assets/logo.png")).toString("base64");
  let source = readFileSync(path.join(root, "worker/index.js"), "utf8");
  // 用函数式替换，避免 HTML 中的 $& / $' 被当作替换模式
  source = source
    .replace("__ADMIN_HTML__", () => JSON.stringify(html))
    .replace("__LOGO_B64__", () => JSON.stringify(logo));

  writeFileSync(path.join(dist, "server/index.js"), source);
  cpSync(path.join(root, ".openai/hosting.json"), path.join(dist, ".openai/hosting.json"));
  cpSync(path.join(root, "drizzle"), path.join(dist, ".openai/drizzle"), { recursive: true });
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = build();
  console.log(`Built ${dist}`);
}
