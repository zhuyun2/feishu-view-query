/**
 * D4：复制视图场景识别与「从模板重配」（设计文档 §6.3 / §5.8）。
 *
 * 背景：配置文件 key 带 viewId。用户「复制视图」会得到**新的 viewId**，因此必然读不到配置。
 * 策略：无配置时按默认模板生成一份，并打 `provisionedFromTemplate` 标记 → 首开时提示用户。
 */
import { createDefaultConfig } from './defaults';
import type { LoadResult } from './ConfigRepository';
import type { CardViewConfig } from './types';
import type { FieldMetaLite } from '@/fields/fieldTypes';

export interface ProvisionContext {
  viewId: string;
  tableId: string;
  /** 当前视图名（用于判定是否像「副本」） */
  viewName?: string;
  fields: readonly FieldMetaLite[];
  updatedBy?: string;
}

/** 视图名是否「像副本」（飞书复制视图通常会带「副本 / copy / (2)」等后缀） */
export function looksLikeCopyView(viewName: string | undefined): boolean {
  if (!viewName) return false;
  const normalized = viewName.trim();
  if (normalized === '') return false;
  return /副本|拷贝|copy/i.test(normalized) || /[(（]\s*\d+\s*[)）]\s*$/.test(normalized);
}

/** 是否需要「从模板重配」（无已保存配置即需要） */
export function shouldProvision(load: LoadResult, ctx: ProvisionContext): boolean {
  if (load.config) return false;
  if (load.unsupportedNewer) return false;
  // 无配置：视图存在、字段可读 → 生成模板
  return ctx.fields.length > 0 || !!ctx.tableId;
}

/** 生成模板配置（复制视图场景会打 provisionedFromTemplate 标记） */
export function provisionFromTemplate(ctx: ProvisionContext): CardViewConfig {
  const provisioned = looksLikeCopyView(ctx.viewName);
  return createDefaultConfig({
    viewId: ctx.viewId,
    tableId: ctx.tableId,
    updatedBy: ctx.updatedBy,
    fields: ctx.fields,
    provisionedFromTemplate: provisioned || undefined,
  });
}

export interface ResolvedConfig {
  config: CardViewConfig;
  /** 是否由模板新生成（需在 UI 出首开提示） */
  provisioned: boolean;
  /** 是否复制视图场景（提示文案不同） */
  copyScenario: boolean;
  /** 加载态是否降级（透传，供 Banner） */
  degraded: boolean;
  /** 是否为**数据损坏**（透传，供 Banner 区分「损坏」与「介质降级」） */
  corrupted: boolean;
  /** 是否只读（更高版本配置） */
  unsupportedNewer: boolean;
}

/**
 * 加载结果 → 最终生效配置。
 * - 已有配置：直接使用（保留 provisionedFromTemplate 供一次性提示后由 UI 清除）；
 * - 无配置：按 D4 生成模板配置。
 */
export function resolveConfigOnLoad(load: LoadResult, ctx: ProvisionContext): ResolvedConfig {
  if (load.config) {
    return {
      config: load.config,
      provisioned: false,
      copyScenario: false,
      degraded: load.degraded,
      corrupted: load.corrupted === true,
      unsupportedNewer: load.unsupportedNewer,
    };
  }
  const config = provisionFromTemplate(ctx);
  return {
    config,
    provisioned: true,
    copyScenario: looksLikeCopyView(ctx.viewName),
    degraded: load.degraded,
    corrupted: load.corrupted === true,
    unsupportedNewer: load.unsupportedNewer,
  };
}
