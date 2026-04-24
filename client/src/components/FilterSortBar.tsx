import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowUpDown, Filter, X, Clock, Flame, TrendingUp, Target, Search,
  ChevronDown, Check, RotateCcw
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { Keyword } from '../services/api';

export interface FilterState {
  searchText: string;
  searchMode: 'title' | 'fulltext';
  includeExpired: 'true' | 'false';
  source: string;
  importance: string;
  keywordId: string;
  timeRange: string;
  isReal: string;
  tenderType: string;
  tenderRegion: string;
  tenderMinBudgetWan: string;
  tenderDeadlineRange: string;
  tenderPlatform: string;
  sortBy: string;
  sortOrder: string;
}

export interface SavedFilterView {
  id: string;
  name: string;
  filters: FilterState;
}

export const defaultFilterState: FilterState = {
  searchText: '',
  searchMode: 'fulltext',
  includeExpired: 'true',
  source: '',
  importance: '',
  keywordId: '',
  timeRange: '',
  isReal: '',
  tenderType: '',
  tenderRegion: '',
  tenderMinBudgetWan: '',
  tenderDeadlineRange: '',
  tenderPlatform: '',
  sortBy: 'importance',
  sortOrder: 'desc',
};

interface FilterSortBarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  keywords: Keyword[];
  themeMode?: 'dark' | 'light';
  isSearchDebouncing?: boolean;
  searchSuggestions?: string[];
  recentSearches?: string[];
  onSelectSearch?: (value: string) => void;
  savedViews?: SavedFilterView[];
  onSaveView?: () => void;
  onApplyView?: (viewId: string) => void;
  onDeleteView?: (viewId: string) => void;
}

const SORT_OPTIONS = [
  { value: 'createdAt', label: '最新发现', icon: Clock },
  { value: 'publishedAt', label: '最新发布', icon: Clock },
  { value: 'importance', label: '重要程度', icon: Flame },
  { value: 'relevance', label: '相关性', icon: Target },
  { value: 'deadlineStatus', label: '截止状态', icon: TrendingUp },
];

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'szggzy', label: '深圳交易中心' },
  { value: 'szygcgpt', label: '深圳阳光采购' },
  { value: 'guangdong', label: '广东交易平台' },
  { value: 'gzebpubservice', label: '广州交易平台' },
  { value: 'ccgp', label: '中国政府采购网' },
  { value: 'ggzyNational', label: '全国交易平台' },
];

const IMPORTANCE_OPTIONS = [
  { value: '', label: '全部等级' },
  { value: 'urgent', label: '🔴 紧急', color: 'text-red-400' },
  { value: 'high', label: '🟠 高', color: 'text-orange-400' },
  { value: 'medium', label: '🟡 中', color: 'text-amber-400' },
  { value: 'low', label: '🟢 低', color: 'text-emerald-400' },
];

const TIME_RANGE_OPTIONS = [
  { value: '', label: '全部时间' },
  { value: '1h', label: '最近 1 小时' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

const REAL_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'true', label: '✅ 真实' },
  { value: 'false', label: '⚠️ 疑似虚假' },
];

const TENDER_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: '设计BIM', label: '设计BIM' },
  { value: '全过程BIM', label: '全过程BIM' },
  { value: '施工BIM', label: '施工BIM' },
  { value: '智慧CIM', label: '智慧CIM' },
  { value: '其他BIM', label: '其他BIM' },
];

const TENDER_REGION_OPTIONS = [
  { value: '', label: '全部地区' },
  { value: '深圳', label: '深圳' },
  { value: '广州', label: '广州' },
  { value: '佛山', label: '佛山' },
  { value: '东莞', label: '东莞' },
  { value: '珠海', label: '珠海' },
  { value: '中山', label: '中山' },
  { value: '惠州', label: '惠州' },
  { value: '广东', label: '广东全省' },
];

const TENDER_BUDGET_OPTIONS = [
  { value: '', label: '全部预算' },
  { value: '40', label: '≥ 40 万' },
  { value: '100', label: '≥ 100 万' },
  { value: '500', label: '≥ 500 万' },
  { value: '1000', label: '≥ 1000 万' },
];

const TENDER_DEADLINE_OPTIONS = [
  { value: '', label: '全部截止' },
  { value: 'open', label: '未过期' },
  { value: '7d', label: '7 天内截止' },
  { value: '30d', label: '30 天内截止' },
  { value: 'expired', label: '已过期' },
];

const TENDER_PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: '深圳公共资源交易中心', label: '深圳公共资源交易中心' },
  { value: '深圳阳光采购平台', label: '深圳阳光采购平台' },
  { value: '广东省公共资源交易平台', label: '广东省公共资源交易平台' },
  { value: '广州公共资源交易公共服务平台', label: '广州公共资源交易公共服务平台' },
  { value: '中国政府采购网', label: '中国政府采购网' },
  { value: '全国公共资源交易平台', label: '全国公共资源交易平台' },
];

function Dropdown({
  label,
  value,
  options,
  onChange,
  themeMode = 'dark',
}: {
  label: string;
  value: string;
  options: { value: string; label: string; color?: string }[];
  onChange: (v: string) => void;
  themeMode?: 'dark' | 'light';
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const isActive = value !== '';
  const isLight = themeMode === 'light';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap',
          isActive
            ? (isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-700' : 'border-blue-500/30 bg-blue-500/15 text-blue-400')
            : (isLight ? 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700' : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:text-slate-300')
        )}
      >
        <span>{isActive ? selected?.label : label}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.96 }}
              transition={{ duration: 0.15 }}
              className={cn(
                'absolute left-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl',
                isLight ? 'border-slate-200 bg-white/98' : 'border-white/10 bg-[#0d0d20]/98'
              )}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                    value === option.value
                      ? (isLight ? 'bg-cyan-50 text-cyan-700' : 'bg-blue-500/10 text-blue-400')
                      : (isLight ? 'text-slate-600 hover:bg-slate-50 hover:text-slate-900' : 'text-slate-400 hover:bg-white/5 hover:text-white')
                  )}
                >
                  {value === option.value && <Check className="h-3 w-3 shrink-0" />}
                  <span className={cn(option.color)}>{option.label}</span>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-400">
      {label}
      <button onClick={onRemove} className="transition-colors hover:text-slate-700">
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

export default function FilterSortBar({
  filters,
  onChange,
  keywords,
  themeMode = 'dark',
  isSearchDebouncing = false,
  searchSuggestions = [],
  recentSearches = [],
  onSelectSearch,
  savedViews = [],
  onSaveView,
  onApplyView,
  onDeleteView,
}: FilterSortBarProps) {
  const [showFilters, setShowFilters] = useState(false);
  const isLight = themeMode === 'light';

  const activeFilterCount = [
    filters.source,
    filters.searchText,
    filters.includeExpired === 'false' ? 'exclude-expired' : '',
    filters.importance,
    filters.keywordId,
    filters.timeRange,
    filters.isReal,
    filters.tenderType,
    filters.tenderRegion,
    filters.tenderMinBudgetWan,
    filters.tenderDeadlineRange,
    filters.tenderPlatform,
  ].filter((v) => v !== '').length;

  const hasNonDefaultSort = filters.sortBy !== 'importance';

  const update = (key: keyof FilterState, value: string) => {
    onChange({ ...filters, [key]: value });
  };

  const resetFilters = () => {
    onChange({ ...defaultFilterState });
  };

  const keywordOptions = [
    { value: '', label: '全部关键词' },
    ...keywords.filter((k) => k.isActive).map((k) => ({ value: k.id, label: k.text })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={cn(
            'flex min-w-[220px] flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm sm:max-w-sm',
            isLight
              ? 'border border-slate-200 bg-white text-slate-700 shadow-sm'
              : 'border border-white/10 bg-white/[0.04] text-slate-300'
          )}
        >
          <Search className={cn('h-4 w-4', isLight ? 'text-slate-400' : 'text-slate-500')} />
          <input
            value={filters.searchText}
            onChange={(event) => update('searchText', event.target.value)}
            placeholder="搜索项目名称、单位、项目编号..."
            className={cn(
              'w-full bg-transparent text-sm outline-none',
              isLight ? 'text-slate-800 placeholder:text-slate-400' : 'text-white placeholder:text-slate-500'
            )}
          />
          {filters.searchText && (
            <button
              onClick={() => update('searchText', '')}
              className={cn(
                'rounded-full p-1 transition',
                isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700' : 'text-slate-500 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className={cn('inline-flex items-center rounded-xl border p-1', isLight ? 'border-slate-200 bg-white shadow-sm' : 'border-white/10 bg-white/[0.03]')}>
          <button
            onClick={() => update('searchMode', 'fulltext')}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              filters.searchMode === 'fulltext'
                ? (isLight ? 'border-cyan-300 bg-cyan-50 text-cyan-700' : 'border-cyan-400/30 bg-cyan-500/12 text-cyan-200')
                : (isLight ? 'border-slate-200 bg-white text-slate-500 hover:text-slate-700' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200')
            )}
          >
            全文字段搜索
          </button>
          <button
            onClick={() => update('searchMode', 'title')}
            className={cn(
              'ml-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              filters.searchMode === 'title'
                ? (isLight ? 'border-cyan-300 bg-cyan-50 text-cyan-700' : 'border-cyan-400/30 bg-cyan-500/12 text-cyan-200')
                : (isLight ? 'border-slate-200 bg-white text-slate-500 hover:text-slate-700' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200')
            )}
          >
            仅标题搜索
          </button>
        </div>

        {isSearchDebouncing && filters.searchText && (
          <span className={cn('rounded-full border px-2.5 py-1 text-[11px]', isLight ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-400/20 bg-amber-500/10 text-amber-200')}>
            搜索输入处理中…
          </span>
        )}

        <div className={cn('flex items-center gap-1 rounded-xl border p-1', isLight ? 'border-slate-200 bg-white shadow-sm' : 'border-white/10 bg-white/[0.03]')}>
          <ArrowUpDown className={cn('ml-2 h-3.5 w-3.5', isLight ? 'text-slate-400' : 'text-slate-600')} />
          {SORT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                onClick={() => update('sortBy', opt.value)}
                className={cn(
                  'flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all whitespace-nowrap',
                  filters.sortBy === opt.value
                    ? (isLight ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm')
                    : (isLight ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200')
                )}
              >
                <Icon className="h-3 w-3" />
                {opt.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => update('includeExpired', filters.includeExpired === 'true' ? 'false' : 'true')}
          className={cn(
            'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all',
            filters.includeExpired === 'false'
              ? 'border-emerald-400/30 bg-emerald-500/12 text-emerald-300'
              : (isLight ? 'border-slate-200 bg-white text-slate-500 hover:text-slate-700' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200')
          )}
        >
          <Check className="h-3.5 w-3.5" />
          {filters.includeExpired === 'true' ? '展示已截止' : '隐藏已截止'}
        </button>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all',
            showFilters || activeFilterCount > 0
              ? 'border-blue-500/30 bg-blue-500/15 text-blue-400'
              : (isLight ? 'border-slate-200 bg-white text-slate-500 shadow-sm hover:text-slate-700' : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:text-slate-300')
          )}
        >
          <Filter className="h-3.5 w-3.5" />
          筛选
          {activeFilterCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>

        {(activeFilterCount > 0 || hasNonDefaultSort) && (
          <button
            onClick={resetFilters}
            className={cn('flex items-center gap-1 rounded-xl px-2.5 py-2 text-xs transition-colors', isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300')}
          >
            <RotateCcw className="h-3 w-3" />
            重置
          </button>
        )}

        {activeFilterCount > 0 && !showFilters && (
          <div className="flex flex-wrap items-center gap-1.5">
            {filters.source && <FilterTag label={SOURCE_OPTIONS.find((o) => o.value === filters.source)?.label || filters.source} onRemove={() => update('source', '')} />}
            {filters.includeExpired === 'false' && <FilterTag label="已隐藏已截止" onRemove={() => update('includeExpired', 'true')} />}
            {filters.importance && <FilterTag label={IMPORTANCE_OPTIONS.find((o) => o.value === filters.importance)?.label || filters.importance} onRemove={() => update('importance', '')} />}
            {filters.keywordId && <FilterTag label={keywords.find((k) => k.id === filters.keywordId)?.text || '关键词'} onRemove={() => update('keywordId', '')} />}
            {filters.timeRange && <FilterTag label={TIME_RANGE_OPTIONS.find((o) => o.value === filters.timeRange)?.label || filters.timeRange} onRemove={() => update('timeRange', '')} />}
            {filters.isReal && <FilterTag label={REAL_OPTIONS.find((o) => o.value === filters.isReal)?.label || '真实性'} onRemove={() => update('isReal', '')} />}
            {filters.tenderType && <FilterTag label={TENDER_TYPE_OPTIONS.find((o) => o.value === filters.tenderType)?.label || filters.tenderType} onRemove={() => update('tenderType', '')} />}
            {filters.tenderRegion && <FilterTag label={TENDER_REGION_OPTIONS.find((o) => o.value === filters.tenderRegion)?.label || filters.tenderRegion} onRemove={() => update('tenderRegion', '')} />}
            {filters.tenderMinBudgetWan && <FilterTag label={TENDER_BUDGET_OPTIONS.find((o) => o.value === filters.tenderMinBudgetWan)?.label || `≥ ${filters.tenderMinBudgetWan} 万`} onRemove={() => update('tenderMinBudgetWan', '')} />}
            {filters.tenderDeadlineRange && <FilterTag label={TENDER_DEADLINE_OPTIONS.find((o) => o.value === filters.tenderDeadlineRange)?.label || filters.tenderDeadlineRange} onRemove={() => update('tenderDeadlineRange', '')} />}
            {filters.tenderPlatform && <FilterTag label={TENDER_PLATFORM_OPTIONS.find((o) => o.value === filters.tenderPlatform)?.label || filters.tenderPlatform} onRemove={() => update('tenderPlatform', '')} />}
          </div>
        )}
      </div>

      {(searchSuggestions.length > 0 || recentSearches.length > 0 || savedViews.length > 0) && (
        <div className="space-y-2">
          {searchSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500">搜索建议</span>
              {searchSuggestions.slice(0, 6).map((item) => (
                <button
                  key={`suggest-${item}`}
                  onClick={() => onSelectSearch?.(item)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition',
                    isLight ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
          )}

          {recentSearches.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500">最近搜索</span>
              {recentSearches.slice(0, 6).map((item) => (
                <button
                  key={`recent-${item}`}
                  onClick={() => onSelectSearch?.(item)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition',
                    isLight ? 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/10'
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
          )}

          {(savedViews.length > 0 || onSaveView) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500">常用视图</span>
              {onSaveView && (
                <button
                  onClick={onSaveView}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    isLight ? 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100' : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15'
                  )}
                >
                  保存当前视图
                </button>
              )}
              {savedViews.slice(0, 6).map((view) => (
                <span
                  key={view.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs',
                    isLight ? 'border-slate-200 bg-white text-slate-600' : 'border-white/10 bg-white/[0.03] text-slate-300'
                  )}
                >
                  <button onClick={() => onApplyView?.(view.id)} className="transition hover:text-cyan-500">
                    {view.name}
                  </button>
                  {onDeleteView && (
                    <button onClick={() => onDeleteView(view.id)} className="transition hover:text-red-500">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className={cn('flex flex-wrap items-center gap-2 rounded-xl p-3', isLight ? 'border border-slate-200 bg-white/80 shadow-[0_12px_40px_rgba(15,23,42,0.08)]' : 'border border-white/5 bg-white/[0.02]')}>
              <Dropdown label="来源" value={filters.source} options={SOURCE_OPTIONS} onChange={(v) => update('source', v)} themeMode={themeMode} />
              <Dropdown label="重要程度" value={filters.importance} options={IMPORTANCE_OPTIONS} onChange={(v) => update('importance', v)} themeMode={themeMode} />
              <Dropdown label="关键词" value={filters.keywordId} options={keywordOptions} onChange={(v) => update('keywordId', v)} themeMode={themeMode} />
              <Dropdown label="时间" value={filters.timeRange} options={TIME_RANGE_OPTIONS} onChange={(v) => update('timeRange', v)} themeMode={themeMode} />
              <Dropdown label="真实性" value={filters.isReal} options={REAL_OPTIONS} onChange={(v) => update('isReal', v)} themeMode={themeMode} />
              <Dropdown label="BIM 类型" value={filters.tenderType} options={TENDER_TYPE_OPTIONS} onChange={(v) => update('tenderType', v)} themeMode={themeMode} />
              <Dropdown label="地区" value={filters.tenderRegion} options={TENDER_REGION_OPTIONS} onChange={(v) => update('tenderRegion', v)} themeMode={themeMode} />
              <Dropdown label="预算" value={filters.tenderMinBudgetWan} options={TENDER_BUDGET_OPTIONS} onChange={(v) => update('tenderMinBudgetWan', v)} themeMode={themeMode} />
              <Dropdown label="截止时间" value={filters.tenderDeadlineRange} options={TENDER_DEADLINE_OPTIONS} onChange={(v) => update('tenderDeadlineRange', v)} themeMode={themeMode} />
              <Dropdown label="平台" value={filters.tenderPlatform} options={TENDER_PLATFORM_OPTIONS} onChange={(v) => update('tenderPlatform', v)} themeMode={themeMode} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
