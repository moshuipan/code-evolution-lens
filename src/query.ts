import { Aggregate, Birth, Snapshot, WINDOW } from './model';

export interface FileGroup { key: string; owner: string; entity: string; package: string; path: string; currentPath?: string; counts: Aggregate }
export interface Page<T> { items: T[]; next?: string }
/** 共享内存快照查询；UI 无须等待正在构建的 worker。 */
export class QueryService {
  readonly births: Map<string, Birth>;
  private readonly eventById;
  private readonly currentByEntity;
  private groups?: FileGroup[];
  /** 查询实例终生绑定一个不可变快照。 */
  constructor(readonly snapshot: Snapshot) {
    this.births = new Map(snapshot.births.map(b => [b.id, b]));
    this.eventById = new Map(snapshot.events.map(e => [e.id, e]));
    this.currentByEntity = new Map(snapshot.files.map(f => [f.entity, f.path]));
  }
  /** 聚合互斥的出生子集；分母为零与观察缺口保留为独立状态。 */
  aggregate(births = this.snapshot.births): Aggregate {
    const entities = new Set(births.map(b => b.entity));
    const result: Aggregate = { ai: 0, aiRewritten: 0, unmarked: 0, unmarkedRewritten: 0, unknown: 0,
      configured: this.snapshot.attributionConfigured,
      complete: !this.snapshot.gaps.some(g => !g.entity || entities.has(g.entity)) };
    for (const b of births) {
      if (b.attribution === 'unknown') { result.unknown++; continue; }
      result[b.attribution]++;
      const e = b.firstRewrite ? this.eventById.get(b.firstRewrite) : undefined;
      if (e && e.time >= b.time && e.time <= b.time + WINDOW) {
        if (b.attribution === 'ai') result.aiRewritten++; else result.unmarkedRewritten++;
      }
    }
    return result;
  }
  /** 按出生归属而非当前路径分组，确保跨包移动不改变分母。 */
  files(pkg?: string): FileGroup[] {
    if (this.groups) return pkg === undefined ? this.groups : this.groups.filter(f => f.package === pkg);
    const groups = new Map<string, Birth[]>();
    for (const b of this.snapshot.births) {
      const key = `${this.snapshot.repoId}:${b.owner}:${b.entity}`;
      const group = groups.get(key) ?? []; group.push(b); groups.set(key, group);
    }
    this.groups = [...groups].map(([key, births]) => ({
      key, owner: births[0].owner, entity: births[0].entity, package: births[0].package,
      path: births[0].path, currentPath: this.currentByEntity.get(births[0].entity),
      counts: this.aggregate(births),
    })).sort((a, b) => b.counts.aiRewritten - a.counts.aiRewritten || a.key.localeCompare(b.key));
    return pkg === undefined ? this.groups : this.groups.filter(f => f.package === pkg);
  }
  /** 文件事件可限定出生归属，防止树节点计数和详情范围混淆。 */
  events(entity: string, owner?: string) {
    return this.snapshot.events.filter(e => e.entity === entity
      && (!owner || e.birthIds.some(id => this.births.get(id)?.owner === owner)))
      .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  }
  /** 游标绑定快照及稳定排序键，拒绝跨快照接续。 */
  page<T>(items: T[], key: (item: T) => string, cursor?: string, limit = 100): Page<T> {
    let offset = 0;
    if (cursor) {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (parsed.snapshot !== this.snapshot.id) throw new Error('分页快照已失效');
      offset = items.findIndex(x => key(x) === parsed.key) + 1;
      if (!offset) throw new Error('分页位置已失效');
    }
    const slice = items.slice(offset, offset + limit);
    return { items: slice, next: offset + slice.length < items.length
      ? Buffer.from(JSON.stringify({ snapshot: this.snapshot.id, key: key(slice.at(-1)!) })).toString('base64url') : undefined };
  }
}
/** 统一显示计数和比例；缺口、未配置和零分母不显示假 0%。 */
export function rate(a: Aggregate): string {
  if (!a.configured) return '未配置归因';
  if (!a.complete) return '不可计算';
  return a.ai ? `AI ${(100 * a.aiRewritten / a.ai).toFixed(1)}% · ${a.aiRewritten}/${a.ai}` : '无成熟 AI 样本';
}
/** 为相同快照内的异步请求生成代号；切换选择或文档变化立即失效。 */
export class RequestGate {
  private serial = 0;
  /** 开始一个新请求并撤销旧请求。 */
  next(): number { return ++this.serial; }
  /** 检查响应是否属于最后一次有效请求。 */
  accepts(ticket: number): boolean { return ticket === this.serial; }
}
