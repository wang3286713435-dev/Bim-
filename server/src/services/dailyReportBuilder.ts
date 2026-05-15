import type { DailyKeywordHit } from './dailyKeywordMatcher.js';
import { formatDailyReportDateLabel } from './dailyReportDate.js';

export type DailySectionTitle =
  | '政策与标准'
  | '行业观点与趋势'
  | '案例与应用'
  | '软件与产品动态'
  | '国际标准 / openBIM';

export type DailyRecencyBucket = 'today' | 'recent' | 'watch';

export type DailyArticleDraft = {
  sourceId: string;
  sourceName: string;
  title: string;
  excerpt: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
  recencyBucket?: DailyRecencyBucket;
  editorialScore?: number;
  keywordHitPreview?: string | null;
  matchedKeywords: DailyKeywordHit[];
};

export type DailyKeywordStat = {
  keywordId: string;
  label: string;
  slug: string;
  category: string | null;
  count: number;
};

export type DailyReportSection = {
  title: DailySectionTitle;
  summary: string;
  items: DailyArticleDraft[];
};

export type DailyReportDraft = {
  title: string;
  intro: string;
  executiveSummary: string;
  highlights: string[];
  recommendedActions: string[];
  sections: DailyReportSection[];
  sourceCount: number;
  articleCount: number;
  keywordStats: DailyKeywordStat[];
  meta: {
    candidateArticleCount: number;
    selectedArticleCount: number;
    freshArticleCount: number;
    supplementalArticleCount: number;
    sourceCount: number;
    editorialAngle?: string;
  };
};

export type DailyEditorialReview = {
  selectedUrls: string[];
  editorialAngle: string;
  recommendedActions: string[];
};

export type DailyOverviewKeywordRef = {
  label: string;
  slug: string;
};

export type DailyOverviewItem = {
  key: string;
  title: string;
  summary: string;
  reason: string;
  importance: 'critical' | 'high' | 'watch';
  status: 'new' | 'persistent' | 'watch';
  reportIds: string[];
  reportDateLabels: string[];
  matchedKeywords: DailyOverviewKeywordRef[];
  sourceNames: string[];
  firstSeenDateLabel: string;
  lastSeenDateLabel: string;
  reportCount: number;
  sourceCount: number;
};

export type DailyOverviewSnapshot = {
  title: string;
  summary: string;
  items: DailyOverviewItem[];
};

export type DailyOverviewReportInput = {
  id: string;
  reportDateLabel: string;
  title: string;
  highlights: string[];
  sections: Array<{
    title: DailySectionTitle;
    items: DailyArticleDraft[];
  }>;
};

const SECTION_ORDER: DailySectionTitle[] = [
  '政策与标准',
  '行业观点与趋势',
  '案例与应用',
  '软件与产品动态',
  '国际标准 / openBIM'
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function normalizeOverviewKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function classifyDailyArticleSection(article: Pick<DailyArticleDraft, 'sourceId' | 'title' | 'excerpt' | 'summary'>): DailySectionTitle {
  const haystack = `${article.title}\n${article.excerpt}\n${article.summary}`.toLowerCase();

  if (article.sourceId === 'buildingsmart' || containsAny(haystack, ['openbim', 'ifc', 'buildingSMART'.toLowerCase()])) {
    return '国际标准 / openBIM';
  }

  if (article.sourceId === 'fuzor' || containsAny(haystack, ['revit', '软件', '教程', '4d', 'vr', '产品'])) {
    return '软件与产品动态';
  }

  if (article.sourceId === 'shbimcenter' && containsAny(haystack, ['政策', '通知', '指南', '标准'])) {
    return '政策与标准';
  }

  if (containsAny(haystack, ['案例', '示范', '试点', '项目'])) {
    return '案例与应用';
  }

  if (containsAny(haystack, ['观点', '趋势', '洞察', '复盘', '观察'])) {
    return '行业观点与趋势';
  }

  if (containsAny(haystack, ['政策', '通知', '指南', '标准'])) {
    return '政策与标准';
  }

  return '行业观点与趋势';
}

export function buildDailyKeywordStats(articles: DailyArticleDraft[]): DailyKeywordStat[] {
  const stats = new Map<string, DailyKeywordStat>();

  for (const article of articles) {
    for (const hit of article.matchedKeywords) {
      const current = stats.get(hit.keywordId);
      if (current) {
        current.count += hit.count;
      } else {
        stats.set(hit.keywordId, {
          keywordId: hit.keywordId,
          label: hit.label,
          slug: hit.slug,
          category: hit.category,
          count: hit.count,
        });
      }
    }
  }

  return [...stats.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
}

export function filterDailyArticlesByKeyword(articles: DailyArticleDraft[], keywordSlug: string): DailyArticleDraft[] {
  if (!keywordSlug) return [...articles];
  return articles.filter((article) => article.matchedKeywords.some((hit) => hit.slug === keywordSlug));
}

function buildSectionSummary(sectionTitle: DailySectionTitle, items: DailyArticleDraft[]): string {
  if (items.length === 0) {
    return `${sectionTitle}暂无新增内容。`;
  }

  const titles = items.slice(0, 2).map((item) => item.title).join('；');
  return `${sectionTitle}收录 ${items.length} 条，重点关注：${titles}`;
}

function getSourceWeight(sourceId: string): number {
  switch (sourceId) {
    case 'shbimcenter':
      return 30;
    case 'buildingsmart':
      return 26;
    case 'chinabim':
      return 22;
    case 'bimbox':
      return 18;
    case 'bimii':
      return 16;
    case 'fuzor':
      return 12;
    default:
      return 10;
  }
}

function getRecencyWeight(bucket: DailyRecencyBucket | undefined): number {
  switch (bucket) {
    case 'today':
      return 30;
    case 'recent':
      return 18;
    case 'watch':
      return 8;
    default:
      return 0;
  }
}

function getSectionWeight(section: DailySectionTitle): number {
  switch (section) {
    case '政策与标准':
      return 22;
    case '行业观点与趋势':
      return 16;
    case '案例与应用':
      return 14;
    case '国际标准 / openBIM':
      return 14;
    case '软件与产品动态':
      return 8;
    default:
      return 0;
  }
}

function getHeadlineWeight(text: string): number {
  const haystack = text.toLowerCase();
  let weight = 0;
  if (containsAny(haystack, ['政策', '通知', '指南', '标准', '意见', '发布'])) weight += 12;
  if (containsAny(haystack, ['趋势', '观察', '报告', '洞察', '风口', '转型'])) weight += 8;
  if (containsAny(haystack, ['案例', '示范', '试点', '医院', '园区', '学校', '综合体'])) weight += 6;
  return weight;
}

export function scoreDailyArticle(article: DailyArticleDraft): number {
  const section = classifyDailyArticleSection(article);
  const keywordScore = Math.min(article.matchedKeywords.reduce((sum, item) => sum + item.count, 0) * 6, 24);
  return (
    getSourceWeight(article.sourceId)
    + getRecencyWeight(article.recencyBucket)
    + getSectionWeight(section)
    + getHeadlineWeight(`${article.title}\n${article.excerpt}\n${article.summary}`)
    + keywordScore
  );
}

export function selectEditorialDailyArticles(articles: DailyArticleDraft[], limit = 8): DailyArticleDraft[] {
  if (articles.length <= limit) {
    return articles
      .map((item) => ({ ...item, editorialScore: item.editorialScore ?? scoreDailyArticle(item) }))
      .sort((a, b) => (b.editorialScore || 0) - (a.editorialScore || 0));
  }

  const scored = articles
    .map((item) => ({ ...item, editorialScore: item.editorialScore ?? scoreDailyArticle(item) }))
    .sort((a, b) => (b.editorialScore || 0) - (a.editorialScore || 0));

  const selected: DailyArticleDraft[] = [];
  const seenUrls = new Set<string>();

  for (const item of scored) {
    if (selected.length >= limit) break;
    if (seenUrls.has(item.url)) continue;
    if (selected.some((entry) => entry.sourceId === item.sourceId)) continue;
    selected.push(item);
    seenUrls.add(item.url);
  }

  for (const item of scored) {
    if (selected.length >= limit) break;
    if (seenUrls.has(item.url)) continue;
    selected.push(item);
    seenUrls.add(item.url);
  }

  return selected;
}

export function buildManagementHighlights(articles: DailyArticleDraft[]): string[] {
  return articles.slice(0, 4).map((article) => {
    const section = classifyDailyArticleSection(article);
    const prefix = section === '政策与标准'
      ? '政策面'
      : section === '行业观点与趋势'
        ? '趋势面'
        : section === '案例与应用'
          ? '应用面'
          : section === '软件与产品动态'
            ? '工具面'
            : '标准面';
    const summary = article.summary || article.excerpt || article.title;
    return `${prefix}：${summary}`.slice(0, 96);
  });
}

export function buildRecommendedActions(articles: DailyArticleDraft[]): string[] {
  const sections = new Set(articles.map((item) => classifyDailyArticleSection(item)));
  const actions: string[] = [];

  if (sections.has('政策与标准')) {
    actions.push('跟踪新规、导则或行业标准是否会影响今年的 BIM 工作流与交付口径。');
  }
  if (sections.has('案例与应用') || sections.has('行业观点与趋势')) {
    actions.push('把代表性案例与趋势观点整理进内部知识库，提炼可复用的方法论与业务信号。');
  }
  if (sections.has('软件与产品动态') || sections.has('国际标准 / openBIM')) {
    actions.push('评估关键工具与标准变化是否需要同步更新团队培训、模板和技术栈。');
  }

  return actions.slice(0, 3);
}

export function applyEditorialSelection(
  articles: DailyArticleDraft[],
  review: DailyEditorialReview | null,
  limit = 8
): DailyArticleDraft[] {
  const fallback = selectEditorialDailyArticles(articles, limit);
  if (!review?.selectedUrls?.length) {
    return fallback;
  }

  const byUrl = new Map(articles.map((item) => [item.url, item]));
  const selected: DailyArticleDraft[] = [];
  const seen = new Set<string>();

  for (const url of review.selectedUrls) {
    const article = byUrl.get(url);
    if (!article || seen.has(url)) continue;
    selected.push(article);
    seen.add(url);
    if (selected.length >= limit) return selected;
  }

  for (const article of fallback) {
    if (selected.length >= limit) break;
    if (seen.has(article.url)) continue;
    selected.push(article);
    seen.add(article.url);
  }

  return selected;
}

export function buildDailyReportDraft(
  reportDate: Date,
  selectedArticles: DailyArticleDraft[],
  candidateArticleCount = selectedArticles.length,
  review?: DailyEditorialReview | null
): DailyReportDraft {
  const keywordStats = buildDailyKeywordStats(selectedArticles);
  const sectionsMap = new Map<DailySectionTitle, DailyArticleDraft[]>();
  const sourceCount = new Set(selectedArticles.map((item) => item.sourceId)).size;
  const freshArticleCount = selectedArticles.filter((item) => item.recencyBucket === 'today').length;
  const supplementalArticleCount = selectedArticles.filter((item) => item.recencyBucket && item.recencyBucket !== 'today').length;

  for (const title of SECTION_ORDER) {
    sectionsMap.set(title, []);
  }

  for (const article of selectedArticles) {
    sectionsMap.get(classifyDailyArticleSection(article))?.push(article);
  }

  const sections = SECTION_ORDER
    .map((title) => ({
      title,
      items: sectionsMap.get(title) || [],
      summary: buildSectionSummary(title, sectionsMap.get(title) || [])
    }))
    .filter((section) => section.items.length > 0);

  const dateLabel = formatDailyReportDateLabel(reportDate);
  const topKeywords = keywordStats.slice(0, 3).map((item) => `${item.label} ${item.count}`).join('｜') || '无重点关键词命中';
  const highlights = buildManagementHighlights(selectedArticles);

  return {
    title: `${dateLabel} BIM 行业日报`,
    intro: `今日从 ${sourceCount} 个来源审阅 ${candidateArticleCount} 条 BIM 相关候选资讯，精选 ${selectedArticles.length} 条进入日报。${supplementalArticleCount > 0 ? `其中 ${supplementalArticleCount} 条为延续关注内容。` : ''}`,
    executiveSummary: `今日重点围绕政策动向、行业趋势与项目应用展开。关键词概览：${topKeywords}。${freshArticleCount > 0 ? `今日新增 ${freshArticleCount} 条。` : '今日新增较少，已自动补入延续关注内容。'}`,
    highlights,
    recommendedActions: review?.recommendedActions?.length ? review.recommendedActions.slice(0, 3) : buildRecommendedActions(selectedArticles),
    sections,
    sourceCount,
    articleCount: selectedArticles.length,
    keywordStats,
    meta: {
      candidateArticleCount,
      selectedArticleCount: selectedArticles.length,
      freshArticleCount,
      supplementalArticleCount,
      sourceCount,
      editorialAngle: review?.editorialAngle || undefined,
    },
  };
}

type DailyOverviewAggregate = {
  key: string;
  title: string;
  summary: string;
  latestReportId: string;
  latestReportDateLabel: string;
  latestRecencyBucket?: DailyRecencyBucket;
  reportIds: Set<string>;
  reportDateLabels: Set<string>;
  sourceNames: Set<string>;
  matchedKeywords: Map<string, DailyOverviewKeywordRef>;
  score: number;
  latestWeight: number;
  repeated: boolean;
  previousStatus?: DailyOverviewItem['status'];
  previousImportance?: DailyOverviewItem['importance'];
};

function buildOverviewReason(status: DailyOverviewItem['status'], reportCount: number, latest: boolean): string {
  if (status === 'persistent') {
    return `连续 ${reportCount} 期日报出现，说明它仍然值得管理层持续关注。`;
  }
  if (latest) {
    return '来自最新一期日报，具备更强时效性，适合放在主视图的最显眼位置。';
  }
  return '与 BIM 关键方向持续相关，建议保留在总览区方便后续查阅。';
}

function buildOverviewSummary(persistentCount: number, freshCount: number, itemCount: number): string {
  if (itemCount === 0) {
    return '当前还没有足够强的跨日报重点信号，等待下一次日报生成后自动补齐。';
  }
  return `当前总览保留 ${itemCount} 条重点信号，其中 ${persistentCount} 条为持续关注，${freshCount} 条来自最新日报。`;
}

export function buildFallbackOverviewSnapshot(params: {
  reportDateLabel: string;
  recentReports: DailyOverviewReportInput[];
  previousItems?: DailyOverviewItem[];
  limit?: number;
}): DailyOverviewSnapshot {
  const { reportDateLabel, recentReports, previousItems = [], limit = 6 } = params;
  const aggregates = new Map<string, DailyOverviewAggregate>();
  const previousByKey = new Map(previousItems.map((item) => [normalizeOverviewKey(item.title) || item.key, item]));

  for (const report of recentReports) {
    const isLatestReport = report.reportDateLabel === reportDateLabel;
    for (const section of report.sections) {
      for (const item of section.items) {
        const key = normalizeOverviewKey(item.title) || normalizeOverviewKey(`${item.sourceName} ${item.summary}`);
        if (!key) continue;
        const existing = aggregates.get(key);
        const articleScore = scoreDailyArticle(item);
        const latestWeight = isLatestReport ? 28 : item.recencyBucket === 'recent' ? 14 : 6;
        const previous = previousByKey.get(key);
        if (existing) {
          existing.reportIds.add(report.id);
          existing.reportDateLabels.add(report.reportDateLabel);
          existing.sourceNames.add(item.sourceName);
          for (const keyword of item.matchedKeywords) {
            existing.matchedKeywords.set(keyword.slug, {
              label: keyword.label,
              slug: keyword.slug
            });
          }
          if (articleScore + latestWeight >= existing.score) {
            existing.title = item.title;
            existing.summary = item.summary || item.excerpt || item.title;
            existing.latestReportId = report.id;
            existing.latestReportDateLabel = report.reportDateLabel;
            existing.latestRecencyBucket = item.recencyBucket;
            existing.score = articleScore + latestWeight;
            existing.latestWeight = latestWeight;
          }
          continue;
        }

        aggregates.set(key, {
          key,
          title: item.title,
          summary: item.summary || item.excerpt || item.title,
          latestReportId: report.id,
          latestReportDateLabel: report.reportDateLabel,
          latestRecencyBucket: item.recencyBucket,
          reportIds: new Set([report.id]),
          reportDateLabels: new Set([report.reportDateLabel]),
          sourceNames: new Set([item.sourceName]),
          matchedKeywords: new Map(item.matchedKeywords.map((keyword) => [keyword.slug, {
            label: keyword.label,
            slug: keyword.slug
          }])),
          score: articleScore + latestWeight,
          latestWeight,
          repeated: false,
          previousStatus: previous?.status,
          previousImportance: previous?.importance
        });
      }
    }
  }

  const items = [...aggregates.values()]
    .map((aggregate): DailyOverviewItem => {
      const reportCount = aggregate.reportIds.size;
      const sourceCount = aggregate.sourceNames.size;
      const isLatest = aggregate.latestReportDateLabel === reportDateLabel;
      const persistent = reportCount >= 2 || aggregate.previousStatus === 'persistent' || aggregate.score >= 90;
      const importance: DailyOverviewItem['importance'] = persistent && aggregate.score >= 90
        ? 'critical'
        : aggregate.score >= 70
          ? 'high'
          : 'watch';
      const status: DailyOverviewItem['status'] = persistent
        ? 'persistent'
        : isLatest
          ? 'new'
          : 'watch';
      return {
        key: aggregate.key,
        title: aggregate.title,
        summary: aggregate.summary,
        reason: buildOverviewReason(status, reportCount, isLatest),
        importance,
        status,
        reportIds: [...aggregate.reportIds],
        reportDateLabels: [...aggregate.reportDateLabels].sort(),
        matchedKeywords: [...aggregate.matchedKeywords.values()].slice(0, 4),
        sourceNames: [...aggregate.sourceNames],
        firstSeenDateLabel: [...aggregate.reportDateLabels].sort()[0] || reportDateLabel,
        lastSeenDateLabel: [...aggregate.reportDateLabels].sort().slice(-1)[0] || reportDateLabel,
        reportCount,
        sourceCount
      };
    })
    .sort((left, right) => {
      const leftRank = left.importance === 'critical' ? 3 : left.importance === 'high' ? 2 : 1;
      const rightRank = right.importance === 'critical' ? 3 : right.importance === 'high' ? 2 : 1;
      if (rightRank !== leftRank) return rightRank - leftRank;
      if (right.reportCount !== left.reportCount) return right.reportCount - left.reportCount;
      return right.lastSeenDateLabel.localeCompare(left.lastSeenDateLabel, 'zh-Hans-CN');
    })
    .slice(0, limit);

  const persistentCount = items.filter((item) => item.status === 'persistent').length;
  const freshCount = items.filter((item) => item.lastSeenDateLabel === reportDateLabel).length;

  return {
    title: `${reportDateLabel} BIM 日报总览`,
    summary: buildOverviewSummary(persistentCount, freshCount, items.length),
    items
  };
}
