/**
 * 视图级状态（M1 轻量实现；M2 按 §9 扩展而非重写：保全 M1 的增量加载 / 分页状态）。
 *
 * 分层：表现层 → 状态层 → 领域层 → 数据层 → 配置层 → 接入层。
 * 表现层不得直接调 SDK，故数据源句柄与配置仓储句柄均由本层持有并暴露动作。
 */
import { create } from 'zustand';
import type { SdkRecord } from '@/sdk/port';
import { DEFAULT_PAGE_SIZE } from '@/constants';
import type { CardViewConfig } from '@/config/types';
import type { ConfigRepository, ConfigSource, SaveResult } from '@/config/ConfigRepository';
import type { EnvSnapshot } from '@/sdk/env';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { PageResult, RecordDataSource } from '@/data/RecordDataSource';
import { resolveTotalInfo } from '@/data/RecordDataSource';
import { appendUniqueRecords } from '@/data/recordPages';
import { logError } from '@/utils/log';
import { formatError } from '@/utils/errorText';
import type { ErrorShape, HostProbeResult } from '@/utils/hostProbe';

export type ViewStatus = 'boot' | 'loading' | 'browse' | 'error';

/**
 * 错误态携带的**诊断附件**（真机 E2E 取证用）。
 * 两者都只在 error 态写入、`applyInit` 成功时清空，成功路径不出现。
 */
export interface ErrorDiagnostics {
  /** 宿主环境取证（window.name / 是否在 iframe / 协议判定 …） */
  probe?: HostProbeResult | null;
  /** 错误值的原始形态（String(err) / typeof / instanceof Error） */
  shape?: ErrorShape | null;
}

/** 手动刷新时的页大小（沿用官方上限；增量加载用 DEFAULT_PAGE_SIZE） */
const REFRESH_PAGE_SIZE = 200;

export interface InitPayload {
  env: EnvSnapshot;
  viewName: string;
  fields: FieldMetaLite[];
  config: CardViewConfig;
  configSource: ConfigSource;
  degraded: boolean;
  degradedReason: string;
  /**
   * 是否为**数据损坏**（与 `degraded` 区分：`degraded` 还涵盖「介质读取失败」）。
   *
   * 供 Banner 判定「该显示『数据损坏』还是『介质降级 R8』」——后者会陈述存储位置，
   * 若在数据损坏时误显，等于向用户说了一句假话（数据其实还在 bridge）。
   */
  corrupted: boolean;
  /** 数据损坏（checksum / 非法 JSON / 迁移失败）→ 保持 source 不切介质，仅回退默认模板 + 备份 */
  configCorrupted: boolean;
  unsupportedNewer: boolean;
  provisionedFromTemplate: boolean;
  copyScenario: boolean;
  canEditConfig: boolean;
  dataSource: RecordDataSource;
  /** 配置仓储（保存配置时复用同一实例，保留其运行期降级 / 只读状态） */
  repository: ConfigRepository;
  firstPage: PageResult;
  total: number;
  /**
   * 总数是否可信（区分「真的是 0」与「取不到」）。
   * `false` 时文案层必须退化为「已加载 L 条」/「已在已加载的 L 条中筛选」，
   * **绝不**允许出现「共 N 条」「已在全部 N 条中筛选」这类谎报全量的措辞。
   */
  totalKnown: boolean;
}

export interface ViewState {
  status: ViewStatus;
  errorMessage: string | null;
  /** 失败发生在哪一步（真机诊断用；与 errorMessage 分开保存，便于 UI 分开展示） */
  errorStep: string | null;
  /** 宿主环境取证（仅 error 态；成功路径为 null） */
  errorProbe: HostProbeResult | null;
  /** 错误值原始形态（仅 error 态；成功路径为 null） */
  errorShape: ErrorShape | null;

  env: EnvSnapshot | null;
  viewName: string;
  fields: FieldMetaLite[];
  fieldsById: Record<string, FieldMetaLite>;

  records: SdkRecord[];
  total: number;
  /** 总数是否可信（见 `InitPayload.totalKnown`）；`false` 时文案层不得声称全量 */
  totalKnown: boolean;
  hasMore: boolean;
  nextPageToken: string | null;
  loadingMore: boolean;
  /**
   * 加载代号（generation）。每次 `refresh()` 或显式取消都会自增；
   * `loadMore` 每批前后校验，使**在途批次作废**——杜绝 refresh 与在途 loadAll 互相污染。
   */
  loadGeneration: number;
  /** 最近一次 `loadMore` 是否失败（供「加载全部」循环立即中止 + 提示，不静默继续） */
  loadMoreFailed: boolean;

  config: CardViewConfig | null;
  configSource: ConfigSource;
  degraded: boolean;
  degradedReason: string;
  /** 数据损坏标记（区别于「介质降级」`degraded`）——供 Banner 二选一判定 */
  corrupted: boolean;
  /** 数据损坏标记（区别于介质降级 `degraded`） */
  configCorrupted: boolean;
  unsupportedNewer: boolean;
  provisionedFromTemplate: boolean;
  copyScenario: boolean;
  canEditConfig: boolean;

  dataSource: RecordDataSource | null;
  repository: ConfigRepository | null;

  setStatus: (status: ViewStatus) => void;
  setError: (message: string, step?: string, diagnostics?: ErrorDiagnostics) => void;
  setLoadingMore: (loading: boolean) => void;
  applyInit: (payload: InitPayload) => void;
  appendRecords: (page: PageResult) => void;
  replaceRecords: (page: PageResult) => void;
  setConfig: (config: CardViewConfig, source: ConfigSource) => void;
  setCanEditConfig: (canEdit: boolean) => void;
  dismissProvisioned: () => void;
  refresh: () => Promise<void>;
  /** T10：滚动增量加载（取下一页；去重追加；并发 / 末页自动抑制） */
  loadMore: () => Promise<void>;
  /** 使在途批次作废（自增加载代号）；用于取消「加载全部」或条件重置、刷新 */
  bumpLoadGeneration: () => void;
  /** T11：保存配置（复用初始化时的仓储实例；成功后同步 `config`） */
  persistConfig: (config: CardViewConfig) => Promise<SaveResult>;
}

function indexFields(fields: FieldMetaLite[]): Record<string, FieldMetaLite> {
  const map: Record<string, FieldMetaLite> = {};
  for (const field of fields) map[field.id] = field;
  return map;
}

export const useViewStore = create<ViewState>((set, get) => ({
  status: 'boot',
  errorMessage: null,
  errorStep: null,
  errorProbe: null,
  errorShape: null,

  env: null,
  viewName: '',
  fields: [],
  fieldsById: {},

  records: [],
  total: 0,
  // 默认 true：与历史文案口径一致（既有测试基线）；真实「未知」由 `useCardViewInit` 依数据源显式写入
  totalKnown: true,
  hasMore: false,
  nextPageToken: null,
  loadingMore: false,
  loadGeneration: 0,
  loadMoreFailed: false,

  config: null,
  configSource: 'default',
  degraded: false,
  degradedReason: '',
  corrupted: false,
  configCorrupted: false,
  unsupportedNewer: false,
  provisionedFromTemplate: false,
  copyScenario: false,
  canEditConfig: false,

  dataSource: null,
  repository: null,

  setStatus: (status) => set({ status }),
  setError: (message, step, diagnostics) =>
    set({
      errorMessage: message,
      errorStep: step ?? null,
      errorProbe: diagnostics?.probe ?? null,
      errorShape: diagnostics?.shape ?? null,
      status: 'error',
    }),
  setLoadingMore: (loading) => set({ loadingMore: loading }),

  applyInit: (payload) =>
    set({
      env: payload.env,
      viewName: payload.viewName,
      fields: payload.fields,
      fieldsById: indexFields(payload.fields),
      config: payload.config,
      configSource: payload.configSource,
      degraded: payload.degraded,
      degradedReason: payload.degradedReason,
      corrupted: payload.corrupted === true,
      configCorrupted: payload.configCorrupted === true,
      unsupportedNewer: payload.unsupportedNewer,
      provisionedFromTemplate: payload.provisionedFromTemplate,
      copyScenario: payload.copyScenario,
      canEditConfig: payload.canEditConfig,
      dataSource: payload.dataSource,
      repository: payload.repository,
      records: payload.firstPage.records,
      hasMore: payload.firstPage.hasMore,
      nextPageToken: payload.firstPage.pageToken,
      total: payload.total,
      totalKnown: payload.totalKnown !== false,
      loadingMore: false,
      loadMoreFailed: false,
      errorMessage: null,
      errorStep: null,
      errorProbe: null,
      errorShape: null,
    }),

  appendRecords: (page) =>
    set((state) => ({
      records: [...state.records, ...page.records],
      hasMore: page.hasMore,
      nextPageToken: page.pageToken,
    })),

  replaceRecords: (page) =>
    set({
      records: page.records,
      hasMore: page.hasMore,
      nextPageToken: page.pageToken,
    }),

  setConfig: (config, source) => set({ config, configSource: source }),

  setCanEditConfig: (canEdit) => set({ canEditConfig: canEdit }),

  dismissProvisioned: () => set({ provisionedFromTemplate: false }),

  refresh: async () => {
    const { dataSource, env, loadGeneration } = get();
    if (!dataSource || !env) return;
    // ⭐ 自增加载代号：使在途的 loadAll / 滚动增量批次**作废**，避免与本次刷新互相污染
    const gen = loadGeneration + 1;
    set({ loadingMore: true, loadGeneration: gen, loadMoreFailed: false });
    try {
      dataSource.clearCache();
      const page = await dataSource.loadPage({ viewId: env.viewId, pageSize: REFRESH_PAGE_SIZE });
      if (get().loadGeneration !== gen) return; // 已被更新的刷新取代 → 不覆盖
      const { total, totalKnown } = await resolveTotalInfo(dataSource, page);
      if (get().loadGeneration !== gen) return;
      set({
        records: page.records,
        hasMore: page.hasMore,
        nextPageToken: page.pageToken,
        total,
        totalKnown,
        loadingMore: false,
      });
    } catch (err) {
      logError('state.refresh', err);
      // 保留 SDK 原始错误码 / 原因（非 Error 对象不再退化成「刷新失败」）
      set({
        loadingMore: false,
        errorMessage: formatError(err),
        errorStep: 'refresh',
      });
    }
  },

  loadMore: async () => {
    const { dataSource, env, nextPageToken, hasMore, loadingMore, loadGeneration } = get();
    if (!dataSource || !env || !hasMore || loadingMore) return;
    // ⭐ 记录本次批次所属代号；回填前校验，一旦刷新 / 取消把代号推进，本批结果即作废
    const gen = loadGeneration;
    set({ loadingMore: true, loadMoreFailed: false });
    try {
      const page = await dataSource.loadPage({
        viewId: env.viewId,
        pageSize: DEFAULT_PAGE_SIZE,
        pageToken: nextPageToken ?? undefined,
      });
      if (get().loadGeneration !== gen) {
        // 作废：不追加记录、不推进游标（保持状态自洽），仅解除阻塞
        set({ loadingMore: false });
        return;
      }
      set((state) => ({
        records: appendUniqueRecords(state.records, page.records),
        hasMore: page.hasMore,
        nextPageToken: page.pageToken,
        loadingMore: false,
        ...(typeof page.total === 'number' && Number.isFinite(page.total)
          ? { total: Math.max(0, Math.trunc(page.total)), totalKnown: true }
          : {}),
      }));
    } catch (err) {
      logError('state.loadMore', err);
      if (get().loadGeneration !== gen) {
        set({ loadingMore: false });
        return;
      }
      // ⭐ 失败必须可被上层感知（loadMoreFailed），否则「加载全部」循环会以为成功而空转
      set({ loadingMore: false, loadMoreFailed: true });
    }
  },

  bumpLoadGeneration: () => set((state) => ({ loadGeneration: state.loadGeneration + 1 })),

  persistConfig: async (config) => {
    const { repository, env } = get();
    if (!repository || !env) {
      return { ok: false, reason: 'write-failed', error: '配置仓储尚未就绪' };
    }
    const result = await repository.save(env.viewId, config);
    if (result.ok) set({ config });
    return result;
  },
}));
