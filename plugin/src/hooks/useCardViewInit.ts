/**
 * 视图初始化编排（T02 完成标准：能 console 出 tableId / viewId / 字段元数据；
 * 能判断编辑权限；主题 token 注入生效）。
 *
 * Boot → Loading → Browse/Error 由 App.tsx 依 store.status 分发。
 */
import { useCallback, useEffect, useRef } from 'react';
import { FIRST_BATCH_PAGE_SIZE } from '@/constants';
import { selectConfigRepository } from '@/config/factory';
import { resolveConfigOnLoad } from '@/config/provision';
import { SdkRecordDataSource } from '@/data/SdkRecordDataSource';
import { toFieldMetaLite } from '@/fields/fieldTypes';
import { canEditTable, getFieldMetaList, getTable, getViewMetaList } from '@/sdk/base';
import { getEnvSnapshot } from '@/sdk/env';
import { useViewStore } from '@/state/ViewStore';
import { logError, logInfo } from '@/utils/log';

export interface CardViewInitResult {
  /** 手动重载（清缓存 → 取首页） */
  reload: () => Promise<void>;
}

export function useCardViewInit(): CardViewInitResult {
  const startedRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    const store = useViewStore.getState();
    store.setStatus('loading');
    try {
      const env = await getEnvSnapshot();
      const table = await getTable(env.tableId);
      const rawMetas = await getFieldMetaList(env.tableId);
      const fields = rawMetas.map(toFieldMetaLite).filter((meta) => meta.id !== '');
      const viewMetas = await getViewMetaList(env.tableId);
      const viewName = viewMetas.find((meta) => meta.id === env.viewId)?.name;

      // T02 验收：打印上下文与字段元数据
      logInfo('init', `tableId=${env.tableId} viewId=${env.viewId}`, {
        tableId: env.tableId,
        viewId: env.viewId,
        fields: fields.map((field) => `${field.name}(${field.type})`),
      });

      const selection = selectConfigRepository(env.appId);
      const load = await selection.repository.load(env.viewId);
      const resolved = resolveConfigOnLoad(load, {
        viewId: env.viewId,
        tableId: env.tableId,
        viewName,
        fields,
        updatedBy: env.userId,
      });

      const canEditConfig = await canEditTable();

      const dataSource = new SdkRecordDataSource(table, env.viewId);
      const firstPage = await dataSource.loadPage({
        viewId: env.viewId,
        pageSize: FIRST_BATCH_PAGE_SIZE,
      });
      const total = await dataSource.count();

      useViewStore.getState().applyInit({
        env,
        viewName: viewName ?? '未命名视图',
        fields,
        config: resolved.config,
        configSource: load.config ? load.source : 'default',
        degraded: selection.degraded || resolved.degraded,
        degradedReason: selection.degraded ? selection.reason : '',
        unsupportedNewer: resolved.unsupportedNewer,
        provisionedFromTemplate: resolved.config.meta.provisionedFromTemplate === true || resolved.provisioned,
        copyScenario: resolved.copyScenario,
        canEditConfig,
        dataSource,
        repository: selection.repository,
        firstPage,
        total,
        // ⭐ 数据损坏（有 error 且无可用配置）与「介质降级」分开：前者不切介质，仅回退默认模板 + 备份
        configCorrupted: resolved.degraded && load.config === null,
      });
      useViewStore.getState().setStatus('browse');
    } catch (err) {
      logError('init', err);
      useViewStore
        .getState()
        .setError(err instanceof Error ? err.message : '初始化失败，请重试');
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [run]);

  const reload = useCallback(async () => {
    await run();
  }, [run]);

  return { reload };
}
