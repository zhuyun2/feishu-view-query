/**
 * 通用「可搜索多选下拉」（SearchableMultiSelect）—— 受控、可模糊查询、键盘可达、可多选。
 *
 * 需求（用户原话）：「筛选字段，字段为下拉单选、多选类型字段需要提供关键字索引」。
 * 背景：筛选面板里「为单选/多选字段选值」的下拉原本是原生 `<select>`——选项多（数百）时
 * 中文无法用首字母定位，且**多选字段实际只能选一个值**（与原生多选语义不符）。
 * 本组件为多选值输入提供：关键字过滤 + 复选框列表 + 已选 chips（可单个移除）+ 一键清空。
 *
 * ⭐ 与 `FieldSelect` 的关系（**共享判定，绝不复制**）：
 *    - 复用 `FieldSelect` 导出的纯函数 `filterFieldOptions`（= `normalizeFieldQuery` + `matchFieldOption`）
 *      与共享 hook `usePopupPosition`（浮层定位 + 最小宽度 + 视口夹取 + 跟随滚动）；
 *    - 交互模式对齐（combobox 触发体 + `role=listbox` + `role=option` + ↑↓/Enter/Esc/Tab + 点外关闭），
 *      但**选中不关闭浮层**（多选需要连续勾选），故 `onChange` 每次都上交**最新整份 `string[]`**。
 *
 * ⭐ 完全受控：内部只保存「浮层开关 / 查询串 / 高亮项」这类纯 UI 态，**不保存值**——
 *    值只来自 `value`，变更只经 `onChange(next)`，由调用方决定写回哪里（筛选面板写回 `FilterCondition.value`）。
 *
 * ⚠️ 多值语义（**不改引擎**，仅在此说明）：`filter/sanitize.ts` 已把多选字段标为 `textList`
 *    并接受 `string[]`；`filter/engine.ts` 的 `contains` 对多选是「任一选项命中即命中」
 *    （`items.some(item => item.text.includes(keyword))`），故多值用「包含」可正确匹配。
 *    但 `is` 对多选是「各选项文本以 `、` 连接后整体相等」，**顺序敏感**——值是多选时，
 *    UI 建议用户优先用「包含」而非「等于」。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  FIELD_SELECT_SEARCH_HINT_TEXT,
  filterFieldOptions,
  usePopupPosition,
} from './FieldSelect';
import type { FieldSelectOption } from './FieldSelect';

/** 无匹配时的空态文案（多选值选择器默认值；与字段下拉的「无匹配字段」区分） */
export const MULTI_SELECT_EMPTY_TEXT = '无匹配选项';

export interface SearchableMultiSelectProps {
  /** 候选集（受控；调用方负责来源，如 `meta.property.options[].name`） */
  options: ReadonlyArray<FieldSelectOption>;
  /** 当前已选值（受控唯一真源；无选中时为空数组） */
  value: readonly string[];
  /** 值变更回调（每次上交**最新整份** `string[]`） */
  onChange: (next: string[]) => void;
  /** 是否可输入搜索（默认 false；true 时触发体可编辑并过滤） */
  searchable?: boolean;
  /** 无选中值时触发体的占位文案 */
  placeholder?: string;
  /** 禁用 */
  disabled?: boolean;
  /** 触发体（搜索输入框）上的 `data-testid`（沿用调用方原有 testid） */
  testId?: string;
  /** 触发体上的 `aria-label` */
  ariaLabel?: string;
  /** 无匹配时的空态文案（默认 `无匹配选项`） */
  emptyText?: string;
  /** 是否展示「可搜索」视觉提示（浮层顶部提示行 + 触发体 🔍 图标；默认 false） */
  searchableHint?: boolean;
  /** 无效态：为 true 时触发体带 `aria-invalid="true"` */
  invalid?: boolean;
}

/**
 * 可搜索多选下拉。
 *
 * ⚠️ 完全受控：内部只保存「浮层开关 / 查询串 / 高亮项」这类纯 UI 态，**不保存值**。
 */
export function SearchableMultiSelect({
  options,
  value,
  onChange,
  searchable = false,
  placeholder = '请选择',
  disabled = false,
  testId,
  ariaLabel,
  emptyText = MULTI_SELECT_EMPTY_TEXT,
  searchableHint = false,
  invalid = false,
}: SearchableMultiSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;

  // ⭐ 与 FieldSelect 同源的浮层定位（含最小宽度 + 视口夹取 + 跟随滚动/尺寸）
  const { dropUp, popupStyle, reposition: positionPopup } = usePopupPosition(rootRef, open);

  const selectedSet = useMemo(() => new Set(value), [value]);
  /** 已选项（按候选原序，保证 chips 顺序稳定） */
  const selectedOptions = useMemo(
    () => options.filter((option) => selectedSet.has(option.value)),
    [options, selectedSet],
  );
  const filtered = useMemo(() => filterFieldOptions(options, query), [options, query]);
  const canEdit = searchable && !disabled;
  const activeDescendant = open && filtered.length > 0 ? `${reactId}-option-${highlight}` : undefined;

  const popupTestId = testId ? `${testId}-popup` : undefined;
  const emptyTestId = testId ? `${testId}-empty` : undefined;
  const optionTestId = testId ? `${testId}-option` : undefined;
  const hintTestId = testId ? `${testId}-hint` : undefined;
  const chipTestId = testId ? `${testId}-chip` : undefined;
  const chipRemoveTestId = testId ? `${testId}-chip-remove` : undefined;
  const clearTestId = testId ? `${testId}-clear` : undefined;
  /** 是否展示「可搜索」视觉提示（仅 searchable 且未禁用时生效；纯视觉，不改交互） */
  const showSearchHint = searchable && searchableHint && !disabled;

  const closeList = (): void => {
    setOpen(false);
    setQuery('');
  };

  /** 打开浮层：高亮落在第一个已选项（找不到则第一项），并定位浮层 */
  const openList = (): void => {
    if (disabled) return;
    const at = filtered.findIndex((option) => selectedSet.has(option.value));
    setHighlight(at >= 0 ? at : 0);
    setQuery('');
    positionPopup();
    setOpen(true);
  };

  /** 切换单个候选的选中态（**不关闭浮层**，可连续勾选） */
  const toggleAt = useCallback(
    (index: number): void => {
      const option = filtered[index];
      if (!option) return;
      const selected = selectedSet.has(option.value);
      const next = selected
        ? value.filter((item) => item !== option.value)
        : [...value, option.value];
      onChange(next);
      inputRef.current?.focus();
    },
    [filtered, selectedSet, value, onChange],
  );

  /** 移除单个已选（chip 上的 ✕） */
  const removeValue = (target: string): void => {
    onChange(value.filter((item) => item !== target));
  };

  /** 清空全部已选 */
  const clearAll = (): void => {
    onChange([]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'Escape':
        if (open) {
          event.preventDefault();
          // ⭐ 不冒泡：否则会连带关闭外层抽屉 / 编辑器
          event.stopPropagation();
          closeList();
        }
        return;
      case 'Tab':
        // 不拦截默认行为 → Tab 能正常离开；仅顺带收起浮层
        if (open) closeList();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        if (filtered.length > 0) setHighlight((prev) => (prev + 1) % filtered.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        if (filtered.length > 0) setHighlight((prev) => (prev - 1 + filtered.length) % filtered.length);
        return;
      case 'Enter':
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        if (filtered.length > 0) toggleAt(highlight);
        return;
      case 'Backspace':
        // 查询为空时退格 = 移除最后一个已选（常见多选交互）
        if (open && query === '' && value.length > 0) {
          event.preventDefault();
          removeValue(value[value.length - 1]);
        }
        return;
      default:
        return;
    }
  };

  /* 点击外部关闭（capture 阶段，先于 React 的合成事件） */
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      closeList();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [open]);

  /* 高亮项滚动入视野（jsdom 无 scrollIntoView → 守卫） */
  useEffect(() => {
    if (!open) return undefined;
    const node = optionRefs.current[highlight];
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    return undefined;
  }, [open, highlight]);

  const rootClassName =
    'cbv-multiselect' +
    (open ? ' cbv-multiselect--open' : '') +
    (disabled ? ' cbv-multiselect--disabled' : '');

  return (
    <div ref={rootRef} className={rootClassName} data-multiselect="true" style={{ position: 'relative' }}>
      {showSearchHint ? (
        <span className="cbv-multiselect__search-icon" aria-hidden="true">
          🔍
        </span>
      ) : null}

      {/* 已选 chips（可单个移除） */}
      {selectedOptions.map((option) => (
        <span key={option.value} className="cbv-multiselect__chip" data-testid={chipTestId} data-chip-value={option.value}>
          <span className="cbv-multiselect__chip-label">{option.label}</span>
          <button
            type="button"
            className="cbv-multiselect__chip-remove"
            data-testid={chipRemoveTestId}
            data-chip-value={option.value}
            aria-label={`移除 ${option.label}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => removeValue(option.value)}
          >
            ✕
          </button>
        </span>
      ))}

      <input
        ref={inputRef}
        className={'cbv-multiselect__input' + (showSearchHint ? ' cbv-multiselect__input--hint' : '')}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-autocomplete={canEdit ? 'list' : 'none'}
        aria-invalid={invalid ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        data-open={open ? 'true' : 'false'}
        value={open ? query : ''}
        placeholder={selectedOptions.length === 0 ? placeholder : ''}
        disabled={disabled}
        readOnly={!canEdit}
        onChange={(event) => {
          if (!canEdit) return;
          if (!open) setOpen(true);
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onFocus={() => {
          if (!open) openList();
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onKeyDown={onKeyDown}
      />

      {selectedOptions.length > 0 ? (
        <button
          type="button"
          className="cbv-multiselect__clear"
          data-testid={clearTestId}
          aria-label="清空已选"
          title="清空已选"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clearAll}
        >
          ✕
        </button>
      ) : null}

      {open ? (
        <div
          className="cbv-multiselect__popup"
          data-testid={popupTestId}
          data-placement={dropUp ? 'top' : 'bottom'}
          style={popupStyle}
        >
          {showSearchHint ? (
            <div className="cbv-multiselect__search-hint" data-testid={hintTestId}>
              {FIELD_SELECT_SEARCH_HINT_TEXT}
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="cbv-multiselect__empty" role="status" data-testid={emptyTestId}>
              {emptyText}
            </div>
          ) : null}
          <ul
            id={listboxId}
            className="cbv-multiselect__list"
            role="listbox"
            aria-multiselectable="true"
            aria-label={ariaLabel}
          >
            {filtered.map((option, index) => {
              const selected = selectedSet.has(option.value);
              return (
                <li
                  key={option.value}
                  id={`${reactId}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  className={
                    'cbv-multiselect__option' +
                    (index === highlight ? ' cbv-multiselect__option--active' : '') +
                    (selected ? ' cbv-multiselect__option--selected' : '')
                  }
                  data-testid={optionTestId}
                  data-option-value={option.value}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => toggleAt(index)}
                >
                  <input
                    type="checkbox"
                    className="cbv-multiselect__checkbox"
                    checked={selected}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <span className="cbv-multiselect__option-label">{option.label}</span>
                  {option.hint ? (
                    <span className="cbv-multiselect__option-hint" title={option.hint}>
                      {option.hint}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default SearchableMultiSelect;
