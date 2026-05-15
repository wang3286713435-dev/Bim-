# BIM 日报飞书模板输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `BIM 日报` 在生成成功后自动以固定飞书模板推送到管理群，并保留独立推送日志与手动重推能力。

**Architecture:** 在日报子系统内新增 `DailyReportPushLog` 持久化推送记录；新增日报专用飞书消息构建/发送服务，自动挂接到日报生成队列，提供手动重推接口与健康状态回显；前端只补充轻量推送状态展示与重推动作，不影响招采主链路或原有热点飞书逻辑。

**Tech Stack:** Prisma / Express / Axios / React / existing Feishu webhook config.

---

### Task 1: 数据模型与日志接口
- 新增 `DailyReportPushLog` Prisma 模型，记录 `reportId / triggerType / channel / status / errorMessage / pushedAt / payloadDigest`。
- 在日报健康接口中增加 `latestPush` 与 `pushHistory` 摘要。
- 保持与 `Notification / AiAnalysisLog / CrawlRun` 完全隔离。

### Task 2: 飞书模板与自动推送
- 新增日报专用飞书卡片模板：标题、导语、今日重点、建议跟踪、来源/篇数概览、查看日报按钮。
- 日报生成队列完成后自动推送；当日报为空时发送“今日无新增”轻量版日报。
- 推送成功/失败都写入 `DailyReportPushLog`。

### Task 3: 手动重推与前端状态
- 新增 `POST /api/daily/reports/:id/push-feishu` 手动重推接口。
- `GET /api/daily/health` 返回最近推送状态，日报页显示最近一次飞书推送结果。
- 若可行，增加日报直达链接参数，供飞书卡片按钮打开对应日报视图。

### Task 4: 验证与文档
- 测试日报飞书卡片 payload、空日报模板、健康状态序列化。
- 运行 `server test/build` 与 `client build`。
- 更新 `README.md`、`CHANGELOG.md` 与 `.env.example`，说明自动推送开关与手动重推方式。
