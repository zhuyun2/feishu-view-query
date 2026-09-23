/**
 * 首选实现：基于 `bitable.bridge` 的配置存取（设计文档 §6.3 / §12 D9）。
 *
 * ⚠️ 关键约束：bridge 作用域是「同一文档 + 同一插件」级、**不是视图级**。
 * 同一文档可存在多个卡片视图，故存储 key 必须带 `viewId` 命名空间，否则会互相覆盖。
 *
 * F2（运行期介质降级）：bridge 只具备「构造期可用性探测」是不够的——运行期仍可能
 * 读写失败。本类在**读写失败时单向闭锁降级**到注入的 `fallback`（localStorage），
 * 之后 `load/save/subscribe` 一律走 fallback，且**不再回写 bridge**；`isDegraded()`
 * 供 UI 显示常驻提示条（R8）。
 *   · 触发条件：bridge 读写**抛异常**，或 `setData` 返回 false（介质故障）。
 *   · 数据损坏（checksum / JSON 非法 / 迁移失败）**不**触发介质切换——那属于数据问题，
 *     仍由 `resolveLoadedConfig` 走「回退默认 + 备份」语义，介质保持 bridge。
 *
 * F5（更高版本只读）：`load` 记住每个 viewId 的 `unsupportedNewer`；该状态下 `save`
 * 直接拒绝，避免把更高版本客户端写入的配置降级覆盖。
 *
 * 依赖注入 `BridgeStore`，既对接真实 SDK，也便于单测注入内存实现。
 */
import { backupKey, configKey } from '@/constants';
import type { BridgeStore } from '@/sdk/base';
import { formatError } from '@/utils/errorText';
import { logError } from '@/utils/log';
import {
  refreshReadOnlyFromPayload,
  resolveLoadedConfig,
  serializeConfig,
  UNSUPPORTED_NEWER_SAVE_MESSAGE,
  type ConfigRepository,
  type LoadResult,
  type SaveResult,
  sizeHint,
} from './ConfigRepository';
import { CURRENT_SCHEMA_VERSION, type CardViewConfig } from './types';

/** 供消费方便利引用（真实定义在 sdk/base.ts，依赖方向 config → sdk） */
export type { BridgeDataChangePayload, BridgeStore } from '@/sdk/base';

/** 构造选项（F2：运行期降级目标） */
export interface BridgeRepositoryOptions {
  /** 注入后，bridge 运行期失败时单向切入此介质；不注入则维持原有「返回降级结果」行为。 */
  fallback?: ConfigRepository;
}

interface ViewSubscription {
  callbacks: Set<(config: CardViewConfig) => void>;
  bridgeUnsub: (() => void) | null;
  fallbackUnsub: (() => void) | null;
}

export class BridgeConfigRepository implements ConfigRepository {
  private readonly store: BridgeStore;
  private readonly fallback?: ConfigRepository;
  /** F2：介质降级单向闭锁 */
  private degraded = false;
  /** F5：读到的更高版本（只读）视图集合 */
  private readonly readOnlyViews = new Set<string>();
  /** 每个 viewId 的订阅与当前生效介质的监听句柄 */
  private readonly subs = new Map<string, ViewSubscription>();

  constructor(store: BridgeStore, options: BridgeRepositoryOptions = {}) {
    this.store = store;
    this.fallback = options.fallback;
  }

  getSchemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /** F2：单向闭锁降级，并把既有订阅重新绑定到 fallback。 */
  private latchDegrade(): void {
    if (this.degraded) return;
    this.degraded = true;
    if (!this.fallback) return;
    for (const [viewId, sub] of this.subs) {
      this.unbindBridge(sub);
      this.bindMedium(viewId, sub);
    }
  }

  /** 以「已降级」语义委托 fallback 读取：强制 source=localStorage / degraded=true。 */
  private async loadViaFallback(viewId: string, cause?: unknown): Promise<LoadResult> {
    const fallback = this.fallback as ConfigRepository;
    const result = await fallback.load(viewId);
    // 降级原因同样可能来自 SDK 的普通对象，统一经 formatError 保留错误码
    const causeMessage = cause === undefined ? undefined : formatError(cause);
    return {
      ...result,
      source: 'localStorage',
      degraded: true,
      // 介质故障 ≠ 数据损坏：bridge 读不到不代表已存的配置坏了。
      // 只有 fallback 自身解析出「内容不可信」时才保留其 corrupted=true。
      corrupted: result.corrupted === true,
      // 可展示原因：此处确实已切到本地 fallback，陈述"仅本地保存"为真。
      reason:
        result.corrupted === true
          ? result.reason
          : '配置存储读取失败，已回退到本地保存，其他成员看不到你的排版。',
      error: result.error ?? causeMessage ?? 'bridge-degraded',
    };
  }

  async load(viewId: string): Promise<LoadResult> {
    if (this.degraded && this.fallback) {
      return this.loadViaFallback(viewId);
    }
    try {
      const raw = await this.store.getData(configKey(viewId));
      const result = resolveLoadedConfig(raw, {
        viewId,
        source: 'bridge',
        backup: (backupRaw) => {
          void this.store.setData(backupKey(viewId, Date.now()), backupRaw);
        },
      });
      // F5 / D1：记住只读状态（数据损坏 ≠ 介质故障，不触发 F2 切换）。
      // 与订阅回调共用同一助手，语义一致：升版加锁；有效 或 空值 解锁；损坏/迁移失败保持。
      refreshReadOnlyFromPayload(this.readOnlyViews, viewId, result);
      return result;
    } catch (err) {
      // 介质读取失败 → 闭锁降级
      this.latchDegrade();
      if (this.fallback) return this.loadViaFallback(viewId, err);
      return {
        config: null,
        degraded: true,
        // 介质读取失败（网络 / 权限 / 超时）≠ 数据损坏
        corrupted: false,
        // 无 fallback 可用 → 配置既不落 bridge 也不落本地，不能说"已本地保存"
        reason: '配置存储读取失败，且无可用本地存储，本次排版无法保存。',
        unsupportedNewer: false,
        source: 'bridge',
        error: `bridge-read-failed: ${formatError(err)}`,
      };
    }
  }

  async save(viewId: string, config: CardViewConfig): Promise<SaveResult> {
    // F2：已降级 → 一律走 fallback，不回写 bridge
    if (this.degraded && this.fallback) {
      return this.fallback.save(viewId, config);
    }

    // F5：更高版本只读 → 直接拒绝，绝不覆盖较新数据
    if (this.readOnlyViews.has(viewId)) {
      return { ok: false, reason: 'unsupported-newer-readonly', error: UNSUPPORTED_NEWER_SAVE_MESSAGE };
    }

    const serialized = serializeConfig(config);
    if (serialized.tooLarge) {
      // D9：保存前拦截 + 明确提示（非介质故障，不降级）
      return { ok: false, tooLarge: true, reason: 'too-large', error: sizeHint(serialized.bytes) };
    }

    try {
      const ok = await this.store.setData(configKey(viewId), serialized.raw);
      if (ok) return { ok: true };
      // 写入被拒（返回 false）→ 介质故障，尝试降级
      this.latchDegrade();
      if (this.fallback) return this.fallback.save(viewId, config);
      return { ok: false, reason: 'write-failed', error: 'bridge 写入返回 false' };
    } catch (err) {
      this.latchDegrade();
      if (this.fallback) return this.fallback.save(viewId, config);
      return {
        ok: false,
        reason: 'write-failed',
        error: `bridge-write-failed: ${formatError(err)}`,
      };
    }
  }

  subscribe(viewId: string, cb: (config: CardViewConfig) => void): () => void {
    let sub = this.subs.get(viewId);
    if (!sub) {
      sub = { callbacks: new Set(), bridgeUnsub: null, fallbackUnsub: null };
      this.subs.set(viewId, sub);
    }
    sub.callbacks.add(cb);
    this.bindMedium(viewId, sub);

    return () => {
      const current = this.subs.get(viewId);
      if (!current) return;
      current.callbacks.delete(cb);
      if (current.callbacks.size === 0) {
        this.unbindBridge(current);
        if (current.fallbackUnsub) {
          try {
            current.fallbackUnsub();
          } catch (err) {
            logError('config.bridge.subscribe', err);
          }
          current.fallbackUnsub = null;
        }
        this.subs.delete(viewId);
      }
    };
  }

  async remove(viewId: string): Promise<boolean> {
    this.readOnlyViews.delete(viewId);
    if (this.degraded && this.fallback) return this.fallback.remove(viewId);
    try {
      // bridge 无删除 API，写入 null 视为清除
      return await this.store.setData(configKey(viewId), null);
    } catch {
      return false;
    }
  }

  /** 按当前生效介质为某 viewId 建立底层监听（同一 viewId 只建一条）。 */
  private bindMedium(viewId: string, sub: ViewSubscription): void {
    if (this.degraded && this.fallback) {
      if (sub.fallbackUnsub) return;
      try {
        sub.fallbackUnsub = this.fallback.subscribe(viewId, (config) => this.emit(sub, config));
      } catch (err) {
        logError('config.bridge.bindFallback', err);
      }
      return;
    }
    if (sub.bridgeUnsub) return;
    try {
      sub.bridgeUnsub = this.store.onDataChange((payload) => {
        if (!payload || payload.key !== configKey(viewId)) return;
        const result = resolveLoadedConfig(payload.value, { viewId, source: 'bridge' });
        // P2-2（架构裁定 §0.2 · Q6）：按新载荷的 schemaVersion 刷新只读标记，
        // 实现「更高版本客户端把配置降版后，本端自动解除只读」，无需重新 load。
        // ⚠️ 仅在**能确定版本**时改动（损坏/空值/迁移失败 → 保持原标记，绝不误解锁）。
        refreshReadOnlyFromPayload(this.readOnlyViews, viewId, result);
        if (result.config) this.emit(sub, result.config);
      });
    } catch (err) {
      logError('config.bridge.bindBridge', err);
    }
  }

  private unbindBridge(sub: ViewSubscription): void {
    if (!sub.bridgeUnsub) return;
    try {
      sub.bridgeUnsub();
    } catch (err) {
      logError('config.bridge.unbindBridge', err);
    }
    sub.bridgeUnsub = null;
  }

  private emit(sub: ViewSubscription, config: CardViewConfig): void {
    for (const cb of [...sub.callbacks]) {
      try {
        cb(config);
      } catch (err) {
        logError('config.bridge.emit', err);
      }
    }
  }
}
