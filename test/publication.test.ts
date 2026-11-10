import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { replay } from '../src/replay';
import { Snapshot } from '../src/model';
import { Fixture, CONFIG, T, DAY } from './fixtures';

/** 仅控制 active 临时文件的 fsync 和 rename 时机，其他文件操作及 SQLite 均真实执行。 */
function controlledStore(afterSync: () => void, failRename = false): any {
  const files = { ...fs,
    /** 在真实 fsync 完成后注入取消，覆盖最后一个异步持久化窗口。 */
    open: async (path: string, flags: string, mode: number) => {
      const file = await fs.open(path, flags, mode);
      if (path.includes('.active.tmp-')) {
        const sync = file.sync.bind(file);
        file.sync = async () => { await sync(); afterSync(); };
      }
      return file;
    },
    /** 可重现 active 切换失败，校验旧指针和临时文件的清理。 */
    rename: async (from: string, to: string) => {
      if (failRename && to.endsWith('.active')) throw new Error('fixture rename failure');
      await fs.rename(from, to);
    },
  };
  const code = buildSync({ entryPoints: ['src/store.ts'], bundle: true, write: false, platform: 'node',
    format: 'cjs', external: ['sql.js'] }).outputFiles[0].text;
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, process, Buffer, structuredClone,
    require: (name: string) => name === 'node:fs/promises' ? files : require(name) });
  return module.exports.SnapshotStore;
}

/** 创建已发布的旧快照，每个时序测试只操作自己的目录。 */
async function publication(run: (directory: string, previous: Snapshot) => Promise<void>): Promise<void> {
  const fixture = await Fixture.create(), directory = await fs.mkdtemp(join(tmpdir(), 'code-evolution-lens-publish-'));
  try {
    await fixture.write('a.ts', 'line\n'); fixture.commit(T - 30 * DAY);
    const previous = await replay(fixture.root, CONFIG, { cutoff: T, now: T + DAY });
    const Store = controlledStore(() => {});
    await new Store(directory, join(process.cwd(), 'dist/sql-wasm.wasm')).publish(previous);
    await run(directory, previous);
  } finally { await fixture.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('P1 active fsync 后提交前取消拒绝发布，旧快照和固定引用保留且临时文件清理', () => publication(async (directory, previous) => {
  const abort = new AbortController(), Store = controlledStore(() => abort.abort(new Error('cancel before commit')));
  const store = new Store(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  let committed = false;
  await assert.rejects(store.publish({ ...previous, id: crypto.randomUUID() }, abort.signal,
    () => { committed = true; }), /cancel before commit/);
  assert.equal(committed, false);
  assert.equal((await store.load(previous.repoId)).id, previous.id);
  assert.equal((await store.load(previous.repoId, previous.id)).id, previous.id);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.tmp-')), false);
}));

test('P1 发布批准后的取消按成功结算，active 指针和返回快照一致', () => publication(async (directory, previous) => {
  const abort = new AbortController(), Store = controlledStore(() => {});
  const store = new Store(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  const next = { ...previous, id: crypto.randomUUID() };
  let approvals = 0;
  await store.publish(next, abort.signal, () => { approvals++; abort.abort(new Error('cancel after approval')); });
  assert.equal(approvals, 1);
  assert.equal((await store.load(previous.repoId)).id, next.id);
  assert.equal((await store.load(previous.repoId, previous.id)).id, previous.id);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.tmp-')), false);
}));

test('active rename 失败保留旧快照并清理临时文件', () => publication(async (directory, previous) => {
  const Store = controlledStore(() => {}, true), store = new Store(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  await assert.rejects(store.publish({ ...previous, id: crypto.randomUUID() }), /fixture rename failure/);
  assert.equal((await store.load(previous.repoId)).id, previous.id);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.tmp-')), false);
}));
