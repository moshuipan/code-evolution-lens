import * as vscode from 'vscode';
import { Runtime, Repository } from './runtime';
import { ScopeNode } from './trends';
import { t, localizeError } from './l10n';

export interface TreeNode { kind: 'scope' | 'more'; repo: Repository; scopeId: string; parent?: TreeNode }
/** 只负责目录导航，不在展开或索引进度更新时计算统计。 */
export class LensTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly limits = new Map<string, number>();
  /** 所有节点共享 Runtime 中的不可变目录结构。 */
  constructor(readonly runtime: Runtime) {}
  /** 刷新结构或状态，不扫描 Git。 */
  refresh(node?: TreeNode): void { this.change.fire(node); }
  /** 节点标题切换曲线，原生箭头仅展开下一层。 */
  getTreeItem(node: TreeNode): vscode.TreeItem {
    const { repo, scopeId } = node, scope = repo.trends?.nodes.get(scopeId);
    const leaf = node.kind === 'more' || scope?.kind === 'file';
    const item = new vscode.TreeItem(node.kind === 'more' ? t('加载更多…') : scopeId === 'repo' ? repo.name : scope?.label ?? t('范围已变化'),
      leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `${repo.id}:${node.kind}:${scopeId}`;
    item.command = { command: `codeEvolutionLens.${node.kind === 'more' ? 'loadMore' : 'selectScope'}`,
      title: node.kind === 'more' ? t('加载更多') : t('查看返工趋势'), arguments: [node] };
    if (node.kind === 'more') return item;
    item.description = scopeId === 'repo' ? localizeError(repo.status) : scope?.deleted ? t('已删除') : scope?.excludedReason ? t('已排除') : undefined;
    item.tooltip = scopeId === 'repo' ? t('{0}\n{1}\n点击查看整个仓库的返工趋势', repo.name, localizeError(repo.status))
      : `${scope?.path}\n${scope?.deleted ? t('已删除文件的历史记录') : scope?.excludedReason ? localizeError(scope.excludedReason) : t('点击查看此范围的返工趋势')}`;
    if (scopeId === 'repo' && repo.issue) item.tooltip += '\n\n' + repo.issue.steps.map((step, index) =>
      `${index + 1}. ${t(step.text)}${step.command ? `\n${step.command}` : ''}`).join('\n');
    item.iconPath = new vscode.ThemeIcon(scopeId === 'repo' ? 'repo' : scope?.kind === 'directory' ? 'folder' : scope?.deleted ? 'history' : 'file-code');
    item.contextValue = scope?.kind === 'file' ? 'lensFile' : 'lensScope';
    return item;
  }
  /** 分页返回直接子目录和文件，保留零样本文件与删除文件的独立身份。 */
  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.runtime.repos.map(repo => ({ kind: 'scope', repo, scopeId: 'repo' }));
    if (node.kind === 'more') return [];
    const all = node.repo.trends?.children(node.scopeId) ?? [];
    const limit = this.limits.get(`${node.repo.id}:${node.scopeId}`) ?? 100;
    const result: TreeNode[] = all.slice(0, limit).map(scope => ({ kind: 'scope', repo: node.repo, scopeId: scope.id, parent: node }));
    if (all.length > limit) result.push({ kind: 'more', repo: node.repo, scopeId: node.scopeId, parent: node });
    return result;
  }
  /** 提供 reveal 所需的祖先节点。 */
  getParent(node: TreeNode): TreeNode | undefined { return node.parent; }
  /** 增加指定目录的可见行数。 */
  loadMore(node: TreeNode): void {
    const key = `${node.repo.id}:${node.scopeId}`;
    this.limits.set(key, (this.limits.get(key) ?? 100) + 100); this.refresh(node.parent);
  }
  /** 显式定位时保证祖先和目标已在各层分页中可见。 */
  findScope(repo: Repository, scopeId: string): TreeNode | undefined {
    const ancestors = repo.trends?.ancestors(scopeId);
    if (!ancestors?.length) return undefined;
    let parent: TreeNode | undefined;
    for (const scope of ancestors) {
      if (parent) {
        const index = repo.trends!.children(parent.scopeId).findIndex((n: ScopeNode) => n.id === scope.id);
        this.limits.set(`${repo.id}:${parent.scopeId}`, Math.max(this.limits.get(`${repo.id}:${parent.scopeId}`) ?? 100, index + 1));
      }
      parent = { kind: 'scope', repo, scopeId: scope.id, parent };
    }
    return parent;
  }
  /** 释放原生树事件。 */
  dispose(): void { this.change.dispose(); }
}
