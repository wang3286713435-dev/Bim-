import type { SearchResult, TenderMetadata } from '../types.js';

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ');
}

function normalizeText(value: string | null | undefined): string {
  return stripHtml(value ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compact(value: string | null | undefined, maxLength = 240): string | undefined {
  const text = normalizeText(value)
    .replace(/^[：:\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function sanitizeTenderUnit(value: string | null | undefined): string | undefined {
  const text = compact(value, 120);
  if (!text) return undefined;
  const cleaned = text
    .split(/(?:项目名称|预算金额|联系地址|招标人联系人|项目联系人|联系人|联系电话|招标代理机构)/)[0]
    ?.trim()
    .replace(/[：:\s]+$/, '');
  return cleaned || undefined;
}

function pick(text: string, patterns: RegExp[], maxLength = 120): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const raw = match?.[1] ?? match?.[2];
    const value = compact(raw, maxLength);
    if (value) return value;
  }
  return undefined;
}

function parseAmountWan(text: string): number | undefined {
  const wan = text.match(/(?:预算|控制价|最高限价|估算价|合同估算价|招标控制价)[^\d]{0,20}([\d,.]+)\s*万(?:元)?/i)
    || text.match(/([\d,.]+)\s*万(?:元)?/i);
  if (wan) {
    const amount = Number.parseFloat(wan[1].replace(/,/g, ''));
    return Number.isFinite(amount) ? amount : undefined;
  }

  const yuan = text.match(/(?:预算|控制价|最高限价|估算价|合同估算价|招标控制价)[^\d]{0,20}([\d,.]+)\s*元/i);
  if (yuan) {
    const amount = Number.parseFloat(yuan[1].replace(/,/g, ''));
    return Number.isFinite(amount) ? amount / 10000 : undefined;
  }

  return undefined;
}

function parseDateCandidate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
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
  const date = new Date(`${match[1]}T${time.length === 5 ? `${time}:00` : time}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pickDate(text: string, labels: string[]): Date | undefined {
  for (const label of labels) {
    const pattern = new RegExp(`${label}[：:\\s]*([^\\n]{0,100})`);
    const match = text.match(pattern);
    const date = parseDateCandidate(match?.[1]);
    if (date) return date;
  }
  return undefined;
}

function section(text: string, labels: string[], maxLength = 600): string | undefined {
  for (const label of labels) {
    const pattern = new RegExp(`${label}[：:\\s]*([\\s\\S]{20,${maxLength}}?)(?:\\n\\s*\\n|投标人|供应商|申请人|开标|递交|获取|联系人|联系电话|$)`);
    const value = compact(text.match(pattern)?.[1], maxLength);
    if (value) return value;
  }
  return undefined;
}

function extractTableFields(rawText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  for (const match of rawText.matchAll(pattern)) {
    const label = compact(stripHtml(match[1]), 80)?.replace(/[：:]\s*$/, '');
    const value = compact(stripHtml(match[2]), 500);
    if (!label || !value) continue;
    fields[label] = value;
  }
  return fields;
}

export function extractTenderDetailFields(result: SearchResult): TenderMetadata {
  const rawText = `${result.title}\n${result.content}`;
  const text = normalizeText(rawText);
  const tableFields = extractTableFields(rawText);
  const deadline = pickDate(text, [
    '投标文件递交截止时间',
    '递交投标文件截止时间',
    '响应文件提交截止时间',
    '提交投标文件截止时间',
    '投标截止时间',
    '报价截止时间',
    '竞价截止时间',
    '截止时间'
  ]);
  const bidOpenTime = pickDate(text, ['开标时间', '开启时间']);
  const docDeadline = pickDate(text, [
    '招标文件获取截止时间',
    '采购文件获取截止时间',
    '文件获取截止时间',
    '报名截止时间',
    '获取文件截止时间'
  ]);

  const unit = pick(text, [
    /(?:招标人|采购人|建设单位|发包人|业主单位|采购单位)[：:\s]*([^\n；;，,]{2,80})/,
    /(?:招标单位|采购单位)[：:\s]*([^\n；;，,]{2,80})/
  ], 80);

  const projectCode = pick(text, [
    /(?:项目编号|招标编号|采购编号|工程编号|标段编号|项目代码|项目统一编码)[：:\s]*([A-Za-z0-9\-_/（）()]+)/
  ], 80);

  const phone = pick(text, [
    /(?:联系电话|联系人电话|电话|联系方式)[：:\s]*((?:0\d{2,3}[-\s]?)?\d{7,8}(?:-\d+)?|1[3-9]\d{9})/
  ], 40);

  const contact = pick(text, [
    /(?:项目联系人|联系人|招标联系人|采购联系人)[：:\s]*([^\n；;，,电话联系方式]{2,30})/
  ], 40);

  const email = pick(text, [
    /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/
  ], 80);

  const address = pick(text, [
    /(?:开标地点|递交地点|投标地点|项目地点|建设地点|服务地点)[：:\s]*([^\n]{3,120})/
  ], 120);

  return {
    ...result.tender,
    unit: sanitizeTenderUnit(tableFields['采购单位'])
      || sanitizeTenderUnit(tableFields['招标人'])
      || sanitizeTenderUnit(tableFields['采购人'])
      || sanitizeTenderUnit(result.tender?.unit)
      || sanitizeTenderUnit(unit),
    budgetWan: result.tender?.budgetWan ?? (
      (() => {
        const directYuan = tableFields['预算金额（元）'] || tableFields['预算金额(元)'] || tableFields['预算金额'] || tableFields['招标控制价'];
        if (directYuan) {
          const numeric = Number.parseFloat(directYuan.replace(/,/g, '').replace(/[^\d.]/g, ''));
          if (Number.isFinite(numeric)) return numeric >= 10000 ? numeric / 10000 : numeric;
        }
        return parseAmountWan(text);
      })()
    ),
    deadline: result.tender?.deadline || deadline || bidOpenTime,
    projectCode,
    contact: tableFields['联系人'] || contact,
    phone: tableFields['联系电话'] || tableFields['联系人电话'] || phone,
    email,
    bidOpenTime,
    docDeadline,
    serviceScope: tableFields['采购需求概况'] || section(text, ['招标范围', '采购内容', '服务内容', '项目概况', '建设内容', '工作内容']),
    qualification: section(text, ['投标人资格要求', '供应商资格要求', '资格要求', '资质要求']),
    address,
    detailSource: result.content.includes('--- Firecrawl 正文 ---') ? 'firecrawl+rules' : 'source-detail+rules',
    detailExtractedAt: new Date()
  };
}
