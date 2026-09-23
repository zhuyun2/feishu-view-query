/**
 * 文档态字段值的**唯一出口**（设计文档 §21.3.4 / §21.5 / §11「字段值出口」）。
 *
 * ⭐ 铁律：组件树里**只有本文件**调用 `registry.renderDoc()`。
 *   `blocks/*` 的区块渲染器一律通过 `<DocFieldValue/>` 取字段值，**禁止**直接 import 某个
 *   Renderer —— 否则字段格式化会出现两套实现，P1 新增字段类型时必然漏改一处（§11 铁律）。
 *
 * 职责边界：
 *  1. 归一化值优先取调用方传入的 `value`（`resolve.ts` 已归一化，避免二次计算）；
 *     未传时才从 `record` 现场归一化（保证本组件单独使用也正确）。
 *  2. 上下文经 `doc/resolve.buildDocRenderContext()` 组装，**跨页片段
 *     （`fragmentIndex` / `fragmentsTotal`）必须透传** —— 渲染器据此在续页省略
 *     「字段名：」标签，防止同一字段跨页重复画标签（§21.3.3）。
 *  3. 单字段异常**不**上抛：`normalize` 异常 → `FALLBACK_VALUE`；`renderDoc` 内部亦已
 *     做 try/catch → FallbackRenderer。分页绝不被一个坏字段拖垮。
 *
 * 与 §21.3.4 签名的一处**刻意偏离**（已记录，便于后续对齐）：
 *  - `props.theme` 的类型是 `StyleTheme` 而非 `DocTheme`。原因：`DocRenderContext.theme`
 *    的类型就是 `StyleTheme`（`fields/fieldTypes.ts`），而 `DocTheme` 是文档排版主题
 *    （字阶/行高/配色）。二者由本文件的 `styleThemeOf()` **显式桥接**，绝不在组件里混用。
 */
import type { ReactElement } from 'react';
import type { DocTheme, FieldDisplayOptions, StyleTheme } from '@/config/types';
import type { SdkRecord } from '@/sdk/port';
import type { FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';
import { MULTI_SELECT_PREVIEW_LIMIT } from '@/constants';
import { normalize } from '@/fields/normalize';
import { FALLBACK_VALUE, renderDoc } from '@/fields/registry';
import { buildDocRenderContext } from '@/doc/resolve';
import { getRecordFields } from '@/data/RecordDataSource';
import { logError } from '@/utils/log';

/** `DocFieldValue` 入参 */
export interface DocFieldValueProps {
  /** 字段 id（`fieldsById` 的键） */
  fieldId: string;
  /** 当前记录；`value` 已给定时可为 null（此时不再读记录） */
  record: SdkRecord | null;
  /** 字段 id → 元数据 */
  fieldsById: Record<string, FieldMetaLite>;
  /** 卡片态主题（`DocRenderContext.theme` 的类型要求） */
  theme: StyleTheme;
  locale: string;
  /** 是否显示「字段名：」前缀（渲染器在续片会自动抑制，见 `docLabelPrefix`） */
  showLabel: boolean;
  /** 前缀文本（缺省用字段名） */
  labelText?: string;
  /** 该块被分页切分后的第几段（0 起）；缺省 0 */
  fragmentIndex?: number;
  /** 该块总段数；缺省 1（未切分） */
  fragmentsTotal?: number;
  /** 已归一化的值（`ResolvedBlock.values[fieldId]`）；缺省时从 record 现场归一化 */
  value?: NormalizedValue;
  /** 字段展示选项；缺省用 `DEFAULT_DOC_FIELD_DISPLAY` */
  display?: FieldDisplayOptions;
}

/**
 * 文档态默认展示选项。
 * 文档态与卡片态相反：**不截断**（长文本靠分页，不靠 CSS 省略号），
 * 空值保留「—」占位（`hideWhenEmpty: false`）。
 */
export const DEFAULT_DOC_FIELD_DISPLAY: FieldDisplayOptions = {
  maxLines: 1,
  truncate: 'none',
  maxItems: MULTI_SELECT_PREVIEW_LIMIT,
  hideWhenEmpty: false,
};

/**
 * 文档主题 → 卡片主题（`StyleTheme`）的**唯一桥接点**。
 *
 * `DocRenderContext.theme` 要求 `StyleTheme`，而区块层持有的是 `DocTheme`；
 * 这里做显式映射（不臆造阴影/圆角等文档态用不到的字段，取最保守值）。
 */
export function styleThemeOf(theme: DocTheme): StyleTheme {
  return {
    preset: 'doc',
    primaryColor: theme.primaryColor,
    borderColor: theme.dividerColor,
    borderRadius: 4,
    shadowLevel: 0,
    fontScale: 1,
    titleWeight: theme.headingWeight,
  };
}

/** 从记录现场取归一化值；异常 → `FALLBACK_VALUE`（绝不上抛） */
function normalizeFromRecord(
  record: SdkRecord | null,
  fieldId: string,
  meta: FieldMetaLite,
): NormalizedValue {
  try {
    return normalize(getRecordFields(record)[fieldId], meta);
  } catch (err) {
    logError('doc.DocFieldValue', err, { fieldId });
    return FALLBACK_VALUE;
  }
}

/**
 * ⭐ 文档态字段值出口组件。
 *
 * 字段元数据缺失（失效字段引用）时渲染一个 muted 占位符，**不**静默返回 null
 * —— 静默 null 会让「配过的字段凭空消失」这一故障无法被发现。
 */
export function DocFieldValue(props: DocFieldValueProps): ReactElement {
  const {
    fieldId,
    record,
    fieldsById,
    theme,
    locale,
    showLabel,
    labelText,
    fragmentIndex,
    fragmentsTotal,
    value,
    display,
  } = props;

  const meta = fieldsById[fieldId];
  if (!meta) {
    return (
      <span className="cbv-doc-field cbv-doc-field--missing" data-field-id={fieldId}>
        —
      </span>
    );
  }

  const nv = value ?? normalizeFromRecord(record, fieldId, meta);
  const ctx = buildDocRenderContext({
    fieldMeta: meta,
    display: display ?? DEFAULT_DOC_FIELD_DISPLAY,
    theme,
    locale,
    showLabel,
    labelText,
    fragmentIndex,
    fragmentsTotal,
  });

  return (
    <span className="cbv-doc-field" data-field-id={fieldId}>
      {renderDoc(nv, ctx)}
    </span>
  );
}

export default DocFieldValue;
