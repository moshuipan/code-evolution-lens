import * as vscode from 'vscode';
import { Runtime } from './runtime';
import { RequestGate } from './query';
import { Selection } from './presentation';
import { t, currentLanguage } from './l10n';

/** 当前标记只使用核验通过的快照、文档版本与可见区域。 */
export class Decorations implements vscode.Disposable {
  private readonly ai = vscode.window.createTextEditorDecorationType({ isWholeLine: true,
    before: { contentText: 'ai ', color: new vscode.ThemeColor('descriptionForeground'), fontWeight: 'normal' } });
  private readonly rw = vscode.window.createTextEditorDecorationType({ isWholeLine: true,
    before: { contentText: t('改 '), color: new vscode.ThemeColor('descriptionForeground'), fontWeight: 'normal' } });
  private readonly gates = new WeakMap<vscode.TextEditor, RequestGate>();
  private readonly verified = new WeakMap<vscode.TextDocument, {
    snapshotId: string; version: number; pending: boolean; result: Promise<string | undefined>;
  }>();
  /** 绑定共享快照服务。 */
  constructor(readonly runtime: Runtime) {}
  /** 文档变化时同步清除旧标记并撤销在途查询。 */
  clear(editor: vscode.TextEditor, invalidateDocument = true): void {
    const gate = this.gates.get(editor) ?? new RequestGate();
    gate.next(); this.gates.set(editor, gate);
    if (invalidateDocument) this.verified.delete(editor.document);
    editor.setDecorations(this.ai, []); editor.setDecorations(this.rw, []);
  }
  /** 为索引期内的 AI 辅助新增行与仍有效的修改区域设置标记。 */
  async update(editor: vscode.TextEditor, scrolling = false): Promise<void> {
    const document = editor.document, repo = this.runtime.repository(document.uri), s = repo?.snapshot;
    if (!s || repo?.stale || document.isDirty
      || !vscode.workspace.getConfiguration('codeEvolutionLens', document.uri).get('decorations.enabled', true)) { this.clear(editor); return; }
    const prior = this.verified.get(document);
    if (prior && (prior.snapshotId !== s.id || prior.version !== document.version)) this.clear(editor);
    const gate = this.gates.get(editor) ?? new RequestGate();
    this.gates.set(editor, gate);
    const ticket = gate.next(), version = document.version;
    let record = this.verified.get(document);
    // 滚动复用已核验结果；非滚动刷新重新核验，同文档的分栏共享尚未完成的读取。
    if (!record || record.snapshotId !== s.id || record.version !== version || (!scrolling && !record.pending)) {
      record = { snapshotId: s.id, version, pending: true, result: this.runtime.verifiedDocument(document, s).catch(() => undefined) };
      this.verified.set(document, record);
      const current = record;
      void current.result.then(() => { current.pending = false; });
    }
    const entity = await record.result;
    if (!gate.accepts(ticket) || this.verified.get(document) !== record) return;
    if (!entity || version !== document.version || document.isDirty || repo.snapshot?.id !== s.id || repo.stale) { this.clear(editor, false); return; }
    const file = s.files.find(f => f.entity === entity);
    if (!file || !repo.trends?.report(`file:${entity}`, 180).summary.complete) { this.clear(editor, false); return; }
    const ai: vscode.DecorationOptions[] = [], rw: vscode.DecorationOptions[] = [];
    /** 只为可见行创建范围，避免一次性建立整个文件的装饰对象。 */
    const visible = (line: number) => editor.visibleRanges.some(r => line >= r.start.line && line <= r.end.line);
    const base: Selection = { repoId: s.repoId, snapshotId: s.id, entity };
    const births = repo.query!.births;
    const visibleLines = new Set<number>();
    for (const range of editor.visibleRanges)
      for (let line = range.start.line; line <= Math.min(range.end.line, file.lines.length - 1); line++) visibleLines.add(line);
    for (const line of visibleLines) {
      const id = file.lines[line], birth = id ? births.get(id) : undefined;
      if (birth?.attribution === 'ai') ai.push({ range: new vscode.Range(line, 0, line, 0),
        hoverMessage: hover(t('AI 辅助新增代码 · 提交包含 AI 标记{0}', birth.attributionSignals?.length
          ? ` · ${[...new Set(birth.attributionSignals.map(signal => signal.provider === 'AI 邮箱名（提供者不唯一）' ? t(signal.provider) : signal.provider))].join(currentLanguage() === 'zh-cn' ? '、' : ', ')}` : ''), { ...base, birthId: birth.id }) });
    }
    for (const event of repo.query!.events(entity)) {
      if (!event.anchor) continue;
      for (let line = event.anchor.start - 1; line < event.anchor.start - 1 + event.anchor.count; line++) {
        if (visible(line)) rw.push({ range: new vscode.Range(line, 0, line, 0),
          hoverMessage: hover(t('首次修改 {0} 行 · {1} · 点击查看返工趋势', event.birthIds.length, event.commit.slice(0, 8)), { ...base, eventId: event.id }) });
      }
    }
    if (!gate.accepts(ticket) || document.version !== version) return;
    editor.setDecorations(this.ai, ai); editor.setDecorations(this.rw, rw);
  }
  /** 刷新所有可见编辑器，互不覆盖对方的请求代号。 */
  updateVisible(): void { for (const editor of vscode.window.visibleTextEditors) void this.update(editor); }
  /** 释放唯一的两种样式对象。 */
  dispose(): void { this.ai.dispose(); this.rw.dispose(); }
}
/** hover 只信任一个受控命令，仓库信息始终用 appendText 转义。 */
function hover(text: string, selection: Selection): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendText(text);
  markdown.appendMarkdown(`\n\n[${t('查看文件返工趋势')}](command:codeEvolutionLens.showLineDetail?${encodeURIComponent(JSON.stringify([selection]))})`);
  markdown.isTrusted = { enabledCommands: ['codeEvolutionLens.showLineDetail'] };
  return markdown;
}
