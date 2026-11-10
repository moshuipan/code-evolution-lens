import * as vscode from 'vscode';
import { relative } from 'node:path';
import { rm } from 'node:fs/promises';
import { Runtime } from './runtime';
import { LensTree, TreeNode } from './tree';
import { TrendsPanel } from './trends-panel';
import { Selection } from './presentation';
import { Decorations } from './decorations';
import { HistoryProvider } from './history';
import { activationProblem } from './host';
import { t, setLanguage, currentLanguage, localizeError } from './l10n';

/** 在仓库所在的本地或远端宿主激活；主面板只响应显式选择。 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setLanguage(vscode.env.language);
  const reason = activationProblem(context);
  if (reason) {
    for (const id of ['refresh', 'openTrends', 'selectScope', 'showFileEvents', 'showLineDetail'])
      context.subscriptions.push(vscode.commands.registerCommand(`codeEvolutionLens.${id}`, () => vscode.window.showInformationMessage(localizeError(reason))));
    return;
  }
  const runtime = new Runtime(context), tree = new LensTree(runtime), panel = new TrendsPanel(runtime);
  const decorations = new Decorations(runtime), history = new HistoryProvider(runtime);
  const treeView = vscode.window.createTreeView('codeEvolutionLens.tree', { treeDataProvider: tree, showCollapseAll: true });
  const output = vscode.window.createOutputChannel('code-evolution-lens');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  status.command = 'codeEvolutionLens.openTrends'; status.text = t('$(graph-line) 返工趋势'); status.show();
  context.subscriptions.push(runtime, tree, panel, decorations, treeView, output, status,
    vscode.workspace.registerTextDocumentContentProvider('code-evolution-lens-history', history));
  /** 集中捕获交互错误，日志不输出正文或邮箱。 */
  const guard = <T extends unknown[]>(fn: (...args: T) => unknown) => async (...args: T) => {
    try { await fn(...args); } catch (error) { void vscode.window.showErrorMessage(localizeError(error instanceof Error ? error.message : '操作失败')); }
  };
  /** 注册命令并由扩展上下文释放。 */
  const command = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`codeEvolutionLens.${id}`, guard(fn)));
  /** 从当前文件或已注册树节点派生文件身份，允许无统计样本的当前文件。 */
  const selectionFor = (node?: TreeNode): Selection | undefined => {
    if (node?.kind === 'scope') {
      const repo = runtime.repos.find(r => r.id === node.repo?.id), scope = repo?.trends?.nodes.get(node.scopeId);
      if (repo?.snapshot && scope?.entity) return { repoId: repo.id, snapshotId: repo.snapshot.id, entity: scope.entity };
    }
    const editor = vscode.window.activeTextEditor, repo = editor ? runtime.repository(editor.document.uri) : undefined;
    const file = repo?.trends?.fileAt(relative(repo.uri.fsPath, editor!.document.uri.fsPath).split('\\').join('/'));
    return repo?.snapshot && file?.entity ? { repoId: repo.id, snapshotId: repo.snapshot.id, entity: file.entity } : undefined;
  };
  /** 命令参数只能引用已授权快照内的实体和事件。 */
  const validSelection = (value: unknown): Selection | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const x = value as Selection, s = runtime.snapshots.get(x.snapshotId);
    if (!s || s.repoId !== x.repoId || !runtime.repos.some(r => r.id === x.repoId && r.root === s.root)
      || !s.entities.some(e => e.entity === x.entity)) return undefined;
    if (x.eventId && !s.events.some(e => e.id === x.eventId && e.entity === x.entity)) return undefined;
    if (x.birthId && !s.births.some(b => b.id === x.birthId && b.entity === x.entity)) return undefined;
    return { repoId: x.repoId, snapshotId: x.snapshotId, entity: x.entity, eventId: x.eventId, birthId: x.birthId };
  };
  command('openTrends', () => panel.show());
  command('openRepositoryTerminal', (repoId?: string) => {
    const repo = runtime.repos.find(r => r.id === (repoId ?? panel.selection.repoId)) ?? (!repoId ? runtime.repos[0] : undefined);
    if (!repo?.issue) return;
    const terminal = vscode.window.createTerminal({ name: `Git · ${repo.name}`, cwd: repo.uri });
    context.subscriptions.push(terminal);
    terminal.show();
  });
  command('selectScope', (node: TreeNode) => {
    const repo = runtime.repos.find(r => r.id === node?.repo?.id);
    if (repo && (node.scopeId === 'repo' || repo.trends?.nodes.has(node.scopeId))) panel.select(repo.id, node.scopeId);
  });
  command('refresh', async () => {
    panel.show();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('正在更新返工趋势'), cancellable: true },
      async (_progress, token) => {
        const disposable = token.onCancellationRequested(() => runtime.cancel());
        try { await runtime.refresh(); } finally { disposable.dispose(); }
      });
  });
  command('cancelIndex', () => runtime.cancel());
  command('loadMore', (node: TreeNode) => tree.loadMore(node));
  command('showFileEvents', (node?: TreeNode) => {
    const selection = selectionFor(node);
    if (selection) panel.select(selection.repoId, `file:${selection.entity}`);
    else void vscode.window.showInformationMessage(t('当前文件尚未纳入索引，请先刷新索引。'));
  });
  command('showLineDetail', async (arg?: Selection) => {
    const provided = validSelection(arg), selection = provided ?? selectionFor();
    if (!selection) { void vscode.window.showInformationMessage(t('当前文件尚未纳入索引，请先刷新索引。')); return; }
    const repo = runtime.repos.find(r => r.id === selection.repoId)!, s = runtime.snapshots.get(selection.snapshotId)!;
    if (!provided) {
      const editor = vscode.window.activeTextEditor!, version = editor.document.version;
      if (await runtime.verifiedDocument(editor.document, s) && editor.document.version === version) {
        const line = editor.selection.active.line + 1;
        selection.birthId = s.files.find(f => f.entity === selection.entity)?.lines[line - 1] ?? undefined;
        selection.eventId = s.events.find(e => e.entity === selection.entity && e.anchor && line >= e.anchor.start && line < e.anchor.start + e.anchor.count)?.id;
      }
    }
    const event = s.events.find(e => e.id === selection.eventId);
    const birth = s.births.find(b => b.id === selection.birthId) ?? s.births.find(b => event?.birthIds.includes(b.id));
    panel.select(repo.id, `file:${selection.entity}`, birth ? repo.trends?.weekFor(birth.time, 180) : undefined, 180);
  });
  command('openFile', async (arg?: Selection | TreeNode) => {
    const selection = validSelection(arg) ?? selectionFor(arg as TreeNode);
    const s = selection ? runtime.snapshots.get(selection.snapshotId) : undefined;
    const file = s?.entities.find(e => e.entity === selection?.entity);
    if (!s || !file || file.deleted) throw new Error('此文件已删除，可从修改记录打开历史差异');
    const uri = await runtime.currentUri(s, file.path);
    if (!uri) throw new Error('当前文件不可用');
    await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  });
  command('openRewriteDiff', async (arg?: Selection) => {
    const selection = validSelection(arg);
    if (selection?.eventId) await history.diff(runtime.snapshots.get(selection.snapshotId)!, selection.eventId);
    else void vscode.window.showInformationMessage(t('请在文件的修改记录中选择“查看差异”。'));
  });
  command('revealCurrent', async (arg?: Selection) => {
    const selection = validSelection(arg);
    if (!selection) return;
    const s = runtime.snapshots.get(selection.snapshotId)!, event = s.events.find(e => e.id === selection.eventId);
    if (!event?.anchor) throw new Error('该区域已删除或再次修改，请查看历史差异');
    const uri = await runtime.currentUri(s, event.anchor.path);
    if (!uri) throw new Error('当前文件不可用');
    const document = await vscode.workspace.openTextDocument(uri), version = document.version;
    if (!await runtime.verifiedDocument(document, s) || document.version !== version) throw new Error('当前内容或分支与索引不一致，请查看历史差异');
    const range = new vscode.Range(event.anchor.start - 1, 0, event.anchor.start - 1 + event.anchor.count, 0);
    const editor = await vscode.window.showTextDocument(document, { selection: range, preview: true, viewColumn: vscode.ViewColumn.Beside });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  });
  command('toggleDecorations', async () => {
    const c = vscode.workspace.getConfiguration('codeEvolutionLens');
    await c.update('decorations.enabled', !c.get('decorations.enabled', true), vscode.ConfigurationTarget.Workspace);
  });
  command('showMethodology', async () => {
    let doc: vscode.TextDocument;
    if (currentLanguage() === 'zh-cn') {
      // vsce 将主 README 规范为 readme.md；源码调试目录仍使用 README.md。
      try { doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'readme.md')); }
      catch { doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'README.md')); }
    } else doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'README.en.md'));
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  });
  command('clearCache', async () => {
    await runtime.stop();
    for (const repo of runtime.repos) {
      repo.snapshot = undefined; repo.query = undefined; repo.trends = undefined;
      repo.stale = true; repo.status = '缓存已清理，请刷新索引';
    }
    runtime.snapshots.clear();
    await rm(runtime.store.directory, { recursive: true, force: true });
    runtime.changed.fire();
  });
  command('showDiagnostics', () => {
    output.clear();
    output.appendLine(JSON.stringify({ app: vscode.env.appName, language: vscode.env.language, displayLanguage: currentLanguage(),
      vscodeApi: vscode.version, node: process.version,
      platform: process.platform, arch: process.arch, remote: vscode.env.remoteName ?? 'local',
      extensionVersion: context.extension.packageJSON.version, extensionKind: context.extension.extensionKind,
      storageScheme: context.storageUri?.scheme, workspaceSchemes: vscode.workspace.workspaceFolders?.map(f => f.uri.scheme),
      repositories: runtime.repos.map(r => ({ repoId: r.id, status: r.status, snapshot: r.snapshot?.id,
        issue: r.issue?.code, uriScheme: r.uri.scheme, git: r.snapshot?.gitVersion,
        completeness: r.snapshot?.completeness, work: r.snapshot?.work })) }, null, 2));
    output.show();
  });
  /** 轻量状态变化不重新计算报告和编辑器行标记。 */
  const updateStatus = () => {
    panel.sync(); status.tooltip = runtime.repos.map(r => `${r.name}: ${localizeError(r.status)}`).join('\n');
  };
  context.subscriptions.push(
    panel.action.event(guard(async action => {
      if (action.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`); return; }
      const commands = { diff: 'openRewriteDiff', current: 'revealCurrent', open: 'openFile',
        refresh: 'refresh', cancel: 'cancelIndex', methodology: 'showMethodology', terminal: 'openRepositoryTerminal' };
      await vscode.commands.executeCommand(`codeEvolutionLens.${commands[action.type]}`, action.type === 'terminal' ? action.repoId : action.selection);
    })),
    panel.selected.event(selection => {
      const repo = runtime.repos.find(r => r.id === selection.repoId), node = repo ? tree.findScope(repo, selection.scopeId) : undefined;
      if (node && treeView.visible) void treeView.reveal(node, { select: true, focus: false }).then(undefined, () => {});
    }),
    runtime.changed.event(() => { tree.refresh(); decorations.updateVisible(); updateStatus(); }),
    runtime.statusChanged.event(updateStatus),
    vscode.window.onDidChangeActiveTextEditor(() => decorations.updateVisible()),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.updateVisible()),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => { void decorations.update(event.textEditor, true); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      for (const editor of vscode.window.visibleTextEditors) if (editor.document === event.document) decorations.clear(editor);
    }),
    vscode.workspace.onDidSaveTextDocument(() => decorations.updateVisible()),
    vscode.window.onDidChangeWindowState(event => { if (event.focused) void runtime.checkFreshness().then(() => decorations.updateVisible()); }),
    vscode.workspace.onDidChangeConfiguration(guard(async event => {
      if (event.affectsConfiguration('codeEvolutionLens')) { await runtime.checkFreshness(); decorations.updateVisible(); }
    })),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void vscode.window.showInformationMessage(t('工作区目录已变化，请重载窗口以更新仓库列表。')); }),
  );
  let checking = false;
  const timer = setInterval(() => {
    if (checking || !vscode.window.state.focused) return;
    checking = true;
    void runtime.checkFreshness().then(() => decorations.updateVisible()).finally(() => { checking = false; });
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  await runtime.discover(); updateStatus(); decorations.updateVisible();
  await runtime.store.collect(new Set(runtime.snapshots.keys()));
  for (const repo of runtime.repos) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.uri, '**/*'));
    let refreshTimer: NodeJS.Timeout | undefined;
    /** 文件或 Git 元数据变化先清标记，再复核当前定位条件。 */
    const changed = () => {
      for (const editor of vscode.window.visibleTextEditors)
        if (runtime.repository(editor.document.uri)?.id === repo.id) decorations.clear(editor);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void runtime.checkFreshness(repo).then(() => decorations.updateVisible()); }, 150);
    };
    context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
      { dispose: () => clearTimeout(refreshTimer) });
  }
}

/** 扩展资源由 context.subscriptions 统一释放。 */
export function deactivate(): void {}
