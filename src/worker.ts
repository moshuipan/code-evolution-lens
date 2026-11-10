import { parentPort, workerData } from 'node:worker_threads';
import { buildIndex } from './indexer';
import { SnapshotStore } from './store';
import { Config } from './model';
import { RepositoryError } from './issues';
import { hash } from './rules';

/** worker 在候选构建结束前只发送进度，不向宿主暴露部分数据。 */
async function main(): Promise<void> {
  const data = workerData as { root: string; config: Config; cutoff: number; directory: string; wasm: string };
  const controller = new AbortController();
  let committing = false, approveCommit: (() => void) | undefined;
  parentPort?.on('message', message => {
    if (message === 'cancel' && !committing) controller.abort(new Error('索引已取消'));
    if (message === 'commit' && approveCommit) { committing = true; approveCommit(); approveCommit = undefined; }
  });
  /** 在最后一次 fsync 后等待宿主批准；获批后宿主与 worker 都不再强制取消。 */
  const requestCommit = () => new Promise<void>((resolve, reject) => {
    controller.signal.throwIfAborted();
    /** 等待批准期间取消仍拒绝切换 active 指针。 */
    const abort = () => { approveCommit = undefined; reject(controller.signal.reason); };
    approveCommit = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    parentPort!.postMessage({ type: 'commit-ready' });
  });
  let lastProgress = 0;
  try {
    const store = new SnapshotStore(data.directory, data.wasm);
    const previous = await store.load(hash(data.root)).catch(() => undefined);
    /** 阶段进度明确区分读取主线与追溯来源，避免重算被误认为卡住。 */
    const progress = (phase: string) => (done: number, total: number) => {
        if (Date.now() - lastProgress >= 100 || done === total) {
          lastProgress = Date.now(); parentPort?.postMessage({ type: 'progress', phase, done, total });
        }
      };
    const snapshot = await buildIndex(data.root, data.config, { cutoff: data.cutoff, signal: controller.signal,
      progress: progress('history'), originProgress: progress('origin') }, previous);
    await store.publish(snapshot, controller.signal, requestCommit);
    parentPort?.postMessage({ type: 'complete', snapshot });
  } catch (error) {
    parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : '索引失败',
      code: error instanceof RepositoryError ? error.code : undefined });
  } finally { parentPort?.close(); }
}
void main();
