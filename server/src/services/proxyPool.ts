import { createConnection } from 'node:net';
import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
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
  lastFailureCategory?: ProxyFailureCategory;
  lastFailureLabel?: string;
  lastFailureSeverity?: ProxyFailureSeverity;
  consecutiveFailureCategory?: ProxyFailureCategory;
  consecutiveFailureLabel?: string;
  consecutiveFailureSeverity?: ProxyFailureSeverity;
  failureCount: number;
  softFailureCount: number;
  consecutiveFailures: number;
  consecutiveFailureStreak: number;
  thresholdTriggeredAt?: number;
  cooldownUntil?: number;
};

type ProxyProbeStatus =
  | 'untested'
  | 'healthy'
  | 'tunnel_unreachable'
  | 'auth_required'
  | 'timeout'
  | 'gateway_502'
  | 'connection_reset'
  | 'upstream_blocked'
  | 'http_error'
  | 'request_failed';

type ProxyFailureCategory = Exclude<ProxyProbeStatus, 'untested' | 'healthy'> | 'empty_result';
type ProxyFailureSeverity = 'soft' | 'degraded' | 'hard';

type ProxyProbeState = {
  probeOk: boolean;
  probeStatus: ProxyProbeStatus;
  probeStatusLabel: string;
  probeUrl?: string;
  publicIp?: string;
  lastProbeAt?: number;
  lastProbeLatencyMs?: number;
  lastProbeError?: string;
  lastProbeStatusCode?: number;
  tunnelOk?: boolean;
  tunnelStatusLabel?: string;
  tunnelLatencyMs?: number;
};

const proxyRuntime = new Map<string, ProxyRuntimeState>();
const proxyProbeRuntime = new Map<string, ProxyProbeState>();
let proxyProbeRefreshPromise: Promise<void> | null = null;
let lastProxyProbeRefreshAt = 0;

function getProxyFailureThreshold(): number {
  return Math.max(1, Number.parseInt(process.env.TENDER_PROXY_FAILURE_THRESHOLD || '2', 10) || 2);
}

function getProxyAlertThreshold(): number {
  return Math.max(getProxyFailureThreshold(), Number.parseInt(process.env.TENDER_PROXY_ALERT_THRESHOLD || '3', 10) || 3);
}

function getProxyFailureCooldownMs(): number {
  return Math.max(5000, Number.parseInt(process.env.TENDER_PROXY_FAILURE_COOLDOWN_MS || '300000', 10) || 300000);
}

function getProxyProbeCacheTtlMs(): number {
  return Math.max(15000, Number.parseInt(process.env.TENDER_PROXY_PROBE_CACHE_TTL_MS || '60000', 10) || 60000);
}

export function getProxyHealthRefreshIntervalMs(): number {
  return Math.max(30000, Number.parseInt(process.env.TENDER_PROXY_HEALTH_INTERVAL_MS || '120000', 10) || 120000);
}

function getProxyProbeTimeoutMs(): number {
  return Math.max(2000, Number.parseInt(process.env.TENDER_PROXY_PROBE_TIMEOUT_MS || '8000', 10) || 8000);
}

function getProxyTunnelTimeoutMs(): number {
  return Math.max(500, Number.parseInt(process.env.TENDER_PROXY_TUNNEL_TIMEOUT_MS || '1500', 10) || 1500);
}

function getProxyProbeUrl(): string {
  return process.env.TENDER_PROXY_PROBE_URL?.trim() || 'https://httpbin.org/ip';
}

function isThresholdTriggered(state: ProxyRuntimeState): boolean {
  return state.consecutiveFailureStreak >= getProxyAlertThreshold();
}

function getProxyAlertLevel(status: ProxyProbeStatus, coolingDown: boolean, thresholdTriggered: boolean): 'healthy' | 'warning' | 'critical' {
  if (coolingDown || thresholdTriggered || status === 'tunnel_unreachable' || status === 'auth_required') return 'critical';
  if (status === 'healthy') return 'healthy';
  return 'warning';
}

function getRoutingMode(status: ProxyProbeStatus, coolingDown: boolean): { mode: 'preferred' | 'degraded' | 'cooldown'; label: string } {
  if (coolingDown) return { mode: 'cooldown', label: '冷却跳过' };
  if (status === 'healthy' || status === 'untested') return { mode: 'preferred', label: '优先使用' };
  return { mode: 'degraded', label: '自动降级' };
}

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
                item === 'default' || ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'].includes(String(item))
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
    softFailureCount: 0,
    consecutiveFailures: 0,
    consecutiveFailureStreak: 0,
  };
  proxyRuntime.set(id, initial);
  return initial;
}

function getProxyProbeState(id: string): ProxyProbeState {
  const existing = proxyProbeRuntime.get(id);
  if (existing) return existing;
  const initial: ProxyProbeState = {
    probeOk: false,
    probeStatus: 'untested',
    probeStatusLabel: '待探测',
  };
  proxyProbeRuntime.set(id, initial);
  return initial;
}

export function hasEnabledProxyPool(): boolean {
  return parseProxyPool().length > 0;
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
  const probeA = getProxyProbeState(a.id);
  const probeB = getProxyProbeState(b.id);
  const coolingA = isCoolingDown(stateA);
  const coolingB = isCoolingDown(stateB);
  const probeRankA = probeA.probeStatus === 'healthy' ? 0 : probeA.probeStatus === 'untested' ? 1 : 2;
  const probeRankB = probeB.probeStatus === 'healthy' ? 0 : probeB.probeStatus === 'untested' ? 1 : 2;

  if (coolingA !== coolingB) return coolingA ? 1 : -1;
  if (probeRankA !== probeRankB) return probeRankA - probeRankB;
  if (probeRankA === 0 && probeRankB === 0 && probeA.lastProbeLatencyMs !== probeB.lastProbeLatencyMs) {
    return (probeA.lastProbeLatencyMs ?? Number.POSITIVE_INFINITY) - (probeB.lastProbeLatencyMs ?? Number.POSITIVE_INFINITY);
  }
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
  const preferred = healthyFirst.filter((entry) => {
    if (isCoolingDown(getProxyState(entry.id))) return false;
    const probeStatus = getProxyProbeState(entry.id).probeStatus;
    return probeStatus === 'healthy' || probeStatus === 'untested';
  });
  const degraded = healthyFirst.filter((entry) => {
    if (isCoolingDown(getProxyState(entry.id))) return false;
    const probeStatus = getProxyProbeState(entry.id).probeStatus;
    return probeStatus !== 'healthy' && probeStatus !== 'untested';
  });
  const cooling = healthyFirst.filter((entry) => isCoolingDown(getProxyState(entry.id)));
  const sequence: Array<ProxyPoolEntry | null> = [
    ...preferred,
    ...(allowDirectFallback ? [null] : []),
    ...degraded,
    ...cooling,
  ];

  return sequence.length > 0 ? sequence : [null];
}

function markProxySuccess(proxyId: string): void {
  const state = getProxyState(proxyId);
  state.lastSuccessAt = Date.now();
  state.lastError = undefined;
  state.consecutiveFailures = 0;
  state.consecutiveFailureStreak = 0;
  state.consecutiveFailureCategory = undefined;
  state.consecutiveFailureLabel = undefined;
  state.consecutiveFailureSeverity = undefined;
  state.thresholdTriggeredAt = undefined;
  state.cooldownUntil = undefined;
}

function recordProxyFailure(proxyId: string, error: unknown, mode: ProxyFailureSeverity = 'hard'): void {
  const state = getProxyState(proxyId);
  const classified = classifyProxyFailure(error, mode);
  state.lastFailureAt = Date.now();
  state.lastError = classified.message;
  state.lastFailureCategory = classified.category;
  state.lastFailureLabel = classified.label;
  state.lastFailureSeverity = classified.severity;

  if (!classified.countFailure) {
    state.softFailureCount += 1;
    return;
  }

  state.failureCount += 1;
  state.consecutiveFailures += Math.max(1, classified.penalty);
  if (state.consecutiveFailureCategory === classified.category) {
    state.consecutiveFailureStreak += Math.max(1, classified.penalty);
  } else {
    state.consecutiveFailureCategory = classified.category;
    state.consecutiveFailureLabel = classified.label;
    state.consecutiveFailureSeverity = classified.severity;
    state.consecutiveFailureStreak = Math.max(1, classified.penalty);
    state.thresholdTriggeredAt = undefined;
  }

  const thresholdTriggered = state.consecutiveFailureStreak >= getProxyAlertThreshold();
  if (thresholdTriggered && !state.thresholdTriggeredAt) {
    state.thresholdTriggeredAt = Date.now();
  }

  if (classified.immediateCooldown || state.consecutiveFailures >= getProxyFailureThreshold() || thresholdTriggered) {
    state.cooldownUntil = Date.now() + (classified.cooldownMs ?? getProxyFailureCooldownMs());
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

function classifyProxyFailure(error: unknown, mode: ProxyFailureSeverity = 'hard'): {
  category: ProxyFailureCategory;
  label: string;
  severity: ProxyFailureSeverity;
  penalty: number;
  cooldownMs?: number;
  immediateCooldown?: boolean;
  message: string;
  statusCode?: number;
  countFailure: boolean;
} {
  const defaultCooldownMs = getProxyFailureCooldownMs();

  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const message = error.message || (status ? `HTTP ${status}` : 'proxy request failed');

    if (status === 407) {
      return {
        category: 'auth_required',
        label: '代理认证失败',
        severity: 'hard',
        penalty: 1,
        cooldownMs: defaultCooldownMs * 2,
        immediateCooldown: true,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    if (status === 502) {
      return {
        category: 'gateway_502',
        label: '502 网关异常',
        severity: 'degraded',
        penalty: 1,
        cooldownMs: defaultCooldownMs,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    if (status === 403 || status === 405) {
      return {
        category: 'upstream_blocked',
        label: '目标站阻断',
        severity: 'soft',
        penalty: 0,
        message,
        statusCode: status,
        countFailure: mode !== 'soft'
      };
    }

    if (status && status >= 500) {
      return {
        category: 'http_error',
        label: `HTTP ${status}`,
        severity: 'degraded',
        penalty: 1,
        cooldownMs: defaultCooldownMs,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    if (error.code === 'ECONNABORTED' || /timeout|timed out/i.test(message)) {
      return {
        category: 'timeout',
        label: '请求超时',
        severity: 'degraded',
        penalty: 1,
        cooldownMs: defaultCooldownMs,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    if (['ECONNRESET', 'EPIPE'].includes(error.code ?? '') || /socket hang up|ECONNRESET/i.test(message)) {
      return {
        category: 'connection_reset',
        label: '连接被重置',
        severity: 'degraded',
        penalty: 1,
        cooldownMs: defaultCooldownMs,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(error.code ?? '')) {
      return {
        category: 'tunnel_unreachable',
        label: '隧道断开',
        severity: 'hard',
        penalty: 1,
        cooldownMs: defaultCooldownMs * 2,
        immediateCooldown: true,
        message,
        statusCode: status,
        countFailure: true
      };
    }

    return {
      category: 'request_failed',
      label: '出口请求失败',
      severity: mode,
      penalty: mode === 'soft' ? 0 : 1,
      cooldownMs: mode === 'soft' ? undefined : defaultCooldownMs,
      message,
      statusCode: status,
      countFailure: mode !== 'soft'
    };
  }

  const message = error instanceof Error ? error.message : String(error || 'proxy request failed');
  const lower = message.toLowerCase();

  if (/gzeb empty result|empty result|probe empty|空结果/.test(lower)) {
    return {
      category: 'empty_result',
      label: '空结果',
      severity: 'soft',
      penalty: 0,
      message,
      countFailure: false
    };
  }

  if (/403|405|forbidden|waf|blocked|challenge|验证码|安全验证|被阻断/.test(lower)) {
    return {
      category: 'upstream_blocked',
      label: '目标站阻断',
      severity: 'soft',
      penalty: 0,
      message,
      countFailure: false
    };
  }

  if (/502|bad gateway/.test(lower)) {
    return {
      category: 'gateway_502',
      label: '502 网关异常',
      severity: 'degraded',
      penalty: 1,
      cooldownMs: defaultCooldownMs,
      message,
      countFailure: true
    };
  }

  if (/timeout|timed out|etimedout|econnaborted/.test(lower)) {
    return {
      category: 'timeout',
      label: '请求超时',
      severity: 'degraded',
      penalty: 1,
      cooldownMs: defaultCooldownMs,
      message,
      countFailure: true
    };
  }

  if (/socket hang up|econnreset|epipe/.test(lower)) {
    return {
      category: 'connection_reset',
      label: '连接被重置',
      severity: 'degraded',
      penalty: 1,
      cooldownMs: defaultCooldownMs,
      message,
      countFailure: true
    };
  }

  if (/tunnel timeout|econnrefused|ehostunreach|enetunreach|cannot listen to port|address already in use|隧道/.test(lower)) {
    return {
      category: 'tunnel_unreachable',
      label: '隧道断开',
      severity: 'hard',
      penalty: 1,
      cooldownMs: defaultCooldownMs * 2,
      immediateCooldown: true,
      message,
      countFailure: true
    };
  }

  if (/407|proxy authentication/.test(lower)) {
    return {
      category: 'auth_required',
      label: '代理认证失败',
      severity: 'hard',
      penalty: 1,
      cooldownMs: defaultCooldownMs * 2,
      immediateCooldown: true,
      message,
      countFailure: true
    };
  }

  return {
    category: 'request_failed',
    label: '出口请求失败',
    severity: mode,
    penalty: mode === 'soft' ? 0 : 1,
    cooldownMs: mode === 'soft' ? undefined : defaultCooldownMs,
    message,
    countFailure: mode !== 'soft'
  };
}

function extractPublicIp(data: unknown): string | undefined {
  if (!data) return undefined;
  if (typeof data === 'string') {
    const match = data.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    return match?.[0];
  }
  if (typeof data === 'object') {
    const candidate = data as { origin?: unknown; ip?: unknown };
    if (typeof candidate.origin === 'string' && candidate.origin.trim()) {
      return candidate.origin.split(',')[0]?.trim() || undefined;
    }
    if (typeof candidate.ip === 'string' && candidate.ip.trim()) {
      return candidate.ip.trim();
    }
  }
  return undefined;
}

async function probeProxyTunnel(proxy: ProxyPoolEntry): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = createConnection({
      host: proxy.host,
      port: proxy.port,
    });
    let settled = false;

    const finish = (result: { ok: boolean; latencyMs: number; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(getProxyTunnelTimeoutMs());
    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - startedAt }));
    socket.once('timeout', () => finish({ ok: false, latencyMs: Date.now() - startedAt, error: 'tunnel timeout' }));
    socket.once('error', (error) => finish({
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: 'code' in error && typeof error.code === 'string' ? error.code : error.message
    }));
  });
}

async function probeSingleProxy(proxy: ProxyPoolEntry): Promise<void> {
  const probeUrl = getProxyProbeUrl();
  const runtime = getProxyProbeState(proxy.id);
  const tunnel = await probeProxyTunnel(proxy);

  runtime.probeUrl = probeUrl;
  runtime.lastProbeAt = Date.now();
  runtime.tunnelOk = tunnel.ok;
  runtime.tunnelLatencyMs = tunnel.latencyMs;
  runtime.tunnelStatusLabel = tunnel.ok ? '本地隧道可达' : '本地隧道不可达';

  if (!tunnel.ok) {
    runtime.probeOk = false;
    runtime.probeStatus = 'tunnel_unreachable';
    runtime.probeStatusLabel = '隧道断开';
    runtime.lastProbeLatencyMs = tunnel.latencyMs;
    runtime.lastProbeError = tunnel.error;
    runtime.lastProbeStatusCode = undefined;
    runtime.publicIp = undefined;
    return;
  }

  const startedAt = Date.now();
  try {
    const response = await axios.get(probeUrl, {
      timeout: getProxyProbeTimeoutMs(),
      proxy: buildAxiosProxyConfig(proxy),
      validateStatus: () => true,
    });
    runtime.lastProbeLatencyMs = Date.now() - startedAt;
    runtime.lastProbeStatusCode = response.status;
    runtime.publicIp = extractPublicIp(response.data);

    if (response.status >= 200 && response.status < 300) {
      runtime.probeOk = true;
      runtime.probeStatus = 'healthy';
      runtime.probeStatusLabel = '出口正常';
      runtime.lastProbeError = undefined;
      return;
    }

    if (response.status === 407) {
      runtime.probeOk = false;
      runtime.probeStatus = 'auth_required';
      runtime.probeStatusLabel = '代理认证失败';
      runtime.lastProbeError = `HTTP ${response.status}`;
      return;
    }

    if (response.status === 502) {
      runtime.probeOk = false;
      runtime.probeStatus = 'gateway_502';
      runtime.probeStatusLabel = '502 网关异常';
      runtime.lastProbeError = `HTTP ${response.status}`;
      return;
    }

    if (response.status === 403 || response.status === 405) {
      runtime.probeOk = false;
      runtime.probeStatus = 'upstream_blocked';
      runtime.probeStatusLabel = '目标站阻断';
      runtime.lastProbeError = `HTTP ${response.status}`;
      return;
    }

    runtime.probeOk = false;
    runtime.probeStatus = 'http_error';
    runtime.probeStatusLabel = '出口异常';
    runtime.lastProbeError = `HTTP ${response.status}`;
  } catch (error) {
    const classified = classifyProxyFailure(error, 'hard');
    runtime.lastProbeLatencyMs = Date.now() - startedAt;
    runtime.lastProbeStatusCode = classified.statusCode;
    runtime.publicIp = undefined;
    runtime.probeOk = false;
    runtime.probeStatus = classified.category === 'empty_result' ? 'request_failed' : classified.category;
    runtime.probeStatusLabel = classified.label;
    runtime.lastProbeError = classified.message;
  }
}

export async function refreshProxyPoolHealth(force = false): Promise<void> {
  const pool = parseProxyPool();
  if (pool.length === 0) return;

  if (!force && proxyProbeRefreshPromise) {
    await proxyProbeRefreshPromise;
    return;
  }

  if (!force && Date.now() - lastProxyProbeRefreshAt < getProxyProbeCacheTtlMs()) {
    return;
  }

  proxyProbeRefreshPromise = (async () => {
    await Promise.all(pool.map((entry) => probeSingleProxy(entry)));
    lastProxyProbeRefreshAt = Date.now();
  })().finally(() => {
    proxyProbeRefreshPromise = null;
  });

  await proxyProbeRefreshPromise;
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
          recordProxyFailure(selectedProxy.id, error, 'hard');
        }
      }
    }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function markProxySoftFailure(proxyId: string | undefined, error: string): void {
  if (!proxyId) return;
  recordProxyFailure(proxyId, error, 'soft');
}

export function getProxyPoolSnapshot() {
  return parseProxyPool().sort(compareProxyHealth).map((entry) => {
    const state = getProxyState(entry.id);
    const probeState = getProxyProbeState(entry.id);
    const coolingDown = isCoolingDown(state);
    const thresholdTriggered = isThresholdTriggered(state);
    const alertLevel = getProxyAlertLevel(probeState.probeStatus, coolingDown, thresholdTriggered);
    const routing = getRoutingMode(probeState.probeStatus, coolingDown);
    return {
      id: entry.id,
      host: entry.host,
      port: entry.port,
      enabled: entry.enabled,
      sources: entry.sources,
      failureCount: state.failureCount,
      softFailureCount: state.softFailureCount,
      consecutiveFailures: state.consecutiveFailures,
      coolingDown,
      cooldownRemainingMs: coolingDown && state.cooldownUntil ? Math.max(0, state.cooldownUntil - Date.now()) : 0,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
      lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : undefined,
      lastFailureCategory: state.lastFailureCategory,
      lastFailureLabel: state.lastFailureLabel,
      lastFailureSeverity: state.lastFailureSeverity,
      consecutiveFailureCategory: state.consecutiveFailureCategory,
      consecutiveFailureLabel: state.consecutiveFailureLabel,
      consecutiveFailureSeverity: state.consecutiveFailureSeverity,
      consecutiveFailureStreak: state.consecutiveFailureStreak,
      alertThreshold: getProxyAlertThreshold(),
      thresholdTriggered,
      thresholdTriggeredAt: state.thresholdTriggeredAt ? new Date(state.thresholdTriggeredAt).toISOString() : undefined,
      probeOk: probeState.probeOk,
      probeStatus: probeState.probeStatus,
      probeStatusLabel: probeState.probeStatusLabel,
      probeUrl: probeState.probeUrl,
      publicIp: probeState.publicIp,
      lastProbeAt: probeState.lastProbeAt ? new Date(probeState.lastProbeAt).toISOString() : undefined,
      lastProbeLatencyMs: probeState.lastProbeLatencyMs,
      lastProbeError: probeState.lastProbeError,
      lastProbeStatusCode: probeState.lastProbeStatusCode,
      tunnelOk: probeState.tunnelOk,
      tunnelStatusLabel: probeState.tunnelStatusLabel,
      tunnelLatencyMs: probeState.tunnelLatencyMs,
      alertLevel,
      routingMode: routing.mode,
      routingModeLabel: routing.label,
    };
  });
}
