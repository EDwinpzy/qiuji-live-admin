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

## 本地开发与验证

```bash
npm run dev      # 本地预览（node:sqlite 模拟 D1，本地目录模拟 R2）→ http://127.0.0.1:8791/
npm run seed     # 写入样例数据（只写 .dev-state）
npm run smoke    # 44 项端到端冒烟：后台接口 + 设备激活/复验/续费 + 热更 + 电视源发布回滚
python scripts/dev/verify-signature.py   # 用真公钥校验云端补货票据（与设备端同一 canonical）
npm run build && npm run validate
```

账号密码写在 `.dev-state/admin_pass.txt`；本地库 `.dev-state/d1.sqlite`，对象在 `.dev-state/r2/`。

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

1. **站点访问**：现在站点是私有的（仅 ChatGPT 登录可见）。设备（APK）无法带 ChatGPT 身份，所以切域名前要把站点改成公开——后台接口本身仍有账号密码门禁（失败 5 次/分钟锁定），与腾讯云现网同一套保护。
2. **出 v1.26 APK**：`android/app/build.gradle` 与 `internal/mobile/app/build.gradle` 的
   `LICENSE_ENDPOINT` → `https://<站点域名>/activate`，
   `HOTUPDATE_ENDPOINT` → `https://<站点域名>/hotupdate`；
   `IptvRepository.SOURCES[0]` → `https://<站点域名>/iptv/latest`（两个工程各一份）。
3. **数据同步**：切之前再跑一次增量同步（旧站仍在被使用，卡密/激活记录会变）：
   `node scripts/migrate/export-cloudbase.mjs` → `node scripts/migrate/import-to-site.mjs <快照目录> <站点域名>`。
4. **每日推流**：接一个定时器调用 `scripts/ops/iptv-refresh.mjs`（或直接 POST `/iptv/refresh?token=…`），替代 CloudBase 每天 06:30 的 `iptv-rebuild`。
5. **网页版**：`otv-web`（`proxy.py` + `www/`，234KB Python）仍在 CloudBase；迁移或把 `OTV_LICENSE_ENDPOINT`、`IPTV_SOURCES[0]` 指向新站点即可先解耦。
6. **收尾**：设备端观察一个版本周期后，CloudBase 的 activate / hotupdate / iptv-rebuild / otv-admin 可下线，PG 与桶做一次终态归档。
