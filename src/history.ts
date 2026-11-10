import * as vscode from 'vscode';
import { Runtime } from './runtime';
import { GitAdapter } from './git';
import { DEFAULT_CONFIG, Snapshot } from './model';
import { t } from './l10n';

export type Evidence = { kind: 'before' | 'after' | 'birth'; id: string };
/** 历史 URI 仅包含快照内已建立的证据身份，不能输入任意对象参数。 */
export class HistoryProvider implements vscode.TextDocumentContentProvider {
  /** 通过共享目录查找已授权快照。 */
  constructor(readonly runtime: Runtime) {}
  /** 从事实记录派生 commit、path 和 blob，防止调用方伪造。 */
  record(s: Snapshot, evidence: Evidence): { commit: string; path: string; blob?: string } {
    if (evidence.kind === 'birth') {
      const b = s.births.find(b => b.id === evidence.id);
      if (b) return { commit: b.commit, path: b.path, blob: b.blob };
    } else {
      const e = s.events.find(e => e.id === evidence.id);
      if (e && evidence.kind === 'before') return { commit: e.parent, path: e.beforePath, blob: e.beforeBlob };
      if (e && evidence.kind === 'after') return { commit: e.commit, path: e.afterPath ?? e.beforePath, blob: e.afterBlob };
    }
    throw new Error('历史证据不属于当前快照');
  }
  /** 将完整对象身份编码为自定义只读 URI。 */
  uri(s: Snapshot, evidence: Evidence): vscode.Uri {
    const record = this.record(s, evidence);
    return vscode.Uri.from({ scheme: 'code-evolution-lens-history', authority: s.repoId, path: `/${record.path}`,
      query: JSON.stringify({ snapshot: s.id, ...evidence, ...record }) });
  }
  /** 读取前复核 URI 与快照派生身份一致；从不读取工作树正文。 */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const value = JSON.parse(uri.query);
    const s = this.runtime.snapshots.get(value.snapshot);
    if (!s || s.repoId !== uri.authority || !this.runtime.repos.some(r => r.id === s.repoId && r.root === s.root)) throw new Error('历史快照不可用');
    const record = this.record(s, value);
    if (value.commit !== record.commit || value.blob !== record.blob || uri.path !== `/${record.path}`) throw new Error('历史 URI 校验失败');
    if (!record.blob) return '';
    const repo = this.runtime.repos.find(r => r.id === s.repoId)!;
    // 历史 blob 读取不执行归因；配置错误时仍可核对已有快照的证据。
    const git = new GitAdapter(s.root, repo.config ?? { ...DEFAULT_CONFIG, ref: s.ref });
    try { return (await git.blob(record.blob)).toString('utf8'); }
    catch { throw new Error('历史对象不可用；事件元数据仍保留，不会自动 fetch'); }
    finally { git.dispose(); }
  }
  /** 打开首次重写前后的不可变版本，使用重写 hunk 坐标导航。 */
  async diff(s: Snapshot, eventId: string): Promise<void> {
    const e = s.events.find(e => e.id === eventId);
    if (!e) throw new Error('重写事件不存在');
    await vscode.commands.executeCommand('vscode.diff', this.uri(s, { kind: 'before', id: e.id }),
      this.uri(s, { kind: 'after', id: e.id }), t('首次修改 {0} · {1}', e.commit.slice(0, 8), e.beforePath),
      { preview: true, viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(Math.max(0, e.afterStart - 1), 0, Math.max(0, e.afterStart - 1), 0) });
  }
}
