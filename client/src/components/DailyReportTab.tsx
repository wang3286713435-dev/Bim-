import { useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, FileStack, RefreshCw, Sparkles, Newspaper, Clock3, Filter, ChevronDown, Search, Pin, Radar } from 'lucide-react';
import { cn } from '../lib/utils';
import type { DailyArticle, DailyHealthStatus, DailyKeyword, DailyOverviewSnapshot, DailyReport } from '../services/api';
import { formatDateTime, relativeTime } from '../utils/relativeTime';

type ThemeMode = 'dark' | 'light';

type DailyReportTabProps = {
  themeMode: ThemeMode;
  overview: DailyOverviewSnapshot | null;
  reports: DailyReport[];
  selectedReport: DailyReport | null;
  articles: DailyArticle[];
  keywords: DailyKeyword[];
  selectedSource: string;
  selectedKeyword: string;
  searchText: string;
  health: DailyHealthStatus | null;
  isLoading: boolean;
  isRunning: boolean;
  isPushingFeishu: boolean;
  onSelectReport: (reportId: string) => void;
  onSelectSource: (sourceId: string) => void;
  onSelectKeyword: (keywordSlug: string) => void;
  onSearchTextChange: (searchText: string) => void;
  onOpenOverviewItem: (reportId: string) => void;
  onRunReport: () => Promise<void>;
  onPushFeishu: (reportId: string) => Promise<void>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitSearchTerms(value: string): string[] {
  return value
    .split(/[\s,，、；;|]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderHighlightedByTerms(text: string, terms: string[], className: string): ReactNode {
  const filteredTerms = terms.map((item) => item.trim()).filter(Boolean);
  if (!text || filteredTerms.length === 0) return text;
  const pattern = new RegExp(`(${filteredTerms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    filteredTerms.some((term) => part.toLowerCase() === term.toLowerCase())
      ? <mark key={`${part}-${index}`} className={cn('rounded px-1 py-0.5 font-medium', className)}>{part}</mark>
      : <span key={`${part}-${index}`}>{part}</span>
  ));
}

function getSelectedTerms(keywords: DailyKeyword[], selectedKeyword: string): string[] {
  const keyword = keywords.find((item) => item.slug === selectedKeyword);
  if (!keyword) return [];
  return [keyword.label, ...keyword.aliases];
}

function getCombinedHighlightTerms(keywords: DailyKeyword[], selectedKeyword: string, searchText: string): string[] {
  return Array.from(new Set([
    ...getSelectedTerms(keywords, selectedKeyword),
    ...splitSearchTerms(searchText),
  ].map((item) => item.trim()).filter(Boolean)));
}

function matchesSearch(text: string, searchTerms: string[]): boolean {
  if (searchTerms.length === 0) return true;
  const haystack = text.toLowerCase();
  return searchTerms.every((term) => haystack.includes(term.toLowerCase()));
}

function filterSections(report: DailyReport | null, selectedSource: string, selectedKeyword: string, searchText: string) {
  if (!report) return [];
  const searchTerms = splitSearchTerms(searchText);
  return report.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const sourceMatch = !selectedSource || item.sourceId === selectedSource;
        const keywordMatch = !selectedKeyword || item.matchedKeywords.some((hit) => hit.slug === selectedKeyword);
        const searchMatch = matchesSearch(
          [
            item.title,
            item.excerpt,
            item.summary,
            item.sourceName,
            item.keywordHitPreview,
            ...item.matchedKeywords.map((hit) => `${hit.label} ${hit.slug}`),
          ].filter(Boolean).join('\n'),
          searchTerms
        );
        return sourceMatch && keywordMatch && searchMatch;
      })
    }))
    .filter((section) => section.items.length > 0);
}

function filterOverviewItems(overview: DailyOverviewSnapshot | null, selectedKeyword: string, searchText: string) {
  if (!overview) return [];
  const searchTerms = splitSearchTerms(searchText);
  return overview.items.filter((item) => {
    const keywordMatch = !selectedKeyword || item.matchedKeywords.some((keyword) => keyword.slug === selectedKeyword);
    const searchMatch = matchesSearch(
      [
        item.title,
        item.summary,
        item.reason,
        item.sourceNames.join(' '),
        item.matchedKeywords.map((keyword) => keyword.label).join(' '),
      ].join('\n'),
      searchTerms
    );
    return keywordMatch && searchMatch;
  });
}

function getRecencyMeta(bucket: 'today' | 'recent' | 'watch' | undefined, isLight: boolean) {
  if (bucket === 'today') {
    return {
      label: '今日新增',
      tone: isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'
    };
  }
  if (bucket === 'recent') {
    return {
      label: '近 3 日补充',
      tone: isLight ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-300/20 bg-amber-500/10 text-amber-100'
    };
  }
  return {
    label: '延续关注',
    tone: isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.05] text-slate-200'
  };
}

function getOverviewTone(importance: 'critical' | 'high' | 'watch', isLight: boolean) {
  if (importance === 'critical') {
    return isLight
      ? 'border-rose-200 bg-rose-50 text-rose-700'
      : 'border-rose-300/25 bg-rose-500/12 text-rose-100';
  }
  if (importance === 'high') {
    return isLight
      ? 'border-cyan-200 bg-cyan-50 text-cyan-800'
      : 'border-cyan-300/25 bg-cyan-500/12 text-cyan-100';
  }
  return isLight
    ? 'border-slate-200 bg-slate-50 text-slate-700'
    : 'border-white/10 bg-white/[0.04] text-slate-200';
}

function getOverviewStatusLabel(status: 'new' | 'persistent' | 'watch') {
  if (status === 'persistent') return '持续关注';
  if (status === 'new') return '最新焦点';
  return '观察信号';
}

export default function DailyReportTab({
  themeMode,
  overview,
  reports,
  selectedReport,
  articles,
  keywords,
  selectedSource,
  selectedKeyword,
  searchText,
  health,
  isLoading,
  isRunning,
  isPushingFeishu,
  onSelectReport,
  onSelectSource,
  onSelectKeyword,
  onSearchTextChange,
  onOpenOverviewItem,
  onRunReport,
  onPushFeishu
}: DailyReportTabProps) {
  const isLight = themeMode === 'light';
  const highlightTerms = useMemo(() => getCombinedHighlightTerms(keywords, selectedKeyword, searchText), [keywords, selectedKeyword, searchText]);
  const sections = useMemo(() => filterSections(selectedReport, selectedSource, selectedKeyword, searchText), [selectedReport, selectedSource, selectedKeyword, searchText]);
  const sourceOptions = health?.sources || [];
  const [showAppendix, setShowAppendix] = useState(false);
  const overviewItems = useMemo(() => filterOverviewItems(overview, selectedKeyword, searchText), [overview, selectedKeyword, searchText]);
  const criticalOverviewItems = overviewItems.filter((item) => item.importance === 'critical' || item.status === 'persistent');

  return (
    <div className="space-y-6">
      <section className={cn(
        'rounded-[28px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.18)]',
        isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.035]'
      )}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tracking-[0.18em] uppercase">
              <Radar className="h-3.5 w-3.5" />
              日报总览
            </div>
            <div>
              <h2 className={cn('text-3xl font-semibold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
                {overview?.title || 'BIM 日报总览正在准备中'}
              </h2>
              <p className={cn('mt-3 max-w-4xl text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
                {overview?.summary || '这里会由 agent 从多期日报中提炼最重要、最需要持续保留的 BIM 关键信号。'}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">持续重点</div>
              <div className="mt-2 text-2xl font-semibold">{criticalOverviewItems.length}</div>
              <div className="mt-1 text-xs text-slate-500">不会因为日报增多而被挤掉的重要内容</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">总览条目</div>
              <div className="mt-2 text-2xl font-semibold">{overviewItems.length}</div>
              <div className="mt-1 text-xs text-slate-500">已按时效性与重要程度重新排序</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">最近刷新</div>
              <div className="mt-2 text-sm font-medium">{overview?.generatedAt ? relativeTime(overview.generatedAt) : '暂无'}</div>
              <div className="mt-1 text-xs text-slate-500">{overview?.generatedAt ? formatDateTime(overview.generatedAt) : '等待日报生成'}</div>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <label className={cn(
              'flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm shadow-sm',
              isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200'
            )}>
              <Search className="h-4 w-4 text-cyan-300" />
              <input
                value={searchText}
                onChange={(event) => onSearchTextChange(event.target.value)}
                placeholder="搜索 BIM / 数字孪生 / Revit，查找相关日报与总览重点…"
                className={cn('w-full bg-transparent text-sm outline-none placeholder:text-slate-400', isLight ? 'text-slate-900' : 'text-white')}
              />
            </label>

            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {overviewItems.map((item) => {
                const tone = getOverviewTone(item.importance, isLight);
                return (
                  <div key={item.key} className={cn('rounded-[22px] border p-4', tone)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]">
                        <Pin className="h-3 w-3" />
                        {getOverviewStatusLabel(item.status)}
                      </span>
                      <span className="rounded-full border px-2.5 py-1 text-[11px]">
                        {item.importance === 'critical' ? '高优先' : item.importance === 'high' ? '重点' : '观察'}
                      </span>
                      <span className="text-[11px] opacity-80">{item.reportCount} 期提及</span>
                    </div>
                    <h3 className="mt-3 text-base font-semibold leading-7">
                      {renderHighlightedByTerms(item.title, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </h3>
                    <p className="mt-2 text-sm leading-6 opacity-90">
                      {renderHighlightedByTerms(item.summary, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </p>
                    <p className="mt-3 text-xs leading-5 opacity-80">
                      {renderHighlightedByTerms(item.reason, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.matchedKeywords.slice(0, 4).map((keyword) => (
                        <button
                          key={`${item.key}-${keyword.slug}`}
                          onClick={() => onSelectKeyword(keyword.slug)}
                          className={cn('rounded-full border px-2.5 py-1 text-[11px] transition', isLight ? 'border-white/70 bg-white text-slate-700 hover:border-cyan-200' : 'border-white/10 bg-white/[0.06] text-slate-100 hover:border-cyan-300/30')}
                        >
                          {keyword.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-3 text-xs opacity-80">
                      <div>
                        首次 {item.firstSeenDateLabel}<br />最近 {item.lastSeenDateLabel}
                      </div>
                      <button
                        onClick={() => onOpenOverviewItem(item.reportIds[0] || '')}
                        className={cn('inline-flex items-center gap-1 rounded-full border px-3 py-1.5 font-medium transition', isLight ? 'border-white/80 bg-white text-slate-700 hover:text-cyan-700' : 'border-white/10 bg-white/[0.08] text-slate-50 hover:text-cyan-100')}
                      >
                        打开关联日报
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {overviewItems.length === 0 && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm lg:col-span-2 xl:col-span-3', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  当前搜索条件下没有命中的总览重点，可以换一个关键词，或先查看完整日报历史。
                </div>
              )}
            </div>
          </div>

          <div className={cn('rounded-[24px] border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/10 bg-white/[0.04]')}>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-300" />
              <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>搜索结果摘要</h3>
            </div>
            <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
              {searchText.trim()
                ? `当前按“${searchText.trim()}”筛出 ${reports.length} 期相关日报，便于快速回看该主题在不同日期里的变化。`
                : '在这里输入关键词，我们会从日报标题、管理层摘要、原始资讯与命中关键词里找出相关日报。'}
            </p>
            <div className="mt-4 space-y-3 text-sm">
              <div className={cn('rounded-2xl border px-4 py-3', isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/[0.05] text-slate-200')}>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">相关日报</div>
                <div className="mt-2 text-2xl font-semibold">{reports.length}</div>
              </div>
              <div className={cn('rounded-2xl border px-4 py-3', isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/[0.05] text-slate-200')}>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">重点总览命中</div>
                <div className="mt-2 text-2xl font-semibold">{overviewItems.length}</div>
              </div>
              <div className={cn('rounded-2xl border px-4 py-3', isLight ? 'border-slate-200 bg-white text-slate-700' : 'border-white/10 bg-white/[0.05] text-slate-200')}>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">当前附录条目</div>
                <div className="mt-2 text-2xl font-semibold">{articles.length}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={cn(
        'rounded-[28px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.18)]',
        isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.035]'
      )}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tracking-[0.18em] uppercase">
              <Newspaper className="h-3.5 w-3.5" />
              BIM 日报
            </div>
            <div>
              <h2 className={cn('text-3xl font-semibold tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
                {selectedReport?.title || '今日 BIM 日报尚未生成'}
              </h2>
              <p className={cn('mt-3 max-w-3xl text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
                {selectedReport?.intro || '我们会每天自动汇总 BIM 行业政策、案例、软件与标准动态，并在这里展示综合日报。'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(selectedReport?.keywordStats || []).slice(0, 6).map((item) => (
                <button
                  key={item.slug}
                  onClick={() => onSelectKeyword(selectedKeyword === item.slug ? '' : item.slug)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    selectedKeyword === item.slug
                      ? (isLight ? 'border-cyan-300 bg-cyan-100 text-cyan-800' : 'border-cyan-300/35 bg-cyan-500/15 text-cyan-100')
                      : (isLight ? 'border-slate-200 bg-slate-50 text-slate-700 hover:border-cyan-200' : 'border-white/10 bg-white/[0.04] text-slate-200 hover:border-cyan-400/25')
                  )}
                >
                  {item.label} {item.count}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">收录来源</div>
              <div className="mt-2 text-2xl font-semibold">{selectedReport?.sourceCount ?? 0}</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">候选 / 入选</div>
              <div className="mt-2 text-2xl font-semibold">{selectedReport ? `${selectedReport.meta.candidateArticleCount} / ${selectedReport.articleCount}` : '0 / 0'}</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">最近生成</div>
              <div className="mt-2 text-sm font-medium">{selectedReport ? relativeTime(selectedReport.generatedAt) : '暂无'}</div>
              <div className="mt-1 text-xs text-slate-500">{selectedReport ? formatDateTime(selectedReport.generatedAt) : ''}</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">今日新增 / 延续</div>
              <div className="mt-2 text-sm font-medium">{selectedReport ? `${selectedReport.meta.freshArticleCount} / ${selectedReport.meta.supplementalArticleCount}` : '0 / 0'}</div>
              <div className="mt-1 text-xs text-slate-500">{isRunning ? '正在生成今日日报' : health?.latestRun?.completedAt ? formatDateTime(health.latestRun.completedAt) : '等待下一次调度'}</div>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <label className={cn('inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <Filter className="h-4 w-4 text-cyan-300" />
              <span>来源筛选</span>
              <select
                value={selectedSource}
                onChange={(event) => onSelectSource(event.target.value)}
                className={cn('bg-transparent text-sm outline-none', isLight ? 'text-slate-900' : 'text-white')}
              >
                <option value="">全部来源</option>
                {sourceOptions.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onSelectKeyword('')}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition',
                  !selectedKeyword
                    ? (isLight ? 'border-cyan-300 bg-cyan-100 text-cyan-800' : 'border-cyan-300/35 bg-cyan-500/15 text-cyan-100')
                    : (isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/[0.04] text-slate-300')
                )}
              >
                全部关键词
              </button>
              {keywords.map((item) => (
                <button
                  key={item.slug}
                  onClick={() => onSelectKeyword(item.slug)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    selectedKeyword === item.slug
                      ? (isLight ? 'border-cyan-300 bg-cyan-100 text-cyan-800' : 'border-cyan-300/35 bg-cyan-500/15 text-cyan-100')
                      : (isLight ? 'border-slate-200 bg-white text-slate-600 hover:border-cyan-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-cyan-400/25')
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => selectedReport && void onPushFeishu(selectedReport.id)}
              disabled={!selectedReport || isPushingFeishu}
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition',
                isLight ? 'border-slate-200 bg-white text-slate-700 hover:border-cyan-300 hover:text-cyan-700' : 'border-white/10 bg-white/[0.04] text-slate-200 hover:border-cyan-300/30',
                (!selectedReport || isPushingFeishu) && 'cursor-not-allowed opacity-60'
              )}
            >
              <ExternalLink className={cn('h-4 w-4', isPushingFeishu && 'animate-pulse')} />
              {isPushingFeishu ? '推送中…' : '推送到飞书'}
            </button>

            <button
              onClick={() => void onRunReport()}
              disabled={isRunning}
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-[0_18px_40px_rgba(14,165,233,0.18)] transition',
                isLight ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-cyan-500/90 text-slate-950 hover:bg-cyan-400',
                isRunning && 'cursor-wait opacity-70'
              )}
            >
              <RefreshCw className={cn('h-4 w-4', isRunning && 'animate-spin')} />
              {isRunning ? '生成中…' : '手动生成今日日报'}
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className={cn(
          'rounded-[24px] border p-4 shadow-[0_18px_60px_rgba(0,0,0,0.12)]',
          isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.03]'
        )}>
          <div className="flex items-center gap-2">
            <FileStack className="h-4 w-4 text-cyan-300" />
            <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>日报历史</h3>
          </div>
          <div className="mt-4 space-y-2">
            {reports.map((report) => {
              const active = selectedReport?.id === report.id;
              return (
                <button
                  key={report.id}
                  onClick={() => onSelectReport(report.id)}
                  className={cn(
                    'w-full rounded-2xl border px-3 py-3 text-left transition',
                    active
                      ? (isLight ? 'border-cyan-300 bg-cyan-50 text-cyan-900' : 'border-cyan-300/35 bg-cyan-500/12 text-cyan-50')
                      : (isLight ? 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/20')
                  )}
                >
                  <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{report.reportDateLabel || report.reportDate.slice(0, 10)}</div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium">
                    {renderHighlightedByTerms(report.title, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{report.articleCount} 条入选 · {report.meta.candidateArticleCount} 条候选</div>
                </button>
              );
            })}
            {reports.length === 0 && (
              <div className={cn('rounded-2xl border border-dashed px-4 py-6 text-sm text-center', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                当前搜索条件下没有找到相关日报
              </div>
            )}
          </div>
        </aside>

        <section className="space-y-6">
          <div className={cn(
            'rounded-[24px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.12)]',
            isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.03]'
          )}>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-300" />
              <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>管理层摘要</h3>
            </div>
            <p className={cn('mt-3 text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>
              {selectedReport?.executiveSummary || '当前还没有生成可阅读的日报正文。'}
            </p>

            {health?.latestPush ? (
              <div className={cn(
                'mt-4 rounded-2xl border px-4 py-3 text-sm',
                isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200'
              )}>
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">飞书推送</div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px]',
                    health.latestPush.status === 'sent'
                      ? (isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100')
                      : health.latestPush.status === 'failed'
                        ? (isLight ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-rose-300/20 bg-rose-500/10 text-rose-100')
                        : (isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/[0.03] text-slate-300')
                  )}>
                    {health.latestPush.status === 'sent' ? '已推送飞书' : health.latestPush.status === 'failed' ? '推送失败' : '未自动推送'}
                  </span>
                  <span className="text-xs text-slate-500">
                    {health.latestPush.pushedAt ? `最近推送：${formatDateTime(health.latestPush.pushedAt)}` : `最近记录：${formatDateTime(health.latestPush.createdAt)}`}
                  </span>
                  {health.latestPush.errorMessage ? (
                    <span className="text-xs text-rose-400">{health.latestPush.errorMessage}</span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {selectedReport?.highlights?.length ? (
              <div className="mt-5 grid gap-3 lg:grid-cols-2">
                {selectedReport.highlights.map((item, index) => (
                  <div
                    key={`${item}-${index}`}
                    className={cn(
                      'rounded-2xl border p-4',
                      isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200'
                    )}
                  >
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">今日重点 {index + 1}</div>
                    <p className="mt-2 text-sm leading-6">
                      {renderHighlightedByTerms(item, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}

            {selectedReport?.recommendedActions?.length ? (
              <div className="mt-5 rounded-2xl border p-4 lg:p-5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">建议跟踪</div>
                <div className="mt-3 grid gap-3 lg:grid-cols-3">
                  {selectedReport.recommendedActions.map((item, index) => (
                    <div
                      key={`${item}-${index}`}
                      className={cn(
                        'rounded-2xl border p-4',
                        isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200'
                      )}
                    >
                      <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">跟踪动作 {index + 1}</div>
                      <p className="mt-2 text-sm leading-6">
                        {renderHighlightedByTerms(item, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className={cn(
            'rounded-[24px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.12)]',
            isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.03]'
          )}>
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-cyan-300" />
              <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>当日报告正文</h3>
            </div>

            <div className="mt-5 space-y-5">
              {sections.map((section) => (
                <div key={section.title} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/10 bg-white/[0.03]')}>
                  <div className="flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-cyan-300" />
                    <h4 className={cn('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{section.title}</h4>
                  </div>
                  <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                    {renderHighlightedByTerms(section.summary, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                  </p>
                  <div className="mt-4 space-y-3">
                    {section.items.map((item) => {
                      const recency = getRecencyMeta(item.recencyBucket, isLight);
                      return (
                        <div key={`${section.title}-${item.url}`} className={cn('rounded-2xl border p-3', isLight ? 'border-slate-200 bg-white' : 'border-white/8 bg-white/[0.03]')}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/[0.04] text-slate-300')}>{item.sourceName}</span>
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', recency.tone)}>{recency.label}</span>
                                {item.matchedKeywords.map((hit) => (
                                  <span key={`${item.url}-${hit.keywordId}`} className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-cyan-300/20 bg-cyan-500/10 text-cyan-100')}>
                                    {hit.label} {hit.count}
                                  </span>
                                ))}
                              </div>
                              <h5 className={cn('mt-3 text-base font-semibold leading-7', isLight ? 'text-slate-900' : 'text-white')}>
                                {renderHighlightedByTerms(item.title, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                              </h5>
                              <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                                {renderHighlightedByTerms(item.summary || item.excerpt || '', highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                              </p>
                            </div>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition', isLight ? 'border-slate-200 bg-white text-slate-700 hover:text-cyan-700' : 'border-white/10 bg-white/[0.04] text-slate-200 hover:text-cyan-100')}
                            >
                              原文
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!selectedReport && !isLoading && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  尚未生成日报，先手动生成一次试试。
                </div>
              )}
              {selectedReport && sections.length === 0 && !isLoading && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  当前搜索或筛选条件下，这份日报没有命中的正文条目。
                </div>
              )}
            </div>
          </div>

          <details
            open={showAppendix}
            onToggle={(event) => setShowAppendix((event.currentTarget as HTMLDetailsElement).open)}
            className={cn(
              'rounded-[24px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.12)]',
              isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.03]'
            )}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileStack className="h-4 w-4 text-cyan-300" />
                  <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>来源附录</h3>
                </div>
                <p className={cn('mt-1 text-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
                  原始资讯用于追溯来源与后续飞书推送，默认收起，不占日报主视图。
                </p>
              </div>
              <ChevronDown className={cn('h-4 w-4 shrink-0 transition', showAppendix && 'rotate-180')} />
            </summary>

            <div className="mt-4 space-y-3">
              {articles.map((item) => {
                const recency = getRecencyMeta(item.recencyBucket, isLight);
                return (
                  <div key={item.id} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.03]')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/[0.04] text-slate-300')}>{item.sourceName}</span>
                      <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', recency.tone)}>{recency.label}</span>
                      {item.matchedKeywords.length > 0 ? item.matchedKeywords.map((hit) => (
                        <span key={`${item.id}-${hit.id}`} className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-cyan-300/20 bg-cyan-500/10 text-cyan-100')}>
                          {hit.label} {hit.count}
                        </span>
                      )) : (
                        <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-slate-200 bg-white text-slate-500' : 'border-white/10 bg-white/[0.04] text-slate-400')}>未命中关键词</span>
                      )}
                      <span className="text-xs text-slate-500">{item.publishedAt ? formatDateTime(item.publishedAt) : '发布时间待补齐'}</span>
                    </div>
                    <h4 className={cn('mt-3 text-base font-semibold leading-7', isLight ? 'text-slate-900' : 'text-white')}>
                      {renderHighlightedByTerms(item.title, highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </h4>
                    <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                      {renderHighlightedByTerms(item.summary || item.excerpt || '', highlightTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                    </p>
                    <div className="mt-3">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className={cn('inline-flex items-center gap-1 text-sm font-medium', isLight ? 'text-cyan-700' : 'text-cyan-200')}
                      >
                        打开原文
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
              {articles.length === 0 && !isLoading && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  当前筛选条件下暂无资讯条目。
                </div>
              )}
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
