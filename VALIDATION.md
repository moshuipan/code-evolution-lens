# code-evolution-lens 验证记录

## 0.3.4 — 2026-11-10

### 范围

扩展包、展示名称、命令、设置、视图、历史 URI、脚本、双语文档统一使用 `code-evolution-lens`。发布者及版权署名使用 `luorAx`，第三方许可保留。清理历史 VSIX、内部报告、分享缓存和一次性脚本；README 加入三张脱敏演示截图。

### 缺陷分析

本轮未确认新增功能缺陷。设置使用 `codeEvolutionLens` 前缀；安装后手动刷新索引，自定义数组及指标口径见双语 README。

### 测试维护

新增测试函数 0 项，保留全部 123 项回归。同步配置、双语清单和控制器中的名称断言，在已有配置用例中核对包名称与展示名称；测试临时目录前缀同步更名。

相关范围先后通过：配置 9 项、双语清单 4 项、UI／宿主 32 项。完整回归通过后，最终面板品牌修改再次通过 32 项 UI／宿主回归。

### 验证结果

- `npm run check`、`npm run build`：通过。
- `npm test`：123 项通过，0 失败、0 跳过、0 取消，52,725.64675 ms。
- `npm audit`：0 个漏洞。
- `npm run package`、`python3 scripts/smoke-vsix.py`：通过。
- 第一次包冒烟在 README 原始字节比较处失败：`vsce` 根据仓库元数据转换相对链接。检查已按预期 GitHub 链接转换校验主 README／CHANGELOG，其余资源仍逐字节比较，重新打包后的冒烟通过。
- 实际 VSIX 中核验三种语言的文档入口、五项设置、68 类 Provider、签名提交解析、归因声明边界、宿主批准与取消、SQLite、合并来源和浅克隆恢复。
- 内置浏览器通过演示仓库 → `src` → `server` → 文件下钻，展开 Provider 详情及修改归因依据；未发现控制台错误。截图使用临时 Git 演示历史，非业务仓库。
- 三张 PNG 已逐张目视检查；仓库标识及提交标识使用不透明像素覆盖，作者、邮箱、私人路径未进入截图。PNG 仅含 `IHDR`、`IDAT`、`IEND`，双语 README 的 6 个图片引用均有效。
- 候选提交内容未发现私人路径、内部仓库地址、访问令牌或私钥。依赖、生成 bundle、VSIX 与本地凭据由 `.gitignore` 排除；没有超过 1 MiB 的候选文件。
- 测试维护流程 Step1—Step6 已完成，`utree flush` 退出 0。

安装包：`code-evolution-lens-0.3.4.vsix`，26 个文件，1,927,458 字节。

SHA-256：`bdd80a1ea3301e9503385f6a515be861b007e1ec7acd71ebfabb70f28fff1364`。

上述结果包含真实 Git、DOM 和实际 bundle 验证；真实 VS Code 及 SSH／容器／WSL 中的原生安装、diff 和行标记仍需对应宿主验收。本轮未创建 Git 提交、推送或发布 Marketplace。
