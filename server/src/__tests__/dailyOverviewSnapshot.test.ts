import { describe, expect, it } from 'vitest';
import {
  applyOverviewPreferences,
  buildFallbackOverviewSnapshot,
  type DailyOverviewItem,
  type DailyOverviewReportInput,
} from '../services/dailyReportBuilder.js';

const recentReports: DailyOverviewReportInput[] = [
  {
    id: 'report-2026-05-15',
    reportDateLabel: '2026-05-15',
    title: '2026-05-15 BIM 行业日报',
    highlights: ['上海发布 BIM 指南，值得持续跟进。'],
    sections: [
      {
        title: '政策与标准',
        items: [
          {
            sourceId: 'shbimcenter',
            sourceName: '上海 BIM 推广中心',
            title: '上海发布 BIM 应用指南（2025版）',
            excerpt: '政策文件正式发布。',
            summary: '上海发布 BIM 指南，明确交付和应用边界。',
            url: 'https://example.com/shanghai-guide',
            publishedAt: new Date('2026-05-15T01:00:00.000Z'),
            recencyBucket: 'today',
            matchedKeywords: [
              {
                keywordId: 'k1',
                label: 'BIM',
                slug: 'bim',
                category: 'core',
                count: 2,
                matchedTexts: ['BIM'],
                hitFields: ['title'],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'report-2026-05-14',
    reportDateLabel: '2026-05-14',
    title: '2026-05-14 BIM 行业日报',
    highlights: ['同一政策昨日已进入管理层关注池。'],
    sections: [
      {
        title: '政策与标准',
        items: [
          {
            sourceId: 'shbimcenter',
            sourceName: '上海 BIM 推广中心',
            title: '上海发布 BIM 应用指南（2025版）',
            excerpt: '同题持续更新。',
            summary: '这条政策昨日已进入日报。',
            url: 'https://example.com/shanghai-guide',
            publishedAt: new Date('2026-05-14T02:00:00.000Z'),
            recencyBucket: 'recent',
            matchedKeywords: [
              {
                keywordId: 'k1',
                label: 'BIM',
                slug: 'bim',
                category: 'core',
                count: 1,
                matchedTexts: ['BIM'],
                hitFields: ['title'],
              },
            ],
          },
        ],
      },
      {
        title: '行业观点与趋势',
        items: [
          {
            sourceId: 'bimbox',
            sourceName: 'BIMBOX',
            title: '数字孪生正在进入园区运维常态化阶段',
            excerpt: '趋势判断。',
            summary: '数字孪生在园区和运维场景继续深化。',
            url: 'https://example.com/digital-twin-ops',
            publishedAt: new Date('2026-05-14T03:00:00.000Z'),
            recencyBucket: 'recent',
            matchedKeywords: [
              {
                keywordId: 'k2',
                label: '数字孪生',
                slug: 'digital-twin',
                category: 'trend',
                count: 2,
                matchedTexts: ['数字孪生'],
                hitFields: ['title'],
              },
            ],
          },
        ],
      },
    ],
  },
];

const previousOverview: DailyOverviewItem[] = [
  {
    key: 'legacy-guide',
    title: '上海发布 BIM 应用指南（2025版）',
    summary: '旧快照中的持续重点。',
    reason: '政策面影响全年 BIM 交付。',
    importance: 'critical',
    status: 'persistent',
    reportIds: ['report-2026-05-14'],
    reportDateLabels: ['2026-05-14'],
    matchedKeywords: [{ label: 'BIM', slug: 'bim' }],
    sourceNames: ['上海 BIM 推广中心'],
    firstSeenDateLabel: '2026-05-14',
    lastSeenDateLabel: '2026-05-14',
    reportCount: 1,
    sourceCount: 1,
  },
];

describe('buildFallbackOverviewSnapshot', () => {
  it('keeps repeated high-value items visible and surfaces the latest critical signal first', () => {
    const snapshot = buildFallbackOverviewSnapshot({
      reportDateLabel: '2026-05-15',
      recentReports,
      previousItems: previousOverview,
    });

    expect(snapshot.title).toContain('总览');
    expect(snapshot.summary).toContain('持续关注');
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.items[0]).toEqual(expect.objectContaining({
      title: '上海发布 BIM 应用指南（2025版）',
      status: 'persistent',
      importance: 'critical',
      reportCount: 2,
      lastSeenDateLabel: '2026-05-15',
    }));
    expect(snapshot.items[0]?.matchedKeywords).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'bim' }),
    ]));
    expect(snapshot.items.some((item) => item.title.includes('数字孪生'))).toBe(true);
  });
});

describe('applyOverviewPreferences', () => {
  it('keeps pinned previous items even when the latest agent snapshot omits them and applies shared order', () => {
    const snapshot = buildFallbackOverviewSnapshot({
      reportDateLabel: '2026-05-15',
      recentReports: [recentReports[0]],
    });

    const merged = applyOverviewPreferences({
      snapshot,
      previousItems: previousOverview,
      preferences: [
        { key: 'legacy-guide', pinned: true, manualOrder: 1 },
        { key: snapshot.items[0]!.key, pinned: false, manualOrder: 0 },
      ],
    });

    expect(merged.items.map((item) => item.key)).toEqual([
      snapshot.items[0]!.key,
      'legacy-guide',
    ]);
    expect(merged.items[1]).toEqual(expect.objectContaining({
      key: 'legacy-guide',
      pinned: true,
      status: 'persistent',
      manualOrder: 1,
    }));
  });
});
