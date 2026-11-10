import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_RULE_VERSION, DEFAULT_AI_PROVIDERS } from '../src/ai-providers';
import { AttributionEngine, attributionRule } from '../src/attribution';
import { DEFAULT_CONFIG } from '../src/model';
import { configHash, hash, normalizeConfig, snapshotConfigHash } from '../src/rules';
import { replay } from '../src/replay';
import { buildIndex } from '../src/indexer';
import { GitAdapter } from '../src/git';
import { QueryService } from '../src/query';
import { Fixture, T, DAY } from './fixtures';

const HUMAN = { parents: ['parent'], message: 'Implement feature', authorName: 'Ada', authorEmail: 'ada@example.test',
  committerName: 'Human', committerEmail: 'human@example.test' };

test('P1 默认 trailer 归因必须有正文和空行分隔，单行标题及无正文声明不命中', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  for (const message of ['Co-authored-by: Claude', 'Generated-by: Claude\n',
    'Co-authored-by: Claude\nSigned-off-by: Human', 'change\nCo-authored-by: Claude',
    '\n\nCo-authored-by: Claude', 'fix: typo\nCo-authored-by: Claude']) {
    assert.deepEqual(engine.attribute({ ...HUMAN, message }), { attribution: 'unmarked', signals: [] }, message);
  }
  for (const message of ['change\n\nCo-authored-by: Claude', 'fix: typo\n\nGenerated-by: Claude',
    'change\r\n\r\nCo-authored-by: Claude\r\n', 'change\n\nCo-authored-by: Claude\n Sonnet']) {
    assert.equal(engine.attribute({ ...HUMAN, message }).attribution, 'ai', message);
  }
  const enabled = new AttributionEngine({ ...DEFAULT_CONFIG, detectAiMessageMarkers: true });
  assert.equal(enabled.attribute({ ...HUMAN, message: '[claude] change' }).attribution, 'ai');
});

test('P1 真实 Git 标题不进入 AI 分母，旧规则快照暖重算纠正归因且保留原快照', async () => {
  const fixture = await Fixture.create();
  try {
    await fixture.write('subject.ts', 'subject line\n'); fixture.commit(T - 30 * DAY, 'Co-authored-by: Claude');
    await fixture.write('trailer.ts', 'trailer line\n'); fixture.commit(T - 29 * DAY, 'change\n\nCo-authored-by: Claude');
    const cold = await replay(fixture.root, DEFAULT_CONFIG, { cutoff: T, now: T + DAY });
    assert.equal(new QueryService(cold).aggregate().ai, 1);
    assert.equal(new QueryService(cold).aggregate().unmarked, 1);
    const legacy = structuredClone(cold);
    legacy.attributionRuleVersion = 'ai-v7:legacy-trailer-boundary';
    legacy.attributionHash = hash(legacy.attributionRuleVersion);
    legacy.configHash = snapshotConfigHash(legacy);
    const subject = legacy.births.find(b => b.path === 'subject.ts')!;
    subject.attribution = 'ai'; subject.attributionSignals = [{ kind: 'coauthor-name', provider: 'Claude Code' }];
    const warm = await buildIndex(fixture.root, DEFAULT_CONFIG, { cutoff: T, now: T + DAY }, legacy);
    assert.deepEqual(warm.births, cold.births);
    assert.deepEqual(warm.events, legacy.events);
    assert.deepEqual(warm.files, legacy.files);
    assert.equal(warm.attributionRuleVersion, AI_RULE_VERSION);
    assert.notEqual(warm.configHash, legacy.configHash);
    assert.notEqual(warm.id, legacy.id);
    assert.equal(subject.attribution, 'ai');
  } finally { await fixture.dispose(); }
});

test('GitHub noreply数字ID可变化，默认账号名称匹配所有身份位置且普通加号邮箱保留', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  for (const address of ['198982749+copilot-swe-agent@users.noreply.github.com',
    '999+COPILOT-SWE-AGENT@USERS.NOREPLY.GITHUB.COM', 'copilot-swe-agent@users.noreply.github.com']) {
    for (const commit of [{ ...HUMAN, authorEmail: address }, { ...HUMAN, committerEmail: address },
      { ...HUMAN, message: `change\n\nCo-Authored-By: Assistant ${address}` }]) {
      assert.equal(engine.attribute(commit).attribution, 'ai');
      assert.equal(engine.attribute(commit).signals[0].provider, 'GitHub Copilot');
    }
  }
  for (const authorEmail of ['198982749+copilot-swe-agent@company.test',
    '198982749+copilot-swe-agent@users.noreply.github.com.evil.test',
    'copilot-swe-agent-extra@users.noreply.github.com', 'copilot-swe-agent+alias@users.noreply.github.com'])
    assert.equal(engine.attribute({ ...HUMAN, authorEmail }).attribution, 'unmarked');
  const custom = new AttributionEngine({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Internal', emails: ['123+robot'] }] });
  assert.equal(custom.attribute({ ...HUMAN, authorEmail: '123+robot@company.test' }).attribution, 'ai');
  assert.equal(custom.attribute({ ...HUMAN, authorEmail: 'robot@company.test' }).attribution, 'unmarked');
});

test('无尖括号的Claude型号及版本命中名称词，无需开启消息启发式或配置邮箱', () => {
  const engine = new AttributionEngine({ ...DEFAULT_CONFIG,
    aiProviders: [{ provider: 'Claude Code', nameTokens: ['claude'] }] });
  for (const value of ['Claude Sonnet 4.6 noreply@anthropic.com', 'CLAUDE Opus 4.6 <noreply@anthropic.com>',
    'Claude Haiku 4.5', 'Claude\n Sonnet 4.6 noreply@anthropic.com']) {
    for (const key of ['Co-Authored-By', 'Generated-by', 'Assisted-by', 'Created-by']) {
      const result = engine.attribute({ ...HUMAN, message: `change\n\n${key}: ${value}` });
      assert.equal(result.attribution, 'ai');
      assert.deepEqual(result.signals, [{ kind: key === 'Co-Authored-By' ? 'coauthor-name' : 'generated-trailer', provider: 'Claude Code' }]);
    }
  }
  const full = new AttributionEngine(DEFAULT_CONFIG).attribute({
    ...HUMAN, message: 'change\n\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com',
  });
  assert.ok(full.signals.some(s => s.kind === 'coauthor-name' && s.provider === 'Claude Code'));
  assert.ok(full.signals.some(s => s.kind === 'coauthor-email'));
});

test('型号名称匹配保留词边界和trailer边界，坏邮箱及正文样例不产生名称信号', () => {
  const engine = new AttributionEngine({ ...DEFAULT_CONFIG,
    aiProviders: [{ provider: 'Claude Code', nameTokens: ['claude'] }] });
  for (const value of ['McClaude Sonnet 4.6 other@example.test', 'Claudeish other@example.test',
    'Claude <bad>', 'Claude <other@example.test', 'Claude other@example.test>',
    'Claude one@example.test two@example.test', 'Claude a@@b', 'Claude @anthropic.com']) {
    assert.equal(engine.attribute({ ...HUMAN, message: `change\n\nCo-Authored-By: ${value}` }).attribution, 'unmarked', value);
  }
  for (const message of ['change\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com',
    'change\n\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com\n\nExample in documentation.',
    'Discuss Claude Sonnet 4.6 noreply@anthropic.com'])
    assert.equal(engine.attribute({ ...HUMAN, message }).attribution, 'unmarked');
});

test('真实分支co-author无尖括号时按名称归因，进入主线和后续返工保持可回溯', async () => {
  const f = await Fixture.create();
  try {
    await f.write('root', 'root\n'); f.commit(T - 200 * DAY);
    f.git(['checkout', '-b', 'feature']);
    await f.write('source.ts', 'original\n');
    const source = f.commit(T - 30 * DAY, 'feature\n\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com');
    f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'merge'], T - 21 * DAY);
    const main = f.git(['rev-parse', 'HEAD']);
    await f.write('source.ts', 'changed\n'); f.commit(T - 18 * DAY);
    const snapshot = await replay(f.root, { ...DEFAULT_CONFIG,
      aiProviders: [{ provider: 'Claude Code', nameTokens: ['claude'] }] }, { cutoff: T, now: T + DAY });
    const original = snapshot.births.find(b => b.commit === main)!;
    assert.equal(original.attribution, 'ai'); assert.equal(original.origin?.commit, source);
    assert.equal(original.time, T - 21 * DAY); assert.ok(original.firstRewrite);
    assert.equal(new QueryService(snapshot).aggregate().aiRewritten, 1);
    assert.deepEqual(original.attributionSignals, [{ kind: 'coauthor-name', provider: 'Claude Code' }]);
  } finally { await f.dispose(); }
});

test('默认68个提供者的邮箱名跨域匹配；共用名称不伪造具体提供者', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  assert.equal(DEFAULT_AI_PROVIDERS.length, 68); assert.equal(engine.configured, true);
  for (const provider of DEFAULT_AI_PROVIDERS) for (const email of provider.emails ?? []) {
    for (const kind of ['author-email', 'committer-email'] as const) {
      const commit = { ...HUMAN, ...(kind === 'author-email' ? { authorEmail: `${email.toUpperCase()}@other.test` } : { committerEmail: `${email}@example.test` }) };
      const result = engine.attribute(commit);
      assert.equal(result.attribution, 'ai', `${provider.provider}: ${kind}`);
      const matches = DEFAULT_AI_PROVIDERS.filter(p => p.emails?.includes(email));
      assert.deepEqual(result.signals, [{ kind, provider: matches.length > 1 ? 'AI 邮箱名（提供者不唯一）' : provider.provider }]);
    }
  }
});

test('默认结尾 co-author 名称与邮箱匹配，大小写、续行、重复 trailer 均可解释', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  for (const provider of DEFAULT_AI_PROVIDERS) {
    const result = engine.attribute({ ...HUMAN, message: `Implement\n\nCo-authored-by: ${provider.nameTokens![0].toUpperCase()} <other@example.test>` });
    assert.equal(result.attribution, 'ai', provider.provider);
    assert.deepEqual(result.signals, [{ kind: 'coauthor-name', provider: provider.provider }]);
  }
  const result = engine.attribute({ ...HUMAN, message: 'Implement\n\nCo-authored-by: Copilot\n Autofix <other@example.test>\nCo-authored-by: Copilot Autofix <other@example.test>\nSigned-off-by: Ada <ada@example.test>' });
  assert.deepEqual(result.signals, [{ kind: 'coauthor-name', provider: 'GitHub Copilot' }]);
  assert.equal(engine.attribute({ ...HUMAN, message: 'Implement\n\nCo-authored-by: Unknown <AGENT@CURSOR.SH>' }).signals[0].kind, 'coauthor-email');
});

test('默认结尾 Generated-by／Assisted-by／Created-by 是显式归因依据', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  for (const key of ['Generated-by', 'Assisted-by', 'Created-by']) {
    assert.deepEqual(engine.attribute({ ...HUMAN, message: `Implement\n\n${key}: Codex` }).signals,
      [{ kind: 'generated-trailer', provider: 'OpenAI Codex' }]);
  }
});

test('新增重点Agent按版本名称声明识别；Pi社区Generated-By和同提交多信号可解释', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  const cases = [
    ['TRAE', 'TRAE SOLO 2.0'], ['TRAE', 'Trae CN'], ['Qoder', 'Qoder CLI 1.0'],
    ['OpenClaw', 'OpenClaw 2026.11'], ['Pi Coding Agent', 'pi 0.63.2'],
    ['OpenCode', 'OpenCode 1.0'], ['Gemini CLI', 'Gemini CLI 1.0'], ['Qwen Code', 'Qwen Code 1.0'],
    ['Kimi Code CLI', 'Kimi Code CLI 1.0'], ['Tongyi Lingma', '通义灵码'],
    ['Mistral Vibe', 'Mistral Vibe 1.0'], ['Oh My Pi', 'omp 1.0'],
  ];
  for (const [provider, name] of cases) for (const key of ['Co-Authored-By', 'Generated-By', 'Assisted-by', 'Created-by']) {
    const decision = engine.attribute({ ...HUMAN, message: `change\n\n${key}: ${name}` });
    assert.equal(decision.attribution, 'ai', `${key}: ${name}`);
    assert.deepEqual(decision.signals, [{ kind: key === 'Co-Authored-By' ? 'coauthor-name' : 'generated-trailer', provider }]);
  }
  const pi = engine.attribute({ ...HUMAN,
    message: 'change\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>\nGenerated-By: pi 0.63.2' });
  assert.equal(pi.attribution, 'ai');
  assert.ok(pi.signals.some(signal => signal.provider === 'Pi Coding Agent' && signal.kind === 'generated-trailer'));
  assert.ok(pi.signals.some(signal => signal.provider === 'Claude Code' && signal.kind === 'coauthor-name'));
  const inherited = engine.attribute({ ...HUMAN, message: 'change\n\nGenerated-By: Oh My Pi 1.0' });
  assert.deepEqual(new Set(inherited.signals.map(signal => signal.provider)), new Set(['Oh My Pi', 'Pi Coding Agent']));
});

test('全部默认标题标签受开关控制，正文提及、配置目录、近似名称和泛词不作名称证据', () => {
  const off = new AttributionEngine(DEFAULT_CONFIG);
  const on = new AttributionEngine({ ...DEFAULT_CONFIG, detectAiMessageMarkers: true });
  for (const provider of DEFAULT_AI_PROVIDERS) for (const tag of provider.bracketTags ?? []) {
    const message = `[${tag.toUpperCase()}] change`;
    assert.equal(off.attribute({ ...HUMAN, message }).attribution, 'unmarked', message);
    const marked = on.attribute({ ...HUMAN, message });
    assert.equal(marked.attribution, 'ai', message);
    assert.ok(marked.signals.some(signal => signal.kind === 'subject-tag' && signal.provider === provider.provider), message);
    assert.equal(on.attribute({ ...HUMAN, message: `change\n\nDiscuss [${tag}] configuration.` }).attribution, 'unmarked', tag);
  }
  for (const message of ['Discuss TRAE Qoder OpenClaw Pi', 'change .trae .qoder .pi .openclaw settings',
    'change\n\nGenerated-By: MyQoder', 'change\n\nGenerated-By: OpenClawish',
    'change\n\nGenerated-By: raspberrypi', 'change\n\nGenerated-By: SOLO',
    'change\n\nGenerated-By: vibe', 'change\n\nGenerated-By: forge',
    'Example\nGenerated-By: pi 0.63.2',
    'Example\n\nGenerated-By: OpenClaw\n\nThis documents an example.']) {
    assert.equal(off.attribute({ ...HUMAN, message }).attribution, 'unmarked', message);
  }
  assert.equal(off.attribute({ ...HUMAN, authorName: 'TRAE', committerName: 'Qoder' }).attribution, 'unmarked');
});

test('默认拒绝正文示例、邮箱子串、近似姓名和普通人类作者名称', () => {
  const engine = new AttributionEngine(DEFAULT_CONFIG);
  const messages = [
    'Discuss Claude and Cursor', '[claude] update docs', 'aider: update docs', 'Generated with Codex',
    'Example\n\nCo-authored-by: Claude <noreply@anthropic.com>\n\nThis is documentation.',
    'Example\nCo-authored-by: Claude <noreply@anthropic.com>',
    'Implement\n\nCo-authored-by: McClaude <person@example.test>',
    'Implement\n\nCo-authored-by: MyCursor <person@example.test>',
    'Implement\n\nCo-authored-by: Claude <bad> <other>',
    'Implement\n\nCo-authored-by: Claude <not-an-email>',
    'Implement\n\nCo-authored-by: fake@cursor.sh.evil.test',
  ];
  for (const message of messages) assert.equal(engine.attribute({ ...HUMAN, message }).attribution, 'unmarked', message);
  assert.equal(engine.attribute({ ...HUMAN, authorName: 'Claude', committerName: 'Cursor' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'mycodex@openai.com' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'someone@noreply.anthropic.com' }).attribution, 'unmarked');
});

test('正文标记、标题标签与 aider 前缀只有显式开启后参与判断', () => {
  const enabled = new AttributionEngine({ ...DEFAULT_CONFIG, detectAiMessageMarkers: true });
  for (const [message, kind] of [
    ['Generated with Codex', 'message-marker'], ['[claude] Implement', 'subject-tag'], ['aider: Implement', 'subject-prefix'],
  ]) assert.ok(enabled.attribute({ ...HUMAN, message }).signals.some(signal => signal.kind === kind));
  assert.equal(enabled.attribute({ ...HUMAN, message: 'Implement\n\nMention [claude] in docs' }).attribution, 'unmarked');
  assert.equal(enabled.attribute({ ...HUMAN, message: 'aider:ish text' }).attribution, 'unmarked');
});

test('显式数组替换默认名单，同名provider只合并显式签名', () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG,
    aiProviders: [
      { provider: '自定义 AI 身份', emails: [' INTERNAL '] },
      { provider: 'Claude Code', emails: ['claude'] },
      { provider: 'claude code', nameTokens: ['internal claude'] },
      { provider: '内部编码助手', nameTokens: ['internal bot'], emails: ['bot'] },
    ] });
  const engine = new AttributionEngine(config);
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'noreply@anthropic.com' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...HUMAN, message: 'Implement\n\nGenerated-by: Claude' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...HUMAN, message: 'Implement\n\nGenerated-by: Internal Claude' }).attribution, 'ai');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'claude@company.test' }).signals[0].provider, 'Claude Code');
  assert.equal(engine.attribute({ ...HUMAN, committerEmail: 'internal@example.test' }).signals[0].provider, '自定义 AI 身份');
  assert.equal(engine.attribute({ ...HUMAN, message: 'Implement\n\nCo-authored-by: Internal Bot <unknown@example.test>' }).signals[0].provider, '内部编码助手');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'bot@company.test' }).signals[0].provider, '内部编码助手');
});

test('清空provider数组关闭识别，自定义邮箱或名称无需另一份配置', () => {
  const config = { ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Local', emails: ['bot'] }] };
  const engine = new AttributionEngine(config);
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'noreply@anthropic.com' }).attribution, 'unmarked');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'bot@local.test' }).attribution, 'ai');
  assert.equal(engine.attribute({ ...HUMAN, authorEmail: 'bot@local.test', parents: ['one', 'two'] }).attribution, 'unknown');
  const off = new AttributionEngine({ ...DEFAULT_CONFIG, aiProviders: [] });
  assert.equal(off.configured, false); assert.equal(off.attribute(HUMAN).attribution, 'unknown');
  assert.equal(off.attribute({ ...HUMAN, authorEmail: 'codex@a.test' }).attribution, 'unknown');
  const weakOnly = { ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Local', bracketTags: ['local'] }] };
  assert.equal(new AttributionEngine(weakOnly).configured, false);
  assert.equal(new AttributionEngine({ ...weakOnly, detectAiMessageMarkers: true }).attribute({ ...HUMAN, message: '[local] Implement' }).attribution, 'ai');
});

test('规则规范化、缓存失效和配置错误可检测', () => {
  const first = normalizeConfig({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Test', emails: ['b', 'a'] }] });
  const reordered = normalizeConfig({ ...DEFAULT_CONFIG, aiProviders: [{ provider: 'Test', emails: [' A ', 'b', 'a'] }] });
  assert.equal(configHash(first), configHash(reordered));
  assert.notEqual(configHash(first), configHash({ ...first, aiProviders: [] }));
  assert.notEqual(configHash(first), configHash({ ...first, detectAiMessageMarkers: true }));
  assert.notEqual(hash(attributionRule(first)), hash(attributionRule({ ...first, aiProviders: [{ provider: 'Local', emails: ['local'] }] })));
  const legacyHash = hash([first.ref, ['b', 'a'], first.packageRoots, first.excludeGlobs, 'legacy-rule']);
  assert.notEqual(configHash(first), legacyHash);
  for (const aiProviders of [[{ provider: 'Only a name' }], [{ provider: '', emails: ['a@b'] }],
    [{ provider: 'Wrong', email: ['a@b'] }], [{ provider: 'Wrong', nameTokens: [''] }],
    [{ provider: 'Wrong', messageMarkers: ['bad\nmarker'] }], [{ provider: 'Wrong', emails: ['two words'] }]]) {
    assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, aiProviders } as never), /AI|aiProviders/);
  }
});

test('真实 Git 作者、提交者、co-author 与默认零配置成熟统计贯通', async () => {
  const f = await Fixture.create();
  const git = new GitAdapter(f.root, DEFAULT_CONFIG);
  try {
    await f.write('author.ts', 'author\n'); f.commit(T - 21 * DAY, 'Author commit', { authorName: 'AI Agent', authorEmail: 'codex@openai.com' });
    await f.write('committer.ts', 'committer\n'); f.commit(T - 20 * DAY, 'Committer commit', { committerEmail: 'copilot@github.com' });
    await f.write('coauthor.ts', 'coauthor\n'); f.commit(T - 19 * DAY, 'Coauthor commit\n\nCo-authored-by: Claude <noreply@anthropic.com>');
    await f.write('human.ts', 'human\n'); f.commit(T - 18 * DAY, '[claude] discuss generated code');
    await f.write('author.ts', 'changed\n'); f.commit(T - 10 * DAY);
    const tip = (await git.probe()).tip, commits = await git.commits(tip);
    assert.equal(commits.length, 5); assert.equal(commits[0].authorName, 'AI Agent'); assert.equal(commits[0].authorEmail, 'codex@openai.com');
    assert.equal(commits[1].committerEmail, 'copilot@github.com'); assert.equal(commits[2].message.trimEnd(), 'Coauthor commit\n\nCo-authored-by: Claude <noreply@anthropic.com>');
    const s = await replay(f.root, DEFAULT_CONFIG, { cutoff: T, now: T + DAY });
    const a = new QueryService(s).aggregate(s.births.filter(b => b.time < T - 14 * DAY));
    assert.equal(a.ai, 3); assert.equal(a.aiRewritten, 1); assert.equal(a.unmarked, 1); assert.equal(a.configured, true);
    assert.ok(s.attributionRuleVersion); assert.equal(s.attributionMessageMarkers, false);
    assert.equal(s.births.find(b => b.path === 'author.ts')?.attributionSignals?.[0].kind, 'author-email');
    assert.equal(s.births.find(b => b.path === 'committer.ts')?.attributionSignals?.[0].kind, 'committer-email');
    assert.ok(!JSON.stringify(s.births).includes('noreply@anthropic.com'));
    const custom = await replay(f.root, normalizeConfig({ ...DEFAULT_CONFIG,
      aiProviders: [{ provider: 'Fixture', emails: ['fixture'] }] }), { cutoff: T, now: T + DAY });
    assert.notEqual(custom.attributionHash, s.attributionHash);
    assert.equal(new QueryService(custom).aggregate(custom.births.filter(b => b.time < T - 14 * DAY)).ai, 4);
  } finally { await git.dispose(); await f.dispose(); }
});
