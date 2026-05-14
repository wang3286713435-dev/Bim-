import type { DailyKeywordHit } from './dailyKeywordMatcher.js';

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
  };
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

export function buildDailyReportDraft(
  reportDate: Date,
  selectedArticles: DailyArticleDraft[],
  candidateArticleCount = selectedArticles.length
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

  const dateLabel = reportDate.toISOString().slice(0, 10);
  const topKeywords = keywordStats.slice(0, 3).map((item) => `${item.label} ${item.count}`).join('｜') || '无重点关键词命中';
  const highlights = buildManagementHighlights(selectedArticles);

  return {
    title: `${dateLabel} BIM 行业日报`,
    intro: `今日从 ${sourceCount} 个来源审阅 ${candidateArticleCount} 条 BIM 相关候选资讯，精选 ${selectedArticles.length} 条进入日报。${supplementalArticleCount > 0 ? `其中 ${supplementalArticleCount} 条为近 7 日延续关注。` : ''}`,
    executiveSummary: `今日重点围绕政策动向、行业趋势与项目应用展开。关键词概览：${topKeywords}。${freshArticleCount > 0 ? `今日新增 ${freshArticleCount} 条。` : '今日新增较少，已自动补入近 7 日延续关注内容。'}`,
    highlights,
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
    },
  };
}
