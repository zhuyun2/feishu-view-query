/**
 * 派生选择器（设计文档 §9）：把「已保存配置 / 草稿 / UI 状态」收敛为渲染层可直接消费的纯值。
 *
 * 全部为**纯函数**（不依赖 React），便于：
 *  ① 虚拟网格与卡片组件共用同一套列数/行数推导；
 *  ② 单测直接断言（无需渲染）。
 */
import type { IRecord } from '@lark-base-open/js-sdk';
import type { CardLayoutConfig, DensityConfig, StyleTheme } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { getRecordFields } from '@/data/RecordDataSource';
import type { DraftState } from './DraftStore';
import type { ViewState } from './ViewStore';
import { attributesMaxRows, densityPreset, resolveDensityPreset, type DensityPresetName } from '@/config/presets';

/** 编辑态优先取草稿（实时预览），否则取已保存配置 */
export function selectEffectiveCardLayout(view: ViewState, draft: DraftState): CardLayoutConfig | null {
  if (draft.active && draft.cardDraft) return draft.cardDraft;
  return view.config?.card ?? null;
}

/** 编辑态优先取草稿密度 */
export function selectEffectiveDensity(view: ViewState, draft: DraftState): DensityConfig | null {
  if (draft.active && draft.densityDraft) return draft.densityDraft;
  return view.config?.density ?? null;
}

/** 编辑态优先取草稿主题 */
export function selectEffectiveTheme(view: ViewState, draft: DraftState): StyleTheme | null {
  if (draft.active && draft.themeDraft) return draft.themeDraft;
  return view.config?.theme ?? null;
}

/** 当前密度档位名 */
export function selectDensityPreset(density: DensityConfig | null | undefined): DensityPresetName {
  return resolveDensityPreset(density);
}

/** 属性区默认行数（R3） */
export function selectAttributesMaxRows(density: DensityConfig | null | undefined): number {
  return attributesMaxRows(density);
}

/** 应用某档密度（返回新的 DensityConfig，保留 columnsMode 等） */
export function selectDensityWithPreset(
  density: DensityConfig | null | undefined,
  preset: DensityPresetName,
): DensityConfig {
  return densityPreset(preset, density ?? undefined);
}

export interface GridMetrics {
  /** 一屏列数（≥ 1） */
  columns: number;
  /** 单卡目标宽度（px，含取整） */
  columnWidth: number;
  gap: number;
  padding: number;
}

/**
 * 卡片网格几何（04 §3.4 推导）：
 *   columns = floor((viewportW − 2×padding + gap) / (cardMinWidth + gap))
 * 列宽取「视口宽均分」以保证右侧不留缝。
 */
export function selectGridMetrics(viewportWidth: number, density: DensityConfig | null | undefined): GridMetrics {
  const safeDensity: DensityConfig = density ?? {
    cardMinWidth: 280,
    columnsMode: 'auto',
    gap: 16,
    padding: 16,
    maxCardHeight: 220,
  };
  const padding = Math.max(0, safeDensity.padding);
  const gap = Math.max(0, safeDensity.gap);
  const minWidth = Math.max(1, safeDensity.cardMinWidth);
  const usable = Math.max(0, viewportWidth - padding * 2);

  let columns: number;
  if (safeDensity.columnsMode === 'fixed' && safeDensity.fixedColumns && safeDensity.fixedColumns > 0) {
    columns = Math.min(Math.floor(safeDensity.fixedColumns), 12);
  } else {
    columns = Math.floor((usable + gap) / (minWidth + gap));
    columns = Math.min(Math.max(columns, 1), 12);
  }
  const columnWidth = columns > 0 ? Math.floor((usable - gap * (columns - 1)) / columns) : minWidth;
  return { columns, columnWidth: Math.max(minWidth, columnWidth), gap, padding };
}

/** 行数（ceil） */
export function selectRowCount(itemCount: number, columns: number): number {
  if (columns <= 0) return 0;
  return Math.ceil(itemCount / columns);
}

/** 记录总数文案（04 §5.1.2：「共 1,248 条」/ 筛选时「共 N 条（已筛选 M 条）」） */
export function selectCountLabel(total: number, loaded: number, filtered: boolean): string {
  const group = (value: number): string => value.toLocaleString('en-US');
  if (total > 0) {
    return filtered ? `共 ${group(total)} 条（已筛选 ${group(loaded)} 条）` : `共 ${group(total)} 条`;
  }
  return loaded > 0 ? `已加载 ${group(loaded)} 条` : '共 0 条';
}

/**
 * 统计卡片配置中「已被删除」的字段引用数（03 §12 / 04 §6 状态 7）。
 * 同时扫描四个槽位与文档模板区块，避免漏报。
 */
export function selectMissingFieldCount(
  config: { card: CardLayoutConfig; detail: { doc: { blocks: unknown[] } } } | null | undefined,
  fieldsById: Record<string, unknown>,
): number {
  if (!config) return 0;
  const missing = new Set<string>();
  const consider = (fieldId: string | undefined): void => {
    if (typeof fieldId === 'string' && fieldId !== '' && !fieldsById[fieldId]) missing.add(fieldId);
  };

  const slots = config.card.slots;
  for (const slotId of ['title', 'subtitle', 'attributes', 'footer'] as const) {
    const slot = slots[slotId];
    if (!slot) continue;
    for (const placement of slot.placements) consider(placement.fieldId);
  }

  for (const block of config.detail.doc.blocks) {
    const raw = block as Record<string, unknown>;
    consider(typeof raw.fieldId === 'string' ? raw.fieldId : undefined);
    if (raw.source && typeof raw.source === 'object') {
      consider((raw.source as Record<string, unknown>).fieldId as string | undefined);
    }
    for (const key of ['rows', 'items', 'columns'] as const) {
      const list = raw[key];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && typeof entry === 'object') {
            consider((entry as Record<string, unknown>).fieldId as string | undefined);
          }
        }
      }
    }
    if (Array.isArray(raw.fieldIds)) {
      for (const fieldId of raw.fieldIds) consider(typeof fieldId === 'string' ? fieldId : undefined);
    }
  }
  return missing.size;
}

/** 卡片排版中所有被引用字段 id（去重，保持出现顺序） */
export function selectPlacedFieldIds(layout: CardLayoutConfig | null | undefined): string[] {
  if (!layout) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const slotId of ['title', 'subtitle', 'attributes', 'footer'] as const) {
    const slot = layout.slots[slotId];
    if (!slot) continue;
    for (const placement of [...slot.placements].sort((a, b) => a.order - b.order)) {
      if (!seen.has(placement.fieldId)) {
        seen.add(placement.fieldId);
        ids.push(placement.fieldId);
      }
    }
  }
  return ids;
}

/**
 * 工具栏搜索（04 §5 S1）：对**已加载记录**做客户端过滤。
 * 仅匹配「卡片排版中已引用字段」的人可见文本（经 `normalize`），**绝不匹配原始 ID / JSON**。
 * 关键词为空 → 原样返回（引用不变，便于 memo）。
 */
export function filterRecordsByQuery(
  records: readonly IRecord[],
  layout: CardLayoutConfig | null | undefined,
  fieldsById: Record<string, FieldMetaLite>,
  query: string,
): IRecord[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === '') return records as IRecord[];
  const fieldIds = selectPlacedFieldIds(layout);
  return records.filter((record) => {
    for (const fieldId of fieldIds) {
      const meta = fieldsById[fieldId];
      if (!meta) continue;
      try {
        const nv = normalize(getRecordFields(record)[fieldId], meta);
        if (!nv.isEmpty && nv.text.toLowerCase().includes(keyword)) return true;
      } catch {
        /* 单字段异常不影响整体过滤 */
      }
    }
    return false;
  });
}
