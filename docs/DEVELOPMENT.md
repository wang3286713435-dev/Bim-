# BIM 招采监控系统开发文档

## 0.1 v1.2 Todo

当前已确认但尚未在 `v1.1` 实现的前端增强项：

1. 输入防抖搜索
2. 高亮命中关键词
3. 支持“仅标题搜索 / 全文字段搜索”切换
4. 支持浅色主题切换

## 1. 当前架构

### 1.1 后端主链路

1. `server/src/jobs/hotspotChecker.ts`
   负责按关键词调度各数据源、调用 AI、保存结果。
2. `server/src/services/tenderSources.ts`
   负责各招采来源的列表抓取与业务过滤。
3. `server/src/services/firecrawl.ts`
   负责详情页正文增强。
4. `server/src/services/ai.ts`
   负责关键词扩展、AI 分析、回退逻辑。
5. `server/src/services/llmProvider.ts`
   负责统一路由到 `OpenRouter` 或 `OpenClaw agent`。
6. `server/src/services/tenderSourceRegistry.ts`
   负责来源注册、启停、查询策略和健康探测。
7. `server/src/services/crawlRunLogger.ts`
   负责抓取运行日志和来源探测日志入库。
8. `server/src/services/runtimeConfig.ts`
   负责运行时配置的默认值、持久化读取、归一化和缓存。

### 1.2 前端

1. `client/src/App.tsx`
   负责监控台首页、来源健康、结构化分布、公告流、关键词页和临时搜索页。
2. `client/src/components/FilterSortBar.tsx`
   负责来源和排序筛选。
3. `client/src/services/api.ts`
   负责前端对 `ops/summary`、`runs`、`runtime` 等新接口的类型与调用封装。

### 1.3 Skill

1. `skills/bim-tender-monitor/SKILL.md`
2. `skills/bim-tender-monitor/references/source-playbook.md`

## 2. 环境变量

在 `server/.env` 中配置：

```env
PORT=3001
CLIENT_URL=http://localhost:5173

AI_PROVIDER=openclaw
OPENCLAW_AGENT_ID=bim-tender
OPENCLAW_BIN=openclaw
OPENCLAW_TIMEOUT_MS=180000

OPENROUTER_API_KEY=
OPENROUTER_MODEL=deepseek/deepseek-v3.2

FIRECRAWL_API_KEY=your_firecrawl_api_key_here
FIRECRAWL_BASE_URL=https://api.firecrawl.dev
FIRECRAWL_TIMEOUT_MS=30000
FIRECRAWL_CACHE_TTL_MS=86400000
FIRECRAWL_CACHE_FILE=.cache/firecrawl-cache.json
```

说明：

1. `AI_PROVIDER=openclaw` 时，后端通过 `openclaw agent --agent bim-tender ... --json` 调用 gateway。
2. `AI_PROVIDER=openrouter` 时，后端直连 OpenRouter。
3. `FIRECRAWL_API_KEY` 用于详情页正文增强。
4. `FIRECRAWL_CACHE_FILE` 和 `FIRECRAWL_CACHE_TTL_MS` 控制详情页缓存。

## 3. OpenClaw 集成说明

### 3.1 当前实现

`server/src/services/llmProvider.ts` 统一封装两种 provider：

1. `OpenRouter`
2. `OpenClaw agent`

OpenClaw 调用策略：

1. 走 `openclaw agent --agent bim-tender --message ... --json`
2. 不使用 `--local`
3. 关闭高思考等级：`--thinking off`
4. timeout 放宽到 180 秒
5. 从返回 JSON 中提取 `result.payloads[0].text`

### 3.2 已验证情况

1. OpenClaw dashboard 中 agent 可正常对话。
2. CLI 通过 gateway 调用在本机已成功返回 JSON。
3. 首次/冷启动耗时可能较长，实测约 37 秒。

## 4. Firecrawl 集成说明

### 4.1 当前策略

Firecrawl 只负责详情页增强，不替代列表页抓取。

原因：

1. 列表页已有稳定公开接口。
2. Firecrawl 更适合清洗详情页正文。
3. 这样成本更低，稳定性更高。

### 4.2 代码入口

`server/src/services/firecrawl.ts`

主要函数：

1. `isFirecrawlEnabled()`
2. `shouldEnrichWithFirecrawl()`
3. `scrapeWithFirecrawl()`
4. `enrichResultWithFirecrawl()`

### 4.3 缓存

Firecrawl 已增加本地文件缓存：

1. 默认缓存文件：`server/.cache/firecrawl-cache.json`
2. 默认 TTL：24 小时
3. 先查内存，再查磁盘，再请求远程 API
4. 适合重复访问同一公告详情页的场景

## 5. 数据源策略

### 5.1 已接入来源

1. `szggzy`
2. `szygcgpt`
3. `guangdong`
4. `gzebpubservice`

### 5.2 设计原则

1. 每个站点一个 source adapter。
2. 列表抓取和详情增强分离。
3. 统一输出 `SearchResult`。
4. 业务过滤放在 source adapter 层。
5. 产品默认只启用上述四个政府/招采来源；原开源项目里的 Twitter、Bing、Bilibili、微博等泛热点来源不参与扫描和默认展示。

### 5.3 v1.0 来源注册表

v1.0 开始，来源统一收口到：

`server/src/services/tenderSourceRegistry.ts`

职责：

1. 维护来源列表、优先级、主页
2. 根据 `TENDER_SOURCES` 控制启用/停用
3. 统一生成搜索 query variants
4. 提供来源探测能力
5. 维护来源运行时状态（重试 / 熔断 / 冷却）
6. 为后续新增来源提供单一扩展点

后续新增来源的标准步骤：

1. 在 `server/src/services/tenderSources.ts` 新增 adapter
2. 在 `server/src/services/tenderSourceRegistry.ts` 注册
3. 用 `/api/hotspots/sources` 验证探测结果

## 6. 默认关键词初始化

系统启动时会自动幂等初始化一组默认 BIM 关键词，代码位置：

`server/src/startup/defaultKeywords.ts`

当前策略：

1. 启动即执行
2. 使用 `upsert`
3. 不会重复插入
4. 自动归类到 `bim-tender`

## 6.1 默认运行时配置初始化

系统启动时也会自动幂等写入一组后端运行时配置，代码位置：

`server/src/startup/defaultSettings.ts`

当前初始化内容包括：

1. 启用来源 `TENDER_SOURCES`
2. 新鲜度窗口 `TENDER_MAX_AGE_DAYS`
3. 单来源抓取条数 `TENDER_SOURCE_RESULT_LIMIT`
4. 单关键词处理条数 `TENDER_RESULTS_PER_KEYWORD`
5. query variants 数量 `TENDER_QUERY_VARIANTS_PER_KEYWORD`
6. 重试、熔断、冷却参数
7. 低价值数据黑白名单
8. AI 相关性阈值

## 7. 常用命令

### 6.1 构建

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run build

cd /Users/Weishengsu/dev/yupi-hot-monitor/client
npm run build
```

### 6.2 启动

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run dev

cd /Users/Weishengsu/dev/yupi-hot-monitor/client
npm run dev
```

### 6.3 手动搜索

```bash
curl -sS -X POST http://localhost:3001/api/hotspots/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"BIM咨询","sources":["szggzy","szygcgpt","guangdong"]}'
```

### 6.4 手动触发监控

```bash
curl -sS -X POST http://localhost:3001/api/check-hotspots
```

### 6.5 来源探测

```bash
curl -sS 'http://localhost:3001/api/hotspots/sources?query=BIM&limit=1'
```

用于验证每个来源：

1. 是否启用
2. 是否探测成功
3. 返回条数
4. 耗时
5. 样例标题和样例链接

### 6.6 抓取运行日志

```bash
curl -sS 'http://localhost:3001/api/hotspots/runs?limit=10'
```

返回：

1. 每次关键词扫描对应一条 `CrawlRun`
2. 每个来源探测结果对应一条 `SourceProbe`
3. 可用于排查“为什么没数据”而不是只看最终前端

### 6.7 后端运行概览

```bash
curl -sS 'http://localhost:3001/api/hotspots/ops/summary'
```

返回：

1. 当前统计总览
2. 运行时配置快照
3. 来源健康探测结果
4. 最近 10 次抓取运行摘要
5. 最近 24 小时失败来源汇总

### 6.8 运行时配置中心

查看运行时配置：

```bash
curl -sS http://localhost:3001/api/settings/runtime
```

更新运行时配置：

```bash
curl -sS -X PUT http://localhost:3001/api/settings/runtime \
  -H 'Content-Type: application/json' \
  -d '{"queryVariantsPerKeyword":2,"sourceRetryCount":2}'
```

查看来源配置：

```bash
curl -sS http://localhost:3001/api/settings/sources
```

更新启用来源：

```bash
curl -sS -X PUT http://localhost:3001/api/settings/sources \
  -H 'Content-Type: application/json' \
  -d '{"sources":["szggzy","szygcgpt","guangdong","gzebpubservice"]}'
```

### 6.9 清理旧泛热点数据

如果本地数据库里已经有原项目的 Bing、Bilibili、微博等旧数据，可以选择清理。执行前先确认不需要保留这些历史记录：

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
sqlite3 prisma/dev.db "DELETE FROM Hotspot WHERE source NOT IN ('szggzy','szygcgpt','guangdong','gzebpubservice'); DELETE FROM Notification WHERE hotspotId IS NOT NULL AND hotspotId NOT IN (SELECT id FROM Hotspot);"
```

## 8. 结构化招采字段

Hotspot 已增加招采结构化字段：

1. `tenderType`：BIM 招采分类
2. `tenderRegion`：地区
3. `tenderCity`：城市/站点
4. `tenderUnit`：招标/采购/建设单位
5. `tenderBudgetWan`：预算金额，单位万元
6. `tenderDeadline`：截止时间
7. `tenderNoticeType`：公告类型
8. `tenderPlatform`：平台名称

这些字段由 `server/src/services/tenderSources.ts` 的 source adapter 生成，并在 `server/src/jobs/hotspotChecker.ts` 入库。前端卡片会优先展示这些结构化招采信息。

## 8.1 当前前端监控台结构

前端首页已从“热点列表页”调整为“BIM 招采监控台”，当前包含：

1. 顶部概览指标：总公告、今日新增、紧急机会、活跃监控词
2. 来源健康卡片：直接显示后端来源探测状态
3. 结构化分布：来源贡献、地区分布、预算区间、截止时间、BIM 类型
4. 最近扫描：展示最近抓取运行摘要
5. 招采公告流：保留筛选和分页
6. 高价值机会侧栏：按重要度和相关性优先排序
7. 监控词页：支持启停、删除、新增
8. 临时搜索页：支持先试词、再决定是否加入长期监控

## 9. 运行可观测性

Prisma 新增模型：

1. `CrawlRun`
2. `SourceProbe`

用途：

1. 记录每个关键词扫描的 raw / unique / fresh / saved 数量
2. 记录每个来源在该次扫描中的返回条数、耗时、样例标题、错误信息
3. 为后续后台管理和可视化诊断页提供基础数据

## 10. 结构化筛选

后端 `/api/hotspots` 已支持以下招采字段筛选：

1. `tenderType`：精确匹配 BIM 分类，例如 `设计BIM`
2. `tenderRegion`：匹配 `tenderRegion` 或 `tenderCity`
3. `tenderMinBudgetWan`：最低预算，单位万元
4. `tenderMaxBudgetWan`：最高预算，单位万元
5. `tenderDeadlineRange`：`open`、`expired`、`7d`、`30d`
6. `tenderDeadlineFrom` / `tenderDeadlineTo`：自定义截止时间范围
7. `tenderPlatform`：精确匹配平台名称

前端筛选栏已同步支持 BIM 类型、地区、预算、截止时间和平台筛选。手动搜索结果暂不入库，因此在浏览器端执行同样的结构化过滤逻辑。

示例：

```bash
curl -sS 'http://localhost:3001/api/hotspots?tenderType=设计BIM&tenderRegion=深圳&tenderMinBudgetWan=100&tenderDeadlineRange=open'
```

## 11. v1.0 配置建议

建议在正式环境明确配置：

1. `TENDER_SOURCES`
2. `TENDER_MAX_AGE_DAYS`
3. `TENDER_SOURCE_RESULT_LIMIT`
4. `TENDER_RESULTS_PER_KEYWORD`
5. `TENDER_QUERY_VARIANTS_PER_KEYWORD`
6. `GUANGDONG_MAX_PAGES`
7. `AI_PROVIDER`
8. `FIRECRAWL_API_KEY`
9. `TENDER_SOURCE_RETRY_COUNT`
10. `TENDER_SOURCE_RETRY_DELAY_MS`
11. `TENDER_SOURCE_CIRCUIT_BREAKER_THRESHOLD`
12. `TENDER_SOURCE_CIRCUIT_BREAKER_COOLDOWN_MS`

## 12. 后续开发建议

1. 将关键词做成来源级模板配置，而不只是普通字符串。
2. 基于结构化字段增加趋势报表和导出。
3. 给 `gzebpubservice` 增加替代策略或禁用开关。
4. 将 skill 再补成标准交付包，供其他 agent 直接接入。

## 13. 广东与广州详情链接稳定化

2026-04-22 已补充详情链接稳定策略：

1. 广东平台 `R` 类公告优先调用官方详情链路解析 `nodeId`：`/ggzy-portal/center/apis/trading-notice/new/singleNode`，失败后再尝试 `/ggzy-portal/center/apis/trading-notice/new/nodeList`。
2. 广东平台 `A` 类深圳工程公告在广东详情链路返回空 `nodeId` 时，回退到深圳公共资源交易中心按标题精确检索，并使用深圳详情页作为可访问详情 URL。
3. 广州公共资源交易公共服务平台在入库前过滤高风险 `002001004*` 目录，并对候选详情 URL 做 HTTP 可达性校验；不可达链接不再返回给入库流程。
4. 已清理本地 SQLite 中旧的广东错误 URL 和广州 404 URL。

已验证样例：

1. `宝深路（洪浪南路-沙河西路）交通改善工程设计（含BIM）` 已回退为深圳详情页：`https://www.szggzy.com/globalSearch/details.html?contentId=20339108`
2. `东莞市道滘镇九横丫城中村改造安置房建设项目一期项目BIM技术服务` 已补齐 `nodeId=1947866755282407426`
3. 当前本地库中的 `gzebpubservice` 样例详情页 HTTP 状态均为 200

## 14. v1.0 后端收口原则

当前后端抓取链路按以下边界维护：

1. `server/src/services/tenderSourceRegistry.ts` 是数据源注册入口，新增来源先在这里登记来源 ID、平台名、优先级和搜索 adapter。
2. `server/src/services/tenderSources.ts` 只负责各来源的搜索、详情 URL 解析、结构化字段提取和来源内过滤。
3. 详情 URL 必须在 adapter 内解析成可人工打开的最终链接；无法解析出可靠详情页的记录应跳过，不再把“看似正确但无数据”的 SPA 路由写入数据库。
4. 广东平台详情策略已固化为：`R` 类走广东 `nodeId` 官方链路，深圳 `A` 类走深圳交易中心标题回查 fallback，其他无 `nodeId` 的广东记录暂不入库。
5. 广州平台详情策略已固化为：先排除高风险分类目录，再做 HTTP 可达性校验，不可达链接不入库。
6. 前端数据分析目前基于后端已过滤后的公告数据计算，后续如果数据量增大，再把分析计算下沉到后端专用 analytics 接口。

新增数据源时必须满足：

1. 返回 `SearchResult[]`
2. `url` 是可打开详情页，不是仅可进入壳页面的 SPA 路由
3. 尽量填充 `tender.type / region / city / unit / budgetWan / deadline / noticeType / platform`
4. 对 404、空详情、跳转异常做 adapter 内过滤
5. 在 `/api/hotspots/sources?query=BIM&limit=1` 中能返回健康探测结果

## 15. 前端投标机会看板改造

2026-04-22 开始将前端从“热点信息流”改为“投标机会看板”：

1. 公告卡片主信息改为项目标题、来源平台、公告阶段、地区、招标/采购单位、预算、截止时间、BIM 类型和发布时间。
2. 不再在主卡片展示摘要优先，也不再展示历史 fallback AI 文案，例如“未配置 AI 服务，使用默认分数”。
3. 卡片新增投标动作建议，用于提示“立即核对投标窗口 / 补齐单位预算 / 评估设计团队匹配度”等业务动作。
4. 首页数据分析快照新增字段完整度，弱化热点相关性表达，转向投标业务判断。
5. 高价值机会排序增加预算、截止时间、招标单位等业务字段权重，不再只按热点重要度和相关性排序。

历史数据中仍可能保留旧 AI 字段，前端已做展示层屏蔽；后续可做一次旧数据 AI 重算或字段清理。

## 16. AI 投标机会分析与后台扫描

2026-04-22 已将 AI 分析目标从“热点相关性判断”调整为“投标机会判断”：

1. AI 现在按投标经营视角分析公告，重点判断项目是否值得跟进。
2. AI 输出的 `relevance` 被解释为“作为公司投标线索的价值分”，不再是普通文本热度或泛相关性。
3. AI 提示词要求关注项目名称、招标/采购单位、地区、公告阶段、预算/控制价、截止时间、BIM 服务范围、资质/履约风险和建议动作。
4. 前端触发扫描不再等待整轮抓取和 AI 分析完成，`POST /api/check-hotspots` 会立即返回 `202 Accepted`，后台继续执行扫描。
5. 健康接口 `/api/health` 会返回 `hotspotCheckQueue`，用于观察后台扫描是否正在运行。
6. 前端新增首位 Tab：`投标机会`，`数据分析` 被放到第二位，符合招采应用的信息优先级。

补充：OpenClaw 在本机偶发响应很慢或超时。为避免扫描任务卡死，AI 失败时不再写入“默认分数”文案，而是进入规则化投标分析 fallback，生成可读的投标要点、关键词命中、预算/截止字段提示。前端会继续隐藏历史 fallback 文案。

## 17. 详情页深度字段提取

2026-04-22 新增抓取后的详情页深度解析环节。流程变为：

1. 列表页抓取候选公告。
2. 规则过滤和去重。
3. 对剩余少量公告访问详情页，优先复用来源详情接口和 Firecrawl 渲染正文。
4. 从详情正文中提取投标筛选字段。
5. 将字段写入 Hotspot 表，供前端投标机会清单展示和筛选。

新增字段：

1. `tenderProjectCode`：项目编号/招标编号/采购编号
2. `tenderContact`：联系人
3. `tenderPhone`：联系电话
4. `tenderEmail`：邮箱
5. `tenderBidOpenTime`：开标时间
6. `tenderDocDeadline`：招标/采购文件获取截止时间
7. `tenderServiceScope`：服务范围/采购内容
8. `tenderQualification`：资格/资质要求
9. `tenderAddress`：开标/递交/项目地点
10. `tenderDetailSource`：字段来源，例如 `firecrawl+rules`
11. `tenderDetailExtractedAt`：详情字段提取时间

本轮已对历史数据做一次规则回填：33 条招采数据中，已补到截止时间 17 条、预算 5 条、单位 27 条、项目编号 5 条、服务范围 6 条。后续新入库公告会自动走这个环节。

## 18. 详情二段深抓取（Agent 化增强）

2026-04-22 在原有规则提取基础上，新增低完整度公告的二段详情增强：

1. `server/src/services/firecrawl.ts` 新增 `scrapeTenderDetailWithFirecrawl(url)`，对低完整度详情页使用更重的 Firecrawl 抓取参数。
2. 二段抓取会请求更长的正文，并通过 Firecrawl 的 `json` 提取返回结构化字段：单位、预算、截止时间、项目编号、联系人、电话、邮箱、开标时间、文件获取截止、服务范围、资格要求、地点。
3. `server/src/services/tenderDetailEnrichment.ts` 中，当首轮规则提取后的字段完整度仍低于 50 分时，会自动进入二段深抓取。
4. 二段结果会与首轮规则结果做合并，以更完整、更长的字段为优先，同时保留已有可信字段。
5. `tenderDetailSource` 现可记录 `firecrawl-detail-json` / `detail-enrichment+agent-firecrawl` 等来源，方便后续观察哪类详情增强更有效。

这一步仍属于后端可控的“轻浏览器/Agent 化增强”，优先解决多数详情页字段缺失问题；如果后续仍有站点必须真实点击、翻页或处理复杂前端交互，再单独补 Playwright / interact 层。

## 19. 飞书通知与多维表格同步

2026-04-22 已新增飞书集成基础能力：

1. `server/src/services/feishu.ts` 支持飞书群机器人 webhook 推送互动卡片。
2. 新发现招采公告入库后，会自动调用飞书通知。
3. 当配置了飞书应用与多维表格参数后，会同步把结构化字段写入飞书多维表格。
4. `/api/health` 新增 `integrations.feishuWebhookEnabled` 与 `integrations.feishuBitableEnabled`，方便确认配置状态。

环境变量：

1. `FEISHU_BOT_WEBHOOK_URL`
2. `FEISHU_BOT_SECRET`（可选，如果群机器人启用了签名）
3. `FEISHU_APP_ID`
4. `FEISHU_APP_SECRET`
5. `FEISHU_BITABLE_APP_TOKEN`
6. `FEISHU_BITABLE_TABLE_ID`

当前默认策略：

1. webhook 推群消息：开箱即用，成本最低。
2. 多维表格写入：作为结构化存档层，后续可继续扩展字段映射。

## 20. 飞书全量同步与字段映射升级

2026-04-22 已完成飞书多维表格全量同步能力，并按现有旧表结构做字段映射升级：

1. 通过飞书 API 读取旧表结构，确认现有主字段为：`项目名称`、`地区`、`类型`、`发布时间`、`招标人`、`预算`、`截止日期`、`平台来源`、`招标文件链接`、`状态`、`优先级`、`搜索关键词`、`联系人`。
2. 新增缺失字段：`系统ID`、`项目编号`、`开标时间`、`文件截止`、`联系电话`、`邮箱`、`服务范围`、`资格要求`、`详情来源`、`解析时间`、`相关性`、`摘要`。
3. 新增 `server/src/scripts/syncFeishuBitable.ts`，支持将本地 SQLite 中的招采公告全量同步到飞书多维表格。
4. 同步策略默认不清空旧表，而是按 `系统ID -> 招标文件链接 -> 项目名称` 顺序匹配并更新，避免重复写入。
5. `npm run sync:feishu -- --limit=40` 已验证通过：本轮同步 `32` 条，`updated=32`，未清空旧数据。
6. 如后续确需覆盖原表，可使用脚本的 `--clear` 模式；该模式会删除云端原有记录，执行前需再次确认。

当前飞书映射：

1. `项目名称` <- `hotspot.title`
2. `地区` <- `tenderRegion / tenderCity`
3. `类型` <- `tenderType`
4. `发布时间` <- `publishedAt`
5. `招标人` <- `tenderUnit`
6. `预算` <- `tenderBudgetWan`
7. `截止日期` <- `tenderDeadline / tenderBidOpenTime / tenderDocDeadline`
8. `平台来源` <- 来源站点映射名称
9. `招标文件链接` <- 原始公告 URL
10. `状态` <- 是否已截止 / 是否待确认
11. `优先级` <- 基于重要性与相关性映射为 `高/中`
12. `搜索关键词` <- 监控词
13. 新增富字段用于后续业务协作与筛选

## 21. 飞书推送规则优化与业务字段升级

2026-04-22 已进一步优化飞书群推送与多维表格字段：

1. 飞书群 webhook 不再对所有新公告都发消息，而是只推送“未截止 + 字段完整度较高 + 价值较高”的项目，减少群噪音。
2. 新增字段完整度算法，按单位、预算、截止、项目编号、服务范围、资格要求、联系方式、详情来源等关键字段综合评分。
3. 新增业务判断逻辑，生成：
   - `建议动作`
   - `商机判断`
   - `详情可靠性`
4. 多维表格新增并同步字段：
   - `字段完整度`
   - `建议动作`
   - `商机判断`
   - `详情可靠性`
5. 已执行一轮全量同步，结果：`updated=32`，并成功创建上述 4 个新字段。

当前飞书使用策略：

1. 群消息用于高价值、可跟进项目提醒。
2. 多维表格用于完整业务协作和项目池管理。
3. 后续如需进一步减少群消息数量，可继续增加预算门槛、截止时间窗口和地区范围限制。
