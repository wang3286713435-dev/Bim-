import axios from 'axios';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SearchResult, TenderMetadata } from '../types.js';

const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev';
const FIRECRAWL_TIMEOUT_MS = Number.parseInt(process.env.FIRECRAWL_TIMEOUT_MS || '30000', 10);
const FIRECRAWL_CACHE_TTL_MS = Number.parseInt(process.env.FIRECRAWL_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const FIRECRAWL_CACHE_FILE = process.env.FIRECRAWL_CACHE_FILE || path.resolve(process.cwd(), '.cache/firecrawl-cache.json');

type FirecrawlCacheEntry = {
  markdown: string;
  fetchedAt: number;
};

type FirecrawlMode = 'basic' | 'detail';

type FirecrawlScrapeOptions = {
  mode?: FirecrawlMode;
};

type FirecrawlDetailExtraction = TenderMetadata & {
  confidence?: string;
  rawEvidence?: string[];
};

type FirecrawlDetailScrapeResult = {
  markdown: string | null;
  extracted: FirecrawlDetailExtraction | null;
};

const memoryCache = new Map<string, FirecrawlCacheEntry>();
let diskCacheLoaded = false;

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    json?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

function isFresh(entry: FirecrawlCacheEntry | undefined): entry is FirecrawlCacheEntry {
  return Boolean(entry && Date.now() - entry.fetchedAt < FIRECRAWL_CACHE_TTL_MS && entry.markdown);
}

async function loadDiskCache(): Promise<void> {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;

  try {
    const raw = await readFile(FIRECRAWL_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, FirecrawlCacheEntry>;
    for (const [url, entry] of Object.entries(parsed)) {
      if (isFresh(entry)) {
        memoryCache.set(url, entry);
      }
    }
  } catch {
    // ignore missing or invalid cache files
  }
}

async function persistDiskCache(): Promise<void> {
  await mkdir(path.dirname(FIRECRAWL_CACHE_FILE), { recursive: true });
  const serialized = JSON.stringify(Object.fromEntries(memoryCache), null, 2);
  await writeFile(FIRECRAWL_CACHE_FILE, serialized, 'utf-8');
}

export function isFirecrawlEnabled(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

export function shouldEnrichWithFirecrawl(result: SearchResult): boolean {
  return ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice'].includes(result.source);
}

function buildCacheKey(url: string, mode: FirecrawlMode): string {
  return `${mode}:${url}`;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const matched = value.match(/[\d,.]+/);
    if (!matched) return undefined;
    const parsed = Number.parseFloat(matched[0].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/年|\/|\./g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/时|点/g, ':')
    .replace(/分/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/(20\d{2}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2}:\d{1,2}(?::\d{1,2})?))?/);
  if (!match) return undefined;
  const time = match[2] || '00:00:00';
  const parsed = new Date(`${match[1]}T${time.length === 5 ? `${time}:00` : time}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeString(value: unknown, maxLength = 600): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function parseDetailExtraction(payload: Record<string, unknown> | undefined): FirecrawlDetailExtraction | null {
  if (!payload) return null;

  const rawEvidence = Array.isArray(payload.rawEvidence)
    ? payload.rawEvidence.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : undefined;

  const extracted: FirecrawlDetailExtraction = {
    unit: normalizeString(payload.unit, 120),
    budgetWan: parseNumber(payload.budgetWan),
    deadline: parseDate(payload.deadline),
    projectCode: normalizeString(payload.projectCode, 120),
    contact: normalizeString(payload.contact, 60),
    phone: normalizeString(payload.phone, 60),
    email: normalizeString(payload.email, 120),
    bidOpenTime: parseDate(payload.bidOpenTime),
    docDeadline: parseDate(payload.docDeadline),
    serviceScope: normalizeString(payload.serviceScope, 1000),
    qualification: normalizeString(payload.qualification, 1000),
    address: normalizeString(payload.address, 240),
    detailSource: 'firecrawl-detail-json',
    detailExtractedAt: new Date(),
    confidence: normalizeString(payload.confidence, 32),
    rawEvidence
  };

  const hasUsefulField = Boolean(
    extracted.unit
    || extracted.budgetWan != null
    || extracted.deadline
    || extracted.projectCode
    || extracted.contact
    || extracted.phone
    || extracted.bidOpenTime
    || extracted.docDeadline
    || extracted.serviceScope
    || extracted.qualification
    || extracted.address
  );

  return hasUsefulField ? extracted : null;
}

export async function scrapeWithFirecrawl(url: string, options: FirecrawlScrapeOptions = {}): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY || !url) {
    return null;
  }

  const mode = options.mode ?? 'basic';
  await loadDiskCache();
  const cacheKey = buildCacheKey(url, mode);
  const cached = memoryCache.get(cacheKey);
  if (isFresh(cached)) {
    return cached.markdown;
  }

  try {
    const isDetailMode = mode === 'detail';
    const response = await axios.post<FirecrawlScrapeResponse>(
      `${FIRECRAWL_BASE_URL.replace(/\/$/, '')}/v2/scrape`,
      {
        url,
        formats: ['markdown'],
        onlyMainContent: !isDetailMode,
        waitFor: isDetailMode ? 2000 : 800,
        blockAds: true,
        proxy: 'auto'
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: isDetailMode ? Math.max(FIRECRAWL_TIMEOUT_MS, 60000) : FIRECRAWL_TIMEOUT_MS
      }
    );

    const markdown = response.data.data?.markdown?.trim();
    if (!markdown) return null;

    const normalized = markdown.slice(0, isDetailMode ? 14000 : 6000);
    memoryCache.set(cacheKey, {
      markdown: normalized,
      fetchedAt: Date.now()
    });
    await persistDiskCache();
    return normalized;
  } catch (error) {
    console.warn('Firecrawl scrape failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function scrapeTenderDetailWithFirecrawl(url: string): Promise<FirecrawlDetailScrapeResult> {
  if (!process.env.FIRECRAWL_API_KEY || !url) {
    return { markdown: null, extracted: null };
  }

  const markdown = await scrapeWithFirecrawl(url, { mode: 'detail' });
  const extractedFromMarkdown = parseDetailExtraction(undefined);

  try {
    const response = await axios.post<FirecrawlScrapeResponse>(
      `${FIRECRAWL_BASE_URL.replace(/\/$/, '')}/v2/scrape`,
      {
        url,
        formats: [
          'markdown',
          {
            type: 'json',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                unit: { type: 'string' },
                budgetWan: { type: 'number' },
                deadline: { type: 'string' },
                projectCode: { type: 'string' },
                contact: { type: 'string' },
                phone: { type: 'string' },
                email: { type: 'string' },
                bidOpenTime: { type: 'string' },
                docDeadline: { type: 'string' },
                serviceScope: { type: 'string' },
                qualification: { type: 'string' },
                address: { type: 'string' },
                confidence: { type: 'string' },
                rawEvidence: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            prompt: [
              '请从中国政府/公共资源/招采公告详情页中提取投标字段。',
              '只提取页面中明确出现的信息，不要猜测。',
              'budgetWan 使用“万元”为单位；如果页面只有元，请换算成万元。',
              'deadline 优先取投标截止/响应截止；没有时可留空，不要用发布时间代替。',
              'bidOpenTime 取开标/开启时间。',
              'docDeadline 取文件获取截止/报名截止。',
              'serviceScope 提取招标范围/服务内容摘要。',
              'qualification 提取投标人资格要求摘要。',
              'address 提取项目地点/开标地点/递交地点。',
              'rawEvidence 返回 1-5 条你据以判断的原文短句。'
            ].join(' ')
          }
        ],
        onlyMainContent: false,
        waitFor: 2500,
        blockAds: true,
        proxy: 'auto'
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: Math.max(FIRECRAWL_TIMEOUT_MS, 90000)
      }
    );

    const jsonData = response.data.data?.json;
    const detailMarkdown = response.data.data?.markdown?.trim() || markdown;
    const extracted = parseDetailExtraction(jsonData);
    return {
      markdown: detailMarkdown ? detailMarkdown.slice(0, 16000) : null,
      extracted: extracted ?? extractedFromMarkdown
    };
  } catch (error) {
    console.warn('Firecrawl detail scrape failed:', error instanceof Error ? error.message : error);
    return {
      markdown,
      extracted: extractedFromMarkdown
    };
  }
}

export async function enrichResultWithFirecrawl(result: SearchResult): Promise<SearchResult> {
  if (!shouldEnrichWithFirecrawl(result) || !isFirecrawlEnabled()) {
    return result;
  }

  const markdown = await scrapeWithFirecrawl(result.url);
  if (!markdown) {
    return result;
  }

  const mergedContent = [result.content, '--- Firecrawl 正文 ---', markdown]
    .filter(Boolean)
    .join('\n');

  return {
    ...result,
    content: mergedContent.slice(0, 8000)
  };
}
