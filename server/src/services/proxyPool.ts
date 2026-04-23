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
  cursor: number;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount: number;
};

const proxyRuntime = new Map<string, ProxyRuntimeState>();
const sourceCursor = new Map<TenderSourceId, number>();

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
    cursor: 0,
    failureCount: 0,
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

function pickProxy(sourceId: TenderSourceId): ProxyPoolEntry | null {
  const candidates = getCandidates(sourceId);
  if (candidates.length === 0) return null;

  const cursor = sourceCursor.get(sourceId) ?? 0;
  const index = cursor % candidates.length;
  sourceCursor.set(sourceId, (cursor + 1) % candidates.length);
  return candidates[index] ?? null;
}

function markProxySuccess(proxyId: string): void {
  const state = getProxyState(proxyId);
  state.lastSuccessAt = Date.now();
  state.lastError = undefined;
  state.failureCount = 0;
}

function markProxyFailure(proxyId: string, error: string): void {
  const state = getProxyState(proxyId);
  state.lastFailureAt = Date.now();
  state.lastError = error;
  state.failureCount += 1;
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
  const selectedProxy = pickProxy(sourceId);

  try {
    const response = await axios.request<T>({
      ...config,
      ...(selectedProxy ? { proxy: buildAxiosProxyConfig(selectedProxy) } : {}),
    });

    if (selectedProxy) {
      markProxySuccess(selectedProxy.id);
    }

    return response;
  } catch (error) {
    if (selectedProxy) {
      const reason = error instanceof Error ? error.message : String(error);
      markProxyFailure(selectedProxy.id, reason);
    }
    throw error;
  }
}

export function getProxyPoolSnapshot() {
  return parseProxyPool().map((entry) => {
    const state = getProxyState(entry.id);
    return {
      id: entry.id,
      host: entry.host,
      port: entry.port,
      enabled: entry.enabled,
      sources: entry.sources,
      failureCount: state.failureCount,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
      lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : undefined,
    };
  });
}
