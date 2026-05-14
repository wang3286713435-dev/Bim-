import { prisma } from '../db.js';
import { generateStructuredJson } from './llmProvider.js';
import { buildKeywordHitPreview, matchDailyKeywords, type DailyKeywordHit } from './dailyKeywordMatcher.js';
import { buildDailyReportDraft, type DailyArticleDraft, type DailyReportDraft, type DailySectionTitle } from './dailyReportBuilder.js';
import { DAILY_SOURCE_DEFINITIONS, type DailySourceId } from './dailyReportRegistry.js';
import { fetchDailySourceArticles, pickDailySourceWindow, type DailySourceArticle } from './dailySources.js';

const DAILY_REPORT_LOOKBACK_HOURS = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_LOOKBACK_HOURS || '24', 10) || 24);
const DAILY_REPORT_FALLBACK_LOOKBACK_HOURS = Math.max(DAILY_REPORT_LOOKBACK_HOURS, Number.parseInt(process.env.DAILY_REPORT_FALLBACK_LOOKBACK_HOURS || '48', 10) || 48);
const DAILY_REPORT_ARTICLES_PER_SOURCE = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_ARTICLES_PER_SOURCE || '6', 10) || 6);
const DAILY_REPORT_AI_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.DAILY_REPORT_AI_CONCURRENCY || '2', 10) || 2));
const DAILY_REPORT_TIMEZONE = process.env.DAILY_REPORT_TIMEZONE || 'Asia/Shanghai';

type DailyKeywordRecord = {
  id: string;
  label: string;
  slug: string;
  aliasesJson: string | null;
  category: string | null;
  sortOrder: number;
};

type DailyRunSourceSummary = {
  sourceId: DailySourceId;
  sourceName: string;
  ok: boolean;
  resultCount: number;
  elapsedMs: number;
  errorMessage?: string;
};

type StoredDailySectionItem = DailyArticleDraft & {
  keywordHitPreview: string | null;
};

type StoredDailySection = {
  title: DailySectionTitle;
  summary: string;
  items: StoredDailySectionItem[];
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateParts(date = new Date()): { key: string; label: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const key = formatter.format(date);
  return { key, label: key };
}

function toReportDate(date = new Date()): Date {
  const { key } = formatDateParts(date);
  return new Date(`${key}T00:00:00+08:00`);
}

function parseAliases(value: string | null): string[] {
  return safeJsonParse<string[]>(value, []);
}

function buildFallbackArticleSummary(article: DailySourceArticle): string {
  const excerpt = normalizeText(article.excerpt || '');
  if (!excerpt) {
    return `${article.sourceName}更新：${article.title}`.slice(0, 120);
  }
  return excerpt.slice(0, 120);
}

async function summarizeDailyArticle(article: DailySourceArticle): Promise<string> {
  try {
    const result = await generateStructuredJson<{ summary: string }>([
      {
        role: 'system',
        content: '你是 BIM 行业资讯编辑。基于标题和摘要，输出 1-2 句、80 字以内的中文资讯摘要。仅输出 JSON：{"summary":"..."}。摘要要说明它属于政策、观点、案例、软件或标准中的哪类信息。'
      },
      {
        role: 'user',
        content: `来源：${article.sourceName}\n标题：${article.title}\n摘要：${article.excerpt || '无摘要'}\n发布时间：${article.publishedAt?.toISOString() || '未知'}`
      }
    ], {
      maxTokens: 180,
      temperature: 0.2
    });
    return normalizeText(result.summary || '') || buildFallbackArticleSummary(article);
  } catch {
    return buildFallbackArticleSummary(article);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let currentIndex = 0;

  async function runner() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

async function buildDailyArticleDrafts(sourceArticles: DailySourceArticle[]): Promise<Array<DailyArticleDraft & { keywordHitPreview: string | null }>> {
  const keywords = await prisma.dailyKeyword.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });

  const keywordInputs = keywords.map((item) => ({
    id: item.id,
    label: item.label,
    slug: item.slug,
    category: item.category,
    aliases: parseAliases(item.aliasesJson)
  }));

  return mapWithConcurrency(sourceArticles, DAILY_REPORT_AI_CONCURRENCY, async (article) => {
    const summary = await summarizeDailyArticle(article);
    const hitResult = matchDailyKeywords({
      title: article.title,
      excerpt: article.excerpt,
      aiSummary: summary
    }, keywordInputs);

    return {
      sourceId: article.sourceId,
      sourceName: article.sourceName,
      title: article.title,
      excerpt: article.excerpt,
      summary,
      url: article.url,
      publishedAt: article.publishedAt,
      matchedKeywords: hitResult.matchedKeywords,
      keywordHitPreview: hitResult.keywordHitPreview
    };
  });
}

async function enhanceReportDraftWithAI(draft: DailyReportDraft): Promise<DailyReportDraft> {
  try {
    const result = await generateStructuredJson<{
      title: string;
      intro: string;
      executiveSummary: string;
      sectionSummaries: Array<{ title: DailySectionTitle; summary: string }>;
    }>([
      {
        role: 'system',
        content: '你是 BIM 行业日报主编。根据输入的分区资讯，生成更正式的日报标题、导语、执行摘要和分区小结。只输出 JSON。'
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: draft.title,
          intro: draft.intro,
          executiveSummary: draft.executiveSummary,
          sections: draft.sections.map((section) => ({
            title: section.title,
            items: section.items.slice(0, 4).map((item) => ({
              title: item.title,
              summary: item.summary,
              sourceName: item.sourceName
            }))
          })),
          keywordStats: draft.keywordStats
        }, null, 2)
      }
    ], {
      maxTokens: 600,
      temperature: 0.2
    });

    const sectionSummaryMap = new Map(result.sectionSummaries?.map((item) => [item.title, normalizeText(item.summary)]));
    return {
      ...draft,
      title: normalizeText(result.title || draft.title) || draft.title,
      intro: normalizeText(result.intro || draft.intro) || draft.intro,
      executiveSummary: normalizeText(result.executiveSummary || draft.executiveSummary) || draft.executiveSummary,
      sections: draft.sections.map((section) => ({
        ...section,
        summary: sectionSummaryMap.get(section.title) || section.summary
      }))
    };
  } catch {
    return draft;
  }
}

function filterToUsableDailyArticles(rows: DailySourceArticle[]): DailySourceArticle[] {
  return rows.filter((item) => Boolean(item.title && item.url));
}

export async function generateDailyReport(triggerType: 'manual' | 'scheduled' = 'manual'): Promise<{
  runId: string;
  reportId: string;
  reportDate: string;
  sourceCount: number;
  articleCount: number;
  report: ReturnType<typeof serializeDailyReportShape>;
}> {
  const run = await prisma.dailyRun.create({
    data: {
      triggerType,
      status: 'running'
    }
  });

  const reportDate = toReportDate(new Date());
  const activeSources = await prisma.dailySource.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' }
  });

  const sourceResults = await Promise.all(activeSources.map((source) => fetchDailySourceArticles(source.id as DailySourceId)));
  const sourceSummary: DailyRunSourceSummary[] = sourceResults.map((result) => ({
    sourceId: result.sourceId,
    sourceName: result.sourceName,
    ok: result.ok,
    resultCount: result.rows.length,
    elapsedMs: result.elapsedMs,
    errorMessage: result.errorMessage
  }));

  const pickedRows = sourceResults.flatMap((result) =>
    pickDailySourceWindow(
      filterToUsableDailyArticles(result.rows),
      DAILY_REPORT_LOOKBACK_HOURS,
      DAILY_REPORT_FALLBACK_LOOKBACK_HOURS,
      DAILY_REPORT_ARTICLES_PER_SOURCE,
      new Date()
    )
  );

  const draftsWithKeywords = await buildDailyArticleDrafts(pickedRows);
  const baseDraft = buildDailyReportDraft(reportDate, draftsWithKeywords);
  const finalDraft = await enhanceReportDraftWithAI(baseDraft);
  const sectionsWithPreview: StoredDailySection[] = finalDraft.sections.map((section) => ({
    title: section.title,
    summary: section.summary,
    items: section.items.map((item) => ({
      ...item,
      keywordHitPreview: buildKeywordHitPreview(item.matchedKeywords)
    }))
  }));

  try {
    const report = await prisma.$transaction(async (tx) => {
      const existing = await tx.dailyReport.findUnique({ where: { reportDate } });
      const savedReport = existing
        ? await tx.dailyReport.update({
            where: { id: existing.id },
            data: {
              title: finalDraft.title,
              intro: finalDraft.intro,
              executiveSummary: finalDraft.executiveSummary,
              sectionsJson: JSON.stringify(sectionsWithPreview),
              status: 'completed',
              sourceCount: finalDraft.sourceCount,
              articleCount: finalDraft.articleCount,
              keywordStatsJson: JSON.stringify(finalDraft.keywordStats),
              generatedAt: new Date()
            }
          })
        : await tx.dailyReport.create({
            data: {
              reportDate,
              title: finalDraft.title,
              intro: finalDraft.intro,
              executiveSummary: finalDraft.executiveSummary,
              sectionsJson: JSON.stringify(sectionsWithPreview),
              status: 'completed',
              sourceCount: finalDraft.sourceCount,
              articleCount: finalDraft.articleCount,
              keywordStatsJson: JSON.stringify(finalDraft.keywordStats),
              generatedAt: new Date()
            }
          });

      await tx.dailyArticle.deleteMany({
        where: { reportId: savedReport.id }
      });

      for (const article of draftsWithKeywords) {
        await tx.dailyArticle.create({
          data: {
            sourceId: article.sourceId,
            reportId: savedReport.id,
            reportDate,
            title: article.title,
            excerpt: article.excerpt,
            summary: article.summary,
            url: article.url,
            publishedAt: article.publishedAt,
            category: null,
            fetchStatus: 'fetched',
            contentHash: `${article.sourceId}:${article.url}`,
            keywordHitPreview: article.keywordHitPreview,
            keywordHits: {
              create: article.matchedKeywords.map((hit) => ({
                keywordId: hit.keywordId,
                matchedText: hit.matchedTexts.join('｜'),
                matchCount: hit.count,
                hitFieldsJson: JSON.stringify(hit.hitFields)
              }))
            }
          }
        });
      }

      await tx.dailyRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          reportId: savedReport.id,
          sourceCount: activeSources.length,
          articleCount: draftsWithKeywords.length,
          sourceSummaryJson: JSON.stringify(sourceSummary),
          completedAt: new Date()
        }
      });

      return savedReport;
    });

    const completeReport = await prisma.dailyReport.findUniqueOrThrow({
      where: { id: report.id }
    });

    return {
      runId: run.id,
      reportId: completeReport.id,
      reportDate: formatDateParts(reportDate).key,
      sourceCount: finalDraft.sourceCount,
      articleCount: finalDraft.articleCount,
      report: serializeDailyReportShape(completeReport)
    };
  } catch (error) {
    await prisma.dailyRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        sourceCount: activeSources.length,
        articleCount: draftsWithKeywords.length,
        sourceSummaryJson: JSON.stringify(sourceSummary),
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date()
      }
    });
    throw error;
  }
}

type DailyArticleWithRelations = Awaited<ReturnType<typeof prisma.dailyArticle.findFirst>> & {
  source?: { id: string; name: string; sourceType: string };
  keywordHits?: Array<{
    keywordId: string;
    matchedText: string;
    matchCount: number;
    hitFieldsJson: string;
    keyword?: { id: string; label: string; slug: string; category: string | null };
  }>;
};

export function serializeDailyArticle(article: DailyArticleWithRelations) {
  const matchedKeywords = (article?.keywordHits || [])
    .filter((hit) => hit.keyword)
    .map((hit) => ({
      id: hit.keyword!.id,
      label: hit.keyword!.label,
      slug: hit.keyword!.slug,
      category: hit.keyword!.category,
      count: hit.matchCount
    }));

  return {
    id: article!.id,
    reportId: article!.reportId,
    reportDate: article!.reportDate.toISOString(),
    sourceId: article!.sourceId,
    sourceName: article?.source?.name || article!.sourceId,
    sourceType: article?.source?.sourceType || null,
    title: article!.title,
    excerpt: article!.excerpt,
    summary: article!.summary,
    url: article!.url,
    publishedAt: article!.publishedAt?.toISOString() || null,
    category: article!.category,
    keywordHitPreview: article!.keywordHitPreview,
    matchedKeywords
  };
}

export function serializeDailyReportShape(report: {
  id: string;
  reportDate: Date;
  title: string;
  intro: string;
  executiveSummary: string;
  sectionsJson: string;
  status: string;
  sourceCount: number;
  articleCount: number;
  keywordStatsJson: string;
  generatedAt: Date;
  createdAt?: Date;
}) {
  return {
    id: report.id,
    reportDate: report.reportDate.toISOString(),
    title: report.title,
    intro: report.intro,
    executiveSummary: report.executiveSummary,
    sections: safeJsonParse<StoredDailySection[]>(report.sectionsJson, []),
    status: report.status,
    sourceCount: report.sourceCount,
    articleCount: report.articleCount,
    keywordStats: safeJsonParse<Array<{ keywordId: string; label: string; slug: string; category: string | null; count: number }>>(report.keywordStatsJson, []),
    generatedAt: report.generatedAt.toISOString(),
    createdAt: report.createdAt?.toISOString() || report.generatedAt.toISOString()
  };
}

export async function getLatestDailyReportRecord() {
  return prisma.dailyReport.findFirst({
    orderBy: { reportDate: 'desc' }
  });
}

export async function listDailyKeywords() {
  const keywords = await prisma.dailyKeyword.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
  return keywords.map((item) => ({
    id: item.id,
    label: item.label,
    slug: item.slug,
    aliases: parseAliases(item.aliasesJson),
    category: item.category,
    sortOrder: item.sortOrder,
    isActive: item.isActive
  }));
}

export async function getDailyReportHealth() {
  const [latestRun, latestReport, sources] = await Promise.all([
    prisma.dailyRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.dailyReport.findFirst({ orderBy: { reportDate: 'desc' } }),
    prisma.dailySource.findMany({ orderBy: { createdAt: 'asc' } })
  ]);

  const sourceSummary = safeJsonParse<DailyRunSourceSummary[]>(latestRun?.sourceSummaryJson, []);

  return {
    latestRun: latestRun ? {
      id: latestRun.id,
      triggerType: latestRun.triggerType,
      status: latestRun.status,
      sourceCount: latestRun.sourceCount,
      articleCount: latestRun.articleCount,
      errorMessage: latestRun.errorMessage,
      startedAt: latestRun.startedAt.toISOString(),
      completedAt: latestRun.completedAt?.toISOString() || null
    } : null,
    latestReport: latestReport ? serializeDailyReportShape(latestReport) : null,
    sources: sources.map((source) => {
      const summary = sourceSummary.find((item) => item.sourceId === source.id);
      return {
        id: source.id,
        name: source.name,
        homepage: source.homepage,
        listUrl: source.listUrl,
        sourceType: source.sourceType,
        isActive: source.isActive,
        status: summary ? (summary.ok ? 'healthy' : 'degraded') : 'unknown',
        resultCount: summary?.resultCount ?? 0,
        elapsedMs: summary?.elapsedMs ?? 0,
        errorMessage: summary?.errorMessage ?? null
      };
    })
  };
}
