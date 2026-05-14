import { describe, expect, it } from 'vitest';
import {
  applyEditorialSelection,
  buildManagementHighlights,
  buildDailyKeywordStats,
  buildDailyReportDraft,
  classifyDailyArticleSection,
  filterDailyArticlesByKeyword,
  scoreDailyArticle,
  selectEditorialDailyArticles,
  type DailyArticleDraft
} from '../services/dailyReportBuilder.js';

const ARTICLES: DailyArticleDraft[] = [
  {
    sourceId: 'shbimcenter',
    sourceName: '上海 BIM 推广中心',
    title: '关于发布《上海市建筑信息模型技术应用指南（2025版）》的通知',
    excerpt: '政策文件正式发布。',
    summary: '上海发布 BIM 应用指南，偏政策标准。',
    url: 'https://www.shbimcenter.org/shanghaizhengce/20213305.html',
    publishedAt: new Date('2026-05-15T00:00:00.000Z'),
    recencyBucket: 'today',
    matchedKeywords: [{ keywordId: 'k1', label: 'BIM', slug: 'bim', category: 'core', count: 2, matchedTexts: ['BIM'], hitFields: ['title'] }],
  },
  {
    sourceId: 'fuzor',
    sourceName: 'Fuzor 官网',
    title: 'Fuzor施工模拟动画如何导出',
    excerpt: '围绕 4D 施工模拟的产品教程。',
    summary: 'Fuzor 发布面向施工模拟的产品型内容。',
    url: 'https://www.bim4d.com.cn/faq/fuzor-jcimhd.html',
    publishedAt: new Date('2026-05-14T00:00:00.000Z'),
    recencyBucket: 'recent',
    matchedKeywords: [{ keywordId: 'k4', label: '4D', slug: '4d', category: 'software', count: 1, matchedTexts: ['4D'], hitFields: ['excerpt'] }],
  },
  {
    sourceId: 'buildingsmart',
    sourceName: 'buildingSMART',
    title: 'Industry Insights: openBIM for increasing efficiency',
    excerpt: 'Focus on openBIM and IFC interoperability.',
    summary: '国际标准组织发布 openBIM 相关文章。',
    url: 'https://www.buildingsmart.org/example',
    publishedAt: new Date('2026-05-13T00:00:00.000Z'),
    recencyBucket: 'watch',
    matchedKeywords: [
      { keywordId: 'k5', label: 'OpenBIM', slug: 'openbim', category: 'standard', count: 1, matchedTexts: ['openBIM'], hitFields: ['title'] },
      { keywordId: 'k6', label: 'IFC', slug: 'ifc', category: 'standard', count: 1, matchedTexts: ['IFC'], hitFields: ['excerpt'] }
    ],
  },
];

describe('classifyDailyArticleSection', () => {
  it('classifies policy, product, and standards articles into expected sections', () => {
    expect(classifyDailyArticleSection(ARTICLES[0])).toBe('政策与标准');
    expect(classifyDailyArticleSection(ARTICLES[1])).toBe('软件与产品动态');
    expect(classifyDailyArticleSection(ARTICLES[2])).toBe('国际标准 / openBIM');
  });
});

describe('buildDailyKeywordStats', () => {
  it('aggregates keyword counts across article hits', () => {
    const stats = buildDailyKeywordStats(ARTICLES);
    expect(stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'BIM', count: 2 }),
      expect.objectContaining({ label: 'OpenBIM', count: 1 }),
      expect.objectContaining({ label: 'IFC', count: 1 }),
    ]));
  });
});

describe('filterDailyArticlesByKeyword', () => {
  it('returns only articles that match the selected keyword slug', () => {
    const filtered = filterDailyArticlesByKeyword(ARTICLES, 'bim');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sourceId).toBe('shbimcenter');
  });
});

describe('buildDailyReportDraft', () => {
  it('builds a multi-section report with management highlights and meta', () => {
    const draft = buildDailyReportDraft(new Date('2026-05-15T09:00:00.000Z'), ARTICLES, 6);

    expect(draft.title).toContain('BIM');
    expect(draft.sourceCount).toBe(3);
    expect(draft.articleCount).toBe(3);
    expect(draft.highlights.length).toBeGreaterThan(0);
    expect(draft.meta.candidateArticleCount).toBe(6);
    expect(draft.meta.supplementalArticleCount).toBe(2);
    expect(draft.sections.map((item) => item.title)).toEqual(expect.arrayContaining(['政策与标准', '软件与产品动态', '国际标准 / openBIM']));
    expect(draft.keywordStats).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'BIM' })]));
  });
});

describe('editorial selection helpers', () => {
  it('scores policy articles above lower-signal software tutorials', () => {
    expect(scoreDailyArticle(ARTICLES[0])).toBeGreaterThan(scoreDailyArticle(ARTICLES[1]));
  });

  it('prefers source-diverse articles when selecting editorial output', () => {
    const overloaded = [
      ARTICLES[0],
      { ...ARTICLES[0], url: 'https://www.shbimcenter.org/another', title: '上海 BIM 试点推进通知', summary: '政策延续更新。' },
      ARTICLES[1],
      ARTICLES[2],
    ];
    const selected = selectEditorialDailyArticles(overloaded, 3);
    expect(new Set(selected.map((item) => item.sourceId)).size).toBe(3);
  });

  it('builds concise management highlights from selected articles', () => {
    const highlights = buildManagementHighlights(ARTICLES);
    expect(highlights).toHaveLength(3);
    expect(highlights[0]).toContain('政策面');
  });

  it('honors AI editorial ordering and fills remaining slots with heuristic picks', () => {
    const selected = applyEditorialSelection(
      ARTICLES,
      {
        selectedUrls: [ARTICLES[2].url, ARTICLES[0].url],
        editorialAngle: '优先强调政策与国际标准，再补应用案例',
        recommendedActions: ['关注政策落地', '跟踪标准互操作']
      },
      3
    );

    expect(selected).toHaveLength(3);
    expect(selected[0]?.url).toBe(ARTICLES[2].url);
    expect(selected[1]?.url).toBe(ARTICLES[0].url);
  });
});
