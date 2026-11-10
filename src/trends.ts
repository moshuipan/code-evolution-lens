import { Aggregate, Birth, FileEntity, LineOrigin, RewriteEvent, Snapshot, WINDOW } from './model';
import { WeekRange, weekRanges } from './time';
import { MetricsQuery, MetricsReport } from './metrics';
import { defaultView, naturalCompare, projectMetrics, queryList } from './view-state';

export interface ScopeNode {
  id: string; kind: 'repository' | 'directory' | 'file'; path: string; label: string;
  parent?: string; entity?: string; deleted?: boolean; excludedReason?: string;
}
export interface TrendPoint extends WeekRange { counts: Aggregate; pending: number }
export interface ScopeRow extends ScopeNode { counts: Aggregate; pending: number }
export interface EventRow {
  id: string; commit: string; time: number; ai: number; human: number;
  beforePath: string; beforeStart: number; beforeCount: number;
  afterPath?: string; afterStart: number; afterCount: number; current: boolean;
  signals: { kind: string; provider: string }[];
  origins: { mainlineCommit: string; mainlineTime: number; sourceCommit: string; sourceTime: number;
    sourcePath: string; sourceLine: number; count: number; kind: LineOrigin['kind'] }[];
}
export interface TrendReport {
  scope: ScopeNode; crumbs: ScopeNode[]; days: number; points: TrendPoint[]; summary: Aggregate;
  pending: number; selectedWeek?: string; children: ScopeRow[]; totalChildren: number;
  events: EventRow[]; totalEvents: number; rangeStart?: string; rangeEnd?: string;
  observedEnd?: string; nextReadyAt?: number; notices: string[];
  metrics: MetricsReport;
  matchingChildren: number;
}

/** 构造空计数，缺少样本与观察缺口分别表示。 */
export function emptyCounts(configured: boolean, complete = true): Aggregate {
  return { ai: 0, aiRewritten: 0, unmarked: 0, unmarkedRewritten: 0, unknown: 0, complete, configured };
}
/** 汇总互斥子集，完整性取交集，绝不平均百分比。 */
function addCounts(target: Aggregate, value: Aggregate): void {
  for (const key of ['ai', 'aiRewritten', 'unmarked', 'unmarkedRewritten', 'unknown'] as const) target[key] += value[key];
  target.complete &&= value.complete;
}
/** 以同一不可变快照提供当前目录结构、历史趋势与可回溯修改记录。 */
export class TrendQuery {
  readonly nodes = new Map<string, ScopeNode>();
  readonly entities = new Map<string, FileEntity>();
  private readonly childIds = new Map<string, string[]>();
  private readonly births = new Map<string, Birth>();
  private readonly events = new Map<string, RewriteEvent>();
  private readonly affected = new Set<string>();
  private readonly globalGap: boolean;
  private readonly reports = new Map<string, TrendReport>();
  private readonly metrics: MetricsQuery;
  /** 注册全部当前文件和有样本的已删除文件，不依赖分母非零才建立导航。 */
  constructor(readonly snapshot: Snapshot) {
    this.metrics = new MetricsQuery(snapshot);
    this.nodes.set('repo', { id: 'repo', kind: 'repository', path: '', label: '整个仓库' });
    for (const e of snapshot.entities) {
      this.entities.set(e.entity, e);
      const pathParts = e.path.split('/');
      let parent = 'repo';
      for (let depth = 1; depth < pathParts.length; depth++) {
        const path = pathParts.slice(0, depth).join('/'), id = `dir:${path}`;
        if (!this.nodes.has(id)) this.register({ id, kind: 'directory', path, label: pathParts[depth - 1], parent });
        parent = id;
      }
      this.register({ id: `file:${e.entity}`, kind: 'file', path: e.path, label: pathParts.at(-1)!,
        parent, entity: e.entity, deleted: e.deleted, excludedReason: e.excludedReason });
    }
    for (const b of snapshot.births) this.births.set(b.id, b);
    for (const e of snapshot.events) this.events.set(e.id, e);
    this.globalGap = snapshot.completeness === 'invalid' || snapshot.gaps.some(g => !g.entity);
    for (const gap of snapshot.gaps) {
      if (!gap.entity) continue;
      for (const id of gap.birthIds ?? snapshot.births.filter(b => b.entity === gap.entity).map(b => b.id)) {
        const b = this.births.get(id);
        if (b && (gap.time === undefined || gap.time <= b.time + WINDOW)) this.affected.add(id);
      }
    }
  }
  /** 注册有父节点的唯一范围身份。 */
  private register(node: ScopeNode): void {
    this.nodes.set(node.id, node);
    const children = this.childIds.get(node.parent!) ?? [];
    children.push(node.id); this.childIds.set(node.parent!, children);
  }
  /** 查询当前文件对应的节点，不与同路径已删除的旧文件混淆。 */
  fileAt(path: string): ScopeNode | undefined {
    return [...this.nodes.values()].find(n => n.kind === 'file' && n.path === path && !n.deleted);
  }
  /** 返回可分页展示的真实直接子节点。 */
  children(id: string): ScopeNode[] {
    return (this.childIds.get(id) ?? []).map(id => this.nodes.get(id)!)
      .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
        || naturalCompare(a.label, b.label) || a.id.localeCompare(b.id));
  }
  /** 判断文件实体是否属于当前范围，目录匹配包含路径分隔边界。 */
  contains(scopeId: string, entity: string): boolean {
    const node = this.nodes.get(scopeId), file = this.entities.get(entity);
    if (!node || !file) return false;
    if (node.kind === 'repository') return true;
    if (node.kind === 'file') return node.entity === entity;
    return file.path.startsWith(`${node.path}/`);
  }
  /** 从出生时间找到所在周，供当前行命令进入正确的图表时间点。 */
  weekFor(time: number, days: number): string | undefined {
    return this.ranges(days).find(w => time >= w.start && time < w.end)?.id;
  }
  /** 生成所选日期范围的周段，统一采用快照记录的时区。 */
  private ranges(days: number): WeekRange[] {
    if (![30, 90, 180].includes(days)) throw new Error('请选择 30、90 或 180 天');
    return weekRanges(this.snapshot.cutoff, days, this.snapshot.timeZone, this.snapshot.rangeStart);
  }
  /** 记录单条已完整观察的新增代码及其 14 天内首次修改。 */
  private count(target: Aggregate, birth: Birth): boolean {
    if (this.affected.has(birth.id)) target.complete = false;
    if (birth.attribution === 'unknown') { target.unknown++; return false; }
    target[birth.attribution]++;
    const event = birth.firstRewrite ? this.events.get(birth.firstRewrite) : undefined;
    const rewritten = !!event && event.time >= birth.time && event.time <= birth.time + WINDOW && event.time <= this.snapshot.cutoff;
    if (rewritten) {
      if (birth.attribution === 'ai') target.aiRewritten++; else target.unmarkedRewritten++;
    }
    return rewritten;
  }
  /** 返回范围的完整路径链；文件身份与目录同名时仍保持唯一。 */
  ancestors(id: string): ScopeNode[] {
    const result: ScopeNode[] = [];
    let node = this.nodes.get(id);
    while (node) { result.unshift(node); node = node.parent ? this.nodes.get(node.parent) : undefined; }
    return result;
  }
  /** 计算趋势与下钻结果，缓存有限数量的选择；所有行都只被归入一个周段。 */
  report(scopeId: string, days: number, selectedWeek?: string, limit = 100, view = defaultView()): TrendReport {
    const key = JSON.stringify([scopeId, days, selectedWeek]);
    const base = this.reports.get(key) ?? this.buildReport(scopeId, days, selectedWeek);
    this.reports.set(key, base);
    if (this.reports.size > 8) this.reports.delete(this.reports.keys().next().value!);
    const page = queryList(base.children, { ...view.lists.directory, limit }, row => row.path, (row, sort) => {
      if (sort === 'added') return row.counts.ai + row.counts.unmarked + row.counts.unknown + row.pending;
      if (sort === 'rate') return row.counts.complete && row.counts.configured && row.counts.ai + row.counts.unmarked
        ? (row.counts.aiRewritten + row.counts.unmarkedRewritten) / (row.counts.ai + row.counts.unmarked) : undefined;
      return row.counts.aiRewritten + row.counts.unmarkedRewritten;
    }, row => !!(row.counts.ai + row.counts.unmarked + row.counts.unknown + row.pending));
    return { ...base, children: page.rows, matchingChildren: page.matching, events: base.events.slice(0, limit),
      metrics: projectMetrics(base.metrics, view) };
  }
  /** 缓存完整候选集合，切换搜索或分页时不重复遍历新增行。 */
  private buildReport(scopeId: string, days: number, selectedWeek?: string): TrendReport {
    const scope = this.nodes.get(scopeId);
    if (!scope) throw new Error('这个目录或文件已变化，请重新选择范围');
    const ranges = this.ranges(days);
    if (selectedWeek && !ranges.some(w => w.id === selectedWeek && w.observed)) selectedWeek = undefined;
    const counts = () => emptyCounts(this.snapshot.attributionConfigured, !this.globalGap);
    const points: TrendPoint[] = ranges.map(w => ({ ...w, counts: counts(), pending: 0 }));
    const rows = new Map(this.children(scopeId).map(node => [node.id, { ...node, counts: counts(), pending: 0 }]));
    const entityRow = new Map<string, ScopeRow>();
    for (const file of this.entities.values()) {
      if (!this.contains(scopeId, file.entity) || scope.kind === 'file') continue;
      let node = this.nodes.get(`file:${file.entity}`)!;
      while (node.parent && node.parent !== scopeId) node = this.nodes.get(node.parent)!;
      const row = rows.get(node.id);
      if (row) entityRow.set(file.entity, row);
    }
    const eventRows = new Map<string, EventRow>();
    for (const b of this.snapshot.births) {
      if (!this.contains(scopeId, b.entity)) continue;
      // 二分查找保留对全仓库大范围的线性扫描成本。
      let low = 0, high = points.length;
      while (low < high) { const mid = (low + high) >>> 1; if (points[mid].end <= b.time) low = mid + 1; else high = mid; }
      const point = points[low];
      if (!point || b.time < point.start) continue;
      const row = entityRow.get(b.entity);
      if (!point.observed) { point.pending++; if (row && !selectedWeek) row.pending++; continue; }
      const rewritten = this.count(point.counts, b);
      if (selectedWeek && point.id !== selectedWeek) continue;
      if (row) this.count(row.counts, b);
      if (!rewritten || scope.kind !== 'file' || !b.firstRewrite) continue;
      const event = this.events.get(b.firstRewrite)!;
      let result = eventRows.get(event.id);
      if (!result) {
        result = { id: event.id, commit: event.commit, time: event.time, ai: 0, human: 0,
          beforePath: event.beforePath, beforeStart: event.beforeStart, beforeCount: event.beforeCount,
          afterPath: event.afterPath, afterStart: event.afterStart, afterCount: event.afterCount,
          current: !!event.anchor, signals: [], origins: [] };
        eventRows.set(event.id, result);
      }
      if (b.attribution === 'ai') result.ai++; else result.human++;
      for (const signal of b.attributionSignals ?? [])
        if (!result.signals.some(s => s.kind === signal.kind && s.provider === signal.provider)) result.signals.push(signal);
      if (b.origin) {
        const o = b.origin;
        const existing = result.origins.find(item => item.mainlineCommit === b.commit && item.sourceCommit === o.commit
          && item.sourcePath === o.path && item.kind === o.kind);
        if (existing) { existing.count++; existing.sourceLine = Math.min(existing.sourceLine, o.line); }
        else result.origins.push({ mainlineCommit: b.commit, mainlineTime: b.time,
          sourceCommit: o.commit, sourceTime: o.time, sourcePath: o.path, sourceLine: o.line, count: 1, kind: o.kind });
      }
    }
    const summary = counts();
    for (const point of points) if (point.observed) addCounts(summary, point.counts);
    const sortedRows = [...rows.values()].sort((a, b) =>
      b.counts.aiRewritten + b.counts.unmarkedRewritten - a.counts.aiRewritten - a.counts.unmarkedRewritten
        || naturalCompare(a.path, b.path) || a.id.localeCompare(b.id));
    const sortedEvents = [...eventRows.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
    const selected = selectedWeek ? points.find(p => p.id === selectedWeek)! : undefined;
    const notices = [...new Set(this.snapshot.gaps.filter(g => !g.entity || this.contains(scopeId, g.entity)).map(g => g.reason))];
    const report: TrendReport = {
      scope, crumbs: this.ancestors(scopeId), days, points, summary,
      pending: points.reduce((n, p) => n + p.pending, 0), selectedWeek,
      children: sortedRows, totalChildren: sortedRows.length, matchingChildren: sortedRows.length,
      events: sortedEvents, totalEvents: sortedEvents.length,
      rangeStart: points[0]?.startDate, rangeEnd: points.at(-1)?.endDate,
      observedEnd: points.filter(p => p.observed).at(-1)?.endDate,
      nextReadyAt: points.find(p => !p.observed && p.pending)?.readyAt, notices,
      metrics: this.metrics.report(scopeId, days, entity => this.contains(scopeId, entity), ranges),
    };
    if (selected && !selected.counts.complete) report.notices = [...new Set([...notices, '所选周有历史读取缺口，返工率暂不能计算'])];
    return report;
  }
}
