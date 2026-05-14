import { describe, expect, it } from 'vitest';
import {
  mergeDailySourceArticles,
  pickDailySourceWindow,
  type DailySourceArticle
} from '../services/dailySources.js';
import { parseWordPressApiResponsePayload } from '../services/dailySourceParsers.js';

function makeArticle(overrides: Partial<DailySourceArticle>): DailySourceArticle {
  return {
    sourceId: 'bimii',
    sourceName: 'BIM建筑网',
    title: '示例文章',
    url: 'https://example.com/article',
    excerpt: '示例摘要',
    publishedAt: new Date('2026-05-14T00:00:00.000Z'),
    rawCategory: null,
    contentHash: 'hash',
    ...overrides
  };
}

describe('parseWordPressApiResponsePayload', () => {
  it('strips PHP warnings before parsing JSON arrays', () => {
    const payload = `<br />\n<b>Warning</b>: Undefined array key "search_terms"<br />\n[{\"date\":\"2026-02-15T21:59:02\",\"link\":\"https://example.com/post\",\"title\":{\"rendered\":\"BIM 搜索结果\"},\"excerpt\":{\"rendered\":\"<p>摘要</p>\"}}]`;
    const posts = parseWordPressApiResponsePayload(payload);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.link).toBe('https://example.com/post');
  });
});

describe('mergeDailySourceArticles', () => {
  it('preserves targeted recall metadata when the same URL appears in base and recall pools', () => {
    const merged = mergeDailySourceArticles(
      [
        makeArticle({
          url: 'https://example.com/a',
          title: '列表文章',
          contentHash: 'base-hash'
        })
      ],
      [
        makeArticle({
          url: 'https://example.com/a',
          title: '列表文章',
          contentHash: 'recall-hash',
          targetedRecall: true,
          recallQueries: ['BIM']
        })
      ]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.targetedRecall).toBe(true);
    expect(merged[0]?.recallQueries).toEqual(['BIM']);
  });
});

describe('pickDailySourceWindow with merged recall candidates', () => {
  it('allows long-tail recall items to enter the watch bucket when source-specific horizon is extended', () => {
    const rows = mergeDailySourceArticles(
      [
        makeArticle({
          url: 'https://example.com/stale',
          title: '旧列表文章',
          publishedAt: new Date('2024-01-01T00:00:00.000Z')
        })
      ],
      [
        makeArticle({
          url: 'https://example.com/recall',
          title: 'BIM 政策延续关注',
          publishedAt: new Date('2026-02-14T00:00:00.000Z'),
          targetedRecall: true,
          recallQueries: ['BIM']
        })
      ]
    );

    const picked = pickDailySourceWindow(
      rows,
      24,
      72,
      4,
      new Date('2026-05-15T00:00:00.000Z'),
      24 * 120,
      1
    );

    expect(picked).toHaveLength(1);
    expect(picked[0]?.title).toBe('BIM 政策延续关注');
    expect(picked[0]?.recencyBucket).toBe('watch');
  });
});
