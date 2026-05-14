import { describe, expect, it } from 'vitest';
import {
  buildDailyKeywordStats,
  buildDailyReportDraft,
  classifyDailyArticleSection,
  filterDailyArticlesByKeyword,
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
  it('builds a multi-section report with keyword overview', () => {
    const draft = buildDailyReportDraft(new Date('2026-05-15T09:00:00.000Z'), ARTICLES);

    expect(draft.title).toContain('BIM');
    expect(draft.sourceCount).toBe(3);
    expect(draft.articleCount).toBe(3);
    expect(draft.sections.map((item) => item.title)).toEqual(expect.arrayContaining(['政策与标准', '软件与产品动态', '国际标准 / openBIM']));
    expect(draft.keywordStats).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'BIM' })]));
  });
});
