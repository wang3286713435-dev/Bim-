import { prisma } from '../db.js';
import {
  enqueueHotspotDetailEnrichment,
  getDetailEnrichmentQueueState,
} from '../services/tenderDetailEnrichment.js';
import { extractTenderDetailFields } from '../services/tenderDetailExtractor.js';
import {
  cleanTenderContact,
  cleanTenderPhone,
  cleanTenderUnit,
} from '../services/tenderFieldQuality.js';

const TENDER_SOURCES = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'] as const;
const STATUS_NOISE_PATTERN = /开标情况|开标记录|开标信息|开标直播|评标情况|评标结果|定标结果/;
const CONTRACT_DISCLOSURE_PATTERN = /合同公开信息|合同信息公开/;

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDirtyStructuredText(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(项目名称|预算金额)[:：]|(联系人|联系电话|联系地址|招标代理机构)/.test(value);
}

function isWeakTenderUnit(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return normalized.length <= 3 || /^(万元|元|预算金额|采购单位|招标人)$/.test(normalized);
}

function sanitizeTenderUnit(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .split(/(?:项目名称|预算金额|联系地址|招标人联系人|项目联系人|联系人|联系电话|招标代理机构)/)[0]
    ?.trim()
    .replace(/[：:\s]+$/, '');
  if (!cleaned || isDirtyStructuredText(cleaned)) return null;
  return cleanTenderUnit(cleaned);
}

function isStatusNoiseText(value: string | null | undefined): boolean {
  if (!value) return false;
  return STATUS_NOISE_PATTERN.test(value);
}

function isContractDisclosureText(value: string | null | undefined): boolean {
  if (!value) return false;
  return CONTRACT_DISCLOSURE_PATTERN.test(value);
}

function isRemovableLowValueHotspot(hotspot: {
  source: string;
  title: string;
  content: string;
}): boolean {
  if (isContractDisclosureText(hotspot.title) || isContractDisclosureText(hotspot.content)) {
    return true;
  }
  if (hotspot.source === 'szggzy' && hotspot.content.includes('合同签订基本信息公示表')) {
    return true;
  }
  if (isStatusNoiseText(hotspot.title)) {
    return true;
  }
  return hotspot.source === 'gzebpubservice'
    && (
      hotspot.title.includes('中标')
      || hotspot.title.includes('成交结果')
      || hotspot.content.includes('中标（成交）结果详情')
    );
}

function shouldResetSuspiciousPhone(hotspot: {
  source: string;
  url: string;
  tenderContact: string | null;
  tenderPhone: string | null;
}): boolean {
  if (!hotspot.tenderPhone) return false;
  if (hotspot.source !== 'guangdong') return false;
  if (!hotspot.url.includes('ygp.gdzwfw.gov.cn')) return false;
  if (hotspot.tenderContact) return false;
  return true;
}

function isMalformedTenderUrl(url: string, source: string): boolean {
  if (source === 'gzebpubservice' && url.includes('#/show-bid-opening/list/')) return true;
  if (source === 'szygcgpt' && url.includes('purchaseInfoDetail')) return true;
  return false;
}

async function waitForDetailQueue(): Promise<void> {
  for (;;) {
    const state = getDetailEnrichmentQueueState();
    if (!state.running && state.pendingCount === 0) return;
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const purgeLegacy = hasFlag('--purge-legacy');

  const hotspots = await prisma.hotspot.findMany({
    where: {
      source: {
        in: [...TENDER_SOURCES],
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const dirtyFieldRepairs = hotspots
    .filter((hotspot) =>
      isDirtyStructuredText(hotspot.tenderUnit)
      || isWeakTenderUnit(hotspot.tenderUnit)
      || isDirtyStructuredText(hotspot.tenderContact)
      || isDirtyStructuredText(hotspot.tenderPhone)
      || shouldResetSuspiciousPhone(hotspot)
    )
    .map((hotspot) => {
      const extracted = extractTenderDetailFields({
        title: hotspot.title,
        content: hotspot.content,
        url: hotspot.url,
        source: hotspot.source as 'szggzy' | 'szygcgpt' | 'guangdong' | 'gzebpubservice',
        tender: {
          unit: hotspot.tenderUnit ?? undefined,
          budgetWan: hotspot.tenderBudgetWan ?? undefined,
          deadline: hotspot.tenderDeadline ?? undefined,
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
          detailExtractedAt: hotspot.tenderDetailExtractedAt ?? undefined,
        },
      });

      return {
        id: hotspot.id,
        source: hotspot.source,
        title: hotspot.title,
        reset: {
          tenderUnit: (isDirtyStructuredText(hotspot.tenderUnit) || isWeakTenderUnit(hotspot.tenderUnit))
            ? (sanitizeTenderUnit(extracted.unit) ?? sanitizeTenderUnit(hotspot.tenderUnit))
            : hotspot.tenderUnit,
          tenderContact: isDirtyStructuredText(hotspot.tenderContact)
            ? (cleanTenderContact(extracted.contact) ?? null)
            : hotspot.tenderContact,
          tenderPhone: isDirtyStructuredText(hotspot.tenderPhone)
            ? (cleanTenderPhone(extracted.phone) ?? null)
            : (shouldResetSuspiciousPhone(hotspot) ? null : hotspot.tenderPhone),
        },
      };
    });

  const malformedUrlRows = hotspots
    .filter((hotspot) => isMalformedTenderUrl(hotspot.url, hotspot.source))
    .map((hotspot) => ({
      id: hotspot.id,
      source: hotspot.source,
      title: hotspot.title,
      url: hotspot.url,
    }));

  const removableLowValueRows = hotspots
    .filter((hotspot) => isRemovableLowValueHotspot(hotspot))
    .map((hotspot) => ({
      id: hotspot.id,
      source: hotspot.source,
      title: hotspot.title,
      url: hotspot.url,
    }));

  const suspiciousPhoneRows = hotspots
    .filter((hotspot) => shouldResetSuspiciousPhone(hotspot))
    .map((hotspot) => ({
      id: hotspot.id,
      source: hotspot.source,
      title: hotspot.title,
      phone: hotspot.tenderPhone,
    }));

  const legacyRows = purgeLegacy
    ? await prisma.hotspot.findMany({
        where: {
          source: {
            notIn: [...TENDER_SOURCES],
          },
        },
        select: {
          id: true,
          source: true,
          title: true,
        },
      })
    : [];

  const summary = {
    dirtyFieldRepairs: dirtyFieldRepairs.length,
    malformedUrlRows: malformedUrlRows.length,
    removableLowValueRows: removableLowValueRows.length,
    suspiciousPhoneRows: suspiciousPhoneRows.length,
    legacyRows: legacyRows.length,
    apply,
    purgeLegacy,
  };

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      summary,
      dirtyFieldRepairs: dirtyFieldRepairs.slice(0, 10),
      malformedUrlRows: malformedUrlRows.slice(0, 10),
      removableLowValueRows: removableLowValueRows.slice(0, 10),
      suspiciousPhoneRows: suspiciousPhoneRows.slice(0, 10),
      legacyRows: legacyRows.slice(0, 10),
    }, null, 2));
    return;
  }

  let updated = 0;
  for (const item of dirtyFieldRepairs) {
    await prisma.hotspot.update({
      where: { id: item.id },
      data: {
        ...item.reset,
        tenderDetailExtractedAt: null,
      },
    });
    enqueueHotspotDetailEnrichment(item.id);
    updated += 1;
  }

  let deletedMalformed = 0;
  if (malformedUrlRows.length > 0) {
    const result = await prisma.hotspot.deleteMany({
      where: {
        id: {
          in: malformedUrlRows.map((item) => item.id),
        },
      },
    });
    deletedMalformed = result.count;
  }

  let deletedLowValue = 0;
  if (removableLowValueRows.length > 0) {
    const result = await prisma.hotspot.deleteMany({
      where: {
        id: {
          in: removableLowValueRows.map((item) => item.id),
        },
      },
    });
    deletedLowValue = result.count;
  }

  let deletedLegacy = 0;
  if (purgeLegacy && legacyRows.length > 0) {
    const result = await prisma.hotspot.deleteMany({
      where: {
        id: {
          in: legacyRows.map((item) => item.id),
        },
      },
    });
    deletedLegacy = result.count;
  }

  await waitForDetailQueue();

  const remainingDirty = await prisma.hotspot.count({
    where: {
      source: {
        in: [...TENDER_SOURCES],
      },
      OR: [
        { tenderUnit: { contains: '项目名称' } },
        { tenderUnit: { contains: '预算金额' } },
        { tenderUnit: { contains: '联系人' } },
        { tenderUnit: { contains: '联系电话' } },
        { tenderUnit: { contains: '联系地址' } },
        { tenderUnit: '万元' },
        { tenderUnit: '元' },
        { tenderContact: { contains: '联系电话' } },
        { tenderContact: { contains: '预算' } },
        { tenderPhone: { contains: '联系人' } },
        { tenderPhone: { contains: '地址' } },
      ],
    },
  });

  const remainingMalformed = await prisma.hotspot.count({
    where: {
      source: {
        in: [...TENDER_SOURCES],
      },
      OR: [
        { url: { contains: '#/show-bid-opening/list/' } },
        { url: { contains: 'purchaseInfoDetail' } },
      ],
    },
  });

  const tenderCount = await prisma.hotspot.count({
    where: { source: { in: [...TENDER_SOURCES] } },
  });

  console.log(JSON.stringify({
    mode: 'apply',
    summary,
    updatedDirtyRows: updated,
    deletedMalformed,
    deletedLowValue,
    deletedLegacy,
    remainingDirty,
    remainingMalformed,
    tenderCount,
    queue: getDetailEnrichmentQueueState(),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('Tender data repair failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
