import dotenv from 'dotenv';
import { prisma } from '../db.js';

dotenv.config();

const OFFICIAL_LIST_DETAIL_SOURCE = 'ceb-list+official-table:v1.5';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function inferNoticeType(title: string): string {
  const patterns = [
    '资格预审公告',
    '竞争性磋商公告',
    '竞争性谈判公告',
    '谈判采购',
    '询比采购公告',
    '询比采购',
    '询价公告',
    '集中比选公告',
    '比选公告',
    '公开招标公告',
    '招标公告',
    '采购公告',
    '项目任务'
  ];
  return patterns.find(pattern => title.includes(pattern)) || '招标采购公告';
}

function inferServiceScope(title: string): string | null {
  const cleaned = normalizeWhitespace(title)
    .replace(/[.。·\s]*\.\s*\.\s*\.$/, '')
    .replace(/[-—_]*\s*(资格预审公告|竞争性磋商公告|竞争性谈判公告|询比采购公告|询价公告|集中比选公告|比选公告|公开招标公告|招标公告|采购公告|项目任务)\s*$/g, '')
    .replace(/[（(]重新招标[）)]$/g, '')
    .trim();
  return cleaned.length >= 4 ? cleaned.slice(0, 180) : null;
}

function isWeakUnit(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value);
  return !normalized || /^(万元|元|预算金额|采购单位|招标人|信息|公告信息)$/.test(normalized);
}

function isBogusContact(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value);
  return !normalized || /^(张三|李四|王五|测试|联系人|项目联系人)$/.test(normalized);
}

function isBogusPhone(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return true;
  if (/^(123456789|1234567890|12345678901)$/.test(normalized)) return true;
  return !/(?:0\d{2,3}[-\s]?)?\d{7,8}(?:-\d+)?|1[3-9]\d{9}/.test(normalized);
}

function isTrustedCebDetailSource(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (normalized.startsWith(OFFICIAL_LIST_DETAIL_SOURCE)) return false;
  if (normalized === 'ceb-detail-api+des') return true;
  if (normalized.startsWith('detail-enrichment+openclaw-browser') && !/:(blocked|not_found)/.test(normalized)) return true;
  return false;
}

function resolveNoticeType(current: string | null | undefined, title: string, preferOfficialList: boolean): string {
  const inferred = inferNoticeType(title);
  const normalized = normalizeWhitespace(current);
  if (!normalized || preferOfficialList) return inferred;
  if (normalized === '招标公告' || normalized === '招标采购公告') return inferred;
  return normalized;
}

function resolveServiceScope(current: string | null | undefined, title: string, preferOfficialList: boolean): string | null {
  const inferred = inferServiceScope(title);
  const normalized = normalizeWhitespace(current);
  if (!normalized || preferOfficialList) return inferred;
  if (/^(项目范围包括|软件开发和系统集成|详见采购文件|详见招标文件)/.test(normalized)) return inferred;
  return normalized;
}

function mergeContent(content: string, lines: string[]): string {
  const baseContent = content
    .split(/--- Agent Detail Enrichment ---|--- OpenClaw Agent Detail Extraction ---|--- v1\.5 CEB 列表字段回填 ---/)[0]
    ?.trim() || content;
  const additions = lines.filter(line => line && !baseContent.includes(line));
  if (!additions.length) return baseContent;
  return [baseContent, '--- v1.5 CEB 列表字段回填 ---', ...additions].filter(Boolean).join('\n');
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const hotspots = await prisma.hotspot.findMany({
    where: { source: 'cebpubservice' },
    orderBy: { createdAt: 'desc' }
  });

  let changed = 0;
  const previews: Array<{ id: string; title: string; updates: Record<string, unknown> }> = [];

  for (const hotspot of hotspots) {
    const keepTrustedDetail = isTrustedCebDetailSource(hotspot.tenderDetailSource);
    const noticeType = resolveNoticeType(hotspot.tenderNoticeType, hotspot.title, !keepTrustedDetail);
    const serviceScope = resolveServiceScope(hotspot.tenderServiceScope, hotspot.title, !keepTrustedDetail);
    const detailSource = keepTrustedDetail
      ? (hotspot.tenderDetailSource || OFFICIAL_LIST_DETAIL_SOURCE)
      : OFFICIAL_LIST_DETAIL_SOURCE;
    const bidOpenTime = hotspot.tenderBidOpenTime || hotspot.tenderDeadline;
    const content = mergeContent(hotspot.content, [
      `公告类型：${noticeType}`,
      serviceScope ? `服务范围：${serviceScope}` : '',
      bidOpenTime ? `开标时间：${bidOpenTime.toLocaleString('zh-CN', { hour12: false })}` : '',
      '详情策略：v1.5 使用官方列表字段稳定解析；SPA 详情接口触发 WAF/JS challenge 时降级，不阻塞定时扫描'
    ]);

    const data = {
      tenderNoticeType: noticeType,
      tenderServiceScope: serviceScope,
      tenderBidOpenTime: bidOpenTime,
      tenderDeadline: hotspot.tenderDeadline || bidOpenTime,
      tenderUnit: !keepTrustedDetail || isWeakUnit(hotspot.tenderUnit) ? null : hotspot.tenderUnit,
      tenderBudgetWan: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE)
        ? null
        : (hotspot.tenderBudgetWan != null && hotspot.tenderBudgetWan > 0 ? hotspot.tenderBudgetWan : null),
      tenderProjectCode: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) ? null : hotspot.tenderProjectCode,
      tenderContact: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) || isBogusContact(hotspot.tenderContact) ? null : hotspot.tenderContact,
      tenderPhone: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) || isBogusPhone(hotspot.tenderPhone) ? null : hotspot.tenderPhone,
      tenderEmail: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) ? null : hotspot.tenderEmail,
      tenderDocDeadline: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) ? null : hotspot.tenderDocDeadline,
      tenderQualification: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) ? null : hotspot.tenderQualification,
      tenderAddress: detailSource.startsWith(OFFICIAL_LIST_DETAIL_SOURCE) ? null : hotspot.tenderAddress,
      tenderDetailSource: detailSource,
      tenderDetailExtractedAt: hotspot.tenderDetailExtractedAt || new Date(),
      content
    };

    const needsUpdate = (
      hotspot.tenderNoticeType !== data.tenderNoticeType
      || hotspot.tenderServiceScope !== data.tenderServiceScope
      || hotspot.tenderBidOpenTime?.getTime() !== data.tenderBidOpenTime?.getTime()
      || hotspot.tenderDeadline?.getTime() !== data.tenderDeadline?.getTime()
      || hotspot.tenderUnit !== data.tenderUnit
      || hotspot.tenderBudgetWan !== data.tenderBudgetWan
      || hotspot.tenderProjectCode !== data.tenderProjectCode
      || hotspot.tenderContact !== data.tenderContact
      || hotspot.tenderPhone !== data.tenderPhone
      || hotspot.tenderEmail !== data.tenderEmail
      || hotspot.tenderDocDeadline?.getTime() !== data.tenderDocDeadline?.getTime()
      || hotspot.tenderQualification !== data.tenderQualification
      || hotspot.tenderAddress !== data.tenderAddress
      || hotspot.tenderDetailSource !== data.tenderDetailSource
      || hotspot.content !== data.content
    );

    if (!needsUpdate) continue;
    changed += 1;
    if (previews.length < 8) {
      previews.push({
        id: hotspot.id,
        title: hotspot.title,
        updates: {
          tenderNoticeType: data.tenderNoticeType,
          tenderServiceScope: data.tenderServiceScope,
          tenderBidOpenTime: data.tenderBidOpenTime,
          tenderDetailSource: data.tenderDetailSource
        }
      });
    }

    if (apply) {
      await prisma.hotspot.update({
        where: { id: hotspot.id },
        data
      });
    }
  }

  console.log(JSON.stringify({
    source: 'cebpubservice',
    mode: apply ? 'apply' : 'dry-run',
    total: hotspots.length,
    changed,
    previews
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
