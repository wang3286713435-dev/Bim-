import type { SearchResult } from '../types.js';
import {
  searchCebpubservice,
  searchCcgp,
  searchGgzyNational,
  searchGzebpubservice,
  searchGuangdongYgp,
  searchSzggzy,
  searchSzygcgpt
} from './tenderSources.js';
import { getRuntimeConfig } from './runtimeConfig.js';

export type TenderSourceId = 'szggzy' | 'szygcgpt' | 'guangdong' | 'gzebpubservice' | 'ccgp' | 'ggzyNational' | 'cebpubservice';
export type TenderSourceStatus = 'disabled' | 'healthy' | 'empty' | 'request_failed' | 'waf_blocked' | 'circuit_open' | 'degraded';

export interface TenderSourceAdapter {
  id: TenderSourceId;
  name: string;
  platform: string;
  homepage: string;
  priority: number;
  riskLevel: 'low' | 'medium' | 'high';
  probeProfile: 'light' | 'standard' | 'layered';
  search: (query: string, limit?: number) => Promise<SearchResult[]>;
}

export interface TenderSourceProbe {
  id: TenderSourceId;
  name: string;
  enabled: boolean;
  ok: boolean;
  status: TenderSourceStatus;
  statusLabel: string;
  statusReason?: string;
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
const GGZY_NATIONAL_LAYERED_QUERIES = ['EPC', '工程总承包', '全过程工程咨询'] as const;

function normalizeQueries(queries: string[]): string[] {
  return [...new Set(queries.map(item => item.trim()).filter(Boolean))];
}

function isBimFamilyQuery(query: string): boolean {
  return /(BIM|建筑信息模型|智慧建造|CIM)/i.test(query);
}

function isGgzyNationalFallbackQuery(query: string): boolean {
  return /(EPC|工程总承包|全过程工程咨询)/i.test(query);
}

function buildLayeredQueriesForSource(sourceId: TenderSourceId, queries: string[], mode: 'probe' | 'crawl' = 'crawl'): string[] {
  const normalized = normalizeQueries(queries);
  if (sourceId !== 'ggzyNational') return normalized;

  const hasBimFamily = normalized.some(isBimFamilyQuery);
  const hasFallbackFamily = normalized.some(isGgzyNationalFallbackQuery);
  if (!hasBimFamily || hasFallbackFamily) return normalized;

  const layered = [...normalized, ...GGZY_NATIONAL_LAYERED_QUERIES];
  return normalizeQueries(layered).slice(0, mode === 'probe' ? 5 : 4);
}

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
    riskLevel: 'medium',
    probeProfile: 'standard',
    search: searchSzggzy
  },
  {
    id: 'szygcgpt',
    name: '深圳阳光采购平台',
    platform: '深圳阳光采购平台',
    homepage: 'https://www.szygcgpt.com/ygcg/purchaseInfoList',
    priority: 2,
    riskLevel: 'low',
    probeProfile: 'light',
    search: searchSzygcgpt
  },
  {
    id: 'guangdong',
    name: '广东省公共资源交易平台',
    platform: '广东省公共资源交易平台',
    homepage: 'https://ygp.gdzwfw.gov.cn/#/44/search/jygg',
    priority: 3,
    riskLevel: 'medium',
    probeProfile: 'standard',
    search: searchGuangdongYgp
  },
  {
    id: 'gzebpubservice',
    name: '广州公共资源交易公共服务平台',
    platform: '广州公共资源交易公共服务平台',
    homepage: 'http://www.gzebpubservice.cn/fulltext_searching.html',
    priority: 4,
    riskLevel: 'high',
    probeProfile: 'layered',
    search: searchGzebpubservice
  },
  {
    id: 'ccgp',
    name: '中国政府采购网',
    platform: '中国政府采购网',
    homepage: 'http://search.ccgp.gov.cn/bxsearch',
    priority: 5,
    riskLevel: 'low',
    probeProfile: 'light',
    search: searchCcgp
  },
  {
    id: 'ggzyNational',
    name: '全国公共资源交易平台',
    platform: '全国公共资源交易平台',
    homepage: 'https://www.ggzy.gov.cn/deal/dealList.html',
    priority: 6,
    riskLevel: 'medium',
    probeProfile: 'light',
    search: searchGgzyNational
  },
  {
    id: 'cebpubservice',
    name: '中国招标投标公共服务平台',
    platform: '中国招标投标公共服务平台',
    homepage: 'https://bulletin.cebpubservice.com/',
    priority: 7,
    riskLevel: 'medium',
    probeProfile: 'standard',
    search: searchCebpubservice
  }
];

export const TENDER_SOURCE_IDS = TENDER_SOURCE_ADAPTERS.map(source => source.id);

export async function getEnabledTenderSources(requestedSources?: string[]): Promise<TenderSourceAdapter[]> {
  const config = await getRuntimeConfig();
  const configured = config.tenderSources;

  const requested = requestedSources?.length ? requestedSources : configured;
  const known = new Set(TENDER_SOURCE_IDS);
  const enabled = new Set(
    requestedSources?.length
      ? requested.filter((source): source is TenderSourceId => known.has(source as TenderSourceId))
      : requested.filter(source => configured.includes(source as TenderSourceId))
  );

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

export function classifyTenderSourceStatus(input: {
  enabled: boolean;
  ok: boolean;
  count?: number;
  error?: string | null;
  circuitOpen?: boolean;
}): { status: TenderSourceStatus; statusLabel: string; statusReason?: string } {
  const error = (input.error || '').trim();
  const lower = error.toLowerCase();
  const isEmptyResult = !error || /empty|空结果|probe empty|returned empty|关键词未返回|暂无样例/i.test(error);

  if (!input.enabled) {
    return { status: 'disabled', statusLabel: '未启用', statusReason: '该来源未加入当前生产扫描' };
  }
  if (input.circuitOpen) {
    return { status: 'circuit_open', statusLabel: '熔断中', statusReason: error || '连续失败后进入冷却' };
  }
  if (input.ok) {
    if ((input.count ?? 0) === 0) {
      return { status: 'empty', statusLabel: '空结果', statusReason: '请求可达，但当前关键词未返回可用结果' };
    }
    if (error && /blocked|waf|challenge|403|405|验证码|安全验证|被阻断/i.test(error)) {
      return { status: 'degraded', statusLabel: '降级可用', statusReason: error };
    }
    return { status: 'healthy', statusLabel: '正常' };
  }
  if (isEmptyResult) {
    return { status: 'empty', statusLabel: '空结果', statusReason: error || '请求可达，但当前关键词未返回可用结果' };
  }
  if (/blocked|waf|challenge|403|405|forbidden|验证码|安全验证|被阻断/i.test(lower)) {
    return { status: 'waf_blocked', statusLabel: 'WAF 拦截', statusReason: error };
  }
  return { status: 'request_failed', statusLabel: '请求失败', statusReason: error };
}

function buildProbeQueries(sourceId: TenderSourceId, query: string): string[] {
  const normalized = query.trim() || 'BIM';
  const variants = new Set<string>([normalized]);

  if (sourceId === 'gzebpubservice') {
    variants.add('BIM');
    variants.add('建筑信息模型');
    variants.add('智慧建造');
  } else if (sourceId === 'szggzy' || sourceId === 'guangdong' || sourceId === 'ccgp' || sourceId === 'ggzyNational' || sourceId === 'cebpubservice') {
    variants.add('BIM');
    variants.add('建筑信息模型');
  } else {
    variants.add('BIM');
  }

  const baseQueries = [...variants].filter(Boolean).slice(0, sourceId === 'gzebpubservice' ? 4 : 3);
  return buildLayeredQueriesForSource(sourceId, baseQueries, 'probe');
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

  const effectiveQueries = buildLayeredQueriesForSource(source.id, queries, 'crawl');
  const perQueryLimit = Math.max(3, Math.ceil(limit / Math.max(1, effectiveQueries.length)));
  const settled = await Promise.allSettled(effectiveQueries.map(async query => {
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
        error: 'source disabled',
        ...classifyTenderSourceStatus({ enabled, ok: false, count: 0, error: 'source disabled' })
      };
    }

    try {
      const aggregated: SearchResult[] = [];
      let lastError: string | undefined;
      let reachedSource = false;
      for (const probeQuery of probeQueries) {
        try {
          const rows = await source.search(probeQuery, limit);
          reachedSource = true;
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
      } else if (reachedSource) {
        markSourceSuccess(source.id);
      } else if (lastError) {
        markSourceFailure(source.id, lastError);
      }
      const runtime = getTenderSourceRuntimeSnapshot(source.id);
      const probeOk = uniqueRows.length > 0 || reachedSource;
      const probeError = probeOk ? undefined : lastError;
      const sourceStatus = classifyTenderSourceStatus({
        enabled,
        ok: probeOk,
        count: uniqueRows.length,
        error: probeError,
        circuitOpen: runtime.circuitOpen
      });
      return {
        id: source.id,
        name: source.name,
        enabled,
        ok: probeOk,
        count: uniqueRows.length,
        elapsedMs: Date.now() - started,
        probeQueries,
        sampleTitle: uniqueRows[0]?.title,
        sampleUrl: uniqueRows[0]?.url,
        error: probeError,
        failureCount: runtime.failureCount,
        circuitOpen: runtime.circuitOpen,
        cooldownRemainingMs: runtime.cooldownRemainingMs,
        lastSuccessAt: runtime.lastSuccessAt,
        lastFailureAt: runtime.lastFailureAt,
        ...sourceStatus
      };
    } catch (error) {
      markSourceFailure(source.id, error instanceof Error ? error.message : String(error));
      const runtime = getTenderSourceRuntimeSnapshot(source.id);
      const sourceStatus = classifyTenderSourceStatus({
        enabled,
        ok: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
        circuitOpen: runtime.circuitOpen
      });
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
        lastFailureAt: runtime.lastFailureAt,
        ...sourceStatus
      };
    }
  }));

  probeCache.set(cacheKey, {
    cachedAt: Date.now(),
    data
  });

  return data;
}
