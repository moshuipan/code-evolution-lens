import type { MetricsReport } from './metrics';
import { currentLanguage } from './l10n';

export type ListKey = 'directory' | 'topFiles' | 'attentionFiles' | 'coupling' | 'contributors' | 'providerFiles';
export type SortKey = 'name' | 'added' | 'rewritten' | 'rate' | 'retained' | 'commits' | 'churn' | 'ratio';
export interface ListView { search: string; sort: SortKey; limit: number; onlySamples: boolean }
export interface ViewAnchor { key: string; offset: number; focus?: string }
export interface ViewState {
  providerGroup: 'all' | 'ai' | 'unmarked' | 'unknown';
  providerSearch: string; providerSort: SortKey; selectedProvider?: string;
  expanded: string[]; events: string[]; weekFocus?: string; dailyDate?: string;
  lists: Record<ListKey, ListView>; anchor?: ViewAnchor;
}
export const LIST_KEYS: ListKey[] = ['directory', 'topFiles', 'attentionFiles', 'coupling', 'contributors', 'providerFiles'];
const SORT_KEYS: SortKey[] = ['name', 'added', 'rewritten', 'rate', 'retained', 'commits', 'churn', 'ratio'];
const collators = {
  'zh-cn': new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }),
  en: new Intl.Collator('en', { numeric: true, sensitivity: 'base' }),
};
const metricPages = new WeakMap<MetricsReport, Map<string, MetricsReport>>();

/** 名称相同的计数用路径自然排序；实体身份仅用于最终消除歧义。 */
export function naturalCompare(a: string, b: string): number { return collators[currentLanguage()].compare(a, b); }

/** 创建独立的展示状态，查询分页不改变统计范围或分母。 */
export function defaultView(): ViewState {
  return { providerGroup: 'all', providerSearch: '', providerSort: 'added', expanded: [], events: [],
    lists: Object.fromEntries(LIST_KEYS.map(key => [key, {
      search: '', sort: key === 'directory' ? 'rewritten' : key === 'contributors' || key === 'providerFiles' ? 'added'
        : key === 'coupling' ? 'commits' : 'churn', limit: key === 'directory' ? 100 : 30, onlySamples: false,
    }])) as Record<ListKey, ListView> };
}

/** 限制保存内容与大小；忽略未知字段，不让客户端保存对象路径或命令参数。 */
export function normalizeView(value: unknown): ViewState {
  const result = defaultView();
  if (!value || typeof value !== 'object') return result;
  const v = value as Partial<ViewState>;
  const text = (s: unknown, max = 500): string => typeof s === 'string' ? s.slice(0, max) : '';
  const ids = (items: unknown): string[] => Array.isArray(items)
    ? [...new Set(items.filter(x => typeof x === 'string' && x.length <= 500))].slice(0, 100) : [];
  if (['all', 'ai', 'unmarked', 'unknown'].includes(v.providerGroup ?? '')) result.providerGroup = v.providerGroup!;
  result.providerSearch = text(v.providerSearch);
  if (SORT_KEYS.includes(v.providerSort!)) result.providerSort = v.providerSort!;
  result.selectedProvider = text(v.selectedProvider) || undefined;
  result.weekFocus = text(v.weekFocus) || undefined;
  result.dailyDate = /^\d{4}-\d{2}-\d{2}$/.test(text(v.dailyDate)) ? v.dailyDate : undefined;
  result.expanded = ids(v.expanded); result.events = ids(v.events);
  for (const key of LIST_KEYS) {
    const list = v.lists?.[key];
    if (!list || typeof list !== 'object') continue;
    result.lists[key] = { search: text(list.search), sort: SORT_KEYS.includes(list.sort) ? list.sort : result.lists[key].sort,
      limit: Number.isInteger(list.limit) ? Math.min(10000, Math.max(1, list.limit)) : result.lists[key].limit,
      onlySamples: list.onlySamples === true };
  }
  if (v.anchor && typeof v.anchor.key === 'string' && Number.isFinite(v.anchor.offset)) {
    result.anchor = { key: text(v.anchor.key), offset: Math.min(10000, Math.max(-10000, v.anchor.offset)),
      focus: text(v.anchor.focus, 2000) || undefined };
  }
  return result;
}

/** 先搜索与排序完整集合，再分页；统计汇总由调用方保留原值。 */
export function queryList<T>(items: T[], view: ListView, name: (item: T) => string,
  score: (item: T, sort: SortKey) => number | undefined, hasSample: (item: T) => boolean = () => true): { rows: T[]; total: number; matching: number } {
  const needle = view.search.trim().toLocaleLowerCase();
  const matching = items.filter(item => (!needle || name(item).toLocaleLowerCase().includes(needle))
    && (!view.onlySamples || hasSample(item))).sort((a, b) => {
    if (view.sort !== 'name') {
      const av = score(a, view.sort), bv = score(b, view.sort);
      if (av === undefined && bv !== undefined) return 1;
      if (av !== undefined && bv === undefined) return -1;
      if (av !== undefined && bv !== undefined && av !== bv) return bv - av;
    }
    return naturalCompare(name(a), name(b));
  });
  return { rows: matching.slice(0, view.limit), total: items.length, matching: matching.length };
}

/** 只投影列表，Provider 与全期活动汇总始终使用全部样本。 */
export function projectMetrics(base: MetricsReport, view: ViewState): MetricsReport {
  const key = JSON.stringify([currentLanguage(), view.lists, view.selectedProvider]);
  const cache = metricPages.get(base) ?? new Map<string, MetricsReport>();
  const cached = cache.get(key);
  if (cached) return cached;
  const result = { ...base, lists: {} as MetricsReport['lists'] };
  for (const key of ['topFiles', 'attentionFiles', 'coupling', 'contributors', 'providerFiles'] as const) {
    const items = key === 'providerFiles' ? base.providerFiles.filter(p => p.providerId === view.selectedProvider) : base[key];
    const page = queryList<any>(items, view.lists[key], item => item.path ?? item.name ?? `${item.left} ${item.right}`, (item, sort) => {
      if (sort === 'churn') return item.added + item.deleted;
      if (sort === 'rate') return item.complete && item.mature ? item.rewritten / item.mature : undefined;
      return item[sort];
    });
    (result[key] as unknown[]) = page.rows;
    result.lists[key] = { total: page.total, matching: page.matching, visible: page.rows.length };
  }
  cache.set(key, result);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  metricPages.set(base, cache);
  return result;
}
