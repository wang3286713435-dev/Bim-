const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface AuthSession {
  authenticated: boolean;
  username: string | null;
  expiresAt?: string | null;
  sessionTtlHours?: number;
}

export interface Keyword {
  id: string;
  text: string;
  category: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { hotspots: number };
}

export interface Hotspot {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  sourceScope?: 'monitored' | 'legacy';
  sourceId: string | null;
  isReal: boolean;
  relevance: number;
  relevanceReason: string | null;
  keywordMentioned: boolean | null;
  importance: 'low' | 'medium' | 'high' | 'urgent';
  summary: string | null;
  viewCount: number | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  commentCount: number | null;
  quoteCount: number | null;
  danmakuCount: number | null;
  authorName: string | null;
  authorUsername: string | null;
  authorAvatar: string | null;
  authorFollowers: number | null;
  authorVerified: boolean | null;
  publishedAt: string | null;
  tenderType: string | null;
  tenderRegion: string | null;
  tenderCity: string | null;
  tenderUnit: string | null;
  tenderBudgetWan: number | null;
  tenderDeadline: string | null;
  tenderNoticeType: string | null;
  tenderStageCategory: 'formal_notice' | 'prequalification_notice' | 'procurement_intent' | 'tender_plan' | 'change_notice' | 'result_notice' | 'contract_notice' | 'unknown';
  tenderStageLabel: string | null;
  tenderStageBucket: 'actionable' | 'pre-signal' | 'change' | 'closed' | 'unknown';
  tenderActionable: boolean;
  tenderPlatform: string | null;
  tenderProjectCode: string | null;
  tenderContact: string | null;
  tenderPhone: string | null;
  tenderEmail: string | null;
  tenderBidOpenTime: string | null;
  tenderDocDeadline: string | null;
  tenderServiceScope: string | null;
  tenderQualification: string | null;
  tenderAddress: string | null;
  tenderDetailSource: string | null;
  tenderDetailExtractedAt: string | null;
  createdAt: string;
  keyword: { id: string; text: string; category: string | null } | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  content: string;
  isRead: boolean;
  hotspotId: string | null;
  createdAt: string;
}

export interface DailyKeyword {
  id: string;
  label: string;
  slug: string;
  aliases: string[];
  category: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface DailyMatchedKeyword {
  id: string;
  label: string;
  slug: string;
  category: string | null;
  count: number;
}

export interface DailyArticle {
  id: string;
  reportId: string;
  reportDate: string;
  sourceId: string;
  sourceName: string;
  sourceType: string | null;
  title: string;
  excerpt: string | null;
  summary: string | null;
  url: string;
  publishedAt: string | null;
  category: string | null;
  recencyBucket?: 'today' | 'recent' | 'watch';
  keywordHitPreview: string | null;
  matchedKeywords: DailyMatchedKeyword[];
}

export interface DailyReportSection {
  title: '政策与标准' | '行业观点与趋势' | '案例与应用' | '软件与产品动态' | '国际标准 / openBIM';
  summary: string;
  items: Array<{
    sourceId: string;
    sourceName: string;
    title: string;
    excerpt: string;
      summary: string;
      url: string;
      publishedAt: string | null;
      recencyBucket?: 'today' | 'recent' | 'watch';
      keywordHitPreview: string | null;
      matchedKeywords: Array<{
        keywordId: string;
      label: string;
      slug: string;
      category: string | null;
      count: number;
      matchedTexts: string[];
      hitFields: string[];
    }>;
  }>;
}

export interface DailyReport {
  id: string;
  reportDate: string;
  title: string;
  intro: string;
  executiveSummary: string;
  highlights: string[];
  recommendedActions: string[];
  sections: DailyReportSection[];
  meta: {
    candidateArticleCount: number;
    selectedArticleCount: number;
    freshArticleCount: number;
    supplementalArticleCount: number;
    sourceCount: number;
    editorialAngle?: string;
  };
  status: string;
  sourceCount: number;
  articleCount: number;
  keywordStats: Array<{
    keywordId: string;
    label: string;
    slug: string;
    category: string | null;
    count: number;
  }>;
  generatedAt: string;
  createdAt: string;
}

export interface DailyHealthStatus {
  latestRun: {
    id: string;
    triggerType: string;
    status: string;
    sourceCount: number;
    articleCount: number;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  latestReport: DailyReport | null;
  sources: Array<{
    id: string;
    name: string;
    homepage: string;
    listUrl: string;
    sourceType: string;
    isActive: boolean;
    status: 'healthy' | 'degraded' | 'unknown';
    resultCount: number;
    elapsedMs: number;
    errorMessage: string | null;
  }>;
  queue: {
    running: boolean;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastError?: string;
  };
}

export interface Stats {
  total: number;
  totalAll?: number;
  monitoredTotal?: number;
  legacyTotal?: number;
  today: number;
  urgent: number;
  bySource: Record<string, number>;
  legacyBySource?: Record<string, number>;
}

export interface SourceHealthProbe {
  id: string;
  name: string;
  enabled: boolean;
  ok: boolean;
  status?: 'disabled' | 'healthy' | 'empty' | 'request_failed' | 'waf_blocked' | 'circuit_open' | 'degraded';
  statusLabel?: string;
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

export interface CrawlRunProbe {
  id: string;
  runId: string;
  sourceId: string;
  sourceName: string;
  queryText: string | null;
  enabled: boolean;
  ok: boolean;
  resultCount: number;
  elapsedMs: number;
  sampleTitle: string | null;
  sampleUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface CrawlRun {
  id: string;
  triggerType: string;
  status: string;
  keywordText: string | null;
  keywordId: string | null;
  searchQueries: string | null;
  totalRaw: number;
  totalUnique: number;
  totalFresh: number;
  totalSaved: number;
  totalFiltered: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  sourceProbes?: CrawlRunProbe[];
}

export interface RuntimeConfig {
  tenderSources: string[];
  maxAgeDays: number;
  sourceResultLimit: number;
  resultsPerKeyword: number;
  queryVariantsPerKeyword: number;
  sourceRetryCount: number;
  sourceRetryDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  guangdongMaxPages: number;
  lowValueExcludeKeywords: string[];
  lowValueIncludeKeywords: string[];
  minRelevanceScore: number;
  strictKeywordMentionScore: number;
}

export interface SourceSetting {
  id: string;
  name: string;
  platform: string;
  homepage: string;
  priority: number;
  enabled: boolean;
  runtime: {
    failureCount: number;
    circuitOpen: boolean;
    cooldownRemainingMs: number;
    lastError?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
  };
}

export interface OpsSummary {
  stats: {
    totalHotspots: number;
    monitoredHotspots?: number;
    legacyHotspots?: number;
    totalHotspotsAll?: number;
    todayHotspots: number;
  };
  quality: {
    total: number;
    unitCount: number;
    budgetCount: number;
    deadlineCount: number;
    contactCount: number;
    phoneCount: number;
    detailCount: number;
    activeCount: number;
    expiredCount: number;
    highCompletenessCount: number;
    unitCoverage: number;
    budgetCoverage: number;
    deadlineCoverage: number;
    contactCoverage: number;
    phoneCoverage: number;
    detailCoverage: number;
    activeCoverage: number;
  };
  ai: {
    source?: 'logs' | 'hotspotReason';
    total: number;
    successCount: number;
    fallbackCount: number;
    errorCount?: number;
    successRate: number;
    fallbackRate: number;
    averageElapsedMs?: number;
    p95ElapsedMs?: number;
    latestAt?: string | null;
    providerStats?: Array<{
      provider: string;
      total: number;
      successCount: number;
      fallbackCount: number;
      averageElapsedMs: number;
    }>;
    fallbackReasons: Array<{ reason: string; count: number }>;
    recentFailures?: Array<{
      title: string | null;
      source: string | null;
      reason: string;
      elapsedMs: number;
      createdAt: string;
    }>;
  };
  sourceQuality: Array<{
    source: string;
    total: number;
    unitCoverage: number;
    budgetCoverage: number;
    deadlineCoverage: number;
    contactCoverage: number;
    phoneCoverage: number;
    serviceScopeCoverage: number;
    detailCoverage: number;
    detailSourceBreakdown: {
      missing: number;
      blocked: number;
      listOnly: number;
      deep: number;
      rules: number;
    };
    activeCount: number;
    expiredCount: number;
    highCompletenessCount: number;
    avgCompleteness: number;
    missingCounts: Record<string, number>;
    dirtyIssueCount: number;
    dirtyIssues: Array<{ issue: string; count: number }>;
    repairHints: string[];
    qualityScore: number;
    qualityGrade: 'no_sample' | 'good' | 'needs_enrichment' | 'poor';
  }>;
  sourceQualityTrend: Array<{
    source: string;
    score7d: number;
    score30d: number;
    delta: number;
    sample7d: number;
    sample30d: number;
    direction: 'up' | 'down' | 'flat';
  }>;
  sourceAcceptance: Array<{
    source: string;
    name: string;
    defaultSource: boolean;
    enabled: boolean;
    eligibleForProduction: boolean;
    passedCount: number;
    totalChecks: number;
    acceptanceScore: number;
    checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
    proxyPolicy: {
      dedicatedCount: number;
      fallbackCount: number;
      directFallbackEnabled: boolean;
      policy: 'source-specific' | 'default-pool' | 'direct-host';
    };
    deepCrawlStrategy: {
      mode: string;
      enabled: boolean;
      note: string;
    };
    nextAction: string;
  }>;
  sourceCandidatePool: Array<{
    category: string;
    priority: string;
    examples: string[];
    strategy: string;
  }>;
  runtimeConfig: RuntimeConfig;
  sourceHealth: SourceHealthProbe[];
  proxyPool?: Array<{
    id: string;
    host: string;
    port: number;
    enabled: boolean;
    sources: string[];
    failureCount: number;
    softFailureCount: number;
    consecutiveFailures: number;
    coolingDown: boolean;
    cooldownRemainingMs: number;
    lastError?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    probeOk: boolean;
    probeStatus: 'untested' | 'healthy' | 'tunnel_unreachable' | 'auth_required' | 'timeout' | 'gateway_502' | 'connection_reset' | 'upstream_blocked' | 'http_error' | 'request_failed';
    probeStatusLabel: string;
    probeUrl?: string;
    publicIp?: string;
    lastProbeAt?: string;
    lastProbeLatencyMs?: number;
    lastProbeError?: string;
    lastProbeStatusCode?: number;
    tunnelOk?: boolean;
    tunnelStatusLabel?: string;
    tunnelLatencyMs?: number;
    lastFailureCategory?: 'tunnel_unreachable' | 'auth_required' | 'timeout' | 'gateway_502' | 'connection_reset' | 'upstream_blocked' | 'http_error' | 'request_failed' | 'empty_result';
    lastFailureLabel?: string;
    lastFailureSeverity?: 'soft' | 'degraded' | 'hard';
    consecutiveFailureCategory?: 'tunnel_unreachable' | 'auth_required' | 'timeout' | 'gateway_502' | 'connection_reset' | 'upstream_blocked' | 'http_error' | 'request_failed' | 'empty_result';
    consecutiveFailureLabel?: string;
    consecutiveFailureSeverity?: 'soft' | 'degraded' | 'hard';
    consecutiveFailureStreak: number;
    alertThreshold: number;
    thresholdTriggered: boolean;
    thresholdTriggeredAt?: string;
    alertLevel: 'healthy' | 'warning' | 'critical';
    routingMode: 'preferred' | 'degraded' | 'cooldown';
    routingModeLabel: string;
  }>;
  proxyAlerts?: Array<{
    id: string;
    severity: 'healthy' | 'warning' | 'critical';
    label: string;
    category: string;
    detail: string;
    thresholdTriggered?: boolean;
    thresholdTriggeredAt?: string;
    consecutiveFailureStreak?: number;
    alertThreshold?: number;
  }>;
  recentRuns: CrawlRun[];
  latestRun: CrawlRun | null;
  failureSummary24h: Record<string, number>;
  probeFailureSummary24h: Record<string, number>;
  runFailureSummary24h: Record<string, number>;
  failureReasons24h: Record<string, Array<{ reason: string; count: number }>>;
}

export interface DetailEnrichmentStatusItem {
  id: string;
  title: string;
  completenessScore: number;
  tenderDetailExtractedAt: string | null;
}

export interface DetailEnrichmentStatus {
  queue: {
    running: boolean;
    pendingCount: number;
    processedCount: number;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastError?: string;
    currentHotspotId?: string;
    currentHotspotIds?: string[];
  };
  data: DetailEnrichmentStatusItem[];
}

export interface HealthStatus {
  status: string;
  version: string;
  mode: string;
  timestamp: string;
  integrations: {
    feishuWebhookEnabled: boolean;
    feishuBitableEnabled: boolean;
  };
  scheduler: {
    cron: string;
    intervalHours: number;
    description: string;
  };
  dailyReportScheduler?: {
    cron: string;
    description: string;
  };
  hotspotCheckQueue: {
    running: boolean;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastError?: string;
  };
  dailyReportQueue?: {
    running: boolean;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastError?: string;
  };
  detailEnrichmentQueue: {
    running: boolean;
    pendingCount: number;
    processedCount: number;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastError?: string;
    currentHotspotId?: string;
    currentHotspotIds?: string[];
  };
}

type RequestConfig = {
  suppressAuthEvent?: boolean;
};

async function request<T>(endpoint: string, options: RequestInit = {}, config: RequestConfig = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    const apiError = new ApiError(error.error || 'Request failed', response.status, error.code);
    if (response.status === 401 && !config.suppressAuthEvent && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:required'));
    }
    throw apiError;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const authApi = {
  getSession: () => request<AuthSession>('/auth/session', {}, { suppressAuthEvent: true }),

  login: (username: string, password: string) =>
    request<AuthSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    }, { suppressAuthEvent: true }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', {
      method: 'POST'
    }, { suppressAuthEvent: true })
};

export const healthApi = {
  get: () => request<HealthStatus>('/health')
};

export const dailyApi = {
  getToday: () => request<{ report: DailyReport | null; articles: DailyArticle[] }>('/daily/today'),

  getReports: (params?: {
    page?: number;
    limit?: number;
    source?: string;
    keyword?: string;
    dateFrom?: string;
    dateTo?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') searchParams.append(key, String(value));
      });
    }
    return request<{ data: DailyReport[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/daily/reports?${searchParams}`
    );
  },

  getReportById: (id: string) => request<DailyReport>(`/daily/reports/${id}`),

  getArticles: (params?: {
    page?: number;
    limit?: number;
    reportId?: string;
    reportDate?: string;
    source?: string;
    keyword?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') searchParams.append(key, String(value));
      });
    }
    return request<{ data: DailyArticle[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/daily/articles?${searchParams}`
    );
  },

  getKeywords: () => request<DailyKeyword[]>('/daily/keywords'),

  getHealth: () => request<DailyHealthStatus>('/daily/health'),

  run: () => request<{ accepted: boolean; message: string; state: DailyHealthStatus['queue'] }>('/daily/run', {
    method: 'POST'
  }),
};

// Keywords API
export const keywordsApi = {
  getAll: () => request<Keyword[]>('/keywords'),
  
  getById: (id: string) => request<Keyword>(`/keywords/${id}`),
  
  create: (data: { text: string; category?: string }) => 
    request<Keyword>('/keywords', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  update: (id: string, data: Partial<Keyword>) => 
    request<Keyword>(`/keywords/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  delete: (id: string) => 
    request<void>(`/keywords/${id}`, { method: 'DELETE' }),
  
  toggle: (id: string) => 
    request<Keyword>(`/keywords/${id}/toggle`, { method: 'PATCH' })
};

// Hotspots API
export const hotspotsApi = {
  getAll: (params?: { 
    page?: number; 
    limit?: number; 
    searchText?: string;
    searchMode?: 'title' | 'fulltext';
    includeExpired?: 'true' | 'false';
    scope?: 'monitored' | 'legacy' | 'all';
    source?: string; 
    tenderStage?: string;
    importance?: string; 
    keywordId?: string;
    isReal?: string;
    timeRange?: string;
    timeFrom?: string;
    timeTo?: string;
    tenderType?: string;
    tenderRegion?: string;
    tenderMinBudgetWan?: string | number;
    tenderMaxBudgetWan?: string | number;
    tenderDeadlineRange?: string;
    tenderDeadlineFrom?: string;
    tenderDeadlineTo?: string;
    tenderPlatform?: string;
    sortBy?: string;
    sortOrder?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') searchParams.append(key, String(value));
      });
    }
    return request<{ data: Hotspot[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/hotspots?${searchParams}`
    );
  },
  
  getStats: () => request<Stats>('/hotspots/stats'),

  getOpsSummary: () => request<OpsSummary>('/hotspots/ops/summary'),

  getRuns: (limit = 20) => request<{ data: CrawlRun[] }>(`/hotspots/runs?limit=${limit}`),
  
  getById: (id: string) => request<Hotspot>(`/hotspots/${id}`),
  
  search: (query: string, sources?: string[]) => 
    request<{ results: Hotspot[] }>('/hotspots/search', {
      method: 'POST',
      body: JSON.stringify({ query, sources })
    }),

  getDetailEnrichmentStatus: () => request<DetailEnrichmentStatus>('/hotspots/detail-enrichment/status'),

  runDetailEnrichment: (limit = 20) =>
    request<{ queued: number; queue: DetailEnrichmentStatus['queue'] }>('/hotspots/detail-enrichment/run', {
      method: 'POST',
      body: JSON.stringify({ limit })
    }),

  notifyFeishu: (id: string) =>
    request<{ webhook: boolean }>(`/hotspots/${id}/notify-feishu`, {
      method: 'POST'
    }),
  
  delete: (id: string) => 
    request<void>(`/hotspots/${id}`, { method: 'DELETE' })
};

// Notifications API
export const notificationsApi = {
  getAll: (params?: { page?: number; limit?: number; unreadOnly?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) searchParams.append(key, String(value));
      });
    }
    return request<{ data: Notification[]; unreadCount: number; pagination: any }>(
      `/notifications?${searchParams}`
    );
  },
  
  markAsRead: (id: string) => 
    request<Notification>(`/notifications/${id}/read`, { method: 'PATCH' }),
  
  markAllAsRead: () => 
    request<void>('/notifications/read-all', { method: 'PATCH' }),
  
  delete: (id: string) => 
    request<void>(`/notifications/${id}`, { method: 'DELETE' }),
  
  clear: () => 
    request<void>('/notifications', { method: 'DELETE' })
};

// Settings API
export const settingsApi = {
  getAll: () => request<Record<string, string>>('/settings'),

  getRuntime: () => request<RuntimeConfig>('/settings/runtime'),

  updateRuntime: (settings: Partial<RuntimeConfig>) =>
    request<{ message: string; config: RuntimeConfig }>('/settings/runtime', {
      method: 'PUT',
      body: JSON.stringify(settings)
    }),

  getSources: () => request<{ data: SourceSetting[] }>('/settings/sources'),

  updateSources: (sources: string[]) =>
    request<{ message: string; tenderSources: string[] }>('/settings/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources })
    }),
  
  update: (settings: Record<string, string>) => 
    request<void>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    })
};

// Manual trigger
export const triggerHotspotCheck = () => 
  request<{ message: string }>('/check-hotspots', { method: 'POST' });
