import { Router } from 'express';
import { prisma } from '../db.js';
import { sortHotspots } from '../utils/sortHotspots.js';
import {
  TENDER_SOURCE_ADAPTERS,
  TENDER_SOURCE_IDS,
  getTenderSourceRuntimeSnapshot,
  getEnabledTenderSources,
  probeTenderSources,
  searchTenderSourceAcrossQueries,
  buildSearchQueries,
  classifyTenderSourceStatus
} from '../services/tenderSourceRegistry.js';
import { DEFAULT_TENDER_SOURCE_IDS, getRuntimeConfig } from '../services/runtimeConfig.js';
import {
  enqueueIncompleteHotspots,
  getDetailEnrichmentQueueState,
  getTenderFieldCompletenessScore
} from '../services/tenderDetailEnrichment.js';
import {
  classifyTenderDetailSource,
  getTenderDirtyIssues,
  isUsableBudgetWan,
  isUsableTenderContact,
  isUsableTenderPhone,
  isUsableTenderServiceScope,
  isUsableTenderUnit
} from '../services/tenderFieldQuality.js';
import { classifyTenderStage } from '../services/tenderStage.js';
import { getProxyPoolSnapshot, refreshProxyPoolHealth } from '../services/proxyPool.js';
import { isFeishuWebhookEnabled, notifyFeishuWebhook } from '../services/feishu.js';

const router = Router();
const TENDER_SOURCES = TENDER_SOURCE_IDS;
const DEFAULT_SOURCE_SET = new Set<string>(DEFAULT_TENDER_SOURCE_IDS);

const SOURCE_CANDIDATE_POOL = [
  {
    category: '省级政府采购网',
    priority: 'P1',
    examples: ['广东政府采购智慧云平台', '浙江政府采购网', '江苏政府采购网'],
    strategy: '优先选公开搜索页和 JSON 接口，先做单源探测，不进入默认扫描'
  },
  {
    category: '行业招标平台',
    priority: 'P2',
    examples: ['轨道交通招采平台', '机场集团采购平台', '医院建设招采平台'],
    strategy: '按业务场景接入，要求关键词命中和详情字段质量同时达标'
  },
  {
    category: '央企/国企招采平台',
    priority: 'P2',
    examples: ['中国建筑招采平台', '中国交建供应链平台', '中铁采购平台'],
    strategy: '通常登录和反爬更强，默认走浏览器 agent / Firecrawl interact 预研'
  }
];

function getQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function getQueryNumber(value: unknown): number | undefined {
  const raw = getQueryString(value);
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeTenderPlatformFilter(value: string): string[] {
  const aliases: Record<string, string[]> = {
    '广州公共资源交易平台': ['广州公共资源交易平台', '广州公共资源交易公共服务平台'],
    '广州公共资源交易公共服务平台': ['广州公共资源交易平台', '广州公共资源交易公共服务平台']
  };
  return aliases[value] || [value];
}

function getEffectiveDeadlineTime(item: {
  tenderDeadline?: Date | string | null;
  tenderBidOpenTime?: Date | string | null;
  tenderDocDeadline?: Date | string | null;
}): number | null {
  const candidates = [item.tenderDeadline, item.tenderBidOpenTime, item.tenderDocDeadline];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = new Date(candidate).getTime();
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function buildRepairHints(input: {
  total: number;
  missingCounts: Record<string, number>;
  dirtyIssues: Map<string, number>;
}): string[] {
  if (input.total === 0) return ['暂无入库样本，先做单源探测和样例确认'];

  const hints: string[] = [];
  const missingLabels: Record<string, string> = {
    unit: '招标单位',
    budget: '预算金额',
    deadline: '截止/开标时间',
    contact: '联系人',
    phone: '联系电话',
    serviceScope: '服务范围',
    detail: '详情解析'
  };

  for (const [key, count] of Object.entries(input.missingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)) {
    if (count > 0) {
      hints.push(`${missingLabels[key] ?? key}缺失 ${count} 条`);
    }
  }

  for (const [issue, count] of [...input.dirtyIssues.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)) {
    hints.push(`${issue} ${count} 条`);
  }

  return hints.length ? hints : ['字段质量稳定，继续观察新增样本'];
}

function getSourceDeepCrawlStrategy(sourceId: string): { mode: string; enabled: boolean; note: string } {
  const map: Record<string, { mode: string; enabled: boolean; note: string }> = {
    ccgp: {
      mode: 'detail-api+rules',
      enabled: true,
      note: '详情页字段补强已接入，适合作为 v1.4 新源验收样板'
    },
    ggzyNational: {
      mode: 'official-api-list',
      enabled: false,
      note: '官方列表接口已修正参数和字段映射；详情字段仍需非空样本继续验证'
    },
    cebpubservice: {
      mode: 'official-list+browser-agent',
      enabled: true,
      note: 'v1.5 已纳入详情增强队列：Firecrawl/浏览器 agent 逐条补字段；WAF 时保留官方列表字段'
    }
  };

  return map[sourceId] || {
    mode: 'rules+firecrawl-fallback',
    enabled: true,
    note: '使用现有规则提取和 Firecrawl 二段补强'
  };
}

function getSourceProxyPolicy(sourceId: string, proxyPool: ReturnType<typeof getProxyPoolSnapshot>) {
  const dedicated = proxyPool.filter(item => item.sources.some(source => source === sourceId));
  const fallback = proxyPool.filter(item => item.sources.includes('default'));
  return {
    dedicatedCount: dedicated.length,
    fallbackCount: fallback.length,
    directFallbackEnabled: process.env.TENDER_PROXY_DIRECT_FALLBACK !== 'false',
    policy: dedicated.length > 0
      ? 'source-specific'
      : fallback.length > 0
        ? 'default-pool'
        : 'direct-host'
  };
}

function decorateHotspotRecord<T extends {
  tenderNoticeType?: string | null;
  title?: string | null;
  content?: string | null;
}>(record: T) {
  const stage = classifyTenderStage({
    tenderNoticeType: record.tenderNoticeType,
    title: record.title,
    content: record.content
  });

  return {
    ...record,
    tenderStageCategory: stage.category,
    tenderStageLabel: stage.label,
    tenderStageBucket: stage.bucket,
    tenderActionable: stage.actionable
  };
}

function matchesTenderStageFilter(
  record: Parameters<typeof decorateHotspotRecord>[0],
  tenderStageFilter: string
): boolean {
  if (!tenderStageFilter) return true;
  const decorated = decorateHotspotRecord(record);
  return (
    decorated.tenderStageCategory === tenderStageFilter
    || decorated.tenderStageBucket === tenderStageFilter
  );
}

// 获取所有热点
router.get('/', async (req, res) => {
  try {
    const { 
      page = '1', 
      limit = '20', 
      source, 
      searchText,
      searchMode,
      includeExpired,
      importance,
      keywordId,
      isReal,
      tenderStage,
      timeRange,
      timeFrom,
      timeTo,
      tenderType,
      tenderRegion,
      tenderMinBudgetWan,
      tenderMaxBudgetWan,
      tenderDeadlineRange,
      tenderDeadlineFrom,
      tenderDeadlineTo,
      tenderPlatform,
      includeLegacy,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    const andConditions: any[] = [];
    if (source) {
      where.source = source;
    } else if (includeLegacy !== 'true') {
      where.source = { in: TENDER_SOURCES };
    }
    if (importance) where.importance = importance;
    if (keywordId) where.keywordId = keywordId;
    if (isReal !== undefined && isReal !== '') {
      where.isReal = isReal === 'true';
    }

    // 招投标结构化字段筛选
    const tenderTypeValue = getQueryString(tenderType);
    const tenderRegionValue = getQueryString(tenderRegion);
    const tenderPlatformValue = getQueryString(tenderPlatform);
    const tenderStageValue = getQueryString(tenderStage);
    const searchTextValue = getQueryString(searchText);
    const searchModeValue = getQueryString(searchMode) === 'title' ? 'title' : 'fulltext';
    const minBudgetWan = getQueryNumber(tenderMinBudgetWan);
    const maxBudgetWan = getQueryNumber(tenderMaxBudgetWan);

    if (tenderTypeValue) where.tenderType = tenderTypeValue;
    if (tenderRegionValue) {
      andConditions.push({
        OR: [
        { tenderRegion: { contains: tenderRegionValue } },
        { tenderCity: { contains: tenderRegionValue } }
        ]
      });
    }
    if (tenderPlatformValue) {
      const platformValues = normalizeTenderPlatformFilter(tenderPlatformValue);
      if (platformValues.length === 1) {
        where.tenderPlatform = platformValues[0];
      } else {
        andConditions.push({
          OR: platformValues.map((platform) => ({ tenderPlatform: platform }))
        });
      }
    }
    if (searchTextValue) {
      const textConditions = searchModeValue === 'title'
        ? [
            { title: { contains: searchTextValue } }
          ]
        : [
            { title: { contains: searchTextValue } },
            { content: { contains: searchTextValue } },
            { summary: { contains: searchTextValue } },
            { tenderUnit: { contains: searchTextValue } },
            { tenderProjectCode: { contains: searchTextValue } },
            { tenderServiceScope: { contains: searchTextValue } },
            { tenderQualification: { contains: searchTextValue } },
            { tenderRegion: { contains: searchTextValue } },
            { tenderCity: { contains: searchTextValue } },
            { tenderAddress: { contains: searchTextValue } },
            { tenderContact: { contains: searchTextValue } }
          ];
      andConditions.push({
        OR: textConditions
      });
    }
    if (minBudgetWan !== undefined || maxBudgetWan !== undefined) {
      where.tenderBudgetWan = {};
      if (minBudgetWan !== undefined) where.tenderBudgetWan.gte = minBudgetWan;
      if (maxBudgetWan !== undefined) where.tenderBudgetWan.lte = maxBudgetWan;
    }

    const deadlineRange = getQueryString(tenderDeadlineRange);
    const deadlineFrom = getQueryString(tenderDeadlineFrom);
    const deadlineTo = getQueryString(tenderDeadlineTo);
    if (deadlineRange || deadlineFrom || deadlineTo) {
      const now = new Date();
      where.tenderDeadline = {};

      switch (deadlineRange) {
        case 'open':
          where.tenderDeadline.gte = now;
          break;
        case 'expired':
          where.tenderDeadline.lt = now;
          break;
        case '7d':
          where.tenderDeadline.gte = now;
          where.tenderDeadline.lte = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          where.tenderDeadline.gte = now;
          where.tenderDeadline.lte = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          break;
      }

      if (deadlineFrom) where.tenderDeadline.gte = new Date(deadlineFrom);
      if (deadlineTo) where.tenderDeadline.lte = new Date(deadlineTo);
    }

    // 时间范围筛选
    if (timeRange) {
      const now = new Date();
      let dateFrom: Date | null = null;
      switch (timeRange) {
        case '1h':
          dateFrom = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case 'today':
          dateFrom = new Date(now);
          dateFrom.setHours(0, 0, 0, 0);
          break;
        case '7d':
          dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }
      if (dateFrom) {
        where.createdAt = { gte: dateFrom };
      }
    } else if (timeFrom || timeTo) {
      where.createdAt = {};
      if (timeFrom) where.createdAt.gte = new Date(timeFrom as string);
      if (timeTo) where.createdAt.lte = new Date(timeTo as string);
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    // 排序处理
    let orderBy: any;
    const sort = sortBy as string;
    const order = (sortOrder as string) === 'asc' ? 'asc' : 'desc';

    // importance 和 hot 需要在内存中排序（Prisma 不支持自定义排序）
    const needsMemorySort = sort === 'importance' || sort === 'hot' || sort === 'deadlineStatus';

    switch (sort) {
      case 'publishedAt':
        orderBy = [{ publishedAt: order }, { createdAt: 'desc' }];
        break;
      case 'relevance':
        orderBy = { relevance: order };
        break;
      case 'importance':
      case 'hot':
      case 'deadlineStatus':
        orderBy = { createdAt: 'desc' };
        break;
      default:
        orderBy = { createdAt: order };
        break;
    }

    const excludeExpired = getQueryString(includeExpired) === 'false';
    const shouldFetchAll = needsMemorySort || excludeExpired || Boolean(tenderStageValue);

    const rawHotspots = await prisma.hotspot.findMany({
      where,
      orderBy,
      ...(shouldFetchAll ? {} : { skip, take: limitNum }),
      include: {
        keyword: {
          select: { id: true, text: true, category: true }
        }
      }
    });

    const filteredRawHotspots = rawHotspots.filter((item) => {
      if (excludeExpired) {
        const deadline = getEffectiveDeadlineTime(item);
        if (deadline != null && deadline < Date.now()) return false;
      }

      if (tenderStageValue && !matchesTenderStageFilter(item, tenderStageValue)) {
        return false;
      }

      return true;
    });

    let hotspots;
    if (shouldFetchAll) {
      const sorted = sortHotspots(filteredRawHotspots, sort, order as 'asc' | 'desc');
      hotspots = sorted.slice(skip, skip + limitNum);
    } else {
      hotspots = filteredRawHotspots;
    }

    const total = shouldFetchAll ? filteredRawHotspots.length : await prisma.hotspot.count({ where });

    res.json({
      data: hotspots.map((item) => decorateHotspotRecord(item)),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching hotspots:', error);
    res.status(500).json({ error: 'Failed to fetch hotspots' });
  }
});

// 获取热点统计
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalHotspotsAll,
      totalHotspots,
      todayHotspots,
      urgentHotspots,
      sourceStats
    ] = await Promise.all([
      prisma.hotspot.count(),
      prisma.hotspot.count({ where: { source: { in: TENDER_SOURCES } } }),
      prisma.hotspot.count({
        where: { source: { in: TENDER_SOURCES }, createdAt: { gte: today } }
      }),
      prisma.hotspot.count({
        where: { source: { in: TENDER_SOURCES }, importance: 'urgent' }
      }),
      prisma.hotspot.groupBy({
        by: ['source'],
        where: { source: { in: TENDER_SOURCES } },
        _count: { source: true }
      })
    ]);

    res.json({
      totalAll: totalHotspotsAll,
      total: totalHotspots,
      monitoredTotal: totalHotspots,
      legacyTotal: Math.max(0, totalHotspotsAll - totalHotspots),
      today: todayHotspots,
      urgent: urgentHotspots,
      bySource: sourceStats.reduce((acc: Record<string, number>, item: { source: string; _count: { source: number } }) => {
        acc[item.source] = item._count.source;
        return acc;
      }, {} as Record<string, number>)
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


// 获取后端运行概览，供后续监控台前端使用
router.get('/ops/summary', async (req, res) => {
  try {
    await refreshProxyPoolHealth().catch((error) => {
      console.warn('Failed to refresh proxy pool health:', error instanceof Error ? error.message : error);
    });
    const runtimeConfig = await getRuntimeConfig();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalHotspots,
      todayHotspots,
      latestRun,
      recentRuns,
      recentSourceProbes,
      latestSourceProbes,
      hotspotQualityRows,
      aiQualityRows,
      recentAiAnalysisLogs,
      latestAiAnalysisLog
    ] = await Promise.all([
      prisma.hotspot.count({ where: { source: { in: TENDER_SOURCES } } }),
      prisma.hotspot.count({ where: { source: { in: TENDER_SOURCES }, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
      prisma.crawlRun.findFirst({
        orderBy: { startedAt: 'desc' },
        include: { sourceProbes: { orderBy: { createdAt: 'asc' } } }
      }),
      prisma.crawlRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          status: true,
          keywordText: true,
          totalRaw: true,
          totalUnique: true,
          totalFresh: true,
          totalSaved: true,
          totalFiltered: true,
          startedAt: true,
          completedAt: true
        }
      }),
      prisma.sourceProbe.findMany({
        where: {
          createdAt: { gte: since }
        },
        select: {
          sourceId: true,
          runId: true,
          ok: true,
          errorMessage: true,
          resultCount: true
        }
      }),
      prisma.sourceProbe.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          sourceId: true,
          sourceName: true,
          ok: true,
          resultCount: true,
          elapsedMs: true,
          sampleTitle: true,
          sampleUrl: true,
          errorMessage: true,
          createdAt: true
        }
      }),
      prisma.hotspot.findMany({
        where: {
          source: { in: TENDER_SOURCES }
        },
        select: {
          id: true,
          source: true,
          tenderUnit: true,
          tenderBudgetWan: true,
          tenderDeadline: true,
          tenderBidOpenTime: true,
          tenderDocDeadline: true,
          tenderProjectCode: true,
          tenderServiceScope: true,
          tenderQualification: true,
          tenderAddress: true,
          tenderContact: true,
          tenderPhone: true,
          tenderDetailSource: true,
          createdAt: true
        }
      }),
      prisma.hotspot.findMany({
        where: {
          source: { in: TENDER_SOURCES }
        },
        select: {
          source: true,
          relevanceReason: true
        }
      }),
      prisma.aiAnalysisLog.findMany({
        where: {
          createdAt: { gte: since }
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          provider: true,
          status: true,
          fallbackUsed: true,
          attemptCount: true,
          elapsedMs: true,
          relevance: true,
          importance: true,
          reason: true,
          errorMessage: true,
          source: true,
          title: true,
          createdAt: true
        }
      }),
      prisma.aiAnalysisLog.findFirst({
        orderBy: { createdAt: 'desc' },
        select: {
          provider: true,
          status: true,
          fallbackUsed: true,
          attemptCount: true,
          elapsedMs: true,
          relevance: true,
          importance: true,
          reason: true,
          errorMessage: true,
          source: true,
          title: true,
          createdAt: true
        }
      })
    ]);

    const probeFailureSummary24h: Record<string, number> = {};
    const runFailureSummary24h: Record<string, number> = {};
    const failureReasons24h: Record<string, Array<{ reason: string; count: number }>> = {};
    const sourceRunState = new Map<string, { sourceId: string; hasFailure: boolean }>();
    const latestProbeBySource = new Map<string, (typeof latestSourceProbes)[number]>();
    const latestNonEmptyProbeBySource = new Map<string, (typeof latestSourceProbes)[number]>();

    function isEmptySourceProbe(probe?: { ok?: boolean; resultCount?: number | null; errorMessage?: string | null }): boolean {
      if (!probe || (probe.resultCount ?? 0) !== 0) return false;
      const errorText = (probe.errorMessage || '').trim();
      return !errorText || /empty|空结果|probe empty|returned empty|关键词未返回/i.test(errorText);
    }

    function isOperationalProbeFailure(probe: { ok: boolean; resultCount?: number | null; errorMessage?: string | null }): boolean {
      return !probe.ok && !isEmptySourceProbe(probe);
    }

    for (const probe of latestSourceProbes) {
      if (!latestProbeBySource.has(probe.sourceId)) {
        latestProbeBySource.set(probe.sourceId, probe);
      }
      if (!latestNonEmptyProbeBySource.has(probe.sourceId) && probe.ok && probe.resultCount > 0) {
        latestNonEmptyProbeBySource.set(probe.sourceId, probe);
      }
    }

    const enabledSourceIds = new Set(runtimeConfig.tenderSources);
    const sourceHealth = TENDER_SOURCE_ADAPTERS.map((source) => {
      const latestProbe = latestProbeBySource.get(source.id);
      const latestProbeIsFailure = latestProbe ? isOperationalProbeFailure(latestProbe) : false;
      const healthProbe = latestProbeIsFailure
        ? latestProbe
        : latestNonEmptyProbeBySource.get(source.id) ?? latestProbe;
      const runtime = getTenderSourceRuntimeSnapshot(source.id);
      const enabled = enabledSourceIds.has(source.id);
      const latestProbeIsEmpty = isEmptySourceProbe(latestProbe);
      const ok = enabled
        ? Boolean(!latestProbeIsFailure && (healthProbe?.ok || latestProbeIsEmpty || runtime.lastSuccessAt) && !runtime.circuitOpen)
        : false;
      const count = enabled ? healthProbe?.resultCount ?? 0 : 0;
      const error = enabled
        ? latestProbeIsFailure ? latestProbe?.errorMessage ?? runtime.lastError : undefined
        : 'source disabled';
      const sourceStatus = classifyTenderSourceStatus({
        enabled,
        ok,
        count,
        error,
        circuitOpen: runtime.circuitOpen
      });
      return {
        id: source.id,
        name: source.name,
        enabled,
        ok,
        ...sourceStatus,
        count,
        elapsedMs: enabled ? healthProbe?.elapsedMs ?? 0 : 0,
        probeQueries: undefined,
        sampleTitle: enabled ? healthProbe?.sampleTitle ?? undefined : undefined,
        sampleUrl: enabled ? healthProbe?.sampleUrl ?? undefined : undefined,
        error,
        failureCount: runtime.failureCount,
        circuitOpen: runtime.circuitOpen,
        cooldownRemainingMs: runtime.cooldownRemainingMs,
        lastSuccessAt: runtime.lastSuccessAt,
        lastFailureAt: runtime.lastFailureAt
      };
    });

    function normalizeFailureReason(errorMessage?: string | null, resultCount?: number): string {
      const text = (errorMessage || '').trim();
      if (!text) {
        if ((resultCount ?? 0) === 0) return '空结果（关键词未命中）';
        return '未知失败';
      }
      if (/empty|空结果|probe empty|returned empty/i.test(text)) return '空结果（关键词未命中）';
      if (/403|405|forbidden|waf|blocked|challenge|验证码|安全验证|被阻断/i.test(text)) return 'WAF / 安全挑战';
      if (/502|bad gateway/i.test(text)) return '502 网关错误';
      if (/429|too many requests|rate limit/i.test(text)) return '429 限流';
      if (/timeout|timed out|ETIMEDOUT/i.test(text)) return '请求超时';
      if (/circuit open/i.test(text)) return '熔断冷却中';
      if (/ECONNRESET|socket hang up/i.test(text)) return '连接被重置';
      if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return 'DNS / 解析失败';
      return text.slice(0, 48);
    }

    for (const probe of recentSourceProbes) {
      if (isOperationalProbeFailure(probe)) {
        probeFailureSummary24h[probe.sourceId] = (probeFailureSummary24h[probe.sourceId] || 0) + 1;
        const normalizedReason = normalizeFailureReason(probe.errorMessage, probe.resultCount);
        const bucket = failureReasons24h[probe.sourceId] || [];
        const existing = bucket.find((item) => item.reason === normalizedReason);
        if (existing) {
          existing.count += 1;
        } else {
          bucket.push({ reason: normalizedReason, count: 1 });
        }
        failureReasons24h[probe.sourceId] = bucket;
      }

      const key = `${probe.runId}:${probe.sourceId}`;
      const current = sourceRunState.get(key) || {
        sourceId: probe.sourceId,
        hasFailure: false
      };

      if (isOperationalProbeFailure(probe)) {
        current.hasFailure = true;
      }

      sourceRunState.set(key, current);
    }

    for (const item of sourceRunState.values()) {
      if (!item.hasFailure) continue;
      runFailureSummary24h[item.sourceId] = (runFailureSummary24h[item.sourceId] || 0) + 1;
    }

    for (const sourceId of Object.keys(failureReasons24h)) {
      failureReasons24h[sourceId] = failureReasons24h[sourceId]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
    }

    const quality = {
      total: hotspotQualityRows.length,
      unitCount: 0,
      budgetCount: 0,
      deadlineCount: 0,
      contactCount: 0,
      phoneCount: 0,
      detailCount: 0,
      activeCount: 0,
      expiredCount: 0,
      highCompletenessCount: 0
    };
    const sourceQualityMap = new Map<string, {
      source: string;
      total: number;
      unitCount: number;
      budgetCount: number;
      deadlineCount: number;
      contactCount: number;
      phoneCount: number;
      serviceScopeCount: number;
      detailCount: number;
      activeCount: number;
      expiredCount: number;
      highCompletenessCount: number;
      completenessTotal: number;
      missingCounts: Record<string, number>;
      dirtyIssueCount: number;
      dirtyIssues: Map<string, number>;
      detailSourceBreakdown: Record<'missing' | 'blocked' | 'listOnly' | 'deep' | 'rules', number>;
    }>();

    for (const row of hotspotQualityRows) {
      const deadline = getEffectiveDeadlineTime(row);
      const completeness = getTenderFieldCompletenessScore(row);
      const item = sourceQualityMap.get(row.source) || {
        source: row.source,
        total: 0,
        unitCount: 0,
        budgetCount: 0,
        deadlineCount: 0,
        contactCount: 0,
        phoneCount: 0,
        serviceScopeCount: 0,
        detailCount: 0,
        activeCount: 0,
        expiredCount: 0,
        highCompletenessCount: 0,
        completenessTotal: 0,
        missingCounts: {
          unit: 0,
          budget: 0,
          deadline: 0,
          contact: 0,
          phone: 0,
          serviceScope: 0,
          detail: 0
        },
        dirtyIssueCount: 0,
        dirtyIssues: new Map<string, number>(),
        detailSourceBreakdown: {
          missing: 0,
          blocked: 0,
          listOnly: 0,
          deep: 0,
          rules: 0
        }
      };

      item.total += 1;
      item.completenessTotal += completeness;
      quality.total += 0;

      if (isUsableTenderUnit(row.tenderUnit)) {
        quality.unitCount += 1;
        item.unitCount += 1;
      } else {
        item.missingCounts.unit += 1;
      }
      if (isUsableBudgetWan(row.tenderBudgetWan)) {
        quality.budgetCount += 1;
        item.budgetCount += 1;
      } else {
        item.missingCounts.budget += 1;
      }
      if (deadline != null) {
        quality.deadlineCount += 1;
        item.deadlineCount += 1;
      } else {
        item.missingCounts.deadline += 1;
      }
      if (isUsableTenderContact(row.tenderContact)) {
        quality.contactCount += 1;
        item.contactCount += 1;
      } else {
        item.missingCounts.contact += 1;
      }
      if (isUsableTenderPhone(row.tenderPhone)) {
        quality.phoneCount += 1;
        item.phoneCount += 1;
      } else {
        item.missingCounts.phone += 1;
      }
      if (isUsableTenderServiceScope(row.tenderServiceScope)) {
        item.serviceScopeCount += 1;
      } else {
        item.missingCounts.serviceScope += 1;
      }
      if (row.tenderDetailSource) {
        quality.detailCount += 1;
        item.detailCount += 1;
      } else {
        item.missingCounts.detail += 1;
      }
      const detailSourceCategory = classifyTenderDetailSource(row.tenderDetailSource);
      item.detailSourceBreakdown[detailSourceCategory === 'list_only' ? 'listOnly' : detailSourceCategory] += 1;
      if (deadline == null || deadline >= Date.now()) {
        quality.activeCount += 1;
        item.activeCount += 1;
      } else {
        quality.expiredCount += 1;
        item.expiredCount += 1;
      }
      if (completeness >= 60) {
        quality.highCompletenessCount += 1;
        item.highCompletenessCount += 1;
      }

      const dirtyIssues = getTenderDirtyIssues(row);
      item.dirtyIssueCount += dirtyIssues.length;
      for (const issue of dirtyIssues) {
        item.dirtyIssues.set(issue, (item.dirtyIssues.get(issue) || 0) + 1);
      }

      sourceQualityMap.set(row.source, item);
    }

    for (const source of TENDER_SOURCE_ADAPTERS) {
      if (!sourceQualityMap.has(source.id)) {
        sourceQualityMap.set(source.id, {
          source: source.id,
          total: 0,
          unitCount: 0,
          budgetCount: 0,
          deadlineCount: 0,
          contactCount: 0,
          phoneCount: 0,
          serviceScopeCount: 0,
          detailCount: 0,
          activeCount: 0,
          expiredCount: 0,
          highCompletenessCount: 0,
          completenessTotal: 0,
          missingCounts: {
            unit: 0,
            budget: 0,
            deadline: 0,
            contact: 0,
            phone: 0,
            serviceScope: 0,
            detail: 0
          },
          dirtyIssueCount: 0,
          dirtyIssues: new Map<string, number>(),
          detailSourceBreakdown: {
            missing: 0,
            blocked: 0,
            listOnly: 0,
            deep: 0,
            rules: 0
          }
        });
      }
    }

    const sourceQuality = [...sourceQualityMap.values()]
      .map((item) => ({
        source: item.source,
        total: item.total,
        unitCoverage: item.total ? Math.round((item.unitCount / item.total) * 100) : 0,
        budgetCoverage: item.total ? Math.round((item.budgetCount / item.total) * 100) : 0,
        deadlineCoverage: item.total ? Math.round((item.deadlineCount / item.total) * 100) : 0,
        contactCoverage: item.total ? Math.round((item.contactCount / item.total) * 100) : 0,
        phoneCoverage: item.total ? Math.round((item.phoneCount / item.total) * 100) : 0,
        serviceScopeCoverage: item.total ? Math.round((item.serviceScopeCount / item.total) * 100) : 0,
        detailCoverage: item.total ? Math.round((item.detailCount / item.total) * 100) : 0,
        detailSourceBreakdown: item.detailSourceBreakdown,
        activeCount: item.activeCount,
        expiredCount: item.expiredCount,
        highCompletenessCount: item.highCompletenessCount,
        avgCompleteness: item.total ? Math.round(item.completenessTotal / item.total) : 0,
        missingCounts: item.missingCounts,
        dirtyIssueCount: item.dirtyIssueCount,
        dirtyIssues: [...item.dirtyIssues.entries()]
          .map(([issue, count]) => ({ issue, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
        repairHints: buildRepairHints(item),
        qualityScore: Math.max(0, Math.min(100, Math.round(
          (item.total ? item.completenessTotal / item.total : 0)
          - (item.total ? (item.dirtyIssueCount / item.total) * 12 : 0)
        )))
      }))
      .map((item) => ({
        ...item,
        qualityGrade: item.total === 0
          ? 'no_sample'
          : item.qualityScore >= 70
            ? 'good'
            : item.qualityScore >= 45
              ? 'needs_enrichment'
              : 'poor'
      }))
      .sort((a, b) => b.qualityScore - a.qualityScore);

    const sourceQualityById = new Map(sourceQuality.map((item) => [item.source, item]));
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    function averageQualityForRows(rows: typeof hotspotQualityRows): number {
      if (rows.length === 0) return 0;
      const total = rows.reduce((sum, row) => {
        const completeness = getTenderFieldCompletenessScore(row);
        const dirtyPenalty = getTenderDirtyIssues(row).length * 12;
        return sum + Math.max(0, Math.min(100, completeness - dirtyPenalty));
      }, 0);
      return Math.round(total / rows.length);
    }

    const sourceQualityTrend = TENDER_SOURCE_ADAPTERS.map((source) => {
      const sourceRows = hotspotQualityRows.filter((row) => row.source === source.id);
      const rows7d = sourceRows.filter((row) => new Date(row.createdAt).getTime() >= sevenDaysAgo);
      const rows30d = sourceRows.filter((row) => new Date(row.createdAt).getTime() >= thirtyDaysAgo);
      const score7d = averageQualityForRows(rows7d);
      const score30d = averageQualityForRows(rows30d);
      const delta = score7d - score30d;
      return {
        source: source.id,
        score7d,
        score30d,
        delta,
        sample7d: rows7d.length,
        sample30d: rows30d.length,
        direction: delta > 3 ? 'up' : delta < -3 ? 'down' : 'flat'
      };
    });

    const proxySnapshot = getProxyPoolSnapshot();
    const proxyAlerts = proxySnapshot
      .filter((item) => item.alertLevel !== 'healthy' || item.coolingDown || item.thresholdTriggered)
      .map((item) => {
        const detail = item.thresholdTriggered
          ? `连续 ${item.consecutiveFailureStreak} 次 ${item.consecutiveFailureLabel || item.probeStatusLabel}，已触发阈值通知；当前路由策略为 ${item.routingModeLabel}`
          : item.coolingDown
            ? `已进入冷却，剩余约 ${Math.ceil(item.cooldownRemainingMs / 1000)} 秒；当前会优先降级到其他代理或直连`
            : item.probeStatus === 'gateway_502'
              ? '主动探测命中 502，当前会优先走其他健康出口，再回退到直连'
              : item.probeStatus === 'timeout'
                ? '主动探测超时，当前会降低该出口优先级，避免拖慢整轮抓取'
                : item.probeStatus === 'tunnel_unreachable'
                  ? '本地隧道不可达，当前会直接跳过该代理并走其他出口/直连'
                  : item.probeStatus === 'auth_required'
                    ? '代理认证失败，当前会跳过该出口直到配置恢复'
                    : item.lastProbeError || item.lastError || item.probeStatusLabel;
        return {
          id: item.id,
          severity: item.thresholdTriggered ? 'critical' : item.alertLevel,
          label: item.thresholdTriggered ? '连续异常已越线' : item.probeStatusLabel,
          category: item.thresholdTriggered ? item.consecutiveFailureCategory || item.probeStatus : item.probeStatus,
          detail,
          thresholdTriggered: item.thresholdTriggered,
          thresholdTriggeredAt: item.thresholdTriggeredAt,
          consecutiveFailureStreak: item.consecutiveFailureStreak,
          alertThreshold: item.alertThreshold,
        };
      });
    const sourceAcceptance = TENDER_SOURCE_ADAPTERS.map((source) => {
      const qualityItem = sourceQualityById.get(source.id);
      const healthItem = sourceHealth.find((item) => item.id === source.id);
      const latestProbe = latestProbeBySource.get(source.id);
      const proxyPolicy = getSourceProxyPolicy(source.id, proxySnapshot);
      const deepCrawlStrategy = getSourceDeepCrawlStrategy(source.id);
      const checks = [
        {
          key: 'isolated_probe',
          label: '单源隔离',
          ok: true,
          detail: DEFAULT_SOURCE_SET.has(source.id) ? '默认生产源' : '新源默认不加入生产扫描，可单源探测'
        },
        {
          key: 'non_empty_sample',
          label: '非空样本',
          ok: Boolean((qualityItem?.total ?? 0) > 0 || (latestProbe?.resultCount ?? 0) > 0),
          detail: `入库样本 ${qualityItem?.total ?? 0} 条，最近探测 ${latestProbe?.resultCount ?? 0} 条`
        },
        {
          key: 'field_quality',
          label: '字段质量',
          ok: (qualityItem?.qualityScore ?? 0) >= 40,
          detail: `质量分 ${qualityItem?.qualityScore ?? 0}，平均完整度 ${qualityItem?.avgCompleteness ?? 0}`
        },
        {
          key: 'detail_reliability',
          label: '详情可靠',
          ok: (qualityItem?.detailCoverage ?? 0) >= 30 || deepCrawlStrategy.enabled,
          detail: `详情覆盖 ${qualityItem?.detailCoverage ?? 0}%；${deepCrawlStrategy.note}`
        },
        {
          key: 'failure_classified',
          label: '失败可解释',
          ok: !healthItem || !['request_failed'].includes(healthItem.status || ''),
          detail: healthItem?.statusReason || healthItem?.statusLabel || '暂无未知失败'
        }
      ];
      const passedCount = checks.filter((item) => item.ok).length;
      const eligibleForProduction = checks.every((item) => item.ok);
      return {
        source: source.id,
        name: source.name,
        defaultSource: DEFAULT_SOURCE_SET.has(source.id),
        enabled: runtimeConfig.tenderSources.includes(source.id),
        eligibleForProduction,
        passedCount,
        totalChecks: checks.length,
        acceptanceScore: Math.round((passedCount / checks.length) * 100),
        checks,
        proxyPolicy,
        deepCrawlStrategy,
        nextAction: eligibleForProduction
          ? '可考虑加入生产扫描或提高扫描配额'
          : checks.find((item) => !item.ok)?.detail || '继续观察'
      };
    });

    const qualitySummary = {
      ...quality,
      unitCoverage: quality.total ? Math.round((quality.unitCount / quality.total) * 100) : 0,
      budgetCoverage: quality.total ? Math.round((quality.budgetCount / quality.total) * 100) : 0,
      deadlineCoverage: quality.total ? Math.round((quality.deadlineCount / quality.total) * 100) : 0,
      contactCoverage: quality.total ? Math.round((quality.contactCount / quality.total) * 100) : 0,
      phoneCoverage: quality.total ? Math.round((quality.phoneCount / quality.total) * 100) : 0,
      detailCoverage: quality.total ? Math.round((quality.detailCount / quality.total) * 100) : 0,
      activeCoverage: quality.total ? Math.round((quality.activeCount / quality.total) * 100) : 0
    };
    const aiSummary = {
      total: aiQualityRows.length,
      successCount: 0,
      fallbackCount: 0,
      fallbackReasons: [] as Array<{ reason: string; count: number }>
    };
    const aiReasonBuckets = new Map<string, number>();

    function normalizeAIReason(reason?: string | null): string {
      const text = (reason || '').trim();
      if (/未配置 AI 服务/.test(text)) return '未配置 AI 服务';
      if (/AI 分析超时或失败|规则投标分析|规则判断/.test(text)) return 'AI 超时/失败后规则回退';
      if (!text) return '无 AI 判断记录';
      return 'AI 成功返回';
    }

    for (const row of aiQualityRows) {
      const reason = normalizeAIReason(row.relevanceReason);
      if (reason === 'AI 成功返回') {
        aiSummary.successCount += 1;
      } else {
        aiSummary.fallbackCount += 1;
      }
      aiReasonBuckets.set(reason, (aiReasonBuckets.get(reason) || 0) + 1);
    }

    aiSummary.fallbackReasons = [...aiReasonBuckets.entries()]
      .filter(([reason]) => reason !== 'AI 成功返回')
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    const aiLogSummary = {
      source: recentAiAnalysisLogs.length > 0 ? 'logs' : 'hotspotReason',
      total: recentAiAnalysisLogs.length || aiSummary.total,
      successCount: 0,
      fallbackCount: 0,
      errorCount: 0,
      successRate: 0,
      fallbackRate: 0,
      averageElapsedMs: 0,
      p95ElapsedMs: 0,
      latestAt: latestAiAnalysisLog?.createdAt ?? null,
      providerStats: [] as Array<{ provider: string; total: number; successCount: number; fallbackCount: number; averageElapsedMs: number }>,
      fallbackReasons: aiSummary.fallbackReasons,
      recentFailures: [] as Array<{ title: string | null; source: string | null; reason: string; elapsedMs: number; createdAt: Date }>
    };

    if (recentAiAnalysisLogs.length > 0) {
      const elapsedValues = recentAiAnalysisLogs
        .map((row) => row.elapsedMs)
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((a, b) => a - b);
      const providerMap = new Map<string, { provider: string; total: number; successCount: number; fallbackCount: number; elapsedTotal: number }>();
      const fallbackBuckets = new Map<string, number>();

      for (const row of recentAiAnalysisLogs) {
        if (row.status === 'success' && !row.fallbackUsed) {
          aiLogSummary.successCount += 1;
        } else if (row.status === 'error') {
          aiLogSummary.errorCount += 1;
        } else {
          aiLogSummary.fallbackCount += 1;
        }

        const provider = row.provider || 'unknown';
        const providerItem = providerMap.get(provider) || {
          provider,
          total: 0,
          successCount: 0,
          fallbackCount: 0,
          elapsedTotal: 0
        };
        providerItem.total += 1;
        providerItem.elapsedTotal += row.elapsedMs || 0;
        if (row.status === 'success' && !row.fallbackUsed) {
          providerItem.successCount += 1;
        } else {
          providerItem.fallbackCount += 1;
        }
        providerMap.set(provider, providerItem);

        if (row.fallbackUsed || row.status !== 'success') {
          const reason = row.errorMessage || row.reason || '未知 AI 回退';
          fallbackBuckets.set(reason, (fallbackBuckets.get(reason) || 0) + 1);
        }
      }

      aiLogSummary.averageElapsedMs = elapsedValues.length
        ? Math.round(elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length)
        : 0;
      aiLogSummary.p95ElapsedMs = elapsedValues.length
        ? elapsedValues[Math.min(elapsedValues.length - 1, Math.floor(elapsedValues.length * 0.95))]
        : 0;
      aiLogSummary.successRate = aiLogSummary.total ? Math.round((aiLogSummary.successCount / aiLogSummary.total) * 100) : 0;
      aiLogSummary.fallbackRate = aiLogSummary.total ? Math.round(((aiLogSummary.fallbackCount + aiLogSummary.errorCount) / aiLogSummary.total) * 100) : 0;
      aiLogSummary.providerStats = [...providerMap.values()]
        .map((item) => ({
          provider: item.provider,
          total: item.total,
          successCount: item.successCount,
          fallbackCount: item.fallbackCount,
          averageElapsedMs: item.total ? Math.round(item.elapsedTotal / item.total) : 0
        }))
        .sort((a, b) => b.total - a.total);
      aiLogSummary.fallbackReasons = [...fallbackBuckets.entries()]
        .map(([reason, count]) => ({ reason: reason.slice(0, 80), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      aiLogSummary.recentFailures = recentAiAnalysisLogs
        .filter((row) => row.fallbackUsed || row.status !== 'success')
        .slice(0, 5)
        .map((row) => ({
          title: row.title,
          source: row.source,
          reason: (row.errorMessage || row.reason || '未知 AI 回退').slice(0, 120),
          elapsedMs: row.elapsedMs,
          createdAt: row.createdAt
        }));
    } else {
      aiLogSummary.successCount = aiSummary.successCount;
      aiLogSummary.fallbackCount = aiSummary.fallbackCount;
      aiLogSummary.successRate = aiSummary.total ? Math.round((aiSummary.successCount / aiSummary.total) * 100) : 0;
      aiLogSummary.fallbackRate = aiSummary.total ? Math.round((aiSummary.fallbackCount / aiSummary.total) * 100) : 0;
    }

    res.json({
      stats: {
        totalHotspots,
        todayHotspots
      },
      quality: qualitySummary,
      ai: aiLogSummary,
      sourceQuality,
      sourceQualityTrend,
      sourceAcceptance,
      sourceCandidatePool: SOURCE_CANDIDATE_POOL,
      runtimeConfig,
      sourceHealth,
      proxyPool: proxySnapshot,
      proxyAlerts,
      recentRuns,
      latestRun,
      failureSummary24h: probeFailureSummary24h,
      probeFailureSummary24h,
      runFailureSummary24h,
      failureReasons24h
    });
  } catch (error) {
    console.error('Error fetching ops summary:', error);
    res.status(500).json({ error: 'Failed to fetch ops summary' });
  }
});

// 获取来源健康状态与样例
router.get('/sources', async (req, res) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query : 'BIM';
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 3;
    const data = await probeTenderSources(query, Number.isFinite(limit) ? limit : 3);
    res.json({ data });
  } catch (error) {
    console.error('Error probing sources:', error);
    res.status(500).json({ error: 'Failed to probe sources' });
  }
});

// 获取抓取运行日志
router.get('/runs', async (req, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
    const runs = await prisma.crawlRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Number.isFinite(limit) ? Math.min(limit, 100) : 20,
      include: {
        sourceProbes: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    res.json({ data: runs });
  } catch (error) {
    console.error('Error fetching crawl runs:', error);
    res.status(500).json({ error: 'Failed to fetch crawl runs' });
  }
});

router.get('/detail-enrichment/status', async (_req, res) => {
  try {
    const queue = getDetailEnrichmentQueueState();
    const latest = await prisma.hotspot.findMany({
      where: {
        source: { in: TENDER_SOURCES }
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const completeness = latest.map(item => ({
      id: item.id,
      title: item.title,
      completenessScore: getTenderFieldCompletenessScore(item as any),
      tenderDetailExtractedAt: item.tenderDetailExtractedAt
    }));

    res.json({ queue, data: completeness });
  } catch (error) {
    console.error('Error fetching detail enrichment status:', error);
    res.status(500).json({ error: 'Failed to fetch detail enrichment status' });
  }
});

router.post('/detail-enrichment/run', async (req, res) => {
  try {
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : 20;
    const source = typeof req.body?.source === 'string' ? req.body.source : undefined;
    const queued = await enqueueIncompleteHotspots(limit, { source });
    res.status(202).json({
      queued,
      source: source || 'all',
      queue: getDetailEnrichmentQueueState()
    });
  } catch (error) {
    console.error('Error queueing detail enrichment:', error);
    res.status(500).json({ error: 'Failed to queue detail enrichment' });
  }
});

router.post('/:id/notify-feishu', async (req, res) => {
  try {
    if (!isFeishuWebhookEnabled()) {
      return res.status(400).json({ error: 'Feishu webhook is not configured' });
    }

    const hotspot = await prisma.hotspot.findUnique({
      where: { id: req.params.id },
      include: {
        keyword: {
          select: { text: true }
        }
      }
    });

    if (!hotspot) {
      return res.status(404).json({ error: 'Hotspot not found' });
    }

    const webhook = await notifyFeishuWebhook(hotspot, { force: true });
    if (!webhook) {
      return res.status(502).json({ error: 'Failed to send Feishu webhook' });
    }

    await prisma.notification.create({
      data: {
        type: 'feishu',
        title: `已手动推送飞书: ${hotspot.title.slice(0, 50)}`,
        content: hotspot.summary || hotspot.title,
        hotspotId: hotspot.id
      }
    });

    res.json({ webhook: true });
  } catch (error) {
    console.error('Error manually notifying Feishu:', error);
    res.status(500).json({ error: 'Failed to notify Feishu' });
  }
});

// 获取单个热点
router.get('/:id', async (req, res) => {
  try {
    const hotspot = await prisma.hotspot.findUnique({
      where: { id: req.params.id },
      include: {
        keyword: true
      }
    });

    if (!hotspot) {
      return res.status(404).json({ error: 'Hotspot not found' });
    }

    res.json(decorateHotspotRecord(hotspot));
  } catch (error) {
    console.error('Error fetching hotspot:', error);
    res.status(500).json({ error: 'Failed to fetch hotspot' });
  }
});

// 手动搜索热点
router.post('/search', async (req, res) => {
  try {
    const requestedSources = Array.isArray(req.body.sources) ? req.body.sources : TENDER_SOURCES;
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const { analyzeContent } = await import('../services/ai.js');
    const { expandKeyword } = await import('../services/ai.js');

    const results: any[] = [];
    const expandedKeywords = await expandKeyword(query);
    const searchQueries = await buildSearchQueries(query, expandedKeywords);
    const sources = await getEnabledTenderSources(requestedSources);

    for (const source of sources) {
      try {
        const tenderResults = await searchTenderSourceAcrossQueries(source, searchQueries, 10);
        results.push(...tenderResults);
      } catch (error) {
        console.error(`${source.id} search failed:`, error);
      }
    }

    // AI 分析前几个结果
    const analyzedResults = await Promise.all(
      results.slice(0, 10).map(async (item) => {
        try {
          const analysis = await analyzeContent(item.title + ' ' + item.content, query);
          return decorateHotspotRecord({
            ...item,
            id: `${item.source}:${item.sourceId || item.url}`,
            isReal: analysis.isReal,
            relevance: analysis.relevance,
            relevanceReason: analysis.relevanceReason,
            keywordMentioned: analysis.keywordMentioned,
            importance: analysis.importance,
            summary: analysis.summary,
            tenderType: item.tender?.type ?? null,
            tenderRegion: item.tender?.region ?? null,
            tenderCity: item.tender?.city ?? null,
            tenderUnit: item.tender?.unit ?? null,
            tenderBudgetWan: item.tender?.budgetWan ?? null,
            tenderDeadline: item.tender?.deadline ?? null,
            tenderNoticeType: item.tender?.noticeType ?? null,
            tenderPlatform: item.tender?.platform ?? null,
            keyword: null,
            createdAt: new Date(),
            analysis
          });
        } catch {
          return decorateHotspotRecord({
            ...item,
            id: `${item.source}:${item.sourceId || item.url}`,
            isReal: true,
            relevance: 0,
            relevanceReason: null,
            keywordMentioned: null,
            importance: 'low',
            summary: null,
            tenderType: item.tender?.type ?? null,
            tenderRegion: item.tender?.region ?? null,
            tenderCity: item.tender?.city ?? null,
            tenderUnit: item.tender?.unit ?? null,
            tenderBudgetWan: item.tender?.budgetWan ?? null,
            tenderDeadline: item.tender?.deadline ?? null,
            tenderNoticeType: item.tender?.noticeType ?? null,
            tenderPlatform: item.tender?.platform ?? null,
            keyword: null,
            createdAt: new Date(),
            analysis: null
          });
        }
      })
    );

    res.json({ results: analyzedResults });
  } catch (error) {
    console.error('Error searching hotspots:', error);
    res.status(500).json({ error: 'Failed to search hotspots' });
  }
});

// 删除热点
router.delete('/:id', async (req, res) => {
  try {
    await prisma.hotspot.delete({
      where: { id: req.params.id }
    });

    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Hotspot not found' });
    }
    console.error('Error deleting hotspot:', error);
    res.status(500).json({ error: 'Failed to delete hotspot' });
  }
});

export default router;
