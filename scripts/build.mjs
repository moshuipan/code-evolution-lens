import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { localizeManifest, verifyLocalization } from './localization.mjs';

/** 将配置说明转换为 JSONC 行注释，嵌套字段也能在示例文件中直接阅读。 */
function descriptionLines(schema, indent) {
  const description = schema?.markdownDescription ?? schema?.description ?? '';
  return description.split('\n').filter(Boolean).map(line => `${indent}// ${line.replace(/`/g, '')}`);
}

/** 按 schema 输出带字段注释的默认值；基础数组保持单行，provider 对象展开说明。 */
function annotatedValue(value, schema, indent = '') {
  if (Array.isArray(value)) {
    if (!value.some(item => item && typeof item === 'object')) return JSON.stringify(value);
    return `[\n${value.map(item => `${indent}  ${annotatedValue(item, schema?.items, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => {
      const childSchema = schema?.properties?.[key], childIndent = `${indent}  `;
      return [...descriptionLines(childSchema, childIndent),
        `${childIndent}${JSON.stringify(key)}: ${annotatedValue(child, childSchema, childIndent)}`].join('\n');
    });
    return `{\n${entries.join(',\n\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** 构建独立宿主与 worker 入口，将 SQLite WASM 放到可直接寻址的位置。 */
async function main() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const { chinese } = await verifyLocalization(manifest);
  const properties = localizeManifest(manifest, chinese).contributes.configuration.properties;
  const examples = Object.entries(properties).map(([key, schema]) => {
    const description = schema.markdownDescription ?? schema.description;
    if (!description || !Object.hasOwn(schema, 'default') || !schema.examples?.length)
      throw new Error(`配置必须包含默认值、说明和示例：${key}`);
    const value = annotatedValue(schema.default, schema, '  ');
    return [...descriptionLines(schema, '  '), `  ${JSON.stringify(key)}: ${value}`].join('\n');
  });
  await writeFile('code-evolution-lens.settings.example.jsonc',
    '// code-evolution-lens：完整默认配置。复制所需字段到仓库 .vscode/settings.json。\n'
    + '// 数组替换本项默认值；需要保留的默认规则请勿删除。邮箱配置只填写 @ 前名称。\n'
    + `{\n${examples.join(',\n\n')}\n}\n`);
  await mkdir('dist', { recursive: true });
  await build({
    entryPoints: ['src/extension.ts', 'src/worker.ts'],
    outdir: 'dist', bundle: true, platform: 'node', format: 'cjs',
    target: 'node20', external: ['vscode'], sourcemap: false,
    legalComments: 'eof',
  });
  await build({ entryPoints: ['src/webview.ts'], outfile: 'media/trends.js',
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'eof' });
  await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
  let notices = '# Third-party notices\n\nBundled dependencies retain their original licenses.\n';
  for (const name of ['diff', 'minimatch', '@isaacs/nonrecursive-glob-match', 'brace-expansion', 'balanced-match', 'sql.js']) {
    const directory = `node_modules/${name}`;
    const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
    const license = (await readdir(directory)).find(file => /^license(?:\.[^.]+)?$/i.test(file));
    if (!license) throw new Error(`License missing: ${name}`);
    notices += `\n## ${name}@${pkg.version} (${pkg.license})\n\n${await readFile(`${directory}/${license}`, 'utf8')}\n`;
  }
  notices += `\n## Provider signatures (MIT)\n\n${await readFile('licenses/provider-signatures.txt', 'utf8')}\n`;
  await writeFile('THIRD_PARTY_NOTICES.md', notices);
}
await main();
