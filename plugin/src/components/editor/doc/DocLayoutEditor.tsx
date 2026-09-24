/**
 * 文档排版编辑器 · 三栏装配（设计文档 §21.6 / §21.3.5 / M3-T09）。
 *
 * ```
 * ┌──────────────┬───────────────────────────────┬────────────────────┐
 * │ 区块库 220px │ A4 画布（弹性，横向滚动）      │ 属性面板 320px     │
 * │ BlockLibrary │ DocCanvas + 插入槽 + 选中态    │ DocPropertyPanel   │
 * └──────────────┴───────────────────────────────┴────────────────────┘
 * ```
 *
 * 职责：
 *  - 提供**文档模式专属**的 `<DndContext>`（`PointerSensor` + `closestCenter`，与卡片模式同款配置，
 *    两模式的 id 命名空间互不为前缀，见 `dragIds.ts`）；
 *  - 落点解析 → 调 `blockMath` 纯函数（`insertIndexFromSlot` / `moveIndexFromSlot` / `isNoopMove`）
 *    → 经 `onChange(updateDoc)` 写入草稿；每次变更前调 `onBeforeChange()`（= `DraftStore.snapshot`）
 *    以支持撤销；
 *  - 持有**区块选中态**（`DocCanvas` 点击 → 右栏区块属性表单）。
 *
 * ⭐ 硬性要求 2 —— **不得改变 A4 纸的有效内容宽度**：
 *   内容宽度决定文本换行位置，差 1px 就可能让段落多折一行从而跨页，用户会觉得「分页跟编辑时不一样」
 *   且**不会有任何报错**。加上右栏后中间可用宽度变小，本组件的做法是：
 *    - 中间列用 `minmax(0, 1fr)`（允许被压缩到 0，**不撑破 grid**），
 *    - 纸页**保持固定像素宽**（由 `DocCanvas` 依 `getPaperSizePx` 决定，本组件**绝不覆盖**），
 *    - 窄于纸宽时由 `.cbv-editor__doc-canvas` 的 `overflow: auto` **横向滚动**兜底。
 *   即：适配靠**横向滚动**，而非压缩/回流纸页 —— 从而与 `DocPaper`（详情态）的
 *    `getContentBox().width` 恒等。守卫：`DocLayoutEditor.test.tsx` 断言不变式。
 *
 * ⚠️ 本组件**不修改** `DocCanvas.tsx` / `components/doc/*`（他域）；`ConfigDrawer` 的接入属 M3-T10。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { DocBlock, DocTemplate } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { getCatalogEntry } from '@/doc/blockCatalog';
import { createBlockIdFactory, defaultBlockFor } from '@/doc/blockDefaults';
import type { BlockIdFactory } from '@/doc/blockDefaults';
import { useLinkTargetFields } from '@/hooks/useLinkTargetFields';
import { BlockLibrary } from './BlockLibrary';
import { DocCanvas, DOC_CANVAS_DEFAULT_LOCALE } from './DocCanvas';
import { DocPropertyPanel } from './DocPropertyPanel';
import {
  blockCountOf,
  findBlock,
  insertBlock,
  insertIndexFromSlot,
  isNoopMove,
  moveBlock,
  moveIndexFromSlot,
  removeBlock,
  updateBlock,
} from './blockMath';
import { parseDragId } from '../dragIds';

export interface DocLayoutEditorProps {
  /** 当前草稿文档模板（`draft.docDraft`） */
  template: DocTemplate;
  /** 当前视图字段元数据 */
  fields: FieldMetaLite[];
  /** 变更入口：内部调用 `DraftStore.updateDoc`（已是不可变更新） */
  onChange(updater: (template: DocTemplate) => DocTemplate): void;
  /** 变更**之前**的快照（撤销栈）；缺省不记录 */
  onBeforeChange?(): void;
  /** 语言环境；缺省 `zh-CN` */
  locale?: string;
  /** 可选：注入确定性 id 生成器（测试用）；缺省模块级递增工厂 */
  makeBlockId?: BlockIdFactory;
}

/** 该类区块的中文名（拖拽幽灵文案） */
function kindLabel(kind: DocBlock['kind']): string {
  return getCatalogEntry(kind)?.label ?? kind;
}

function DocLayoutEditorInner({
  template,
  fields,
  onChange,
  onBeforeChange,
  locale = DOC_CANVAS_DEFAULT_LOCALE,
  makeBlockId,
}: DocLayoutEditorProps): ReactElement {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [ghostLabel, setGhostLabel] = useState<string | null>(null);

  /**
   * ⭐ 需求 2 · 第二阶段：「关联记录显示列」的目标表字段候选（**按需**懒加载）。
   * 右栏区块属性表单底部的配置段会 `ensure(fieldId)` 触发解析；
   * 解析失败/无 tableId → 该段显示降级文案（不影响其它编辑）。
   */
  const { states: linkTargetFields, ensure: ensureLinkFields } = useLinkTargetFields(fields);

  // 新块 id：优先注入（测试确定性），否则模块级递增工厂（**不用**含随机/时间的 createId）
  const defaultFactory = useRef(createBlockIdFactory());
  const makeId = useMemo<BlockIdFactory>(
    () => makeBlockId ?? defaultFactory.current.next,
    [makeBlockId],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** 先快照、后变更（保证「撤销」能回到上一状态） */
  const mutate = useCallback(
    (updater: (current: DocTemplate) => DocTemplate): void => {
      if (onBeforeChange) onBeforeChange();
      onChange(updater);
    },
    [onBeforeChange, onChange],
  );

  /** 选中的区块若已被删除/不在模板中 → 视为未选中（避免右栏展示幽灵区块） */
  const effectiveSelectedId = selectedBlockId && findBlock(template, selectedBlockId) ? selectedBlockId : null;

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      const parsed = parseDragId(String(event.active.id));
      if (parsed.kind === 'blocklib') {
        setGhostLabel(kindLabel(parsed.value as DocBlock['kind']));
        return;
      }
      if (parsed.kind === 'docblock') {
        const found = findBlock(template, parsed.value);
        setGhostLabel(found ? kindLabel(found.block.kind) : '区块');
      }
    },
    [template],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setGhostLabel(null);
      const { active, over } = event;
      if (!over) return;

      const activeParsed = parseDragId(String(active.id));
      const overParsed = parseDragId(String(over.id));

      // 落点槽位：直接拖到插入槽，或拖到某个区块上（取该区块的索引作为槽）
      let slotIndex: number | null = null;
      if (overParsed.kind === 'docslot') {
        const parsed = Number(overParsed.value);
        slotIndex = Number.isFinite(parsed) ? parsed : null;
      } else if (overParsed.kind === 'docblock') {
        const found = findBlock(template, overParsed.value);
        slotIndex = found ? found.index : null;
      }
      if (slotIndex === null) return;

      if (activeParsed.kind === 'blocklib') {
        const kind = activeParsed.value as DocBlock['kind'];
        if (!getCatalogEntry(kind)) return;
        const block = defaultBlockFor(kind, fields, { makeId });
        const at = insertIndexFromSlot(slotIndex, blockCountOf(template));
        mutate((current) => insertBlock(current, block, at));
        setSelectedBlockId(block.blockId);
        return;
      }

      if (activeParsed.kind === 'docblock') {
        if (isNoopMove(template, activeParsed.value, slotIndex)) return;
        const toIndex = moveIndexFromSlot(template, activeParsed.value, slotIndex);
        if (toIndex < 0) return;
        mutate((current) => moveBlock(current, activeParsed.value, toIndex));
      }
    },
    [fields, makeId, mutate, template],
  );

  const handleBlockChange = useCallback(
    (blockId: string, patch: Record<string, unknown>): void => {
      mutate((current) => updateBlock(current, blockId, patch as unknown as Partial<DocBlock>));
    },
    [mutate],
  );

  const handleBlockDelete = useCallback(
    (blockId: string): void => {
      mutate((current) => removeBlock(current, blockId));
      setSelectedBlockId((current) => (current === blockId ? null : current));
    },
    [mutate],
  );

  const handlePageSetupChange = useCallback(
    (next: DocTemplate['pageSetup']): void => {
      mutate((current) => ({ ...current, pageSetup: next }));
    },
    [mutate],
  );

  const handleThemeChange = useCallback(
    (next: DocTemplate['theme']): void => {
      mutate((current) => ({ ...current, theme: next }));
    },
    [mutate],
  );

  const blockCount = blockCountOf(template);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="cbv-editor__body cbv-editor__body--doc" data-doc-editor="true">
        <BlockLibrary />
        <main className="cbv-editor__center cbv-editor__doc-center" data-doc-editor-center="true">
          <DocCanvas
            template={template}
            fields={fields}
            selectedBlockId={effectiveSelectedId}
            onSelectBlock={setSelectedBlockId}
            locale={locale}
          />
          <footer className="cbv-editor__doc-status" data-doc-block-count={blockCount} data-doc-slot-count={blockCount + 1}>
            <span className="cbv-editor__doc-status-hint">从左侧拖入区块 · 拖动区块可排序 · 点击区块编辑属性</span>
            <span className="cbv-editor__doc-status-count">已用 {blockCount} 块 / 插入槽 {blockCount + 1}</span>
          </footer>
        </main>
        <DocPropertyPanel
          template={template}
          fields={fields}
          selectedBlockId={effectiveSelectedId}
          onBlockChange={handleBlockChange}
          onBlockDelete={handleBlockDelete}
          onPageSetupChange={handlePageSetupChange}
          onThemeChange={handleThemeChange}
          linkTargetFields={linkTargetFields}
          onEnsureLinkFields={ensureLinkFields}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {ghostLabel ? (
          <div className="cbv-drag-ghost" data-kind="blocklib">
            {ghostLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export const DocLayoutEditor = DocLayoutEditorInner;

export default DocLayoutEditor;
