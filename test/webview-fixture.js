const session = sessionStorage.lensSession ?? Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
sessionStorage.lensSession = session;
let latest;
/** 将验证台操作发送给真实 TrendQuery；原生 diff/open 只记录，不伪装执行成功。 */
async function deliver(message) {
  document.getElementById('messages').textContent = `${message.type}${message.target ? ` · ${message.target}` : ''}`;
  const response = await fetch(`/message?session=${encodeURIComponent(session)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      ...message, language: new URLSearchParams(location.search).get('lang') ?? 'zh-cn',
    }),
  });
  const result = await response.json();
  if (result.type === 'persisted') return;
  latest = result;
  window.dispatchEvent(new MessageEvent('message', { data: latest }));
}
/** 模拟宿主消息传输接口，实际前端代码原样执行。 */
window.acquireVsCodeApi = () => ({ postMessage: message => { void deliver(message); },
  getState: () => JSON.parse(sessionStorage.lensView ?? 'null'),
  setState: value => { sessionStorage.lensView = JSON.stringify(value); } });
/** 通过可见控件验证状态更新。 */
document.getElementById('stale').onclick = () => { void deliver({ ...latest, type: 'simulate-stale', report: undefined }); };
/** 切换浅克隆空态以验证完整修复指引，不在验证台执行下载。 */
document.getElementById('shallow').onclick = () => { void deliver({ ...latest, type: 'simulate-shallow', report: undefined }); };
/** 通过宿主变量模拟浅色或深色主题，不修改产品 DOM。 */
document.getElementById('theme').onchange = event => {
  const light = event.target.value === 'light';
  for (const [key, value] of Object.entries(light ? {
    'editor-background': '#ffffff', foreground: '#242c38', descriptionForeground: '#596577',
    'sideBar-background': '#f5f7fa', 'button-secondaryBackground': '#e7ebf1', 'widget-border': '#cbd2dc',
    'charts-blue': '#1d67b8', 'charts-orange': '#a65b06',
  } : {
    'editor-background': '#181b22', foreground: '#dce3ed', descriptionForeground: '#a5afbf',
    'sideBar-background': '#20242d', 'button-secondaryBackground': '#303744', 'widget-border': '#434c5a',
    'charts-blue': '#58a6ff', 'charts-orange': '#edac65',
  })) document.documentElement.style.setProperty(`--vscode-${key}`, value);
};
