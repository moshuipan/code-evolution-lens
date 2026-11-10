import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, Commit } from './model';
import { safeGitPath } from './rules';
import { RepositoryError } from './issues';

export interface Change { oldMode: string; newMode: string; before: string; after: string; status: string; oldPath: string; newPath: string }
export interface BlameSpan { commit: string; path: string; original: number; final: number; count: number }
interface BlobRead {
  oid: string; header: Buffer; chunks: Buffer[]; size?: number; received: number;
  resolve: (data: Buffer) => void; reject: (error: Error) => void;
}
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GLOBAL = ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'diff.renames=true', '-c', 'diff.renameLimit=1000', '-c', 'diff.algorithm=myers',
  '-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null'];
/** 对对象身份做白名单校验。 */
export function validOid(value: string): boolean { return OID.test(value); }
/** 固定 Git 环境，禁止隐式联网、交互和非必要锁。 */
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
}
/** 解码 Git 的 C 风格路径，包括换行与八进制字节，再校验 UTF-8 和目录边界。 */
export function decodeGitPath(value: string): string {
  let path = value;
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error('Git 来源路径无法解析');
    const bytes: Buffer[] = [];
    const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    const body = value.slice(1, -1);
    for (let i = 0; i < body.length;) {
      if (body[i] !== '\\') {
        let end = i + 1; while (end < body.length && body[end] !== '\\') end++;
        bytes.push(Buffer.from(body.slice(i, end))); i = end; continue;
      }
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (octal) { bytes.push(Buffer.from([parseInt(octal[0], 8)])); i += 4; }
      else {
        const escaped = escapes[body[i + 1]];
        if (escaped === undefined) throw new Error('Git 来源路径转义无效');
        bytes.push(Buffer.from(escaped)); i += 2;
      }
    }
    path = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes));
  }
  if (!safeGitPath(path) || path.includes('\uFFFD')) throw new Error('Git 来源路径编码无效');
  return path;
}
/** 只读 Git 对象适配层；参数数组隔离命令，处理完整输出并支持用户取消。 */
export class GitAdapter {
  readonly children = new Set<ChildProcessWithoutNullStreams>();
  bytes = 0;
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private diffRepository?: string;
  private objectDirectory?: string;
  private objectsChecked = false;
  private commitCache = new Map<string, Commit>();
  private treeCache = new Map<string, string>();
  private batchProcess?: ChildProcessWithoutNullStreams;
  private batchPending?: BlobRead;
  private blobQueue: Promise<void> = Promise.resolve();
  /** 为同一仓库绑定引用配置和取消信号。 */
  constructor(readonly root: string, readonly config: Config, readonly signal?: AbortSignal) {}
  /** 完整执行只读 Git 查询；不按时长或输出量截断，stderr 不携带到诊断输出。 */
  run(args: string[], isolatedDiff = false): Promise<Buffer> {
    this.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const env = environment();
      if (isolatedDiff) env.GIT_OBJECT_DIRECTORY = this.objectDirectory;
      const child = spawn('git', [...GLOBAL, ...(isolatedDiff ? [`--git-dir=${this.diffRepository}`] : []), ...args], {
        cwd: this.root, env, stdio: 'pipe',
      });
      this.children.add(child);
      let error = '', failed: Error | undefined;
      let abortTimer: NodeJS.Timeout | undefined;
      const chunks: Buffer[] = [];
      /** 在用户取消时中止 Git。 */
      const abort = () => {
        failed ??= new Error('索引已取消');
        // 给在途只读查询 100ms 收尾；未退出时终止，阻止后续查询立即生效。
        abortTimer = setTimeout(() => child.kill('SIGTERM'), 100);
      };
      this.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { chunks.push(data); });
      child.stderr.on('data', (data: Buffer) => { if (error.length < 4096) error += data.toString(); });
      child.on('error', () => { failed = new Error('无法在工作区宿主启动 Git。请在同一宿主安装 Git 并检查 PATH，然后重载窗口；远端工作区需在远端安装。'); });
      child.on('close', code => {
        clearTimeout(abortTimer); this.children.delete(child); this.signal?.removeEventListener('abort', abort);
        if (failed) reject(failed);
        else if (code !== 0) reject(new Error(`Git ${args[0]} 失败（退出码 ${code}）`));
        else if (/rename detection was skipped|too many files/i.test(error)) reject(new Error('rename 检测超过固定预算'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end();
    });
  }
  /** 在读取对象之前拒绝未验证的仓库模式。 */
  async probe(): Promise<{ root: string; tip: string; version: string }> {
    const root = (await this.run(['rev-parse', '--show-toplevel'])).toString().trim();
    if ((await this.run(['rev-parse', '--is-shallow-repository'])).toString().trim() === 'true')
      throw new RepositoryError('shallow-clone');
    const entries = (await this.run(['config', '--local', '--list'])).toString();
    if (/(?:extensions\.partialclone|remote\.[^\n=]+\.promisor)=(?!false)/i.test(entries))
      throw new Error('不支持 partial clone：不会自动下载缺失对象');
    if (/core\.sparsecheckout=true/i.test(entries)) throw new Error('不支持 sparse checkout');
    const sparse = (await this.run(['config', '--list'])).toString();
    if (/core\.sparsecheckout=true/i.test(sparse)) throw new Error('不支持 sparse checkout');
    const superRoot = (await this.run(['rev-parse', '--show-superproject-working-tree'])).toString().trim();
    if (superRoot) throw new Error('不支持子模块工作区');
    const tip = (await this.run(['rev-parse', '--verify', '--end-of-options', `${this.config.ref}^{commit}`])).toString().trim();
    if (!validOid(tip)) throw new Error('ref 未解析为提交');
    return { root, tip, version: (await this.run(['--version'])).toString().trim() };
  }
  /** 隔离 raw diff 的属性与配置来源；临时 bare 元数据只读共享原仓库对象目录。 */
  private async prepareDiffRepository(): Promise<void> {
    if (this.diffRepository) return;
    this.objectDirectory = resolve(this.root, (await this.run(['rev-parse', '--git-path', 'objects'])).toString().trim());
    const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-git-'));
    this.diffRepository = directory;
    await mkdir(join(directory, 'objects')); await mkdir(join(directory, 'refs'));
    await writeFile(join(directory, 'HEAD'), 'ref: refs/heads/unborn\n');
    await writeFile(join(directory, 'config'), '[core]\n\tbare = true\n');
  }
  /** 沿固定主线读取元数据，不使用时间筛选提前截断。 */
  async commits(tip: string): Promise<Commit[]> {
    if (!validOid(tip)) throw new Error('提交身份无效');
    const raw = await this.run(['log', '--no-show-signature', '--first-parent', '--reverse',
      '--format=%H%x00%P%x00%ct%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00', tip]);
    const fields = raw.toString('utf8').split('\0');
    const commits: Commit[] = [];
    for (let i = 0; i + 7 < fields.length; i += 8) {
      const oid = fields[i].trim();
      if (!validOid(oid)) throw new Error('提交记录无法解析');
      commits.push({ oid, parents: fields[i + 1].split(' ').filter(Boolean), time: Number(fields[i + 2]),
        authorName: fields[i + 3], authorEmail: fields[i + 4], committerName: fields[i + 5], committerEmail: fields[i + 6],
        message: fields[i + 7] });
    }
    if (commits[0]?.parents.length) throw new Error('主线历史不完整，无法从根回放');
    return commits;
  }
  /** 读取来源提交的完整消息与身份，保留 trailer；缓存有界且不依赖 blame 的摘要。 */
  async commitInfo(oid: string): Promise<Commit> {
    if (!validOid(oid)) throw new Error('来源提交身份无效');
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const fields = (await this.run(['show', '--no-show-signature', '-s', '--no-patch',
      '--format=%H%x00%P%x00%ct%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00', oid])).toString('utf8').split('\0');
    if (fields.length !== 9 || fields[0].trim() !== oid || !Number.isSafeInteger(Number(fields[2])))
      throw new Error('来源提交元数据无法解析');
    const commit: Commit = { oid, parents: fields[1].split(' ').filter(Boolean), time: Number(fields[2]),
      authorName: fields[3], authorEmail: fields[4], committerName: fields[5], committerEmail: fields[6], message: fields[7] };
    if (this.commitCache.size >= 2048) this.commitCache.delete(this.commitCache.keys().next().value!);
    this.commitCache.set(oid, commit); return commit;
  }
  /** 用字面路径在不可变树中定位普通文件 blob，避免工作树、路径表达式和用户属性参与。 */
  async treeBlob(oid: string, path: string): Promise<string> {
    if (!validOid(oid) || !safeGitPath(path)) throw new Error('来源代码身份无效');
    const key = `${oid}\0${path}`, cached = this.treeCache.get(key);
    if (cached) return cached;
    await this.prepareDiffRepository();
    const records = (await this.run(['ls-tree', '-z', oid, '--', path], true)).toString('utf8').split('\0').filter(Boolean);
    const match = records.length === 1 ? /^(100\d{3}) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(records[0]) : null;
    if (!match || match[3] !== path || !validOid(match[2])) throw new Error('来源代码版本无法核验');
    if (this.treeCache.size >= 4096) this.treeCache.delete(this.treeCache.keys().next().value!);
    this.treeCache.set(key, match[2]); return match[2];
  }
  /** 对合并新增区间追溯全部父分支；固定关闭忽略提交和跨文件移动／复制推断。 */
  async blame(oid: string, path: string, ranges: { start: number; count: number }[]): Promise<BlameSpan[]> {
    if (!validOid(oid) || !safeGitPath(path) || ranges.length > 128 || !ranges.length
      || ranges.some(r => !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.count) || r.start < 1 || r.count < 1))
      throw new Error('来源追溯区间无效');
    await this.prepareDiffRepository();
    const raw = (await this.run(['blame', '--incremental', '--root', '--ignore-revs-file', '',
      ...ranges.flatMap(r => ['-L', `${r.start},${r.start + r.count - 1}`]), oid, '--', path], true)).toString('utf8');
    const spans: BlameSpan[] = [];
    let current: Omit<BlameSpan, 'path'> | undefined;
    for (const line of raw.split('\n')) {
      const header = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+) (\d+)$/.exec(line);
      if (header) {
        if (current) throw new Error('Git 来源记录不完整');
        current = { commit: header[1], original: Number(header[2]), final: Number(header[3]), count: Number(header[4]) };
        if ([current.original, current.final, current.count].some(n => !Number.isSafeInteger(n) || n < 1))
          throw new Error('Git 来源坐标无效');
      } else if (line.startsWith('filename ')) {
        if (!current) throw new Error('Git 来源记录缺少提交');
        spans.push({ ...current, path: decodeGitPath(line.slice(9)) }); current = undefined;
      }
    }
    if (current) throw new Error('Git 来源记录不完整');
    return spans;
  }
  /** 获取 NUL 分隔的完整 OID 差异，固定 rename 阈值和检测预算。 */
  async changes(commit: Commit): Promise<Change[]> {
    await this.prepareDiffRepository();
    const base = commit.parents[0];
    const args = ['diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-abbrev',
      '--no-ext-diff', '--no-textconv', '--no-indent-heuristic', '--ignore-submodules=none',
      '-M50%', '-l1000', ...(base ? [base, commit.oid] : ['--root', commit.oid])];
    const parts = (await this.run(args, true)).toString('utf8').split('\0');
    const changes: Change[] = [];
    for (let i = 0; i < parts.length && parts[i];) {
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(parts[i++]);
      if (!m) throw new Error('Git raw diff 无法解析');
      const oldPath = parts[i++], newPath = m[5].startsWith('R') ? parts[i++] : oldPath;
      if (!safeGitPath(oldPath) || !safeGitPath(newPath) || oldPath.includes('\uFFFD') || newPath.includes('\uFFFD'))
        throw new Error('仓库包含不支持的路径编码');
      if (m[1] === '160000' || m[2] === '160000') throw new Error('主线包含子模块，首版不支持');
      changes.push({ oldMode: m[1], newMode: m[2], before: m[3], after: m[4], status: m[5], oldPath, newPath });
    }
    return changes;
  }
  /** 完整读取不可变 blob；LRU 淘汰只控制缓存保留量，不限制可分析文件大小。 */
  async blob(oid: string): Promise<Buffer> {
    const previous = this.blobQueue;
    let release!: () => void;
    this.blobQueue = new Promise<void>(resolveQueue => { release = resolveQueue; });
    await previous;
    try { return await this.loadBlob(oid); } finally { release(); }
  }
  /** 串行共享只读 cat-file 进程，省去每个对象的大小和正文两次进程启动。 */
  private async loadBlob(oid: string): Promise<Buffer> {
    this.signal?.throwIfAborted();
    if (!validOid(oid)) throw new Error('blob 身份无效');
    if (!this.objectsChecked) {
      const config = (await this.run(['config', '--list'])).toString();
      if (/(?:extensions\.partialclone|remote\.[^\n=]+\.promisor)=(?!false)/i.test(config))
        throw new Error('不支持 partial clone：不会自动下载缺失对象');
      this.objectsChecked = true;
    }
    const cached = this.cache.get(oid);
    if (cached) { this.cache.delete(oid); this.cache.set(oid, cached); return cached; }
    const data = await this.batchBlob(oid);
    this.bytes += data.length;
    this.cache.set(oid, data); this.cacheBytes += data.length;
    while (this.cacheBytes > 16 * 1024 * 1024 && this.cache.size > 1) {
      const key = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(key)!.length; this.cache.delete(key);
    }
    return data;
  }
  /** 失败立即拒绝待处理对象并终止进程；任何残缺正文均不会进入缓存。 */
  private failBatch(error: Error): void {
    const pending = this.batchPending;
    this.batchPending = undefined;
    if (pending) pending.reject(error);
    const child = this.batchProcess;
    this.batchProcess = undefined;
    if (pending) child?.kill('SIGTERM'); else child?.stdin.end();
  }
  /** 校验 batch 协议的类型、OID 和声明长度，不限制对象大小或累计读取量。 */
  private acceptBlobChunk(chunk: Buffer): void {
    const pending = this.batchPending;
    if (!pending) throw new Error('Git 对象响应没有对应请求');
    if (pending.size === undefined) {
      const buffered = Buffer.concat([pending.header, chunk]), end = buffered.indexOf(10);
      if (end < 0) {
        if (buffered.length > 4096) throw new Error('Git 对象头超过预算');
        pending.header = buffered; return;
      }
      if (end > 4096) throw new Error('Git 对象头超过预算');
      const match = /^([0-9a-f]+) blob (\d+)$/.exec(buffered.subarray(0, end).toString('ascii'));
      if (!match || match[1] !== pending.oid) throw new Error('Git blob 不存在或对象响应无法核验');
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('blob 大小无法核验');
      pending.size = size; pending.header = Buffer.alloc(0); chunk = buffered.subarray(end + 1);
    }
    pending.received += chunk.length;
    if (pending.received > pending.size + 1) throw new Error('Git 对象正文超过声明大小');
    if (chunk.length) pending.chunks.push(chunk);
    if (pending.received === pending.size + 1) {
      const data = Buffer.concat(pending.chunks);
      if (data[data.length - 1] !== 10) throw new Error('Git 对象结束标记无效');
      this.batchPending = undefined;
      pending.resolve(data.subarray(0, -1));
    }
  }
  /** 一次仅提交一个十六进制 OID；按二进制长度读取完整正文，取消或退出拒绝未完成对象。 */
  private batchBlob(oid: string): Promise<Buffer> {
    this.signal?.throwIfAborted();
    if (!this.batchProcess) {
      const child = spawn('git', [...GLOBAL, 'cat-file', '--batch'], { cwd: this.root, env: environment(), stdio: 'pipe' });
      this.batchProcess = child; this.children.add(child);
      /** 取消时中止共享查询，不继续读取后续对象。 */
      const abort = () => this.failBatch(new Error('索引已取消'));
      this.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => {
        if (this.batchProcess !== child) return;
        try { this.acceptBlobChunk(data); } catch (error) { this.failBatch(error instanceof Error ? error : new Error('Git 对象读取失败')); }
      });
      child.stderr.on('data', () => {}); // 不把代码、身份或仓库诊断正文转发给用户。
      child.stdin.on('error', () => { if (this.batchProcess === child) this.failBatch(new Error('Git 对象查询管道已关闭')); });
      child.on('error', () => { if (this.batchProcess === child) this.failBatch(new Error('无法在工作区宿主启动 Git')); });
      child.on('close', () => {
        this.children.delete(child); this.signal?.removeEventListener('abort', abort);
        if (this.batchProcess === child) this.failBatch(new Error('Git 对象查询提前结束'));
      });
    }
    if (this.batchPending) throw new Error('Git 对象请求未串行化');
    return new Promise((resolveBlob, reject) => {
      this.batchPending = { oid, header: Buffer.alloc(0), chunks: [], received: 0, resolve: resolveBlob, reject };
      this.batchProcess!.stdin.write(`${oid}\n`);
    });
  }
  /** 释放缓存并终止所有在途 Git 查询。 */
  async dispose(): Promise<void> {
    const batch = this.batchProcess;
    if (this.batchPending) this.failBatch(new Error('Git 对象查询已关闭'));
    else if (batch) {
      // 已完成的 batch 通过 EOF 正常退出，避免每次成功索引都发送终止信号。
      this.batchProcess = undefined; this.children.delete(batch); batch.stdin.end();
    }
    for (const child of this.children) child.kill('SIGTERM');
    this.cache.clear();
    this.commitCache.clear(); this.treeCache.clear();
    if (this.diffRepository) await rm(this.diffRepository, { recursive: true, force: true });
  }
}
