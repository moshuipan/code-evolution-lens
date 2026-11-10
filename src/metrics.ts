import { Birth, Snapshot, WINDOW } from './model';
import { dateKey, daysBefore, shiftDate, WeekRange } from './time';

const DAY = 86400;
export const COUPLING_FILE_LIMIT = 100;
export interface Fraction { numerator: number; denominator: number; complete: boolean }
export interface ProviderRow {
  id: string; name: string; members: string[]; attribution: Birth['attribution'];
  added: number; aiShare?: number; commits: number; files: number; activeDays: number;
  mature: number; rewritten: number; complete: boolean; medianRewriteDays?: number;
  retention14: Fraction; retention30: Fraction;
}
export interface SurvivalPoint { age: number; survival: number; atRisk: number; events: number; censored: number }
export interface SurvivalSeries {
  attribution: 'ai' | 'unmarked'; samples: number; excluded: number; points: SurvivalPoint[];
}
export interface ActivityDay { date: string; commits: number; added: number; deleted: number }
export interface ChangedFile {
  entity: string; path: string; added: number; deleted: number; commits: number; authors: number;
  mature: number; rewritten: number; complete: boolean;
}
export interface ProviderFile {
  providerId: string; entity: string; path: string; added: number; mature: number; rewritten: number; complete: boolean;
}
export interface MetricsReport {
  configured: boolean; complete: boolean; providers: ProviderRow[]; survival: SurvivalSeries[];
  activity: {
    available: boolean; complete: boolean; commits: number; merges: number; added: number; deleted: number;
    files: number; averageFiles: number; commitsPerDay: number; activeDays: number; peakDay?: ActivityDay;
    repeatedFiles: number; sessions: number; fixTitles: number; revertTitles: number; daily: ActivityDay[];
  };
  topFiles: ChangedFile[]; attentionFiles: ChangedFile[]; totalFiles: number;
  coupling: { left: string; right: string; leftEntity: string; rightEntity: string; commits: number; ratio: number }[];
  couplingSkipped: number;
  contributors: { id: string; name: string; added: number; retained: number; files: number }[];
  contributorLines: number; unidentifiedAuthorLines: number; largestContributorShare?: number;
  providerFiles: ProviderFile[];
  lists: Record<string, { total: number; matching: number; visible: number }>;
}
interface Observation { duration: number; event: boolean }

/** 证据中的具体名称优先；多个名称进入单一“多提供者”桶，共享邮箱不制造工具身份。 */
export function providerBucket(birth: Birth): Pick<ProviderRow, 'id' | 'name' | 'members' | 'attribution'> {
  const attribution = birth.attribution;
  if (attribution !== 'ai') return { id: attribution, name: attribution === 'unmarked' ? '未发现 AI 标记' : '归因未知', members: [], attribution };
  const names = [...new Map((birth.attributionSignals ?? []).filter(s => s.provider !== 'AI 邮箱名（提供者不唯一）')
    .map(s => [s.provider.toLowerCase(), s.provider])).values()].sort((a, b) => a.localeCompare(b));
  return { id: names.length === 1 ? `provider:${names[0].toLowerCase()}` : names.length ? 'multiple' : 'ambiguous',
    name: names.length === 1 ? names[0] : names.length ? '多提供者' : '提供者不唯一', members: names, attribution };
}

/** 同时发生事件与删失时先处理事件；内部使用精确秒数，只压缩展示点，不改变乘积。 */
export function kaplanMeier(observations: Observation[]): SurvivalPoint[] {
  if (!observations.length) return [];
  const times = new Map<number, { events: number; censored: number }>();
  for (const o of observations) {
    const value = times.get(o.duration) ?? { events: 0, censored: 0 };
    if (o.event) value.events++; else value.censored++;
    times.set(o.duration, value);
  }
  const sorted = [...times].sort(([a], [b]) => a - b), max = sorted.at(-1)![0];
  const ages = Array.from({ length: Math.floor(max / DAY) + 1 }, (_, i) => i * DAY);
  if (ages.at(-1) !== max) ages.push(max);
  let index = 0, risk = observations.length, survival = 1, events = 0, censored = 0;
  const result: SurvivalPoint[] = [];
  for (const age of ages) {
    let riskAtAge = risk;
    while (index < sorted.length && sorted[index][0] <= age) {
      const [time, value] = sorted[index++];
      if (time === age) riskAtAge = risk;
      survival *= 1 - value.events / risk;
      events += value.events; censored += value.censored;
      risk -= value.events + value.censored;
      if (time < age) riskAtAge = risk;
    }
    result.push({ age: age / DAY, survival, atRisk: riskAtAge, events, censored });
  }
  return result;
}

/** 返回中位数；只用于已经发生返工的条件样本，不能解释为全部代码寿命。 */
function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  values.sort((a, b) => a - b);
  const mid = values.length >>> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** 对同一不可变快照计算当前范围的全期指标；选周只筛选原有返工列表。 */
export class MetricsQuery {
  private readonly events;
  private readonly gaps = new Map<string, number | null>();
  private readonly globalGap: boolean;
  private readonly paths;
  private readonly cache = new Map<string, MetricsReport>();
  /** 预编译事件与历史缺口索引，避免每条新增行遍历所有缺口。 */
  constructor(readonly snapshot: Snapshot) {
    this.events = new Map(snapshot.events.map(e => [e.id, e]));
    this.paths = new Map(snapshot.entities.map(e => [e.entity, e.path]));
    this.globalGap = snapshot.completeness === 'invalid' || snapshot.gaps.some(g => !g.entity);
    const byEntity = new Map<string, string[]>();
    for (const b of snapshot.births) {
      const ids = byEntity.get(b.entity) ?? []; ids.push(b.id); byEntity.set(b.entity, ids);
    }
    for (const gap of snapshot.gaps) for (const id of gap.birthIds ?? byEntity.get(gap.entity ?? '') ?? []) {
      const old = this.gaps.get(id);
      this.gaps.set(id, gap.time === undefined || old === null ? null : Math.min(old ?? Infinity, gap.time));
    }
  }
  /** 在所选日历窗口聚合互斥 provider、固定年龄留存、KM 和提交活动。 */
  report(scopeId: string, days: number, contains: (entity: string) => boolean, weeks: WeekRange[]): MetricsReport {
    const key = `${scopeId}:${days}`, cached = this.cache.get(key);
    if (cached) return cached;
    const s = this.snapshot, start = Math.max(s.rangeStart, daysBefore(s.cutoff, days, s.timeZone));
    const births = s.births.filter(b => b.time >= start && b.time < s.cutoff && contains(b.entity));
    const matureEnd = weeks.filter(w => w.observed).at(-1)?.end ?? start;
    const rows = new Map<string, { row: ProviderRow; commits: Set<string>; files: Set<string>; days: Set<string>; times: number[]; members: Set<string> }>();
    const observations = { ai: [] as Observation[], unmarked: [] as Observation[] };
    const excluded = { ai: 0, unmarked: 0 };
    const fileBirths = new Map<string, { mature: number; rewritten: number; complete: boolean }>();
    const contributors = new Map<string, { id: string; name: string; added: number; retained: number; files: Set<string> }>();
    const participants = new Map<string, Set<string>>();
    const providerFiles = new Map<string, ProviderFile>();
    let aiAdded = 0, unidentifiedAuthorLines = 0;
    const birthDays = new Map<number, string>();
    for (const b of births) {
      const bucket = providerBucket(b);
      let group = rows.get(bucket.id);
      if (!group) {
        const fraction = (): Fraction => ({ numerator: 0, denominator: 0, complete: !this.globalGap });
        group = { row: { ...bucket, added: 0, commits: 0, files: 0, activeDays: 0, mature: 0, rewritten: 0,
          complete: !this.globalGap, retention14: fraction(), retention30: fraction() },
          commits: new Set(), files: new Set(), days: new Set(), times: [], members: new Set() };
        rows.set(bucket.id, group);
      }
      const row = group.row, event = b.firstRewrite ? this.events.get(b.firstRewrite) : undefined;
      const eventTime = event && event.time >= b.time && event.time <= s.cutoff ? event.time : undefined;
      const gap = this.gaps.get(b.id);
      const completeThrough = (age: number): boolean => !this.globalGap && gap !== null && (gap === undefined || gap > b.time + age);
      row.added++; if (b.attribution === 'ai') aiAdded++;
      let day = birthDays.get(b.time);
      if (!day) { day = dateKey(b.time, s.timeZone); birthDays.set(b.time, day); }
      group.commits.add(b.origin?.commit ?? b.commit); group.files.add(b.entity); group.days.add(day);
      for (const member of bucket.members) group.members.add(member);
      const mature = b.time < matureEnd;
      const rewritten = eventTime !== undefined && eventTime <= b.time + WINDOW;
      const pfKey = JSON.stringify([bucket.id, b.entity]);
      const pf = providerFiles.get(pfKey) ?? { providerId: bucket.id, entity: b.entity,
        path: this.paths.get(b.entity) ?? '', added: 0, mature: 0, rewritten: 0, complete: !this.globalGap };
      pf.added++;
      if (mature) { pf.mature++; pf.complete &&= completeThrough(WINDOW); if (rewritten) pf.rewritten++; }
      providerFiles.set(pfKey, pf);
      if (rewritten && completeThrough(eventTime! - b.time)) group.times.push((eventTime! - b.time) / DAY);
      const fb = fileBirths.get(b.entity) ?? { mature: 0, rewritten: 0, complete: !this.globalGap };
      if (mature) {
        row.mature++; fb.mature++;
        row.complete &&= completeThrough(WINDOW); fb.complete &&= completeThrough(WINDOW);
        if (rewritten) { row.rewritten++; fb.rewritten++; }
      }
      fileBirths.set(b.entity, fb);
      for (const age of [14, 30] as const) {
        const fraction = age === 14 ? row.retention14 : row.retention30;
        if (b.time + age * DAY > s.cutoff) continue;
        if (!completeThrough(age * DAY)) { fraction.complete = false; continue; }
        fraction.denominator++;
        if (eventTime === undefined || eventTime > b.time + age * DAY) fraction.numerator++;
      }
      if (b.attribution !== 'unknown') {
        if (this.globalGap || gap === null || (gap !== undefined && gap <= b.time)) excluded[b.attribution]++;
        else {
          const end = Math.min(s.cutoff, gap ?? Infinity);
          const observedEvent = eventTime !== undefined && eventTime < (gap ?? Infinity) && eventTime <= end;
          observations[b.attribution].push({ duration: (observedEvent ? eventTime! : end) - b.time, event: observedEvent });
        }
      }
      if (!b.sourceAuthor) unidentifiedAuthorLines++;
      else {
        const author = b.sourceAuthor, c = contributors.get(author.id) ?? { ...author, added: 0, retained: 0, files: new Set<string>() };
        c.added++; if (eventTime === undefined && completeThrough(s.cutoff - b.time)) c.retained++;
        c.files.add(b.entity); contributors.set(author.id, c);
        const people = participants.get(b.entity) ?? new Set(); people.add(author.id); participants.set(b.entity, people);
      }
    }
    const providers = [...rows.values()].map(g => ({ ...g.row, members: [...g.members].sort(),
      aiShare: g.row.attribution === 'ai' && aiAdded ? g.row.added / aiAdded : undefined,
      commits: g.commits.size, files: g.files.size, activeDays: g.days.size, medianRewriteDays: median(g.times) }))
      .sort((a, b) => Number(b.attribution === 'ai') - Number(a.attribution === 'ai') || b.added - a.added || a.id.localeCompare(b.id));
    const activity = this.activity(start, days, scopeId, contains, fileBirths, participants);
    const contributorRows = [...contributors.values()].map(c => ({ ...c, files: c.files.size }))
      .sort((a, b) => b.added - a.added || a.id.localeCompare(b.id));
    const contributorLines = contributorRows.reduce((n, c) => n + c.added, 0);
    const result: MetricsReport = {
      configured: s.attributionConfigured, complete: !this.globalGap, providers,
      survival: (['ai', 'unmarked'] as const).map(attribution => ({ attribution, samples: observations[attribution].length,
        excluded: excluded[attribution], points: s.attributionConfigured ? kaplanMeier(observations[attribution]) : [] })),
      ...activity, contributors: contributorRows, contributorLines, unidentifiedAuthorLines,
      providerFiles: [...providerFiles.values()], lists: {},
      largestContributorShare: contributorLines ? contributorRows[0].added / contributorLines : undefined,
    };
    this.cache.set(key, result);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
  /** 使用已保存主线汇总计算活跃度；耦合分子分母均排除同一批量提交集合。 */
  private activity(start: number, days: number, scopeId: string, contains: (entity: string) => boolean,
    fileBirths: Map<string, { mature: number; rewritten: number; complete: boolean }>, participants: Map<string, Set<string>>) {
    const s = this.snapshot;
    const commits = (s.activity ?? []).filter(c => c.time >= start && (scopeId === 'repo' || c.files.some(f => contains(f.entity))));
    const files = new Map<string, ChangedFile>(), dayMap = new Map<string, ActivityDay>(), previous = new Map<string, number>();
    const eligibleCounts = new Map<string, number>(), pairs = new Map<string, { leftEntity: string; rightEntity: string; commits: number }>();
    let added = 0, deleted = 0, sessions = 0, couplingSkipped = 0, complete = !this.globalGap;
    for (const commit of commits) {
      const date = dateKey(commit.time, s.timeZone), day = dayMap.get(date) ?? { date, commits: 0, added: 0, deleted: 0 };
      day.commits++;
      const last = previous.get(commit.author.id);
      if (last === undefined || commit.time - last > 90 * 60) sessions++;
      previous.set(commit.author.id, commit.time);
      const changed = commit.files.filter(f => contains(f.entity));
      for (const f of changed) {
        const fb = fileBirths.get(f.entity) ?? { mature: 0, rewritten: 0, complete: !this.globalGap };
        const row = files.get(f.entity) ?? { entity: f.entity, path: this.paths.get(f.entity) ?? '', added: 0, deleted: 0, commits: 0, authors: 0, ...fb };
        row.added += f.added; row.deleted += f.deleted; row.commits++; row.complete &&= f.complete;
        const people = participants.get(f.entity) ?? new Set();
        people.add(commit.author.id); participants.set(f.entity, people); row.authors = people.size;
        files.set(f.entity, row);
        added += f.added; deleted += f.deleted; day.added += f.added; day.deleted += f.deleted; complete &&= f.complete;
      }
      dayMap.set(date, day);
      // 使用整个提交的文件数决定是否排除，目录下钻不会把大合并变成可用小提交。
      if (commit.files.length > COUPLING_FILE_LIMIT || commit.files.some(f => !f.complete)) { couplingSkipped++; continue; }
      const ids = changed.map(f => f.entity).sort();
      for (const id of ids) eligibleCounts.set(id, (eligibleCounts.get(id) ?? 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}:${ids[j]}`, pair = pairs.get(key) ?? { leftEntity: ids[i], rightEntity: ids[j], commits: 0 };
        pair.commits++; pairs.set(key, pair);
      }
    }
    const daily: ActivityDay[] = [];
    const first = dateKey(start, s.timeZone);
    for (let i = 0; i < days; i++) {
      const date = shiftDate(first, i);
      if (date >= dateKey(s.cutoff, s.timeZone)) break;
      daily.push(dayMap.get(date) ?? { date, commits: 0, added: 0, deleted: 0 });
    }
    const sortedFiles = [...files.values()].sort((a, b) => b.added + b.deleted - a.added - a.deleted || a.path.localeCompare(b.path));
    const middle = median(sortedFiles.map(f => f.added + f.deleted)) ?? Infinity;
    const coupling = [...pairs.values()].filter(p => p.commits >= 3).map(p => ({ ...p,
      left: this.paths.get(p.leftEntity) ?? '', right: this.paths.get(p.rightEntity) ?? '',
      ratio: p.commits / Math.min(eligibleCounts.get(p.leftEntity)!, eligibleCounts.get(p.rightEntity)!) }))
      .sort((a, b) => b.commits - a.commits || b.ratio - a.ratio || a.left.localeCompare(b.left));
    return {
      activity: { available: !!s.activity, complete, commits: commits.length, merges: commits.filter(c => c.merge).length,
        added, deleted, files: files.size, averageFiles: commits.length ? [...files.values()].reduce((n, f) => n + f.commits, 0) / commits.length : 0,
        commitsPerDay: commits.length / Math.max(1, daily.length), activeDays: dayMap.size,
        peakDay: [...dayMap.values()].sort((a, b) => b.commits - a.commits || a.date.localeCompare(b.date))[0],
        repeatedFiles: sortedFiles.filter(f => f.commits >= 2).length, sessions,
        fixTitles: commits.filter(c => c.intent === 'fix').length, revertTitles: commits.filter(c => c.intent === 'revert').length, daily },
      topFiles: sortedFiles, totalFiles: sortedFiles.length,
      attentionFiles: sortedFiles.filter(f => f.complete && f.authors === 1 && f.added + f.deleted >= middle && f.added + f.deleted > 0),
      coupling, couplingSkipped,
    };
  }
}
