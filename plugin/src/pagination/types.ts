/**
 * 分页领域层类型定义（设计文档 §21.3.1）。
 *
 * 本文件为**纯类型 + 常量**：对 `config/types` 只做 `import type`（编译期擦除），
 * 不含任何 DOM / React / SDK 运行时引用，可在 Node 环境直接加载。
 */
import type { BreakInside, DocBlockKind } from '@/config/types';

/** 单个区块的测量结果（尺寸表的一行） */
export interface BlockMetrics {
  blockId: string;
  kind: DocBlockKind;
  /** 整块「外高」px（含区块自身 margin；区块间距由渲染层 CSS 决定并被一并计入） */
  outerHeight: number;
  /**
   * 可切分块（paragraph/fieldList/table）的**原子单元**高度序列：
   * paragraph → 每行高；fieldList → 每项高；table → 每数据行高。
   * 不可切分块为 undefined。
   */
  units?: number[];
  /** 表格续页需重复的表头高度（0/undefined = 不重复） */
  repeatHeaderHeight?: number;
}

/** ⭐ 可注入测量器：生产走离屏 DOM，测试注入确定性 stub（本任务仅定义接口，实现在 M3-T02） */
export interface Measurer {
  /** 从「已渲染好的离屏宿主」同步读取尺寸；host 内各区块根节点须带 data-block-id */
  measureBlocks(
    host: HTMLElement,
    blocks: ReadonlyArray<{ blockId: string; kind: DocBlockKind }>,
  ): BlockMetrics[];
}

/** 纯函数装箱输入中的区块描述（无 DOM / 无 React / 无 SDK / 无 config 运行时依赖） */
export interface PackBlock {
  blockId: string;
  kind: DocBlockKind;
  breakInside: BreakInside;
  /** 标题等需与「下一块首单元」同页（§17.2「标题孤行」） */
  keepWithNext?: boolean;
}

export interface PackOptions {
  /** 页底至少保留的原子单元数（孤行控制），<1 视为 1 */
  minUnitsAtBottom: number;
  /** 换页后页顶至少保留的原子单元数（寡行控制），<1 视为 1 */
  minUnitsAtTop: number;
  /** 是否启用孤行/寡行控制；本期默认 false（仅保证每页 ≥1 单元） */
  enableWidowOrphan: boolean;
}

/** 分页默认选项（§21.9：集中定义，禁止散落 magic number） */
export const DEFAULT_PACK_OPTIONS: PackOptions = {
  minUnitsAtBottom: 1,
  minUnitsAtTop: 1,
  enableWidowOrphan: false,
};

export interface PackInput {
  blocks: ReadonlyArray<PackBlock>;
  /** 与 blocks 同序等长 */
  metrics: ReadonlyArray<BlockMetrics>;
  /** = ContentBox.height（纸张高 − 上下页边距） */
  contentHeight: number;
  options?: Partial<PackOptions>;
}

export interface PagedItem {
  blockId: string;
  /** 该块第几段（0 起） */
  fragmentIndex: number;
  /** 该块总段数 */
  fragmentsTotal: number;
  /** 本片段高度 */
  height: number;
  /** 原子切片区间 [from, to)（行号 / 项号 / 数据行号） */
  slice?: { from: number; to: number };
}

export interface PagedPage {
  pageIndex: number;
  items: PagedItem[];
  /** 本页已用高度（边界提示 / 断言用） */
  usedHeight: number;
}

export interface PackResult {
  pages: PagedPage[];
  totalPages: number;
  /** 单块 > 一整页且不可切分 → 已独占一页并裁剪；此处登记以触发降级提示（§21.4 规则 4） */
  overflowBlockIds: string[];
}

/** 分页产物（§21.3.2）：渲染层与预览容器消费；由控制器组装，类型归属本层 */
export interface PagedDocument {
  pages: PagedPage[];
  totalPages: number;
  fontReady: boolean;
  /** 分页失败 → 单页长文档降级（§12） */
  degraded: boolean;
}
