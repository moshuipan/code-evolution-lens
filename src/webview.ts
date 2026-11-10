import type { Aggregate } from './model';
import type { TrendPoint, TrendReport } from './trends';
import type { MessageContext } from './presentation';
import type { RepositoryIssue } from './issues';
import type { Fraction, MetricsReport, ChangedFile } from './metrics';
import { normalizeView, naturalCompare, ListKey, SortKey, ViewState } from './view-state';
import { t, setLanguage, currentLanguage, localizeError } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): unknown; setState?(value: unknown): void };
interface State extends MessageContext {
  type: 'state' | 'status'; report?: TrendReport; stale: boolean; indexing: boolean;
  repositories: { id: string; name: string }[]; status: string;
  cutoff?: number; timezone?: string; ref?: string; navigationTip?: string; messageMarkers?: boolean;
  issue?: RepositoryIssue; repositoryPath?: string;
  view?: ViewState; canBack?: boolean; destination?: 'results' | 'summary' | 'restore'; feedback?: string;
  language?: string;
}
const api = acquireVsCodeApi();
const app = document.getElementById('app')!;
setLanguage(document.documentElement.lang || undefined);
let state: State | undefined;
let view = normalizeView(api.getState?.());
let restoring = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let number = new Intl.NumberFormat(currentLanguage());
const listNames: Record<ListKey, string> = { directory: '目录', topFiles: '文件改动', attentionFiles: '关注文件',
  coupling: '共同修改', contributors: '来源作者', providerFiles: '提供者相关文件' };
const signalNames: Record<string, string> = { 'author-email': '作者邮箱名', 'committer-email': '提交者邮箱名',
  'coauthor-email': '协作邮箱名', 'coauthor-name': '协作名称', 'generated-trailer': '生成归因声明',
  'message-marker': '消息标记', 'subject-tag': '标题标签', 'subject-prefix': '标题前缀' };

/** 所有仓库文本使用 textContent，永不进入 HTML 或 CSS。 */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** 按当前消息身份发送动作；客户端不能指定路径、blob 或命令名。 */
function send(type: string, fields: Record<string, unknown> = {}): void {
  if (!state) return;
  if (['scope', 'repository', 'back', 'diff', 'open', 'days', 'week'].includes(type)) saveView();
  api.postMessage({ type, ...fields, requestId: state.requestId, repoId: state.repoId, snapshotId: state.snapshotId });
}
/** 按稳定行身份记录视口位置及焦点，避免下钻后恢复到无关的像素位置。 */
function captureAnchor(): void {
  const top = (document.querySelector('.range-heading')?.getBoundingClientRect().height ?? 0) + 8;
  const anchors = [...app.querySelectorAll<HTMLElement>('[data-anchor]')].filter(n => {
    const rect = n.getBoundingClientRect(); return rect.height && rect.bottom > top && rect.top < window.innerHeight;
  });
  const node = anchors.find(n => n.getBoundingClientRect().top >= top) ?? anchors.at(-1);
  if (node) view.anchor = { key: node.dataset.anchor!, offset: node.getBoundingClientRect().top,
    focus: document.activeElement?.getAttribute('data-focus') ?? undefined };
}
/** 同步保存前端和宿主的轻量展示状态，进度更新不触发此过程。 */
function saveView(capture = true): void {
  if (restoring) return;
  captureDetails();
  if (capture) captureAnchor();
  api.setState?.(view);
  if (state) api.postMessage({ type: 'persist', view, requestId: state.requestId, repoId: state.repoId, snapshotId: state.snapshotId });
}
/** 同步读取 open 属性，捕获尚未派发 toggle 的点击及即将离开的事件详情。 */
function captureDetails(): void {
  for (const node of app.querySelectorAll<HTMLDetailsElement>('details[data-persist]')) {
    const id = node.dataset.persist!;
    const event = node.closest('.event') !== null, items = event ? view.events : view.expanded;
    const next = node.open ? [...new Set([...items, id])] : items.filter(x => x !== id);
    if (event) view.events = next; else view.expanded = next;
  }
}
/** 更新查询后由宿主对完整集合搜索排序，列表分母不跟随展示过滤。 */
function queryView(): void { saveView(); send('view', { view }); }
/** 在当前位置创建可聚焦的指标解释。 */
function help(title: string, text: string): HTMLDetailsElement {
  const node = element('details', undefined, 'metric-help');
  node.append(element('summary', title), element('p', text, 'muted')); return node;
}
/** 保存可展开模块和事件说明，恢复时只接受宿主核验过的身份。 */
function persistDetails(node: HTMLDetailsElement, id: string, event = false): void {
  node.dataset.persist = id; node.dataset.focus = `expand:${id}`; node.open = (event ? view.events : view.expanded).includes(id);
  node.addEventListener('toggle', () => {
    const items = event ? view.events : view.expanded;
    if (node.open === items.includes(id)) return;
    const next = node.open ? [...items, id] : items.filter(x => x !== id);
    if (event) view.events = next; else view.expanded = next;
    saveView();
  });
}
/** 列表控件共用明确的名称与排序，搜索提交后恢复输入焦点。 */
function listControls(key: ListKey, sorts: [SortKey, string][], onlySamples = false): HTMLElement {
  const controls = element('form', undefined, 'list-controls');
  const search = element('input'); search.type = 'search'; search.value = view.lists[key].search;
  search.placeholder = key === 'contributors' ? t('搜索来源作者') : t('搜索完整范围的路径');
  search.setAttribute('aria-label', t('{0}搜索', t(listNames[key])));
  search.dataset.focus = `search:${key}`;
  const submit = element('button', t('查找')); submit.type = 'submit';
  controls.onsubmit = event => { event.preventDefault(); view.lists[key].search = search.value; view.lists[key].limit = key === 'directory' ? 100 : 30; queryView(); };
  const sort = element('select'); sort.setAttribute('aria-label', t('{0}排序', t(listNames[key]))); sort.dataset.focus = `sort:${key}`;
  for (const [value, label] of sorts) { const option = element('option', t(label)); option.value = value; option.selected = value === view.lists[key].sort; sort.append(option); }
  sort.onchange = () => { view.lists[key].sort = sort.value as SortKey; view.lists[key].limit = key === 'directory' ? 100 : 30; queryView(); };
  controls.append(search, submit, sort);
  if (onlySamples) {
    const label = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = view.lists[key].onlySamples;
    check.dataset.focus = `samples:${key}`; check.onchange = () => { view.lists[key].onlySamples = check.checked; view.lists[key].limit = 100; queryView(); };
    label.append(check, document.createTextNode(t('仅显示有样本项'))); controls.append(label);
  }
  if (view.lists[key].search || view.lists[key].onlySamples) {
    const clear = element('button', t('清除列表筛选')); clear.type = 'button';
    clear.onclick = () => { view.lists[key].search = ''; view.lists[key].onlySamples = false; queryView(); }; controls.append(clear);
  }
  return controls;
}
/** 显示筛选结果与完整规模，并从完整集合加载下一页。 */
function listPaging(key: ListKey, info: { total: number; matching: number; visible: number }): HTMLElement {
  const node = element('div', undefined, 'list-paging');
  node.append(element('p', t('显示 {0} / {1} 项 · 完整范围 {2} 项；筛选不改变统计分母。', info.visible, info.matching, info.total), 'muted'));
  if (!info.matching && info.total) node.append(element('p', t('当前列表筛选没有匹配项。清除列表筛选可恢复全部项目。'), 'empty-inline'));
  if (info.visible < info.matching) {
    const more = element('button', t('加载更多'), 'more'); more.dataset.focus = `more:${key}`;
    more.onclick = () => { view.lists[key].limit += key === 'directory' ? 100 : 30; queryView(); }; node.append(more);
  }
  return node;
}
/** 创建语义按钮，原生键盘操作与鼠标使用同一个动作。 */
function button(text: string, type: string, fields: Record<string, unknown> = {}, className = ''): HTMLButtonElement {
  const node = element('button', text, className);
  node.type = 'button'; node.dataset.action = type;
  node.dataset.focus = JSON.stringify([type, fields]);
  node.onclick = () => send(type, fields);
  return node;
}
/** 返回两组各自的比例；无样本、未配置与缺口均不产生数值点。 */
function ratio(counts: Aggregate, ai: boolean): number | undefined {
  const total = ai ? counts.ai : counts.unmarked;
  return counts.complete && counts.configured && total ? 100 * (ai ? counts.aiRewritten : counts.unmarkedRewritten) / total : undefined;
}
/** 区分无法计算与零样本，真实零返工显示 0.0%。 */
function percentage(counts: Aggregate, ai: boolean): string {
  if (!counts.configured) return t('未配置识别');
  if (!counts.complete) return t('历史不完整');
  const value = ratio(counts, ai);
  return value === undefined ? t('无样本') : `${value.toFixed(1)}%`;
}
/** 格式化计数，先给分子，再给分母，避免将百分比当作样本规模。 */
function fraction(counts: Aggregate, ai: boolean): string {
  return t('{0} / {1} 行', number.format(ai ? counts.aiRewritten : counts.unmarkedRewritten), number.format(ai ? counts.ai : counts.unmarked));
}
/** 所有展示日期使用索引时区，与按周分组保持一致。 */
function date(seconds?: number): string {
  return seconds === undefined ? '—' : new Intl.DateTimeFormat(currentLanguage(), {
    timeZone: state?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(seconds * 1000);
}
/** 更新轻量状态，保留曲线、焦点与当前筛选。 */
function renderStatus(): void {
  if (!state) return;
  renderRecovery();
  const label = document.getElementById('index-status');
  if (label) label.textContent = localizeError(state.status);
  const notice = document.getElementById('stale-notice');
  if (notice) { notice.hidden = !state.stale || !state.report; notice.textContent = t('当前展示上次索引结果。刷新后更新曲线。'); }
  for (const node of app.querySelectorAll<HTMLButtonElement>('button[data-action="refresh"]')) {
    node.disabled = state.indexing; node.textContent = state.indexing ? t('正在更新…') : t('刷新索引');
  }
  for (const node of app.querySelectorAll<HTMLButtonElement>('button[data-action="cancel"]')) node.hidden = !state.indexing;
  for (const node of app.querySelectorAll<HTMLButtonElement>('button[data-action="current"]')) {
    node.disabled = state.stale || state.indexing;
    node.title = node.disabled ? t('更新索引后可核验当前位置') : t('定位前会核验分支、磁盘和编辑器内容');
  }
}
/** 空态和保留旧快照时均展示修复步骤；状态更新不重绘曲线或重置展开状态。 */
function renderRecovery(): void {
  const container = document.getElementById('repository-recovery');
  if (!container || !state) return;
  const issue = state.issue, key = JSON.stringify([state.repoId, issue?.code, state.repositoryPath, currentLanguage()]);
  const empty = app.querySelector<HTMLElement>('.empty-state');
  if (empty) empty.hidden = !!issue;
  if (container.dataset.key === key) return;
  container.dataset.key = key; container.replaceChildren(); container.hidden = !issue;
  if (!issue) return;
  container.append(element('h2', t(issue.title)), element('p', t(issue.explanation)),
    element('p', t('仓库目录：{0}', state.repositoryPath ?? ''), 'location muted'));
  const steps = element('ol');
  for (const step of issue.steps) {
    const item = element('li', t(step.text));
    if (step.command) {
      const code = element('pre'); code.append(element('code', step.command)); item.append(code);
    }
    steps.append(item);
  }
  const actions = element('div', undefined, 'actions');
  actions.append(button(t('打开仓库终端'), 'terminal'), button(t('刷新索引'), 'refresh', {}, 'primary'));
  const details = element('details');
  details.append(element('summary', t('命令失败或仍然是浅克隆')));
  const alternatives = element('ul');
  for (const text of issue.troubleshooting) alternatives.append(element('li', t(text)));
  details.append(alternatives);
  container.append(steps, actions, details);
}
/** 展示两组全期汇总及观察中的新增行。 */
function summary(report: TrendReport): HTMLElement {
  const grid = element('section', undefined, 'summary');
  grid.setAttribute('aria-label', t('全期汇总'));
  for (const ai of [true, false]) {
    const card = element('article', undefined, `metric ${ai ? 'ai' : 'human'}`);
    card.append(element('div', ai ? t('AI 辅助代码返工率') : t('未发现 AI 标记的代码返工率'), 'metric-label'),
      element('strong', percentage(report.summary, ai), 'metric-value'),
      element('div', t('{0} · 首次删改 / 新增', fraction(report.summary, ai)), 'muted'));
    grid.append(card);
  }
  const pending = element('article', undefined, 'metric pending');
  pending.append(element('div', t('仍在观察的新增代码'), 'metric-label'),
    element('strong', t('{0} 行', number.format(report.pending)), 'metric-value'),
    element('div', report.nextReadyAt ? t('最早 {0} 后刷新可更新', date(report.nextReadyAt)) : t('最近周暂不计算最终比例'), 'muted'));
  grid.append(pending);
  return grid;
}
/** 创建 SVG 节点，仅接受固定属性和数值坐标。 */
function svg(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
}
/** 展示周明细；观察中的周解释等待原因而不展示临时百分比。 */
function weekText(point: TrendPoint): string {
  const range = `${point.startDate} — ${point.endDate}`;
  return point.observed ? t('{0} 新增的代码 · AI 辅助 {1}（{2}）· 未发现 AI 标记 {3}（{4}）· 未知 {5} 行',
    range, percentage(point.counts, true), fraction(point.counts, true), percentage(point.counts, false), fraction(point.counts, false), number.format(point.counts.unknown))
    : t('{0} · {1} 行仍在观察，{2} 后刷新可查看最终比例', range, number.format(point.pending), date(point.readyAt));
}
/** 固定 0—100% 纵轴；无样本和读取缺口中断线段，最近周显示灰区。 */
function chart(report: TrendReport): HTMLElement {
  const section = element('section', undefined, 'chart-card');
  const heading = element('div', undefined, 'section-heading');
  const title = element('div');
  title.append(element('h2', t('返工率趋势')), element('p', t('横轴按代码新增周分组 · 每行观察新增后的 14 天'), 'muted'));
  const legend = element('div', undefined, 'legend');
  legend.append(element('span', t('● AI 辅助'), 'ai'), element('span', t('◆ 未发现 AI 标记'), 'human'));
  heading.append(title, legend); section.append(heading);
  const figure = svg('svg', { viewBox: '0 0 1000 320', role: 'group', 'aria-label': t('按周返工率曲线，纵轴从 0% 到 100%。方向键切换周，Enter 筛选下方记录，Escape 清除周筛选。') });
  section.dataset.anchor = 'chart';
  const left = 56, right = 978, top = 22, bottom = 250, step = (right - left) / Math.max(1, report.points.length);
  const detail = element('p', undefined, 'week-detail'); detail.id = 'week-detail'; detail.setAttribute('aria-live', 'polite');
  const selected = report.points.find(p => p.id === report.selectedWeek);
  detail.textContent = selected ? weekText(selected) : t('将光标移到某一周查看计数；点击该周筛选下方列表。');
  for (let value = 0; value <= 100; value += 25) {
    const y = bottom - (bottom - top) * value / 100;
    figure.append(svg('line', { x1: left, y1: y, x2: right, y2: y, class: 'grid-line' }),
      svg('text', { x: left - 12, y: y + 4, 'text-anchor': 'end', class: 'axis-label' }, `${value}%`));
  }
  const firstPending = report.points.findIndex(p => !p.observed);
  if (firstPending >= 0) {
    const x = left + firstPending * step;
    figure.append(svg('rect', { x, y: top, width: right - x, height: bottom - top, class: 'pending-region' }),
      svg('text', { x: x + (right - x) / 2, y: top + 18, 'text-anchor': 'middle', class: 'axis-label' }, t('观察中')));
  }
  if (selected) {
    const index = report.points.indexOf(selected);
    figure.append(svg('rect', { x: left + index * step, y: top, width: step, height: bottom - top, class: 'selected-region' }));
  }
  for (const ai of [true, false]) {
    let path = '', connected = false;
    report.points.forEach((point, index) => {
      const value = point.observed ? ratio(point.counts, ai) : undefined;
      if (value === undefined) { connected = false; return; }
      const x = left + (index + .5) * step, y = bottom - (bottom - top) * value / 100;
      path += `${connected ? 'L' : 'M'}${x},${y} `; connected = true;
    });
    figure.append(svg('path', { d: path, class: `series ${ai ? 'ai-line' : 'human-line'}` }));
    report.points.forEach((point, index) => {
      const value = point.observed ? ratio(point.counts, ai) : undefined;
      if (value === undefined) return;
      const x = left + (index + .5) * step, y = bottom - (bottom - top) * value / 100;
      figure.append(ai ? svg('circle', { cx: x, cy: y, r: 4, class: 'ai-dot' })
        : svg('path', { d: `M${x},${y - 5}l5,5l-5,5l-5,-5Z`, class: 'human-dot' }));
    });
  }
  const activeWeek = view.weekFocus ?? report.selectedWeek ?? report.points.find(p => p.observed)?.id ?? report.points[0]?.id;
  report.points.forEach((point, index) => {
    const x = left + index * step;
    if (index % Math.max(1, Math.ceil(report.points.length / 8)) === 0 || index === report.points.length - 1)
      figure.append(svg('text', { x: x + step / 2, y: bottom + 24, 'text-anchor': 'middle', class: 'axis-label' }, point.startDate.slice(5)));
    const hit = svg('rect', { x, y: top, width: step, height: bottom - top, class: 'week-hit',
      tabindex: point.id === activeWeek ? 0 : -1, role: point.observed ? 'button' : 'img', 'aria-label': weekText(point),
      'data-focus': `week:${point.id}`,
      ...(point.observed ? { 'aria-pressed': String(point.id === report.selectedWeek) } : {}) });
    hit.append(svg('title', {}, weekText(point)));
    hit.addEventListener('mouseenter', () => { detail.textContent = weekText(point); });
    hit.addEventListener('focus', () => {
      detail.textContent = weekText(point); view.weekFocus = point.id;
      for (const other of figure.querySelectorAll('.week-hit')) other.setAttribute('tabindex', other === hit ? '0' : '-1');
      saveView();
    });
    /** 每次点击只切换下方列表的周筛选，图表与全期汇总保持不变。 */
    const choose = () => {
      if (!point.observed) return;
      (hit as SVGElement & { focus(options?: FocusOptions): void }).focus({ preventScroll: true });
      send('week', { target: point.id === report.selectedWeek ? '' : point.id });
    };
    hit.addEventListener('click', choose);
    hit.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(); }
      else if (key === 'Escape') { event.preventDefault(); send('week', { target: '' }); }
      else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
        event.preventDefault();
        const target = key === 'Home' ? 0 : key === 'End' ? report.points.length - 1
          : Math.max(0, Math.min(report.points.length - 1, index + (key === 'ArrowLeft' ? -1 : 1)));
        (figure.querySelectorAll<SVGElement>('.week-hit')[target] as SVGElement & { focus(): void }).focus();
      }
    });
    figure.append(hit);
  });
  figure.append(svg('text', { x: right, y: 310, 'text-anchor': 'end', class: 'axis-label' }, t('代码新增周')));
  section.append(figure, detail);
  if (!report.points.some(p => p.observed && (ratio(p.counts, true) !== undefined || ratio(p.counts, false) !== undefined)))
    section.append(element('p', report.pending && !report.summary.ai && !report.summary.unmarked && !report.summary.unknown
      ? t('当前范围只有观察中的代码，完成观察后才会出现曲线。')
      : t('当前范围没有可计算的样本。可选择更长的时间范围或查看其他目录。'), 'empty-inline'));
  section.append(element('p', t('方向键切换周 · Enter 选周 · Escape 清除。缺口不连线；灰区尚未完成观察。'), 'muted chart-note'));
  const result = element('button', report.selectedWeek ? t('查看本周结果') : t('查看目录与记录'));
  result.type = 'button'; result.onclick = () => document.getElementById('results')?.scrollIntoView({ block: 'start' });
  section.append(result);
  if (!report.summary.configured) section.append(button(t('打开识别设置'), 'settings'));
  else if (!report.summary.complete) section.append(element('p', t('历史读取不完整，展开上方缺口说明可查看原因。'), 'notice'));
  else if (!report.summary.ai && !report.summary.unmarked && !report.summary.unknown && report.pending)
    section.append(element('p', t('全部新增样本仍在观察，最早 {0} 后刷新。', date(report.nextReadyAt)), 'notice'));
  return section;
}
/** 表格单元格同时呈现比率和样本量。 */
function rateCell(counts: Aggregate, ai: boolean): HTMLTableCellElement {
  const cell = element('td');
  cell.append(element('div', percentage(counts, ai), ai ? 'ai' : 'human'), element('small', fraction(counts, ai), 'muted'));
  return cell;
}
/** 展示直接子节点，点击下钻使用与左树相同的范围身份。 */
function directoryList(report: TrendReport): HTMLElement {
  const wrapper = element('div', undefined, 'table-scroll'), table = element('table');
  const head = element('thead'), header = element('tr');
  for (const text of ['目录 / 文件', 'AI 辅助', '未发现 AI 标记', '返工行数', '观察中']) header.append(element('th', t(text)));
  head.append(header); table.append(head);
  const body = element('tbody');
  for (const child of report.children) {
    const row = element('tr'), name = element('td'), link = button(child.label, 'scope', { target: child.id }, 'path-button');
    row.dataset.anchor = `scope:${child.id}`;
    link.title = child.path;
    name.append(element('span', child.kind === 'directory' ? '▸ ' : '· ', 'muted'), link);
    if (child.deleted) name.append(element('small', t('已删除'), 'tag'));
    else if (child.excludedReason) name.append(element('small', t('已排除'), 'tag'));
    name.title = child.excludedReason ? localizeError(child.excludedReason) : child.path;
    row.append(name, rateCell(child.counts, true), rateCell(child.counts, false),
      element('td', number.format(child.counts.aiRewritten + child.counts.unmarkedRewritten)),
      element('td', report.selectedWeek ? '—' : number.format(child.pending)));
    body.append(row);
  }
  table.append(body); wrapper.append(table);
  if (!report.totalChildren) wrapper.append(element('p', t('此范围没有已索引的文件。'), 'empty-inline'));
  return wrapper;
}
/** 展示与分子相同的首次删改记录，并解释旧代码的归因依据。 */
function eventList(report: TrendReport): HTMLElement {
  const list = element('div', undefined, 'events');
  for (const event of report.events) {
    const row = element('article', undefined, 'event'); row.dataset.anchor = `event:${event.id}`;
    const header = element('div', undefined, 'event-heading');
    header.append(element('strong', t('{0} · {1}代码', date(event.time), event.afterCount ? t('替换') : t('删除'))),
      element('code', event.commit.slice(0, 8), 'muted'));
    const counts = element('p', t('首次删改：AI 辅助 {0} 行 · 未发现 AI 标记 {1} 行', number.format(event.ai), number.format(event.human)));
    const locations = element('p', t('{0} · 修改前第 {1} 行起 {2} 行 → {3}', event.beforePath, event.beforeStart, event.beforeCount,
      event.afterCount ? t('{0} · 修改后第 {1} 行起 {2} 行', event.afterPath ?? '', event.afterStart, event.afterCount) : t('已删除')), 'muted location');
    const actions = element('div', undefined, 'actions');
    actions.append(button(t('查看差异'), 'diff', { eventId: event.id }, 'primary'));
    if (event.current) actions.append(button(t('定位当前代码'), 'current', { eventId: event.id }));
    else actions.append(element('small', t('仅有历史位置'), 'muted'));
    const details = element('details'), explanation = element('summary', t('代码归因依据'));
    persistDetails(details, event.id, true);
    details.append(explanation);
    for (const origin of event.origins.slice(0, 20)) {
      details.append(element('p', t('主线新增：{0} · {1} · {2} 行', origin.mainlineCommit.slice(0, 8), date(origin.mainlineTime), number.format(origin.count)), 'muted'));
      details.append(element('p', t('原始来源：{0} · {1} · {2} · 第 {3} 行起{4}', origin.sourceCommit.slice(0, 8), date(origin.sourceTime), origin.sourcePath, origin.sourceLine, origin.kind === 'inherited' ? t('（合并带入）') : ''), 'muted location'));
    }
    if (event.origins.length > 20) details.append(element('p', t('另有 {0} 个来源提交，完整记录保存在索引中。', event.origins.length - 20), 'muted'));
    for (const signal of event.signals) details.append(element('p', `${signal.provider === 'AI 邮箱名（提供者不唯一）' ? t('AI 邮箱名（提供者不唯一）') : signal.provider} · ${t(signalNames[signal.kind] ?? signal.kind)}`, 'muted'));
    if (event.human) details.append(element('p', t('未发现 AI 标记：原始来源提交未命中 AI 标记，可能包含未声明的 AI 使用。'), 'muted'));
    if (event.ai) details.append(element('p', t('以上依据来自被修改代码的原始来源提交，不代表本次修改由 AI 完成。'), 'muted'));
    row.append(header, counts, locations, actions, details); list.append(row);
  }
  if (!report.totalEvents) {
    list.append(element('p', report.selectedWeek ? t('所选新增周没有 14 天内首次删改记录；清除周筛选可查看其他周。')
      : report.pending && !report.summary.ai && !report.summary.unmarked ? t('样本仍在观察，最早 {0} 后刷新。', date(report.nextReadyAt))
        : t('当前时间范围内没有新增后 14 天内的首次删改记录。可扩大日期范围查看。'), 'empty-inline'));
    if (report.selectedWeek) list.append(button(t('查看所有周的记录'), 'week', { target: '' }));
  }
  return list;
}
/** 统一展示可核验比例，保留分子分母和缺口状态。 */
function sampleRate(value: Fraction): string {
  return !value.complete ? t('历史不完整') : !value.denominator ? t('无样本')
    : `${(100 * value.numerator / value.denominator).toFixed(1)}% · ${number.format(value.numerator)} / ${number.format(value.denominator)}`;
}
/** 创建可横向滚动的语义表格，所有单元格均以文本或受控节点填充。 */
function metricTable(headers: string[], rows: (string | HTMLElement)[][], empty = '当前范围没有该项样本，可扩大日期范围查看。'): HTMLElement {
  const wrap = element('div', undefined, 'table-scroll'), table = element('table'), head = element('thead'), body = element('tbody');
  const header = element('tr'); for (const text of headers) header.append(element('th', t(text))); head.append(header);
  for (const values of rows) {
    const row = element('tr');
    for (const value of values) {
      const cell = element('td');
      if (typeof value === 'string') cell.textContent = value; else cell.append(value);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body); wrap.append(table);
  if (!rows.length && empty) wrap.append(element('p', t(empty), 'empty-inline'));
  return wrap;
}
/** 仅翻译程序生成的归因桶名称，保留自定义提供者的名称原文。 */
function providerName(provider: { id: string; name: string }): string {
  return ['unmarked', 'unknown', 'multiple', 'ambiguous'].includes(provider.id) ? t(provider.name) : provider.name;
}

/** 展示 provider 规模、成熟返工与固定年龄留存；筛选仅作用于此表。 */
function providerStats(metrics: MetricsReport): HTMLElement {
  const section = element('section', undefined, 'list-card provider-stats');
  section.dataset.anchor = 'providers';
  const heading = element('div', undefined, 'section-heading'), title = element('div');
  title.append(element('h2', t('Provider 统计')), element('p', t('全期分析 · 新增量含观察中的行，返工率只计算成熟周'), 'muted'),
    help(t('这些比例如何比较'), t('AI 组内占比使用全部 AI 新增行作为分母，搜索不会改变它。返工率使用已整周完成 14 天观察的行；固定年龄留存使用已满相应年龄的行。任务难度和样本量不同，不能据此直接做质量排名。')));
  const filter = element('select'); filter.setAttribute('aria-label', t('Provider 统计筛选')); filter.dataset.focus = 'provider-filter';
  const groups = ['all', 'ai', 'unmarked', 'unknown'];
  for (const [i, text] of ['全部归因', 'AI 提供者', '未发现 AI 标记', '归因未知'].entries()) {
    const option = element('option', t(text)); option.value = groups[i]; option.selected = view.providerGroup === option.value; filter.append(option);
  }
  const controls = element('form', undefined, 'list-controls'), search = element('input');
  search.type = 'search'; search.placeholder = t('搜索提供者或成员名称'); search.value = view.providerSearch;
  search.setAttribute('aria-label', t('提供者名称搜索')); search.dataset.focus = 'provider-search';
  const submit = element('button', t('查找')); submit.type = 'submit';
  const sort = element('select'); sort.setAttribute('aria-label', t('提供者排序')); sort.dataset.focus = 'provider-sort';
  for (const [value, label] of [['added', '新增量 ↓'], ['name', '名称'], ['rate', '返工率 ↓'], ['retained', '14 天留存 ↓']]) {
    const option = element('option', t(label)); option.value = value; option.selected = value === view.providerSort; sort.append(option);
  }
  const content = element('div');
  /** 百分比与分子分母分行展示，让核心列在普通视口内可比较。 */
  const valueNode = (value?: Fraction): HTMLElement => {
    const node = element('span', undefined, 'rate-value');
    node.append(element('span', !value ? '—' : !value.complete ? t('历史不完整') : !value.denominator ? t('无成熟样本')
      : `${(100 * value.numerator / value.denominator).toFixed(1)}%`));
    if (value) node.append(element('small', t('{0} / {1} 行', number.format(value.numerator), number.format(value.denominator)), 'muted'));
    return node;
  };
  /** 具体名称与多提供者成员同时可搜索；每条代码仍只归入一个桶。 */
  const update = () => {
    const needle = view.providerSearch.trim().toLocaleLowerCase();
    const rows = metrics.providers.filter(p => (view.providerGroup === 'all' || p.attribution === view.providerGroup)
      && (!needle || `${providerName(p)} ${p.members.join(' ')}`.toLocaleLowerCase().includes(needle))).sort((a, b) => {
      const score = (p: typeof a): number => view.providerSort === 'rate' ? p.complete && p.mature && p.attribution !== 'unknown' && metrics.configured ? p.rewritten / p.mature : -1
        : view.providerSort === 'retained' ? p.retention14.complete && p.retention14.denominator && p.attribution !== 'unknown' && metrics.configured
          ? p.retention14.numerator / p.retention14.denominator : -1 : p.added;
      return (view.providerSort === 'name' ? 0 : score(b) - score(a)) || naturalCompare(providerName(a), providerName(b));
    });
    const wrap = element('div', undefined, 'table-scroll'), table = element('table'), head = element('thead'), body = element('tbody');
    const header = element('tr');
    for (const label of ['归因 / 提供者', '新增行', 'AI 组内占比', '14 天返工率', '14 天留存']) header.append(element('th', t(label)));
    head.append(header);
    for (const p of rows) {
      const row = element('tr'); row.dataset.anchor = `provider:${p.id}`;
      const known = p.attribution !== 'unknown' && metrics.configured;
      const values = [element('strong', providerName(p)), number.format(p.added), p.aiShare === undefined ? '—' : `${(100 * p.aiShare).toFixed(1)}%`,
        valueNode(known ? { numerator: p.rewritten, denominator: p.mature, complete: p.complete } : undefined),
        valueNode(known ? p.retention14 : undefined)];
      for (const value of values) { const cell = element('td'); typeof value === 'string' ? cell.textContent = value : cell.append(value); row.append(cell); }
      const extraRow = element('tr', undefined, 'provider-extra'), cell = element('td'); cell.colSpan = 5;
      const extra = element('details'); persistDetails(extra, `provider:${p.id}`);
      extra.append(element('summary', t('{0} · 详情与相关文件', providerName(p))));
      const stats = element('div', undefined, 'provider-details');
      for (const [label, value] of [['来源提交', p.commits], ['文件数', p.files], ['活跃日', p.activeDays],
        ['30 天留存', known ? sampleRate(p.retention30) : '—'],
        ['14 天内已返工样本的中位时间', !metrics.configured || p.attribution === 'unknown' || p.medianRewriteDays === undefined || !p.complete ? '—' : t('{0} 天', p.medianRewriteDays.toFixed(2))]])
        stats.append(element('p', t('{0}：{1}', t(String(label)), value)));
      extra.append(stats);
      if (p.members.length > 1) extra.append(element('p', t('成员：{0}。该桶不向成员分摊行数。', p.members.join(currentLanguage() === 'zh-cn' ? '、' : ', ')), 'muted'));
      const related = element('button', t('查看相关文件')); related.type = 'button'; related.dataset.focus = `related:${p.id}`;
      related.onclick = () => { view.selectedProvider = p.id; view.lists.providerFiles.limit = 30;
        view.anchor = { key: 'provider-files', offset: 90 }; saveView(false); send('view', { view }); };
      extra.append(related); cell.append(extra); extraRow.append(cell); body.append(row, extraRow);
    }
    table.append(head, body); wrap.append(table);
    if (!rows.length) {
      wrap.append(element('p', metrics.providers.length ? t('当前提供者筛选没有匹配项。') : t('当前范围没有新增样本，可扩大日期范围查看。'), 'empty-inline'));
      if (metrics.providers.length) {
        const reset = element('button', t('显示全部归因')); reset.onclick = () => {
          view.providerGroup = 'all'; view.providerSearch = ''; filter.value = 'all'; search.value = ''; update(); saveView();
        }; wrap.append(reset);
      }
    }
    content.replaceChildren(wrap);
  };
  filter.onchange = () => { view.providerGroup = filter.value as ViewState['providerGroup']; update(); saveView(); };
  controls.onsubmit = event => { event.preventDefault(); view.providerSearch = search.value; update(); saveView(); };
  sort.onchange = () => { view.providerSort = sort.value as SortKey; update(); saveView(); };
  controls.append(filter, search, submit, sort);
  update(); heading.append(title); section.append(heading, controls, content,
    element('p', t('每条新增行只计入一个桶。留存是首次文本删改前的保留比例；中位时间只针对已发生的 14 天返工。'), 'muted chart-note'));
  if (!metrics.configured) section.append(element('p', t('未配置有效 AI 识别规则，归因与分组留存暂不可计算。'), 'notice'), button(t('打开识别设置'), 'settings'));
  if (view.selectedProvider) {
    const related = element('section', undefined, 'provider-files'); related.dataset.anchor = 'provider-files'; related.id = 'provider-files';
    const p = metrics.providers.find(p => p.id === view.selectedProvider);
    const close = element('button', t('关闭相关文件')); close.onclick = () => { view.selectedProvider = undefined; queryView(); };
    related.append(element('h2', t('{0} · 全期相关文件', p ? providerName(p) : '')), element('p', t('文件新增行仅包含此互斥归因桶；进入文件后可核验完整修改记录。'), 'muted'), close,
      listControls('providerFiles', [['added', '新增量 ↓'], ['rewritten', '返工量 ↓'], ['rate', '返工率 ↓'], ['name', '路径']]),
      metricTable(['文件', '该归因新增行', '14 天首次返工 / 成熟行'], metrics.providerFiles.map(f => [
        button(f.path, 'scope', { target: `file:${f.entity}`, destination: 'results' }, 'path-button'), number.format(f.added),
        p?.attribution === 'unknown' || !metrics.configured ? '—' : valueNode({ numerator: f.rewritten, denominator: f.mature, complete: f.complete }),
      ]), ''),
      listPaging('providerFiles', metrics.lists.providerFiles ?? { total: 0, matching: 0, visible: 0 }));
    section.append(related);
  }
  return section;
}
/** 将 KM 曲线与逐年龄样本数并列展示，不在最后可观察年龄之后外推。 */
function survivalStats(metrics: MetricsReport): HTMLElement {
  const details = element('details', undefined, 'list-card'); persistDetails(details, 'survival'); details.dataset.anchor = 'survival';
  details.append(element('summary', t('代码在首次修改前保留了多久')));
  details.append(element('p', t('含未观察满样本的留存估计 · Kaplan–Meier'), 'muted chart-note'),
    help(t('如何读这条曲线'), t('首次删除或替换算一次事件。尚未修改的行只证明它保留到了当前年龄，之后的状态仍未知（右删失）。曲线估计首次文本修改前的保留比例，不是缺陷率。')));
  const legend = element('div', undefined, 'legend');
  legend.append(element('span', t('● AI 辅助 · 实线'), 'ai'), element('span', t('◆ 未发现 AI 标记 · 虚线'), 'human'));
  details.append(legend);
  const figure = svg('svg', { viewBox: '0 0 1000 260', role: 'img', 'aria-label': t('从新增到首次文本删改的留存估计，包含右删失样本') });
  const max = Math.max(1, ...metrics.survival.flatMap(s => s.points.map(p => p.age)));
  const x = (age: number) => 60 + 910 * age / max, y = (survival: number) => 205 - 175 * survival;
  for (const pct of [0, 25, 50, 75, 100]) {
    figure.append(svg('line', { x1: 60, x2: 970, y1: y(pct / 100), y2: y(pct / 100), class: 'grid-line' }),
      svg('text', { x: 50, y: y(pct / 100) + 4, 'text-anchor': 'end', class: 'axis-label' }, `${pct}%`));
  }
  for (let i = 0; i <= 4; i++) figure.append(svg('text', { x: x(max * i / 4), y: 232, 'text-anchor': 'middle', class: 'axis-label' }, t('{0} 天', (max * i / 4).toFixed(0))));
  const rows: string[][] = [];
  for (const series of metrics.survival) {
    let path = '';
    for (const [i, p] of series.points.entries()) path += i ? ` H${x(p.age)} V${y(p.survival)}` : `M${x(p.age)} ${y(p.survival)}`;
    if (path) figure.append(svg('path', { d: path, class: `series ${series.attribution === 'ai' ? 'ai-line' : 'human-line'} km-series` }));
    const name = series.attribution === 'ai' ? t('AI 辅助') : t('未发现 AI 标记');
    details.append(element('p', t('{0}：{1} 行可观察样本，{2} 行因缺口排除。', name, number.format(series.samples), number.format(series.excluded)), 'muted chart-note'));
    for (const age of [0, 1, 3, 7, 14, 30, 60, 90, 180]) {
      const p = series.points.find(p => p.age === age);
      if (p) rows.push([name, t('{0} 天', age), `${(100 * p.survival).toFixed(1)}%`, number.format(p.atRisk), number.format(p.events), number.format(p.censored)]);
    }
  }
  if (metrics.survival.some(s => s.points.length)) details.append(figure);
  else details.append(element('p', t('没有可估计的分组样本。'), 'empty-inline'));
  details.append(metricTable(['组别', '年龄', '留存估计', '该年龄仍在观察', '累计删改', '累计删失'], rows));
  return details;
}
/** 显示文本改动、提交节奏与标题声明；活动区间不解释为工时。 */
function activityStats(metrics: MetricsReport): HTMLElement {
  const section = element('details', undefined, 'list-card'); persistDetails(section, 'activity'); section.dataset.anchor = 'activity';
  section.append(element('summary', t('改动与活跃度')));
  const a = metrics.activity;
  if (!a.available) { section.append(element('p', t('旧索引缺少提交汇总，请刷新索引。'), 'notice')); return section; }
  if (!a.complete) section.append(element('p', t('部分文本不可解析，增删量只包含已核验部分。'), 'notice'));
  const grid = element('div', undefined, 'activity-grid');
  const values = [
    ['文本改动量', t('{0} 行', number.format(a.added + a.deleted)), `+${number.format(a.added)} / −${number.format(a.deleted)}`],
    ['主线提交', number.format(a.commits), t('{0} 个合并 · {1} 次 / 日历天', a.merges, a.commitsPerDay.toFixed(2))],
    ['改动文件', number.format(a.files), t('{0} 个 / 提交', a.averageFiles.toFixed(1))],
    ['文件重复编辑率', a.files ? `${(100 * a.repeatedFiles / a.files).toFixed(1)}%` : t('无样本'), t('{0} / {1} 个文件被至少 2 次修改', a.repeatedFiles, a.files)],
    ['活跃日 / 活动区间', `${a.activeDays} / ${a.sessions}`, '同作者相邻提交间隔 ≤ 90 分钟'],
    ['修复 / 回滚标题', `${a.fixTitles} / ${a.revertTitles}`, '明确标题声明，不是已确认缺陷数'],
  ];
  for (const [label, value, note] of values) {
    const card = element('article'); card.append(element('div', t(label), 'muted'), element('strong', value), element('small', t(note), 'muted')); grid.append(card);
  }
  section.append(grid, element('p', t('峰值日：{0}。合并仓库中的节奏主要反映主线整合。', a.peakDay ? t('{0} · {1} 次提交', a.peakDay.date, a.peakDay.commits) : t('无提交')), 'muted chart-note'));
  const figure = svg('svg', { viewBox: '0 0 1000 160', role: 'group', 'aria-label': t('每日主线提交次数') });
  const max = Math.max(1, ...a.daily.map(d => d.commits)), step = 920 / Math.max(1, a.daily.length);
  for (const [i, day] of a.daily.entries()) {
    const bar = svg('rect', { x: 55 + i * step, y: 125 - 105 * day.commits / max, width: Math.max(1, step - 1),
      height: Math.max(1, 105 * day.commits / max), class: 'activity-bar' });
    bar.append(svg('title', {}, t('{0} · {1} 次提交 · +{2} / −{3} 行', day.date, day.commits, day.added, day.deleted))); figure.append(bar);
  }
  figure.append(svg('text', { x: 55, y: 150, class: 'axis-label' }, a.daily[0]?.date ?? ''),
    svg('text', { x: 975, y: 150, 'text-anchor': 'end', class: 'axis-label' }, a.daily.at(-1)?.date ?? ''),
    svg('text', { x: 45, y: 25, 'text-anchor': 'end', class: 'axis-label' }, t('{0} 次', max)));
  section.append(figure, element('p', t('增删量包含窗外旧行的删除；追加也算文件编辑。活动区间不是实际工作时长。'), 'muted chart-note'));
  const daily = element('section'), controls = element('div', undefined, 'list-controls');
  const choose = element('input'); choose.type = 'date'; choose.min = a.daily[0]?.date ?? ''; choose.max = a.daily.at(-1)?.date ?? '';
  choose.setAttribute('aria-label', t('每日活动起始日期')); choose.dataset.focus = 'daily-date';
  const content = element('div'); content.setAttribute('aria-live', 'polite');
  let start = view.dailyDate ? Math.max(0, a.daily.findIndex(d => d.date === view.dailyDate)) : Math.max(0, a.daily.length - 14);
  const previous = element('button', t('前 14 天')), next = element('button', t('后 14 天'));
  previous.dataset.focus = 'daily-previous'; next.dataset.focus = 'daily-next';
  /** 逐日文字明细含无提交日，日期输入和分页按钮支持原生键盘操作。 */
  const updateDaily = () => {
    choose.value = a.daily[start]?.date ?? ''; previous.disabled = start === 0; next.disabled = start + 14 >= a.daily.length;
    content.replaceChildren(metricTable(['日期', '主线提交', '新增行', '删除行'], a.daily.slice(start, start + 14)
      .map(d => [d.date, number.format(d.commits), number.format(d.added), number.format(d.deleted)])));
    view.dailyDate = a.daily[start]?.date; saveView();
  };
  previous.onclick = () => { start = Math.max(0, start - 14); updateDaily(); };
  next.onclick = () => { start = Math.min(a.daily.length - 1, start + 14); updateDaily(); };
  choose.onchange = () => { const index = a.daily.findIndex(d => d.date === choose.value); if (index >= 0) { start = index; updateDaily(); } };
  controls.append(previous, choose, next); daily.append(element('h2', t('每日文字明细')), controls, content); updateDaily(); section.append(daily);
  return section;
}
/** 文件导航始终引用已注册的实体身份，不使用路径作为宿主动作参数。 */
function changedFiles(files: ChangedFile[]): HTMLElement {
  return metricTable(['文件', '新增 / 删除', '主线提交 / 参与作者', '14 天首次返工 / 成熟行'], files.map(f => [
    button(f.path, 'scope', { target: `file:${f.entity}`, destination: 'results' }, 'path-button'),
    `+${number.format(f.added)} / −${number.format(f.deleted)}`, `${f.commits} / ${f.authors}`,
    f.complete ? `${number.format(f.rewritten)} / ${number.format(f.mature)}` : t('历史不完整'),
  ]), '');
}
/** 展示共同修改与近期文本贡献集中度，允许下钻改动文件核验。 */
function fileStats(metrics: MetricsReport): HTMLElement {
  const section = element('details', undefined, 'list-card'); persistDetails(section, 'files'); section.dataset.anchor = 'files';
  /** 每个统计列表独立查询与分页，完整数量由宿主提供。 */
  const list = (key: ListKey, title: string, table: HTMLElement, empty: string): HTMLElement => {
    const group = element('section', undefined, 'metric-list'); group.dataset.anchor = key;
    const info = metrics.lists[key] ?? { total: (metrics[key as keyof MetricsReport] as unknown[]).length,
      matching: (metrics[key as keyof MetricsReport] as unknown[]).length, visible: (metrics[key as keyof MetricsReport] as unknown[]).length };
    group.append(element('h2', t(title)), listControls(key, key === 'contributors'
      ? [['added', '新增量 ↓'], ['retained', '仍保留行 ↓'], ['name', '作者名称']]
      : key === 'coupling' ? [['commits', '共同提交 ↓'], ['ratio', '共同修改比例 ↓'], ['name', '路径']]
        : [['churn', '总改动量 ↓'], ['added', '新增量 ↓'], ['rewritten', '返工量 ↓'], ['rate', '返工率 ↓'], ['name', '路径']]),
    table, listPaging(key, info));
    if (!info.total) group.append(element('p', t(empty), 'empty-inline'));
    return group;
  };
  section.append(element('summary', t('文件改动、共同修改与贡献集中度')),
    list('topFiles', '文件改动', changedFiles(metrics.topFiles), '此范围没有已核验的主线文件改动，可扩大日期范围查看。'));
  section.append(list('coupling', '共同修改文件 · 至少 3 次', metricTable(['文件 A', '文件 B', '共同提交', '共同修改比例'], metrics.coupling.map(p => [
    button(p.left, 'scope', { target: `file:${p.leftEntity}`, destination: 'results' }, 'path-button'),
    button(p.right, 'scope', { target: `file:${p.rightEntity}`, destination: 'results' }, 'path-button'), number.format(p.commits), `${(100 * p.ratio).toFixed(1)}%`,
  ]), ''), '没有文件对达到至少 3 次可用共同提交。可扩大日期范围查看。'));
  section.append(element('p', t('比例 = 共同提交 / 两文件中较少的可用改动提交。已排除 {0} 个超过 100 文件或文本不完整的提交，分母同步排除。', metrics.couplingSkipped), 'muted chart-note'));
  section.append(list('contributors', '近期贡献集中度 · 新增代码的来源作者', metricTable(['来源作者', '新增行', '截至索引截止仍保留行', '文件数'], metrics.contributors.map(c => [
    c.name, number.format(c.added), number.format(c.retained), number.format(c.files),
  ]), ''), '当前范围没有可核验的新增代码来源作者，来源不明的行仍列入下方计数。'));
  section.append(element('p', t('最大来源作者占比：{0}\n    · 已确认来源作者 {1} 行 · 来源不明 {2} 行。留存数仅包含历史可核验的行。',
    metrics.largestContributorShare === undefined ? t('无样本') : `${(100 * metrics.largestContributorShare).toFixed(1)}%`,
    number.format(metrics.contributorLines), number.format(metrics.unidentifiedAuthorLines)), 'muted chart-note'),
    element('p', t('作者与 AI provider 是不同维度；近期文本归属不能等同仓库所有权或人员替代难度。'), 'muted chart-note'),
    list('attentionFiles', '关注文件 · 改动量达到中位数且参与作者只有一位', changedFiles(metrics.attentionFiles), '没有文件同时满足改动量与单作者条件，这不代表整个范围没有改动。'),
    element('p', t('参与作者合并主线提交作者与可核验来源作者。此列表供审查排查，不代表缺陷或风险结论。'), 'muted chart-note'));
  return section;
}
/** 重绘完整报告；轻量进度不经过此函数，避免闪烁和重复统计。 */
function render(): void {
  if (!state) return;
  const previousScroll = window.scrollY;
  const focused = state.destination === 'restore' ? view.anchor?.focus : document.activeElement?.getAttribute('data-focus');
  restoring = true;
  app.replaceChildren();
  const toolbar = element('header', undefined, 'toolbar');
  const brand = element('div');
  brand.append(element('div', 'code-evolution-lens', 'eyebrow'), element('h1', t('返工趋势')));
  const controls = element('div', undefined, 'controls');
  const repositories = element('select'); repositories.setAttribute('aria-label', t('仓库')); repositories.dataset.focus = 'repository';
  for (const repo of state.repositories) {
    const option = element('option', repo.name); option.value = repo.id; option.selected = repo.id === state.repoId; repositories.append(option);
  }
  repositories.onchange = () => send('repository', { target: repositories.value });
  controls.append(repositories, button(t('刷新索引'), 'refresh', {}, 'primary'), button(t('取消'), 'cancel'), button(t('统计口径'), 'methodology'));
  toolbar.append(brand, controls); app.append(toolbar);
  const statusLine = element('div', undefined, 'status-line'), label = element('span', localizeError(state.status));
  label.id = 'index-status'; label.setAttribute('role', 'status');
  statusLine.append(label);
  if (state.cutoff !== undefined) statusLine.append(element('span', t('索引截止 {0} 00:00 · {1} · {2} @ {3}', date(state.cutoff), state.timezone ?? '', state.ref ?? '', state.navigationTip?.slice(0, 8) ?? ''), 'muted'));
  const stale = element('p', undefined, 'notice'); stale.id = 'stale-notice';
  const recovery = element('section', undefined, 'recovery-card');
  recovery.id = 'repository-recovery'; recovery.setAttribute('aria-label', t('仓库问题解决步骤')); recovery.hidden = true;
  app.append(statusLine, stale, recovery);
  const report = state.report;
  if (!report) {
    const empty = element('section', undefined, 'empty-state');
    empty.append(element('div', '↗', 'empty-icon'), element('h2', t('从整个仓库看起')),
      element('p', t('刷新索引后，查看 AI 辅助与未发现 AI 标记的代码返工率，再逐层进入目录和文件。'), 'muted'),
      button(t('刷新索引'), 'refresh', {}, 'primary'));
    app.append(empty); renderStatus(); restoring = false; return;
  }
  const range = element('section', undefined, 'range-heading'), crumbs = element('nav', undefined, 'crumbs');
  crumbs.setAttribute('aria-label', t('当前统计范围'));
  if (state.canBack) crumbs.append(button(t('返回上次查看'), 'back'));
  for (const [index, node] of report.crumbs.entries()) {
    if (index) crumbs.append(element('span', '/', 'muted'));
    const link = button(node.kind === 'repository' ? t('整个仓库') : node.label, 'scope', { target: node.id, destination: 'results' });
    if (node.id === report.scope.id) link.setAttribute('aria-current', 'location');
    link.title = node.path || t('整个仓库'); crumbs.append(link);
  }
  const days = element('div', undefined, 'days'); days.setAttribute('aria-label', t('统计时间范围'));
  for (const value of [30, 90, 180]) {
    const control = button(t('近 {0} 天', value), 'days', { days: value });
    control.setAttribute('aria-pressed', String(value === report.days)); days.append(control);
  }
  const weekFilter = element('div', undefined, 'context-week');
  if (report.selectedWeek) weekFilter.append(element('span', t('新增周 {0}', report.selectedWeek)), button(t('清除周筛选'), 'week', { target: '' }));
  else weekFilter.append(element('span', t('全部新增周'), 'muted'));
  range.append(crumbs, days, weekFilter); app.append(range);
  const feedback = element('p', localizeError(state.feedback ?? ''), 'view-feedback'); feedback.id = 'view-feedback';
  feedback.setAttribute('role', 'status'); feedback.hidden = !state.feedback; app.append(feedback);
  app.append(element('p', t('{0} — {1} 新增的代码 · 全期汇总仅包含已完成观察的周{2}', report.rangeStart ?? '', report.rangeEnd ?? '',
    report.observedEnd ? t('（截至 {0}）', report.observedEnd) : ''), 'muted'));
  const cards = summary(report); cards.dataset.anchor = 'summary'; cards.id = 'scope-summary'; app.append(cards);
  app.append(help(t('归因说明 · 未知 {0} 行', number.format(report.summary.unknown)), t('AI 辅助组由 Git 留下的归因证据识别。未发现 AI 标记的组可能包含未声明的 AI 使用，不能确认完全由人编写。归因未知的行不计入两组比例。')));
  if (state.messageMarkers) app.append(element('p', t('已启用提交正文与标题的启发式 AI 识别。'), 'notice'));
  if (report.notices.length) {
    const notices = element('details', undefined, 'notice');
    persistDetails(notices, 'notices');
    notices.append(element('summary', t('部分历史无法读取 · {0} 项说明', report.notices.length)));
    for (const text of report.notices) notices.append(element('p', localizeError(text)));
    app.append(notices);
  }
  if (report.scope.excludedReason) app.append(element('p', t('文件排除说明：{0}', localizeError(report.scope.excludedReason)), 'notice'));
  app.append(chart(report));
  const section = element('section', undefined, 'list-card'), heading = element('div', undefined, 'section-heading');
  section.id = 'results'; section.dataset.anchor = 'results';
  const title = element('div'), total = report.scope.kind === 'file' ? report.totalEvents : report.totalChildren;
  title.append(element('h2', t('{0} · {1}', report.scope.kind === 'file' ? t('修改记录') : t('目录与文件'), number.format(total))),
    element('p', report.selectedWeek ? t('仅查看 {0} 这一周；上方汇总及下方全期分析不变。', report.selectedWeek) : t('全部已完成观察的周'), 'muted'));
  const actions = element('div', undefined, 'actions');
  if (report.selectedWeek) actions.append(button(t('清除周筛选'), 'week', { target: '' }));
  if (report.scope.kind === 'file' && !report.scope.deleted) actions.append(button(t('打开文件'), 'open'));
  heading.append(title, actions); section.append(heading);
  if (report.scope.kind !== 'file') section.append(listControls('directory', [['rewritten', '返工量 ↓'], ['added', '新增量 ↓'], ['rate', '返工率 ↓'], ['name', '路径']], true));
  section.append(report.scope.kind === 'file' ? eventList(report) : directoryList(report));
  const visible = report.scope.kind === 'file' ? report.events.length : report.children.length;
  if (report.scope.kind !== 'file') section.append(listPaging('directory', { total: report.totalChildren, matching: report.matchingChildren ?? report.totalChildren, visible }));
  else if (visible < total) section.append(button(t('加载更多（已显示 {0} / {1}）', visible, total), 'more', {}, 'more'));
  app.append(section, providerStats(report.metrics), survivalStats(report.metrics), activityStats(report.metrics), fileStats(report.metrics),
    element('footer', t('返工率 = 新增后 14 天内首次被删除或替换的非空行 ÷ 新增非空行。按 Git 主线文本变化统计，比例不等同于缺陷率。'), 'muted'));
  renderStatus();
  for (const node of app.querySelectorAll<HTMLDetailsElement>('details[data-persist]')) {
    const summary = node.querySelector('summary');
    if (summary) { summary.dataset.focus = node.dataset.focus; delete node.dataset.focus; }
  }
  let anchor = view.anchor ? [...app.querySelectorAll<HTMLElement>('[data-anchor]')].find(n => n.dataset.anchor === view.anchor!.key) : undefined;
  if (state.destination === 'results') { anchor = section; section.tabIndex = -1; section.focus({ preventScroll: true }); }
  else if (state.destination === 'summary') { anchor = cards; cards.tabIndex = -1; cards.focus({ preventScroll: true }); }
  else if (focused) [...app.querySelectorAll<HTMLElement>('[data-focus]')].find(n => n.dataset.focus === focused)?.focus({ preventScroll: true });
  if (typeof window.scrollTo === 'function') {
    const offset = state.destination && state.destination !== 'restore' ? (range.getBoundingClientRect().height + 12) : view.anchor?.offset ?? 0;
    window.scrollTo(0, anchor ? Math.max(0, window.scrollY + anchor.getBoundingClientRect().top - offset) : previousScroll);
  }
  restoring = false; api.setState?.(view);
}
/** 只接受递增完整状态；轻量状态必须属于同一请求和快照。 */
window.addEventListener('message', (event: MessageEvent<State>) => {
  const next = event.data;
  if (!next || !Number.isInteger(next.requestId)) return;
  if (next.type === 'status') {
    if (!state || next.requestId !== state.requestId || next.repoId !== state.repoId || next.snapshotId !== state.snapshotId) return;
    state = { ...state, status: next.status, stale: next.stale, indexing: next.indexing,
      issue: next.issue, repositoryPath: next.repositoryPath }; renderStatus(); return;
  }
  if (next.type !== 'state' || (state && next.requestId <= state.requestId)) return;
  if (state && !next.destination) { captureAnchor(); captureDetails(); }
  if (next.view) view = normalizeView(next.view);
  setLanguage(next.language);
  document.documentElement.lang = currentLanguage();
  number = new Intl.NumberFormat(currentLanguage());
  state = next; render();
});
/** 滚动仅保存锚点，不触发完整报告或任何索引任务。 */
window.addEventListener('scroll', () => {
  if (restoring) return;
  clearTimeout(persistTimer); persistTimer = setTimeout(() => saveView(), 120);
}, { passive: true });
api.postMessage({ type: 'ready', view });
