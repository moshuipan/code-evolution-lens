import type { AiProvider } from './ai-providers';
import type { AttributionSignal } from './attribution';
import manifest from '../package.json';

export const WINDOW = 14 * 86400;
export const HISTORY_DAYS = 180;
export const METRIC_VERSION = 'weekly-first-parent-14d-v5:provider-survival-activity';
export const REPLAY_RULE = 'v2:window-line-identities:diff@8.0.4:Myers-lines:disjoint-and-forced-prefix-single-direction-exact:CRLF=LF:final-newline-significant:UTF8-fatal:rename50:limit1000:no-attributes:minimatch11.0.1';
export const ORIGIN_RULE = 'origin-v1:merge-blame-incremental:all-parents:no-ignore-revs:no-move-copy:exact-normalized-line:merge-created-unknown';
export type Attribution = 'ai' | 'unmarked' | 'unknown';
export interface Config {
  ref: string;
  detectAiMessageMarkers: boolean;
  aiProviders: AiProvider[];
  packageRoots: string[];
  excludeGlobs: string[];
}
export interface Commit {
  oid: string; parents: string[]; time: number; message: string;
  authorName: string; authorEmail: string; committerName: string; committerEmail: string;
}
export interface Birth {
  id: string; entity: string; owner: string; package: string;
  commit: string; blob: string; path: string; line: number; time: number;
  attribution: Attribution; firstRewrite?: string;
  attributionSignals?: AttributionSignal[];
  origin?: LineOrigin;
  sourceAuthor?: AuthorIdentity;
}
export interface AuthorIdentity { id: string; name: string }
export interface FileActivity { entity: string; added: number; deleted: number; complete: boolean }
export interface CommitActivity {
  commit: string; time: number; author: AuthorIdentity; merge: boolean;
  intent?: 'fix' | 'revert'; files: FileActivity[];
}
export interface LineOrigin {
  kind: 'direct' | 'inherited' | 'merge-created' | 'unverified';
  commit: string; path: string; line: number; time: number; blob: string;
}
export interface Anchor { path: string; start: number; count: number }
export interface RewriteEvent {
  id: string; entity: string; birthIds: string[];
  commit: string; parent: string; time: number;
  beforePath: string; afterPath?: string; beforeBlob: string; afterBlob?: string;
  beforeStart: number; beforeCount: number; afterStart: number; afterCount: number;
  anchor?: Anchor;
}
export interface FileState {
  entity: string; path: string; blob: string;
  /** 已读取的文本与物理行对齐；null 为窗外行，空数组也可表示尚无跟踪身份的未读取版本。 */
  lines: (string | null)[];
}
export interface FileEntity {
  entity: string; path: string; blob: string; deleted: boolean; excludedReason?: string;
}
export interface Gap { reason: string; commit?: string; path?: string; entity?: string; time?: number; birthIds?: string[] }
export interface Snapshot {
  schema: 2; id: string; repoId: string; root: string; ref: string;
  navigationTipOid: string; analysisTipOid?: string;
  cutoff: number; timeZone: string; createdAt: number;
  rangeStart: number;
  metricVersion: string; attributionHash: string; filterHash: string; replayHash: string;
  gitVersion: string; configHash: string; attributionConfigured: boolean;
  attributionRuleVersion?: string; attributionMessageMarkers?: boolean;
  originRuleVersion?: string;
  completeness: 'complete' | 'partial' | 'invalid';
  births: Birth[]; events: RewriteEvent[]; files: FileState[]; entities: FileEntity[]; gaps: Gap[];
  /** 窗口内主线文本改动；旧 schema 2 快照缺少此字段时要求重建。 */
  activity?: CommitActivity[];
  excluded: { objects: number; bytes: number; knownLines: number };
  work: { commits: number; objectBytes: number; elapsedMs: number };
}
export interface Aggregate {
  ai: number; aiRewritten: number; unmarked: number; unmarkedRewritten: number; unknown: number;
  complete: boolean; configured: boolean;
}
// 配置界面与运行时共用 manifest 默认值，避免示例列表和实际识别规则漂移。
const settings = manifest.contributes.configuration.properties;
export const DEFAULT_CONFIG: Config = {
  ref: settings['codeEvolutionLens.ref'].default,
  detectAiMessageMarkers: settings['codeEvolutionLens.detectAiMessageMarkers'].default,
  aiProviders: structuredClone(settings['codeEvolutionLens.aiProviders'].default),
  excludeGlobs: [...settings['codeEvolutionLens.excludeGlobs'].default],
  packageRoots: [],
};
