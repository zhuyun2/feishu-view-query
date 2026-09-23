/**
 * 配置仓储选型工厂（设计文档 §6.3）。
 *
 * 运行时特性探测：bridge 可用 → BridgeConfigRepository（可跨用户共享）；
 * 否则 → LocalStorageConfigRepository（仅本机，UI 必须明示降级）。
 * 上层只依赖 `ConfigRepository` 接口，切换只发生在本文件一处。
 *
 * F2：bridge 可用时**仍注入 localStorage 作为运行期降级目标**——bridge 可能在运行期
 * 读写失败，届时 BridgeConfigRepository 会单向闭锁切到该 fallback（`isDegraded()` 为真）。
 */
import { isBridgeAvailable, getBridgeStore, getAppId } from '@/sdk/base';
import { logWarn } from '@/utils/log';
import { setTemplateBridgeStore } from '@/doc/template/storage';
import { BridgeConfigRepository } from './BridgeConfigRepository';
import type { ConfigRepository } from './ConfigRepository';
import { getDefaultStorage, LocalStorageConfigRepository } from './LocalStorageConfigRepository';

export type RepositoryKind = 'bridge' | 'localStorage';

export interface RepositorySelection {
  repository: ConfigRepository;
  kind: RepositoryKind;
  /** 是否处于降级（影响 UI 常驻提示条） */
  degraded: boolean;
  reason: string;
}

/** 选择配置仓储（带降级原因，供 UI 提示） */
export function selectConfigRepository(appId: string = getAppId()): RepositorySelection {
  const bridgeStore = getBridgeStore();
  const storage = getDefaultStorage();

  // ⭐ 把同一个 bridge 存储实例注册给「导入 docx 模板」的分块存储层（专用 key `cbv:tpl:*`）。
  //    这样模板块与配置共用同一介质，且 UI 组件无需 import SDK。无 bridge → 注册 null，
  //    写入侧据此走「小模板内联降级 / 大模板显式报错」，绝不把大模板静默塞进主配置。
  setTemplateBridgeStore(bridgeStore);

  if (bridgeStore) {
    // F2：即便首选 bridge，也准备 localStorage 作为运行期降级目标
    const fallback = storage ? new LocalStorageConfigRepository(storage, appId) : undefined;
    return {
      repository: new BridgeConfigRepository(bridgeStore, { fallback }),
      kind: 'bridge',
      degraded: false,
      reason: 'bridge 可用，配置可跨用户共享',
    };
  }

  if (storage) {
    logWarn('config.factory', 'bridge 不可用，降级到 localStorage（配置仅本机可见）');
    return {
      repository: new LocalStorageConfigRepository(storage, appId),
      kind: 'localStorage',
      degraded: true,
      reason: 'bridge 不可用，配置仅本地保存，其他成员看不到你的排版',
    };
  }

  // 极端兜底：两者都不可用时仍返回 localStorage 实现（写入会失败并返回 ok=false），
  // 保证上层拿到稳定对象、不因构造失败崩溃。
  logWarn('config.factory', 'bridge 与 localStorage 均不可用，配置将无法持久化');
  return {
    repository: new LocalStorageConfigRepository(
      {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      appId,
    ),
    kind: 'localStorage',
    degraded: true,
    reason: '当前环境无法持久化配置',
  };
}

/** 简化入口：只取仓储实例 */
export function createConfigRepository(appId?: string): ConfigRepository {
  return selectConfigRepository(appId).repository;
}

/** 便捷：bridge 是否可用（供 UI 判断） */
export { isBridgeAvailable };
