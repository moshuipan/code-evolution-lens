import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { Config, HISTORY_DAYS, METRIC_VERSION, ORIGIN_RULE, REPLAY_RULE, Snapshot } from './model';
import { attributionRule, normalizeProviders } from './attribution';

/** 为规则及身份生成稳定摘要，不将邮箱放入诊断日志。 */
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** 默认统计截止时间为本地当天零点，计算值使用 UTC 秒。 */
export function cutoffToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
}
/** 标准化规则并拒绝无法解释的配置。 */
export function normalizeConfig(input: Config): Config {
  // 仅复制当前配置字段，识别规则统一由 aiProviders 提供。
  const c: Config = { ref: input.ref, aiProviders: input.aiProviders,
    detectAiMessageMarkers: input.detectAiMessageMarkers ?? false,
    packageRoots: input.packageRoots, excludeGlobs: input.excludeGlobs };
  if (!c.ref || c.ref.startsWith('-') || /[\0\r\n]/.test(c.ref)) throw new Error('ref 无效');
  if (typeof c.detectAiMessageMarkers !== 'boolean')
    throw new Error('AI 规则开关必须为布尔值');
  c.aiProviders = normalizeProviders(c.aiProviders);
  c.packageRoots = [...new Set(c.packageRoots.map(x => x.replace(/\/+$/, '')))].sort();
  for (const p of c.packageRoots) if (!safeGitPath(p)) throw new Error('packageRoots 必须为仓库相对目录');
  c.excludeGlobs = [...new Set(c.excludeGlobs)].sort();
  return c;
}
/** 缓存指纹只涵盖事实规则；预算改变不修改已完成快照的语义。 */
export function configHash(c: Config): string {
  return snapshotConfigHash({ ref: c.ref, attributionHash: attributionHash(c),
    filterHash: hash([c.excludeGlobs, c.packageRoots]), replayHash: hash(REPLAY_RULE), metricVersion: METRIC_VERSION });
}
/** 从独立事实指纹构成总指纹，使仅重算归因时可以原样保留未知的用户过滤配置。 */
export function snapshotConfigHash(s: Pick<Snapshot, 'ref' | 'attributionHash' | 'filterHash' | 'replayHash' | 'metricVersion'>): string {
  return hash([s.ref, s.attributionHash, s.filterHash, s.replayHash, s.metricVersion, HISTORY_DAYS]);
}
/** 行来源算法与 AI 签名共同构成归因指纹；升级时旧快照必须重算。 */
export function attributionHash(c: Config): string { return hash([attributionRule(c), ORIGIN_RULE]); }
/** 仅接受 Git 常规仓库相对路径，拒绝穿越和 Windows 分隔符歧义。 */
export function safeGitPath(path: string): boolean {
  return !!path && !isAbsolute(path) && !/[\0\\]/.test(path)
    && !/^[A-Za-z]:/.test(path) && path.split('/').every(x => x !== '..' && x !== '.' && x !== '');
}
/** 使用系统路径边界检查工作区归属。 */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** 保留所有物理行与末尾换行差异，仅将 CRLF 规范为 LF。 */
export function textLines(content: Buffer): string[] | undefined {
  if (content.includes(0)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/\r\n/g, '\n');
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  } catch { return undefined; }
}
/** 出生过滤只影响统计资格，不改变物理位置。 */
export function eligible(path: string, line: string, c: Config): boolean {
  return /\S/.test(line) && !c.excludeGlobs.some(glob => minimatch(path, glob, { dot: true, nocase: false }));
}
/** 重叠包根使用最长匹配；默认按出生时顶层目录分组。 */
export function packageOf(path: string, roots: string[]): string {
  if (!roots.length) return path.includes('/') ? path.split('/')[0] : '（根目录）';
  return roots.filter(r => path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? '（其他）';
}
