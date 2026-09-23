/**
 * 通用「可搜索字段选择器」（FieldSelect）—— 受控、可模糊查询、键盘可达、无障碍不退化。
 *
 * 背景（用户反馈）：
 *   「字段选择框需要支持字段模糊查询，不然字段太多很难选择」/
 *   「视图筛选下拉选择字段要支持字段模糊查询」。
 *   全仓此前只有原生 `<select>`（无搜索），且**没有任何可搜索下拉的先例**，
 *   故本组件是**新建的共享受控组件**，同时服务两处调用方：
 *     ① 筛选面板的字段下拉（`filter/FilterConditionRow.tsx`）；
 *     ② 文档编辑器属性面板的字段绑定下拉
 *        （`editor/doc/BlockPropertyForm.tsx` 的 `fieldPicker` / `fieldRows`）。
 *
 * ⭐ 只统一「呈现与交互」，**不统一业务语义**：组件**不知道** `fieldId` 是什么，
 *    也不做任何算子回落 / 补丁构造——值一律由 `value` 驱动，变更一律由 `onChange(next)` 上交，
 *    由调用方各自决定：
 *      - 筛选面板 → `resolveConditionOnFieldChange`（切字段时算子回落 + 清空值）；
 *      - 编辑器   → `commit(spec, value)`（构造区块补丁）。
 *    这样「面板显示的」与「引擎求值 / 草稿写入的」永远同源，本组件不保留第二份真源。
 *
 * 交互与可达性（对照原生 `<select>` 不得退化）：
 *  - 触发体是 `role="combobox"` 的文本输入：`aria-expanded` / `aria-controls` /
 *    `aria-activedescendant` / `aria-autocomplete` / `aria-label` 全部显式给出；
 *  - 浮层是 `role="listbox"`，候选项是 `role="option"` 且带 `aria-selected`；
 *  - 键盘：↑/↓ 移动高亮、Enter 选中、Esc 关闭且 **stopPropagation**
 *    （避免误关外层抽屉/编辑器）、Tab 正常离开；
 *  - 浮层用 `position: fixed`（脱离祖先 `overflow` 裁剪）+ 底部空间不足时**向上翻转**。
 *
 * 模糊查询规则（对用户直觉友好、且**刻意不过度设计**）：
 *  - 大小写不敏感；忽略输入两端空白；
 *  - 同时匹配**候选项标签**（调用方传入的 label，通常已含「字段名（类型中文名）」）
 *    与可选 `hint` ⇒ 输入「备注」命中该字段；输入「文本」命中所有文本型字段；
 *  - **不做**拼音 / 编辑距离 / 分词（那是过度设计）。
 *  - 无匹配时给出明确空态（`无匹配字段`），绝不渲染一片空白。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

/** 单个候选项 */
export interface FieldSelectOption {
  /** 稳定值（如字段 id）；允许空串表示「未绑定」这类空选项 */
  value: string;
  /** 展示标签（通常为「字段名（类型中文名）」） */
  label: string;
  /** 可选次要说明（展示于右侧，并参与模糊匹配） */
  hint?: string;
}

export interface FieldSelectProps {
  /** 候选集（受控；调用方负责过滤，如按字段类型过滤 / 剔除不可筛字段） */
  options: ReadonlyArray<FieldSelectOption>;
  /** 当前值（受控唯一真源） */
  value: string;
  /** 值变更回调（本组件不做任何业务加工，原样上交所选 value） */
  onChange: (next: string) => void;
  /** 是否可输入搜索（两处调用方均传 true；false 时退化为只读下拉） */
  searchable?: boolean;
  /** 无选中值时显示的占位文案 */
  placeholder?: string;
  /** 禁用 */
  disabled?: boolean;
  /** 触发体上的 `data-testid`（沿用调用方原有 testid） */
  testId?: string;
  /** 触发体上的 `aria-label` */
  ariaLabel?: string;
  /** 供 label 的 `htmlFor` 关联（原生控件曾用 id 关联标签） */
  id?: string;
  /** 无效态：为 true 时触发体带 `aria-invalid="true"`（沿用原有无障碍契约） */
  invalid?: boolean;
}

/** 无匹配时的空态文案（测试锁定确切文本） */
export const FIELD_SELECT_EMPTY_TEXT = '无匹配字段';

/** 浮层估算最大高度（用于翻转判定；与 CSS 的 max-height 同量级） */
export const FIELD_SELECT_POPUP_MAX_HEIGHT = 240;

/** SSR / 无布局环境下的浮层兜底定位 */
const FALLBACK_POPUP_STYLE: CSSProperties = { position: 'fixed', left: 0, top: 0, width: 0 };

/** 归一化查询串：忽略两端空白 + 大小写不敏感 */
export function normalizeFieldQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 单项是否命中查询（标签或 hint 包含即命中；空查询恒命中） */
export function matchFieldOption(option: FieldSelectOption, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;
  if (option.label.toLowerCase().includes(normalizedQuery)) return true;
  if (option.hint && option.hint.toLowerCase().includes(normalizedQuery)) return true;
  return false;
}

/**
 * 过滤候选集（纯函数，供组件与单测共用）。
 * 空查询 → 原样返回**全部**候选（保证「打开即全量可选」）。
 */
export function filterFieldOptions(
  options: ReadonlyArray<FieldSelectOption>,
  query: string,
): FieldSelectOption[] {
  const normalized = normalizeFieldQuery(query);
  if (normalized === '') return options.slice();
  return options.filter((option) => matchFieldOption(option, normalized));
}

/**
 * 浮层是否应**向上**展开（纯函数）：
 * 下方空间够 → 向下；不够且上方更大 → 向上；否则（上方更小）仍向下。
 */
export function shouldDropUp(
  trigger: { top: number; bottom: number },
  viewportHeight: number,
  popupHeight: number = FIELD_SELECT_POPUP_MAX_HEIGHT,
): boolean {
  const spaceBelow = viewportHeight - trigger.bottom;
  if (spaceBelow >= popupHeight) return false;
  return trigger.top > spaceBelow;
}

/**
 * 可搜索字段选择器。
 *
 * ⚠️ 完全受控：内部只保存「浮层开关 / 查询串 / 高亮项」这类**纯 UI 态**，
 *    **不保存值**——值只来自 `value`，变更只经 `onChange`。
 */
export function FieldSelect({
  options,
  value,
  onChange,
  searchable = false,
  placeholder = '请选择',
  disabled = false,
  testId,
  ariaLabel,
  id,
  invalid = false,
}: FieldSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>(FALLBACK_POPUP_STYLE);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;

  const filtered = useMemo(() => filterFieldOptions(options, query), [options, query]);
  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);
  const displayLabel = selected ? selected.label : value;
  const canEdit = searchable && !disabled;
  const activeDescendant = open && filtered.length > 0 ? `${reactId}-option-${highlight}` : undefined;

  const popupTestId = testId ? `${testId}-popup` : undefined;
  const emptyTestId = testId ? `${testId}-empty` : undefined;
  const optionTestId = testId ? `${testId}-option` : undefined;

  /** 依据触发体位置计算浮层几何（fixed 定位 + 翻转） */
  const positionPopup = useCallback((): void => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined') {
      setPopupStyle(FALLBACK_POPUP_STYLE);
      setDropUp(false);
      return;
    }
    const rect = root.getBoundingClientRect();
    const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
    const up = shouldDropUp({ top: rect.top, bottom: rect.bottom }, viewportHeight);
    const available = up ? rect.top : viewportHeight - rect.bottom;
    setDropUp(up);
    setPopupStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      top: up ? undefined : rect.bottom + 2,
      bottom: up ? viewportHeight - rect.top + 2 : undefined,
      maxHeight: Math.max(120, available - 8),
    });
  }, []);

  const closeList = (): void => {
    setOpen(false);
    setQuery('');
  };

  /** 打开浮层：把高亮落在当前值上（找不到则第一项），并定位浮层 */
  const openList = (): void => {
    if (disabled) return;
    const at = filtered.findIndex((option) => option.value === value);
    setHighlight(at >= 0 ? at : 0);
    setQuery('');
    positionPopup();
    setOpen(true);
  };

  /** 选中第 index 个候选项（过滤后的视图下标） */
  const selectAt = (index: number): void => {
    const option = filtered[index];
    if (!option) return;
    onChange(option.value);
    closeList();
    inputRef.current?.focus();
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
        if (filtered.length > 0) selectAt(highlight);
        else closeList();
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

  /* 打开期间跟随滚动 / 改变窗口尺寸重新定位（fixed 定位不随祖先滚动自动移动） */
  useEffect(() => {
    if (!open) return undefined;
    const onReflow = (): void => positionPopup();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, positionPopup]);

  /* 高亮项滚动入视野（jsdom 无 scrollIntoView → 守卫） */
  useEffect(() => {
    if (!open) return undefined;
    const node = optionRefs.current[highlight];
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    return undefined;
  }, [open, highlight]);

  const rootClassName =
    'cbv-fieldselect' +
    (open ? ' cbv-fieldselect--open' : '') +
    (disabled ? ' cbv-fieldselect--disabled' : '');

  return (
    <div ref={rootRef} className={rootClassName} data-field-select="true" style={{ position: 'relative', display: 'inline-flex' }}>
      <input
        ref={inputRef}
        id={id}
        className="cbv-fieldselect__input"
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
        value={open ? query : displayLabel}
        placeholder={displayLabel === '' ? placeholder : displayLabel}
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

      {open ? (
        <div
          className="cbv-fieldselect__popup"
          data-testid={popupTestId}
          data-placement={dropUp ? 'top' : 'bottom'}
          style={popupStyle}
        >
          {filtered.length === 0 ? (
            <div className="cbv-fieldselect__empty" role="status" data-testid={emptyTestId}>
              {FIELD_SELECT_EMPTY_TEXT}
            </div>
          ) : null}
          <ul id={listboxId} className="cbv-fieldselect__list" role="listbox" aria-label={ariaLabel}>
            {filtered.map((option, index) => (
              <li
                key={option.value}
                id={`${reactId}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={
                  'cbv-fieldselect__option' +
                  (index === highlight ? ' cbv-fieldselect__option--active' : '') +
                  (option.value === value ? ' cbv-fieldselect__option--selected' : '')
                }
                data-testid={optionTestId}
                data-option-value={option.value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => selectAt(index)}
              >
                <span className="cbv-fieldselect__option-label">{option.label}</span>
                {option.hint ? (
                  <span className="cbv-fieldselect__option-hint" title={option.hint}>
                    {option.hint}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default FieldSelect;
