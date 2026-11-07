# My TV 云端（Sites 版）

> GitHub 仓库：[EDwinpzy/qiuji-live-admin](https://github.com/EDwinpzy/qiuji-live-admin)

My TV 的云端服务，替代原腾讯云 CloudBase 环境，数据与对象自持：

| 原来（CloudBase） | 现在 |
|---|---|
| otv-admin Web 函数（Python） | 同一个 Worker 的 `/api/*` |
| activate / hotupdate 云函数 | `/activate`、`/hotupdate/*` |
| iptv-rebuild 定时函数 | 站点内置每日自触发（06:30 后首个访问）+ 后台「自动重建」+ `/iptv/refresh`（外部强制触发） |
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

## 本机上传热更包（不用浏览器选目录）

后台「热更新」页的「上传最新版本」靠浏览器的目录直读能力，在内嵌浏览器 / 后台窗口里选择框弹不出来。
本机直接跑脚本即可，默认路径已经写死在脚本里（app 工程的 `python-backend.zip`）：

```bash
node scripts/ops/hu-upload.mjs            # 默认路径 + 立即发布
node scripts/ops/hu-upload.mjs --offline  # 只上传（下线态），到后台点「上线」再推给设备
node scripts/ops/hu-upload.mjs --dry-run  # 只登录看看要传什么，不传
```

- 走的是后台同一套接口（`/api/hu_upload_chunk` + `/api/hu_upload_commit`），4MB 分片、每片失败重传 3 次；
- 其它参数：`--file <zip>`、`--name`、`--notes`、`--force`、`--scheduled <时间>`、`--site`；
- 密码取 `OTV_ADMIN_PASS` 或 `My TV/tools/keys/admin_pass.txt`。

## 设备端对接（v1.26 需改）

- `LICENSE_ENDPOINT` → `<站点域名>/activate`
- `HOTUPDATE_ENDPOINT` → `<站点域名>/hotupdate`
- `IptvRepository.SOURCES[0]` → `<站点域名>/iptv/latest`
- 热更包下载地址由 `/hotupdate/check` 返回（`/objects/backend-hu{n}.zip`）

## 与旧系统的差异（已知）

- 热更包分片重组上限 96MB（Worker 内存限制）；更大的包请在本机签发后用直传，或拆包。
- 电视源「自动重建」受 Worker 子请求数限制，单次默认测 60 条线路（`OTV_IPTV_PROBES` 可调，原实现 ~520 条）。
- 每日自动推流不需要本机也不需要外部定时器：每天 06:30（北京时间）之后站点的第一个访问会顺带触发一次重建（仅 auto 模式）；也可用 `POST /iptv/refresh?token=…` 从外部强制触发。

## 状态：已退役（现网为自建 VPS）

本目录是**上一代** Cloudflare 方案（Sites / Worker + D1 + R2）的遗留实现。
CloudBase 与免费域名方案均已退役；现网后台由主仓库的
`tools/admin_server.py` + `tools/admin.html` 提供，运行在自建 VPS 上：

- compose 服务 `admin`，容器内监听 `8791`（`deploy/selfhosted/compose.yaml`）；
- 经 `deploy/selfhosted/nginx.conf` 在站点 `/admin/` 暴露（`/admin` 308 跳 `/admin/`），
  根路径 `/` 同样代理到该服务；
- 账号密码、会话密钥、API 凭据以 Docker secrets 挂载，不入库、不进镜像。

本目录源码与 `scripts/` 运维脚本保留作迁移对照与历史追溯。其中仍在日常发版中使用的：

- `scripts/ops/hu-upload.mjs` — 上传并发布热更包，**必须显式传 `--site <站点地址>`**
  （或环境变量 `SITE_URL`），脚本不再内置默认站点，缺站点直接 exit 2；
- `scripts/ops/license-gen.mjs` — 本机签发卡密并写入后台。

> CloudBase 时代的 `cloudbaserc.json` 等配置已不在版本库中；仅 `scripts/migrate/export-cloudbase.mjs`
> 作为历史数据导出工具保留，其输出目录 `.migrate/` 已被 gitignore。

## 上一代方案的实测存档（2026-09-15，Cloudflare 方案，已退役）

以下记录仅供追溯当时 Worker + D1 + R2 形态的行为，不代表现网。自建 VPS 方案的运维手册见主仓库
`docs/项目文档.md`。

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

- 后台「影视源」页新增「延时」列与「全部测速」按钮，每个源也可单独测速；列表上方不再放排序按钮，
  改为点表头「延时」本身排序：配置顺序 → 由快到慢 → 由慢到快 → 配置顺序，表头带 ▲/▼ 指示，
  列表标题右侧的小字同步显示当前顺序；
- 新接口 `POST /api/vod_source_speed`：macms 源打一次 `?ac=list`、hhkan 源打一次站内搜索页，只测一次请求，
  返回 `{ok, latency_ms, status, bytes}`；`vod_source_test`（指定影片测试）同时回报 `latency_ms` 并计入延时列；
- 排序规则：测速成功按毫秒排 → 测速失败 → 未测速（失败与未测速始终在末尾，同档保持配置顺序）；
  点「全部测速」测完自动切到「由快到慢」，刷新页面回到配置顺序；测速结果存浏览器
  localStorage（`otv_vod_latency_v1`），刷新后保留。
