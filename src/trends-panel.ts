import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Runtime } from './runtime';
import { TrendReport } from './trends';
import { acceptMessage, MessageContext, Selection, TrendSelection } from './presentation';
import { defaultView, normalizeView, ViewState } from './view-state';
import { t, currentLanguage, localizeError } from './l10n';

export interface TrendAction { type: 'diff' | 'current' | 'open' | 'refresh' | 'cancel' | 'methodology' | 'terminal' | 'settings'; selection?: Selection; repoId?: string }
/** 单实例主编辑区面板；范围只由显式操作改变，隐藏期间不推送整页。 */
export class TrendsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private serial = 0;
  private lastKey = '';
  private limit = 100;
  private context: MessageContext = { requestId: 0, repoId: '', snapshotId: '' };
  private report?: TrendReport;
  private view: ViewState;
  private history: { selection: TrendSelection; view: ViewState }[] = [];
  private destination?: 'results' | 'summary' | 'restore';
  private feedback?: string;
  selection: TrendSelection;
  readonly action = new vscode.EventEmitter<TrendAction>();
  readonly selected = new vscode.EventEmitter<TrendSelection>();
  /** 恢复工作区中最后一次查看的范围与时间，不恢复已淘汰的固定证据。 */
  constructor(readonly runtime: Runtime) {
    const saved = runtime.context.workspaceState.get<TrendSelection>('trendSelection');
    this.selection = { repoId: typeof saved?.repoId === 'string' ? saved.repoId : '',
      scopeId: typeof saved?.scopeId === 'string' ? saved.scopeId : 'repo',
      days: [30, 90, 180].includes(saved?.days ?? 0) ? saved!.days : 90,
      week: typeof saved?.week === 'string' ? saved.week : undefined };
    this.view = normalizeView(runtime.context.workspaceState.get('trendView'));
    const history = runtime.context.workspaceState.get<{ selection: TrendSelection; view: ViewState }[]>('trendHistory');
    this.history = Array.isArray(history) ? history.filter(h => h?.selection && typeof h.selection.repoId === 'string'
      && typeof h.selection.scopeId === 'string' && [30, 90, 180].includes(h.selection.days)).slice(-20)
      .map(h => ({ selection: { ...h.selection }, view: normalizeView(h.view) })) : [];
    void runtime.context.workspaceState.update('pinnedSelection', undefined);
  }
  /** 创建或展示同一面板，Webview 重载后由 ready 重新发送最新状态。 */
  show(): void {
    if (this.panel) { this.panel.reveal(undefined, false); this.sync(); return; }
    const root = vscode.Uri.joinPath(this.runtime.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('codeEvolutionLens.trends', t('返工趋势'), vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [root] });
    this.panel = panel; this.ready = false; this.lastKey = '';
    const webview = panel.webview, nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'trends.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'trends.css'));
    webview.onDidReceiveMessage(value => {
      if (panel !== this.panel || !value || typeof value !== 'object') return;
      if (value.type === 'ready') { this.ready = true; this.sync(true); return; }
      if (!panel.visible) return;
      const repo = this.runtime.repos.find(r => r.id === this.context.repoId);
      if ((repo?.snapshot?.id ?? '') !== this.context.snapshotId) return;
      const message = acceptMessage(value, this.context, this.report, this.runtime.repos.map(r => r.id));
      if (!message) return;
      switch (message.type) {
        case 'persist': this.view = message.view!; this.saveView(); break;
        case 'view': this.view = message.view!; this.limit = this.view.lists.directory.limit; this.sync(true); break;
        case 'back': this.back(); break;
        case 'repository': this.select(message.target!, 'repo', undefined, undefined, 'summary'); break;
        case 'scope': this.select(this.selection.repoId, message.target!, undefined, undefined, message.destination ?? 'results'); break;
        case 'days': this.selection.days = message.days!; this.selection.week = undefined; this.limit = 100;
          this.view.lists.directory.limit = 100; this.feedback = t('已切换为近 {0} 天，周筛选已清除。', message.days!); this.sync(); break;
        case 'week': this.selection.week = message.target || undefined; this.limit = 100; this.view.lists.directory.limit = 100;
          this.feedback = message.target ? t('已筛选下方结果；上方汇总和全期分析保持不变。') : t('周筛选已清除，下方列表恢复全部已完成观察的周。'); this.sync(); break;
        case 'more': this.limit += 100; this.view.lists.directory.limit = this.limit; this.sync(); break;
        default:
          this.action.fire({ type: message.type, repoId: this.context.repoId, selection: this.report?.scope.entity ? {
            repoId: this.context.repoId, snapshotId: this.context.snapshotId,
            entity: this.report.scope.entity, eventId: message.eventId,
          } : undefined });
      }
    });
    panel.onDidChangeViewState(() => { if (panel.visible) this.sync(true); });
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.ready = false; this.lastKey = ''; this.context.requestId = ++this.serial; } });
    webview.html = `<!doctype html><html lang="${currentLanguage()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><main id="app">${t('正在加载返工趋势…')}</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  /** 切换范围时保留时间区间和选中周；树点击及编辑器命令共用入口。 */
  select(repoId: string, scopeId: string, week?: string, days?: number, destination: 'results' | 'summary' = 'summary'): void {
    const changed = repoId !== this.selection.repoId || scopeId !== this.selection.scopeId;
    if (changed && this.report) {
      this.history.push({ selection: { ...this.selection }, view: normalizeView(this.view) });
      if (this.history.length > 20) this.history.shift();
    }
    if (repoId !== this.selection.repoId) this.selection.week = undefined;
    this.selection = { ...this.selection, repoId, scopeId,
      ...(week ? { week } : {}), ...(days ? { days } : {}) };
    if (changed) {
      const old = this.view; this.view = defaultView();
      this.view.expanded = old.expanded.filter(id => !id.startsWith('provider:'));
      this.destination = destination;
    }
    this.limit = 100; this.show();
    this.selected.fire(this.selection);
  }
  /** 返回保存的来源列表；快照身份由当前仓库重新提供，不复用旧统计证据。 */
  private back(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.selection = { ...previous.selection }; this.view = normalizeView(previous.view);
    this.limit = this.view.lists.directory.limit; this.destination = 'restore';
    this.sync(true); this.selected.fire(this.selection);
  }
  /** 保存展示状态及轻量导航历史，不保存统计快照。 */
  private saveView(): void {
    void this.runtime.context.workspaceState.update('trendView', normalizeView(this.view));
    void this.runtime.context.workspaceState.update('trendHistory', this.history);
  }
  /** 选择或快照变化才计算完整报告；索引进度仅传状态，不撤销按钮请求。 */
  sync(force = false): void {
    if (!this.panel || !this.ready || !this.panel.visible) return;
    const repo = this.runtime.repos.find(r => r.id === this.selection.repoId) ?? this.runtime.repos[0];
    if (repo && repo.id !== this.selection.repoId) {
      if (this.selection.repoId) this.feedback = '原仓库已移出工作区，已返回当前仓库。';
      this.selection.repoId = repo.id; this.selection.scopeId = 'repo'; this.selection.week = undefined; this.view = defaultView();
    }
    if (repo?.trends && !repo.trends.nodes.has(this.selection.scopeId)) {
      this.selection.scopeId = 'repo'; this.selection.week = undefined;
      this.view = defaultView(); this.destination = 'summary'; this.feedback = '原目录或文件已不在当前索引中，已返回整个仓库。';
    }
    const queryKey = () => JSON.stringify([repo?.snapshot?.id, this.selection, this.limit, this.view.lists, this.view.selectedProvider]);
    const key = queryKey();
    const status = { language: currentLanguage(), status: localizeError(repo?.status ?? '请打开并信任一个 Git 仓库根目录'),
      issue: repo?.issue, repositoryPath: repo?.root,
      stale: repo?.stale ?? false, indexing: this.runtime.repos.some(r => r.indexing),
      repositories: this.runtime.repos.map(r => ({ id: r.id, name: r.name })) };
    if (!force && key === this.lastKey) {
      void this.panel.webview.postMessage({ type: 'status', ...this.context, ...status }); return;
    }
    const oldWeek = this.selection.week;
    this.report = repo?.trends?.report(this.selection.scopeId, this.selection.days, this.selection.week, this.limit, this.view);
    this.selection.week = this.report?.selectedWeek;
    if (oldWeek && !this.selection.week && this.report) this.feedback = '原选中周已超出当前时间范围，周筛选已清除。';
    if (this.report) {
      this.view.events = this.view.events.filter(id => repo?.snapshot?.events.some(e => e.id === id && e.entity === this.report!.scope.entity));
      this.view.expanded = this.view.expanded.filter(id => !id.startsWith('provider:')
        || this.report!.metrics.providers.some(p => `provider:${p.id}` === id));
      if (this.view.selectedProvider && !this.report.metrics.providers.some(p => p.id === this.view.selectedProvider)) {
        this.view.selectedProvider = undefined; this.feedback = '原提供者在当前范围已无样本，已关闭相关文件筛选。';
      }
      if (this.view.weekFocus && !this.report.points.some(p => p.id === this.view.weekFocus)) this.view.weekFocus = undefined;
      if (this.view.dailyDate && !this.report.metrics.activity.daily.some(d => d.date === this.view.dailyDate)) this.view.dailyDate = undefined;
    }
    this.lastKey = queryKey();
    this.context = { requestId: ++this.serial, repoId: repo?.id ?? '', snapshotId: repo?.snapshot?.id ?? '' };
    void this.runtime.context.workspaceState.update('trendSelection', { ...this.selection });
    this.saveView();
    void this.panel.webview.postMessage({ type: 'state', ...this.context, ...status, report: this.report,
      cutoff: repo?.snapshot?.cutoff, timezone: repo?.snapshot?.timeZone, ref: repo?.snapshot?.ref,
      navigationTip: repo?.snapshot?.navigationTipOid, messageMarkers: repo?.snapshot?.attributionMessageMarkers ?? false,
      view: normalizeView(this.view), canBack: this.history.length > 0, destination: this.destination, feedback: localizeError(this.feedback ?? '') });
    this.destination = undefined; this.feedback = undefined;
  }
  /** 释放唯一面板和事件监听。 */
  dispose(): void { this.panel?.dispose(); this.action.dispose(); this.selected.dispose(); }
}
