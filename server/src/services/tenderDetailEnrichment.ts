import { load } from 'cheerio';
import { prisma } from '../db.js';
import { scrapeTenderDetailWithFirecrawl, scrapeWithFirecrawl } from './firecrawl.js';
import { extractTenderDetailWithAgent, isTenderDetailAgentEnabled } from './tenderDetailAgent.js';
import { extractTenderDetailFields } from './tenderDetailExtractor.js';
import { fetchSzygcgptDetailByUrl } from './tenderSources.js';
import {
  cleanTenderContact,
  cleanTenderPhone,
  cleanTenderServiceScope,
  cleanTenderUnit,
  isUsableBudgetWan,
  isUsableTenderContact,
  isUsableTenderPhone,
  isUsableTenderServiceScope,
  isUsableTenderUnit,
  looksNoisyStructuredValue,
  normalizeFieldText
} from './tenderFieldQuality.js';
import type { HotspotWithKeyword, SearchResult, TenderMetadata } from '../types.js';

type DetailQueueState = {
  running: boolean;
  pendingCount: number;
  processedCount: number;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
  currentHotspotId?: string;
  currentHotspotIds?: string[];
};

const pendingIds = new Set<string>();
const activeIds = new Set<string>();
const DETAIL_ENRICHMENT_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.TENDER_DETAIL_ENRICHMENT_CONCURRENCY || '2', 10) || 2)
);
const state: DetailQueueState = {
  running: false,
  pendingCount: 0,
  processedCount: 0
};
const TENDER_DETAIL_ENRICHMENT_SOURCES = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'];

function mergePreferredUnit(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = cleanTenderUnit(value);
    if (!cleaned) continue;
    if (looksNoisyStructuredValue(value)) continue;
    return cleaned;
  }
  return null;
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
    isUsableTenderUnit(hotspot.tenderUnit) ? 16 : 0,
    isUsableBudgetWan(hotspot.tenderBudgetWan) ? 14 : 0,
    hotspot.tenderDeadline ? 16 : 0,
    hotspot.tenderBidOpenTime ? 8 : 0,
    hotspot.tenderDocDeadline ? 6 : 0,
    hotspot.tenderProjectCode ? 10 : 0,
    isUsableTenderServiceScope(hotspot.tenderServiceScope) ? 10 : 0,
    hotspot.tenderQualification ? 8 : 0,
    hotspot.tenderAddress ? 6 : 0,
    isUsableTenderContact(hotspot.tenderContact) ? 3 : 0,
    isUsableTenderPhone(hotspot.tenderPhone) ? 3 : 0
  ];
  return weights.reduce((sum, value) => sum + value, 0);
}

function shouldEnrichHotspot(hotspot: HotspotWithKeyword): boolean {
  if (getTenderFieldCompletenessScore(hotspot) < 70) return true;
  const usesSzggzyDetailApi = hotspot.url.includes('szggzy.com/globalSearch/details.html');
  if (['szggzy', 'guangdong', 'szygcgpt', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'].includes(hotspot.source) || usesSzggzyDetailApi) {
    return !isUsableBudgetWan(hotspot.tenderBudgetWan)
      || !isUsableTenderUnit(hotspot.tenderUnit)
      || looksNoisyStructuredValue(hotspot.tenderUnit)
      || !hotspot.tenderDeadline
      || !hotspot.tenderProjectCode
      || !isUsableTenderContact(hotspot.tenderContact)
      || !isUsableTenderPhone(hotspot.tenderPhone);
  }
  return false;
}

function mergePreferredText(current: string | null | undefined, next: string | null | undefined): string | null {
  const currentValue = normalizeFieldText(current);
  const nextValue = normalizeFieldText(next);
  if (looksNoisyStructuredValue(currentValue) && nextValue) {
    return nextValue;
  }
  if (currentValue && currentValue.length >= (nextValue?.length ?? 0)) {
    return currentValue;
  }
  return nextValue ?? currentValue ?? null;
}

function mergeAuthoritativeText(
  current: string | null | undefined,
  next: string | null | undefined,
  options?: { preferNext?: boolean }
): string | null {
  const currentValue = normalizeFieldText(current);
  const nextValue = normalizeFieldText(next);
  if (options?.preferNext && nextValue) {
    return nextValue;
  }
  return mergePreferredText(currentValue, nextValue);
}

function mergePreferredDate(current: Date | null | undefined, next: Date | null | undefined): Date | null {
  return current || next || null;
}

function mergePreferredNumber(current: number | null | undefined, next: number | null | undefined): number | null {
  if (current != null && Number.isFinite(current) && current > 0) return current;
  if (next != null && Number.isFinite(next) && next > 0) return next;
  return null;
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

function parseStructuredDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/年|\/|\./g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/时|点/g, ':')
    .replace(/分/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const matched = normalized.match(/(20\d{2}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2}:\d{1,2}(?::\d{1,2})?))?/);
  if (!matched) return undefined;
  const [year, month, day] = matched[1].split('-');
  const [hour = '00', minute = '00', second = '00'] = (matched[2] || '00:00:00').split(':');
  const text = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseSzggzyStructuredTender(detailHtml: string): SearchResult['tender'] | null {
  const $ = load(detailHtml);
  const rows = $('tr').toArray().map((row) => $(row).find('td, th').toArray().map((cell) =>
    $(cell)
      .text()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  ).filter(Boolean)).filter((cells) => cells.length > 0);

  let unit: string | undefined;
  let contact: string | undefined;
  let phone: string | undefined;
  let email: string | undefined;
  let address: string | undefined;
  let budgetWan: number | undefined;
  let deadline: Date | undefined;
  let bidOpenTime: Date | undefined;
  let projectCode: string | undefined;
  let serviceScope: string | undefined;
  let qualification: string | undefined;

  let currentParty: 'owner' | 'agent' | null = null;
  for (const cells of rows) {
    if (cells[0] === '建设单位') {
      currentParty = 'owner';
      if (cells.length >= 3 && cells[1] === '单位名称') {
        unit = cleanTenderUnit(cells[2]) || unit;
      }
      continue;
    }
    if (cells[0] === '招标代理') {
      currentParty = 'agent';
      continue;
    }

    const [label, value] = cells.length === 2
      ? [cells[0], cells[1]]
      : cells.length >= 3
        ? [cells[cells.length - 2], cells[cells.length - 1]]
        : [cells[0], undefined];

    if (!label || !value) continue;

    if (currentParty === 'owner') {
      if (label === '单位名称') unit = cleanTenderUnit(value) || unit;
      if (label === '经办人') contact = cleanTenderContact(value) || contact;
      if (label === '办公电话') phone = cleanTenderPhone(value) || phone;
      if (label === '电子邮箱') email = value || email;
      if (label === '通讯地址') address = value || address;
    }
    if (!contact && currentParty === 'agent' && label === '经办人') {
      contact = cleanTenderContact(value) || contact;
    }
    if (!phone && currentParty === 'agent' && (label === '办公电话' || label === '手机号码')) {
      phone = cleanTenderPhone(value) || phone;
    }

    if (label === '本次发包工程估价' || label === '本次发包工程概算' || label === '预算金额' || label === '招标估价（万元）' || label === '招标估价') {
      const amount = value.match(/([\d,.]+)\s*万元?/);
      if (amount) {
        const parsed = Number.parseFloat(amount[1].replace(/,/g, ''));
        if (Number.isFinite(parsed)) budgetWan = parsed;
      } else {
        const parsed = Number.parseFloat(value.replace(/,/g, '').replace(/[^\d.]/g, ''));
        if (Number.isFinite(parsed)) budgetWan = parsed;
      }
    }
    if (label === '投标文件递交截止时间') {
      deadline = parseStructuredDate(value) || deadline;
    }
    if (label === '开标时间' || label === '开启时间') {
      bidOpenTime = parseStructuredDate(value) || bidOpenTime;
    }
    if (label === '招标项目编号' || label === '项目编号') {
      projectCode = normalizeFieldText(value)?.replace(/[）)】\]]+$/, '') || projectCode;
    }
    if (label === '本次招标内容' || label === '服务内容') {
      serviceScope = cleanTenderServiceScope(value) || serviceScope;
    }
    if (label === '其他资质要求' || label === '投标人资质要求') {
      qualification = value || qualification;
    }
    if (label === '工程地址' || label === '项目地点') {
      address = value || address;
    }
  }

  if (!unit && !contact && !phone && !budgetWan && !deadline && !projectCode && !serviceScope) {
    return null;
  }

  return {
    unit,
    budgetWan,
    deadline,
    projectCode,
    contact,
    phone,
    email,
    bidOpenTime,
    serviceScope,
    qualification,
    address,
    detailSource: 'szggzy-api+structured',
    detailExtractedAt: new Date()
  };
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

  const szggzyDetailContent = hotspot.url.includes('szggzy.com/globalSearch/details.html')
    ? await fetchSzggzyDetailContent(hotspot.url)
    : null;
  const szggzyStructuredTender = szggzyDetailContent ? parseSzggzyStructuredTender(szggzyDetailContent) : null;
  const szygcgptDetail = hotspot.source === 'szygcgpt'
    ? await fetchSzygcgptDetailByUrl(hotspot.url)
    : null;
  const basicMarkdown = szggzyDetailContent || szygcgptDetail?.content || await scrapeWithFirecrawl(hotspot.url);
  const basicMergedContent = basicMarkdown
    ? [hotspot.content, '--- Detail Enrichment ---', basicMarkdown].filter(Boolean).join('\n')
    : hotspot.content;
  const baseSearchResult = buildSearchResultFromHotspot(typedHotspot, basicMergedContent);
  const ruleExtracted = extractTenderDetailFields({
    ...baseSearchResult,
    tender: {
      ...baseSearchResult.tender,
      ...(szggzyStructuredTender ?? {}),
      ...(szygcgptDetail?.tender ?? {})
    }
  });
  const basicExtracted: TenderMetadata = {
    ...ruleExtracted,
    unit: mergePreferredUnit(
      szggzyStructuredTender?.unit,
      szygcgptDetail?.tender.unit,
      ruleExtracted.unit,
      typedHotspot.tenderUnit
    ) ?? undefined,
    budgetWan: szggzyStructuredTender?.budgetWan
      ?? szygcgptDetail?.tender.budgetWan
      ?? ruleExtracted.budgetWan,
    deadline: szggzyStructuredTender?.deadline
      ?? szygcgptDetail?.tender.deadline
      ?? ruleExtracted.deadline,
    projectCode: mergeAuthoritativeText(
      ruleExtracted.projectCode,
      szggzyStructuredTender?.projectCode ?? szygcgptDetail?.tender.projectCode,
      { preferNext: true }
    ) ?? undefined,
    contact: cleanTenderContact(szggzyStructuredTender?.contact)
      ?? cleanTenderContact(szygcgptDetail?.tender.contact)
      ?? cleanTenderContact(ruleExtracted.contact)
      ?? undefined,
    phone: cleanTenderPhone(szggzyStructuredTender?.phone)
      ?? cleanTenderPhone(szygcgptDetail?.tender.phone)
      ?? cleanTenderPhone(ruleExtracted.phone)
      ?? undefined,
    email: szggzyStructuredTender?.email
      ?? szygcgptDetail?.tender.email
      ?? ruleExtracted.email,
    bidOpenTime: szggzyStructuredTender?.bidOpenTime
      ?? szygcgptDetail?.tender.bidOpenTime
      ?? ruleExtracted.bidOpenTime,
    docDeadline: szygcgptDetail?.tender.docDeadline ?? ruleExtracted.docDeadline,
    serviceScope: mergeAuthoritativeText(
      cleanTenderServiceScope(ruleExtracted.serviceScope),
      cleanTenderServiceScope(szggzyStructuredTender?.serviceScope ?? szygcgptDetail?.tender.serviceScope),
      { preferNext: true }
    ) ?? undefined,
    qualification: mergeAuthoritativeText(
      ruleExtracted.qualification,
      szggzyStructuredTender?.qualification ?? szygcgptDetail?.tender.qualification,
      { preferNext: true }
    ) ?? undefined,
    address: mergeAuthoritativeText(
      ruleExtracted.address,
      szggzyStructuredTender?.address ?? szygcgptDetail?.tender.address,
      { preferNext: true }
    ) ?? undefined,
    detailSource: szggzyStructuredTender
      ? (szggzyStructuredTender.detailSource ?? 'szggzy-api+structured')
      : (szygcgptDetail?.tender.detailSource ?? ruleExtracted.detailSource),
    detailExtractedAt: new Date()
  };
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
    : szygcgptDetail?.content
      ? (szygcgptDetail.tender.detailSource ?? 'szygcgpt-detail+rules')
      : (basicMarkdown ? 'detail-enrichment+firecrawl' : (basicExtracted.detailSource ?? typedHotspot.tenderDetailSource));
  let finalExtracted: TenderMetadata = basicExtracted;
  let nextScore = basicScore;
  let preferStructuredFields = Boolean(szggzyStructuredTender || szygcgptDetail);

  // 低完整度公告进入二段深抓取，模拟 agent/browse 式详情解析。
  if (basicScore < 50) {
    const deepResult = await scrapeTenderDetailWithFirecrawl(hotspot.url);
    const deepMergedContent = deepResult.markdown
      ? [basicMergedContent, '--- Agent Detail Enrichment ---', deepResult.markdown].filter(Boolean).join('\n')
      : basicMergedContent;
    const deepRuleExtracted = extractTenderDetailFields(buildSearchResultFromHotspot(typedHotspot, deepMergedContent));
    const deepExtracted: TenderMetadata = {
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
        preferStructuredFields = false;
      }
  }

  // OpenClaw agent 作为最后一层详情增强：允许 agent 逐条打开详情页/读取正文补字段。
  if (isTenderDetailAgentEnabled() && (hotspot.source === 'cebpubservice' || nextScore < 70)) {
    const agentExtracted = await extractTenderDetailWithAgent({
      title: hotspot.title,
      url: hotspot.url,
      source: hotspot.source,
      content: finalContent,
      current: buildSearchResultFromHotspot(typedHotspot, finalContent).tender
    });

    if (agentExtracted) {
      const mergedAgentExtracted: TenderMetadata = {
        ...finalExtracted,
        unit: mergePreferredUnit(agentExtracted.unit, finalExtracted.unit, typedHotspot.tenderUnit) ?? undefined,
        budgetWan: agentExtracted.budgetWan ?? finalExtracted.budgetWan,
        deadline: agentExtracted.deadline ?? finalExtracted.deadline,
        projectCode: agentExtracted.projectCode ?? finalExtracted.projectCode,
        contact: cleanTenderContact(agentExtracted.contact) ?? cleanTenderContact(finalExtracted.contact) ?? undefined,
        phone: cleanTenderPhone(agentExtracted.phone) ?? cleanTenderPhone(finalExtracted.phone) ?? undefined,
        email: agentExtracted.email ?? finalExtracted.email,
        bidOpenTime: agentExtracted.bidOpenTime ?? finalExtracted.bidOpenTime,
        docDeadline: agentExtracted.docDeadline ?? finalExtracted.docDeadline,
        serviceScope: mergePreferredText(
          cleanTenderServiceScope(finalExtracted.serviceScope),
          cleanTenderServiceScope(agentExtracted.serviceScope)
        ) ?? undefined,
        qualification: mergePreferredText(finalExtracted.qualification, agentExtracted.qualification) ?? undefined,
        address: agentExtracted.address ?? finalExtracted.address,
        detailSource: agentExtracted.detailSource || 'detail-enrichment+openclaw-browser',
        detailExtractedAt: new Date()
      };
      const agentScore = getTenderFieldCompletenessScore({
        ...typedHotspot,
        tenderUnit: mergedAgentExtracted.unit ?? typedHotspot.tenderUnit,
        tenderBudgetWan: mergedAgentExtracted.budgetWan ?? typedHotspot.tenderBudgetWan,
        tenderDeadline: mergedAgentExtracted.deadline ?? typedHotspot.tenderDeadline,
        tenderBidOpenTime: mergedAgentExtracted.bidOpenTime ?? typedHotspot.tenderBidOpenTime,
        tenderDocDeadline: mergedAgentExtracted.docDeadline ?? typedHotspot.tenderDocDeadline,
        tenderProjectCode: mergedAgentExtracted.projectCode ?? typedHotspot.tenderProjectCode,
        tenderServiceScope: mergedAgentExtracted.serviceScope ?? typedHotspot.tenderServiceScope,
        tenderQualification: mergedAgentExtracted.qualification ?? typedHotspot.tenderQualification,
        tenderAddress: mergedAgentExtracted.address ?? typedHotspot.tenderAddress,
        tenderContact: mergedAgentExtracted.contact ?? typedHotspot.tenderContact,
        tenderPhone: mergedAgentExtracted.phone ?? typedHotspot.tenderPhone
      });

      if (agentScore >= nextScore) {
        finalExtracted = mergedAgentExtracted;
        finalDetailSource = mergedAgentExtracted.detailSource ?? 'detail-enrichment+openclaw-browser';
        finalContent = [
          finalContent,
          '--- OpenClaw Agent Detail Extraction ---',
          JSON.stringify({
            unit: mergedAgentExtracted.unit,
            budgetWan: mergedAgentExtracted.budgetWan,
            deadline: mergedAgentExtracted.deadline,
            projectCode: mergedAgentExtracted.projectCode,
            contact: mergedAgentExtracted.contact,
            phone: mergedAgentExtracted.phone,
            bidOpenTime: mergedAgentExtracted.bidOpenTime,
            docDeadline: mergedAgentExtracted.docDeadline,
            serviceScope: mergedAgentExtracted.serviceScope,
            qualification: mergedAgentExtracted.qualification,
            address: mergedAgentExtracted.address
          })
        ].filter(Boolean).join('\n');
        nextScore = agentScore;
        preferStructuredFields = false;
      }
    }
  }

  if (nextScore <= prevScore && !basicMarkdown) return false;
  const preferAuthoritativeExtraction = preferStructuredFields || hotspot.source === 'szggzy' || hotspot.url.includes('szggzy.com/globalSearch/details.html');

  await prisma.hotspot.update({
    where: { id: hotspotId },
    data: {
      content: finalContent.slice(0, 16000),
      tenderUnit: (preferAuthoritativeExtraction && cleanTenderUnit(finalExtracted.unit))
        || mergePreferredUnit(hotspot.tenderUnit, finalExtracted.unit),
      tenderBudgetWan: (preferAuthoritativeExtraction && isUsableBudgetWan(finalExtracted.budgetWan))
        ? finalExtracted.budgetWan
        : mergePreferredNumber(hotspot.tenderBudgetWan, finalExtracted.budgetWan),
      tenderDeadline: mergePreferredDate(hotspot.tenderDeadline, finalExtracted.deadline),
      tenderProjectCode: mergeAuthoritativeText(hotspot.tenderProjectCode, finalExtracted.projectCode, { preferNext: preferAuthoritativeExtraction }),
      tenderContact: mergeAuthoritativeText(cleanTenderContact(hotspot.tenderContact), cleanTenderContact(finalExtracted.contact), { preferNext: preferAuthoritativeExtraction }),
      tenderPhone: mergeAuthoritativeText(cleanTenderPhone(hotspot.tenderPhone), cleanTenderPhone(finalExtracted.phone), { preferNext: preferAuthoritativeExtraction }),
      tenderEmail: mergePreferredText(hotspot.tenderEmail, finalExtracted.email),
      tenderBidOpenTime: mergePreferredDate(hotspot.tenderBidOpenTime, finalExtracted.bidOpenTime),
      tenderDocDeadline: mergePreferredDate(hotspot.tenderDocDeadline, finalExtracted.docDeadline),
      tenderServiceScope: mergePreferredText(cleanTenderServiceScope(hotspot.tenderServiceScope), cleanTenderServiceScope(finalExtracted.serviceScope)),
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
  state.processedCount = 0;

  try {
    async function worker(): Promise<void> {
      while (pendingIds.size > 0) {
        const [hotspotId] = pendingIds;
        if (!hotspotId) break;
        pendingIds.delete(hotspotId);
        activeIds.add(hotspotId);
        state.pendingCount = pendingIds.size;
        state.currentHotspotId = hotspotId;
        state.currentHotspotIds = [...activeIds];
        try {
          await enrichSingleHotspot(hotspotId);
          state.processedCount += 1;
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          console.error('Detail enrichment failed:', hotspotId, error);
        } finally {
          activeIds.delete(hotspotId);
          state.currentHotspotIds = [...activeIds];
          state.currentHotspotId = state.currentHotspotIds[0];
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(DETAIL_ENRICHMENT_CONCURRENCY, pendingIds.size) }, worker));
  } finally {
    state.running = false;
    state.currentHotspotId = undefined;
    state.currentHotspotIds = [];
    state.pendingCount = pendingIds.size;
    state.lastFinishedAt = new Date();
    if (pendingIds.size > 0) {
      void processQueue();
    }
  }
}

export function enqueueHotspotDetailEnrichment(hotspotId: string): void {
  pendingIds.add(hotspotId);
  state.pendingCount = pendingIds.size;
  void processQueue();
}

export async function enqueueIncompleteHotspots(limit = 20, options?: { source?: string }): Promise<number> {
  const requestedSource = options?.source?.trim();
  const sourceFilter = requestedSource && TENDER_DETAIL_ENRICHMENT_SOURCES.includes(requestedSource)
    ? [requestedSource]
    : TENDER_DETAIL_ENRICHMENT_SOURCES;

  const hotspots = await prisma.hotspot.findMany({
    where: {
      source: {
        in: sourceFilter
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
