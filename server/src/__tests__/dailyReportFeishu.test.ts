import { describe, expect, it } from 'vitest';
import { buildDailyReportFeishuCard, buildDailyReportRouteUrl, summarizeDailyPushState } from '../services/dailyReportFeishu.js';

describe('buildDailyReportRouteUrl', () => {
  it('builds a report deep link using tab and reportId query params', () => {
    expect(buildDailyReportRouteUrl('https://tender.zhuoyusmart.top', 'report-123')).toBe(
      'https://tender.zhuoyusmart.top/?tab=daily&reportId=report-123'
    );
  });
});

describe('buildDailyReportFeishuCard', () => {
  it('renders a management-friendly daily card with highlights, actions, and report link', () => {
    const card = buildDailyReportFeishuCard({
      report: {
        id: 'report-123',
        reportDate: '2026-05-15T00:00:00.000Z',
        title: '2026年5月15日 BIM行业资讯日报',
        intro: '今日 BIM 资讯以政策更新和数字孪生实践为主。',
        executiveSummary: '政策标准与数字孪生落地是今天最值得管理层关注的两条主线。',
        highlights: ['上海发布 BIM 应用指南。', 'buildingSMART 继续推进 openBIM 实践。'],
        recommendedActions: ['安排团队复核上海政策影响。', '跟踪 openBIM 与 IFC 标准落地。'],
        sourceCount: 4,
        articleCount: 8,
        generatedAt: '2026-05-15T09:10:00.000Z',
        meta: {
          candidateArticleCount: 16,
          selectedArticleCount: 8,
          freshArticleCount: 3,
          supplementalArticleCount: 5,
          sourceCount: 4,
          editorialAngle: '政策与标准优先，兼顾国际标准和案例。'
        },
        keywordStats: [
          { keywordId: '1', label: 'BIM', slug: 'bim', category: 'core', count: 12 },
          { keywordId: '2', label: '数字孪生', slug: 'digital-twin', category: 'trend', count: 5 }
        ]
      },
      reportUrl: 'https://tender.zhuoyusmart.top/?tab=daily&reportId=report-123'
    });

    expect(card.msg_type).toBe('interactive');
    expect(JSON.stringify(card)).toContain('管理层摘要');
    expect(JSON.stringify(card)).toContain('今日重点 1');
    expect(JSON.stringify(card)).toContain('建议跟踪 1');
    expect(JSON.stringify(card)).toContain('查看平台内日报');
    expect(JSON.stringify(card)).toContain('BIM 12');
  });

  it('falls back to a no-new-items summary when the report has no selected articles', () => {
    const card = buildDailyReportFeishuCard({
      report: {
        id: 'report-empty',
        reportDate: '2026-05-16T00:00:00.000Z',
        title: '2026年5月16日 BIM行业资讯日报',
        intro: '今日暂无值得纳入管理层日报的新资讯。',
        executiveSummary: '今日候选池未形成高价值资讯，建议继续观察。',
        highlights: [],
        recommendedActions: [],
        sourceCount: 0,
        articleCount: 0,
        generatedAt: '2026-05-16T09:00:00.000Z',
        meta: {
          candidateArticleCount: 0,
          selectedArticleCount: 0,
          freshArticleCount: 0,
          supplementalArticleCount: 0,
          sourceCount: 0
        },
        keywordStats: []
      },
      reportUrl: 'https://tender.zhuoyusmart.top/?tab=daily&reportId=report-empty'
    });

    expect(JSON.stringify(card)).toContain('今日无新增');
    expect(JSON.stringify(card)).toContain('继续观察');
  });
});

describe('summarizeDailyPushState', () => {
  it('maps push logs into lightweight API fields', () => {
    expect(summarizeDailyPushState({
      id: 'push-1',
      reportId: 'report-123',
      triggerType: 'scheduled',
      channel: 'feishu_webhook',
      status: 'sent',
      errorMessage: null,
      payloadDigest: 'digest',
      pushedAt: new Date('2026-05-15T09:11:00.000Z'),
      createdAt: new Date('2026-05-15T09:11:00.000Z')
    })).toEqual(expect.objectContaining({
      status: 'sent',
      triggerType: 'scheduled',
      reportId: 'report-123'
    }));
  });
});
