/**
 * 「关联记录显示列」配置段（需求 2 · 第二阶段）。
 *
 * 位置：文档排版编辑器右栏「区块属性」表单（`BlockPropertyForm`）**底部**，仅当所选区块
 * **绑定了关联字段**（`Link` 18 / `DuplexLink` 21）时出现。
 *
 * 用户需求（原话）：「目前详情页面可以添加『双向关联』字段显示，但是关联出来的字段显示的信息
 * 太多，我想可以自己设置双向关联字段需要显示哪些关联字段」。
 *
 * 交互：
 *  - 候选 = **目标表字段**（异步经 `useLinkTargetFields` 的 `ensure()`；
 *    目标表 id 取自关联字段 meta 的 `property.tableId`）；
 *  - 用**已交付且冻结**的 `SearchableMultiSelect`（可搜 / 多选 / 单删 / 一键清空）；
 *  - 列上限 {@link LINK_COLUMNS_MAX}（超出 → 明确文案，**拦截**该次变更而非静默截断）；
 *  - 行数上限输入（1~50，留空 = 默认 20）；
 *  - **未配置时展示「默认列」**，让用户知道不配置会看到什么；
 *  - **降级**（拿不到目标表字段）→ 显式文案 {@link LINK_COLUMNS_DEGRADED_TEXT}，**仍可保存**，
 *    绝不白屏 / 静默失败。
 *
 * ⚠️ 为什么是**独立成段**而非并入数据驱动的 `PROP_SCHEMA`：本配置依赖
 *   （a）**异步**候选项、（b）**按绑定项区分**（`fieldList.items[i]` / `keyValueGrid.rows[i]` /
 *   `table`）—— 与「纯数据 + 同步」的属性模式表不同构。独立成段可保持模式表 12 类断言不变
 *   （`BlockPropertyForm.test.tsx`），且不污染 `data-prop-key` / `data-prop-count` 契约。
 */
import { useEffect, useMemo, useState } from 'react';
import type { DocBlock } from '@/config/types';
import type { FieldMetaLite, FieldTypeValue } from '@/fields/fieldTypes';
import { FieldType, getFieldTypeLabel } from '@/fields/fieldTypes';
import { SearchableMultiSelect } from '@/components/common/SearchableMultiSelect';
import type { FieldSelectOption } from '@/components/common/FieldSelect';
import { pickLinkTableColumns } from '@/doc/linkTable';
import type { LinkTargetFieldsState } from '@/hooks/useLinkTargetFields';

/* ============================ 常量（UI 文案 / 限额，集中定义） ============================ */

/** ⭐ 列数上限（用户勾选过多会让关联表横向拥挤；由 UI 拦截并明确告知） */
export const LINK_COLUMNS_MAX = 8;

/** 超出列上限时的文案 */
export const LINK_COLUMNS_MAX_MESSAGE = `最多可选 ${LINK_COLUMNS_MAX} 列，请先移除其它列`;

/** 无法读取目标表字段时的**降级**文案（需求指定原文；仍可保存，按默认列显示） */
export const LINK_COLUMNS_DEGRADED_TEXT = '无法读取关联表的字段，将使用默认列';

/** 正在读取目标表字段时的占位文案 */
export const LINK_COLUMNS_LOADING_TEXT = '正在读取关联表字段…';

/** 该段标题 */
export const LINK_COLUMNS_SECTION_TITLE = '关联记录显示列';

/** 关联字段类型 */
const LINK_TYPES: readonly FieldTypeValue[] = [FieldType.Link, FieldType.DuplexLink];

/* ============================ 纯逻辑（可被单测直接驱动） ============================ */

/** 一个「关联字段绑定」：本区块里某处绑定了关联字段（= 一处可配置列的位置） */
export type LinkBindingScope = 'fieldList' | 'keyValueGrid' | 'table';

export interface LinkBinding {
  scope: LinkBindingScope;
  /** 数组下标（`fieldList.items` / `keyValueGrid.rows`）；`table` 恒为 -1 */
  index: number;
  /** 关联字段 id（当前表字段） */
  fieldId: string;
  /** 关联字段中文名（展示） */
  label: string;
  /** 已配置的目标表列（目标表字段 id，顺序即列顺序） */
  columns: string[];
  /** 已配置的行数上限（未配置 → `undefined`） */
  rowLimit: number | undefined;
}

/** 归一化 `linkColumns`：非数组 / 空串项 → 过滤（保序） */
function readColumns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** 归一化 `linkRowLimit`：非有限数 → `undefined` */
function readRowLimit(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * ⭐ **纯函数**：从区块里收集「关联字段绑定」清单（顺序 = 配置项展示顺序）。
 * 覆盖：`fieldList.items[]` / `keyValueGrid.rows[]` / `table(rowSource=linkedRecords)`。
 */
export function collectLinkBindings(block: DocBlock, fields: readonly FieldMetaLite[]): LinkBinding[] {
  if (!block || typeof block !== 'object') return [];

  const byId: Record<string, FieldMetaLite> = {};
  for (const field of fields) {
    if (field && typeof field.id === 'string' && field.id !== '') byId[field.id] = field;
  }
  const isLinkField = (fieldId: unknown): fieldId is string => {
    if (typeof fieldId !== 'string' || fieldId === '') return false;
    const meta = byId[fieldId];
    return !!meta && LINK_TYPES.includes(meta.type);
  };

  const out: LinkBinding[] = [];
  switch (block.kind) {
    case 'keyValueGrid':
      (block.rows ?? []).forEach((row, index) => {
        if (!isLinkField(row.fieldId)) return;
        out.push({
          scope: 'keyValueGrid',
          index,
          fieldId: row.fieldId,
          label: byId[row.fieldId].name,
          columns: readColumns(row.linkColumns),
          rowLimit: readRowLimit(row.linkRowLimit),
        });
      });
      break;
    case 'fieldList':
      (block.items ?? []).forEach((item, index) => {
        if (!isLinkField(item.fieldId)) return;
        out.push({
          scope: 'fieldList',
          index,
          fieldId: item.fieldId,
          label: byId[item.fieldId].name,
          columns: readColumns(item.linkColumns),
          rowLimit: readRowLimit(item.linkRowLimit),
        });
      });
      break;
    case 'table':
      if (block.rowSource.type === 'linkedRecords' && isLinkField(block.rowSource.fieldId)) {
        out.push({
          scope: 'table',
          index: -1,
          fieldId: block.rowSource.fieldId,
          label: byId[block.rowSource.fieldId].name,
          columns: readColumns(block.linkColumns),
          rowLimit: readRowLimit(block.linkRowLimit),
        });
      }
      break;
    default:
      break;
  }
  return out;
}

/** 构造「写入 `linkColumns`」的区块补丁（`updateBlock` 为浅合并，故按整段替换数组） */
export function buildLinkColumnsPatch(
  block: DocBlock,
  binding: LinkBinding,
  nextColumns: string[],
): Record<string, unknown> {
  // 按 block.kind 判别（binding.scope 与 kind 同源；用 kind 才能让 TS 正确窄化 block）
  if (block.kind === 'table') return { linkColumns: nextColumns };
  if (block.kind === 'keyValueGrid') {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    return { rows: rows.map((row, index) => (index === binding.index ? { ...row, linkColumns: nextColumns } : row)) };
  }
  if (block.kind === 'fieldList') {
    const items = Array.isArray(block.items) ? block.items : [];
    return { items: items.map((item, index) => (index === binding.index ? { ...item, linkColumns: nextColumns } : item)) };
  }
  return {};
}

/**
 * 写入 / 删除绑定项的 `linkRowLimit`（`undefined` → 删键，回到「未配置」语义）。
 * 泛型保留原对象的其它字段（typescript 层面不做 `Record` 索引约束，避免丢失 `FieldBindingItem` 形态）。
 */
function withRowLimit<T extends object>(target: T, limit: number | undefined): T & { linkRowLimit?: number } {
  const copy: T & { linkRowLimit?: number } = { ...target };
  if (limit === undefined) {
    delete copy.linkRowLimit;
  } else {
    copy.linkRowLimit = limit;
  }
  return copy;
}

/**
 * 构造「写入 `linkRowLimit`」的区块补丁。
 * `nextLimit === undefined` 时**删除该键**（写回「未配置」语义；`JSON` 序列化会丢弃 `undefined`）。
 */
export function buildLinkRowLimitPatch(
  block: DocBlock,
  binding: LinkBinding,
  nextLimit: number | undefined,
): Record<string, unknown> {
  if (block.kind === 'table') {
    return nextLimit === undefined ? { linkRowLimit: undefined } : { linkRowLimit: nextLimit };
  }
  if (block.kind === 'keyValueGrid') {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    return { rows: rows.map((row, index) => (index === binding.index ? withRowLimit(row, nextLimit) : row)) };
  }
  if (block.kind === 'fieldList') {
    const items = Array.isArray(block.items) ? block.items : [];
    return { items: items.map((item, index) => (index === binding.index ? withRowLimit(item, nextLimit) : item)) };
  }
  return {};
}

/* ============================ 组件 ============================ */

export interface LinkColumnsSectionProps {
  block: DocBlock;
  fields: readonly FieldMetaLite[];
  /** 关联字段 id → 目标表字段状态（缺省 = 未接线） */
  linkTargetFields?: Readonly<Record<string, LinkTargetFieldsState>>;
  /** 请求解析某关联字段的目标表字段；**缺省 → 视为不可读取**（显示降级文案） */
  onEnsure?: (fieldId: string) => void;
  /** 提交区块补丁（与 `BlockPropertyForm` 同口径） */
  onChange: (patch: Record<string, unknown>) => void;
}

interface LinkColumnsRowProps {
  block: DocBlock;
  binding: LinkBinding;
  state: LinkTargetFieldsState | undefined;
  /** 是否有可用的解析入口（无 → 直接判定为不可读取） */
  canResolve: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}

function LinkColumnsRow({ block, binding, state, canResolve, onChange }: LinkColumnsRowProps): JSX.Element {
  const [error, setError] = useState('');

  const status = state?.status ?? (canResolve ? 'idle' : 'unavailable');
  /** 目标表字段（取稳定引用，避免每次渲染换新数组导致下方 useMemo 失效） */
  const stateFields = state?.fields;
  const targetFields = useMemo<readonly FieldMetaLite[]>(() => stateFields ?? [], [stateFields]);
  const testId = `cbv-linkcols-${block.blockId}-${binding.scope}-${binding.index < 0 ? 'table' : binding.index}`;

  const options = useMemo<FieldSelectOption[]>(
    () => targetFields.map((field) => ({ value: field.id, label: field.name, hint: getFieldTypeLabel(field.type) })),
    [targetFields],
  );

  /** 默认列（未配置时会展示的列）——仅在读到目标表字段时才有内容 */
  const defaultLabels = useMemo(() => pickLinkTableColumns(targetFields).map((column) => column.label), [targetFields]);

  const handleColumns = (next: string[]): void => {
    if (next.length > LINK_COLUMNS_MAX) {
      setError(LINK_COLUMNS_MAX_MESSAGE);
      return;
    }
    setError('');
    onChange(buildLinkColumnsPatch(block, binding, next));
  };

  const handleRowLimit = (text: string): void => {
    if (text === '') {
      onChange(buildLinkRowLimitPatch(block, binding, undefined));
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    onChange(buildLinkRowLimitPatch(block, binding, value));
  };

  const rowLimitValue =
    typeof binding.rowLimit === 'number' && Number.isFinite(binding.rowLimit) ? binding.rowLimit : '';

  return (
    <div
      className="cbv-linkcols__item"
      data-link-cols-item="true"
      data-link-cols-scope={binding.scope}
      data-link-cols-field={binding.fieldId}
      data-link-cols-status={status}
    >
      <div className="cbv-linkcols__title" data-link-cols-title="true">
        {binding.label}
      </div>

      {status === 'ready' ? (
        <SearchableMultiSelect
          options={options}
          value={binding.columns}
          onChange={handleColumns}
          searchable
          searchableHint
          placeholder="默认列（未配置）"
          testId={testId}
          ariaLabel={`${binding.label} 关联记录显示列`}
        />
      ) : status === 'loading' || status === 'idle' ? (
        <div className="cbv-linkcols__loading" data-link-cols-loading="true">
          {LINK_COLUMNS_LOADING_TEXT}
        </div>
      ) : (
        <div className="cbv-linkcols__degraded" data-link-cols-degraded="true" role="status">
          {LINK_COLUMNS_DEGRADED_TEXT}
        </div>
      )}

      {status === 'ready' && defaultLabels.length > 0 ? (
        <div className="cbv-linkcols__hint" data-link-cols-default="true">
          {`未配置时默认显示：${defaultLabels.join('、')}`}
        </div>
      ) : null}

      <div className="cbv-linkcols__limit">
        <label className="cbv-linkcols__limit-label" htmlFor={`${testId}-rowlimit`}>
          显示行数上限
        </label>
        <input
          id={`${testId}-rowlimit`}
          className="cbv-prop-field__control cbv-prop-field__control--num"
          type="number"
          min={1}
          max={50}
          step={1}
          value={rowLimitValue}
          onChange={(event) => handleRowLimit(event.target.value)}
          aria-label={`${binding.label} 关联记录显示行数上限`}
          data-link-cols-rowlimit="true"
        />
        <span className="cbv-linkcols__hint">1~50，留空默认 20</span>
      </div>

      {error !== '' ? (
        <div className="cbv-linkcols__error" role="alert" data-link-cols-error="true">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 关联记录显示列配置段。**无关联字段绑定 → 返回 `null`**（不占位、不干扰其它区块）。
 */
export function LinkColumnsSection({
  block,
  fields,
  linkTargetFields,
  onEnsure,
  onChange,
}: LinkColumnsSectionProps): JSX.Element | null {
  const bindings = useMemo(() => collectLinkBindings(block, fields), [block, fields]);
  const canResolve = typeof onEnsure === 'function';

  // 按需解析目标表字段（懒加载）：仅对**本区块确实绑定的关联字段**发起
  useEffect(() => {
    if (!onEnsure) return;
    for (const binding of bindings) onEnsure(binding.fieldId);
  }, [bindings, onEnsure]);

  if (bindings.length === 0) return null;

  return (
    <section className="cbv-linkcols" data-link-cols-section="true" data-link-cols-count={bindings.length}>
      <div className="cbv-blockform__group-title">{LINK_COLUMNS_SECTION_TITLE}</div>
      {bindings.map((binding) => (
        <LinkColumnsRow
          key={`${binding.scope}-${binding.index}`}
          block={block}
          binding={binding}
          state={linkTargetFields?.[binding.fieldId]}
          canResolve={canResolve}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

export default LinkColumnsSection;
