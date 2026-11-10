import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Fixture, CONFIG, AI, T, DAY } from './fixtures';
import { replay } from '../src/replay';
import { TrendQuery, TrendReport } from '../src/trends';
import { acceptMessage } from '../src/presentation';
import { configHash, cutoffToday } from '../src/rules';
import { issueForCode } from '../src/issues';
import { basename, join } from 'node:path';
import { mkdtemp, rm, symlink, realpath, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter as NodeEmitter } from 'node:events';
import { defaultView, normalizeView } from '../src/view-state';

let f: Fixture, q: TrendQuery;
const path = 'src/api/<img src=x onerror=alert(1)>.ts';
before(async () => {
  f = await Fixture.create();
  await f.write('unchanged.ts', 'old\n'); f.commit(T - 200 * DAY);
  await f.write(path, 'first\nsecond\n'); f.commit(T - 60 * DAY, `AI\n\n${AI}`);
  await f.write(path, 'first\nchanged\n'); f.commit(T - 58 * DAY);
  await f.write('src/b.ts', 'human\n'); f.commit(T - 40 * DAY);
  await f.write('src/b.ts', 'changed\n'); f.commit(T - 37 * DAY);
  await f.write('recent.ts', 'pending\n'); f.commit(T - 2 * DAY, `AI\n\n${AI}`);
  q = new TrendQuery({ ...await replay(f.root, CONFIG, { cutoff: T, now: T + DAY }), timeZone: 'UTC' });
});
after(async () => { await f?.dispose(); });

/** 将真实 Git 统计报告包装成 Webview 状态，不模拟统计数字。 */
function state(report: TrendReport, requestId = 1, language = 'zh-cn') {
  return { type: 'state', language, requestId, snapshotId: q.snapshot.id, repoId: q.snapshot.repoId,
    status: '已更新', repositories: [{ id: q.snapshot.repoId, name: '测试仓库' }], stale: false, indexing: false,
    cutoff: T, timezone: 'UTC', ref: 'HEAD', navigationTip: q.snapshot.navigationTipOid, report };
}
/** 在 DOM 环境执行实际打包脚本并记录其对宿主发送的消息。 */
function client(report: TrendReport, saved?: unknown, language = 'zh-cn') {
  const dom = new JSDOM('<main id="app"></main>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent: any[] = [];
  let persisted = saved;
  dom.window.scrollTo = () => {};
  (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(structuredClone(message)),
    getState: () => persisted, setState: (value: unknown) => { persisted = structuredClone(value); } });
  dom.window.eval(readFileSync('media/trends.js', 'utf8'));
  /** 通过真实消息事件推送状态，以验证前端协议。 */
  const publish = (value: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: value }));
  publish(state(report, 1, language));
  return { dom, sent, publish, document: dom.window.document, saved: () => persisted };
}

test('中文、英文与未支持语言的真实趋势DOM使用同一统计结果，路径和操作身份保持原文', () => {
  const report = q.report('repo', 180), snapshot = JSON.stringify(q.snapshot);
  const reference = client(report);
  try {
    const rates = [...reference.document.querySelectorAll('.summary .metric-value')].slice(0, 2).map(n => n.textContent);
    for (const language of ['en', 'en-US', 'fr', 'ja', 'zh-tw']) {
      const ui = client(report, undefined, language);
      try {
        assert.equal(ui.document.documentElement.lang, 'en');
        assert.equal(ui.document.querySelector('h1')!.textContent, 'Rework Trends');
        assert.equal(ui.document.querySelector('[data-action="refresh"]')!.textContent, 'Refresh Index');
        assert.deepEqual([...ui.document.querySelectorAll('.summary .metric-value')].slice(0, 2).map(n => n.textContent), rates);
        const rendered = ui.document.getElementById('app')!.textContent!;
        assert.ok(rendered.includes('自定义 AI 身份'), '用户提供者名称应保留中文原文');
        const text = rendered.replaceAll('测试仓库', '').replaceAll('自定义 AI 身份', '');
        assert.equal(/[\u3400-\u9fff]/.test(text), false, (text.match(/.{0,20}[\u3400-\u9fff].{0,30}/g) ?? []).join('\n'));
        assert.equal(ui.document.querySelector('select[aria-label="Repository"] option')!.textContent, '测试仓库');
        ui.document.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
        assert.equal(ui.sent.at(-1).type, 'refresh');
        assert.equal(ui.sent.at(-1).repoId, q.snapshot.repoId);
        assert.equal(ui.sent.at(-1).snapshotId, q.snapshot.id);
        assert.equal('language' in ui.sent.at(-1), false);
        assert.equal(ui.document.querySelectorAll('img').length, 0);
      } finally { ui.dom.window.close(); }
    }
    assert.equal(reference.document.querySelector('h1')!.textContent, '返工趋势');
    assert.equal(JSON.stringify(q.snapshot), snapshot);
  } finally { reference.dom.window.close(); }
});

test('英文修改记录、来源依据、控件提示均已翻译，仓库文件名不作为翻译键', () => {
  const node = q.fileAt(path)!, report = q.report(node.id, 180), ui = client(report, undefined, 'en');
  try {
    assert.ok(ui.document.querySelector('.event')!.textContent!.includes('First deletions or replacements'));
    assert.ok(ui.document.querySelector('.event')!.textContent!.includes('Original source'));
    assert.ok(ui.document.querySelector('.event')!.textContent!.includes(path));
    const text = ui.document.getElementById('app')!.textContent!.replaceAll('测试仓库', '').replaceAll('自定义 AI 身份', '');
    assert.equal(/[\u3400-\u9fff]/.test(text), false, (text.match(/.{0,20}[\u3400-\u9fff].{0,30}/g) ?? []).join('\n'));
    for (const node of ui.document.querySelectorAll('[aria-label], [title], [placeholder]'))
      for (const attribute of ['aria-label', 'title', 'placeholder'])
        assert.equal(/[\u3400-\u9fff]/.test(node.getAttribute(attribute) ?? ''), false);
    ui.document.querySelector<HTMLButtonElement>('[data-action="diff"]')!.click();
    assert.equal(ui.sent.at(-1).type, 'diff');
    assert.equal(ui.sent.at(-1).eventId, report.events[0].id);
    assert.equal(ui.document.querySelectorAll('img').length, 0);
    const unchanged = q.report('repo', 180);
    const named = { ...unchanged, children: unchanged.children.map((child, index) => index === 0 ? { ...child, label: '刷新索引', path: '刷新索引' } : child) };
    ui.publish(state(named, 2, 'en'));
    assert.equal(ui.document.querySelector('.path-button')!.textContent, '刷新索引');
  } finally { ui.dom.window.close(); }
});

test('英文浅克隆指南保留Git命令，轻量进度不重建图表或丢失语言', () => {
  const report = q.report('repo', 90), ui = client(report, undefined, 'fr'), issue = issueForCode('shallow-clone')!;
  try {
    const chart = ui.document.querySelector('svg');
    ui.publish({ ...state(report, 1, 'fr'), type: 'status', issue, repositoryPath: '/remote/中文/{0}/<img>',
      status: issue.summary, stale: true, indexing: true });
    assert.equal(ui.document.querySelector('svg'), chart);
    assert.equal(ui.document.documentElement.lang, 'en');
    const recovery = ui.document.getElementById('repository-recovery')!;
    assert.equal(recovery.querySelector('h2')!.textContent, 'Shallow Clone: Complete the Git History First');
    assert.deepEqual([...recovery.querySelectorAll('code')].map(n => n.textContent),
      ['git remote -v', 'git fetch --unshallow', 'git rev-parse --is-shallow-repository']);
    assert.ok(recovery.textContent!.includes('/remote/中文/{0}/<img>'));
    assert.equal(ui.document.querySelectorAll('img').length, 0);
    assert.equal(ui.document.querySelector('[data-action="refresh"]')!.textContent, 'Updating…');
    ui.publish(state(report, 2, 'zh-cn'));
    assert.equal(ui.document.documentElement.lang, 'zh-cn');
    assert.equal(ui.document.querySelector('h1')!.textContent, '返工趋势');
  } finally { ui.dom.window.close(); }
});

test('完整范围先搜索排序再分页；目录后100项、文件与作者后30项仍可找到', () => {
  const seed = q.snapshot.births.find(b => b.attribution === 'ai')!;
  const entities = Array.from({ length: 150 }, (_, i) => ({ entity: `many-${i}`, path: `many/file-${i}.ts`, deleted: false, blob: 'a'.repeat(40) }));
  const snapshot = { ...q.snapshot, entities, events: [],
    births: entities.map((e, i) => ({ ...seed, id: `many-birth-${i}`, entity: e.entity, firstRewrite: undefined,
      sourceAuthor: { id: `author-${i}`, name: `作者 ${i}` } })),
    activity: entities.map((e, i) => ({ ...q.snapshot.activity![0], oid: `activity-${i}`,
      author: { id: `author-${i}`, name: `作者 ${i}` }, files: [{ entity: e.entity, added: i + 1, deleted: 0, complete: true }] })),
  };
  const many = new TrendQuery(snapshot), view = defaultView();
  const all = many.report('dir:many', 90);
  assert.equal(all.children.length, 100); assert.equal(all.totalChildren, 150);
  assert.equal(all.metrics.topFiles.length, 30); assert.equal(all.metrics.lists.contributors.total, 150);
  view.lists.directory.search = 'file-149'; view.lists.topFiles.search = 'file-149'; view.lists.contributors.search = '作者 149';
  const filtered = many.report('dir:many', 90, undefined, 100, view);
  assert.equal(filtered.children[0].entity, 'many-149'); assert.equal(filtered.matchingChildren, 1);
  assert.equal(filtered.metrics.topFiles[0].entity, 'many-149'); assert.equal(filtered.metrics.contributors[0].id, 'author-149');
  assert.deepEqual(filtered.summary, all.summary);
  assert.equal(filtered.metrics.contributorLines, all.metrics.contributorLines);
  view.lists.directory.search = ''; view.lists.directory.sort = 'name';
  const names = many.report('dir:many', 90, undefined, 100, view).children.map(r => r.label);
  assert.ok(names.indexOf('file-2.ts') < names.indexOf('file-10.ts'));
  view.lists.topFiles.search = ''; view.lists.topFiles.sort = 'added'; view.lists.topFiles.limit = 1;
  assert.equal(many.report('dir:many', 90, undefined, 100, view).metrics.topFiles[0].entity, 'many-149');
  const empty = new TrendQuery({ ...snapshot, births: [], activity: [] });
  view.lists.directory.onlySamples = true;
  const noRows = empty.report('dir:many', 90, undefined, 100, view);
  assert.equal(noRows.totalChildren, 150); assert.equal(noRows.matchingChildren, 0); assert.equal(noRows.children.length, 0);
});

test('Provider相关文件沿用互斥桶，多信号不分摊；文件入口只接受当前可见结果', () => {
  const report = q.report('repo', 90), view = defaultView();
  for (const p of report.metrics.providers) {
    view.selectedProvider = p.id;
    const filtered = q.report('repo', 90, undefined, 100, view);
    assert.equal(filtered.metrics.providerFiles.reduce((n, f) => n + f.added, 0), p.added);
    const context = { requestId: 3, repoId: q.snapshot.repoId, snapshotId: q.snapshot.id };
    for (const file of filtered.metrics.providerFiles)
      assert.ok(acceptMessage({ ...context, type: 'scope', target: `file:${file.entity}` }, context, filtered));
    assert.equal(acceptMessage({ ...context, type: 'view', view: { ...view, selectedProvider: 'forged' } }, context, filtered), undefined);
  }
  const seed = q.snapshot.births[0];
  const multi = new TrendQuery({ ...q.snapshot, births: [
    { ...seed, id: 'multi', attribution: 'ai', attributionSignals: [{ provider: 'Tool A', kind: 'coauthor-name' },
      { provider: 'Tool A', kind: 'generated-trailer' }, { provider: 'Tool B', kind: 'coauthor-name' }] },
  ] });
  view.selectedProvider = 'multiple';
  const result = multi.report('repo', 90, undefined, 100, view);
  assert.equal(result.metrics.providers.length, 1); assert.equal(result.metrics.providerFiles[0].added, 1);
});

test('周图只有一个Tab入口，方向键切周、Enter选周、Escape清除；结果紧接图表', () => {
  const report = q.report('repo', 90), ui = client(report);
  try {
    const hits = [...ui.document.querySelectorAll<SVGElement>('.week-hit')];
    assert.equal(hits.filter(h => h.getAttribute('tabindex') === '0').length, 1);
    const index = hits.findIndex(h => h.getAttribute('tabindex') === '0');
    (hits[index] as any).focus();
    hits[index].dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(ui.document.activeElement, hits[index + 1]);
    hits[index + 1].dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(ui.sent.at(-1).target, report.points[index + 1].id);
    hits[index + 1].dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ui.sent.at(-1).target, '');
    assert.equal(ui.document.querySelector('.chart-card')?.nextElementSibling?.id, 'results');
    ui.publish({ ...state(q.report('repo', 90, report.points[index + 1].id), 2), feedback: '已筛选下方结果' });
    assert.ok(ui.document.querySelector('.context-week')?.textContent?.includes('清除周筛选'));
    assert.ok(ui.document.getElementById('results')?.textContent?.includes('全期分析不变'));
    assert.equal(ui.document.getElementById('view-feedback')?.getAttribute('role'), 'status');
  } finally { ui.dom.window.close(); }
});

test('每日活动提供日期文字明细与键盘分页，KM含当地两组图例和三句解释', () => {
  const ui = client(q.report('repo', 90));
  try {
    const activity = ui.document.querySelector('details[data-persist="activity"]')!;
    assert.equal(activity.querySelectorAll('tbody tr').length, 14);
    const date = activity.querySelector<HTMLInputElement>('input[type=date]')!;
    date.value = date.min; date.dispatchEvent(new ui.dom.window.Event('change'));
    assert.equal(activity.querySelector('tbody td')?.textContent, date.min);
    const next = activity.querySelector<HTMLButtonElement>('[data-focus="daily-next"]')!;
    next.focus(); next.click();
    assert.ok(activity.querySelector('tbody td')!.textContent! > date.min);
    assert.equal(ui.document.activeElement, next);
    const survival = ui.document.querySelector('details[data-persist="survival"]')!;
    assert.equal(survival.querySelectorAll('.legend span').length, 2);
    assert.ok(survival.textContent!.includes('之后的状态仍未知'));
  } finally { ui.dom.window.close(); }
});

test('展示状态跨重绘和前端重建恢复：名称搜索、排序、展开模块及归因事件', () => {
  const report = q.report(q.fileAt(path)!.id, 90), ui = client(report);
  try {
    const filter = ui.document.querySelector<HTMLSelectElement>('[aria-label="Provider 统计筛选"]')!;
    filter.value = 'ai'; filter.dispatchEvent(new ui.dom.window.Event('change'));
    const input = ui.document.querySelector<HTMLInputElement>('[aria-label="提供者名称搜索"]')!;
    input.value = '自定义'; input.closest('form')!.dispatchEvent(new ui.dom.window.Event('submit', { cancelable: true }));
    const details = ui.document.querySelector<HTMLDetailsElement>('[data-persist="survival"]')!; details.open = true;
    const event = ui.document.querySelector<HTMLDetailsElement>('.event details')!; event.open = true;
    ui.document.querySelector<HTMLButtonElement>('[data-action=diff]')!.click();
    const saved = normalizeView(ui.saved());
    assert.ok(saved.expanded.includes('survival')); assert.ok(saved.events.includes(report.events[0].id));
    const reopened = client(report, saved);
    try {
      assert.equal(reopened.document.querySelector<HTMLSelectElement>('[aria-label="Provider 统计筛选"]')!.value, 'ai');
      assert.equal(reopened.document.querySelector<HTMLInputElement>('[aria-label="提供者名称搜索"]')!.value, '自定义');
      assert.equal(reopened.document.querySelector<HTMLDetailsElement>('[data-persist="survival"]')!.open, true);
      assert.equal(reopened.document.querySelector<HTMLDetailsElement>('.event details')!.open, true);
    } finally { reopened.dom.window.close(); }
  } finally { ui.dom.window.close(); }
});

test('局部筛选空态说明原因且可恢复，未配置与观察中样本有对应操作', () => {
  const ui = client(q.report(q.fileAt(path)!.id, 90));
  try {
    const filter = ui.document.querySelector<HTMLSelectElement>('[aria-label="Provider 统计筛选"]')!;
    filter.value = 'unknown'; filter.dispatchEvent(new ui.dom.window.Event('change'));
    const provider = ui.document.querySelector('.provider-stats')!;
    assert.ok(provider.textContent!.includes('当前提供者筛选没有匹配项'));
    assert.ok(!provider.textContent!.includes('当前范围没有新增样本'));
    [...provider.querySelectorAll('button')].find(b => b.textContent === '显示全部归因')!.click();
    assert.equal(filter.value, 'all'); assert.ok(provider.querySelector('tbody tr'));
    const unconfigured = structuredClone(q.report('repo', 90)); unconfigured.summary.configured = false; unconfigured.metrics.configured = false;
    ui.publish(state(unconfigured, 2));
    assert.ok(ui.document.querySelector('[data-action=settings]'));
    const pending = q.report(q.fileAt('recent.ts')!.id, 30); ui.publish(state(pending, 3));
    assert.ok(ui.document.querySelector('.chart-card')!.textContent!.includes('全部新增样本仍在观察'));
  } finally { ui.dom.window.close(); }
});

test('展示状态输入限制及未知字段处理，保留合法中文搜索与稳定锚点', () => {
  const view = normalizeView({ providerGroup: 'forged', providerSearch: '工具', expanded: ['files', 'files', 1],
    lists: { directory: { search: '第149个.ts', sort: 'name', limit: 120, onlySamples: true } },
    anchor: { key: 'scope:file:x', offset: 87, focus: 'button', path: '/outside' }, command: 'rm' });
  assert.equal(view.providerGroup, 'all'); assert.equal(view.providerSearch, '工具');
  assert.deepEqual(view.expanded, ['files']); assert.equal(view.lists.directory.limit, 120);
  assert.equal(view.lists.directory.search, '第149个.ts'); assert.equal(view.anchor?.offset, 87);
  assert.equal('command' in view, false); assert.equal('path' in view.anchor!, false);
});

test('真实Git→趋势DOM：两组数值、缺点不补零、近期灰区与注入文本', () => {
  const { dom, document } = client(q.report('repo', 90));
  try {
    assert.equal(document.querySelector('.metric.ai .metric-value')?.textContent, '50.0%');
    assert.equal(document.querySelector('.metric.human .metric-value')?.textContent, '33.3%');
    assert.equal(document.querySelector('.pending .metric-value')?.textContent, '1 行');
    assert.equal(document.querySelectorAll('.ai-dot').length, 1);
    assert.equal(document.querySelectorAll('.human-dot').length, 3);
    assert.equal(document.querySelectorAll('.pending-region').length, 1);
    const humanPath = document.querySelector('.human-line')!.getAttribute('d')!;
    assert.equal((humanPath.match(/M/g) ?? []).length, 2); // 不相邻周不能跨空白连接。
  } finally { dom.window.close(); }
  const file = client(q.report(q.fileAt(path)!.id, 90));
  try {
    assert.ok(file.document.body.textContent!.includes('<img src=x onerror=alert(1)>.ts'));
    assert.equal(file.document.querySelectorAll('img, script').length, 0);
    assert.ok(file.document.body.textContent!.includes('自定义 AI 身份'));
    file.document.querySelector<HTMLButtonElement>('button[data-action="diff"]')!.click();
    assert.equal(file.sent.at(-1).eventId, q.report(q.fileAt(path)!.id, 90).events[0].id);
    assert.equal(file.sent.at(-1).snapshotId, q.snapshot.id);
  } finally { file.dom.window.close(); }
});

test('合并代码的修改详情区分主线新增与原始来源，来源路径按文本显示', async () => {
  const merged = await Fixture.create();
  try {
    await merged.write('root', 'root\n'); merged.commit(T - 200 * DAY);
    merged.git(['checkout', '-b', 'feature']); await merged.write(path, 'AI\n');
    const source = merged.commit(T - 80 * DAY, `source\n\n${AI}`);
    merged.git(['checkout', 'main']); merged.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 60 * DAY);
    const main = merged.git(['rev-parse', 'HEAD']);
    await merged.write(path, 'changed\n'); merged.commit(T - 58 * DAY);
    const query = new TrendQuery(await replay(merged.root, CONFIG, { cutoff: T, now: T + DAY }));
    const ui = client(query.report(query.fileAt(path)!.id, 180));
    try {
      const details = ui.document.querySelector('.event details')!;
      assert.ok(details.textContent!.includes(`主线新增：${main.slice(0, 8)}`));
      assert.ok(details.textContent!.includes(`原始来源：${source.slice(0, 8)}`));
      assert.ok(details.textContent!.includes('合并带入'));
      assert.ok(details.textContent!.includes('<img src=x onerror=alert(1)>.ts'));
      assert.equal(ui.document.querySelectorAll('img, script').length, 0);
    } finally { ui.dom.window.close(); }
  } finally { await merged.dispose(); }
});

test('周筛选键盘消息保留全期卡片；过期状态不重绘，迟到报告不能覆盖', () => {
  const report = q.report('repo', 90), ui = client(report);
  try {
    const week = q.weekFor(T - 60 * DAY, 90)!;
    const hit = [...ui.document.querySelectorAll('.week-hit')].find(n => n.getAttribute('data-focus') === `week:${week}`)!;
    (hit as SVGElement).focus();
    hit.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(ui.sent.at(-1).type, 'week'); assert.equal(ui.sent.at(-1).target, week);
    ui.publish(state(q.report('repo', 90, week), 2));
    assert.equal(ui.document.querySelector('.metric.human .metric-value')?.textContent, '33.3%');
    assert.equal(ui.document.activeElement?.getAttribute('data-focus'), `week:${week}`);
    const chart = ui.document.querySelector('svg');
    ui.publish({ ...state(report, 2), type: 'status', status: '正在读取提交 100/200', indexing: true, stale: true });
    assert.equal(ui.document.querySelector('svg'), chart);
    assert.equal(ui.document.querySelector<HTMLButtonElement>('button[data-action="refresh"]')!.disabled, true);
    assert.equal(ui.document.getElementById('stale-notice')!.hidden, false);
    ui.publish(state(q.report('repo', 30), 1));
    assert.equal(ui.document.querySelector('svg'), chart);
    const sent = ui.sent.length, pending = ui.document.querySelector('.week-hit[role="img"]')!;
    pending.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.sent.length, sent);
  } finally { ui.dom.window.close(); }
});

test('无样本与历史缺口不显示假0%；当前位置随过期状态停用', () => {
  const noSample = client(q.report(q.fileAt('unchanged.ts')!.id, 90));
  try {
    assert.equal(noSample.document.querySelector('.metric.ai .metric-value')?.textContent, '无样本');
    assert.equal(noSample.document.querySelectorAll('.ai-dot, .human-dot').length, 0);
  } finally { noSample.dom.window.close(); }
  const report = q.report(q.fileAt(path)!.id, 90), ui = client(report);
  try {
    const current = ui.document.querySelector<HTMLButtonElement>('button[data-action="current"]')!;
    assert.equal(current.disabled, false);
    ui.publish({ ...state(report), type: 'status', stale: true });
    assert.equal(current.disabled, true);
    const gap = structuredClone(report);
    gap.summary.complete = false;
    for (const point of gap.points) point.counts.complete = false;
    ui.publish(state(gap, 2));
    assert.equal(ui.document.querySelector('.metric.ai .metric-value')?.textContent, '历史不完整');
    assert.equal(ui.document.querySelectorAll('.ai-dot').length, 0);
  } finally { ui.dom.window.close(); }
});

test('消息绑定请求、仓库、快照和可见行，拒绝跨范围diff与观察中周', () => {
  const report = q.report(q.fileAt(path)!.id, 90), context = { requestId: 5, repoId: q.snapshot.repoId, snapshotId: q.snapshot.id };
  const valid = { ...context, type: 'diff', eventId: report.events[0].id };
  assert.ok(acceptMessage(valid, context, report));
  for (const wrong of [{ requestId: 4 }, { repoId: 'other' }, { snapshotId: 'old' }, { eventId: 'forged' }])
    assert.equal(acceptMessage({ ...valid, ...wrong }, context, report), undefined);
  assert.equal(acceptMessage(valid, context, q.report('repo', 90)), undefined);
  assert.equal(acceptMessage({ ...context, type: 'week', target: report.points.find(p => !p.observed)!.id }, context, report), undefined);
  assert.equal(acceptMessage({ ...context, type: 'scope', target: '../outside' }, context, report), undefined);
  assert.equal(acceptMessage({ ...context, type: 'days', days: 999 }, context, report), undefined);
});

/** 最小宿主事件模型，仅检验控制器消息和生命周期，不代替 Trae 实测。 */
class Emitter<T = void> {
  private listeners: ((value: T) => void)[] = [];
  /** 注册监听器并返回可释放句柄。 */
  event = (fn: (value: T) => void) => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter(x => x !== fn); } }; };
  /** 同步传递受控测试事件。 */
  fire(value: T): void { for (const fn of this.listeners) fn(value); }
  /** 释放所有事件。 */
  dispose(): void { this.listeners = []; }
}
/** 在隔离 CommonJS 容器注入最小 vscode 接口，执行实际控制器代码。 */
function controller(entry: string, vscode: unknown, modules: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): any {
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'] }).outputFiles[0].text;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, process, Buffer, TextDecoder, AbortController, structuredClone,
    __dirname: process.cwd(), __filename: join(process.cwd(), entry),
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name: string) => name === 'vscode' ? vscode : modules[name] ?? require(name), ...globals });
  return module.exports;
}

test('真实扩展入口使用IDE显示语言，英文与未知语言通知回退英文', async () => {
  for (const language of ['zh-cn', 'en', 'fr']) {
    const messages: string[] = [], commands = new Map<string, () => void>();
    const vscode = { env: { language }, workspace: { isTrusted: false },
      window: { showInformationMessage: (message: string) => messages.push(message) },
      commands: { registerCommand: (id: string, action: () => void) => { commands.set(id, action); return { dispose() {} }; } } };
    const { activate } = controller('src/extension.ts', vscode);
    await activate({ subscriptions: [] });
    commands.get('codeEvolutionLens.refresh')!();
    assert.equal(messages[0], language === 'zh-cn' ? '请先信任当前工作区，再重载窗口。'
      : 'Trust the current workspace, then reload the window.');
  }
});

/** 执行真实面板控制器并保存工作区状态，隔离宿主窗口的显示行为。 */
function panelHarness(query: TrendQuery, memory = new Map<string, unknown>()) {
  const messages: any[] = [], received = new Emitter<any>(), disposed = new Emitter<void>();
  const fakePanel = { visible: true, webview: { html: '', cspSource: 'test:',
    asWebviewUri: (uri: string) => uri, onDidReceiveMessage: received.event, postMessage: (m: unknown) => messages.push(structuredClone(m)) },
    reveal: () => {}, onDidDispose: disposed.event, onDidChangeViewState: () => ({ dispose() {} }), dispose: () => disposed.fire() };
  const vscode = { EventEmitter: Emitter, Uri: { joinPath: (...parts: string[]) => parts.join('/') }, ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => fakePanel } };
  const { TrendsPanel } = controller('src/trends-panel.ts', vscode);
  const repo = { id: query.snapshot.repoId, snapshot: query.snapshot, trends: query, name: 'fixture', status: '已更新', stale: false };
  const panel = new TrendsPanel({ repos: [repo], context: { extensionUri: 'extension', workspaceState: {
    get: (key: string) => structuredClone(memory.get(key)), update: (key: string, value: unknown) => { memory.set(key, structuredClone(value)); return Promise.resolve(); },
  } } });
  panel.show(); received.fire({ type: 'ready' });
  /** 由最后一个完整状态绑定真实消息身份。 */
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    const last = [...messages].reverse().find(m => m.type === 'state');
    received.fire({ type, requestId: last.requestId, repoId: last.repoId, snapshotId: last.snapshotId, ...fields });
  };
  return { panel, repo, memory, messages, send };
}

test('宿主返回恢复来源查询与锚点，重开保存查看方式；失效文件、周与事件有回退解释', () => {
  const host = panelHarness(q), view = defaultView();
  try {
    view.lists.directory.search = 'src'; view.providerGroup = 'ai'; view.expanded = ['files'];
    view.anchor = { key: 'scope:dir:src', offset: 110, focus: 'origin-button' };
    host.send('persist', { view });
    host.send('scope', { target: 'dir:src', destination: 'results' });
    assert.equal(host.messages.at(-1).destination, 'results'); assert.equal(host.messages.at(-1).canBack, true);
    host.send('back');
    assert.equal(host.messages.at(-1).destination, 'restore'); assert.equal(host.panel.selection.scopeId, 'repo');
    assert.equal(host.messages.at(-1).view.lists.directory.search, 'src');
    assert.equal(host.messages.at(-1).view.anchor.focus, 'origin-button');
    host.panel.dispose();
    const reopened = panelHarness(q, host.memory);
    try {
      assert.equal(reopened.messages.at(-1).view.providerGroup, 'ai');
      assert.deepEqual(reopened.messages.at(-1).view.expanded, ['files']);
      reopened.send('view', { view: defaultView() });
      reopened.send('scope', { target: 'dir:src', destination: 'results' });
      reopened.send('scope', { target: 'dir:src/api', destination: 'results' });
      reopened.send('scope', { target: q.fileAt(path)!.id, destination: 'results' });
      const file = reopened.messages.at(-1), eventView = defaultView();
      eventView.events = [file.report.events[0].id, 'missing-event']; eventView.weekFocus = 'old-week';
      reopened.send('persist', { view: eventView });
      reopened.panel.selection.week = 'week-no-longer-present';
      reopened.panel.sync(true);
      assert.equal(reopened.messages.at(-1).view.events.length, 1);
      assert.equal(reopened.messages.at(-1).view.weekFocus, undefined);
      assert.ok(reopened.messages.at(-1).feedback.includes('周筛选已清除'));
      const snapshot = { ...q.snapshot, id: 'new-identity', entities: [], births: [], events: [], activity: [] };
      reopened.repo.snapshot = snapshot; reopened.repo.trends = new TrendQuery(snapshot); reopened.panel.sync();
      assert.equal(reopened.panel.selection.scopeId, 'repo');
      assert.ok(reopened.messages.at(-1).feedback.includes('已返回整个仓库'));
      assert.deepEqual(reopened.messages.at(-1).view.events, []);
    } finally { reopened.panel.dispose(); }
  } finally { host.panel.dispose(); }
});

/** 为实际标记控制器提供受控文档、两个编辑器及可延迟的核验入口。 */
function decorationHarness(verify: () => Promise<string | undefined>) {
  const report = q.report(q.fileAt(path)!.id, 90), entity = report.scope.entity!;
  const styles: any[] = [];
  const vscode = {
    ThemeColor: class { constructor(readonly id: string) {} },
    Range: class { start: { line: number }; end: { line: number };
      constructor(line: number, _a: number, end: number, _b: number) { this.start = { line }; this.end = { line: end }; } },
    MarkdownString: class { isTrusted: unknown; appendText() {} appendMarkdown() {} },
    window: { createTextEditorDecorationType: (value: any) => { const style = { ...value, dispose() {} }; styles.push(style); return style; } },
    workspace: { getConfiguration: () => ({ get: () => true }) },
  };
  const document = { uri: { toString: () => 'file:test' }, version: 1, isDirty: false };
  /** 记录每次装饰覆盖，用于核验核验期间不清空与分栏互相独立。 */
  const editor = () => ({ document, visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }],
    calls: [] as { style: any; values: any[] }[],
    setDecorations(style: any, values: any[]) { this.calls.push({ style, values }); } });
  const repo = { snapshot: q.snapshot, stale: false, trends: q,
    query: { births: new Map(q.snapshot.births.map(b => [b.id, b])), events: (id: string) => q.snapshot.events.filter(e => e.entity === id) } };
  const { Decorations } = controller('src/decorations.ts', vscode);
  const decorations = new Decorations({ repository: () => repo, verifiedDocument: verify });
  return { entity, repo, document, editor, decorations, styles };
}

test('滚动共享尚未完成核验，不清空有效标记；同文档分栏独立，失败才撤销', async () => {
  let reads = 0;
  const entity = q.fileAt(path)!.entity!;
  let resolve!: (id: string | undefined) => void;
  let result = Promise.resolve<string | undefined>(entity);
  const h = decorationHarness(() => { reads++; return result; }), first = h.editor(), second = h.editor();
  await h.decorations.update(first); assert.equal(first.calls.at(-2)!.values.length, 1);
  const before = first.calls.length;
  result = new Promise(r => { resolve = r; });
  const pending = h.decorations.update(first);
  const scrolling = Array.from({ length: 25 }, () => h.decorations.update(first, true));
  const split = h.decorations.update(second);
  assert.equal(reads, 2); assert.equal(first.calls.length, before); assert.equal(second.calls.length, 0);
  resolve(entity); await Promise.all([pending, split, ...scrolling]);
  assert.equal(first.calls.at(-2)!.values.length, 1); assert.equal(second.calls.at(-2)!.values.length, 1);
  await h.decorations.update(first, true); assert.equal(reads, 2);
  result = new Promise(r => { resolve = r; });
  const failed = [h.decorations.update(first), h.decorations.update(second)];
  resolve(undefined); await Promise.all(failed);
  assert.ok(first.calls.slice(-2).every(c => c.values.length === 0));
  assert.ok(second.calls.slice(-2).every(c => c.values.length === 0));
  assert.ok(h.styles.every(s => s.before.fontWeight === 'normal' && s.before.color.id === 'descriptionForeground'));
});

test('编辑与快照失效撤销在途标记，旧核验不能重新贴回', async () => {
  let resolve!: (id: string | undefined) => void;
  const h = decorationHarness(() => new Promise(r => { resolve = r; })), editor = h.editor();
  const pending = h.decorations.update(editor);
  h.document.version++; h.document.isDirty = true; h.decorations.clear(editor);
  resolve(h.entity); await pending; assert.ok(editor.calls.every(c => !c.values.length));
  const dirty = h.decorations.update(editor, true); await dirty; assert.ok(editor.calls.every(c => !c.values.length));
  h.document.isDirty = false; h.repo.stale = false;
  const second = h.decorations.update(editor); h.repo.stale = true; resolve(h.entity);
  await second; assert.ok(editor.calls.every(c => !c.values.length));
});

test('新指标DOM筛选与展开状态随报告保留，指标文件导航使用受控实体', () => {
  const report = q.report('repo', 90), ui = client(report);
  try {
    assert.ok(ui.document.body.textContent!.includes('Provider 统计'));
    const filter = ui.document.querySelector<HTMLSelectElement>('select[aria-label="Provider 统计筛选"]')!;
    filter.value = 'ai'; filter.dispatchEvent(new ui.dom.window.Event('change'));
    assert.equal(ui.document.querySelectorAll('.provider-stats tbody tr:not(.provider-extra)').length, 1);
    const details = ui.document.querySelector<HTMLDetailsElement>('details[data-persist="activity"]')!; details.open = true;
    ui.publish(state(q.report('repo', 180), 2));
    assert.equal(ui.document.querySelector<HTMLDetailsElement>('details[data-persist="activity"]')!.open, true);
    assert.equal(ui.document.querySelector<HTMLSelectElement>('select[aria-label="Provider 统计筛选"]')!.value, 'ai');
    const target = `file:${report.metrics.topFiles[0].entity}`, context = { requestId: 2, repoId: q.snapshot.repoId, snapshotId: q.snapshot.id };
    assert.ok(acceptMessage({ ...context, type: 'scope', target }, context, report));
    assert.equal(acceptMessage({ ...context, type: 'scope', target: 'file:forged' }, context, report), undefined);
  } finally { ui.dom.window.close(); }
});

test('宿主只读取当前provider配置，不查询旧邮箱键或生成隐式规则', () => {
  const requested: string[] = [];
  const { readConfig } = controller('src/runtime.ts', {
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => {
      requested.push(key);
      return key === 'aiEmails' ? ['ignored-bot'] : key === 'aiProviders' ? [] : fallback;
    } }) },
  });
  const config = readConfig({});
  assert.equal('aiEmails' in config, false); assert.equal(config.aiProviders.length, 0);
  assert.equal(Object.keys(config).some(key => key.startsWith('max') || key === 'useDefaultAiRules'), false);
  assert.equal(requested.includes('aiEmails'), false);
});

test('单实例面板：ready前保留选择、隐藏恢复、状态不重算、旧快照消息拒绝', () => {
  const messages: any[] = [], received = new Emitter<any>(), disposed = new Emitter<void>(), visibility = new Emitter<void>();
  let creates = 0, calculations = 0;
  const fakePanel = { visible: true, webview: { options: {}, html: '', cspSource: 'test:',
    asWebviewUri: (uri: string) => uri, onDidReceiveMessage: received.event, postMessage: (m: unknown) => messages.push(m) },
    reveal: () => {}, onDidDispose: disposed.event, onDidChangeViewState: visibility.event, dispose: () => disposed.fire() };
  const vscode = { EventEmitter: Emitter, Uri: { joinPath: (...parts: string[]) => parts.join('/') }, ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => { creates++; return fakePanel; } } };
  const { TrendsPanel } = controller('src/trends-panel.ts', vscode);
  const original = q.report.bind(q);
  const query = { nodes: q.nodes, report: (...args: Parameters<TrendQuery['report']>) => { calculations++; return original(...args); } };
  const repo = { id: q.snapshot.repoId, snapshot: q.snapshot, trends: query, name: 'fixture', status: '已更新', stale: false };
  const panel = new TrendsPanel({ repos: [repo], context: { extensionUri: 'extension', workspaceState: { get: () => undefined, update: () => Promise.resolve() } } });
  panel.select(repo.id, 'dir:src'); panel.show();
  assert.equal(creates, 1); assert.equal(messages.length, 0);
  received.fire({ type: 'ready' });
  assert.equal(messages.at(-1).report.scope.id, 'dir:src');
  const initial = messages.at(-1);
  for (let i = 0; i < 20; i++) panel.sync();
  assert.equal(calculations, 1); assert.equal(messages.at(-1).requestId, initial.requestId);
  fakePanel.visible = false; panel.select(repo.id, 'repo');
  const size = messages.length; panel.sync(); assert.equal(messages.length, size);
  fakePanel.visible = true; visibility.fire();
  assert.equal(messages.at(-1).report.scope.id, 'repo');
  received.fire({ ...initial, type: 'scope', target: 'dir:src/api' });
  assert.equal(panel.selection.scopeId, 'repo');
  const context = messages.at(-1);
  const actions: unknown[] = []; panel.action.event((action: unknown) => actions.push(action));
  repo.snapshot = { ...q.snapshot, id: 'replacement' };
  received.fire({ ...context, type: 'refresh' });
  assert.equal(actions.length, 0);
  assert.match(fakePanel.webview.html, /default-src 'none'/);
  assert.match(fakePanel.webview.html, /nonce-/);
  panel.dispose();
});

test('原生树为真实多层目录，节点点击切换曲线，分页可显式定位无样本文件', () => {
  const many = new TrendQuery({ ...q.snapshot, entities: [...q.snapshot.entities,
    ...Array.from({ length: 120 }, (_, i) => ({ entity: `extra-${i}`, path: `large/file-${String(i).padStart(3, '0')}.ts`, deleted: false, blob: 'a'.repeat(40) }))] });
  const vscode = { EventEmitter: Emitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class { constructor(public label: string, public collapsibleState: number) {} }, ThemeIcon: class { constructor(public id: string) {} } };
  const { LensTree } = controller('src/tree.ts', vscode);
  const repo = { id: q.snapshot.repoId, name: 'repo', status: '已更新', trends: many };
  const tree = new LensTree({ repos: [repo] }), root = tree.getChildren()[0];
  const src = tree.getChildren(root).find((n: any) => n.scopeId === 'dir:src');
  const api = tree.getChildren(src).find((n: any) => n.scopeId === 'dir:src/api');
  const file = tree.getChildren(api)[0];
  assert.equal(tree.getTreeItem(file).command.command, 'codeEvolutionLens.selectScope');
  assert.equal(tree.getParent(file), api);
  const large = tree.getChildren(root).find((n: any) => n.scopeId === 'dir:large');
  assert.equal(tree.getChildren(large).length, 101);
  const target = tree.findScope(repo, 'file:extra-119');
  assert.equal(tree.getChildren(target.parent).length, 120);
  assert.ok(tree.findScope(repo, q.fileAt('unchanged.ts')!.id));
  tree.dispose();
});

test('统计ref与工作树HEAD可不同：趋势仍有效，当前行定位拒绝不匹配分支', async () => {
  const config = { ...CONFIG, ref: 'main' };
  const vscode = { EventEmitter: Emitter, Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => (config as any)[key] ?? fallback }) } };
  const { Runtime } = controller('src/runtime.ts', vscode);
  const runtime = new Runtime({ storageUri: { fsPath: f.root }, asAbsolutePath: (path: string) => path });
  const repo = { id: q.snapshot.repoId, root: f.root, uri: vscode.Uri.file(f.root), name: 'fixture', config, status: '', stale: true };
  runtime.repos.push(repo);
  runtime.install(repo, { ...q.snapshot, ref: 'main', cutoff: cutoffToday(), configHash: configHash(config) });
  f.git(['checkout', '-b', 'separate-worktree-branch']);
  await f.write('other.ts', 'outside selected ref\n'); f.commit(T - DAY);
  await runtime.checkFreshness(repo);
  assert.equal(repo.stale, false);
  const document = { uri: { scheme: 'file', fsPath: `${f.root}/${path}` }, isDirty: false, getText: () => 'first\nchanged\n' };
  assert.equal(await runtime.verifiedDocument(document, (repo as any).snapshot), undefined);
  f.git(['checkout', 'main']);
  await f.write('advance.ts', 'new selected ref commit\n'); f.commit(T - DAY);
  await runtime.checkFreshness(repo);
  assert.equal(repo.stale, true);
  assert.ok((repo as any).trends.report('repo', 90)); // 原统计仍可查阅。
  runtime.dispose();
});

test('浅克隆空态展示完整步骤；状态推送、仓库切换和修复后无残留', () => {
  const ui = client(q.report('repo', 90)), issue = issueForCode('shallow-clone');
  try {
    const failure = { ...state(q.report('repo', 90), 2), report: undefined, snapshotId: '',
      status: issue!.summary, issue, repositoryPath: '/remote/<img src=x>/项目 空格' };
    ui.publish(failure);
    const recovery = ui.document.getElementById('repository-recovery')!;
    assert.equal(recovery.hidden, false);
    assert.equal(ui.document.querySelector<HTMLElement>('.empty-state')!.hidden, true);
    assert.deepEqual([...recovery.querySelectorAll('pre')].map(n => n.textContent),
      ['git remote -v', 'git fetch --unshallow', 'git rev-parse --is-shallow-repository']);
    assert.ok(recovery.textContent!.includes('false'));
    assert.ok(recovery.textContent!.includes('SSH／容器／WSL'));
    assert.equal(recovery.querySelectorAll('img').length, 0);
    recovery.querySelector<HTMLButtonElement>('[data-action="terminal"]')!.click();
    assert.equal(ui.sent.at(-1).type, 'terminal');
    assert.equal(ui.sent.at(-1).repoId, q.snapshot.repoId);
    assert.equal('command' in ui.sent.at(-1), false);
    const details = recovery.querySelector('details')!; details.open = true;
    ui.publish({ ...failure, type: 'status', indexing: true, status: '准备索引' });
    assert.equal(recovery.querySelector('details'), details);
    assert.equal(details.open, true);
    assert.equal(recovery.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.disabled, true);
    ui.publish({ ...failure, type: 'status', issue: undefined, indexing: false, status: '其他错误' });
    assert.equal(recovery.hidden, true);
    assert.equal(ui.document.querySelector<HTMLElement>('.empty-state')!.hidden, false);
    ui.publish(state(q.report('repo', 90), 3));
    const chart = ui.document.querySelector('svg')!;
    ui.publish({ ...state(q.report('repo', 90), 3), type: 'status', issue, stale: true });
    assert.equal(ui.document.querySelector('svg'), chart);
    assert.equal(ui.document.getElementById('repository-recovery')!.hidden, false);
    ui.publish({ ...state(q.report('repo', 90), 4), repoId: 'another-repository' });
    assert.equal(ui.document.getElementById('repository-recovery')!.hidden, true);
  } finally { ui.dom.window.close(); }
});

test('修复终端消息绑定当前仓库；拒绝旧请求或伪造仓库', () => {
  const context = { requestId: 3, repoId: 'known-repo', snapshotId: '' };
  assert.ok(acceptMessage({ ...context, type: 'terminal' }, context, undefined, ['known-repo']));
  assert.equal(acceptMessage({ ...context, type: 'terminal', repoId: 'forged' }, context, undefined, ['known-repo']), undefined);
  assert.equal(acceptMessage({ ...context, type: 'terminal', requestId: 2 }, context, undefined, ['known-repo']), undefined);
  assert.equal(acceptMessage({ ...context, type: 'terminal' }, context, undefined, []), undefined);
});

/** 模拟 URI 身份与路径操作；磁盘和 Git 仍使用真实临时目录。 */
class HostUri {
  /** 保存宿主身份，避免测试把远端 URI 自动降成 file。 */
  constructor(readonly scheme: string, readonly authority: string, readonly path: string) {}
  /** Node 文件操作使用宿主本机路径。 */
  get fsPath(): string { return this.path; }
  /** 创建宿主 file URI。 */
  static file(path: string): HostUri { return new HostUri('file', '', path); }
  /** 路径拼接保持原 URI 身份。 */
  static joinPath(uri: HostUri, ...parts: string[]): HostUri { return new HostUri(uri.scheme, uri.authority, join(uri.path, ...parts)); }
}

/** 为真实 Runtime 提供资源级配置，记录它是否仍使用原始远端 URI。 */
function remoteHost(root: string, directory: string, scheme = 'vscode-remote', remoteName: string | undefined = 'ssh-remote') {
  const authority = scheme === 'file' ? '' : `${remoteName}+fixture`;
  const uri = new HostUri(scheme, authority, root), resources: HostUri[] = [];
  const context = {
    storageUri: new HostUri(scheme, authority, join(directory, 'cache')),
    extensionUri: new HostUri(scheme, authority, process.cwd()), extension: { extensionKind: 2, packageJSON: { version: '0.2.1' } },
    asAbsolutePath: (path: string) => join(process.cwd(), path),
    workspaceState: { get: () => undefined, update: () => Promise.resolve() },
    subscriptions: [] as { dispose(): void }[],
  };
  const vscode = { EventEmitter: Emitter, Uri: HostUri, ExtensionKind: { UI: 1, Workspace: 2 },
    env: { remoteName: remoteName as string | undefined }, workspace: { isTrusted: true, workspaceFolders: [{ uri, name: '远端仓库' }],
      getConfiguration: (_section: string, resource: HostUri) => {
        resources.push(resource);
        return { get: (key: string, fallback: unknown) => (CONFIG as any)[key] ?? fallback };
      },
    } };
  return { context, vscode, uri, resources };
}

test('P1 宿主在取消后拒绝发布批准；批准后取消不强杀 worker，安装完成快照', async () => {
  for (const cancelBeforeApproval of [true, false]) {
    const workers: TestWorker[] = [], timers = new Set<() => void>();
    /** 提供受控消息和退出事件，验证真实 Runtime 的提交与取消协议。 */
    class TestWorker extends NodeEmitter {
      messages: string[] = [];
      terminated = false;
      /** 捕获宿主创建的 worker，不执行外部线程。 */
      constructor(_path: string, readonly options: unknown) { super(); workers.push(this); }
      /** 记录宿主对 worker 的协议指令。 */
      postMessage(message: string): void { this.messages.push(message); }
      /** 模拟强制退出，让宿主按取消结算。 */
      async terminate(): Promise<number> { this.terminated = true; this.emit('exit', 1); return 1; }
    }
    const host = remoteHost(f.root, f.root);
    const { Runtime } = controller('src/runtime.ts', host.vscode, { 'node:worker_threads': { Worker: TestWorker } }, {
      setTimeout: (fn: () => void) => { timers.add(fn); return fn; }, clearTimeout: (fn: () => void) => timers.delete(fn),
    });
    const runtime = new Runtime(host.context);
    const repo = { id: q.snapshot.repoId, root: f.root, uri: host.uri, name: 'fixture', status: '', stale: true };
    runtime.repos.push(repo);
    runtime.checkFreshness = async () => {};
    const refreshed = runtime.refresh(), worker = workers[0];
    if (cancelBeforeApproval) runtime.cancel();
    worker.emit('message', { type: 'commit-ready' });
    if (cancelBeforeApproval) {
      assert.equal(worker.messages.includes('commit'), false);
      assert.ok(worker.messages.includes('cancel'));
      for (const timer of timers) timer();
      await refreshed;
      assert.equal(worker.terminated, true);
      assert.equal(runtime.snapshots.size, 0);
    } else {
      assert.deepEqual(worker.messages, ['commit']);
      runtime.cancel(); runtime.cancel();
      assert.equal(timers.size, 0);
      assert.equal(worker.messages.includes('cancel'), false);
      worker.emit('message', { type: 'complete', snapshot: q.snapshot });
      await refreshed;
      assert.equal(worker.terminated, false);
      assert.equal(runtime.repos[0].snapshot.id, q.snapshot.id);
      assert.equal(runtime.snapshots.get(q.snapshot.id).id, q.snapshot.id);
    }
    runtime.dispose();
  }
});

test('本地与SSH／容器／WSL按执行宿主激活；拒绝本机UI误装和其他远端URI', () => {
  for (const remoteName of [undefined, 'ssh-remote', 'dev-container', 'wsl']) {
    const host = remoteHost('/repo', '/storage', remoteName ? 'vscode-remote' : 'file', remoteName);
    // undefined 默认参数需显式还原，代表普通本地窗口。
    host.vscode.env.remoteName = remoteName;
    const { activationProblem, isHostFileUri } = controller('src/host.ts', host.vscode);
    assert.equal(activationProblem(host.context), undefined);
    assert.equal(isHostFileUri(new HostUri('vscode-remote', 'ssh-remote+other', '/repo'), host.context), false);
    assert.equal(isHostFileUri(new HostUri('memfs', '', '/repo'), host.context), false);
    if (remoteName) {
      host.context.extension.extensionKind = 1;
      assert.match(activationProblem(host.context), /安装到远端/);
    }
    host.vscode.workspace.isTrusted = false;
    assert.match(activationProblem(host.context), /信任/);
  }
});

/** 注入视图和命令接口，实际激活、仓库发现和资源读取仍由生产入口执行。 */
function activationHost(host: ReturnType<typeof remoteHost>) {
  const commands = new Map<string, (...args: any[]) => any>();
  const patterns: HostUri[] = [], terminals: any[] = [], messages: any[] = [];
  const received = new Emitter<any>();
  const disposable = { dispose: () => {} };
  let tree: any, shellWrites = 0;
  const vscode = { ...host.vscode, StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: 1, Beside: 2 },
      ThemeColor: class { constructor(readonly id: string) {} },
      RelativePattern: class { constructor(readonly base: HostUri, readonly pattern: string) { patterns.push(base); } },
      commands: {
        registerCommand: (id: string, fn: (...args: any[]) => any) => { commands.set(id, fn); return disposable; },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args),
      },
      window: {
        state: { focused: false }, visibleTextEditors: [],
        createTextEditorDecorationType: () => disposable,
        createTreeView: (_id: string, options: any) => { tree = options.treeDataProvider; return { ...disposable, visible: false }; },
        createOutputChannel: () => ({ ...disposable, clear: () => {}, appendLine: () => {}, show: () => {} }),
        createStatusBarItem: () => ({ ...disposable, show: () => {} }),
        showInformationMessage: () => {}, showErrorMessage: (message: string) => assert.fail(message),
        showTextDocument: async (document: unknown) => document,
        createTerminal: (options: unknown) => {
          terminals.push(options);
          return { ...disposable, show: () => {}, sendText: () => { shellWrites++; } };
        },
        createWebviewPanel: () => ({
          ...disposable, visible: true, reveal: () => {}, onDidChangeViewState: () => disposable, onDidDispose: () => disposable,
          webview: { html: '', cspSource: 'test:', asWebviewUri: (uri: unknown) => uri,
            onDidReceiveMessage: received.event, postMessage: (message: unknown) => messages.push(message) },
        }),
        onDidChangeActiveTextEditor: () => disposable, onDidChangeVisibleTextEditors: () => disposable,
        onDidChangeTextEditorVisibleRanges: () => disposable, onDidChangeWindowState: () => disposable,
      },
      workspace: { ...host.vscode.workspace,
        /** 精确检查目录项，令 macOS 测试也能复现 Linux 的资源大小写约束。 */
        openTextDocument: async (uri: HostUri) => {
          assert.ok((await readdir(join(uri.fsPath, '..'))).includes(basename(uri.fsPath)), `资源不存在：${uri.fsPath}`);
          return { uri, getText: () => readFileSync(uri.fsPath, 'utf8') };
        },
        registerTextDocumentContentProvider: () => disposable,
        onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
        onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
        createFileSystemWatcher: () => ({ ...disposable, onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable }),
      },
  };
  return { vscode, commands, patterns, terminals, messages, received, tree: () => tree, shellWrites: () => shellWrites };
}

test('P1 中文统计口径命令兼容包内小写文档和源码文档，英文按语言选择', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-methodology-'));
  try {
    for (const filename of ['readme.md', 'README.md', 'README.en.md']) {
      await writeFile(join(directory, filename), `methodology: ${filename}`);
      const host = remoteHost(directory, directory);
      host.vscode.workspace.workspaceFolders = [];
      host.context.extensionUri = new HostUri('vscode-remote', host.uri.authority, directory);
      const harness = activationHost(host);
      Object.assign(harness.vscode.env, { language: filename === 'README.en.md' ? 'en' : 'zh-cn' });
      const shown: HostUri[] = [];
      harness.vscode.window.showTextDocument = async (document: any) => { shown.push(document.uri); return document; };
      const { activate } = controller('src/extension.ts', harness.vscode);
      try {
        await activate(host.context);
        await harness.commands.get('codeEvolutionLens.showMethodology')!();
        assert.equal(basename(shown[0].fsPath), filename);
        assert.equal(shown[0].authority, host.uri.authority);
      } finally { for (const item of host.context.subscriptions) item.dispose(); }
      await rm(join(directory, filename));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('P1 错误 provider 配置隔离单仓库，保持真实路径身份，修正后刷新恢复', async () => {
  const bad = await Fixture.create(), good = await Fixture.create();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'code-evolution-lens-config-')));
  const alias = join(directory, '工作区链接');
  const host = remoteHost(alias, directory);
  let valid = false;
  const goodUri = new HostUri(host.uri.scheme, host.uri.authority, good.root);
  host.vscode.workspace.workspaceFolders = [{ uri: host.uri, name: '配置错误' }, { uri: goodUri, name: '正常仓库' }];
  host.vscode.workspace.getConfiguration = (_section, resource) => ({
    get: (key: string, fallback: unknown) => key === 'aiProviders' && resource === host.uri && !valid
      ? [{ provider: 'Internal' }] : (CONFIG as any)[key] ?? fallback,
  });
  const harness = activationHost(host);
  Object.assign(harness.vscode.env, { language: 'zh-cn' });
  try {
    await symlink(bad.root, alias);
    for (const fixture of [bad, good]) {
      await fixture.write('a.ts', 'line\n'); fixture.commit(cutoffToday() - 30 * DAY, `birth\n\n${AI}`);
    }
    const { activate } = controller('src/extension.ts', harness.vscode);
    await activate(host.context);
    const runtime: any = host.context.subscriptions.find(item => 'repos' in item);
    assert.equal(runtime.repos.length, 2);
    const invalid = runtime.repos[0], normal = runtime.repos[1], id = invalid.id;
    assert.equal(invalid.root, bad.root);
    assert.equal(invalid.uri, host.uri);
    assert.equal(invalid.config, undefined);
    assert.match(invalid.status, /至少需要一项匹配规则/);
    await runtime.refresh();
    assert.equal(await runtime.store.load(id), undefined);
    assert.ok(normal.snapshot);
    assert.equal(normal.stale, false);
    valid = true;
    await runtime.refresh();
    assert.equal(invalid.id, id);
    assert.equal(invalid.snapshot.repoId, id);
    assert.equal(invalid.stale, false, invalid.status);
    assert.equal((await runtime.store.load(id)).id, invalid.snapshot.id);
    valid = false;
    await runtime.checkFreshness(invalid);
    assert.equal(invalid.stale, true);
    assert.match(invalid.status, /至少需要一项匹配规则/);
    assert.equal(invalid.config, undefined);
  } finally {
    for (const item of host.context.subscriptions) {
      if ('stop' in item) await (item as any).stop();
      item.dispose();
    }
    await bad.dispose(); await good.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test('真实扩展入口在远端注册视图与监听；修复终端保留仓库URI且不执行命令', async () => {
  const fixture = await Fixture.create(), directory = await mkdtemp(join(tmpdir(), 'code-evolution-lens-activation-'));
  const host = remoteHost(fixture.root, directory), harness = activationHost(host);
  const { vscode, commands, patterns, terminals, messages, received } = harness;
  try {
    await fixture.write('a.ts', 'line\n'); const oid = fixture.commit(cutoffToday() - 30 * DAY);
    await fixture.write('.git/shallow', `${oid}\n`);
    const { activate } = controller('src/extension.ts', vscode);
    await activate(host.context);
    const tree = harness.tree();
    assert.ok(tree, 'remoteName 不应阻止扩展激活');
    const root = tree.getChildren()[0];
    assert.equal(root.repo.issue.code, 'shallow-clone');
    assert.equal(patterns[0], host.uri);
    assert.match(tree.getTreeItem ? root.repo.status : '', /git fetch --unshallow/);
    await commands.get('codeEvolutionLens.selectScope')!(root);
    received.fire({ type: 'ready' });
    assert.equal(messages.at(-1).issue.code, 'shallow-clone');
    const current = messages.at(-1);
    received.fire({ ...current, type: 'terminal' });
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].cwd, host.uri);
    received.fire({ ...current, type: 'terminal', repoId: 'forged' });
    await commands.get('codeEvolutionLens.openRepositoryTerminal')!('forged');
    assert.equal(terminals.length, 1);
    assert.equal(harness.shellWrites(), 0);
  } finally {
    for (const item of host.context.subscriptions) {
      if ('stop' in item) await (item as any).stop();
      item.dispose();
    }
    await fixture.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test('真实浅克隆→worker问题码→手动补全→刷新：远端路径、SQLite、定位和缓存重载', async () => {
  const source = await Fixture.create(), directory = await realpath(await mkdtemp(join(tmpdir(), 'code-evolution-lens-remote-')));
  const clonePath = join(directory, '克隆 含空格'), alias = join(directory, '工作区链接');
  let runtime: any, restored: any;
  try {
    const cutoff = cutoffToday();
    await source.write('src/a.ts', 'old\nkeep\n'); source.commit(cutoff - 35 * DAY, `birth\n\n${AI}`);
    await source.write('src/a.ts', 'changed\nkeep\n'); source.commit(cutoff - 32 * DAY);
    source.git(['clone', '--depth=1', pathToFileURL(source.root).href, clonePath]);
    const clone = new Fixture(clonePath);
    await symlink(clonePath, alias);
    const host = remoteHost(alias, directory);
    const { Runtime } = controller('src/runtime.ts', host.vscode);
    runtime = new Runtime(host.context);
    await runtime.discover();
    const repo = runtime.repos[0], identity = repo.id;
    assert.equal(runtime.repos.length, 1);
    assert.equal(repo.root, clonePath);
    assert.equal(repo.uri, host.uri);
    assert.equal(repo.issue.code, 'shallow-clone');
    await runtime.refresh(); // 真实打包 worker 再次遇到浅克隆。
    assert.equal(repo.issue.code, 'shallow-clone');
    assert.equal(await runtime.store.load(repo.id), undefined);
    assert.equal(clone.git(['rev-parse', '--is-shallow-repository']), 'true'); // 插件未擅自 fetch。
    clone.git(['fetch', '--unshallow']); // 在测试仓库按界面命令修复。
    assert.equal(clone.git(['rev-parse', '--is-shallow-repository']), 'false');
    await runtime.refresh();
    assert.equal(repo.id, identity);
    assert.equal(repo.issue, undefined);
    assert.equal(repo.stale, false, repo.status);
    assert.equal(repo.snapshot.events.length, 1);
    assert.equal((await runtime.store.load(identity)).id, repo.snapshot.id);
    const uri = await runtime.currentUri(repo.snapshot, 'src/a.ts');
    assert.equal(uri.scheme, 'vscode-remote');
    assert.equal(uri.authority, host.uri.authority);
    assert.equal(uri.fsPath, join(alias, 'src/a.ts'));
    assert.equal(runtime.repository(uri), repo);
    assert.equal(runtime.repository(new HostUri(uri.scheme, 'ssh-remote+other', uri.path)), undefined);
    assert.equal(runtime.repository(HostUri.file(uri.path)), undefined);
    assert.equal(await runtime.currentUri(repo.snapshot, '../outside'), undefined);
    await symlink(join(source.root, 'src/a.ts'), join(clonePath, 'outside-link'));
    assert.equal(await runtime.currentUri(repo.snapshot, 'outside-link'), undefined);
    const document = { uri, isDirty: false, getText: () => 'changed\nkeep\n' };
    assert.equal(await runtime.verifiedDocument(document, repo.snapshot), repo.snapshot.files[0].entity);
    assert.equal(host.resources.every(uri => uri.scheme === host.uri.scheme && uri.authority === host.uri.authority), true);
    restored = new Runtime(host.context);
    await restored.discover();
    assert.equal(restored.repos[0].snapshot.id, repo.snapshot.id);
  } finally {
    await runtime?.stop(); runtime?.dispose();
    await restored?.stop(); restored?.dispose();
    await source.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
