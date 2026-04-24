const API_BASE = '/api';

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

export interface Stats {
  total: number;
  today: number;
  urgent: number;
  bySource: Record<string, number>;
}

export interface SourceHealthProbe {
  id: string;
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
  sourceQuality: Array<{
    source: string;
    total: number;
    unitCoverage: number;
    budgetCoverage: number;
    deadlineCoverage: number;
    contactCoverage: number;
    detailCoverage: number;
    avgCompleteness: number;
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
    lastError?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
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
  hotspotCheckQueue: {
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

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const healthApi = {
  get: () => request<HealthStatus>('/health')
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
    source?: string; 
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
