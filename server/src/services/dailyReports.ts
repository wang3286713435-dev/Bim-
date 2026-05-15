import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { generateStructuredJson } from './llmProvider.js';
import { formatDailyReportDateLabel, toDailyReportDate } from './dailyReportDate.js';
import { buildKeywordHitPreview, matchDailyKeywords, type DailyKeywordHit } from './dailyKeywordMatcher.js';
import {
  applyEditorialSelection,
  buildFallbackOverviewSnapshot,
  buildDailyReportDraft,
  selectEditorialDailyArticles,
  type DailyOverviewItem,
  type DailyOverviewSnapshot,
  type DailyOverviewReportInput,
  type DailyEditorialReview,
  type DailyArticleDraft,
  type DailyRecencyBucket,
  type DailyReportDraft,
  type DailySectionTitle
} from './dailyReportBuilder.js';
import { DAILY_SOURCE_DEFINITIONS, type DailySourceId } from './dailyReportRegistry.js';
import {
  fetchDailyArticleDetailText,
  fetchDailySourceArticles,
  pickDailySourceWindow,
  type DailySourceArticle,
  type DailySourceArticleWithBucket
} from './dailySources.js';

const DAILY_REPORT_LOOKBACK_HOURS = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_LOOKBACK_HOURS || '24', 10) || 24);
const DAILY_REPORT_FALLBACK_LOOKBACK_HOURS = Math.max(DAILY_REPORT_LOOKBACK_HOURS, Number.parseInt(process.env.DAILY_REPORT_FALLBACK_LOOKBACK_HOURS || '72', 10) || 72);
const DAILY_REPORT_EXTENDED_LOOKBACK_HOURS = Math.max(DAILY_REPORT_FALLBACK_LOOKBACK_HOURS, Number.parseInt(process.env.DAILY_REPORT_EXTENDED_LOOKBACK_HOURS || '168', 10) || 168);
const DAILY_REPORT_ARTICLES_PER_SOURCE = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_ARTICLES_PER_SOURCE || '4', 10) || 4);
const DAILY_REPORT_MIN_ARTICLES_PER_SOURCE = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_MIN_ARTICLES_PER_SOURCE || '2', 10) || 2);
const DAILY_REPORT_FINAL_ARTICLE_LIMIT = Math.max(3, Number.parseInt(process.env.DAILY_REPORT_FINAL_ARTICLE_LIMIT || '8', 10) || 8);
const DAILY_REPORT_AI_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.DAILY_REPORT_AI_CONCURRENCY || '2', 10) || 2));
const DAILY_REPORT_DETAIL_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.DAILY_REPORT_DETAIL_CONCURRENCY || '2', 10) || 2));

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

type StoredDailyMeta = {
  candidateArticleCount: number;
  selectedArticleCount: number;
  freshArticleCount: number;
  supplementalArticleCount: number;
  sourceCount: number;
  editorialAngle?: string;
  recommendedActions?: string[];
};

type StoredDailyOverviewSnapshot = DailyOverviewSnapshot & {
  generatedAt?: string;
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

function parseAliases(value: string | null): string[] {
  return safeJsonParse<string[]>(value, []);
}

export function buildDailyReportWhere(params: {
  source?: string;
  keyword?: string;
  searchText?: string;
  dateFrom?: Date | null;
  dateTo?: Date | null;
}): Prisma.DailyReportWhereInput {
  const where: Prisma.DailyReportWhereInput = {};
  const source = params.source?.trim();
  const keyword = params.keyword?.trim();
  const searchText = params.searchText?.trim();

  if (params.dateFrom || params.dateTo) {
    where.reportDate = {
      ...(params.dateFrom ? { gte: params.dateFrom } : {}),
      ...(params.dateTo ? { lte: params.dateTo } : {}),
    };
  }

  if (source || keyword) {
    where.articles = {
      some: {
        ...(source ? { sourceId: source } : {}),
        ...(keyword ? { keywordHits: { some: { keyword: { slug: keyword } } } } : {}),
      }
    };
  }

  if (searchText) {
    const articleSearch: Prisma.DailyArticleWhereInput = {
      OR: [
        { title: { contains: searchText } },
        { excerpt: { contains: searchText } },
        { summary: { contains: searchText } },
        { keywordHitPreview: { contains: searchText } },
        { source: { name: { contains: searchText } } },
        {
          keywordHits: {
            some: {
              OR: [
                { matchedText: { contains: searchText } },
                { keyword: { label: { contains: searchText } } },
                { keyword: { slug: { contains: searchText } } },
              ]
            }
          }
        }
      ]
    };

    where.OR = [
      { title: { contains: searchText } },
      { intro: { contains: searchText } },
      { executiveSummary: { contains: searchText } },
      { highlightsJson: { contains: searchText } },
      { sectionsJson: { contains: searchText } },
      { keywordStatsJson: { contains: searchText } },
      { metaJson: { contains: searchText } },
      { articles: { some: articleSearch } },
    ];
  }

  return where;
}

export function buildDailyArticleWhere(params: {
  source?: string;
  keyword?: string;
  reportId?: string;
  reportDate?: Date | null;
  searchText?: string;
}): Prisma.DailyArticleWhereInput {
  const where: Prisma.DailyArticleWhereInput = {};
  const source = params.source?.trim();
  const keyword = params.keyword?.trim();
  const reportId = params.reportId?.trim();
  const searchText = params.searchText?.trim();

  if (source) where.sourceId = source;
  if (reportId) where.reportId = reportId;
  if (params.reportDate && !reportId) {
    const end = new Date(params.reportDate.getTime() + 24 * 60 * 60 * 1000 - 1);
    where.reportDate = { gte: params.reportDate, lte: end };
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
  if (searchText) {
    where.OR = [
      { title: { contains: searchText } },
      { excerpt: { contains: searchText } },
      { summary: { contains: searchText } },
      { keywordHitPreview: { contains: searchText } },
      { source: { name: { contains: searchText } } },
      {
        keywordHits: {
          some: {
            OR: [
              { matchedText: { contains: searchText } },
              { keyword: { label: { contains: searchText } } },
              { keyword: { slug: { contains: searchText } } },
            ]
          }
        }
      }
    ];
  }

  return where;
}

function buildFallbackArticleSummary(article: DailySourceArticle): string {
  const excerpt = normalizeText(article.excerpt || '');
  if (!excerpt) {
    return `${article.sourceName}更新：${article.title}`.slice(0, 120);
  }
  return excerpt.slice(0, 120);
}

async function summarizeDailyArticle(
  article: DailySourceArticle,
  detailText?: string
): Promise<string> {
  try {
    const result = await generateStructuredJson<{ summary: string }>([
      {
        role: 'system',
        content: '你是 BIM 行业资讯编辑。请阅读给定资讯内容，输出 1-2 句、80 字以内的中文管理摘要。摘要要直接说明这条资讯为什么重要，优先突出政策、趋势、案例、软件或标准影响。仅输出 JSON：{"summary":"..."}。'
      },
      {
        role: 'user',
        content: `来源：${article.sourceName}\n标题：${article.title}\n列表摘要：${article.excerpt || '无摘要'}\n正文摘要：${detailText || '无正文'}\n发布时间：${article.publishedAt?.toISOString() || '未知'}`
      }
    ], {
      maxTokens: 220,
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

async function buildDailyArticleDrafts(
  sourceArticles: Array<DailySourceArticleWithBucket & { detailText?: string }>
): Promise<Array<DailyArticleDraft & { keywordHitPreview: string | null }>> {
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
    const summary = await summarizeDailyArticle(article, article.detailText);
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
      recencyBucket: article.recencyBucket,
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
      highlights?: string[];
      recommendedActions?: string[];
      sectionSummaries: Array<{ title: DailySectionTitle; summary: string }>;
    }>([
      {
        role: 'system',
        content: '你是 BIM 行业日报主编。请根据输入资讯，为管理层生成可直接阅读的 BIM 日报成品。输出更正式的日报标题、导语、执行摘要、3-5 条今日重点、2-3 条建议跟踪动作，以及分区小结。只输出 JSON。'
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
              sourceName: item.sourceName,
              recencyBucket: item.recencyBucket
            }))
          })),
          keywordStats: draft.keywordStats,
          meta: draft.meta,
          recommendedActions: draft.recommendedActions
        }, null, 2)
      }
    ], {
      maxTokens: 900,
      temperature: 0.2
    });

    const sectionSummaryMap = new Map(result.sectionSummaries?.map((item) => [item.title, normalizeText(item.summary)]));
    return {
      ...draft,
      title: normalizeText(result.title || draft.title) || draft.title,
      intro: normalizeText(result.intro || draft.intro) || draft.intro,
      executiveSummary: normalizeText(result.executiveSummary || draft.executiveSummary) || draft.executiveSummary,
      highlights: Array.isArray(result.highlights)
        ? result.highlights.map((item) => normalizeText(item)).filter(Boolean).slice(0, 5)
        : draft.highlights,
      recommendedActions: Array.isArray(result.recommendedActions)
        ? result.recommendedActions.map((item) => normalizeText(item)).filter(Boolean).slice(0, 3)
        : draft.recommendedActions,
      sections: draft.sections.map((section) => ({
        ...section,
        summary: sectionSummaryMap.get(section.title) || section.summary
      }))
    };
  } catch {
    return draft;
  }
}

async function reviewDailyCandidateSetWithAI(
  candidates: Array<DailyArticleDraft & { keywordHitPreview: string | null }>,
  limit: number
): Promise<DailyEditorialReview | null> {
  if (candidates.length === 0) return null;

  try {
    const result = await generateStructuredJson<DailyEditorialReview>([
      {
        role: 'system',
        content: '你是 BIM 行业日报的总编辑。请审阅全部候选资讯，优先挑选最值得管理层阅读的内容。优先级：政策与标准 > 行业趋势 > 代表性案例 > 软件工具 > 国际标准。避免重复角度，兼顾来源多样性与时效。只输出 JSON：{"selectedUrls":[],"editorialAngle":"","recommendedActions":[]}'
      },
      {
        role: 'user',
        content: JSON.stringify(candidates.map((item) => ({
          url: item.url,
          sourceName: item.sourceName,
          title: item.title,
          summary: item.summary,
          excerpt: item.excerpt,
          recencyBucket: item.recencyBucket,
          keywordHitPreview: item.keywordHitPreview,
          matchedKeywords: item.matchedKeywords.map((hit) => hit.label)
        })), null, 2)
      }
    ], {
      maxTokens: 900,
      temperature: 0.2
    });

    return {
      selectedUrls: Array.isArray(result.selectedUrls) ? result.selectedUrls.filter(Boolean).slice(0, limit) : [],
      editorialAngle: normalizeText(result.editorialAngle || ''),
      recommendedActions: Array.isArray(result.recommendedActions)
        ? result.recommendedActions.map((item) => normalizeText(item)).filter(Boolean).slice(0, 3)
        : []
    };
  } catch {
    return null;
  }
}

function serializeStoredOverviewSnapshot(snapshot: {
  id?: string;
  scope?: string;
  title: string;
  summary: string;
  itemsJson: string;
  generatedAt?: Date;
}) {
  const parsed = safeJsonParse<StoredDailyOverviewSnapshot>(snapshot.itemsJson, {
    title: snapshot.title,
    summary: snapshot.summary,
    items: []
  });

  return {
    id: snapshot.id || 'daily-overview',
    scope: snapshot.scope || 'primary',
    title: snapshot.title,
    summary: snapshot.summary,
    items: parsed.items || [],
    generatedAt: snapshot.generatedAt?.toISOString() || new Date().toISOString()
  };
}

async function buildDailyOverviewSnapshotWithAI(params: {
  reportDateLabel: string;
  recentReports: DailyOverviewReportInput[];
  previousItems: DailyOverviewItem[];
}): Promise<DailyOverviewSnapshot> {
  const fallback = buildFallbackOverviewSnapshot(params);
  if (fallback.items.length === 0) return fallback;

  try {
    const result = await generateStructuredJson<{
      title: string;
      summary: string;
      items: Array<{
        key: string;
        title?: string;
        summary?: string;
        reason?: string;
        importance?: 'critical' | 'high' | 'watch';
        status?: 'new' | 'persistent' | 'watch';
      }>;
    }>([
      {
        role: 'system',
        content: '你是 BIM 日报主编。请从候选总览项里挑出最该长期放在主视图的 3-6 条信息。今天最重要的内容要突出，跨多期反复出现的重要信息要继续保留。只输出 JSON：{"title":"","summary":"","items":[{"key":"","title":"","summary":"","reason":"","importance":"critical|high|watch","status":"new|persistent|watch"}]}'
      },
      {
        role: 'user',
        content: JSON.stringify({
          reportDateLabel: params.reportDateLabel,
          previousItems: params.previousItems.slice(0, 5).map((item) => ({
            key: item.key,
            title: item.title,
            summary: item.summary,
            status: item.status,
            importance: item.importance,
            reportCount: item.reportCount,
            lastSeenDateLabel: item.lastSeenDateLabel
          })),
          candidates: fallback.items.map((item) => ({
            key: item.key,
            title: item.title,
            summary: item.summary,
            reason: item.reason,
            importance: item.importance,
            status: item.status,
            reportCount: item.reportCount,
            sourceCount: item.sourceCount,
            reportDateLabels: item.reportDateLabels,
            matchedKeywords: item.matchedKeywords.map((keyword) => keyword.label)
          }))
        }, null, 2)
      }
    ], {
      maxTokens: 900,
      temperature: 0.2
    });

    const fallbackByKey = new Map(fallback.items.map((item) => [item.key, item]));
    const items = Array.isArray(result.items)
      ? result.items.map((item) => {
          const base = fallbackByKey.get(item.key);
          if (!base) return null;
          return {
            ...base,
            title: normalizeText(item.title || base.title) || base.title,
            summary: normalizeText(item.summary || base.summary) || base.summary,
            reason: normalizeText(item.reason || base.reason) || base.reason,
            importance: item.importance || base.importance,
            status: item.status || base.status,
          };
        }).filter((item): item is DailyOverviewItem => Boolean(item)).slice(0, 6)
      : [];

    if (items.length === 0) return fallback;

    return {
      title: normalizeText(result.title || fallback.title) || fallback.title,
      summary: normalizeText(result.summary || fallback.summary) || fallback.summary,
      items
    };
  } catch {
    return fallback;
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

  const reportDate = toDailyReportDate(new Date());
  const previousOverviewSnapshot = await prisma.dailyOverviewSnapshot.findFirst({
    orderBy: { generatedAt: 'desc' }
  });
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

  const pickedRows = sourceResults.flatMap((result) => {
    const sourceDefinition = DAILY_SOURCE_DEFINITIONS.find((item) => item.id === result.sourceId);
    const watchHorizonHours = Math.max(
      DAILY_REPORT_EXTENDED_LOOKBACK_HOURS,
      (sourceDefinition?.recall?.watchHorizonDays || 0) * 24
    );

    return pickDailySourceWindow(
      filterToUsableDailyArticles(result.rows),
      DAILY_REPORT_LOOKBACK_HOURS,
      DAILY_REPORT_FALLBACK_LOOKBACK_HOURS,
      DAILY_REPORT_ARTICLES_PER_SOURCE,
      new Date(),
      watchHorizonHours,
      DAILY_REPORT_MIN_ARTICLES_PER_SOURCE
    );
  });

  const enrichedCandidates = await mapWithConcurrency(pickedRows, DAILY_REPORT_DETAIL_CONCURRENCY, async (article) => ({
    ...article,
    detailText: await fetchDailyArticleDetailText(article)
  }));

  const candidateDrafts = await buildDailyArticleDrafts(enrichedCandidates);
  const editorialReview = await reviewDailyCandidateSetWithAI(candidateDrafts, DAILY_REPORT_FINAL_ARTICLE_LIMIT);
  const selectedDrafts = applyEditorialSelection(candidateDrafts, editorialReview, DAILY_REPORT_FINAL_ARTICLE_LIMIT);
  const baseDraft = buildDailyReportDraft(reportDate, selectedDrafts, candidateDrafts.length, editorialReview);
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
              highlightsJson: JSON.stringify(finalDraft.highlights),
              sectionsJson: JSON.stringify(sectionsWithPreview),
              metaJson: JSON.stringify({
                ...finalDraft.meta,
                recommendedActions: finalDraft.recommendedActions
              }),
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
              highlightsJson: JSON.stringify(finalDraft.highlights),
              sectionsJson: JSON.stringify(sectionsWithPreview),
              metaJson: JSON.stringify({
                ...finalDraft.meta,
                recommendedActions: finalDraft.recommendedActions
              }),
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

      for (const article of selectedDrafts) {
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
            recencyBucket: article.recencyBucket || 'today',
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
          articleCount: selectedDrafts.length,
          sourceSummaryJson: JSON.stringify(sourceSummary),
          completedAt: new Date()
        }
      });

      return savedReport;
    });

    const completeReport = await prisma.dailyReport.findUniqueOrThrow({
      where: { id: report.id }
    });
    const recentReports = await prisma.dailyReport.findMany({
      orderBy: { reportDate: 'desc' },
      take: 10
    });
    const previousOverviewItems = previousOverviewSnapshot
      ? serializeStoredOverviewSnapshot(previousOverviewSnapshot).items
      : [];
    const overviewDraft = await buildDailyOverviewSnapshotWithAI({
      reportDateLabel: formatDailyReportDateLabel(reportDate),
      recentReports: recentReports.map((item) => toOverviewReportInput(serializeDailyReportShape(item))),
      previousItems: previousOverviewItems
    });
    await prisma.dailyOverviewSnapshot.upsert({
      where: {
        reportId: completeReport.id
      },
      update: {
        scope: 'primary',
        title: overviewDraft.title,
        summary: overviewDraft.summary,
        itemsJson: JSON.stringify(overviewDraft),
        generatedAt: new Date()
      },
      create: {
        reportId: completeReport.id,
        scope: 'primary',
        title: overviewDraft.title,
        summary: overviewDraft.summary,
        itemsJson: JSON.stringify(overviewDraft),
        generatedAt: new Date()
      }
    });

    return {
      runId: run.id,
      reportId: completeReport.id,
      reportDate: formatDailyReportDateLabel(reportDate),
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
        articleCount: selectedDrafts.length,
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
    reportDateLabel: formatDailyReportDateLabel(article!.reportDate),
    sourceId: article!.sourceId,
    sourceName: article?.source?.name || article!.sourceId,
    sourceType: article?.source?.sourceType || null,
    title: article!.title,
    excerpt: article!.excerpt,
    summary: article!.summary,
    url: article!.url,
    publishedAt: article!.publishedAt?.toISOString() || null,
    category: article!.category,
    recencyBucket: article!.recencyBucket,
    keywordHitPreview: article!.keywordHitPreview,
    matchedKeywords
  };
}

function toOverviewReportInput(report: ReturnType<typeof serializeDailyReportShape>): DailyOverviewReportInput {
  return {
    id: report.id,
    reportDateLabel: report.reportDateLabel,
    title: report.title,
    highlights: report.highlights,
    sections: report.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        title: item.title,
        excerpt: item.excerpt,
        summary: item.summary,
        url: item.url,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        recencyBucket: item.recencyBucket,
        keywordHitPreview: item.keywordHitPreview,
        matchedKeywords: item.matchedKeywords.map((hit) => ({
          keywordId: hit.keywordId,
          label: hit.label,
          slug: hit.slug,
          category: hit.category,
          count: hit.count,
          matchedTexts: hit.matchedTexts,
          hitFields: hit.hitFields
        }))
      }))
    }))
  };
}

export function serializeDailyReportShape(report: {
  id: string;
  reportDate: Date;
  title: string;
  intro: string;
  executiveSummary: string;
  highlightsJson?: string | null;
  sectionsJson: string;
  metaJson?: string | null;
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
    reportDateLabel: formatDailyReportDateLabel(report.reportDate),
    title: report.title,
    intro: report.intro,
    executiveSummary: report.executiveSummary,
    highlights: safeJsonParse<string[]>(report.highlightsJson, []),
    sections: safeJsonParse<StoredDailySection[]>(report.sectionsJson, []),
    meta: safeJsonParse<StoredDailyMeta>(report.metaJson, {
      candidateArticleCount: report.articleCount,
      selectedArticleCount: report.articleCount,
      freshArticleCount: report.articleCount,
      supplementalArticleCount: 0,
      sourceCount: report.sourceCount,
    }),
    recommendedActions: safeJsonParse<StoredDailyMeta>(report.metaJson, {
      candidateArticleCount: report.articleCount,
      selectedArticleCount: report.articleCount,
      freshArticleCount: report.articleCount,
      supplementalArticleCount: 0,
      sourceCount: report.sourceCount,
      recommendedActions: []
    }).recommendedActions || [],
    status: report.status,
    sourceCount: report.sourceCount,
    articleCount: report.articleCount,
    keywordStats: safeJsonParse<Array<{ keywordId: string; label: string; slug: string; category: string | null; count: number }>>(report.keywordStatsJson, []),
    generatedAt: report.generatedAt.toISOString(),
    createdAt: report.createdAt?.toISOString() || report.generatedAt.toISOString()
  };
}

export async function getLatestDailyOverview() {
  const snapshot = await prisma.dailyOverviewSnapshot.findFirst({
    orderBy: { generatedAt: 'desc' }
  });

  if (!snapshot) {
    const recentReports = await prisma.dailyReport.findMany({
      orderBy: { reportDate: 'desc' },
      take: 10
    });
    if (recentReports.length === 0) return null;
    const serialized = recentReports.map((item) => serializeDailyReportShape(item));
    const reportDateLabel = serialized[0]?.reportDateLabel || formatDailyReportDateLabel(new Date());
    const fallback = buildFallbackOverviewSnapshot({
      reportDateLabel,
      recentReports: serialized.map((item) => toOverviewReportInput(item)),
      previousItems: []
    });
    return {
      id: 'daily-overview-fallback',
      scope: 'primary',
      title: fallback.title,
      summary: fallback.summary,
      items: fallback.items,
      generatedAt: serialized[0]?.generatedAt || new Date().toISOString()
    };
  }
  return serializeStoredOverviewSnapshot(snapshot);
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
  const [latestRun, latestReport, sources, overview] = await Promise.all([
    prisma.dailyRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.dailyReport.findFirst({ orderBy: { reportDate: 'desc' } }),
    prisma.dailySource.findMany({ orderBy: { createdAt: 'asc' } }),
    getLatestDailyOverview()
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
    overview,
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
