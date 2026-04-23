import type { SearchResult } from '../types.js';
import {
  searchGzebpubservice,
  searchGuangdongYgp,
  searchSzggzy,
  searchSzygcgpt
} from './tenderSources.js';
import { getRuntimeConfig } from './runtimeConfig.js';

export type TenderSourceId = 'szggzy' | 'szygcgpt' | 'guangdong' | 'gzebpubservice';

export interface TenderSourceAdapter {
  id: TenderSourceId;
  name: string;
  platform: string;
  homepage: string;
  priority: number;
  search: (query: string, limit?: number) => Promise<SearchResult[]>;
}

export interface TenderSourceProbe {
  id: TenderSourceId;
  name: string;
  enabled: boolean;
  ok: boolean;
  count: number;
  elapsedMs: number;
  probeQueries?: string[];
  sampleTitle?: string;
  sampleUrl?: string;
  error?: string;
  failureCount?: number;
  circuitOpen?: boolean;
  cooldownRemainingMs?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

type SourceRuntimeState = {
  failureCount: number;
  circuitOpenUntil: number | null;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
};

type ProbeCacheEntry = {
  cachedAt: number;
  data: TenderSourceProbe[];
};

const sourceRuntimeState = new Map<TenderSourceId, SourceRuntimeState>();
const probeCache = new Map<string, ProbeCacheEntry>();
const PROBE_CACHE_TTL_MS = Number.parseInt(process.env.TENDER_SOURCE_PROBE_CACHE_TTL_MS || '120000', 10);

function getSourceState(sourceId: TenderSourceId): SourceRuntimeState {
  const existing = sourceRuntimeState.get(sourceId);
  if (existing) return existing;
  const initial: SourceRuntimeState = {
    failureCount: 0,
    circuitOpenUntil: null
  };
  sourceRuntimeState.set(sourceId, initial);
  return initial;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCircuitOpen(sourceId: TenderSourceId): boolean {
  const state = getSourceState(sourceId);
  if (!state.circuitOpenUntil) return false;
  if (Date.now() >= state.circuitOpenUntil) {
    state.circuitOpenUntil = null;
    state.failureCount = 0;
    return false;
  }
  return true;
}

function markSourceSuccess(sourceId: TenderSourceId): void {
  const state = getSourceState(sourceId);
  state.failureCount = 0;
  state.circuitOpenUntil = null;
  state.lastError = undefined;
  state.lastSuccessAt = Date.now();
}

function markSourceFailure(sourceId: TenderSourceId, error: string): void {
  const state = getSourceState(sourceId);
  state.failureCount += 1;
  state.lastError = error;
  state.lastFailureAt = Date.now();
}

export const TENDER_SOURCE_ADAPTERS: TenderSourceAdapter[] = [
  {
    id: 'szggzy',
    name: '深圳公共资源交易中心',
    platform: '深圳公共资源交易中心',
    homepage: 'https://www.szggzy.com/globalSearch/index.html',
    priority: 1,
    search: searchSzggzy
  },
  {
    id: 'szygcgpt',
    name: '深圳阳光采购平台',
    platform: '深圳阳光采购平台',
    homepage: 'https://www.szygcgpt.com/ygcg/purchaseInfoList',
    priority: 2,
    search: searchSzygcgpt
  },
  {
    id: 'guangdong',
    name: '广东省公共资源交易平台',
    platform: '广东省公共资源交易平台',
    homepage: 'https://ygp.gdzwfw.gov.cn/#/44/search/jygg',
    priority: 3,
    search: searchGuangdongYgp
  },
  {
    id: 'gzebpubservice',
    name: '广州公共资源交易公共服务平台',
    platform: '广州公共资源交易公共服务平台',
    homepage: 'http://www.gzebpubservice.cn/fulltext_searching.html',
    priority: 4,
    search: searchGzebpubservice
  }
];

export const TENDER_SOURCE_IDS = TENDER_SOURCE_ADAPTERS.map(source => source.id);

export async function getEnabledTenderSources(requestedSources?: string[]): Promise<TenderSourceAdapter[]> {
  const config = await getRuntimeConfig();
  const configured = config.tenderSources;

  const requested = requestedSources?.length ? requestedSources : configured;
  const enabled = new Set(requested.filter(source => configured.includes(source as TenderSourceId)));

  return TENDER_SOURCE_ADAPTERS.filter(source => enabled.has(source.id));
}

export function getTenderSourcePriority(sourceId: string): number {
  return TENDER_SOURCE_ADAPTERS.find(source => source.id === sourceId)?.priority ?? 99;
}

export function getTenderSourceRuntimeSnapshot(sourceId: TenderSourceId) {
  const state = getSourceState(sourceId);
  const circuitOpen = isCircuitOpen(sourceId);
  return {
    failureCount: state.failureCount,
    circuitOpen,
    cooldownRemainingMs: circuitOpen && state.circuitOpenUntil ? Math.max(0, state.circuitOpenUntil - Date.now()) : 0,
    lastError: state.lastError,
    lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
    lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : undefined
  };
}

export async function buildSearchQueries(keyword: string, expandedKeywords: string[]): Promise<string[]> {
  const config = await getRuntimeConfig();
  const maxVariants = config.queryVariantsPerKeyword;
  const candidates = [
    keyword,
    ...expandedKeywords,
    'BIM',
    '建筑信息模型'
  ];

  return [...new Set(candidates.map(query => query.trim()).filter(Boolean))].slice(0, Math.max(1, maxVariants));
}

function buildProbeQueries(sourceId: TenderSourceId, query: string): string[] {
  const normalized = query.trim() || 'BIM';
  const variants = new Set<string>([normalized]);

  if (sourceId === 'gzebpubservice') {
    variants.add('BIM');
    variants.add('建筑信息模型');
    variants.add('智慧建造');
  } else if (sourceId === 'szggzy' || sourceId === 'guangdong') {
    variants.add('BIM');
    variants.add('建筑信息模型');
  } else {
    variants.add('BIM');
  }

  return [...variants].filter(Boolean).slice(0, sourceId === 'gzebpubservice' ? 4 : 3);
}

export async function searchTenderSourceAcrossQueries(
  source: TenderSourceAdapter,
  queries: string[],
  limit: number
): Promise<SearchResult[]> {
  const config = await getRuntimeConfig();
  if (isCircuitOpen(source.id)) {
    const state = getSourceState(source.id);
    throw new Error(`source circuit open: cooldown ${Math.max(0, (state.circuitOpenUntil ?? 0) - Date.now())}ms`);
  }

  const perQueryLimit = Math.max(3, Math.ceil(limit / Math.max(1, queries.length)));
  const settled = await Promise.allSettled(queries.map(async query => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.sourceRetryCount; attempt += 1) {
      try {
        const rows = await source.search(query, perQueryLimit);
        markSourceSuccess(source.id);
        return rows;
      } catch (error) {
        lastError = error;
        markSourceFailure(source.id, error instanceof Error ? error.message : String(error));
        const state = getSourceState(source.id);
        if (state.failureCount >= config.circuitBreakerThreshold) {
          state.circuitOpenUntil = Date.now() + config.circuitBreakerCooldownMs;
        }
        if (attempt < config.sourceRetryCount) {
          await sleep(config.sourceRetryDelayMs * (attempt + 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }));
  const results: SearchResult[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value);
    } else {
      console.warn(`Tender source ${source.id} query failed:`, result.reason);
    }
  }

  return results.slice(0, limit);
}

export async function probeTenderSources(query = 'BIM', limit = 3): Promise<TenderSourceProbe[]> {
  const cacheKey = `${query.trim() || 'BIM'}::${limit}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PROBE_CACHE_TTL_MS) {
    return cached.data;
  }

  const enabledIds = new Set((await getEnabledTenderSources()).map(source => source.id));

  const data = await Promise.all(TENDER_SOURCE_ADAPTERS.map(async source => {
    const started = Date.now();
    const enabled = enabledIds.has(source.id);
    const probeQueries = buildProbeQueries(source.id, query);

    if (!enabled) {
      return {
        id: source.id,
        name: source.name,
        enabled,
        ok: false,
        count: 0,
        elapsedMs: 0,
        probeQueries,
        error: 'source disabled'
      };
    }

    try {
      const aggregated: SearchResult[] = [];
      let lastError: string | undefined;
      for (const probeQuery of probeQueries) {
        try {
          const rows = await source.search(probeQuery, limit);
          if (rows.length > 0) {
            aggregated.push(...rows);
            break;
          }
          lastError = `probe empty: ${probeQuery}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      const uniqueRows = aggregated.filter((item, index, list) =>
        index === list.findIndex((candidate) => candidate.url === item.url && candidate.source === item.source)
      );

      if (uniqueRows.length > 0) {
        markSourceSuccess(source.id);
      } else if (lastError) {
        markSourceFailure(source.id, lastError);
      }
      const runtime = getTenderSourceRuntimeSnapshot(source.id);
      return {
        id: source.id,
        name: source.name,
        enabled,
        ok: uniqueRows.length > 0,
        count: uniqueRows.length,
        elapsedMs: Date.now() - started,
        probeQueries,
        sampleTitle: uniqueRows[0]?.title,
        sampleUrl: uniqueRows[0]?.url,
        error: uniqueRows.length > 0 ? undefined : lastError,
        failureCount: runtime.failureCount,
        circuitOpen: runtime.circuitOpen,
        cooldownRemainingMs: runtime.cooldownRemainingMs,
        lastSuccessAt: runtime.lastSuccessAt,
        lastFailureAt: runtime.lastFailureAt
      };
    } catch (error) {
      markSourceFailure(source.id, error instanceof Error ? error.message : String(error));
      const runtime = getTenderSourceRuntimeSnapshot(source.id);
      return {
        id: source.id,
        name: source.name,
        enabled,
        ok: false,
        count: 0,
        elapsedMs: Date.now() - started,
        probeQueries,
        error: error instanceof Error ? error.message : String(error),
        failureCount: runtime.failureCount,
        circuitOpen: runtime.circuitOpen,
        cooldownRemainingMs: runtime.cooldownRemainingMs,
        lastSuccessAt: runtime.lastSuccessAt,
        lastFailureAt: runtime.lastFailureAt
      };
    }
  }));

  probeCache.set(cacheKey, {
    cachedAt: Date.now(),
    data
  });

  return data;
}
