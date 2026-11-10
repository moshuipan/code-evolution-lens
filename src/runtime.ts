import * as vscode from 'vscode';
import { join, relative, resolve } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { Config, DEFAULT_CONFIG, Snapshot } from './model';
import { configHash, cutoffToday, hash, inside, normalizeConfig } from './rules';
import { GitAdapter } from './git';
import { SnapshotStore } from './store';
import { QueryService } from './query';
import { TrendQuery } from './trends';
import { isHostFileUri } from './host';
import { issueForCode, issueForError, RepositoryError, RepositoryIssue } from './issues';
import { t } from './l10n';

export interface Repository {
  root: string; uri: vscode.Uri; id: string; name: string; config?: Config; issue?: RepositoryIssue;
  snapshot?: Snapshot; query?: QueryService; trends?: TrendQuery; status: string; stale: boolean; indexing?: boolean;
}
/** 从资源级配置生成可重复的事实规则。 */
export function readConfig(uri: vscode.Uri): Config {
  const c = vscode.workspace.getConfiguration('codeEvolutionLens', uri);
  return normalizeConfig({ ...Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k, c.get(k, v)])),
    packageRoots: [] } as unknown as Config);
}
/** 管理工作区仓库、worker 生命周期与活跃快照；同时只运行一个构建。 */
export class Runtime implements vscode.Disposable {
  readonly changed = new vscode.EventEmitter<void>();
  readonly statusChanged = new vscode.EventEmitter<void>();
  readonly repos: Repository[] = [];
  readonly snapshots = new Map<string, Snapshot>();
  readonly store: SnapshotStore;
  private worker?: Worker;
  private committing = false;
  private cancelled = false;
  private running = false;
  private cancelTimer?: NodeJS.Timeout;
  /** 所有缓存限定在扩展专用 storageUri 的 index 子目录。 */
  constructor(readonly context: vscode.ExtensionContext) {
    this.store = new SnapshotStore(join(context.storageUri!.fsPath, 'index'), context.asAbsolutePath('dist/sql-wasm.wasm'));
  }
  /** 在仓库所在宿主探测 Git；先建立稳定身份，使浅克隆补全后可以直接刷新。 */
  async discover(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let git: GitAdapter | undefined;
      let repo: Repository = { root: folder.uri.fsPath, uri: folder.uri, id: hash(folder.uri.fsPath),
        name: folder.name, status: '尚未索引 · 点击刷新', stale: true };
      try {
        if (!isHostFileUri(folder.uri, this.context)) throw new Error('此工作区不是当前宿主的磁盘目录，请打开本地或远端 Git 仓库根目录。');
        const workspace = await realpath(folder.uri.fsPath);
        repo = { ...repo, root: workspace, id: hash(workspace) };
        const config = readConfig(folder.uri);
        repo.config = config;
        git = new GitAdapter(workspace, config);
        const root = await realpath((await git.run(['rev-parse', '--show-toplevel'])).toString().trim());
        if (!inside(workspace, root)) throw new Error('仓库根位于当前工作区之外，请直接打开仓库根目录');
        const id = hash(root);
        if (this.repos.some(r => r.id === id)) continue;
        // Git 与缓存用真实路径；编辑器保留用户打开的路径（可能是符号链接）及远端 authority。
        repo = { ...repo, root, id };
        this.repos.push(repo);
        await git.probe();
        try {
          const cached = await this.store.load(id);
          if (cached && cached.root === root) this.install(repo, cached);
        } catch { repo.status = '缓存需要重建，请点击刷新索引'; }
      } catch (error) {
        repo.status = error instanceof Error ? error.message : '仓库不可用';
        repo.issue = issueForError(error);
        if (!this.repos.includes(repo)) this.repos.push(repo);
      } finally { git?.dispose(); }
    }
    await this.checkFreshness(); this.changed.fire();
  }
  /** 发布内存查询视图，快照及历史对象在本次会话中保留引用。 */
  install(repo: Repository, snapshot: Snapshot): void {
    repo.snapshot = snapshot; repo.query = new QueryService(snapshot); repo.trends = new TrendQuery(snapshot);
    repo.stale = false; repo.status = snapshot.completeness === 'complete' ? '已更新' : '部分历史无法读取';
    repo.issue = undefined;
    this.snapshots.set(snapshot.id, snapshot);
  }
  /** 刷新采用串行安全重建；旧快照仍可查询。 */
  async refresh(): Promise<void> {
    if (this.running) { void vscode.window.showInformationMessage(t('已有索引任务在运行')); return; }
    this.running = true; this.cancelled = false;
    try {
      for (const repo of this.repos) {
        if (this.cancelled) break;
        repo.indexing = true; repo.stale = true;
        repo.status = '准备索引'; this.changed.fire();
        try {
          if (!isHostFileUri(repo.uri, this.context)) throw new Error('请在仓库所在宿主打开 Git 工作区。');
          repo.config = undefined;
          repo.config = readConfig(repo.uri);
          const snapshot = await this.build(repo, repo.config);
          this.install(repo, snapshot);
          repo.indexing = false;
          await this.checkFreshness(repo);
        } catch (error) {
          repo.status = this.cancelled ? '索引已取消，保留上次结果' : error instanceof Error ? error.message : '索引失败';
          repo.issue = this.cancelled ? undefined : issueForError(error);
        }
        finally { repo.indexing = false; }
        this.changed.fire();
      }
    } finally { this.running = false; }
  }
  /** 启动独立 worker，进度消息不重建查询实例。 */
  private build(repo: Repository, config: Config): Promise<Snapshot> {
    return new Promise((resolveBuild, reject) => {
      const worker = new Worker(this.context.asAbsolutePath('dist/worker.js'), { workerData: {
        root: repo.root, config, cutoff: cutoffToday(), directory: this.store.directory, wasm: this.store.wasm,
      } });
      this.worker = worker; this.committing = false;
      let settled = false;
      /** 构建完成只结算一次，并释放取消定时器。 */
      const settle = (snapshot?: Snapshot, error?: Error) => {
        if (settled) return;
        settled = true; this.worker = undefined; this.committing = false;
        clearTimeout(this.cancelTimer); this.cancelTimer = undefined;
        if (snapshot) resolveBuild(snapshot); else reject(error ?? new Error('索引已取消'));
      };
      worker.on('message', message => {
        if (message.type === 'commit-ready' && !settled) {
          if (this.cancelled) worker.postMessage('cancel');
          else {
            this.committing = true;
            clearTimeout(this.cancelTimer); this.cancelTimer = undefined;
            worker.postMessage('commit');
          }
        }
        if (message.type === 'progress') {
          repo.status = message.phase === 'origin' ? t('正在追溯代码来源 {0}/{1}', message.done, message.total) : t('正在读取提交 {0}/{1}', message.done, message.total);
          this.statusChanged.fire();
        }
        if (message.type === 'complete') settle(message.snapshot);
        if (message.type === 'error') {
          const issue = issueForCode(message.code);
          settle(undefined, issue ? new RepositoryError(issue.code) : new Error(message.message));
        }
      });
      worker.on('error', () => settle(undefined, new Error('索引 worker 失败，请查看宿主日志；上次索引结果已保留')));
      worker.on('exit', () => settle());
    });
  }
  /** 提交批准前立即取消，1.5 秒后可强杀；批准后等待发布完成，后续仓库仍取消。 */
  cancel(): void {
    this.cancelled = true;
    const worker = this.worker;
    if (worker && !this.committing) {
      worker.postMessage('cancel');
      this.cancelTimer ??= setTimeout(() => { void worker.terminate(); }, 1500);
    }
  }
  /** 清缓存或停用前等待 worker 完全退出，防止重新写入。 */
  async stop(): Promise<void> {
    this.cancelled = true;
    const worker = this.worker;
    if (worker) await worker.terminate();
    clearTimeout(this.cancelTimer); this.cancelTimer = undefined;
  }
  /** 校验统计 ref、配置和日期；工作树 HEAD 仅在当前定位时要求一致。 */
  async checkFreshness(only?: Repository): Promise<void> {
    for (const repo of only ? [only] : this.repos) {
      const s = repo.snapshot;
      if (!s || repo.indexing || repo.issue) continue;
      let git: GitAdapter | undefined;
      try {
        repo.config = undefined;
        const config = readConfig(repo.uri);
        repo.config = config;
        git = new GitAdapter(repo.root, config);
        const tip = (await git.run(['rev-parse', '--verify', '--end-of-options', `${s.ref}^{commit}`])).toString().trim();
        const stale = s.cutoff !== cutoffToday() || s.configHash !== configHash(config)
          || s.navigationTipOid !== tip;
        if (stale !== repo.stale) {
          repo.stale = stale; repo.status = stale ? '日期、设置或分支有变化，请刷新索引' : s.completeness === 'complete' ? '已更新' : '部分历史无法读取';
          this.changed.fire();
        }
      } catch (error) {
        repo.stale = true;
        repo.status = error instanceof Error ? error.message : 'ref 不可读取，请刷新';
        this.changed.fire();
      }
      finally { git?.dispose(); }
    }
  }
  /** 同时核验 URI 宿主和文件系统边界，避免把其他远端的同名路径归入仓库。 */
  repository(uri: vscode.Uri): Repository | undefined {
    return this.repos.filter(r => r.uri.scheme === uri.scheme && r.uri.authority === uri.authority && inside(r.uri.fsPath, uri.fsPath))
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  }
  /** 同时核验编辑器、磁盘和固定 blob；已保存未提交文本也不能获得精确标记。 */
  async verifiedDocument(document: vscode.TextDocument, snapshot: Snapshot): Promise<string | undefined> {
    const repo = this.repository(document.uri);
    if (!repo?.config || repo.stale || repo.snapshot?.id !== snapshot.id || document.isDirty || snapshot.completeness === 'invalid') return undefined;
    const path = relative(repo.uri.fsPath, document.uri.fsPath).split('\\').join('/');
    const file = snapshot.files.find(f => f.path === path);
    if (!file) return undefined;
    const git = new GitAdapter(repo.root, repo.config);
    try {
      if (!inside(repo.root, await realpath(document.uri.fsPath))) return undefined;
      const head = (await git.run(['rev-parse', '--verify', 'HEAD'])).toString().trim();
      const tip = (await git.run(['rev-parse', '--verify', '--end-of-options', `${snapshot.ref}^{commit}`])).toString().trim();
      if (head !== snapshot.navigationTipOid || tip !== head || snapshot.cutoff !== cutoffToday()) return undefined;
      const blob = (await git.blob(file.blob)).toString('utf8').replace(/\r\n/g, '\n');
      const disk = (await readFile(document.uri.fsPath, 'utf8')).replace(/\r\n/g, '\n');
      return blob === document.getText().replace(/\r\n/g, '\n') && disk === blob ? file.entity : undefined;
    } catch { return undefined; } finally { git.dispose(); }
  }
  /** 当前路径在打开前核验真实路径，防止符号链接越出仓库。 */
  async currentUri(snapshot: Snapshot, path: string): Promise<vscode.Uri | undefined> {
    const repo = this.repos.find(r => r.id === snapshot.repoId && r.root === snapshot.root);
    if (!repo) return undefined;
    const candidate = resolve(snapshot.root, path);
    try { return inside(snapshot.root, candidate) && inside(snapshot.root, await realpath(candidate))
      ? vscode.Uri.joinPath(repo.uri, relative(repo.root, candidate).split('\\').join('/')) : undefined; }
    catch { return undefined; }
  }
  /** 停止后台任务并释放事件资源。 */
  dispose(): void { this.cancel(); this.changed.dispose(); this.statusChanged.dispose(); }
}
