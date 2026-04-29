import type { TenderMetadata } from '../types.js';
import { generateStructuredJson, getOpenClawDetailOptions } from './llmProvider.js';
import {
  cleanTenderContact,
  cleanTenderPhone,
  cleanTenderServiceScope,
  cleanTenderUnit,
  isUsableTenderContact,
  isUsableTenderPhone,
  isUsableTenderUnit,
} from './tenderFieldQuality.js';

type AgentDetailResponse = {
  unit?: string | null;
  budgetWan?: number | string | null;
  deadline?: string | null;
  projectCode?: string | null;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  bidOpenTime?: string | null;
  docDeadline?: string | null;
  serviceScope?: string | null;
  qualification?: string | null;
  address?: string | null;
  confidence?: 'high' | 'medium' | 'low' | 'blocked' | 'not_found' | string | null;
  evidence?: string[] | null;
};

export type TenderDetailAgentInput = {
  title: string;
  url: string;
  source: string;
  content: string;
  current?: TenderMetadata;
};

function isEnabledFlag(value: string | null | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function isTenderDetailAgentEnabled(): boolean {
  if (process.env.TENDER_DETAIL_AGENT_ENABLED === 'false') return false;
  return process.env.AI_PROVIDER === 'openclaw' || isEnabledFlag(process.env.TENDER_DETAIL_AGENT_ENABLED);
}

function normalizeString(value: unknown, maxLength = 1000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || ['无', '未披露', '不详', 'null', 'undefined'].includes(normalized)) return undefined;
  return normalized.slice(0, maxLength);
}

function parseAmountWan(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;

  const text = value.replace(/,/g, '').trim();
  const amount = Number.parseFloat(text.match(/[\d.]+/)?.[0] ?? '');
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (/万/.test(text)) return amount;
  if (/元/.test(text) || amount >= 10000) return amount / 10000;
  return amount;
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;

  const normalized = value
    .replace(/年|\/|\./g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/时|点/g, ':')
    .replace(/分/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return undefined;

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function compactContent(content: string): string {
  return content
    .replace(/\r/g, '\n')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]+\)/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 6000);
}

function buildPrompt(input: TenderDetailAgentInput): string {
  return [
    '你是 bim-tender 招采详情字段提取 agent。',
    '任务：逐条进入公告详情页或基于已抓取正文，提取公司投标决策需要的结构化字段。',
    '如果你的运行环境有浏览器/网页访问工具，请优先打开 URL，等待页面渲染完成后读取正文；如果页面被 WAF、验证码、登录或空壳页阻断，请不要猜测，confidence 返回 blocked 或 not_found。',
    '只提取页面或正文中明确出现的信息，不得根据标题、行业经验或常识补编。',
    'budgetWan 必须使用万元；页面为元时换算为万元。',
    'deadline 优先投标/响应文件递交截止时间；bidOpenTime 是开标/开启时间；docDeadline 是文件获取/报名截止时间。',
    '返回 JSON，不要解释，不要 Markdown。',
    'JSON 字段：unit,budgetWan,deadline,projectCode,contact,phone,email,bidOpenTime,docDeadline,serviceScope,qualification,address,confidence,evidence。',
    `来源：${input.source}`,
    `标题：${input.title}`,
    `URL：${input.url}`,
    `已有字段：${JSON.stringify(input.current ?? {})}`,
    `已抓取正文：\n${compactContent(input.content)}`
  ].join('\n\n');
}

export async function extractTenderDetailWithAgent(input: TenderDetailAgentInput): Promise<TenderMetadata | null> {
  if (!isTenderDetailAgentEnabled()) return null;

  try {
    const parsed = await generateStructuredJson<AgentDetailResponse>([
      {
        role: 'system',
        content: '你只能返回严格 JSON。字段没有明确证据时返回 null。'
      },
      {
        role: 'user',
        content: buildPrompt(input)
      }
    ], {
      temperature: 0.1,
      maxTokens: 1200,
      openclaw: getOpenClawDetailOptions({ sessionPrefix: 'detail-enrichment' })
    });

    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const confidence = normalizeString(parsed.confidence, 32);
    if (confidence === 'blocked' || confidence === 'not_found') return null;
    if (evidence.some((item) => /request has been blocked|potential threats|405\.png|_waf_|验证码|安全验证|VAPTCHA|captcha/i.test(item))) return null;
    if (input.source === 'cebpubservice' && evidence.length === 0) return null;

    const unit = cleanTenderUnit(parsed.unit);
    const contact = cleanTenderContact(parsed.contact);
    const phone = cleanTenderPhone(parsed.phone);
    const serviceScope = cleanTenderServiceScope(parsed.serviceScope);

    const extracted: TenderMetadata = {
      unit: isUsableTenderUnit(unit) ? (unit ?? undefined) : undefined,
      budgetWan: parseAmountWan(parsed.budgetWan),
      deadline: parseDate(parsed.deadline),
      projectCode: normalizeString(parsed.projectCode, 120),
      contact: isUsableTenderContact(contact) ? (contact ?? undefined) : undefined,
      phone: isUsableTenderPhone(phone) ? (phone ?? undefined) : undefined,
      email: normalizeString(parsed.email, 120),
      bidOpenTime: parseDate(parsed.bidOpenTime),
      docDeadline: parseDate(parsed.docDeadline),
      serviceScope: serviceScope ?? undefined,
      qualification: normalizeString(parsed.qualification, 1200),
      address: normalizeString(parsed.address, 240),
      detailSource: parsed.confidence === 'blocked' || parsed.confidence === 'not_found'
        ? `detail-enrichment+openclaw-browser:${parsed.confidence}`
        : 'detail-enrichment+openclaw-browser',
      detailExtractedAt: new Date()
    };

    const hasUsefulField = Boolean(
      extracted.unit
      || extracted.budgetWan != null
      || extracted.deadline
      || extracted.projectCode
      || extracted.contact
      || extracted.phone
      || extracted.email
      || extracted.bidOpenTime
      || extracted.docDeadline
      || extracted.serviceScope
      || extracted.qualification
      || extracted.address
    );

    return hasUsefulField ? extracted : null;
  } catch (error) {
    console.warn('OpenClaw detail extraction failed:', error instanceof Error ? error.message : error);
    return null;
  }
}
