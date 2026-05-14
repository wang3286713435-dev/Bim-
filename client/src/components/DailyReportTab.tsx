import type { ReactNode } from 'react';
import { ExternalLink, FileStack, RefreshCw, Sparkles, Newspaper, Clock3, Filter } from 'lucide-react';
import { cn } from '../lib/utils';
import type { DailyArticle, DailyHealthStatus, DailyKeyword, DailyReport } from '../services/api';
import { formatDateTime, relativeTime } from '../utils/relativeTime';

type ThemeMode = 'dark' | 'light';

type DailyReportTabProps = {
  themeMode: ThemeMode;
  reports: DailyReport[];
  selectedReport: DailyReport | null;
  articles: DailyArticle[];
  keywords: DailyKeyword[];
  selectedSource: string;
  selectedKeyword: string;
  health: DailyHealthStatus | null;
  isLoading: boolean;
  isRunning: boolean;
  onSelectReport: (reportId: string) => void;
  onSelectSource: (sourceId: string) => void;
  onSelectKeyword: (keywordSlug: string) => void;
  onRunReport: () => Promise<void>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function filterSections(report: DailyReport | null, selectedSource: string, selectedKeyword: string) {
  if (!report) return [];
  return report.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const sourceMatch = !selectedSource || item.sourceId === selectedSource;
        const keywordMatch = !selectedKeyword || item.matchedKeywords.some((hit) => hit.slug === selectedKeyword);
        return sourceMatch && keywordMatch;
      })
    }))
    .filter((section) => section.items.length > 0);
}

export default function DailyReportTab({
  themeMode,
  reports,
  selectedReport,
  articles,
  keywords,
  selectedSource,
  selectedKeyword,
  health,
  isLoading,
  isRunning,
  onSelectReport,
  onSelectSource,
  onSelectKeyword,
  onRunReport
}: DailyReportTabProps) {
  const isLight = themeMode === 'light';
  const selectedTerms = getSelectedTerms(keywords, selectedKeyword);
  const sections = filterSections(selectedReport, selectedSource, selectedKeyword);
  const sourceOptions = health?.sources || [];

  return (
    <div className="space-y-6">
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
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">资讯条数</div>
              <div className="mt-2 text-2xl font-semibold">{selectedReport?.articleCount ?? 0}</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">最近生成</div>
              <div className="mt-2 text-sm font-medium">{selectedReport ? relativeTime(selectedReport.generatedAt) : '暂无'}</div>
              <div className="mt-1 text-xs text-slate-500">{selectedReport ? formatDateTime(selectedReport.generatedAt) : ''}</div>
            </div>
            <div className={cn('rounded-2xl border px-4 py-3 text-sm', isLight ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-white/10 bg-white/[0.04] text-slate-200')}>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">任务状态</div>
              <div className="mt-2 text-sm font-medium">{isRunning ? '正在生成' : health?.latestRun?.status === 'completed' ? '已完成' : '待生成'}</div>
              <div className="mt-1 text-xs text-slate-500">{health?.latestRun?.completedAt ? formatDateTime(health.latestRun.completedAt) : '等待下一次调度'}</div>
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
                  <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{report.reportDate.slice(0, 10)}</div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium">{report.title}</div>
                  <div className="mt-2 text-xs text-slate-500">{report.articleCount} 条资讯 · {report.sourceCount} 个来源</div>
                </button>
              );
            })}
            {reports.length === 0 && (
              <div className={cn('rounded-2xl border border-dashed px-4 py-6 text-sm text-center', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                尚无日报历史
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
              <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>当日报告正文</h3>
            </div>
            <p className={cn('mt-3 text-sm leading-7', isLight ? 'text-slate-600' : 'text-slate-300')}>{selectedReport?.executiveSummary || '当前还没有生成可阅读的日报正文。'}</p>

            <div className="mt-5 space-y-5">
              {sections.map((section) => (
                <div key={section.title} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/10 bg-white/[0.03]')}>
                  <div className="flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-cyan-300" />
                    <h4 className={cn('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{section.title}</h4>
                  </div>
                  <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>{renderHighlightedByTerms(section.summary, selectedTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}</p>
                  <div className="mt-4 space-y-3">
                    {section.items.map((item) => (
                      <div key={`${section.title}-${item.url}`} className={cn('rounded-2xl border p-3', isLight ? 'border-slate-200 bg-white' : 'border-white/8 bg-white/[0.03]')}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/[0.04] text-slate-300')}>{item.sourceName}</span>
                              {item.matchedKeywords.map((hit) => (
                                <span key={`${item.url}-${hit.keywordId}`} className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-cyan-300/20 bg-cyan-500/10 text-cyan-100')}>
                                  {hit.label} {hit.count}
                                </span>
                              ))}
                            </div>
                            <h5 className={cn('mt-3 text-base font-semibold leading-7', isLight ? 'text-slate-900' : 'text-white')}>
                              {renderHighlightedByTerms(item.title, selectedTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                            </h5>
                            <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                              {renderHighlightedByTerms(item.summary || item.excerpt || '', selectedTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
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
                    ))}
                  </div>
                </div>
              ))}
              {!selectedReport && !isLoading && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  尚未生成日报，先手动生成一次试试。
                </div>
              )}
            </div>
          </div>

          <div className={cn(
            'rounded-[24px] border p-5 shadow-[0_18px_60px_rgba(0,0,0,0.12)]',
            isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/[0.03]'
          )}>
            <div className="flex items-center gap-2">
              <FileStack className="h-4 w-4 text-cyan-300" />
              <h3 className={cn('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>原始资讯列表</h3>
            </div>
            <div className="mt-4 space-y-3">
              {articles.map((item) => (
                <div key={item.id} className={cn('rounded-2xl border p-4', isLight ? 'border-slate-200 bg-slate-50' : 'border-white/8 bg-white/[0.03]')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/[0.04] text-slate-300')}>{item.sourceName}</span>
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
                    {renderHighlightedByTerms(item.title, selectedTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
                  </h4>
                  <p className={cn('mt-2 text-sm leading-6', isLight ? 'text-slate-600' : 'text-slate-300')}>
                    {renderHighlightedByTerms(item.summary || item.excerpt || '', selectedTerms, isLight ? 'bg-amber-200 text-slate-900' : 'bg-amber-300/30 text-white')}
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
              ))}
              {articles.length === 0 && !isLoading && (
                <div className={cn('rounded-2xl border border-dashed px-4 py-8 text-center text-sm', isLight ? 'border-slate-200 text-slate-500' : 'border-white/10 text-slate-400')}>
                  当前筛选条件下暂无资讯条目。
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
