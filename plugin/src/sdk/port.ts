/**
 * SDK **类型端口**（设计文档 §0.3.2-E）：全仓唯一的「SDK 类型」引用点。
 *
 * 目的：把「具体用哪个 SDK 包」这个决定**收敛到一个文件**。此前 `IRecord` / `ITable` /
 * `IView` / `IFieldMeta` 泄漏进 25 个文件（编译期擦除，但换包时 25 处都要改）；收敛之后
 * 换包只需改本文件的 1 行 `import type` + `base.ts` / `env.ts` 两处值导入。
 *
 * ⚠️ 约束（违反即失效）：
 *  1. 本文件**只允许**出现 `import type`（编译期擦除），**绝不引入运行时代码** ——
 *     否则会把 SDK 的 import 期副作用重新带回所有消费方，破坏 §0.3.5 的不白屏方案。
 *  2. 这里的别名一律用 `type A = B`（结构等价），**不得**改写成更宽/更窄的结构 ——
 *     那会静默改变 25 个消费方的类型检查语义。
 *  3. `src/utils/hostProbe.ts` 与本文件无关，它必须保持**零 SDK 依赖**（§0.3.5 方案 C）。
 */
import type { IFieldMeta, IRecord, ITable, IView } from '@lark-opdev/block-bitable-api';

/** 记录（领域层只经 `getRecordFields` / `getRecordId` 读取，不直接依赖字段值类型） */
export type SdkRecord = IRecord;

/** 表格句柄（只读用途，见 `base.ts` 的 D1 约束） */
export type SdkTable = ITable;

/** 字段元数据 */
export type SdkFieldMeta = IFieldMeta;

/** 视图句柄 */
export type SdkView = IView;
