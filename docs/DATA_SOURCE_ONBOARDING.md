# v1.4 数据源接入手册

v1.4 的目标不是一次性堆很多数据源，而是把“新增数据源”变成可重复、可诊断、可降级的工程流程。

## 接入原则

1. 先验证来源稳定性，再决定是否入库。
2. 先做列表页和详情页探测，再做字段提取。
3. 先接入 1 个试点新源，不批量扩展。
4. 新源默认不影响现有四源稳定性。
5. 新源必须支持降级：失败时不能拖慢整轮扫描。

## 接入前 Checklist

### 1. 基础信息

- 来源名称
- 首页 URL
- 搜索页 URL
- 是否政府/国企/公共资源平台
- 是否需要登录
- 是否有验证码、滑块、WAF、频控
- 是否可公开访问详情页

### 2. 列表能力

- 搜索接口类型：HTML / JSON API / SPA / 表单 POST
- 是否支持关键词
- 是否支持发布时间范围
- 是否支持分页
- 单页返回字段：标题、发布时间、链接、摘要、项目编号、金额、单位
- 列表是否包含结果公告/候选人/合同公告等低价值噪声

### 3. 详情能力

- 详情 URL 是否稳定
- 详情 URL 是否需要从接口参数构建
- 详情页是否可直接访问
- 是否需要 JS 渲染 / Firecrawl / 浏览器 agent
- 是否可提取：单位、预算、截止、开标、联系人、电话、资格要求、服务范围

### 4. 反爬风险

- `low`：稳定 JSON/HTML，无明显拦截
- `medium`：偶发 403/502，需要限频或代理
- `high`：WAF、验证码、登录、强 JS 渲染、频繁空结果

### 5. 降级策略

- 空结果是否记为失败
- 403/502 是否进入熔断
- 是否允许代理池
- 是否允许直连兜底
- 每轮最大耗时
- 每关键词最大结果数

## Adapter 最小要求

每个新源需要实现：

```ts
export async function searchNewTenderSource(query: string, limit = 20): Promise<SearchResult[]> {
  // 1. 请求列表
  // 2. 过滤低价值公告
  // 3. 构建稳定详情 URL
  // 4. 提取基础 tender metadata
  // 5. 返回 SearchResult[]
}
```

必须返回字段：

- `title`
- `url`
- `source`
- `content`
- `publishedAt`，如果能取到
- `tender.type`，如果能分类
- `tender.platform`

推荐返回字段：

- `sourceId`
- `tender.unit`
- `tender.budgetWan`
- `tender.noticeType`
- `tender.projectCode`

## 试点接入流程

1. 在 `docs/DATA_SOURCE_ONBOARDING.md` 填完 checklist。
2. 用 `npm run probe:tender-source-candidate -- --url=<url> --query=BIM` 做外部连通性探测。
3. 参考 `docs/templates/tenderSourceAdapter.template.ts` 编写 adapter。
4. 在 `server/src/services/tenderSources.ts` 增加搜索函数。
5. 在 `server/src/services/tenderSourceRegistry.ts` 注册 adapter。
6. 在 `server/src/services/runtimeConfig.ts` 扩展 `TenderSourceId`。
7. 本地只启用新源跑一轮扫描。
8. 检查入库字段完整度和详情链接健康度。
9. 决定是否加入默认 `TENDER_SOURCES`。

## v1.4 试点验收标准

- 新源单独扫描不影响现有四源。
- 新源至少能稳定返回 1 条真实 BIM 招采数据。
- 详情链接可打开或有明确可靠度标记。
- 字段完整度平均不低于 40。
- 失败可分类，不产生大量未知异常。
