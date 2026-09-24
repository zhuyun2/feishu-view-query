/**
 * 计数信号量（并发闸门）——通用工具。
 *
 * ⭐ 语义与 `doc/template/buildData.ts` 内的同名实现**完全一致**（那里为不破坏既有单测而保留
 *    内联副本；本模块是供新代码复用的抽取版本，两处行为对齐：动态任务流上精确限流、
 *    名额转交避免「先加后被抢占」的瞬时超限）。
 *
 * 为什么不用「分批 `Promise.all`」：关联记录的行数在运行期才知道，分批无法静态切分；
 * 信号量能在**动态任务流**上精确限流。
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    const normalized = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 0;
    this.available = normalized >= 1 ? normalized : 1;
  }

  /** 取得一个名额（无空位则排队） */
  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolveSlot) => {
      this.queue.push(resolveSlot);
    });
  }

  /** 归还名额（若有排队者，直接转交，避免「先加后被抢占」的瞬时超限） */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  /** 在名额约束下执行任务：`await sem.run(() => read(...))` */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

export default Semaphore;
