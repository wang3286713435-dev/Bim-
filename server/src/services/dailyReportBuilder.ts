import type { DailyKeywordHit } from './dailyKeywordMatcher.js';

export type DailySectionTitle =
  | '政策与标准'
  | '行业观点与趋势'
  | '案例与应用'
  | '软件与产品动态'
  | '国际标准 / openBIM';

export type DailyArticleDraft = {
  sourceId: string;
  sourceName: string;
  title: string;
  excerpt: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
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
  sections: DailyReportSection[];
  sourceCount: number;
  articleCount: number;
  keywordStats: DailyKeywordStat[];
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

export function buildDailyReportDraft(reportDate: Date, articles: DailyArticleDraft[]): DailyReportDraft {
  const keywordStats = buildDailyKeywordStats(articles);
  const sectionsMap = new Map<DailySectionTitle, DailyArticleDraft[]>();
  const sourceCount = new Set(articles.map((item) => item.sourceId)).size;

  for (const title of SECTION_ORDER) {
    sectionsMap.set(title, []);
  }

  for (const article of articles) {
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

  return {
    title: `${dateLabel} BIM 日报`,
    intro: `今日共整理 ${articles.length} 条 BIM 相关资讯，覆盖 ${sourceCount} 个来源。`,
    executiveSummary: `关键词概览：${topKeywords}`,
    sections,
    sourceCount,
    articleCount: articles.length,
    keywordStats,
  };
}
