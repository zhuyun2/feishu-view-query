/**
 * 字段筛选数据模型（设计文档 §22.2.1，逐字落地）。
 *
 * ⭐ 算子标识**逐字复用** SDK `FilterOperator` 枚举值，使「语义对齐飞书原生筛选」可审计、可断言。
 *   【实测】`plugin/_sdktmp/x0411/package/dist/index.d.ts` L1487-1508：
 *   `Is="is" / IsNot="isNot" / Contains="contains" / DoesNotContain="doesNotContain" /
 *    IsEmpty="isEmpty" / IsNotEmpty="isNotEmpty" / IsGreater="isGreater" /
 *    IsGreaterEqual="isGreaterEqual" / IsLess="isLess" / IsLessEqual="isLessEqual"`。
 *   任何新增算子都必须能在该枚举中找到同名字面量（由 operatorMatrix 守卫）。
 *
 * ⭐ 与 SDK `IFilterInfo` 同构：**单层** conjunction + conditions[]。
 *   主理人裁定：**不做嵌套条件组**——嵌套会与原生能力脱节且 UI 复杂度爆炸。
 *
 * 本模块为**纯类型模块**（零运行时依赖、零副作用），可被任意层 `import type` 引用。
 * 刻意不 `import` SDK 类型：本仓在用的 SDK 包为 `@lark-opdev/block-bitable-api`，
 * 其类型面与 js-sdk 不完全一致；字面量联合 + 上述注释即「可审计」的等价形式。
 */

/** 筛选算子：与 SDK `FilterOperator` 枚举值逐字一致 */
export type FilterOperator =
  | 'is' // 等于
  | 'isNot' // 不等于（含空值记录，见下）
  | 'contains' // 包含（**区分大小写**，主理人裁定 §22.10-②）
  | 'doesNotContain' // 不包含（**含空值记录**，主理人裁定 §22.10-③）
  | 'isEmpty' // 为空
  | 'isNotEmpty' // 不为空
  | 'isGreater' // 大于 / 晚于
  | 'isGreaterEqual' // 大于或等于
  | 'isLess' // 小于 / 早于
  | 'isLessEqual'; // 小于或等于

/** 条件组合方式：与 SDK `FilterConjunction` 同构（单层，不做嵌套） */
export type FilterConjunction = 'and' | 'or';

/** 单条筛选条件 */
export interface FilterCondition {
  /** 稳定 id（UI key / 删除定位用）；由 `createId('flt')` 生成，净化时缺失则补 `flt_auto_{index}` */
  conditionId: string;
  /** 目标字段 id（取值来自 `fields/fieldTypes.ts` 的 `FieldMetaLite.id`，不另造字段名） */
  fieldId: string;
  operator: FilterOperator;
  /**
   * 依算子与字段类型而定（§22.3 算子矩阵）：
   * - `isEmpty` / `isNotEmpty`：**无值**（undefined）；
   * - 文本类：string；数字/进度/评分/货币：number；复选框：boolean；
   * - 日期：毫秒时间戳 number（或可解析的日期字符串）；
   * - 多选/成员/附件：string 或 string[]。
   *
   * ⭐ 日期 `is` 的粒度为**按天**（主理人裁定 §22.10-④）：同日不同时分视为相等。
   */
  value?: unknown;
}

/** 筛选配置（嵌入 `CardViewConfig.filter`） */
export interface FilterConfig {
  /** 预留开关；P0 恒 true。`conditions` 为空即等价「不筛」 */
  enabled: boolean;
  conjunction: FilterConjunction;
  /** 有序条件列表（顺序对 UI 有意义，净化必须保序） */
  conditions: FilterCondition[];
}
