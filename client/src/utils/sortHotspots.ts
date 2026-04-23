/**
 * 热点排序工具函数（前端版本，与 server/src/utils/sortHotspots.ts 逻辑一致）
 */

export interface SortableHotspot {
  likeCount: number | null;
  retweetCount: number | null;
  viewCount: number | null;
  importance: string;
  relevance: number;
  publishedAt: Date | string | null;
  createdAt: Date | string;
  tenderDeadline?: Date | string | null;
  tenderBidOpenTime?: Date | string | null;
  tenderDocDeadline?: Date | string | null;
}

export const IMPORTANCE_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function calcHotScore(item: SortableHotspot): number {
  const likes = item.likeCount || 0;
  const retweets = item.retweetCount || 0;
  const views = item.viewCount || 0;
  return likes * 10 + retweets * 5 + Math.log10(Math.max(views, 1)) * 2;
}

export function compareImportance(a: SortableHotspot, b: SortableHotspot): number {
  return (IMPORTANCE_ORDER[a.importance] ?? 4) - (IMPORTANCE_ORDER[b.importance] ?? 4);
}

function toTimestamp(d: Date | string | null): number {
  if (!d) return 0;
  return typeof d === 'string' ? new Date(d).getTime() : d.getTime();
}

function getEffectiveDeadline(item: SortableHotspot): number {
  return (
    toTimestamp(item.tenderDeadline ?? null)
    || toTimestamp(item.tenderBidOpenTime ?? null)
    || toTimestamp(item.tenderDocDeadline ?? null)
  );
}

function compareDeadlineStatus(a: SortableHotspot, b: SortableHotspot): number {
  const now = Date.now();
  const deadlineA = getEffectiveDeadline(a);
  const deadlineB = getEffectiveDeadline(b);

  const bucketA = !deadlineA ? 2 : deadlineA < now ? 3 : deadlineA - now <= 7 * 24 * 60 * 60 * 1000 ? 0 : 1;
  const bucketB = !deadlineB ? 2 : deadlineB < now ? 3 : deadlineB - now <= 7 * 24 * 60 * 60 * 1000 ? 0 : 1;

  if (bucketA !== bucketB) return bucketA - bucketB;
  if (deadlineA && deadlineB) return deadlineA - deadlineB;
  return compareImportance(a, b);
}

export function sortHotspots<T extends SortableHotspot>(
  items: T[],
  sortBy: string,
  sortOrder: 'asc' | 'desc' = 'desc'
): T[] {
  const sorted = [...items];
  const desc = sortOrder === 'desc';

  sorted.sort((a, b) => {
    let result: number;

    switch (sortBy) {
      case 'publishedAt': {
        const ta = toTimestamp(a.publishedAt);
        const tb = toTimestamp(b.publishedAt);
        result = ta - tb;
        if (result === 0) {
          result = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
        }
        break;
      }

      case 'importance': {
        result = compareImportance(a, b);
        if (result === 0) {
          result = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
          return desc ? -(result) : result;
        }
        return desc ? result : -result;
      }

      case 'relevance':
        result = a.relevance - b.relevance;
        break;

      case 'hot':
        result = calcHotScore(a) - calcHotScore(b);
        break;

      case 'deadlineStatus':
        result = compareDeadlineStatus(a, b);
        return desc ? result : -result;

      default: // createdAt
        result = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
        break;
    }

    return desc ? -(result) : result;
  });

  return sorted;
}
