import { Router } from 'express';
import { prisma } from '../db.js';
import { getDailyReportQueueState, startDailyReportInBackground } from '../jobs/dailyReportQueue.js';
import {
  buildDailyArticleWhere,
  buildDailyReportWhere,
  getDailyReportHealth,
  getLatestDailyOverview,
  getLatestDailyReportRecord,
  listDailyKeywords,
  serializeDailyArticle,
  serializeDailyReportShape,
  updateDailyOverviewPreferences
} from '../services/dailyReports.js';
import { getLatestDailyReportPushLog, listRecentDailyReportPushLogs, pushDailyReportToFeishu } from '../services/dailyReportFeishu.js';

const router = Router();

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseDateBoundary(value: unknown, fallbackTime: 'start' | 'end'): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  const hasTime = normalized.includes('T');
  const date = new Date(hasTime ? normalized : `${normalized}${fallbackTime === 'start' ? 'T00:00:00+08:00' : 'T23:59:59+08:00'}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

router.get('/today', async (_req, res) => {
  try {
    const report = await getLatestDailyReportRecord();
    if (!report) {
      return res.json({ report: null, articles: [] });
    }

    const articles = await prisma.dailyArticle.findMany({
      where: { reportId: report.id },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        source: true,
        keywordHits: {
          include: {
            keyword: true
          }
        }
      }
    });

    res.json({
      report: serializeDailyReportShape(report),
      articles: articles.map((item) => serializeDailyArticle(item))
    });
  } catch (error) {
    console.error('Error fetching today daily report:', error);
    res.status(500).json({ error: 'Failed to fetch today daily report' });
  }
});

router.get('/overview', async (_req, res) => {
  try {
    res.json({
      overview: await getLatestDailyOverview()
    });
  } catch (error) {
    console.error('Error fetching daily report overview:', error);
    res.status(500).json({ error: 'Failed to fetch daily report overview' });
  }
});

router.patch('/overview/preferences', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const overview = await updateDailyOverviewPreferences(items.map((item: Record<string, unknown>) => ({
      key: typeof item.key === 'string' ? item.key : '',
      pinned: typeof item.pinned === 'boolean' ? item.pinned : undefined,
      manualOrder: typeof item.manualOrder === 'number' && Number.isFinite(item.manualOrder)
        ? item.manualOrder
        : item.manualOrder === null
          ? null
          : undefined
    })));
    res.json({ overview });
  } catch (error) {
    console.error('Error updating daily report overview preferences:', error);
    res.status(500).json({ error: 'Failed to update daily report overview preferences' });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 30);
    const skip = (page - 1) * limit;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const searchText = typeof req.query.searchText === 'string' ? req.query.searchText.trim() : '';
    const dateFrom = parseDateBoundary(req.query.dateFrom, 'start');
    const dateTo = parseDateBoundary(req.query.dateTo, 'end');

    const where = buildDailyReportWhere({ source, keyword, searchText, dateFrom, dateTo });

    const [reports, total] = await Promise.all([
      prisma.dailyReport.findMany({
        where,
        orderBy: { reportDate: 'desc' },
        skip,
        take: limit
      }),
      prisma.dailyReport.count({ where })
    ]);

    res.json({
      data: reports.map((item) => serializeDailyReportShape(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    console.error('Error fetching daily report history:', error);
    res.status(500).json({ error: 'Failed to fetch daily report history' });
  }
});

router.get('/reports/:id', async (req, res) => {
  try {
    const report = await prisma.dailyReport.findUnique({
      where: { id: req.params.id }
    });

    if (!report) {
      return res.status(404).json({ error: 'Daily report not found' });
    }

    res.json(serializeDailyReportShape(report));
  } catch (error) {
    console.error('Error fetching daily report:', error);
    res.status(500).json({ error: 'Failed to fetch daily report' });
  }
});

router.get('/articles', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 50);
    const skip = (page - 1) * limit;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const reportId = typeof req.query.reportId === 'string' ? req.query.reportId.trim() : '';
    const searchText = typeof req.query.searchText === 'string' ? req.query.searchText.trim() : '';
    const reportDate = parseDateBoundary(req.query.reportDate, 'start');
    const where = buildDailyArticleWhere({ source, keyword, reportId, reportDate, searchText });

    const [articles, total] = await Promise.all([
      prisma.dailyArticle.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: {
          source: true,
          keywordHits: {
            include: {
              keyword: true
            }
          }
        }
      }),
      prisma.dailyArticle.count({ where })
    ]);

    res.json({
      data: articles.map((item) => serializeDailyArticle(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    console.error('Error fetching daily articles:', error);
    res.status(500).json({ error: 'Failed to fetch daily articles' });
  }
});

router.get('/keywords', async (_req, res) => {
  try {
    res.json(await listDailyKeywords());
  } catch (error) {
    console.error('Error fetching daily keywords:', error);
    res.status(500).json({ error: 'Failed to fetch daily keywords' });
  }
});

router.get('/health', async (_req, res) => {
  try {
    const [health, latestPush, pushHistory] = await Promise.all([
      getDailyReportHealth(),
      getLatestDailyReportPushLog(),
      listRecentDailyReportPushLogs()
    ]);
    res.json({
      ...health,
      latestPush,
      pushHistory,
      queue: getDailyReportQueueState()
    });
  } catch (error) {
    console.error('Error fetching daily report health:', error);
    res.status(500).json({ error: 'Failed to fetch daily report health' });
  }
});

router.post('/run', async (_req, res) => {
  try {
    const result = startDailyReportInBackground('manual');
    res.status(result.accepted ? 202 : 409).json({
      ...result,
      state: getDailyReportQueueState()
    });
  } catch (error) {
    console.error('Error triggering daily report:', error);
    res.status(500).json({ error: 'Failed to trigger daily report' });
  }
});

router.post('/reports/:id/push-feishu', async (req, res) => {
  try {
    const report = await prisma.dailyReport.findUnique({
      where: { id: req.params.id },
      select: { id: true }
    });

    if (!report) {
      return res.status(404).json({ error: 'Daily report not found' });
    }

    const result = await pushDailyReportToFeishu(report.id, {
      triggerType: 'manual_push',
      force: true
    });

    res.json({
      status: result.status,
      log: result.log
    });
  } catch (error) {
    console.error('Error pushing BIM daily report to Feishu:', error);
    res.status(500).json({ error: 'Failed to push BIM daily report to Feishu' });
  }
});

export default router;
