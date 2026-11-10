import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { AttributionEngine } from './attribution';
import { GitAdapter } from './git';
import { Config, HISTORY_DAYS, METRIC_VERSION, REPLAY_RULE, Snapshot } from './model';
import { resolveOrigins } from './origin';
import { replay, ReplayOptions, validateSnapshot } from './replay';
import { configHash, hash, normalizeConfig } from './rules';
import { daysBefore } from './time';

/** 同主线、日期和回放规则的完整旧快照只重算归因；其他变化仍从根回放。 */
export async function buildIndex(root: string, input: Config, options: ReplayOptions, previous?: Snapshot): Promise<Snapshot> {
  const config = normalizeConfig(input), started = Date.now();
  const git = new GitAdapter(root, config, options.signal);
  /** 暖重算保留用户取消入口，候选失败不会触碰旧快照。 */
  const check = () => { options.signal?.throwIfAborted(); };
  try {
    const probe = await git.probe(), canonicalRoot = await realpath(probe.root);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (previous?.completeness === 'complete' && previous.root === canonicalRoot && previous.ref === config.ref
      && previous.navigationTipOid === probe.tip && previous.cutoff === options.cutoff && previous.timeZone === timeZone
      && previous.rangeStart === daysBefore(options.cutoff, HISTORY_DAYS, timeZone)
      && previous.filterHash === hash([config.excludeGlobs, config.packageRoots])
      && previous.replayHash === hash(REPLAY_RULE) && previous.metricVersion === METRIC_VERSION) {
      validateSnapshot(previous); check();
      const snapshot = structuredClone(previous);
      snapshot.id = randomUUID(); snapshot.createdAt = options.now ?? Date.now() / 1000;
      snapshot.configHash = configHash(config); snapshot.gitVersion = probe.version;
      const commits = await git.commits(probe.tip);
      await resolveOrigins(snapshot, git, new AttributionEngine(config), commits, check, options.originProgress ?? options.progress);
      snapshot.work = { commits: commits.length, objectBytes: git.bytes, elapsedMs: Date.now() - started };
      validateSnapshot(snapshot); return snapshot;
    }
  } finally { await git.dispose(); }
  return replay(root, config, options);
}
