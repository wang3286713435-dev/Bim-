import axios from 'axios';
import type { SearchResult } from '../types.js';
import { getRuntimeConfig } from './runtimeConfig.js';

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
const gzebLimiter = new RateLimiter(1500);
const szygcgptLimiter = new RateLimiter(1500);
const guangdongLimiter = new RateLimiter(5000);

const EXCLUDE_TITLE = ['材料采购', '监理', '劳务', '设备租赁', '结果公示', '候选人公示', '合同公示', '合同公告', '中标结果', '成交结果', '中选结果', '终止', '失败', '流标', '废标', '投诉', '质疑'];
const INCLUDE_TITLE = ['BIM', '建筑信息模型', '智慧建造', 'CIM', '数字孪生', '正向设计'];
const SHENZHEN_SITE_PREFIXES = ['4403'];
const SHENZHEN_SITE_NAMES = ['深圳', '福田', '罗湖', '南山', '宝安', '龙岗', '龙华', '坪山', '光明', '盐田', '大鹏', '深汕'];
const DETAIL_URL_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const detailUrlHealthCache = new Map<string, { healthy: boolean; checkedAt: number }>();

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

function parseUnit(value: string | null | undefined): string {
  const match = normalizeWhitespace(value).match(/(?:招标单位|建设单位|采购人|招标人)[：:]?\s*([^\n]{2,60})/);
  return match?.[1]?.trim() ?? '';
}

function shouldIncludeTender(title: string, content: string): boolean {
  const text = `${title} ${content}`;
  if (EXCLUDE_TITLE.some(keyword => text.includes(keyword))) return false;
  return INCLUDE_TITLE.some(keyword => text.toUpperCase().includes(keyword.toUpperCase()));
}

function classifyTenderType(title: string, datasetName = ''): string | null {
  const text = `${title} ${datasetName}`.toUpperCase();
  if (text.includes('结果') || text.includes('中标') || text.includes('成交')) return null;
  if (text.includes('全过程') || (text.includes('EPC') && text.includes('BIM'))) return '全过程BIM';
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
  const response = await axios.post<SzggzyResponse>(
    'https://www.szggzy.com/cms/api/v1/trade/es/content/page',
    {
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
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.szggzy.com/globalSearch/index.html'
      },
      timeout: 20000
    }
  );

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

  try {
    const response = await axios.post<GzebResponse>(
      'http://www.gzebpubservice.cn/inteligentsearchfw/rest/esinteligentsearch/getFullTextDataNew',
      {
        pn: 1,
        rn: limit,
        sdt: '',
        edt: '',
        wd: query,
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
      {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 20000
      }
    );

    if (response.data.code !== 200 || !response.data.content) {
      console.log(`GZEB search: no results or API error (code: ${response.data.code ?? 'unknown'})`);
      return [];
    }

    const parsed = JSON.parse(response.data.content) as GzebContent;
    const records = parsed.result?.records ?? [];
    const resultsByTitle = new Map<string, SearchResult>();

    for (const record of records) {
      const title = stripHtml(record.title);
      const content = stripHtml(record.content);
      if (!shouldIncludeTender(title, content)) continue;

      const type = classifyTenderType(title);
      if (!type) continue;
      const amount = parseAmountWan(content);
      if (amount !== null && amount < 40) continue;

      const url = record.linkurl ? new URL(record.linkurl, 'http://www.gzebpubservice.cn/').toString() : '';
      // 广州平台部分 category 会返回已失效的静态详情页，先直接跳过，避免前端出现 404。
      if (!isHealthyGzebUrl(url, record.categorynum)) continue;
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
      const existing = resultsByTitle.get(key);
      if (!existing) {
        resultsByTitle.set(key, candidate);
        continue;
      }

      const existingIsStatic = existing.url.includes('gzebpubservice.cn/jyfw/');
      const candidateIsStatic = candidate.url.includes('gzebpubservice.cn/jyfw/');
      if (!existingIsStatic && candidateIsStatic) {
        resultsByTitle.set(key, candidate);
        continue;
      }

      const existingHasAnnouncement = /招标公告|采购公告|竞价公告/.test(existing.title);
      const candidateHasAnnouncement = /招标公告|采购公告|竞价公告/.test(candidate.title);
      if (!existingHasAnnouncement && candidateHasAnnouncement) {
        resultsByTitle.set(key, candidate);
      }
    }

    const results = [...resultsByTitle.values()];
    console.log(`GZEB search for "${query}": found ${results.length} filtered results`);
    return results;
  } catch (error) {
    console.error('GZEB search error:', error instanceof Error ? error.message : error);
    return [];
  }
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
    const response = await axios.get<SzygcgptDetailResponse>(endpoint, {
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
      const response = await axios.post<SzygcgptResponse>(
        'https://www.szygcgpt.com/app/home/pageGGList.do',
        {
          page,
          rows,
          keyWords: query
        },
        {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://www.szygcgpt.com/ygcg/purchaseInfoList'
          },
          timeout: 20000
        }
      );

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
  return true;
}

async function isReachableDetailUrl(url: string): Promise<boolean> {
  if (!url) return false;

  const cached = detailUrlHealthCache.get(url);
  if (cached && Date.now() - cached.checkedAt < DETAIL_URL_HEALTH_TTL_MS) {
    return cached.healthy;
  }

  try {
    const response = await axios.get(url, {
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
    const singleNode = await axios.get<{ data?: string | null }>(
      'https://ygp.gdzwfw.gov.cn/ggzy-portal/center/apis/trading-notice/new/singleNode',
      {
        params,
        timeout: 15000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://ygp.gdzwfw.gov.cn/'
        }
      }
    );
    const directNodeId = normalizeWhitespace(singleNode.data?.data);
    if (directNodeId) return directNodeId;
  } catch (error) {
    console.warn('Guangdong singleNode lookup failed:', error instanceof Error ? error.message : error);
  }

  try {
    const nodeList = await axios.get<{ data?: GuangdongNodeLookupResult[] }>(
      'https://ygp.gdzwfw.gov.cn/ggzy-portal/center/apis/trading-notice/new/nodeList',
      {
        params,
        timeout: 15000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://ygp.gdzwfw.gov.cn/'
        }
      }
    );
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
        response = await axios.post<GuangdongResponse>(
          'https://ygp.gdzwfw.gov.cn/ggzy-portal/search/v2/items',
          {
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
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': 'Mozilla/5.0',
              Referer: 'https://ygp.gdzwfw.gov.cn/'
            },
            timeout: 20000
          }
        );
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
