import { Router } from 'express';
import { prisma } from '../db.js';
import { sortHotspots } from '../utils/sortHotspots.js';
import {
  TENDER_SOURCE_IDS,
  getEnabledTenderSources,
  probeTenderSources,
  searchTenderSourceAcrossQueries,
  buildSearchQueries
} from '../services/tenderSourceRegistry.js';
import { getRuntimeConfig } from '../services/runtimeConfig.js';
import {
  enqueueIncompleteHotspots,
  getDetailEnrichmentQueueState,
  getTenderFieldCompletenessScore
} from '../services/tenderDetailEnrichment.js';

const router = Router();
const TENDER_SOURCES = TENDER_SOURCE_IDS;

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

// 获取所有热点
router.get('/', async (req, res) => {
  try {
    const { 
      page = '1', 
      limit = '20', 
      source, 
      searchText,
      importance,
      keywordId,
      isReal,
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
    const searchTextValue = getQueryString(searchText);
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
    if (tenderPlatformValue) where.tenderPlatform = tenderPlatformValue;
    if (searchTextValue) {
      andConditions.push({
        OR: [
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
        ]
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
    const needsMemorySort = sort === 'importance' || sort === 'hot';

    switch (sort) {
      case 'publishedAt':
        orderBy = [{ publishedAt: order }, { createdAt: 'desc' }];
        break;
      case 'relevance':
        orderBy = { relevance: order };
        break;
      case 'importance':
      case 'hot':
        orderBy = { createdAt: 'desc' };
        break;
      default:
        orderBy = { createdAt: order };
        break;
    }

    const [rawHotspots, total] = await Promise.all([
      prisma.hotspot.findMany({
        where,
        orderBy,
        ...(needsMemorySort ? {} : { skip, take: limitNum }),
        include: {
          keyword: {
            select: { id: true, text: true, category: true }
          }
        }
      }),
      prisma.hotspot.count({ where })
    ]);

    let hotspots;
    if (needsMemorySort) {
      const sorted = sortHotspots(rawHotspots, sort, order as 'asc' | 'desc');
      hotspots = sorted.slice(skip, skip + limitNum);
    } else {
      hotspots = rawHotspots;
    }

    res.json({
      data: hotspots,
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
      totalHotspots,
      todayHotspots,
      urgentHotspots,
      sourceStats
    ] = await Promise.all([
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
      total: totalHotspots,
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
    const runtimeConfig = await getRuntimeConfig();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalHotspots,
      todayHotspots,
      latestRun,
      recentRuns,
      recentFailures
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
      prisma.sourceProbe.groupBy({
        by: ['sourceId'],
        where: {
          createdAt: { gte: since },
          ok: false
        },
        _count: { sourceId: true }
      })
    ]);

    const sourceHealth = await probeTenderSources('BIM', 1);

    res.json({
      stats: {
        totalHotspots,
        todayHotspots
      },
      runtimeConfig,
      sourceHealth,
      recentRuns,
      latestRun,
      failureSummary24h: recentFailures.reduce((acc: Record<string, number>, item: { sourceId: string; _count: { sourceId: number } }) => {
        acc[item.sourceId] = item._count.sourceId;
        return acc;
      }, {} as Record<string, number>)
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
    const queued = await enqueueIncompleteHotspots(limit);
    res.status(202).json({
      queued,
      queue: getDetailEnrichmentQueueState()
    });
  } catch (error) {
    console.error('Error queueing detail enrichment:', error);
    res.status(500).json({ error: 'Failed to queue detail enrichment' });
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

    res.json(hotspot);
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
          return {
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
          };
        } catch {
          return {
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
          };
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
