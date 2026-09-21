/**
 * 条件高亮类型出口（设计文档 §4.4 / §6.9）。
 *
 * 高亮的**权威定义**位于 `@/config/types`（配置模型的一部分，随配置持久化）。
 * 本模块只是 `highlight/` 子域的类型门面，避免规则引擎直接依赖配置层内部路径，
 * 并为域内提供记录侧的最小抽象类型。
 */
export type {
  HighlightRule,
  HighlightStyle,
  HighlightTarget,
  RuleCondition,
  RuleExpr,
  RuleOperator,
} from '@/config/types';

/**
 * 记录侧最小抽象（供规则引擎/调试消费）。
 * 刻意与 `@lark-base-open/js-sdk` 的 `IRecord` 解耦，避免本域反向依赖接入层。
 */
export interface RecordMetaLike {
  /** 记录 id（仅内部定位用，**绝不渲染**） */
  recordId: string;
}
