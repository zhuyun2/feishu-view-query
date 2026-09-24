/**
 * 派生选择器（设计文档 §9）：把「已保存配置 / 草稿 / UI 状态」收敛为渲染层可直接消费的纯值。
 *
 * 全部为**纯函数**（不依赖 React），便于：
 *  ① 虚拟网格与卡片组件共用同一套列数/行数推导；
 *  ② 单测直接断言（无需渲染）。
 */
import type { SdkRecord } from '@/sdk/port';
import type { CardLayoutConfig, DensityConfig, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { getRecordFields } from '@/data/RecordDataSource';
import type { DraftState } from './DraftStore';
import type { ViewState } from './ViewStore';
import { attributesMaxRows, densityPreset, resolveDensityPreset, type DensityPresetName } from '@/config/presets';
import { applyFilterConditions, computeFilterScope, evaluateConditionState, isConditionValid, isFilterActive } from '@/filter/engine';
import type { FieldMetaMap, FilterScope } from '@/filter/engine';
import type { FilterCondition, FilterConfig } from '@/filter/types';

/** 编辑态优先取草稿（实时预览），否则取已保存配置 */
export function selectEffectiveCardLayout(view: ViewState, draft: DraftState): CardLayoutConfig | null {
  if (draft.active && draft.cardDraft) return draft.cardDraft;
  return view.config?.card ?? null;
}

/** 编辑态优先取草稿密度 */
export function selectEffectiveDensity(view: ViewState, draft: DraftState): DensityConfig | null {
  if (draft.active && draft.densityDraft) return draft.densityDraft;
  return view.config?.density ?? null;
}

/** 编辑态优先取草稿主题 */
export function selectEffectiveTheme(view: ViewState, draft: DraftState): StyleTheme | null {
  if (draft.active && draft.themeDraft) return draft.themeDraft;
  return view.config?.theme ?? null;
}

/** 当前密度档位名 */
export function selectDensityPreset(density: DensityConfig | null | undefined): DensityPresetName {
  return resolveDensityPreset(density);
}

/** 属性区默认行数（R3） */
export function selectAttributesMaxRows(density: DensityConfig | null | undefined): number {
  return attributesMaxRows(density);
}

/** 应用某档密度（返回新的 DensityConfig，保留 columnsMode 等） */
export function selectDensityWithPreset(
  density: DensityConfig | null | undefined,
  preset: DensityPresetName,
): DensityConfig {
  return densityPreset(preset, density ?? undefined);
}

export interface GridMetrics {
  /** 一屏列数（≥ 1） */
  columns: number;
  /** 单卡目标宽度（px，含取整） */
  columnWidth: number;
  gap: number;
  padding: number;
}

/**
 * 卡片网格几何（04 §3.4 推导）：
 *   columns = floor((viewportW − 2×padding + gap) / (cardMinWidth + gap))
 * 列宽取「视口宽均分」以保证右侧不留缝。
 */
export function selectGridMetrics(viewportWidth: number, density: DensityConfig | null | undefined): GridMetrics {
  const safeDensity: DensityConfig = density ?? {
    cardMinWidth: 280,
    columnsMode: 'auto',
    gap: 16,
    padding: 16,
    maxCardHeight: 220,
  };
  const padding = Math.max(0, safeDensity.padding);
  const gap = Math.max(0, safeDensity.gap);
  const minWidth = Math.max(1, safeDensity.cardMinWidth);
  const usable = Math.max(0, viewportWidth - padding * 2);

  let columns: number;
  if (safeDensity.columnsMode === 'fixed' && safeDensity.fixedColumns && safeDensity.fixedColumns > 0) {
    columns = Math.min(Math.floor(safeDensity.fixedColumns), 12);
  } else {
    columns = Math.floor((usable + gap) / (minWidth + gap));
    columns = Math.min(Math.max(columns, 1), 12);
  }
  const columnWidth = columns > 0 ? Math.floor((usable - gap * (columns - 1)) / columns) : minWidth;
  return { columns, columnWidth: Math.max(minWidth, columnWidth), gap, padding };
}

/** 行数（ceil） */
export function selectRowCount(itemCount: number, columns: number): number {
  if (columns <= 0) return 0;
  return Math.ceil(itemCount / columns);
}

/** 非负整数收敛（脏数据 / NaN / 负数 → 0） */
function toNonNegInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 分母口径：是否可用 `total` 作为「全量」分母。
 *
 * 两条否决条件（任一成立则退回 `loaded` 口径）：
 * 1. `totalKnown === false`（总数取不到）—— 绝不能谎报「共 0 条」；
 * 2. `total < loaded`（脏数据 / 陈旧总数）—— 避免出现「已加载 200 / 共 100」的反向矛盾。
 *
 * 默认 `totalKnown` 视作 true，以保持既有调用点 / 测试基线逐字不变。
 */
function isKnownTotal(total: number, loaded: number, totalKnown: boolean | undefined): boolean {
  return totalKnown !== false && toNonNegInt(total) >= toNonNegInt(loaded);
}

/** 记录总数文案（04 §5.1.2：「共 1,248 条」/ 筛选时「共 N 条（已筛选 M 条）」） */
export function selectCountLabel(total: number, loaded: number, filtered: boolean, totalKnown = true): string {
  const group = (value: number): string => value.toLocaleString('en-US');
  const safeTotal = toNonNegInt(total);
  const safeLoaded = toNonNegInt(loaded);
  const known = totalKnown !== false;

  if (known && safeTotal >= safeLoaded && safeTotal > 0) {
    return filtered ? `共 ${group(safeTotal)} 条（已筛选 ${group(safeLoaded)} 条）` : `共 ${group(safeTotal)} 条`;
  }
  // 总数未知 / 不可信 → 只报「已加载」，绝不用「共 N 条」
  if (safeLoaded > 0) return `已加载 ${group(safeLoaded)} 条`;
  return known ? '共 0 条' : '已加载 0 条';
}

/**
 * 统计卡片配置中「已被删除」的字段引用数（03 §12 / 04 §6 状态 7）。
 * 同时扫描四个槽位与文档模板区块，避免漏报。
 */
export function selectMissingFieldCount(
  config: { card: CardLayoutConfig; detail: { doc: { blocks: unknown[] } } } | null | undefined,
  fieldsById: Record<string, unknown>,
): number {
  if (!config) return 0;
  const missing = new Set<string>();
  const consider = (fieldId: string | undefined): void => {
    if (typeof fieldId === 'string' && fieldId !== '' && !fieldsById[fieldId]) missing.add(fieldId);
  };

  const slots = config.card.slots;
  for (const slotId of ['title', 'subtitle', 'attributes', 'footer'] as const) {
    const slot = slots[slotId];
    if (!slot) continue;
    for (const placement of slot.placements) consider(placement.fieldId);
  }

  for (const block of config.detail.doc.blocks) {
    const raw = block as Record<string, unknown>;
    consider(typeof raw.fieldId === 'string' ? raw.fieldId : undefined);
    if (raw.source && typeof raw.source === 'object') {
      consider((raw.source as Record<string, unknown>).fieldId as string | undefined);
    }
    for (const key of ['rows', 'items', 'columns'] as const) {
      const list = raw[key];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && typeof entry === 'object') {
            consider((entry as Record<string, unknown>).fieldId as string | undefined);
          }
        }
      }
    }
    if (Array.isArray(raw.fieldIds)) {
      for (const fieldId of raw.fieldIds) consider(typeof fieldId === 'string' ? fieldId : undefined);
    }
  }
  return missing.size;
}

/** 卡片排版中所有被引用字段 id（去重，保持出现顺序） */
export function selectPlacedFieldIds(layout: CardLayoutConfig | null | undefined): string[] {
  if (!layout) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const slotId of ['title', 'subtitle', 'attributes', 'footer'] as const) {
    const slot = layout.slots[slotId];
    if (!slot) continue;
    for (const placement of [...slot.placements].sort((a, b) => a.order - b.order)) {
      if (!seen.has(placement.fieldId)) {
        seen.add(placement.fieldId);
        ids.push(placement.fieldId);
      }
    }
  }
  return ids;
}

/**
 * 工具栏搜索（04 §5 S1）：对**已加载记录**做客户端过滤。
 * 仅匹配「卡片排版中已引用字段」的人可见文本（经 `normalize`），**绝不匹配原始 ID / JSON**。
 * 关键词为空 → 原样返回（引用不变，便于 memo）。
 */
export function filterRecordsByQuery(
  records: readonly SdkRecord[],
  layout: CardLayoutConfig | null | undefined,
  fieldsById: Record<string, FieldMetaLite>,
  query: string,
): SdkRecord[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === '') return records as SdkRecord[];
  const fieldIds = selectPlacedFieldIds(layout);
  return records.filter((record) => {
    for (const fieldId of fieldIds) {
      const meta = fieldsById[fieldId];
      if (!meta) continue;
      try {
        const nv = normalize(getRecordFields(record)[fieldId], meta);
        if (!nv.isEmpty && nv.text.toLowerCase().includes(keyword)) return true;
      } catch {
        /* 单字段异常不影响整体过滤 */
      }
    }
    return false;
  });
}

/* ===================== §22 字段筛选：可见集与覆盖率 ===================== */

/**
 * 千分位分组（与 `selectCountLabel` 同口径；脏数据 → 0，绝不输出 `NaN`）。
 *
 * 覆盖率文案里任何一个 `NaN` 都是「对用户说了假话」，故此处与 `engine.computeFilterScope`
 * 一样做数值收敛。
 */
function groupCount(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return Math.max(0, Math.trunc(value)).toLocaleString('en-US');
}

/** `selectVisibleRecords` 的入参 */
export interface VisibleRecordsInput {
  /** 服务端原生筛选后的**已加载**记录（`ViewStore.records`；原生 `viewId` 隐式生效，插件不干预） */
  records: readonly SdkRecord[];
  /** 当前草稿态筛选配置（`UiStore.filter`） */
  filter: FilterConfig | null | undefined;
  /** 字段元数据索引（fieldId → meta） */
  fieldsById: FieldMetaMap;
  /** 卡片排版（决定「搜索」参与匹配的字段集合） */
  layout: CardLayoutConfig | null | undefined;
  /** 工具栏搜索关键词 */
  searchQuery: string;
}

/** `selectVisibleRecords` 的返回值 */
export interface VisibleRecordsSlice {
  /** 最终可见记录序列（不拷贝元素引用，便于 `CardItem` memo） */
  records: SdkRecord[];
  /** 插件筛选后的条数（**未经搜索收窄**） */
  filterMatched: number;
  /** 最终可见条数（筛选 ∩ 搜索） */
  visible: number;
  /** 是否有生效的插件筛选条件 */
  hasFilter: boolean;
  /** 搜索关键词是否非空 */
  hasSearch: boolean;
}

/**
 * ⭐ 数据流主链（§22.1.2）：**原生筛选（服务端） → 插件筛选 → 搜索**，三者叠加（AND）。
 *
 * ```
 * ViewStore.records  （服务端已按 viewId 应用原生筛选与排序）
 *   → applyFilterConditions   ← 本选择器内部调用（filter/engine.ts，纯函数）
 *   → filterRecordsByQuery    ← 既有搜索过滤
 *   → VirtualCardGrid
 * ```
 *
 * 实现 Notes：
 * - **无条件时 `applyFilterConditions` 返回入参原引用** → 不产生新数组，避免无谓重渲染；
 * - **无条件 + 空关键词时整体保持原引用**（`toBe` 可断言），与既有搜索行为一致；
 * - 全程纯函数，不触碰 store。
 */
export function selectVisibleRecords(input: VisibleRecordsInput): VisibleRecordsSlice {
  const afterFilter = applyFilterConditions(input.records, input.filter, input.fieldsById);
  const hasSearch = input.searchQuery.trim() !== '';
  const visible = filterRecordsByQuery(afterFilter, input.layout, input.fieldsById, input.searchQuery);
  return {
    records: visible,
    filterMatched: afterFilter.length,
    visible: visible.length,
    hasFilter: isFilterActive(input.filter),
    hasSearch,
  };
}

/**
 * 覆盖范围（§22.11）——`computeFilterScope` 的薄封装（§22.6）。
 *
 * ⚠️ `fullCoverage` **仅**由 `hasMore` 决定：只要还有未加载页，就绝不允许声称覆盖全量。
 * 保留独立导出是为了让上层只依赖选择器层，不必直接 `import` 引擎。
 */
export function selectFilterScope(
  filter: FilterConfig | null | undefined,
  loaded: number,
  matched: number,
  total: number,
  hasMore: boolean,
): FilterScope {
  return computeFilterScope(filter, loaded, matched, total, hasMore);
}

/** `selectFilterScopeLabel` 的入参（§22.5.5，逐字落地） */
export interface FilterScopeLabelInput {
  total: number;
  loaded: number;
  matched: number;
  hasFilter: boolean;
  hasSearch: boolean;
  hasMore: boolean;
  /**
   * **未生效**的条件数（§22.5.6-3，F4 接线）：
   * 无效条件会被 `evaluateFilter` 丢弃（§22.4.5），用户看到的是**全部记录**，
   * 故文案必须显式告知「有 N 个条件未生效」，否则用户会以为「这就是筛选结果」。
   * 缺省 / 为 0 时**文案与旧版逐字一致**（F3 既有断言锁定）。
   */
  invalidCount?: number;
  /**
   * 总数是否可信（`ViewStore.totalKnown`）。
   * `false` 时**必须**去掉「共 0 条」前缀，退化为「已在已加载的 L 条中筛选，命中 M 条」
   * （`!hasMore` 时用「已在全部 L 条中筛选」）。缺省视作 `true`（保持既有测试基线）。
   */
  totalKnown?: boolean;
}

/**
 * 「N 个条件未生效」的括号后缀（**唯一来源**，UI 与单测共用）。
 *
 * ⚠️ 刻意做成纯函数由 `selectFilterScopeLabel` / `selectFilterScopeStatus` / 面板三处共用：
 *    同一句提示若各写一份，迟早出现「面板说 1 个、状态行说 2 个」的自相矛盾。
 */
export function invalidCountSuffix(count: number): string {
  const safe = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return safe > 0 ? `（其中 ${groupCount(safe)} 个条件未生效）` : '';
}

/**
 * 单条条件是否会**真正参与筛选**（§22.5.6 的 UI 判据）。
 *
 * 只做**组合**，不做重新实现：
 * - `isConditionValid(cond, fieldsById)`：引擎的**完整**静态判定
 *   （算子是否已知 **且** 字段类型 × 算子匹配 **且** 字段仍存在）；
 * - `evaluateConditionState(cond, null, metas)`：传 `null` 记录时，引擎仍会先完成
 *   上述两道判定才返回 `'noMatch'`，故 `!== 'invalid'` 即「可参与求值」。
 *
 * 两道都只调用引擎、**不重新实现**任何判定；`isEmpty` / `isNotEmpty` 的豁免（§22.3.2）
 * 由引擎的 `isTypeOperatorMatch` 保证，本函数天然继承。
 * 二者若将来出现分歧（`isConditionValid` 说有效、求值说无效），以**求值**为准：
 * 用户真正关心的是「这条条件在结果里生效了吗」，保守判红也只会多一点提示、不会漏报。
 */
export function isFilterConditionEffective(
  cond: FilterCondition | null | undefined,
  fieldsById: FieldMetaMap,
): boolean {
  if (!isConditionValid(cond, fieldsById)) return false;
  return evaluateConditionState(cond, null, fieldsById) !== 'invalid';
}

/** 当前配置里**不会生效**（会被引擎丢弃）的条件数（§22.5.6-3） */
export function countInvalidConditions(
  filter: FilterConfig | null | undefined,
  fieldsById: FieldMetaMap,
): number {
  if (!filter || !Array.isArray(filter.conditions)) return 0;
  let count = 0;
  for (const cond of filter.conditions) {
    if (!isFilterConditionEffective(cond, fieldsById)) count += 1;
  }
  return count;
}

/**
 * 工具栏记录数文案（§22.5.5）。
 *
 * 文案规则（**禁止假绿**，QA §22.9.4-①② 断言守卫）：
 * - 无筛选无搜索 → 沿用 `selectCountLabel` 的三档口径（`共 N 条` / `已加载 N 条` / `共 0 条`）；
 * - 有收窄（筛选或搜索）且 **已加载全部**（`!hasMore`）→ `共 N 条（已筛选 M 条）`；
 * - 有收窄且 **未加载全部**（`hasMore`）→ **必须**含「已加载」限定词：
 *   `共 N 条 · 已在已加载的 L 条中筛选，命中 M 条`。
 *
 * ⚠️ 第三种情况下**严禁**退化成 `共 M 条` 这类可被解读为「全量命中」的文案——
 * 那等于对用户说「表里总共就这么多」，而实际上只筛了已加载的一小部分。
 *
 * ⚠️ `invalidCount > 0` 时（§22.5.6-3）在**末尾**追加 {@link invalidCountSuffix}；
 * `invalidCount` 缺省 / 为 0 时输出与旧版**逐字一致**（F3 既有断言锁定）。
 */
export function selectFilterScopeLabel(input: FilterScopeLabelInput): string {
  const narrowed = input.hasFilter || input.hasSearch;
  if (!narrowed) return selectCountLabel(input.total, input.loaded, false, input.totalKnown);

  const matched = groupCount(input.matched);
  const invalidSuffix = invalidCountSuffix(input.invalidCount ?? 0);
  const loaded = groupCount(input.loaded);

  // 总数可信且不小于已加载 → 沿用既有「共 N 条」口径（逐字不变）
  if (isKnownTotal(input.total, input.loaded, input.totalKnown)) {
    const total = groupCount(input.total);
    if (!input.hasMore) return `共 ${total} 条（已筛选 ${matched} 条）${invalidSuffix}`;
    return `共 ${total} 条 · 已在已加载的 ${loaded} 条中筛选，命中 ${matched} 条${invalidSuffix}`;
  }

  // ⭐ 总数未知 / 不可信 → 用已加载当分母，**绝不**出现「共 0 条」这类谎报
  if (input.hasMore) {
    return `已在已加载的 ${loaded} 条中筛选，命中 ${matched} 条${invalidSuffix}`;
  }
  return `已在全部 ${loaded} 条中筛选，命中 ${matched} 条${invalidSuffix}`;
}

/** 「加载全部并重新筛选」升级入口文案（唯一来源，UI 与单测共用） */
export const LOAD_ALL_LABEL = '加载全部并重新筛选';

/** 「未加载全部」诚实提示文案（唯一来源，UI 与单测共用） */
export const INCOMPLETE_NOTICE = '未加载全部';

/** `selectFilterScopeStatus` 的入参 */
export interface FilterScopeStatusInput {
  /** 原生可见总数（`ViewStore.total`） */
  total: number;
  /** 已加载条数（`ViewStore.records.length`） */
  loaded: number;
  /** 插件筛选命中数（未启用筛选时传 `loaded`） */
  filterMatched: number;
  /** 最终可见条数（筛选 ∩ 搜索） */
  visible: number;
  hasFilter: boolean;
  hasSearch: boolean;
  hasMore: boolean;
  /** 是否正在执行「加载全部」升级 */
  loadingAll: boolean;
  /** 本次升级**开始时**的已加载条数；未开始或未记录时传 0 */
  startedFrom?: number;
  /**
   * **未生效**的条件数（§22.5.6-3，F4 接线）。缺省 / 为 0 时 `scopeText` 与旧版逐字一致。
   *
   * ⚠️ 这是状态行的**必填信息**而非装饰：无效条件被 `evaluateFilter` 丢弃后
   * 用户看到的是全部记录，只显示「命中 N 条」会让他以为筛选生效了。
   */
  invalidCount?: number;
  /**
   * 总数是否可信（`ViewStore.totalKnown`）。`false` 时范围前缀去掉「/ 共 N 条」，
   * 退化为「已在已加载的 L 条中筛选」（`!hasMore` 时「已在全部 L 条中筛选」）。
   * 缺省视作 `true`（保持既有测试基线逐字不变）。
   */
  totalKnown?: boolean;
  /**
   * 「静默全量」：为 `true` 时不显示进度文案（数据量小、耗时可忽略）。
   * 仍照常渲染状态行与「未加载全部」提示，只是不复述逐批进度。
   */
  loadingAllSilent?: boolean;
}

/** `selectFilterScopeStatus` 的返回值（状态行可直接渲染，无需再拼文案） */
export interface FilterScopeStatus {
  /** 是否渲染状态行（有插件筛选或搜索时才渲染） */
  visible: boolean;
  /** 覆盖范围（**常驻**：不只显示命中数，必须写明筛选发生在哪个集合上） */
  scopeText: string;
  /** 「未加载全部」提示；已加载全部时为 `null` */
  incompleteText: string | null;
  /** 是否显示升级入口（未加载全部 + 有收窄 + 未在升级中） */
  canUpgrade: boolean;
  /** 升级按钮文案 */
  upgradeLabel: string;
  /** 升级进行中的进度文案；未在升级时为 `null` */
  progressText: string | null;
}

/**
 * 覆盖率状态行（§22.11.3 / §22.5.2「★ 覆盖范围」）——本特性「不假绿」的关键 UI 约束。
 *
 * 三条冗余保证，逐条有单测可证伪：
 * 1. **常驻覆盖范围**：无论命中多少，都写明「已在 <集合> 中筛选」；
 * 2. **`hasMore` 为真** → 常驻 {@link INCOMPLETE_NOTICE} + {@link LOAD_ALL_LABEL} 升级入口；
 * 3. **文案准入**：只有 `!hasMore`（已加载全部）或用户已执行升级后，才出现「全部」字样。
 *
 * ⭐ 第四条（§22.5.6-3，F4 追加）：`invalidCount > 0` 时**必须**在 `scopeText` 末尾
 * 追加 {@link invalidCountSuffix}——防的是「谎报筛选生效了」，与第 1~3 条防的
 * 「谎报筛过了全量」是同一类问题，都不能只靠引擎语义正确兜住。
 */
export function selectFilterScopeStatus(input: FilterScopeStatusInput): FilterScopeStatus {
  const hasFilter = input.hasFilter === true;
  const hasSearch = input.hasSearch === true;
  const visible = hasFilter || hasSearch;
  const hasMore = input.hasMore === true;
  const loadingAll = input.loadingAll === true;
  const startedFrom = Number.isFinite(input.startedFrom) ? Math.max(0, Math.trunc(input.startedFrom ?? 0)) : 0;

  if (!visible) {
    return {
      visible: false,
      scopeText: '',
      incompleteText: null,
      canUpgrade: false,
      upgradeLabel: LOAD_ALL_LABEL,
      progressText: null,
    };
  }

  const known = isKnownTotal(input.total, input.loaded, input.totalKnown);
  const verb = hasFilter ? '筛选' : '搜索';
  const total = groupCount(input.total);
  const loaded = groupCount(input.loaded);
  const matched = groupCount(hasFilter ? input.filterMatched : input.visible);

  // 范围前缀：诚实区分「部分集合」与「全量集合」；总数未知时**不得**出现「共 N 条」
  const scopePrefix = known
    ? hasMore
      ? `已在已加载的 ${loaded} / 共 ${total} 条中${verb}`
      : `已在全部 ${total} 条中${verb}`
    : hasMore
      ? `已在已加载的 ${loaded} 条中${verb}`
      : `已在全部 ${loaded} 条中${verb}`;
  // 叠加搜索时补一句最终可见数，避免用户误以为「命中 = 屏幕上看到的条数」
  const scopeTail = hasFilter && hasSearch ? `，命中 ${matched} 条（叠加搜索后 ${groupCount(input.visible)} 条）` : `，命中 ${matched} 条`;

  // 升级进度（§22.11.3：本路径约 50 次请求 / 10–30s，**必须有进度提示**；静默模式除外）
  let progressText: string | null = null;
  if (loadingAll && input.loadingAllSilent !== true) {
    const base = known ? `已加载 ${loaded} / 共 ${total}` : `已加载 ${loaded}`;
    // 只有**确曾记录过起点**且确实多拉到记录时才报「本次新增」；
    // 起点未知（0 / 缺失 / 脏数据）或 delta ≤ 0 时一律省略——不知道的事就不说。
    const delta = Number.isFinite(input.loaded) ? input.loaded - startedFrom : Number.NaN;
    progressText =
      startedFrom > 0 && Number.isFinite(delta) && delta > 0
        ? `${base}（本次新增 ${groupCount(delta)} 条）`
        : base;
  }

  return {
    visible: true,
    scopeText: `${scopePrefix}${scopeTail}${invalidCountSuffix(input.invalidCount ?? 0)}`,
    incompleteText: hasMore ? INCOMPLETE_NOTICE : null,
    canUpgrade: hasMore && !loadingAll,
    upgradeLabel: LOAD_ALL_LABEL,
    progressText,
  };
}
