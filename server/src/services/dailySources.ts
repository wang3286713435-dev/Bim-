import axios from 'axios';
import { createHash } from 'node:crypto';
import type { DailySourceId } from './dailyReportRegistry.js';
import { DAILY_SOURCE_DEFINITIONS } from './dailyReportRegistry.js';
import {
  parseBimboxTopicHtml,
  parseChinaBimListResponse,
  parseFuzorSupportHtml,
  parseShbimCenterListHtml,
  parseWordPressPosts,
  type ParsedDailySourceRow
} from './dailySourceParsers.js';

export type DailySourceArticle = ParsedDailySourceRow & {
  sourceId: DailySourceId;
  sourceName: string;
  contentHash: string;
};

export type DailySourceFetchResult = {
  sourceId: DailySourceId;
  sourceName: string;
  ok: boolean;
  rows: DailySourceArticle[];
  elapsedMs: number;
  errorMessage?: string;
};

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
};

function trimText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildContentHash(sourceId: DailySourceId, row: ParsedDailySourceRow): string {
  return createHash('sha1')
    .update([sourceId, trimText(row.title), trimText(row.url), trimText(row.excerpt || '')].join('|'))
    .digest('hex');
}

function dedupeRows(sourceId: DailySourceId, sourceName: string, rows: ParsedDailySourceRow[]): DailySourceArticle[] {
  const seen = new Set<string>();
  return rows
    .map((row) => ({
      ...row,
      sourceId,
      sourceName,
      excerpt: trimText(row.excerpt || ''),
      title: trimText(row.title),
      contentHash: buildContentHash(sourceId, row)
    }))
    .filter((row) => {
      const key = `${row.url}|${row.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(row.title && row.url);
    });
}

async function fetchWordPressSource(sourceId: DailySourceId, listUrl: string, sourceName: string): Promise<DailySourceArticle[]> {
  const response = await axios.get(listUrl, { headers: REQUEST_HEADERS, timeout: 20000 });
  return dedupeRows(sourceId, sourceName, parseWordPressPosts(response.data));
}

async function fetchBimboxSource(sourceName: string): Promise<DailySourceArticle[]> {
  const definition = DAILY_SOURCE_DEFINITIONS.find((item) => item.id === 'bimbox')!;
  const response = await axios.get(definition.listUrl, { headers: REQUEST_HEADERS, timeout: 20000 });
  return dedupeRows('bimbox', sourceName, parseBimboxTopicHtml(response.data));
}

async function fetchShbimCenterSource(sourceName: string): Promise<DailySourceArticle[]> {
  const pages = [
    'https://www.shbimcenter.org/zhengcezhinan/',
    'https://www.shbimcenter.org/anlizhanshi/'
  ];
  const results = await Promise.all(pages.map((url) => axios.get(url, { headers: REQUEST_HEADERS, timeout: 20000 })));
  const rows = results.flatMap((response, index) => parseShbimCenterListHtml(response.data, pages[index]));
  return dedupeRows('shbimcenter', sourceName, rows);
}

async function fetchFuzorSource(sourceName: string): Promise<DailySourceArticle[]> {
  const definition = DAILY_SOURCE_DEFINITIONS.find((item) => item.id === 'fuzor')!;
  const response = await axios.get(definition.listUrl, { headers: REQUEST_HEADERS, timeout: 20000 });
  return dedupeRows('fuzor', sourceName, parseFuzorSupportHtml(response.data, definition.homepage));
}

type ChinaBimSelectorResponse = {
  code?: number;
  data?: {
    list?: Array<{
      fullName?: string;
      children?: Array<{
        fullName?: string;
        id?: string;
        children?: Array<{ fullName?: string; id?: string }>;
      }>;
    }>;
  };
};

function collectChinaBimLeafIds(payload: ChinaBimSelectorResponse): string[] {
  const root = payload.data?.list?.find((item) => item.fullName === 'ChinaBIM');
  if (!root?.children) return [];
  const ids: string[] = [];

  for (const child of root.children) {
    if (child.fullName?.includes('视频')) continue;
    if (child.children?.length) {
      for (const nested of child.children) {
        if (nested.fullName?.includes('视频') || !nested.id) continue;
        ids.push(nested.id);
      }
      continue;
    }
    if (child.id) ids.push(child.id);
  }

  return [...new Set(ids)];
}

async function fetchChinaBimSource(sourceName: string): Promise<DailySourceArticle[]> {
  const baseUrl = 'https://www.chinabim.com';
  const selectorResponse = await axios.get<ChinaBimSelectorResponse>(
    `${baseUrl}/prefixEbc/api/example/SupplyRelease/685442873671305925/Data/Selector`,
    { headers: { ...REQUEST_HEADERS, 'jnpf-origin': 'pc' }, timeout: 20000 }
  );
  const categoryIds = collectChinaBimLeafIds(selectorResponse.data).slice(0, 6);
  const listResponses = await Promise.all(categoryIds.map((id) =>
    axios.post(
      `${baseUrl}/prefixEbc/api/example/SupplyRelease/ciipReleaseNewsCenter/getList`,
      { newsReleaseArea: id, currentPage: 1, pageSize: 6, dataType: 0 },
      { headers: { ...REQUEST_HEADERS, 'jnpf-origin': 'pc' }, timeout: 20000 }
    )
  ));
  const rows = listResponses.flatMap((response) => parseChinaBimListResponse(response.data, baseUrl));
  return dedupeRows('chinabim', sourceName, rows);
}

export async function fetchDailySourceArticles(sourceId: DailySourceId): Promise<DailySourceFetchResult> {
  const definition = DAILY_SOURCE_DEFINITIONS.find((item) => item.id === sourceId);
  if (!definition) {
    return {
      sourceId,
      sourceName: sourceId,
      ok: false,
      rows: [],
      elapsedMs: 0,
      errorMessage: 'Unknown source'
    };
  }

  const startedAt = Date.now();

  try {
    const rows = sourceId === 'bimii' || sourceId === 'buildingsmart'
      ? await fetchWordPressSource(sourceId, definition.listUrl, definition.name)
      : sourceId === 'bimbox'
        ? await fetchBimboxSource(definition.name)
        : sourceId === 'shbimcenter'
          ? await fetchShbimCenterSource(definition.name)
          : sourceId === 'fuzor'
            ? await fetchFuzorSource(definition.name)
            : await fetchChinaBimSource(definition.name);

    return {
      sourceId,
      sourceName: definition.name,
      ok: true,
      rows,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      sourceId,
      sourceName: definition.name,
      ok: false,
      rows: [],
      elapsedMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export function pickDailySourceWindow(rows: DailySourceArticle[], primaryHours: number, fallbackHours: number, maxItems: number, referenceDate = new Date()): DailySourceArticle[] {
  const primaryCutoff = new Date(referenceDate.getTime() - primaryHours * 60 * 60 * 1000);
  const fallbackCutoff = new Date(referenceDate.getTime() - fallbackHours * 60 * 60 * 1000);
  const sorted = [...rows].sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));
  const withinPrimary = sorted.filter((item) => item.publishedAt && item.publishedAt >= primaryCutoff);
  if (withinPrimary.length > 0) return withinPrimary.slice(0, maxItems);
  return sorted.filter((item) => item.publishedAt && item.publishedAt >= fallbackCutoff).slice(0, maxItems);
}
