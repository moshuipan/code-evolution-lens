import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { replay, validateSnapshot } from '../src/replay';
import { TrendQuery } from '../src/trends';
import { dateKey, daysBefore, midnight, weekRanges } from '../src/time';
import { AI, CONFIG, DAY, Fixture, T } from './fixtures';

/** 对每个真实 Git 场景创建可销毁的仓库。 */
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await Fixture.create();
  try { await run(f); } finally { await f.dispose(); }
}
/** 以固定观察截止运行内核，按 UTC 展示可重复的时间轴。 */
async function query(f: Fixture): Promise<TrendQuery> {
  const snapshot = await replay(f.root, CONFIG, { cutoff: T, now: T + DAY });
  return new TrendQuery({ ...snapshot, timeZone: 'UTC' });
}

test('按周分组遵守时区、边缘截断和整周观察完成，夏令时不改变14天时长', () => {
  const cutoff = midnight('2026-11-06', 'Asia/Shanghai');
  const ranges = weekRanges(cutoff, 30, 'Asia/Shanghai', daysBefore(cutoff, 180, 'Asia/Shanghai'));
  assert.equal(ranges[0].startDate, '2026-10-07'); assert.equal(ranges[0].endDate, '2026-10-11');
  assert.equal(ranges[1].startDate, '2026-10-12'); assert.equal(ranges[1].observed, true);
  assert.equal(ranges[2].startDate, '2026-10-19'); assert.equal(ranges[2].observed, false);
  assert.equal(ranges.at(-1)?.endDate, '2026-11-05');
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  const dst = weekRanges(midnight('2026-03-30', 'America/New_York'), 30, 'America/New_York', 0);
  const transition = dst.find(w => w.startDate === '2026-03-02')!;
  assert.equal(transition.end - transition.start, 7 * DAY - 3600);
  assert.equal(transition.readyAt - transition.end, 14 * DAY);
  assert.equal(dateKey(midnight('2026-03-09', 'America/New_York'), 'America/New_York'), '2026-03-09');
});

test('真实目录→文件趋势：父子计数相加、近期不混入比例、无样本文件仍存在', () => fixture(async f => {
  await f.write('unchanged.txt', 'older than 180 days\n'); f.commit(T - 200 * DAY);
  await f.write('src/api/lib.ts', 'a\nb\nc\nd\n'); f.commit(T - 56 * DAY, `AI code\n\n${AI}`);
  await f.write('src/worker.ts', 'w1\nw2\n'); f.commit(T - 55 * DAY);
  await f.write('src/api/lib.ts', 'a\nchanged\nc\nd\n'); f.commit(T - 53 * DAY);
  await f.write('new.ts', 'recent\n'); f.commit(T - 2 * DAY, `Recent\n\n${AI}`);
  const q = await query(f), repo = q.report('repo', 90);
  assert.equal(repo.summary.ai, 4); assert.equal(repo.summary.aiRewritten, 1);
  assert.equal(repo.pending, 1);
  assert.ok(q.fileAt('unchanged.txt'));
  assert.equal(q.report(q.fileAt('unchanged.txt')!.id, 90).summary.ai, 0);
  assert.equal(q.report(q.fileAt('new.ts')!.id, 90).pending, 1);
  for (const key of ['ai', 'aiRewritten', 'unmarked', 'unmarkedRewritten', 'unknown'] as const)
    assert.equal(repo.summary[key], repo.children.reduce((n, child) => n + child.counts[key], 0));
  const directory = q.report('dir:src', 90), file = q.report(q.fileAt('src/api/lib.ts')!.id, 90);
  assert.equal(directory.summary.aiRewritten, 1); assert.equal(file.summary.aiRewritten, 1);
  assert.equal(file.events.length, 1); assert.equal(file.events[0].ai, 1);
  assert.equal(repo.points.filter(p => p.observed).reduce((n, p) => n + p.counts.ai, 0), repo.summary.ai);
  assert.ok(repo.points.some(p => p.observed && p.counts.ai === 0));
}));

test('历史范围覆盖180天，30/90/180切换不伪造旧曲线', () => fixture(async f => {
  for (const [file, days] of [['old.ts', 130], ['middle.ts', 60], ['recent.ts', 21]] as const) {
    await f.write(file, `${file}\n`); f.commit(T - days * DAY, `AI\n\n${AI}`);
  }
  const q = await query(f);
  assert.equal(q.report('repo', 180).summary.ai, 3);
  assert.equal(q.report('repo', 90).summary.ai, 2);
  assert.equal(q.report('repo', 30).summary.ai, 1);
  assert.throws(() => q.report('repo', 999), /30、90 或 180/);
}));

test('点选周只过滤列表，汇总不变；修改记录按该周旧代码去重', () => fixture(async f => {
  await f.write('a.ts', 'first\n'); f.commit(T - 60 * DAY, `one\n\n${AI}`);
  await f.write('a.ts', 'first\nsecond\n'); f.commit(T - 40 * DAY, `two\n\n${AI}`);
  await f.write('a.ts', 'first\nchanged\n'); f.commit(T - 36 * DAY);
  const q = await query(f), node = q.fileAt('a.ts')!;
  const week = q.weekFor(T - 40 * DAY, 90)!;
  const complete = q.report(node.id, 90), selected = q.report(node.id, 90, week);
  assert.deepEqual(selected.summary, complete.summary); assert.equal(selected.events.length, 1);
  assert.equal(selected.events[0].ai, 1); assert.equal(selected.events[0].beforeStart, 2);
  const earlier = q.report(node.id, 90, q.weekFor(T - 60 * DAY, 90));
  assert.equal(earlier.events.length, 0); // 第一个旧代码没有被修改。
  assert.equal(q.report('repo', 90, '1900-01-01').selectedWeek, undefined);
}));

test('跨目录重命名按当前路径归属，删除后重建同名文件保留两个身份', () => fixture(async f => {
  await f.write('old/a.ts', 'one\ntwo\nthree\nfour\n'); f.commit(T - 60 * DAY, `AI\n\n${AI}`);
  await f.move('old/a.ts', 'current/a.ts'); f.commit(T - 59 * DAY);
  await rm(join(f.root, 'current/a.ts')); f.commit(T - 58 * DAY);
  await f.write('current/a.ts', 'brand new\n'); f.commit(T - 56 * DAY);
  const q = await query(f), dir = q.report('dir:current', 90);
  assert.equal(q.nodes.has('dir:old'), false);
  assert.equal(dir.children.length, 2); assert.notEqual(dir.children[0].id, dir.children[1].id);
  assert.equal(dir.children.filter(n => n.deleted).length, 1);
  assert.equal(dir.summary.ai, 4); assert.equal(dir.summary.aiRewritten, 4);
  assert.equal(q.report(q.fileAt('current/a.ts')!.id, 90).summary.ai, 0);
  assert.equal(q.report(dir.children.find(n => n.deleted)!.id, 90).events[0].current, false);
}));

test('二进制转换缺口只影响观察尚未完成的旧代码和对应范围', () => fixture(async f => {
  await f.write('old.ts', 'old\n'); f.commit(T - 80 * DAY, `old\n\n${AI}`);
  await f.write('young.ts', 'young\n'); f.commit(T - 50 * DAY, `young\n\n${AI}`);
  await f.write('old.ts', Buffer.from([0, 1])); await f.write('young.ts', Buffer.from([0, 2])); f.commit(T - 48 * DAY);
  const q = await query(f);
  assert.equal(q.report(q.fileAt('old.ts')!.id, 90).summary.complete, true);
  assert.equal(q.report(q.fileAt('young.ts')!.id, 90).summary.complete, false);
  assert.equal(q.report('repo', 90).summary.complete, false);
  const affectedWeeks = q.report('repo', 90).points.filter(p => !p.counts.complete);
  assert.equal(affectedWeeks.length, 1);
}));

test('没有AI标记仍显示人工参考，合并追溯人工来源且空点不是零样本比率', () => fixture(async f => {
  await f.write('a.ts', 'human\n'); f.commit(T - 60 * DAY);
  f.git(['checkout', '-b', 'branch']); await f.write('merged.ts', 'unknown\n'); f.commit(T - 58 * DAY);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'branch', '-m', 'merge'], T - 57 * DAY);
  const report = (await query(f)).report('repo', 90);
  assert.equal(report.summary.ai, 0); assert.equal(report.summary.unmarked, 2); assert.equal(report.summary.unknown, 0);
  assert.equal(report.summary.configured, true);
  assert.ok(report.points.some(p => p.observed && p.counts.ai === 0 && p.counts.unmarked === 0));
}));

test('旧版缓存不能被当作180天趋势数据，必须明确要求重建', () => fixture(async f => {
  await f.write('a.ts', 'sample\n'); f.commit(T - 60 * DAY);
  const q = await query(f);
  assert.throws(() => validateSnapshot({ ...q.snapshot, schema: 1 } as any), /重新分析仓库/);
}));
