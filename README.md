# My TV 云端（Sites 版）

My TV 的云端服务，替代原腾讯云 CloudBase 环境，数据与对象自持：

| 原来（CloudBase） | 现在 |
|---|---|
| otv-admin Web 函数（Python） | 同一个 Worker 的 `/api/*` |
| activate / hotupdate 云函数 | `/activate`、`/hotupdate/*` |
| iptv-rebuild 定时函数 | `/iptv/refresh`（外部定时调用）+ 后台「自动重建」 |
| PostgreSQL + RPC | D1（`DB` 绑定），表结构见 `drizzle/0001_init.sql` |
| pgstore 公开桶 | R2（`BUCKET` 绑定），key 布局不变（`backend-hu16.zip`、`iptv/…`） |

代码只有一个文件：`worker/index.js`（无三方依赖）。`assets/admin.html` 是后台界面，构建时内联进 Worker。

## 运行环境密钥（Sites 站点设置）

| 名称 | 说明 |
|---|---|
| `OTV_ADMIN_USER` | 后台账号，默认 `admin` |
| `OTV_ADMIN_PASS` | 后台密码（必填，未配置时后台返回 503） |
| `OTV_ADMIN_SECRET` | 会话签名密钥（必填，改它可强制所有会话下线） |
| `OTV_PRIV_KEY` | 卡密签发私钥（PKCS8 PEM，填了才能云端「补货」） |
| `OTV_REFRESH_TOKEN` | 电视源 `/iptv/refresh` 触发令牌（可选） |
| `OTV_HU_OFF` | `1` = 全局紧急停更 |

后台登录限速落在 D1（`login_guard` 表，迁移 `0002_login_guard.sql`）：单 IP 60 秒内 5 次失败即锁定，另有全局 40 次/分钟兜底；成功登录清空本 IP 计数。

> 2026-09-15 线上实测：纯内存计数在 Workers 上**永远不触发**（每个请求可能是全新 isolate，全局变量不共享），6 次/12 次连续失败都返回 401。所以限速必须以 D1 为准，内存表只作快路径。

## 本地开发与验证

```bash
npm run dev      # 本地预览（node:sqlite 模拟 D1，本地目录模拟 R2）→ http://127.0.0.1:8791/
npm run seed     # 写入样例数据（只写 .dev-state）
npm run smoke    # 44 项端到端冒烟：后台接口 + 设备激活/复验/续费 + 热更 + 电视源发布回滚
python scripts/dev/verify-signature.py   # 用真公钥校验云端补货票据（与设备端同一 canonical）
npm run build && npm run validate
```

账号密码写在 `.dev-state/admin_pass.txt`；本地库 `.dev-state/d1.sqlite`，对象在 `.dev-state/r2/`。

## 本机补货（写入站点 D1）

CloudBase 时代的 `license_gen.py`（本地签发）+ `db_import.py`（写 PG）已由一条命令取代：

```bash
node scripts/ops/license-gen.mjs --plan monthly --count 10 --note "第二批"
```

- 站点取 `SITE_URL`（默认线上站点），密码取 `OTV_ADMIN_PASS` 或 `My TV/tools/keys/admin_pass.txt`；
- 云端用 `OTV_PRIV_KEY` 签发（与 `license_gen.py` 同一套 ECDSA P-256 / DER 口径，设备端验签一致），直接写入 D1；
- 同时落地 `out/license/<批次>/cards.csv` 供发卡平台导入；
- 走后台账号密码登录，站点即使是私有状态也能用。

## 设备端对接（v1.26 需改）

- `LICENSE_ENDPOINT` → `<站点域名>/activate`
- `HOTUPDATE_ENDPOINT` → `<站点域名>/hotupdate`
- `IptvRepository.SOURCES[0]` → `<站点域名>/iptv/latest`
- 热更包下载地址由 `/hotupdate/check` 返回（`/objects/backend-hu{n}.zip`）

## 与旧系统的差异（已知）

- 热更包分片重组上限 96MB（Worker 内存限制）；更大的包请在本机签发后用直传，或拆包。
- 电视源「自动重建」受 Worker 子请求数限制，单次默认测 60 条线路（`OTV_IPTV_PROBES` 可调，原实现 ~520 条）。
- 每日自动推流没有内置定时器：用外部定时器（如 GitHub Actions）每天 `POST /iptv/refresh?token=…`。

## 切域名清单（脱离 CloudBase）

线上域名统一为 `https://mytv-cloud.pengzhiyuan0724.chatgpt.site`。

1. ~~**站点访问**~~ ✅ 已公开（2026-09-15）：设备（APK）不带 ChatGPT 身份，私有站点不可达，所以已切成 public；后台 `/api/*` 仍有账号密码门禁（失败 5 次/分钟锁定），与腾讯云现网同一套保护。
2. **出 v1.26 APK**：本地代码已改好，**待构建发布**——
   `android/app/build.gradle`、`internal/mobile/app/build.gradle` 的
   `LICENSE_ENDPOINT` → `…/activate`，`HOTUPDATE_ENDPOINT` → `…/hotupdate`；
   `IptvRepository.SOURCES[0]` → `…/iptv/latest`（两个工程各一份）。
3. **数据同步**：切之前再跑一次增量同步（旧站仍在被使用，卡密/激活记录会变）：
   `node scripts/migrate/export-cloudbase.mjs` → `node scripts/migrate/import-to-site.mjs <快照目录> <站点域名>`。
4. **每日推流**：只在站点切到「自动模式」后才需要——接一个定时器调用 `scripts/ops/iptv-refresh.mjs`（或直接 POST `/iptv/refresh?token=…`），替代 CloudBase 每天 06:30 的 `iptv-rebuild`。当前是托管模式，`/iptv/refresh` 会直接跳过，不覆盖手工列表。
5. **网页版**：`otv-web`（`proxy.py` + `www/`，234KB Python）仍在 CloudBase；已把 `OTV_LICENSE_ENDPOINT`、`IPTV_SOURCES[0]` 指向新站点（卡密/电视源已解耦），网页版本体与足球兜底中继仍跑在 CloudBase。
6. **收尾**：设备端观察一个版本周期后，CloudBase 的 activate / hotupdate / iptv-rebuild / otv-admin 可下线，PG 与桶做一次终态归档。

### 公开后实测（2026-09-15，去掉门禁绕过头直连）

| 检查 | 结果 |
|---|---|
| `GET /healthz` | `{"ok":true}` |
| `POST /activate`（不存在的卡） | `{"ret":404,"msg":"not_found"}`（与旧站同口径） |
| `POST /hotupdate/check` | v17 + `sha256 4f0c536d7523…` + 新域名下载地址 |
| `GET /iptv/latest` | 200，17.4KB m3u |
| `GET /objects/backend-hu17.zip`（Range） | 206 / `bytes 0-1023/40416518` |
| `GET /api/state`（未登录） | 401（后台门禁生效） |
| 正确密码登录 | 200 + 会话 Cookie |
| 连续 5 次错误密码 | 第 6 次起 429（v5 修复前：12 次连发全部 401） |

### v6（2026-09-15）：与后台最新口径对齐

- 热更包校验必备条目补 `media_index.py`、`pinyin_map.json`——与 App `HotUpdateManager.REQUIRED_ENTRIES`、后台 `admin_server.HU_REQUIRED_ENTRIES` 完全一致；旧口径包现在会被拒（实测返回「zip 缺少必备条目: media_index.py, pinyin_map.json」），完整包正常入库。
- `/objects/*` 补 `Content-Length`：全量下载、Range（`206` + `Content-Range`）、HEAD 三种形态都有正确长度，设备端下载进度不再缺字段。

### v7（2026-09-15）：影视源按测速延时排序

- 后台「影视源」页新增「延时」列、「全部测速」「按延时排序 / 按配置顺序」按钮，每个源也可单独测速；
- 新接口 `POST /api/vod_source_speed`：macms 源打一次 `?ac=list`、hhkan 源打一次站内搜索页，只测一次请求，
  返回 `{ok, latency_ms, status, bytes}`；`vod_source_test`（指定影片测试）同时回报 `latency_ms` 并计入延时列；
- 排序规则：测速成功按毫秒升序 → 测速失败 → 未测速，同档保持配置顺序；测速结果与排序模式存浏览器
  localStorage（`otv_vod_latency_v1` / `otv_vod_sort_v1`），刷新后保留。
