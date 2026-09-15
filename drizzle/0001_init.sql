-- MyTV 云端（Sites 版）初始表结构。
-- 对应 CloudBase PG 的 licenses / activate_log / hotupdate_* / iptv_* / announcements / vod_source_*，
-- 语义保持一致，时间统一存 ISO-8601 UTC 文本（形如 2026-09-15T04:33:12.345Z）。

CREATE TABLE licenses (
  code         TEXT PRIMARY KEY,
  plan         TEXT NOT NULL CHECK (plan IN ('weekly', 'monthly', 'quarterly', 'yearly', 'lifetime')),
  days         INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  max_dev      INTEGER NOT NULL DEFAULT 2,
  devices      TEXT NOT NULL DEFAULT '[]',
  note         TEXT NOT NULL DEFAULT '',
  ticket       TEXT NOT NULL,
  sold_at      TEXT,
  activated_at TEXT,
  expire_at    TEXT,
  redeemed_at  TEXT,
  redeemed_to  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_licenses_updated_at ON licenses (updated_at DESC);
CREATE INDEX idx_licenses_expire_at ON licenses (expire_at);
CREATE INDEX idx_licenses_redeemed_to ON licenses (redeemed_to);
CREATE INDEX idx_licenses_created_at ON licenses (created_at DESC);

CREATE TABLE activate_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT,
  device_id TEXT,
  ip        TEXT,
  result    TEXT NOT NULL,
  at        TEXT NOT NULL
);

CREATE INDEX idx_activate_log_at ON activate_log (at DESC);
CREATE INDEX idx_activate_log_code ON activate_log (code);

CREATE TABLE hotupdate_pkg (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  hot_version_code INTEGER NOT NULL UNIQUE,
  hot_version_name TEXT NOT NULL DEFAULT '',
  apk_min_version  INTEGER NOT NULL DEFAULT 0,
  apk_max_version  INTEGER NOT NULL DEFAULT 2147483647,
  object_key       TEXT NOT NULL,
  file_size        INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  force_apply      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('published', 'offline', 'scheduled')),
  publish_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_hotupdate_pkg_status_version ON hotupdate_pkg (status, hot_version_code DESC);

CREATE TABLE hotupdate_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device       TEXT NOT NULL,
  apk_version  INTEGER,
  from_version INTEGER,
  to_version   INTEGER,
  result       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_hotupdate_log_created ON hotupdate_log (created_at DESC);

CREATE TABLE iptv_channel (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '其他',
  logo       TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_iptv_channel_sort ON iptv_channel (group_name, sort_order, id);

CREATE TABLE iptv_line (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES iptv_channel (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_iptv_line_channel ON iptv_line (channel_id, sort_order, id);

CREATE TABLE iptv_version (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    INTEGER NOT NULL UNIQUE,
  object_key TEXT NOT NULL DEFAULT '',
  file_size  INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT NOT NULL DEFAULT '',
  channels   INTEGER NOT NULL DEFAULT 0,
  lines      INTEGER NOT NULL DEFAULT 0,
  notes      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'offline', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_iptv_version_version ON iptv_version (version DESC);

CREATE TABLE iptv_admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_iptv_admin_log_created ON iptv_admin_log (created_at DESC);

CREATE TABLE iptv_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE iptv_group (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'offline')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_announcements_status_id ON announcements (status, id DESC);

CREATE TABLE vod_source_drafts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  site_url     TEXT NOT NULL,
  api_url      TEXT NOT NULL DEFAULT '',
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('hhkan', 'macms_json', 'macms_xml')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  revision     INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

CREATE TABLE vod_source_versions (
  version      INTEGER PRIMARY KEY,
  config       TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  published_at TEXT NOT NULL
);
