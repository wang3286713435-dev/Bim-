export type TenderStageCategory =
  | 'formal_notice'
  | 'prequalification_notice'
  | 'procurement_intent'
  | 'tender_plan'
  | 'change_notice'
  | 'result_notice'
  | 'contract_notice'
  | 'unknown';

export type TenderStageBucket = 'actionable' | 'pre-signal' | 'change' | 'closed' | 'unknown';

export interface TenderStageInfo {
  category: TenderStageCategory;
  label: string;
  bucket: TenderStageBucket;
  actionable: boolean;
}

const RESULT_PATTERNS = /(中标|成交|结果公告|结果公示|候选人公示|候选人结果|成交结果|中标结果|中选结果|定标结果|评标结果|开标情况|开标记录|中选候选人|入围结果)/i;
const CONTRACT_PATTERNS = /(合同公开|合同公告|合同签订|合同信息|履约|验收结果|验收公告)/i;
const PROCUREMENT_INTENT_PATTERNS = /(采购意向|意向公开|采购需求|需求调查|需求公示|采购意向公告)/i;
const TENDER_PLAN_PATTERNS = /(招标计划|发包计划|项目计划|预公告|招标预告|采购计划公告)/i;
const CHANGE_PATTERNS = /(更正公告|变更公告|补遗|澄清|答疑|延期|终止公告|终止|中止|异常公告|暂停公告|更正|变更)/i;
const PREQUALIFICATION_PATTERNS = /(资格预审|预审公告|资格审查公告)/i;
const FORMAL_NOTICE_PATTERNS = /(招标公告|采购公告|公开招标|邀请招标|邀请函|邀请书|竞争性磋商|竞争性谈判|询价公告|比选公告|遴选公告|竞价公告|询比公告|询比价|谈判采购|单一来源|征集公告|招募公告|发包公告)/i;

function normalizeNoticeText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildStageInfo(
  category: TenderStageCategory,
  label: string,
  bucket: TenderStageBucket,
  actionable: boolean
): TenderStageInfo {
  return {
    category,
    label,
    bucket,
    actionable
  };
}

export function classifyTenderStage(input: {
  tenderNoticeType?: string | null;
  title?: string | null;
  content?: string | null;
}): TenderStageInfo {
  const noticeType = input.tenderNoticeType?.trim() || '';
  const title = input.title?.trim() || '';
  const headlineText = normalizeNoticeText(noticeType, title);
  const fullText = normalizeNoticeText(noticeType, title, input.content);

  if (CONTRACT_PATTERNS.test(headlineText)) {
    return buildStageInfo('contract_notice', '合同履约', 'closed', false);
  }

  if (RESULT_PATTERNS.test(headlineText)) {
    return buildStageInfo('result_notice', '结果公示', 'closed', false);
  }

  if (PROCUREMENT_INTENT_PATTERNS.test(headlineText)) {
    return buildStageInfo('procurement_intent', '采购意向', 'pre-signal', false);
  }

  if (TENDER_PLAN_PATTERNS.test(headlineText)) {
    return buildStageInfo('tender_plan', '招标计划', 'pre-signal', false);
  }

  if (CHANGE_PATTERNS.test(headlineText)) {
    return buildStageInfo('change_notice', '变更补遗', 'change', true);
  }

  if (PREQUALIFICATION_PATTERNS.test(headlineText)) {
    return buildStageInfo('prequalification_notice', '资格预审', 'actionable', true);
  }

  if (FORMAL_NOTICE_PATTERNS.test(headlineText)) {
    return buildStageInfo('formal_notice', '正式公告', 'actionable', true);
  }

  const isGenericActionable = /(公告|公示|邀请函|邀请书)/.test(headlineText) && !/(意向|计划|合同|结果)/.test(headlineText);
  if (isGenericActionable && /(采购需求|报名|投标文件|招标文件|开标时间|递交投标文件)/.test(fullText)) {
    return buildStageInfo('formal_notice', noticeType || '正式公告', 'actionable', true);
  }

  return buildStageInfo('unknown', noticeType || '待判定', isGenericActionable ? 'actionable' : 'unknown', isGenericActionable);
}
