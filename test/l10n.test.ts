import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import manifest from '../package.json';
import english from '../l10n.en.json';
import { currentLanguage, localizeError, resolveLanguage, setLanguage, t } from '../src/l10n';
import { DEFAULT_CONFIG } from '../src/model';
import { configHash } from '../src/rules';

afterEach(() => setLanguage());

test('中文为源码默认文案；英文与未支持语言使用英文，语言选择不依赖操作系统', () => {
  assert.equal(currentLanguage(), 'zh-cn');
  assert.equal(t('刷新索引'), '刷新索引');
  for (const value of ['zh-cn', 'ZH-CN', 'zh_CN']) assert.equal(resolveLanguage(value), 'zh-cn');
  for (const value of ['en', 'en-US', 'en-GB', 'fr', 'de', 'ja', 'zh-tw', 'zh', '', null, 42]) {
    assert.equal(resolveLanguage(value), 'en', String(value));
  }
  for (const value of ['en', 'en-US', 'fr', 'de', 'ja', 'zh-tw']) {
    setLanguage(value);
    assert.equal(t('刷新索引'), 'Refresh Index', value);
  }
});

test('完整英文词典保留占位符，参数不被再次解释或转换成HTML', () => {
  setLanguage('en');
  for (const [source, translated] of Object.entries(english)) {
    assert.equal(t(source), translated);
    assert.equal(/[\u3400-\u9fff]/.test(translated), false, source);
    assert.deepEqual((source.match(/\{\d+\}/g) ?? []).sort(), (translated.match(/\{\d+\}/g) ?? []).sort(), source);
  }
  const path = '<img src=x onerror=alert(1)>/{0}/中文.ts';
  assert.equal(t('{0} · 修改前第 {1} 行起 {2} 行 → {3}', path, 5, 2, 'after'),
    `${path} · Before: 2 lines starting at line 5 → after`);
  assert.equal(t('{0}：{1}', '{1}', 'untouched'), '{1}: untouched');
});

test('后台错误及历史缺口在展示层翻译，保留路径、提交和原始错误事实', () => {
  setLanguage('fr');
  const path = 'src/中文/{0}/<img>.ts', message = `Git cat-file 失败（退出码 1）（文件 ${path}，提交 abcdef012345）`;
  assert.equal(localizeError(message), `Git cat-file failed (exit code 1) (file ${path}, commit abcdef012345)`);
  assert.equal(localizeError('Git 来源坐标重复'), 'Duplicate Git source coordinates');
  assert.equal(localizeError('AI 签名 emails 必须为最多 64 项的非空字面字符串'),
    'AI signature field emails must contain at most 64 nonempty literal strings');
  assert.equal(localizeError('ENOENT: an external error'), 'ENOENT: an external error');
  setLanguage();
  assert.equal(localizeError(message), message);
});

test('双语清单只替换展示字段，配置默认值、AI签名与统计指纹不随语言改变', async () => {
  const { verifyLocalization, localizeManifest } = await import(pathToFileURL(join(process.cwd(), 'scripts/localization.mjs')).href);
  const { english, chinese } = await verifyLocalization(manifest);
  const zh = localizeManifest(manifest, chinese), en = localizeManifest(manifest, english);
  assert.equal(zh.contributes.views.codeEvolutionLens[0].name, '仓库与目录');
  assert.equal(en.contributes.views.codeEvolutionLens[0].name, 'Repositories and Directories');
  assert.equal(en.contributes.commands.find((c: { command: string }) => c.command === 'codeEvolutionLens.refresh').title,
    'code-evolution-lens: Refresh Index');
  for (const key of Object.keys(manifest.contributes.configuration.properties)) {
    assert.deepEqual(zh.contributes.configuration.properties[key].default, en.contributes.configuration.properties[key].default);
    assert.deepEqual(zh.contributes.configuration.properties[key].examples, en.contributes.configuration.properties[key].examples);
  }
  assert.equal(en.contributes.configuration.properties['codeEvolutionLens.aiProviders'].default.length, 68);
  const before = JSON.stringify(DEFAULT_CONFIG), fingerprint = configHash(DEFAULT_CONFIG);
  setLanguage('ja');
  assert.equal(configHash(DEFAULT_CONFIG), fingerprint);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.deepEqual(en.contributes.commands.map((c: { command: string }) => c.command), zh.contributes.commands.map((c: { command: string }) => c.command));
});
