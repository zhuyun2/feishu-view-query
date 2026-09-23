/**
 * 字段域类型（设计文档 §6.5）。
 * 本模块为纯类型/常量模块（仅 `import type` 引用外部声明），确保可被单测直接加载。
 *
 * ⚠️ 与 SDK 的 FieldType 区分：这里是我们自己的语义枚举，SDK 类型仅以 `import type` 引用。
 */
import type { ReactNode } from 'react';
import type { FieldDisplayOptions, StyleTheme } from '@/config/types';

/** 飞书多维表格字段类型（与官方数值对齐，§6.5 表格） */
export enum FieldType {
  Text = 1,
  Number = 2,
  SingleSelect = 3,
  MultiSelect = 4,
  DateTime = 5,
  Checkbox = 7,
  User = 11,
  Phone = 13,
  Url = 15,
  Attachment = 17,
  Link = 18,
  Lookup = 19,
  Formula = 20,
  DuplexLink = 21,
  Location = 22,
  GroupChat = 23,
  CreatedTime = 1001,
  ModifiedTime = 1002,
  CreatedUser = 1003,
  ModifiedUser = 1004,
  AutoNumber = 1005,
  Barcode = 99001,
  Progress = 99002,
  Currency = 99003,
  Rating = 99004,
}

export type FieldTypeValue = FieldType | number;

export type FieldPriority = 'P0' | 'P1' | 'P2' | 'unsupported';

/** 卡片态 P0 字段类型集合（T06 覆盖范围） */
export const P0_FIELD_TYPES: readonly FieldTypeValue[] = [
  FieldType.Text,
  FieldType.Number,
  FieldType.Currency,
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.DateTime,
  FieldType.Checkbox,
];

/** 字段类型 → 优先级映射（§6.5） */
export const FIELD_TYPE_PRIORITY: Readonly<Record<number, FieldPriority>> = {
  [FieldType.Text]: 'P0',
  [FieldType.Number]: 'P0',
  [FieldType.Currency]: 'P0',
  [FieldType.SingleSelect]: 'P0',
  [FieldType.MultiSelect]: 'P0',
  [FieldType.DateTime]: 'P0',
  [FieldType.Checkbox]: 'P0',
  [FieldType.User]: 'P1',
  [FieldType.CreatedUser]: 'P1',
  [FieldType.ModifiedUser]: 'P1',
  [FieldType.Attachment]: 'P1',
  [FieldType.Rating]: 'P1',
  [FieldType.Progress]: 'P1',
  [FieldType.Phone]: 'P1',
  [FieldType.Url]: 'P1',
  [FieldType.Formula]: 'P1',
  [FieldType.Lookup]: 'P1',
  [FieldType.Link]: 'P1',
  [FieldType.DuplexLink]: 'P1',
  [FieldType.CreatedTime]: 'P1',
  [FieldType.ModifiedTime]: 'P1',
  [FieldType.AutoNumber]: 'P1',
  [FieldType.Location]: 'P2',
  [FieldType.GroupChat]: 'P2',
  [FieldType.Barcode]: 'P2',
};

/** 字段类型中文名（编辑器字段池/不支持提示用） */
export const FIELD_TYPE_LABEL: Readonly<Record<number, string>> = {
  [FieldType.Text]: '文本',
  [FieldType.Number]: '数字',
  [FieldType.SingleSelect]: '单选',
  [FieldType.MultiSelect]: '多选',
  [FieldType.DateTime]: '日期',
  [FieldType.Checkbox]: '复选框',
  [FieldType.User]: '成员',
  [FieldType.Phone]: '电话',
  [FieldType.Url]: '链接',
  [FieldType.Attachment]: '附件',
  [FieldType.Link]: '单向关联',
  [FieldType.Lookup]: '查找引用',
  [FieldType.Formula]: '公式',
  [FieldType.DuplexLink]: '双向关联',
  [FieldType.Location]: '地理位置',
  [FieldType.GroupChat]: '群聊',
  [FieldType.CreatedTime]: '创建时间',
  [FieldType.ModifiedTime]: '修改时间',
  [FieldType.CreatedUser]: '创建人',
  [FieldType.ModifiedUser]: '修改人',
  [FieldType.AutoNumber]: '自动编号',
  [FieldType.Barcode]: '条码',
  [FieldType.Progress]: '进度',
  [FieldType.Currency]: '货币',
  [FieldType.Rating]: '评分',
};

export function getFieldPriority(type: FieldTypeValue): FieldPriority {
  return FIELD_TYPE_PRIORITY[type as number] ?? 'unsupported';
}

export function getFieldTypeLabel(type: FieldTypeValue): string {
  return FIELD_TYPE_LABEL[type as number] ?? '未知类型';
}

export function isP0FieldType(type: FieldTypeValue): boolean {
  return getFieldPriority(type) === 'P0';
}

/**
 * 字段元数据「瘦身版」：跨层流转用（避免把整个 SDK IFieldMeta 泄漏到表现层）。
 * `property` 保留原始属性（用于取选项颜色/货币符号等），但**渲染层不得直接展示**。
 */
export interface FieldMetaLite {
  id: string;
  name: string;
  type: FieldTypeValue;
  isPrimary: boolean;
  property?: unknown;
}

/**
 * SDK 字段元数据 → `FieldMetaLite`。
 * 入参刻意声明为 `unknown`：本模块不依赖 SDK 类型，映射职责留在领域层。
 */
export function toFieldMetaLite(meta: unknown): FieldMetaLite {
  const raw = (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    type: (typeof raw.type === 'number' ? raw.type : FieldType.Text) as FieldTypeValue,
    isPrimary: raw.isPrimary === true,
    property: raw.property,
  };
}

/** 归一化值的语义种类 */
export type NormalizedKind =
  | 'empty'
  | 'text'
  | 'number'
  | 'currency'
  | 'select'
  | 'multiSelect'
  | 'dateTime'
  | 'checkbox'
  | 'user'
  | 'attachment'
  | 'url'
  | 'phone'
  | 'rating'
  | 'progress'
  | 'unsupported';

/** 归一化后的单项（标签/成员/附件等列表项） */
export interface NormalizedItem {
  /** 展示文本（人可见，如选项名 / 成员名 / 文件名） */
  text: string;
  /** 语义颜色（仅用于标签，取值来自字段选项色板序号） */
  colorIndex?: number;
  /** 图片可用地址（附件/头像），无则 undefined */
  imageUrl?: string;
}

/**
 * 归一化值：卡片态与文档态共用的唯一数据视图。
 * 铁律（US-5 AC1）：`text` / `display` 永远是人可见文本，**绝不包含原始 ID 或 JSON**。
 */
export interface NormalizedValue {
  kind: NormalizedKind;
  /** 纯文本（复制、搜索、fallback 用） */
  text: string;
  /** 展示文本（可能与 text 略有差异，如千分位） */
  display: string;
  /** 货币符号（仅 currency；来自字段 property.symbol，缺省时渲染层回退 ¥） */
  symbol?: string;
  /** 列表项（select / multiSelect / user / attachment） */
  items?: NormalizedItem[];
  /** 数值（number / currency / rating / progress） */
  number?: number;
  /** 布尔（checkbox） */
  boolean?: boolean;
  /** 毫秒时间戳（dateTime / createdTime / modifiedTime） */
  timestamp?: number;
  /**
   * 字段**自身**的展示日期格式（已映射为 `formatDate` 方言，如 `YYYY/MM/DD`）。
   *
   * 仅当字段自带明确格式时才有值（当前来源：公式字段的
   * `property.dataType.property.dateFormat`，见 `normalize.normalizeFormulaDate`）。
   * 普通日期字段不设此值，渲染层继续回退到视图级 `ctx.display.dateFormat`。
   */
  dateFormat?: string;
  /** 是否为空（未填） */
  isEmpty: boolean;
}

/** 渲染上下文（卡片态） */
export interface RenderContext {
  fieldMeta: FieldMetaLite;
  display: FieldDisplayOptions;
  theme: StyleTheme;
  locale: string;
}

/** 渲染上下文（文档态，§6.5） */
export interface DocRenderContext extends RenderContext {
  /** 该块是否被分页切分（切分时应避免重复画「字段名:」标签） */
  fragmentIndex: number;
  fragmentsTotal: number;
  /** 文档态是否显示标签前缀 */
  showLabel: boolean;
  labelText?: string;
}

/** 字段渲染器（双态） */
export interface FieldRenderer {
  key: string;
  priority: FieldPriority;
  /** 卡片态：紧凑 */
  renderCard(nv: NormalizedValue, ctx: RenderContext): ReactNode;
  /** 文档态：完整、可跨页、支持长文本 */
  renderDoc(nv: NormalizedValue, ctx: DocRenderContext): ReactNode;
}

/**
 * 文档态标签前缀文本（纯函数）：仅在「需显示标签 + 该区块未被切分或为首片」时返回。
 * 渲染器据此在自身 JSX 内组合，避免把 JSX 帮助函数下沉到纯类型模块。
 */
export function docLabelPrefix(ctx: DocRenderContext): string | null {
  if (!ctx.showLabel || !ctx.labelText) return null;
  if (ctx.fragmentsTotal > 1 && ctx.fragmentIndex > 0) return null;
  return `${ctx.labelText}：`;
}
