import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Birth } from '../src/model';
import { providerBucket, kaplanMeier } from '../src/metrics';
import { replay } from '../src/replay';
import { buildIndex } from '../src/indexer';
import { TrendQuery } from '../src/trends';
import { Fixture, CONFIG, AI, T, DAY } from './fixtures';

test('provider 多信号不重复分摊；具体名称、多个名称和共享证据互斥', () => {
  const birth = { attribution: 'ai' } as Birth;
  assert.equal(providerBucket(birth).id, 'ambiguous');
  birth.attributionSignals = [{ provider: 'AI 邮箱名（提供者不唯一）', kind: 'coauthor-email' },
    { provider: 'Claude Code', kind: 'coauthor-name' }, { provider: 'Claude Code', kind: 'generated-trailer' }];
  assert.equal(providerBucket(birth).id, 'provider:claude code');
  birth.attributionSignals.push({ provider: 'OpenAI Codex', kind: 'coauthor-name' });
  assert.equal(providerBucket(birth).id, 'multiple');
  assert.deepEqual(providerBucket(birth).members, ['Claude Code', 'OpenAI Codex']);
});

test('KM 同时事件和删失按共同风险集计算；不外推至未观察的年龄', () => {
  const points = kaplanMeier([{ duration: DAY, event: true }, { duration: DAY, event: false },
    { duration: 2 * DAY, event: true }, { duration: 3 * DAY, event: false }]);
  assert.deepEqual(points[1], { age: 1, survival: 0.75, atRisk: 4, events: 1, censored: 1 });
  assert.deepEqual(points[2], { age: 2, survival: 0.375, atRisk: 2, events: 2, censored: 1 });
  assert.equal(points.at(-1)!.age, 3); assert.equal(points.at(-1)!.survival, 0.375);
  assert.deepEqual(kaplanMeier([]), []);
});

test('真实回放：删除窗外旧行与追加仅影响churn，成熟provider与原趋势完全对齐', async () => {
  const f = await Fixture.create();
  try {
    await f.write('src/a.ts', 'old\n\n'); f.commit(T - 200 * DAY);
    await f.write('src/a.ts', 'one\ntwo\n\n'); f.commit(T - 60 * DAY, `add\n\n${AI}`);
    await f.write('src/a.ts', 'one\ntwo\nthree\n'); f.commit(T - 59 * DAY, 'fix: append');
    await f.write('src/a.ts', 'one\nchanged\nthree\n'); f.commit(T - 57 * DAY, 'fix(core): edit');
    await f.write('recent.ts', 'pending\n'); f.commit(T - 2 * DAY, `add\n\n${AI}`);
    const s = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }), q = new TrendQuery(s), r = q.report('repo', 90);
    const ai = r.metrics.providers.find(p => p.attribution === 'ai')!;
    assert.equal(ai.added, 3); assert.equal(ai.mature, r.summary.ai); assert.equal(ai.rewritten, r.summary.aiRewritten);
    assert.equal(ai.mature, 2); assert.equal(ai.rewritten, 1); assert.equal(ai.aiShare, 1);
    assert.deepEqual(ai.retention14, { numerator: 1, denominator: 2, complete: true });
    assert.deepEqual(ai.retention30, { numerator: 1, denominator: 2, complete: true });
    assert.equal(ai.medianRewriteDays, 3);
    assert.equal(r.metrics.activity.added, 5); assert.equal(r.metrics.activity.deleted, 2);
    assert.equal(r.metrics.activity.fixTitles, 2); assert.equal(r.metrics.activity.repeatedFiles, 1);
    assert.equal(r.metrics.topFiles[0].commits, 3); assert.equal(r.metrics.activity.sessions, 4);
    assert.equal(r.metrics.providers.reduce((n, p) => n + p.added, 0), s.births.length);
    assert.equal(r.metrics.contributors[0].retained, 4);
    assert.ok(!JSON.stringify(s).includes('fixture@example.test'));
    assert.equal(q.report('repo', 90, q.weekFor(T - 60 * DAY, 90)).metrics, r.metrics);
    assert.equal(q.report('repo', 30).metrics.activity.commits, 1);
  } finally { await f.dispose(); }
});

test('合并来源provider和作者追溯；配置暖重算只更新归因，保留活动汇总', async () => {
  const f = await Fixture.create();
  try {
    await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
    f.git(['checkout', '-b', 'feature']);
    await f.write('a.ts', 'ai\n');
    const source = f.commit(T - 80 * DAY, 'add\n\nGenerated-By: TRAE', { authorName: 'Source', authorEmail: 'source@example.test' });
    f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 60 * DAY);
    const s = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }), r = new TrendQuery(s).report('repo', 90);
    assert.equal(r.metrics.providers[0].name, 'TRAE'); assert.equal(r.metrics.providers[0].commits, 1);
    assert.equal(s.births[0].origin?.commit, source); assert.equal(r.metrics.contributors[0].name, 'Source');
    assert.equal(r.metrics.activity.merges, 1); assert.equal(r.metrics.activity.commits, 1);
    const warm = await buildIndex(f.root, { ...CONFIG, aiProviders: [{ provider: '团队助手', nameTokens: ['trae'] }] },
      { cutoff: T, now: T + DAY }, s);
    assert.deepEqual(warm.activity, s.activity);
    assert.equal(new TrendQuery(warm).report('repo', 90).metrics.providers[0].name, '团队助手');
  } finally { await f.dispose(); }
});

test('固定年龄边界、整周成熟边界与截至截止日的存活区分；KM利用年轻删失样本', async () => {
  const f = await Fixture.create();
  try {
    await f.write('a', 'exact14\n'); f.commit(T - 14 * DAY, `add\n\n${AI}`);
    await f.write('b', 'young\n'); f.commit(T - DAY, `add\n\n${AI}`);
    await f.write('b', 'later\n'); f.commit(T + 10);
    const s = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }), r = new TrendQuery(s).report('repo', 30);
    const ai = r.metrics.providers.find(p => p.attribution === 'ai')!;
    assert.equal(ai.retention14.denominator, 1); assert.equal(ai.retention14.numerator, 1);
    assert.equal(ai.retention30.denominator, 0); assert.equal(ai.mature, r.summary.ai);
    assert.equal(r.metrics.survival[0].samples, 2);
    assert.equal(r.metrics.survival[0].points.at(-1)!.age, 14);
    assert.equal(r.metrics.survival[0].points.at(-1)!.events, 0);
    assert.equal(r.metrics.contributors[0].retained, 2);
    assert.equal(r.metrics.activity.commits, 2);
  } finally { await f.dispose(); }
});

test('历史缺口截断KM观察，未知时间排除；无样本和未配置不补假零', async () => {
  const f = await Fixture.create();
  try {
    await f.write('a', 'one\ntwo\n'); f.commit(T - 40 * DAY, `add\n\n${AI}`);
    const s = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
    s.gaps.push({ entity: s.births[0].entity, birthIds: [s.births[0].id], time: T - 35 * DAY, reason: '测试缺口' },
      { entity: s.births[1].entity, birthIds: [s.births[1].id], reason: '未知时刻缺口' });
    s.completeness = 'partial';
    const r = new TrendQuery(s).report('repo', 90);
    assert.equal(r.metrics.survival[0].samples, 1); assert.equal(r.metrics.survival[0].excluded, 1);
    assert.equal(r.metrics.survival[0].points.at(-1)!.age, 5);
    assert.equal(r.metrics.providers[0].complete, false); assert.equal(r.metrics.providers[0].retention14.complete, false);
    assert.equal(r.metrics.providers[0].retention14.denominator, 0);
    const unconfigured = await buildIndex(f.root, { ...CONFIG, aiProviders: [] }, { cutoff: T, now: T + DAY });
    assert.ok(new TrendQuery(unconfigured).report('repo', 90).metrics.survival.every(s => !s.points.length));
  } finally { await f.dispose(); }
});

test('共同修改分母同步排除大批量提交；重命名与删除后重建使用不同实体', async () => {
  const f = await Fixture.create();
  try {
    for (let i = 0; i < 3; i++) {
      await f.write('src/a', `a${i}\n`); await f.write('src/b', `b${i}\n`);
      f.commit(T - (60 - i) * DAY);
    }
    await f.write('src/a', 'batch\n'); await f.write('src/b', 'batch-b\n');
    for (let i = 0; i < 99; i++) await f.write(`src/batch-${i}`, 'value\n');
    f.commit(T - 55 * DAY);
    await f.move('src/a', 'src/renamed'); f.commit(T - 50 * DAY);
    const s = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }), q = new TrendQuery(s);
    const r = q.report('dir:src', 90).metrics;
    assert.equal(r.couplingSkipped, 1);
    const pair = r.coupling.find(p => [p.left, p.right].includes('src/renamed'))!;
    assert.equal(pair.commits, 3); assert.equal(pair.ratio, 1);
    assert.ok(!r.coupling.some(p => p.left === 'src/a' || p.right === 'src/a'));
    assert.equal(q.report(q.fileAt('src/renamed')!.id, 90).metrics.couplingSkipped, 1);
    await rm(join(f.root, 'src/renamed')); f.commit(T - 45 * DAY);
    await f.write('src/renamed', 'new identity\n'); f.commit(T - 40 * DAY);
    const next = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
    assert.equal(next.entities.filter(e => e.path === 'src/renamed').length, 2);
    const query = new TrendQuery(next);
    assert.equal(query.report('repo', 90).metrics.totalFiles, 102);
    const current = query.report(query.fileAt('src/renamed')!.id, 90).metrics;
    assert.equal(current.totalFiles, 1); assert.equal(current.topFiles[0].added, 1);
  } finally { await f.dispose(); }
});

test('同作者90分钟活动区间，跨作者独立；二进制缺口不制造改动量', async () => {
  const f = await Fixture.create();
  try {
    await f.write('a', 'one\n'); f.commit(T - 40 * DAY);
    await f.write('a', 'two\n'); f.commit(T - 40 * DAY + 90 * 60);
    await f.write('a', 'three\n'); f.commit(T - 40 * DAY + 90 * 60 + 1, 'fix issue', { authorName: 'Other' });
    await f.write('a', 'four\n'); f.commit(T - 40 * DAY + 180 * 60 + 1);
    await f.write('binary', Buffer.from([0, 1, 2])); f.commit(T - 30 * DAY, 'Revert "example"');
    const r = new TrendQuery(await replay(f.root, CONFIG, { cutoff: T, now: T + DAY })).report('repo', 90).metrics;
    assert.equal(r.activity.sessions, 4); assert.equal(r.activity.fixTitles, 0); assert.equal(r.activity.revertTitles, 1);
    assert.equal(r.activity.complete, false); assert.equal(r.activity.added, 4); assert.equal(r.activity.deleted, 3);
  } finally { await f.dispose(); }
});
