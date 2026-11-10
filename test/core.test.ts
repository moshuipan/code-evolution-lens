import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { replay, project, segments } from '../src/replay';
import { QueryService, RequestGate, rate } from '../src/query';
import { cutoffToday, eligible, hash, packageOf, safeGitPath, textLines } from '../src/rules';
import { AttributionEngine } from '../src/attribution';
import { SnapshotStore } from '../src/store';
import { AI, CONFIG, DAY, Fixture, T } from './fixtures';
import { Snapshot } from '../src/model';
import { GitAdapter } from '../src/git';

/** 为每个场景创建隔离仓库并保证清理。 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await Fixture.create();
  try { await run(f); } finally { await f.dispose(); }
}
/** 使用固定截止时间执行被测回放。 */
function scan(f: Fixture, config = CONFIG) { return replay(f.root, config, { cutoff: T, now: T + DAY }); }

/** 在隔离仓库中生成 SSH 密钥和真实签名提交，签名配置不触及用户环境。 */
async function signedFixture(run: (f: Fixture, oid: string) => Promise<void>): Promise<void> {
  await fixture(async f => {
    const key = join(f.root, '.git', 'fixture-signing-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const signers = join(f.root, '.git', 'allowed-signers');
    await writeFile(signers, `fixture@example.test ${await readFile(`${key}.pub`, 'utf8')}`);
    f.git(['config', 'gpg.format', 'ssh']);
    f.git(['config', 'user.signingkey', key]);
    f.git(['config', 'gpg.ssh.allowedSignersFile', signers]);
    await f.write('a.ts', 'signed line\n'); f.git(['add', 'a.ts']);
    f.git(['commit', '-S', '-m', `signed\n\n${AI}`], T - 30 * DAY);
    const oid = f.git(['rev-parse', 'HEAD']);
    assert.match(f.git(['cat-file', 'commit', oid]), /gpgsig -----BEGIN SSH SIGNATURE-----/);
    await run(f, oid);
  });
}

test('P1 真实签名提交的 commits 不受 log.showSignature 影响，完整回放仍成功', () => signedFixture(async (f, oid) => {
  const baseline = new GitAdapter(f.root, CONFIG), configured = new GitAdapter(f.root, CONFIG);
  try {
    f.git(['config', 'log.showSignature', 'false']);
    const expected = await baseline.commits(oid);
    f.git(['config', 'log.showSignature', 'true']);
    assert.deepEqual(await configured.commits(oid), expected);
    assert.equal((await scan(f)).births[0].attribution, 'ai');
  } finally { await baseline.dispose(); await configured.dispose(); }
}));

test('P1 真实签名提交的 commitInfo 不受 log.showSignature 影响，保留全部身份和 trailer', () => signedFixture(async (f, oid) => {
  const baseline = new GitAdapter(f.root, CONFIG), configured = new GitAdapter(f.root, CONFIG);
  try {
    f.git(['config', 'log.showSignature', 'false']);
    const expected = await baseline.commitInfo(oid);
    f.git(['config', 'log.showSignature', 'true']);
    assert.deepEqual(await configured.commitInfo(oid), expected);
    assert.match(expected.message, /Co-authored-by: Assistant/);
  } finally { await baseline.dispose(); await configured.dispose(); }
}));

test('T01 首次重写去重：100 行出生、20 行重写、其中 5 行再改仍为 20/100', () => fixture(async f => {
  const lines = Array.from({ length: 100 }, (_, i) => `original_${i}\n`);
  await f.write('src/a.ts', lines.join('')); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  const changed = lines.map((line, i) => i < 20 ? `replacement_${i}\n` : line);
  await f.write('src/a.ts', changed.join('')); f.commit(T - 18 * DAY);
  await f.write('src/a.ts', changed.map((line, i) => i < 5 ? `second_${i}\n` : line).join('')); f.commit(T - 17 * DAY);
  const s = await scan(f), a = new QueryService(s).aggregate();
  // 替换行也在出生窗内，归入无标记组；旧 AI 分母不变。
  assert.equal(a.ai, 100); assert.equal(a.aiRewritten, 20); assert.equal(s.events.filter(e => e.birthIds.some(id => s.births.find(b => b.id === id)?.attribution === 'ai')).length, 1);
  assert.equal(s.events[0].anchor, undefined);
}));

test('T02 窗口边界：第14天计入，之后1秒不计；出生窗左闭右开', () => fixture(async f => {
  await f.write('a', 'a\n'); f.commit(T - 28 * DAY, `left\n\n${AI}`);
  await f.write('b', 'b\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'new a\n'); f.commit(T - 14 * DAY);
  await f.write('b', 'new b\n'); f.commit(T - 7 * DAY + 1);
  const s = await scan(f), a = new QueryService(s).aggregate();
  assert.equal(a.ai, 2); assert.equal(a.aiRewritten, 1);
  assert.equal(s.births.filter(b => b.attribution === 'ai').length, 2);
  assert.equal(s.births.length, 4); // 趋势版本还保留后续新增代码，查询时按周筛选。
}));

test('T03 父级按计数相加而不是平均百分比', () => fixture(async f => {
  for (const [name, size] of [['a', 10], ['b', 90]] as const) await f.write(`pkg/${name}`, Array.from({ length: size }, (_, i) => `${name}${i}\n`).join(''));
  f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('pkg/a', Array.from({ length: 9 }, (_, i) => `a${i + 1}\n`).join(''));
  await f.write('pkg/b', Array.from({ length: 45 }, (_, i) => `b${i + 45}\n`).join(''));
  f.commit(T - 10 * DAY);
  const q = new QueryService(await scan(f)); assert.equal(rate(q.aggregate()), 'AI 46.0% · 46/100');
  assert.equal(q.files().reduce((n, f) => n + f.counts.aiRewritten, 0), 46);
}));

test('T04 只识别结尾 trailer；merge 未知；未配置不冒充无标记', () => {
  const engine = new AttributionEngine(CONFIG);
  const commit = { authorName: 'Fixture', authorEmail: 'fixture@example.test', committerName: 'Fixture',
    committerEmail: 'fixture@example.test', parents: ['parent'], message: `message\n\n${AI}` };
  assert.equal(engine.attribute(commit).attribution, 'ai');
  assert.equal(engine.attribute({ ...commit, message: `message\n${AI}\n\nbody` }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...commit, parents: ['p1', 'p2'] }).attribution, 'unknown');
  assert.equal(new AttributionEngine({ ...CONFIG, aiProviders: [] }).attribute(commit).attribution, 'unknown');
  assert.equal(engine.attribute({ ...commit, message: 'AI helped' }).attribution, 'unmarked');
});

test('T04 普通 merge 与 squash 的真实 Git 历史', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 30 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('branch', 'branch\n'); f.commit(T - 23 * DAY, `branch\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', `merge\n\n${AI}`], T - 22 * DAY);
  f.git(['checkout', '-b', 'squashed']); await f.write('squash', 'squash\n'); f.commit(T - 21 * DAY, `feature\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--squash', 'squashed'], T - 20 * DAY); f.commit(T - 20 * DAY, `squash\n\n${AI}`);
  const a = new QueryService(await scan(f)).aggregate(); assert.equal(a.unknown, 0); assert.equal(a.ai, 2);
}));

test('T07/T20/T21 跨包 rename 保持出生归属，进入排除路径仍观察删除', () => fixture(async f => {
  await f.write('packages/a/f.ts', 'one\ntwo\nthree\nfour\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.move('packages/a/f.ts', 'vendor/f.ts'); f.commit(T - 19 * DAY);
  await f.write('vendor/f.ts', 'one\nthree\nfour\n'); f.commit(T - 18 * DAY);
  const q = new QueryService(await scan(f, { ...CONFIG, packageRoots: ['packages', 'packages/a'] }));
  const files = q.files();
  assert.equal(files.length, 1); assert.equal(files[0].package, 'packages/a'); assert.equal(files[0].currentPath, 'vendor/f.ts');
  assert.equal(files[0].counts.aiRewritten, 1); assert.equal(files[0].counts.ai, 4);
  assert.equal(q.snapshot.events[0].anchor, undefined);
}));

test('T18 多 hunk 和重复文本不受用户 diff 配置影响', () => fixture(async f => {
  await f.write('a', 'same\nA\nsame\nB\nsame\nC\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'same\nX\nsame\nB\nsame\nY\n'); f.commit(T - 10 * DAY);
  const first = await scan(f);
  await writeFile(join(f.root, '.git/config'), `${await readFile(join(f.root, '.git/config'), 'utf8')}\n[diff]\n algorithm = histogram\n external = /does/not/exist\n`);
  await f.write('.gitattributes', '* -diff\n'); await f.write('.git/info/attributes', '* binary\n');
  const second = await scan(f);
  assert.deepEqual(first.births, second.births); assert.deepEqual(first.events, second.events);
  assert.equal(new QueryService(second).aggregate().aiRewritten, 2);
  assert.deepEqual(second.events.map(e => e.beforeStart), [2, 6]);
}));

test('T19 空白、CRLF 与无末尾换行保持物理坐标', () => fixture(async f => {
  await f.write('a', 'one\r\n\r\ntwo'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'one\n\nchanged'); f.commit(T - 10 * DAY);
  const s = await scan(f);
  const aiBirths = s.births.filter(b => b.attribution === 'ai');
  assert.equal(aiBirths.length, 2); assert.deepEqual(aiBirths.map(b => b.line), [1, 3]);
  assert.equal(s.events.length, 1); assert.equal(s.events[0].beforeStart, 3);
  assert.deepEqual(textLines(Buffer.from('x\n')), ['x\n']); assert.deepEqual(textLines(Buffer.from('x')), ['x']);
  assert.equal(textLines(Buffer.from([0xff])), undefined);
}));

test('T15 截止时间后正常提交只影响导航，不误判时间异常', () => fixture(async f => {
  await f.write('a', 'one\n'); const birth = f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'new\n'); const tip = f.commit(T + 3600);
  const s = await scan(f);
  assert.equal(s.analysisTipOid, birth); assert.equal(s.navigationTipOid, tip); assert.equal(s.completeness, 'complete');
  assert.equal(new QueryService(s).aggregate().aiRewritten, 0);
}));

test('T17 时间逆序及未来提交使比例不可计算', () => fixture(async f => {
  await f.write('a', 'one\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'two\n'); f.commit(T - 22 * DAY);
  f.commit(T + 2 * DAY);
  const s = await scan(f);
  assert.equal(s.completeness, 'invalid'); assert.equal(rate(new QueryService(s).aggregate()), '不可计算');
  assert.equal(s.gaps.length, 2);
}));

test('T07 anchor 随前插入移动；穿过区域后撤销；出生坐标不变', () => fixture(async f => {
  await f.write('a', 'top\nold\nbottom\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', 'top\nnew\nbottom\n'); f.commit(T - 10 * DAY);
  await f.write('a', 'prefix\ntop\nnew\nbottom\n'); f.commit(T - 9 * DAY);
  const s = await scan(f), event = s.events[0];
  assert.equal(event.beforeStart, 2); assert.equal(event.afterStart, 2); assert.equal(event.anchor?.start, 3);
  assert.equal(s.births.find(b => b.id === event.birthIds[0])?.line, 2);
  assert.equal(project({ path: 'a', start: 1, count: 2 }, segments(['a\n', 'b\n'], ['a\n', 'x\n', 'b\n']), 'a'), undefined);
}));

test('T11/T24 浅克隆和partial clone拒绝发布', () => fixture(async f => {
  await f.write('a', 'one\n'); const oid = f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await writeFile(join(f.root, '.git/shallow'), `${oid}\n`);
  await assert.rejects(scan(f), /浅克隆/);
  await rm(join(f.root, '.git/shallow'));
  await writeFile(join(f.root, '.git/config'), `${await readFile(join(f.root, '.git/config'), 'utf8')}\n[remote "origin"]\n promisor = true\n`);
  await assert.rejects(scan(f), /partial clone/);
}));

test('T20 文本转二进制产生局部缺口，其他实体可独立聚合', () => fixture(async f => {
  await f.write('a', 'one\n'); await f.write('b', 'two\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('a', Buffer.from([0, 1, 2])); f.commit(T - 10 * DAY);
  const q = new QueryService(await scan(f));
  assert.equal(q.snapshot.completeness, 'partial'); assert.equal(q.aggregate().complete, false);
  assert.equal(q.files().find(f => f.path === 'b')?.counts.complete, true);
  assert.equal(q.snapshot.excluded.objects, 1);
}));

test('T12 恶意路径与正文不会执行命令，UTF-8 特殊路径正确解析', () => fixture(async f => {
  const path = 'src/奇怪 $(touch NOT_ALLOWED) `echo x`\nfile.ts';
  await f.write(path, 'one\n'); f.commit(T - 21 * DAY, `unsafe <script>alert(1)</script>\n\n${AI}`);
  const s = await scan(f); assert.equal(s.births[0].path, path);
  assert.equal(safeGitPath('../escape'), false); assert.equal(safeGitPath('C:/escape'), false);
  assert.equal(safeGitPath('folder\\escape'), false);
}));

test('T16/T21/T22 日期、最长包归属、请求代号及分页隔离', () => fixture(async f => {
  assert.notEqual(cutoffToday(new Date(2026, 10, 4, 23, 59)), cutoffToday(new Date(2026, 10, 5, 0, 0)));
  assert.equal(packageOf('a/b/f', ['a', 'a/b']), 'a/b');
  const gate = new RequestGate(), older = gate.next(), newer = gate.next();
  assert.equal(gate.accepts(older), false); assert.equal(gate.accepts(newer), true);
  await f.write('a', 'one\n'); f.commit(T - 21 * DAY);
  const q = new QueryService(await scan(f)), p = q.page(['a', 'b'], x => x, undefined, 1);
  assert.deepEqual(q.page(['a', 'b'], x => x, p.next, 1).items, ['b']);
  const other = new QueryService({ ...q.snapshot, id: 'other' });
  assert.throws(() => other.page(['a', 'b'], x => x, p.next, 1), /快照/);
  assert.equal(eligible('vendor/a', 'code', CONFIG), false);
}));

test('T11/T23/T26 SQLite 回读、取消保留旧快照、固定引用与损坏拒绝', () => fixture(async f => {
  await f.write('a', 'one\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  const s = await scan(f), directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-store-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'));
  try {
    await store.publish(s); assert.deepEqual(await store.load(s.repoId), s);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(store.publish({ ...s, id: crypto.randomUUID() }, controller.signal));
    assert.equal((await store.load(s.repoId))?.id, s.id);
    const newer = { ...s, id: crypto.randomUUID() }; await store.publish(newer);
    await store.collect(new Set([s.id])); assert.equal((await store.load(s.repoId, s.id))?.id, s.id);
    await writeFile(join(directory, `${s.repoId}-${newer.id}.sqlite`), 'broken');
    await assert.rejects(store.load(s.repoId));
    await assert.rejects(store.load('../../outside'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('T26 打包 worker 可回放并持久化', () => fixture(async f => {
  await f.write('a', 'one\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-worker-'));
  try {
    const completed = await runWorker(f, directory, false); assert.equal(completed.type, 'complete');
    const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
    assert.equal((await store.load(hash(f.root)))?.id, completed.snapshot?.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('T26 worker 运行时取消在2秒内完成并保留旧快照', t => fixture(async f => {
  await f.write('a', 'one\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-cancel-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  try {
    const previous = await scan(f); await store.publish(previous);
    for (let i = 0; i < 24; i++) f.commit(T - 20 * DAY + i);
    const cancelled = await runWorker(f, directory, true);
    t.diagnostic(`worker 启动到取消完成 ${cancelled.elapsed.toFixed(1)} ms（不含 fixture 构造）`);
    assert.equal(cancelled.type, 'error'); assert.ok(cancelled.elapsed < 2000, `cancel elapsed ${cancelled.elapsed}`);
    assert.equal((await store.load(hash(f.root)))?.id, previous.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('P1 真实 worker 等待发布批准时取消保留旧快照', () => fixture(async f => {
  await f.write('a.ts', 'line\n'); f.commit(T - 30 * DAY);
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-worker-approval-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  try {
    const previous = await scan(f); await store.publish(previous);
    const result = await runWorker(f, directory, false, 'cancel');
    assert.equal(result.ready, true);
    assert.equal(result.type, 'error');
    assert.equal((await store.load(previous.repoId))?.id, previous.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('P1 真实 worker 发布获批后收到取消仍完成，磁盘与完成消息一致', () => fixture(async f => {
  await f.write('a.ts', 'line\n'); f.commit(T - 30 * DAY);
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-worker-committed-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  try {
    const result = await runWorker(f, directory, false, 'commit-then-cancel');
    assert.equal(result.ready, true);
    assert.equal(result.type, 'complete');
    assert.equal((await store.load(hash(f.root)))?.id, result.snapshot?.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

/** 启动真实打包 worker；排除测试转译器注入，模拟扩展宿主启动参数。 */
function runWorker(f: Fixture, directory: string, cancel: boolean, approval: 'commit' | 'cancel' | 'commit-then-cancel' = 'commit'):
Promise<{ type: string; snapshot?: Snapshot; elapsed: number; ready: boolean }> {
  return new Promise((resolve, reject) => {
    const now = performance.now();
    let result: { type: string; snapshot?: Snapshot; elapsed: number; ready: boolean } | undefined, ready = false;
    const worker = new Worker(join(process.cwd(), 'dist/worker.js'), { execArgv: [], workerData: {
      root: f.root, config: CONFIG, cutoff: T, directory, wasm: join(process.cwd(), 'dist/sql-wasm.wasm'),
    } });
    worker.on('error', reject);
    worker.on('message', message => {
      if (cancel && message.type === 'progress') worker.postMessage('cancel');
      if (message.type === 'commit-ready') {
        ready = true; worker.postMessage(approval === 'cancel' ? 'cancel' : 'commit');
        if (approval === 'commit-then-cancel') worker.postMessage('cancel');
      }
      if (message.type === 'complete' || message.type === 'error') result = { ...message, ready, elapsed: performance.now() - now };
    });
    worker.on('exit', code => {
      if (code || !result) reject(new Error(`worker exit ${code}`));
      else resolve(result);
    });
  });
}
