import { Router } from 'express';
import { prisma } from '../db.js';
import { getDailyReportQueueState, startDailyReportInBackground } from '../jobs/dailyReportQueue.js';
import { getDailyReportHealth, getLatestDailyReportRecord, listDailyKeywords, serializeDailyArticle, serializeDailyReportShape } from '../services/dailyReports.js';

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

router.get('/reports', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 30);
    const skip = (page - 1) * limit;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const dateFrom = parseDateBoundary(req.query.dateFrom, 'start');
    const dateTo = parseDateBoundary(req.query.dateTo, 'end');

    const where: Record<string, unknown> = {};
    if (dateFrom || dateTo) {
      where.reportDate = {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {})
      };
    }

    if (source || keyword) {
      where.articles = {
        some: {
          ...(source ? { sourceId: source } : {}),
          ...(keyword ? { keywordHits: { some: { keyword: { slug: keyword } } } } : {})
        }
      };
    }

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
    const reportDate = parseDateBoundary(req.query.reportDate, 'start');

    const where: Record<string, unknown> = {};
    if (source) where.sourceId = source;
    if (reportId) where.reportId = reportId;
    if (reportDate && !reportId) {
      const end = new Date(reportDate.getTime() + 24 * 60 * 60 * 1000 - 1);
      where.reportDate = { gte: reportDate, lte: end };
    }
    if (keyword) {
      where.keywordHits = {
        some: {
          keyword: {
            slug: keyword
          }
        }
      };
    }

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
    const health = await getDailyReportHealth();
    res.json({
      ...health,
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

export default router;
