export interface RepositoryIssue {
  code: 'shallow-clone'; title: string; summary: string; explanation: string;
  steps: { text: string; command?: string }[];
  troubleshooting: string[];
}

const SHALLOW_CLONE: RepositoryIssue = {
  code: 'shallow-clone',
  title: '浅克隆：请先补全 Git 历史',
  summary: '浅克隆缺少完整历史：运行 git fetch --unshallow 后刷新索引；点击仓库查看步骤。',
  explanation: '返工率需要从主线起点追踪代码的新增与删改。浅克隆截断了历史，暂时无法建立索引。',
  steps: [
    { text: '在此仓库目录打开终端。SSH／容器／WSL 工作区请使用当前远端窗口的终端，先确认远程仓库地址。', command: 'git remote -v' },
    { text: '从默认远程仓库补全历史。此命令需要联网，可能下载较多数据；不会合并或切换当前分支。', command: 'git fetch --unshallow' },
    { text: '检查是否已补全；输出应为 false。', command: 'git rev-parse --is-shallow-repository' },
    { text: '回到此面板点击“刷新索引”，无需重载窗口。' },
  ],
  troubleshooting: [
    '默认远程不正确时，指定 git remote -v 中有完整历史的远程名，例如 git fetch --unshallow origin。',
    '没有远程地址时，先运行 git remote add origin <仓库URL>（替换占位符），或重新克隆完整仓库，不使用 --depth、--shallow-since、--filter。',
    '认证失败或连接超时时，先在同一远端终端解决仓库权限、SSH 密钥或网络连接，再重试 fetch。',
    '若提示仓库已经完整，直接执行检查命令并刷新；若检查仍为 true，上游可能也是浅克隆或未提供所需分支历史，需从完整上游补全。',
    '仅增加 --deepen 或补齐最近 90 天仍可能是浅克隆；当前索引需要完整主线。插件不会自动执行 fetch。',
  ],
};

/** 将可恢复原因跨 worker 传输，界面不依赖错误文案匹配。 */
export class RepositoryError extends Error {
  /** 绑定已知问题码，完整步骤由宿主和界面共用。 */
  constructor(readonly code: RepositoryIssue['code']) {
    super(SHALLOW_CLONE.summary);
    this.name = 'RepositoryError';
  }
}

/** 只接受已知问题码，避免把任意 worker 字段当作操作指令。 */
export function issueForCode(code: unknown): RepositoryIssue | undefined {
  return code === 'shallow-clone' ? SHALLOW_CLONE : undefined;
}

/** 从结构化错误提取修复指南；普通 Git 错误保留原有处理。 */
export function issueForError(error: unknown): RepositoryIssue | undefined {
  return error instanceof RepositoryError ? issueForCode(error.code) : undefined;
}
