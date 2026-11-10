import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { require as tsRequire } from 'tsx/cjs/api';

const { previewQuery } = tsRequire('../test/preview-fixture.ts', import.meta.url);
/** 真实缓存与测试历史共用实际前端，验证台通过环境变量选择只读数据来源。 */
async function loadQuery() {
  if (!process.env.LENS_PREVIEW_CACHE) return previewQuery();
  const { SnapshotStore } = tsRequire('../src/store.ts', import.meta.url);
  const { TrendQuery } = tsRequire('../src/trends.ts', import.meta.url);
  const { hash } = tsRequire('../src/rules.ts', import.meta.url);
  const root = await realpath(process.env.LENS_PREVIEW_ROOT);
  const snapshot = await new SnapshotStore(process.env.LENS_PREVIEW_CACHE, join(process.cwd(), 'dist/sql-wasm.wasm')).load(hash(root));
  if (!snapshot) throw new Error('真实验证缓存不存在');
  return new TrendQuery(snapshot);
}
const query = await loadQuery();
const { acceptMessage } = tsRequire('../src/presentation.ts', import.meta.url);
const { issueForCode } = tsRequire('../src/issues.ts', import.meta.url);
const { defaultView, normalizeView } = tsRequire('../src/view-state.ts', import.meta.url);
const { resolveLanguage } = tsRequire('../src/l10n.ts', import.meta.url);
const sessions = new Map();

/** 为每个浏览器标签独立保存范围，数据完全来自真实 Git 回放。 */
function session(id) {
  if (!sessions.has(id)) {
    if (sessions.size > 32) sessions.delete(sessions.keys().next().value);
    sessions.set(id, { serial: 0, scope: 'repo', days: 90, week: undefined, limit: 100, view: defaultView(), history: [] });
  }
  return sessions.get(id);
}
/** 输出浏览器当前选择对应的真实统计报告。 */
function state(current) {
  current.report = query.report(current.scope, current.days, current.week, current.limit, current.view);
  return { type: 'state', language: current.language ?? 'zh-cn', requestId: ++current.serial, repoId: query.snapshot.repoId, snapshotId: query.snapshot.id,
    repositories: [{ id: query.snapshot.repoId, name: process.env.LENS_PREVIEW_CACHE ? '本地缓存预览' : '示例仓库 · 真实 Git 测试历史' }], status: '前端验证台 · 非 IDE 宿主',
    stale: current.stale ?? false, indexing: false, report: current.report,
    cutoff: query.snapshot.cutoff, timezone: query.snapshot.timeZone, ref: query.snapshot.ref,
    navigationTip: query.snapshot.navigationTipOid, view: current.view, canBack: current.history.length > 0,
    destination: current.destination, feedback: current.feedback };
}
/** 只接受验证台消息与固定资源路径，默认监听本机地址。 */
async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1'), route = url.pathname;
  const resources = { '/trends.js': 'media/trends.js', '/trends.css': 'media/trends.css', '/fixture.js': 'test/webview-fixture.js' };
  if (resources[route]) {
    response.setHeader('Content-Type', route.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(join(process.cwd(), resources[route]))); return;
  }
  if (route === '/message' && request.method === 'POST') {
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 131072) throw new Error('Message too large'); chunks.push(chunk); }
    const message = JSON.parse(Buffer.concat(chunks).toString()), current = session(url.searchParams.get('session') ?? 'default');
    current.language = resolveLanguage(message.language ?? current.language);
    const context = { requestId: current.serial, repoId: query.snapshot.repoId, snapshotId: query.snapshot.id };
    const accepted = acceptMessage(message, context, current.report, [query.snapshot.repoId]);
    current.destination = undefined; current.feedback = undefined;
    if (accepted) {
      if (message.type === 'persist') {
        current.view = accepted.view;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'persisted' })); return;
      }
      if (message.type === 'view') { current.view = accepted.view; current.limit = current.view.lists.directory.limit; }
      if (message.type === 'scope' && current.scope !== message.target) {
        current.history.push({ scope: current.scope, days: current.days, week: current.week, view: normalizeView(current.view) });
        current.scope = message.target; current.limit = 100; current.view = defaultView();
        current.destination = message.destination ?? 'results';
      }
      if (message.type === 'back' && current.history.length) { Object.assign(current, current.history.pop()); current.limit = current.view.lists.directory.limit; current.destination = 'restore'; }
      if (message.type === 'days') { current.days = message.days; current.week = undefined; current.limit = 100; }
      if (message.type === 'week') { current.week = message.target || undefined; current.limit = 100;
        current.feedback = message.target ? '已筛选下方结果；上方汇总和全期分析保持不变。' : '周筛选已清除，下方列表恢复全部已完成观察的周。'; }
      if (message.type === 'more') current.limit += 100;
    }
    if (message.type === 'simulate-stale') current.stale = !current.stale;
    if (message.type === 'simulate-shallow') current.shallow = !current.shallow;
    response.setHeader('Content-Type', 'application/json');
    const result = state(current);
    if (current.shallow) Object.assign(result, { report: undefined, issue: issueForCode('shallow-clone'),
      repositoryPath: '/home/developer/项目 空格', status: issueForCode('shallow-clone').summary });
    response.end(JSON.stringify(result)); return;
  }
  if (route !== '/') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="${resolveLanguage(url.searchParams.get('lang') ?? 'zh-cn')}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>code-evolution-lens · 前端验证台</title><link rel="stylesheet" href="/trends.css"><style>
  :root{--vscode-editor-background:#181b22;--vscode-foreground:#dce3ed;--vscode-descriptionForeground:#a5afbf;--vscode-sideBar-background:#20242d;--vscode-button-background:#286fbb;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#303744;--vscode-widget-border:#434c5a}
  #verification{padding:10px 36px;border-bottom:1px dashed #758194;font:12px system-ui;display:flex;align-items:center;gap:12px;flex-wrap:wrap}#messages{color:#9baabb;overflow-wrap:anywhere;max-width:100%}
  </style></head><body><aside id="verification"><b>前端验证台 · 非 IDE 宿主</b><select id="theme" aria-label="验证主题"><option value="dark">深色</option><option value="light">浅色</option></select><button id="stale">模拟索引过期</button><button id="shallow">切换浅克隆状态</button><span id="messages">等待握手</span></aside><main id="app"></main><script src="/fixture.js"></script><script src="/trends.js"></script></body></html>`);
}
createServer((request, response) => { void serve(request, response).catch(error => { response.writeHead(500); response.end(error.message); }); })
  .listen(Number(process.env.LENS_PREVIEW_PORT ?? 4173), process.env.LENS_PREVIEW_HOST ?? '127.0.0.1',
    () => console.log(`Preview: port ${process.env.LENS_PREVIEW_PORT ?? 4173} · real Git report, browser UI only`));
