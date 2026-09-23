/**
 * 区块默认值工厂（设计文档 §21.2 `doc/blockDefaults.ts` / §5.2 默认 A4 模板）。
 *
 * 编辑器从区块库拖入新块时，由 `defaultBlockFor(kind, fields)` 产出「结构合法、字段绑定合理」的初始块。
 * 默认值风格与 `config/defaults.ts` 的 `defaultDocTemplate()` 保持一致
 * （键值网格 2 列 / 6 个字段、spacer 12px、labelWidthPx 88、页脚元信息「 · 」分隔等），二者不互相矛盾。
 *
 * ⚠️ id 生成的偏差裁定：
 *   - §21.2 提到「复用 `defaults.ts` 的 `createId`」，但 `createId` 内含 `Math.random()` / `Date.now()`，
 *     **不可确定性单测**；
 *   - team-lead 硬约束要求「blockId 生成必须确定性可测」，本模块据此**不裸调随机/时间**，
 *     改用模块级递增序号工厂（`createBlockIdFactory`），并支持通过 `options.makeId` 注入自定义生成器。
 *   - 若确需与既有 `createId` 完全一致的形态，可在调用处注入 `options.makeId = createId`。
 */
import type {
  BadgeRowBlock,
  DividerBlock,
  DocBlock,
  FieldListBlock,
  HeadingBlock,
  ImageBlock,
  KeyValueGridBlock,
  MetaFooterBlock,
  PageBreakBlock,
  ParagraphBlock,
  RichTextBlock,
  SpacerBlock,
  TableBlock,
} from '@/config/types';
import { FieldType, isP0FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite, FieldTypeValue } from '@/fields/fieldTypes';
import {
  DEFAULT_GRID_FIELD_COUNT,
  DEFAULT_KEY_VALUE_COLUMNS,
  MULTI_SELECT_PREVIEW_LIMIT,
} from '@/constants';
import { getCatalogEntry } from './blockCatalog';

/** 区块 id 生成器签名 */
export type BlockIdFactory = (prefix: string) => string;

/** id 生成器句柄（可注入） */
export interface BlockIdFactoryHandle {
  next: BlockIdFactory;
}

/**
 * 确定性 id 工厂：递增序号（`${prefix}_${36 进制序号}`）。
 * 不依赖时间 / 随机，同一调用序列产出完全一致，便于断言与快照。
 */
export function createBlockIdFactory(seed = 0): BlockIdFactoryHandle {
  let counter = seed;
  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}_${counter.toString(36)}`;
    },
  };
}

let defaultIdCounter = 0;

/** 默认 id 生成器（模块级递增；确定性，无时间/随机） */
function defaultMakeId(prefix: string): string {
  defaultIdCounter += 1;
  return `${prefix}_${defaultIdCounter.toString(36)}`;
}

/** 重置默认 id 计数器（仅测试用，保证跨用例确定性） */
export function resetDefaultBlockIdFactory(seed = 0): void {
  defaultIdCounter = seed;
}

/** `defaultBlockFor` 可选参数 */
export interface BlockDefaultOptions {
  /** 自定义 id 生成器；缺省走确定性默认工厂 */
  makeId?: BlockIdFactory;
}

/** 各 kind 的 blockId 前缀（§21.9：区块 id 前缀 `blk_*`） */
const BLOCK_ID_PREFIX: Readonly<Record<DocBlock['kind'], string>> = {
  heading: 'blk_heading',
  paragraph: 'blk_paragraph',
  keyValueGrid: 'blk_kvg',
  fieldList: 'blk_fieldlist',
  badgeRow: 'blk_badge',
  image: 'blk_image',
  table: 'blk_table',
  richText: 'blk_rich',
  divider: 'blk_divider',
  spacer: 'blk_spacer',
  pageBreak: 'blk_pagebreak',
  metaFooter: 'blk_meta',
};

/** 标签型字段（标签行默认绑定） */
const TAG_TYPES: readonly FieldTypeValue[] = [
  FieldType.SingleSelect,
  FieldType.MultiSelect,
  FieldType.User,
  FieldType.GroupChat,
];

/** 关联字段（表格默认行来源） */
const LINK_TYPES: readonly FieldTypeValue[] = [FieldType.Link, FieldType.DuplexLink];

/** 区块内部标识（UI 列表展示用；取目录中文名） */
function blockNote(kind: DocBlock['kind']): string {
  return getCatalogEntry(kind)?.label ?? kind;
}

/** 首个文本字段 */
function firstTextField(fields: readonly FieldMetaLite[]): FieldMetaLite | undefined {
  return fields.find((field) => field.type === FieldType.Text);
}

/** 键值网格默认承载的字段：优先 P0，不足则取全部；最多 `DEFAULT_GRID_FIELD_COUNT` 个 */
function pickGridFields(fields: readonly FieldMetaLite[]): FieldMetaLite[] {
  const p0 = fields.filter((field) => isP0FieldType(field.type));
  const source = p0.length > 0 ? p0 : [...fields];
  return source.slice(0, DEFAULT_GRID_FIELD_COUNT);
}

/** 表格默认列字段：取前 3 个 */
function pickTableFields(fields: readonly FieldMetaLite[]): FieldMetaLite[] {
  return fields.slice(0, 3);
}

/** 标签行默认字段：优先标签型，最多 3 个；无标签型则回退首个字段 */
function pickTagFields(fields: readonly FieldMetaLite[]): FieldMetaLite[] {
  const tagFields = fields.filter((field) => TAG_TYPES.includes(field.type));
  if (tagFields.length > 0) return tagFields.slice(0, 3);
  return fields.length > 0 ? [fields[0]] : [];
}

/** 表格行来源字段：首个关联 / 双向关联字段 */
function pickLinkField(fields: readonly FieldMetaLite[]): FieldMetaLite | undefined {
  return fields.find((field) => LINK_TYPES.includes(field.type));
}

/**
 * 生成某 `kind` 区块的默认实例。
 *
 * @param kind   区块类型
 * @param fields 当前视图字段元数据（用于合理默认绑定；可为空）
 * @param options 可选：注入 id 生成器（默认确定性工厂）
 */
export function defaultBlockFor(
  kind: DocBlock['kind'],
  fields: readonly FieldMetaLite[] = [],
  options: BlockDefaultOptions = {},
): DocBlock {
  const makeId = options.makeId ?? defaultMakeId;
  const list = [...fields];
  const prefix = BLOCK_ID_PREFIX[kind];

  switch (kind) {
    case 'heading': {
      const block: HeadingBlock = {
        blockId: makeId(prefix),
        kind: 'heading',
        breakInside: 'avoid',
        level: 1,
        source: { type: 'static', text: '标题' },
        hideWhenEmpty: false,
        note: blockNote(kind),
      };
      return block;
    }

    case 'paragraph': {
      const field = firstTextField(list) ?? list[0];
      const block: ParagraphBlock = {
        blockId: makeId(prefix),
        kind: 'paragraph',
        breakInside: 'auto',
        fieldId: field ? field.id : '',
        preserveLineBreaks: true,
        hideWhenEmpty: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'keyValueGrid': {
      const block: KeyValueGridBlock = {
        blockId: makeId(prefix),
        kind: 'keyValueGrid',
        breakInside: 'avoid',
        columns: DEFAULT_KEY_VALUE_COLUMNS,
        rows: pickGridFields(list).map((field) => ({ fieldId: field.id })),
        labelWidthPx: 88,
        showColon: true,
        zebra: false,
        hideEmptyRows: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'fieldList': {
      const block: FieldListBlock = {
        blockId: makeId(prefix),
        kind: 'fieldList',
        breakInside: 'auto',
        items: list.map((field) => ({ fieldId: field.id })),
        showLabels: true,
        hideEmptyItems: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'badgeRow': {
      const block: BadgeRowBlock = {
        blockId: makeId(prefix),
        kind: 'badgeRow',
        breakInside: 'avoid',
        fieldIds: pickTagFields(list).map((field) => field.id),
        maxItems: MULTI_SELECT_PREVIEW_LIMIT,
        showLabels: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'image': {
      const field = list.find((item) => item.type === FieldType.Attachment) ?? list[0];
      const block: ImageBlock = {
        blockId: makeId(prefix),
        kind: 'image',
        breakInside: 'avoid',
        fieldId: field ? field.id : '',
        mode: 'first',
        index: 0,
        width: 240,
        align: 'left',
        hideWhenEmpty: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'table': {
      const linkField = pickLinkField(list);
      const block: TableBlock = {
        blockId: makeId(prefix),
        kind: 'table',
        breakInside: 'auto',
        columns: pickTableFields(list).map((field) => ({ fieldId: field.id })),
        rowSource: linkField
          ? { type: 'linkedRecords', fieldId: linkField.id }
          : { type: 'currentRecord' },
        showHeader: true,
        zebra: true,
        note: blockNote(kind),
      };
      return block;
    }

    case 'richText': {
      const block: RichTextBlock = {
        blockId: makeId(prefix),
        kind: 'richText',
        breakInside: 'auto',
        markdown:
          '支持 **粗体**、*斜体*、`行内代码` 与 [链接](https://example.com)。\n\n- 列表项一\n- 列表项二',
        note: blockNote(kind),
      };
      return block;
    }

    case 'divider': {
      const block: DividerBlock = {
        blockId: makeId(prefix),
        kind: 'divider',
        breakInside: 'avoid',
        thickness: 1,
        borderStyle: 'solid',
        note: blockNote(kind),
      };
      return block;
    }

    case 'spacer': {
      const block: SpacerBlock = {
        blockId: makeId(prefix),
        kind: 'spacer',
        breakInside: 'auto',
        height: 12,
        note: blockNote(kind),
      };
      return block;
    }

    case 'pageBreak': {
      const block: PageBreakBlock = {
        blockId: makeId(prefix),
        kind: 'pageBreak',
        breakInside: 'auto',
        note: blockNote(kind),
      };
      return block;
    }

    case 'metaFooter': {
      const block: MetaFooterBlock = {
        blockId: makeId(prefix),
        kind: 'metaFooter',
        breakInside: 'avoid',
        fields: ['createdUser', 'createdTime', 'modifiedTime'],
        separator: ' · ',
        fontSize: 12,
        muted: true,
        note: blockNote(kind),
      };
      return block;
    }
  }
}

/** 全部区块类型的默认实例（供测试 / 编辑器「全部可拖入」校验） */
export function defaultBlocksForAllKinds(
  fields: readonly FieldMetaLite[] = [],
  options: BlockDefaultOptions = {},
): DocBlock[] {
  return (Object.keys(BLOCK_ID_PREFIX) as DocBlock['kind'][]).map((kind) =>
    defaultBlockFor(kind, fields, options),
  );
}
