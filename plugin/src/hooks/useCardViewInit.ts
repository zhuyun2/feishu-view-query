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
import { resolveTotalInfo } from '@/data/RecordDataSource';
import { sanitizeFilterConfig } from '@/filter/sanitize';
import { toFieldMetaLite } from '@/fields/fieldTypes';
import { canEditTable, getFieldMetaList, getTable, getViewMetaList } from '@/sdk/base';
import { getEnvSnapshot } from '@/sdk/env';
import { useViewStore } from '@/state/ViewStore';
import { useUiStore } from '@/state/UiStore';
import { logError, logInfo } from '@/utils/log';
import { formatError } from '@/utils/errorText';
import { collectErrorShape, collectHostProbe } from '@/utils/hostProbe';

export interface CardViewInitResult {
  /** 手动重载（清缓存 → 取首页） */
  reload: () => Promise<void>;
}

export function useCardViewInit(): CardViewInitResult {
  const startedRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    const store = useViewStore.getState();
    store.setStatus('loading');
    // 真机诊断（E2E 缺陷）：记录「死在哪一步」，失败时随错误一起上报，
    // 避免生产环境只剩一句无信息量的兜底文案。
    let step = 'boot';
    let tableId: string | undefined;
    let viewId: string | undefined;
    try {
      step = 'getEnvSnapshot';
      const env = await getEnvSnapshot();
      tableId = env.tableId;
      viewId = env.viewId;

      step = 'getTable';
      const table = await getTable(env.tableId);

      step = 'getFieldMetaList';
      const rawMetas = await getFieldMetaList(env.tableId);
      const fields = rawMetas.map(toFieldMetaLite).filter((meta) => meta.id !== '');

      step = 'getViewMetaList';
      const viewMetas = await getViewMetaList(env.tableId);
      const viewName = viewMetas.find((meta) => meta.id === env.viewId)?.name;

      // T02 验收：打印上下文与字段元数据
      logInfo('init', `tableId=${env.tableId} viewId=${env.viewId}`, {
        tableId: env.tableId,
        viewId: env.viewId,
        fields: fields.map((field) => `${field.name}(${field.type})`),
      });

      step = 'configLoad';
      const selection = selectConfigRepository(env.appId);
      const load = await selection.repository.load(env.viewId);
      const resolved = resolveConfigOnLoad(load, {
        viewId: env.viewId,
        tableId: env.tableId,
        viewName,
        fields,
        updatedBy: env.userId,
      });

      step = 'canEditTable';
      const canEditConfig = await canEditTable();

      const dataSource = new SdkRecordDataSource(table, env.viewId);

      step = 'loadPage';
      const firstPage = await dataSource.loadPage({
        viewId: env.viewId,
        pageSize: FIRST_BATCH_PAGE_SIZE,
      });

      step = 'count';
      // ⭐ 总数优先取自首页响应的 total（零额外请求、天然尊重视图可见范围）；
      //    取不到时 totalKnown=false，让文案层退化为「已加载 L 条」而非谎报「共 0 条」。
      const { total, totalKnown } = await resolveTotalInfo(dataSource, firstPage);

      useViewStore.getState().applyInit({
        env,
        viewName: viewName ?? '未命名视图',
        fields,
        config: resolved.config,
        configSource: load.config ? load.source : 'default',
        degraded: selection.degraded || resolved.degraded,
        // 介质降级时 reason 必有值：优先构造期选型原因，其次运行期降级分支的原因。
        // （R8 横幅会陈述存储位置，落到空值就会用兜底文案，可能与实际不符。）
        degradedReason: selection.degraded ? selection.reason : (load.reason ?? ''),
        // 「数据损坏」与「介质降级」分开透传：Banner 据此二选一，避免陈述错误事实。
        corrupted: load.corrupted === true,
        unsupportedNewer: resolved.unsupportedNewer,
        // D4 首开提示：仅在「真的是首次生成」时提示。
        // 真实损坏（corrupted）时配置是「读出来的数据坏了、回退默认模板」，
        // 并非「首次打开，已按模板生成」——此时显示 D4 会与损坏条自相矛盾，
        // 且会让人误以为一切正常、只是个新视图，从而错过真正的损坏提示。
        // 注意：这里只抑制**提示**，`resolved.config` 仍是默认模板（回退逻辑未被触及）。
        provisionedFromTemplate:
          (resolved.config.meta.provisionedFromTemplate === true || resolved.provisioned) &&
          load.corrupted !== true,
        copyScenario: resolved.copyScenario,
        canEditConfig,
        dataSource,
        repository: selection.repository,
        firstPage,
        total,
        totalKnown,
        // ⭐ 数据损坏（有 error 且无可用配置）与「介质降级」分开：前者不切介质，仅回退默认模板 + 备份。
        // 判定必须用 `corrupted` 而非 `degraded`：`degraded` 也涵盖 bridge 读取失败（网络/权限/超时），
        // 那属于「读不到」而非「数据坏了」，用它会把一次网络抖动误报成配置损坏。
        configCorrupted: load.corrupted === true && load.config === null,
      });
      useViewStore.getState().setStatus('browse');

      // ⭐ 装载持久化的筛选条件（§22.6 F3）：一次性从已解析配置流入 UiStore。
      // 之后 UiStore.filter 是唯一运行期真相，这里**不**再反向读写 ViewStore.config.filter
      // （否则会与 records 形成两份真相）。
      // 容错：`filter` 在旧配置中缺省（环境/persist 层已补默认），仍再净化一次以防手写脏数据；
      // 字段列表非空时顺便剔除「字段已被删除」的条件行。
      useUiStore.getState().replaceFilter(
        sanitizeFilterConfig(resolved.config.filter, fields.length > 0 ? { fields } : {}),
      );
    } catch (err) {
      // 关键点：飞书 SDK 拒绝 Promise 时抛的是普通对象（{ code, msg }），
      // 必须经 formatError 保留错误码与原因，否则整条信息会被丢弃。
      //
      // 真机 E2E 取证：所有 SDK 调用统一 timeout，怀疑是「插件↔宿主通信协议不匹配」
      // （handshake 协议 vs iframe-block 协议）。这个判断只能靠运行时宿主环境坐实，
      // 故在此把宿主取证与错误原始形态一并采集 —— 日志一份、UI 一份（用户可直接截图）。
      const probe = collectHostProbe();
      const shape = collectErrorShape(err);
      logError('init', err, { step, tableId, viewId, probe, shape });
      useViewStore.getState().setError(`${step}：${formatError(err)}`, step, { probe, shape });
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
