import { diffArrays } from 'diff';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { GitAdapter, validOid } from './git';
import { Anchor, Birth, Config, FileEntity, FileState, HISTORY_DAYS, METRIC_VERSION, ORIGIN_RULE, REPLAY_RULE, RewriteEvent, Snapshot } from './model';
import { attributionHash, configHash, eligible, hash, normalizeConfig, packageOf, safeGitPath, textLines } from './rules';
import { AttributionEngine } from './attribution';
import { authorIdentity, commitIntent, resolveOrigins } from './origin';
import { daysBefore } from './time';

interface Segment { oldStart: number; newStart: number; removed: number; added: number; common: boolean }
export interface ReplayOptions {
  cutoff: number; now?: number; signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
  originProgress?: (done: number, total: number) => void;
}
/** 强制修改前缀之后，若仅删除或仅插入即可对齐，直接构造 Myers 的贪心公共区间。 */
function singleDirectionSegments(before: string[], after: string[], oldPrefix: number, newPrefix: number): Segment[] | undefined {
  const removeOnly = before.length - oldPrefix >= after.length - newPrefix;
  const result: Segment[] = [];
  let oldAt = oldPrefix, newAt = newPrefix, oldStart = 0, newStart = 0;
  while (oldAt < before.length && newAt < after.length) {
    if (before[oldAt] !== after[newAt]) {
      if (removeOnly) oldAt++; else newAt++;
      continue;
    }
    if (oldAt !== oldStart || newAt !== newStart)
      result.push({ oldStart, newStart, removed: oldAt - oldStart, added: newAt - newStart, common: false });
    const commonOld = oldAt, commonNew = newAt;
    while (oldAt < before.length && newAt < after.length && before[oldAt] === after[newAt]) { oldAt++; newAt++; }
    result.push({ oldStart: commonOld, newStart: commonNew, removed: oldAt - commonOld, added: newAt - commonNew, common: true });
    oldStart = oldAt; newStart = newAt;
  }
  if (removeOnly ? newAt < after.length : oldAt < before.length) return undefined;
  if (oldStart < before.length || newStart < after.length)
    result.push({ oldStart, newStart, removed: before.length - oldStart, added: after.length - newStart, common: false });
  return result;
}
/** 将固定 Myers 差异转为零基坐标；可证明的空侧、无共同文本和单向编辑使用精确快路径。 */
export function segments(before: string[], after: string[]): Segment[] {
  if (!before.length && !after.length) return [];
  if (!before.length || !after.length)
    return [{ oldStart: 0, newStart: 0, removed: before.length, added: after.length, common: false }];
  // 无相同行时，最短编辑脚本只能是全部删除和新增；不改变重复文本的 Myers 选路。
  const shorter = before.length <= after.length ? before : after;
  const longer = before.length <= after.length ? after : before;
  const lines = new Set(shorter);
  if (!longer.some(line => lines.has(line)))
    return [{ oldStart: 0, newStart: 0, removed: before.length, added: after.length, common: false }];
  const otherLines = new Set(longer);
  const beforeLines = before === shorter ? lines : otherLines;
  const afterLines = after === shorter ? lines : otherLines;
  let oldPrefix = 0, newPrefix = 0;
  // 只移过在另一侧完全不存在的前缀；这些行无法成为公共区间，不能任意截断重复文本后缀。
  while (oldPrefix < before.length && !afterLines.has(before[oldPrefix])) oldPrefix++;
  while (newPrefix < after.length && !beforeLines.has(after[newPrefix])) newPrefix++;
  const singleDirection = singleDirectionSegments(before, after, oldPrefix, newPrefix);
  if (singleDirection) return singleDirection;
  const diff = diffArrays(before, after);
  const result: Segment[] = [];
  let oldStart = 0, newStart = 0;
  for (const part of diff) {
    const count = part.value.length;
    const common = !part.added && !part.removed;
    const previous = result.at(-1);
    if (!common && previous && !previous.common) {
      previous.removed += part.removed ? count : 0;
      previous.added += part.added ? count : 0;
    } else result.push({ oldStart, newStart, removed: part.added ? 0 : count, added: part.removed ? 0 : count, common });
    if (!part.added) oldStart += count;
    if (!part.removed) newStart += count;
  }
  return result;
}
/** anchor 必须完全落入同一未改动区间；内部插入或替换会撤销定位。 */
export function project(anchor: Anchor, parts: Segment[], path: string): Anchor | undefined {
  const start = anchor.start - 1;
  const span = parts.find(p => p.common && start >= p.oldStart && start + anchor.count <= p.oldStart + p.removed);
  return span ? { path, start: span.newStart + start - span.oldStart + 1, count: anchor.count } : undefined;
}
/** 从根核验主线和文件身份，只为窗口内新增或仍需跟踪的代码回放正文。 */
export async function replay(root: string, input: Config, options: ReplayOptions): Promise<Snapshot> {
  const config = normalizeConfig(input);
  const attribution = new AttributionEngine(config);
  const started = Date.now(), now = options.now ?? started / 1000;
  const git = new GitAdapter(root, config, options.signal);
  const files = new Map<string, FileState>();
  const entities = new Map<string, FileEntity>();
  const birthById = new Map<string, Birth>();
  const eventByEntity = new Map<string, RewriteEvent[]>();
  /** 检查用户主动取消；同步差异长期运行时由宿主终止 worker，保留旧快照。 */
  const check = () => { options.signal?.throwIfAborted(); };
  /** 对必要正文读取补充仓库相对路径和提交；不输出对象内容。 */
  const readBlob = async (oid: string, path: string, commit: string): Promise<Buffer> => {
    try { return await git.blob(oid); }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : '无法读取代码版本'}（文件 ${path}，提交 ${commit.slice(0, 12)}）`);
    }
  };
  try {
    const probe = await git.probe();
    const commits = await git.commits(probe.tip);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rangeStart = daysBefore(options.cutoff, HISTORY_DAYS, timeZone);
    const snapshot: Snapshot = {
      schema: 2, id: randomUUID(), repoId: hash(probe.root), root: probe.root, ref: config.ref,
      navigationTipOid: probe.tip, cutoff: options.cutoff, timeZone, rangeStart,
      createdAt: now, metricVersion: METRIC_VERSION, attributionHash: attributionHash(config),
      filterHash: hash([config.excludeGlobs, config.packageRoots]), replayHash: hash(REPLAY_RULE),
      gitVersion: probe.version, configHash: configHash(config), attributionConfigured: attribution.configured,
      attributionRuleVersion: attribution.rule.version, attributionMessageMarkers: attribution.rule.messageSignals,
      completeness: 'complete', births: [], events: [], files: [], entities: [], gaps: [], activity: [],
      excluded: { objects: 0, bytes: 0, knownLines: 0 },
      work: { commits: commits.length, objectBytes: 0, elapsedMs: 0 },
    };
    for (let index = 0; index < commits.length; index++) {
      check();
      const commit = commits[index];
      if (!Number.isSafeInteger(commit.time) || commit.time > now || (index > 0 && commit.time < commits[index - 1].time)) {
        snapshot.completeness = 'invalid';
        snapshot.gaps.push({ reason: '主线提交时间逆序或晚于索引时刻，统计边界不可核验', commit: commit.oid });
      }
      if (commit.time <= options.cutoff) snapshot.analysisTipOid = commit.oid;
      const attr = attribution.attribute(commit);
      const inRange = commit.time >= rangeStart && commit.time < options.cutoff;
      const intent = commitIntent(commit.message);
      const activity = { commit: commit.oid, time: commit.time, author: authorIdentity(commit),
        merge: commit.parents.length > 1, ...(intent ? { intent } : {}), files: [] as import('./model').FileActivity[] };
      const changes = await git.changes(commit);
      const previous = new Map(changes.map(c => [c.oldPath, files.get(c.oldPath)]));
      for (const c of changes) {
        const old = previous.get(c.oldPath);
        if (old) files.delete(c.oldPath);
      }
      for (const change of changes) {
        check();
        const old = previous.get(change.oldPath);
        const entity = old?.entity ?? hash([commit.oid, change.newPath]);
        const deleted = /^0+$/.test(change.after);
        entities.set(entity, { entity, path: deleted ? change.oldPath : change.newPath,
          blob: deleted ? change.before : change.after, deleted,
          ...(eligible(change.newPath, 'code', config) ? {} : { excludedReason: '此路径的新代码被排除规则过滤' }) });
        const events = eventByEntity.get(entity) ?? [];
        const needsTracking = old?.lines.some(Boolean) || events.some(event => event.anchor);
        const countBefore = eligible(change.oldPath, 'code', config), countAfter = eligible(change.newPath, 'code', config);
        if (!needsTracking && (!inRange || (!countBefore && !countAfter))) {
          // 例如旧生成文件由 498 行变成 65064 行：此时只需保存身份、路径和版本。
          // 下次有统计资格时读取 change.before，按真实物理行初始化 null，不把旧行误认作新增。
          if (!deleted) files.set(change.newPath, { entity, path: change.newPath, blob: change.after, lines: [] });
          continue;
        }
        const oldRegular = change.oldMode.startsWith('100');
        const newRegular = change.newMode.startsWith('100');
        const beforeBytes = oldRegular ? await readBlob(change.before, change.oldPath, commit.oid) : Buffer.alloc(0);
        const afterBytes = !deleted && newRegular ? await readBlob(change.after, change.newPath, commit.oid) : Buffer.alloc(0);
        const before = textLines(beforeBytes);
        const after = deleted ? [] : newRegular ? textLines(afterBytes) : undefined;
        const fileActivity = { entity, added: 0, deleted: 0, complete: !!before && !!after };
        if (inRange && (countBefore || countAfter) && (oldRegular || newRegular))
          activity.files.push(fileActivity);
        if (!after || !before) {
          if (old?.lines.some(Boolean)) snapshot.gaps.push({
            entity, path: change.oldPath, commit: commit.oid, time: commit.time,
            birthIds: old.lines.filter((id): id is string => !!id), reason: '代码变成无法解析的文本，部分修改历史不能计算',
          });
          for (const event of events) event.anchor = undefined;
          if (!after) {
            entities.get(entity)!.excludedReason = '非 UTF-8 普通文本，不参与代码行统计';
            snapshot.excluded.objects++; snapshot.excluded.bytes += afterBytes.length;
            if (!deleted) files.set(change.newPath, { entity, path: change.newPath, blob: change.after, lines: [] });
            continue;
          }
        }
        const oldText = before ?? [];
        const oldIds = old?.lines.length === oldText.length ? old.lines : new Array<string | null>(oldText.length).fill(null);
        check();
        const parts = segments(oldText, after!);
        check();
        for (const event of events) {
          if (event.anchor) event.anchor = project(event.anchor, parts, change.newPath);
        }
        const ids: (string | null)[] = [];
        for (const part of parts) {
          if (part.common) {
            for (let i = part.oldStart; i < part.oldStart + part.removed; i++) ids.push(oldIds[i]);
            continue;
          }
          // 窗外旧行的删除也属于文本改动量；它不必有窗口内出生身份。
          if (fileActivity.complete) {
            if (countBefore) for (let line = part.oldStart; line < part.oldStart + part.removed; line++)
              if (oldText[line].trim()) fileActivity.deleted++;
            if (countAfter) for (let line = part.newStart; line < part.newStart + part.added; line++)
              if (after![line].trim()) fileActivity.added++;
          }
          const removedIds = oldIds.slice(part.oldStart, part.oldStart + part.removed).filter((id): id is string => !!id);
          if (removedIds.length) {
            const event: RewriteEvent = {
              id: hash([commit.oid, entity, part.oldStart, part.newStart]), entity, birthIds: removedIds,
              commit: commit.oid, parent: commit.parents[0], time: commit.time,
              beforePath: change.oldPath, afterPath: deleted ? undefined : change.newPath,
              beforeBlob: change.before, afterBlob: deleted ? undefined : change.after,
              beforeStart: part.oldStart + 1, beforeCount: part.removed,
              afterStart: part.newStart + 1, afterCount: part.added,
              anchor: part.added ? { path: change.newPath, start: part.newStart + 1, count: part.added } : undefined,
            };
            snapshot.events.push(event);
            const events = eventByEntity.get(entity) ?? [];
            events.push(event); eventByEntity.set(entity, events);
            for (const id of removedIds) birthById.get(id)!.firstRewrite = event.id;
          }
          for (let line = part.newStart; line < part.newStart + part.added; line++) {
            if (inRange && eligible(change.newPath, after![line], config)) {
              const pkg = packageOf(change.newPath, config.packageRoots);
              const birth: Birth = {
                id: hash([commit.oid, change.newPath, line + 1]), entity,
                owner: hash([pkg, change.newPath]), package: pkg, commit: commit.oid, blob: change.after,
                path: change.newPath, line: line + 1, time: commit.time, attribution: attr.attribution,
                attributionSignals: attr.signals,
              };
              snapshot.births.push(birth); birthById.set(birth.id, birth); ids.push(birth.id);
            } else {
              if (inRange) snapshot.excluded.knownLines++;
              ids.push(null);
            }
          }
        }
        if (!deleted) {
          if (ids.length !== after!.length) throw new Error('物理行回放不变量失败');
          files.set(change.newPath, { entity, path: change.newPath, blob: change.after, lines: ids });
        }
      }
      if (inRange) snapshot.activity!.push(activity);
      options.progress?.(index + 1, commits.length);
      await setImmediate();
    }
    check();
    if (snapshot.gaps.length && snapshot.completeness === 'complete') snapshot.completeness = 'partial';
    snapshot.files = [...files.values()];
    const tracked = new Set([...snapshot.births.map(b => b.entity), ...snapshot.activity!.flatMap(c => c.files.map(f => f.entity))]);
    snapshot.entities = [...entities.values()].filter(e => !e.deleted || tracked.has(e.entity));
    await resolveOrigins(snapshot, git, attribution, commits, check, options.originProgress);
    snapshot.work.objectBytes = git.bytes;
    snapshot.work.elapsedMs = Date.now() - started;
    validateSnapshot(snapshot);
    return snapshot;
  } finally { await git.dispose(); }
}
/** 发布前核验出生唯一性、首次重写关系及当前坐标。 */
export function validateSnapshot(s: Snapshot): void {
  if (s.schema !== 2 || !s.id || !s.repoId || !s.navigationTipOid || !Number.isFinite(s.rangeStart) || !Array.isArray(s.entities))
    throw new Error('分析数据需要升级，请重新分析仓库');
  const births = new Map(s.births.map(b => [b.id, b]));
  const events = new Map(s.events.map(e => [e.id, e]));
  const files = new Map(s.files.map(f => [f.entity, f]));
  const entities = new Map(s.entities.map(e => [e.entity, e]));
  if (entities.size !== s.entities.length || s.births.some(b => !entities.has(b.entity))
    || s.files.some(f => entities.get(f.entity)?.deleted || entities.get(f.entity)?.path !== f.path))
    throw new Error('文件历史身份不一致');
  if (s.activity && (new Set(s.activity.map(c => c.commit)).size !== s.activity.length
    || s.activity.some(c => !validOid(c.commit) || !Number.isSafeInteger(c.time) || c.time < s.rangeStart || c.time >= s.cutoff
      || new Set(c.files.map(f => f.entity)).size !== c.files.length
      || c.files.some(f => !entities.has(f.entity) || !Number.isSafeInteger(f.added) || f.added < 0
        || !Number.isSafeInteger(f.deleted) || f.deleted < 0))))
    throw new Error('提交改动汇总不一致');
  const rewritten = new Set<string>(), alive = new Set<string>();
  if (births.size !== s.births.length || events.size !== s.events.length) throw new Error('快照身份重复');
  for (const e of s.events) {
    if (!e.birthIds.length) throw new Error('首次重写关系不一致');
    for (const id of e.birthIds) {
      if (births.get(id)?.firstRewrite !== e.id || rewritten.has(id)) throw new Error('首次重写关系不一致');
      rewritten.add(id);
    }
    if (e.anchor) {
      const file = files.get(e.entity);
      if (!file || file.path !== e.anchor.path || e.anchor.start < 1 || e.anchor.start + e.anchor.count - 1 > file.lines.length)
        throw new Error('当前 anchor 越界');
    }
  }
  for (const b of s.births) if (b.firstRewrite && !rewritten.has(b.id)) throw new Error('出生事件引用缺失');
  for (const b of s.births) {
    const o = b.origin;
    if (s.originRuleVersion === ORIGIN_RULE && !o) throw new Error('代码来源记录缺失，请刷新索引');
    if (!o) continue; // schema 2 的旧快照仍可读取，由规则指纹触发重算。
    if (!['direct', 'inherited', 'merge-created', 'unverified'].includes(o.kind)
      || !validOid(o.commit) || !validOid(o.blob) || !safeGitPath(o.path) || !Number.isSafeInteger(o.line)
      || o.line < 1 || !Number.isSafeInteger(o.time)
      || (['merge-created', 'unverified'].includes(o.kind) && b.attribution !== 'unknown')
      || (o.kind === 'direct' && (o.commit !== b.commit || o.blob !== b.blob || o.path !== b.path || o.line !== b.line || o.time !== b.time)))
      throw new Error('代码来源身份不一致');
  }
  for (const f of s.files) for (const id of f.lines) if (id) {
    if (!births.has(id) || births.get(id)!.firstRewrite || alive.has(id)) throw new Error('存活身份无效');
    alive.add(id);
  }
}
