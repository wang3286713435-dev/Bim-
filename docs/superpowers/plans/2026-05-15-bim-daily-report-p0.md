# BIM 日报 P0 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提升 `BIM 日报` 的候选内容厚度与管理层可读性，解决“6 个来源只产出少量文章”和“日报仍偏抓取后台”的核心问题。

**Architecture:** 后端新增“来源内定向召回 + 审稿式编辑层”两级增强。第一层在各来源内部用关键词召回补充候选，第二层让 AI 先审阅候选再生成更像管理层晨报的结构化摘要。前端不改变模块边界，只重排日报主视图，突出重点判断并继续把原始来源放在附录。

**Tech Stack:** Express, Prisma, SQLite, Axios, React, TypeScript, OpenClaw/OpenRouter

---

### Task 1: 根因固化与召回策略测试

**Files:**
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/__tests__/dailyReportBuilder.test.ts`
- Create: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/__tests__/dailySourceRecall.test.ts`

- [ ] 为来源内召回写失败测试，覆盖：WordPress 搜索召回、BIMBOX 搜索召回、来源去重、慢来源补充条目上限。
- [ ] 为审稿式编辑写失败测试，覆盖：候选排序、来源多样性、管理层重点输出结构。

### Task 2: 后端来源内定向召回

**Files:**
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/services/dailyReportRegistry.ts`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/services/dailySourceParsers.ts`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/services/dailySources.ts`

- [ ] 为每个来源定义召回关键词与召回能力。
- [ ] 为 `bimii` / `buildingsmart` 接入 WordPress 搜索召回。
- [ ] 为 `bimbox` 接入站内 `?s=` 搜索召回。
- [ ] 为 `shbimcenter` 接入 `/search/index/init.html` 搜索召回。
- [ ] 合并列表抓取与来源内召回结果，并在候选选择前统一去重、打标签。

### Task 3: 后端审稿式日报总结

**Files:**
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/services/dailyReportBuilder.ts`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/src/services/dailyReports.ts`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/server/prisma/schema.prisma`（仅当新增持久化字段确有必要）

- [ ] 增加“审稿前候选集”与“最终入选集”的明确分层。
- [ ] 在 AI 增强阶段新增编辑审稿 prompt：先筛出最值得管理层看的条目，再输出管理层摘要、重点关注、建议跟踪方向。
- [ ] 保持日报独立数据边界，不写入招采主链路表。

### Task 4: 前端日报主视图重构

**Files:**
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/client/src/components/DailyReportTab.tsx`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/client/src/services/api.ts`

- [ ] 将首页主视图进一步聚焦为：导语、管理层摘要、今日重点、建议跟踪。
- [ ] 保持关键词筛选与命中高亮，但弱化资讯条目密度。
- [ ] 保持原始资讯作为附录，不回到主阅读流。

### Task 5: 验证与手动日报生成

**Files:**
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/CHANGELOG.md`
- Modify: `/Users/Weishengsu/dev/Bim_tender/yupi-hot-monitor/README.md`

- [ ] 运行 `npm --prefix server test`
- [ ] 运行 `npm --prefix server run build`
- [ ] 运行 `npm --prefix client run build`
- [ ] 手动触发日报生成并记录：来源数、候选数、入选数、highlights 数量。
- [ ] 更新版本日志，准备交由用户审查。
