# BIM 招采监控系统开发文档

## 0.1 v1.2 Todo

当前 `v1.2` 开发状态：

### 已完成

1. 输入防抖搜索
2. 高亮命中关键词
3. 支持“仅标题搜索 / 全文字段搜索”切换
4. 支持浅色主题切换（已收口为语义化主题变量方案）
5. 持续优化投标机会列表的信息密度与交互细节
6. 浅色主题已覆盖投标机会 / 数据分析 / 详情页 / 监控词 / 临时搜索主链路
7. 搜索建议与最近搜索记录
8. 保存常用筛选视图
9. 机会卡片批量操作

### 部分完成

1. 飞书投递回执与抓取状态时间线
   - 已有监控日志、抓取摘要、飞书启用状态、后端健康状态
   - 还缺逐次投递结果与时间线视图
2. 统一来源失败口径展示，区分探测失败与整轮任务失败
   - 已把前端口径改为“24h 探测失败”
   - 还未补齐整轮失败统计接口和展示

### 未完成

1. 当前无明确未完成项，剩余工作集中在部分完成项的深化

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

## 22. 服务器数据质量巡检（2026-04-23）

已对广州腾讯云 `134.175.238.186` 上的 `v1.2.0` 运行库做了一轮巡检，当前结论如下：

1. 当前数据库总记录 `57` 条，其中四个招采来源记录 `32` 条，其余仍有历史遗留的 `sogou / bing / bilibili` 旧数据。
2. 四个招采来源字段覆盖率：
   - `tenderUnit`：`28 / 32`
   - `tenderBudgetWan`：`10 / 32`
   - `tenderDeadline`：`21 / 32`
   - `tenderContact`：`2 / 32`
   - `tenderPhone`：`5 / 32`
3. 当前识别到的脏数据样本主要有两类：
   - `szggzy`：单位字段被“项目名称/预算金额”等表格标签污染
   - `gzebpubservice`：单位字段被“联系地址/联系人/招标代理机构”整段正文拼进来
4. 当前识别到的坏链接样本：
   - `gzebpubservice` 仍存在 1 条 `jyxt.gzggzy.cn/ggzy/jsgc/#/show-bid-opening/list/...` 类型链接，应继续过滤
5. 这些问题说明后端的详情增强链路已具备效果，但还需要继续做“脏值替换”和“来源专属字段模板”。

## 23. 失败口径拆分（2026-04-23）

为避免前端将来源故障看成同一类问题，`/api/hotspots/ops/summary` 已拆出两套统计：

1. `probeFailureSummary24h`
   - 探测级失败次数
   - 一个来源在同一轮内对多个关键词连续失败，会累计多次
2. `runFailureSummary24h`
   - 轮次级异常次数
   - 同一轮抓取里某来源只要失败过一次，就记为该来源 `1` 次轮次异常

前端 `来源健康` 与 `监控日志` 已同步显示：

1. `24h 探测失败`
2. `24h 轮次异常`

这套口径更适合后续做来源诊断、告警阈值和降噪策略。

## 24. v1.3 规划

明天优先推进 `v1.3`，重点从“功能补充”转到“后端质量和扩展性”：

1. 扫描服务器脏数据并做批量修复脚本
2. 为四条主来源补来源级字段清洗模板
3. 继续完善详情增强，优先修预算、截止、联系人、联系电话、资质要求
4. 为来源健康增加错误原因聚合、异常趋势和自动降噪
5. 接入新增数据源，并保持来源注册表扩展方式不变
6. 前端补数据质量与来源诊断展示，不与主机会清单抢主视觉

## 25. 多出口代理池骨架（2026-04-23）

已开始为高风险来源铺多出口代理池骨架，目标是后续把其它公网服务器接成备用出口：

1. 新增 `server/src/services/proxyPool.ts`
2. 当前支持通过环境变量 `TENDER_PROXY_POOL` 配置 HTTP 代理池
3. 已接入的来源请求：
   - `szggzy`
   - `szygcgpt`
   - `guangdong`
   - `gzebpubservice`
4. 当前策略：
   - 按来源选择 source-specific 代理
   - 若无来源专属代理，则回退到 `default`
   - 轮询选择可用代理
   - 记录每个代理的失败次数、最近成功、最近失败、最近错误
5. 当前前端 `监控日志` 已能看到出口池状态；如果未配置代理，会明确显示“默认使用主机本机出口”。

注意：

1. 这一步只是“后端代理池骨架”，还没有真正接入你另外两台服务器。
2. 要真正实现 IP 池轮换，需要把那两台服务器配置成 HTTP 代理或抓取 worker，而不是只知道它们的公网 IP。

补充：已新增脚本 `server/src/scripts/repairTenderData.ts`，并在 `server/package.json` 提供：

1. `npm run repair:tender-data -- --dry-run`
2. `npm run repair:tender-data -- --apply --purge-legacy`

当前脚本能力：

1. 识别并清理 `tenderUnit / tenderContact / tenderPhone` 中的标签污染值
2. 删除已知坏链接记录（当前主要是 `gzebpubservice` 的 `show-bid-opening/list` 路由）
3. 可选清理历史非招采来源旧数据
4. 对修复过的记录自动重新触发详情增强

## 26. 代理池健康优先选择（2026-04-24）

为避免高风险来源在“坏出口”上反复消耗重试，本轮已将代理池从简单轮询升级为健康优先选择：

1. `server/src/services/proxyPool.ts` 新增健康排序逻辑，优先选择：
   - 最近成功的出口
   - 连续失败更少的出口
   - 总失败更少的出口
2. 新增代理状态字段：
   - `consecutiveFailures`
   - `coolingDown`
   - `cooldownRemainingMs`
3. 当前默认策略：
   - 连续失败阈值：`2`
   - 冷却时间：`5 分钟`
4. `/api/hotspots/ops/summary` 已回传代理池快照，前端监控日志可直接看到出口健康状态。

当前已接入的出口：

1. `proxy-a-tunnel`
   - `134.175.238.186 -> 47.250.59.136 -> tinyproxy`
2. `proxy-b-tunnel`
   - `134.175.238.186 -> 101.37.119.138 -> tinyproxy`

## 27. 广州来源专项稳定化（2026-04-24）

`gzebpubservice` 是当前四个来源里最不稳定的一个，主要问题是：WAF 敏感、空结果较多、结果公告噪声高、详情链路不统一。为此已开始做来源专项治理：

1. `server/src/services/tenderSources.ts`
   - 将广州源限频从 `1500ms` 调整为 `4000ms`
   - 增加 `isLowValueGzebRecord()`，前置过滤：
     - `中标结果`
     - `成交结果`
     - `结果公告`
     - `候选人公示`
     - `合同公告`
     - `终止公告`
     - `废标 / 流标`
2. 广州搜索改为使用 `axiosWithSourceProxyDetailed()`，可拿到实际命中的代理 ID。
3. 对以下场景记为“代理软失败”，触发重试/退避：
   - `response.data.code != 200`
   - `response.data.content` 为空
   - 过滤后结果为空（空结果 / 疑似被拦截）
4. 广州来源重试次数改为跟随运行时配置 `sourceRetryCount + 1`，并按 `sourceRetryDelayMs` 做退避。
5. 当前目标不是盲目增加抓取量，而是先提高：
   - 有效结果密度
   - 出口切换质量
   - 失败原因可观测性
6. 已新增查询词分层策略：
   - 先搜原始精确词
   - 再依次回退到 `BIM`
   - `建筑信息模型`
   - `智慧建造`
   这样在广州源精确词命中较差时，仍能通过宽泛词拿到候选，再由规则过滤压掉噪声。
7. 已新增错误分类重试：
   - `403 / WAF`
   - `429`
   - `502 / 503 / 504`
   - `超时 / 连接异常`
   - `空结果`
   各类型会使用不同的退避时间。
8. `probeTenderSources()` 已开始使用来源级探测词分层：
   - `gzebpubservice`：`BIM / 建筑信息模型 / 智慧建造`
   - `szggzy / guangdong`：`BIM / 建筑信息模型`
   - `szygcgpt`：保守探测，减少额外请求
   这样前端监控面板里的来源健康不再被单一探测词误导。
9. 详情可信度已统一收口为四档：
   - `深抓取详情`
   - `官方详情已解析`
   - `原始详情已校验`
   - `低可信结果页 / 待人工核验`
   当前已用于前端详情展示与飞书字段映射。
10. 来源健康探测已增加短时缓存：
    - 默认缓存 `120s`
    - 适用于 `/api/hotspots/ops/summary` 和 `/api/hotspots/sources`
    - 目标是降低监控页频繁刷新时对来源站点的额外压力，同时提升前端响应速度。
11. 服务器运行侧已确认需要修复 SQLite 目录权限，避免启动阶段默认关键词初始化报：
    - `attempt to write a readonly database`
    本轮会将 `server/prisma` 目录统一收回到服务运行用户权限下。
12. 广州来源结果可信度前置过滤已继续加强：
    - 直接过滤 `show-bid-opening/list` 等结果页跳转
    - 直接过滤标题中明显的 `中标/成交/结果公告/候选人公示/合同公告`
    - 若公告正文同时缺少“公告特征”和“BIM业务特征”，则不再进入候选池
13. 来源注册表已补充来源元信息：
    - `riskLevel`
    - `probeProfile`
    这两项暂时主要用于约束探测和后续运维视图，但也为新增来源接入保留了标准字段。
14. `ops/summary` 已新增数据质量统计：
    - 总样本数
    - 高完整度机会数
    - 未截止/已截止数量
    - 单位/预算/截止/联系人/电话/详情解析披露率
15. `ops/summary` 已新增来源质量统计：
    - 每个来源的样本量
    - 平均完整度
    - 单位/预算/截止/联系人/详情覆盖率
    前端“数据分析”页已接入两个新面板，作为来源治理和运营诊断的基础视图。
16. 已新增“来源治理优先级”面板：
    - 综合平均完整度
    - 预算覆盖率
    - 联系人覆盖率
    - 24h 轮次异常
    给出当前应该优先治理的来源排序。
17. 已定位“相关性全是 78”的原因：
    - 这不是当前规则分析器的分数
    - 而是服务器里早期遗留数据，`relevanceReason` 为 `未配置 AI 服务，使用默认分数`
    - 当前已新增脚本 `npm run reanalyze:tender-relevance` 用于批量重算这些旧记录
18. 详情提取规则继续补强：
    - 新增更多预算标签：`采购预算 / 项目预算 / 预算总金额`
    - 新增更多联系人/电话标签：`联系人及电话 / 联系方式 / 项目联系人`
    - 对 `szygcgpt / gzebpubservice`，即使完整度不低，只要预算/联系人/电话缺失也会继续进入详情增强
19. AI 分析链路继续稳固：
    - 对发送给 OpenClaw 的正文做清洗与压缩，移除图片 markdown、重复增强片段、导航噪声和超长列表
    - 优先保留项目编号、单位、预算、联系人、截止、服务范围、资质要求等投标字段
    - 若第一次 AI 解析失败，会自动用更短的清洗文本再试一次，尽量减少大文本超时导致的规则回退
20. 服务器 OpenClaw 运行环境继续收口：
    - 已确认服务器上存在 `main / xiaozhi / lizhi / bim-tender` 四个 agent
    - 当前仅业务必需的是 `bim-tender`
    - 已移除无关 `lizhi` agent，降低本机 agent 管理与路由负担
    - 后续若确认 `xiaozhi` 也不参与业务，可继续考虑精简
21. `bim-tender` agent 继续轻量化：
    - 已将工作区内历史脚本、截图、日志、`node_modules`、旧日报等归档到独立 archive 目录
    - 工作区体积已从约 `112M` 收到约 `32M`
    - 已将 `AGENTS.md / SOUL.md / MEMORY.md` 收口为“单条招采字段分析”用途，不再携带旧日报机器人流程
    - 已把 `bim-tender` 模型切到更轻的 `minimax-m2.5`，先观察对稳定性和时延的影响
22. 后端扫描链路增加有限并行：
    - `hotspotChecker` 现在支持有限并行 AI 分析
    - 默认并行度来自 `TENDER_AI_CONCURRENCY`（默认 `2`，上限 `4`）
    - 目标是在不明显放大反爬压力的前提下，提高单轮扫描吞吐
23. 历史重算与详情增强也开始支持并行：
    - `npm run reanalyze:tender-relevance -- --concurrency=2` 可并行调用多个 OpenClaw 会话
    - 详情增强队列新增 `TENDER_DETAIL_ENRICHMENT_CONCURRENCY`，默认 `2`，上限 `4`
    - 队列状态新增 `currentHotspotIds`，便于前端或健康接口看到当前并行处理的项目
24. OpenClaw 调用继续减负：
    - 投标分析 prompt 已进一步缩短为纯 JSON 分类器指令
    - 目标是减少模型铺陈和启动后的生成长度，降低超时概率
25. 广州源字段提取继续补强：
    - 日期解析已兼容 `开标时间为`、`电子投标文件递交截止时间`、`递交电子投标文件截止时间` 等写法
    - 继续兼容广州电子标常见字段：`递交资格预审/投标文件截止时间`、`获取资格预审/招标文件截止时间`
    - 中文日期会补齐月/日/时/分的前导零，避免 `2025-8-25T10:30:00` 在 Node 中解析不稳定
    - 当前策略仍然是：若明确投标截止缺失，则用开标时间作为可跟进截止判断的保守代理
26. 前端监控日志继续增强：
    - 详情补全队列会展示当前并行 worker 数
    - 同步展示待处理数量和本轮已处理数量
27. AI 成功率观测已接入：
    - `ops/summary` 返回 `ai.successCount / ai.fallbackCount / ai.successRate / ai.fallbackRate`
    - 当前口径基于 `relevanceReason` 区分 OpenClaw 直接返回与规则回退，不新增数据库迁移
    - 前端“数据分析”页新增 AI 分析模块，用于观察 prompt 压缩和并发调整后的真实效果
28. OpenClaw 失败原因初步定位：
    - 新增 `npm run probe:openclaw-analysis` 单条分析探针
    - 线上实测 OpenClaw 能返回标准 JSON，解析正常
    - 当前主要问题不是解析失败，而是单条调用耗时较长，且旧 fallback 记录此前没有被重算脚本覆盖
    - 重算脚本已纳入 `AI 分析超时或失败，使用规则投标分析` 记录
    - 重算脚本已改为规则扩词，避免重算时额外调用 OpenClaw 做关键词扩展
29. AI 观测口径升级：
    - 新增 `AiAnalysisLog` 表，不再只依赖 `relevanceReason` 文案反推成功/失败
    - 每次公告 AI 分析会记录 `provider / status / fallbackUsed / attemptCount / elapsedMs / errorMessage`
    - `hotspotChecker` 与 `reanalyze:tender-relevance --apply` 都会写入真实任务日志
    - `ops/summary` 优先使用近 24h 真实任务日志，若没有日志再回退到历史文案估算
    - 前端 AI 面板展示近 24h 成功率、回退率、平均耗时、P95 耗时、最近分析时间和 provider 分布
30. 监控看板查询降噪：
    - `GET /api/hotspots/ops/summary` 不再实时调用 `probeTenderSources`
    - 来源健康改为读取最近 `SourceProbe` 与运行时状态，避免每次打开数据分析页都触发广州源 WAF/502 重试
    - 手动来源探测保留在 `GET /api/hotspots/sources`，后续若要主动探测可单独做按钮和冷却时间
31. 广州源现网复核与代理策略：
    - 生产服务器测试显示：广州搜索接口本身仍可用，直连和 `proxy-b` 可以返回 `BIM / 建筑信息模型 / BIM设计` 结果
    - `proxy-a` 当前对广州源大量返回 `403 / ECONNRESET`，是近期广州数据被打空的主要风险之一
    - 代理池已从“选一个出口请求”升级为“同一次请求内健康优先 failover”
    - 失败后会立即尝试下一个健康出口，并允许直连兜底；可通过 `TENDER_PROXY_DIRECT_FALLBACK=false` 关闭直连兜底
    - 广州搜索结果的 BIM 类型判断改为标题 + 正文摘要共同判断，避免标题未显式写 BIM、正文包含建筑信息模型的记录被误过滤
    - 当前策略：广州源不下线，但作为高风险源继续低频抓取、结果严格过滤，避免坏链接和结果公告污染首页
32. v1.2 版本收口：
    - 后端 `/api/health.version` 从 `server/package.json` 读取，不再在 `server/src/index.ts` 写死版本号
    - 前端标题区版本号改为展示 `healthStatus.version`
    - `client/package.json` 同步为 `1.2.0`，避免前后端版本语义不一致
    - 后续版本升级优先更新 package 版本，再由健康接口和前端自动展示
33. 详情页交互收口：
    - 新增 `POST /api/hotspots/:id/notify-feishu`，支持从详情页手动推送指定项目到飞书群
    - 手动飞书群推送会强制发送 webhook，不再套用自动推送的完整度/截止时间过滤，适合人工挑选重点项目
    - 详情页“操作”区新增“手动推送至飞书群”按钮，不调整原有详情页排版结构
    - 详情页滚动超过顶部返回按钮后，右下角出现圆形悬浮返回按钮，点击可直接返回投标机会清单

## 34. v1.2 正式收口（2026-04-24）

当前 `v1.2` 已完成收口，正式进入维护冻结状态：

1. 前端主链路已完成投标机会、详情页、数据分析、监控日志、监控词和临时搜索的功能收口。
2. 后端已完成四个政府/招采来源的基础抓取、详情增强、AI 判断、飞书推送与多维表同步闭环。
3. 版本号已统一从 `server/package.json` 读取，并通过 `/api/health.version` 反馈给前端。
4. 详情页已补充手动飞书群推送与悬浮返回按钮。
5. GitHub 保留早期 `v1.2.0` 标签，最终收口标签使用 `v1.2-final`，指向包含所有 v1.2 收尾功能的最终提交。

`v1.3` 开始后，不再向 v1.2 主线追加新功能，只处理严重 bug 或部署问题。

## 35. v1.3 TODO 起点

优先级 P0：

1. 数据库脏数据扫描与修复：坏链接、重复记录、字段污染、已截止未标记、低可信详情。
2. 广州源专项稳定化：失败分类、出口健康优先、低频抓取、候选详情降噪、真实空结果与拦截分离。
3. AI 可观测细化：新增 AI 任务明细接口/面板，展示 provider、耗时、回退原因、重试次数。
4. 飞书回执链路：记录自动推送、手动推送、多维表同步结果，前端可查看最近投递状态。

优先级 P1：

1. 来源级字段模板：针对深圳、广东、广州、阳光采购分别优化预算、截止、联系人、电话、资质、服务范围。
2. 详情增强规则继续补强，减少“未披露”。
3. 来源健康趋势图，区分 WAF/403、502、超时、空结果、详情失效。
4. 新数据源接入 checklist 和 adapter 模板，v1.4 再正式扩展新源。

优先级 P2：

1. 前端数据分析页运营化，强化字段完整度、来源质量、可跟进机会和飞书投递状态。
2. 详情页动作时间线：手动推送、AI 重算、详情增强、字段修复。
3. MySQL 迁移前置评估与 schema 兼容性整理。

## 36. v1.3 收口判断（2026-04-24）

当前版本线实际已进入 `v1.3` 收口阶段，核心判断如下：

1. `v1.3` 的主要目标不是新增数据源，而是稳固现有四源、提升后端稳定性和数据质量。
2. 已完成的大项包括：广州源专项稳定化、代理池健康优先 failover、AI 真实任务日志、详情增强并行化、数据质量面板、来源治理优先级、手动飞书推送。
3. 新增数据源仍是重要方向，但为了避免在现有四源未完全稳定前扩大风险，正式接入主线顺延到 `v1.4`。
4. `v1.3` 收口时只保留新增数据源的 adapter/checklist 设计思路，不再实际接入新源。
5. 接下来 `v1.3` 只处理严重 bug、文档、版本号、部署验证和必要 smoke test。

`v1.3` 最终收口检查项：

1. `/api/health` 返回 `version=1.3.0`。
2. `/api/hotspots/ops/summary` 正常返回来源健康、AI、质量统计。
3. 详情页可打开，手动飞书按钮可见，飞书 webhook 配置正常。
4. 广州源可以通过专项脚本或搜索函数返回候选，不要求每轮都稳定命中。
5. GitHub 打 `v1.3.0` 标签。


## 37. v1.4 开发启动（2026-04-24）

`v1.4` 主线是新增数据源接入能力，但先做工程化基础，不直接把新源加入生产默认扫描：

1. 当前版本号切换为 `1.4.0-dev`。
2. 新增 `docs/DATA_SOURCE_ONBOARDING.md`，记录数据源接入 checklist、验收标准和降级策略。
3. 新增 `docs/V1_4_TODO.md`，明确 P0/P1/P2 和暂不做事项。
4. 新增 `docs/templates/tenderSourceAdapter.template.ts`，作为新源 adapter 模板。
5. 新增 `npm run probe:tender-source-candidate`，用于在写 adapter 前探测候选来源的 HTTP 状态、反爬信号、页面链接和正文预览。
6. 新源接入策略：先单源探测，再本地 adapter，再字段质量评估，最后决定是否加入默认 `TENDER_SOURCES`。


下一步会继续在广州来源上补：

1. `403 / 502 / 空结果` 分类治理
2. 结果页与招标公告页的可信度分级
3. 低质量关键词与查询词策略优化

## 38. v1.4 CEB 详情页专项（2026-04-24）

中国招标投标公共服务平台 `cebpubservice` 当前采用“两段式”策略：

1. 列表页 `bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html` 可以稳定返回标题、地区、来源渠道、发布时间和开标时间，作为默认生产可用字段。
2. SPA 详情页跳转到 `ctbpsp.com/#/bulletinDetail`，真实接口为 `/cutominfoapi/bulletin/{uuid}/uid/0`。
3. 前端接口响应存在 DES/ECB 加密，已在后端补充 `crypto-js` 解密工具，密钥来自站点前端脚本。
4. 详情接口直连会返回阿里云 WAF/JS challenge 页面，Firecrawl 也会被拦截；因此定时扫描默认不请求详情接口，避免扩大失败率。
5. 新增 `CEB_DETAIL_FETCH_ENABLED=true` 作为手动探测开关。开启后若触发 WAF，会将详情来源标记为 `ceb-list+rules:blocked`，并保留列表字段，不让单源拖垮整轮扫描。

后续如果要继续 CEB 详情补强，建议走浏览器会话/Playwright 挑战 cookie 或专用代理会话，不建议在生产定时任务中直接暴力重试。

## 39. v1.4 来源健康分类收口（2026-04-24）

来源健康不再只显示“正常 / 待观察 / 熔断中”，而是由后端统一输出结构化状态：

1. `disabled`：未启用，通常是 v1.4 新源只做单源探测、未加入生产扫描。
2. `healthy`：最近探测成功，且有可用样例。
3. `empty`：请求可达但关键词无结果，适用于全国公共资源交易平台这类“接口可用但 BIM 样本为空”的场景。
4. `request_failed`：超时、网络、网关等普通请求失败。
5. `waf_blocked`：403/405/WAF/challenge/验证码/安全验证等反爬或安全挑战。
6. `circuit_open`：连续失败后进入熔断冷却。
7. `degraded`：主体链路可用，但详情补强等子链路被 WAF 拦截后降级。

前端“来源健康”卡片已改为展示 `statusLabel` 和 `statusReason`，这样后续新增数据源时，可以快速判断是“没启用”“没结果”“被拦截”还是“真失败”。

## 40. v1.4 来源字段质量评分与脏数据口径（2026-04-24）

在来源质量统计中新增“质量分”和修复建议，避免只看字段完整度导致误判：

1. 后端 `sourceQuality` 新增字段：
   - `qualityScore`：平均完整度扣除脏值惩罚后的来源质量分。
   - `qualityGrade`：`no_sample / good / needs_enrichment / poor`。
   - `missingCounts`：按来源统计单位、预算、截止、联系人、详情解析缺失数量。
   - `dirtyIssueCount` 和 `dirtyIssues`：统计字段污染、预算异常、电话异常、详情链路可信度低等问题。
   - `repairHints`：给前端直接展示的治理建议，例如“预算金额缺失 12 条；单位字段疑似污染 3 条”。
2. 脏数据口径当前覆盖：
   - 单位字段混入 `项目名称 / 预算金额 / 联系人 / 联系电话 / 联系地址 / 招标代理机构` 等标签。
   - 预算金额为非正数或极端异常值。
   - 联系电话不符合座机或手机号基本格式。
   - 详情来源出现 `blocked / waf / challenge / 404 / bad-link / unhealthy`。
3. 前端“来源质量分布”展示质量分、可跟进/已截止、高完整度、脏值数量、缺预算/缺截止和修复口径。
4. 前端“来源治理优先级”已把质量分、脏值数量和轮次异常一起纳入治理指数。

这一步让 v1.4 新源接入具备更明确的验收依据：不是“能抓到列表就算接入”，而是要达到可支撑投标决策的字段质量。

## 41. v1.4 新源验收闸门与 TODO 收口（2026-04-24）

v1.4 今日收口重点是把“新增数据源”从代码接入升级成可验收、可观察、可回退的流程：

1. 全国公共资源交易平台 `ggzyNational`：
   - 修正官方接口参数，只发送页面实际使用的 `SOURCE_TYPE / DEAL_TIME / PAGENUMBER / FINDTXT`，不再携带默认 `0 / 0000` 参数导致空结果。
   - 完成 `EPC` 非空样本验证，可返回招标/资审公告。
   - 已映射字段：标题、地区、城市、公告阶段、发布时间、详情 URL、项目编号、详情来源。
   - `BIM` 当前只命中成交公示，按主动公告过滤规则剔除，因此显示 0 条是符合预期的业务过滤。
2. 新增 `sourceQualityTrend`：
   - 返回近 7 天质量分、近 30 天质量分、样本数和趋势方向。
   - 前端“来源质量分布”已展示趋势摘要。
3. 新增 `sourceAcceptance`：
   - 每个来源都有验收分、通过项、代理策略、深抓取策略和下一步动作。
   - 新源必须通过单源隔离、非空样本、字段质量、详情可靠、失败可解释五类检查，才建议加入生产扫描。
4. 新增 `sourceCandidatePool`：
   - 省级政府采购网、行业招标平台、央企/国企招采平台进入候选池。
   - 前端“新源验收闸门”展示候选池和策略。
5. 来源级代理策略：
   - 延续 `TENDER_PROXY_POOL.sources`，验收闸门会显示 `source-specific / default-pool / direct-host`。
6. Firecrawl / 浏览器 agent 深抓取策略：
   - 每个来源输出 `deepCrawlStrategy`，区分规则补强、官方详情、浏览器会话和 WAF 降级。

v1.4 TODO 已全部收口。仍未强行解决的是 `cebpubservice` 的真实 SPA 详情字段抓取，因为该接口触发 WAF/JS challenge；本版本已完成安全降级与后续浏览器会话策略，不在生产定时扫描中暴力重试。

## 42. v1.5 CEB 单源专项启动（2026-04-24）

本轮开始进入 v1.5，目标不是继续横向扩新源，而是先把中国招标投标公共服务平台 `cebpubservice` 做稳。

已验证现状：

1. 官方列表页 `https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html` 能稳定返回公开 HTML 表格。
2. 列表页可直接解析标题、UUID、行业、地区、来源渠道、发布时间和开标时间。
3. SPA 详情页 `https://ctbpsp.com/#/bulletinDetail` 的真实接口 `/cutominfoapi/bulletin/{uuid}/uid/0` 当前返回阿里云 WAF/JS challenge。
4. Firecrawl scrape 对同一详情页也返回 405 风控页，不能作为 CEB 详情补强的默认生产方案。
5. 翻页请求需要 VAPTCHA 请求头，生产扫描暂不做自动验证码绕过，继续通过关键词分层扩大列表覆盖。

本次代码调整：

1. CEB 发布时间优先取列表首列 `td[id]` 的完整时间，例如 `2026-04-17 17:14:04`。
2. 公告类型由标题推断，覆盖公开招标、竞争性磋商、竞争性谈判、询比采购、比选、采购公告、项目任务等。
3. 开标时间继续作为截止参考，同时输出 `公告状态：未截止 / 已开标/已截止`。
4. 从标题清洗 `tenderServiceScope`，在详情不可用时也能展示项目服务范围。
5. 字段来源标记升级为 `ceb-list+official-table:v1.5`，前端和飞书均识别为“官方列表可信”。
6. 新增 `npm --prefix server run probe:cebpubservice -- --query=BIM --limit=5`，用于单源专项诊断。
7. 新增 `npm --prefix server run backfill:cebpubservice -- --apply`，用于线上旧 CEB 记录字段回填。

后续策略：

1. 在服务器数据库执行历史数据回填，把旧 CEB 记录补齐公告类型、服务范围和详情来源。
2. 再做 CEB 治理面板专项指标：列表字段覆盖、详情 WAF 次数、有效样本数。
3. 详情正文补强已按原四源方案接回详情增强队列：先 Firecrawl/来源详情能力，低完整度再交给 OpenClaw `bim-tender` agent 逐条核验 URL 和正文；被 WAF/验证码阻断时不猜测字段，保留列表字段。


## 43. v1.5 CEB 接回原详情增强队列（2026-04-24）

本次按历史文档第 17/18 节修正 v1.5 实现：新源不应只做列表降级，而要复用原四源“少量候选公告逐条进入详情页补字段”的链路。

确认到的旧方案：

1. 列表页先抓取候选公告。
2. 规则过滤和去重后，对剩余少量公告访问详情页。
3. 优先使用来源详情接口或 Firecrawl 渲染正文。
4. 首轮规则字段提取后，如果完整度仍低，进入二段 Agent 化详情增强。
5. 字段回写 `Hotspot` 表，前端投标机会清单和详情页直接使用结构化字段。

本次修正：

1. `shouldEnrichWithFirecrawl` 扩展到 `ccgp / ggzyNational / cebpubservice`，新源也会进入详情页正文增强。
2. `enqueueIncompleteHotspots` 的来源范围从原四源扩展为七个招采来源，手动详情增强不再漏掉新源。
2.1 `POST /api/hotspots/detail-enrichment/run` 支持传 `source`，可以只补跑 `cebpubservice`，适合单平台专项治理。
3. 新增 `server/src/services/tenderDetailAgent.ts`，低完整度公告会把 URL、当前字段和已抓取正文交给 OpenClaw `bim-tender` agent。
4. Agent 提示词明确要求：如果可用浏览器/网页工具，优先打开详情页并等待渲染；若遇到 WAF、验证码、登录或空壳页，返回 blocked/not_found，不得猜测字段。
5. Firecrawl 抓取增加 WAF/验证码/安全挑战页识别，避免 CEB 的 405 风控页被拼入公告正文。
6. 前端和飞书已识别 `detail-enrichment+openclaw-browser` 为“深抓取详情”。

这样 CEB 当前策略变为：官方列表字段保底 + 详情增强队列逐条尝试 Firecrawl/浏览器 agent 补字段 + WAF 时明确降级。

新增运维命令：

1. `npm --prefix server run enrich:source-details -- --source=cebpubservice --limit=20`：只补跑 CEB 详情增强。
2. `npm --prefix server run enrich:source-details -- --source=ccgp --limit=20`：后续套到中国政府采购网。
3. `npm --prefix server run enrich:source-details -- --source=ggzyNational --limit=20`：后续套到全国公共资源交易平台。


## 44. v1.5 CEB 真实样本入库与脏字段清理（2026-04-24）

本轮围绕 CEB 跑了 3 条本地真实入库样本，用于前端验收。

发现的问题：

1. CEB 详情页和 Firecrawl 均返回 WAF/405 阻断页。
2. Firecrawl 结构化 JSON 在阻断页场景下可能返回无证据字段，出现 `单位=万元`、`预算=0` 等脏值。
3. OpenClaw/Agent 在没有真实详情证据时也可能输出示例型字段，例如 `项目编号=123456`、`联系人=张先生`、`地址=北京市朝阳区`，必须过滤。

已修复：

1. Firecrawl detail 如果 markdown 为空或命中 WAF/验证码/405 阻断页，直接返回空增强结果，不接受 JSON 字段。
2. Firecrawl 字段解析不再接受 `budgetWan <= 0`，且过滤 `万元 / 元 / 信息` 等弱单位。
3. CEB 官方列表降级态只保留列表可证明字段：标题、地区、公告类型、发布时间、开标/截止参考、服务范围、详情来源。
4. `backfill:cebpubservice` 会清理 CEB 旧样本中的阻断页内容和疑似幻觉字段。

当前本地 3 条 CEB 样本覆盖：

1. 截止/开标：3/3。
2. 服务范围：3/3。
3. 详情来源：3/3，均为 `ceb-list+official-table:v1.5`。
4. 单位、预算、联系人、电话：0/3，原因是详情页被 WAF 阻断，列表页不提供这些字段。
5. 平均字段完整度：34。

结论：CEB 当前已经可以作为“列表可信线索源”展示，但还不是“详情字段完整源”。下一步前端验收通过后，再继续研究真实浏览器会话/已验证 cookie/人工授权会话是否能突破详情页；在此之前禁止用无证据字段填充前端。
