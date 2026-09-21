/**
 * 视图级状态（M1 轻量实现；M2 按 §9 扩展而非重写：保全 M1 的增量加载 / 分页状态）。
 *
 * 分层：表现层 → 状态层 → 领域层 → 数据层 → 配置层 → 接入层。
 * 表现层不得直接调 SDK，故数据源句柄与配置仓储句柄均由本层持有并暴露动作。
 */
import { create } from 'zustand';
import type { IRecord } from '@lark-base-open/js-sdk';
import { DEFAULT_PAGE_SIZE } from '@/constants';
import type { CardViewConfig } from '@/config/types';
import type { ConfigRepository, ConfigSource, SaveResult } from '@/config/ConfigRepository';
import type { EnvSnapshot } from '@/sdk/env';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { PageResult, RecordDataSource } from '@/data/RecordDataSource';
import { appendUniqueRecords } from '@/data/recordPages';
import { logError } from '@/utils/log';

export type ViewStatus = 'boot' | 'loading' | 'browse' | 'error';

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
}

export interface ViewState {
  status: ViewStatus;
  errorMessage: string | null;

  env: EnvSnapshot | null;
  viewName: string;
  fields: FieldMetaLite[];
  fieldsById: Record<string, FieldMetaLite>;

  records: IRecord[];
  total: number;
  hasMore: boolean;
  nextPageToken: string | null;
  loadingMore: boolean;

  config: CardViewConfig | null;
  configSource: ConfigSource;
  degraded: boolean;
  degradedReason: string;
  /** 数据损坏标记（区别于介质降级 `degraded`） */
  configCorrupted: boolean;
  unsupportedNewer: boolean;
  provisionedFromTemplate: boolean;
  copyScenario: boolean;
  canEditConfig: boolean;

  dataSource: RecordDataSource | null;
  repository: ConfigRepository | null;

  setStatus: (status: ViewStatus) => void;
  setError: (message: string) => void;
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

  env: null,
  viewName: '',
  fields: [],
  fieldsById: {},

  records: [],
  total: 0,
  hasMore: false,
  nextPageToken: null,
  loadingMore: false,

  config: null,
  configSource: 'default',
  degraded: false,
  degradedReason: '',
  configCorrupted: false,
  unsupportedNewer: false,
  provisionedFromTemplate: false,
  copyScenario: false,
  canEditConfig: false,

  dataSource: null,
  repository: null,

  setStatus: (status) => set({ status }),
  setError: (message) => set({ errorMessage: message, status: 'error' }),
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
      errorMessage: null,
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
    const { dataSource, env } = get();
    if (!dataSource || !env) return;
    set({ loadingMore: true });
    try {
      dataSource.clearCache();
      const page = await dataSource.loadPage({ viewId: env.viewId, pageSize: REFRESH_PAGE_SIZE });
      const total = await dataSource.count();
      set({
        records: page.records,
        hasMore: page.hasMore,
        nextPageToken: page.pageToken,
        total,
        loadingMore: false,
      });
    } catch (err) {
      logError('state.refresh', err);
      set({
        loadingMore: false,
        errorMessage: err instanceof Error ? err.message : '刷新失败',
      });
    }
  },

  loadMore: async () => {
    const { dataSource, env, nextPageToken, hasMore, loadingMore } = get();
    if (!dataSource || !env || !hasMore || loadingMore) return;
    set({ loadingMore: true });
    try {
      const page = await dataSource.loadPage({
        viewId: env.viewId,
        pageSize: DEFAULT_PAGE_SIZE,
        pageToken: nextPageToken ?? undefined,
      });
      set((state) => ({
        records: appendUniqueRecords(state.records, page.records),
        hasMore: page.hasMore,
        nextPageToken: page.pageToken,
        loadingMore: false,
      }));
    } catch (err) {
      logError('state.loadMore', err);
      set({ loadingMore: false });
    }
  },

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
