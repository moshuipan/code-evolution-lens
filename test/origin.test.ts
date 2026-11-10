import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AttributionEngine } from '../src/attribution';
import { decodeGitPath, GitAdapter } from '../src/git';
import { buildIndex } from '../src/indexer';
import { ORIGIN_RULE } from '../src/model';
import { resolveOrigins } from '../src/origin';
import { replay, validateSnapshot } from '../src/replay';
import { attributionHash, configHash, hash } from '../src/rules';
import { SnapshotStore } from '../src/store';
import { TrendQuery } from '../src/trends';
import { AI, CONFIG, DAY, Fixture, T } from './fixtures';

/** 用真实多父 Git 历史验证来源，测试结束仅清理自身临时仓库。 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await Fixture.create();
  try { await run(f); } finally { await f.dispose(); }
}
/** 保持同一截止时刻，避免暖重算和冷回放因日期产生差异。 */
function scan(f: Fixture) { return replay(f.root, CONFIG, { cutoff: T, now: T + DAY }); }

test('混合AI和人工的合并逐行归因，主线时间和14天首次修改不变', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']);
  await f.write('src/mixed.ts', 'ai-one\nsame\nai-last\n');
  const ai = f.commit(T - 100 * DAY, `AI source\n\n${AI}`);
  await f.write('src/mixed.ts', 'ai-one\nsame\nhuman\nai-last\n');
  const human = f.commit(T - 40 * DAY);
  f.git(['checkout', 'main']);
  f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 30 * DAY);
  const merge = f.git(['rev-parse', 'HEAD']);
  await f.write('src/mixed.ts', 'new-ai-one\nsame\nnew-human\nai-last\n'); f.commit(T - 20 * DAY);
  const s = await scan(f), imported = s.births.filter(b => b.commit === merge);
  assert.deepEqual(imported.map(b => b.attribution), ['ai', 'ai', 'unmarked', 'ai']);
  assert.deepEqual(imported.map(b => b.origin?.commit), [ai, ai, human, ai]);
  assert.ok(imported.every(b => b.time === T - 30 * DAY && b.origin?.kind === 'inherited'));
  const report = new TrendQuery(s).report('repo', 180);
  assert.equal(report.summary.ai, 3); assert.equal(report.summary.aiRewritten, 1);
  assert.equal(report.summary.unmarked, 3); assert.equal(report.summary.unmarkedRewritten, 1);
  const file = new TrendQuery(s).fileAt('src/mixed.ts')!;
  const events = new TrendQuery(s).report(file.id, 180).events;
  assert.ok(events.some(event => event.origins.some(o => o.mainlineCommit === merge && o.sourceCommit === ai)));
  assert.ok(events.some(event => event.origins.some(o => o.sourceCommit === human)));
}));

test('冲突解决行保持未知，合并消息不覆盖分支来源', () => fixture(async f => {
  await f.write('conflict', 'base\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('conflict', 'branch\n'); f.commit(T - 60 * DAY, `branch\n\n${AI}`);
  f.git(['checkout', 'main']); await f.write('conflict', 'main\n'); f.commit(T - 59 * DAY);
  assert.throws(() => f.git(['merge', '--no-ff', 'feature', '-m', `merge\n\n${AI}`], T - 58 * DAY));
  await f.write('conflict', 'resolved\n'); const merge = f.commit(T - 58 * DAY, `resolve\n\n${AI}`);
  const s = await scan(f), resolved = s.births.find(b => b.commit === merge)!;
  assert.equal(resolved.attribution, 'unknown'); assert.equal(resolved.origin?.kind, 'merge-created');
  assert.equal(resolved.origin?.commit, merge);
}));

test('祖先合并中的冲突解决行进入主线后仍未知，其余分支行继承AI来源', () => fixture(async f => {
  await f.write('conflict', 'base\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('conflict', 'feature\n'); f.commit(T - 70 * DAY);
  f.git(['checkout', '-b', 'nested']); await f.write('conflict', 'nested\n');
  await f.write('ai', 'AI\n'); const ai = f.commit(T - 69 * DAY, `nested\n\n${AI}`);
  f.git(['checkout', 'feature']); await f.write('conflict', 'other\n'); f.commit(T - 68 * DAY);
  assert.throws(() => f.git(['merge', '--no-ff', 'nested', '-m', 'nested merge'], T - 67 * DAY));
  await f.write('conflict', 'resolved\n'); const ancestor = f.commit(T - 67 * DAY, `resolve\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'main merge'], T - 60 * DAY);
  const s = await scan(f);
  assert.equal(s.births.find(b => b.path === 'conflict')?.origin?.commit, ancestor);
  assert.equal(s.births.find(b => b.path === 'conflict')?.attribution, 'unknown');
  assert.equal(s.births.find(b => b.path === 'ai')?.origin?.commit, ai);
  assert.equal(s.births.find(b => b.path === 'ai')?.attribution, 'ai');
}));

test('多父合并、来源rename、重复行和特殊字面路径可核验且不执行路径正文', () => fixture(async f => {
  const path = 'src/中文 "quoted" $(touch NOT_ALLOWED)\nfile';
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'one']); await f.write(path, 'same\r\nsame\r\nai\r\n');
  const ai = f.commit(T - 60 * DAY, `source\n\n${AI}`);
  await f.move(path, 'renamed/file'); f.commit(T - 59 * DAY);
  f.git(['checkout', 'main']); f.git(['checkout', '-b', 'two']);
  await f.write('human', 'human\n'); const human = f.commit(T - 58 * DAY);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'one', 'two', '-m', 'octopus'], T - 57 * DAY);
  const s = await scan(f), imported = s.births.filter(b => b.path === 'renamed/file');
  assert.deepEqual(imported.map(b => b.origin?.line), [1, 2, 3]);
  assert.ok(imported.every(b => b.origin?.commit === ai && b.origin?.path === path && b.attribution === 'ai'));
  assert.equal(s.births.find(b => b.path === 'human')?.origin?.commit, human);
  assert.equal(decodeGitPath('"src/\\344\\270\\255\\346\\226\\207\\nfile"'), 'src/中文\nfile');
  assert.throws(() => decodeGitPath('"../escape"'));
  assert.throws(() => decodeGitPath('"bad\\q"'));
}));

test('blame忽略用户配置和属性，末尾换行变化保留为未知且CRLF可继承', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('line', 'same'); const ai = f.commit(T - 60 * DAY, `source\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', '--no-commit', 'feature'], T - 59 * DAY);
  await f.write('line', 'same\n'); const merge = f.commit(T - 59 * DAY, 'merge with newline');
  const first = await scan(f);
  const line = first.births.find(b => b.commit === merge)!;
  assert.equal(line.attribution, 'unknown');
  assert.ok(['unverified', 'merge-created'].includes(line.origin!.kind));
  await writeFile(join(f.root, '.git/config'), `${await readFile(join(f.root, '.git/config'), 'utf8')}\n[blame]\n ignoreRevsFile = /does/not/exist\n[diff]\n algorithm = histogram\n`);
  await f.write('.git/info/attributes', '* binary\n');
  assert.deepEqual((await scan(f)).births, first.births);
  assert.ok(ai);
}));

test('暖重算保留旧快照全部事实，与冷回放归因和曲线相等；关闭规则仍未知', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('a', 'AI\n'); f.commit(T - 60 * DAY, `source\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 50 * DAY);
  await f.write('a', 'changed\n'); f.commit(T - 45 * DAY);
  const cold = await scan(f), previous = structuredClone(cold);
  delete previous.originRuleVersion;
  previous.attributionHash = hash(new AttributionEngine(CONFIG).rule);
  for (const b of previous.births) { delete b.origin; b.attribution = 'unknown'; b.attributionSignals = []; }
  const warm = await buildIndex(f.root, CONFIG, { cutoff: T, now: T + DAY }, previous);
  assert.deepEqual(warm.births, cold.births); assert.deepEqual(warm.events, previous.events);
  assert.deepEqual(warm.files, previous.files); assert.deepEqual(warm.entities, previous.entities);
  assert.ok(previous.births.every(b => b.attribution === 'unknown' && !b.origin));
  assert.notEqual(warm.id, previous.id); assert.equal(warm.originRuleVersion, ORIGIN_RULE);
  assert.equal(warm.attributionHash, attributionHash(CONFIG)); assert.equal(warm.configHash, configHash(CONFIG));
  assert.deepEqual(new TrendQuery(warm).report('repo', 180), new TrendQuery(cold).report('repo', 180));
  const disabled = await buildIndex(f.root, { ...CONFIG, aiProviders: [] }, { cutoff: T, now: T + DAY }, warm);
  assert.ok(disabled.births.every(b => b.attribution === 'unknown')); assert.equal(disabled.attributionConfigured, false);
  const invalid = structuredClone(warm); delete invalid.births[0].origin;
  assert.throws(() => validateSnapshot(invalid), /来源记录缺失/);
}));

test('来源查询失败与取消不发布候选，SQLite的旧active结果保留', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('a', 'AI\n'); f.commit(T - 60 * DAY, `source\n\n${AI}`);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 50 * DAY);
  const previous = await scan(f), directory = await mkdtemp(join(tmpdir(), 'origin-store-'));
  const store = new SnapshotStore(directory, join(process.cwd(), 'dist/sql-wasm.wasm'));
  const git = new GitAdapter(f.root, CONFIG);
  try {
    await store.publish(previous);
    git.blame = async () => { throw new Error('test missing origin object'); };
    await assert.rejects(resolveOrigins(structuredClone(previous), git, new AttributionEngine(CONFIG),
      await git.commits(previous.navigationTipOid), () => {}), /missing origin object.*主线提交/);
    const controller = new AbortController();
    await assert.rejects(buildIndex(f.root, CONFIG, { cutoff: T, now: T + DAY, signal: controller.signal,
      originProgress: () => controller.abort(new Error('test cancel')) }, previous), /test cancel/);
    assert.equal((await store.load(previous.repoId))?.id, previous.id);
  } finally { await git.dispose(); await rm(directory, { recursive: true, force: true }); }
}));

test('主线或排除规则变化不复用旧事实，自定义规则用于原始分支提交', () => fixture(async f => {
  await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
  f.git(['checkout', '-b', 'feature']); await f.write('a', 'AI\n');
  f.commit(T - 60 * DAY, 'source', { authorEmail: 'internal@example.test' });
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 50 * DAY);
  const previous = await scan(f);
  assert.equal(previous.births[0].attribution, 'unmarked');
  const config = { ...CONFIG, aiProviders: [...CONFIG.aiProviders, { provider: 'Internal', emails: ['internal'] }] };
  const custom = await buildIndex(f.root, config, { cutoff: T, now: T + DAY }, previous);
  assert.equal(custom.births[0].attribution, 'ai');
  const filtered = await buildIndex(f.root, { ...config, excludeGlobs: ['a'] }, { cutoff: T, now: T + DAY }, custom);
  assert.equal(filtered.births.length, 0);
  await f.write('new', 'new\n'); f.commit(T - 40 * DAY);
  const updated = await buildIndex(f.root, config, { cutoff: T, now: T + DAY }, custom);
  assert.equal(updated.births.length, 2);
  assert.notEqual(updated.navigationTipOid, previous.navigationTipOid);
}));

test('共享cat-file读取空blob、二进制和并发请求；类型失败不会污染下一对象', () => fixture(async f => {
  await f.write('empty', '');
  const binary = Buffer.from([0, 10, 255, 1]);
  await f.write('binary', binary); await f.write('large', 'x'.repeat(5000)); await f.write('one', '1');
  const commit = f.commit(T - 60 * DAY);
  const empty = f.git(['rev-parse', 'HEAD:empty']), blob = f.git(['rev-parse', 'HEAD:binary']);
  const large = f.git(['rev-parse', 'HEAD:large']);
  const one = f.git(['rev-parse', 'HEAD:one']);
  const git = new GitAdapter(f.root, CONFIG);
  try {
    const results = await Promise.all([git.blob(empty), git.blob(blob), git.blob(blob)]);
    assert.equal(results[0].length, 0); assert.deepEqual(results[1], binary); assert.deepEqual(results[2], binary);
    assert.equal(git.bytes, 4); assert.equal(git.children.size, 1);
    assert.equal((await git.blob(large)).length, 5000);
    await assert.rejects(git.blob(commit), /对象响应无法核验/);
    assert.equal((await git.blob(one)).toString(), '1');
    assert.deepEqual(await git.blob(blob), binary);
  } finally { await git.dispose(); }
}));
