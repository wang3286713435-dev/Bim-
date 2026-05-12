# BIM Tender Monitor

面向 BIM 招投标场景的政府招采监控系统。项目基于原开源项目二次开发，当前聚焦深圳、广东、广州及全国级公开招采平台，输出真正可跟进的 BIM 投标机会，而不是泛热点列表。

## 当前版本

- `v1.6.18`（新增登录保护，匿名访问无法直接看到监控数据）
- 运行模式：后端托管前端的单应用模式
- 默认访问地址：[http://localhost:3001](http://localhost:3001)

## CEB 详情会话复用

- `CEB_DETAIL_FETCH_ENABLED=true`：开启 CEB 详情接口探测
- `CEB_DETAIL_COOKIE=...`：直接传浏览器已验证 Cookie
- `CEB_DETAIL_SESSION_FILE=/abs/path/ceb-session.json`：从文件读取 Cookie / UA / Referer / 额外请求头
- `npm --prefix server run probe:ceb-detail-session -- --query=BIM`：验证当前会话是否可用

会话文件示例：

```json
{
  "cookie": "acw_tc=...; JSESSIONID=...; ...",
  "userAgent": "Mozilla/5.0 ...",
  "referer": "https://ctbpsp.com/#/bulletinDetail?uuid=...",
  "extraHeaders": {
    "X-Requested-With": "XMLHttpRequest"
  }
}
```

推荐做法：

- 把真实会话文件放到 `/Users/Weishengsu/dev/yupi-hot-monitor/.secrets/ceb-session.json`
- 参考模板：[docs/ceb-session.example.json](/Users/Weishengsu/dev/yupi-hot-monitor/docs/ceb-session.example.json)
- 然后告诉我这个路径，或者让我直接按默认路径读取

## 核心能力

- 聚焦 BIM 招采来源：深圳、广东、广州及全国级公开招采平台，当前默认包含 `szggzy`、`szygcgpt`、`guangdong`、`gzebpubservice`、`ccgp`、`ggzyNational`、`cebpubservice`
- 列表抓取、详情增强、AI 识别、结构化字段提取、入库展示全链路闭环
- 投标机会清单与项目详情页分层展示
- 招采结构化筛选：地区、预算、截止时间、平台、BIM 类型
- Firecrawl 详情增强与二段深度解析队列
- OpenClaw / OpenRouter AI provider 路由
- 飞书群推送 + 飞书多维表格全量/增量同步
- 单应用部署，适合直接上云服务器

## 当前数据源

- 深圳公共资源交易中心 `szggzy`
- 深圳阳光采购平台 `szygcgpt`
- 广东省公共资源交易平台 `guangdong`
- 广州公共资源交易公共服务平台 `gzebpubservice`
- 中国政府采购网 `ccgp`
- 全国公共资源交易平台 `ggzyNational`
- 中国招标投标公共服务平台 `cebpubservice`

## 项目结构

```text
client/   React 前端
server/   Express + Prisma + SQLite 后端
docs/     需求、开发、交接文档
skills/   BIM 招采监控 Skill
```

## 快速开始

### 环境要求

- Node.js 20 LTS 推荐
- npm 10+
- SQLite（默认使用 Prisma 本地文件库）
- 可选：Firecrawl、OpenClaw、飞书开放平台配置

### 安装依赖

```bash
git clone <your-repo-url>
cd yupi-hot-monitor

npm --prefix client install
npm --prefix server install
cd server
npx prisma generate
npx prisma db push
```

### 环境变量

复制并编辑 `/Users/Weishengsu/dev/yupi-hot-monitor/server/.env.example`：

```bash
cp server/.env.example server/.env
```

常用配置：

```env
PORT=3001
HOTSPOT_CHECK_CRON=0 0 * * *
HOTSPOT_CHECK_INTERVAL_HOURS=24
AUTH_USERNAME=admin
AUTH_PASSWORD=88888888
AUTH_SESSION_SECRET=change_this_before_public_release
AUTH_SESSION_TTL_HOURS=168
AUTH_COOKIE_SECURE=false
AI_PROVIDER=openclaw
OPENCLAW_AGENT_ID=bim-tender
OPENCLAW_ANALYSIS_AGENT_ID=main
OPENCLAW_ANALYSIS_LOCAL=true
OPENCLAW_DETAIL_AGENT_ID=bim-tender
OPENCLAW_DETAIL_LOCAL=false
OPENCLAW_BIN=/Users/yourname/.openclaw/bin/openclaw
OPENCLAW_TIMEOUT_MS=180000
TENDER_KEYWORD_COOLDOWN_ZERO_SAVE_THRESHOLD=4
TENDER_KEYWORD_COOLDOWN_HOURS=24
TENDER_KEYWORD_COOLDOWN_LOOKBACK_DAYS=14

FIRECRAWL_API_KEY=
FEISHU_BOT_WEBHOOK_URL=
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BITABLE_APP_TOKEN=
FEISHU_BITABLE_TABLE_ID=
```

推荐口径：

- `OPENCLAW_ANALYSIS_AGENT_ID=main`：列表相关性判断走更轻、更稳的分析 agent。
- `OPENCLAW_ANALYSIS_LOCAL=true`：服务端分析优先跳过 gateway，直接走本地 runtime，减少超时和 session 抖动。
- `OPENCLAW_DETAIL_AGENT_ID=bim-tender`：详情字段补强继续使用更重的专用 agent。
- `OPENCLAW_DETAIL_LOCAL=false`：默认保守，避免浏览器型详情任务在不兼容环境下被过早切到本地模式。
- `HOTSPOT_CHECK_*`：默认每天 `00:00` 扫描一次，降低高频探测导致的 WAF 风险。
- `AUTH_*`：访问保护配置。默认账号密码是 `admin / 88888888`，正式对外前建议至少修改密码和 `AUTH_SESSION_SECRET`。
- `TENDER_KEYWORD_COOLDOWN_*`：对连续多轮 `0 saved` 的关键词做自动降频；默认达到 `4` 轮连续零产出后冷却 `24h`，减少空转扫描。

### 本地开发

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run dev

cd /Users/Weishengsu/dev/yupi-hot-monitor/client
npm run dev
```

开发模式地址：

- 前端：[http://localhost:5173](http://localhost:5173)
- 后端：[http://localhost:3001](http://localhost:3001)

### v1.2 单应用运行

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run build:app
npm run start
```

运行后直接访问：

- 应用首页：[http://localhost:3001](http://localhost:3001)
- 健康检查：[http://localhost:3001/api/health](http://localhost:3001/api/health)

## 生产部署

推荐统一使用仓库自带脚本，避免把本地 SQLite 数据库、`.env`、`.secrets`、构建产物误同步到生产机：

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor
./scripts/deploy_production.sh
```

可选参数：

```bash
./scripts/deploy_production.sh root@134.175.238.186
```

脚本默认会：

- 先备份生产目录到 `/opt/bim-tender-backups/<timestamp>/`
- `rsync` 同步代码，但明确排除：
  - `server/prisma/dev.db`
  - `server/prisma/dev.db-journal`
  - `server/.env`
  - `.secrets`
  - `client/dist`
  - `server/dist`
- 在服务器上重新构建前后端
- 重启 `bim-tender.service`
- 最后打印 `/api/health`

如果需要覆盖默认值，可以设置这些环境变量：

```bash
DEPLOY_HOST=root@134.175.238.186
DEPLOY_REMOTE_DIR=/opt/bim-tender
DEPLOY_SERVICE=bim-tender.service
DEPLOY_OWNER=admin:admin
DEPLOY_RUN_USER=admin
```

## 常用命令

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run build
npm run build:app
npm run start
npm run sync:feishu -- --limit=40
```

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/client
npm run build
```

## 飞书同步

当前已支持：

- 飞书群机器人项目卡片推送
- 飞书多维表格字段同步
- 全量同步脚本：`npm run sync:feishu`

建议在飞书表中使用这些业务字段：

- 项目名称
- 地区
- 类型
- 发布时间
- 招标人
- 预算
- 截止日期
- 平台来源
- 招标文件链接
- 状态
- 优先级
- 搜索关键词
- 联系人
- 系统ID
- 项目编号
- 开标时间
- 文件截止
- 联系电话
- 邮箱
- 服务范围
- 资格要求
- 字段完整度
- 建议动作
- 商机判断
- 详情可靠性
- 摘要

## 文档

- 开发文档：`/Users/Weishengsu/dev/yupi-hot-monitor/docs/DEVELOPMENT.md`
- 需求文档：`/Users/Weishengsu/dev/yupi-hot-monitor/docs/REQUIREMENTS.md`
- 上下文交接：`/Users/Weishengsu/dev/yupi-hot-monitor/docs/CONTEXT_HANDOFF.md`
- 本地运行：`/Users/Weishengsu/dev/yupi-hot-monitor/docs/LOCAL_SETUP.md`
- 版本记录：`/Users/Weishengsu/dev/yupi-hot-monitor/CHANGELOG.md`

## 部署建议

腾讯云 `2 核 4G` 可以先承载 `v1.2`：

- `pm2` 或 `systemd` 托管 `node dist/index.js`
- `Nginx` 反向代理到 `3001`
- SQLite 先作为主库，后续可迁移 MySQL
- 将 `.env` 单独维护在服务器

最小部署流程：

```bash
cd /opt/bim-tender
npm --prefix client install
npm --prefix server install
cd server
npx prisma generate
npx prisma db push
npm run build:app
npm run start
```

## 版本计划

- `v1.1.0`：单应用部署、飞书同步、投标机会清单、详情页、数据库模糊搜索
- `v1.2.0`：搜索建议、保存筛选视图、批量操作、浅色主题收口、监控日志与列表/筛选体验优化（已结束）
- `v1.3.0`：后端稳定性、脏数据治理、广州源专项稳定化、AI/飞书可观测（已结束）
- `v1.4.0`：新增数据源接入、adapter 模板、数据源接入 checklist、新源验收闸门、字段质量趋势（已收口）
- `v1.5.0`：中国招标投标公共服务平台专项，字段完整性、详情降级和反爬状态可解释（开发中）

## License

本仓库基于原开源项目二次开发，请在对外发布时保留原作者与上游项目说明，并根据你的实际发布策略补充许可证信息。
