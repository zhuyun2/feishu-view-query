/**
 * 卡片排版预设（R3 密度三档 / 模板画廊 / R4 封面图口径）——设计文档 §4.2 · §4.4。
 *
 * 本模块是「纯数据 + 纯函数」：不依赖 React，便于单测与编辑器/渲染层共用。
 * 数值唯一来源：`04-UI设计说明.md` §3.4、§5.3、§11 R3。
 */
import type { CardLayoutConfig, DensityConfig, FieldPlacement, SlotConfig, SlotId } from './types';

export type DensityPresetName = 'compact' | 'standard' | 'comfortable';
export type CardTemplateName = CardLayoutConfig['templateId'];

/** R3 三档密度映射（04 §11 R3） */
export const DENSITY_PRESETS: Readonly<Record<DensityPresetName, Required<Pick<DensityConfig, 'preset' | 'cardMinWidth' | 'gap' | 'padding' | 'maxCardHeight' | 'attributesMaxRows'>>>> =
  {
    compact: { preset: 'compact', cardMinWidth: 240, gap: 12, padding: 10, maxCardHeight: 160, attributesMaxRows: 2 },
    standard: {
      preset: 'standard',
      cardMinWidth: 280,
      gap: 16,
      padding: 16,
      maxCardHeight: 220,
      attributesMaxRows: 3,
    },
    comfortable: {
      preset: 'comfortable',
      cardMinWidth: 320,
      gap: 20,
      padding: 20,
      maxCardHeight: 320,
      attributesMaxRows: 5,
    },
  };

export const DENSITY_PRESET_ORDER: readonly DensityPresetName[] = ['compact', 'standard', 'comfortable'];

export const DENSITY_PRESET_LABEL: Readonly<Record<DensityPresetName, string>> = {
  compact: '紧凑',
  standard: '标准',
  comfortable: '宽松',
};

/** 按密度档取一份全新的 DensityConfig（不共享引用，避免调用方互相污染） */
export function densityPreset(name: DensityPresetName, base?: DensityConfig): DensityConfig {
  const preset = DENSITY_PRESETS[name] ?? DENSITY_PRESETS.standard;
  return {
    ...base,
    ...preset,
    columnsMode: base?.columnsMode ?? 'auto',
    fixedColumns: base?.fixedColumns,
  };
}

/** 解析当前密度命中的档位（容错：未标注时按尺寸就近推断） */
export function resolveDensityPreset(density: DensityConfig | null | undefined): DensityPresetName {
  if (density?.preset && density.preset in DENSITY_PRESETS) return density.preset;
  if (!density) return 'standard';
  let nearest: DensityPresetName = 'standard';
  let minDistance = Number.POSITIVE_INFINITY;
  for (const name of DENSITY_PRESET_ORDER) {
    const distance = Math.abs(DENSITY_PRESETS[name].cardMinWidth - density.cardMinWidth);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = name;
    }
  }
  return nearest;
}

/** 属性区默认行数（R3）：未标注时按标准档 3 行 */
export function attributesMaxRows(density: DensityConfig | null | undefined): number {
  const explicit = density?.attributesMaxRows;
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return DENSITY_PRESETS[resolveDensityPreset(density)].attributesMaxRows;
}

/* ===================== 卡片模板画廊 ===================== */

export interface CardTemplateMeta {
  id: CardTemplateName;
  label: string;
  /** 一行为主的简述（编辑器模板画廊 tooltip） */
  description: string;
}

/**
 * 模板画廊（S3 右栏）：紧凑 / 标准 / 大图 / 清单（+ custom）。
 *
 * ⚠️ R4 取舍：`cover`「大图」模板**不显示封面图**（卡片无封面槽位）。
 * 实现为「属性区优先承载附件字段（首图 64×64 + 张数）」+ 属性区行数放宽，
 * 即「大图靠属性区的首图体现」，与 R4 冻结口径一致。
 */
export const CARD_TEMPLATES: readonly CardTemplateMeta[] = [
  { id: 'compact', label: '紧凑', description: '标题 + 少量属性，一屏看更多' },
  { id: 'standard', label: '标准', description: '标题 / 副标题 / 属性 / 底部四槽位' },
  { id: 'cover', label: '大图', description: '属性区优先大尺寸首图（R4：不显示封面图）' },
  { id: 'list', label: '清单', description: '单列清单式，标题与属性纵向排列' },
];

/** 各模板的槽位形状（visible / direction / 每卡上限 / 属性区额外行数系数） */
interface TemplateShape {
  titleVisible: boolean;
  subtitleVisible: boolean;
  footerVisible: boolean;
  subtitleDirection: 'row' | 'column';
  attributesDirection: 'row' | 'column';
  maxItemsPerCard: number;
  /** 大图模板把属性区行数放大（用密度行数 × 系数向上取整） */
  attributesRowBoost: number;
}

const TEMPLATE_SHAPES: Readonly<Record<CardTemplateName, TemplateShape>> = {
  standard: {
    titleVisible: true,
    subtitleVisible: true,
    footerVisible: true,
    subtitleDirection: 'row',
    attributesDirection: 'column',
    maxItemsPerCard: 8,
    attributesRowBoost: 1,
  },
  compact: {
    titleVisible: true,
    subtitleVisible: false,
    footerVisible: false,
    subtitleDirection: 'row',
    attributesDirection: 'column',
    maxItemsPerCard: 3,
    attributesRowBoost: 1,
  },
  cover: {
    titleVisible: true,
    subtitleVisible: true,
    footerVisible: true,
    subtitleDirection: 'row',
    attributesDirection: 'column',
    maxItemsPerCard: 10,
    attributesRowBoost: 2,
  },
  list: {
    titleVisible: true,
    subtitleVisible: true,
    footerVisible: true,
    subtitleDirection: 'column',
    attributesDirection: 'column',
    maxItemsPerCard: 10,
    attributesRowBoost: 1,
  },
  custom: {
    titleVisible: true,
    subtitleVisible: true,
    footerVisible: true,
    subtitleDirection: 'row',
    attributesDirection: 'column',
    maxItemsPerCard: 8,
    attributesRowBoost: 1,
  },
};

/** 全部已放置字段（按槽位顺序展平，保持 order 稳定） */
function flattenPlacements(layout: CardLayoutConfig): FieldPlacement[] {
  const order: SlotId[] = ['title', 'subtitle', 'attributes', 'footer'];
  const all: FieldPlacement[] = [];
  for (const slotId of order) {
    const slot = layout.slots[slotId];
    if (!slot) continue;
    all.push(...[...slot.placements].sort((a, b) => a.order - b.order));
  }
  return all;
}

function buildSlot(
  id: SlotId,
  visible: boolean,
  direction: 'row' | 'column',
  maxItemsPerCard: number,
  placements: FieldPlacement[],
): SlotConfig {
  return {
    id,
    visible,
    collapsibleWhenEmpty: true,
    direction,
    separator: ' · ',
    maxItemsPerCard,
    placements: placements.map((placement, index) => ({ ...placement, order: index })),
  };
}

/**
 * 套用模板：**保留已用字段（尽力映射）**，未映射字段留在属性区（不丢字段）。
 *
 * 分配策略：第 1 个字段 → 标题；其后 1~2 个 → 副标题；其余 → 属性区；日期类字段不强制入底部。
 * 与 04 §5.3.3「换模板：槽位配置整体替换，保留已用字段」一致。
 */
export function applyCardTemplate(
  templateId: CardTemplateName,
  layout: CardLayoutConfig,
): CardLayoutConfig {
  const shape = TEMPLATE_SHAPES[templateId] ?? TEMPLATE_SHAPES.standard;
  const all = flattenPlacements(layout);

  let titlePlacements: FieldPlacement[] = [];
  let subtitlePlacements: FieldPlacement[] = [];
  let attributePlacements: FieldPlacement[] = [];

  if (all.length > 0) {
    titlePlacements = [all[0]];
    const rest = all.slice(1);
    subtitlePlacements = shape.subtitleVisible ? rest.slice(0, 2) : [];
    attributePlacements = shape.subtitleVisible ? rest.slice(2) : rest;
  }

  const slots: Record<SlotId, SlotConfig> = {
    title: buildSlot('title', shape.titleVisible, 'row', 1, titlePlacements),
    subtitle: buildSlot('subtitle', shape.subtitleVisible, shape.subtitleDirection, 3, subtitlePlacements),
    attributes: buildSlot('attributes', true, shape.attributesDirection, shape.maxItemsPerCard, attributePlacements),
    footer: buildSlot('footer', shape.footerVisible, 'row', 3, []),
  };

  return {
    ...layout,
    templateId,
    slots,
    showCoverImage: false,
  };
}
