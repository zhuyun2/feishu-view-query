/**
 * 文档排版编辑器的**纯排布逻辑**（设计文档 §21.3.5 / §21.6 / M3-T08）。
 *
 * 定位：与卡片排版的 `components/editor/placementMath.ts` 同构，专管 `DocTemplate.blocks` 有序区块流。
 * dnd-kit 只负责手势与视觉反馈，**增删改排的索引计算全部下沉到这里**，以便在 Node 下裸跑、
 * 100% 单测（无 React / 无 DOM / 无 SDK / 无 config 运行时依赖）。
 *
 * 约定（与 `placementMath.ts` 一致，团队纪律）：
 *  - **不修改入参**：一律返回新对象（`DraftStore.updateDoc` 据此做 dirty 判定与快照回滚）；
 *  - **索引口径**：`toIndex` / `index` 一律表示「**插入到该位置之前**」的 0 基索引，合法区间 `[0, n]`；
 *    负值 → 钳到 0，越界 → 钳到末尾 `n`（等价「追加」）；
 *  - **落点语义**：插入槽 `docslot:{i}` 表示「放在第 i 个区块**之前**」，故 `i === n` = 追加末尾。
 */
import type { DocBlock, DocTemplate } from '@/config/types';

/** 区块数量（容错：`blocks` 非数组时按 0） */
export function blockCountOf(template: DocTemplate): number {
  return Array.isArray(template.blocks) ? template.blocks.length : 0;
}

/** 区块 id 序列（保序；供断言与「按 id 定位」） */
export function blockIds(template: DocTemplate): string[] {
  return (Array.isArray(template.blocks) ? template.blocks : []).map((block) => block.blockId);
}

/**
 * 插入槽序号序列：`N` 个区块 → **`N+1`** 个槽（`0..N`）。
 * 纯函数：画布与测试据此产出/校验槽位，避免「槽位少一个」导致末尾无法插入。
 */
export function slotIndexes(blockCount: number): number[] {
  const count = Math.max(0, Math.trunc(Number.isFinite(blockCount) ? blockCount : 0));
  const indexes: number[] = [];
  for (let i = 0; i <= count; i += 1) indexes.push(i);
  return indexes;
}

/**
 * 按 `blockId` 定位区块。
 * @returns `{ block, index }`；未找到 → `null`（调用方自行兜底，绝不抛错）。
 */
export function findBlock(template: DocTemplate, blockId: string): { block: DocBlock; index: number } | null {
  const blocks = Array.isArray(template.blocks) ? template.blocks : [];
  const index = blocks.findIndex((block) => block.blockId === blockId);
  if (index < 0) return null;
  return { block: blocks[index], index };
}

/** 是否含某区块 */
export function hasBlock(template: DocTemplate, blockId: string): boolean {
  return findBlock(template, blockId) !== null;
}

/**
 * 把「插入索引」钳制到 `[0, length]`。
 *  - 非有限值（`NaN` / `Infinity`）→ `length`（视为追加末尾）；
 *  - 小数 → 向下取整；`<0` → `0`；`>length` → `length`。
 */
export function clampInsertIndex(index: number, length: number): number {
  const limit = Math.max(0, Math.trunc(Number.isFinite(length) ? length : 0));
  if (!Number.isFinite(index)) return limit;
  const value = Math.trunc(index);
  if (value < 0) return 0;
  if (value > limit) return limit;
  return value;
}

/** 写入新 `blocks`（不改动 `template` 其余字段的引用） */
function withBlocks(template: DocTemplate, blocks: DocBlock[]): DocTemplate {
  return { ...template, blocks };
}

/**
 * 插入新块到 `index`（插入前索引，`[0, n]`）。
 * `index < 0` → 头部；`index > n` / 非有限 → 末尾（追加）。
 */
export function insertBlock(template: DocTemplate, block: DocBlock, index: number): DocTemplate {
  const blocks = [...(Array.isArray(template.blocks) ? template.blocks : [])];
  const at = clampInsertIndex(index, blocks.length);
  blocks.splice(at, 0, block);
  return withBlocks(template, blocks);
}

/** 追加新块到末尾（= `insertBlock(template, block, n)`） */
export function appendBlock(template: DocTemplate, block: DocBlock): DocTemplate {
  return insertBlock(template, block, blockCountOf(template));
}

/**
 * 删除区块。
 * @returns 删掉后的新模板；`blockId` 不存在时**原样返回**（同一引用，便于调用方判定「无变化」）。
 */
export function removeBlock(template: DocTemplate, blockId: string): DocTemplate {
  const found = findBlock(template, blockId);
  if (!found) return template;
  const blocks = (Array.isArray(template.blocks) ? template.blocks : []).filter(
    (_block, index) => index !== found.index,
  );
  return withBlocks(template, blocks);
}

/**
 * 移动区块到 `toIndex`。
 *
 * ⭐ 索引口径：`toIndex` 是「**移除该块之后**」列表中的插入位置（`[0, n-1]`）。
 * 这样调用方（拖放落点解析）只需先算好目标索引，无需关心「同向后移动一位」的偏移 —— 该偏移
 * 由 `moveIndexFromSlot()` 负责。
 *
 * @returns 移动后的新模板；`blockId` 不存在时原样返回。
 */
export function moveBlock(template: DocTemplate, blockId: string, toIndex: number): DocTemplate {
  const found = findBlock(template, blockId);
  if (!found) return template;

  const rest = (Array.isArray(template.blocks) ? template.blocks : []).filter(
    (_block, index) => index !== found.index,
  );
  const at = clampInsertIndex(toIndex, rest.length);
  rest.splice(at, 0, found.block);
  return withBlocks(template, rest);
}

/**
 * 更新区块（浅合并 `patch`）。
 *
 * `patch` 允许改 `kind` 等字段；类型层面用泛型约束到具体区块（如 `updateBlock<HeadingBlock>`），
 * 运行时只做对象浅合并。
 *
 * @returns 更新后的新模板；`blockId` 不存在时原样返回。
 */
export function updateBlock<T extends DocBlock>(
  template: DocTemplate,
  blockId: string,
  patch: Partial<T>,
): DocTemplate {
  const found = findBlock(template, blockId);
  if (!found) return template;
  const blocks = (Array.isArray(template.blocks) ? template.blocks : []).map((block, index) =>
    index === found.index ? ({ ...block, ...patch } as DocBlock) : block,
  );
  return withBlocks(template, blocks);
}

/**
 * 落点解析 ①：**新块**从区块库拖到插入槽 `slotIndex` → 新块插入索引。
 * 槽位序号本身就是插入索引（`0..n`），此处仅做钳制（防脏数据 / 越界）。
 */
export function insertIndexFromSlot(slotIndex: number, blockCount: number): number {
  return clampInsertIndex(slotIndex, blockCount);
}

/**
 * 落点解析 ②：把**已存在**的块拖到插入槽 `slotIndex` → 传给 `moveBlock()` 的目标索引。
 *
 * 关键：区块被移走后剩余列表短一位，故当落点在该块**之后**时，目标索引需 `-1`。
 * 例：`[b0,b1,b2]`，把 `b1` 拖到末尾槽 `slot=3` → 剩余 `[b0,b2]`，应插到索引 2（= 3-1）。
 *
 * @returns `[0, n-1]` 的目标索引；`blockId` 不存在或模板为空 → `-1`（调用方按「插入新块」处理或忽略）。
 */
export function moveIndexFromSlot(template: DocTemplate, blockId: string, slotIndex: number): number {
  const found = findBlock(template, blockId);
  const count = blockCountOf(template);
  if (!found || count === 0) return -1;

  const raw = clampInsertIndex(slotIndex, count);
  const adjusted = raw > found.index ? raw - 1 : raw;
  return clampInsertIndex(adjusted, count - 1);
}

/**
 * 判定「移动是否为空操作」：落点在原位的**前一位或原位**即视为不动。
 * 例：`[b0,b1,b2]`，`b1` 拖到槽 1（原位）或槽 2（原位之后）→ 均为空操作。
 */
export function isNoopMove(template: DocTemplate, blockId: string, slotIndex: number): boolean {
  const found = findBlock(template, blockId);
  if (!found) return false;
  const raw = clampInsertIndex(slotIndex, blockCountOf(template));
  return raw === found.index || raw === found.index + 1;
}
