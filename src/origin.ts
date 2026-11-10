import { setImmediate } from 'node:timers/promises';
import { AttributionEngine } from './attribution';
import { GitAdapter } from './git';
import { AuthorIdentity, Birth, Commit, ORIGIN_RULE, Snapshot } from './model';
import { attributionHash, hash, textLines } from './rules';

/** 以 Git 作者名称和邮箱生成去重身份；持久化时只保存哈希与显示名称。 */
export function authorIdentity(commit: Commit): AuthorIdentity {
  return { id: hash([commit.authorName.trim(), commit.authorEmail.trim().toLowerCase()]), name: commit.authorName.trim() || '未署名作者' };
}

/** 只识别明确的提交标题声明，不把一般改动推断为缺陷修复。 */
export function commitIntent(message: string): 'fix' | 'revert' | undefined {
  const subject = message.split(/\r?\n/, 1)[0];
  if (/^(?:fix|bugfix|hotfix)(?:\([^()\r\n]+\))?!?:\s+\S/i.test(subject)) return 'fix';
  if (/^revert(?:\([^()\r\n]+\))?!?:\s+\S/i.test(subject) || /^Revert ".+"$/.test(subject)) return 'revert';
  return undefined;
}

/** 将排序后的物理行合并为 Git 可查询区间，空白和未统计行不进入归因。 */
function ranges(births: Birth[]): { start: number; count: number }[] {
  const result: { start: number; count: number }[] = [];
  for (const birth of births) {
    const previous = result.at(-1);
    if (previous && previous.start + previous.count === birth.line) previous.count++;
    else result.push({ start: birth.line, count: 1 });
  }
  return result;
}

/** 仅替换行归因；新增身份、主线坐标、主线时间和首次修改事件保持不变。 */
export async function resolveOrigins(snapshot: Snapshot, git: GitAdapter, engine: AttributionEngine,
  commits: Commit[], check: () => void, progress?: (done: number, total: number) => void): Promise<void> {
  const mainline = new Map(commits.map(commit => [commit.oid, commit]));
  const groups = new Map<string, Birth[]>();
  const texts = new Map<string, { lines: string[]; bytes: number }>();
  let textBytes = 0;
  /** 缓存规范化来源正文，避免重复 span 反复拆分大文件；额外内存限制为 16 MiB。 */
  const linesFor = async (blob: string): Promise<string[]> => {
    const cached = texts.get(blob);
    if (cached) { texts.delete(blob); texts.set(blob, cached); return cached.lines; }
    const bytes = await git.blob(blob), lines = textLines(bytes);
    if (!lines) throw new Error('来源代码不是普通 UTF-8 文本');
    texts.set(blob, { lines, bytes: bytes.length }); textBytes += bytes.length;
    while (textBytes > 16 * 1024 * 1024 && texts.size > 1) {
      const key = texts.keys().next().value!;
      textBytes -= texts.get(key)!.bytes; texts.delete(key);
    }
    return lines;
  };
  for (const birth of snapshot.births) {
    const key = `${birth.commit}\0${birth.path}`, group = groups.get(key) ?? [];
    group.push(birth); groups.set(key, group);
  }
  let done = 0;
  for (const births of groups.values()) {
    check();
    births.sort((a, b) => a.line - b.line);
    const first = births[0], commit = mainline.get(first.commit);
    if (!commit || commit.time !== first.time || births.some(b => b.blob !== first.blob || b.time !== first.time))
      throw new Error('主线新增记录无法核验');
    if (commit.parents.length < 2) {
      const decision = engine.attribute(commit);
      const author = authorIdentity(commit);
      for (const birth of births) {
        birth.attribution = decision.attribution; birth.attributionSignals = decision.signals;
        birth.origin = { kind: 'direct', commit: commit.oid, path: birth.path, line: birth.line, time: commit.time, blob: birth.blob };
        birth.sourceAuthor = author;
      }
    } else {
      try {
        const current = await linesFor(first.blob);
        const byLine = new Map(births.map(b => [b.line, b])), assigned = new Set<number>();
        const intervals = ranges(births);
        for (let at = 0; at < intervals.length; at += 128) {
          check();
          const spans = await git.blame(commit.oid, first.path, intervals.slice(at, at + 128));
          for (const span of spans) {
            check();
            const source = mainline.get(span.commit) ?? await git.commitInfo(span.commit);
            const blob = await git.treeBlob(source.oid, span.path);
            const sourceLines = await linesFor(blob);
            const decision = engine.attribute(source);
            const author = source.parents.length < 2 ? authorIdentity(source) : undefined;
            for (let offset = 0; offset < span.count; offset++) {
              const line = span.final + offset, birth = byLine.get(line);
              if (!birth) continue;
              if (assigned.has(line)) throw new Error('Git 来源坐标重复');
              const original = span.original + offset;
              if (current[line - 1] === undefined || sourceLines[original - 1] === undefined)
                throw new Error('Git 来源坐标越界');
              // blame 不区分末尾换行；只有完整规范化物理行相同时，才能继承来源。
              const verified = current[line - 1] === sourceLines[original - 1];
              birth.origin = { kind: !verified ? 'unverified' : source.parents.length > 1 ? 'merge-created' : 'inherited',
                commit: source.oid, path: span.path, line: original, time: source.time, blob };
              birth.attribution = verified ? decision.attribution : 'unknown';
              birth.attributionSignals = verified ? decision.signals : [];
              if (verified && author) birth.sourceAuthor = author; else delete birth.sourceAuthor;
              assigned.add(line);
            }
          }
        }
        if (assigned.size !== births.length) throw new Error('Git 来源追溯未覆盖全部新增代码');
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : '来源追溯失败'}（文件 ${first.path}，主线提交 ${commit.oid.slice(0, 12)}）`);
      }
    }
    check(); progress?.(++done, groups.size); await setImmediate(); check();
  }
  snapshot.attributionHash = attributionHash(git.config);
  snapshot.attributionConfigured = engine.configured;
  snapshot.attributionRuleVersion = engine.rule.version;
  snapshot.attributionMessageMarkers = engine.rule.messageSignals;
  snapshot.originRuleVersion = ORIGIN_RULE;
}
