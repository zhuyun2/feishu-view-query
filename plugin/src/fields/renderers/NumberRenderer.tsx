/**
 * 数字 / 货币渲染器（P0）。
 * 卡片态：千分位；货币使用**字段自身的 symbol**（缺省 ¥）。文档态：完整数值，货币右对齐。
 * 全部数字使用等宽数字（tabular-nums，04 §3.3）。
 */
import { docLabelPrefix } from '../fieldTypes';
import type { DocRenderContext, FieldRenderer, NormalizedValue } from '../fieldTypes';
import { formatCurrency, formatNumber } from '@/utils/format';
import type { NumberFormatOptions } from '@/config/types';

/** 货币缺省符号（仅在字段元数据未提供 symbol 时兜底） */
const DEFAULT_CURRENCY_SYMBOL = '¥';

function resolveText(nv: NormalizedValue, numberFormat: NumberFormatOptions | undefined, currencyDecimals: boolean): string {
  const value = typeof nv.number === 'number' ? nv.number : Number(nv.text);
  if (!Number.isFinite(value)) return nv.display;
  if (nv.kind === 'currency') {
    // F1：符号取自归一化结果（字段 property.symbol），不再硬编码 ¥
    const symbol = nv.symbol ?? DEFAULT_CURRENCY_SYMBOL;
    return formatCurrency(value, symbol, currencyDecimals ? { useGrouping: true, decimals: 2 } : numberFormat);
  }
  return formatNumber(value, numberFormat);
}

export const NumberRenderer: FieldRenderer = {
  key: 'number',
  priority: 'P0',

  renderCard(nv, ctx) {
    if (nv.isEmpty) {
      return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    }
    const text = resolveText(nv, ctx.display.numberFormat, false);
    return (
      <span className="cbv-field-num cbv-num" title={text}>
        {ctx.display.prefix ?? ''}
        {text}
        {ctx.display.suffix ?? ''}
      </span>
    );
  },

  renderDoc(nv, ctx: DocRenderContext) {
    if (nv.isEmpty) return ctx.display.hideWhenEmpty ? null : <span className="cbv-field-empty">—</span>;
    const label = docLabelPrefix(ctx);
    const text = resolveText(nv, ctx.display.numberFormat, true);
    const className = nv.kind === 'currency' ? 'cbv-doc-num cbv-num cbv-doc-num--right' : 'cbv-doc-num cbv-num';
    return (
      <span className={className}>
        {label ? <span className="cbv-doc-label">{label}</span> : null}
        {ctx.display.prefix ?? ''}
        {text}
        {ctx.display.suffix ?? ''}
      </span>
    );
  },
};
