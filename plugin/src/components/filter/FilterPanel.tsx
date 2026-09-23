/**
 * 筛选面板容器（设计文档 §22.5.2 / §22.5.3 / §22.5.6）。
 *
 * 结构：条件列表 → 添加条件 / 与或切换 → 覆盖范围状态行 → 清空 / 完成（收起面板）。
 *
 * ⭐ 两条「不假绿」的 UI 铁律在本组件落地：
 * 1. **覆盖范围常驻**（§22.11）：只写明「已在已加载的 N / 共 M 条中筛选，命中 K 条」，
 *    未加载全部时绝不出现「共 K 条」这类可被解读为全量命中的文案；
 * 2. **无效条件显式告知**（§22.5.6）：存在无效条件时，状态行**必须**额外提示
 *    「（其中 N 个条件未生效）」，不能只显示匹配数。
 *    背景：无效条件会被 `evaluateFilter` 丢弃（§22.4.5），用户看到的是全部记录；
 *    若不提示，用户会以为「这就是筛选结果」。
 *
 * 数据流：本面板是 `UiStore.filter`（**草稿态唯一真相**）的编辑界面——
 * 每次编辑即时写回 `setFilter()`，筛选结果由 `ViewShell` 经 `selectVisibleRecords`
 * 落到卡片墙；本面板**只**负责编辑与如实汇报，不下推服务端（D1 只读铁律）。
 */
import { useMemo } from 'react';
import { createId } from '@/config/defaults';
import { isFilterableFieldType } from '@/filter/operatorMatrix';
import type { FilterCondition, FilterConjunction } from '@/filter/types';
import {
  countInvalidConditions,
  INCOMPLETE_NOTICE,
  selectFilterScopeStatus,
  selectVisibleRecords,
} from '@/state/selectors';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { createDefaultCondition, FilterConditionRow } from './FilterConditionRow';

export interface FilterPanelProps {
  /**
   * 「完成」= **仅收起面板**（筛选早已随输入即时生效，见 §22.5.4）。
   * ⚠️ 刻意**不叫「应用」**：那会暗示「点了才生效」，与事实不符（团队裁定 · 2026-09-21）。
   * 不传则不渲染该按钮。
   */
  onApply?: () => void;
}

/** 无效条件的汇总提示（N 个条件未生效）；与状态行后缀同源，两处文案必须一致 */
export function invalidConditionsText(count: number): string {
  return `有 ${count} 个条件未生效`;
}

/**
 * 状态行里「未生效」的括号后缀（§22.5.6 建议文案：`命中 37 条（其中 1 个条件未生效）`）。
 * 转发到 `state/selectors.invalidCountSuffix()` —— 面板与 `ViewShell` 状态行**共用同一份**
 * 文案，避免「面板说 1 个、工具栏说 2 个」的自相矛盾。
 */
export { invalidCountSuffix as invalidScopeSuffix } from '@/state/selectors';

export function FilterPanel({ onApply }: FilterPanelProps): JSX.Element {
  const records = useViewStore((state) => state.records);
  const fields = useViewStore((state) => state.fields);
  const fieldsById = useViewStore((state) => state.fieldsById);
  const total = useViewStore((state) => state.total);
  const hasMore = useViewStore((state) => state.hasMore);
  const layout = useViewStore((state) => state.config?.card ?? null);

  const searchQuery = useUiStore((state) => state.searchQuery);
  const filter = useUiStore((state) => state.filter);
  const setFilter = useUiStore((state) => state.setFilter);
  const clearFilter = useUiStore((state) => state.clearFilter);

  const conditions = filter.conditions;

  const visible = useMemo(
    () => selectVisibleRecords({ records, filter, fieldsById, layout, searchQuery }),
    [records, filter, fieldsById, layout, searchQuery],
  );

  /** 未生效条件数（判据来自引擎，UI 不自建校验，§22.5.6-1） */
  const invalidCount = useMemo(() => countInvalidConditions(filter, fieldsById), [filter, fieldsById]);

  const status = useMemo(
    () =>
      selectFilterScopeStatus({
        total,
        loaded: records.length,
        filterMatched: visible.filterMatched,
        visible: visible.visible,
        hasFilter: visible.hasFilter,
        hasSearch: visible.hasSearch,
        hasMore,
        loadingAll: false,
        startedFrom: 0,
        invalidCount,
      }),
    [
      total,
      records.length,
      visible.filterMatched,
      visible.visible,
      visible.hasFilter,
      visible.hasSearch,
      hasMore,
      invalidCount,
    ],
  );

  // 后缀由 `selectFilterScopeStatus` 统一追加（与 ViewShell 状态行同一份文案，不会漂移）
  const scopeText = status.scopeText;

  /** 是否存在**可筛**字段（无可筛字段时禁用「添加条件」，从源头不给不可筛条件） */
  const hasFilterableField = useMemo(
    () => fields.some((field) => isFilterableFieldType(field.type)),
    [fields],
  );

  function replaceConditions(next: FilterCondition[]): void {
    setFilter({ ...filter, conditions: next });
  }

  function handleAdd(): void {
    const created = createDefaultCondition(fields, fieldsById, createId('flt'));
    if (!created) return;
    replaceConditions([...conditions, created]);
  }

  function handleChange(index: number, next: FilterCondition): void {
    const copy = conditions.slice();
    copy[index] = next;
    replaceConditions(copy);
  }

  function handleRemove(index: number): void {
    replaceConditions(conditions.filter((_, i) => i !== index));
  }

  function handleConjunction(next: FilterConjunction): void {
    setFilter({ ...filter, conjunction: next });
  }

  return (
    <div className="cbv-filter-panel" data-testid="filter-panel">
      <div className="cbv-filter-panel__head">
        <strong>筛选</strong>
        <span className="cbv-filter-panel__hint">筛选对已加载记录即时生效</span>
      </div>

      {conditions.length === 0 ? (
        <div className="cbv-filter-panel__empty" data-testid="filter-empty-hint">
          暂无筛选条件，点击「添加条件」开始
        </div>
      ) : (
        <div className="cbv-filter-panel__rows">
          {conditions.map((condition, index) => (
            <FilterConditionRow
              key={condition.conditionId}
              condition={condition}
              fields={fields}
              fieldsById={fieldsById}
              onChange={(next) => handleChange(index, next)}
              onRemove={() => handleRemove(index)}
            />
          ))}
        </div>
      )}

      <div className="cbv-filter-panel__actions">
        <button
          type="button"
          className="cbv-btn"
          data-testid="filter-add-condition"
          disabled={!hasFilterableField}
          title={hasFilterableField ? '添加一条筛选条件' : '当前视图没有可筛选的字段'}
          onClick={handleAdd}
        >
          + 添加条件
        </button>

        {conditions.length >= 2 ? (
          <div className="cbv-segmented cbv-segmented--mini" role="group" aria-label="条件组合方式">
            <button
              type="button"
              className={`cbv-segmented__item${filter.conjunction === 'and' ? ' cbv-segmented__item--active' : ''}`}
              data-testid="filter-conjunction-and"
              aria-pressed={filter.conjunction === 'and'}
              onClick={() => handleConjunction('and')}
            >
              与
            </button>
            <button
              type="button"
              className={`cbv-segmented__item${filter.conjunction === 'or' ? ' cbv-segmented__item--active' : ''}`}
              data-testid="filter-conjunction-or"
              aria-pressed={filter.conjunction === 'or'}
              onClick={() => handleConjunction('or')}
            >
              或
            </button>
          </div>
        ) : null}
      </div>

      {/* ⭐ 覆盖范围状态行：常驻；有无效条件时**必须**同时给出「未生效」数量（§22.5.6-3） */}
      {status.visible ? (
        <div className="cbv-filter-scope" data-testid="filter-panel-scope" role="status">
          <span className="cbv-filter-scope__text" data-testid="filter-panel-scope-text">
            {scopeText}
          </span>
          {status.incompleteText ? (
            <span className="cbv-filter-scope__incomplete">{status.incompleteText}</span>
          ) : null}
          {invalidCount > 0 ? (
            <span
              className="cbv-filter-scope__invalid"
              data-testid="filter-invalid-summary"
              role="alert"
              style={{ color: '#d83931' }}
            >
              {`⚠ ${invalidConditionsText(invalidCount)}，已按其余条件筛选`}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="cbv-filter-panel__footer">
        <button
          type="button"
          className="cbv-btn cbv-btn--danger"
          data-testid="filter-clear"
          disabled={conditions.length === 0}
          onClick={clearFilter}
        >
          清空
        </button>
        {onApply ? (
          // ⭐ 按钮名必须是「完成」而不是「应用」（团队裁定 · 2026-09-21）：
          //    筛选在**输入时早已生效**，本按钮**只收起面板**、不做任何提交。
          //    叫「应用」会暗示「点了才生效」，与事实不符——一个以为「不点不生效」的用户
          //    会在关掉面板后发现视图仍被筛着，却不知道原因、也不知道怎么恢复。
          //    面板头部的「即时生效」提示是准确的，正好与本按钮名互补。
          //    ⚠️ 行为一个字不改（仍只调用 `onApply` → 收起面板）。
          <button type="button" className="cbv-btn cbv-btn--primary" data-testid="filter-apply" onClick={onApply}>
            完成
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 未加载全部提示文案（与 ViewShell 状态行同口径，避免两处文案漂移） */
export const FILTER_PANEL_INCOMPLETE_NOTICE = INCOMPLETE_NOTICE;
