/**
 * 默认配置工厂（设计文档 §5.2 默认 A4 模板 / §6.3）。
 *
 * ⚠️ `defaultDocTemplate()` 的字段绑定依赖字段元数据，故接受可选 `fields` 入参：
 *  - 传入字段列表：按 §5.2 规则真实绑定（首个文本字段作标题、前 6 个 P0 字段进键值网格、其余进字段清单）；
 *  - 不传（如迁移旧配置时）：生成结构合法但无字段绑定的模板。
 */
import {
  CURRENT_SCHEMA_VERSION,
  type BreakInside,
  type CardLayoutConfig,
  type CardViewConfig,
  type DensityConfig,
  type DetailConfig,
  type DividerBlock,
  type DocBlock,
  type DocTemplate,
  type DocTheme,
  type DrawerConfig,
  type FieldListBlock,
  type FieldPlacement,
  type HeaderFooterConfig,
  type HeadingBlock,
  type KeyValueGridBlock,
  type MetaFooterBlock,
  type PageSetup,
  type SlotConfig,
  type SlotId,
  type SpacerBlock,
  type StyleTheme,
} from './types';
import { FieldType, isP0FieldType } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { defaultFilterConfig } from '@/filter/sanitize';
import {
  DEFAULT_GRID_FIELD_COUNT,
  DEFAULT_KEY_VALUE_COLUMNS,
  DEFAULT_PAGE_MARGIN_PX,
  PLUGIN_VERSION,
} from '@/constants';

let idSeed = 0;

/** 生成稳定前缀的短 id（不依赖 crypto，保证在受限沙箱内可用） */
export function createId(prefix: string): string {
  idSeed += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idSeed.toString(36)}${random}`;
}

/** 生成一个字段落位 */
export function createPlacement(fieldId: string, order: number, label?: string): FieldPlacement {
  return {
    placementId: createId('plc'),
    fieldId,
    order,
    label,
    labelVisible: false,
    display: {
      maxLines: 1,
      truncate: 'ellipsis',
      maxItems: 3,
      hideWhenEmpty: true,
    },
  };
}

function createSlot(id: SlotId, overrides: Partial<SlotConfig> = {}): SlotConfig {
  return {
    id,
    visible: id !== 'subtitle',
    collapsibleWhenEmpty: true,
    direction: id === 'attributes' ? 'column' : 'row',
    separator: ' · ',
    maxItemsPerCard: id === 'attributes' ? 8 : 3,
    placements: [],
    ...overrides,
  };
}

/** 取 P0 字段（保持原顺序） */
function p0Fields(fields: readonly FieldMetaLite[]): FieldMetaLite[] {
  return fields.filter((field) => isP0FieldType(field.type));
}

/** 取首个文本字段 */
function firstTextField(fields: readonly FieldMetaLite[]): FieldMetaLite | undefined {
  return fields.find((field) => field.type === FieldType.Text);
}

/** 默认卡片排版（standard 模板：标题 / 副标题 / 属性 / 底部） */
export function defaultCardLayout(fields: readonly FieldMetaLite[] = []): CardLayoutConfig {
  const list = [...fields];
  const titleField = firstTextField(list) ?? list[0];
  const subtitleField = list.find((field) => field !== titleField);
  const attributesFields = p0Fields(list.filter((field) => field !== titleField)).slice(0, 6);
  const footerFields = list.filter(
    (field) => field.type === FieldType.CreatedTime || field.type === FieldType.ModifiedTime,
  );

  const title = createSlot('title');
  if (titleField) title.placements = [createPlacement(titleField.id, 0)];

  const subtitle = createSlot('subtitle');
  if (subtitleField) subtitle.placements = [createPlacement(subtitleField.id, 0)];

  const attributes = createSlot('attributes', { direction: 'column' });
  attributes.placements = attributesFields.map((field, index) => createPlacement(field.id, index));

  const footer = createSlot('footer', { visible: footerFields.length > 0 });
  footer.placements = footerFields.map((field, index) => createPlacement(field.id, index));

  return {
    templateId: 'standard',
    cardAspect: 'auto',
    slots: { title, subtitle, attributes, footer },
  };
}

/** 默认抽屉外观（R2：默认宽 860 / 适应宽度 / zoom 预设） */
export function defaultDrawerConfig(): DrawerConfig {
  return {
    defaultWidthPx: 860,
    maximizable: true,
    defaultZoom: 1,
    zoomPresets: [0.5, 0.75, 1, 1.25, 1.5],
    defaultFitToWidth: true,
  };
}

/** 默认页眉页脚配置 */
export function defaultHeaderFooter(): HeaderFooterConfig {
  return {
    enabled: false,
    content: '',
    align: 'center',
    fontSize: 12,
    color: '#8F959E',
    showBorder: false,
  };
}

/** 默认页面设置（A4 纵向，页边距 72px ≈ 19mm） */
export function defaultPageSetup(): PageSetup {
  return {
    paper: 'A4',
    orientation: 'portrait',
    margin: {
      top: DEFAULT_PAGE_MARGIN_PX,
      right: DEFAULT_PAGE_MARGIN_PX,
      bottom: DEFAULT_PAGE_MARGIN_PX,
      left: DEFAULT_PAGE_MARGIN_PX,
    },
    header: defaultHeaderFooter(),
    footer: defaultHeaderFooter(),
    showPageNumber: true,
    pageNumberFormat: 'n/total',
    headerFooterScope: 'all',
  };
}

/** 默认文档主题（04 §3.3 字阶推导一致） */
export function defaultDocTheme(): DocTheme {
  return {
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    baseFontSize: 14,
    lineHeight: 1.6,
    headingScale: [1.6, 1.35, 1.15],
    headingWeight: 600,
    blockSpacing: 12,
    paragraphIndent: 0,
    primaryColor: '#3370FF',
    textColor: '#1F2329',
    mutedColor: '#8F959E',
    dividerColor: '#E5E6EB',
  };
}

function baseBlock<T extends DocBlock['kind']>(
  kind: T,
  blockIdPrefix: string,
  breakInside: BreakInside = 'avoid',
): { blockId: string; kind: T; breakInside: BreakInside } {
  return { blockId: createId(blockIdPrefix), kind, breakInside };
}

/**
 * 默认 A4 文档模板（§5.2）：
 * [heading L1] → [divider] → [keyValueGrid 2列 前 6 个 P0 字段] → [spacer 12] →
 * [heading L2「详细信息」] → [fieldList 其余字段] → [spacer] → [metaFooter]
 */
export function defaultDocTemplate(fields: readonly FieldMetaLite[] = []): DocTemplate {
  const list = [...fields];
  const titleField = firstTextField(list);
  const gridFields = p0Fields(list).slice(0, DEFAULT_GRID_FIELD_COUNT);
  const gridIds = new Set(gridFields.map((field) => field.id));
  const restFields = list.filter((field) => !gridIds.has(field.id) && field.id !== titleField?.id);

  const headingL1: HeadingBlock = {
    ...baseBlock('heading', 'blk_heading'),
    level: 1,
    source: titleField
      ? { type: 'field', fieldId: titleField.id }
      : { type: 'static', text: '记录详情' },
    hideWhenEmpty: false,
    note: '文档主标题',
  };

  const divider: DividerBlock = {
    ...baseBlock('divider', 'blk_divider'),
    thickness: 1,
    borderStyle: 'solid',
  };

  const keyValueGrid: KeyValueGridBlock = {
    ...baseBlock('keyValueGrid', 'blk_kvg'),
    columns: DEFAULT_KEY_VALUE_COLUMNS,
    rows: gridFields.map((field) => ({ fieldId: field.id })),
    labelWidthPx: 88,
    showColon: true,
    zebra: false,
    hideEmptyRows: true,
  };

  const spacer1: SpacerBlock = {
    ...baseBlock('spacer', 'blk_spacer', 'auto'),
    height: 12,
  };

  const headingL2: HeadingBlock = {
    ...baseBlock('heading', 'blk_heading'),
    level: 2,
    source: { type: 'static', text: '详细信息' },
    hideWhenEmpty: false,
    note: '二级标题',
  };

  const fieldList: FieldListBlock = {
    ...baseBlock('fieldList', 'blk_fieldlist', 'auto'),
    items: restFields.map((field) => ({ fieldId: field.id })),
    showLabels: true,
    hideEmptyItems: true,
  };

  const spacer2: SpacerBlock = {
    ...baseBlock('spacer', 'blk_spacer', 'auto'),
    height: 12,
  };

  const metaFooter: MetaFooterBlock = {
    ...baseBlock('metaFooter', 'blk_meta'),
    fields: ['createdUser', 'createdTime', 'modifiedTime'],
    separator: ' · ',
    fontSize: 12,
    muted: true,
  };

  return {
    templateId: 'a4-default',
    pageSetup: defaultPageSetup(),
    theme: defaultDocTheme(),
    blocks: [headingL1, divider, keyValueGrid, spacer1, headingL2, fieldList, spacer2, metaFooter],
  };
}

/** 默认详情配置（D3 固定文档式） */
export function defaultDetailConfig(fields: readonly FieldMetaLite[] = []): DetailConfig {
  return {
    mode: 'document',
    fieldScope: 'all',
    drawer: defaultDrawerConfig(),
    doc: defaultDocTemplate(fields),
  };
}

/** 空筛选配置（= 不筛）实现位于 `filter/sanitize.ts`（§22.6）；此处透出供配置层使用 */
export { defaultFilterConfig };

/** 默认样式主题 */
export function defaultTheme(): StyleTheme {
  return {
    preset: 'feishu-default',
    primaryColor: '#3370FF',
    backgroundColor: undefined,
    borderColor: undefined,
    borderRadius: 8,
    shadowLevel: 1,
    fontScale: 1,
    titleWeight: 600,
  };
}

/** 默认密度（R3：标准档 = 卡片最小宽 280 / 间距 16 / 内边距 16 / 属性 3 行） */
export function defaultDensity(): DensityConfig {
  return {
    preset: 'standard',
    cardMinWidth: 280,
    columnsMode: 'auto',
    gap: 16,
    padding: 16,
    maxCardHeight: 220,
    attributesMaxRows: 3,
  };
}

/** 组装完整默认配置 */
export function createDefaultConfig(params: {
  viewId: string;
  tableId: string;
  updatedBy?: string;
  fields?: readonly FieldMetaLite[];
  now?: number;
  provisionedFromTemplate?: boolean;
}): CardViewConfig {
  const now = params.now ?? Date.now();
  const fields = params.fields ?? [];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      configId: params.viewId,
      tableId: params.tableId,
      createdAt: now,
      updatedAt: now,
      updatedBy: params.updatedBy ?? 'system',
      templateId: 'standard',
      provisionedFromTemplate: params.provisionedFromTemplate,
    },
    card: defaultCardLayout(fields),
    detail: defaultDetailConfig(fields),
    theme: defaultTheme(),
    density: defaultDensity(),
    highlightRules: [],
    filter: defaultFilterConfig(),
  };
}

/** 插件版本常量透出（配置 layer 使用） */
export const CONFIG_PLUGIN_VERSION = PLUGIN_VERSION;

/** 兼容：供外部按 §6.3 命名调用的别名 */
export const defaultDocTemplateForFields = defaultDocTemplate;
