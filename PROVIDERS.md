# 默认 Agent 规则的来源与识别边界

核对日期：2026-11-09。范围为参与代码生成、修改、提交或委托编程的 Agent 产品家族。产品持续新增，本清单不是“全球所有 Agent”的穷尽目录。

## 如何理解这份清单

- **名称声明**：产品名称经官方资料或社区工具目录核对，插件识别提交结尾显式写出的 `Co-Authored-By`／`Generated-By`／`Assisted-by`／`Created-by` 名称。名称规则不证明该产品会自动写入声明。
- **公开 Git 模式**：来源中出现具体邮箱或 trailer。可能来自源码、用户公开记录或社区检测目录，并不保证每个产品版本都默认开启。
- **社区扩展**：对应可安装扩展的输出，不能当成产品内置默认行为。
- `bracketTags` 是本插件接受的显式标题标签约定；新增产品的标签不代表厂商默认生成这种标题。该类启发式仍默认关闭。
- 未查到固定邮箱的产品不猜测邮箱。`noreply`、`agent` 等名称较通用；按当前用户要求忽略域名后，会扩大命中范围。只靠名称不能确定实际使用的工具、模型或完整生成过程。
- `.trae`、`.qoder`、`.pi` 等目录存在只说明可能配置过工具，不能据此给该仓库全部提交归因。本插件不把目录、安装状态、星标数或模型 API 配置作为归因证据。

## 来源

| 编号 | 来源 | 本次用途 |
|---|---|---|
| V | [Vulnetix 支持工具目录](https://docs.cli.vulnetix.com/docs/aibom/supported-tools/) | 社区产品目录及已公开的 Git 检测模式；不复制其中的环境／目录探测方式 |
| S | [skills-manager 支持 Agent 目录](https://github.com/jtianling/skills-manager/blob/HEAD/docs/supported-agents.md) | 交叉确认产品名称、Agent 家族；Universal 是协议兼容项，不当成产品 |
| T | [Trellis 多平台文档](https://docs.trytrellis.app/advanced/multi-platform.md) | 交叉确认 22 个平台及其他可用 Agent；不把其 hooks 当成提交签名 |
| P | [Pi 官方包目录中的 pi-co-authored-by](https://pi.dev/packages/pi-co-authored-by) | 社区扩展输出：`Generated-By: pi 0.63.2`，co-author 可能为模型名称 |
| R | [社区 Agent 归因实测](https://github.com/osolmaz/pi-must-win/blob/HEAD/docs/agent-attribution.md) | Claude、Cursor 和 Codex 的版本差异；其中观测日期为 2026-07-20 |
| C | [Codex baseline 源码](https://github.com/openai/codex/blob/main/codex-rs/git-utils/src/baseline.rs) | `Co-authored-by: Codex <noreply@openai.com>` 仅证明内部 baseline 用法，不宣称用户提交都会写入 |
| A | [Amp 公开线程](https://ampcode.com/threads/T-019c7344-1f23-716e-be3f-442b8d29a8a1) | 公开提交示例 `Co-authored-by: Amp <amp@ampcode.com>`；另与 V 的模式交叉核对 |
| D | [DeepSeek 官方 Deep Code 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode/) | 确认 Deep Code 产品名称及编程用途，不用于猜测邮箱 |
| L | [DeepSeek 官方 Langcli 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/langcli/) | 确认 Langcli 产品名称及编程用途，不用于猜测邮箱 |
| H | [Hermes Agent 快速开始](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) | 确认 Hermes Agent；另有 Grok Build、Claude Code 委托编程文档 |
| B | [Hermes 的 Blackbox 集成文档](https://hermes-agent.nousresearch.com/docs/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-blackbox) | 确认 Blackbox AI 多模型编程 CLI，不用于猜测邮箱 |
| G | [既有签名规则来源声明](THIRD_PARTY_NOTICES.md) | 原有 11 类规则的固定来源，继续保留其 MIT 许可 |

重点产品另核对了官方资料：

- [TRAE SOLO Agent](https://docs.trae.ai/ide/solo-coder)：确认编程 Agent 能力；未据此推断固定提交邮箱。
- [Qoder CLI 命令](https://docs.qoder.com/cli/cli-reference)、[设置参考](https://docs.qoder.com/cli/settings-reference)：确认产品及 commit 子命令；AI Code Metrics 服务不等于 Git message 中存在归因标记。
- [OpenClaw 文档](https://docs.openclaw.ai/)：确认个人 Agent、代码执行和编程 Agent 委托能力；用户 co-author 不等于 AI co-author。
- [Cline 概览](https://docs.cline.bot/cline-overview)、[Kiro 自主模式](https://kiro.dev/docs/web/autonomous-mode/)、[Gemini CLI 安装](https://geminicli.com/docs/get-started/installation/)：核对产品身份。
- [Qwen Code 设置文档](https://qwenlm.github.io/qwen-code-docs/pt-BR/users/configuration/settings/)：记录 `general.gitCoAuthor.commit` 及独立 Git notes。未查实固定邮箱字符串，所以新增规则不填邮箱，也不解析 Git notes。
- [Crush 官方 README](https://github.com/charmbracelet/crush/blob/main/README.md)：确认终端编程 Agent。

## 产品覆盖

以下 68 行与默认 provider 家族一一对应。Trae CN、CLI／IDE 的同一产品不另建重复家族。

| Provider | 依据 | 新增规则的说明 |
|---|---|---|
| Claude Code | G、R、V | 原有签名；名称也可能指使用 Claude 模型的其他工具 |
| GitHub Copilot | G、V | 原有签名；补充公开的 `copilot-swe-agent[bot]` 账号形式 |
| Cursor | G、R、V | 原有签名；补充公开记录中的 `cursoragent` |
| aider | G、V | 原有签名 |
| OpenAI Codex | G、C、R、V | 保留名称与已见邮箱；不把内部 baseline 签名说成当前用户提交默认 |
| Devin | G、V、T | 原有签名；补充公开 bot 账号形式 |
| Windsurf | G、V、S | 保留独立显式名称；不根据产品整合或改名推断旧提交来源 |
| Sourcegraph Cody | G、V | 原有签名 |
| Continue | G、V、S | 原有签名 |
| Sweep | G | 原有签名 |
| gpt-engineer | G | 原有签名；与 Lovable 的显式品牌分别记录 |
| TRAE | 官方、V、S、T | 名称声明；包含 TRAE、TRAE CN 和完整产品名称，不用泛化的 SOLO 单词 |
| Qoder | 官方、V、S、T | 名称声明，无固定邮箱假设 |
| OpenClaw | 官方、V、S | 名称声明；不会把被委托 Agent 的提交全部归为 OpenClaw |
| Pi Coding Agent | P、V、S、T | 支持扩展的 `Generated-By: pi <版本>`；不把扩展视为内置默认 |
| OpenCode | V、S、T | 名称声明 |
| Cline | 官方、V、S、T | 名称声明 |
| Roo Code | V、S | 名称声明 |
| Kilo Code | V、S、T | 名称声明 |
| Amp | A、V、S、T | 名称声明与公开邮箱 `amp` |
| Gemini CLI | 官方、V、S、T | 名称声明；没有固定邮箱假设 |
| Qwen Code | 官方、V、S | 名称声明；不解析其独立 Git notes |
| Kimi Code CLI | V、S、T | 名称声明 |
| Kiro | 官方、V、S、T | 名称声明 |
| Google Antigravity | V、S、T | 名称声明 |
| CodeBuddy | V、S、T | 名称声明 |
| Augment Code | V、S | 名称声明 |
| Goose | V、S | 名称声明 |
| Factory Droid | V、T | 公开 Git 模式 `factory-droid[bot]`；不是名称含 Droid 的所有项目 |
| OpenHands | V、S | 公开 Git 模式 `openhands`、`openhands-ai[bot]` |
| Junie | V、S | 名称声明 |
| Mistral Vibe | V、S | 名称声明；使用完整产品词，避免单独匹配 vibe |
| Crush | 官方、V、S | 名称声明 |
| Warp | V、S、T | 名称声明；公开 Git 模式包含 `oz-agent` |
| Amazon Q Developer | V | 名称声明及公开 bot 账号 `amazon-q-developer[bot]` |
| Google Jules | V | 名称声明及公开 bot 账号 `google-labs-jules[bot]` |
| JetBrains AI Assistant | V | 名称声明，使用完整产品名称 |
| Zed | V | 名称声明；不把所有 Zed 编辑器保存的代码自动归为 AI |
| Codebuff | V | 名称声明 |
| ForgeCode | V | 名称声明，避免泛化为 forge |
| Plandex | V | 名称声明；目录列出的提交前缀仅作为公开模式记录 |
| Refact.ai | V | 名称声明；不新增宽泛的 agent 邮箱 |
| Letta Code | V | 名称声明 |
| Replit Agent | V、S | 名称声明；不新增通用 no-reply 邮箱 |
| Bolt | V | 使用 bolt.new／Bolt Agent 等明确名称，避免普通 bolt 单词 |
| Lovable | V | 名称声明及公开 bot 账号 `gpt-engineer-app[bot]` |
| v0 | V | 名称声明及公开账号 `it+v0agent`、`v0[bot]` |
| Codegen | V | 名称声明及公开 bot 账号 `codegen-sh[bot]` |
| Tongyi Lingma | V | 名称声明 |
| iFlow CLI | V、S | 名称声明 |
| Zencoder | V、S | 名称声明 |
| Pochi | V、S | 名称声明 |
| Kode | V、S | 名称声明 |
| Neovate | V、S | 名称声明 |
| Cortex Code | V、S | 名称声明，使用完整产品词 |
| Mux | V、S | 名称声明 |
| Deep Agents | S、T | 名称声明，指编程 Agent 工具，不把所有 Agent 框架调用归为该产品 |
| Firebender | S、T | 名称声明 |
| Oh My Pi | T | 名称声明；短名称可能与 Pi 的声明重叠，多信号不代表多次计数 |
| Reasonix | T | 名称声明 |
| ZCode | T | 名称声明 |
| Grok Build | T、H | 名称声明，使用完整产品词，不把所有 Grok 模型调用归为该 Agent |
| Snow CLI | T | 名称声明，使用完整产品词 |
| DeepSeek Harness | T | 名称声明，不把所有 DeepSeek 模型调用归为该 Agent |
| Deep Code | D | 名称声明 |
| Langcli | L | 名称声明 |
| Hermes Agent | H | 名称声明，不根据委托关系推断具体代码的来源 |
| Blackbox AI | B | 名称声明 |

## 使用边界

名字在清单里但 Git 历史没有声明时，插件仍可能显示“未发现 AI 标记”；扩大名单不能恢复从未记录的 AI 使用事实。使用任意模型的 Agent 也可能只写模型名称，单靠 trailer 不能严格区分工具与模型。

所有新增名称和标签均按本插件既有字面规则匹配，正文／标题启发式开关保持默认关闭。资料无法证明存在的邮箱或固定消息字符串不加入默认规则。默认字段仍由 `package.json` 维护，子字段格式与旧配置兼容逻辑没有新增。
