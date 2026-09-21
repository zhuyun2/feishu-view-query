/**
 * SDK 接入层：`bitable` 单例与只读封装（设计文档 §6.2 / §15 SDK 隔离）。
 *
 * ⚠️ D1 只读约束：本层**不暴露任何写接口**（不封装 setRecord / addRecord / deleteRecord
 * 等写 API），从架构上杜绝误用；权限基线为免审的 `bitable:app:readonly`。
 *
 * ⚠️ 分层：本层是依赖图最底层，**只向下依赖 SDK**，不 import 任何上层模块（config / fields /
 * data），避免反向依赖与运行时环。SDK 类型仅以 `import type` 引用（编译期擦除）。
 */
import { bitable } from '@lark-base-open/js-sdk';
import type { IFieldMeta, ITable, IView } from '@lark-base-open/js-sdk';
import { logError } from '@/utils/log';

/** 当前表格/视图上下文（`bitable.base.getSelection()` 的瘦身映射） */
export interface BaseSelection {
  baseId: string;
  tableId: string;
  viewId: string;
  fieldId?: string;
  recordId?: string;
}

/** 获取当前选中上下文；无 tableId/viewId 时抛错（调用方进入 Error 态） */
export async function getSelection(): Promise<BaseSelection> {
  const selection = (await bitable.base.getSelection()) as unknown as Partial<BaseSelection>;
  const tableId = typeof selection.tableId === 'string' ? selection.tableId : '';
  const viewId = typeof selection.viewId === 'string' ? selection.viewId : '';
  if (tableId === '' || viewId === '') {
    throw new Error('未能获取当前表格或视图上下文（tableId / viewId 缺失）');
  }
  return {
    baseId: typeof selection.baseId === 'string' ? selection.baseId : '',
    tableId,
    viewId,
    fieldId: typeof selection.fieldId === 'string' ? selection.fieldId : undefined,
    recordId: typeof selection.recordId === 'string' ? selection.recordId : undefined,
  };
}

/** 取表格句柄（只读用途） */
export async function getTable(tableId: string): Promise<ITable> {
  return bitable.base.getTableById(tableId);
}

/** 取视图句柄（只读用途） */
export async function getView(tableId: string, viewId: string): Promise<IView> {
  const table = await getTable(tableId);
  // 已核对 @lark-base-open/js-sdk@1.0.2：ITable 提供 getViewById(id)（无 getView）
  return table.getViewById(viewId);
}

/** 取字段元数据列表（只读；原始 SDK 类型由上层映射为 FieldMetaLite） */
export async function getFieldMetaList(tableId: string): Promise<IFieldMeta[]> {
  const table = await getTable(tableId);
  return table.getFieldMetaList();
}

/** 视图元数据（只读；供工具栏展示视图名 / 未来搜索对齐） */
export interface ViewMetaLite {
  id: string;
  name: string;
  type?: number;
}

export async function getViewMetaList(tableId: string): Promise<ViewMetaLite[]> {
  const table = await getTable(tableId);
  const metas = await table.getViewMetaList();
  return metas
    .map((meta) => {
      const raw = meta as unknown as { id?: unknown; name?: unknown; type?: unknown };
      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        name: typeof raw.name === 'string' ? raw.name : '',
        type: typeof raw.type === 'number' ? raw.type : undefined,
      };
    })
    .filter((meta) => meta.id !== '');
}

/* ===================== bridge 存储能力（供配置层消费） ===================== */

/** bridge 数据变更载荷 */
export interface BridgeDataChangePayload {
  key: string;
  value: unknown;
}

/** bridge 存储适配器契约（配置层依赖此抽象，实现由本层提供） */
export interface BridgeStore {
  getData(key: string): Promise<unknown>;
  setData(key: string, value: unknown): Promise<boolean>;
  /** 订阅数据变更；返回取消订阅函数（SDK 的 onDataChange 即返回 unsubscribe） */
  onDataChange(listener: (payload: BridgeDataChangePayload) => void): () => void;
}

type BridgeLike = {
  getData?: (key: string) => Promise<unknown>;
  setData?: (key: string, value: unknown) => Promise<boolean>;
  onDataChange?: (cb: (ev: unknown) => void) => unknown;
};

/**
 * 解析变更事件中的 keys。
 * SDK 实际形态：`onDataChange((ev: IEventCbCtx<DataChangeCtx>) => void)`，
 * 其中 `IEventCbCtx<T> = { data: T }`、`DataChangeCtx = { keys: string[] }`。
 * 事件**只给 keys、不给 value**，故需按 key 回读。
 */
function extractChangedKeys(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const outer = payload as Record<string, unknown>;
  const inner = (typeof outer.data === 'object' && outer.data !== null ? outer.data : outer) as Record<
    string,
    unknown
  >;
  const keys = inner.keys;
  if (Array.isArray(keys)) return keys.filter((key): key is string => typeof key === 'string');
  const single = inner.key;
  if (typeof single === 'string' && single !== '') return [single];
  return [];
}

/** bridge 能力探测：真实 bridge 可用时返回 true */
export function isBridgeAvailable(): boolean {
  try {
    const bridge = bitable.bridge as unknown as BridgeLike;
    return typeof bridge.getData === 'function' && typeof bridge.setData === 'function';
  } catch {
    return false;
  }
}

/**
 * 构造 bridge 存储适配器。
 * 若 bridge 不可用（本地演练 / 受限环境），返回 null，由配置层 factory 降级到 localStorage。
 */
export function getBridgeStore(): BridgeStore | null {
  if (!isBridgeAvailable()) return null;
  const bridge = bitable.bridge as unknown as BridgeLike;
  const getData = bridge.getData;
  const setData = bridge.setData;
  if (typeof getData !== 'function' || typeof setData !== 'function') return null;

  return {
    getData: (key: string) => getData.call(bitable.bridge, key) as Promise<unknown>,
    setData: (key: string, value: unknown) =>
      setData.call(bitable.bridge, key, value) as Promise<boolean>,
    onDataChange: (listener) => {
      if (typeof bridge.onDataChange !== 'function') return () => undefined;
      const dispose = bridge.onDataChange((event: unknown) => {
        for (const key of extractChangedKeys(event)) {
          void (getData.call(bitable.bridge, key) as Promise<unknown>)
            .then((value) => listener({ key, value }))
            .catch((err: unknown) => logError('sdk.bridge.onDataChange', err));
        }
      });
      return typeof dispose === 'function' ? (dispose as () => void) : () => undefined;
    },
  };
}

/* ===================== 权限探测 ===================== */

type PermissionProvider = {
  isEditable?: () => Promise<unknown>;
  getPermission?: (params: unknown) => Promise<unknown>;
};

/**
 * 判断当前用户是否具备「编辑该表格」的权限（PRD P0-08 / US-4 AC3）。
 *
 * SDK 实际提供（已核对 `@lark-base-open/js-sdk@1.0.2` 类型定义）：
 *  ① `bitable.base.isEditable(): Promise<boolean>` —— 首选；
 *  ② `bitable.base.getPermission({ entity: 'Table', param: { tableId }, type: 'editable' })` —— 次选；
 *  ③ 均不可用/抛错时保守返回 `true`（仅影响「配置入口是否可见」，不影响只读基线与数据安全）。
 */
export async function canEditTable(tableId?: string): Promise<boolean> {
  const base = bitable.base as unknown as PermissionProvider;

  try {
    if (typeof base.isEditable === 'function') {
      const editable = await base.isEditable();
      if (typeof editable === 'boolean') return editable;
    }
  } catch (err) {
    logError('sdk.permission.isEditable', err);
  }

  try {
    if (tableId && typeof base.getPermission === 'function') {
      const result = await base.getPermission({
        entity: 'Table',
        param: { tableId },
        type: 'editable',
      });
      if (typeof result === 'boolean') return result;
    }
  } catch (err) {
    logError('sdk.permission.getPermission', err);
  }

  return true;
}

/** 当前应用 appId（降级存储 key 需要；SDK 未提供该 API 时返回 'unknown'） */
export function getAppId(): string {
  try {
    const base = bitable.base as unknown as { getAppId?: () => string };
    if (typeof base.getAppId === 'function') {
      const appId = base.getAppId();
      if (typeof appId === 'string' && appId !== '') return appId;
    }
  } catch {
    /* 忽略 */
  }
  return 'unknown';
}

