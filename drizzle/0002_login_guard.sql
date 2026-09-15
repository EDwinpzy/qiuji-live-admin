-- 后台登录限速（2026-09-15）。
-- Workers 每个请求可能是全新 isolate，纯内存计数在线上不生效；
-- 这里把失败次数落 D1，跨 isolate / 重启都算数。
-- scope 取值：`ip:<客户端 IP>`（拿不到 IP 时退化为全局）与 `all`（全局兜底）。

CREATE TABLE IF NOT EXISTS login_guard (
  scope        TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_guard_updated ON login_guard (updated_at);
