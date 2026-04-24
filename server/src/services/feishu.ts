import axios from 'axios';
import crypto from 'node:crypto';

export interface FeishuHotspot {
  id: string;
  title: string;
  url: string;
  source: string;
  importance: string;
  relevance: number;
  summary: string | null;
  createdAt: Date;
  publishedAt?: Date | null;
  tenderType?: string | null;
  tenderRegion?: string | null;
  tenderCity?: string | null;
  tenderUnit?: string | null;
  tenderBudgetWan?: number | null;
  tenderDeadline?: Date | null;
  tenderBidOpenTime?: Date | null;
  tenderDocDeadline?: Date | null;
  tenderProjectCode?: string | null;
  tenderContact?: string | null;
  tenderPhone?: string | null;
  tenderEmail?: string | null;
  tenderQualification?: string | null;
  tenderServiceScope?: string | null;
  tenderDetailSource?: string | null;
  tenderDetailExtractedAt?: Date | null;
  keyword?: { text: string } | null;
}

type FeishuFieldType = 1 | 2 | 3 | 4 | 5 | 15;

type FeishuFieldDefinition = {
  field_name: string;
  type: FeishuFieldType;
  property?: Record<string, unknown> | null;
};

type FeishuFieldItem = {
  field_id: string;
  field_name: string;
  type: number;
  ui_type: string;
  property?: Record<string, unknown> | null;
};

type FeishuRecordItem = {
  record_id: string;
  fields: Record<string, unknown>;
};

const FEISHU_API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn/open-apis';

const REQUIRED_BITABLE_FIELDS: FeishuFieldDefinition[] = [
  { field_name: '系统ID', type: 1 },
  { field_name: '项目编号', type: 1 },
  { field_name: '开标时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' } },
  { field_name: '文件截止', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' } },
  { field_name: '联系电话', type: 1 },
  { field_name: '邮箱', type: 1 },
  { field_name: '服务范围', type: 1 },
  { field_name: '资格要求', type: 1 },
  { field_name: '详情来源', type: 1 },
  { field_name: '解析时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy/MM/dd HH:mm' } },
  { field_name: '相关性', type: 2, property: { formatter: '0' } },
  { field_name: '摘要', type: 1 },
  { field_name: '字段完整度', type: 2, property: { formatter: '0' } },
  { field_name: '建议动作', type: 1 },
  { field_name: '商机判断', type: 1 },
  { field_name: '详情可靠性', type: 1 }
];

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  return value.includes('your_') || value.includes('example') || value.includes('replace_');
}

function formatBudget(value: number | null | undefined): string {
  if (value == null) return '未披露';
  if (value >= 10000) return `${(value / 10000).toFixed(2)} 亿元`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} 万元`;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '未披露';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '未披露';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function toTimestamp(value: Date | string | null | undefined): number | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.getTime();
}

function compact(value: string | null | undefined, maxLength = 800): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function getEffectiveDeadline(hotspot: FeishuHotspot): Date | null {
  return hotspot.tenderDeadline || hotspot.tenderBidOpenTime || hotspot.tenderDocDeadline || null;
}

function getDeadlineLabel(hotspot: FeishuHotspot): string {
  return formatDate(getEffectiveDeadline(hotspot));
}

function getImportanceLabel(importance: string): string {
  const map: Record<string, string> = {
    low: '线索池',
    medium: '一般跟进',
    high: '重点评估',
    urgent: '立即跟进'
  };
  return map[importance] || importance;
}

function getPriorityLabel(hotspot: FeishuHotspot): string {
  return hotspot.importance === 'urgent' || hotspot.importance === 'high' || hotspot.relevance >= 75 ? '高' : '中';
}

function getTenderFieldCompleteness(hotspot: FeishuHotspot): number {
  return [
    hotspot.tenderUnit ? 16 : 0,
    hotspot.tenderBudgetWan != null ? 14 : 0,
    hotspot.tenderDeadline ? 16 : 0,
    hotspot.tenderBidOpenTime ? 8 : 0,
    hotspot.tenderDocDeadline ? 6 : 0,
    hotspot.tenderProjectCode ? 10 : 0,
    hotspot.tenderServiceScope ? 10 : 0,
    hotspot.tenderQualification ? 8 : 0,
    hotspot.tenderContact ? 3 : 0,
    hotspot.tenderPhone ? 3 : 0,
    hotspot.tenderEmail ? 3 : 0,
    hotspot.tenderDetailSource ? 3 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function getStatusLabel(hotspot: FeishuHotspot): string {
  const deadline = getEffectiveDeadline(hotspot);
  const time = toTimestamp(deadline);
  if (!time) return '待确认';
  if (time < Date.now()) return '已截止';
  return '正在招标';
}

function getSourceLabel(source: string): string {
  const map: Record<string, string> = {
    szggzy: '深圳公共资源交易中心',
    guangdong: '广东省公共资源交易平台',
    gdebpubservice: '广州公共资源交易公共服务平台',
    gzebpubservice: '广州公共资源交易公共服务平台',
    szygcgpt: '深圳阳光采购平台'
  };
  return map[source] || source;
}

function getTypeLabel(hotspot: FeishuHotspot): string {
  if (hotspot.tenderType) return hotspot.tenderType;
  const title = hotspot.title;
  if (title.includes('设计')) return '设计BIM';
  if (title.includes('施工')) return '施工BIM';
  return '其他BIM';
}

function getRegionLabel(hotspot: FeishuHotspot): string {
  return [hotspot.tenderRegion, hotspot.tenderCity].filter(Boolean).join(' / ') || '未标注';
}

function getDetailReliability(hotspot: FeishuHotspot): string {
  if (hotspot.url.includes('show-bid-opening/list') || /中标|成交|结果公告|候选人公示/.test(hotspot.title)) return '低可信结果页';
  if (hotspot.tenderDetailSource?.includes('firecrawl-detail-json') || hotspot.tenderDetailSource?.includes('detail-enrichment+agent-firecrawl')) return '深抓取详情';
  if (hotspot.tenderDetailSource?.includes('szggzy-api+rules') || hotspot.tenderDetailSource?.includes('source-detail+rules') || hotspot.tenderDetailSource?.includes('detail-enrichment')) return '官方详情已解析';
  if (hotspot.url.includes('szggzy.com/globalSearch/details.html')) return '深圳原始详情';
  if (hotspot.url.includes('nodeId=')) return '已解析详情';
  if (hotspot.url.includes('detailTop') || hotspot.url.includes('gzebpubservice.cn/jyfw/')) return '原始详情已校验';
  if (hotspot.tenderDetailSource?.includes('firecrawl')) return 'Firecrawl正文';
  return '待人工核验';
}

function getBusinessDecision(hotspot: FeishuHotspot): { judgement: string; action: string } {
  const deadline = getEffectiveDeadline(hotspot);
  const deadlineTs = toTimestamp(deadline);
  const completeness = getTenderFieldCompleteness(hotspot);

  if (deadlineTs && deadlineTs < Date.now()) {
    return { judgement: '已过期项目', action: '归档观察' };
  }
  if ((hotspot.importance === 'urgent' || hotspot.importance === 'high' || hotspot.relevance >= 80) && completeness >= 55) {
    return { judgement: '建议优先跟进', action: '立即核对投标窗口' };
  }
  if (completeness < 45) {
    return { judgement: '信息待补齐', action: '补齐单位/预算/截止时间' };
  }
  if (hotspot.tenderType?.includes('设计')) {
    return { judgement: '可纳入设计类机会池', action: '评估设计团队匹配度' };
  }
  if (hotspot.tenderType?.includes('施工')) {
    return { judgement: '可纳入施工类机会池', action: '评估施工阶段 BIM 资源' };
  }
  return { judgement: '进入常规线索池', action: '进入商机初筛' };
}

function shouldNotifyFeishuWebhook(hotspot: FeishuHotspot): boolean {
  const deadlineTs = toTimestamp(getEffectiveDeadline(hotspot));
  const completeness = getTenderFieldCompleteness(hotspot);
  const isExpired = Boolean(deadlineTs && deadlineTs < Date.now());
  const hasBusinessCore = Boolean(hotspot.tenderUnit && hotspot.tenderBudgetWan != null);
  const valuable = hotspot.importance === 'urgent' || hotspot.importance === 'high' || hotspot.relevance >= 80;
  return !isExpired && completeness >= 45 && (valuable || hasBusinessCore);
}

function getFeishuWebhookConfig() {
  const webhook = process.env.FEISHU_BOT_WEBHOOK_URL;
  const secret = process.env.FEISHU_BOT_SECRET;
  return {
    enabled: !isPlaceholder(webhook),
    webhook,
    secret
  };
}

function getBitableConfig() {
  return {
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN,
    tableId: process.env.FEISHU_BITABLE_TABLE_ID
  };
}

function buildWebhookSign(secret: string, timestamp: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

export function isFeishuWebhookEnabled(): boolean {
  return getFeishuWebhookConfig().enabled;
}

export function isFeishuBitableEnabled(): boolean {
  return !isPlaceholder(process.env.FEISHU_APP_ID)
    && !isPlaceholder(process.env.FEISHU_APP_SECRET)
    && !isPlaceholder(process.env.FEISHU_BITABLE_APP_TOKEN)
    && !isPlaceholder(process.env.FEISHU_BITABLE_TABLE_ID);
}

async function sendFeishuWebhookCard(hotspot: FeishuHotspot, options?: { force?: boolean }): Promise<boolean> {
  const config = getFeishuWebhookConfig();
  if (!config.enabled || !config.webhook) return false;
  if (!options?.force && !shouldNotifyFeishuWebhook(hotspot)) return false;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = config.secret ? buildWebhookSign(config.secret, timestamp) : undefined;
  const completeness = getTenderFieldCompleteness(hotspot);
  const decision = getBusinessDecision(hotspot);

  try {
    await axios.post(config.webhook, {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true, enable_forward: true },
        header: {
          template: hotspot.importance === 'urgent' ? 'red' : hotspot.importance === 'high' ? 'orange' : 'blue',
          title: {
            tag: 'plain_text',
            content: `bim_tender | ${getImportanceLabel(hotspot.importance)}`
          }
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**${hotspot.title}**\n${compact(hotspot.summary || hotspot.tenderServiceScope || '系统已发现新的 BIM 招采公告，建议进入详情页复核字段。', 180)}`
            }
          },
          {
            tag: 'div',
            fields: [
              { is_short: true, text: { tag: 'lark_md', content: `**来源**\n${getSourceLabel(hotspot.source)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**监控词**\n${hotspot.keyword?.text || '临时搜索'}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**地区**\n${getRegionLabel(hotspot)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**预算**\n${formatBudget(hotspot.tenderBudgetWan)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**截止**\n${getDeadlineLabel(hotspot)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**项目编号**\n${hotspot.tenderProjectCode || '未披露'}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**单位**\n${hotspot.tenderUnit || '未披露'}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**相关性**\n${hotspot.relevance}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**字段完整度**\n${completeness}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**建议动作**\n${decision.action}` } }
            ]
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '打开原始公告' },
                type: 'primary',
                url: hotspot.url
              }
            ]
          }
        ]
      },
      ...(sign ? { timestamp, sign } : {})
    }, { timeout: 15000 });

    return true;
  } catch (error) {
    console.error('Failed to send Feishu webhook:', error);
    return false;
  }
}

let tenantAccessTokenCache: { token: string; expiresAt: number } | null = null;

async function getTenantAccessToken(): Promise<string | null> {
  if (!isFeishuBitableEnabled()) return null;
  if (tenantAccessTokenCache && tenantAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return tenantAccessTokenCache.token;
  }

  try {
    const response = await axios.post(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    }, { timeout: 15000 });

    const token = response.data?.tenant_access_token as string | undefined;
    const expire = Number(response.data?.expire || 0);
    if (!token) return null;
    tenantAccessTokenCache = { token, expiresAt: Date.now() + expire * 1000 };
    return token;
  } catch (error) {
    console.error('Failed to get Feishu tenant access token:', error);
    return null;
  }
}

async function feishuRequest<T>(config: {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  data?: unknown;
  params?: Record<string, string | number | undefined>;
}): Promise<T> {
  const token = await getTenantAccessToken();
  if (!token) {
    throw new Error('Feishu tenant access token unavailable');
  }

  const response = await axios({
    method: config.method,
    url: `${FEISHU_API_BASE}${config.path}`,
    data: config.data,
    params: config.params,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  return response.data as T;
}

async function listBitableFields(): Promise<FeishuFieldItem[]> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return [];

  const response = await feishuRequest<{ data: { items: FeishuFieldItem[] } }>({
    method: 'get',
    path: `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    params: { page_size: 500 }
  });
  return response.data.items;
}

async function createBitableField(field: FeishuFieldDefinition): Promise<void> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return;

  await feishuRequest({
    method: 'post',
    path: `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    data: field
  });
}

export async function ensureFeishuBitableFields(): Promise<{ created: string[]; existing: string[] }> {
  if (!isFeishuBitableEnabled()) {
    return { created: [], existing: [] };
  }

  const fields = await listBitableFields();
  const existingNames = new Set(fields.map(item => item.field_name));
  const created: string[] = [];
  const existing: string[] = [];

  for (const field of REQUIRED_BITABLE_FIELDS) {
    if (existingNames.has(field.field_name)) {
      existing.push(field.field_name);
      continue;
    }
    await createBitableField(field);
    created.push(field.field_name);
  }

  return { created, existing };
}

async function listAllBitableRecords(): Promise<FeishuRecordItem[]> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return [];

  const items: FeishuRecordItem[] = [];
  let pageToken: string | undefined;

  while (true) {
    const response = await feishuRequest<{
      data: {
        items: FeishuRecordItem[];
        has_more: boolean;
        page_token?: string;
      };
    }>({
      method: 'get',
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      params: {
        page_size: 500,
        page_token: pageToken
      }
    });

    items.push(...response.data.items);
    if (!response.data.has_more || !response.data.page_token) break;
    pageToken = response.data.page_token;
  }

  return items;
}

function buildBitableFields(hotspot: FeishuHotspot): Record<string, unknown> {
  const decision = getBusinessDecision(hotspot);
  return {
    项目名称: hotspot.title,
    地区: getRegionLabel(hotspot),
    类型: getTypeLabel(hotspot),
    发布时间: toTimestamp(hotspot.publishedAt),
    招标人: hotspot.tenderUnit || '',
    预算: hotspot.tenderBudgetWan ?? undefined,
    截止日期: toTimestamp(getEffectiveDeadline(hotspot)),
    平台来源: getSourceLabel(hotspot.source),
    招标文件链接: {
      text: '招标链接',
      link: hotspot.url
    },
    状态: getStatusLabel(hotspot),
    优先级: getPriorityLabel(hotspot),
    搜索关键词: hotspot.keyword?.text ? [hotspot.keyword.text] : [],
    联系人: hotspot.tenderContact || '',
    系统ID: hotspot.id,
    项目编号: hotspot.tenderProjectCode || '',
    开标时间: toTimestamp(hotspot.tenderBidOpenTime),
    文件截止: toTimestamp(hotspot.tenderDocDeadline),
    联系电话: hotspot.tenderPhone || '',
    邮箱: hotspot.tenderEmail || '',
    服务范围: compact(hotspot.tenderServiceScope, 1000),
    资格要求: compact(hotspot.tenderQualification, 1000),
    详情来源: hotspot.tenderDetailSource || '',
    解析时间: toTimestamp(hotspot.tenderDetailExtractedAt),
    相关性: hotspot.relevance,
    摘要: compact(hotspot.summary, 1000),
    字段完整度: getTenderFieldCompleteness(hotspot),
    建议动作: decision.action,
    商机判断: decision.judgement,
    详情可靠性: getDetailReliability(hotspot)
  };
}

async function createBitableRecord(hotspot: FeishuHotspot): Promise<boolean> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return false;

  try {
    await feishuRequest({
      method: 'post',
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      data: { fields: buildBitableFields(hotspot) }
    });
    return true;
  } catch (error) {
    console.error('Failed to create Feishu bitable record:', error);
    return false;
  }
}

async function updateBitableRecord(recordId: string, hotspot: FeishuHotspot): Promise<boolean> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return false;

  try {
    await feishuRequest({
      method: 'put',
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      data: { fields: buildBitableFields(hotspot) }
    });
    return true;
  } catch (error) {
    console.error('Failed to update Feishu bitable record:', error);
    return false;
  }
}

async function deleteBitableRecord(recordId: string): Promise<boolean> {
  const { appToken, tableId } = getBitableConfig();
  if (!appToken || !tableId) return false;

  try {
    await feishuRequest({
      method: 'delete',
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`
    });
    return true;
  } catch (error) {
    console.error('Failed to delete Feishu bitable record:', error);
    return false;
  }
}

export async function clearFeishuBitableRecords(): Promise<{ total: number; deleted: number }> {
  const records = await listAllBitableRecords();
  let deleted = 0;
  for (const record of records) {
    if (await deleteBitableRecord(record.record_id)) {
      deleted += 1;
    }
  }
  return { total: records.length, deleted };
}

export async function syncHotspotsToFeishuBitable(
  hotspots: FeishuHotspot[],
  options: { clearFirst?: boolean } = {}
): Promise<{ created: number; updated: number; deleted: number; total: number; createdFields: string[] }> {
  if (!isFeishuBitableEnabled()) {
    return { created: 0, updated: 0, deleted: 0, total: 0, createdFields: [] };
  }

  const fieldResult = await ensureFeishuBitableFields();
  let deleted = 0;
  let existingRecords: FeishuRecordItem[];

  if (options.clearFirst) {
    const clearResult = await clearFeishuBitableRecords();
    deleted = clearResult.deleted;
    existingRecords = [];
  } else {
    existingRecords = await listAllBitableRecords();
  }

  const recordBySystemId = new Map<string, FeishuRecordItem>();
  const recordByUrl = new Map<string, FeishuRecordItem>();
  const recordByTitle = new Map<string, FeishuRecordItem>();

  for (const record of existingRecords) {
    const systemId = typeof record.fields['系统ID'] === 'string' ? record.fields['系统ID'] : undefined;
    const title = typeof record.fields['项目名称'] === 'string' ? record.fields['项目名称'] : undefined;
    const urlValue = record.fields['招标文件链接'] as { link?: string } | undefined;
    if (systemId) recordBySystemId.set(systemId, record);
    if (urlValue?.link) recordByUrl.set(urlValue.link, record);
    if (title) recordByTitle.set(title, record);
  }

  let created = 0;
  let updated = 0;

  for (const hotspot of hotspots) {
    const existing = recordBySystemId.get(hotspot.id) || recordByUrl.get(hotspot.url) || recordByTitle.get(hotspot.title);
    if (existing) {
      if (await updateBitableRecord(existing.record_id, hotspot)) {
        updated += 1;
      }
    } else if (await createBitableRecord(hotspot)) {
      created += 1;
    }
  }

  return {
    created,
    updated,
    deleted,
    total: hotspots.length,
    createdFields: fieldResult.created
  };
}

export async function notifyFeishu(hotspot: FeishuHotspot): Promise<{ webhook: boolean; bitable: boolean }> {
  const [webhook, bitable] = await Promise.all([
    sendFeishuWebhookCard(hotspot),
    createBitableRecord(hotspot)
  ]);
  return { webhook, bitable };
}

export async function notifyFeishuWebhook(hotspot: FeishuHotspot, options?: { force?: boolean }): Promise<boolean> {
  return sendFeishuWebhookCard(hotspot, options);
}
