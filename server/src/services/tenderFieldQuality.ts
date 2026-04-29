const STRUCTURED_POLLUTION_PATTERN = /(项目名称|预算金额|采购需求概况|联系人|联系电话|联系地址|招标代理机构|采购单位|招标人)[：:]/;
const DETAIL_BLOCKED_PATTERN = /blocked|waf|challenge|captcha|验证码|安全验证|404|bad-link|unhealthy|forbidden|被阻断/i;
const MOBILE_PHONE_PATTERN = /1[3-9]\d{9}/;
const LANDLINE_PHONE_PATTERN = /0\d{2,3}[-\s]?\d{7,8}(?:-\d+)?/;
const LOCAL_PHONE_PATTERN = /(?<!\d)\d{7,8}(?!\d)/;
const PHONE_PATTERN = new RegExp(`${MOBILE_PHONE_PATTERN.source}|${LANDLINE_PHONE_PATTERN.source}|${LOCAL_PHONE_PATTERN.source}`);

export type TenderDetailSourceCategory = 'missing' | 'blocked' | 'list_only' | 'deep' | 'rules';

export function normalizeFieldText(value: unknown, maxLength = 1000): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const normalized = String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized ? normalized.slice(0, maxLength) : null;
}

function stripFieldWrappers(value: unknown, maxLength = 1000): string | null {
  const normalized = normalizeFieldText(value, maxLength);
  if (!normalized) return null;

  const cleaned = normalized
    .replace(/[`*_#]/g, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || null;
}

export function looksNoisyStructuredValue(value: unknown): boolean {
  const normalized = normalizeFieldText(value, 300);
  if (!normalized) return false;
  return STRUCTURED_POLLUTION_PATTERN.test(normalized) || /\|.+\|/.test(normalized);
}

export function cleanTenderUnit(value: unknown): string | null {
  const normalized = stripFieldWrappers(value, 180);
  if (!normalized) return null;

  const cleaned = normalized
    .replace(/^(招标人|采购人|采购单位|建设单位|业主单位|发包人|项目法人|采购机构)(?:名称)?(?:为)?[：:\s]*/, '')
    .replace(/^为[：:\s]*/, '')
    .replace(/[（(]以下简称[^）)]*[）)]/g, '')
    .replace(/[，,；;。]\s*(项目已具备|建设资金|出资比例|现对|地址|联系人|电话|联系方式|采购项目).*$/, '')
    .split(/(?:项目名称|预算金额|采购需求概况|联系地址|招标人联系人|项目联系人|联系人|联系电话|联系方式|招标代理机构|采购代理机构)/)[0]
    ?.trim()
    .replace(/[。：:\s]+$/, '');

  if (!cleaned || cleaned.length <= 3 || cleaned.length > 120) return null;
  if (/^(万元|元|预算金额|采购单位|招标人|采购人|招标代理|代理机构|与招标代理|信息|公告信息|详见公告)$/.test(cleaned)) return null;
  if (STRUCTURED_POLLUTION_PATTERN.test(cleaned)) return null;
  if (/(中小企业采购|潜在投标人|潜在供应商|潜在申请人|资格要求|详见|应当专门面向)/.test(cleaned)) return null;
  if (/(\.pdf|授权代表证明书|招标申请函|提供的项目基础资料|设计任务书|工程管理要求|声明\.pdf|项目概况及招标范围)/i.test(cleaned)) return null;
  if (/[；;。]/.test(cleaned) && cleaned.length > 24) return null;
  if (PHONE_PATTERN.test(cleaned)) return null;
  return cleaned;
}

export function looksWeakTenderUnit(value: unknown): boolean {
  const normalized = normalizeFieldText(value, 180);
  if (!normalized) return true;
  if (/^(?:为|招标人为|采购人为|采购单位为|建设单位为|业主单位为)/.test(normalized)) return true;
  if (/[|｜]|以下简称|中小企业采购|潜在投标人|潜在供应商|潜在申请人/.test(normalized)) return true;
  return !cleanTenderUnit(normalized);
}

export function isUsableTenderUnit(value: unknown): boolean {
  return Boolean(cleanTenderUnit(value)) && !looksNoisyStructuredValue(value) && !looksWeakTenderUnit(value);
}

export function isUsableBudgetWan(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

export function cleanTenderContact(value: unknown): string | null {
  const normalized = stripFieldWrappers(value, 100);
  if (!normalized) return null;

  const withoutPhone = normalized
    .replace(/^(联系人及电话|联系人姓名|项目联系人|采购联系人|招标联系人|联系人|经办人|项目负责人)[：:\s]*/, '')
    .replace(/(?:联系电话|联系人电话|联系方式|电话)[：:\s]*.*$/, '')
    .replace(PHONE_PATTERN, '')
    .split(/[，,；;、]/)[0]
    ?.trim()
    .replace(/[：:\s]+$/, '');

  if (!withoutPhone || withoutPhone.length < 2 || withoutPhone.length > 30) return null;
  if (/^(张三|李四|王五|测试|联系人|项目联系人|采购联系人|招标联系人|无|暂无|详见公告|详见)$/.test(withoutPhone)) return null;
  if (/(项目名称|预算金额|采购需求|联系电话|联系方式|联系地址|招标代理|采购代理|资格要求|详见|地址)/.test(withoutPhone)) return null;
  if (/(证书|合格|授权|声明|申请函|投标人|投标文件|资格)/.test(withoutPhone)) return null;
  if (/^\d+$/.test(withoutPhone)) return null;
  return withoutPhone;
}

export function isUsableTenderContact(value: unknown): boolean {
  return Boolean(cleanTenderContact(value));
}

export function cleanTenderPhone(value: unknown): string | null {
  const normalized = stripFieldWrappers(value, 120);
  if (!normalized) return null;

  const match = normalized.match(MOBILE_PHONE_PATTERN)
    || normalized.match(LANDLINE_PHONE_PATTERN)
    || normalized.match(LOCAL_PHONE_PATTERN);
  if (!match) return null;

  const phone = match[0].replace(/\s+/g, '');
  if (/^(12345678901|1234567890|00000000|00000000000|11111111|11111111111)$/.test(phone.replace(/-/g, ''))) {
    return null;
  }
  if (/^0755-?36568999$/.test(phone)) {
    return null;
  }
  return phone;
}

export function isUsableTenderPhone(value: unknown): boolean {
  return Boolean(cleanTenderPhone(value));
}

export function cleanTenderServiceScope(value: unknown): string | null {
  const normalized = normalizeFieldText(value, 1600);
  if (!normalized) return null;

  let cleaned = normalized
    .replace(/[`*_#]/g, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[：:\s-]+/, '')
    .trim();
  for (let index = 0; index < 3; index += 1) {
    cleaned = cleaned
      .replace(/^(?:\d+(?:\.\d+)*\s*)?(项目概况|工程概况|工程范围(?:及主要内容)?|主要内容|及主要内容|招标范围|采购内容|服务内容|采购需求概况|工作内容)[：:\s]*/, '')
      .replace(/^[：:\s-]+/, '')
      .trim();
  }

  if (!cleaned || cleaned.length < 10) return null;
  if (/^(详见|具体详见|以招标文件|见采购文件|详见公告)[^，。；;]{0,20}$/.test(cleaned)) return null;
  if (STRUCTURED_POLLUTION_PATTERN.test(cleaned) && cleaned.length < 80) return null;
  return cleaned.slice(0, 1000);
}

export function isUsableTenderServiceScope(value: unknown): boolean {
  return Boolean(cleanTenderServiceScope(value));
}

export function classifyTenderDetailSource(value: unknown): TenderDetailSourceCategory {
  const normalized = normalizeFieldText(value, 160)?.toLowerCase();
  if (!normalized) return 'missing';
  if (DETAIL_BLOCKED_PATTERN.test(normalized)) return 'blocked';
  if (/list|official-table|source-list/.test(normalized)) return 'list_only';
  if (/firecrawl|agent|openclaw|browser|detail-api|source-detail|szggzy-api/.test(normalized)) return 'deep';
  return 'rules';
}

export function getTenderDirtyIssues(item: {
  tenderUnit?: string | null;
  tenderBudgetWan?: number | null;
  tenderContact?: string | null;
  tenderPhone?: string | null;
  tenderServiceScope?: string | null;
  tenderDetailSource?: string | null;
}): string[] {
  const issues: string[] = [];

  if (item.tenderUnit && !isUsableTenderUnit(item.tenderUnit)) {
    issues.push('单位字段疑似污染');
  }
  if (item.tenderBudgetWan != null && !isUsableBudgetWan(item.tenderBudgetWan)) {
    issues.push('预算金额疑似异常');
  }
  if (item.tenderContact && !isUsableTenderContact(item.tenderContact)) {
    issues.push('联系人字段疑似污染');
  }
  if (item.tenderPhone && !isUsableTenderPhone(item.tenderPhone)) {
    issues.push('联系电话疑似异常');
  }
  if (item.tenderServiceScope && !isUsableTenderServiceScope(item.tenderServiceScope)) {
    issues.push('服务范围字段疑似污染');
  }
  if (classifyTenderDetailSource(item.tenderDetailSource) === 'blocked') {
    issues.push('详情链路可信度低');
  }

  return issues;
}
