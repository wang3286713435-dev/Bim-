import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileSearch,
  Flame,
  Gavel,
  Layers3,
  LockKeyhole,
  LogOut,
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
  UserRound,
  WalletCards,
  X,
  SunMedium,
  MoonStar,
  Newspaper
} from 'lucide-react';
import {
  authApi,
  dailyApi,
  healthApi,
  hotspotsApi,
  keywordsApi,
  notificationsApi,
  triggerHotspotCheck,
  type AuthSession,
  type CrawlRun,
  type DailyArticle,
  type DailyHealthStatus,
  type DailyKeyword,
  type DailyReport,
  type Hotspot,
  type Keyword,
  type HealthStatus,
  type Notification,
  type OpsSummary,
  type Stats
} from './services/api';
import { disconnectSocket, onNewHotspot, onNotification, subscribeToKeywords } from './services/socket';
import DailyReportTab from './components/DailyReportTab';
import FilterSortBar, { defaultFilterState, type FilterState, type SavedFilterView } from './components/FilterSortBar';
import { BackgroundBeams } from './components/ui/background-beams';
import { Spotlight } from './components/ui/spotlight';
import { cn } from './lib/utils';
import { relativeTime, formatDateTime } from './utils/relativeTime';
import { sortHotspots } from './utils/sortHotspots';

type TabKey = 'opportunities' | 'daily' | 'dashboard' | 'keywords' | 'search';
type ThemeMode = 'dark' | 'light';

type Bucket = {
  label: string;
  value: number;
};

type TrendPoint = {
  label: string;
  shortLabel: string;
  actionable: number;
  preSignal: number;
  expired: number;
  priority: number;
};

const TAB_ITEMS: Array<{ key: TabKey; label: string; icon: typeof Radar }> = [
  { key: 'opportunities', label: '投标机会', icon: Gavel },
  { key: 'daily', label: 'BIM 日报', icon: Newspaper },
  { key: 'dashboard', label: '数据分析', icon: Radar },
  { key: 'keywords', label: '监控词', icon: Target },
  { key: 'search', label: '临时搜索', icon: Search }
];

const SOURCE_LABELS: Record<string, string> = {
  szggzy: '深圳交易中心',
  szygcgpt: '深圳阳光采购',
  guangdong: '广东交易平台',
  gzebpubservice: '广州交易平台',
  ccgp: '中国政府采购网',
  ggzyNational: '全国交易平台',
  cebpubservice: '中国招投标服务'
};

function normalizeTenderPlatform(value: string | null | undefined): string {
  if (value === '广州公共资源交易平台') return '广州公共资源交易公共服务平台';
  return value || '';
}

const DASHBOARD_RECENT_SEARCH_KEY = 'bim-tender-dashboard-recent-searches';
const MANUAL_RECENT_SEARCH_KEY = 'bim-tender-manual-recent-searches';
const SAVED_FILTER_VIEWS_KEY = 'bim-tender-saved-filter-views';
const OPPORTUNITY_ACTIONS_KEY = 'bim-tender-opportunity-actions';

type OpportunityAction = 'follow' | 'archive' | 'ignore';

function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSearchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function extractNotificationSearchText(notification: Pick<Notification, 'title' | 'content'>): string {
  const normalizedTitle = notification.title.replace(/^发现新招采公告[:：]?\s*/u, '').trim();
  if (normalizedTitle) return normalizedTitle;

  const summaryHead = notification.content
    .split(/[\n，,。；;]/u)
    .map((item) => item.trim())
    .find(Boolean);

  return summaryHead || '';
}

function renderHighlightedText(
  text: string,
  query: string,
  className = 'bg-amber-300/25 text-amber-50',
  maxHighlights = Number.POSITIVE_INFINITY
): ReactNode {
  const terms = getSearchTerms(query);
  if (!text || terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  let highlightedCount = 0;
  return parts.map((part, index) =>
    terms.some((term) => part.toLowerCase() === term.toLowerCase()) && highlightedCount < maxHighlights ? (
      (() => {
        highlightedCount += 1;
        return (
      <mark key={`${part}-${index}`} className={cn('rounded px-1 py-0.5 font-medium', className)}>
        {part}
      </mark>
        );
      })()
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function getBadgeTone(tone: string, themeMode: ThemeMode): string {
  if (themeMode === 'dark') return `${tone} font-medium`;
  if (tone.includes('red')) return 'font-medium border-red-300 bg-red-100 text-red-800';
  if (tone.includes('rose')) return 'font-medium border-rose-300 bg-rose-100 text-rose-800';
  if (tone.includes('orange')) return 'font-medium border-orange-300 bg-orange-100 text-orange-800';
  if (tone.includes('amber')) return 'font-medium border-amber-300 bg-amber-100 text-amber-800';
  if (tone.includes('emerald')) return 'font-medium border-emerald-300 bg-emerald-100 text-emerald-800';
  if (tone.includes('violet')) return 'font-medium border-violet-300 bg-violet-100 text-violet-800';
  if (tone.includes('sky')) return 'font-medium border-sky-300 bg-sky-100 text-sky-800';
  if (tone.includes('cyan')) return 'font-medium border-cyan-300 bg-cyan-100 text-cyan-800';
  if (tone.includes('slate')) return 'font-medium border-slate-300 bg-slate-100 text-slate-800';
  if (tone.includes('white')) return 'font-medium border-slate-300 bg-white text-slate-800';
  return 'font-medium border-slate-300 bg-white text-slate-800';
}

function getPlatformBadgeTone(themeMode: ThemeMode): string {
  return themeMode === 'light'
    ? 'font-medium border-cyan-300 bg-cyan-100 text-cyan-800'
    : 'font-medium border-cyan-400/20 bg-cyan-500/10 text-cyan-200';
}

function getOpportunityActionMeta(action: OpportunityAction | undefined, themeMode: ThemeMode): { label: string; tone: string } | null {
  if (!action) return null;
  if (action === 'follow') {
    return {
      label: '已标记跟进',
      tone: themeMode === 'light' ? 'font-medium border-emerald-300 bg-emerald-100 text-emerald-800' : 'font-medium border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
    };
  }
  if (action === 'archive') {
    return {
      label: '已归档',
      tone: themeMode === 'light' ? 'font-medium border-slate-300 bg-slate-100 text-slate-800' : 'font-medium border-slate-400/15 bg-slate-500/10 text-slate-300'
    };
  }
  return {
    label: '已忽略',
    tone: themeMode === 'light' ? 'font-medium border-amber-300 bg-amber-100 text-amber-800' : 'font-medium border-amber-300/25 bg-amber-400/12 text-amber-200'
  };
}

function hotspotMatchesSearch(hotspot: Hotspot, query: string, mode: 'title' | 'fulltext'): boolean {
  const terms = getSearchTerms(query.toLowerCase());
  if (terms.length === 0) return true;

  const haystacks = mode === 'title'
    ? [hotspot.title]
    : [
        hotspot.title,
        hotspot.content,
        hotspot.summary || '',
        hotspot.tenderUnit || '',
        hotspot.tenderProjectCode || '',
        hotspot.tenderServiceScope || '',
        hotspot.tenderQualification || '',
        hotspot.tenderRegion || '',
        hotspot.tenderCity || '',
        hotspot.tenderAddress || '',
        hotspot.tenderContact || ''
      ];

  const normalized = haystacks.join(' ').toLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function readStoredStringArray(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredStringArray(key: string, values: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(values.slice(0, 8)));
}

function rememberSearchTerm(list: string[], term: string): string[] {
  const normalized = term.trim();
  if (!normalized) return list;
  return [normalized, ...list.filter((item) => item !== normalized)].slice(0, 8);
}

function readSavedFilterViews(): SavedFilterView[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_FILTER_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is SavedFilterView => Boolean(item?.id && item?.name && item?.filters)) : [];
  } catch {
    return [];
  }
}

function readOpportunityActions(): Record<string, OpportunityAction> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(OPPORTUNITY_ACTIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed as Record<string, OpportunityAction> : {};
  } catch {
    return {};
  }
}

function getHealthTone(ok: boolean, circuitOpen?: boolean): string {
  if (circuitOpen) return 'text-red-300 bg-red-500/10 border-red-400/20';
  if (ok) return 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20';
  return 'text-amber-200 bg-amber-500/10 border-amber-400/20';
}

function getSourceStatusTone(status: string | undefined, ok: boolean, circuitOpen?: boolean): string {
  if (status === 'disabled') return 'text-slate-300 bg-slate-500/10 border-slate-400/20';
  if (status === 'healthy') return 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20';
  if (status === 'degraded') return 'text-cyan-200 bg-cyan-500/10 border-cyan-400/20';
  if (status === 'empty') return 'text-amber-200 bg-amber-500/10 border-amber-400/20';
  if (status === 'waf_blocked' || status === 'circuit_open') return 'text-red-300 bg-red-500/10 border-red-400/20';
  if (status === 'request_failed') return 'text-orange-200 bg-orange-500/10 border-orange-400/20';
  return getHealthTone(ok, circuitOpen);
}

function getProxyStatusTone(status: string | undefined, probeOk: boolean): string {
  if (probeOk || status === 'healthy') return 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20';
  if (status === 'untested') return 'text-slate-300 bg-slate-500/10 border-slate-400/20';
  if (status === 'auth_required' || status === 'tunnel_unreachable') return 'text-red-300 bg-red-500/10 border-red-400/20';
  if (status === 'upstream_blocked') return 'text-orange-200 bg-orange-500/10 border-orange-400/20';
  if (status === 'timeout' || status === 'gateway_502' || status === 'connection_reset' || status === 'http_error' || status === 'request_failed') {
    return 'text-amber-200 bg-amber-500/10 border-amber-400/20';
  }
  return 'text-red-300 bg-red-500/10 border-red-400/20';
}

function formatProxySources(sources: string[]): string {
  if (!sources.length) return '未绑定来源';
  return sources.map((item) => item === 'default' ? '默认池' : getSourceLabel(item)).join(' / ');
}

function getProxyAlertTone(severity: 'healthy' | 'warning' | 'critical', themeMode: ThemeMode): string {
  if (severity === 'critical') return getBadgeTone('text-red-200 bg-red-500/10 border-red-400/20', themeMode);
  if (severity === 'warning') return getBadgeTone('text-amber-200 bg-amber-500/10 border-amber-400/20', themeMode);
  return getBadgeTone('text-emerald-200 bg-emerald-500/10 border-emerald-400/20', themeMode);
}

function getSourceQualityMeta(grade: string | undefined, score: number): { label: string; tone: string } {
  if (grade === 'no_sample') return { label: '暂无样本', tone: 'text-slate-300 bg-slate-500/10 border-slate-400/20' };
  if (grade === 'good' || score >= 70) return { label: '质量较高', tone: 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20' };
  if (grade === 'needs_enrichment' || score >= 45) return { label: '待补强', tone: 'text-amber-200 bg-amber-500/10 border-amber-400/20' };
  return { label: '质量偏低', tone: 'text-red-200 bg-red-500/10 border-red-400/20' };
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

function buildStageBuckets(items: Hotspot[]): Bucket[] {
  const counters = {
    actionable: 0,
    preSignal: 0,
    change: 0,
    closed: 0,
    unknown: 0
  };

  for (const item of items) {
    switch (item.tenderStageBucket) {
      case 'actionable':
        counters.actionable += 1;
        break;
      case 'pre-signal':
        counters.preSignal += 1;
        break;
      case 'change':
        counters.change += 1;
        break;
      case 'closed':
        counters.closed += 1;
        break;
      default:
        counters.unknown += 1;
        break;
    }
  }

  return [
    { label: '正式可跟进', value: counters.actionable },
    { label: '前置信号', value: counters.preSignal },
    { label: '变更复核', value: counters.change },
    { label: '结果归档', value: counters.closed },
    { label: '待判定', value: counters.unknown }
  ];
}

function buildTrendPoints(items: Hotspot[]): TrendPoint[] {
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Array.from({ length: 7 }, (_, index) => {
    const current = new Date(base);
    current.setDate(base.getDate() - (6 - index));
    const key = current.toISOString().slice(0, 10);
    return {
      key,
      label: formatter.format(current).replace('/', ' / '),
      shortLabel: formatter.format(current).split('/').pop() || `${current.getDate()}`,
      actionable: 0,
      preSignal: 0,
      expired: 0,
      priority: 0,
    };
  });
  const dayMap = new Map(days.map((item) => [item.key, item]));

  for (const item of items) {
    const rawDate = item.publishedAt || item.createdAt;
    if (!rawDate) continue;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    const target = dayMap.get(key);
    if (!target) continue;

    if (item.tenderStageBucket === 'actionable') target.actionable += 1;
    if (item.tenderStageBucket === 'pre-signal') target.preSignal += 1;
    if (getDeadlineInfo(getEffectiveDeadline(item)).urgency === 'expired') target.expired += 1;
    if (getOpportunityRank(item).label === '优先跟进') target.priority += 1;
  }

  return days;
}

function getLeadingBucket(data: Bucket[]): Bucket | null {
  const filtered = data.filter((item) => item.value > 0);
  if (!filtered.length) return null;
  return [...filtered].sort((a, b) => b.value - a.value)[0];
}

function buildBusinessReadouts(items: Hotspot[], regionBuckets: Bucket[], budgetBuckets: Bucket[], typeBuckets: Bucket[]): Array<{
  title: string;
  summary: string;
  detail: string;
  tone: string;
}> {
  const regionLead = getLeadingBucket(regionBuckets);
  const budgetLead = getLeadingBucket(budgetBuckets);
  const typeLead = getLeadingBucket(typeBuckets);
  const stageSummary = buildOpportunityStageSummary(items);
  const actionableShare = items.length ? Math.round((stageSummary.actionable / items.length) * 100) : 0;
  const signalShare = items.length ? Math.round((stageSummary.preSignal / items.length) * 100) : 0;

  return [
    {
      title: '区域热点',
      summary: regionLead ? `${regionLead.label} 是当前最密集的项目区域。` : '当前还没有形成明显区域热点。',
      detail: regionLead ? `当前样本里 ${regionLead.label} 有 ${regionLead.value} 条，可优先安排本地资源判断。` : '等待更多样本后再判断是深圳、广州还是全国项目在抬头。',
      tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200',
    },
    {
      title: '预算结构',
      summary: budgetLead ? `${budgetLead.label} 是当前最常见的预算区间。` : '当前披露预算的样本还不够多。',
      detail: budgetLead ? `如果这个区间持续占比最高，首页可以优先按 ${budgetLead.label} 的资源投入做商机判断。`
        : '建议继续补强预算字段，方便后面做更稳定的体量分析。',
      tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
    },
    {
      title: '类型偏向',
      summary: typeLead ? `${typeLead.label} 是当前最活跃的 BIM 需求方向。` : '当前 BIM 类型分布仍偏分散。',
      detail: typeLead ? `当前样本里 ${typeLead.label} 共 ${typeLead.value} 条，可优先匹配设计、施工或咨询资源。`
        : '后面可以继续按 BIM 类型做更细的团队分派视图。',
      tone: 'border-violet-400/20 bg-violet-500/10 text-violet-200',
    },
    {
      title: '机会结构',
      summary: actionableShare >= signalShare ? '正式可跟进公告仍是主线。' : '前置信号占比更高，适合 BD 提前卡位。',
      detail: `当前正式机会占比 ${actionableShare}% ，前置信号占比 ${signalShare}% ，可以据此决定是优先做投标判断还是做前哨跟踪。`,
      tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200',
    },
  ];
}

function formatBudget(value: number | null): string {
  if (value == null) return '未披露';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 亿元`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} 万元`;
}

function isFallbackAIReason(reason: string | null): boolean {
  if (!reason) return false;
  return reason.includes('未配置 AI 服务')
    || reason.includes('AI 分析失败')
    || reason.includes('AI 分析超时或失败')
    || reason.includes('规则投标分析')
    || reason.includes('规则判断')
    || reason.includes('默认分数');
}

function getAIInsight(reason: string | null): { label: string; text: string; mode: 'ai' | 'fallback' } | null {
  const normalized = reason?.trim();
  if (!normalized) return null;

  if (!isFallbackAIReason(normalized)) {
    return {
      label: 'AI 判定',
      text: normalized,
      mode: 'ai'
    };
  }

  const fallbackReason = normalized.includes('规则判断：')
    ? normalized.split('规则判断：')[1]
    : normalized
      .replace(/^未配置 AI 服务，使用规则投标分析[；;]?\s*/, '')
      .replace(/^AI 分析失败，使用规则投标分析[；;]?\s*/, '')
      .replace(/^AI 分析超时或失败，使用规则投标分析[；;]?\s*/, '')
      .replace(/^未配置 AI 服务，使用默认分数[；;]?\s*/, '')
      .replace(/^AI 分析失败，使用默认分数[；;]?\s*/, '');

  return {
    label: '规则回退',
    text: (fallbackReason
      .replace(/，/g, '；')
      .replace(/\s+/g, ' ')
      .trim()) || '本轮 AI 超时或异常，已回退到规则判断。',
    mode: 'fallback'
  };
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

function getNoticeStage(
  hotspot: Pick<Hotspot, 'tenderStageCategory' | 'tenderStageLabel' | 'tenderStageBucket' | 'tenderNoticeType'>
): { label: string; tone: string } {
  const label = hotspot.tenderStageLabel || hotspot.tenderNoticeType || '待判定';

  switch (hotspot.tenderStageBucket) {
    case 'actionable':
      if (hotspot.tenderStageCategory === 'prequalification_notice') {
        return { label, tone: 'border-sky-400/25 bg-sky-500/12 text-sky-100' };
      }
      return { label, tone: 'border-cyan-400/25 bg-cyan-500/12 text-cyan-100' };
    case 'pre-signal':
      return { label, tone: 'border-amber-300/25 bg-amber-400/12 text-amber-100' };
    case 'change':
      return { label, tone: 'border-orange-300/25 bg-orange-400/12 text-orange-100' };
    case 'closed':
      return { label, tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300' };
    default:
      return { label, tone: 'border-white/10 bg-white/5 text-slate-300' };
  }
}

function getOpportunitySortLabel(sortBy: string | undefined): string {
  switch (sortBy) {
    case 'publishedAt':
      return '按最新发布排序';
    case 'deadlineStatus':
      return '按截止窗口排序';
    case 'relevance':
      return '按业务相关性排序';
    case 'importance':
      return '按重要程度排序';
    default:
      return '按最新发现排序';
  }
}

function getOpportunityViewMeta(filters: Pick<FilterState, 'tenderStage' | 'includeExpired' | 'sortBy'>): {
  label: string;
  description: string;
  tone: string;
} {
  const sortLabel = getOpportunitySortLabel(filters.sortBy);
  const includeExpired = filters.includeExpired !== 'false';

  switch (filters.tenderStage) {
    case 'actionable':
      return {
        label: '可跟进公告视图',
        description: `仅保留正式公告、资格预审和变更补遗；${sortLabel}。${includeExpired ? '当前包含已截止样本。' : '已自动隐藏已截止样本。'}`,
        tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'
      };
    case 'formal_notice':
      return {
        label: '正式公告视图',
        description: `聚焦真正可投标的正式公告；${sortLabel}。`,
        tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'
      };
    case 'prequalification_notice':
      return {
        label: '资格预审视图',
        description: `适合优先核对资格门槛、报名窗口和联合体要求；${sortLabel}。`,
        tone: 'border-sky-400/20 bg-sky-500/10 text-sky-200'
      };
    case 'change':
    case 'change_notice':
      return {
        label: '变更复核视图',
        description: `重点检查截止时间、文件范围和资质条件是否发生变化；${sortLabel}。`,
        tone: 'border-orange-300/25 bg-orange-400/12 text-orange-200'
      };
    case 'pre-signal':
      return {
        label: '前置信号观察池',
        description: `用于提前跟踪采购意向和招标计划，等待正式公告落地；${sortLabel}。`,
        tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200'
      };
    case 'procurement_intent':
      return {
        label: '采购意向观察池',
        description: `优先观察需求方向、预算线索和预计采购时间，不与正式公告混排；${sortLabel}。`,
        tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200'
      };
    case 'tender_plan':
      return {
        label: '招标计划观察池',
        description: `适合前置跟踪预计招标时间、建设地点和项目概况；${sortLabel}。`,
        tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200'
      };
    case 'closed':
    case 'result_notice':
    case 'contract_notice':
      return {
        label: '归档信息视图',
        description: `当前以结果公示和合同履约样本为主，适合作为复盘或客户线索；${sortLabel}。`,
        tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300'
      };
    default:
      return {
        label: '混合机会池',
        description: `当前同时展示正式公告、前置信号和变更样本；${sortLabel}。${includeExpired ? '如需聚焦当前机会，可关闭已截止样本。' : '已截止样本已隐藏。'}`,
        tone: 'border-white/10 bg-white/5 text-slate-300'
      };
  }
}

function getOpportunitySummary(hotspot: Hotspot): string {
  if (hotspot.tenderStageBucket === 'pre-signal') {
    return hotspot.tenderStageCategory === 'procurement_intent'
      ? hotspot.tenderServiceScope || '当前是采购意向线索，优先关注预算、需求概况和预计采购时间。'
      : hotspot.tenderServiceScope || '当前是招标计划线索，优先关注预计招标时间、项目地点和计划阶段。';
  }

  if (hotspot.tenderStageBucket === 'change') {
    return hotspot.tenderServiceScope || hotspot.summary || '当前进入变更或补遗阶段，建议先核对截止时间、文件范围和资格条件变化。';
  }

  if (hotspot.tenderStageBucket === 'closed') {
    return hotspot.summary || '当前属于结果或合同阶段，适合作为历史样本复盘，不再进入一线投标决策。';
  }

  return hotspot.summary
    || hotspot.tenderServiceScope
    || (hotspot.tenderUnit
      ? `优先确认 ${hotspot.tenderUnit} 的招采条件、资质要求和投标截止节点。`
      : '当前公告缺少单位或预算字段，建议进入详情页补齐关键信息后再判断是否跟进。');
}

function getOpportunityPriorityReason(hotspot: Hotspot): string {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  const completeness = getFieldCompleteness(hotspot);

  if (hotspot.tenderStageBucket === 'pre-signal') {
    return hotspot.tenderStageCategory === 'procurement_intent' ? '优先作为采购需求前哨线索' : '优先作为招标计划前哨线索';
  }
  if (hotspot.tenderStageBucket === 'change') return '优先复核变更是否影响投标窗口';
  if (deadline.urgency === 'urgent') return '截止窗口紧，优先核对报名与投标节点';
  if (hotspot.tenderBudgetWan != null && hotspot.tenderBudgetWan >= 100) return '预算规模较高，优先进入资源评估';
  if (completeness.score >= 75) return '核心字段较完整，适合直接判断';
  if (hotspot.relevance >= 80) return '业务匹配度较高，建议尽快筛查';
  return '保留在线索池，等待更多字段或人工判断';
}

function buildOpportunityStageSummary(items: Hotspot[]) {
  return items.reduce((acc, item) => {
    if (item.tenderStageBucket === 'actionable') acc.actionable += 1;
    if (item.tenderStageBucket === 'pre-signal') acc.preSignal += 1;
    if (item.tenderStageBucket === 'change') acc.change += 1;
    if (item.tenderStageBucket === 'closed') acc.closed += 1;
    if (item.tenderActionable && getDeadlineInfo(getEffectiveDeadline(item)).urgency === 'urgent') acc.urgent += 1;
    if (item.tenderActionable && getFieldCompleteness(item).score >= 75) acc.complete += 1;
    return acc;
  }, {
    actionable: 0,
    preSignal: 0,
    change: 0,
    closed: 0,
    urgent: 0,
    complete: 0
  });
}

function getDetailReliability(hotspot: Pick<Hotspot, 'url' | 'title' | 'tenderDetailSource'>): { label: string; tone: string } {
  const url = hotspot.url || '';
  const source = hotspot.tenderDetailSource || '';
  const title = hotspot.title || '';

  if (url.includes('show-bid-opening/list') || /中标|成交|结果公告|候选人公示/.test(title)) {
    return { label: '低可信结果页', tone: 'border-rose-400/25 bg-rose-500/12 text-rose-200' };
  }
  if (source.includes('firecrawl-detail-json') || source.includes('detail-enrichment+agent-firecrawl') || source.includes('detail-enrichment+openclaw-browser')) {
    return { label: '深抓取详情', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' };
  }
  if (source.includes('szggzy-api+rules') || source.includes('source-detail+rules') || source.includes('detail-enrichment')) {
    return { label: '官方详情已解析', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' };
  }
  if (source.includes('ceb-list+official-table')) {
    return { label: '官方列表可信', tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200' };
  }
  if (url.includes('szggzy.com/globalSearch/details.html') || url.includes('nodeId=') || url.includes('detailTop') || /gzebpubservice\.cn\/jyfw\//.test(url)) {
    return { label: '原始详情已校验', tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200' };
  }
  return { label: '待人工核验', tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200' };
}

function getDetailReliabilityNarrative(hotspot: Pick<Hotspot, 'url' | 'title' | 'tenderDetailSource'>): {
  title: string;
  description: string;
  nextStep: string;
} {
  const source = hotspot.tenderDetailSource || '';
  const url = hotspot.url || '';
  const title = hotspot.title || '';

  if (url.includes('show-bid-opening/list') || /中标|成交|结果公告|候选人公示/.test(title)) {
    return {
      title: '结果页可信度偏低',
      description: '当前链接更像开标、结果或公示页，字段虽然能看，但不适合作为正式投标判断依据。',
      nextStep: '优先回原公告或官方详情页，核对预算、截止时间和报名要求是否来自同一项目。',
    };
  }
  if (source.includes('firecrawl-detail-json') || source.includes('detail-enrichment+agent-firecrawl') || source.includes('detail-enrichment+openclaw-browser')) {
    return {
      title: '深抓取详情',
      description: '字段来自浏览器深抓取或增强队列，通常比列表页更完整，适合直接用于投标初筛。',
      nextStep: '优先核对联系人、预算和资格要求，再决定是否推送飞书或进入跟进池。',
    };
  }
  if (source.includes('szggzy-api+rules') || source.includes('source-detail+rules') || source.includes('detail-enrichment')) {
    return {
      title: '官方详情已解析',
      description: '字段来自平台官方详情接口或规则解析，可靠性较高，适合直接判断项目窗口和单位信息。',
      nextStep: '重点复核时间轴、项目编号和服务范围是否满足当前投标策略。',
    };
  }
  if (source.includes('ceb-list+official-table')) {
    return {
      title: '官方列表可信',
      description: '当前主要来自平台官方列表，标题和基础信息可信，但详情字段仍可能不完整。',
      nextStep: '先作为线索保留，等正式详情补齐后再决定是否进入一线跟进。',
    };
  }
  if (url.includes('szggzy.com/globalSearch/details.html') || url.includes('nodeId=') || url.includes('detailTop') || /gzebpubservice\.cn\/jyfw\//.test(url)) {
    return {
      title: '原始详情已校验',
      description: '当前详情链接本身是可信的原始公告地址，适合人工继续确认原文和附件。',
      nextStep: '可直接打开原始公告，对照页面正文确认附件、资格要求和报名方式。',
    };
  }
  return {
    title: '待人工核验',
    description: '当前字段主要来自列表或规则推断，还不适合完全替代人工核验。',
    nextStep: '先核对单位、预算和截止时间，再决定是否推进为正式机会。',
  };
}

function getBidAction(hotspot: Hotspot): string {
  if (hotspot.tenderStageBucket === 'pre-signal') {
    return hotspot.tenderStageCategory === 'procurement_intent'
      ? '跟踪正式采购公告'
      : '跟踪正式招标公告';
  }
  if (hotspot.tenderStageBucket === 'closed') return '归档历史样本';
  if (hotspot.tenderStageBucket === 'change') return '核对变更对报名与投标窗口的影响';
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  if (deadline.urgency === 'expired') return '归档观察';
  if (deadline.urgency === 'urgent') return '立即核对投标窗口';
  if (!hotspot.tenderUnit || !hotspot.tenderBudgetWan) return '补齐单位/预算信息';
  if (hotspot.tenderType?.includes('设计')) return '评估设计团队匹配度';
  if (hotspot.tenderType?.includes('施工')) return '评估施工阶段 BIM 资源';
  return '进入商机初筛';
}

function getOpportunityRank(hotspot: Hotspot): { label: string; tone: string } {
  if (hotspot.tenderStageBucket === 'pre-signal') {
    return { label: '前置信号', tone: 'border-amber-300/25 bg-amber-400/12 text-amber-100' };
  }
  if (hotspot.tenderStageBucket === 'change') {
    return { label: '变更跟踪', tone: 'border-orange-300/25 bg-orange-400/12 text-orange-100' };
  }
  if (hotspot.tenderStageBucket === 'closed') {
    return { label: '归档信息', tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300' };
  }
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
  if (hotspot.tenderStageBucket === 'pre-signal') {
    return {
      label: '持续跟踪',
      tone: 'border-amber-300/25 bg-amber-400/12 text-amber-100',
      summary: hotspot.tenderStageCategory === 'procurement_intent'
        ? '当前更适合作为采购意向线索，建议等待正式公告后再进入投标评估。'
        : '当前更适合作为招标计划线索，建议跟踪后续正式公告与资格条件。'
    };
  }

  if (hotspot.tenderStageBucket === 'closed') {
    return {
      label: '归档观察',
      tone: 'border-slate-400/15 bg-slate-500/10 text-slate-300',
      summary: '当前属于结果或合同阶段，不进入优先跟进，可留作历史样本和客户线索。'
    };
  }

  if (hotspot.tenderStageBucket === 'change') {
    return {
      label: '核对变更',
      tone: 'border-orange-300/25 bg-orange-400/12 text-orange-100',
      summary: '该项目已进入变更或补遗阶段，建议先核对截止时间、文件范围和报名条件是否变化。'
    };
  }

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

function DashboardMetric({ title, value, caption, tone, icon: Icon, themeMode = 'dark' }: {
  title: string;
  value: string | number;
  caption: string;
  tone: string;
  icon: typeof Activity;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'relative overflow-hidden rounded-[28px] border p-5 sm:p-6',
        isLight ? 'border-slate-200 bg-white' : tone
      )}
    >
      <div className={cn(
        'absolute inset-0',
        isLight
          ? 'bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.08),transparent_45%)]'
          : 'bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_45%)]'
      )} />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{title}</p>
          <p className={cn('mt-3 text-3xl font-semibold sm:text-4xl', isLight ? 'text-slate-900' : 'text-white')}>{value}</p>
          <p className={cn('mt-2 text-sm', isLight ? 'text-slate-500' : 'text-slate-300/80')}>{caption}</p>
        </div>
        <div className={cn(
          'rounded-2xl border p-3',
          isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/6 text-white/90'
        )}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </motion.div>
  );
}

function DataBars({ title, subtitle, data, tone, themeMode = 'dark' }: {
  title: string;
  subtitle: string;
  data: Bucket[];
  tone: string;
  themeMode?: ThemeMode;
}) {
  const max = Math.max(...data.map(item => item.value), 1);
  const isLight = themeMode === 'light';
  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{title}</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>{subtitle}</p>
        </div>
      </div>
      <div className="space-y-3">
        {data.map(item => (
          <div key={item.label}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className={cn(isLight ? 'text-slate-700' : 'text-slate-300')}>{item.label}</span>
              <span className="text-slate-500">{item.value}</span>
            </div>
            <div className={cn('h-2 rounded-full', isLight ? 'bg-slate-100' : 'bg-white/6')}>
              <div className={cn('h-2 rounded-full transition-all', tone)} style={{ width: `${toPercent(item.value, max)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnalysisCard({ title, value, caption, icon: Icon, tone, themeMode = 'dark' }: {
  title: string;
  value: string;
  caption: string;
  icon: typeof Activity;
  tone: string;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/10 bg-[#101427]')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{title}</p>
          <p className={cn('mt-3 text-2xl font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{value}</p>
          <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{caption}</p>
        </div>
        <div className={cn('rounded-2xl border p-3', tone)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function TrendPanel({
  title,
  subtitle,
  points,
  themeMode = 'dark',
}: {
  title: string;
  subtitle: string;
  points: TrendPoint[];
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  const metrics = [
    { key: 'actionable', label: '新机会', tone: 'bg-[linear-gradient(90deg,#22d3ee,#14b8a6)]' },
    { key: 'preSignal', label: '前置信号', tone: 'bg-[linear-gradient(90deg,#f59e0b,#fbbf24)]' },
    { key: 'expired', label: '已截止', tone: 'bg-[linear-gradient(90deg,#94a3b8,#64748b)]' },
    { key: 'priority', label: '优先跟进池', tone: 'bg-[linear-gradient(90deg,#fb7185,#ef4444)]' },
  ] as const;
  const max = Math.max(
    1,
    ...points.flatMap((point) => metrics.map((metric) => point[metric.key]))
  );

  return (
    <section className={cn(
      'rounded-[28px] border p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{title}</h3>
          <p className={cn('mt-1 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{subtitle}</p>
        </div>
        <span className={cn('rounded-full border px-3 py-1.5 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>
          最近 7 天
        </span>
      </div>

      <div className="space-y-4">
        {metrics.map((metric) => (
          <div key={metric.key}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className={cn('text-sm font-medium', isLight ? 'text-slate-800' : 'text-slate-200')}>{metric.label}</span>
              <span className="text-xs text-slate-500">{points.reduce((sum, point) => sum + point[metric.key], 0)} 条</span>
            </div>
            <div className="grid grid-cols-7 gap-2">
              {points.map((point) => (
                <div key={`${metric.key}-${point.label}`} className={cn('rounded-2xl border p-2.5', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
                  <div className="flex h-16 items-end">
                    <div className={cn('w-full rounded-full transition-all', metric.tone)} style={{ height: `${Math.max(8, Math.round((point[metric.key] / max) * 100))}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">{point.shortLabel}</p>
                  <p className={cn('mt-1 text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{point[metric.key]}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReadoutPanel({
  title,
  subtitle,
  items,
  themeMode = 'dark',
}: {
  title: string;
  subtitle: string;
  items: Array<{ title: string; summary: string; detail: string; tone: string }>;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <section className={cn(
      'rounded-[28px] border p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5">
        <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{title}</h3>
        <p className={cn('mt-1 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{subtitle}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <div key={item.title} className={cn('rounded-[24px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
            <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[11px]', getBadgeTone(item.tone, themeMode))}>{item.title}</span>
            <p className={cn('mt-3 text-base font-semibold leading-7', isLight ? 'text-slate-900' : 'text-white')}>{item.summary}</p>
            <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProxyFact({
  label,
  value,
  themeMode = 'dark',
}: {
  label: string;
  value: string;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <div className={cn(
      'rounded-2xl border px-3 py-3',
      isLight ? 'border-slate-200 bg-white' : 'border-white/8 bg-white/[0.035]'
    )}>
      <p className={cn('text-[11px] uppercase tracking-[0.18em]', isLight ? 'text-slate-500' : 'text-slate-500')}>{label}</p>
      <p className={cn('mt-2 text-sm leading-6 break-words', isLight ? 'text-slate-900' : 'text-slate-200')}>{value}</p>
    </div>
  );
}

function SourceQualityComparePanel({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  const rows = useMemo(() => {
    if (!summary) return [];
    return [...summary.sourceQuality]
      .map((item) => ({
        source: item.source,
        label: getSourceLabel(item.source),
        qualityScore: item.qualityScore,
        activeCount: item.activeCount,
        detailCoverage: item.detailCoverage,
        contactCoverage: item.contactCoverage,
        qualityGrade: item.qualityGrade,
      }))
      .sort((a, b) => b.qualityScore - a.qualityScore || b.activeCount - a.activeCount)
      .slice(0, 5);
  }, [summary]);

  const weakest = useMemo(() => {
    if (!summary?.sourceQuality?.length) return null;
    return [...summary.sourceQuality]
      .sort((a, b) => a.qualityScore - b.qualityScore || b.dirtyIssueCount - a.dirtyIssueCount)[0];
  }, [summary]);

  return (
    <section className={cn(
      'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300/75">Source Quality</p>
          <h3 className={cn('mt-2 text-2xl font-semibold', isLight ? 'text-slate-900' : 'text-white')}>来源质量对比</h3>
          <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>把质量高、能稳定产出有效机会的来源放到前面，也把最需要治理的来源直接挑出来。</p>
        </div>
        {weakest && (
          <span className={cn(
            'rounded-full border px-3 py-1.5 text-xs',
            getBadgeTone('border-amber-300/25 bg-amber-400/12 text-amber-200', themeMode)
          )}>
            当前待治理：{getSourceLabel(weakest.source)}
          </span>
        )}
      </div>
      <div className="space-y-3">
        {rows.map((item, index) => (
          <div
            key={item.source}
            className={cn(
              'rounded-[24px] border p-4',
              isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]'
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px]',
                    index === 0
                      ? getBadgeTone('border-emerald-400/20 bg-emerald-500/10 text-emerald-200', themeMode)
                      : isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/5 text-slate-300'
                  )}>
                    {index === 0 ? '当前最稳' : `TOP ${index + 1}`}
                  </span>
                  <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{item.label}</p>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  质量分 {item.qualityScore} · 可跟进 {item.activeCount} · 详情解析率 {item.detailCoverage}% · 联系人披露 {item.contactCoverage}%
                </p>
              </div>
              <span className={cn('rounded-full border px-3 py-1 text-xs', getBadgeTone(
                item.qualityScore >= 70
                  ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
                  : item.qualityScore >= 45
                    ? 'border-amber-300/25 bg-amber-400/12 text-amber-200'
                    : 'border-red-400/20 bg-red-500/10 text-red-200',
                themeMode
              ))}>
                {item.qualityScore >= 70 ? '稳定产出' : item.qualityScore >= 45 ? '待补强' : '需治理'}
              </span>
            </div>
            <div className={cn('mt-4 h-2 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#22c55e,#0ea5e9)]"
                style={{ width: `${Math.max(item.qualityScore, 8)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TenderFact({ label, value, icon: Icon, strong = false, themeMode = 'dark' }: {
  label: string;
  value: string;
  icon: typeof Activity;
  strong?: boolean;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <div className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.035]')}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={cn('mt-2 leading-6', strong ? (isLight ? 'text-lg font-semibold text-slate-900' : 'text-lg font-semibold text-white') : (isLight ? 'text-sm font-medium text-slate-700' : 'text-sm font-medium text-slate-200'))}>
        {value || '待补全'}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  icon: Icon,
  themeMode = 'dark',
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <div className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.035]')}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={cn('mt-2 whitespace-pre-wrap break-words text-sm leading-6', isLight ? 'text-slate-700' : 'text-slate-200')}>
        {value}
      </div>
    </div>
  );
}

function DetailFieldSection({
  title,
  subtitle,
  children,
  themeMode = 'dark',
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <section className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
      <div className="mb-4">
        <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{title}</h3>
        <p className={cn('mt-1 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function HotspotDetailPage({
  hotspot,
  isLoading,
  onBack,
  onNotifyFeishu,
  isNotifyingFeishu = false,
  feishuWebhookEnabled = false,
  themeMode = 'dark',
}: {
  hotspot: Hotspot | null;
  isLoading: boolean;
  onBack: () => void;
  onNotifyFeishu: (hotspot: Hotspot) => void;
  isNotifyingFeishu?: boolean;
  feishuWebhookEnabled?: boolean;
  themeMode?: ThemeMode;
}) {
  const [showFloatingBack, setShowFloatingBack] = useState(false);

  useEffect(() => {
    if (!hotspot) {
      setShowFloatingBack(false);
      return;
    }

    const handleScroll = () => {
      setShowFloatingBack(window.scrollY > 360);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [hotspot?.id]);

  if (!hotspot && !isLoading) return null;

  const isLight = themeMode === 'light';
  const deadline = hotspot ? getDeadlineInfo(getEffectiveDeadline(hotspot)) : null;
  const stage = hotspot ? getNoticeStage(hotspot) : null;
  const detailReliability = hotspot ? getDetailReliability(hotspot) : null;
  const region = hotspot ? [hotspot.tenderRegion, hotspot.tenderCity].filter(Boolean).join(' / ') || '未标注' : '载入中';
  const published = hotspot?.publishedAt ? formatDateTime(hotspot.publishedAt) : '未披露';
  const extractedAt = hotspot?.tenderDetailExtractedAt ? formatDateTime(hotspot.tenderDetailExtractedAt) : '未记录';
  const completeness = hotspot ? getFieldCompleteness(hotspot) : null;
  const recommendation = hotspot ? getFollowUpRecommendation(hotspot) : null;
  const timeline = hotspot ? buildTimeline(hotspot) : [];
  const detailNarrative = hotspot ? getDetailReliabilityNarrative(hotspot) : null;

  return (
    <section className="space-y-6">
      <div className={cn(
        'overflow-hidden rounded-[34px] border p-6 shadow-[0_28px_110px_rgba(0,0,0,0.34)]',
        isLight
          ? 'border-cyan-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.1),rgba(255,255,255,0.96)_48%,rgba(20,184,166,0.06))]'
          : 'border-cyan-300/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.18),rgba(15,23,42,0.9)_48%,rgba(20,184,166,0.12))]'
      )}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-4xl">
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/75">Opportunity Detail</p>
              <h2 className={cn('mt-3 text-3xl font-semibold tracking-tight sm:text-4xl', isLight ? 'text-slate-900' : 'text-white')}>
                {hotspot?.title || '正在加载项目详情'}
              </h2>
              {hotspot && (
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getPlatformBadgeTone(themeMode))}>
                    {hotspot.tenderPlatform || getSourceLabel(hotspot.source)}
                  </span>
                  {deadline && <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(deadline.tone, themeMode))}>{deadline.label}</span>}
                  {stage && <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(stage.tone, themeMode))}>{stage.label}</span>}
                  {detailReliability && <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(detailReliability.tone, themeMode))}>{detailReliability.label}</span>}
                  {completeness && <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(completeness.tone, themeMode))}>{completeness.label} · {completeness.score}</span>}
                </div>
              )}
            </div>
            <button
              onClick={onBack}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition',
                isLight ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              返回清单
            </button>
          </div>
        </div>
      </div>

      {isLoading && !hotspot && (
        <div className={cn(
          'rounded-[28px] border p-8',
          isLight ? 'border-slate-200 bg-white/92 text-slate-500' : 'border-white/10 bg-white/[0.04] text-slate-400'
        )}>
          正在读取项目详情与结构化字段…
        </div>
      )}

      {hotspot && (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <TenderFact label="预算金额" value={formatBudget(hotspot.tenderBudgetWan)} icon={WalletCards} strong themeMode={themeMode} />
            <TenderFact label="截止时间" value={getEffectiveDeadline(hotspot) ? formatDateTime(getEffectiveDeadline(hotspot)!) : '未披露'} icon={CalendarClock} strong themeMode={themeMode} />
            <TenderFact label="项目编号" value={hotspot.tenderProjectCode || '未披露'} icon={ClipboardCheck} themeMode={themeMode} />
            <TenderFact label="详情可信度" value={detailNarrative?.title || '待核验'} icon={ShieldCheck} themeMode={themeMode} />
          </section>

          <section className="grid gap-4 2xl:grid-cols-[1.15fr_0.85fr]">
            <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
              <div className="flex items-center justify-between gap-3">
                <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>跟进建议</h3>
                {recommendation && <span className={cn('rounded-full border px-2.5 py-1 text-xs', getBadgeTone(recommendation.tone, themeMode))}>{recommendation.label}</span>}
              </div>
              <p className={cn('mt-3 text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{getBidAction(hotspot)}</p>
              <p className={cn('mt-2 text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
                {recommendation?.summary || '建议先完成基础字段核验，再决定是否推进。'}
              </p>
              {detailNarrative && (
                <div className={cn('mt-4 rounded-[22px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{detailNarrative.title}</span>
                    {detailReliability && <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', getBadgeTone(detailReliability.tone, themeMode))}>{detailReliability.label}</span>}
                  </div>
                  <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{detailNarrative.description}</p>
                  <p className={cn('mt-3 text-sm font-medium leading-6', isLight ? 'text-slate-700' : 'text-slate-200')}>下一步：{detailNarrative.nextStep}</p>
                </div>
              )}
            </div>

            <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
              <div className="flex items-center justify-between gap-3">
                <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>字段完整度</h3>
                {completeness && <span className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{completeness.score}/100</span>}
              </div>
              <div className={cn('mt-4 h-3 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
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
              <p className={cn('mt-3 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>
                依据单位、预算、截止时间、项目编号、服务范围、资格要求、联系人等投标关键字段综合计算。
              </p>
            </div>
          </section>

          <section className="grid gap-4 2xl:grid-cols-2">
            <DetailFieldSection title="基础信息" subtitle="先确认这是不是我们真正要看的项目，再进入后续投标判断。" themeMode={themeMode}>
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                <DetailField label="地区 / 城市" value={region} icon={MapPin} themeMode={themeMode} />
                <DetailField label="招标 / 采购单位" value={hotspot.tenderUnit || '未披露'} icon={Building2} themeMode={themeMode} />
                <DetailField label="BIM 类型" value={hotspot.tenderType || '未分类'} icon={Gavel} themeMode={themeMode} />
                <DetailField label="公告阶段" value={stage?.label || hotspot.tenderNoticeType || '待判定'} icon={Layers3} themeMode={themeMode} />
                <DetailField label="发布时间" value={published} icon={ClipboardCheck} themeMode={themeMode} />
                <DetailField label="地点" value={hotspot.tenderAddress || '未披露'} icon={MapPin} themeMode={themeMode} />
              </div>
            </DetailFieldSection>

            <DetailFieldSection title="投标时间与窗口" subtitle="这里优先看报名、文件领取、投标截止和开标节点，决定是不是该立即推进。" themeMode={themeMode}>
              <div className="grid gap-3 md:grid-cols-2">
                <DetailField label="投标截止" value={getEffectiveDeadline(hotspot) ? formatDateTime(getEffectiveDeadline(hotspot)!) : '未披露'} icon={TimerReset} themeMode={themeMode} />
                <DetailField label="开标时间" value={hotspot.tenderBidOpenTime ? formatDateTime(hotspot.tenderBidOpenTime) : '未披露'} icon={CalendarClock} themeMode={themeMode} />
                <DetailField label="文件获取截止" value={hotspot.tenderDocDeadline ? formatDateTime(hotspot.tenderDocDeadline) : '未披露'} icon={CalendarClock} themeMode={themeMode} />
                <DetailField label="详情来源标签" value={detailReliability?.label || '待核验'} icon={ShieldCheck} themeMode={themeMode} />
              </div>
            </DetailFieldSection>
          </section>

          <section className="grid gap-4 2xl:grid-cols-2">
            <DetailFieldSection title="联系人与投标联络" subtitle="联系人、电话和邮箱优先用于判断是否值得立刻人工跟进。" themeMode={themeMode}>
              <div className="grid gap-3 md:grid-cols-2">
                <DetailField label="联系人" value={hotspot.tenderContact || '未披露'} icon={Building2} themeMode={themeMode} />
                <DetailField label="联系电话" value={hotspot.tenderPhone || '未披露'} icon={ClipboardCheck} themeMode={themeMode} />
                <DetailField label="邮箱" value={hotspot.tenderEmail || '未披露'} icon={Bell} themeMode={themeMode} />
                <DetailField label="项目编号" value={hotspot.tenderProjectCode || '未披露'} icon={ClipboardCheck} themeMode={themeMode} />
              </div>
            </DetailFieldSection>

            <DetailFieldSection title="服务范围与资质" subtitle="这块用来判断项目到底偏设计、施工还是全过程咨询，以及我们是否具备对应资质。" themeMode={themeMode}>
              <div className="grid gap-3">
                <DetailField label="服务范围" value={hotspot.tenderServiceScope || '未披露'} icon={Layers3} themeMode={themeMode} />
                <DetailField label="资格要求" value={hotspot.tenderQualification || '未披露'} icon={ShieldCheck} themeMode={themeMode} />
              </div>
            </DetailFieldSection>
          </section>

          <section className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
            <div className="flex items-center justify-between gap-3">
              <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>关键时间轴</h3>
              <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Timeline</span>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {timeline.map(item => (
                <div key={item.label} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#0f1425]')}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{item.label}</span>
                    <span className={cn('rounded-full border px-2 py-1 text-[11px]', getBadgeTone(item.tone, themeMode))}>
                      {item.date ? '已识别' : '未披露'}
                    </span>
                  </div>
                  <p className={cn('mt-3 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                    {item.date ? formatDateTime(item.date) : '当前公告未提取到该时间节点'}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 2xl:grid-cols-[1.2fr_0.8fr]">
            <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>公告正文摘要</h3>
                <span className={cn('rounded-full border px-2.5 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/5 text-slate-300')}>
                  相关性 {hotspot.relevance}
                </span>
              </div>
              <p className={cn('whitespace-pre-wrap text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
                {hotspot.summary || hotspot.content || '暂无正文内容'}
              </p>
            </div>

            <div className="space-y-4 2xl:sticky 2xl:top-24">
              <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
                <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>字段来源可信度</h3>
                {detailNarrative && (
                  <div className={cn('mt-4 rounded-[22px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
                    <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{detailNarrative.title}</p>
                    <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{detailNarrative.description}</p>
                    <p className={cn('mt-3 text-sm font-medium leading-6', isLight ? 'text-slate-700' : 'text-slate-200')}>{detailNarrative.nextStep}</p>
                  </div>
                )}
                <div className={cn('mt-4 space-y-3 text-sm', isLight ? 'text-slate-600' : 'text-slate-300')}>
                  <div className="flex items-center justify-between gap-3"><span>字段来源</span><span className={cn('max-w-[14rem] text-right break-all', isLight ? 'text-slate-900' : 'text-slate-100')}>{hotspot.tenderDetailSource || '未记录'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>提取时间</span><span className={cn('text-right', isLight ? 'text-slate-900' : 'text-slate-100')}>{extractedAt}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>监控词</span><span className={cn('text-right', isLight ? 'text-slate-900' : 'text-slate-100')}>{hotspot.keyword?.text || '临时搜索'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>详情链接</span><span className={cn('text-right', isLight ? 'text-slate-900' : 'text-slate-100')}>{detailReliability?.label || '待核验'}</span></div>
                </div>
              </div>

              <div className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
                <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>操作</h3>
                <div className="mt-4 space-y-3">
                  <a
                    href={hotspot.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-4 py-3 text-sm font-medium text-white shadow-[0_14px_34px_rgba(14,165,233,0.26)] transition hover:brightness-110"
                  >
                    打开原始公告 <ExternalLink className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => onNotifyFeishu(hotspot)}
                    disabled={!feishuWebhookEnabled || isNotifyingFeishu}
                    className={cn(
                      'inline-flex w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium transition',
                      feishuWebhookEnabled
                        ? (isLight
                          ? 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100'
                          : 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/15')
                        : (isLight
                          ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                          : 'cursor-not-allowed border-white/8 bg-white/[0.03] text-slate-500')
                    )}
                  >
                    {isNotifyingFeishu ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
                    {feishuWebhookEnabled ? (isNotifyingFeishu ? '正在推送飞书…' : '手动推送至飞书群') : '飞书群推送未启用'}
                  </button>
                  <div className={cn(
                    'rounded-2xl border p-4 text-sm leading-6',
                    isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
                  )}>
                    首页列表只展示预算、截止、单位、地区等关键字段；完整字段都在这里集中查看，方便投标初筛。
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
      <AnimatePresence>
        {showFloatingBack && (
          <motion.button
            type="button"
            onClick={onBack}
            initial={{ opacity: 0, scale: 0.86, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.86, y: 12 }}
            className={cn(
              'fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full border shadow-[0_18px_42px_rgba(0,0,0,0.28)] backdrop-blur-xl transition hover:scale-105 sm:bottom-8 sm:right-8',
              isLight
                ? 'border-cyan-200 bg-white/92 text-cyan-700 hover:bg-cyan-50'
                : 'border-cyan-300/20 bg-[#07111f]/88 text-cyan-100 hover:bg-cyan-400/12'
            )}
            aria-label="返回投标机会清单"
            title="返回清单"
          >
            <ChevronLeft className="h-5 w-5" />
          </motion.button>
        )}
      </AnimatePresence>
    </section>
  );
}

function HotspotCard({
  hotspot,
  onOpenDetail,
  searchText = '',
  themeMode = 'dark',
  selected = false,
  onToggleSelect,
  action,
}: {
  hotspot: Hotspot;
  onOpenDetail: (hotspot: Hotspot) => void;
  searchText?: string;
  themeMode?: ThemeMode;
  selected?: boolean;
  onToggleSelect?: (hotspotId: string) => void;
  action?: OpportunityAction;
}) {
  const deadline = getDeadlineInfo(getEffectiveDeadline(hotspot));
  const stage = getNoticeStage(hotspot);
  const detailReliability = getDetailReliability(hotspot);
  const rank = getOpportunityRank(hotspot);
  const region = [hotspot.tenderRegion, hotspot.tenderCity].filter(Boolean).join(' / ') || '未标注';
  const published = hotspot.publishedAt ? formatDateTime(hotspot.publishedAt) : '未披露';
  const aiInsight = getAIInsight(hotspot.relevanceReason);
  const isLight = themeMode === 'light';
  const highlightTone = isLight ? 'bg-amber-100 text-amber-800' : 'bg-amber-300/25 text-amber-50';
  const actionMeta = getOpportunityActionMeta(action, themeMode);
  const summaryText = getOpportunitySummary(hotspot);
  const priorityReason = getOpportunityPriorityReason(hotspot);

  return (
    <article className={cn(
      'group overflow-hidden rounded-[24px] border shadow-[0_18px_56px_rgba(0,0,0,0.22)] transition-all',
      selected
        ? (isLight ? 'border-cyan-300 bg-cyan-50/40' : 'border-cyan-300/35 bg-[#111729]')
        : (isLight ? 'border-slate-200 bg-white hover:border-cyan-300/35 hover:bg-slate-50' : 'border-white/10 bg-[#0d1020]/92 hover:border-cyan-300/20 hover:bg-[#111729]')
    )}>
      <div className={cn('border-b p-5', isLight ? 'border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(16,185,129,0.04),rgba(255,255,255,0.92))]' : 'border-white/8 bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(16,185,129,0.06),rgba(255,255,255,0.02))]')}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              {onToggleSelect && (
                <button
                  onClick={() => onToggleSelect(hotspot.id)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 transition',
                    selected
                      ? (isLight ? 'border-cyan-300 bg-cyan-100 text-cyan-700' : 'border-cyan-300/30 bg-cyan-500/12 text-cyan-100')
                      : (isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10')
                  )}
                >
                  <Check className="h-3 w-3" />
                  {selected ? '已选' : '选择'}
                </button>
              )}
              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getPlatformBadgeTone(themeMode))}>{hotspot.tenderPlatform || getSourceLabel(hotspot.source)}</span>
              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(rank.tone, themeMode))}>{rank.label}</span>
              {actionMeta && <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', actionMeta.tone)}>{actionMeta.label}</span>}
              {deadline.urgency === 'expired' && (
                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone('border-slate-400/20 bg-slate-500/12 text-slate-300', themeMode))}>已截止</span>
              )}
              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(stage.tone, themeMode))}>{stage.label}</span>
              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] tracking-[0.01em]', getBadgeTone(detailReliability.tone, themeMode))}>{detailReliability.label}</span>
            </div>
            <h3 className={cn('text-xl font-semibold leading-8', isLight ? 'text-slate-900 group-hover:text-cyan-700' : 'text-white group-hover:text-cyan-100')}>{renderHighlightedText(hotspot.title, searchText, highlightTone)}</h3>
            <div className={cn('mt-3 flex flex-wrap items-center gap-2 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
              <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4 text-cyan-300" />{region}</span>
              <span className="hidden text-slate-600 sm:inline">/</span>
              <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-emerald-300" />{renderHighlightedText(hotspot.tenderUnit || '单位待补全', searchText, highlightTone, 1)}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row xl:flex-col xl:items-end">
            <span className={cn('inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium', deadline.tone)}>
              <TimerReset className="h-4 w-4" />
              {deadline.label}
            </span>
            <button
              onClick={() => onOpenDetail(hotspot)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_34px_rgba(14,165,233,0.26)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            >
              查看详情 <ArrowRight className="h-4 w-4" />
            </button>
            <a
              href={hotspot.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
                isLight ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
              )}
            >
              原始公告 <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TenderFact label="预算金额" value={formatBudget(hotspot.tenderBudgetWan)} icon={WalletCards} strong themeMode={themeMode} />
          <TenderFact label="截止时间" value={getEffectiveDeadline(hotspot) ? formatDateTime(getEffectiveDeadline(hotspot)!) : '未披露'} icon={CalendarClock} strong={deadline.urgency === 'urgent'} themeMode={themeMode} />
          <TenderFact label="BIM 类型" value={hotspot.tenderType || '未分类'} icon={Gavel} themeMode={themeMode} />
          <TenderFact label="发布时间" value={published} icon={ClipboardCheck} themeMode={themeMode} />
        </div>

        <div className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.035]')}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">投标摘要</p>
            <div className="flex items-center gap-2 text-xs">
              <span className={cn('rounded-full border px-2.5 py-1', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>相关性 {hotspot.relevance}</span>
              <span className={cn('rounded-full border px-2.5 py-1', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>{hotspot.keyword?.text || '临时搜索'}</span>
            </div>
          </div>
          <p className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{getBidAction(hotspot)}</p>
          <p className={cn('mt-2 line-clamp-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-400')}>{renderHighlightedText(summaryText, searchText, highlightTone, 2)}</p>
          <p className={cn('mt-3 text-xs', isLight ? 'text-slate-500' : 'text-slate-500')}>排序依据：{priorityReason}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>来源：{getSourceLabel(hotspot.source)}</span>
            <span>入库：{relativeTime(hotspot.createdAt)}</span>
          </div>
        </div>

        {aiInsight && (
          <div className={cn(
            'rounded-2xl border p-3 text-sm',
            aiInsight.mode === 'fallback'
              ? (isLight ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-amber-300/15 bg-amber-400/[0.08] text-amber-100')
              : (isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-cyan-400/10 bg-cyan-500/[0.06] text-cyan-100')
          )}>
            <span className="font-medium">{aiInsight.label}：</span>
            {aiInsight.text}
          </div>
        )}
      </div>
    </article>
  );
}

function SourceHealthCard({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary) {
    return (
      <section className={cn('rounded-[28px] border p-5', isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]')}>
        <p className="text-sm text-slate-500">正在加载来源状态…</p>
      </section>
    );
  }

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>来源健康</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>区分未启用、空结果、请求失败、WAF 拦截和熔断冷却，避免把所有异常都混成待观察。</p>
        </div>
        <div className={cn('rounded-2xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
          {summary.runtimeConfig.tenderSources.length} / {summary.sourceHealth.length} 已启用
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {summary.sourceHealth.map(source => (
          <div key={source.id} className={cn('rounded-[24px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{getSourceLabel(source.id)}</p>
                <p className="mt-1 text-xs text-slate-500">{source.elapsedMs} ms</p>
              </div>
              <span className={cn('rounded-full border px-2.5 py-1 text-xs', getBadgeTone(getSourceStatusTone(source.status, source.ok, source.circuitOpen), themeMode))}>
                {source.statusLabel || (source.circuitOpen ? '熔断中' : source.ok ? '正常' : '待观察')}
              </span>
            </div>
            <div className={cn('mt-4 space-y-2 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
              <div className="flex items-center justify-between"><span>命中数量</span><span className={cn(isLight ? 'text-slate-900' : 'text-slate-200')}>{source.count}</span></div>
              <div className="flex items-center justify-between"><span>24h 探测失败</span><span className={cn(isLight ? 'text-slate-900' : 'text-slate-200')}>{summary.probeFailureSummary24h[source.id] || summary.failureSummary24h[source.id] || 0}</span></div>
              <div className="flex items-center justify-between"><span>24h 轮次异常</span><span className={cn(isLight ? 'text-slate-900' : 'text-slate-200')}>{summary.runFailureSummary24h[source.id] || 0}</span></div>
              <div className="flex items-center justify-between"><span>上次成功</span><span className={cn(isLight ? 'text-slate-900' : 'text-slate-200')}>{source.lastSuccessAt ? relativeTime(source.lastSuccessAt) : '暂无'}</span></div>
            </div>
            {source.probeQueries?.length ? (
              <p className="mt-3 line-clamp-2 text-[11px] leading-5 text-slate-500">
                探测词：{source.probeQueries.join(' / ')}
              </p>
            ) : null}
            {source.sampleTitle && <p className="mt-4 line-clamp-2 text-xs leading-5 text-slate-500">样例：{source.sampleTitle}</p>}
            {source.statusReason && (
              <p className={cn('mt-3 line-clamp-2 rounded-2xl border px-3 py-2 text-xs leading-5', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400')}>
                状态说明：{source.statusReason}
              </p>
            )}
            {(summary.failureReasons24h[source.id]?.length ?? 0) > 0 && (
              <div className={cn(
                'mt-3 rounded-2xl border px-3 py-3 text-xs',
                isLight ? 'border-amber-200 bg-amber-50/80 text-amber-800' : 'border-amber-400/15 bg-amber-500/8 text-amber-200/90'
              )}>
                <p className="mb-2 font-medium">最近失败原因</p>
                <div className="space-y-1.5">
                  {summary.failureReasons24h[source.id].map((item) => (
                    <div key={`${source.id}-${item.reason}`} className="flex items-center justify-between gap-3">
                      <span className="line-clamp-1">{item.reason}</span>
                      <span className="shrink-0">{item.count} 次</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {source.error && <p className={cn('mt-2 line-clamp-2 text-xs leading-5', isLight ? 'text-amber-700' : 'text-amber-200/80')}>最近错误：{source.error}</p>}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-6 text-slate-500">“24h 探测失败”统计的是 probe 级失败次数；“24h 轮次异常”统计的是同一轮抓取里该来源至少失败过一次的轮次数，更接近真实稳定性。</p>
    </section>
  );
}

function QualityMetric({
  title,
  value,
  caption,
  themeMode,
}: {
  title: string;
  value: string;
  caption: string;
  themeMode: ThemeMode;
}) {
  const isLight = themeMode === 'light';
  return (
    <div className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <p className={cn('mt-2 text-2xl font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{value}</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{caption}</p>
    </div>
  );
}

function QualityCoverageCard({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary) return null;

  const rows = [
    { label: '单位披露率', value: summary.quality.unitCoverage },
    { label: '预算披露率', value: summary.quality.budgetCoverage },
    { label: '截止披露率', value: summary.quality.deadlineCoverage },
    { label: '联系人披露率', value: summary.quality.contactCoverage },
    { label: '详情解析率', value: summary.quality.detailCoverage },
  ];

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>数据质量</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>直接看字段披露率，判断当前项目池能不能支撑投标决策。</p>
        </div>
        <div className={cn('rounded-2xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
          样本 {summary.quality.total} 条
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <QualityMetric title="高完整度" value={`${summary.quality.highCompletenessCount}`} caption="字段完整度 >= 60 的机会数" themeMode={themeMode} />
        <QualityMetric title="可跟进" value={`${summary.quality.activeCount}`} caption="未截止或未标注截止的机会数" themeMode={themeMode} />
        <QualityMetric title="已截止" value={`${summary.quality.expiredCount}`} caption="建议仅作归档观察" themeMode={themeMode} />
        <QualityMetric title="联系人披露" value={`${summary.quality.contactCount}`} caption={`联系电话披露率 ${summary.quality.phoneCoverage}%`} themeMode={themeMode} />
      </div>

      <div className="mt-5 space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className={cn(isLight ? 'text-slate-700' : 'text-slate-300')}>{row.label}</span>
              <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{row.value}%</span>
            </div>
            <div className={cn('h-2 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
              <div className="h-full rounded-full bg-[linear-gradient(90deg,#0ea5e9,#14b8a6)]" style={{ width: `${row.value}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AIQualityCard({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary?.ai) return null;

  const successRate = summary.ai.successRate;
  const fallbackRate = summary.ai.fallbackRate;
  const provider = summary.ai.providerStats?.[0];
  const latestLabel = summary.ai.latestAt ? relativeTime(summary.ai.latestAt) : '暂无任务记录';
  const formatElapsed = (value?: number) => {
    if (!value) return '暂无';
    if (value >= 1000) return `${Math.round(value / 1000)}s`;
    return `${value}ms`;
  };

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>AI 分析</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
            {summary.ai.source === 'logs' ? '基于真实任务日志统计 OpenClaw 耗时、成功和回退。' : '暂无新任务日志，暂按历史判断文案估算。'}
          </p>
        </div>
        <div className={cn('rounded-2xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
          近24h {summary.ai.total} 次
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <QualityMetric title="AI 成功率" value={`${successRate}%`} caption={`${summary.ai.successCount} 次直接返回`} themeMode={themeMode} />
        <QualityMetric title="规则回退率" value={`${fallbackRate}%`} caption={`${summary.ai.fallbackCount + (summary.ai.errorCount || 0)} 次兜底/异常`} themeMode={themeMode} />
        <QualityMetric title="平均耗时" value={formatElapsed(summary.ai.averageElapsedMs)} caption={`P95 ${formatElapsed(summary.ai.p95ElapsedMs)}`} themeMode={themeMode} />
        <QualityMetric title="最近分析" value={latestLabel} caption={provider ? `${provider.provider} · ${provider.total} 次` : '等待下一轮扫描'} themeMode={themeMode} />
      </div>

      <div className="mt-5 space-y-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className={cn(isLight ? 'text-slate-700' : 'text-slate-300')}>AI 成功</span>
            <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{successRate}%</span>
          </div>
          <div className={cn('h-2 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#22c55e,#14b8a6)]" style={{ width: `${successRate}%` }} />
          </div>
        </div>
        {summary.ai.providerStats && summary.ai.providerStats.length > 0 && (
          <div className={cn('grid gap-2 rounded-[18px] border p-3 text-xs sm:grid-cols-2', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/8 bg-[#0f1425] text-slate-300')}>
            {summary.ai.providerStats.slice(0, 4).map((item) => (
              <div key={item.provider} className="flex items-center justify-between gap-3">
                <span className="uppercase tracking-[0.16em]">{item.provider}</span>
                <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>
                  {item.successCount}/{item.total} 成功 · {formatElapsed(item.averageElapsedMs)}
                </span>
              </div>
            ))}
          </div>
        )}
        {summary.ai.fallbackReasons.length > 0 && (
          <div className={cn('rounded-[18px] border p-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/8 bg-[#0f1425] text-slate-300')}>
            {summary.ai.fallbackReasons.slice(0, 3).map((item) => (
              <div key={item.reason} className="flex items-center justify-between gap-3 py-1">
                <span>{item.reason}</span>
                <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{item.count} 条</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SourceQualityPanel({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary) return null;
  const trendBySource = new Map((summary.sourceQualityTrend || []).map((item) => [item.source, item]));

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5">
        <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>来源质量分布</h3>
        <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>看每个来源“有多少数据”和“数据够不够用”，比只看成功失败更接近业务价值。</p>
      </div>
      <div className="space-y-3">
        {summary.sourceQuality.map((item) => {
          const qualityMeta = getSourceQualityMeta(item.qualityGrade, item.qualityScore);
          const trend = trendBySource.get(item.source);
          const trendLabel = trend
            ? trend.direction === 'up'
              ? `近7天 +${trend.delta}`
              : trend.direction === 'down'
                ? `近7天 ${trend.delta}`
                : '近7天持平'
            : '暂无趋势';
          return (
          <div key={item.source} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{getSourceLabel(item.source)}</p>
                <p className="mt-1 text-xs text-slate-500">样本 {item.total} 条 · 质量分 {item.qualityScore} · 平均完整度 {item.avgCompleteness} · {trendLabel}</p>
              </div>
              <span className={cn('rounded-full border px-2.5 py-1 text-xs', getBadgeTone(qualityMeta.tone, themeMode))}>
                {qualityMeta.label}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {[
                ['单位', item.unitCoverage],
                ['预算', item.budgetCoverage],
                ['截止', item.deadlineCoverage],
                ['联系人', item.contactCoverage],
                ['详情', item.detailCoverage],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-500">{label}</span>
                    <span className={cn(isLight ? 'text-slate-900' : 'text-white')}>{value}%</span>
                  </div>
                  <div className={cn('h-1.5 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
                    <div className="h-full rounded-full bg-[linear-gradient(90deg,#22c55e,#14b8a6)]" style={{ width: `${value}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                可跟进 {item.activeCount} · 已截止 {item.expiredCount}
              </div>
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                高完整度 {item.highCompletenessCount} · 脏值 {item.dirtyIssueCount}
              </div>
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                缺预算 {item.missingCounts?.budget ?? 0} · 缺截止 {item.missingCounts?.deadline ?? 0}
              </div>
            </div>
            {item.repairHints?.length > 0 && (
              <div className={cn('mt-3 rounded-2xl border px-3 py-2 text-xs leading-6', isLight ? 'border-cyan-200 bg-cyan-50/70 text-cyan-800' : 'border-cyan-400/10 bg-cyan-500/8 text-cyan-100/85')}>
                修复口径：{item.repairHints.join('；')}
              </div>
            )}
            {item.dirtyIssues?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {item.dirtyIssues.slice(0, 3).map((issue) => (
                  <span key={`${item.source}-${issue.issue}`} className={cn('rounded-full border px-2.5 py-1 text-[11px]', getBadgeTone('text-orange-200 bg-orange-500/10 border-orange-400/20', themeMode))}>
                    {issue.issue} · {issue.count}
                  </span>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}

function SourceGovernancePanel({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary) return null;

  const governanceRows = summary.sourceQuality
    .map((item) => {
      const failure = summary.runFailureSummary24h[item.source] || 0;
      const score =
        (100 - item.qualityScore)
        + (100 - item.contactCoverage) * 0.35
        + (100 - item.budgetCoverage) * 0.25
        + item.dirtyIssueCount * 2
        + failure * 3;
      return {
        ...item,
        failure,
        score: Math.round(score),
      };
    })
    .sort((a, b) => b.score - a.score);

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5">
        <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>来源治理优先级</h3>
        <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>把“字段缺失”和“运行异常”放在一起看，帮助我们决定下一轮该先治哪个来源。</p>
      </div>
      <div className="space-y-3">
        {governanceRows.map((item, index) => (
          <div key={item.source} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>
                  {index + 1}. {getSourceLabel(item.source)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  治理指数 {item.score} · 轮次异常 {item.failure} · 质量分 {item.qualityScore} · 脏值 {item.dirtyIssueCount}
                </p>
              </div>
              <span className={cn('rounded-full border px-2.5 py-1 text-xs', getBadgeTone(index === 0 ? 'danger' : index === 1 ? 'warning' : 'default', themeMode))}>
                {index === 0 ? '优先治理' : index === 1 ? '次优先' : '观察'}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                预算覆盖 {item.budgetCoverage}%
              </div>
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                联系人覆盖 {item.contactCoverage}%
              </div>
              <div className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                截止覆盖 {item.deadlineCoverage}%
              </div>
            </div>
            {item.repairHints?.length > 0 && (
              <p className={cn('mt-3 rounded-xl border px-3 py-2 text-xs leading-6', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                建议：{item.repairHints.slice(0, 3).join('；')}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceAcceptancePanel({ summary, themeMode = 'dark' }: { summary: OpsSummary | null; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  if (!summary) return null;

  const newSources = summary.sourceAcceptance.filter((item) => !item.defaultSource);
  const candidates = summary.sourceCandidatePool || [];

  return (
    <section className={cn(
      'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>新源验收闸门</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>新数据源先过样本、字段、详情、失败分类和代理策略，再决定是否进入生产扫描。</p>
        </div>
        <span className={cn('rounded-full border px-3 py-1.5 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-400')}>
          {newSources.filter((item) => item.eligibleForProduction).length}/{newSources.length} 可入生产
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {newSources.map((item) => (
          <div key={item.source} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{getSourceLabel(item.source)}</p>
                <p className="mt-1 text-xs text-slate-500">验收 {item.passedCount}/{item.totalChecks} · {item.proxyPolicy.policy} · {item.deepCrawlStrategy.mode}</p>
              </div>
              <span className={cn('rounded-full border px-2.5 py-1 text-xs', getBadgeTone(item.eligibleForProduction ? 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20' : item.acceptanceScore >= 60 ? 'text-amber-200 bg-amber-500/10 border-amber-400/20' : 'text-red-200 bg-red-500/10 border-red-400/20', themeMode))}>
                {item.eligibleForProduction ? '可入生产' : item.acceptanceScore >= 60 ? '继续观察' : '暂缓'}
              </span>
            </div>
            <div className="mt-4 space-y-2">
              {item.checks.map((check) => (
                <div key={`${item.source}-${check.key}`} className={cn('rounded-xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.03] text-slate-300')}>
                  <div className="flex items-center justify-between gap-3">
                    <span>{check.label}</span>
                    <span className={check.ok ? 'text-emerald-400' : 'text-amber-400'}>{check.ok ? '通过' : '待补'}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-slate-500">{check.detail}</p>
                </div>
              ))}
            </div>
            <p className={cn('mt-3 rounded-xl border px-3 py-2 text-xs leading-6', isLight ? 'border-cyan-200 bg-cyan-50/70 text-cyan-800' : 'border-cyan-400/10 bg-cyan-500/8 text-cyan-100/85')}>
              下一步：{item.nextAction}
            </p>
          </div>
        ))}
      </div>

      <div className={cn('mt-4 rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.03]')}>
        <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>候选池</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {candidates.map((item) => (
            <div key={item.category} className={cn('rounded-xl border px-3 py-3 text-xs leading-6', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-[#101427] text-slate-300')}>
              <div className="flex items-center justify-between gap-3">
                <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{item.category}</span>
                <span>{item.priority}</span>
              </div>
              <p className="mt-2 text-slate-500">{item.examples.join(' / ')}</p>
              <p className="mt-2">{item.strategy}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HeaderProgress({
  progressValue,
  progressLabel,
  themeMode,
  queueRunning,
}: {
  progressValue: number;
  progressLabel: string | null;
  themeMode: ThemeMode;
  queueRunning: boolean;
}) {
  const isLight = themeMode === 'light';
  const showExplicitProgress = progressValue > 0 || Boolean(progressLabel);
  if (!showExplicitProgress && !queueRunning) return null;

  if (!showExplicitProgress) {
    return (
      <div className={cn(
        'min-w-[13rem] flex-1 rounded-[18px] border px-3 py-2 shadow-[0_10px_30px_rgba(15,23,42,0.08)]',
        isLight ? 'border-slate-200 bg-white/88' : 'border-white/10 bg-white/[0.04]'
      )}>
        <div className="flex items-center gap-2.5">
          <span className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full',
            isLight ? 'bg-cyan-50 text-cyan-600' : 'bg-cyan-500/10 text-cyan-200'
          )}>
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          </span>
          <p className={cn('min-w-0 truncate text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>
            后台队列运行中，结果会自动同步到主页
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'min-w-[13rem] flex-1 rounded-[18px] border px-3 py-2 shadow-[0_10px_30px_rgba(15,23,42,0.08)]',
      isLight ? 'border-slate-200 bg-white/88' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="flex items-center gap-2.5">
        <div className={cn('h-1.5 min-w-20 flex-1 overflow-hidden rounded-full', isLight ? 'bg-slate-100' : 'bg-white/8')}>
        <div
          className={cn(
            'h-full rounded-full bg-[linear-gradient(90deg,#0ea5e9,#14b8a6)] transition-all duration-500',
            progressValue < 100 && 'animate-pulse'
          )}
          style={{ width: `${Math.min(100, Math.max(progressValue, 8))}%` }}
        />
      </div>
      <p className={cn('min-w-0 truncate text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>
        {progressLabel || '刷新列表与分析数据'}
      </p>
    </div>
  </div>
  );
}

function OpportunityListSection({
  hotspots,
  summaryHotspots,
  filters,
  onFiltersChange,
  keywords,
  currentPage,
  totalPages,
  onPageChange,
  onOpenDetail,
  themeMode,
  isSearchDebouncing,
  searchSuggestions,
  recentSearches,
  onClearRecentSearches,
  savedViews,
  onSaveView,
  onApplyView,
  onDeleteView,
  selectedIds,
  onToggleSelect,
  onBatchAction,
  onClearSelection,
  actionsById,
}: {
  hotspots: Hotspot[];
  summaryHotspots: Hotspot[];
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  keywords: Keyword[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onOpenDetail: (hotspot: Hotspot) => void;
  themeMode: ThemeMode;
  isSearchDebouncing: boolean;
  searchSuggestions: string[];
  recentSearches: string[];
  onClearRecentSearches: () => void;
  savedViews: SavedFilterView[];
  onSaveView: () => void;
  onApplyView: (viewId: string) => void;
  onDeleteView: (viewId: string) => void;
  selectedIds: string[];
  onToggleSelect: (hotspotId: string) => void;
  onBatchAction: (action: OpportunityAction) => void;
  onClearSelection: () => void;
  actionsById: Record<string, OpportunityAction>;
}) {
  const goToPage = (page: number) => {
    if (page === currentPage) return;
    onPageChange(page);
  };

  const showHero = currentPage === 1;
  const isLight = themeMode === 'light';
  const [heroCollapsed, setHeroCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('bim-tender-opportunity-hero-collapsed') === 'true';
  });
  const viewMeta = useMemo(() => getOpportunityViewMeta(filters), [filters]);
  const stageSummary = useMemo(() => buildOpportunityStageSummary(summaryHotspots), [summaryHotspots]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('bim-tender-opportunity-hero-collapsed', heroCollapsed ? 'true' : 'false');
  }, [heroCollapsed]);

  const summaryCards = [
    {
      label: '正式可跟进',
      value: stageSummary.actionable,
      caption: '正式公告、资格预审、变更补遗',
      tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200',
      icon: ShieldCheck
    },
    {
      label: '前置信号',
      value: stageSummary.preSignal,
      caption: '采购意向、招标计划',
      tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200',
      icon: Radar
    },
    {
      label: '紧急窗口',
      value: stageSummary.urgent,
      caption: '7 天内需尽快核对',
      tone: 'border-red-400/20 bg-red-500/10 text-red-200',
      icon: AlertTriangle
    },
    {
      label: '高完整度',
      value: stageSummary.complete,
      caption: '字段足够直接判断',
      tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
      icon: Sparkles
    }
  ];

  return (
    <section className="space-y-4" id="opportunity-list">
      {selectedIds.length > 0 && (
        <div className={cn(
          'sticky top-[5.5rem] z-20 flex flex-wrap items-center justify-between gap-3 rounded-[20px] border px-4 py-3 shadow-[0_16px_48px_rgba(15,23,42,0.12)] backdrop-blur-xl',
          isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-[#0b1324]/88'
        )}>
          <div className="text-sm">
            <span className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>已选择 {selectedIds.length} 条</span>
            <span className={cn('ml-2 text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>可批量标记跟进、归档或忽略</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => onBatchAction('follow')} className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition', isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15')}>标记跟进</button>
            <button onClick={() => onBatchAction('archive')} className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition', isLight ? 'border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200' : 'border-slate-400/15 bg-slate-500/10 text-slate-300 hover:bg-slate-500/15')}>归档</button>
            <button onClick={() => onBatchAction('ignore')} className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition', isLight ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100' : 'border-amber-300/25 bg-amber-400/12 text-amber-200 hover:bg-amber-400/16')}>忽略</button>
            <button onClick={onClearSelection} className={cn('rounded-full border px-3 py-1.5 text-xs transition', isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10')}>取消选择</button>
          </div>
        </div>
      )}

      {showHero ? (
        <div className={cn(
          'overflow-visible rounded-[34px] border p-6 shadow-[0_28px_110px_rgba(0,0,0,0.34)]',
          isLight
            ? 'border-cyan-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(255,255,255,0.96)_48%,rgba(20,184,166,0.08))]'
            : 'border-cyan-300/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.18),rgba(15,23,42,0.9)_48%,rgba(20,184,166,0.12))]'
        )}>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-4xl">
                <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/75">Opportunity Pipeline</p>
                <h2 className={cn('mt-3 text-4xl font-semibold tracking-tight sm:text-5xl', isLight ? 'text-slate-900' : 'text-white')}>投标机会清单</h2>
                <p className={cn('mt-4 max-w-3xl text-base leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
                  以招标决策字段为核心：单位、地区、预算、截止时间、公告阶段、详情可靠性。
                </p>
              </div>
              <button
                onClick={() => setHeroCollapsed((prev) => !prev)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition',
                  isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                )}
              >
                <ChevronDown className={cn('h-4 w-4 transition-transform', heroCollapsed && '-rotate-90')} />
                {heroCollapsed ? '展开概览与筛选' : '收起概览与筛选'}
              </button>
            </div>

            {!heroCollapsed ? (
              <>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {summaryCards.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.label}
                        className={cn(
                          'rounded-[24px] border p-4 shadow-[0_16px_48px_rgba(15,23,42,0.08)]',
                          getBadgeTone(item.tone, themeMode),
                          isLight && 'bg-white/88'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[11px] uppercase tracking-[0.2em]">{item.label}</p>
                            <p className={cn('mt-3 text-3xl font-semibold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>{item.value}</p>
                            <p className={cn('mt-2 text-xs leading-5', isLight ? 'text-slate-500' : 'text-slate-300/80')}>{item.caption}</p>
                          </div>
                          <div className={cn('rounded-2xl border p-2.5', getBadgeTone(item.tone, themeMode))}>
                            <Icon className="h-4 w-4" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className={cn(
                  'rounded-[26px] border px-5 py-4 shadow-[0_16px_48px_rgba(15,23,42,0.08)]',
                  isLight ? 'border-slate-200 bg-white/88' : 'border-white/10 bg-[#0d1325]/78'
                )}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">当前视图</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', getBadgeTone(viewMeta.tone, themeMode))}>{viewMeta.label}</span>
                        {filters.searchText && (
                          <span className={cn('rounded-full border px-3 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>
                            搜索：{filters.searchText}
                          </span>
                        )}
                      </div>
                      <p className={cn('mt-3 max-w-3xl text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>{viewMeta.description}</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className={cn('rounded-2xl border px-3 py-2 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-300')}>
                        当前页：{currentPage} / {totalPages}
                      </div>
                      <div className={cn('rounded-2xl border px-3 py-2 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-300')}>
                        已加载样本：{summaryHotspots.length} 条
                      </div>
                    </div>
                  </div>
                </div>
                <div className="w-full">
                  <FilterSortBar
                    filters={filters}
                    onChange={onFiltersChange}
                    keywords={keywords}
                    themeMode={themeMode}
                    isSearchDebouncing={isSearchDebouncing}
                    searchSuggestions={searchSuggestions}
                    recentSearches={recentSearches}
                    onClearRecentSearches={onClearRecentSearches}
                    onSelectSearch={(value) => onFiltersChange({ ...filters, searchText: value })}
                    savedViews={savedViews}
                    onSaveView={onSaveView}
                    onApplyView={onApplyView}
                    onDeleteView={onDeleteView}
                    collapseStorageKey="bim-tender-opportunity-filter-collapsed"
                  />
                </div>
              </>
            ) : (
              <div className={cn(
                'rounded-[24px] border px-4 py-3 shadow-[0_16px_48px_rgba(15,23,42,0.08)]',
                isLight ? 'border-slate-200 bg-white/88' : 'border-white/10 bg-[#0d1325]/78'
              )}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', getBadgeTone(viewMeta.tone, themeMode))}>{viewMeta.label}</span>
                  <span className={cn('rounded-full border px-3 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>正式可跟进 {stageSummary.actionable}</span>
                  <span className={cn('rounded-full border px-3 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>前置信号 {stageSummary.preSignal}</span>
                  <span className={cn('rounded-full border px-3 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>紧急窗口 {stageSummary.urgent}</span>
                  <span className={cn('rounded-full border px-3 py-1 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>已加载 {summaryHotspots.length}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={cn(
          'rounded-[24px] border p-4 shadow-[0_18px_60px_rgba(0,0,0,0.2)]',
          isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.035]'
        )}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-300/70">Opportunity Pipeline</p>
              <h2 className={cn('mt-1 text-xl font-semibold', isLight ? 'text-slate-900' : 'text-white')}>投标机会清单</h2>
              <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-500' : 'text-slate-400')}>{viewMeta.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', getBadgeTone(viewMeta.tone, themeMode))}>{viewMeta.label}</span>
              <span className={cn(
                'rounded-full border px-3 py-1 text-xs',
                isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300'
              )}>
                第 {currentPage} / {totalPages} 页
              </span>
            </div>
          </div>
          <FilterSortBar
            filters={filters}
            onChange={onFiltersChange}
            keywords={keywords}
            themeMode={themeMode}
            isSearchDebouncing={isSearchDebouncing}
            searchSuggestions={searchSuggestions}
            recentSearches={recentSearches}
            onClearRecentSearches={onClearRecentSearches}
            onSelectSearch={(value) => onFiltersChange({ ...filters, searchText: value })}
            savedViews={savedViews}
            onSaveView={onSaveView}
            onApplyView={onApplyView}
            onDeleteView={onDeleteView}
            collapseStorageKey="bim-tender-opportunity-filter-collapsed"
          />
        </div>
      )}

      <div className="space-y-3.5">
        {hotspots.map(item => (
          <HotspotCard
            key={item.id}
            hotspot={item}
            onOpenDetail={onOpenDetail}
            searchText={filters.searchText}
            themeMode={themeMode}
            selected={selectedIds.includes(item.id)}
            onToggleSelect={onToggleSelect}
            action={actionsById[item.id]}
          />
        ))}
        {hotspots.length === 0 && (
          <div className={cn(
            'rounded-[28px] border border-dashed p-10 text-center shadow-[0_16px_48px_rgba(15,23,42,0.08)]',
            isLight ? 'border-slate-200 bg-white text-slate-500' : 'border-white/10 bg-white/[0.03] text-slate-500'
          )}>
            当前筛选条件下暂无投标机会，可以放宽地区 / 预算 / 时间筛选试试。
          </div>
        )}
      </div>

      <div className={cn(
        'flex items-center justify-between gap-4 rounded-[20px] border px-4 py-3 text-sm shadow-[0_14px_40px_rgba(15,23,42,0.08)]',
        isLight ? 'border-slate-200 bg-white text-slate-500' : 'border-white/8 bg-white/[0.03] text-slate-400'
      )}>
        <div className="flex items-center gap-3">
          <span>第 {currentPage} / {totalPages} 页</span>
          <span className={cn(
            'rounded-full border px-2.5 py-1 text-xs',
            isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300'
          )}>
            每页 4 条
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className={cn(
              'relative z-10 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 transition disabled:cursor-not-allowed disabled:opacity-40',
              isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent' : 'border-white/10 bg-white/5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent'
            )}
          >
            <ChevronLeft className="h-4 w-4" /> 上一页
          </button>
          <button
            onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            className={cn(
              'relative z-10 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 transition disabled:cursor-not-allowed disabled:opacity-40',
              isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent' : 'border-white/10 bg-white/5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent'
            )}
          >
            下一页 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

function RunsPanel({ runs, themeMode = 'dark' }: { runs: CrawlRun[]; themeMode?: ThemeMode }) {
  const isLight = themeMode === 'light';
  return (
    <section className={cn(
      'rounded-[28px] border p-5 shadow-[0_20px_80px_rgba(0,0,0,0.24)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
    )}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>最近扫描</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>看哪一轮有命中、哪一轮只是跑空，不需要再靠日志盲猜。</p>
        </div>
        <div className={cn('rounded-2xl border px-3 py-2 text-xs', isLight ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
          近 {runs.length} 次
        </div>
      </div>

      <div className="space-y-3">
        {runs.map(run => (
          <div key={run.id} className={cn('rounded-[24px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#0f1425]')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className={cn('font-medium', isLight ? 'text-slate-900' : 'text-white')}>{run.keywordText || '未命名关键词'}</p>
                <p className="mt-1 text-xs text-slate-500">{formatDateTime(run.startedAt)} · {run.status}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={cn('rounded-full border px-2.5 py-1', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>raw {run.totalRaw}</span>
                <span className={cn('rounded-full border px-2.5 py-1', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>fresh {run.totalFresh}</span>
                <span className={cn('rounded-full border px-2.5 py-1', getBadgeTone('border-emerald-400/20 bg-emerald-500/10 text-emerald-200', themeMode))}>saved {run.totalSaved}</span>
                <span className={cn('rounded-full border px-2.5 py-1', getBadgeTone('border-amber-400/20 bg-amber-500/10 text-amber-200', themeMode))}>filtered {run.totalFiltered}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MonitorLogPanel({ summary, health, themeMode }: { summary: OpsSummary | null; health: HealthStatus | null; themeMode: ThemeMode }) {
  const latestRun = summary?.latestRun || null;
  const queueRunning = health?.hotspotCheckQueue.running || false;
  const activeDetailIds = health?.detailEnrichmentQueue.currentHotspotIds || [];
  const detailWorkerCount = activeDetailIds.length;
  const isLight = themeMode === 'light';
  const healthTone = health?.status === 'ok'
    ? (isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200')
    : (isLight ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-400/20 bg-amber-500/10 text-amber-200');

  const statusRows = [
    {
      label: '后端健康',
      value: health?.status === 'ok' ? '正常' : '待检查',
      tone: healthTone,
    },
    {
      label: '自动扫描',
      value: health?.scheduler?.description || '未读取',
      tone: isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/5 text-slate-200',
    },
    {
      label: '最近启动',
      value: health?.hotspotCheckQueue.lastStartedAt ? relativeTime(health.hotspotCheckQueue.lastStartedAt) : '暂无',
      tone: isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/5 text-slate-200',
    },
    {
      label: '最近完成',
      value: health?.hotspotCheckQueue.lastFinishedAt ? relativeTime(health.hotspotCheckQueue.lastFinishedAt) : '暂无',
      tone: isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/5 text-slate-200',
    },
    {
      label: '历史样本',
      value: `${summary?.stats.legacyHotspots ?? 0} 条`,
      tone: isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/5 text-slate-200',
    },
  ];
  const totalProbeFailures = summary ? Object.values(summary.probeFailureSummary24h || summary.failureSummary24h || {}).reduce((acc, value) => acc + value, 0) : 0;
  const totalRunFailures = summary ? Object.values(summary.runFailureSummary24h || {}).reduce((acc, value) => acc + value, 0) : 0;
  const proxyPool = summary?.proxyPool || [];
  const proxyAlerts = summary?.proxyAlerts || [];
  const healthyProxyCount = proxyPool.filter((item) => item.probeOk).length;
  const topFailureReasons = summary
    ? Object.entries(summary.failureReasons24h || {})
        .flatMap(([sourceId, items]) => items.map((item) => ({ sourceId, ...item })))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
    : [];

  return (
    <section className={cn(
      'rounded-[24px] border px-4 py-4 shadow-[0_20px_80px_rgba(0,0,0,0.18)]',
      isLight ? 'border-slate-200 bg-white/92' : 'border-white/8 bg-white/[0.03]'
    )}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className={cn('text-lg font-semibold', isLight ? 'text-slate-900' : 'text-white')}>监控日志</h3>
          <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
            实时看抓取状态、入库结果、飞书链路和服务健康。
          </p>
        </div>
        <span className={cn(
          'rounded-full border px-3 py-1 text-xs',
          queueRunning
            ? (isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-700' : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200')
            : (isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200')
        )}>
          {queueRunning ? '扫描中' : latestRun?.status || '空闲'}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {statusRows.map((item) => (
          <div key={item.label} className={cn('rounded-[18px] border px-3 py-3', item.tone)}>
            <p className="text-[11px] uppercase tracking-[0.22em] opacity-70">{item.label}</p>
            <p className="mt-2 text-sm font-medium">{item.value}</p>
          </div>
        ))}
      </div>

      <div className={cn(
        'mt-3 rounded-[20px] border p-4 text-sm',
        isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/8 bg-[#0f1425] text-slate-200'
      )}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>最近抓取</span><span>{latestRun?.startedAt ? relativeTime(latestRun.startedAt) : '暂无记录'}</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>最近入库</span><span>{latestRun ? `${latestRun.totalSaved} 条` : '暂无'}</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>原始抓取</span><span>{latestRun ? `${latestRun.totalRaw} 条` : '暂无'}</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>去重后</span><span>{latestRun ? `${latestRun.totalUnique} 条` : '暂无'}</span></div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>飞书群推送</span><span>{health?.integrations.feishuWebhookEnabled ? '已启用' : '未启用'}</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>多维表同步</span><span>{health?.integrations.feishuBitableEnabled ? '已启用' : '未启用'}</span></div>
            <div className="flex items-center justify-between gap-3">
              <span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>详情补全队列</span>
              <span>
                {health?.detailEnrichmentQueue.running
                  ? `并行 ${detailWorkerCount || 1} 个 · 待处理 ${health.detailEnrichmentQueue.pendingCount}`
                  : '空闲'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>本轮补全</span><span>{health?.detailEnrichmentQueue.processedCount ?? 0} 条</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>健康心跳</span><span>{health?.timestamp ? relativeTime(health.timestamp) : '暂无'}</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>24h 探测失败</span><span>{totalProbeFailures} 次</span></div>
            <div className="flex items-center justify-between gap-3"><span className={cn(isLight ? 'text-slate-500' : 'text-slate-400')}>24h 轮次异常</span><span>{totalRunFailures} 轮</span></div>
          </div>
        </div>
      </div>

      <div className={cn(
        'mt-3 rounded-[20px] border p-4 text-xs leading-6',
        isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
      )}>
        {latestRun
          ? `最近一轮扫描原始抓取 ${latestRun.totalRaw} 条，去重后 ${latestRun.totalUnique} 条，最终入库 ${latestRun.totalSaved} 条。当前监控源样本 ${summary?.stats.monitoredHotspots ?? summary?.stats.totalHotspots ?? 0} 条，旧版历史样本 ${summary?.stats.legacyHotspots ?? 0} 条。${health?.hotspotCheckQueue.lastError ? `最近错误：${health.hotspotCheckQueue.lastError}` : '当前未发现新的队列错误。'}`
          : '系统正在等待下一轮抓取。这里会持续刷新最近一次抓取、飞书投递和后端健康状态。'}
      </div>

      {topFailureReasons.length > 0 && (
        <div className={cn(
          'mt-3 rounded-[20px] border p-4 text-xs leading-6',
          isLight ? 'border-amber-200 bg-amber-50/70 text-amber-800' : 'border-amber-400/10 bg-amber-500/8 text-amber-100/85'
        )}>
          <p className="mb-2 font-medium">最近主要失败原因</p>
          <div className="space-y-1.5">
            {topFailureReasons.map((item) => (
              <div key={`${item.sourceId}-${item.reason}`} className="flex items-center justify-between gap-3">
                <span>{getSourceLabel(item.sourceId)} · {item.reason}</span>
                <span className="shrink-0">{item.count} 次</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {proxyAlerts.length > 0 && (
        <div className={cn(
          'mt-3 rounded-[20px] border p-4 text-xs leading-6',
          isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-300'
        )}>
          <p className="mb-3 font-medium">代理告警</p>
          <div className="space-y-2.5">
            {proxyAlerts.map((item) => (
              <div key={`${item.id}-${item.category}`} className={cn(
                'rounded-[16px] border px-3 py-3',
                isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#0f1425]'
              )}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className={cn('text-sm font-medium', isLight ? 'text-slate-900' : 'text-white')}>{item.id}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{item.detail}</p>
                    {item.thresholdTriggered && item.consecutiveFailureStreak != null && item.alertThreshold != null && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        连续异常 {item.consecutiveFailureStreak}/{item.alertThreshold}
                        {item.thresholdTriggeredAt ? ` · ${relativeTime(item.thresholdTriggeredAt)} 触发` : ''}
                      </p>
                    )}
                  </div>
                  <span className={cn('shrink-0 rounded-full border px-2.5 py-1 text-[11px]', getProxyAlertTone(item.severity, themeMode))}>
                    {item.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={cn(
        'mt-3 rounded-[20px] border p-4 text-xs leading-6',
        isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
      )}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="font-medium">代理池</p>
          <span className={cn(
            'rounded-full border px-2.5 py-1',
            getBadgeTone(healthyProxyCount === proxyPool.length && proxyPool.length > 0
              ? 'text-emerald-200 bg-emerald-500/10 border-emerald-400/20'
              : healthyProxyCount > 0
                ? 'text-amber-200 bg-amber-500/10 border-amber-400/20'
                : 'text-red-200 bg-red-500/10 border-red-400/20', themeMode)
          )}>
            {proxyPool.length > 0 ? `${healthyProxyCount}/${proxyPool.length} 健康` : '未配置'}
          </span>
        </div>
        {proxyPool.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {proxyPool.map((item) => (
              <div
                key={item.id}
                className={cn(
                  'min-w-0 rounded-[22px] border p-4',
                  isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#0f1425]'
                )}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <p className={cn('text-xl font-semibold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>{item.id}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{item.host}:{item.port}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <span className={cn('whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]', getBadgeTone(getProxyStatusTone(item.probeStatus, item.probeOk), themeMode))}>
                      {item.probeStatusLabel}
                    </span>
                    {item.thresholdTriggered && (
                      <span className={cn(
                        'whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]',
                        getBadgeTone('border-red-400/20 bg-red-500/10 text-red-200', themeMode)
                      )}>
                        连续异常已越线
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <ProxyFact label="出口 IP" value={item.publicIp || '未返回'} themeMode={themeMode} />
                  <ProxyFact
                    label="隧道状态"
                    value={`${item.tunnelStatusLabel || '待探测'}${item.tunnelLatencyMs != null ? ` · ${item.tunnelLatencyMs} ms` : ''}`}
                    themeMode={themeMode}
                  />
                  <ProxyFact
                    label="主动探测"
                    value={item.lastProbeAt ? `${relativeTime(item.lastProbeAt)}${item.lastProbeLatencyMs != null ? ` · ${item.lastProbeLatencyMs} ms` : ''}` : '暂无'}
                    themeMode={themeMode}
                  />
                  <ProxyFact label="当前路由" value={item.routingModeLabel} themeMode={themeMode} />
                  <ProxyFact label="实战成功" value={item.lastSuccessAt ? relativeTime(item.lastSuccessAt) : '暂无'} themeMode={themeMode} />
                  <ProxyFact
                    label="失败统计"
                    value={`硬失败 ${item.failureCount} 次 · 软失败 ${item.softFailureCount} 次`}
                    themeMode={themeMode}
                  />
                  <ProxyFact label="连续失败" value={`${item.consecutiveFailures} 次`} themeMode={themeMode} />
                  <ProxyFact
                    label="同类连续异常"
                    value={`${item.consecutiveFailureStreak}/${item.alertThreshold}${item.consecutiveFailureLabel ? ` · ${item.consecutiveFailureLabel}` : ''}`}
                    themeMode={themeMode}
                  />
                  <div className="sm:col-span-2">
                    <ProxyFact label="适用来源" value={formatProxySources(item.sources)} themeMode={themeMode} />
                  </div>
                </div>

                {item.thresholdTriggered && (
                  <p className={cn(
                    'mt-3 rounded-xl border px-3 py-2 text-[11px] leading-5',
                    isLight ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-400/15 bg-red-500/10 text-red-200'
                  )}>
                    连续 {item.consecutiveFailureStreak} 次 {item.consecutiveFailureLabel || item.probeStatusLabel} 已达到阈值 {item.alertThreshold}
                    {item.thresholdTriggeredAt ? ` · ${relativeTime(item.thresholdTriggeredAt)} 触发告警` : ''}
                  </p>
                )}

                {item.coolingDown && (
                  <p className={cn(
                    'mt-3 rounded-xl border px-3 py-2 text-[11px] leading-5',
                    isLight ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-400/15 bg-amber-500/10 text-amber-200'
                  )}>
                    熔断冷却中，剩余约 {Math.ceil(item.cooldownRemainingMs / 1000)} 秒
                  </p>
                )}

                {item.lastProbeError && (
                  <p
                    className={cn(
                      'mt-3 rounded-xl border px-3 py-2 text-[11px] leading-5',
                      isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
                    )}
                    title={item.lastProbeAt ? `${formatDateTime(item.lastProbeAt)} · ${item.probeUrl || '未记录探测地址'}` : item.probeUrl || undefined}
                  >
                    主动探测：{item.lastProbeError}
                    {item.lastProbeStatusCode ? ` · HTTP ${item.lastProbeStatusCode}` : ''}
                  </p>
                )}

                {item.lastFailureLabel && (
                  <p
                    className={cn(
                      'mt-2 rounded-xl border px-3 py-2 text-[11px] leading-5',
                      isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
                    )}
                    title={item.lastFailureAt ? formatDateTime(item.lastFailureAt) : undefined}
                  >
                    最近失败分类：{item.lastFailureLabel}
                    {item.lastFailureSeverity ? ` · ${item.lastFailureSeverity === 'hard' ? '硬故障' : item.lastFailureSeverity === 'degraded' ? '降级故障' : '软故障'}` : ''}
                  </p>
                )}

                {item.lastError && (
                  <p
                    className={cn(
                      'mt-2 rounded-xl border px-3 py-2 text-[11px] leading-5',
                      isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/8 bg-white/[0.035] text-slate-400'
                    )}
                    title={item.lastFailureAt ? formatDateTime(item.lastFailureAt) : undefined}
                  >
                    抓取链路最近错误：{item.lastError}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p>当前未配置多出口代理，默认使用主机本机出口。</p>
        )}
      </div>
    </section>
  );
}

type LoginScreenProps = {
  isSubmitting: boolean;
  errorMessage: string | null;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
};

function LoginScreen({ isSubmitting, errorMessage, onSubmit }: LoginScreenProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  return (
    <div className="min-h-screen bg-[#07111f] text-white">
      <BackgroundBeams className="opacity-60" />
      <Spotlight className="-top-32 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2" fill="#0ea5e9" />
      <div className="pointer-events-none fixed inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(7,17,31,0.96),rgba(7,17,31,0))]" />
      <div className="pointer-events-none fixed right-[-120px] top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="pointer-events-none fixed bottom-0 left-[-120px] h-72 w-72 rounded-full bg-amber-300/10 blur-3xl" />

      <main className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md rounded-[32px] border border-white/10 bg-[#0b1324]/92 p-8 shadow-[0_28px_90px_rgba(0,0,0,0.35)] backdrop-blur-2xl"
        >
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-[20px] border border-cyan-300/20 bg-[linear-gradient(135deg,rgba(34,211,238,0.22),rgba(251,191,36,0.12))] shadow-[0_16px_40px_rgba(14,165,233,0.18)]">
              <LockKeyhole className="h-7 w-7 text-cyan-200" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/75">Protected Access</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">登录 BIM 招采监控台</h1>
            </div>
          </div>

          <p className="mt-5 text-sm leading-7 text-slate-300">
            我们已经把前端和 API 都加上了会话校验。现在访问域名时，需要先登录，避免任何人直接看到招采数据、运维状态和后端配置。
          </p>

          <form className="mt-8 space-y-4" onSubmit={onSubmit}>
            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-sm text-slate-300">
                <UserRound className="h-4 w-4 text-cyan-200" />
                用户名
              </span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/50 focus:bg-white/[0.08]"
                placeholder="请输入用户名"
                name="username"
              />
            </label>

            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-sm text-slate-300">
                <LockKeyhole className="h-4 w-4 text-cyan-200" />
                密码
              </span>
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                type="password"
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/50 focus:bg-white/[0.08]"
                placeholder="请输入密码"
                name="password"
              />
            </label>

            {errorMessage && (
              <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-5 py-3 text-sm font-medium text-white shadow-[0_16px_40px_rgba(14,165,233,0.35)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-80"
            >
              <ShieldCheck className={cn('h-4 w-4', isSubmitting && 'animate-pulse')} />
              {isSubmitting ? '登录中…' : '进入监控台'}
            </button>
          </form>

          <div className="mt-6 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs leading-6 text-slate-400">
            当前是基础访问保护版本。后续如果我们切到 HTTPS，可以再把登录 Cookie 升级为 `Secure`，进一步收紧会话安全。
          </div>
        </motion.div>
      </main>
    </div>
  );
}

type DashboardAppProps = {
  authUser: string;
  onLogout: () => Promise<void>;
};

function DashboardApp({ authUser, onLogout }: DashboardAppProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('opportunities');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = window.localStorage.getItem('bim-tender-theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [analyticsHotspots, setAnalyticsHotspots] = useState<Hotspot[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [opsSummary, setOpsSummary] = useState<OpsSummary | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [dailyReports, setDailyReports] = useState<DailyReport[]>([]);
  const [dailyKeywords, setDailyKeywords] = useState<DailyKeyword[]>([]);
  const [dailyArticles, setDailyArticles] = useState<DailyArticle[]>([]);
  const [dailyHealth, setDailyHealth] = useState<DailyHealthStatus | null>(null);
  const [selectedDailyReport, setSelectedDailyReport] = useState<DailyReport | null>(null);
  const [selectedDailyReportId, setSelectedDailyReportId] = useState('');
  const [selectedDailySource, setSelectedDailySource] = useState('');
  const [selectedDailyKeyword, setSelectedDailyKeyword] = useState('');
  const [isDailyLoading, setIsDailyLoading] = useState(false);
  const [isDailyRunning, setIsDailyRunning] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Hotspot[]>([]);
  const [dashboardFilters, setDashboardFilters] = useState<FilterState>({ ...defaultFilterState });
  const [searchFilters, setSearchFilters] = useState<FilterState>({ ...defaultFilterState });
  const [dashboardRecentSearches, setDashboardRecentSearches] = useState<string[]>(() => readStoredStringArray(DASHBOARD_RECENT_SEARCH_KEY));
  const [manualRecentSearches, setManualRecentSearches] = useState<string[]>(() => readStoredStringArray(MANUAL_RECENT_SEARCH_KEY));
  const [savedFilterViews, setSavedFilterViews] = useState<SavedFilterView[]>(() => readSavedFilterViews());
  const [opportunityActions, setOpportunityActions] = useState<Record<string, OpportunityAction>>(() => readOpportunityActions());
  const [selectedOpportunityIds, setSelectedOpportunityIds] = useState<string[]>([]);
  const [pushingFeishuId, setPushingFeishuId] = useState<string | null>(null);
  const [debouncedDashboardSearchText, setDebouncedDashboardSearchText] = useState('');
  const [isSearchDebouncing, setIsSearchDebouncing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const opportunityPageSize = 4;
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [heroProgress, setHeroProgress] = useState(0);
  const [heroProgressLabel, setHeroProgressLabel] = useState<string | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [selectedHotspot, setSelectedHotspot] = useState<Hotspot | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const heroProgressRunRef = useRef(0);
  const appVersion = healthStatus?.version || '读取中';

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const beginHeroProgress = useCallback((label: string) => {
    heroProgressRunRef.current += 1;
    setHeroProgressLabel(label);
    setHeroProgress(12);
    return heroProgressRunRef.current;
  }, []);

  const advanceHeroProgress = useCallback((value: number, runId?: number) => {
    if (runId != null && runId !== heroProgressRunRef.current) return;
    setHeroProgress((prev) => Math.max(prev, value));
  }, []);

  const clearHeroProgress = useCallback((runId?: number) => {
    if (runId != null && runId !== heroProgressRunRef.current) return;
    setHeroProgress(0);
    setHeroProgressLabel(null);
  }, []);

  const finishHeroProgress = useCallback((runId?: number) => {
    if (runId != null && runId !== heroProgressRunRef.current) return;
    setHeroProgress(100);
    window.setTimeout(() => {
      if (runId != null && runId !== heroProgressRunRef.current) return;
      clearHeroProgress(runId);
    }, 450);
  }, [clearHeroProgress]);

  useEffect(() => {
    document.body.dataset.theme = themeMode;
    window.localStorage.setItem('bim-tender-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    writeStoredStringArray(DASHBOARD_RECENT_SEARCH_KEY, dashboardRecentSearches);
  }, [dashboardRecentSearches]);

  useEffect(() => {
    writeStoredStringArray(MANUAL_RECENT_SEARCH_KEY, manualRecentSearches);
  }, [manualRecentSearches]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SAVED_FILTER_VIEWS_KEY, JSON.stringify(savedFilterViews));
  }, [savedFilterViews]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(OPPORTUNITY_ACTIONS_KEY, JSON.stringify(opportunityActions));
  }, [opportunityActions]);

  useEffect(() => {
    const trimmed = dashboardFilters.searchText.trim();
    setIsSearchDebouncing(Boolean(trimmed));
    const timer = window.setTimeout(() => {
      setDebouncedDashboardSearchText(trimmed);
      setIsSearchDebouncing(false);
    }, 380);
    return () => window.clearTimeout(timer);
  }, [dashboardFilters.searchText]);

  useEffect(() => {
    if (!debouncedDashboardSearchText) return;
    setDashboardRecentSearches((prev) => rememberSearchTerm(prev, debouncedDashboardSearchText));
  }, [debouncedDashboardSearchText]);

  const buildDashboardParams = useCallback((page: number, limit: number) => {
    const params: Record<string, string | number> = { page, limit };
    if (debouncedDashboardSearchText) params.searchText = debouncedDashboardSearchText;
    if (dashboardFilters.searchMode) params.searchMode = dashboardFilters.searchMode;
    if (dashboardFilters.includeExpired) params.includeExpired = dashboardFilters.includeExpired;
    if (dashboardFilters.source) params.source = dashboardFilters.source;
    if (dashboardFilters.tenderStage) params.tenderStage = dashboardFilters.tenderStage;
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
  }, [dashboardFilters, debouncedDashboardSearchText]);

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
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [buildDashboardParams, currentPage, showToast]);

  const loadAuxiliaryData = useCallback(async () => {
    try {
      const analyticsParams = buildDashboardParams(1, 100);
      const healthPromise = healthApi.get();
      void healthPromise.then((healthData) => {
        setHealthStatus(healthData);
      }).catch((error) => {
        console.error('Failed to load health status:', error);
      });

      const [keywordsData, analyticsData, statsData, notifData, opsData, healthData] = await Promise.all([
        keywordsApi.getAll(),
        hotspotsApi.getAll(analyticsParams),
        hotspotsApi.getStats(),
        notificationsApi.getAll({ limit: 12 }),
        hotspotsApi.getOpsSummary(),
        healthPromise
      ]);

      setKeywords(keywordsData);
      setAnalyticsHotspots(analyticsData.data);
      setStats(statsData);
      setNotifications(notifData.data);
      setUnreadCount(notifData.unreadCount);
      setOpsSummary(opsData);
      setHealthStatus(healthData);

      const activeKeywords = keywordsData.filter(item => item.isActive).map(item => item.text);
      if (activeKeywords.length > 0) {
        subscribeToKeywords(activeKeywords);
      }
    } catch (error) {
      console.error('Failed to load auxiliary data:', error);
      showToast('加载分析数据失败', 'error');
      throw error;
    }
  }, [buildDashboardParams, showToast]);

  const refreshDashboardData = useCallback(async (label = '正在刷新列表与分析数据…') => {
    const runId = beginHeroProgress(label);
    const [pageResult, auxResult] = await Promise.allSettled([
      loadPageData().then(() => advanceHeroProgress(68, runId)),
      loadAuxiliaryData().then(() => advanceHeroProgress(86, runId)),
    ]);

    if (pageResult.status === 'rejected' || auxResult.status === 'rejected') {
      clearHeroProgress(runId);
      return;
    }

    finishHeroProgress(runId);
  }, [advanceHeroProgress, beginHeroProgress, clearHeroProgress, finishHeroProgress, loadAuxiliaryData, loadPageData]);

  const refreshOperationalStatus = useCallback(async () => {
    try {
      const [opsData, healthData, notifData] = await Promise.all([
        hotspotsApi.getOpsSummary(),
        healthApi.get(),
        notificationsApi.getAll({ limit: 12 }),
      ]);

      setOpsSummary(opsData);
      setHealthStatus(healthData);
      setNotifications(notifData.data);
      setUnreadCount(notifData.unreadCount);
    } catch (error) {
      console.error('Failed to refresh operational status:', error);
    }
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [dashboardFilters]);

  useEffect(() => {
    refreshDashboardData();
  }, [refreshDashboardData]);

  useEffect(() => {
    const intervalMs = healthStatus?.hotspotCheckQueue.running ? 8000 : 30000;
    const timer = window.setInterval(() => {
      refreshOperationalStatus();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [healthStatus?.hotspotCheckQueue.running, refreshOperationalStatus]);

  useEffect(() => {
    const unsubHotspot = onNewHotspot(() => {
      refreshDashboardData('正在同步最新机会…');
      showToast('发现新的 BIM 招采公告', 'success');
    });

    const unsubNotif = onNotification(() => {
      setUnreadCount(prev => prev + 1);
    });

    return () => {
      unsubHotspot();
      unsubNotif();
    };
  }, [refreshDashboardData, showToast]);

  const handleManualCheck = async () => {
    setIsChecking(true);
    const runId = beginHeroProgress('后台扫描已提交…');
    try {
      await triggerHotspotCheck();
      advanceHeroProgress(48, runId);
      showToast('已加入后台扫描队列', 'success');
      window.setTimeout(() => {
        refreshDashboardData('正在同步扫描结果…');
      }, 4000);
      finishHeroProgress(runId);
    } catch (error) {
      console.error(error);
      showToast('触发扫描失败', 'error');
      clearHeroProgress(runId);
    } finally {
      setIsChecking(false);
    }
  };

  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  }, [onLogout]);

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    setIsLoading(true);
    try {
      const trimmed = searchQuery.trim();
      const result = await hotspotsApi.search(searchQuery);
      setManualRecentSearches((prev) => rememberSearchTerm(prev, trimmed));
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

  const handleNotifyFeishu = useCallback(async (hotspot: Hotspot) => {
    setPushingFeishuId(hotspot.id);
    try {
      await hotspotsApi.notifyFeishu(hotspot.id);
      showToast('已推送至飞书群', 'success');
      refreshOperationalStatus();
    } catch (error) {
      console.error('Failed to notify Feishu:', error);
      showToast(error instanceof Error ? error.message : '推送飞书失败', 'error');
    } finally {
      setPushingFeishuId(null);
    }
  }, [refreshOperationalStatus, showToast]);

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

  const markNotificationRead = useCallback(async (notificationId: string) => {
    setNotifications(prev => prev.map(item => item.id === notificationId ? { ...item, isRead: true } : item));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await notificationsApi.markAsRead(notificationId);
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
      refreshOperationalStatus();
    }
  }, [refreshOperationalStatus]);

  const loadDailyData = useCallback(async (params?: {
    reportId?: string;
    source?: string;
    keyword?: string;
  }) => {
    setIsDailyLoading(true);
    try {
      const source = params?.source ?? '';
      const keyword = params?.keyword ?? '';
      const requestedReportId = params?.reportId ?? '';

      const [reportsData, keywordsData, healthData] = await Promise.all([
        dailyApi.getReports({
          page: 1,
          limit: 30,
          source: source || undefined,
          keyword: keyword || undefined,
        }),
        dailyApi.getKeywords(),
        dailyApi.getHealth(),
      ]);

      setDailyReports(reportsData.data);
      setDailyKeywords(keywordsData);
      setDailyHealth(healthData);
      setIsDailyRunning(Boolean(healthData.queue.running));

      const availableReportIds = new Set(reportsData.data.map((item) => item.id));
      const fallbackReportId = reportsData.data[0]?.id || healthData.latestReport?.id || '';
      const nextReportId = requestedReportId && availableReportIds.has(requestedReportId)
        ? requestedReportId
        : fallbackReportId;

      if (!nextReportId) {
        setSelectedDailyReportId('');
        setSelectedDailyReport(null);
        setDailyArticles([]);
        return;
      }

      setSelectedDailyReportId(nextReportId);

      const [reportData, articlesData] = await Promise.all([
        dailyApi.getReportById(nextReportId),
        dailyApi.getArticles({
          reportId: nextReportId,
          source: source || undefined,
          keyword: keyword || undefined,
          page: 1,
          limit: 100,
        }),
      ]);

      setSelectedDailyReport(reportData);
      setDailyArticles(articlesData.data);
    } catch (error) {
      console.error('Failed to load BIM daily report data:', error);
      showToast('加载 BIM 日报失败', 'error');
    } finally {
      setIsDailyLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (activeTab !== 'daily') return;
    void loadDailyData({
      reportId: selectedDailyReportId || undefined,
      source: selectedDailySource || undefined,
      keyword: selectedDailyKeyword || undefined,
    });
  }, [activeTab, loadDailyData, selectedDailyKeyword, selectedDailyReportId, selectedDailySource]);

  useEffect(() => {
    if (activeTab !== 'daily' || !dailyHealth?.queue.running) return;
    const timer = window.setInterval(() => {
      void loadDailyData({
        reportId: selectedDailyReportId || undefined,
        source: selectedDailySource || undefined,
        keyword: selectedDailyKeyword || undefined,
      });
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeTab, dailyHealth?.queue.running, loadDailyData, selectedDailyKeyword, selectedDailyReportId, selectedDailySource]);

  const handleRunDailyReport = useCallback(async () => {
    setIsDailyRunning(true);
    try {
      const result = await dailyApi.run();
      showToast(result.accepted ? '已加入 BIM 日报生成队列' : '日报生成任务已在运行', result.accepted ? 'success' : 'error');
      await loadDailyData({
        reportId: selectedDailyReportId || undefined,
        source: selectedDailySource || undefined,
        keyword: selectedDailyKeyword || undefined,
      });
      if (result.accepted) {
        window.setTimeout(() => {
          void loadDailyData({
            reportId: selectedDailyReportId || undefined,
            source: selectedDailySource || undefined,
            keyword: selectedDailyKeyword || undefined,
          });
        }, 3000);
      }
    } catch (error) {
      console.error('Failed to trigger BIM daily report:', error);
      showToast('触发 BIM 日报生成失败', 'error');
      setIsDailyRunning(false);
    }
  }, [loadDailyData, selectedDailyKeyword, selectedDailyReportId, selectedDailySource, showToast]);

  const handleSearchFromNotification = useCallback((notification: Notification) => {
    const query = extractNotificationSearchText(notification);
    if (!query) {
      showToast('这条通知暂时没有可搜索的关键词', 'error');
      return;
    }

    setShowNotifications(false);
    setSelectedHotspot(null);
    setIsDetailLoading(false);
    setActiveTab('opportunities');
    setCurrentPage(1);
    setDashboardFilters({
      ...defaultFilterState,
      searchText: query,
      searchMode: 'fulltext',
    });
    showToast(`已按“${query}”筛选机会清单`, 'success');
  }, [showToast]);

  const handleOpenHotspotDetailById = useCallback(async (hotspotId: string) => {
    const knownHotspot = [...hotspots, ...analyticsHotspots, ...searchResults].find((item) => item.id === hotspotId);
    if (knownHotspot) {
      await handleOpenHotspotDetail(knownHotspot);
      return;
    }

    setSelectedHotspot(null);
    setIsDetailLoading(true);
    try {
      const detail = await hotspotsApi.getById(hotspotId);
      setSelectedHotspot(detail);
    } catch (error) {
      console.error('Failed to open hotspot detail by notification:', error);
      showToast('通知对应的项目详情暂时无法读取，已改为筛选该线索。', 'error');
      const fallback = notifications.find((item) => item.hotspotId === hotspotId);
      if (fallback) {
        handleSearchFromNotification(fallback);
      }
    } finally {
      setIsDetailLoading(false);
    }
  }, [analyticsHotspots, handleOpenHotspotDetail, handleSearchFromNotification, hotspots, notifications, searchResults, showToast]);

  const handleNotificationClick = useCallback(async (notification: Notification) => {
    setShowNotifications(false);
    if (!notification.isRead) {
      void markNotificationRead(notification.id);
    }

    setActiveTab('opportunities');
    if (notification.hotspotId) {
      await handleOpenHotspotDetailById(notification.hotspotId);
      return;
    }

    handleSearchFromNotification(notification);
  }, [handleOpenHotspotDetailById, handleSearchFromNotification, markNotificationRead]);

  const filteredSearchResults = useMemo(() => {
    let results = [...searchResults];
    if (searchFilters.searchText.trim()) {
      results = results.filter(item => hotspotMatchesSearch(item, searchFilters.searchText, searchFilters.searchMode));
    }
    if (searchFilters.includeExpired === 'false') {
      results = results.filter(item => getDeadlineInfo(getEffectiveDeadline(item)).urgency !== 'expired');
    }
    if (searchFilters.source) results = results.filter(item => item.source === searchFilters.source);
    if (searchFilters.tenderStage) {
      results = results.filter((item) => (
        item.tenderStageCategory === searchFilters.tenderStage
        || item.tenderStageBucket === searchFilters.tenderStage
      ));
    }
    if (searchFilters.importance) results = results.filter(item => item.importance === searchFilters.importance);
    if (searchFilters.keywordId) results = results.filter(item => item.keyword?.id === searchFilters.keywordId);
    if (searchFilters.isReal === 'true') results = results.filter(item => item.isReal);
    if (searchFilters.isReal === 'false') results = results.filter(item => !item.isReal);
    if (searchFilters.tenderType) results = results.filter(item => item.tenderType === searchFilters.tenderType);
    if (searchFilters.tenderRegion) {
      results = results.filter(item => (item.tenderRegion || '').includes(searchFilters.tenderRegion) || (item.tenderCity || '').includes(searchFilters.tenderRegion));
    }
    if (searchFilters.tenderPlatform) {
      const targetPlatform = normalizeTenderPlatform(searchFilters.tenderPlatform);
      results = results.filter(item => normalizeTenderPlatform(item.tenderPlatform) === targetPlatform);
    }
    if (searchFilters.tenderMinBudgetWan) {
      const min = Number(searchFilters.tenderMinBudgetWan);
      results = results.filter(item => item.tenderBudgetWan != null && item.tenderBudgetWan >= min);
    }
    return sortHotspots(results, searchFilters.sortBy || 'createdAt', (searchFilters.sortOrder || 'desc') as 'asc' | 'desc');
  }, [searchFilters, searchResults]);

  const dashboardSearchSuggestions = useMemo(() => {
    const query = dashboardFilters.searchText.trim().toLowerCase();
    const pool = [...dashboardRecentSearches, ...keywords.map((item) => item.text)];
    const unique = Array.from(new Set(pool));
    if (!query) return [];
    return unique.filter((item) => item.toLowerCase().includes(query)).slice(0, 6);
  }, [dashboardFilters.searchText, dashboardRecentSearches, keywords]);

  const manualSearchSuggestions = useMemo(() => {
    const query = searchFilters.searchText.trim().toLowerCase();
    const pool = [...manualRecentSearches, ...keywords.map((item) => item.text)];
    const unique = Array.from(new Set(pool));
    if (!query) return [];
    return unique.filter((item) => item.toLowerCase().includes(query)).slice(0, 6);
  }, [keywords, manualRecentSearches, searchFilters.searchText]);

  const handleClearDashboardRecentSearches = useCallback(() => {
    setDashboardRecentSearches([]);
    showToast('已清空首页最近搜索', 'success');
  }, [showToast]);

  const handleClearManualRecentSearches = useCallback(() => {
    setManualRecentSearches([]);
    showToast('已清空临时搜索记录', 'success');
  }, [showToast]);

  const directSearchSuggestions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const pool = [...manualRecentSearches, ...keywords.map((item) => item.text)];
    const unique = Array.from(new Set(pool));
    if (!query) return unique.slice(0, 6);
    return unique.filter((item) => item.toLowerCase().includes(query)).slice(0, 6);
  }, [keywords, manualRecentSearches, searchQuery]);

  const handleSaveCurrentView = useCallback(() => {
    const name = window.prompt('请输入视图名称', dashboardFilters.searchText.trim() || '我的筛选视图');
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setSavedFilterViews((prev) => {
      const id = `view-${Date.now()}`;
      const next = [{ id, name: trimmed, filters: { ...dashboardFilters } }, ...prev.filter((item) => item.name !== trimmed)];
      return next.slice(0, 8);
    });
    showToast(`已保存视图：${trimmed}`, 'success');
  }, [dashboardFilters, showToast]);

  const handleApplyView = useCallback((viewId: string) => {
    const target = savedFilterViews.find((item) => item.id === viewId);
    if (!target) return;
    setDashboardFilters({ ...target.filters });
    showToast(`已切换到视图：${target.name}`, 'success');
  }, [savedFilterViews, showToast]);

  const handleDeleteView = useCallback((viewId: string) => {
    const target = savedFilterViews.find((item) => item.id === viewId);
    setSavedFilterViews((prev) => prev.filter((item) => item.id !== viewId));
    if (target) showToast(`已删除视图：${target.name}`, 'success');
  }, [savedFilterViews, showToast]);

  const handleToggleOpportunitySelect = useCallback((hotspotId: string) => {
    setSelectedOpportunityIds((prev) => prev.includes(hotspotId) ? prev.filter((item) => item !== hotspotId) : [...prev, hotspotId]);
  }, []);

  const handleBatchOpportunityAction = useCallback((action: OpportunityAction) => {
    if (selectedOpportunityIds.length === 0) return;
    setOpportunityActions((prev) => {
      const next = { ...prev };
      for (const id of selectedOpportunityIds) {
        next[id] = action;
      }
      return next;
    });
    const labels: Record<OpportunityAction, string> = {
      follow: '标记跟进',
      archive: '归档',
      ignore: '忽略',
    };
    showToast(`已为 ${selectedOpportunityIds.length} 条机会执行“${labels[action]}”`, 'success');
    setSelectedOpportunityIds([]);
  }, [selectedOpportunityIds, showToast]);

  const handleClearOpportunitySelection = useCallback(() => {
    setSelectedOpportunityIds([]);
  }, []);

  const regionBuckets = useMemo(() => buildRegionBuckets(analyticsHotspots), [analyticsHotspots]);
  const budgetBuckets = useMemo(() => buildBudgetBuckets(analyticsHotspots), [analyticsHotspots]);
  const deadlineBuckets = useMemo(() => buildDeadlineBuckets(analyticsHotspots), [analyticsHotspots]);
  const typeBuckets = useMemo(() => buildTenderTypeBuckets(analyticsHotspots), [analyticsHotspots]);
  const stageBuckets = useMemo(() => buildStageBuckets(analyticsHotspots), [analyticsHotspots]);
  const trendPoints = useMemo(() => buildTrendPoints(analyticsHotspots), [analyticsHotspots]);
  const businessReadouts = useMemo(
    () => buildBusinessReadouts(analyticsHotspots, regionBuckets, budgetBuckets, typeBuckets),
    [analyticsHotspots, regionBuckets, budgetBuckets, typeBuckets]
  );
  const sourceShare = useMemo(() => {
    const sourceEntries = Object.entries(stats?.bySource || {}).map(([label, value]) => ({ label: getSourceLabel(label), value }));
    return sourceEntries.sort((a, b) => b.value - a.value);
  }, [stats]);
  const legacySourceSummary = useMemo(() => {
    const entries = Object.entries(stats?.legacyBySource || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([source, count]) => `${getSourceLabel(source)} ${count} 条`);
    return entries.join(' · ');
  }, [stats]);
  const highValueHotspots = useMemo(() => {
    return [...analyticsHotspots]
      .filter(item => item.tenderActionable)
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
    const stageSummary = buildOpportunityStageSummary(analyticsHotspots);
    const deadlineRisk = analyticsHotspots.filter(item => {
      const effective = getEffectiveDeadline(item);
      if (!effective) return false;
      const deadline = new Date(effective).getTime();
      return Number.isFinite(deadline) && deadline >= now && deadline <= sevenDays;
    }).length;
    const activeOpportunity = analyticsHotspots.filter(item => {
      if (!item.tenderActionable) return false;
      const effective = getEffectiveDeadline(item);
      if (!effective) return true;
      const deadline = new Date(effective).getTime();
      return Number.isFinite(deadline) ? deadline >= now : true;
    }).length;
    const totalBudgetWan = knownBudgetItems.reduce((sum, item) => sum + (item.tenderBudgetWan || 0), 0);
    const completeRows = analyticsHotspots.filter(item => item.tenderUnit && item.tenderRegion && item.tenderNoticeType).length;
    const completeness = analyticsHotspots.length ? Math.round((completeRows / analyticsHotspots.length) * 100) : 0;
    const strongestSource = opsSummary?.sourceQuality?.length
      ? [...opsSummary.sourceQuality].sort((a, b) => b.qualityScore - a.qualityScore || b.activeCount - a.activeCount)[0]
      : null;
    const weakestSource = opsSummary?.sourceQuality?.length
      ? [...opsSummary.sourceQuality].sort((a, b) => a.qualityScore - b.qualityScore || b.dirtyIssueCount - a.dirtyIssueCount)[0]
      : null;

    return {
      activeOpportunity,
      deadlineRisk,
      totalBudgetWan,
      knownBudgetCount: knownBudgetItems.length,
      completeness,
      stageSummary,
      strongestSource,
      weakestSource
    };
  }, [analyticsHotspots, opsSummary]);

  const dashboardInsightCards = useMemo(() => {
    const strongestSourceLabel = analysisSnapshot.strongestSource ? getSourceLabel(analysisSnapshot.strongestSource.source) : '待评估';
    const weakestSourceLabel = analysisSnapshot.weakestSource ? getSourceLabel(analysisSnapshot.weakestSource.source) : '待评估';
    return [
      {
        title: '正式机会',
        value: `${analysisSnapshot.stageSummary.actionable}`,
        caption: analysisSnapshot.deadlineRisk > 0
          ? `其中 ${analysisSnapshot.deadlineRisk} 条在 7 天内要完成窗口确认。`
          : '当前正式机会都还没有进入紧急窗口。',
        icon: ShieldCheck,
        tone: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'
      },
      {
        title: '前置信号',
        value: `${analysisSnapshot.stageSummary.preSignal}`,
        caption: '适合作为 BD 提前布局池，不和正式公告混排判断。',
        icon: Radar,
        tone: 'border-amber-300/25 bg-amber-400/12 text-amber-200'
      },
      {
        title: '最佳来源',
        value: strongestSourceLabel,
        caption: analysisSnapshot.strongestSource
          ? `质量分 ${analysisSnapshot.strongestSource.qualityScore}，可跟进 ${analysisSnapshot.strongestSource.activeCount} 条。`
          : '等待来源质量样本回传。',
        icon: Sparkles,
        tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
      },
      {
        title: '优先治理',
        value: weakestSourceLabel,
        caption: analysisSnapshot.weakestSource
          ? `质量分 ${analysisSnapshot.weakestSource.qualityScore}，脏值 ${analysisSnapshot.weakestSource.dirtyIssueCount} 条。`
          : '当前来源治理状态良好。',
        icon: AlertTriangle,
        tone: 'border-orange-300/25 bg-orange-400/12 text-orange-200'
      }
    ];
  }, [analysisSnapshot]);

  return (
    <div className={cn(
      'min-h-screen',
      themeMode === 'light' ? 'bg-[linear-gradient(180deg,#f4f8ff,#e9f2ff)] text-slate-900' : 'bg-[#07111f] text-white'
    )}>
      <BackgroundBeams className={themeMode === 'light' ? 'opacity-20' : 'opacity-60'} />
      <Spotlight className="-top-32 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2" fill={themeMode === 'light' ? '#38bdf8' : '#0ea5e9'} />
      <div className={cn(
        'pointer-events-none fixed inset-x-0 top-0 h-40',
        themeMode === 'light'
          ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0))]'
          : 'bg-[linear-gradient(180deg,rgba(7,17,31,0.96),rgba(7,17,31,0))]'
      )} />
      <div className={cn('pointer-events-none fixed right-[-120px] top-24 h-72 w-72 rounded-full blur-3xl', themeMode === 'light' ? 'bg-cyan-400/8' : 'bg-cyan-400/10')} />
      <div className={cn('pointer-events-none fixed bottom-0 left-[-120px] h-72 w-72 rounded-full blur-3xl', themeMode === 'light' ? 'bg-amber-300/8' : 'bg-amber-300/10')} />

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={cn(
              'fixed left-1/2 top-5 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[20px] border px-4 py-3 text-sm shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur-xl',
              toast.type === 'success'
                ? (themeMode === 'light'
                  ? 'border-emerald-200 bg-white/96 text-slate-800'
                  : 'border-emerald-400/30 bg-emerald-500/12 text-emerald-100')
                : (themeMode === 'light'
                  ? 'border-red-200 bg-white/96 text-slate-800'
                  : 'border-red-400/30 bg-red-500/12 text-red-100')
            )}
          >
            <span className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full',
              toast.type === 'success'
                ? (themeMode === 'light' ? 'bg-emerald-50 text-emerald-600' : 'bg-emerald-500/18 text-emerald-200')
                : (themeMode === 'light' ? 'bg-red-50 text-red-600' : 'bg-red-500/18 text-red-200')
            )}>
              {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <p className={cn('font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>
                {toast.type === 'success' ? '操作已提交' : '操作失败'}
              </p>
              <p className={cn('text-xs', themeMode === 'light' ? 'text-slate-500' : 'text-slate-300')}>
                {toast.message}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className={cn(
        'sticky top-0 z-40 border-b backdrop-blur-2xl',
        themeMode === 'light' ? 'border-slate-200 bg-white/85' : 'border-white/8 bg-[#07111f]/70'
      )}>
        <div className="mx-auto max-w-7xl px-5 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-[20px] border border-cyan-300/20 bg-[linear-gradient(135deg,rgba(34,211,238,0.22),rgba(251,191,36,0.12))] shadow-[0_16px_40px_rgba(14,165,233,0.18)]">
                <Radar className={cn('h-7 w-7', themeMode === 'light' ? 'text-cyan-600' : 'text-cyan-200')} />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/75">BIM Tender Command</p>
                <h1 className={cn('mt-1 text-2xl font-semibold tracking-tight sm:text-3xl', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>BIM 招采监控台</h1>
                <p className={cn('mt-1 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>Version {appVersion}</p>
              </div>
            </div>

            <HeaderProgress
              progressValue={heroProgress}
              progressLabel={heroProgressLabel}
              themeMode={themeMode}
              queueRunning={healthStatus?.hotspotCheckQueue.running || false}
            />

            <div className="flex flex-wrap items-center gap-3">
              <div className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm',
                themeMode === 'light'
                  ? 'border-slate-200 bg-white text-slate-600'
                  : 'border-white/10 bg-white/5 text-slate-300'
              )}>
                <UserRound className="h-4 w-4" />
                <span>{authUser}</span>
              </div>
              <button
                onClick={() => setThemeMode(prev => prev === 'dark' ? 'light' : 'dark')}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
                  themeMode === 'light'
                    ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                )}
              >
                {themeMode === 'light' ? <MoonStar className="h-4 w-4" /> : <SunMedium className="h-4 w-4" />}
                {themeMode === 'light' ? '切回深色' : '浅色主题'}
              </button>
              <button
                onClick={() => { refreshDashboardData(); }}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
                  themeMode === 'light'
                    ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                )}
              >
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                刷新数据
              </button>
              <button
                onClick={handleManualCheck}
                disabled={isChecking}
                className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#0ea5e9,#14b8a6)] px-5 py-2.5 text-sm font-medium text-white shadow-[0_16px_40px_rgba(14,165,233,0.35)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-wait disabled:opacity-80"
              >
                <RefreshCw className={cn('h-4 w-4', isChecking && 'animate-spin')} />
                {isChecking ? '提交中' : '后台扫描'}
              </button>
              <button
                onClick={() => { void handleLogout(); }}
                disabled={isLoggingOut}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
                  themeMode === 'light'
                    ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                )}
              >
                <LogOut className={cn('h-4 w-4', isLoggingOut && 'animate-pulse')} />
                {isLoggingOut ? '退出中' : '退出登录'}
              </button>

              <div className="relative">
                <button
                  onClick={() => setShowNotifications(prev => !prev)}
                  className={cn(
                    'relative rounded-full border p-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
                    themeMode === 'light'
                      ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                  )}
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
                      className={cn(
                        'absolute right-0 top-14 z-50 flex max-h-[min(70vh,32rem)] w-[22rem] flex-col overflow-hidden rounded-[28px] border p-4 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl',
                        themeMode === 'light' ? 'border-slate-200 bg-white/96' : 'border-white/10 bg-[#0b1324]/96'
                      )}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className={cn('text-sm font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>最近通知</h3>
                        {unreadCount > 0 && (
                          <button onClick={handleMarkAllRead} className="text-xs text-cyan-300 hover:text-cyan-200">全部已读</button>
                        )}
                      </div>
                      <div className="space-y-3 overflow-y-auto pr-1">
                        {notifications.length === 0 && (
                          <div className={cn(
                            'rounded-2xl border border-dashed p-4 text-sm',
                            themeMode === 'light' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/8 bg-white/[0.03] text-slate-500'
                          )}>
                            暂无通知
                          </div>
                        )}
                        {notifications.slice(0, 6).map(item => (
                          <button
                            key={item.id}
                            onClick={() => { void handleNotificationClick(item); }}
                            className={cn(
                              'block w-full rounded-2xl border p-3 text-left text-sm transition',
                              item.isRead
                                ? (themeMode === 'light'
                                  ? 'border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:bg-white'
                                  : 'border-white/5 bg-white/[0.03] text-slate-500 hover:border-white/10 hover:bg-white/[0.05]')
                                : (themeMode === 'light'
                                  ? 'border-cyan-200 bg-cyan-50 text-slate-700 hover:border-cyan-300 hover:bg-cyan-100/70'
                                  : 'border-cyan-400/10 bg-cyan-500/[0.06] text-slate-200 hover:border-cyan-400/20 hover:bg-cyan-500/[0.1]')
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium">{item.title}</p>
                                <p className="mt-1 line-clamp-2 text-xs">{item.content}</p>
                              </div>
                              <ArrowRight className={cn(
                                'mt-0.5 h-4 w-4 shrink-0',
                                themeMode === 'light' ? 'text-slate-400' : 'text-slate-500'
                              )} />
                            </div>
                            <p className={cn(
                              'mt-2 text-[11px]',
                              themeMode === 'light' ? 'text-slate-400' : 'text-slate-500'
                            )}>
                              {item.hotspotId ? '点击直达项目详情' : '点击按关键词筛选主页机会'}
                            </p>
                          </button>
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
                    ? (themeMode === 'light' ? 'border-cyan-300 bg-cyan-50 text-cyan-700' : 'border-cyan-300/25 bg-cyan-500/12 text-cyan-100')
                    : (themeMode === 'light' ? 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-900' : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-100')
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {selectedHotspot && (
          <HotspotDetailPage
            hotspot={selectedHotspot}
            isLoading={isDetailLoading}
            onBack={handleCloseHotspotDetail}
            onNotifyFeishu={handleNotifyFeishu}
            isNotifyingFeishu={pushingFeishuId === selectedHotspot.id}
            feishuWebhookEnabled={healthStatus?.integrations.feishuWebhookEnabled || false}
            themeMode={themeMode}
          />
        )}

        {!selectedHotspot && activeTab === 'opportunities' && (
          <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.7fr)]">
            <OpportunityListSection
              hotspots={hotspots}
              summaryHotspots={analyticsHotspots}
              filters={dashboardFilters}
              onFiltersChange={setDashboardFilters}
              keywords={keywords}
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setCurrentPage}
              onOpenDetail={handleOpenHotspotDetail}
              themeMode={themeMode}
              isSearchDebouncing={isSearchDebouncing}
              searchSuggestions={dashboardSearchSuggestions}
              recentSearches={dashboardRecentSearches}
              onClearRecentSearches={handleClearDashboardRecentSearches}
              savedViews={savedFilterViews}
              onSaveView={handleSaveCurrentView}
              onApplyView={handleApplyView}
              onDeleteView={handleDeleteView}
              selectedIds={selectedOpportunityIds}
              onToggleSelect={handleToggleOpportunitySelect}
              onBatchAction={handleBatchOpportunityAction}
              onClearSelection={handleClearOpportunitySelection}
              actionsById={opportunityActions}
            />

            <aside className="space-y-4">
              <section className={cn(
                'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
                themeMode === 'light'
                  ? 'border-slate-200 bg-[linear-gradient(180deg,rgba(14,165,233,0.1),rgba(255,255,255,0.96))]'
                  : 'border-white/10 bg-[linear-gradient(180deg,rgba(14,165,233,0.12),rgba(255,255,255,0.04))]'
              )}>
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h3 className={cn('text-lg font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>优先跟进</h3>
                    <p className={cn('mt-1 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>仅保留正式公告 / 资格预审 / 变更补遗，按截止、预算、单位和匹配度排序。</p>
                  </div>
                  <Flame className="h-5 w-5 text-orange-300" />
                </div>
                <div className="space-y-3">
                  {highValueHotspots.map(item => {
                    const deadline = getDeadlineInfo(getEffectiveDeadline(item));
                    const stage = getNoticeStage(item);
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleOpenHotspotDetail(item)}
                        className={cn(
                          'block w-full rounded-[22px] border p-4 text-left transition',
                          themeMode === 'light'
                            ? 'border-slate-200 bg-white hover:border-cyan-300 hover:bg-cyan-50/40'
                            : 'border-white/8 bg-[#101427] hover:border-cyan-400/20 hover:bg-[#12192b]'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className={cn('line-clamp-3 text-sm font-medium leading-6', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{item.title}</p>
                            <p className="mt-2 text-xs text-slate-500">{item.tenderUnit || '单位待补全'}</p>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs">
                              <span className={cn('rounded-full border px-2 py-1', getBadgeTone(stage.tone, themeMode))}>{stage.label}</span>
                              <span className={cn('rounded-full border px-2 py-1', themeMode === 'light' ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>{item.tenderRegion || item.tenderCity || '未标注地区'}</span>
                              <span className={cn('rounded-full border px-2 py-1', themeMode === 'light' ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/5 text-slate-300')}>{formatBudget(item.tenderBudgetWan)}</span>
                              <span className={cn('rounded-full border px-2 py-1', deadline.tone)}>{deadline.label}</span>
                            </div>
                          </div>
                          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                        </div>
                      </button>
                    );
                  })}
                  {highValueHotspots.length === 0 && (
                    <div className={cn(
                      'rounded-[22px] border border-dashed p-4 text-sm',
                      themeMode === 'light' ? 'border-slate-200 bg-white text-slate-500' : 'border-white/8 bg-white/[0.03] text-slate-500'
                    )}>
                      当前暂无优先项目。
                    </div>
                  )}
                </div>
              </section>

              <section className={cn(
                'rounded-[24px] border p-5 shadow-[0_18px_56px_rgba(0,0,0,0.2)]',
                themeMode === 'light' ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
              )}>
                <div className="mb-4">
                  <h3 className={cn('text-lg font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>投标快照</h3>
                  <p className={cn('mt-1 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>当前筛选条件下的业务状态。</p>
                </div>
                <div className="grid gap-3">
                  <AnalysisCard title="可跟进" value={`${analysisSnapshot.activeOpportunity}`} caption="未过期或未标注截止时间。" icon={Target} tone="border-cyan-400/20 bg-cyan-500/10 text-cyan-200" themeMode={themeMode} />
                  <AnalysisCard title="7天内截止" value={`${analysisSnapshot.deadlineRisk}`} caption="需要优先人工核对。" icon={AlertTriangle} tone="border-red-400/20 bg-red-500/10 text-red-200" themeMode={themeMode} />
                  <AnalysisCard title="预算合计" value={formatBudget(analysisSnapshot.totalBudgetWan)} caption={`覆盖 ${analysisSnapshot.knownBudgetCount} 条已披露预算公告。`} icon={WalletCards} tone="border-emerald-400/20 bg-emerald-500/10 text-emerald-200" themeMode={themeMode} />
                </div>
              </section>

              <MonitorLogPanel summary={opsSummary} health={healthStatus} themeMode={themeMode} />
            </aside>
          </div>
        )}

        {!selectedHotspot && activeTab === 'daily' && (
          <DailyReportTab
            themeMode={themeMode}
            reports={dailyReports}
            selectedReport={selectedDailyReport}
            articles={dailyArticles}
            keywords={dailyKeywords}
            selectedSource={selectedDailySource}
            selectedKeyword={selectedDailyKeyword}
            health={dailyHealth}
            isLoading={isDailyLoading}
            isRunning={isDailyRunning || Boolean(dailyHealth?.queue.running)}
            onSelectReport={setSelectedDailyReportId}
            onSelectSource={setSelectedDailySource}
            onSelectKeyword={setSelectedDailyKeyword}
            onRunReport={handleRunDailyReport}
          />
        )}

        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <DashboardMetric
                title="招采公告"
                value={stats?.monitoredTotal ?? stats?.total ?? 0}
                caption={
                  stats?.legacyTotal
                    ? `当前 7 个招采源共 ${stats.monitoredTotal ?? stats.total} 条；另有 ${stats.legacyTotal} 条旧版历史样本仍保留在库内。${legacySourceSummary ? `主要来源：${legacySourceSummary}。` : ''}`
                    : '当前 7 个招采源已沉淀的 BIM 招采公告。'
                }
                tone="border-cyan-400/15 bg-[linear-gradient(180deg,rgba(14,165,233,0.16),rgba(14,165,233,0.04))]"
                icon={Layers3}
                themeMode={themeMode}
              />
              <DashboardMetric title="今日新增" value={stats?.today ?? 0} caption="当天新发现，可直接作为跟进入口" tone="border-emerald-400/15 bg-[linear-gradient(180deg,rgba(16,185,129,0.16),rgba(16,185,129,0.04))]" icon={Sparkles} themeMode={themeMode} />
              <DashboardMetric title="紧急机会" value={stats?.urgent ?? 0} caption="高优先级项目，需要尽快人工确认" tone="border-red-400/15 bg-[linear-gradient(180deg,rgba(239,68,68,0.16),rgba(239,68,68,0.04))]" icon={AlertTriangle} themeMode={themeMode} />
              <DashboardMetric title="活跃监控词" value={keywords.filter(item => item.isActive).length} caption="当前参与自动扫描的 BIM 关键词数量" tone="border-amber-300/15 bg-[linear-gradient(180deg,rgba(251,191,36,0.14),rgba(251,191,36,0.04))]" icon={Target} themeMode={themeMode} />
            </section>

            <section className="grid gap-5 xl:grid-cols-[1.45fr_0.95fr]">
              <div className={cn(
                'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.35)]',
                themeMode === 'light'
                  ? 'border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.08),rgba(255,255,255,0.96),rgba(20,184,166,0.05))]'
                  : 'border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.88),rgba(8,47,73,0.84))]'
              )}>
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Bid Pipeline</p>
                    <h2 className={cn('mt-3 max-w-2xl text-3xl font-semibold leading-tight sm:text-4xl', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>把招采公告整理成可判断、可分派、可跟进的投标线索。</h2>
                    <p className={cn('mt-3 max-w-2xl text-sm leading-7', themeMode === 'light' ? 'text-slate-600' : 'text-slate-300/85')}>
                      首页优先回答投标团队最关心的问题：项目在哪、谁招、什么类型、预算多少、什么时候截止、详情链接是否可靠。
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:min-w-[18rem]">
                    <div className={cn('rounded-[24px] border p-4', themeMode === 'light' ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.05]')}>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">来源可达</p>
                      <p className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.sourceHealth.filter(item => item.ok).length ?? 0}/{opsSummary?.sourceHealth.length ?? 0}</p>
                    </div>
                    <div className={cn('rounded-[24px] border p-4', themeMode === 'light' ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.05]')}>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">今日扫描</p>
                      <p className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.stats.todayHotspots ?? 0}</p>
                    </div>
                  </div>
                </div>
              </div>

              <section className={cn(
                'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
                themeMode === 'light' ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
              )}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className={cn('text-lg font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>运行参数</h3>
                    <p className={cn('mt-1 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>这里读的是后端运行时配置，不是写死文案。</p>
                  </div>
                  <Settings2 className="h-5 w-5 text-slate-500" />
                </div>
                <div className={cn('mt-5 grid gap-3 text-sm sm:grid-cols-2', themeMode === 'light' ? 'text-slate-700' : 'text-slate-300')}>
                  <div className={cn('rounded-2xl border p-4', themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}><div className="text-xs uppercase tracking-[0.2em] text-slate-500">新鲜度</div><div className={cn('mt-2 text-lg font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.runtimeConfig.maxAgeDays ?? '--'} 天</div></div>
                  <div className={cn('rounded-2xl border p-4', themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}><div className="text-xs uppercase tracking-[0.2em] text-slate-500">单源条数</div><div className={cn('mt-2 text-lg font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.runtimeConfig.sourceResultLimit ?? '--'}</div></div>
                  <div className={cn('rounded-2xl border p-4', themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}><div className="text-xs uppercase tracking-[0.2em] text-slate-500">关键词配额</div><div className={cn('mt-2 text-lg font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.runtimeConfig.resultsPerKeyword ?? '--'}</div></div>
                  <div className={cn('rounded-2xl border p-4', themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]')}><div className="text-xs uppercase tracking-[0.2em] text-slate-500">扩展查询数</div><div className={cn('mt-2 text-lg font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{opsSummary?.runtimeConfig.queryVariantsPerKeyword ?? '--'}</div></div>
                </div>
              </section>
            </section>

            <SourceHealthCard summary={opsSummary} themeMode={themeMode} />

            <section className="grid gap-5 xl:grid-cols-[1.05fr_1fr]">
              <QualityCoverageCard summary={opsSummary} themeMode={themeMode} />
              <AIQualityCard summary={opsSummary} themeMode={themeMode} />
            </section>

            <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <section className={cn(
                'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
                themeMode === 'light'
                  ? 'border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.05),rgba(255,255,255,0.96),rgba(20,184,166,0.04))]'
                  : 'border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.88),rgba(8,47,73,0.84))]'
              )}>
                <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Business Signal</p>
                    <h3 className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>业务判断摘要</h3>
                    <p className={cn('mt-2 text-sm leading-7', themeMode === 'light' ? 'text-slate-500' : 'text-slate-300/85')}>
                      这块不再只报总量，而是先告诉我们当前到底该优先看正式机会、前置信号，还是来源治理问题。
                    </p>
                  </div>
                  <span className={cn('rounded-full border px-3 py-1.5 text-xs', themeMode === 'light' ? 'border-slate-200 bg-white text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
                    样本 {analyticsHotspots.length} 条
                  </span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {dashboardInsightCards.map((item) => (
                    <AnalysisCard
                      key={item.title}
                      title={item.title}
                      value={item.value}
                      caption={item.caption}
                      icon={item.icon}
                      tone={item.tone}
                      themeMode={themeMode}
                    />
                  ))}
                </div>
              </section>

              <SourceQualityComparePanel summary={opsSummary} themeMode={themeMode} />
            </section>

            <SourceQualityPanel summary={opsSummary} themeMode={themeMode} />

            <SourceGovernancePanel summary={opsSummary} themeMode={themeMode} />

            <SourceAcceptancePanel summary={opsSummary} themeMode={themeMode} />

            <section className={cn(
              'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
              themeMode === 'light'
                ? 'border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.05),rgba(255,255,255,0.96),rgba(16,185,129,0.06))]'
                : 'border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.84),rgba(20,83,45,0.22))]'
            )}>
              <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/75">Data Analysis</p>
                  <h3 className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>数据分析快照</h3>
                  <p className={cn('mt-2 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>基于当前筛选条件下最近 100 条公告计算，先看结构、再看趋势、最后落到业务动作。</p>
                </div>
                <span className={cn('rounded-full border px-3 py-1.5 text-xs', themeMode === 'light' ? 'border-slate-200 bg-white text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>
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
                  themeMode={themeMode}
                />
                <AnalysisCard
                  title="7天内截止"
                  value={`${analysisSnapshot.deadlineRisk}`}
                  caption="需要优先人工确认投标窗口的项目。"
                  icon={AlertTriangle}
                  tone="border-red-400/20 bg-red-500/10 text-red-200"
                  themeMode={themeMode}
                />
                <AnalysisCard
                  title="已披露预算"
                  value={formatBudget(analysisSnapshot.totalBudgetWan)}
                  caption={`覆盖 ${analysisSnapshot.knownBudgetCount} 条有预算字段的公告。`}
                  icon={Layers3}
                  tone="border-emerald-400/20 bg-emerald-500/10 text-emerald-200"
                  themeMode={themeMode}
                />
                <AnalysisCard
                  title="字段完整度"
                  value={`${analysisSnapshot.completeness}%`}
                  caption="单位、地区、公告类型都已识别的样本占比。"
                  icon={Activity}
                  tone="border-amber-300/20 bg-amber-400/10 text-amber-200"
                  themeMode={themeMode}
                />
              </div>
            </section>

            <section className="grid gap-5 2xl:grid-cols-[1.15fr_0.85fr]">
              <TrendPanel
                title="近 7 天机会走势"
                subtitle="把新机会、前置信号、已截止和优先跟进池拆开看，避免只盯总量。"
                points={trendPoints}
                themeMode={themeMode}
              />
              <ReadoutPanel
                title="业务化解读"
                subtitle="把预算、地区、BIM 类型和机会结构翻译成更容易做决策的话。"
                items={businessReadouts}
                themeMode={themeMode}
              />
            </section>

            <section className="grid gap-5 xl:grid-cols-2">
              <DataBars title="公告阶段" subtitle="先分清正式可投标、前置信号、变更复核和归档信息。" data={stageBuckets} tone="bg-[linear-gradient(90deg,#22d3ee,#14b8a6)]" themeMode={themeMode} />
              <DataBars title="来源贡献" subtitle="看哪几个来源在稳定产出项目。" data={sourceShare} tone="bg-[linear-gradient(90deg,#22d3ee,#38bdf8)]" themeMode={themeMode} />
              <DataBars title="地区分布" subtitle="当前筛选条件下，项目主要集中在哪些城市。" data={regionBuckets} tone="bg-[linear-gradient(90deg,#f59e0b,#f97316)]" themeMode={themeMode} />
            </section>

            <section className="grid gap-5 xl:grid-cols-3">
              <DataBars title="预算区间" subtitle="帮助快速判断商机体量。" data={budgetBuckets} tone="bg-[linear-gradient(90deg,#34d399,#10b981)]" themeMode={themeMode} />
              <DataBars title="截止时间" subtitle="优先看到哪些项目快到节点。" data={deadlineBuckets} tone="bg-[linear-gradient(90deg,#fb7185,#ef4444)]" themeMode={themeMode} />
              <DataBars title="BIM 类型" subtitle="看监控结果更偏设计、施工还是全过程。" data={typeBuckets} tone="bg-[linear-gradient(90deg,#c084fc,#8b5cf6)]" themeMode={themeMode} />
            </section>

            <RunsPanel runs={opsSummary?.recentRuns || []} themeMode={themeMode} />

          </div>
        )}

        {activeTab === 'keywords' && (
          <div className="grid gap-6 xl:grid-cols-[1.1fr_1.4fr]">
            <section className={cn(
              'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
              themeMode === 'light' ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
            )}>
              <div className="mb-5">
                <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/75">Keyword Ops</p>
                <h2 className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>监控词配置</h2>
                <p className={cn('mt-2 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>这里先保留轻量维护方式，后续我们再做来源级模板和分组管理。</p>
              </div>

              <form onSubmit={handleAddKeyword} className={cn(
                'rounded-[24px] border p-4',
                themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/10 bg-[#101427]'
              )}>
                <label className={cn('text-sm', themeMode === 'light' ? 'text-slate-700' : 'text-slate-300')}>新增 BIM 监控词</label>
                <div className="mt-3 flex gap-3">
                  <input
                    value={newKeyword}
                    onChange={event => setNewKeyword(event.target.value)}
                    placeholder="例如：BIM机电深化设计"
                    className={cn(
                      'min-w-0 flex-1 rounded-2xl border px-4 py-3 text-sm outline-none placeholder:text-slate-500',
                      themeMode === 'light'
                        ? 'border-slate-200 bg-white text-slate-900 focus:border-cyan-300'
                        : 'border-white/10 bg-white/5 text-white focus:border-cyan-300/35'
                    )}
                  />
                  <button type="submit" className="rounded-2xl bg-[linear-gradient(135deg,#10b981,#14b8a6)] px-4 py-3 text-sm font-medium text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-not-allowed disabled:opacity-60">添加</button>
                </div>
              </form>

              <div className={cn(
                'mt-5 rounded-[24px] border p-4 text-sm',
                themeMode === 'light' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-[#101427] text-slate-400'
              )}>
                <div className={cn('flex items-center gap-2', themeMode === 'light' ? 'text-slate-900' : 'text-slate-200')}><ShieldCheck className="h-4 w-4 text-emerald-300" /> 当前活跃监控词 {keywords.filter(item => item.isActive).length} 个</div>
                <p className="mt-2 leading-6">建议把业务常用词拆成“设计 / 咨询 / 深化 / 施工 / 交付”等层级，后面做报表会更清晰。</p>
              </div>
            </section>

            <section className={cn(
              'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
              themeMode === 'light' ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
            )}>
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h3 className={cn('text-xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>关键词清单</h3>
                  <p className={cn('mt-1 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>先保证监控词库干净、明确、可解释。</p>
                </div>
                <div className={cn('rounded-full border px-3 py-1.5 text-xs', themeMode === 'light' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-white/10 bg-white/5 text-slate-400')}>共 {keywords.length} 项</div>
              </div>
              <div className="space-y-3">
                {keywords.map(item => (
                  <div key={item.id} className={cn(
                    'flex flex-col gap-3 rounded-[24px] border p-4 sm:flex-row sm:items-center sm:justify-between',
                    themeMode === 'light' ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-[#101427]'
                  )}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={cn('text-base font-medium', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>{item.text}</span>
                        <span className={cn('rounded-full px-2.5 py-1 text-xs', item.isActive
                          ? (themeMode === 'light' ? 'bg-emerald-50 text-emerald-700' : 'bg-emerald-500/12 text-emerald-200')
                          : (themeMode === 'light' ? 'bg-slate-200 text-slate-600' : 'bg-slate-500/12 text-slate-400'))}>
                          {item.isActive ? '启用中' : '已暂停'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">创建于 {formatDateTime(item.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleToggleKeyword(item.id)} className={cn(
                        'rounded-full border px-3 py-2 text-sm transition',
                        themeMode === 'light' ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent'
                      )}>
                        {item.isActive ? '暂停' : '启用'}
                      </button>
                      <button onClick={() => handleDeleteKeyword(item.id)} className={cn(
                        'rounded-full border px-3 py-2 text-sm transition',
                        themeMode === 'light' ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent' : 'border-red-400/15 bg-red-500/8 text-red-200 hover:bg-red-500/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent'
                      )}>
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
            <section className={cn(
              'rounded-[32px] border p-6 shadow-[0_24px_100px_rgba(0,0,0,0.3)]',
              themeMode === 'light' ? 'border-slate-200 bg-white/92' : 'border-white/10 bg-white/[0.04]'
            )}>
              <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-fuchsia-300/75">Exploration</p>
                  <h2 className={cn('mt-2 text-2xl font-semibold', themeMode === 'light' ? 'text-slate-900' : 'text-white')}>临时搜索工作台</h2>
                  <p className={cn('mt-2 text-sm', themeMode === 'light' ? 'text-slate-500' : 'text-slate-400')}>适合验证一个新词有没有量，再决定要不要加进监控库。</p>
                </div>
                <form onSubmit={handleSearch} className="flex w-full max-w-2xl gap-3">
                  <input
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="输入关键词，例如：BIM正向设计"
                    className={cn(
                      'min-w-0 flex-1 rounded-2xl border px-4 py-3 text-sm outline-none placeholder:text-slate-500',
                      themeMode === 'light'
                        ? 'border-slate-200 bg-white text-slate-900 focus:border-cyan-300'
                        : 'border-white/10 bg-[#101427] text-white focus:border-cyan-300/35'
                    )}
                  />
                  <button type="submit" className="inline-flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#8b5cf6,#ec4899)] px-5 py-3 text-sm font-medium text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-not-allowed disabled:opacity-60">
                    <FileSearch className="h-4 w-4" /> 搜索
                  </button>
                </form>
              </div>
              {directSearchSuggestions.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500">快速词</span>
                  {directSearchSuggestions.slice(0, 6).map((item) => (
                    <button
                      key={`direct-${item}`}
                      onClick={() => setSearchQuery(item)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition',
                        themeMode === 'light' ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/10'
                      )}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              )}
              <FilterSortBar
                filters={searchFilters}
                onChange={setSearchFilters}
                keywords={keywords}
                themeMode={themeMode}
                searchSuggestions={manualSearchSuggestions}
                recentSearches={manualRecentSearches}
                onClearRecentSearches={handleClearManualRecentSearches}
                onSelectSearch={(value) => setSearchFilters((prev) => ({ ...prev, searchText: value }))}
                collapseStorageKey="bim-tender-manual-filter-collapsed"
              />
            </section>

            <section className="space-y-4">
              {filteredSearchResults.map(item => (
                <HotspotCard
                  key={item.id}
                  hotspot={item}
                  onOpenDetail={handleOpenHotspotDetail}
                  searchText={searchFilters.searchText}
                  themeMode={themeMode}
                />
              ))}
              {filteredSearchResults.length === 0 && (
                <div className={cn(
                  'rounded-[28px] border border-dashed p-10 text-center',
                  themeMode === 'light' ? 'border-slate-200 bg-white text-slate-500' : 'border-white/10 bg-white/[0.03] text-slate-500'
                )}>
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

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSubmittingLogin, setIsSubmittingLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    setIsCheckingSession(true);
    try {
      const nextSession = await authApi.getSession();
      if (nextSession.authenticated) {
        setSession(nextSession);
        setAuthError(null);
      } else {
        setSession(null);
      }
    } catch {
      setSession(null);
    } finally {
      setIsCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    const handleAuthRequired = () => {
      disconnectSocket();
      setSession(null);
      setAuthError('登录已失效，请重新登录。');
      setIsCheckingSession(false);
    };

    window.addEventListener('auth:required', handleAuthRequired as EventListener);
    return () => {
      window.removeEventListener('auth:required', handleAuthRequired as EventListener);
      disconnectSocket();
    };
  }, []);

  const handleLogin = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '');

    if (!username || !password) {
      setAuthError('请输入用户名和密码。');
      return;
    }

    setIsSubmittingLogin(true);
    try {
      const nextSession = await authApi.login(username, password);
      setSession(nextSession);
      setAuthError(null);
      disconnectSocket();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败，请稍后重试。');
      setSession(null);
    } finally {
      setIsSubmittingLogin(false);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      setSession(null);
      setAuthError(null);
    }
  }, []);

  if (isCheckingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#07111f] text-slate-300">
        <div className="rounded-[28px] border border-white/10 bg-[#0b1324]/92 px-6 py-5 text-sm shadow-[0_20px_70px_rgba(0,0,0,0.32)]">
          正在校验登录状态…
        </div>
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <LoginScreen
        isSubmitting={isSubmittingLogin}
        errorMessage={authError}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <DashboardApp
      authUser={session.username || 'admin'}
      onLogout={handleLogout}
    />
  );
}

export default App;
