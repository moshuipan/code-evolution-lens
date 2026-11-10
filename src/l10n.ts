import english from '../l10n.en.json';

export type Language = 'zh-cn' | 'en';
let language: Language = 'zh-cn';
const translations: Readonly<Record<string, string>> = english;

/** 中文是源码默认语言；仅支持简体中文，其他 IDE 语言统一回退英文。 */
export function resolveLanguage(value: unknown = 'zh-cn'): Language {
  return typeof value === 'string' && value.toLowerCase().replace(/_/g, '-') === 'zh-cn' ? 'zh-cn' : 'en';
}

/** 每个运行环境独立初始化，Webview 只接受宿主传入的语言，不读取浏览器或服务器语言。 */
export function setLanguage(value?: string): Language {
  language = resolveLanguage(value);
  return language;
}

/** 返回当前界面的语言，用于文案、HTML lang 和数字日期的展示格式。 */
export function currentLanguage(): Language { return language; }

/** 替换数字占位符；参数只作为文本插入，不递归解释其中的花括号或 HTML。 */
function format(message: string, args: readonly (string | number | boolean)[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}

/** 中文文案同时作为稳定翻译键；英文词典完整性由构建检查保证。 */
export function t(message: string, ...args: (string | number | boolean)[]): string {
  return format(language === 'zh-cn' ? message : translations[message] ?? message, args);
}

/** 只翻译已知程序错误，不翻译仓库路径、作者姓名、提交正文等用户数据。 */
export function localizeError(message: string): string {
  if (language === 'zh-cn') return message;
  if (Object.hasOwn(translations, message)) return t(message);
  const context = /^([\s\S]+)（文件 ([\s\S]+)，(主线提交|提交) ([a-f0-9]{12})）$/.exec(message);
  if (context) return t(context[3] === '主线提交' ? '{0}（文件 {1}，主线提交 {2}）' : '{0}（文件 {1}，提交 {2}）',
    localizeError(context[1]), context[2], context[4]);
  const git = /^Git (\S+) 失败（退出码 (null|-?\d+)）$/.exec(message);
  if (git) return t('Git {0} 失败（退出码 {1}）', git[1], git[2]);
  const signature = /^AI 签名 (\w+) 必须为最多 64 项的非空字面字符串$/.exec(message);
  return signature ? t('AI 签名 {0} 必须为最多 64 项的非空字面字符串', signature[1]) : message;
}
