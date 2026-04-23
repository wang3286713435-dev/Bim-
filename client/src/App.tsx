import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileSearch,
  Flame,
  Gavel,
  Layers3,
  MapPin,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  TimerReset,
  Trash2,
  WalletCards,
  X
} from 'lucide-react';
import {
  hotspotsApi,
  keywordsApi,
  notificationsApi,
  triggerHotspotCheck,
  type CrawlRun,
  type Hotspot,
  type Keyword,
  type Notification,
  type OpsSummary,
  type Stats
} from './services/api';
import { onNewHotspot, onNotification, subscribeToKeywords } from './services/socket';
import FilterSortBar, { defaultFilterState, type FilterState } from './components/FilterSortBar';
import { BackgroundBeams } from './components/ui/background-beams';
import { Spotlight } from './components/ui/spotlight';
import { cn } from './lib/utils';
import { relativeTime, formatDateTime } from './utils/relativeTime';
import { sortHotspots } from './utils/sortHotspots';

type TabKey = 'opportunities' | 'dashboard' | 'keywords' | 'search';

type Bucket = {
  label: string;
  value: number;
};

const TAB_ITEMS: Array<{ key: TabKey; label: string; icon: typeof Radar }> = [
  { key: 'opportunities', label: '投标机会', icon: Gavel },
  { key: 'dashboard', label: '数据分析', icon: Radar },
  { key: 'keywords', label: '监控词', icon: Target },
  { key: 'search', label: '临时搜索', icon: Search }
];

const SOURCE_LABELS: Record<string, string> = {
  szggzy: '深圳交易中心',
  szygcgpt: '深圳阳光采购',
  guangdong: '广东交易平台',
  gzebpubservice: '广州交易平台'
};

function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

function getHealthTone(ok: boolean, circuitOpen?: boolean): string {
  if (circuitOpen) return 'text-red-300 bg-red-500/10 border-red-400/20';
  if (ok) return 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20';
  return 'text-amber-200 bg-amber-500/10 border-amber-400/20';
}

function toPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(8, Math.round((value / max) * 100));
}

function buildRegionBuckets(items: Hotspot[]): Bucket[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const region = item.tenderRegion || item.tenderCity || '未标注';
    map.set(region, (map.get(region) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({ label, value }));
}

function buildBudgetBuckets(items: Hotspot[]): Bucket[] {
  const buckets = [
    { label: '< 100万', min: 0, max: 100, value: 0 },
    { label: '100-300万', min: 100, max: 300, value: 0 },
    { label: '300-1000万', min: 300, max: 1000, value: 0 },
    { label: '1000万+', min: 1000, max: Number.POSITIVE_INFINITY, value: 0 }
  ];

  for (const item of items) {
    if (item.tenderBudgetWan == null) continue;
    const target = buckets.find(bucket => item.tenderBudgetWan! >= bucket.min && item.tenderBudgetWan! < bucket.max);
    if (target) target.value += 1;
  }

  return buckets.map(({ label, value }) => ({ label, value }));
}

function buildDeadlineBuckets(items: Hotspot[]): Bucket[] {
  const now = Date.now();
  const oneWeek = now + 7 * 24 * 60 * 60 * 1000;
  const oneMonth = now + 30 * 24 * 60 * 60 * 1000;
  const buckets = {
    urgent: 0,
    near: 0,
    later: 0,
    unknown: 0
  };

  for (const item of items) {
    if (!item.tenderDeadline) {
      buckets.unknown += 1;
      continue;
    }
    const deadline = new Date(item.tenderDeadline).getTime();
    if (Number.isNaN(deadline)) {
      buckets.unknown += 1;
    } else if (deadline < now) {
      buckets.urgent += 1;
    } else if (deadline <= oneWeek) {
      buckets.urgent += 1;
    } else if (deadline <= oneMonth) {
      buckets.near += 1;
    } else {
      buckets.later += 1;
    }
  }

  return [
    { label: '7 天内', value: buckets.urgent },
    { label: '30 天内', value: buckets.near },
    { label: '30 天后', value: buckets.later },
    { label: '未标注', value: buckets.unknown }
  ];
}

function buildTenderTypeBuckets(items: Hotspot[]): Bucket[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const type = item.tenderType || '未分类';
    map.set(type, (map.get(type) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, value]) => ({ label, value }));
}

function formatBudget(value: number | null): string {
  if (value == null) return '未披露';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 亿元`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} 万元`;
}

function isFallbackAIReason(reason: string | null): boolean {
  if (!reason) return false;
  return reason.includes('未配置 AI 服务') || reason.includes('AI 分析失败') || reason.includes('默认分数');
}

function getEffectiveDeadline(hotspot: Pick<Hotspot, 'tenderDeadline' | 'tenderBidOpenTime' | 'tenderDocDeadline'>): string | null {
  return hotspot.tenderDeadline || hotspot.tenderBidOpenTime || hotspot.tenderDocDeadline || null;
}

function getDeadlineInfo(deadline: string | null): { label: string; tone: string; urgency: 'expired' | 'urgent' | 'near' | 'open' | 'unknown' } {
  if (!deadline) {
    return {
      label: '未披露',
      tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300',
      urgency: 'unknown'
    };
  }

  const time = new Date(deadline).getTime();
  if (!Number.isFinite(time)) {
    return {
      label: '待核验',
      tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300',
      urgency: 'unknown'
    };
  }

  const now = Date.now();
  const days = Math.ceil((time - now) / (24 * 60 * 60 * 1000));
  if (days < 0) {
    return {
      label: '已截止',
      tone: 'border-slate-400/15 bg-slate-500/10 text-slate-400',
      urgency: 'expired'
    };
  }
  if (days <= 7) {
    return {
      label: `${days} 天内截止`,
      tone: 'border-red-400/25 bg-red-500/12 text-red-200',
      urgency: 'urgent'
    };
  }
  if (days <= 30) {
    return {
      label: `${days} 天后截止`,
      tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200',
      urgency: 'near'
    };
  }
  return {
    label: `${days} 天后截止`,
    tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
    urgency: 'open'
  };
}

function getNoticeStage(noticeType: string | null): { label: string; tone: string } {
  const text = noticeType || '未标注公告类型';
  if (text.includes('招标') || text.includes('资格预审')) return { label: text, tone: 'border-cyan-400/25 bg-cyan-500/12 text-cyan-100' };
  if (text.includes('采购') || text.includes('竞价')) return { label: text, tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100' };
  if (text.includes('变更') || text.includes('补充')) return { label: text, tone: 'border-amber-300/25 bg-amber-400/12 text-amber-100' };
  if (text.includes('结果') || text.includes('中标') || text.includes('成交')) return { label: text, tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300' };
  return { label: text, tone: 'border-white/10 bg-white/5 text-slate-300' };
}

function getDetailReliability(url: string): { label: string; tone: string } {
  if (url.includes('szggzy.com/globalSearch/details.html')) {
    return { label: '深圳原始详情', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' };
  }
  if (url.includes('nodeId=')) {
    return { label: '已解析详情', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' };
  }
  if (url.includes('jyxt.gzggzy.cn') || url.includes('gzebpubservice.cn')) {
    return { label: '已校验链接', tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200' };
  }
  return { label: '待人工核验', tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200' };
}

function getBidAction(hotspot: Hotspot): string {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  if (deadline.urgency === 'expired') return '归档观察';
  if (deadline.urgency === 'urgent') return '立即核对投标窗口';
  if (!hotspot.tenderUnit || !hotspot.tenderBudgetWan) return '补齐单位/预算信息';
  if (hotspot.tenderType?.includes('设计')) return '评估设计团队匹配度';
  if (hotspot.tenderType?.includes('施工')) return '评估施工阶段 BIM 资源';
  return '进入商机初筛';
}

function getOpportunityRank(hotspot: Hotspot): { label: string; tone: string } {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  const hasBusinessFields = Boolean(hotspot.tenderUnit || hotspot.tenderBudgetWan || getEffectiveDeadline(hotspot));
  if (deadline.urgency === 'urgent' && hotspot.relevance >= 70) {
    return { label: '优先跟进', tone: 'border-red-400/25 bg-red-500/12 text-red-100' };
  }
  if (hotspot.importance === 'high' || hotspot.relevance >= 80 || hasBusinessFields) {
    return { label: '重点评估', tone: 'border-orange-300/25 bg-orange-400/12 text-orange-100' };
  }
  return { label: '线索池', tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300' };
}

function getFieldCompleteness(hotspot: Hotspot): { score: number; label: string; tone: string } {
  const score = [
    hotspot.tenderUnit ? 16 : 0,
    hotspot.tenderBudgetWan != null ? 14 : 0,
    hotspot.tenderDeadline ? 16 : 0,
    hotspot.tenderBidOpenTime ? 8 : 0,
    hotspot.tenderDocDeadline ? 6 : 0,
    hotspot.tenderProjectCode ? 10 : 0,
    hotspot.tenderServiceScope ? 10 : 0,
    hotspot.tenderQualification ? 8 : 0,
    hotspot.tenderAddress ? 6 : 0,
    hotspot.tenderContact ? 3 : 0,
    hotspot.tenderPhone ? 3 : 0
  ].reduce((sum, value) => sum + value, 0);

  if (score >= 75) {
    return { score, label: '字段完整', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' };
  }
  if (score >= 45) {
    return { score, label: '信息可判断', tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200' };
  }
  return { score, label: '待补字段', tone: 'border-red-400/20 bg-red-500/10 text-red-200' };
}

function getFollowUpRecommendation(hotspot: Hotspot): {
  label: string;
  tone: string;
  summary: string;
} {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  const completeness = getFieldCompleteness(hotspot);

  if (deadline.urgency === 'expired') {
    return {
      label: '归档观察',
      tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300',
      summary: '项目已过期，不进入优先跟进，可留作历史样本。'
    };
  }

  if (deadline.urgency === 'urgent' && hotspot.tenderUnit && hotspot.tenderBudgetWan != null) {
    return {
      label: '立即跟进',
      tone: 'border-red-400/25 bg-red-500/12 text-red-100',
      summary: '截止时间紧，且核心字段较完整，建议立即核对投标窗口和报名要求。'
    };
  }

  if (hotspot.relevance >= 80 && completeness.score >= 45) {
    return {
      label: '重点评估',
      tone: 'border-orange-300/25 bg-orange-400/12 text-orange-100',
      summary: '业务匹配度较高，建议尽快完成资格、预算和资源排期评估。'
    };
  }

  if (completeness.score < 45) {
    return {
      label: '补齐信息',
      tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200',
      summary: '当前字段仍不够完整，建议优先补齐单位、预算、截止时间等核心信息。'
    };
  }

  return {
    label: '进入线索池',
    tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300',
    summary: '可继续观察，待后续字段补全或业务优先级提升后再推进。'
  };
}

function buildTimeline(hotspot: Hotspot): Array<{ label: string; date: string | null; tone: string }> {
  return [
    { label: '发布时间', date: hotspot.publishedAt, tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200' },
    { label: '文件获取截止', date: hotspot.tenderDocDeadline, tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200' },
    { label: '投标截止', date: hotspot.tenderDeadline, tone: 'border-red-400/20 bg-red-500/10 text-red-200' },
    { label: '开标时间', date: hotspot.tenderBidOpenTime, tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' }
  ];
}

function DashboardMetric({ title, value, caption, tone, icon: Icon }: {
  title: string;
  value: string | number;
  caption: string;
  tone: string;
  icon: typeof Activity;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'relative overflow-hidden rounded-[28px] border p-5 sm:p-6',
        tone
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_45%)]" />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{title}</p>
          <p className="mt-3 text-3xl font-semibold text-white sm:text-4xl">{value}</p>
          <p className="mt-2 text-sm text-slate-300/80">{caption}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/6 p-3 text-white/90">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </motion.div>
  );
}

function DataBars({ title, subtitle, data, tone }: {
  title: string;
  subtitle: string;
  data: Bucket[];
  tone: string;
}) {
  const max = Math.max(...data.map(item => item.value), 1);
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-3">
        {data.map(item => (
          <div key={item.label}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-slate-300">{item.label}</span>
              <span className="text-slate-500">{item.value}</span>
            </div>
            <div className="h-2 rounded-full bg-white/6">
              <div className={cn('h-2 rounded-full transition-all', tone)} style={{ width: `${toPercent(item.value, max)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnalysisCard({ title, value, caption, icon: Icon, tone }: {
  title: string;
  value: string;
  caption: string;
  icon: typeof Activity;
  tone: string;
}) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-[#101427] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{title}</p>
          <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
          <p className="mt-2 text-sm leading-6 text-slate-400">{caption}</p>
        </div>
        <div className={cn('rounded-2xl border p-3', tone)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function TenderFact({ label, value, icon: Icon, strong = false }: {
  label: string;
  value: string;
  icon: typeof Activity;
  strong?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={cn('mt-2 leading-6', strong ? 'text-lg font-semibold text-white' : 'text-sm font-medium text-slate-200')}>
        {value || '待补全'}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  icon: Icon
}: {
  label: string;
  value: string;
  icon: typeof Activity;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
        {value}
      </div>
    </div>
  );
}

function HotspotDetailPage({
  hotspot,
  isLoading,
  onBack
}: {
  hotspot: Hotspot | null;
  isLoading: boolean;
  onBack: () => void;
}) {
  if (!hotspot && !isLoading) return null;

  const deadline = hotspot ? getDeadlineInfo(getEffectiveDeadline(hotspot)) : null;
  const stage = hotspot ? getNoticeStage(hotspot.tenderNoticeType) : null;
  const detailReliability = hotspot ? getDetailReliability(hotspot.url) : null;
  const region = hotspot ? [hotspot.tenderRegion, hotspot.tenderCity].filter(Boolean).join(' / ') || '未标注' : '载入中';
  const published = hotspot?.publishedAt ? formatDateTime(hotspot.publishedAt) : '未披露';
  const extractedAt = hotspot?.tenderDetailExtractedAt ? formatDateTime(hotspot.tenderDetailExtractedAt) : '未记录';
  const completeness = hotspot ? getFieldCompleteness(hotspot) : null;
  const recommendation = hotspot ? getFollowUpRecommendation(hotspot) : null;
  const timeline = hotspot ? buildTimeline(hotspot) : [];

  return (
    <section className="space-y-6">
      <div className="overflow-hidden rounded-[34px] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.18),rgba(15,23,42,0.9)_48%,rgba(20,184,166,0.12))] p-6 shadow-[0_28px_110px_rgba(0,0,0,0.34)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-4xl">
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/75">Opportunity Detail</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {hotspot?.title || '正在加载项目详情'}
              </h2>
              {hotspot && (
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-cyan-200">
                    {hotspot.tenderPlatform || getSourceLabel(hotspot.source)}
                  </span>
                  {deadline && <span className={cn('rounded-full border px-2.5 py-1', deadline.tone)}>{deadline.label}</span>}
                  {stage && <span className={cn('rounded-full border px-2.5 py-1', stage.tone)}>{stage.label}</span>}
                  {detailReliability && <span className={cn('rounded-full border px-2.5 py-1', detailReliability.tone)}>{detailReliability.label}</span>}
                  {completeness && <span className={cn('rounded-full border px-2.5 py-1', completeness.tone)}>{completeness.label} · {completeness.score}</span>}
                </div>
              )}
            </div>
            <button
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
              返回清单
            </button>
          </div>
        </div>
      </div>

      {isLoading && !hotspot && (
        <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-8 text-slate-400">
          正在读取项目详情与结构化字段…
        </div>
      )}

      {hotspot && (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <TenderFact label="预算金额" value={formatBudget(hotspot.tenderBudgetWan)} icon={WalletCards} strong />
            <TenderFact label="截止时间" value={getEffectiveDeadline(hotspot) ? formatDateTime(getEffectiveDeadline(hotspot)!) : '未披露'} icon={CalendarClock} strong />
            <TenderFact label="项目编号" value={hotspot.tenderProjectCode || '未披露'} icon={ClipboardCheck} />
            <TenderFact label="发布时间" value={published} icon={ClipboardCheck} />
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">跟进建议</h3>
                {recommendation && <span className={cn('rounded-full border px-2.5 py-1 text-xs', recommendation.tone)}>{recommendation.label}</span>}
              </div>
              <p className="mt-3 text-base font-semibold text-white">{getBidAction(hotspot)}</p>
              <p className="mt-2 text-sm leading-7 text-slate-300">
                {recommendation?.summary || '建议先完成基础字段核验，再决定是否推进。'}
              </p>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">字段完整度</h3>
                {completeness && <span className="text-sm font-medium text-white">{completeness.score}/100</span>}
              </div>
              <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/8">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    completeness?.score && completeness.score >= 75
                      ? 'bg-[linear-gradient(90deg,#10b981,#34d399)]'
                      : completeness?.score && completeness.score >= 45
                        ? 'bg-[linear-gradient(90deg,#f59e0b,#fbbf24)]'
                        : 'bg-[linear-gradient(90deg,#ef4444,#fb7185)]'
                  )}
                  style={{ width: `${completeness?.score || 0}%` }}
                />
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                依据单位、预算、截止时间、项目编号、服务范围、资格要求、联系人等投标关键字段综合计算。
              </p>
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <DetailField label="地区 / 城市" value={region} icon={MapPin} />
            <DetailField label="招标 / 采购单位" value={hotspot.tenderUnit || '未披露'} icon={Building2} />
            <DetailField label="BIM 类型" value={hotspot.tenderType || '未分类'} icon={Gavel} />
            <DetailField label="开标时间" value={hotspot.tenderBidOpenTime ? formatDateTime(hotspot.tenderBidOpenTime) : '未披露'} icon={CalendarClock} />
            <DetailField label="文件获取截止" value={hotspot.tenderDocDeadline ? formatDateTime(hotspot.tenderDocDeadline) : '未披露'} icon={TimerReset} />
            <DetailField label="地点" value={hotspot.tenderAddress || '未披露'} icon={MapPin} />
            <DetailField label="联系人" value={hotspot.tenderContact || '未披露'} icon={Building2} />
            <DetailField label="联系电话" value={hotspot.tenderPhone || '未披露'} icon={ClipboardCheck} />
            <DetailField label="邮箱" value={hotspot.tenderEmail || '未披露'} icon={Bell} />
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <DetailField label="服务范围" value={hotspot.tenderServiceScope || '未披露'} icon={Layers3} />
            <DetailField label="资格要求" value={hotspot.tenderQualification || '未披露'} icon={ShieldCheck} />
          </section>

          <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">关键时间轴</h3>
              <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Timeline</span>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {timeline.map(item => (
                <div key={item.label} className="rounded-2xl border border-white/8 bg-[#0f1425] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-white">{item.label}</span>
                    <span className={cn('rounded-full border px-2 py-1 text-[11px]', item.tone)}>
                      {item.date ? '已识别' : '未披露'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    {item.date ? formatDateTime(item.date) : '当前公告未提取到该时间节点'}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">公告正文摘要</h3>
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300">
                  相关性 {hotspot.relevance}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">
                {hotspot.summary || hotspot.content || '暂无正文内容'}
              </p>
            </div>

            <div className="space-y-4">
              <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                <h3 className="text-lg font-semibold text-white">解析状态</h3>
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                  <div className="flex items-center justify-between gap-3"><span>字段来源</span><span className="text-right text-slate-100">{hotspot.tenderDetailSource || '未记录'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>提取时间</span><span className="text-right text-slate-100">{extractedAt}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>监控词</span><span className="text-right text-slate-100">{hotspot.keyword?.text || '临时搜索'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>详情链接</span><span className="text-right text-slate-100">{detailReliability?.label || '待核验'}</span></div>
                </div>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                <h3 className="text-lg font-semibold text-white">操作</h3>
                <div className="mt-4 space-y-3">
                  <a
                    href={hotspot.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-4 py-3 text-sm font-medium text-white shadow-[0_14px_34px_rgba(14,165,233,0.26)] transition hover:brightness-110"
                  >
                    打开原始公告 <ExternalLink className="h-4 w-4" />
                  </a>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.035] p-4 text-sm leading-6 text-slate-400">
                    首页列表只展示预算、截止、单位、地区等关键字段；完整字段都在这里集中查看，方便投标初筛。
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function HotspotCard({ hotspot, onOpenDetail }: { hotspot: Hotspot; onOpenDetail: (hotspot: Hotspot) => void }) {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  const stage = getNoticeStage(hotspot.tenderNoticeType);
  const detailReliability = getDetailReliability(hotspot.url);
  const rank = getOpportunityRank(hotspot);
  const region = [hotspot.tenderRegion, hotspot.tenderCity].filter(Boolean).join(' / ') || '未标注';
  const published = hotspot.publishedAt ? formatDateTime(hotspot.publishedAt) : '未披露';
  const aiReason = isFallbackAIReason(hotspot.relevanceReason) ? null : hotspot.relevanceReason;
  const summaryText = hotspot.summary
    || hotspot.tenderServiceScope
    || (hotspot.tenderUnit
      ? `优先确认 ${hotspot.tenderUnit} 的招采条件、资质要求和投标截止节点。`
      : '当前公告缺少单位或预算字段，建议进入详情页补齐关键信息后再判断是否跟进。');

  return (
    <article className="group overflow-hidden rounded-[26px] border border-white/10 bg-[#0d1020]/92 shadow-[0_20px_70px_rgba(0,0,0,0.26)] transition-all hover:border-cyan-300/20 hover:bg-[#111729]">
      <div className="border-b border-white/8 bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(16,185,129,0.06),rgba(255,255,255,0.02))] p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-cyan-200">{hotspot.tenderPlatform || getSourceLabel(hotspot.source)}</span>
              <span className={cn('rounded-full border px-2.5 py-1', rank.tone)}>{rank.label}</span>
              {deadline.urgency === 'expired' && (
                <span className="rounded-full border border-slate-400/20 bg-slate-500/12 px-2.5 py-1 text-slate-300">已截止</span>
              )}
              <span className={cn('rounded-full border px-2.5 py-1', stage.tone)}>{stage.label}</span>
              <span className={cn('rounded-full border px-2.5 py-1', detailReliability.tone)}>{detailReliability.label}</span>
            </div>
            <h3 className="text-xl font-semibold leading-8 text-white group-hover:text-cyan-100">{hotspot.title}</h3>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
              <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4 text-cyan-300" />{region}</span>
              <span className="hidden text-slate-600 sm:inline">/</span>
              <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-emerald-300" />{hotspot.tenderUnit || '单位待补全'}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row xl:flex-col xl:items-end">
            <span className={cn('inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium', deadline.tone)}>
              <TimerReset className="h-4 w-4" />
              {deadline.label}
            </span>
            <button
              onClick={() => onOpenDetail(hotspot)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_34px_rgba(14,165,233,0.26)] transition hover:brightness-110"
            >
              查看详情 <ArrowRight className="h-4 w-4" />
            </button>
            <a
              href={hotspot.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
            >
              原始公告 <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TenderFact label="预算金额" value={formatBudget(hotspot.tenderBudgetWan)} icon={WalletCards} strong />
          <TenderFact label="截止时间" value={getEffectiveDeadline(hotspot) ? formatDateTime(getEffectiveDeadline(hotspot)!) : '未披露'} icon={CalendarClock} strong={deadline.urgency === 'urgent'} />
          <TenderFact label="BIM 类型" value={hotspot.tenderType || '未分类'} icon={Gavel} />
          <TenderFact label="发布时间" value={published} icon={ClipboardCheck} />
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">投标摘要</p>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">相关性 {hotspot.relevance}</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">{hotspot.keyword?.text || '临时搜索'}</span>
            </div>
          </div>
          <p className="text-base font-semibold text-white">{getBidAction(hotspot)}</p>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-400">{summaryText}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>来源：{getSourceLabel(hotspot.source)}</span>
            <span>入库：{relativeTime(hotspot.createdAt)}</span>
          </div>
        </div>

        {aiReason && (
          <div className="rounded-2xl border border-cyan-400/10 bg-cyan-500/[0.06] p-3 text-sm text-cyan-100">
            AI 辅助判断：{aiReason}
          </div>
        )}
      </div>
    </article>
  );
}

function SourceHealthCard({ summary }: { summary: OpsSummary | null }) {
  if (!summary) {
    return (
      <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
        <p className="text-sm text-slate-500">正在加载来源状态…</p>
      </section>
    );
  }

  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">来源健康</h3>
          <p className="mt-1 text-sm text-slate-400">直接读取后端探测结果，前端不再猜来源状态。</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-400">
          {summary.runtimeConfig.tenderSources.length} / 4 已启用
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {summary.sourceHealth.map(source => (
          <div key={source.id} className="rounded-[24px] border border-white/8 bg-[#101427] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">{getSourceLabel(source.id)}</p>
                <p className="mt-1 text-xs text-slate-500">{source.elapsedMs} ms</p>
              </div>
              <span className={cn('rounded-full border px-2.5 py-1 text-xs', getHealthTone(source.ok, source.circuitOpen))}>
                {source.circuitOpen ? '熔断中' : source.ok ? '正常' : '待观察'}
              </span>
            </div>
            <div className="mt-4 space-y-2 text-sm text-slate-400">
              <div className="flex items-center justify-between"><span>命中数量</span><span className="text-slate-200">{source.count}</span></div>
              <div className="flex items-center justify-between"><span>24h 失败</span><span className="text-slate-200">{summary.failureSummary24h[source.id] || 0}</span></div>
              <div className="flex items-center justify-between"><span>上次成功</span><span className="text-slate-200">{source.lastSuccessAt ? relativeTime(source.lastSuccessAt) : '暂无'}</span></div>
            </div>
            {source.sampleTitle && <p className="mt-4 line-clamp-2 text-xs leading-5 text-slate-500">样例：{source.sampleTitle}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function OpportunityListSection({
  hotspots,
  filters,
  onFiltersChange,
  keywords,
  currentPage,
  totalPages,
  onPageChange,
  onOpenDetail
}: {
  hotspots: Hotspot[];
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  keywords: Keyword[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onOpenDetail: (hotspot: Hotspot) => void;
}) {
  const goToPage = (page: number) => {
    if (page === currentPage) return;
    onPageChange(page);
  };

  const showHero = currentPage === 1;

  return (
    <section className="space-y-5" id="opportunity-list">
      {showHero ? (
        <div className="overflow-hidden rounded-[34px] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.18),rgba(15,23,42,0.9)_48%,rgba(20,184,166,0.12))] p-6 shadow-[0_28px_110px_rgba(0,0,0,0.34)]">
          <div className="flex flex-col gap-5">
            <div className="max-w-4xl">
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/75">Opportunity Pipeline</p>
              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">投标机会清单</h2>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300">
                以招标决策字段为核心：单位、地区、预算、截止时间、公告阶段、详情可靠性。
              </p>
            </div>
            <div className="w-full">
              <FilterSortBar filters={filters} onChange={onFiltersChange} keywords={keywords} />
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.2)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-300/70">Opportunity Pipeline</p>
              <h2 className="mt-1 text-xl font-semibold text-white">投标机会清单</h2>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
              第 {currentPage} / {totalPages} 页
            </div>
          </div>
          <FilterSortBar filters={filters} onChange={onFiltersChange} keywords={keywords} />
        </div>
      )}

      <div className="space-y-4">
        {hotspots.map(item => <HotspotCard key={item.id} hotspot={item} onOpenDetail={onOpenDetail} />)}
        {hotspots.length === 0 && (
          <div className="rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] p-10 text-center text-slate-500">
            当前筛选条件下暂无投标机会，可以放宽地区 / 预算 / 时间筛选试试。
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-[24px] border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
        <span>第 {currentPage} / {totalPages} 页</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className="relative z-10 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> 上一页
          </button>
          <button
            onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            className="relative z-10 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

function RunsPanel({ runs }: { runs: CrawlRun[] }) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">最近扫描</h3>
          <p className="mt-1 text-sm text-slate-400">看哪一轮有命中、哪一轮只是跑空，不需要再靠日志盲猜。</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-400">
          近 {runs.length} 次
        </div>
      </div>

      <div className="space-y-3">
        {runs.map(run => (
          <div key={run.id} className="rounded-[24px] border border-white/8 bg-[#0f1425] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-white">{run.keywordText || '未命名关键词'}</p>
                <p className="mt-1 text-xs text-slate-500">{formatDateTime(run.startedAt)} · {run.status}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">raw {run.totalRaw}</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">fresh {run.totalFresh}</span>
                <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-emerald-200">saved {run.totalSaved}</span>
                <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-amber-200">filtered {run.totalFiltered}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('opportunities');
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [analyticsHotspots, setAnalyticsHotspots] = useState<Hotspot[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [opsSummary, setOpsSummary] = useState<OpsSummary | null>(null);
  const [newKeyword, setNewKeyword] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Hotspot[]>([]);
  const [dashboardFilters, setDashboardFilters] = useState<FilterState>({ ...defaultFilterState });
  const [searchFilters, setSearchFilters] = useState<FilterState>({ ...defaultFilterState });
  const [currentPage, setCurrentPage] = useState(1);
  const opportunityPageSize = 4;
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [selectedHotspot, setSelectedHotspot] = useState<Hotspot | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const buildDashboardParams = useCallback((page: number, limit: number) => {
    const params: Record<string, string | number> = { page, limit };
    if (dashboardFilters.searchText) params.searchText = dashboardFilters.searchText;
    if (dashboardFilters.source) params.source = dashboardFilters.source;
    if (dashboardFilters.importance) params.importance = dashboardFilters.importance;
    if (dashboardFilters.keywordId) params.keywordId = dashboardFilters.keywordId;
    if (dashboardFilters.timeRange) params.timeRange = dashboardFilters.timeRange;
    if (dashboardFilters.isReal) params.isReal = dashboardFilters.isReal;
    if (dashboardFilters.tenderType) params.tenderType = dashboardFilters.tenderType;
    if (dashboardFilters.tenderRegion) params.tenderRegion = dashboardFilters.tenderRegion;
    if (dashboardFilters.tenderMinBudgetWan) params.tenderMinBudgetWan = dashboardFilters.tenderMinBudgetWan;
    if (dashboardFilters.tenderDeadlineRange) params.tenderDeadlineRange = dashboardFilters.tenderDeadlineRange;
    if (dashboardFilters.tenderPlatform) params.tenderPlatform = dashboardFilters.tenderPlatform;
    if (dashboardFilters.sortBy) params.sortBy = dashboardFilters.sortBy;
    if (dashboardFilters.sortOrder) params.sortOrder = dashboardFilters.sortOrder;
    return params;
  }, [dashboardFilters]);

  const loadPageData = useCallback(async () => {
    setIsLoading(true);
    try {
      const dashboardParams = buildDashboardParams(currentPage, opportunityPageSize);
      const hotspotsData = await hotspotsApi.getAll(dashboardParams);
      setHotspots(hotspotsData.data);
      setTotalPages(hotspotsData.pagination.totalPages);
    } catch (error) {
      console.error('Failed to load page data:', error);
      showToast('加载列表失败', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [buildDashboardParams, currentPage, showToast]);

  const loadAuxiliaryData = useCallback(async () => {
    try {
      const analyticsParams = buildDashboardParams(1, 100);
      const [keywordsData, analyticsData, statsData, notifData, opsData] = await Promise.all([
        keywordsApi.getAll(),
        hotspotsApi.getAll(analyticsParams),
        hotspotsApi.getStats(),
        notificationsApi.getAll({ limit: 12 }),
        hotspotsApi.getOpsSummary()
      ]);

      setKeywords(keywordsData);
      setAnalyticsHotspots(analyticsData.data);
      setStats(statsData);
      setNotifications(notifData.data);
      setUnreadCount(notifData.unreadCount);
      setOpsSummary(opsData);

      const activeKeywords = keywordsData.filter(item => item.isActive).map(item => item.text);
      if (activeKeywords.length > 0) {
        subscribeToKeywords(activeKeywords);
      }
    } catch (error) {
      console.error('Failed to load auxiliary data:', error);
      showToast('加载分析数据失败', 'error');
    }
  }, [buildDashboardParams, showToast]);

  useEffect(() => {
    setCurrentPage(1);
  }, [dashboardFilters]);

  useEffect(() => {
    loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    loadAuxiliaryData();
  }, [loadAuxiliaryData]);

  useEffect(() => {
    const unsubHotspot = onNewHotspot(() => {
      loadPageData();
      loadAuxiliaryData();
      showToast('发现新的 BIM 招采公告', 'success');
    });

    const unsubNotif = onNotification(() => {
      setUnreadCount(prev => prev + 1);
    });

    return () => {
      unsubHotspot();
      unsubNotif();
    };
  }, [loadAuxiliaryData, loadPageData, showToast]);

  const handleManualCheck = async () => {
    setIsChecking(true);
    try {
      await triggerHotspotCheck();
      showToast('已加入后台扫描队列', 'success');
      window.setTimeout(() => {
        loadPageData();
        loadAuxiliaryData();
      }, 4000);
    } catch (error) {
      console.error(error);
      showToast('触发扫描失败', 'error');
    } finally {
      setIsChecking(false);
    }
  };

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    setIsLoading(true);
    try {
      const result = await hotspotsApi.search(searchQuery);
      setSearchResults(result.results);
      showToast(`返回 ${result.results.length} 条结果`, 'success');
    } catch (error) {
      console.error(error);
      showToast('搜索失败', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenHotspotDetail = useCallback(async (hotspot: Hotspot) => {
    setSelectedHotspot(hotspot);
    setIsDetailLoading(true);
    try {
      const detail = await hotspotsApi.getById(hotspot.id);
      setSelectedHotspot(detail);
    } catch (error) {
      console.error('Failed to load hotspot detail:', error);
      showToast('读取项目详情失败，先展示当前列表数据。', 'error');
    } finally {
      setIsDetailLoading(false);
    }
  }, [showToast]);

  const handleCloseHotspotDetail = useCallback(() => {
    setSelectedHotspot(null);
    setIsDetailLoading(false);
  }, []);

  const handleAddKeyword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newKeyword.trim()) return;
    try {
      const created = await keywordsApi.create({ text: newKeyword.trim() });
      setKeywords(prev => [created, ...prev]);
      setNewKeyword('');
      showToast('监控词已添加', 'success');
    } catch (error) {
      console.error(error);
      showToast('添加监控词失败', 'error');
    }
  };

  const handleDeleteKeyword = async (id: string) => {
    try {
      await keywordsApi.delete(id);
      setKeywords(prev => prev.filter(item => item.id !== id));
      showToast('监控词已删除', 'success');
    } catch (error) {
      console.error(error);
      showToast('删除失败', 'error');
    }
  };

  const handleToggleKeyword = async (id: string) => {
    try {
      const updated = await keywordsApi.toggle(id);
      setKeywords(prev => prev.map(item => item.id === id ? updated : item));
    } catch (error) {
      console.error(error);
      showToast('状态更新失败', 'error');
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllAsRead();
      setUnreadCount(0);
      setNotifications(prev => prev.map(item => ({ ...item, isRead: true })));
    } catch (error) {
      console.error(error);
    }
  };

  const filteredSearchResults = useMemo(() => {
    let results = [...searchResults];
    if (searchFilters.source) results = results.filter(item => item.source === searchFilters.source);
    if (searchFilters.importance) results = results.filter(item => item.importance === searchFilters.importance);
    if (searchFilters.keywordId) results = results.filter(item => item.keyword?.id === searchFilters.keywordId);
    if (searchFilters.isReal === 'true') results = results.filter(item => item.isReal);
    if (searchFilters.isReal === 'false') results = results.filter(item => !item.isReal);
    if (searchFilters.tenderType) results = results.filter(item => item.tenderType === searchFilters.tenderType);
    if (searchFilters.tenderRegion) {
      results = results.filter(item => (item.tenderRegion || '').includes(searchFilters.tenderRegion) || (item.tenderCity || '').includes(searchFilters.tenderRegion));
    }
    if (searchFilters.tenderPlatform) results = results.filter(item => item.tenderPlatform === searchFilters.tenderPlatform);
    if (searchFilters.tenderMinBudgetWan) {
      const min = Number(searchFilters.tenderMinBudgetWan);
      results = results.filter(item => item.tenderBudgetWan != null && item.tenderBudgetWan >= min);
    }
    return sortHotspots(results, searchFilters.sortBy || 'createdAt', (searchFilters.sortOrder || 'desc') as 'asc' | 'desc');
  }, [searchFilters, searchResults]);

  const regionBuckets = useMemo(() => buildRegionBuckets(analyticsHotspots), [analyticsHotspots]);
  const budgetBuckets = useMemo(() => buildBudgetBuckets(analyticsHotspots), [analyticsHotspots]);
  const deadlineBuckets = useMemo(() => buildDeadlineBuckets(analyticsHotspots), [analyticsHotspots]);
  const typeBuckets = useMemo(() => buildTenderTypeBuckets(analyticsHotspots), [analyticsHotspots]);
  const sourceShare = useMemo(() => {
    const sourceEntries = Object.entries(stats?.bySource || {}).map(([label, value]) => ({ label: getSourceLabel(label), value }));
    return sourceEntries.sort((a, b) => b.value - a.value);
  }, [stats]);
  const highValueHotspots = useMemo(() => {
    return [...analyticsHotspots]
      .filter(item => getDeadlineInfo(getEffectiveDeadline(item)).urgency !== 'expired')
      .sort((a, b) => {
        const scoreA = (a.importance === 'urgent' ? 300 : a.importance === 'high' ? 200 : a.importance === 'medium' ? 100 : 0)
          + (a.tenderDeadline ? 60 : 0)
          + (a.tenderBudgetWan ? 60 : 0)
          + (a.tenderUnit ? 40 : 0)
          + a.relevance;
        const scoreB = (b.importance === 'urgent' ? 300 : b.importance === 'high' ? 200 : b.importance === 'medium' ? 100 : 0)
          + (b.tenderDeadline ? 60 : 0)
          + (b.tenderBudgetWan ? 60 : 0)
          + (b.tenderUnit ? 40 : 0)
          + b.relevance;
        return scoreB - scoreA;
      })
      .slice(0, 5);
  }, [analyticsHotspots]);
  const analysisSnapshot = useMemo(() => {
    const now = Date.now();
    const sevenDays = now + 7 * 24 * 60 * 60 * 1000;
    const knownBudgetItems = analyticsHotspots.filter(item => item.tenderBudgetWan != null);
    const deadlineRisk = analyticsHotspots.filter(item => {
      const effective = getEffectiveDeadline(item);
      if (!effective) return false;
      const deadline = new Date(effective).getTime();
      return Number.isFinite(deadline) && deadline >= now && deadline <= sevenDays;
    }).length;
    const activeOpportunity = analyticsHotspots.filter(item => {
      const effective = getEffectiveDeadline(item);
      if (!effective) return true;
      const deadline = new Date(effective).getTime();
      return Number.isFinite(deadline) ? deadline >= now : true;
    }).length;
    const totalBudgetWan = knownBudgetItems.reduce((sum, item) => sum + (item.tenderBudgetWan || 0), 0);
    const completeRows = analyticsHotspots.filter(item => item.tenderUnit && item.tenderRegion && item.tenderNoticeType).length;
    const completeness = analyticsHotspots.length ? Math.round((completeRows / analyticsHotspots.length) * 100) : 0;

    return {
      activeOpportunity,
      deadlineRisk,
      totalBudgetWan,
      knownBudgetCount: knownBudgetItems.length,
      completeness
    };
  }, [analyticsHotspots]);

  return (
    <div className="min-h-screen bg-[#07111f] text-white">
      <BackgroundBeams className="opacity-60" />
      <Spotlight className="-top-32 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2" fill="#0ea5e9" />
      <div className="pointer-events-none fixed inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(7,17,31,0.96),rgba(7,17,31,0))]" />
      <div className="pointer-events-none fixed right-[-120px] top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="pointer-events-none fixed bottom-0 left-[-120px] h-72 w-72 rounded-full bg-amber-300/10 blur-3xl" />

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={cn(
              'fixed left-1/2 top-5 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border px-4 py-2 text-sm shadow-2xl backdrop-blur-xl',
              toast.type === 'success'
                ? 'border-emerald-400/30 bg-emerald-500/12 text-emerald-100'
                : 'border-red-400/30 bg-red-500/12 text-red-100'
            )}
          >
            {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#07111f]/70 backdrop-blur-2xl">
        <div className="mx-auto max-w-7xl px-5 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-[20px] border border-cyan-300/20 bg-[linear-gradient(135deg,rgba(34,211,238,0.22),rgba(251,191,36,0.12))] shadow-[0_16px_40px_rgba(14,165,233,0.18)]">
                <Radar className="h-7 w-7 text-cyan-200" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/75">BIM Tender Command</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">BIM 招采监控台</h1>
                <p className="mt-1 text-sm text-slate-400">Version 1.1.0</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => { loadPageData(); loadAuxiliaryData(); }}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
              >
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                刷新数据
              </button>
              <button
                onClick={handleManualCheck}
                disabled={isChecking}
                className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-5 py-2.5 text-sm font-medium text-white shadow-[0_16px_40px_rgba(14,165,233,0.35)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-80"
              >
                <RefreshCw className={cn('h-4 w-4', isChecking && 'animate-spin')} />
                {isChecking ? '提交中' : '后台扫描'}
              </button>

              <div className="relative">
                <button
                  onClick={() => setShowNotifications(prev => !prev)}
                  className="relative rounded-full border border-white/10 bg-white/5 p-2.5 text-slate-200 transition hover:bg-white/10"
                >
                  <Bell className="h-5 w-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>

                <AnimatePresence>
                  {showNotifications && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.96 }}
                      className="absolute right-0 top-14 z-50 w-[22rem] rounded-[28px] border border-white/10 bg-[#0b1324]/96 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl"
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-white">最近通知</h3>
                        {unreadCount > 0 && (
                          <button onClick={handleMarkAllRead} className="text-xs text-cyan-300 hover:text-cyan-200">全部已读</button>
                        )}
                      </div>
                      <div className="space-y-3">
                        {notifications.length === 0 && <p className="text-sm text-slate-500">暂无通知</p>}
                        {notifications.slice(0, 6).map(item => (
                          <div key={item.id} className={cn('rounded-2xl border p-3 text-sm', item.isRead ? 'border-white/5 bg-white/[0.03] text-slate-500' : 'border-cyan-400/10 bg-cyan-500/[0.06] text-slate-200')}>
                            <p className="font-medium">{item.title}</p>
                            <p className="mt-1 line-clamp-2 text-xs">{item.content}</p>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-5 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-wrap items-center gap-2">
          {TAB_ITEMS.map(item => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => {
                  setActiveTab(item.key);
                  setSelectedHotspot(null);
                  setIsDetailLoading(false);
                }}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm transition',
                  active
                    ? 'border-cyan-300/25 bg-cyan-500/12 text-cyan-100'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-100'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {selectedHotspot && (
          <HotspotDetailPage hotspot={selectedHotspot} isLoading={isDetailLoading} onBack={handleCloseHotspotDetail} />
        )}

        {!selectedHotspot && activeTab === 'opportunities' && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.7fr)]">
            <OpportunityListSection
              hotspots={hotspots}
              filters={dashboardFilters}
              onFiltersChange={setDashboardFilters}
              keywords={keywords}
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setCurrentPage}
              onOpenDetail={handleOpenHotspotDetail}
            />

            <aside className="space-y-5">
              <section className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,165,233,0.12),rgba(255,255,255,0.04))] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">优先跟进</h3>
                    <p className="mt-1 text-sm text-slate-400">按截止、预算、单位和业务匹配度排序。</p>
                  </div>
                  <Flame className="h-5 w-5 text-orange-300" />
                </div>
                <div className="space-y-3">
                  {highValueHotspots.map(item => {
                    const deadline = getDeadlineInfo(getEffectiveDeadline(item));
                    return (
                      <button key={item.id} onClick={() => handleOpenHotspotDetail(item)} className="block w-full rounded-[22px] border border-white/8 bg-[#101427] p-4 text-left transition hover:border-cyan-400/20 hover:bg-[#12192b]">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium leading-6 text-white">{item.title}</p>
                            <p className="mt-2 text-xs text-slate-500">{item.tenderUnit || '单位待补全'}</p>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs">
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-slate-300">{item.tenderRegion || item.tenderCity || '未标注地区'}</span>
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-slate-300">{formatBudget(item.tenderBudgetWan)}</span>
                              <span className={cn('rounded-full border px-2 py-1', deadline.tone)}>{deadline.label}</span>
                            </div>
                          </div>
                          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                        </div>
                      </button>
                    );
                  })}
                  {highValueHotspots.length === 0 && <p className="text-sm text-slate-500">当前暂无优先项目。</p>}
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-white">投标快照</h3>
                  <p className="mt-1 text-sm text-slate-400">当前筛选条件下的业务状态。</p>
                </div>
                <div className="grid gap-3">
                  <AnalysisCard title="可跟进" value={`${analysisSnapshot.activeOpportunity}`} caption="未过期或未标注截止时间。" icon={Target} tone="border-cyan-400/20 bg-cyan-500/10 text-cyan-200" />
                  <AnalysisCard title="7天内截止" value={`${analysisSnapshot.deadlineRisk}`} caption="需要优先人工核对。" icon={AlertTriangle} tone="border-red-400/20 bg-red-500/10 text-red-200" />
                  <AnalysisCard title="预算合计" value={formatBudget(analysisSnapshot.totalBudgetWan)} caption={`覆盖 ${analysisSnapshot.knownBudgetCount} 条已披露预算公告。`} icon={WalletCards} tone="border-emerald-400/20 bg-emerald-500/10 text-emerald-200" />
                </div>
              </section>
            </aside>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <DashboardMetric title="总公告" value={stats?.total ?? 0} caption="当前数据库中已沉淀的 BIM 招采公告" tone="border-cyan-400/15 bg-[linear-gradient(180deg,rgba(14,165,233,0.16),rgba(14,165,233,0.04))]" icon={Layers3} />
              <DashboardMetric title="今日新增" value={stats?.today ?? 0} caption="当天新发现，可直接作为跟进入口" tone="border-emerald-400/15 bg-[linear-gradient(180deg,rgba(16,185,129,0.16),rgba(16,185,129,0.04))]" icon={Sparkles} />
              <DashboardMetric title="紧急机会" value={stats?.urgent ?? 0} caption="高优先级项目，需要尽快人工确认" tone="border-red-400/15 bg-[linear-gradient(180deg,rgba(239,68,68,0.16),rgba(239,68,68,0.04))]" icon={AlertTriangle} />
              <DashboardMetric title="活跃监控词" value={keywords.filter(item => item.isActive).length} caption="当前参与自动扫描的 BIM 关键词数量" tone="border-amber-300/15 bg-[linear-gradient(180deg,rgba(251,191,36,0.14),rgba(251,191,36,0.04))]" icon={Target} />
            </section>

            <section className="grid gap-5 xl:grid-cols-[1.45fr_0.95fr]">
              <div className="rounded-[32px] border border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.88),rgba(8,47,73,0.84))] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.35)]">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Bid Pipeline</p>
                    <h2 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight text-white sm:text-4xl">把招采公告整理成可判断、可分派、可跟进的投标线索。</h2>
                    <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300/85">
                      首页优先回答投标团队最关心的问题：项目在哪、谁招、什么类型、预算多少、什么时候截止、详情链接是否可靠。
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:min-w-[18rem]">
                    <div className="rounded-[24px] border border-white/10 bg-white/[0.05] p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">来源命中</p>
                      <p className="mt-2 text-2xl font-semibold text-white">{opsSummary?.sourceHealth.filter(item => item.ok).length ?? 0}/4</p>
                    </div>
                    <div className="rounded-[24px] border border-white/10 bg-white/[0.05] p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">今日扫描</p>
                      <p className="mt-2 text-2xl font-semibold text-white">{opsSummary?.stats.todayHotspots ?? 0}</p>
                    </div>
                  </div>
                </div>
              </div>

              <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">运行参数</h3>
                    <p className="mt-1 text-sm text-slate-400">这里读的是后端运行时配置，不是写死文案。</p>
                  </div>
                  <Settings2 className="h-5 w-5 text-slate-500" />
                </div>
                <div className="mt-5 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/8 bg-[#101427] p-4"><div className="text-xs uppercase tracking-[0.2em] text-slate-500">新鲜度</div><div className="mt-2 text-lg font-medium text-white">{opsSummary?.runtimeConfig.maxAgeDays ?? '--'} 天</div></div>
                  <div className="rounded-2xl border border-white/8 bg-[#101427] p-4"><div className="text-xs uppercase tracking-[0.2em] text-slate-500">单源条数</div><div className="mt-2 text-lg font-medium text-white">{opsSummary?.runtimeConfig.sourceResultLimit ?? '--'}</div></div>
                  <div className="rounded-2xl border border-white/8 bg-[#101427] p-4"><div className="text-xs uppercase tracking-[0.2em] text-slate-500">关键词配额</div><div className="mt-2 text-lg font-medium text-white">{opsSummary?.runtimeConfig.resultsPerKeyword ?? '--'}</div></div>
                  <div className="rounded-2xl border border-white/8 bg-[#101427] p-4"><div className="text-xs uppercase tracking-[0.2em] text-slate-500">扩展查询数</div><div className="mt-2 text-lg font-medium text-white">{opsSummary?.runtimeConfig.queryVariantsPerKeyword ?? '--'}</div></div>
                </div>
              </section>
            </section>

            <SourceHealthCard summary={opsSummary} />

            <section className="rounded-[32px] border border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.84),rgba(20,83,45,0.22))] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]">
              <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/75">Data Analysis</p>
                  <h3 className="mt-2 text-2xl font-semibold text-white">数据分析快照</h3>
                  <p className="mt-2 text-sm text-slate-400">基于当前筛选条件下最近 100 条公告计算，先给业务判断方向，后面再升级趋势图。</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400">
                  样本 {analyticsHotspots.length} 条
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <AnalysisCard
                  title="可跟进机会"
                  value={`${analysisSnapshot.activeOpportunity}`}
                  caption="未过期或未标注截止时间的公告数量。"
                  icon={Target}
                  tone="border-cyan-400/20 bg-cyan-500/10 text-cyan-200"
                />
                <AnalysisCard
                  title="7天内截止"
                  value={`${analysisSnapshot.deadlineRisk}`}
                  caption="需要优先人工确认投标窗口的项目。"
                  icon={AlertTriangle}
                  tone="border-red-400/20 bg-red-500/10 text-red-200"
                />
                <AnalysisCard
                  title="已披露预算"
                  value={formatBudget(analysisSnapshot.totalBudgetWan)}
                  caption={`覆盖 ${analysisSnapshot.knownBudgetCount} 条有预算字段的公告。`}
                  icon={Layers3}
                  tone="border-emerald-400/20 bg-emerald-500/10 text-emerald-200"
                />
                <AnalysisCard
                  title="字段完整度"
                  value={`${analysisSnapshot.completeness}%`}
                  caption="单位、地区、公告类型都已识别的样本占比。"
                  icon={Activity}
                  tone="border-amber-300/20 bg-amber-400/10 text-amber-200"
                />
              </div>
            </section>

            <section className="grid gap-5 xl:grid-cols-2">
              <DataBars title="来源贡献" subtitle="看哪几个来源在稳定产出项目。" data={sourceShare} tone="bg-[linear-gradient(90deg,#22d3ee,#38bdf8)]" />
              <DataBars title="地区分布" subtitle="当前筛选条件下，项目主要集中在哪些城市。" data={regionBuckets} tone="bg-[linear-gradient(90deg,#f59e0b,#f97316)]" />
            </section>

            <section className="grid gap-5 xl:grid-cols-3">
              <DataBars title="预算区间" subtitle="帮助快速判断商机体量。" data={budgetBuckets} tone="bg-[linear-gradient(90deg,#34d399,#10b981)]" />
              <DataBars title="截止时间" subtitle="优先看到哪些项目快到节点。" data={deadlineBuckets} tone="bg-[linear-gradient(90deg,#fb7185,#ef4444)]" />
              <DataBars title="BIM 类型" subtitle="看监控结果更偏设计、施工还是全过程。" data={typeBuckets} tone="bg-[linear-gradient(90deg,#c084fc,#8b5cf6)]" />
            </section>

            <RunsPanel runs={opsSummary?.recentRuns || []} />

          </div>
        )}

        {activeTab === 'keywords' && (
          <div className="grid gap-6 xl:grid-cols-[1.1fr_1.4fr]">
            <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]">
              <div className="mb-5">
                <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/75">Keyword Ops</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">监控词配置</h2>
                <p className="mt-2 text-sm text-slate-400">这里先保留轻量维护方式，后续我们再做来源级模板和分组管理。</p>
              </div>

              <form onSubmit={handleAddKeyword} className="rounded-[24px] border border-white/10 bg-[#101427] p-4">
                <label className="text-sm text-slate-300">新增 BIM 监控词</label>
                <div className="mt-3 flex gap-3">
                  <input
                    value={newKeyword}
                    onChange={event => setNewKeyword(event.target.value)}
                    placeholder="例如：BIM机电深化设计"
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-300/35"
                  />
                  <button type="submit" className="rounded-2xl bg-[linear-gradient(135deg,#10b981,#14b8a6)] px-4 py-3 text-sm font-medium text-white transition hover:brightness-110">添加</button>
                </div>
              </form>

              <div className="mt-5 rounded-[24px] border border-white/10 bg-[#101427] p-4 text-sm text-slate-400">
                <div className="flex items-center gap-2 text-slate-200"><ShieldCheck className="h-4 w-4 text-emerald-300" /> 当前活跃监控词 {keywords.filter(item => item.isActive).length} 个</div>
                <p className="mt-2 leading-6">建议把业务常用词拆成“设计 / 咨询 / 深化 / 施工 / 交付”等层级，后面做报表会更清晰。</p>
              </div>
            </section>

            <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-white">关键词清单</h3>
                  <p className="mt-1 text-sm text-slate-400">先保证监控词库干净、明确、可解释。</p>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400">共 {keywords.length} 项</div>
              </div>
              <div className="space-y-3">
                {keywords.map(item => (
                  <div key={item.id} className="flex flex-col gap-3 rounded-[24px] border border-white/8 bg-[#101427] p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-medium text-white">{item.text}</span>
                        <span className={cn('rounded-full px-2.5 py-1 text-xs', item.isActive ? 'bg-emerald-500/12 text-emerald-200' : 'bg-slate-500/12 text-slate-400')}>
                          {item.isActive ? '启用中' : '已暂停'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">创建于 {formatDateTime(item.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleToggleKeyword(item.id)} className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                        {item.isActive ? '暂停' : '启用'}
                      </button>
                      <button onClick={() => handleDeleteKeyword(item.id)} className="rounded-full border border-red-400/15 bg-red-500/8 px-3 py-2 text-sm text-red-200 transition hover:bg-red-500/14">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'search' && (
          <div className="space-y-6">
            <section className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]">
              <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-fuchsia-300/75">Exploration</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">临时搜索工作台</h2>
                  <p className="mt-2 text-sm text-slate-400">适合验证一个新词有没有量，再决定要不要加进监控库。</p>
                </div>
                <form onSubmit={handleSearch} className="flex w-full max-w-2xl gap-3">
                  <input
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="输入关键词，例如：BIM正向设计"
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#101427] px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-300/35"
                  />
                  <button type="submit" className="inline-flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#8b5cf6,#ec4899)] px-5 py-3 text-sm font-medium text-white transition hover:brightness-110">
                    <FileSearch className="h-4 w-4" /> 搜索
                  </button>
                </form>
              </div>
              <FilterSortBar filters={searchFilters} onChange={setSearchFilters} keywords={keywords} />
            </section>

            <section className="space-y-4">
              {filteredSearchResults.map(item => <HotspotCard key={item.id} hotspot={item} onOpenDetail={handleOpenHotspotDetail} />)}
              {filteredSearchResults.length === 0 && (
                <div className="rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] p-10 text-center text-slate-500">
                  还没有搜索结果。你可以先试试 `BIM咨询`、`BIM施工应用`、`建筑信息模型` 这类词。
                </div>
              )}
            </section>
          </div>
        )}
      </main>

    </div>
  );
}

export default App;
