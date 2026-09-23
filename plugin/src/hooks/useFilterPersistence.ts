/**
 * 筛选条件的**防抖持久化**（设计文档 §22.5.4 / §22.6 F5）。
 *
 * 语义分离（§22.10-⑤ 裁定）：
 *  - **即时生效**：编辑条件立刻写 `UiStore.filter`，卡片墙与状态行**同帧**收窄（由 F3 接线负责）；
 *  - **防抖持久化**：本 Hook 在筛选变更后 **300ms** 才把 `{ ...config, filter }` 经**既有保存链路**
 *    （`ViewStore.persistConfig` → `ConfigRepository.save`）落盘，避免「每次敲键盘都写 bridge」。
 *
 * 底层约束（逐条有单测锁定）：
 * 1. **写入条件**：`canEditConfig === true` 且 `unsupportedNewer === false`。
 *    ⚠️ 更高版本只读时**绝不允许**写回——那会把更高版本客户端写入的配置**降级覆盖**
 *    （项目已冻结口径，见 `BridgeConfigRepository.save` 的 `unsupported-newer-readonly` 分支）。
 * 2. **不重复写**：仅当「本地已编辑过（`filterTouched`）」或「当前 filter 与已持久化的
 *    `config.filter` 不同」时才写。否则初始化装载（F3 的 `replaceFilter`）会触发一次
 *    **无意义回写**——那不是用户的意图，也会与远端同步相互打架。
 * 3. **失败不致命**：保存失败（返回 not-ok 或抛异常）只记录错误日志，**绝不**抛给调用方，
 *    筛选本身（本地求值）完全不受影响。
 * 4. **不新建仓储**：payload 走 `ViewStore.persistConfig`（复用初始化时同一仓储实例，
 *    保留其运行期介质降级 / 只读状态），本 Hook 不持有任何存储句柄。
 *
 * 与 `useCardViewInit` 的分工：装载（`config.filter → UiStore.filter`）由 F3 完成，
 * 本 Hook **只负责反向写入**，绝不重复实现装载。
 */
import { useEffect } from 'react';
import type { CardViewConfig } from '@/config/types';
import type { FilterConfig } from '@/filter/types';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { stableStringify } from '@/utils/hash';
import { logError } from '@/utils/log';

/** 持久化防抖延时（ms）。设计文档 §22.5.4 建议 ≈500ms，实施期收敛为 300ms（响应更快、请求仍可控）。 */
export const FILTER_PERSIST_DEBOUNCE_MS = 300;

/** 持久化日志作用域（`utils/log` 唯一日志出口） */
export const FILTER_PERSIST_SCOPE = 'filter.persist';

/**
 * 两份 `FilterConfig` 是否**语义相等**（键序无关）。
 *
 * 复用 `stableStringify()`（与配置 checksum 同源）：它递归按 key 字典序排序，
 * 消除「同一对象不同创建顺序」造成的假不等——否则一次初始化装载就可能被判为「已变更」而回写。
 * `null` / `undefined` 统一归一为 `null`，故「无 filter」与「缺省 filter」等价。
 */
export function filterConfigEquals(
  a: FilterConfig | null | undefined,
  b: FilterConfig | null | undefined,
): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/**
 * 组装写入载荷：`{ ...config, filter }`（**整体替换 filter 分支**，其余配置原样保留）。
 * `config` 尚未就绪（`null` / 非对象）→ 返回 `null`（调用方据此跳过本次写入）。
 */
export function buildFilterPersistPayload(
  config: CardViewConfig | null | undefined,
  filter: FilterConfig,
): CardViewConfig | null {
  if (!config || typeof config !== 'object') return null;
  return { ...config, filter };
}

/** 单次持久化的准入条件（纯数据，便于单测直接断言，无需渲染） */
export interface FilterPersistGate {
  /** 是否有配置编辑权限 */
  canEditConfig: boolean;
  /** 是否读到更高版本（只读）——为真时**禁止**写回 */
  unsupportedNewer: boolean;
  /** 本地是否已编辑过筛选项（`UiStore.filterTouched`） */
  filterTouched: boolean;
  /** 当前运行期筛选（`UiStore.filter`） */
  current: FilterConfig;
  /** 已持久化的筛选（`ViewStore.config.filter`） */
  persisted: FilterConfig | null | undefined;
}

/**
 * 是否应当写回本次筛选变更（纯函数）。
 *
 * 顺序上**先**看权限与版本（硬门槛），**再**看去重（软门槛）：
 * 只读 / 更高版本时一律返回 `false`，与 `filterTouched` 无关。
 */
export function shouldPersistFilter(gate: FilterPersistGate): boolean {
  if (!gate.canEditConfig) return false;
  if (gate.unsupportedNewer) return false;
  if (gate.filterTouched) return true;
  return !filterConfigEquals(gate.current, gate.persisted);
}

/**
 * 挂载筛选防抖持久化。应在**常驻挂载**的宿主里调用一次（本项目中为 `Toolbar`）。
 *
 * @param delayMs 防抖延时（测试可注入较小值；缺省 {@link FILTER_PERSIST_DEBOUNCE_MS}）
 */
export function useFilterPersistence(delayMs: number = FILTER_PERSIST_DEBOUNCE_MS): void {
  const filter = useUiStore((state) => state.filter);
  const filterTouched = useUiStore((state) => state.filterTouched);
  const canEditConfig = useViewStore((state) => state.canEditConfig);
  const unsupportedNewer = useViewStore((state) => state.unsupportedNewer);

  useEffect(() => {
    // 硬门槛：只读 / 更高版本 → 连定时器都不排（用户改条件仍即时生效，只是不落盘）
    if (!canEditConfig || unsupportedNewer) return;

    const timer = window.setTimeout(() => {
      // ⚠️ 定时期间状态可能变化（权限被收回 / 远端写入更高版本配置）→ **在写入前二次校验**，
      //    绝不能凭「排定时器那一刻」的权限就写回。
      const view = useViewStore.getState();
      const current = useUiStore.getState().filter;
      const gate: FilterPersistGate = {
        canEditConfig: view.canEditConfig,
        unsupportedNewer: view.unsupportedNewer,
        filterTouched: useUiStore.getState().filterTouched,
        current,
        persisted: view.config?.filter ?? null,
      };
      if (!shouldPersistFilter(gate)) return;

      const payload = buildFilterPersistPayload(view.config, current);
      if (!payload) return;

      void view
        .persistConfig(payload)
        .then((result) => {
          if (!result.ok) {
            // 保存被拒（超限 / 只读 / 介质失败）→ 只记日志，不影响筛选使用
            logError(FILTER_PERSIST_SCOPE, result.error ?? result.reason ?? 'save-rejected');
          }
        })
        .catch((err: unknown) => {
          // 仓储抛异常（网络 / 权限 / SDK 普通对象）也必须被吞掉并记录，绝不冒泡到 React
          logError(FILTER_PERSIST_SCOPE, err);
        });
    }, delayMs);

    // 依赖变化（= 又一次编辑）→ 清掉上一个定时器，实现「连续变更只写最后一次」
    return () => window.clearTimeout(timer);
  }, [filter, filterTouched, canEditConfig, unsupportedNewer, delayMs]);
}
