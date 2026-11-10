import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffArrays } from 'diff';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { GitAdapter } from '../src/git';
import { replay, segments } from '../src/replay';
import { Config, DEFAULT_CONFIG, Snapshot } from '../src/model';
import { configHash, hash, normalizeConfig } from '../src/rules';
import { SnapshotStore } from '../src/store';
import { AI, CONFIG, DAY, Fixture, T } from './fixtures';

/** 创建只在临时目录操作的真实 Git 历史。 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await Fixture.create();
  try { await run(f); } finally { await f.dispose(); }
}
/** 提取原版 jsdiff 的公共行配对，验证重复文本的身份选择而非只比较编辑行数。 */
function referenceMatches(before: string[], after: string[]): [number, number][] {
  const result: [number, number][] = [];
  let oldAt = 0, newAt = 0;
  for (const part of diffArrays(before, after)) {
    if (!part.added && !part.removed)
      for (let i = 0; i < part.count; i++) result.push([oldAt + i, newAt + i]);
    if (!part.added) oldAt += part.count;
    if (!part.removed) newAt += part.count;
  }
  return result;
}
/** 生成长度不超过四的三字符序列，覆盖歧义重复行及无公共文本。 */
function shortArrays(): string[][] {
  const result: string[][] = [[]];
  let level: string[][] = [[]];
  for (let n = 1; n <= 4; n++) {
    level = level.flatMap(array => ['a\n', 'b\n', 'c\n'].map(line => [...array, line]));
    result.push(...level);
  }
  return result;
}

test('精确快路径：14641 组小输入与 diff@8.0.4 公共行身份及完整坐标一致', () => {
  const arrays = shortArrays();
  for (const before of arrays) for (const after of arrays) {
    const actual: [number, number][] = [];
    let oldAt = 0, newAt = 0;
    for (const part of segments(before, after)) {
      assert.equal(part.oldStart, oldAt); assert.equal(part.newStart, newAt);
      if (part.common) {
        assert.equal(part.removed, part.added);
        assert.deepEqual(before.slice(oldAt, oldAt + part.removed), after.slice(newAt, newAt + part.added));
        for (let i = 0; i < part.removed; i++) actual.push([oldAt + i, newAt + i]);
      } else assert.ok(part.removed + part.added > 0);
      oldAt += part.removed; newAt += part.added;
    }
    assert.equal(oldAt, before.length); assert.equal(newAt, after.length);
    assert.deepEqual(actual, referenceMatches(before, after));
  }
});

test('大规模空侧、无相同行和生成头变化后的纯删除得到精确差异', () => {
  const old = Array.from({ length: 65064 }, (_, i) => `old_${i}\n`);
  const replacement = Array.from({ length: 65064 }, (_, i) => `replacement_${i}\n`);
  assert.deepEqual(segments([], old), [{ oldStart: 0, newStart: 0, removed: 0, added: old.length, common: false }]);
  assert.deepEqual(segments(old, []), [{ oldStart: 0, newStart: 0, removed: old.length, added: 0, common: false }]);
  assert.deepEqual(segments(old, replacement),
    [{ oldStart: 0, newStart: 0, removed: old.length, added: replacement.length, common: false }]);
  const kept = old.filter((_, i) => i % 100 === 0);
  const parts = segments(['old generated header\n', ...old], ['new generated header\n', ...kept]);
  assert.equal(parts.filter(p => p.common).reduce((n, p) => n + p.removed, 0), kept.length);
  assert.equal(parts.filter(p => !p.common).reduce((n, p) => n + p.removed, 0), old.length + 1 - kept.length);
  assert.equal(parts.filter(p => !p.common).reduce((n, p) => n + p.added, 0), 1);
});

test('窗外巨量变化不读取正文，保留身份并从真实父版本识别窗口内新增', () => fixture(async f => {
  const huge = Array.from({ length: 65064 }, (_, i) => `generated_${i}\n`).join('');
  await f.write('generated.ts', 'original\n');
  await f.write('untouched.ts', huge);
  const root = f.commit(T - 220 * DAY);
  await f.write('generated.ts', huge); f.commit(T - 210 * DAY);
  const baseline = 'one\ntwo\nthree\n';
  await f.write('generated.ts', baseline); f.commit(T - 181 * DAY);
  await f.move('generated.ts', 'src/current.ts');
  await f.write('src/current.ts', `${baseline}recent\n`); const birth = f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('src/current.ts', baseline); f.commit(T - 18 * DAY);
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  assert.equal(snapshot.completeness, 'complete'); assert.equal(snapshot.work.commits, 5);
  assert.equal(snapshot.births.length, 1); assert.equal(snapshot.births[0].commit, birth);
  assert.equal(snapshot.births[0].line, 4); assert.equal(snapshot.births[0].entity, hash([root, 'generated.ts']));
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].beforeStart, 4);
  assert.equal(snapshot.entities.find(e => e.entity === snapshot.births[0].entity)?.path, 'src/current.ts');
  assert.equal(snapshot.entities.find(e => e.path === 'untouched.ts')?.blob, f.git(['rev-parse', 'HEAD:untouched.ts']));
  assert.deepEqual(snapshot.files.find(file => file.path === 'untouched.ts')?.lines, []);
  assert.ok(snapshot.work.objectBytes < 64);
}));

test('排除路径无跟踪时不读取巨量正文，移出后仍只将真正新增行计入', () => fixture(async f => {
  await f.write('vendor/huge.ts', 'generated\n'.repeat(65064));
  await f.write('vendor/a.ts', 'one\ntwo\nthree\n'); f.commit(T - 21 * DAY);
  await f.move('vendor/a.ts', 'src/a.ts');
  await f.write('src/a.ts', 'one\ntwo\nthree\nrecent\n'); f.commit(T - 20 * DAY, `birth\n\n${AI}`);
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  assert.equal(snapshot.births.length, 1); assert.equal(snapshot.births[0].line, 4);
  assert.match(snapshot.entities.find(e => e.path === 'vendor/huge.ts')?.excludedReason ?? '', /排除/);
}));

test('没有存活出生行的文件仍投影旧事件 anchor，截止后 rename 到排除路径不丢定位', () => fixture(async f => {
  await f.write('src/a.ts', 'old\n'); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  await f.write('src/a.ts', 'replacement\n'); f.commit(T + 3600);
  await f.write('src/a.ts', 'prefix\nreplacement\n'); f.commit(T + 7200);
  await f.move('src/a.ts', 'vendor/a.ts'); f.commit(T + 10800);
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  assert.equal(snapshot.births.length, 1); assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.events[0].anchor, { path: 'vendor/a.ts', start: 2, count: 1 });
  assert.deepEqual(snapshot.files.find(file => file.path === 'vendor/a.ts')?.lines, [null, null]);
}));

test('窗外跳过正文仍核验所有主线提交时间，不能藏掉时间逆序', () => fixture(async f => {
  await f.write('old.ts', 'generated\n'.repeat(65064)); f.commit(T - 220 * DAY);
  f.commit(T - 221 * DAY);
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  assert.equal(snapshot.completeness, 'invalid'); assert.equal(snapshot.gaps.length, 1);
  assert.equal(snapshot.work.commits, 2); assert.equal(snapshot.work.objectBytes, 0);
}));

test('六项旧上限和旧开关不进入运行配置，不改变事实指纹', () => {
  const legacy = { ...CONFIG, maxCommits: 1, maxBlobBytes: 1, maxTotalBytes: 1,
    maxPhysicalLines: 1, maxFileDiffMs: 1, maxIndexSeconds: 1, useDefaultAiRules: false };
  const normalized = normalizeConfig(legacy);
  assert.deepEqual(normalized, normalizeConfig(CONFIG));
  assert.equal(configHash(CONFIG), configHash(normalized));
  for (const key of Object.keys(legacy).filter(key => key.startsWith('max') || key === 'useDefaultAiRules'))
    assert.equal(key in DEFAULT_CONFIG, false);
});

test('实际worker忽略旧上限，完成精确差异并原子发布新快照', () => fixture(async f => {
  const path = 'src/预算 中文.ts';
  const old = Array.from({ length: 1200 }, (_, i) => `old_${i}\n`);
  const changed = Array.from({ length: 1200 }, (_, i) => `changed_${i}\n`);
  await f.write(path, `top\n${old.join('')}bottom\n`); f.commit(T - 21 * DAY, `birth\n\n${AI}`);
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-unlimited-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  try {
    const previous = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }); await store.publish(previous);
    await f.write(path, `top\n${changed.join('')}bottom\n`); f.commit(T - 18 * DAY);
    const legacy = { ...CONFIG, maxCommits: 1, maxBlobBytes: 1, maxTotalBytes: 1,
      maxPhysicalLines: 1, maxFileDiffMs: 1, maxIndexSeconds: 1 };
    const recovered = await runWorker(f, directory, legacy);
    assert.equal(recovered.type, 'complete');
    assert.equal(recovered.snapshot?.events.length, 1);
    assert.equal(recovered.snapshot?.events[0].birthIds.length, 1200);
    assert.equal((await store.load(hash(f.root)))?.id, recovered.snapshot?.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('回放时钟跨过180秒仍完成精确差异，不再设置Myers或总时长截止', t => fixture(async f => {
  await f.write('a.ts', `top\n${'old\n'.repeat(1200)}bottom\n`); f.commit(T - 21 * DAY);
  await f.write('a.ts', `top\n${'new\n'.repeat(1200)}bottom\n`); f.commit(T - 18 * DAY);
  const started = Date.now();
  let clock = started;
  t.mock.method(Date, 'now', () => clock++);
  const snapshot = await replay(f.root, CONFIG, {
    cutoff: T, now: T + DAY, progress: done => { if (done === 1) clock = started + 3600000; },
  });
  assert.equal(snapshot.completeness, 'complete');
  assert.equal(snapshot.events[0].birthIds.length, 1200);
  assert.ok(snapshot.work.elapsedMs >= 3600000);
}));

test('超过旧4MiB文件和500000物理行仍回放全部正文', () => fixture(async f => {
  const content = `${' '.repeat(8)}\n`.repeat(500001) + 'code\n';
  await f.write('large.ts', content); f.commit(T - 21 * DAY);
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  assert.ok(snapshot.work.objectBytes > 4194304);
  assert.equal(snapshot.files[0].lines.length, 500002);
  assert.equal(snapshot.births.length, 1); assert.equal(snapshot.births[0].line, 500002);
}));

test('读取50001条主线记录不加max-count也不截断', async () => {
  const git = new GitAdapter(process.cwd(), CONFIG);
  const ids = Array.from({ length: 50001 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  git.run = async args => {
    assert.ok(!args.some(arg => arg.startsWith('--max-count')));
    return Buffer.from(ids.map((oid, i) => [oid, ids[i - 1] ?? '', T - DAY, 'Fixture', 'fixture@example.test',
      'Fixture', 'fixture@example.test', 'message', ''].join('\0')).join('\n'));
  };
  const commits = await git.commits(ids.at(-1)!);
  assert.equal(commits.length, 50001); assert.equal(commits.at(-1)?.oid, ids.at(-1));
});

/** 启动实际构建的 worker，验证失败路径不会发布候选缓存。 */
function runWorker(f: Fixture, directory: string, config: Config): Promise<{ type: string; message?: string; snapshot?: Snapshot }> {
  return new Promise((resolve, reject) => {
    let result: { type: string; message?: string; snapshot?: Snapshot } | undefined;
    const worker = new Worker(join(process.cwd(), 'dist/worker.js'), { execArgv: [], workerData: {
      root: f.root, config, cutoff: T, directory, wasm: join(process.cwd(), 'dist/sql-wasm.wasm'),
    } });
    worker.on('message', message => {
      if (message.type === 'commit-ready') worker.postMessage('commit');
      if (message.type === 'complete' || message.type === 'error') result = message;
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code || !result) reject(new Error(`worker exit ${code}`));
      else resolve(result);
    });
  });
}
