import { TrendReport } from './trends';
import { normalizeView, ViewState } from './view-state';

export interface Selection { repoId: string; snapshotId: string; entity: string; eventId?: string; birthId?: string }
export interface TrendSelection { repoId: string; scopeId: string; days: number; week?: string }
export interface MessageContext { requestId: number; repoId: string; snapshotId: string }
export type TrendMessage = MessageContext & {
  type: 'repository' | 'scope' | 'days' | 'week' | 'more' | 'diff' | 'current' | 'open' | 'refresh' | 'cancel' | 'methodology' | 'terminal' | 'settings' | 'view' | 'persist' | 'back';
  target?: string; days?: number; eventId?: string; view?: ViewState; destination?: 'results' | 'summary';
};
/** 验证客户端请求来源和当前可见范围；不接受任意路径或历史对象参数。 */
export function acceptMessage(value: unknown, context: MessageContext, report?: TrendReport, repositories: string[] = []): TrendMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const m = value as TrendMessage;
  if (m.requestId !== context.requestId || m.repoId !== context.repoId || m.snapshotId !== context.snapshotId) return undefined;
  switch (m.type) {
    case 'refresh': case 'cancel': case 'methodology': case 'settings': case 'back': return m;
    case 'view': case 'persist': {
      if (!m.view || typeof m.view !== 'object') return undefined;
      const view = normalizeView(m.view);
      if (view.selectedProvider && !report?.metrics.providers.some(p => p.id === view.selectedProvider)) return undefined;
      return { ...m, view };
    }
    case 'terminal': return repositories.includes(context.repoId) ? m : undefined;
    case 'repository': return repositories.includes(m.target ?? '') ? m : undefined;
    case 'scope': {
      if (!report) return undefined;
      const files = [...report.metrics.topFiles, ...report.metrics.attentionFiles, ...report.metrics.providerFiles,
        ...report.metrics.coupling.flatMap(p => [{ entity: p.leftEntity }, { entity: p.rightEntity }])];
      return [...report.crumbs, ...report.children].some(n => n.id === m.target)
        || files.some(f => `file:${f.entity}` === m.target) ? m : undefined;
    }
    case 'days': return [30, 90, 180].includes(m.days ?? 0) ? m : undefined;
    case 'week': return report && (m.target === '' || report.points.some(p => p.id === m.target && p.observed)) ? m : undefined;
    case 'more': return report ? m : undefined;
    case 'diff': case 'current': return report?.events.some(e => e.id === m.eventId && (m.type !== 'current' || e.current)) ? m : undefined;
    case 'open': return report?.scope.kind === 'file' && !report.scope.deleted ? m : undefined;
    default: return undefined;
  }
}
