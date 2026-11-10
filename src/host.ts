import * as vscode from 'vscode';

/** 仅把当前扩展宿主的磁盘资源交给 Node；远端 URI 必须属于当前工作区或扩展。 */
export function isHostFileUri(uri: vscode.Uri, context: vscode.ExtensionContext): boolean {
  if (uri.scheme === 'file') return true;
  if (!vscode.env.remoteName || context.extension.extensionKind !== vscode.ExtensionKind.Workspace
    || uri.scheme !== 'vscode-remote') return false;
  return [context.extensionUri, ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)]
    .some(base => base.scheme === uri.scheme && base.authority === uri.authority);
}

/** 检查实际执行位置，不把“窗口连接了远端”等同于“不支持”。 */
export function activationProblem(context: vscode.ExtensionContext): string | undefined {
  if (!vscode.workspace.isTrusted) return '请先信任当前工作区，再重载窗口。';
  if (vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.Workspace)
    return '请在当前 SSH／容器／WSL 窗口的扩展管理中，将 code-evolution-lens 安装到远端，然后重载窗口。Git 分析需要在仓库所在宿主运行。';
  if (!context.storageUri) return '请打开一个 Git 仓库根目录，再重载窗口。';
  if (!isHostFileUri(context.storageUri, context))
    return '当前缓存目录不在工作区宿主的磁盘上；请将扩展安装到仓库所在宿主后重载窗口。';
  return undefined;
}
