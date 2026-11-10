import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import manifest from '../package.json';
import { AttributionEngine, attributionRule, normalizeEmailNames } from '../src/attribution';
import { DEFAULT_AI_PROVIDERS } from '../src/ai-providers';
import { DEFAULT_CONFIG } from '../src/model';
import { configHash, normalizeConfig } from '../src/rules';
import chinese from '../package.nls.zh-cn.json';

/** 配置展示测试读取中文源词典，默认值与规则仍来自原始清单。 */
function sourceText(value: string): string {
  const match = /^%([^%]+)%$/.exec(value);
  return match ? (chinese as Record<string, string>)[match[1]] : value;
}
const properties = JSON.parse(JSON.stringify(manifest.contributes.configuration.properties),
  (key, value) => ['title', 'description', 'markdownDescription', 'label'].includes(key) && typeof value === 'string'
    ? sourceText(value) : value) as typeof manifest.contributes.configuration.properties;
const person = { parents: ['parent'], message: 'change', authorName: 'Human', authorEmail: 'human@example.test',
  committerName: 'Human', committerEmail: 'human@example.test' };

test('公开配置只保留五项，默认值、描述、示例和提供者补全模板齐全', () => {
  assert.equal(manifest.name, 'code-evolution-lens');
  assert.equal(manifest.displayName, manifest.name);
  assert.deepEqual(Object.keys(properties).sort(), ['aiProviders', 'decorations.enabled',
    'detectAiMessageMarkers', 'excludeGlobs', 'ref'].map(key => `codeEvolutionLens.${key}`).sort());
  for (const value of Object.values(properties)) {
    assert.ok(Object.hasOwn(value, 'default'));
    assert.ok(value.markdownDescription.length > 0); assert.ok(value.examples.length > 0);
  }
  for (const value of Object.values(properties['codeEvolutionLens.aiProviders'].items.properties)) {
    assert.ok(Object.hasOwn(value, 'default')); assert.ok(value.examples.length);
    assert.ok(value.title); assert.ok(value.markdownDescription.includes('填写'));
  }
  const sample = properties['codeEvolutionLens.aiProviders'].defaultSnippets[0].body;
  const config = normalizeConfig({ ...DEFAULT_CONFIG, aiProviders: sample, detectAiMessageMarkers: true });
  const result = new AttributionEngine(config).attribute({ ...person, authorEmail: 'internal-codebot@company.example' });
  assert.equal(result.attribution, 'ai'); assert.equal(result.signals[0].provider, '内部编码助手');
});

test('设置主说明直接展示六字段机制，纯文本宿主和Markdown宿主都能读到示例', () => {
  const schema = properties['codeEvolutionLens.aiProviders'];
  for (const description of [schema.description, schema.markdownDescription]) {
    for (const field of Object.keys(schema.items.properties)) assert.ok(description.includes(field), field);
    for (const example of ['Co-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com',
      'internal-codebot@company.example', '[trae] 修复缓存', 'Generated with Cursor', 'aider: 修复权限校验'])
      assert.ok(description.includes(example), example);
    for (const mechanism of ['完整词或短语', '作者、提交者或结尾声明', '只检查标题',
      'detectAiMessageMarkers: true', '任意一项命中', '[]', '替换默认值', '默认', 'false', '没有 Git 标记'])
      assert.ok(description.includes(mechanism), mechanism);
  }
});

test('68类默认规则与来源清单对应，格式有效且未查实产品不猜邮箱', async () => {
  const raw = await readFile('PROVIDERS.md', 'utf8');
  const table = raw.split('## 产品覆盖')[1].split('## 使用边界')[0];
  const documented = table.split('\n').filter(line => line.startsWith('|')).slice(2)
    .map(line => line.split('|')[1].trim());
  assert.deepEqual(documented, DEFAULT_AI_PROVIDERS.map(provider => provider.provider));
  assert.equal(new Set(documented.map(name => name.toLowerCase())).size, 68);
  const normalized = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(normalized.aiProviders.length, 68);
  for (const provider of ['TRAE', 'Qoder', 'OpenClaw', 'Pi Coding Agent', 'Gemini CLI', 'Qwen Code']) {
    assert.deepEqual(normalized.aiProviders.find(item => item.provider === provider)?.emails, [], provider);
  }
  for (const item of normalized.aiProviders) {
    assert.ok(item.nameTokens?.length, item.provider);
    assert.ok(item.bracketTags?.length, item.provider);
  }
});

test('默认值与可复制示例一致，签名只有邮箱名，运行时不修改manifest数组', async () => {
  assert.equal(DEFAULT_AI_PROVIDERS.length, 68);
  assert.ok(DEFAULT_AI_PROVIDERS.find(provider => provider.provider === 'GitHub Copilot')?.emails?.includes('copilot-swe-agent'));
  const raw = await readFile('code-evolution-lens.settings.example.jsonc', 'utf8');
  for (const field of Object.values(properties['codeEvolutionLens.aiProviders'].items.properties))
    assert.ok(raw.includes(`// ${field.markdownDescription.replace(/`/g, '')}`));
  const example = JSON.parse(raw.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')) as
    { [Key in keyof typeof properties]: typeof properties[Key]['default'] };
  assert.deepEqual(example, Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.default])));
  for (const name of example['codeEvolutionLens.aiProviders'].flatMap((p: { emails?: string[] }) => p.emails ?? []))
    assert.ok(!name.includes('@') && !/^\d+\+/.test(name));
  const before = JSON.stringify(properties);
  const fromExample = normalizeConfig({ ref: example['codeEvolutionLens.ref'],
    aiProviders: example['codeEvolutionLens.aiProviders'], detectAiMessageMarkers: example['codeEvolutionLens.detectAiMessageMarkers'],
    excludeGlobs: example['codeEvolutionLens.excludeGlobs'], packageRoots: [] });
  assert.deepEqual(fromExample, normalizeConfig(DEFAULT_CONFIG));
  assert.equal(JSON.stringify(properties), before);
});

test('配置只能填写邮箱名，完整地址在schema与运行时都报错', () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Internal', emails: [' Assistant ', 'assistant'] }] });
  assert.deepEqual(config.aiProviders[0].emails, ['assistant']);
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG,
    aiProviders: [{ provider: 'Internal', emails: ['Assistant@company.example'] }] }), /不要填写 @ 或域名/);
  for (const schema of [properties['codeEvolutionLens.aiProviders'].items.properties.emails.items]) {
    const pattern = new RegExp(schema.pattern);
    assert.equal(pattern.test('codebot'), true); assert.equal(pattern.test('codebot@a.test'), false);
  }
  for (const input of [[''], ['two words'], ['name@domain'], ['@domain'], ['name@'], ['a@b@c'], [null], 'bot'])
    assert.throws(() => normalizeEmailNames(input), /邮箱名/);
});

test('邮箱名按完整名称跨域匹配，不去掉加号后缀也不匹配子串', () => {
  const engine = new AttributionEngine({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Custom', emails: ['CodeBot', 'robot+agent'] }] });
  for (const authorEmail of ['codebot@first.test', 'CODEBOT@second.test', 'robot+agent@third.test'])
    assert.equal(engine.attribute({ ...person, authorEmail }).attribution, 'ai');
  for (const authorEmail of ['mycodebot@first.test', 'robot@third.test', 'human@codebot', 'codebot+other@test'])
    assert.equal(engine.attribute({ ...person, authorEmail }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...person, message: 'change\n\nCo-authored-by: Bot <CODEBOT@another.test>' }).attribution, 'ai');
});

test('仅从provider中删除noreply就能停用邮箱匹配；旧算法指纹过期', () => {
  const custom = { ...DEFAULT_CONFIG,
    aiProviders: DEFAULT_CONFIG.aiProviders.map(p => ({ ...p, emails: p.emails?.filter(name => name !== 'noreply') })) };
  const engine = new AttributionEngine(custom);
  assert.equal(engine.attribute({ ...person, authorEmail: 'noreply@anthropic.com' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...person, message: 'change\n\nCo-authored-by: Claude <noreply@anthropic.com>' }).attribution, 'ai');
  assert.notEqual(configHash(DEFAULT_CONFIG), configHash(custom));
  assert.ok(attributionRule(custom).version.startsWith('ai-v8:'));
});

test('额外的旧邮箱键不参与归因，也不会生成自定义provider', () => {
  const input = { ...DEFAULT_CONFIG, aiProviders: [], aiEmails: ['other-bot'] };
  const result = normalizeConfig(input);
  assert.equal('aiEmails' in result, false);
  assert.deepEqual(result.aiProviders, []);
  assert.equal(new AttributionEngine(result).configured, false);
});

test('字段示例能够产生所描述的归因结果，需要开关的三类规则关闭时不生效', () => {
  const fields = properties['codeEvolutionLens.aiProviders'].items.properties;
  const cases = [
    { field: 'nameTokens', message: 'change\n\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com', extra: false },
    { field: 'emails', message: 'change\n\nCo-Authored-By: Assistant 198982749+copilot-swe-agent@users.noreply.github.com', extra: false },
    { field: 'bracketTags', message: '[claude] 增加权限缓存', extra: true },
    { field: 'messageMarkers', message: 'change\n\nGenerated with Claude Code', extra: true },
    { field: 'subjectPrefixes', message: 'aider: 修复权限校验', extra: true },
  ] as const;
  for (const item of cases) {
    const aiProviders = [{ provider: 'Test', [item.field]: fields[item.field].examples[0] }];
    const commit = { ...person, message: item.message };
    assert.equal(new AttributionEngine({ ...DEFAULT_CONFIG, aiProviders, detectAiMessageMarkers: true }).attribute(commit).attribution, 'ai', item.field);
    const off = new AttributionEngine({ ...DEFAULT_CONFIG, aiProviders, detectAiMessageMarkers: false }).attribute(commit);
    assert.equal(off.attribution, item.extra ? 'unknown' : 'ai', item.field);
  }
  for (const tag of ['[claude]', 'a', '中文标签', 'x'.repeat(32)])
    assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Test', bracketTags: [tag] }] }), /不带方括号的标题标签/);
});
