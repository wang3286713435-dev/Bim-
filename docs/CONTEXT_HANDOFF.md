# 项目上下文交接

更新时间：2026-04-21

## 1. 当前项目状态

项目基于开源仓库 `liyupi/yupi-hot-monitor` 二次开发，目标已从通用热点监控调整为 `BIM 招采监控系统`。

当前项目目录：

- `/Users/Weishengsu/dev/yupi-hot-monitor`

前后端均可构建通过。

## 2. 已完成的核心改造

### 2.1 招采数据源接入

已接入以下来源：

1. `szggzy` 深圳公共资源交易中心
2. `szygcgpt` 深圳阳光采购平台
3. `guangdong` 广东省公共资源交易平台
4. `gzebpubservice` 广州公共资源交易公共服务平台

核心代码：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/tenderSources.ts`

已融合此前两个脚本中的核心能力：

1. 公开接口抓取
2. BIM 标题包含/排除规则
3. BIM 类型分类
4. 预算解析
5. 分页抓取
6. 去重和限频

备注：

- `gzebpubservice` 当前仍可能遇到 WAF/502，不算稳定来源。
- `guangdong` 存在限频，需要低频访问。

### 2.2 AI Provider 抽象

新增统一 AI provider 层：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/llmProvider.ts`

当前支持：

1. `OpenRouter`
2. `OpenClaw agent`

当前推荐配置：

```env
AI_PROVIDER=openclaw
OPENCLAW_AGENT_ID=bim-tender
OPENCLAW_BIN=openclaw
OPENCLAW_TIMEOUT_MS=180000
```

说明：

- 现在已确认 `OpenClaw dashboard` 中的 `bim-tender` agent 可用。
- 后端也已真实验证通过 `openclaw agent --agent bim-tender --message ... --json` 的调用链路。
- 不再使用 `--local`。

### 2.3 AI 分析链路

AI 相关代码：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/ai.ts`

已支持：

1. 关键词扩展
2. 相关性判断
3. 真假/有效性判断
4. 重要度分级
5. 摘要输出
6. provider 不可用时的 fallback

已实测：

- `expandKeyword('BIM全过程咨询')` 成功
- `analyzeContent(...)` 成功返回结构化 JSON

### 2.4 Firecrawl 集成

新增：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/firecrawl.ts`

集成策略：

1. Firecrawl 只做详情页正文增强
2. 不替代列表页公开 API
3. 仅对招采来源启用

原因：

1. 列表页已有稳定公开接口
2. Firecrawl 更适合详情页正文提取
3. 成本和稳定性更可控

### 2.5 Firecrawl 缓存

Firecrawl 已加缓存：

1. 内存缓存
2. 磁盘缓存
3. TTL 控制

默认配置：

```env
FIRECRAWL_CACHE_TTL_MS=86400000
FIRECRAWL_CACHE_FILE=.cache/firecrawl-cache.json
```

缓存文件路径：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/.cache/firecrawl-cache.json`

已验证缓存命中有效。

### 2.6 默认 BIM 关键词初始化

新增：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/startup/defaultKeywords.ts`

服务启动时会自动幂等写入 11 个默认关键词：

1. `BIM设计`
2. `BIM正向设计`
3. `BIM全过程咨询`
4. `BIM施工应用`
5. `BIM深化设计`
6. `BIM数字化交付`
7. `EPC+BIM`
8. `建筑信息模型`
9. `BIM技术服务`
10. `BIM咨询`
11. `智慧建造BIM`

启动接入位置：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/index.ts`

## 3. 前端改动

已在前端增加来源展示、招采元信息展示和筛选：

- `/Users/Weishengsu/dev/yupi-hot-monitor/client/src/components/FilterSortBar.tsx`
- `/Users/Weishengsu/dev/yupi-hot-monitor/client/src/App.tsx`
- `/Users/Weishengsu/dev/yupi-hot-monitor/client/src/services/api.ts`

当前支持展示：

1. 深圳交易中心
2. 深圳阳光采购
3. 广东交易平台
4. 广州交易平台

当前支持筛选：

1. 来源、关键词、重要度、时间、真实性
2. BIM 类型
3. 地区
4. 最低预算
5. 截止时间
6. 招采平台

最新一轮前端二开已完成：

1. 首页改为“BIM 招采监控台”
2. 增加来源健康面板
3. 增加结构化分布模块：
   - 来源贡献
   - 地区分布
   - 预算区间
   - 截止时间
   - BIM 类型
4. 增加最近扫描模块，消费 `/api/hotspots/ops/summary`
5. 公告流卡片改为更偏业务视角的结构化展示
6. 高价值机会侧栏单独突出
7. 监控词页与临时搜索页保留，但布局已重做

v1.0 额外完成：

1. 新增 `server/src/services/tenderSourceRegistry.ts`
2. 抓取来源统一注册、统一优先级、统一 query variants
3. 新增 `/api/hotspots/sources` 用于来源健康探测
4. `/api/health` 增加 `version`、`mode`、`enabledSources`
5. 新增 `CrawlRun` / `SourceProbe` 持久化运行日志
6. 新增 `/api/hotspots/runs` 查看抓取运行记录
7. 新增 `server/src/services/runtimeConfig.ts`
8. 启动时自动写入默认运行时配置
9. 新增 `/api/settings/runtime` 运行时配置接口
10. 新增 `/api/settings/sources` 来源配置接口
11. 新增 `/api/hotspots/ops/summary` 运维概览接口

## 4. Skill 封装

已新增项目 skill：

- `/Users/Weishengsu/dev/yupi-hot-monitor/skills/bim-tender-monitor/SKILL.md`
- `/Users/Weishengsu/dev/yupi-hot-monitor/skills/bim-tender-monitor/references/source-playbook.md`

目标：

1. 将 BIM 招采抓取与 AI 分析能力封装成可复用 skill
2. 供其他 AI 或 agent 接手使用

## 5. 文档

已存在文档：

1. 需求文档
   - `/Users/Weishengsu/dev/yupi-hot-monitor/docs/REQUIREMENTS.md`
2. 开发文档
   - `/Users/Weishengsu/dev/yupi-hot-monitor/docs/DEVELOPMENT.md`
3. 当前上下文交接文档
   - `/Users/Weishengsu/dev/yupi-hot-monitor/docs/CONTEXT_HANDOFF.md`

## 6. 已验证结果

已完成验证：

1. `server` 构建通过
2. `client` 构建通过
3. `OpenClaw` provider 调用成功
4. `Firecrawl` API 请求成功
5. Firecrawl 缓存生效
6. 默认 BIM 关键词已成功初始化 11 条
7. 结构化筛选前后端构建通过
8. 来源注册表与探测接口已验证通过
9. 抓取运行日志已实际入库并验证
10. 运行时配置接口和来源配置接口已验证
11. 运维概览接口已验证
12. 前端 `client` 构建通过

## 7. 当前已知问题

1. `gzebpubservice` 仍可能被 WAF 拦截
2. `guangdong` 需要严格限频
3. `OpenClaw` 冷启动较慢，需保留较高 timeout
4. 报表能力还未展开
5. 部分来源 adapter 目前会吞掉异常并返回空数组，注册表层的熔断统计因此偏保守；后续如需更精确的失败统计，要把 adapter 错误显式上抛或增加失败状态回传
6. 前端当前分布图仍以条形可视化为主，下一轮可以升级为更完整的趋势报表与图形组件

## 8. 建议的下一步

优先级最高的后续工作：

1. 基于结构化字段增加趋势报表和导出
2. 将关键词升级为“来源级模板配置”
3. 给 Firecrawl 缓存增加清理策略和命中日志
4. 处理 `gzebpubservice` 的替代方案或开关禁用
5. 给来源配置中心补充前端管理页
6. 评估多公网 IP / 多出口调度方案以对抗 WAF
7. 继续前端可视化深化：
   - 趋势曲线
   - 地区热力
   - 截止时间告警视图
   - 来源诊断后台页

## 9. 关键文件清单

后端：

- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/tenderSources.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/ai.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/llmProvider.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/firecrawl.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/runtimeConfig.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/tenderSourceRegistry.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/jobs/hotspotChecker.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/startup/defaultKeywords.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/startup/defaultSettings.ts`
- `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/index.ts`

前端：

- `/Users/Weishengsu/dev/yupi-hot-monitor/client/src/App.tsx`
- `/Users/Weishengsu/dev/yupi-hot-monitor/client/src/components/FilterSortBar.tsx`

文档：

- `/Users/Weishengsu/dev/yupi-hot-monitor/docs/REQUIREMENTS.md`
- `/Users/Weishengsu/dev/yupi-hot-monitor/docs/DEVELOPMENT.md`
- `/Users/Weishengsu/dev/yupi-hot-monitor/docs/CONTEXT_HANDOFF.md`

Skill：

- `/Users/Weishengsu/dev/yupi-hot-monitor/skills/bim-tender-monitor/SKILL.md`

## 10. 2026-04-22 抓取稳定化断点

本轮已完成：

1. 后端重新构建并启动成功，健康接口正常：`http://localhost:3001/api/health`
2. 广东详情链接已拆分处理：`R` 类通过广东官方 API 补 `nodeId`，深圳 `A` 类失败时回退深圳公共资源交易中心详情页。
3. 本地 SQLite 已更新 4 条广东历史链接：2 条补齐 `nodeId`，2 条切换到深圳详情页。
4. 广州历史 404 链接已删除 1 条；当前本地库中抽查的广州详情链接均返回 200。
5. `server/src/services/tenderSources.ts` 已通过 `npm run build`。

注意事项：

1. 广东接口有严格限频，直接频繁测试会返回 429，需要等待后再测。
2. 广州搜索接口偶发 502，现阶段新入库前会做详情 URL 可达性过滤，但来源本身仍需接受偶发失败。
3. 前端看到的旧“未配置 AI 服务，使用默认分数”多半来自历史入库数据；重新扫描后再确认 OpenClaw 输出。

## 11. 2026-04-22 v1.0 收口补充

已继续完成：

1. 广东 URL 构建拆成 `buildGuangdongPortalDetailUrl`，详情解析统一由 `resolveGuangdongDetail` 返回。
2. 广东无 `nodeId` 且无来源 fallback 的记录会被跳过，避免前端再次出现“能打开但无真实数据”的详情页。
3. 深圳交易中心 fallback 的 `sourceId` 已统一转成字符串。
4. 前端监控台新增“数据分析快照”：可跟进机会、7 天内截止、已披露预算、平均相关性。
5. 后端当前运行在 `localhost:3001`，前端当前运行在 `127.0.0.1:5173`。

下一步可继续：

1. 把前端数据分析升级为趋势图和来源诊断页。
2. 若样本量变大，把前端本地统计下沉为后端 `/api/hotspots/analytics`。
3. 做旧数据 AI 重算，清理历史 fallback 分数。

## 12. 2026-04-22 前端投标化改造断点

已完成：

1. `client/src/App.tsx` 中的公告卡片已改为投标机会卡。
2. 前端不再展示历史 fallback AI 文案“未配置 AI 服务，使用默认分数”。
3. 首页快照从平均相关性改为字段完整度。
4. 高价值机会排序加入投标字段权重：截止时间、预算、招标单位。
5. `client npm run build` 已通过。

下一步建议：

1. 增加独立“数据分析”页，做趋势、地区、来源、预算和截止时间图表。
2. 增加“项目详情抽屉”，在前端展开结构化字段和原文，而不是跳转后才看。
3. 后端补 `/api/hotspots/analytics`，把统计从前端本地计算迁到后端。
4. 对历史数据做 AI 重算或清理旧 fallback 字段。

## 13. 2026-04-22 AI 与前端主入口调整

已完成：

1. `server/src/services/ai.ts` 的 AI 提示词已改为投标机会分析，不再以热点摘要为目标。
2. 新增 `server/src/jobs/hotspotCheckQueue.ts`，手动扫描和定时扫描都会通过后台队列执行，避免前端等待 OpenClaw 长时间阻塞。
3. `POST /api/check-hotspots` 现在返回 `202 Accepted` 表示已入队，重复触发时返回 `409`。
4. `/api/health` 增加 `hotspotCheckQueue` 状态。
5. 前端新增 `投标机会` Tab，并设为默认首页，`数据分析` 后移。
6. `投标机会` 页突出机会清单、优先跟进、投标快照。

注意：本轮验证时触发了一次后台扫描，如果立即再次点击扫描，可能短时间返回“already running”。

补充：本轮测试发现 OpenClaw CLI 偶发超时，已将 AI fallback 改成规则化投标分析，不再产生“未配置 AI 服务，使用默认分数 / AI 分析失败，使用默认分数”这类不适合前端展示的文本。

## 14. 2026-04-22 投标机会页体验修复

已完成：

1. 投标机会页顶部标题区改成大 Hero 区，避免标题和说明被右侧栏挤压成多行小块。
2. 主内容布局从 `1.35fr/0.65fr` 调整为更偏主列表的 `1.7fr/320px` 结构。
3. 公告卡片新增明确 `已截止` tag。
4. 右侧 `优先跟进` 只展示未截止公告，已截止公告不再进入优先跟进列表。
5. 投标机会页分页按钮增加 `z-index` 和背景，避免被背景层或布局层影响点击。
6. 前端构建通过。

## 15. 2026-04-22 详情页深度字段提取

已完成：

1. Prisma `Hotspot` 增加投标详情字段，并执行 `npx prisma db push` 同步 SQLite。
2. 新增 `server/src/services/tenderDetailExtractor.ts`，基于详情正文提取预算、截止、项目编号、联系人、电话、开标时间、文件截止、服务范围、资格要求、地点等字段。
3. `hotspotChecker` 已在 Firecrawl/详情增强后调用提取器，并将字段写入数据库。
4. 对历史 33 条招采数据做了回填，字段补全效果：截止时间 17、预算 5、单位 27、项目编号 5、服务范围 6。
5. 前端 `Hotspot` 类型已补充新字段，投标机会卡片会展示项目编号、开标时间、文件截止、地点、联系人、电话、服务范围、资格要求。

后续建议：

1. 针对各来源做专属详情字段解析器，减少纯正则误提取。
2. 对广东/深圳/广州分别做字段模板，提高预算和截止时间命中率。
3. 加一个详情字段质量分，前端优先展示字段完整度高的机会。

## 16. 2026-04-22 详情二段深抓取（Agent 化增强）

已完成：

1. `server/src/services/firecrawl.ts` 新增二段 Firecrawl 详情抓取，低完整度公告可使用更重的抓取参数和结构化 `json` 提取。
2. `server/src/services/tenderDetailEnrichment.ts` 在首轮规则提取后，如果完整度仍低于 50，会自动进入二段深抓取。
3. 二段抓取会合并结构化字段与规则提取结果，并回写数据库。
4. 后端已重建并重启，`POST /api/hotspots/detail-enrichment/run` 已触发一轮历史不完整公告补跑。

当前判断：

1. 这层已经具备“对少量候选公告逐个深度访问详情页并补字段”的能力。
2. 它优先使用 Firecrawl 深抓取，不是 Selenium/Playwright；但架构上已经为后续再接浏览器自动化留好了入口。
3. 如果后续仍有字段缺失严重的来源，应优先观察 `tenderDetailSource` 和完整度变化，再决定是否升级到真正的浏览器交互解析。
