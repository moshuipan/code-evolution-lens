import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, DEFAULT_CONFIG } from '../src/model';

export const DAY = 86400;
export const T = Date.parse('2026-11-05T00:00:00Z') / 1000;
export const CONFIG: Config = { ...DEFAULT_CONFIG,
  aiProviders: [...DEFAULT_CONFIG.aiProviders, { provider: '自定义 AI 身份', emails: ['robot'] }], excludeGlobs: ['vendor/**'] };
export const AI = 'Co-authored-by: Assistant <robot@example.test>';
export interface FixtureIdentity { authorName?: string; authorEmail?: string; committerName?: string; committerEmail?: string }

/** 独立临时 Git 仓库；所有提交只发生在 /tmp 中的测试 fixture。 */
export class Fixture {
  /** 记录受控临时路径。 */
  constructor(readonly root: string) {}
  /** 创建全新仓库，不读取用户全局 Git 配置。 */
  static async create(): Promise<Fixture> {
    const f = new Fixture(await realpath(await mkdtemp(join(tmpdir(), 'code-evolution-lens-test-'))));
    f.git(['init', '--initial-branch=main']); return f;
  }
  /** 执行参数数组命令，固定测试身份、时区及配置来源。 */
  git(args: string[], time = T - 21 * DAY, identity: FixtureIdentity = {}): string {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: identity.authorName ?? 'Fixture', GIT_AUTHOR_EMAIL: identity.authorEmail ?? 'fixture@example.test',
      GIT_COMMITTER_NAME: identity.committerName ?? 'Fixture', GIT_COMMITTER_EMAIL: identity.committerEmail ?? 'fixture@example.test',
      GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
    return execFileSync('git', args, { cwd: this.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  /** 写入文本或二进制测试对象。 */
  async write(path: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(join(this.root, path)), { recursive: true }); await writeFile(join(this.root, path), content);
  }
  /** 在临时仓库中记录一个提交，返回完整 OID。 */
  commit(time: number, message = 'fixture', identity: FixtureIdentity = {}): string {
    this.git(['add', '--all']);
    this.git(['commit', '--allow-empty', '-m', message], time, identity);
    return this.git(['rev-parse', 'HEAD']);
  }
  /** 移动 fixture 文件以测试 Git rename 识别。 */
  async move(from: string, to: string): Promise<void> {
    await mkdir(dirname(join(this.root, to)), { recursive: true }); await rename(join(this.root, from), join(this.root, to));
  }
  /** 仅清理当前测试创建的临时仓库。 */
  async dispose(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}
