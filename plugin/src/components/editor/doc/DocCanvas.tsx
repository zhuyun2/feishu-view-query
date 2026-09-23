/**
 * 文档画布（中栏，设计文档 §21.6 / M3-T08）。
 *
 * 职责：把当前草稿模板（`DocTemplate.blocks`）渲染成**可编辑的 A4 文档流**：
 *  - 每个区块一个**区块外壳**（`data-block-id` / `data-block-kind` / `data-selected`），
 *    点击可选中，`useDraggable`（id = `docblock:{blockId}`）可排序 / 移动；
 *  - 区块之间（含首尾）共 **N+1** 个**插入槽**（`useDroppable`，id = `docslot:{index}`，
 *    带 `data-docslot-index`）—— 拖入即在此处插入；
 *  - 用 `buildSampleRecord(fields)` 合成样例记录驱动真实区块渲染（所见即所得）。
 *
 * ⭐ 与 `DocPreview` 的关系（**架构说明，见交付报告「偏差」**）：
 *   `DocPreview` 渲染的是**已分页**、按 `top` **绝对定位**且带**纸页虚拟化**的纸页；
 *   编辑器需要的是「区块流 + 区块之间的投放槽 + 逐块选中」，这三者无法叠加在绝对定位 + 虚拟化的
 *   纸页上（且 `components/doc/*` 已冻结，不能给 `BlockRenderer` 加选中/投放钩子）。
 *   因此本组件**复用文档渲染管线的最底层原语** —— 同一个 `BlockRenderer`、同一套
 *   `getContentBox()/getPaperSizePx()` 纸页几何与 `PageSetup`/`DocTheme` —— 以获得等价的所见即所得，
 *   同时保留可编辑性。分页纸页（`DocPreview`）仍用于**详情抽屉的阅读态**（T06/T07）。
 *
 * ⭐ 锚点契约（供 `DocCanvas.test.tsx` 断言）：
 *   每个模板区块**有且仅有**一个「区块流锚点」，即 `.cbv-editor__doc-flow` 的**直接子元素**
 *   中带 `data-block-id` 的节点（其内层 `BlockRenderer` 根也带 `data-block-id`，那是测量契约所需，
 *   故断言时必须按**直接子元素**取，避免把内层根重复计入）。
 *   ⚠️ 即使某区块因 `hideWhenEmpty` / 失效字段被 `resolve` 剔除、或 `pageBreak` 不渲染 DOM，
 *   其**外壳仍存在**（因此锚点序列恒等于模板顺序）——这是「区块凭空消失且不报错」的防线。
 */
import type { CSSProperties, ReactElement } from 'react';
import { Fragment, useCallback, useMemo } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { DocBlock, DocTheme, DocTemplate, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type { ResolvedBlock } from '@/doc/resolve';
import { getCatalogEntry } from '@/doc/blockCatalog';
import { getContentBox, getPaperSizePx } from '@/constants/paper';
import { defaultDocTheme, defaultPageSetup } from '@/config/defaults';
import { resolveBlocks } from '@/doc/resolve';
import { BlockRenderer } from '@/components/doc/blocks/BlockRenderer';
import { buildSampleRecord } from '../sampleRecord';
import { docBlockDragId, docSlotDropId } from '../dragIds';

/** 默认语言环境（参与 `resolve` 的 payloadHash） */
export const DOC_CANVAS_DEFAULT_LOCALE = 'zh-CN';

export interface DocCanvasProps {
  /** 当前草稿文档模板（`draft.docDraft`） */
  template: DocTemplate;
  /** 当前视图字段元数据（用于合成样例记录与字段选择） */
  fields: FieldMetaLite[];
  /** 当前选中区块 id；`null` / 缺省 = 未选中 */
  selectedBlockId?: string | null;
  /** 点击区块外壳回传 `blockId`（缺省 = 区块不可选中） */
  onSelectBlock?: (blockId: string) => void;
  /** 语言环境；缺省 `zh-CN` */
  locale?: string;
}

/** 区块类型中文名（外壳 `aria-label` 用） */
function blockKindLabel(kind: DocBlock['kind']): string {
  return getCatalogEntry(kind)?.label ?? kind;
}

/** 纸页样式：宽高 = 纸张 px，padding = 页边距（用长手属性，与 `DocPaper` 同口径） */
function paperStyleOf(setup: PageSetup): CSSProperties {
  const paper = getPaperSizePx(setup.paper, setup.orientation);
  return {
    position: 'relative',
    boxSizing: 'border-box',
    width: paper.w,
    minHeight: paper.h,
    paddingTop: setup.margin.top,
    paddingRight: setup.margin.right,
    paddingBottom: setup.margin.bottom,
    paddingLeft: setup.margin.left,
    margin: '0 auto',
    background: '#fff',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
  };
}

/** 插入槽：区块之间 / 首尾的投放目标（`docslot:{index}`） */
function DocDropSlot({ index }: { index: number }): ReactElement {
  const { setNodeRef, isOver } = useDroppable({
    id: docSlotDropId(index),
    data: { kind: 'docslot', slotIndex: index },
  });

  return (
    <div
      ref={setNodeRef}
      className={`cbv-editor__doc-slot${isOver ? ' cbv-editor__doc-slot--over' : ''}`}
      data-docslot="true"
      data-docslot-index={index}
      role="presentation"
    >
      <span className="cbv-editor__doc-slot-line" aria-hidden="true" />
    </div>
  );
}

/** 区块内容：优先真实渲染（所见即所得），并按 kind / 解析结果分流 */
function DocBlockBody({
  block,
  resolved,
  theme,
  locale,
  record,
  fieldsById,
  contentWidth,
}: {
  block: DocBlock;
  resolved: ResolvedBlock | null;
  theme: DocTheme;
  locale: string;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  contentWidth: number;
}): ReactElement {
  // `pageBreak` 在文档流里**不渲染 DOM**（§21.4 规则 9），但编辑器中必须**可见**，
  // 否则用户会以为这一块凭空消失（且无法选中/删除）。
  if (block.kind === 'pageBreak') {
    return (
      <div className="cbv-editor__doc-pagebreak" data-editor-page-break="true">
        强制分页
      </div>
    );
  }

  if (!resolved) {
    // 被 resolve 剔除（hideWhenEmpty / 失效字段引用 / 表格无有效列）→ 显式告知，绝不静默留白。
    return (
      <div className="cbv-editor__doc-block-empty" data-editor-block-empty="true">
        该区块在当前示例数据下不渲染
      </div>
    );
  }

  return (
    <BlockRenderer
      resolved={resolved}
      fragmentIndex={0}
      fragmentsTotal={1}
      theme={theme}
      locale={locale}
      record={record}
      fieldsById={fieldsById}
      contentWidth={contentWidth}
    />
  );
}

/** 区块外壳：拖拽排序 + 点击选中 + 选中态视觉标识 */
function DocBlockShell({
  block,
  index,
  resolved,
  selected,
  onSelectBlock,
  theme,
  locale,
  record,
  fieldsById,
  contentWidth,
}: {
  block: DocBlock;
  index: number;
  resolved: ResolvedBlock | null;
  selected: boolean;
  onSelectBlock?: (blockId: string) => void;
  theme: DocTheme;
  locale: string;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  contentWidth: number;
}): ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: docBlockDragId(block.blockId),
    data: { kind: 'docblock', blockId: block.blockId, index },
  });

  const selectable = typeof onSelectBlock === 'function';
  const handleClick = useCallback((): void => {
    onSelectBlock?.(block.blockId);
  }, [onSelectBlock, block.blockId]);

  const className =
    `cbv-editor__doc-block cbv-editor__doc-block--${block.kind}` +
    `${selected ? ' cbv-editor__doc-block--selected' : ''}` +
    `${isDragging ? ' cbv-editor__doc-block--dragging' : ''}`;

  return (
    <div
      ref={setNodeRef}
      // dnd-kit 的 `attributes`（role/tabIndex/aria-*）与 `listeners`（pointer 事件）先铺开，
      // 下方显式属性覆盖其中与选中态相关的键（如 `aria-pressed`），避免重复指定。
      {...attributes}
      {...listeners}
      className={className}
      data-block-id={block.blockId}
      data-block-kind={block.kind}
      data-block-index={index}
      data-selected={selected ? 'true' : 'false'}
      data-doc-flow-block="true"
      aria-label={`区块 ${index + 1}：${blockKindLabel(block.kind)}`}
      aria-pressed={selected}
      onClick={selectable ? handleClick : undefined}
    >
      <div className="cbv-editor__doc-block-body">
        <DocBlockBody
          block={block}
          resolved={resolved}
          theme={theme}
          locale={locale}
          record={record}
          fieldsById={fieldsById}
          contentWidth={contentWidth}
        />
      </div>
    </div>
  );
}

function DocCanvasInner({
  template,
  fields,
  selectedBlockId = null,
  onSelectBlock,
  locale = DOC_CANVAS_DEFAULT_LOCALE,
}: DocCanvasProps): ReactElement {
  // 区块序列：`useMemo` 固定引用，避免下游 `useMemo(resolvedById)` 的依赖每次渲染都变
  const blocks = useMemo(
    () => (Array.isArray(template.blocks) ? template.blocks : []),
    [template],
  );
  const pageSetup = template.pageSetup ?? defaultPageSetup();
  const theme = template.theme ?? defaultDocTheme();
  // ⚠️ 本处几何须与 DocPaper 保持一致（同一 `getContentBox` / `getPaperSizePx` 来源，不各自硬编码）；
  //    改动请同步另一侧 —— 否则「编辑器排好的换行位置」与「详情里看到的」会分叉，且不会有任何报错。
  //    守卫：`docPathConsistency.test.tsx` 断言两侧内容宽度恒等 `getContentBox().width`。
  const contentBox = getContentBox(pageSetup.paper, pageSetup.orientation, pageSetup.margin);

  // 样例记录：让配置态**始终有内容可看**（真实记录由用户数据提供）
  const record = useMemo<SdkRecord>(() => buildSampleRecord(fields), [fields]);

  const fieldsById = useMemo(() => {
    const map: Record<string, FieldMetaLite> = {};
    for (const field of fields) map[field.id] = field;
    return map;
  }, [fields]);

  // 求值：字段值 / hideWhenEmpty / visibleWhen / 失效引用过滤（纯函数）
  const resolvedById = useMemo(() => {
    const resolved = resolveBlocks({ blocks, record, fields, locale });
    const map = new Map<string, ResolvedBlock>();
    for (const item of resolved) map.set(item.blockId, item);
    return map;
  }, [blocks, record, fields, locale]);

  return (
    <div
      className="cbv-editor__doc-canvas"
      data-testid="doc-canvas"
      data-block-count={blocks.length}
      data-slot-count={blocks.length + 1}
    >
      <div
        className="cbv-editor__doc-paper"
        data-paper={pageSetup.paper}
        data-orientation={pageSetup.orientation}
        data-content-width={contentBox.width}
        style={paperStyleOf(pageSetup)}
      >
        <div className="cbv-editor__doc-flow" data-doc-flow="true">
          {blocks.map((block, index) => (
            <Fragment key={block.blockId === '' ? `idx-${index}` : block.blockId}>
              <DocDropSlot index={index} />
              <DocBlockShell
                block={block}
                index={index}
                resolved={resolvedById.get(block.blockId) ?? null}
                selected={selectedBlockId === block.blockId}
                onSelectBlock={onSelectBlock}
                theme={theme}
                locale={locale}
                record={record}
                fieldsById={fieldsById}
                contentWidth={contentBox.width}
              />
            </Fragment>
          ))}
          {/* 末尾槽：N 个区块 → N+1 个槽（缺它则无法「追加到末尾」） */}
          <DocDropSlot index={blocks.length} />
        </div>
      </div>
    </div>
  );
}

export const DocCanvas = DocCanvasInner;

export default DocCanvas;
