import { prisma } from '../db.js';

export type TenderSourceId = 'szggzy' | 'szygcgpt' | 'guangdong' | 'gzebpubservice' | 'ccgp' | 'ggzyNational' | 'cebpubservice';
export const DEFAULT_TENDER_SOURCE_IDS: TenderSourceId[] = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'];
export const TENDER_SOURCE_IDS: TenderSourceId[] = [...DEFAULT_TENDER_SOURCE_IDS];
const LEGACY_DEFAULT_TENDER_SOURCE_IDS: TenderSourceId[] = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice'];

export type RuntimeConfig = {
  tenderSources: TenderSourceId[];
  maxAgeDays: number;
  sourceResultLimit: number;
  resultsPerKeyword: number;
  queryVariantsPerKeyword: number;
  keywordCooldownZeroSaveThreshold: number;
  keywordCooldownHours: number;
  keywordCooldownLookbackDays: number;
  sourceRetryCount: number;
  sourceRetryDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  guangdongMaxPages: number;
  lowValueExcludeKeywords: string[];
  lowValueIncludeKeywords: string[];
  minRelevanceScore: number;
  strictKeywordMentionScore: number;
};

export const RUNTIME_SETTING_KEYS = [
  'TENDER_SOURCES',
  'TENDER_MAX_AGE_DAYS',
  'TENDER_SOURCE_RESULT_LIMIT',
  'TENDER_RESULTS_PER_KEYWORD',
  'TENDER_QUERY_VARIANTS_PER_KEYWORD',
  'TENDER_KEYWORD_COOLDOWN_ZERO_SAVE_THRESHOLD',
  'TENDER_KEYWORD_COOLDOWN_HOURS',
  'TENDER_KEYWORD_COOLDOWN_LOOKBACK_DAYS',
  'TENDER_SOURCE_RETRY_COUNT',
  'TENDER_SOURCE_RETRY_DELAY_MS',
  'TENDER_SOURCE_CIRCUIT_BREAKER_THRESHOLD',
  'TENDER_SOURCE_CIRCUIT_BREAKER_COOLDOWN_MS',
  'GUANGDONG_MAX_PAGES',
  'LOW_VALUE_EXCLUDE_KEYWORDS',
  'LOW_VALUE_INCLUDE_KEYWORDS',
  'MIN_RELEVANCE_SCORE',
  'STRICT_KEYWORD_MENTION_SCORE'
] as const;

const CONFIG_CACHE_TTL_MS = 15000;
let configCache: { value: RuntimeConfig; expiresAt: number } | null = null;

function parseCsv(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseIntSafe(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeTenderSourceIds(sources: TenderSourceId[]): TenderSourceId[] {
  return [...new Set(sources.filter(source => TENDER_SOURCE_IDS.includes(source)))];
}

function shouldUpgradeLegacyDefaultSources(sources: TenderSourceId[]): boolean {
  const normalized = normalizeTenderSourceIds(sources);
  return normalized.length === LEGACY_DEFAULT_TENDER_SOURCE_IDS.length
    && normalized.every((source, index) => source === LEGACY_DEFAULT_TENDER_SOURCE_IDS[index]);
}

function upgradeLegacyDefaultSources(sources: TenderSourceId[]): TenderSourceId[] {
  return shouldUpgradeLegacyDefaultSources(sources)
    ? [...DEFAULT_TENDER_SOURCE_IDS]
    : normalizeTenderSourceIds(sources);
}

export function buildDefaultRuntimeConfig(): RuntimeConfig {
  const configuredSources = parseCsv(process.env.TENDER_SOURCES).filter(source => TENDER_SOURCE_IDS.includes(source as TenderSourceId)) as TenderSourceId[];
  return normalizeRuntimeConfig({
    tenderSources: configuredSources.length ? upgradeLegacyDefaultSources(configuredSources) : DEFAULT_TENDER_SOURCE_IDS,
    maxAgeDays: parseIntSafe(process.env.TENDER_MAX_AGE_DAYS, 365),
    sourceResultLimit: parseIntSafe(process.env.TENDER_SOURCE_RESULT_LIMIT, 8),
    resultsPerKeyword: parseIntSafe(process.env.TENDER_RESULTS_PER_KEYWORD, 8),
    queryVariantsPerKeyword: parseIntSafe(process.env.TENDER_QUERY_VARIANTS_PER_KEYWORD, 2),
    keywordCooldownZeroSaveThreshold: parseIntSafe(process.env.TENDER_KEYWORD_COOLDOWN_ZERO_SAVE_THRESHOLD, 4),
    keywordCooldownHours: parseIntSafe(process.env.TENDER_KEYWORD_COOLDOWN_HOURS, 24),
    keywordCooldownLookbackDays: parseIntSafe(process.env.TENDER_KEYWORD_COOLDOWN_LOOKBACK_DAYS, 14),
    sourceRetryCount: parseIntSafe(process.env.TENDER_SOURCE_RETRY_COUNT, 2),
    sourceRetryDelayMs: parseIntSafe(process.env.TENDER_SOURCE_RETRY_DELAY_MS, 1200),
    circuitBreakerThreshold: parseIntSafe(process.env.TENDER_SOURCE_CIRCUIT_BREAKER_THRESHOLD, 3),
    circuitBreakerCooldownMs: parseIntSafe(process.env.TENDER_SOURCE_CIRCUIT_BREAKER_COOLDOWN_MS, 300000),
    guangdongMaxPages: parseIntSafe(process.env.GUANGDONG_MAX_PAGES, 2),
    lowValueExcludeKeywords: parseCsv(process.env.LOW_VALUE_EXCLUDE_KEYWORDS || '中标结果,成交结果,候选人公示,合同公告,失败,终止,流标,废标,投诉,质疑'),
    lowValueIncludeKeywords: parseCsv(process.env.LOW_VALUE_INCLUDE_KEYWORDS || 'BIM,建筑信息模型,智慧建造,CIM,数字孪生,装配式建筑,工程总承包,EPC,全过程工程咨询,施工模拟,竣工模型交付,管线综合,智慧运维'),
    minRelevanceScore: parseIntSafe(process.env.MIN_RELEVANCE_SCORE, 50),
    strictKeywordMentionScore: parseIntSafe(process.env.STRICT_KEYWORD_MENTION_SCORE, 65)
  });
}

export function normalizeRuntimeConfig(input: Partial<RuntimeConfig>): RuntimeConfig {
  const defaults = {
    tenderSources: [...DEFAULT_TENDER_SOURCE_IDS],
    maxAgeDays: 365,
    sourceResultLimit: 8,
    resultsPerKeyword: 8,
    queryVariantsPerKeyword: 2,
    keywordCooldownZeroSaveThreshold: 4,
    keywordCooldownHours: 24,
    keywordCooldownLookbackDays: 14,
    sourceRetryCount: 2,
    sourceRetryDelayMs: 1200,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 300000,
    guangdongMaxPages: 2,
    lowValueExcludeKeywords: ['中标结果', '成交结果', '候选人公示', '合同公告', '失败', '终止', '流标', '废标', '投诉', '质疑'],
    lowValueIncludeKeywords: ['BIM', '建筑信息模型', '智慧建造', 'CIM', '数字孪生', '装配式建筑', '工程总承包', 'EPC', '全过程工程咨询', '施工模拟', '竣工模型交付', '管线综合', '智慧运维'],
    minRelevanceScore: 50,
    strictKeywordMentionScore: 65
  } satisfies RuntimeConfig;

  const tenderSources = normalizeTenderSourceIds((input.tenderSources ?? defaults.tenderSources) as TenderSourceId[]);

  return {
    tenderSources: tenderSources.length ? [...new Set(tenderSources)] : defaults.tenderSources,
    maxAgeDays: clampInteger(input.maxAgeDays ?? defaults.maxAgeDays, 1, 3650),
    sourceResultLimit: clampInteger(input.sourceResultLimit ?? defaults.sourceResultLimit, 1, 50),
    resultsPerKeyword: clampInteger(input.resultsPerKeyword ?? defaults.resultsPerKeyword, 1, 50),
    queryVariantsPerKeyword: clampInteger(input.queryVariantsPerKeyword ?? defaults.queryVariantsPerKeyword, 1, 10),
    keywordCooldownZeroSaveThreshold: clampInteger(input.keywordCooldownZeroSaveThreshold ?? defaults.keywordCooldownZeroSaveThreshold, 0, 30),
    keywordCooldownHours: clampInteger(input.keywordCooldownHours ?? defaults.keywordCooldownHours, 0, 720),
    keywordCooldownLookbackDays: clampInteger(input.keywordCooldownLookbackDays ?? defaults.keywordCooldownLookbackDays, 1, 90),
    sourceRetryCount: clampInteger(input.sourceRetryCount ?? defaults.sourceRetryCount, 0, 5),
    sourceRetryDelayMs: clampInteger(input.sourceRetryDelayMs ?? defaults.sourceRetryDelayMs, 0, 60000),
    circuitBreakerThreshold: clampInteger(input.circuitBreakerThreshold ?? defaults.circuitBreakerThreshold, 1, 20),
    circuitBreakerCooldownMs: clampInteger(input.circuitBreakerCooldownMs ?? defaults.circuitBreakerCooldownMs, 5000, 3600000),
    guangdongMaxPages: clampInteger(input.guangdongMaxPages ?? defaults.guangdongMaxPages, 1, 10),
    lowValueExcludeKeywords: (input.lowValueExcludeKeywords ?? defaults.lowValueExcludeKeywords).map(item => item.trim()).filter(Boolean),
    lowValueIncludeKeywords: (input.lowValueIncludeKeywords ?? defaults.lowValueIncludeKeywords).map(item => item.trim()).filter(Boolean),
    minRelevanceScore: clampInteger(input.minRelevanceScore ?? defaults.minRelevanceScore, 0, 100),
    strictKeywordMentionScore: clampInteger(input.strictKeywordMentionScore ?? defaults.strictKeywordMentionScore, 0, 100)
  };
}

export function runtimeConfigToSettings(config: RuntimeConfig): Record<string, string> {
  const normalized = normalizeRuntimeConfig(config);
  return {
    TENDER_SOURCES: normalized.tenderSources.join(','),
    TENDER_MAX_AGE_DAYS: String(normalized.maxAgeDays),
    TENDER_SOURCE_RESULT_LIMIT: String(normalized.sourceResultLimit),
    TENDER_RESULTS_PER_KEYWORD: String(normalized.resultsPerKeyword),
    TENDER_QUERY_VARIANTS_PER_KEYWORD: String(normalized.queryVariantsPerKeyword),
    TENDER_KEYWORD_COOLDOWN_ZERO_SAVE_THRESHOLD: String(normalized.keywordCooldownZeroSaveThreshold),
    TENDER_KEYWORD_COOLDOWN_HOURS: String(normalized.keywordCooldownHours),
    TENDER_KEYWORD_COOLDOWN_LOOKBACK_DAYS: String(normalized.keywordCooldownLookbackDays),
    TENDER_SOURCE_RETRY_COUNT: String(normalized.sourceRetryCount),
    TENDER_SOURCE_RETRY_DELAY_MS: String(normalized.sourceRetryDelayMs),
    TENDER_SOURCE_CIRCUIT_BREAKER_THRESHOLD: String(normalized.circuitBreakerThreshold),
    TENDER_SOURCE_CIRCUIT_BREAKER_COOLDOWN_MS: String(normalized.circuitBreakerCooldownMs),
    GUANGDONG_MAX_PAGES: String(normalized.guangdongMaxPages),
    LOW_VALUE_EXCLUDE_KEYWORDS: normalized.lowValueExcludeKeywords.join(','),
    LOW_VALUE_INCLUDE_KEYWORDS: normalized.lowValueIncludeKeywords.join(','),
    MIN_RELEVANCE_SCORE: String(normalized.minRelevanceScore),
    STRICT_KEYWORD_MENTION_SCORE: String(normalized.strictKeywordMentionScore)
  };
}

export async function getRuntimeConfig(forceRefresh = false): Promise<RuntimeConfig> {
  if (!forceRefresh && configCache && configCache.expiresAt > Date.now()) {
    return configCache.value;
  }

  const defaults = buildDefaultRuntimeConfig();
  const settings = await prisma.setting.findMany({
    where: { key: { in: [...RUNTIME_SETTING_KEYS] } }
  });

  const map = Object.fromEntries(settings.map(item => [item.key, item.value]));

  const configuredSources = parseCsv(map.TENDER_SOURCES).filter(source => TENDER_SOURCE_IDS.includes(source as TenderSourceId)) as TenderSourceId[];
  const config = normalizeRuntimeConfig({
    tenderSources: configuredSources.length ? upgradeLegacyDefaultSources(configuredSources) : defaults.tenderSources,
    maxAgeDays: parseIntSafe(map.TENDER_MAX_AGE_DAYS, defaults.maxAgeDays),
    sourceResultLimit: parseIntSafe(map.TENDER_SOURCE_RESULT_LIMIT, defaults.sourceResultLimit),
    resultsPerKeyword: parseIntSafe(map.TENDER_RESULTS_PER_KEYWORD, defaults.resultsPerKeyword),
    queryVariantsPerKeyword: parseIntSafe(map.TENDER_QUERY_VARIANTS_PER_KEYWORD, defaults.queryVariantsPerKeyword),
    keywordCooldownZeroSaveThreshold: parseIntSafe(map.TENDER_KEYWORD_COOLDOWN_ZERO_SAVE_THRESHOLD, defaults.keywordCooldownZeroSaveThreshold),
    keywordCooldownHours: parseIntSafe(map.TENDER_KEYWORD_COOLDOWN_HOURS, defaults.keywordCooldownHours),
    keywordCooldownLookbackDays: parseIntSafe(map.TENDER_KEYWORD_COOLDOWN_LOOKBACK_DAYS, defaults.keywordCooldownLookbackDays),
    sourceRetryCount: parseIntSafe(map.TENDER_SOURCE_RETRY_COUNT, defaults.sourceRetryCount),
    sourceRetryDelayMs: parseIntSafe(map.TENDER_SOURCE_RETRY_DELAY_MS, defaults.sourceRetryDelayMs),
    circuitBreakerThreshold: parseIntSafe(map.TENDER_SOURCE_CIRCUIT_BREAKER_THRESHOLD, defaults.circuitBreakerThreshold),
    circuitBreakerCooldownMs: parseIntSafe(map.TENDER_SOURCE_CIRCUIT_BREAKER_COOLDOWN_MS, defaults.circuitBreakerCooldownMs),
    guangdongMaxPages: parseIntSafe(map.GUANGDONG_MAX_PAGES, defaults.guangdongMaxPages),
    lowValueExcludeKeywords: parseCsv(map.LOW_VALUE_EXCLUDE_KEYWORDS).length ? parseCsv(map.LOW_VALUE_EXCLUDE_KEYWORDS) : defaults.lowValueExcludeKeywords,
    lowValueIncludeKeywords: parseCsv(map.LOW_VALUE_INCLUDE_KEYWORDS).length ? parseCsv(map.LOW_VALUE_INCLUDE_KEYWORDS) : defaults.lowValueIncludeKeywords,
    minRelevanceScore: parseIntSafe(map.MIN_RELEVANCE_SCORE, defaults.minRelevanceScore),
    strictKeywordMentionScore: parseIntSafe(map.STRICT_KEYWORD_MENTION_SCORE, defaults.strictKeywordMentionScore)
  });

  configCache = {
    value: config,
    expiresAt: Date.now() + CONFIG_CACHE_TTL_MS
  };

  return config;
}

export async function ensureRuntimeConfigSettings(): Promise<void> {
  const defaults = runtimeConfigToSettings(buildDefaultRuntimeConfig());
  const existing = await prisma.setting.findMany({
    where: { key: { in: [...RUNTIME_SETTING_KEYS] } }
  });
  const existingMap = new Map(existing.map(item => [item.key, item.value]));

  for (const [key, value] of Object.entries(defaults)) {
    const currentValue = existingMap.get(key);
    if (!currentValue) {
      await prisma.setting.create({
        data: { key, value }
      });
      continue;
    }

    if (key === 'TENDER_SOURCES') {
      const currentSources = parseCsv(currentValue).filter(source => TENDER_SOURCE_IDS.includes(source as TenderSourceId)) as TenderSourceId[];
      if (shouldUpgradeLegacyDefaultSources(currentSources)) {
        await prisma.setting.update({
          where: { key },
          data: { value }
        });
      }
    }
  }

  clearRuntimeConfigCache();
}

export function clearRuntimeConfigCache(): void {
  configCache = null;
}
