import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';

const displayFields = new Set(['title', 'name', 'description', 'markdownDescription', 'label']);
const dataFields = new Set(['default', 'examples', 'body']);
const errorTemplates = new Set([
  'Git {0} 失败（退出码 {1}）', 'AI 签名 {0} 必须为最多 64 项的非空字面字符串',
  '{0}（文件 {1}，提交 {2}）', '{0}（文件 {1}，主线提交 {2}）',
]);

/** 只解析清单的展示字段，保持默认规则、示例值、命令 ID 和配置键不变。 */
export function localizeManifest(value, bundle) {
  if (Array.isArray(value)) return value.map(item => localizeManifest(item, bundle));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (dataFields.has(key)) return [key, child];
    const match = displayFields.has(key) && typeof child === 'string' ? /^%([^%]+)%$/.exec(child) : undefined;
    if (match) {
      if (!Object.hasOwn(bundle, match[1])) throw new Error(`清单翻译缺失：${match[1]}`);
      return [key, bundle[match[1]]];
    }
    return [key, localizeManifest(child, bundle)];
  }));
}

/** 翻译必须保留相同的数字占位符，允许调整顺序但不允许删除、增加或重复参数。 */
function placeholders(message) { return (message.match(/\{\d+\}/g) ?? []).sort().join(','); }

/** 检查双语清单、源码文案与参数覆盖，阻止不完整英文翻译进入安装包。 */
export async function verifyLocalization(manifest) {
  /** 从项目根目录读取源词典，不依赖构建命令的工作目录。 */
  const load = async file => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  const [english, chinese, messages] = await Promise.all([
    load('package.nls.json'), load('package.nls.zh-cn.json'), load('l10n.en.json'),
  ]);
  if (Object.keys(english).sort().join('\n') !== Object.keys(chinese).sort().join('\n'))
    throw new Error('清单的中英文翻译键不一致');
  for (const bundle of [english, chinese]) localizeManifest(manifest, bundle);
  for (const [source, translation] of Object.entries(messages)) {
    if (typeof translation !== 'string' || !translation.trim() || placeholders(source) !== placeholders(translation))
      throw new Error(`英文翻译为空或占位符不一致：${source}`);
  }
  for (const file of (await readdir(new URL('../src/', import.meta.url))).filter(file => file.endsWith('.ts') && file !== 'l10n.ts')) {
    const code = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    /** AST 检查忽略注释，动态仓库数据不作为翻译键提取。 */
    function visit(node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[\u3400-\u9fff]/.test(node.text)
        && !Object.hasOwn(messages, node.text)) throw new Error(`${file} 的中文文案缺少英文翻译：${node.text}`);
      if (ts.isTemplateExpression(node) && /[\u3400-\u9fff]/.test(node.head.text + node.templateSpans.map(span => span.literal.text).join(''))) {
        const message = node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join('');
        // 只允许已经被展示层显式解析的错误模板，不能按文件名放行新增的未翻译文案。
        if (!errorTemplates.has(message) || !Object.hasOwn(messages, message))
          throw new Error(`${file} 的动态文案需要改为翻译占位符：${node.getText(source)}`);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0];
        if (key && ts.isStringLiteral(key) && !Object.hasOwn(messages, key.text)) throw new Error(`${file} 的翻译键缺失：${key.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { english, chinese };
}
