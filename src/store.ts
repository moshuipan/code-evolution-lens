import initSqlJs from 'sql.js';
import { mkdir, readFile, rename, unlink, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Snapshot } from './model';
import { hash } from './rules';
import { validateSnapshot } from './replay';

/** SQLite 不可变快照 + 原子 active 指针；旧文件可被固定详情继续引用。 */
export class SnapshotStore {
  /** 数据库存放于扩展 storageUri；WASM 路径随包固定。 */
  constructor(readonly directory: string, readonly wasm: string) {}
  /** 候选持久化后在提交前检查取消；批准提交后只按实际写入结果结算。 */
  async publish(snapshot: Snapshot, signal?: AbortSignal, beforeCommit?: () => void | Promise<void>): Promise<void> {
    validateSnapshot(snapshot); signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => this.wasm });
    const db = new SQL.Database();
    const filename = `${snapshot.repoId}-${snapshot.id}.sqlite`;
    const target = join(this.directory, filename);
    try {
      db.run('CREATE TABLE snapshot (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, payload TEXT NOT NULL)');
      const payload = JSON.stringify(snapshot);
      db.run('INSERT INTO snapshot VALUES (?, ?, ?)', [snapshot.id, hash(payload), payload]);
      signal?.throwIfAborted();
      await atomicWrite(target, db.export(), signal);
      await atomicWrite(join(this.directory, `${snapshot.repoId}.active`), Buffer.from(filename), signal, beforeCommit);
    } finally { db.close(); }
  }
  /** 只读取 active 指向的完整 SQLite；损坏时不返回残缺数据。 */
  async load(repoId: string, snapshotId?: string): Promise<Snapshot | undefined> {
    if (!/^[a-f0-9]{64}$/.test(repoId)) throw new Error('仓库缓存身份无效');
    let filename: string;
    if (snapshotId && !/^[a-f0-9-]{36}$/.test(snapshotId)) throw new Error('快照缓存身份无效');
    try { filename = snapshotId ? `${repoId}-${snapshotId}.sqlite` : (await readFile(join(this.directory, `${repoId}.active`))).toString(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!new RegExp(`^${repoId}-[a-f0-9-]+\\.sqlite$`).test(filename)) throw new Error('缓存指针无效');
    const SQL = await initSqlJs({ locateFile: () => this.wasm });
    const db = new SQL.Database(await readFile(join(this.directory, filename)));
    try {
      const row = db.exec('SELECT checksum, payload FROM snapshot')[0]?.values[0];
      if (!row || hash(row[1]) !== row[0]) throw new Error('缓存校验失败');
      const snapshot = JSON.parse(row[1] as string) as Snapshot;
      validateSnapshot(snapshot);
      if (snapshot.repoId !== repoId) throw new Error('缓存仓库身份不匹配');
      return snapshot;
    } finally { db.close(); }
  }
  /** 删除无引用快照和未发布临时文件；始终保留 active 与固定引用。 */
  async collect(retained: Set<string>): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return; }
    const active = new Set<string>();
    for (const name of names.filter(n => n.endsWith('.active'))) active.add((await readFile(join(this.directory, name))).toString());
    for (const name of names) {
      if (!/^[a-f0-9-]+\.sqlite(?:\.tmp-[a-f0-9-]+)?$/.test(name)) continue;
      if (active.has(name) || [...retained].some(id => name.endsWith(`-${id}.sqlite`))) continue;
      await unlink(join(this.directory, name));
    }
  }
}
/** 同目录写入并 fsync，rename 是读者可见的唯一切换点。 */
async function atomicWrite(path: string, bytes: Uint8Array, signal?: AbortSignal, beforeCommit?: () => void | Promise<void>): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    signal?.throwIfAborted();
    // 回调批准后不再检查取消，避免 active 已切换而调用方误报失败。
    await beforeCommit?.();
    await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
