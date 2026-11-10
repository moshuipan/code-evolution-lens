import type { Attribution, Commit, Config } from './model';
import { AI_RULE_VERSION, AiProvider } from './ai-providers';

export type SignalKind = 'author-email' | 'committer-email' | 'coauthor-email' | 'coauthor-name'
  | 'generated-trailer' | 'message-marker' | 'subject-tag' | 'subject-prefix';
export interface AttributionSignal { kind: SignalKind; provider: string }
export interface AttributionDecision { attribution: Attribution; signals: AttributionSignal[] }
type CommitIdentity = Pick<Commit, 'message' | 'parents' | 'authorName' | 'authorEmail' | 'committerName' | 'committerEmail'>;
const FIELDS = ['nameTokens', 'emails', 'bracketTags', 'messageMarkers', 'subjectPrefixes'] as const;
export interface AttributionRule {
  version: string; messageSignals: boolean; providers: AiProvider[];
}

/** 从 Git 身份字段中提取邮箱名；配置值另行校验，不能使用完整邮箱地址。 */
function emailName(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!/^[^<>\s@]+(?:@[^<>\s@]+)?$/.test(value)) return undefined;
  return value.split('@', 1)[0];
}

/** GitHub 的数字前缀是账号 ID；仅为其 noreply 域添加去前缀别名，保留普通邮箱的加号。 */
function identityEmailNames(input: string): string[] {
  const name = emailName(input);
  if (!name) return [];
  const github = /^(\d+)\+([^<>\s@]+)@users\.noreply\.github\.com$/i.exec(input.trim());
  return github ? [name, github[2].toLowerCase()] : [name];
}

/** 校验邮箱配置只能填写名称，例如 codex；完整邮箱报错，不自动截断或迁移。 */
export function normalizeEmailNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 64
    || input.some(value => typeof value !== 'string' || value.length > 256 || !/^[^<>\s@]+$/.test(value.trim())))
    throw new Error('aiProviders.emails 请填写邮箱名数组，例如 ["codex"]；不要填写 @ 或域名，最多 64 项。');
  return [...new Set(input.map(value => value.trim().toLowerCase()))].sort();
}

/** 校验并规范化签名列表，避免拼写错误被静默忽略或失去预算约束。 */
export function normalizeProviders(input: unknown): AiProvider[] {
  if (!Array.isArray(input) || input.length > 128) throw new Error('aiProviders 必须是最多 128 项的签名数组');
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'provider' && !FIELDS.includes(key as typeof FIELDS[number])))
      throw new Error('aiProviders 包含未知字段或无效对象');
    const provider = value as AiProvider;
    if (typeof provider.provider !== 'string' || !provider.provider.trim() || provider.provider.length > 128
      || /[\0\r\n]/.test(provider.provider)) throw new Error('AI 提供者名称无效');
    const result: AiProvider = { provider: provider.provider.trim() };
    for (const field of FIELDS) {
      const items = provider[field] ?? [];
      if (!Array.isArray(items) || items.length > 64
        || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 256 || /[\0\r\n]/.test(item)))
        throw new Error(`AI 签名 ${field} 必须为最多 64 项的非空字面字符串`);
      result[field] = [...new Set(items.map(item => item.trim().toLowerCase()))].sort();
    }
    result.emails = normalizeEmailNames(result.emails);
    if (result.bracketTags!.some(tag => !/^[a-z0-9][a-z0-9 _.-]{1,30}$/.test(tag)))
      throw new Error('aiProviders.bracketTags 请填写不带方括号的标题标签，例如 ["claude"]；使用 2—31 个英文字母、数字、空格或 _ . -，首位为字母或数字。');
    if (!FIELDS.some(field => result[field]!.length)) throw new Error('AI 提供者至少需要一项匹配规则');
    return result;
  });
}

/** 只使用生效的 provider 数组；合并显式同名规则，不在后台补回默认项。 */
export function attributionRule(config: Config): AttributionRule {
  const providers = new Map<string, AiProvider>();
  for (const item of normalizeProviders(config.aiProviders)) {
    const key = item.provider.toLowerCase();
    const merged = providers.get(key) ?? { provider: item.provider };
    for (const field of FIELDS) merged[field] = [...new Set([...(merged[field] ?? []), ...(item[field] ?? [])]
      .map(value => value.trim().toLowerCase()))].sort();
    providers.set(key, merged);
  }
  return { version: AI_RULE_VERSION, messageSignals: config.detectAiMessageMarkers,
    providers: [...providers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) };
}

/** 从归因声明提取名称和邮箱，兼容 Name <email>、Name email、纯邮箱和纯名称。 */
function trailerIdentity(value: string): { name: string; email?: string } | undefined {
  const text = value.trim();
  const bracketed = /^([^<>@]*?)\s*<([^<>\s@]+@[^<>\s@]+)>$/.exec(text);
  if (bracketed) return { name: bracketed[1].trim().toLowerCase(), email: bracketed[2] };
  if (/[<>]/.test(text)) return undefined;
  const bare = /^(?:(.*?)\s+)?([^<>\s@]+@[^<>\s@]+)$/.exec(text);
  if (bare && !(bare[1] ?? '').includes('@'))
    return { name: (bare[1] ?? '').trim().toLowerCase(), email: bare[2] };
  // 孤立 @ 或多个邮箱不是名称；不能从坏格式中截出 Claude 等词进行归因。
  return text.includes('@') ? undefined : { name: text.toLowerCase() };
}

/** 提取真正的结尾 trailer 块，续行归入上一字段；正文中的示例不参与默认归因。 */
function trailers(message: string): { key: string; value: string }[] {
  const lines = message.trimEnd().split(/\r?\n/);
  let start = lines.length;
  while (start > 0 && /^(?:[A-Za-z][A-Za-z0-9-]*:\s*.*|[ \t]+\S.*)$/.test(lines[start - 1])) start--;
  if (start === 0 || start === lines.length || lines[start - 1].trim()
    || !lines.slice(0, start - 1).some(line => line.trim())) return [];
  const result: { key: string; value: string }[] = [];
  for (const line of lines.slice(start)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (match) result.push({ key: match[1].toLowerCase(), value: match[2].trim() });
    else if (result.length) result.at(-1)!.value += ` ${line.trim()}`;
    else return [];
  }
  return result;
}

/** 只匹配名称中的完整词或短语，避免 McClaude、MyCursor 等部分名称命中。 */
function nameMatches(name: string, token: string): boolean {
  const word = /[\p{L}\p{N}_]/u;
  let index = name.indexOf(token);
  while (index !== -1) {
    const before = Array.from(name.slice(0, index)).at(-1) ?? '';
    const after = Array.from(name.slice(index + token.length))[0] ?? '';
    if (!word.test(before) && !word.test(after)) return true;
    index = name.indexOf(token, index + 1);
  }
  return false;
}

/** 编译一次有效规则后复用于整条主线；信号只保存类型与提供者，不持久化邮箱正文。 */
export class AttributionEngine {
  readonly rule: AttributionRule;
  readonly configured: boolean;
  private readonly emailProviders = new Map<string, Set<string>>();
  /** 建立精确邮箱名索引；同名不同域账号按相同配置匹配。 */
  constructor(config: Config) {
    this.rule = attributionRule(config);
    for (const provider of this.rule.providers) for (const email of provider.emails ?? []) {
      const matches = this.emailProviders.get(email) ?? new Set();
      matches.add(provider.provider); this.emailProviders.set(email, matches);
    }
    this.configured = !!this.emailProviders.size || this.rule.providers.some(provider =>
      !!provider.nameTokens?.length || (this.rule.messageSignals
        && !!(provider.messageMarkers?.length || provider.bracketTags?.length || provider.subjectPrefixes?.length)));
  }
  /** 依据身份名称或显式标记归因；merge 交给来源追溯，清空全部规则时仍为未知。 */
  attribute(commit: CommitIdentity): AttributionDecision {
    if (commit.parents.length > 1 || !this.configured) return { attribution: 'unknown', signals: [] };
    const signals = new Map<string, AttributionSignal>();
    /** 去重同一种提供者信号，避免重复 trailer 产生重复证据。 */
    const add = (kind: SignalKind, provider: string) => signals.set(`${kind}:${provider}`, { kind, provider });
    /** 比较完整邮箱名与 GitHub 账号别名；同名规则去重，普通邮箱不删除加号前缀。 */
    const email = (value: string, kind: SignalKind) => {
      const providers = new Set(identityEmailNames(value).flatMap(name => [...(this.emailProviders.get(name) ?? [])]));
      if (!providers.size) return;
      // noreply 等名称被多个工具共用时，只确认命中 AI 规则，不伪造具体工具身份。
      if (providers.size > 1) add(kind, 'AI 邮箱名（提供者不唯一）');
      else add(kind, providers.values().next().value!);
    };
    email(commit.authorEmail, 'author-email'); email(commit.committerEmail, 'committer-email');
    for (const trailer of trailers(commit.message)) {
      const coauthor = trailer.key === 'co-authored-by';
      if (!coauthor && !['generated-by', 'assisted-by', 'created-by'].includes(trailer.key)) continue;
      const identity = trailerIdentity(trailer.value);
      if (!identity) continue;
      if (identity.email) email(identity.email, coauthor ? 'coauthor-email' : 'generated-trailer');
      for (const provider of this.rule.providers) {
        if (provider.nameTokens?.some(token => nameMatches(identity.name, token)))
          add(coauthor ? 'coauthor-name' : 'generated-trailer', provider.provider);
      }
    }
    if (this.rule.messageSignals) {
      const message = commit.message.toLowerCase(), subject = message.split('\n', 1)[0].trim();
      const tags = new Set([...subject.matchAll(/\[([a-z0-9][a-z0-9 _.-]{1,30})\]/g)].map(match => match[1].trim()));
      for (const provider of this.rule.providers) {
        if (provider.messageMarkers?.some(marker => message.includes(marker))) add('message-marker', provider.provider);
        if (provider.bracketTags?.some(tag => tags.has(tag))) add('subject-tag', provider.provider);
        if (provider.subjectPrefixes?.some(prefix => subject.startsWith(prefix)
          && !/[\p{L}\p{N}_]/u.test(subject.slice(prefix.length, prefix.length + 1)))) add('subject-prefix', provider.provider);
      }
    }
    return { attribution: signals.size ? 'ai' : 'unmarked', signals: [...signals.values()] };
  }
}
