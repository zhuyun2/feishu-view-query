/**
 * 区块属性表单（M3-T09 / 设计文档 §21.6 右栏「区块属性」段）。
 *
 * ⭐ 数据驱动（硬性要求 1）：**不为 12 类区块各手写一份表单**。
 *  - 每类的可配置属性由本文件的属性模式表 `PROP_SCHEMA` **声明**（纯数据，无 JSX）；
 *  - 所有区块共有的基类属性（`breakInside` / `style.*` / `visibleWhen` / `note`）由
 *    `BLOCK_BASE_PROP_SPECS` 统一追加，**不逐类重复书写**；
 *  - 字段选择器的可绑定字段类型由 `doc/blockCatalog.ts` 的 `supportedFieldTypes` 驱动。
 *
 * ⚠️ 为什么必须数据驱动：**漏写一类区块的表单不会报错**，用户只会看到「这个区块不能配置」，
 * 属静默功能性缺陷。因此「目录（`blockCatalog`）覆盖 12 类」与「模式表覆盖 12 类」这两处口径
 * 由 `BlockPropertyForm.test.tsx` **逐类断言字段集合**（含 `pageBreak` 这类无专属属性者，
 * 也必须渲染出基类属性，故其表单**绝不为空**）。
 *
 * 渲染契约：每个属性行带 `data-prop-key={spec.key}`、`data-prop-control={spec.control}`，
 * 供测试按 kind 断言「该类的属性字段集合」。
 */
import { memo } from 'react';
import type { DocBlock, RuleCondition } from '@/config/types';
import type { FieldMetaLite, FieldTypeValue } from '@/fields/fieldTypes';
import { getFieldTypeLabel } from '@/fields/fieldTypes';
import type { LinkTargetFieldsState } from '@/hooks/useLinkTargetFields';
import { FieldSelect } from '@/components/common/FieldSelect';
import type { FieldSelectOption } from '@/components/common/FieldSelect';
import { getCatalogEntry } from '@/doc/blockCatalog';
import { LinkColumnsSection } from './LinkColumnsSection';

/* ============================ 模式（纯数据 / 纯函数） ============================ */

/** 属性分组（渲染顺序由 `PROP_GROUP_ORDER` 决定） */
export type PropGroup = 'content' | 'layout' | 'behavior';

export const PROP_GROUP_LABEL: Readonly<Record<PropGroup, string>> = {
  content: '内容',
  layout: '布局与样式',
  behavior: '条件与备注',
};

export const PROP_GROUP_ORDER: readonly PropGroup[] = ['content', 'layout', 'behavior'];

/** 控件类型（值 → 通用控件的映射，`renderControl` 实现） */
export type PropControl =
  | 'text'
  | 'multiline'
  | 'number'
  | 'select'
  | 'toggle'
  | 'fieldPicker'
  | 'multiFieldPicker'
  | 'fieldRows'
  | 'multiEnum';

export interface PropOption {
  value: string | number;
  label: string;
}

export interface PropFieldSpec {
  /** 数据键：支持点路径（如 `source.type` / `style.align`） */
  key: string;
  label: string;
  control: PropControl;
  group: PropGroup;
  /** `select` / `multiEnum` 的候选项 */
  options?: readonly PropOption[];
  min?: number;
  max?: number;
  step?: number;
  /** 数字控件允许「未设置」（空输入 → `undefined`） */
  optional?: boolean;
  /** 字段选择器的类型过滤；缺省 = 目录 `supportedFieldTypes` */
  fieldTypes?: readonly FieldTypeValue[];
  /** 仅在 `getValueAt(block, path) === equals` 时可用（不可用时**仍渲染**，以稳定字段集合） */
  enabledWhen?: { path: string; equals: unknown };
  /** 无字段可选时禁用（如「条件显隐」需要至少一个字段） */
  requiresFields?: boolean;
  hint?: string;
  /** 判别式切换等需要**整体替换**某个键时的补丁构造器（`source` / `rowSource`） */
  toPatch?: (args: { block: DocBlock; value: unknown; fields: readonly FieldMetaLite[] }) => Record<string, unknown>;
}

/** 读取点路径值（越界 / 非对象 → `undefined`） */
export function getValueAt(source: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 由点路径构造**浅合并补丁**：`updateBlock()` 只做一层浅合并，故中间层需自行补全
 * （`style.align` → `{ style: { ...旧 style, align } }`）。
 */
export function buildPatch(base: unknown, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.');
  const [head, ...rest] = segments;
  if (rest.length === 0) return { [head]: value };
  const parent = typeof base === 'object' && base !== null ? (base as Record<string, unknown>) : {};
  const childBase = parent[head];
  const child =
    typeof childBase === 'object' && childBase !== null ? (childBase as Record<string, unknown>) : {};
  return { [head]: { ...child, ...buildPatch(childBase, rest.join('.'), value) } };
}

const ALIGN_OPTIONS: readonly PropOption[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
  { value: 'justify', label: '两端对齐' },
];

const BREAK_OPTIONS: readonly PropOption[] = [
  { value: 'auto', label: '允许跨页' },
  { value: 'avoid', label: '整体不跨页' },
];

/** `metaFooter` 可选的元信息项（对应 `MetaFooterBlock.fields` 的联合类型） */
export const META_FIELD_OPTIONS: readonly PropOption[] = [
  { value: 'createdUser', label: '创建人' },
  { value: 'createdTime', label: '创建时间' },
  { value: 'modifiedUser', label: '修改人' },
  { value: 'modifiedTime', label: '修改时间' },
  { value: 'recordId', label: '记录 ID' },
];

/** 默认的「条件显隐」条件（开启开关时写入；无字段 → 不写入，见 `requiresFields`） */
export function defaultVisibleWhen(fields: readonly FieldMetaLite[]): RuleCondition | null {
  if (fields.length === 0) return null;
  return { logic: 'and', items: [{ fieldId: fields[0].id, operator: 'isNotEmpty' }] };
}

/** 基类公共属性（**所有** kind 均追加，避免逐类重复） */
export const BLOCK_BASE_PROP_SPECS: readonly PropFieldSpec[] = [
  {
    key: 'breakInside',
    label: '分页行为',
    control: 'select',
    group: 'layout',
    options: BREAK_OPTIONS,
    hint: '「整体不跨页」时该块会整体移到下一页',
  },
  { key: 'style.align', label: '对齐', control: 'select', group: 'layout', options: ALIGN_OPTIONS },
  { key: 'style.marginTop', label: '上间距', control: 'number', group: 'layout', min: 0, max: 200, step: 1, optional: true },
  {
    key: 'style.marginBottom',
    label: '下间距',
    control: 'number',
    group: 'layout',
    min: 0,
    max: 200,
    step: 1,
    optional: true,
  },
  {
    key: 'visibleWhen',
    label: '条件显隐',
    control: 'toggle',
    group: 'behavior',
    requiresFields: true,
    hint: '开启后仅在「首字段非空」时显示该块',
    toPatch: ({ value, fields }) => ({ visibleWhen: value ? defaultVisibleWhen(fields) : null }),
  },
  { key: 'note', label: '备注', control: 'text', group: 'behavior', hint: '仅编辑器内部标识，不参与渲染' },
];

/** 逐类专属属性（**声明式**；顺序即渲染顺序） */
export const PROP_SCHEMA: Readonly<Record<DocBlock['kind'], readonly PropFieldSpec[]>> = {
  heading: [
    {
      key: 'level',
      label: '标题层级',
      control: 'select',
      group: 'content',
      options: [
        { value: 1, label: '一级标题' },
        { value: 2, label: '二级标题' },
        { value: 3, label: '三级标题' },
      ],
    },
    {
      key: 'source.type',
      label: '内容来源',
      control: 'select',
      group: 'content',
      options: [
        { value: 'static', label: '静态文本' },
        { value: 'field', label: '绑定字段' },
      ],
      toPatch: ({ block, value, fields }) => {
        const source = (block as { source?: { type?: string; text?: string; fieldId?: string } }).source;
        if (value === 'field') {
          const fieldId = source?.type === 'field' && source.fieldId ? source.fieldId : fields[0]?.id ?? '';
          return { source: { type: 'field', fieldId } };
        }
        const text = source?.type === 'static' && typeof source.text === 'string' ? source.text : '标题';
        return { source: { type: 'static', text } };
      },
    },
    { key: 'source.text', label: '静态文本', control: 'text', group: 'content', enabledWhen: { path: 'source.type', equals: 'static' } },
    { key: 'source.fieldId', label: '绑定字段', control: 'fieldPicker', group: 'content', enabledWhen: { path: 'source.type', equals: 'field' } },
    { key: 'hideWhenEmpty', label: '空值隐藏', control: 'toggle', group: 'content' },
  ],
  paragraph: [
    { key: 'fieldId', label: '内容字段', control: 'fieldPicker', group: 'content' },
    { key: 'preserveLineBreaks', label: '保留换行', control: 'toggle', group: 'content' },
    { key: 'hideWhenEmpty', label: '空值隐藏', control: 'toggle', group: 'content' },
    { key: 'maxLines', label: '最大行数', control: 'number', group: 'content', min: 1, max: 999, step: 1, optional: true },
  ],
  richText: [{ key: 'markdown', label: '静态文本', control: 'multiline', group: 'content', hint: '支持 **粗体** / *斜体* / 换行 / - 列表' }],
  keyValueGrid: [
    { key: 'columns', label: '列数', control: 'select', group: 'content', options: [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} 列` })) },
    { key: 'rows', label: '字段行', control: 'fieldRows', group: 'content' },
    { key: 'labelWidthPx', label: '标签列宽', control: 'number', group: 'layout', min: 40, max: 240, step: 4 },
    { key: 'showColon', label: '标签后加冒号', control: 'toggle', group: 'layout' },
    { key: 'zebra', label: '斑马纹', control: 'toggle', group: 'layout' },
    { key: 'hideEmptyRows', label: '隐藏空行', control: 'toggle', group: 'content' },
  ],
  fieldList: [
    { key: 'items', label: '字段项', control: 'fieldRows', group: 'content' },
    { key: 'showLabels', label: '显示字段名', control: 'toggle', group: 'layout' },
    { key: 'hideEmptyItems', label: '隐藏空项', control: 'toggle', group: 'content' },
  ],
  badgeRow: [
    { key: 'fieldIds', label: '标签字段', control: 'multiFieldPicker', group: 'content' },
    { key: 'maxItems', label: '最多标签数', control: 'number', group: 'content', min: 1, max: 20, step: 1 },
    { key: 'showLabels', label: '显示字段名', control: 'toggle', group: 'layout' },
  ],
  image: [
    { key: 'fieldId', label: '附件字段', control: 'fieldPicker', group: 'content' },
    {
      key: 'mode',
      label: '取图方式',
      control: 'select',
      group: 'content',
      options: [
        { value: 'first', label: '首张' },
        { value: 'all', label: '全部' },
        { value: 'index', label: '指定序号' },
      ],
    },
    { key: 'index', label: '图片序号', control: 'number', group: 'content', min: 0, max: 99, step: 1, enabledWhen: { path: 'mode', equals: 'index' } },
    { key: 'width', label: '宽度', control: 'number', group: 'layout', min: 40, max: 794, step: 8 },
    { key: 'height', label: '高度', control: 'number', group: 'layout', min: 40, max: 1123, step: 8, optional: true, hint: '留空表示按比例' },
    { key: 'align', label: '对齐', control: 'select', group: 'layout', options: ALIGN_OPTIONS.slice(0, 3) },
    { key: 'caption', label: '图注', control: 'text', group: 'content' },
    { key: 'hideWhenEmpty', label: '空值隐藏', control: 'toggle', group: 'content' },
  ],
  table: [
    { key: 'columns', label: '列', control: 'fieldRows', group: 'content' },
    {
      key: 'rowSource.type',
      label: '行来源',
      control: 'select',
      group: 'content',
      options: [
        { value: 'currentRecord', label: '当前记录' },
        { value: 'linkedRecords', label: '关联记录' },
      ],
      toPatch: ({ block, value, fields }) => {
        const source = (block as { rowSource?: { type?: string; fieldId?: string } }).rowSource;
        if (value === 'linkedRecords') {
          const fieldId = source?.type === 'linkedRecords' && source.fieldId ? source.fieldId : fields[0]?.id ?? '';
          return { rowSource: { type: 'linkedRecords', fieldId } };
        }
        return { rowSource: { type: 'currentRecord' } };
      },
    },
    { key: 'rowSource.fieldId', label: '关联字段', control: 'fieldPicker', group: 'content', enabledWhen: { path: 'rowSource.type', equals: 'linkedRecords' } },
    { key: 'showHeader', label: '显示表头', control: 'toggle', group: 'layout' },
    { key: 'zebra', label: '斑马纹', control: 'toggle', group: 'layout' },
    { key: 'maxRows', label: '最大行数', control: 'number', group: 'content', min: 1, max: 999, step: 1, optional: true },
  ],
  divider: [
    { key: 'thickness', label: '线宽', control: 'number', group: 'layout', min: 1, max: 12, step: 1 },
    {
      key: 'borderStyle',
      label: '线型',
      control: 'select',
      group: 'layout',
      options: [
        { value: 'solid', label: '实线' },
        { value: 'dashed', label: '虚线' },
        { value: 'dotted', label: '点线' },
      ],
    },
  ],
  spacer: [{ key: 'height', label: '高度', control: 'number', group: 'layout', min: 0, max: 240, step: 2 }],
  // `pageBreak` 无专属属性：**仍有基类属性**（故表单非空，见测试断言）
  pageBreak: [],
  metaFooter: [
    { key: 'fields', label: '元信息项', control: 'multiEnum', group: 'content', options: META_FIELD_OPTIONS },
    { key: 'separator', label: '分隔符', control: 'text', group: 'layout' },
    { key: 'fontSize', label: '字号', control: 'number', group: 'layout', min: 8, max: 24, step: 1 },
    { key: 'muted', label: '弱化显示', control: 'toggle', group: 'layout' },
  ],
};

/** 某 kind 的完整属性模式（**专属属性 + 基类属性**，声明顺序） */
export function propertySchemaFor(kind: DocBlock['kind']): readonly PropFieldSpec[] {
  const specific = PROP_SCHEMA[kind] ?? [];
  return [...specific, ...BLOCK_BASE_PROP_SPECS];
}

/** 按分组产出模式（组内顺序 = 模式顺序；组顺序 = `PROP_GROUP_ORDER`） */
export function groupedSchemaFor(kind: DocBlock['kind']): ReadonlyArray<{ group: PropGroup; label: string; specs: readonly PropFieldSpec[] }> {
  const all = propertySchemaFor(kind);
  return PROP_GROUP_ORDER.map((group) => ({
    group,
    label: PROP_GROUP_LABEL[group],
    specs: all.filter((spec) => spec.group === group),
  })).filter((item) => item.specs.length > 0);
}

/** 该 kind 可绑定的字段（类型过滤：专属声明优先，否则取目录 `supportedFieldTypes`） */
export function eligibleFieldsFor(
  kind: DocBlock['kind'],
  fields: readonly FieldMetaLite[],
  spec?: PropFieldSpec,
): FieldMetaLite[] {
  const allowed = spec?.fieldTypes ?? getCatalogEntry(kind)?.supportedFieldTypes ?? [];
  if (allowed.length === 0) return [];
  return fields.filter((field) => (allowed as readonly FieldTypeValue[]).includes(field.type));
}

/** 「未绑定」空候选（取代原生命令式下拉的 `<option value="">（未绑定）</option>`，供清空绑定） */
export const UNBOUND_FIELD_OPTION: FieldSelectOption = { value: '', label: '（未绑定）' };

/**
 * 字段选择器候选集（纯函数）：空候选（可清空绑定）+ **已按字段类型过滤**的字段。
 * ⚠️ 类型过滤发生在调用方（`eligibleFieldsFor`），本函数只负责加空候选与格式化标签，
 *    绝不放宽候选范围——否则 `image` 这类只允许附件字段的区块会选到文本字段。
 */
export function fieldSelectOptions(eligible: readonly FieldMetaLite[]): FieldSelectOption[] {
  return [
    UNBOUND_FIELD_OPTION,
    ...eligible.map((field) => ({
      value: field.id,
      label: `${field.name}（${getFieldTypeLabel(field.type)}）`,
    })),
  ];
}

/* ============================ 表单组件 ============================ */

export interface BlockPropertyFormProps {
  block: DocBlock;
  fields: FieldMetaLite[];
  /** 提交区块补丁（由调用方经 `blockMath.updateBlock` 写入草稿） */
  onChange: (patch: Record<string, unknown>) => void;
  /** 删除该区块（缺省则不渲染删除按钮） */
  onDelete?: () => void;
  /**
   * ⭐ 需求 2 · 第二阶段：关联字段 id → **目标表字段状态**（「关联记录显示列」配置段用）。
   * 缺省 = 未接线 → 该段显示降级文案（不可读取，按默认列）。
   */
  linkTargetFields?: Readonly<Record<string, LinkTargetFieldsState>>;
  /** ⭐ 需求 2 · 第二阶段：按需解析关联字段的目标表字段（缺省 = 不可读取） */
  onEnsureLinkFields?: (fieldId: string) => void;
}

function controlId(blockId: string, key: string): string {
  return `cbv-prop-${blockId}-${key.replace(/\./g, '-')}`;
}

function BlockPropertyFormInner({
  block,
  fields,
  onChange,
  onDelete,
  linkTargetFields,
  onEnsureLinkFields,
}: BlockPropertyFormProps): JSX.Element {
  const kind = block.kind;
  const groups = groupedSchemaFor(kind);

  const commit = (spec: PropFieldSpec, value: unknown): void => {
    if (spec.toPatch) {
      onChange(spec.toPatch({ block, value, fields }));
      return;
    }
    onChange(buildPatch(block as unknown as Record<string, unknown>, spec.key, value));
  };

  const renderControl = (spec: PropFieldSpec): JSX.Element => {
    const raw = getValueAt(block, spec.key);
    const id = controlId(block.blockId, spec.key);
    const eligible = spec.control.startsWith('field') || spec.control === 'fieldPicker' || spec.control === 'multiFieldPicker' || spec.control === 'fieldRows'
      ? eligibleFieldsFor(kind, fields, spec)
      : [];
    const enabledByPath = spec.enabledWhen ? getValueAt(block, spec.enabledWhen.path) === spec.enabledWhen.equals : true;
    const disabled = !enabledByPath || (spec.requiresFields === true && fields.length === 0);

    switch (spec.control) {
      case 'multiline':
        return (
          <textarea
            id={id}
            className="cbv-prop-field__control"
            rows={4}
            value={typeof raw === 'string' ? raw : ''}
            disabled={disabled}
            onChange={(event) => commit(spec, event.target.value)}
          />
        );

      case 'number': {
        const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : '';
        return (
          <input
            id={id}
            className="cbv-prop-field__control"
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={numeric}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value;
              if (text === '') {
                commit(spec, spec.optional ? undefined : 0);
                return;
              }
              commit(spec, Number(text));
            }}
          />
        );
      }

      case 'select':
        return (
          <select
            id={id}
            className="cbv-prop-field__control"
            value={raw === undefined || raw === null ? '' : String(raw)}
            disabled={disabled}
            onChange={(event) => {
              const found = (spec.options ?? []).find((option) => String(option.value) === event.target.value);
              commit(spec, found ? found.value : event.target.value);
            }}
          >
            {(spec.options ?? []).map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case 'toggle': {
        const checked = spec.key === 'visibleWhen' ? raw !== undefined && raw !== null : raw === true;
        return (
          <input
            id={id}
            className="cbv-prop-field__control cbv-prop-field__control--toggle"
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={spec.label}
            onChange={(event) => commit(spec, event.target.checked)}
          />
        );
      }

      case 'fieldPicker':
        return (
          // ⭐ 换成共享的 `FieldSelect`（可搜索，字段多时靠模糊查询定位）；
          //    onChange 语义**原样**保留：值直接 `commit(spec, next)` 构造区块补丁。
          <FieldSelect
            id={id}
            options={fieldSelectOptions(eligible)}
            value={typeof raw === 'string' ? raw : ''}
            onChange={(next) => commit(spec, next)}
            searchable
            testId={id}
            ariaLabel={spec.label}
            disabled={disabled}
          />
        );

      case 'multiFieldPicker': {
        const list = Array.isArray(raw) ? (raw as unknown[]).map((item) => String(item)) : [];
        return (
          <div className="cbv-prop-field__checks">
            {eligible.length === 0 ? (
              <span className="cbv-prop-field__hint">无可用字段</span>
            ) : (
              eligible.map((field) => (
                <label key={field.id} className="cbv-prop-field__check">
                  <input
                    type="checkbox"
                    checked={list.includes(field.id)}
                    disabled={disabled}
                    aria-label={field.name}
                    onChange={() => {
                      const next = list.includes(field.id)
                        ? list.filter((item) => item !== field.id)
                        : [...list, field.id];
                      commit(spec, next);
                    }}
                  />
                  <span>{field.name}</span>
                </label>
              ))
            )}
          </div>
        );
      }

      case 'fieldRows': {
        const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
        return (
          <div className="cbv-prop-field__rows">
            {rows.map((row, index) => (
              <div key={`${id}-row-${index}`} className="cbv-prop-field__row" data-prop-row-index={index}>
                {/* 逐行字段绑定：同样换成可搜索的 `FieldSelect`，`commit` 语义原样保留 */}
                <FieldSelect
                  options={fieldSelectOptions(eligible)}
                  value={typeof row.fieldId === 'string' ? row.fieldId : ''}
                  onChange={(next) => {
                    const nextRows = rows.map((item, at) => (at === index ? { ...item, fieldId: next } : item));
                    commit(spec, nextRows);
                  }}
                  searchable
                  testId={`${id}-row-${index}`}
                  ariaLabel={`第 ${index + 1} 行字段`}
                  disabled={disabled}
                />
                <button
                  type="button"
                  className="cbv-btn cbv-btn--mini"
                  aria-label={`移除第 ${index + 1} 行`}
                  disabled={disabled}
                  onClick={() => commit(spec, rows.filter((_item, at) => at !== index))}
                >
                  移除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="cbv-btn cbv-btn--mini"
              disabled={disabled}
              onClick={() => commit(spec, [...rows, { fieldId: eligible[0]?.id ?? '' }])}
            >
              添加一行
            </button>
          </div>
        );
      }

      case 'multiEnum': {
        const list = Array.isArray(raw) ? (raw as unknown[]).map((item) => String(item)) : [];
        return (
          <div className="cbv-prop-field__checks">
            {(spec.options ?? []).map((option) => (
              <label key={String(option.value)} className="cbv-prop-field__check">
                <input
                  type="checkbox"
                  checked={list.includes(String(option.value))}
                  disabled={disabled}
                  aria-label={option.label}
                  onChange={() => {
                    const value = String(option.value);
                    const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
                    commit(spec, next);
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        );
      }

      case 'text':
      default:
        return (
          <input
            id={id}
            className="cbv-prop-field__control"
            type="text"
            value={typeof raw === 'string' ? raw : ''}
            disabled={disabled}
            onChange={(event) => commit(spec, event.target.value)}
          />
        );
    }
  };

  const catalog = getCatalogEntry(kind);

  return (
    <div
      className="cbv-blockform"
      data-block-form="true"
      data-block-form-kind={kind}
      data-prop-count={propertySchemaFor(kind).length}
    >
      <div className="cbv-blockform__head">
        <span className="cbv-blockform__kind">{catalog?.label ?? kind}</span>
        <span className="cbv-blockform__id" title={block.blockId}>
          {block.blockId}
        </span>
      </div>

      {groups.map((group) => (
        <section key={group.group} className="cbv-blockform__group" data-prop-group={group.group}>
          <div className="cbv-blockform__group-title">{group.label}</div>
          {group.specs.map((spec) => (
            <div
              key={spec.key}
              className="cbv-prop-field"
              data-prop-key={spec.key}
              data-prop-control={spec.control}
              data-prop-disabled={spec.enabledWhen && getValueAt(block, spec.enabledWhen.path) !== spec.enabledWhen.equals ? 'true' : 'false'}
            >
              <label className="cbv-prop-field__label" htmlFor={controlId(block.blockId, spec.key)}>
                {spec.label}
              </label>
              {renderControl(spec)}
              {spec.hint ? <span className="cbv-prop-field__hint">{spec.hint}</span> : null}
            </div>
          ))}
        </section>
      ))}

      {/*
       * ⭐ 需求 2 · 第二阶段：「关联记录显示列」独立配置段。
       * 仅当所选区块绑定了关联字段（Link/DuplexLink）时渲染（否则该组件返回 null）。
       * 刻意**不并入** `PROP_SCHEMA`：该段依赖异步候选项 + 按绑定项区分，
       * 与「纯数据 + 同步」的模式表不同构；独立成段可保持 12 类 `data-prop-key` 契约不变。
       */}
      <LinkColumnsSection
        block={block}
        fields={fields}
        linkTargetFields={linkTargetFields}
        onEnsure={onEnsureLinkFields}
        onChange={onChange}
      />

      {onDelete ? (
        <button type="button" className="cbv-btn cbv-btn--danger cbv-blockform__delete" onClick={onDelete}>
          删除该区块
        </button>
      ) : null}
    </div>
  );
}

export const BlockPropertyForm = memo(BlockPropertyFormInner);
BlockPropertyForm.displayName = 'BlockPropertyForm';

export default BlockPropertyForm;
