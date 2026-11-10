"""从实际 VSIX 解包启动 worker；临时目录中没有工程 node_modules。"""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile


def packaged_markdown(content, repository_url):
    """预期 vsce 对 GitHub 相对链接的转换，其余 Markdown 内容保持逐字节一致。"""
    repository = repository_url.removesuffix(".git").rstrip("/")
    assert repository.startswith("https://github.com/")

    def replace(match):
        """仅转换本地图片和文档链接，绝对 URL、邮件与页内锚点保持原样。"""
        image, title, target = match.groups()
        if re.match(r"^\w+:", target) or target.startswith("#"):
            return match.group(0)
        kind = "raw" if image else "blob"
        return f"{image}[{title}]({repository}/{kind}/HEAD/{target})"

    return re.sub(r"(!?)\[([^\[\]]*)\]\(([^)]+)\)", replace, content.decode()).encode()


def check_methodology(extension, base, env):
    """加载实际 VSIX 扩展入口，以精确文件名核验中文、英文和语言回退命令。"""
    script = r"""
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const extensionPath = process.argv[1], storage = process.argv[2];
const disposable = { dispose() {} }, commands = new Map(), opened = [];
/** 保留实际路径供 Node 读取，文档 URI 由真实扩展入口选择。 */
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; this.authority = ''; }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
}
/** 提供扩展事件接口，激活逻辑由实际 bundle 执行。 */
class Emitter {
  constructor() { this.listeners = []; this.event = fn => { this.listeners.push(fn); return disposable; }; }
  fire(value) { for (const fn of this.listeners) fn(value); }
  dispose() { this.listeners = []; }
}
const vscode = { EventEmitter: Emitter, Uri, ExtensionKind: { Workspace: 2 },
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: 2 },
  env: { language: 'zh-cn' }, ThemeColor: class {},
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; } },
  workspace: { isTrusted: true, workspaceFolders: [], registerTextDocumentContentProvider: () => disposable,
    onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
    onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
    /** 用目录项精确比对大小写；不依赖当前操作系统是否区分大小写。 */
    openTextDocument: async uri => {
      if (!fs.readdirSync(path.dirname(uri.fsPath)).includes(path.basename(uri.fsPath))) throw Error('missing resource');
      return { uri, text: fs.readFileSync(uri.fsPath, 'utf8') };
    } },
  window: { state: { focused: false }, visibleTextEditors: [],
    createTextEditorDecorationType: () => disposable, createTreeView: () => ({ ...disposable, visible: false }),
    createOutputChannel: () => disposable, createStatusBarItem: () => ({ ...disposable, show() {} }),
    onDidChangeActiveTextEditor: () => disposable, onDidChangeVisibleTextEditors: () => disposable,
    onDidChangeTextEditorVisibleRanges: () => disposable, onDidChangeWindowState: () => disposable,
    showTextDocument: async doc => { opened.push(path.basename(doc.uri.fsPath)); },
    showErrorMessage: message => { throw Error(message); } } };
const load = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : load.call(this, name, parent, main); };
const { activate } = require(path.join(extensionPath, 'dist/extension.js'));
Module._load = load;
/** 激活三种语言并执行真实命令，释放每次激活建立的定时器。 */
async function main() {
  for (const language of ['zh-cn', 'en', 'fr']) {
    vscode.env.language = language;
    const context = { subscriptions: [], extensionUri: new Uri(extensionPath), storageUri: new Uri(storage),
      asAbsolutePath: name => path.join(extensionPath, name), workspaceState: { get() {}, update: async () => {} },
      extension: { extensionKind: 2, packageJSON: { version: 'smoke' } } };
    try { await activate(context); await commands.get('codeEvolutionLens.showMethodology')(); }
    finally { for (const item of context.subscriptions) item.dispose(); }
  }
  console.log(JSON.stringify(opened));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
"""
    result = subprocess.run(["node", "-e", script, str(extension), str(base / "docs-cache")],
                            cwd=base, env=env, text=True, capture_output=True, check=True, timeout=30)
    assert json.loads(result.stdout) == ["readme.md", "README.en.md", "README.en.md"], result.stdout


def main():
    """核验安装包结构、离线依赖与一个真实 Git 快照的发布。"""
    workspace = Path(__file__).resolve().parents[1]
    version = json.loads((workspace / "package.json").read_text())["version"]
    package = workspace / f"code-evolution-lens-{version}.vsix"
    with tempfile.TemporaryDirectory(prefix="code-evolution-lens-vsix-") as temp:
        base = Path(temp)
        with zipfile.ZipFile(package) as archive:
            names = archive.namelist()
            assert not any("node_modules/" in name or ".trae-html-share-packages/" in name for name in names)
            assert "extension/readme.md" in names and "extension/README.md" not in names
            archive.extractall(base / "unpacked")
        extension = base / "unpacked" / "extension"
        manifest = json.loads((extension / "package.json").read_text())
        source_bundle = json.loads((extension / "package.nls.zh-cn.json").read_text())
        fallback_bundle = json.loads((extension / "package.nls.json").read_text())
        assert source_bundle.keys() == fallback_bundle.keys()
        assert manifest["name"] == manifest["displayName"] == "code-evolution-lens"
        assert source_bundle["commands.refresh"] == "code-evolution-lens: 刷新索引"
        assert fallback_bundle["commands.refresh"] == "code-evolution-lens: Refresh Index"
        assert (extension / "l10n.en.json").is_file()
        assert (extension / "README.en.md").is_file()
        aliases = {"readme.md": "README.md", "changelog.md": "CHANGELOG.md", "LICENSE.txt": "LICENSE"}
        for name in names:
            if not name.startswith("extension/") or name.endswith("/"):
                continue
            packaged = name[len("extension/"):]
            source = aliases.get(packaged, packaged)
            expected = (workspace / source).read_bytes()
            if packaged in {"readme.md", "changelog.md"}:
                expected = packaged_markdown(expected, manifest["repository"]["url"])
            assert (extension / packaged).read_bytes() == expected, packaged
        for relative in [
            "media/screenshots/repository-trends.png",
            "media/screenshots/provider-retention.png",
            "media/screenshots/file-evidence.png",
        ]:
            assert (extension / relative).is_file()
            assert relative in (extension / "README.en.md").read_text()
            repository = manifest["repository"]["url"].removesuffix(".git")
            assert f"{repository}/raw/HEAD/{relative}" in (extension / "readme.md").read_text()

        def resolve_display(value):
            """只解析清单展示字段，保留默认签名及示例数据原文。"""
            if isinstance(value, list):
                return [resolve_display(item) for item in value]
            if not isinstance(value, dict):
                return value
            return {
                key: (source_bundle[child[1:-1]]
                      if key in {"name", "title", "description", "markdownDescription", "label"}
                      and isinstance(child, str) and child.startswith("%") and child.endswith("%")
                      else child if key in {"default", "examples", "body"} else resolve_display(child))
                for key, child in value.items()
            }

        manifest = resolve_display(manifest)
        assert manifest["version"] == version
        assert manifest["extensionKind"] == ["workspace"]
        assert all("vscode-remote" in item["when"] for item in manifest["contributes"]["menus"]["editor/context"])
        assert (extension / "dist" / "sql-wasm.wasm").stat().st_size > 100000
        assert (extension / "media" / "trends.js").stat().st_size > 1000
        assert (extension / "media" / "trends.css").stat().st_size > 1000
        assert (extension / "METRICS.md").is_file()
        assert not (extension / "media" / "detail.js").exists()
        assert manifest["contributes"]["views"]["codeEvolutionLens"] == [
            {"id": "codeEvolutionLens.tree", "name": "仓库与目录"}]
        root = base / "repo"
        root.mkdir()
        cutoff = int(time.time()) // 86400 * 86400
        env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_AUTHOR_NAME": "VSIX Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
               "GIT_COMMITTER_NAME": "VSIX Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test",
               "GIT_AUTHOR_DATE": f"{cutoff - 21 * 86400} +0000",
               "GIT_COMMITTER_DATE": f"{cutoff - 21 * 86400} +0000", "NODE_PATH": ""}
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=root, env=env, check=True, capture_output=True)
        check_methodology(extension, base, env)
        signing_key = root / ".git" / "fixture-key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(signing_key)],
                       env=env, check=True, capture_output=True)
        signers = root / ".git" / "allowed-signers"
        signers.write_text("fixture@example.test " + signing_key.with_suffix(".pub").read_text())
        for key, value in [("gpg.format", "ssh"), ("user.signingkey", str(signing_key)),
                           ("gpg.ssh.allowedSignersFile", str(signers)), ("log.showSignature", "true")]:
            subprocess.run(["git", "config", key, value], cwd=root, env=env, check=True)
        legacy = root / "old-generated.ts"
        legacy.write_text("".join(f"old_{i}\n" for i in range(498)))
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{cutoff - 220 * 86400} +0000"
        subprocess.run(["git", "add", "old-generated.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "old generated baseline"],
                       cwd=root, env=env, check=True, capture_output=True)
        legacy.write_text("".join(f"old_{i}\n" for i in range(65064)))
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{cutoff - 210 * 86400} +0000"
        subprocess.run(["git", "add", "old-generated.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "old generated expansion"],
                       cwd=root, env=env, check=True, capture_output=True)
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{cutoff - 21 * 86400} +0000"
        subprocess.run(["git", "checkout", "-b", "ai-feature"], cwd=root, env=env, check=True, capture_output=True)
        (root / "source.ts").write_text("const fixture = 1;\n")
        subprocess.run(["git", "add", "source.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-S", "-m", "fixture\n\nCo-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com"],
                       cwd=root, env=env, check=True, capture_output=True)
        source = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, env=env, text=True,
                                capture_output=True, check=True).stdout.strip()
        (root / "copilot.ts").write_text("const copilot = 1;\n")
        subprocess.run(["git", "add", "copilot.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "copilot fixture"], cwd=root,
                       env={**env, "GIT_AUTHOR_EMAIL": "198982749+copilot-swe-agent@users.noreply.github.com"},
                       check=True, capture_output=True)
        agents = [
            ("trae.ts", "TRAE", "Generated-By: TRAE SOLO 2.0"),
            ("codex.ts", "OpenAI Codex", "Co-authored-by: Codex <noreply@openai.com>"),
            ("qoder.ts", "Qoder", "Assisted-by: Qoder CLI 1.0"),
            ("openclaw.ts", "OpenClaw", "Created-by: OpenClaw"),
            ("pi.ts", "Pi Coding Agent", "Generated-By: pi 0.63.2"),
            ("amp.ts", "Amp", "Co-authored-by: Amp <amp@ampcode.com>"),
        ]
        for path, provider, trailer in agents:
            (root / path).write_text(f"const {Path(path).stem} = 1;\n")
            subprocess.run(["git", "add", path], cwd=root, env=env, check=True)
            subprocess.run(["git", "commit", "-m", f"{provider} fixture\n\n{trailer}"],
                           cwd=root, env=env, check=True, capture_output=True)
        (root / "unmarked.ts").write_text("const unmarked = 1;\n")
        subprocess.run(["git", "add", "unmarked.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "[trae] discuss .trae .qoder .pi OpenClaw configuration"],
                       cwd=root, env=env, check=True, capture_output=True)
        (root / "subject.ts").write_text("const subject = 1;\n")
        subprocess.run(["git", "add", "subject.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "Co-authored-by: Claude"], cwd=root, env=env,
                       check=True, capture_output=True)
        subprocess.run(["git", "checkout", "main"], cwd=root, env=env, check=True, capture_output=True)
        subprocess.run(["git", "merge", "--no-ff", "-S", "ai-feature", "-m", "merge without AI trailer"],
                       cwd=root, env=env, check=True, capture_output=True)
        defaults = manifest["contributes"]["configuration"]["properties"]
        assert len(defaults) == 5
        assert all("default" in value and value.get("examples") and value.get("markdownDescription")
                   for value in defaults.values())
        assert "codeEvolutionLens.useDefaultAiRules" not in defaults
        assert "codeEvolutionLens.aiEmails" not in defaults
        assert not any(key.startswith("codeEvolutionLens.max") for key in defaults)
        keys = ["ref", "detectAiMessageMarkers", "aiProviders", "excludeGlobs"]
        config = {key: defaults[f"codeEvolutionLens.{key}"]["default"] for key in keys}
        config["packageRoots"] = []
        assert len(config["aiProviders"]) == 68
        assert len({provider["provider"].lower() for provider in config["aiProviders"]}) == 68
        schema = defaults["codeEvolutionLens.aiProviders"]
        assert len(schema["items"]["anyOf"]) == 5
        for description in [schema["description"], schema["markdownDescription"]]:
            assert all(field in description for field in schema["items"]["properties"])
            assert all(example in description for example in [
                "Co-Authored-By: Claude Sonnet 4.6 noreply@anthropic.com",
                "internal-codebot@company.example", "[trae] 修复缓存", "detectAiMessageMarkers: true"])
        sources = (extension / "PROVIDERS.md").read_text()
        assert all(f"| {provider['provider']} |" in sources for provider in config["aiProviders"])
        assert config["detectAiMessageMarkers"] is False
        assert "copilot-swe-agent" in next(p for p in config["aiProviders"] if p["provider"] == "GitHub Copilot")["emails"]
        assert all("@" not in name for provider in config["aiProviders"] for name in provider.get("emails", []))
        example = json.loads("\n".join(line for line in (extension / "code-evolution-lens.settings.example.jsonc")
                                      .read_text().splitlines() if not line.lstrip().startswith("//")))
        assert example == {key: value["default"] for key, value in defaults.items()}
        worker_data = {"root": str(root), "config": config, "cutoff": cutoff,
                       "directory": str(base / "cache"), "wasm": str(extension / "dist" / "sql-wasm.wasm")}
        script = """
const { Worker } = require('node:worker_threads');
const worker = new Worker(process.argv[1], { workerData: JSON.parse(process.argv[2]), execArgv: [] });
/** 发布前批准 worker 切换 active，只输出最终结算供脚本断言。 */
worker.on('message', message => {
  if (message.type === 'commit-ready') {
    worker.postMessage(process.argv[3] === 'cancel' ? 'cancel' : 'commit');
    if (process.argv[3] === 'commit-then-cancel') worker.postMessage('cancel');
  }
  if (message.type === 'complete' || message.type === 'error') console.log(JSON.stringify(message));
});
worker.on('error', error => { console.error(error.message); process.exitCode = 1; });
"""
        result = subprocess.run(["node", "-e", script, str(extension / "dist" / "worker.js"), json.dumps(worker_data)],
                                cwd=base, env=env, text=True, capture_output=True, check=True, timeout=30)
        response = json.loads(result.stdout)
        assert response["type"] == "complete", response
        assert response["snapshot"]["schema"] == 2
        assert len(response["snapshot"]["entities"]) == 11
        assert len(response["snapshot"]["births"]) == 10
        assert response["snapshot"]["attributionRuleVersion"].startswith("ai-v8:")
        source_birth = next(b for b in response["snapshot"]["births"] if b["path"] == "source.ts")
        copilot_birth = next(b for b in response["snapshot"]["births"] if b["path"] == "copilot.ts")
        assert source_birth["attribution"] == "ai"
        assert source_birth["origin"]["kind"] == "inherited"
        assert source_birth["origin"]["commit"] == source
        assert source_birth["commit"] != source
        assert source_birth["sourceAuthor"]["name"] == "VSIX Fixture"
        assert len(source_birth["sourceAuthor"]["id"]) == 64
        activity = response["snapshot"]["activity"]
        assert len(activity) == 1 and activity[0]["merge"]
        assert len(activity[0]["files"]) == 10
        assert sum(file["added"] for file in activity[0]["files"]) == 10
        assert sum(file["deleted"] for file in activity[0]["files"]) == 0
        assert "fixture@example.test" not in json.dumps(response["snapshot"])
        assert copilot_birth["attribution"] == "ai"
        assert any(signal["provider"] == "GitHub Copilot" and signal["kind"] == "author-email"
                   for signal in copilot_birth["attributionSignals"])
        for path, provider, trailer in agents:
            birth = next(b for b in response["snapshot"]["births"] if b["path"] == path)
            assert birth["attribution"] == "ai", (path, birth)
            assert birth["origin"]["kind"] == "inherited"
            assert birth["commit"] != birth["origin"]["commit"]
            assert any(signal["provider"] == provider for signal in birth["attributionSignals"]), (provider, birth)
        unmarked = next(b for b in response["snapshot"]["births"] if b["path"] == "unmarked.ts")
        assert unmarked["attribution"] == "unmarked" and not unmarked["attributionSignals"]
        subject = next(b for b in response["snapshot"]["births"] if b["path"] == "subject.ts")
        assert subject["attribution"] == "unmarked" and not subject["attributionSignals"]
        assert response["snapshot"]["attributionConfigured"]
        assert any(signal["provider"] == "Claude Code" and signal["kind"] == "coauthor-name"
                   for signal in source_birth["attributionSignals"])
        assert response["snapshot"]["work"]["commits"] == 3
        assert response["snapshot"]["work"]["objectBytes"] < 1024
        assert next(file for file in response["snapshot"]["files"] if file["path"] == "old-generated.ts")["lines"] == []
        assert len(list((base / "cache").glob("*.active"))) == 1
        active = next((base / "cache").glob("*.active"))
        previous_pointer = active.read_text()
        result = subprocess.run(["node", "-e", script, str(extension / "dist" / "worker.js"),
                                 json.dumps(worker_data), "cancel"], cwd=base, env=env, text=True,
                                capture_output=True, check=True, timeout=30)
        assert json.loads(result.stdout)["type"] == "error"
        assert active.read_text() == previous_pointer
        result = subprocess.run(["node", "-e", script, str(extension / "dist" / "worker.js"),
                                 json.dumps(worker_data), "commit-then-cancel"], cwd=base, env=env,
                                text=True, capture_output=True, check=True, timeout=30)
        approved = json.loads(result.stdout)
        assert approved["type"] == "complete"
        assert active.read_text().endswith(f"-{approved['snapshot']['id']}.sqlite")
        assert not list((base / "cache").glob("*.tmp-*"))
        (root / "source.ts").write_text("const fixture = 2;\n")
        subprocess.run(["git", "add", "source.ts"], cwd=root, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "update fixture"], cwd=root, env=env, check=True, capture_output=True)
        shallow = base / "浅克隆 空格"
        subprocess.run(["git", "clone", "--depth=1", root.as_uri(), str(shallow)],
                       cwd=base, env=env, check=True, capture_output=True)
        worker_data.update(root=str(shallow), directory=str(base / "shallow-cache"))
        result = subprocess.run(["node", "-e", script, str(extension / "dist" / "worker.js"), json.dumps(worker_data)],
                                cwd=base, env=env, text=True, capture_output=True, check=True, timeout=30)
        failure = json.loads(result.stdout)
        assert failure["type"] == "error" and failure["code"] == "shallow-clone", failure
        assert "git fetch --unshallow" in failure["message"]
        assert not list((base / "shallow-cache").glob("*.active"))
        subprocess.run(["git", "fetch", "--unshallow"], cwd=shallow, env=env, check=True, capture_output=True)
        check = subprocess.run(["git", "rev-parse", "--is-shallow-repository"], cwd=shallow, env=env,
                               text=True, capture_output=True, check=True)
        assert check.stdout.strip() == "false"
        result = subprocess.run(["node", "-e", script, str(extension / "dist" / "worker.js"), json.dumps(worker_data)],
                                cwd=base, env=env, text=True, capture_output=True, check=True, timeout=30)
        recovered = json.loads(result.stdout)
        assert recovered["type"] == "complete", recovered
        assert len(recovered["snapshot"]["events"]) == 1
        assert len(list((base / "shallow-cache").glob("*.active"))) == 1
        print(f"PASS VSIX {manifest['version']}: exact-case methodology commands in three languages, clean resources, signed mainline and source commits, separated trailers, publication approval and cancellation, five settings, 68 providers, bundled WASM, SQLite, preserved merge attribution, window-external 65064-line history, shallow clone recovery")


if __name__ == "__main__":
    main()
