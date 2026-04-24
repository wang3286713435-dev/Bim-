import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { TenderSourceId } from './runtimeConfig.js';

type ProxyPoolEntry = {
  id: string;
  protocol: 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  sources: Array<TenderSourceId | 'default'>;
};

type ProxyRuntimeState = {
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount: number;
  consecutiveFailures: number;
  cooldownUntil?: number;
};

const proxyRuntime = new Map<string, ProxyRuntimeState>();
const DEFAULT_PROXY_FAILURE_THRESHOLD = Number.parseInt(process.env.TENDER_PROXY_FAILURE_THRESHOLD || '2', 10);
const DEFAULT_PROXY_FAILURE_COOLDOWN_MS = Number.parseInt(process.env.TENDER_PROXY_FAILURE_COOLDOWN_MS || '300000', 10);

function parseProxyPool(): ProxyPoolEntry[] {
  const raw = process.env.TENDER_PROXY_POOL?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Array<Partial<ProxyPoolEntry>>;
    return parsed
      .map<ProxyPoolEntry>((entry, index) => ({
        id: entry.id?.trim() || `proxy-${index + 1}`,
        protocol: 'http' as const,
        host: entry.host?.trim() || '',
        port: Number(entry.port),
        username: entry.username?.trim() || undefined,
        password: entry.password?.trim() || undefined,
        enabled: entry.enabled !== false,
        sources: Array.isArray(entry.sources) && entry.sources.length
          ? entry.sources
              .filter((item): item is TenderSourceId | 'default' =>
                item === 'default' || ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice'].includes(String(item))
              )
          : ['default'],
      }))
      .filter((entry) => entry.enabled && entry.host && Number.isFinite(entry.port) && entry.port > 0);
  } catch (error) {
    console.warn('Failed to parse TENDER_PROXY_POOL:', error instanceof Error ? error.message : error);
    return [];
  }
}

function getProxyState(id: string): ProxyRuntimeState {
  const existing = proxyRuntime.get(id);
  if (existing) return existing;
  const initial: ProxyRuntimeState = {
    failureCount: 0,
    consecutiveFailures: 0,
  };
  proxyRuntime.set(id, initial);
  return initial;
}

function getCandidates(sourceId: TenderSourceId): ProxyPoolEntry[] {
  const pool = parseProxyPool();
  const sourceSpecific = pool.filter((entry) => entry.sources.includes(sourceId));
  if (sourceSpecific.length > 0) return sourceSpecific;
  return pool.filter((entry) => entry.sources.includes('default'));
}

function isCoolingDown(state: ProxyRuntimeState): boolean {
  if (!state.cooldownUntil) return false;
  if (Date.now() >= state.cooldownUntil) {
    state.cooldownUntil = undefined;
    state.consecutiveFailures = 0;
    return false;
  }
  return true;
}

function compareProxyHealth(a: ProxyPoolEntry, b: ProxyPoolEntry): number {
  const stateA = getProxyState(a.id);
  const stateB = getProxyState(b.id);
  const coolingA = isCoolingDown(stateA);
  const coolingB = isCoolingDown(stateB);

  if (coolingA !== coolingB) return coolingA ? 1 : -1;
  if (stateA.consecutiveFailures !== stateB.consecutiveFailures) return stateA.consecutiveFailures - stateB.consecutiveFailures;
  if (stateA.failureCount !== stateB.failureCount) return stateA.failureCount - stateB.failureCount;

  const successA = stateA.lastSuccessAt ?? 0;
  const successB = stateB.lastSuccessAt ?? 0;
  if (successA !== successB) return successB - successA;

  const failureA = stateA.lastFailureAt ?? 0;
  const failureB = stateB.lastFailureAt ?? 0;
  if (failureA !== failureB) return failureA - failureB;

  return a.id.localeCompare(b.id);
}

function getProxyAttemptSequence(sourceId: TenderSourceId): Array<ProxyPoolEntry | null> {
  const candidates = getCandidates(sourceId);
  const allowDirectFallback = process.env.TENDER_PROXY_DIRECT_FALLBACK !== 'false';

  if (candidates.length === 0) return [null];

  const healthyFirst = [...candidates].sort(compareProxyHealth);
  const available = healthyFirst.filter((entry) => !isCoolingDown(getProxyState(entry.id)));
  const cooling = healthyFirst.filter((entry) => isCoolingDown(getProxyState(entry.id)));
  const sequence: Array<ProxyPoolEntry | null> = [
    ...available,
    ...(allowDirectFallback ? [null] : []),
    ...cooling,
  ];

  return sequence.length > 0 ? sequence : [null];
}

function markProxySuccess(proxyId: string): void {
  const state = getProxyState(proxyId);
  state.lastSuccessAt = Date.now();
  state.lastError = undefined;
  state.consecutiveFailures = 0;
  state.cooldownUntil = undefined;
}

function markProxyFailure(proxyId: string, error: string): void {
  const state = getProxyState(proxyId);
  state.lastFailureAt = Date.now();
  state.lastError = error;
  state.failureCount += 1;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= Math.max(1, DEFAULT_PROXY_FAILURE_THRESHOLD)) {
    state.cooldownUntil = Date.now() + Math.max(5000, DEFAULT_PROXY_FAILURE_COOLDOWN_MS);
  }
}

function buildAxiosProxyConfig(proxy: ProxyPoolEntry): NonNullable<AxiosRequestConfig['proxy']> {
  return {
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    auth: proxy.username
      ? {
          username: proxy.username,
          password: proxy.password ?? '',
        }
      : undefined,
  };
}

export async function axiosWithSourceProxy<T>(
  sourceId: TenderSourceId,
  config: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  const { response } = await axiosWithSourceProxyDetailed<T>(sourceId, config);
  return response;
}

export async function axiosWithSourceProxyDetailed<T>(
  sourceId: TenderSourceId,
  config: AxiosRequestConfig,
): Promise<{ response: AxiosResponse<T>; proxyId?: string }> {
  const attempts = getProxyAttemptSequence(sourceId);
  let lastError: unknown;

  for (const selectedProxy of attempts) {
    try {
      const response = await axios.request<T>({
        ...config,
        ...(selectedProxy ? { proxy: buildAxiosProxyConfig(selectedProxy) } : { proxy: false }),
      });

      if (selectedProxy) {
        markProxySuccess(selectedProxy.id);
      }

      return {
        response,
        proxyId: selectedProxy?.id,
      };
    } catch (error) {
      lastError = error;
      if (selectedProxy) {
        const reason = error instanceof Error ? error.message : String(error);
        markProxyFailure(selectedProxy.id, reason);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function markProxySoftFailure(proxyId: string | undefined, error: string): void {
  if (!proxyId) return;
  markProxyFailure(proxyId, error);
}

export function getProxyPoolSnapshot() {
  return parseProxyPool().sort(compareProxyHealth).map((entry) => {
    const state = getProxyState(entry.id);
    const coolingDown = isCoolingDown(state);
    return {
      id: entry.id,
      host: entry.host,
      port: entry.port,
      enabled: entry.enabled,
      sources: entry.sources,
      failureCount: state.failureCount,
      consecutiveFailures: state.consecutiveFailures,
      coolingDown,
      cooldownRemainingMs: coolingDown && state.cooldownUntil ? Math.max(0, state.cooldownUntil - Date.now()) : 0,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
      lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : undefined,
    };
  });
}
