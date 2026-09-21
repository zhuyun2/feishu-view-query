/**
 * 字段渲染器注册表（设计文档 §6.5 / §11）。
 *
 * 双态入口：`renderCard(nv, ctx)` / `renderDoc(nv, ctx)`。
 * 铁律：
 *  ① 永不输出原始 ID / JSON（由 `normalize()` 保证，本层只消费 NormalizedValue）；
 *  ② 单字段渲染异常必须被 try/catch 捕获 → 回落 FallbackRenderer，不影响整卡；
 *  ③ 未注册类型一律走 FallbackRenderer。
 */
import type { ReactNode } from 'react';
import { FieldType } from './fieldTypes';
import type {
  DocRenderContext,
  FieldRenderer,
  FieldTypeValue,
  NormalizedValue,
  RenderContext,
} from './fieldTypes';
import { AttachmentRenderer } from './renderers/AttachmentRenderer';
import { CheckboxRenderer } from './renderers/CheckboxRenderer';
import { DateRenderer } from './renderers/DateRenderer';
import { FallbackRenderer } from './renderers/FallbackRenderer';
import { FormulaRenderer } from './renderers/FormulaRenderer';
import { LinkRenderer } from './renderers/LinkRenderer';
import { LookupRenderer } from './renderers/LookupRenderer';
import { NumberRenderer } from './renderers/NumberRenderer';
import { ProgressRenderer } from './renderers/ProgressRenderer';
import { RatingRenderer } from './renderers/RatingRenderer';
import { TagRenderer } from './renderers/TagRenderer';
import { TextRenderer } from './renderers/TextRenderer';
import { UserRenderer } from './renderers/UserRenderer';
import { logError } from '@/utils/log';

const registry = new Map<number, FieldRenderer>();

/** 渲染异常 / 归一化异常时的统一兜底值（不含任何原始数据） */
export const FALLBACK_VALUE: NormalizedValue = {
  kind: 'unsupported',
  text: '该字段类型暂不支持',
  display: '该字段类型暂不支持',
  isEmpty: false,
};

/** 注册（同类型后注册覆盖先前，便于 P1 扩展时替换实现） */
export function registerRenderer(type: FieldTypeValue, renderer: FieldRenderer): void {
  registry.set(type as number, renderer);
}

/** 取渲染器；未注册返回 FallbackRenderer */
export function getRenderer(type: FieldTypeValue): FieldRenderer {
  return registry.get(type as number) ?? FallbackRenderer;
}

/** P0 渲染器登记（T06） */
function registerP0Renderers(): void {
  registerRenderer(FieldType.Text, TextRenderer);
  registerRenderer(FieldType.Number, NumberRenderer);
  registerRenderer(FieldType.Currency, NumberRenderer);
  registerRenderer(FieldType.SingleSelect, TagRenderer);
  registerRenderer(FieldType.MultiSelect, TagRenderer);
  registerRenderer(FieldType.DateTime, DateRenderer);
  registerRenderer(FieldType.CreatedTime, DateRenderer);
  registerRenderer(FieldType.ModifiedTime, DateRenderer);
  registerRenderer(FieldType.Checkbox, CheckboxRenderer);
}
registerP0Renderers();

/** P1 渲染器登记（T07）：人员 / 附件 / 评分 / 进度 / 链接 / 公式 / 查找引用 */
function registerP1Renderers(): void {
  registerRenderer(FieldType.User, UserRenderer);
  registerRenderer(FieldType.CreatedUser, UserRenderer);
  registerRenderer(FieldType.ModifiedUser, UserRenderer);
  registerRenderer(FieldType.Attachment, AttachmentRenderer);
  registerRenderer(FieldType.Rating, RatingRenderer);
  registerRenderer(FieldType.Progress, ProgressRenderer);
  registerRenderer(FieldType.Phone, LinkRenderer);
  registerRenderer(FieldType.Url, LinkRenderer);
  registerRenderer(FieldType.Formula, FormulaRenderer);
  registerRenderer(FieldType.Lookup, LookupRenderer);
  registerRenderer(FieldType.Link, LookupRenderer);
  registerRenderer(FieldType.DuplexLink, LookupRenderer);
  // AutoNumber 为数字语义，复用数字渲染器（千分位/tabular-nums）
  registerRenderer(FieldType.AutoNumber, NumberRenderer);
}
registerP1Renderers();

/** 卡片态渲染入口（带字段级异常隔离）：单字段异常 → FallbackRenderer，绝不上抛。 */
export function renderCard(nv: NormalizedValue, ctx: RenderContext): ReactNode {
  try {
    return getRenderer(ctx.fieldMeta.type).renderCard(nv, ctx);
  } catch (err) {
    logError('fields.renderCard', err, { fieldId: ctx.fieldMeta.id });
    return FallbackRenderer.renderCard(FALLBACK_VALUE, ctx);
  }
}

/**
 * 归一化阶段的兜底渲染入口（F3）。
 * 组件路径在 `normalize()` 抛错时调用本函数，保证「单字段异常不影响整卡」在组件路径同样成立。
 */
export function renderFallbackCard(ctx: RenderContext): ReactNode {
  return FallbackRenderer.renderCard(FALLBACK_VALUE, ctx);
}

/** 文档态渲染入口（带字段级异常隔离）：异常不中断分页。 */
export function renderDoc(nv: NormalizedValue, ctx: DocRenderContext): ReactNode {
  try {
    return getRenderer(ctx.fieldMeta.type).renderDoc(nv, ctx);
  } catch (err) {
    logError('fields.renderDoc', err, { fieldId: ctx.fieldMeta.id });
    return FallbackRenderer.renderDoc(FALLBACK_VALUE, ctx);
  }
}

/** 供编辑器汇总「本视图有 N 个不支持字段」用 */
export function listUnsupportedFieldIds(
  fields: readonly { id: string; type: FieldTypeValue }[],
): string[] {
  return fields.filter((field) => getRenderer(field.type) === FallbackRenderer).map((field) => field.id);
}

export { FallbackRenderer };
