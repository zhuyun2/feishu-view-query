/**
 * 区块库元数据目录（设计文档 §5.2 区块库 / §21.3.3 `BlockCatalogEntry`）。
 *
 * 纯数据 + 纯函数：不依赖组件、不依赖运行时配置，供编辑器左栏（`BlockLibrary`）与单测消费。
 *
 * 分组口径严格对齐 §5.2「文本 / 字段 / 媒体 / 结构 / 元信息」5 组，共 **12 类**区块
 * （title/paragraph/richText · 3 + keyValueGrid/fieldList/badgeRow · 3 + image/table · 2
 *  + divider/spacer/pageBreak · 3 + metaFooter · 1 = 12）。
 *
 * ⚠️ 计数说明：§21 个别处（§21.2 文件清单、§21.6、§21.8 M3-T03、§21.13 P0-12）写作「11 类」，
 * 但 `DocBlockKind` 联合类型与 §5.2 / §16 T16 / P0-12（§16）均明确为 **12 类**；本目录以类型为准则取 12，
 * 若缺任一类将导致该区块在编辑器中不可拖入，属功能性缺陷。此偏差已在任务报告中登记。
 */
import type { BreakInside, DocBlock } from '@/config/types';
import { FieldType } from '@/fields/fieldTypes';
import type { FieldTypeValue } from '@/fields/fieldTypes';

/** 区块库 5 个语义分组 */
export type BlockGroup = 'text' | 'field' | 'media' | 'structure' | 'meta';

/** 单个区块的目录元数据 */
export interface BlockCatalogEntry {
  /** 区块类型（= `DocBlockKind`） */
  kind: DocBlock['kind'];
  /** 所属分组 */
  group: BlockGroup;
  /** 中文名（区块库项文案，§5.2） */
  label: string;
  /** 图标 key（04 §S4 区块库项左侧图标，交由图标组件解析） */
  icon: string;
  /** 从区块库拖入文档流时该区块的默认分页行为 */
  defaultBreakInside: BreakInside;
  /** 是否可绑定字段（false = 纯静态 / 结构类区块） */
  bindable: boolean;
  /** 可绑定的字段类型（`bindable=false` 时为空；供属性面板字段选择器过滤） */
  supportedFieldTypes: readonly FieldTypeValue[];
  /** 新建时的默认尺寸提示（px；渲染层 / 属性面板作为初值） */
  defaultSize?: { width?: number; height?: number };
  /** 区块库 tooltip 说明（§5.2「说明」列） */
  description: string;
}

/** 单值 / 文本型字段（标题、段落等直接以文本呈现的绑定块） */
const SCALAR_TYPES: readonly FieldTypeValue[] = [
  FieldType.Text,
  FieldType.Number,
  FieldType.Currency,
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.DateTime,
  FieldType.Checkbox,
];

/** 标签型字段（标签行 `badgeRow`） */
const TAG_TYPES: readonly FieldTypeValue[] = [
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.User,
  FieldType.GroupChat,
  FieldType.Progress,
  FieldType.Rating,
  FieldType.Checkbox,
];

/** 附件字段（图片 `image`） */
const ATTACHMENT_TYPES: readonly FieldTypeValue[] = [FieldType.Attachment];

/**
 * 全部字段类型（键值网格 / 字段清单 / 表格可绑定任意字段）。
 * 通过枚举反向映射剔除数字键，只取成员名（纯函数、无魔法字符串）。
 */
const ALL_FIELD_TYPES: readonly FieldTypeValue[] = Object.keys(FieldType)
  .filter((key) => Number.isNaN(Number(key)))
  .map((key) => FieldType[key as keyof typeof FieldType]);

/** 分组展示顺序（左栏自上而下，与 §5.2 一致） */
export const BLOCK_GROUP_ORDER: readonly BlockGroup[] = ['text', 'field', 'media', 'structure', 'meta'];

/** 分组中文名 */
export const BLOCK_GROUP_LABEL: Readonly<Record<BlockGroup, string>> = {
  text: '文本',
  field: '字段',
  media: '媒体',
  structure: '结构',
  meta: '元信息',
};

/** ⭐ 区块库目录（5 组 12 类），顺序即左栏展示顺序 */
export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = [
  // ── 文本 ──
  {
    kind: 'heading',
    group: 'text',
    label: '标题',
    icon: 'heading',
    defaultBreakInside: 'avoid',
    bindable: true,
    supportedFieldTypes: SCALAR_TYPES,
    description: '标题层级（可静态文本或绑定字段）',
  },
  {
    kind: 'paragraph',
    group: 'text',
    label: '段落',
    icon: 'paragraph',
    defaultBreakInside: 'auto',
    bindable: true,
    supportedFieldTypes: SCALAR_TYPES,
    description: '字段长文本，按行跨页',
  },
  {
    kind: 'richText',
    group: 'text',
    label: '静态文本',
    icon: 'richText',
    defaultBreakInside: 'auto',
    bindable: false,
    supportedFieldTypes: [],
    description: '静态说明，支持极简 markdown 子集',
  },
  // ── 字段 ──
  {
    kind: 'keyValueGrid',
    group: 'field',
    label: '键值网格',
    icon: 'keyValueGrid',
    defaultBreakInside: 'avoid',
    bindable: true,
    supportedFieldTypes: ALL_FIELD_TYPES,
    description: '键值网格（最常用）',
  },
  {
    kind: 'fieldList',
    group: 'field',
    label: '字段清单',
    icon: 'fieldList',
    defaultBreakInside: 'auto',
    bindable: true,
    supportedFieldTypes: ALL_FIELD_TYPES,
    description: '纵向字段清单',
  },
  {
    kind: 'badgeRow',
    group: 'field',
    label: '标签行',
    icon: 'badgeRow',
    defaultBreakInside: 'avoid',
    bindable: true,
    supportedFieldTypes: TAG_TYPES,
    description: '标签行（选项 / 成员等）',
  },
  // ── 媒体 ──
  {
    kind: 'image',
    group: 'media',
    label: '图片',
    icon: 'image',
    defaultBreakInside: 'avoid',
    bindable: true,
    supportedFieldTypes: ATTACHMENT_TYPES,
    defaultSize: { width: 240 },
    description: '附件图片',
  },
  {
    kind: 'table',
    group: 'media',
    label: '表格',
    icon: 'table',
    defaultBreakInside: 'auto',
    bindable: true,
    supportedFieldTypes: ALL_FIELD_TYPES,
    description: '关联记录 / 多值表格',
  },
  // ── 结构 ──
  {
    kind: 'divider',
    group: 'structure',
    label: '分隔线',
    icon: 'divider',
    defaultBreakInside: 'avoid',
    bindable: false,
    supportedFieldTypes: [],
    defaultSize: { height: 1 },
    description: '分隔线',
  },
  {
    kind: 'spacer',
    group: 'structure',
    label: '间距',
    icon: 'spacer',
    defaultBreakInside: 'auto',
    bindable: false,
    supportedFieldTypes: [],
    defaultSize: { height: 12 },
    description: '垂直间距',
  },
  {
    kind: 'pageBreak',
    group: 'structure',
    label: '强制分页',
    icon: 'pageBreak',
    defaultBreakInside: 'auto',
    bindable: false,
    supportedFieldTypes: [],
    description: '在此处强制结束当前页（不渲染 DOM）',
  },
  // ── 元信息 ──
  {
    kind: 'metaFooter',
    group: 'meta',
    label: '页脚元信息',
    icon: 'metaFooter',
    defaultBreakInside: 'avoid',
    bindable: false,
    supportedFieldTypes: [],
    description: '创建人 / 创建时间 / 修改时间 / 记录 ID',
  },
];

/** 按 kind 取目录项（未知 kind 返回 undefined，调用方自行兜底） */
export function getCatalogEntry(kind: DocBlock['kind']): BlockCatalogEntry | undefined {
  return BLOCK_CATALOG.find((entry) => entry.kind === kind);
}

/** 分组视图（供左栏按组渲染；组内顺序 = 目录顺序） */
export interface BlockCatalogGroup {
  group: BlockGroup;
  label: string;
  entries: readonly BlockCatalogEntry[];
}

/** 按 `BLOCK_GROUP_ORDER` 产出分组视图（保持确定性） */
export function groupCatalog(): readonly BlockCatalogGroup[] {
  return BLOCK_GROUP_ORDER.map((group) => ({
    group,
    label: BLOCK_GROUP_LABEL[group],
    entries: BLOCK_CATALOG.filter((entry) => entry.group === group),
  }));
}
