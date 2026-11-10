# 发布 code-evolution-lens

扩展名称为 `code-evolution-lens`，`package.json` 中的 Publisher ID 为 `luorAx`，完整扩展 ID 为 `luorAx.code-evolution-lens`。发布前须在 Marketplace 创建或选择对应 Publisher ID，并确认当前账号有其管理权限。

## 构建与验收

使用 Node.js 22 或更新版本、Git，在项目根目录执行：

```sh
npm ci
npm run check
npm run build
npm test
npm audit
npm run package
python3 scripts/smoke-vsix.py
```

安装生成的 `code-evolution-lens-<版本>.vsix`，在真实 VS Code 验证：刷新索引、五项设置、中文／英文统计口径、README 图片、历史 diff 和行标记。需要支持 SSH／容器／WSL 时，也要在对应宿主验收。浏览器预览和模拟宿主冒烟不代替原生验收。

## 上传 Marketplace

1. 打开 [Marketplace 发布管理门户](https://marketplace.visualstudio.com/manage)，登录有权限的账号，创建或选择 Publisher ID `luorAx`，确认其与 `package.json.publisher` 一致。
2. 创建或选择 `code-evolution-lens` 扩展，上传本次验收的 VSIX。
3. 核对名称、版本、README、截图、许可和安装位置，完成发布。当前包是开发预览；需要预发布通道时，使用 `npx vsce package --pre-release --no-dependencies` 后重新验收实际包。
4. 从市场安装已发布版本再验证。预期页面为 `https://marketplace.visualstudio.com/items?itemName=luorAx.code-evolution-lens`；此地址不表示扩展已经发布。

也可配置受控的 CLI／CI 发布流程。凭据在本机或 CI secret 中维护；不要写入项目文件、命令示例、截图或日志。

## Git 与 VSIX 的文件范围

Git 保留源码、测试、开发脚本、默认配置示例、锁文件、双语 README、截图、指标口径、来源与许可证。`media/trends.js` 与 `dist/` 由构建生成，依赖目录、VSIX、coverage 和本地凭据不提交。

VSIX 包含宿主／worker bundle、SQLite WASM、前端资源、配置示例和用户文档；排除源码、测试、构建脚本、开发验证记录、锁文件及本地凭据。发布前用 `npx vsce ls --no-dependencies` 核对实际文件清单。

`vsce` 根据 `package.json.repository` 将主 README 的相对图片／文档链接转换为 GitHub 地址。发布到 Marketplace 前，需将本版源码与脱敏截图提交并推送到该仓库，使在线链接可访问；本地 VSIX 包含同一组截图。

新增截图应使用演示历史；若包含仓库名、真实文件路径、作者、邮箱、提交标识、远端地址或终端内容，先裁剪或使用不透明像素遮盖，再导出无元数据 PNG。不要提交未脱敏原图。

官方参考：[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)、[Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)。
