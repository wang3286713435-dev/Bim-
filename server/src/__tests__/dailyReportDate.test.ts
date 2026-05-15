import { describe, expect, it } from 'vitest';
import { buildDailyReportDraft, type DailyArticleDraft } from '../services/dailyReportBuilder.js';
import { serializeDailyReportShape } from '../services/dailyReports.js';

const ARTICLES: DailyArticleDraft[] = [
  {
    sourceId: 'chinabim',
    sourceName: 'ChinaBIM',
    title: 'BIM 行业观察',
    excerpt: '今日 BIM 资讯。',
    summary: '今日有新的 BIM 相关资讯。',
    url: 'https://www.chinabim.com/example',
    publishedAt: new Date('2026-05-15T01:00:00.000Z'),
    recencyBucket: 'today',
    matchedKeywords: [{ keywordId: 'bim', label: 'BIM', slug: 'bim', category: 'core', count: 1, matchedTexts: ['BIM'], hitFields: ['title'] }],
  },
];

describe('daily report date labeling', () => {
  it('uses Asia/Shanghai calendar date when building the report title', () => {
    const reportDate = new Date('2026-05-14T16:00:00.000Z');
    const draft = buildDailyReportDraft(reportDate, ARTICLES, ARTICLES.length);
    expect(draft.title).toContain('2026-05-15');
  });

  it('serializes a stable local reportDateLabel for the frontend', () => {
    const serialized = serializeDailyReportShape({
      id: 'report-1',
      reportDate: new Date('2026-05-14T16:00:00.000Z'),
      title: '2026-05-15 BIM 行业日报',
      intro: 'intro',
      executiveSummary: 'summary',
      highlightsJson: '[]',
      sectionsJson: '[]',
      metaJson: '{"candidateArticleCount":1,"selectedArticleCount":1,"freshArticleCount":1,"supplementalArticleCount":0,"sourceCount":1}',
      status: 'completed',
      sourceCount: 1,
      articleCount: 1,
      keywordStatsJson: '[]',
      generatedAt: new Date('2026-05-15T01:10:00.000Z'),
      createdAt: new Date('2026-05-15T01:10:00.000Z')
    });

    expect(serialized.reportDateLabel).toBe('2026-05-15');
  });
});
