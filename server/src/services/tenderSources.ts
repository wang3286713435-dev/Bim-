import axios from 'axios';
import { AxiosError } from 'axios';
import { load } from 'cheerio';
import CryptoJS from 'crypto-js';
import type { SearchResult, TenderMetadata } from '../types.js';
import { getRuntimeConfig } from './runtimeConfig.js';
import { axiosWithSourceProxy, axiosWithSourceProxyDetailed, markProxySoftFailure } from './proxyPool.js';
import { extractTenderDetailFields } from './tenderDetailExtractor.js';

class RateLimiter {
  private lastRequestTime = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

const szggzyLimiter = new RateLimiter(1500);
const gzebLimiter = new RateLimiter(4000);
const szygcgptLimiter = new RateLimiter(1500);
const guangdongLimiter = new RateLimiter(5000);
const ccgpLimiter = new RateLimiter(2500);
const ggzyNationalLimiter = new RateLimiter(2500);
const cebLimiter = new RateLimiter(3500);

const EXCLUDE_TITLE = ['材料采购', '监理', '劳务', '设备租赁', '结果公示', '候选人公示', '合同公示', '合同公告', '中标结果', '成交结果', '中选结果', '终止', '失败', '流标', '废标', '投诉', '质疑'];
const INCLUDE_TITLE = ['BIM', '建筑信息模型', '智慧建造', 'CIM', '数字孪生', '正向设计', '装配式建筑', '工程总承包', 'EPC', '全过程工程咨询', '施工模拟', '竣工模型交付', '管线综合', '智慧运维'];
const SHENZHEN_SITE_PREFIXES = ['4403'];
const SHENZHEN_SITE_NAMES = ['深圳', '福田', '罗湖', '南山', '宝安', '龙岗', '龙华', '坪山', '光明', '盐田', '大鹏', '深汕'];
const DETAIL_URL_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const detailUrlHealthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
const ccgpDetailCache = new Map<string, { content: string; tender: TenderMetadata; fetchedAt: number }>();
const cebDetailCache = new Map<string, CebDetailProbe>();

type CebDetailProbe = {
  status: 'disabled' | 'ok' | 'blocked' | 'empty' | 'error';
  content?: string;
  tender?: TenderMetadata;
  message?: string;
  fetchedAt: number;
};

function stripHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value: string | null | undefined): string {
  return normalizeWhitespace(value)
    .replace(/[()（）【】\[\]《》“”"'‘’]/g, '')
    .replace(/[,:：;；、·\\/_-]/g, '')
    .toUpperCase();
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseCompactDate(value: string | null | undefined): Date | undefined {
  if (!value || value.length < 8) return undefined;
  return toDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
}

function getOneYearAgoStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  d.setHours(0, 0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} 00:00:00`;
}

function getOneYearAgoDateOnly(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  d.setHours(0, 0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseAmountWan(value: string | null | undefined): number | null {
  const text = normalizeWhitespace(value);
  if (!text) return null;

  const wanMatch = text.match(/([\d,.]+)\s*万(?:元)?/i);
  if (wanMatch) {
    const amount = Number.parseFloat(wanMatch[1].replace(/,/g, ''));
    return Number.isFinite(amount) ? amount : null;
  }

  const yuanMatch = text.match(/([\d,.]+)\s*元/i);
  if (yuanMatch) {
    const amount = Number.parseFloat(yuanMatch[1].replace(/,/g, ''));
    return Number.isFinite(amount) ? amount / 10000 : null;
  }

  return null;
}

function parseDateText(value: string | null | undefined): string {
  const match = normalizeWhitespace(value).match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? '';
}

function formatDateForCcgp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}:${mm}:${dd}`;
}

function parseCcgpDate(value: string | null | undefined): Date | undefined {
  const match = normalizeWhitespace(value).match(/(20\d{2})[.-](\d{2})[.-](\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return toDate(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
}

function parseTenderDate(value: string | null | undefined): Date | undefined {
  const text = normalizeWhitespace(value)
    .replace(/年|\/|\./g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/时|点/g, ':')
    .replace(/分/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return toDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`);
}

function pickTenderDate(text: string, labels: string[]): Date | undefined {
  for (const label of labels) {
    const pattern = new RegExp(`${label}(?:为|是)?[：:\\s]*([^\\n；;，,]{0,80})`);
    const date = parseTenderDate(text.match(pattern)?.[1]);
    if (date) return date;
  }
  return undefined;
}

function parseBudgetWanLoose(text: string): number | undefined {
  const yuanLabel = text.match(/(?:预算金额|采购预算|项目预算|最高限价|控制价)(?:（元）|\(元\))?[：:\s￥¥]*([\d,.]+)(?!\s*万)/);
  if (yuanLabel) {
    const amount = Number.parseFloat(yuanLabel[1].replace(/,/g, ''));
    if (Number.isFinite(amount)) return amount >= 10000 ? amount / 10000 : amount;
  }
  return parseAmountWan(text) ?? undefined;
}

function parseUnit(value: string | null | undefined): string {
  const match = normalizeWhitespace(value).match(/(?:招标单位|建设单位|采购人|招标人)[：:]?\s*([^\n]{2,60})/);
  return match?.[1]?.trim() ?? '';
}

function isEnabledFlag(value: string | null | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function isCebDetailFetchEnabled(): boolean {
  return isEnabledFlag(process.env.CEB_DETAIL_FETCH_ENABLED);
}

function isCebWafChallenge(text: string): boolean {
  return /_waf_|antidom|potential threats|security|405|云盾|安全验证|访问被阻断|blocked/i.test(text);
}

function decryptCebPayload(payload: string): string | null {
  const raw = payload.trim().replace(/^"|"$/g, '');
  if (!raw || raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('<')) return null;

  try {
    const key = CryptoJS.enc.Utf8.parse('1qaz@wsx3e');
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(raw) } as CryptoJS.lib.CipherParams,
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    return text.trim() || null;
  } catch {
    return null;
  }
}

function parseCebDetailJson(raw: string): Record<string, unknown> | null {
  const candidates = [raw, decryptCebPayload(raw)].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Continue with the next candidate. CEB may return encrypted JSON or an HTML WAF page.
    }
  }
  return null;
}

function flattenCebDetailPayload(payload: Record<string, unknown>): string {
  const data = payload.data ?? payload.result ?? payload;
  if (typeof data === 'string') return stripHtml(data);
  return stripHtml(JSON.stringify(data));
}

function shouldIncludeTender(title: string, content: string): boolean {
  const text = `${title} ${content}`;
  if (EXCLUDE_TITLE.some(keyword => text.includes(keyword))) return false;
  return INCLUDE_TITLE.some(keyword => text.toUpperCase().includes(keyword.toUpperCase()));
}

function isActiveProcurementNotice(title: string, content: string): boolean {
  const text = `${title} ${content}`;
  if (/中标|成交|结果公告|结果公示|候选人公示|合同公告|合同公示|更正|终止|废标|流标|投诉|质疑/.test(text)) {
    return false;
  }
  return /招标公告|采购公告|磋商公告|谈判公告|询价公告|资格预审|比选公告|遴选公告|项目任务/.test(text);
}

function isLowValueGzebRecord(title: string, content: string): boolean {
  const text = `${title} ${content}`;
  return [
    '中标（成交）结果详情',
    '中标结果',
    '成交结果',
    '结果公告',
    '候选人公示',
    '合同公告',
    '终止公告',
    '废标',
    '流标'
  ].some(keyword => text.includes(keyword));
}

function assessGzebRecordReliability(record: GzebRecord, title: string, content: string, url: string): { trusted: boolean; reason?: string } {
  const combined = `${title}\n${content}`;

  if (!url) {
    return { trusted: false, reason: '缺少详情链接' };
  }

  if (/show-bid-opening\/list|show-bid-result|\/results?\//i.test(url)) {
    return { trusted: false, reason: '结果页跳转链接' };
  }

  if (/中标|成交|结果公告|候选人公示|合同公告|合同信息公开|终止公告|流标|废标/.test(title)) {
    return { trusted: false, reason: '结果类公告' };
  }

  const hasAnnouncementCue = /招标公告|采购公告|竞价公告|资格预审|比选公告|遴选公告/.test(combined);
  const hasBusinessCue = /BIM|建筑信息模型|智慧建造|数字孪生|CIM/i.test(combined);
  if (!hasAnnouncementCue && !hasBusinessCue) {
    return { trusted: false, reason: '公告特征不足' };
  }

  if (record.categorynum?.startsWith('002001004')) {
    return { trusted: false, reason: '高风险目录' };
  }

  return { trusted: true };
}

function buildGzebQueryVariants(query: string): string[] {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  const upper = normalized.toUpperCase();

  if (upper !== 'BIM' && /BIM|建筑信息模型|智慧建造|CIM|数字孪生/i.test(normalized)) {
    variants.add('BIM');
  }

  if (!normalized.includes('建筑信息模型') && /BIM|建筑信息模型/i.test(normalized)) {
    variants.add('建筑信息模型');
  }

  if (!normalized.includes('智慧建造') && /智慧|数字|BIM/i.test(normalized)) {
    variants.add('智慧建造');
  }

  const stripped = normalized
    .replace(/全过程咨询/g, '')
    .replace(/正向设计/g, '设计')
    .replace(/数字化交付/g, '')
    .replace(/深化设计/g, '设计')
    .replace(/施工应用/g, '施工')
    .trim();

  if (stripped && stripped !== normalized && stripped.length >= 2) {
    variants.add(stripped);
  }

  return [...variants].slice(0, 4);
}

type GzebErrorCategory =
  | 'waf'
  | 'gateway'
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'empty'
  | 'api'
  | 'unknown';

function classifyGzebError(error: unknown): { category: GzebErrorCategory; message: string } {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 403) return { category: 'waf', message: '403 / WAF 拦截' };
    if (status === 429) return { category: 'rate_limit', message: '429 限流' };
    if (status === 502 || status === 503 || status === 504) return { category: 'gateway', message: `${status} 网关异常` };
    if (error.code === 'ECONNABORTED') return { category: 'timeout', message: '请求超时' };
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error.code ?? '')) {
      return { category: 'connection', message: error.code ?? '连接异常' };
    }
    return { category: 'unknown', message: error.message };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/empty result/i.test(message)) return { category: 'empty', message: '空结果 / 疑似被拦截' };
  if (/api code/i.test(message)) return { category: 'api', message };
  return { category: 'unknown', message };
}

function getGzebRetryDelayMs(category: GzebErrorCategory, baseDelayMs: number, attempt: number): number {
  const factorMap: Record<GzebErrorCategory, number> = {
    waf: 3,
    gateway: 2,
    rate_limit: 4,
    timeout: 2,
    connection: 2,
    empty: 1,
    api: 1,
    unknown: 1,
  };

  return baseDelayMs * Math.max(1, factorMap[category]) * Math.max(1, attempt + 1);
}

function classifyTenderType(title: string, datasetName = ''): string | null {
  const text = `${title} ${datasetName}`.toUpperCase();
  if (text.includes('结果') || text.includes('中标') || text.includes('成交')) return null;
  if (text.includes('全过程') || (text.includes('EPC') && text.includes('BIM'))) return '全过程BIM';
  if (text.includes('工程总承包') || text.includes('EPC') || text.includes('总承包工程')) return '工程总承包/EPC';
  if (text.includes('装配式建筑')) return '装配式建筑';
  if (text.includes('设计') && (text.includes('BIM') || text.includes('正向'))) return '设计BIM';
  if (text.includes('施工') && text.includes('BIM')) return '施工BIM';
  if (text.includes('智慧') || text.includes('CIM') || text.includes('数字孪生')) return '智慧CIM';
  if (text.includes('BIM') || text.includes('建筑信息模型')) return '其他BIM';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildTenderContent(parts: Array<string | null | undefined>): string {
  return parts
    .map(part => normalizeWhitespace(part))
    .filter(Boolean)
    .join('\n');
}

interface TenderResultMeta {
  title: string;
  content: string;
  url: string;
  source: SearchResult['source'];
  sourceId?: string;
  publishedAt?: Date;
  tender?: SearchResult['tender'];
}

function toTenderResult(meta: TenderResultMeta): SearchResult[] {
  if (!meta.title || !meta.url) return [];
  return [{
    title: meta.title,
    content: meta.content || meta.title,
    url: meta.url,
    source: meta.source,
    sourceId: meta.sourceId,
    publishedAt: meta.publishedAt,
    tender: meta.tender
  }];
}

interface GgzyNationalResponse {
  code?: number;
  data?: {
    records?: Array<Record<string, unknown>>;
  };
}

function firstStringField(record: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return normalizeWhitespace(value);
  }
  return '';
}

function resolveUrl(value: string, baseUrl: string): string {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

async function fetchCcgpDetail(url: string, base: SearchResult): Promise<{ content: string; tender: TenderMetadata } | null> {
  const cached = ccgpDetailCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_URL_HEALTH_TTL_MS) {
    return { content: cached.content, tender: cached.tender };
  }

  try {
    const response = await axiosWithSourceProxy<string>('ccgp', {
      method: 'get',
      url,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'http://search.ccgp.gov.cn/bxsearch'
      }
    });

    const $ = load(response.data);
    const title = normalizeWhitespace($('meta[name="ArticleTitle"]').attr('content')) || base.title;
    const detailHtml = $('.vF_detail_content').html()
      || $('.vF_detail_main').html()
      || $('.vF_detail').html()
      || $('body').html()
      || response.data;
    const detailText = stripHtml(detailHtml);
    const extracted = extractTenderDetailFields({
      ...base,
      title,
      content: buildTenderContent([
        base.content,
        '--- CCGP 官方详情 ---',
        detailHtml
      ])
    });
    const looseBudgetWan = parseBudgetWanLoose(detailText);
    const looseDeadline = pickTenderDate(detailText, [
      '提交投标文件截止时间',
      '响应文件提交截止时间',
      '投标截止时间',
      '递交截止时间',
      '截止时间'
    ]);
    const looseBidOpenTime = pickTenderDate(detailText, ['开标时间', '开启时间']);
    const looseProjectCode = detailText.match(/(?:项目编号|招标编号|采购编号)[：:\s]*([A-Za-z0-9\-_/（）()\\[\\]【】]+[A-Za-z0-9）)\\]】])/)?.[1]?.trim();
    const extractedUnit = extracted.unit && !['信息', '采购人信息', '招标人信息'].includes(extracted.unit)
      ? extracted.unit
      : undefined;
    const mergedTender: TenderMetadata = {
      ...base.tender,
      ...extracted,
      unit: extractedUnit || base.tender?.unit,
      budgetWan: extracted.budgetWan ?? looseBudgetWan ?? base.tender?.budgetWan,
      deadline: extracted.deadline ?? looseDeadline ?? base.tender?.deadline,
      bidOpenTime: extracted.bidOpenTime ?? looseBidOpenTime ?? base.tender?.bidOpenTime,
      projectCode: extracted.projectCode ?? looseProjectCode ?? base.tender?.projectCode,
      platform: '中国政府采购网',
      detailSource: 'ccgp-detail+rules',
      detailExtractedAt: new Date()
    };
    const content = buildTenderContent([
      base.content,
      mergedTender.projectCode ? `项目编号：${mergedTender.projectCode}` : null,
      mergedTender.deadline ? `截止时间：${mergedTender.deadline.toISOString().replace('T', ' ').slice(0, 16)}` : null,
      mergedTender.bidOpenTime ? `开标时间：${mergedTender.bidOpenTime.toISOString().replace('T', ' ').slice(0, 16)}` : null,
      mergedTender.contact ? `联系人：${mergedTender.contact}` : null,
      mergedTender.phone ? `联系电话：${mergedTender.phone}` : null,
      detailText || null
    ]);

    ccgpDetailCache.set(url, {
      content,
      tender: mergedTender,
      fetchedAt: Date.now()
    });
    return { content, tender: mergedTender };
  } catch (error) {
    console.warn('CCGP detail fetch failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function fetchCebDetailViaApi(uuid: string, base: SearchResult): Promise<CebDetailProbe> {
  const cached = cebDetailCache.get(uuid);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_URL_HEALTH_TTL_MS) return cached;

  if (!isCebDetailFetchEnabled()) {
    const disabled: CebDetailProbe = {
      status: 'disabled',
      message: 'CEB 详情接口默认关闭，避免触发阿里云 405/WAF 挑战影响定时扫描',
      fetchedAt: Date.now()
    };
    cebDetailCache.set(uuid, disabled);
    return disabled;
  }

  try {
    const detailUrl = `https://ctbpsp.com/cutominfoapi/bulletin/${encodeURIComponent(uuid)}/uid/0`;
    const { response, proxyId } = await axiosWithSourceProxyDetailed<string>('cebpubservice', {
      method: 'get',
      url: detailUrl,
      timeout: 25000,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        Referer: `https://ctbpsp.com/#/bulletinDetail?uuid=${encodeURIComponent(uuid)}&inpvalue=&dataSource=0&tenderAgency=`
      }
    });

    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    if (response.status >= 400 || isCebWafChallenge(raw) || /^\s*</.test(raw)) {
      markProxySoftFailure(proxyId, `ceb detail blocked: http ${response.status}`);
      const blocked: CebDetailProbe = {
        status: 'blocked',
        message: `详情接口触发 WAF/JS challenge（HTTP ${response.status}），已降级使用列表字段`,
        fetchedAt: Date.now()
      };
      cebDetailCache.set(uuid, blocked);
      return blocked;
    }

    const parsed = parseCebDetailJson(raw);
    if (!parsed) {
      const empty: CebDetailProbe = {
        status: 'empty',
        message: '详情接口返回非结构化内容，已降级使用列表字段',
        fetchedAt: Date.now()
      };
      cebDetailCache.set(uuid, empty);
      return empty;
    }

    const detailText = flattenCebDetailPayload(parsed);
    if (!detailText || detailText === '{}' || detailText === 'null') {
      const empty: CebDetailProbe = {
        status: 'empty',
        message: '详情接口返回空详情，已降级使用列表字段',
        fetchedAt: Date.now()
      };
      cebDetailCache.set(uuid, empty);
      return empty;
    }

    const extracted = extractTenderDetailFields({
      ...base,
      content: buildTenderContent([
        base.content,
        '--- CEB 官方详情 ---',
        detailText
      ])
    });

    const mergedTender: TenderMetadata = {
      ...base.tender,
      ...extracted,
      unit: extracted.unit || parseUnit(detailText) || base.tender?.unit,
      budgetWan: extracted.budgetWan ?? parseBudgetWanLoose(detailText) ?? base.tender?.budgetWan,
      deadline: extracted.deadline ?? pickTenderDate(detailText, ['投标文件递交截止时间', '投标截止时间', '递交截止时间', '截止时间']) ?? base.tender?.deadline,
      bidOpenTime: extracted.bidOpenTime ?? pickTenderDate(detailText, ['开标时间', '开启时间']) ?? base.tender?.bidOpenTime,
      platform: '中国招标投标公共服务平台',
      detailSource: 'ceb-detail-api+des',
      detailExtractedAt: new Date()
    };

    const content = buildTenderContent([
      base.content,
      mergedTender.unit ? `招标人/采购人：${mergedTender.unit}` : null,
      mergedTender.budgetWan ? `预算金额：${mergedTender.budgetWan} 万元` : null,
      mergedTender.deadline ? `截止时间：${mergedTender.deadline.toISOString().replace('T', ' ').slice(0, 16)}` : null,
      mergedTender.contact ? `联系人：${mergedTender.contact}` : null,
      mergedTender.phone ? `联系电话：${mergedTender.phone}` : null,
      detailText
    ]);

    const ok: CebDetailProbe = {
      status: 'ok',
      content,
      tender: mergedTender,
      fetchedAt: Date.now()
    };
    cebDetailCache.set(uuid, ok);
    return ok;
  } catch (error) {
    const failed: CebDetailProbe = {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now()
    };
    cebDetailCache.set(uuid, failed);
    return failed;
  }
}

export async function searchCebpubservice(query: string, limit = 20): Promise<SearchResult[]> {
  await cebLimiter.wait();

  try {
    const params = new URLSearchParams({
      searchDate: getOneYearAgoDateOnly(),
      dates: '300',
      categoryId: '88',
      industryName: '',
      area: '',
      status: '',
      publishMedia: '',
      sourceInfo: '',
      showStatus: '1',
      word: query,
      page: '1'
    });

    const response = await axiosWithSourceProxy<string>('cebpubservice', {
      method: 'get',
      url: `https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html?${params.toString()}`,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://bulletin.cebpubservice.com/'
      }
    });

    const $ = load(response.data);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    $('table.table_text tr').each((_, row) => {
      if (results.length >= limit) return false;

      const cells = $(row).find('td');
      if (cells.length < 5) return;

      const titleLink = $(cells[0]).find('a').first();
      const title = normalizeWhitespace(titleLink.attr('title') || titleLink.text());
      const href = titleLink.attr('href') || '';
      const uuid = href.match(/urlOpen\('([^']+)'\)/)?.[1];
      if (!title || !uuid || seen.has(uuid)) return;

      const industry = normalizeWhitespace($(cells[1]).text());
      const region = normalizeWhitespace($(cells[2]).text()).replace(/[【】]/g, '');
      const channel = normalizeWhitespace($(cells[3]).text());
      const publishedAt = parseCcgpDate(normalizeWhitespace($(cells[4]).text()));
      const bidOpenTime = parseCcgpDate($(cells[5]).attr('id') || normalizeWhitespace($(cells[5]).text()));
      const rowText = normalizeWhitespace($(row).text());

      if (!shouldIncludeTender(title, rowText)) return;
      if (!isActiveProcurementNotice(title, rowText)) return;

      const type = classifyTenderType(title, rowText);
      if (!type) return;

      const amount = parseAmountWan(rowText);
      if (amount !== null && amount < 40) return;

      seen.add(uuid);
      results.push(...toTenderResult({
        title,
        url: `https://ctbpsp.com/#/bulletinDetail?uuid=${encodeURIComponent(uuid)}&inpvalue=&dataSource=0&tenderAgency=`,
        source: 'cebpubservice',
        sourceId: uuid,
        publishedAt,
        tender: {
          type,
          region: region || undefined,
          budgetWan: amount ?? undefined,
          deadline: bidOpenTime,
          bidOpenTime,
          noticeType: '招标公告',
          platform: '中国招标投标公共服务平台',
          detailSource: 'ceb-list+rules',
          detailExtractedAt: new Date()
        },
        content: buildTenderContent([
          '平台：中国招标投标公共服务平台',
          `分类：${type}`,
          industry ? `行业：${industry}` : null,
          region ? `地区：${region}` : null,
          channel ? `来源渠道：${channel}` : null,
          bidOpenTime ? `开标时间：${bidOpenTime.toISOString().replace('T', ' ').slice(0, 16)}` : null,
          '详情策略：列表字段稳定解析；SPA 详情接口需通过浏览器/WAF challenge 后再补强',
          rowText || null
        ])
      }));
    });

    console.log(`CEB PubService search for "${query}": found ${results.length} filtered results`);
    const sliced = results.slice(0, limit);
    if (!isCebDetailFetchEnabled()) return sliced;

    const enriched: SearchResult[] = [];
    for (const result of sliced) {
      const uuid = result.sourceId;
      if (!uuid) {
        enriched.push(result);
        continue;
      }

      const detail = await fetchCebDetailViaApi(uuid, result);
      if (detail.status === 'ok' && detail.content && detail.tender) {
        enriched.push({
          ...result,
          content: detail.content,
          tender: detail.tender
        });
      } else {
        enriched.push({
          ...result,
          content: [
            result.content,
            detail.message ? `详情补强：${detail.message}` : `详情补强：${detail.status}`
          ].filter(Boolean).join('\n'),
          tender: {
            ...result.tender,
            detailSource: `ceb-list+rules:${detail.status}`,
            detailExtractedAt: new Date()
          }
        });
      }
    }

    return enriched;
  } catch (error) {
    console.error('CEB PubService search error:', error instanceof Error ? error.message : error);
    return [];
  }
}

export async function searchCcgp(query: string, limit = 20): Promise<SearchResult[]> {
  await ccgpLimiter.wait();

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 1);

    const params = new URLSearchParams({
      searchtype: '1',
      page_index: '1',
      bidSort: '0',
      buyerName: '',
      projectId: '',
      pinMu: '0',
      bidType: '0',
      dbselect: 'bidx',
      kw: query,
      start_time: formatDateForCcgp(startDate),
      end_time: formatDateForCcgp(endDate),
      timeType: '6',
      displayZone: '',
      zoneId: '',
      pppStatus: '0',
      agentName: ''
    });

    const response = await axiosWithSourceProxy<string>('ccgp', {
      method: 'get',
      url: `http://search.ccgp.gov.cn/bxsearch?${params.toString()}`,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'http://search.ccgp.gov.cn/bxsearch'
      }
    });

    const $ = load(response.data);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    $('ul.vT-srch-result-list-bid > li').each((_, element) => {
      if (results.length >= limit) return false;

      const row = $(element);
      const link = row.find('a[href*="ccgp.gov.cn/cggg/"]').first();
      const title = normalizeWhitespace(link.text());
      const url = resolveUrl(link.attr('href') || '', 'http://www.ccgp.gov.cn/');
      if (!title || !url || seen.has(url)) return;

      const rowText = normalizeWhitespace(row.text());
      const content = normalizeWhitespace(rowText.replace(title, ''));
      if (!shouldIncludeTender(title, content)) return;
      if (!isActiveProcurementNotice(title, content)) return;

      const type = classifyTenderType(title, content);
      if (!type) return;

      const amount = parseAmountWan(content);
      if (amount !== null && amount < 40) return;

      const unit = rowText.match(/采购人[：:]\s*([^|]{2,80})/)?.[1]?.trim();
      const agent = rowText.match(/代理机构[：:]\s*([^|]{2,80})/)?.[1]?.trim();
      const noticeType = rowText.match(/(公开招标公告|竞争性磋商公告|竞争性谈判公告|询价公告|资格预审公告|招标公告|采购公告|比选公告|遴选公告)/)?.[1];
      const dateMatch = rowText.match(/20\d{2}[.-]\d{2}[.-]\d{2}(?:\s+\d{2}:\d{2}:\d{2})?/);
      const region = rowText.split('|').map(item => item.trim()).filter(Boolean).at(-1);
      const sourceId = url.match(/\/([^/]+)\.htm$/)?.[1];

      const baseResult = toTenderResult({
        title,
        url,
        source: 'ccgp',
        sourceId,
        publishedAt: parseCcgpDate(dateMatch?.[0]),
        tender: {
          type,
          region: region && region.length <= 12 ? region : undefined,
          unit: unit || undefined,
          budgetWan: amount ?? undefined,
          noticeType,
          platform: '中国政府采购网',
          detailSource: 'ccgp-list+rules',
          detailExtractedAt: new Date()
        },
        content: buildTenderContent([
          '平台：中国政府采购网',
          `分类：${type}`,
          noticeType ? `公告类型：${noticeType}` : null,
          region && region.length <= 12 ? `地区：${region}` : null,
          unit ? `采购人：${unit}` : null,
          agent ? `代理机构：${agent}` : null,
          amount !== null ? `预算：${amount} 万元` : null,
          content || null
        ])
      })[0];

      if (!baseResult) return;
      seen.add(url);
      results.push(baseResult);
    });

    for (const result of results) {
      const detail = await fetchCcgpDetail(result.url, result);
      if (!detail) continue;
      result.content = detail.content;
      result.tender = detail.tender;
    }

    console.log(`CCGP search for "${query}": found ${results.length} filtered results`);
    return results.slice(0, limit);
  } catch (error) {
    console.error('CCGP search error:', error instanceof Error ? error.message : error);
    return [];
  }
}

export async function searchGgzyNational(query: string, limit = 20): Promise<SearchResult[]> {
  await ggzyNationalLimiter.wait();

  try {
    const params = new URLSearchParams({
      SOURCE_TYPE: '1',
      DEAL_TIME: '02',
      PAGENUMBER: '1',
      FINDTXT: query
    });

    const response = await axiosWithSourceProxy<GgzyNationalResponse>('ggzyNational', {
      method: 'post',
      url: 'https://www.ggzy.gov.cn/information/pubTradingInfo/getTradList',
      data: params.toString(),
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.ggzy.gov.cn/deal/dealList.html'
      }
    });

    if (response.data.code && response.data.code !== 200) {
      if (response.data.code === 829) {
        throw new Error('ggzy captcha required');
      }
      throw new Error(`ggzy api code ${response.data.code}`);
    }

    const records = response.data.data?.records ?? [];
    if (records.length === 0) {
      console.log(`GGZY National search for "${query}": official API returned empty records`);
      return [];
    }

    const results = records.flatMap(record => {
      const title = firstStringField(record, ['title', 'TITLE', 'DEAL_TITLE', 'dealTitle', 'PROJECT_NAME', 'projectName']);
      const rawContent = buildTenderContent([
        firstStringField(record, ['bodyContent', 'content', 'CONTENT', 'DEAL_CONTENT', 'description', 'summary']),
        firstStringField(record, ['informationTypeText', 'businessTypeText', 'industryTypeText']),
        firstStringField(record, ['transactionSourcesPlatformText'])
      ]);
      const rawUrl = firstStringField(record, ['url', 'URL', 'detailUrl', 'DETAIL_URL', 'linkurl', 'LINKURL']);
      const url = resolveUrl(rawUrl, 'https://www.ggzy.gov.cn/');
      if (!title || !url) return [];
      if (!shouldIncludeTender(title, rawContent)) return [];
      if (!isActiveProcurementNotice(title, rawContent)) return [];

      const type = classifyTenderType(title, rawContent);
      if (!type) return [];
      const amount = parseAmountWan(rawContent);
      if (amount !== null && amount < 40) return [];

      const sourceId = firstStringField(record, ['id', 'ID', 'uuid', 'UUID']) || url.match(/([^/?#]+)(?:[?#].*)?$/)?.[1];
      const region = firstStringField(record, ['provinceText', 'region', 'REGION', 'DEAL_PROVINCE_NAME']);
      const city = firstStringField(record, ['cityText', 'city', 'CITY']);
      const noticeType = firstStringField(record, ['informationTypeText', 'noticeType', 'NOTICE_TYPE']);
      const projectCode = firstStringField(record, ['tenderProjectCode', 'projectCode', 'PROJECT_CODE']);
      const publishedAt = parseCcgpDate(firstStringField(record, ['publishTime', 'time', 'TIME', 'date', 'PUBLISH_TIME']));
      return toTenderResult({
        title,
        url,
        source: 'ggzyNational',
        sourceId,
        publishedAt,
        tender: {
          type,
          region: region || undefined,
          city: city || undefined,
          budgetWan: amount ?? undefined,
          noticeType: noticeType || undefined,
          platform: '全国公共资源交易平台',
          projectCode: projectCode || undefined,
          detailSource: 'ggzy-national-list+official-api',
          detailExtractedAt: new Date()
        },
        content: buildTenderContent([
          '平台：全国公共资源交易平台',
          `分类：${type}`,
          noticeType ? `公告阶段：${noticeType}` : null,
          region ? `地区：${region}` : null,
          city ? `城市：${city}` : null,
          projectCode ? `项目编号：${projectCode}` : null,
          publishedAt ? `发布时间：${publishedAt.toISOString().slice(0, 10)}` : null,
          amount !== null ? `预算：${amount} 万元` : null,
          rawContent || null
        ])
      });
    });

    console.log(`GGZY National search for "${query}": found ${results.length} filtered results`);
    return results.slice(0, limit);
  } catch (error) {
    console.error('GGZY National search error:', error instanceof Error ? error.message : error);
    return [];
  }
}

interface ResolvedTenderDetail {
  url: string;
  sourceId?: string;
  platform: string;
  resolvedBy: 'direct' | 'node-id' | 'origin-fallback';
}

interface SzggzyResponse {
  data?: {
    content?: Array<{
      id: string;
      title: string;
      txt?: string;
      linkTo?: string;
      releaseTime?: string;
      channelName?: string;
      pChannelName?: string;
      unitName?: string;
      tenderer?: string;
      amount?: number;
    }>;
  };
}

type SzggzyItem = NonNullable<NonNullable<SzggzyResponse['data']>['content']>[number];

function resolveSzggzyUrl(item: SzggzyItem): string {
  const contentId = String(item.id);
  if (item.linkTo) {
    if (/^https?:\/\//i.test(item.linkTo)) return item.linkTo;
    return new URL(item.linkTo, 'https://www.szggzy.com/').toString();
  }
  return `https://www.szggzy.com/globalSearch/details.html?contentId=${encodeURIComponent(contentId)}`;
}

async function fetchSzggzyItems(query: string, limit = 20): Promise<SzggzyItem[]> {
  const response = await axiosWithSourceProxy<SzggzyResponse>('szggzy', {
    method: 'post',
    url: 'https://www.szggzy.com/cms/api/v1/trade/es/content/page',
    data: {
      keyword: query,
      page: 0,
      size: limit,
      searchPosition: 'titleAndTxt',
      channelId: null,
      noticeLabels: [],
      releaseTimeBegin: null,
      releaseTimeEnd: null,
      orderBy: 0,
      id: null
    },
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://www.szggzy.com/globalSearch/index.html'
    },
    timeout: 20000
  });

  return response.data.data?.content ?? [];
}

async function findSzggzyDetailByTitle(title: string): Promise<{ url: string; contentId?: string } | null> {
  const normalizedTarget = normalizeTitle(title);
  if (!normalizedTarget) return null;

  try {
    await szggzyLimiter.wait();
    const items = await fetchSzggzyItems(title, 10);

    const exact = items.find(item => normalizeTitle(stripHtml(item.title)) === normalizedTarget);
    if (exact) {
      return {
        url: resolveSzggzyUrl(exact),
        contentId: String(exact.id)
      };
    }

    const fuzzy = items.find(item => {
      const normalized = normalizeTitle(stripHtml(item.title));
      return normalized.includes(normalizedTarget) || normalizedTarget.includes(normalized);
    });
    if (fuzzy) {
      return {
        url: resolveSzggzyUrl(fuzzy),
        contentId: String(fuzzy.id)
      };
    }
  } catch (error) {
    console.warn('SZGGZY title fallback failed:', error instanceof Error ? error.message : error);
  }

  return null;
}

export async function searchSzggzy(query: string, limit = 20): Promise<SearchResult[]> {
  await szggzyLimiter.wait();

  try {
    const items = await fetchSzggzyItems(query, limit);
    const results: SearchResult[] = items.flatMap(item => {
      const title = stripHtml(item.title);
      const rawContent = stripHtml(item.txt);
      if (!shouldIncludeTender(title, rawContent)) return [];

      const amount = parseAmountWan(rawContent) ?? (typeof item.amount === 'number' ? item.amount : null);
      if (amount !== null && amount < 40) return [];

      const type = classifyTenderType(title);
      if (!type) return [];
      const unit = parseUnit(rawContent) || stripHtml(item.unitName) || stripHtml(item.tenderer);
      const channel = [item.pChannelName, item.channelName].filter(Boolean).join(' / ');

      return toTenderResult({
        title,
        url: resolveSzggzyUrl(item),
        source: 'szggzy',
        sourceId: item.id,
        publishedAt: toDate(item.releaseTime),
        tender: {
          type,
          unit: unit || undefined,
          budgetWan: amount ?? undefined,
          noticeType: channel || undefined,
          platform: '深圳公共资源交易中心'
        },
        content: buildTenderContent([
          `平台：深圳公共资源交易中心`,
          `分类：${type}`,
          channel ? `栏目：${channel}` : null,
          unit ? `单位：${unit}` : null,
          amount !== null ? `预算：${amount} 万元` : null,
          rawContent || null
        ])
      });
    });

    console.log(`SZGGZY search for "${query}": found ${results.length} filtered results`);
    return results;
  } catch (error) {
    console.error('SZGGZY search error:', error instanceof Error ? error.message : error);
    return [];
  }
}

interface GzebResponse {
  code?: number;
  content?: string;
}

interface GzebRecord {
  title: string;
  content?: string;
  linkurl?: string;
  webdate?: string;
  categorynum?: string;
  id?: string;
}

interface GzebContent {
  result?: {
    records?: GzebRecord[];
  };
}

export async function searchGzebpubservice(query: string, limit = 20): Promise<SearchResult[]> {
  await gzebLimiter.wait();

  const runtimeConfig = await getRuntimeConfig();
  const attempts = Math.max(2, runtimeConfig.sourceRetryCount + 1);
  const variants = buildGzebQueryVariants(query);
  const resultsByTitle = new Map<string, SearchResult>();

  for (const variant of variants) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const { response, proxyId } = await axiosWithSourceProxyDetailed<GzebResponse>('gzebpubservice', {
          method: 'post',
          url: 'http://www.gzebpubservice.cn/inteligentsearchfw/rest/esinteligentsearch/getFullTextDataNew',
          data: {
            pn: 1,
            rn: limit,
            sdt: '',
            edt: '',
            wd: variant,
            inc_wd: '',
            exc_wd: '',
            fields: 'title;content',
            cnum: '001',
            sort: '',
            ssort: 'title',
            cl: 500,
            terminal: '',
            condition: [],
            time: [
              {
                fieldName: 'webdate',
                startTime: getOneYearAgoStart(),
                endTime: '2099-12-31 23:59:59'
              }
            ],
            highlights: 'title;content',
            statistics: null,
            unionCondition: null,
            accuracy: '',
            noParticiple: '0',
            searchRange: null,
            isBusiness: '1'
          },
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'User-Agent': 'Mozilla/5.0'
          },
          timeout: 20000
        });

        if (response.data.code !== 200 || !response.data.content) {
          const reason = `gzeb api code ${response.data.code ?? 'unknown'}`;
          markProxySoftFailure(proxyId, reason);
          const delayMs = getGzebRetryDelayMs('api', runtimeConfig.sourceRetryDelayMs, attempt);
          if (attempt < attempts - 1) {
            await sleep(delayMs);
            continue;
          }
          console.log(`GZEB search: ${reason}, variant="${variant}"`);
          break;
        }

        const parsed = JSON.parse(response.data.content) as GzebContent;
        const records = parsed.result?.records ?? [];
        const variantResults = new Map<string, SearchResult>();

        for (const record of records) {
          const title = stripHtml(record.title);
          const content = stripHtml(record.content);
          if (isLowValueGzebRecord(title, content)) continue;
          if (!shouldIncludeTender(title, content)) continue;

          const type = classifyTenderType(title, content);
          if (!type) continue;
          const amount = parseAmountWan(content);
          if (amount !== null && amount < 40) continue;

          const url = record.linkurl ? new URL(record.linkurl, 'http://www.gzebpubservice.cn/').toString() : '';
          if (!isHealthyGzebUrl(url, record.categorynum)) continue;
          const reliability = assessGzebRecordReliability(record, title, content, url);
          if (!reliability.trusted) continue;
          if (!(await isReachableDetailUrl(url))) continue;

          const candidate = toTenderResult({
            title,
            url,
            source: 'gzebpubservice',
            publishedAt: toDate(record.webdate),
            tender: {
              type,
              budgetWan: amount ?? undefined,
              platform: '广州公共资源交易公共服务平台'
            },
            content: buildTenderContent([
              '平台：广州公共资源交易公共服务平台',
              `分类：${type}`,
              amount !== null ? `预算：${amount} 万元` : null,
              content || null
            ])
          })[0];

          if (!candidate) continue;

          const key = normalizeTitle(title);
          const existing = variantResults.get(key);
          if (!existing) {
            variantResults.set(key, candidate);
            continue;
          }

          const existingIsStatic = existing.url.includes('gzebpubservice.cn/jyfw/');
          const candidateIsStatic = candidate.url.includes('gzebpubservice.cn/jyfw/');
          if (!existingIsStatic && candidateIsStatic) {
            variantResults.set(key, candidate);
            continue;
          }

          const existingHasAnnouncement = /招标公告|采购公告|竞价公告/.test(existing.title);
          const candidateHasAnnouncement = /招标公告|采购公告|竞价公告/.test(candidate.title);
          if (!existingHasAnnouncement && candidateHasAnnouncement) {
            variantResults.set(key, candidate);
          }
        }

        const results = [...variantResults.values()];
        if (results.length === 0) {
          markProxySoftFailure(proxyId, `gzeb empty result (${variant})`);
          const delayMs = getGzebRetryDelayMs('empty', runtimeConfig.sourceRetryDelayMs, attempt);
          if (attempt < attempts - 1) {
            await sleep(delayMs);
            continue;
          }
          break;
        }

        for (const result of results) {
          resultsByTitle.set(normalizeTitle(result.title), result);
        }

        if (resultsByTitle.size >= Math.min(limit, 3)) {
          console.log(`GZEB search for "${query}" via "${variant}": found ${resultsByTitle.size} filtered results`);
          return [...resultsByTitle.values()].slice(0, limit);
        }

        break;
      } catch (error) {
        const classified = classifyGzebError(error);
        console.error(`GZEB search error [${classified.category}] variant="${variant}":`, classified.message);
        const delayMs = getGzebRetryDelayMs(classified.category, runtimeConfig.sourceRetryDelayMs, attempt);
        if (attempt < attempts - 1) {
          await sleep(delayMs);
          continue;
        }
      }
    }
  }

  const finalResults = [...resultsByTitle.values()].slice(0, limit);
  console.log(`GZEB layered search for "${query}": found ${finalResults.length} filtered results`);
  return finalResults;
}

interface SzygcgptResponse {
  data?: {
    list?: Array<{
      ggGuid?: string;
      bdGuid?: string;
      guid?: string;
      ggName?: string;
      ggXingZhi?: number;
      ggLeiXing?: string | number;
      dataSource?: string | number;
      faBuTime?: string;
      wjEndTime?: string;
      zbRName?: string;
      bdBH?: string;
    }>;
  };
}

interface SzygcgptDetailResponse {
  success?: boolean;
  code?: number;
  data?: {
    bd?: {
      bdName?: string;
      bdBH?: string;
      zbFanWei?: string;
      ziZhiYaoQiu?: string;
      dayLimitShuoMing?: string;
      shouBiaoDiDian?: string;
      kbDiDian?: string;
      bdHeTongGuJia?: number | string;
      purchaseControlPriceExplain?: string;
      tbWJDiJiaoEndTime?: number | string;
      sqWJDiJiaoEndTime?: number | string;
      zbWJHuoQuEndTime?: number | string;
    };
    gc?: {
      zbRName?: string;
      caiGouRen?: string;
    };
    ggDetail?: {
      title?: string;
      content?: string;
      publishTime?: number | string;
    };
  };
}

function resolveSzygcgptRegion(bdBH: string | null | undefined): string {
  const regionMap: Record<string, string> = {
    '4403': '深圳',
    '4401': '广州',
    '4406': '佛山',
    '4419': '东莞',
    '4404': '珠海',
    '4420': '中山',
    '4413': '惠州'
  };

  const code = normalizeWhitespace(bdBH);
  for (const [prefix, region] of Object.entries(regionMap)) {
    if (code.includes(prefix)) return region;
  }
  return '其他';
}

function buildSzygcgptParams(item: NonNullable<NonNullable<SzygcgptResponse['data']>['list']>[number]): URLSearchParams {
  const ggLeiXing = item.ggXingZhi ?? item.ggLeiXing ?? '';
  const dataSource = item.dataSource ?? 0;
  const params = new URLSearchParams({
    ggGuid: item.ggGuid ?? '',
    bdGuid: item.bdGuid ?? '',
    ggLeiXing: String(ggLeiXing),
    dataSource: String(dataSource)
  });
  if (item.guid) params.set('guid', item.guid);
  return params;
}

function resolveSzygcgptUrl(item: NonNullable<NonNullable<SzygcgptResponse['data']>['list']>[number]): string {
  const params = buildSzygcgptParams(item);
  return `https://www.szygcgpt.com/ygcg/detailTop?${params.toString()}`;
}

function parseSzygcgptAmountWan(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /[万元]/.test(value)) return parseAmountWan(value);
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // 阳光采购详情接口常用“元”为单位，转为万元。
  return amount > 10000 ? amount / 10000 : amount;
}

function toTimestampDate(value: number | string | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function fetchSzygcgptDetail(item: NonNullable<NonNullable<SzygcgptResponse['data']>['list']>[number]): Promise<SzygcgptDetailResponse['data'] | null> {
  if (!item.ggGuid || !item.bdGuid) return null;

  const params = buildSzygcgptParams(item);
  const dataSource = String(item.dataSource ?? 0);
  const endpoint = dataSource === '1'
    ? 'https://www.szygcgpt.com/app/etl/detail'
    : 'https://www.szygcgpt.com/app/home/detail.do';

  try {
    const response = await axiosWithSourceProxy<SzygcgptDetailResponse>('szygcgpt', {
      method: 'get',
      url: endpoint,
      params: Object.fromEntries(params),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: resolveSzygcgptUrl(item)
      },
      timeout: 15000
    });
    return response.data.success !== false ? response.data.data ?? null : null;
  } catch (error) {
    console.warn('SZYGCGPT detail fetch failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function searchSzygcgpt(query: string, limit = 20): Promise<SearchResult[]> {
  await szygcgptLimiter.wait();

  try {
    const rows = Math.min(Math.max(limit, 10), 50);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= 5 && results.length < limit; page += 1) {
      const response = await axiosWithSourceProxy<SzygcgptResponse>('szygcgpt', {
        method: 'post',
        url: 'https://www.szygcgpt.com/app/home/pageGGList.do',
        data: {
          page,
          rows,
          keyWords: query
        },
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.szygcgpt.com/ygcg/purchaseInfoList'
        },
        timeout: 20000
      });

      const items = response.data.data?.list ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        const title = normalizeWhitespace(item.ggName);
        if (!title || !shouldIncludeTender(title, '')) continue;
        if (![1, 2, 5].includes(Number(item.ggXingZhi ?? -1))) continue;

        const key = `${title}|${item.ggGuid ?? ''}|${item.bdGuid ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const type = classifyTenderType(title);
        if (!type) continue;
        const region = resolveSzygcgptRegion(item.bdBH);
        const detail = await fetchSzygcgptDetail(item);
        const bd = detail?.bd;
        const gc = detail?.gc;
        const ggDetail = detail?.ggDetail;
        const detailContent = buildTenderContent([
          ggDetail?.content,
          bd?.zbFanWei ? `招标范围：${bd.zbFanWei}` : null,
          bd?.ziZhiYaoQiu ? `资质要求：${bd.ziZhiYaoQiu}` : null,
          bd?.dayLimitShuoMing ? `工期说明：${bd.dayLimitShuoMing}` : null,
          bd?.shouBiaoDiDian ? `收标地点：${bd.shouBiaoDiDian}` : null,
          bd?.kbDiDian ? `开标地点：${bd.kbDiDian}` : null,
          bd?.purchaseControlPriceExplain ? `控制价说明：${bd.purchaseControlPriceExplain}` : null
        ]);

        const publishedAt = toTimestampDate(ggDetail?.publishTime) || toTimestampDate(item.faBuTime);
        const deadline = toTimestampDate(bd?.tbWJDiJiaoEndTime) || toTimestampDate(bd?.sqWJDiJiaoEndTime) || toTimestampDate(bd?.zbWJHuoQuEndTime) || toTimestampDate(item.wjEndTime);
        const amount = parseAmountWan(detailContent) ?? parseSzygcgptAmountWan(bd?.bdHeTongGuJia);
        const unit = normalizeWhitespace(gc?.zbRName || gc?.caiGouRen || item.zbRName);
        const url = item.ggGuid && item.bdGuid ? resolveSzygcgptUrl(item) : '';

        results.push(...toTenderResult({
          title: normalizeWhitespace(ggDetail?.title) || title,
          url,
          source: 'szygcgpt',
          sourceId: item.ggGuid,
          publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
          tender: {
            type,
            region,
            unit: unit || undefined,
            budgetWan: amount ?? undefined,
            deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined,
            noticeType: String(item.ggXingZhi ?? ''),
            platform: '深圳阳光采购平台'
          },
          content: buildTenderContent([
            '平台：深圳阳光采购平台',
            `分类：${type}`,
            `地区：${region}`,
            bd?.bdName ? `标段：${normalizeWhitespace(bd.bdName)}` : null,
            bd?.bdBH ? `编号：${normalizeWhitespace(bd.bdBH)}` : null,
            unit ? `单位：${unit}` : null,
            amount !== null ? `预算：${amount} 万元` : null,
            deadline && !Number.isNaN(deadline.getTime()) ? `截止：${deadline.toISOString().replace('T', ' ').slice(0, 16)}` : null,
            detailContent || null
          ])
        }));

        if (results.length >= limit) break;
      }
    }

    console.log(`SZYGCGPT search for "${query}": found ${results.length} filtered results`);
    return results.slice(0, limit);
  } catch (error) {
    console.error('SZYGCGPT search error:', error instanceof Error ? error.message : error);
    return [];
  }
}

interface GuangdongResponse {
  data?: {
    pageData?: Array<{
      noticeId?: string;
      noticeTitle?: string;
      publishDate?: string;
      highlightNoticeContent?: string;
      regionName?: string;
      siteName?: string;
      projectOwner?: string;
      datasetName?: string;
      edition?: string;
      projectType?: string;
      bizCode?: string;
      tradingProcess?: string;
      siteCode?: string;
      projectCode?: string;
      noticeThirdTypeDesc?: string;
      pubServicePlat?: string;
    }>;
  };
}

type GuangdongItem = NonNullable<NonNullable<GuangdongResponse['data']>['pageData']>[number] & {
  noticeSecondType?: string;
};

function isHealthyGzebUrl(url: string, categorynum?: string): boolean {
  if (!url) return false;
  // 这些目录下的静态详情页在现网经常直接 404，先过滤掉，避免前端展示坏链接。
  if (categorynum?.startsWith('002001004')) return false;
  if (/show-bid-opening\/list|show-bid-result/i.test(url)) return false;
  return true;
}

async function isReachableDetailUrl(url: string): Promise<boolean> {
  if (!url) return false;

  const cached = detailUrlHealthCache.get(url);
  if (cached && Date.now() - cached.checkedAt < DETAIL_URL_HEALTH_TTL_MS) {
    return cached.healthy;
  }

  try {
    const response = await axiosWithSourceProxy<string>('gzebpubservice', {
      method: 'get',
      url,
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    const healthy = response.status >= 200 && response.status < 400;
    detailUrlHealthCache.set(url, { healthy, checkedAt: Date.now() });
    return healthy;
  } catch {
    detailUrlHealthCache.set(url, { healthy: false, checkedAt: Date.now() });
    return false;
  }
}

interface GuangdongNodeLookupResult {
  nodeId?: string;
}

function isShenzhenGuangdongRecord(item: GuangdongItem): boolean {
  const siteCode = normalizeWhitespace(item.siteCode);
  const text = [item.regionName, item.siteName, item.pubServicePlat].map(normalizeWhitespace).join(' ');
  return SHENZHEN_SITE_PREFIXES.some(prefix => siteCode.startsWith(prefix))
    || SHENZHEN_SITE_NAMES.some(keyword => text.includes(keyword));
}

async function resolveGuangdongNodeId(item: GuangdongItem, tradingType: string, classify?: string): Promise<string | null> {
  const bizCode = item.bizCode || item.tradingProcess || '';
  if (!item.siteCode || !bizCode) return null;

  const params = {
    siteCode: item.siteCode,
    tradingType,
    bizCode,
    ...(classify ? { classify } : {})
  };

  try {
    const singleNode = await axiosWithSourceProxy<{ data?: string | null }>('guangdong', {
      method: 'get',
      url: 'https://ygp.gdzwfw.gov.cn/ggzy-portal/center/apis/trading-notice/new/singleNode',
      params,
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://ygp.gdzwfw.gov.cn/'
      }
    });
    const directNodeId = normalizeWhitespace(singleNode.data?.data);
    if (directNodeId) return directNodeId;
  } catch (error) {
    console.warn('Guangdong singleNode lookup failed:', error instanceof Error ? error.message : error);
  }

  try {
    const nodeList = await axiosWithSourceProxy<{ data?: GuangdongNodeLookupResult[] }>('guangdong', {
      method: 'get',
      url: 'https://ygp.gdzwfw.gov.cn/ggzy-portal/center/apis/trading-notice/new/nodeList',
      params,
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://ygp.gdzwfw.gov.cn/'
      }
    });
    const firstNodeId = normalizeWhitespace(nodeList.data?.data?.[0]?.nodeId);
    return firstNodeId || null;
  } catch (error) {
    console.warn('Guangdong nodeList lookup failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

function buildGuangdongPortalDetailUrl(
  item: GuangdongItem,
  options?: { nodeId?: string; tradingType?: string; classify?: string }
): string {
  const bizCode = item.bizCode || item.tradingProcess || '';
  const edition = item.edition || 'v3';
  const tradingType = options?.tradingType || item.noticeSecondType || (item.projectType ? item.projectType.charAt(0) : 'A');
  const classify = options?.classify ?? (item.projectType && item.projectType !== tradingType ? item.projectType : undefined);
  const params = new URLSearchParams({
    noticeId: item.noticeId || '',
    projectCode: item.projectCode || '',
    bizCode,
    siteCode: item.siteCode || '',
    publishDate: item.publishDate || ''
  });

  if (classify) params.set('classify', classify);
  if (options?.nodeId) params.set('nodeId', options.nodeId);

  return `https://ygp.gdzwfw.gov.cn/#/44/new/jygg/${edition}/${tradingType}?${params.toString()}`;
}

async function resolveGuangdongDetail(item: GuangdongItem): Promise<ResolvedTenderDetail | null> {
  const tradingType = item.noticeSecondType || (item.projectType ? item.projectType.charAt(0) : 'A');
  const classify = item.projectType && item.projectType !== tradingType ? item.projectType : undefined;
  const nodeId = await resolveGuangdongNodeId(item, tradingType, classify);
  if (nodeId) {
    return {
      url: buildGuangdongPortalDetailUrl(item, { nodeId, tradingType, classify }),
      sourceId: item.noticeId,
      platform: '广东省公共资源交易平台',
      resolvedBy: 'node-id'
    };
  }

  // 广东平台会索引部分深圳工程公告，但这类 A/A02/A99 详情在广东 SPA 内部无法解析 nodeId。
  // 已验证的稳定入口是按标题回查深圳公共资源交易中心并使用其 details.html。
  if (isShenzhenGuangdongRecord(item)) {
    const szggzyDetail = await findSzggzyDetailByTitle(item.noticeTitle || '');
    if (szggzyDetail) {
      return {
        url: szggzyDetail.url,
        sourceId: szggzyDetail.contentId || item.noticeId,
        platform: '深圳公共资源交易中心',
        resolvedBy: 'origin-fallback'
      };
    }
  }

  console.warn(`Guangdong detail unresolved, skipped: ${stripHtml(item.noticeTitle)} (${item.noticeId ?? 'no-notice-id'})`);
  return null;
}

export async function searchGuangdongYgp(query: string, limit = 20): Promise<SearchResult[]> {
  await guangdongLimiter.wait();

  try {
    const runtimeConfig = await getRuntimeConfig();
    const pageSize = Math.min(Math.max(limit, 10), 50);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (let pageNo = 1; pageNo <= runtimeConfig.guangdongMaxPages && results.length < limit; pageNo += 1) {
      let response: { data: GuangdongResponse };
      try {
        response = await axiosWithSourceProxy<GuangdongResponse>('guangdong', {
          method: 'post',
          url: 'https://ygp.gdzwfw.gov.cn/ggzy-portal/search/v2/items',
          data: {
            keyword: query,
            pageNo,
            pageSize,
            siteCode: '44',
            noticeType: '',
            noticeSecondType: '',
            regionCode: '',
            tradingType: '',
            projectType: '',
            dateRange: ''
          },
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://ygp.gdzwfw.gov.cn/'
          },
          timeout: 20000
        });
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        console.warn(`Guangdong YGP page ${pageNo} failed for "${query}"${status ? ` (status ${status})` : ''}`);
        break;
      }

      const items = response.data.data?.pageData ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        const title = stripHtml(item.noticeTitle);
        const content = stripHtml(item.highlightNoticeContent);
        if (!shouldIncludeTender(title, content)) continue;

        const type = classifyTenderType(title, item.datasetName);
        if (!type) continue;
        const amount = parseAmountWan(content);
        if (amount !== null && amount < 40) continue;
        const region = item.regionName ? normalizeWhitespace(item.regionName) : undefined;
        const city = item.siteName ? normalizeWhitespace(item.siteName) : undefined;
        const unit = item.projectOwner ? normalizeWhitespace(item.projectOwner) : undefined;
        const noticeType = item.noticeThirdTypeDesc ? normalizeWhitespace(item.noticeThirdTypeDesc) : undefined;

        const key = `${title}|${item.noticeId ?? ''}|${item.publishDate ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const detail = await resolveGuangdongDetail(item);
        if (!detail) continue;

        results.push(...toTenderResult({
          title,
          url: detail.url,
          source: 'guangdong',
          sourceId: detail.sourceId || item.noticeId,
          publishedAt: parseCompactDate(item.publishDate),
          tender: {
            type,
            region,
            city,
            unit,
            budgetWan: amount ?? undefined,
            noticeType,
            platform: detail.platform || '广东省公共资源交易平台'
          },
          content: buildTenderContent([
            `平台：${detail.platform || '广东省公共资源交易平台'}`,
            `分类：${type}`,
            region ? `地区：${region}` : null,
            city ? `站点：${city}` : null,
            unit ? `单位：${unit}` : null,
            noticeType ? `公告类型：${noticeType}` : null,
            amount !== null ? `预算：${amount} 万元` : null,
            `详情解析：${detail.resolvedBy}`,
            content || null
          ])
        }));

        if (results.length >= limit) break;
      }
    }

    console.log(`Guangdong YGP search for "${query}": found ${results.length} filtered results`);
    return results.slice(0, limit);
  } catch (error) {
    console.error('Guangdong YGP search error:', error instanceof Error ? error.message : error);
    return [];
  }
}
