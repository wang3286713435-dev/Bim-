import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { serializeDailyReportShape } from './dailyReports.js';
import { isFeishuWebhookEnabled, sendFeishuWebhookMessage } from './feishu.js';

type DailyReportKeywordStat = {
  keywordId: string;
  label: string;
  slug: string;
  category: string | null;
  count: number;
};

type DailyReportMeta = {
  candidateArticleCount: number;
  selectedArticleCount: number;
  freshArticleCount: number;
  supplementalArticleCount: number;
  sourceCount: number;
  editorialAngle?: string;
};

type DailyReportCardInput = {
  id: string;
  reportDate: string;
  reportDateLabel?: string;
  title: string;
  intro: string;
  executiveSummary: string;
  highlights: string[];
  recommendedActions: string[];
  sourceCount: number;
  articleCount: number;
  generatedAt: string;
  meta: DailyReportMeta;
  keywordStats: DailyReportKeywordStat[];
};

type DailyPushLogRecord = {
  id: string;
  reportId: string;
  triggerType: string;
  channel: string;
  status: string;
  payloadDigest: string | null;
  errorMessage: string | null;
  pushedAt: Date | null;
  createdAt: Date;
};

export type DailyPushStateSummary = ReturnType<typeof summarizeDailyPushState>;

const DAILY_REPORT_FEISHU_AUTO_PUSH = process.env.DAILY_REPORT_FEISHU_AUTO_PUSH !== 'false';
const DAILY_REPORT_FEISHU_PUSH_ON_MANUAL = process.env.DAILY_REPORT_FEISHU_PUSH_ON_MANUAL === 'true';
const DAILY_REPORT_FEISHU_HIGHLIGHT_LIMIT = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_FEISHU_HIGHLIGHT_LIMIT || '4', 10) || 4);
const DAILY_REPORT_FEISHU_ACTION_LIMIT = Math.max(1, Number.parseInt(process.env.DAILY_REPORT_FEISHU_ACTION_LIMIT || '3', 10) || 3);

function compact(value: string, maxLength = 180): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatReportDateLabel(reportDateIso: string): string {
  const date = new Date(reportDateIso);
  if (Number.isNaN(date.getTime())) return reportDateIso.slice(0, 10);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getBaseClientUrl(): string {
  return (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
}

export function buildDailyReportRouteUrl(baseUrl: string, reportId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('tab', 'daily');
  url.searchParams.set('reportId', reportId);
  return url.toString();
}

function getKeywordOverview(report: DailyReportCardInput): string {
  const topKeywords = report.keywordStats
    .slice(0, 3)
    .map((item) => `${item.label} ${item.count}`)
    .join('｜');
  return topKeywords || '今日未形成明显关键词集中';
}

function buildHighlightElements(report: DailyReportCardInput) {
  const highlights = report.highlights.slice(0, DAILY_REPORT_FEISHU_HIGHLIGHT_LIMIT);
  if (highlights.length === 0) {
    return [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**今日无新增**\n今日候选池未形成需要立即上报管理层的新资讯，建议继续观察重点来源。'
        }
      }
    ];
  }

  return highlights.map((item, index) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**今日重点 ${index + 1}**\n${compact(item, 180)}`
    }
  }));
}

function buildActionElements(report: DailyReportCardInput) {
  const actions = report.recommendedActions.slice(0, DAILY_REPORT_FEISHU_ACTION_LIMIT);
  if (actions.length === 0) {
    return [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**建议跟踪**\n继续观察政策、标准与案例来源更新，暂无新增专项动作。'
        }
      }
    ];
  }

  return actions.map((item, index) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**建议跟踪 ${index + 1}**\n${compact(item, 180)}`
    }
  }));
}

export function buildDailyReportFeishuCard(options: {
  report: DailyReportCardInput;
  reportUrl: string;
}) {
  const { report, reportUrl } = options;
  const dateLabel = report.reportDateLabel || formatReportDateLabel(report.reportDate);
  const noNewItems = report.articleCount === 0;

  return {
    msg_type: 'interactive',
    card: {
      config: {
        wide_screen_mode: true,
        enable_forward: true
      },
      header: {
        template: noNewItems ? 'grey' : 'blue',
        title: {
          tag: 'plain_text',
          content: `BIM 日报 | ${dateLabel}`
        }
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${report.title}**\n${compact(report.intro || report.executiveSummary || '今日 BIM 行业资讯已生成。', 180)}`
          }
        },
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: `**管理层摘要**\n${compact(report.executiveSummary || report.intro || '今日无新增重点资讯。', 120)}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**关键词命中**\n${getKeywordOverview(report)}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**收录来源**\n${report.sourceCount}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**候选 / 入选**\n${report.meta.candidateArticleCount} / ${report.articleCount}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**今日新增 / 延续**\n${report.meta.freshArticleCount} / ${report.meta.supplementalArticleCount}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**编辑角度**\n${compact(report.meta.editorialAngle || '优先提炼政策、趋势、案例与标准信号。', 80)}` } }
          ]
        },
        ...buildHighlightElements(report),
        ...buildActionElements(report),
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              type: 'primary',
              text: {
                tag: 'plain_text',
                content: '查看平台内日报'
              },
              url: reportUrl
            }
          ]
        }
      ]
    }
  };
}

function digestPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function canAutoPushDailyReport(triggerType: 'manual' | 'scheduled'): boolean {
  if (!DAILY_REPORT_FEISHU_AUTO_PUSH) return false;
  if (triggerType === 'manual') return DAILY_REPORT_FEISHU_PUSH_ON_MANUAL;
  return true;
}

export function summarizeDailyPushState(log: DailyPushLogRecord) {
  return {
    id: log.id,
    reportId: log.reportId,
    triggerType: log.triggerType,
    channel: log.channel,
    status: log.status,
    errorMessage: log.errorMessage,
    payloadDigest: log.payloadDigest,
    pushedAt: log.pushedAt?.toISOString() || null,
    createdAt: log.createdAt.toISOString()
  };
}

async function getDailyReportForPush(reportId: string): Promise<DailyReportCardInput> {
  const report = await prisma.dailyReport.findUnique({ where: { id: reportId } });
  if (!report) {
    throw new Error('Daily report not found');
  }
  return serializeDailyReportShape(report);
}

async function createPushLog(input: {
  reportId: string;
  triggerType: string;
  status: string;
  payloadDigest?: string | null;
  errorMessage?: string | null;
  pushedAt?: Date | null;
}) {
  const log = await prisma.dailyReportPushLog.create({
    data: {
      reportId: input.reportId,
      triggerType: input.triggerType,
      channel: 'feishu_webhook',
      status: input.status,
      payloadDigest: input.payloadDigest || null,
      errorMessage: input.errorMessage || null,
      pushedAt: input.pushedAt || null
    }
  });
  return summarizeDailyPushState(log);
}

async function hasSuccessfulPush(reportId: string): Promise<boolean> {
  const existing = await prisma.dailyReportPushLog.findFirst({
    where: {
      reportId,
      channel: 'feishu_webhook',
      status: 'sent'
    },
    orderBy: { createdAt: 'desc' }
  });
  return Boolean(existing);
}

export async function pushDailyReportToFeishu(reportId: string, options?: {
  triggerType?: 'manual' | 'scheduled' | 'manual_push';
  force?: boolean;
}) {
  const triggerType = options?.triggerType || 'manual_push';

  if (!isFeishuWebhookEnabled()) {
    return {
      status: 'skipped' as const,
      log: await createPushLog({
        reportId,
        triggerType,
        status: 'skipped',
        errorMessage: 'Feishu webhook is not configured'
      })
    };
  }

  if (!options?.force && triggerType === 'scheduled' && await hasSuccessfulPush(reportId)) {
    return {
      status: 'skipped' as const,
      log: await createPushLog({
        reportId,
        triggerType,
        status: 'skipped',
        errorMessage: 'A successful Feishu push already exists for this daily report'
      })
    };
  }

  const report = await getDailyReportForPush(reportId);
  const reportUrl = buildDailyReportRouteUrl(getBaseClientUrl(), report.id);
  const payload = buildDailyReportFeishuCard({ report, reportUrl });
  const payloadDigest = digestPayload(payload);
  const sendResult = await sendFeishuWebhookMessage(payload);

  if (sendResult.ok) {
    return {
      status: 'sent' as const,
      log: await createPushLog({
        reportId,
        triggerType,
        status: 'sent',
        payloadDigest,
        pushedAt: new Date()
      })
    };
  }

  return {
    status: sendResult.skipped ? 'skipped' as const : 'failed' as const,
    log: await createPushLog({
      reportId,
      triggerType,
      status: sendResult.skipped ? 'skipped' : 'failed',
      payloadDigest,
      errorMessage: sendResult.errorMessage || null
    })
  };
}

export async function autoPushDailyReportToFeishu(reportId: string, triggerType: 'manual' | 'scheduled') {
  if (!canAutoPushDailyReport(triggerType)) {
    return {
      status: 'skipped' as const,
      reason: triggerType === 'manual'
        ? 'Manual daily report generation does not auto-push to Feishu by default'
        : 'Daily report Feishu auto-push is disabled'
    };
  }

  const result = await pushDailyReportToFeishu(reportId, {
    triggerType,
    force: false
  });

  return {
    status: result.status,
    log: result.log
  };
}

export async function getLatestDailyReportPushLog() {
  const log = await prisma.dailyReportPushLog.findFirst({
    orderBy: { createdAt: 'desc' }
  });
  return log ? summarizeDailyPushState(log) : null;
}

export async function listRecentDailyReportPushLogs(limit = 5) {
  const logs = await prisma.dailyReportPushLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 20))
  });
  return logs.map((log) => summarizeDailyPushState(log));
}
