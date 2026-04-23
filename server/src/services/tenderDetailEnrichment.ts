import { prisma } from '../db.js';
import { scrapeTenderDetailWithFirecrawl, scrapeWithFirecrawl } from './firecrawl.js';
import { extractTenderDetailFields } from './tenderDetailExtractor.js';
import type { HotspotWithKeyword, SearchResult } from '../types.js';

type DetailQueueState = {
  running: boolean;
  pendingCount: number;
  processedCount: number;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
  currentHotspotId?: string;
};

const pendingIds = new Set<string>();
const state: DetailQueueState = {
  running: false,
  pendingCount: 0,
  processedCount: 0
};

function normalizeString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function looksNoisyStructuredValue(value: string | null | undefined): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  return /(项目名称|预算金额|采购需求概况|联系人|联系电话|采购单位)[:：]/.test(normalized);
}

function looksWeakTenderUnit(value: string | null | undefined): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return true;
  if (normalized.length <= 3) return true;
  return /^(万元|元|预算金额|采购单位|招标人)$/.test(normalized);
}

function mergePreferredUnit(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    if (looksNoisyStructuredValue(normalized) || looksWeakTenderUnit(normalized)) continue;
    return normalized;
  }
  return normalizeString(values.find((value) => normalizeString(value)) ?? null);
}

function buildSearchResultFromHotspot(hotspot: HotspotWithKeyword, content: string): SearchResult {
  return {
    title: hotspot.title,
    content,
    url: hotspot.url,
    source: hotspot.source as SearchResult['source'],
    sourceId: hotspot.sourceId ?? undefined,
    publishedAt: hotspot.publishedAt ?? undefined,
    tender: {
      type: hotspot.tenderType ?? undefined,
      region: hotspot.tenderRegion ?? undefined,
      city: hotspot.tenderCity ?? undefined,
      unit: hotspot.tenderUnit ?? undefined,
      budgetWan: hotspot.tenderBudgetWan ?? undefined,
      deadline: hotspot.tenderDeadline ?? undefined,
      noticeType: hotspot.tenderNoticeType ?? undefined,
      platform: hotspot.tenderPlatform ?? undefined,
      projectCode: hotspot.tenderProjectCode ?? undefined,
      contact: hotspot.tenderContact ?? undefined,
      phone: hotspot.tenderPhone ?? undefined,
      email: hotspot.tenderEmail ?? undefined,
      bidOpenTime: hotspot.tenderBidOpenTime ?? undefined,
      docDeadline: hotspot.tenderDocDeadline ?? undefined,
      serviceScope: hotspot.tenderServiceScope ?? undefined,
      qualification: hotspot.tenderQualification ?? undefined,
      address: hotspot.tenderAddress ?? undefined,
      detailSource: hotspot.tenderDetailSource ?? undefined,
      detailExtractedAt: hotspot.tenderDetailExtractedAt ?? undefined
    }
  };
}

export function getTenderFieldCompletenessScore(hotspot: Pick<
  HotspotWithKeyword,
  | 'tenderUnit'
  | 'tenderBudgetWan'
  | 'tenderDeadline'
  | 'tenderBidOpenTime'
  | 'tenderDocDeadline'
  | 'tenderProjectCode'
  | 'tenderServiceScope'
  | 'tenderQualification'
  | 'tenderAddress'
  | 'tenderContact'
  | 'tenderPhone'
>): number {
  const weights = [
    hotspot.tenderUnit ? 16 : 0,
    hotspot.tenderBudgetWan != null ? 14 : 0,
    hotspot.tenderDeadline ? 16 : 0,
    hotspot.tenderBidOpenTime ? 8 : 0,
    hotspot.tenderDocDeadline ? 6 : 0,
    hotspot.tenderProjectCode ? 10 : 0,
    hotspot.tenderServiceScope ? 10 : 0,
    hotspot.tenderQualification ? 8 : 0,
    hotspot.tenderAddress ? 6 : 0,
    hotspot.tenderContact ? 3 : 0,
    hotspot.tenderPhone ? 3 : 0
  ];
  return weights.reduce((sum, value) => sum + value, 0);
}

function shouldEnrichHotspot(hotspot: HotspotWithKeyword): boolean {
  if (getTenderFieldCompletenessScore(hotspot) < 70) return true;
  if (hotspot.source === 'szygcgpt' || hotspot.source === 'gzebpubservice') {
    return hotspot.tenderBudgetWan == null || !hotspot.tenderContact || !hotspot.tenderPhone;
  }
  return false;
}

function mergePreferredText(current: string | null | undefined, next: string | null | undefined): string | null {
  const currentValue = normalizeString(current);
  const nextValue = normalizeString(next);
  if (looksNoisyStructuredValue(currentValue) && nextValue) {
    return nextValue;
  }
  if (currentValue && currentValue.length >= (nextValue?.length ?? 0)) {
    return currentValue;
  }
  return nextValue ?? currentValue ?? null;
}

function mergePreferredDate(current: Date | null | undefined, next: Date | null | undefined): Date | null {
  return current || next || null;
}

function mergePreferredNumber(current: number | null | undefined, next: number | null | undefined): number | null {
  return current ?? next ?? null;
}

function extractSzggzyContentId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('szggzy.com')) return null;
    return parsed.searchParams.get('contentId');
  } catch {
    return null;
  }
}

async function fetchSzggzyDetailContent(url: string): Promise<string | null> {
  const contentId = extractSzggzyContentId(url);
  if (!contentId) return null;

  try {
    const response = await fetch(`https://www.szggzy.com/cms/api/v1/trade/content/detail?contentId=${encodeURIComponent(contentId)}`, {
      headers: {
        Referer: url,
        Accept: 'application/json, text/plain, */*'
      }
    });

    if (!response.ok) return null;
    const payload = await response.json() as { data?: { txt?: string } };
    const detailText = payload?.data?.txt;
    return typeof detailText === 'string' && detailText.trim() ? detailText : null;
  } catch (error) {
    console.warn('Failed to fetch szggzy detail content:', url, error);
    return null;
  }
}

async function enrichSingleHotspot(hotspotId: string): Promise<boolean> {
  const hotspot = await prisma.hotspot.findUnique({
    where: { id: hotspotId },
    include: {
      keyword: {
        select: { id: true, text: true, category: true }
      }
    }
  });

  if (!hotspot) return false;

  const typedHotspot = hotspot as unknown as HotspotWithKeyword;
  if (!shouldEnrichHotspot(typedHotspot)) return false;

  const szggzyDetailContent = hotspot.source === 'szggzy'
    ? await fetchSzggzyDetailContent(hotspot.url)
    : null;
  const basicMarkdown = szggzyDetailContent || await scrapeWithFirecrawl(hotspot.url);
  const basicMergedContent = basicMarkdown
    ? [hotspot.content, '--- Detail Enrichment ---', basicMarkdown].filter(Boolean).join('\n')
    : hotspot.content;

  const basicExtracted = extractTenderDetailFields(buildSearchResultFromHotspot(typedHotspot, basicMergedContent));
  const basicScore = getTenderFieldCompletenessScore({
    ...typedHotspot,
    tenderUnit: basicExtracted.unit ?? typedHotspot.tenderUnit,
    tenderBudgetWan: basicExtracted.budgetWan ?? typedHotspot.tenderBudgetWan,
    tenderDeadline: basicExtracted.deadline ?? typedHotspot.tenderDeadline,
    tenderBidOpenTime: basicExtracted.bidOpenTime ?? typedHotspot.tenderBidOpenTime,
    tenderDocDeadline: basicExtracted.docDeadline ?? typedHotspot.tenderDocDeadline,
    tenderProjectCode: basicExtracted.projectCode ?? typedHotspot.tenderProjectCode,
    tenderServiceScope: basicExtracted.serviceScope ?? typedHotspot.tenderServiceScope,
    tenderQualification: basicExtracted.qualification ?? typedHotspot.tenderQualification,
    tenderAddress: basicExtracted.address ?? typedHotspot.tenderAddress,
    tenderContact: basicExtracted.contact ?? typedHotspot.tenderContact,
    tenderPhone: basicExtracted.phone ?? typedHotspot.tenderPhone
  });
  const prevScore = getTenderFieldCompletenessScore(typedHotspot);
  let finalContent = basicMergedContent;
  let finalDetailSource = szggzyDetailContent
    ? 'szggzy-api+rules'
    : (basicMarkdown ? 'detail-enrichment+firecrawl' : (basicExtracted.detailSource ?? typedHotspot.tenderDetailSource));
  let finalExtracted = basicExtracted;
  let nextScore = basicScore;

  // 低完整度公告进入二段深抓取，模拟 agent/browse 式详情解析。
  if (basicScore < 50) {
    const deepResult = await scrapeTenderDetailWithFirecrawl(hotspot.url);
    const deepMergedContent = deepResult.markdown
      ? [basicMergedContent, '--- Agent Detail Enrichment ---', deepResult.markdown].filter(Boolean).join('\n')
      : basicMergedContent;
    const deepRuleExtracted = extractTenderDetailFields(buildSearchResultFromHotspot(typedHotspot, deepMergedContent));
    const deepExtracted = {
      ...deepRuleExtracted,
      ...deepResult.extracted,
      unit: mergePreferredUnit(
        deepRuleExtracted.unit,
        deepResult.extracted?.unit,
        basicExtracted.unit,
        typedHotspot.tenderUnit
      ) ?? undefined,
      detailSource: deepResult.extracted?.detailSource || deepRuleExtracted.detailSource || 'detail-enrichment+agent-firecrawl',
      detailExtractedAt: new Date()
    };
    const deepScore = getTenderFieldCompletenessScore({
      ...typedHotspot,
      tenderUnit: deepExtracted.unit ?? basicExtracted.unit ?? typedHotspot.tenderUnit,
      tenderBudgetWan: deepExtracted.budgetWan ?? basicExtracted.budgetWan ?? typedHotspot.tenderBudgetWan,
      tenderDeadline: deepExtracted.deadline ?? basicExtracted.deadline ?? typedHotspot.tenderDeadline,
      tenderBidOpenTime: deepExtracted.bidOpenTime ?? basicExtracted.bidOpenTime ?? typedHotspot.tenderBidOpenTime,
      tenderDocDeadline: deepExtracted.docDeadline ?? basicExtracted.docDeadline ?? typedHotspot.tenderDocDeadline,
      tenderProjectCode: deepExtracted.projectCode ?? basicExtracted.projectCode ?? typedHotspot.tenderProjectCode,
      tenderServiceScope: deepExtracted.serviceScope ?? basicExtracted.serviceScope ?? typedHotspot.tenderServiceScope,
      tenderQualification: deepExtracted.qualification ?? basicExtracted.qualification ?? typedHotspot.tenderQualification,
      tenderAddress: deepExtracted.address ?? basicExtracted.address ?? typedHotspot.tenderAddress,
      tenderContact: deepExtracted.contact ?? basicExtracted.contact ?? typedHotspot.tenderContact,
      tenderPhone: deepExtracted.phone ?? basicExtracted.phone ?? typedHotspot.tenderPhone
    });

    if (deepScore >= nextScore) {
      finalContent = deepMergedContent;
      finalExtracted = deepExtracted;
      finalDetailSource = deepExtracted.detailSource ?? 'detail-enrichment+agent-firecrawl';
      nextScore = deepScore;
    }
  }

  if (nextScore <= prevScore && !basicMarkdown) return false;

  await prisma.hotspot.update({
    where: { id: hotspotId },
    data: {
      content: finalContent.slice(0, 16000),
      tenderUnit: mergePreferredText(hotspot.tenderUnit, finalExtracted.unit),
      tenderBudgetWan: mergePreferredNumber(hotspot.tenderBudgetWan, finalExtracted.budgetWan),
      tenderDeadline: mergePreferredDate(hotspot.tenderDeadline, finalExtracted.deadline),
      tenderProjectCode: mergePreferredText(hotspot.tenderProjectCode, finalExtracted.projectCode),
      tenderContact: mergePreferredText(hotspot.tenderContact, finalExtracted.contact),
      tenderPhone: mergePreferredText(hotspot.tenderPhone, finalExtracted.phone),
      tenderEmail: mergePreferredText(hotspot.tenderEmail, finalExtracted.email),
      tenderBidOpenTime: mergePreferredDate(hotspot.tenderBidOpenTime, finalExtracted.bidOpenTime),
      tenderDocDeadline: mergePreferredDate(hotspot.tenderDocDeadline, finalExtracted.docDeadline),
      tenderServiceScope: mergePreferredText(hotspot.tenderServiceScope, finalExtracted.serviceScope),
      tenderQualification: mergePreferredText(hotspot.tenderQualification, finalExtracted.qualification),
      tenderAddress: mergePreferredText(hotspot.tenderAddress, finalExtracted.address),
      tenderDetailSource: finalDetailSource,
      tenderDetailExtractedAt: new Date()
    }
  });

  return true;
}

async function processQueue(): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.lastStartedAt = new Date();
  state.lastError = undefined;

  try {
    while (pendingIds.size > 0) {
      const [hotspotId] = pendingIds;
      if (!hotspotId) break;
      pendingIds.delete(hotspotId);
      state.pendingCount = pendingIds.size;
      state.currentHotspotId = hotspotId;
      try {
        await enrichSingleHotspot(hotspotId);
        state.processedCount += 1;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        console.error('Detail enrichment failed:', hotspotId, error);
      }
    }
  } finally {
    state.running = false;
    state.currentHotspotId = undefined;
    state.pendingCount = pendingIds.size;
    state.lastFinishedAt = new Date();
  }
}

export function enqueueHotspotDetailEnrichment(hotspotId: string): void {
  pendingIds.add(hotspotId);
  state.pendingCount = pendingIds.size;
  void processQueue();
}

export async function enqueueIncompleteHotspots(limit = 20): Promise<number> {
  const hotspots = await prisma.hotspot.findMany({
    where: {
      source: {
        in: ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice']
      }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100))
  });

  let queued = 0;
  for (const hotspot of hotspots) {
    const typedHotspot = hotspot as unknown as HotspotWithKeyword;
    if (!shouldEnrichHotspot(typedHotspot)) continue;
    if (!pendingIds.has(hotspot.id)) {
      pendingIds.add(hotspot.id);
      queued += 1;
    }
  }
  state.pendingCount = pendingIds.size;
  void processQueue();
  return queued;
}

export function getDetailEnrichmentQueueState(): DetailQueueState {
  return { ...state, pendingCount: pendingIds.size };
}
