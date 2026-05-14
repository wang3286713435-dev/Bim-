import axios from 'axios';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { DailySourceId } from './dailyReportRegistry.js';
import { DAILY_SOURCE_DEFINITIONS } from './dailyReportRegistry.js';
import {
  extractReadableContentFromHtml,
  parseBimboxTopicHtml,
  parseChinaBimListResponse,
  parseFuzorSupportHtml,
  parseShbimCenterListHtml,
  parseWordPressApiResponsePayload,
  parseWordPressPosts,
  type ParsedDailySourceRow
} from './dailySourceParsers.js';

export type DailySourceArticle = ParsedDailySourceRow & {
  sourceId: DailySourceId;
  sourceName: string;
  contentHash: string;
  targetedRecall?: boolean;
  recallQueries?: string[];
};

export type DailySourceArticleWithBucket = DailySourceArticle & {
  recencyBucket: 'today' | 'recent' | 'watch';
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

const CHINA_BIM_DETAIL_HEADERS = {
  ...REQUEST_HEADERS,
  'jnpf-origin': 'pc'
};

function trimText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildContentHash(sourceId: DailySourceId, row: ParsedDailySourceRow): string {
  return createHash('sha1')
    .update([sourceId, trimText(row.title), trimText(row.url), trimText(row.excerpt || '')].join('|'))
    .digest('hex');
}

function materializeRows(
  sourceId: DailySourceId,
  sourceName: string,
  rows: ParsedDailySourceRow[],
  extras?: Partial<Pick<DailySourceArticle, 'targetedRecall' | 'recallQueries'>>
): DailySourceArticle[] {
  const seen = new Set<string>();
  return rows
    .map((row) => ({
      ...row,
      sourceId,
      sourceName,
      excerpt: trimText(row.excerpt || ''),
      title: trimText(row.title),
      contentHash: buildContentHash(sourceId, row),
      targetedRecall: extras?.targetedRecall,
      recallQueries: extras?.recallQueries?.length ? [...new Set(extras.recallQueries)] : undefined
    }))
    .filter((row) => {
      const key = `${row.url}|${row.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(row.title && row.url);
    });
}

function dedupeRows(sourceId: DailySourceId, sourceName: string, rows: ParsedDailySourceRow[]): DailySourceArticle[] {
  return materializeRows(sourceId, sourceName, rows);
}

export function mergeDailySourceArticles(baseRows: DailySourceArticle[], recallRows: DailySourceArticle[]): DailySourceArticle[] {
  const merged = new Map<string, DailySourceArticle>();

  for (const row of [...baseRows, ...recallRows]) {
    const key = `${row.url}|${row.title}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...row,
        recallQueries: row.recallQueries?.length ? [...new Set(row.recallQueries)] : undefined
      });
      continue;
    }

    merged.set(key, {
      ...current,
      excerpt: row.excerpt.length > current.excerpt.length ? row.excerpt : current.excerpt,
      publishedAt: current.publishedAt || row.publishedAt,
      targetedRecall: current.targetedRecall || row.targetedRecall,
      recallQueries: [...new Set([...(current.recallQueries || []), ...(row.recallQueries || [])])]
    });
  }

  return [...merged.values()];
}

async function fetchWordPressSource(sourceId: DailySourceId, listUrl: string, sourceName: string): Promise<DailySourceArticle[]> {
  const response = await axios.get(listUrl, { headers: REQUEST_HEADERS, timeout: 20000 });
  const posts = Array.isArray(response.data) ? response.data : parseWordPressApiResponsePayload(response.data);
  return dedupeRows(sourceId, sourceName, parseWordPressPosts(posts));
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

function buildWordPressSearchUrl(listUrl: string, query: string, perPage: number): string {
  const url = new URL(listUrl);
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('_fields', 'link,title,date,excerpt,categories,tags');
  return url.toString();
}

async function fetchWordPressRecallSource(
  sourceId: DailySourceId,
  listUrl: string,
  sourceName: string,
  queries: string[],
  maxPerQuery: number
): Promise<DailySourceArticle[]> {
  const responses = await Promise.all(queries.map((query) =>
    axios.get(buildWordPressSearchUrl(listUrl, query, maxPerQuery), { headers: REQUEST_HEADERS, timeout: 20000 })
      .then((response) => {
        const posts = Array.isArray(response.data) ? response.data : parseWordPressApiResponsePayload(response.data);
        return materializeRows(sourceId, sourceName, parseWordPressPosts(posts), {
          targetedRecall: true,
          recallQueries: [query]
        });
      })
      .catch(() => [] as DailySourceArticle[])
  ));
  return mergeDailySourceArticles([], responses.flat());
}

async function fetchBimboxRecallSource(sourceName: string, queries: string[], maxPerQuery: number): Promise<DailySourceArticle[]> {
  const responses = await Promise.all(queries.map((query) =>
    axios.get(`https://bimbox.top/?s=${encodeURIComponent(query)}`, { headers: REQUEST_HEADERS, timeout: 20000 })
      .then((response) => materializeRows('bimbox', sourceName, parseBimboxTopicHtml(response.data).slice(0, maxPerQuery), {
        targetedRecall: true,
        recallQueries: [query]
      }))
      .catch(() => [] as DailySourceArticle[])
  ));
  return mergeDailySourceArticles([], responses.flat());
}

async function fetchShbimCenterRecallSource(sourceName: string, queries: string[], maxPerQuery: number): Promise<DailySourceArticle[]> {
  const responses = await Promise.all(queries.map((query) =>
    axios.get(`https://www.shbimcenter.org/search/index/init.html?modelid=0&q=${encodeURIComponent(query)}`, { headers: REQUEST_HEADERS, timeout: 20000 })
      .then((response) => materializeRows('shbimcenter', sourceName, parseShbimCenterListHtml(response.data, 'https://www.shbimcenter.org/search/index/init.html').slice(0, maxPerQuery), {
        targetedRecall: true,
        recallQueries: [query]
      }))
      .catch(() => [] as DailySourceArticle[])
  ));
  return mergeDailySourceArticles([], responses.flat());
}

async function fetchDailySourceRecallArticles(definition: (typeof DAILY_SOURCE_DEFINITIONS)[number]): Promise<DailySourceArticle[]> {
  const recall = definition.recall;
  if (!recall?.queries.length) return [];

  if (definition.id === 'bimii' || definition.id === 'buildingsmart') {
    return fetchWordPressRecallSource(definition.id, definition.listUrl, definition.name, recall.queries, recall.maxPerQuery);
  }

  if (definition.id === 'bimbox') {
    return fetchBimboxRecallSource(definition.name, recall.queries, recall.maxPerQuery);
  }

  if (definition.id === 'shbimcenter') {
    return fetchShbimCenterRecallSource(definition.name, recall.queries, recall.maxPerQuery);
  }

  return [];
}

function chooseLongestText($: cheerio.CheerioAPI, selectors: string[]): string {
  let best = '';
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = trimText($(element).text());
      if (text.length > best.length) best = text;
    });
    if (best.length >= 600) break;
  }
  return best;
}

async function fetchChinaBimDetailText(article: DailySourceArticle): Promise<string> {
  const id = article.url.match(/\/news\/([^/?#]+)/)?.[1];
  if (!id) return '';
  const response = await axios.get(
    `https://www.chinabim.com/prefixEbc/api/example/SupplyRelease/ciipReleaseNewsCenter/detail/${id}`,
    { headers: CHINA_BIM_DETAIL_HEADERS, timeout: 20000 }
  );
  const detail = response.data?.data || {};
  return trimText([detail.title, detail.digest, detail.content].filter(Boolean).join(' '));
}

async function fetchGenericDetailText(article: DailySourceArticle): Promise<string> {
  const response = await axios.get(article.url, { headers: REQUEST_HEADERS, timeout: 20000 });
  const extracted = extractReadableContentFromHtml(response.data);
  if (extracted) return extracted;
  const $ = cheerio.load(response.data);
  return chooseLongestText($, ['article', 'main', 'body']);
}

export async function fetchDailyArticleDetailText(article: DailySourceArticle): Promise<string> {
  try {
    if (article.sourceId === 'chinabim') {
      return await fetchChinaBimDetailText(article);
    }
    return await fetchGenericDetailText(article);
  } catch {
    return article.excerpt || '';
  }
}

export function getDailyRecencyBucket(
  publishedAt: Date | null,
  referenceDate = new Date(),
  primaryHours = 24,
  fallbackHours = 72,
  extendedHours = 168
): 'today' | 'recent' | 'watch' | 'stale' {
  if (!publishedAt) return 'stale';
  const ageMs = referenceDate.getTime() - publishedAt.getTime();
  if (ageMs < 0) return 'today';
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours <= primaryHours) return 'today';
  if (ageHours <= fallbackHours) return 'recent';
  if (ageHours <= extendedHours) return 'watch';
  return 'stale';
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
    const baseRows = sourceId === 'bimii' || sourceId === 'buildingsmart'
      ? await fetchWordPressSource(sourceId, definition.listUrl, definition.name)
      : sourceId === 'bimbox'
        ? await fetchBimboxSource(definition.name)
        : sourceId === 'shbimcenter'
          ? await fetchShbimCenterSource(definition.name)
          : sourceId === 'fuzor'
            ? await fetchFuzorSource(definition.name)
            : await fetchChinaBimSource(definition.name);
    const recallRows = await fetchDailySourceRecallArticles(definition);
    const rows = mergeDailySourceArticles(baseRows, recallRows);

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

export function pickDailySourceWindow(
  rows: DailySourceArticle[],
  primaryHours: number,
  fallbackHours: number,
  maxItems: number,
  referenceDate = new Date(),
  extendedHours = 168,
  minItems = 2
): DailySourceArticleWithBucket[] {
  const sorted = [...rows]
    .map((item) => ({
      ...item,
      recencyBucket: getDailyRecencyBucket(item.publishedAt, referenceDate, primaryHours, fallbackHours, extendedHours)
    }))
    .filter((item): item is DailySourceArticleWithBucket => item.recencyBucket !== 'stale')
    .sort((a, b) => {
      const targetedDelta = Number(Boolean(b.targetedRecall)) - Number(Boolean(a.targetedRecall));
      if (targetedDelta !== 0) return targetedDelta;
      return (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0);
    });

  const today = sorted.filter((item) => item.recencyBucket === 'today');
  const recent = sorted.filter((item) => item.recencyBucket === 'recent');
  const watch = sorted.filter((item) => item.recencyBucket === 'watch');

  const selected: DailySourceArticleWithBucket[] = [];
  const seen = new Set<string>();

  const pushRows = (items: DailySourceArticleWithBucket[], limit: number) => {
    for (const item of items) {
      if (selected.length >= limit) break;
      if (seen.has(item.url)) continue;
      selected.push(item);
      seen.add(item.url);
    }
  };

  pushRows(today, maxItems);
  if (selected.length < minItems) pushRows(recent, Math.min(maxItems, minItems));
  if (selected.length < minItems) pushRows(watch, Math.min(maxItems, minItems));
  if (selected.length < maxItems) pushRows(recent, maxItems);
  if (selected.length < maxItems) pushRows(watch, maxItems);

  return selected;
}
