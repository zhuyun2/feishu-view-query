/**
 * 降级实现：`localStorage` 配置存取（设计文档 §6.3 / §12）。
 *
 * ⚠️ 明示：**不满足跨用户共享**（仅本机本浏览器可见）。启用时 UI 必须出常驻提示条。
 * key 采用 `cbv:config:{appId}:{viewId}`，补 appId 维度避免多应用串扰。
 *
 * F5（更高版本只读）：`load` 记住每个 viewId 的 `unsupportedNewer`；该状态下 `save`
 * 直接拒绝，避免把更高版本客户端写入的配置降级覆盖。
 */
import { degradedConfigKey } from '@/constants';
import { formatError } from '@/utils/errorText';
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

/** 存储适配器（真实实现取 window.localStorage，测试可注入内存实现） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 默认取浏览器 localStorage；SSR / 受限环境返回 null */
export function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // 隐私模式等场景下访问 localStorage 可能抛错
  }
  return null;
}

export class LocalStorageConfigRepository implements ConfigRepository {
  private readonly storage: StorageLike;
  private readonly appId: string;
  /** F5：读到的更高版本（只读）视图集合 */
  private readonly readOnlyViews = new Set<string>();

  constructor(storage: StorageLike, appId = 'unknown') {
    this.storage = storage;
    this.appId = appId;
  }

  getSchemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  /** 本实现自身即「降级介质」，相对于自身不存在进一步降级 → 恒为 false。 */
  isDegraded(): boolean {
    return false;
  }

  private key(viewId: string): string {
    return degradedConfigKey(this.appId, viewId);
  }

  async load(viewId: string): Promise<LoadResult> {
    try {
      const raw = this.storage.getItem(this.key(viewId));
      const result = resolveLoadedConfig(raw, {
        viewId,
        source: 'localStorage',
        backup: (backupRaw) => {
          try {
            this.storage.setItem(`${this.key(viewId)}:backup:${Date.now()}`, backupRaw);
          } catch {
            /* 备份失败不影响主流程 */
          }
        },
      });
      // F5 / D1：记住只读状态（与订阅回调共用同一助手，语义一致）
      refreshReadOnlyFromPayload(this.readOnlyViews, viewId, result);
      return result;
    } catch (err) {
      return {
        config: null,
        degraded: true,
        // 介质读取失败 ≠ 数据损坏
        corrupted: false,
        // 本地存储自身就不可用 → 已无更低一级介质可退，不能说"已回退本地保存"
        reason: '本地存储读取失败，已使用默认排版，本次修改无法保存。',
        unsupportedNewer: false,
        source: 'localStorage',
        error: `localStorage-read-failed: ${formatError(err)}`,
      };
    }
  }

  async save(viewId: string, config: CardViewConfig): Promise<SaveResult> {
    // F5：更高版本只读 → 直接拒绝，绝不覆盖较新数据
    if (this.readOnlyViews.has(viewId)) {
      return { ok: false, reason: 'unsupported-newer-readonly', error: UNSUPPORTED_NEWER_SAVE_MESSAGE };
    }

    const serialized = serializeConfig(config);
    if (serialized.tooLarge) {
      return { ok: false, tooLarge: true, reason: 'too-large', error: sizeHint(serialized.bytes) };
    }
    try {
      this.storage.setItem(this.key(viewId), serialized.raw);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: 'write-failed',
        error: `localStorage-write-failed: ${formatError(err)}`,
      };
    }
  }

  subscribe(viewId: string, cb: (config: CardViewConfig) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const key = this.key(viewId);
    const listener = (event: StorageEvent): void => {
      if (event.key !== key) return;
      const result = resolveLoadedConfig(event.newValue, { viewId, source: 'localStorage' });
      // P2-2（架构裁定 §0.2 · Q6）：按新载荷的 schemaVersion 刷新只读标记。
      // ⚠️ 仅在能确定版本时改动（损坏/空值/迁移失败 → 保持原标记，绝不误解锁）。
      refreshReadOnlyFromPayload(this.readOnlyViews, viewId, result);
      if (result.config) cb(result.config);
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }

  async remove(viewId: string): Promise<boolean> {
    this.readOnlyViews.delete(viewId);
    try {
      this.storage.removeItem(this.key(viewId));
      return true;
    } catch {
      return false;
    }
  }
}
