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

export const defaultFilterState: FilterState = {
  searchText: '',
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
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

interface FilterSortBarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  keywords: Keyword[];
}

const SORT_OPTIONS = [
  { value: 'createdAt', label: '最新发现', icon: Clock },
  { value: 'publishedAt', label: '最新发布', icon: Clock },
  { value: 'importance', label: '重要程度', icon: Flame },
  { value: 'relevance', label: '相关性', icon: Target },
  { value: 'hot', label: '热度综合', icon: TrendingUp },
];

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'szggzy', label: '深圳交易中心' },
  { value: 'szygcgpt', label: '深圳阳光采购' },
  { value: 'guangdong', label: '广东交易平台' },
  { value: 'gzebpubservice', label: '广州交易平台' },
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
  { value: '广州公共资源交易平台', label: '广州公共资源交易平台' },
];

// Dropdown component
function Dropdown({ 
  label, 
  value, 
  options, 
  onChange 
}: { 
  label: string; 
  value: string; 
  options: { value: string; label: string; color?: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(o => o.value === value);
  const isActive = value !== '';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap",
          isActive
            ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
            : "bg-white/5 text-slate-400 border border-white/10 hover:border-white/20 hover:text-slate-300"
        )}
      >
        <span>{isActive ? selected?.label : label}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
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
              className="absolute left-0 top-full mt-1 z-50 min-w-[160px] bg-[#0d0d20]/98 backdrop-blur-xl rounded-xl border border-white/10 shadow-2xl overflow-hidden"
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => { onChange(option.value); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left",
                    value === option.value
                      ? "bg-blue-500/10 text-blue-400"
                      : "text-slate-400 hover:bg-white/5 hover:text-white"
                  )}
                >
                  {value === option.value && <Check className="w-3 h-3 shrink-0" />}
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

export default function FilterSortBar({ filters, onChange, keywords }: FilterSortBarProps) {
  const [showFilters, setShowFilters] = useState(false);

  const activeFilterCount = [
    filters.source,
    filters.searchText,
    filters.importance,
    filters.keywordId,
    filters.timeRange,
    filters.isReal,
    filters.tenderType,
    filters.tenderRegion,
    filters.tenderMinBudgetWan,
    filters.tenderDeadlineRange,
    filters.tenderPlatform,
  ].filter(v => v !== '').length;

  const hasNonDefaultSort = filters.sortBy !== 'createdAt';

  const update = (key: keyof FilterState, value: string) => {
    onChange({ ...filters, [key]: value });
  };

  const resetFilters = () => {
    onChange({ ...defaultFilterState });
  };

  const keywordOptions = [
    { value: '', label: '全部关键词' },
    ...keywords.filter(k => k.isActive).map(k => ({ value: k.id, label: k.text })),
  ];

  return (
    <div className="space-y-3">
      {/* Main Bar: Sort + Filter Toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-300 sm:max-w-sm">
          <Search className="h-4 w-4 text-slate-500" />
          <input
            value={filters.searchText}
            onChange={(event) => update('searchText', event.target.value)}
            placeholder="搜索项目名称、单位、项目编号..."
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
          />
          {filters.searchText && (
            <button
              onClick={() => update('searchText', '')}
              className="rounded-full p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Sort Selector */}
        <div className="flex items-center gap-1 bg-white/[0.03] rounded-xl border border-white/5 p-1">
          <ArrowUpDown className="w-3.5 h-3.5 text-slate-600 ml-2" />
          {SORT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                onClick={() => update('sortBy', opt.value)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap",
                  filters.sortBy === opt.value
                    ? "bg-blue-500/15 text-blue-400 shadow-sm"
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                <Icon className="w-3 h-3" />
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Filter Toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all",
            showFilters || activeFilterCount > 0
              ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
              : "bg-white/5 text-slate-400 border border-white/10 hover:border-white/20"
          )}
        >
          <Filter className="w-3.5 h-3.5" />
          筛选
          {activeFilterCount > 0 && (
            <span className="w-4 h-4 rounded-full bg-blue-500 text-[10px] text-white flex items-center justify-center font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Reset */}
        {(activeFilterCount > 0 || hasNonDefaultSort) && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            重置
          </button>
        )}

        {/* Active Filter Tags */}
        {activeFilterCount > 0 && !showFilters && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {filters.source && (
              <FilterTag
                label={SOURCE_OPTIONS.find(o => o.value === filters.source)?.label || filters.source}
                onRemove={() => update('source', '')}
              />
            )}
            {filters.importance && (
              <FilterTag
                label={IMPORTANCE_OPTIONS.find(o => o.value === filters.importance)?.label || filters.importance}
                onRemove={() => update('importance', '')}
              />
            )}
            {filters.keywordId && (
              <FilterTag
                label={keywords.find(k => k.id === filters.keywordId)?.text || '关键词'}
                onRemove={() => update('keywordId', '')}
              />
            )}
            {filters.timeRange && (
              <FilterTag
                label={TIME_RANGE_OPTIONS.find(o => o.value === filters.timeRange)?.label || filters.timeRange}
                onRemove={() => update('timeRange', '')}
              />
            )}
            {filters.isReal && (
              <FilterTag
                label={REAL_OPTIONS.find(o => o.value === filters.isReal)?.label || '真实性'}
                onRemove={() => update('isReal', '')}
              />
            )}
            {filters.tenderType && (
              <FilterTag
                label={TENDER_TYPE_OPTIONS.find(o => o.value === filters.tenderType)?.label || filters.tenderType}
                onRemove={() => update('tenderType', '')}
              />
            )}
            {filters.tenderRegion && (
              <FilterTag
                label={TENDER_REGION_OPTIONS.find(o => o.value === filters.tenderRegion)?.label || filters.tenderRegion}
                onRemove={() => update('tenderRegion', '')}
              />
            )}
            {filters.tenderMinBudgetWan && (
              <FilterTag
                label={TENDER_BUDGET_OPTIONS.find(o => o.value === filters.tenderMinBudgetWan)?.label || `≥ ${filters.tenderMinBudgetWan} 万`}
                onRemove={() => update('tenderMinBudgetWan', '')}
              />
            )}
            {filters.tenderDeadlineRange && (
              <FilterTag
                label={TENDER_DEADLINE_OPTIONS.find(o => o.value === filters.tenderDeadlineRange)?.label || filters.tenderDeadlineRange}
                onRemove={() => update('tenderDeadlineRange', '')}
              />
            )}
            {filters.tenderPlatform && (
              <FilterTag
                label={TENDER_PLATFORM_OPTIONS.find(o => o.value === filters.tenderPlatform)?.label || filters.tenderPlatform}
                onRemove={() => update('tenderPlatform', '')}
              />
            )}
          </div>
        )}
      </div>

      {/* Expanded Filter Panel */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center gap-2 flex-wrap p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <Dropdown label="来源" value={filters.source} options={SOURCE_OPTIONS} onChange={(v) => update('source', v)} />
              <Dropdown label="重要程度" value={filters.importance} options={IMPORTANCE_OPTIONS} onChange={(v) => update('importance', v)} />
              <Dropdown label="关键词" value={filters.keywordId} options={keywordOptions} onChange={(v) => update('keywordId', v)} />
              <Dropdown label="时间" value={filters.timeRange} options={TIME_RANGE_OPTIONS} onChange={(v) => update('timeRange', v)} />
              <Dropdown label="真实性" value={filters.isReal} options={REAL_OPTIONS} onChange={(v) => update('isReal', v)} />
              <Dropdown label="BIM 类型" value={filters.tenderType} options={TENDER_TYPE_OPTIONS} onChange={(v) => update('tenderType', v)} />
              <Dropdown label="地区" value={filters.tenderRegion} options={TENDER_REGION_OPTIONS} onChange={(v) => update('tenderRegion', v)} />
              <Dropdown label="预算" value={filters.tenderMinBudgetWan} options={TENDER_BUDGET_OPTIONS} onChange={(v) => update('tenderMinBudgetWan', v)} />
              <Dropdown label="截止时间" value={filters.tenderDeadlineRange} options={TENDER_DEADLINE_OPTIONS} onChange={(v) => update('tenderDeadlineRange', v)} />
              <Dropdown label="平台" value={filters.tenderPlatform} options={TENDER_PLATFORM_OPTIONS} onChange={(v) => update('tenderPlatform', v)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-500/10 text-blue-400 text-[10px] font-medium border border-blue-500/20">
      {label}
      <button onClick={onRemove} className="hover:text-white transition-colors">
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}
