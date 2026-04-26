import dotenv from 'dotenv';
import { prisma } from '../db.js';
import { deduplicateResults } from '../services/search.js';
import { analyzeContent, preMatchKeyword } from '../services/ai.js';
import { enrichResultWithFirecrawl, shouldEnrichWithFirecrawl } from '../services/firecrawl.js';
import {
  TENDER_SOURCE_ADAPTERS,
  searchTenderSourceAcrossQueries,
  type TenderSourceId,
} from '../services/tenderSourceRegistry.js';
import { extractTenderDetailFields } from '../services/tenderDetailExtractor.js';
import {
  enqueueHotspotDetailEnrichment,
  getDetailEnrichmentQueueState,
  getTenderFieldCompletenessScore,
} from '../services/tenderDetailEnrichment.js';
import type { AIAnalysis, SearchResult } from '../types.js';

dotenv.config();

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueue(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const state = getDetailEnrichmentQueueState();
    if (!state.running && state.pendingCount === 0) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Detail enrichment queue timeout after ${timeoutMs}ms`);
    }
    await sleep(1000);
  }
}

function buildQueries(query: string): string[] {
  return [...new Set([query, 'BIM', '建筑信息模型'].map((item) => item.trim()).filter(Boolean))].slice(0, 3);
}

function buildRuleAnalysis(item: SearchResult, query: string): AIAnalysis {
  const text = `${item.title}\n${item.content}`;
  const preMatch = preMatchKeyword(text, buildQueries(query));
  const hasDeadline = Boolean(item.tender?.deadline || item.tender?.bidOpenTime || /截止|开标|递交/.test(text));
  const hasBudget = Boolean(item.tender?.budgetWan != null || /预算|控制价|最高限价|万元|金额/.test(text));
  const relevance = preMatch.matched ? (hasDeadline || hasBudget ? 82 : 72) : 58;
  return {
    isReal: true,
    relevance,
    relevanceReason: `单源样本入库：${preMatch.matched ? `命中 ${preMatch.matchedTerms.join('、')}` : '待补关键词'}；${hasDeadline ? '有截止/开标线索' : '待补截止'}；${hasBudget ? '有预算线索' : '待补预算'}`,
    keywordMentioned: preMatch.matched,
    importance: relevance >= 80 ? 'high' : 'medium',
    summary: item.tender?.serviceScope || item.content.slice(0, 120)
  };
}

function selectKeywordText(query: string): string {
  return query.trim() || 'BIM';
}

async function ensureKeyword(query: string) {
  const text = selectKeywordText(query);
  return prisma.keyword.upsert({
    where: { text },
    update: { isActive: true },
    create: {
      text,
      category: 'v1.5-sample',
      isActive: true,
    },
  });
}

function coverage(rows: Awaited<ReturnType<typeof prisma.hotspot.findMany>>) {
  return {
    total: rows.length,
    unit: rows.filter((item) => item.tenderUnit).length,
    budget: rows.filter((item) => item.tenderBudgetWan != null).length,
    deadline: rows.filter((item) => item.tenderDeadline || item.tenderBidOpenTime || item.tenderDocDeadline).length,
    projectCode: rows.filter((item) => item.tenderProjectCode).length,
    contact: rows.filter((item) => item.tenderContact).length,
    phone: rows.filter((item) => item.tenderPhone).length,
    serviceScope: rows.filter((item) => item.tenderServiceScope).length,
    qualification: rows.filter((item) => item.tenderQualification).length,
    address: rows.filter((item) => item.tenderAddress).length,
    detailSource: rows.filter((item) => item.tenderDetailSource).length,
    avgCompleteness: rows.length
      ? Math.round(rows.reduce((sum, item) => sum + getTenderFieldCompletenessScore(item as any), 0) / rows.length)
      : 0,
  };
}

async function main(): Promise<void> {
  const sourceId = (getArg('source', 'cebpubservice') || 'cebpubservice') as TenderSourceId;
  const query = getArg('query', 'BIM') || 'BIM';
  const limit = Number.parseInt(getArg('limit', '5') || '5', 10);
  const wait = hasFlag('wait');
  const useAi = hasFlag('ai');
  const timeoutMs = Number.parseInt(getArg('timeoutMs', '600000') || '600000', 10);
  const source = TENDER_SOURCE_ADAPTERS.find((item) => item.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);

  const keyword = await ensureKeyword(query);
  const queries = buildQueries(query);
  const rawRows = await searchTenderSourceAcrossQueries(source, queries, Math.max(1, Math.min(limit, 20)));
  const rows = deduplicateResults(rawRows).slice(0, limit);
  const savedIds: string[] = [];
  const skipped: string[] = [];

  for (const item of rows) {
    const existing = await prisma.hotspot.findFirst({
      where: {
        url: item.url,
        source: item.source,
      },
      select: { id: true, title: true },
    });
    if (existing) {
      skipped.push(existing.title);
      enqueueHotspotDetailEnrichment(existing.id);
      continue;
    }

    const enrichedItem = shouldEnrichWithFirecrawl(item)
      ? await enrichResultWithFirecrawl(item)
      : item;
    const tenderDetail = extractTenderDetailFields(enrichedItem);
    const analysis = useAi
      ? await analyzeContent(`${enrichedItem.title}\n${enrichedItem.content}`, query, preMatchKeyword(`${enrichedItem.title}\n${enrichedItem.content}`, queries))
      : buildRuleAnalysis(enrichedItem, query);

    const hotspot = await prisma.hotspot.create({
      data: {
        title: enrichedItem.title,
        content: enrichedItem.content.slice(0, 16000),
        url: enrichedItem.url,
        source: enrichedItem.source,
        sourceId: enrichedItem.sourceId != null ? String(enrichedItem.sourceId) : null,
        isReal: analysis.isReal,
        relevance: analysis.relevance,
        relevanceReason: analysis.relevanceReason || null,
        keywordMentioned: analysis.keywordMentioned ?? null,
        importance: analysis.importance,
        summary: analysis.summary,
        publishedAt: enrichedItem.publishedAt || null,
        tenderType: enrichedItem.tender?.type || null,
        tenderRegion: enrichedItem.tender?.region || null,
        tenderCity: enrichedItem.tender?.city || null,
        tenderUnit: tenderDetail.unit || enrichedItem.tender?.unit || null,
        tenderBudgetWan: tenderDetail.budgetWan ?? enrichedItem.tender?.budgetWan ?? null,
        tenderDeadline: tenderDetail.deadline || enrichedItem.tender?.deadline || null,
        tenderNoticeType: enrichedItem.tender?.noticeType || null,
        tenderPlatform: enrichedItem.tender?.platform || null,
        tenderProjectCode: tenderDetail.projectCode || enrichedItem.tender?.projectCode || null,
        tenderContact: tenderDetail.contact || enrichedItem.tender?.contact || null,
        tenderPhone: tenderDetail.phone || enrichedItem.tender?.phone || null,
        tenderEmail: tenderDetail.email || enrichedItem.tender?.email || null,
        tenderBidOpenTime: tenderDetail.bidOpenTime || enrichedItem.tender?.bidOpenTime || null,
        tenderDocDeadline: tenderDetail.docDeadline || enrichedItem.tender?.docDeadline || null,
        tenderServiceScope: tenderDetail.serviceScope || enrichedItem.tender?.serviceScope || null,
        tenderQualification: tenderDetail.qualification || enrichedItem.tender?.qualification || null,
        tenderAddress: tenderDetail.address || enrichedItem.tender?.address || null,
        tenderDetailSource: tenderDetail.detailSource || enrichedItem.tender?.detailSource || null,
        tenderDetailExtractedAt: tenderDetail.detailExtractedAt || enrichedItem.tender?.detailExtractedAt || null,
        keywordId: keyword.id,
      },
    });
    savedIds.push(hotspot.id);
    enqueueHotspotDetailEnrichment(hotspot.id);
  }

  if (wait) {
    await waitForQueue(timeoutMs);
  }

  const inspectedIds = [...savedIds];
  const sourceRows = await prisma.hotspot.findMany({
    where: {
      source: sourceId,
      ...(inspectedIds.length ? { id: { in: inspectedIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: inspectedIds.length || limit,
  });

  console.log(JSON.stringify({
    source: sourceId,
    query,
    queries,
    fetched: rows.length,
    saved: savedIds.length,
    skippedExisting: skipped.length,
    waitedForDetailQueue: wait,
    queue: getDetailEnrichmentQueueState(),
    coverage: coverage(sourceRows),
    samples: sourceRows.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      relevance: item.relevance,
      importance: item.importance,
      unit: item.tenderUnit,
      budgetWan: item.tenderBudgetWan,
      deadline: item.tenderDeadline,
      bidOpenTime: item.tenderBidOpenTime,
      serviceScope: item.tenderServiceScope,
      detailSource: item.tenderDetailSource,
      completeness: getTenderFieldCompletenessScore(item as any),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
