/**
 * 区块分发器（设计文档 §21.3.4 / §21.5）。
 *
 * ⭐ 本文件是「测量契约」的**唯一落地处**（与 `pagination/measurer.ts` 一一对应）：
 *   ① 区块根节点带 **`data-block-id`**（测量器按它建索引，避免拼选择器）；
 *   ② 区块根节点带 `data-block-kind` / `data-fragment-index` / `data-fragments-total`（调试与样式钩子）；
 *   ③ 可切分区块的**原子单元**带 **`data-unit-index`**，且必须是**顶层**的
 *      （父链上不能再有 `data-unit-index`，否则测量器会重复计数）；
 *   ④ 表头带 **`data-repeat-header`**（表格续页重复表头；表格属 T05，见 `PENDING_BLOCK_KINDS`）。
 *
 * ⭐ 外间距为什么用「内层 margin + 根 `display:flow-root`」而不是「根 margin」：
 *   `measurer.readHeight()` 读的是 `offsetHeight`，**不含 margin**。若把区块间距放在
 *   根节点自身 margin 上，测量高度会比实际占位少 N px，分页会静默错位（页看起来有内容，
 *   只是越往后越挤）。这里让根成为 BFC（`display:flow-root`）并把 margin 放在内层，
 *   根的 `offsetHeight` 就把 margin **完整包含**进来，测量与实际占位严格一致。
 *
 * 组件层级：`BlockRenderer` 只画一层「区块根 + 内容内层」，具体形态交给各分组渲染器：
 * `TextBlocks`（heading/paragraph/richText）、`FieldBlocks`（keyValueGrid/fieldList/badgeRow）、
 * `MediaBlocks`（image/table，T05）、`StructureBlocks`（divider/spacer/pageBreak/metaFooter，T05）。
 * 未知 kind → **显式占位**（可见 + 带 `data-block-pending`），绝不静默 `return null`
 * —— 静默 null 会让「某类区块凭空消失」这一故障无法被发现。
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { memo } from 'react';
import type { DocBlock, DocBlockKind, DocTheme, StyleTheme } from '@/config/types';
import type { SdkRecord } from '@/sdk/port';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { ResolvedBlock, ResolvedPayload } from '@/doc/resolve';
import { getCatalogEntry } from '@/doc/blockCatalog';
import { logWarn } from '@/utils/log';
import { styleThemeOf } from '../DocFieldValue';
import { FieldListView, KeyValueGridView, BadgeRowView } from './FieldBlocks';
import { HeadingBlockView, ParagraphBlockView, RichTextView } from './TextBlocks';
import { ImageView, TableView } from './MediaBlocks';
import { DividerView, MetaFooterView, PageBreakView, SpacerView } from './StructureBlocks';

/** `BlockRenderer` 入参（§21.3.4） */
export interface BlockRendererProps {
  resolved: ResolvedBlock;
  fragmentIndex: number;
  fragmentsTotal: number;
  /** 原子切片区间（段落 / 清单 / 表格跨页时由分页结果透传） */
  slice?: { from: number; to: number };
  theme: DocTheme;
  locale: string;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  /** 内容盒宽度 px（网格标签列宽换算基准 = ContentBox.width） */
  contentWidth: number;
  /** 由 `DocPaper` 计算的绝对定位样式 */
  style?: CSSProperties;
}

/** 具体区块渲染器的公共入参（由 `BlockRenderer` 组装后下发） */
export interface DocBlockRenderProps {
  /** = `ResolvedBlock.blockId`；渲染器内部**不再**重复输出 `data-block-id`（根已输出） */
  blockId: string;
  fragmentIndex: number;
  fragmentsTotal: number;
  /** 原子切片区间（paragraph / fieldList 用） */
  slice?: { from: number; to: number };
  /** 由 `BlockRenderer` 算好的区块外间距（margin），**必须**落在内容内层元素上 */
  innerStyle: CSSProperties;
  /**
   * 用户在区块样式里**显式**配置的文本色（`DocBlock.style.color`）；未配置时为 `undefined`。
   * 供 `divider`（架构裁定 Q4：分隔线颜色沿用基类 `style.color`）等结构类区块取线色；
   * 未配置时应回落到主题色，**不可**用 `theme.textColor` 冒充「用户配过」。
   */
  blockColor?: string;
  theme: DocTheme;
  /** `DocTheme` → `StyleTheme` 的桥接结果，供 `DocFieldValue` 使用 */
  styleTheme: StyleTheme;
  locale: string;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  /** 内容盒宽度 px */
  contentWidth: number;
}

/**
 * ⚠️ **这不是「待实现清单」**——T05 已全部交付，这里**不得**再往里加 kind。
 * 它的唯一用途是给 `blocks.test.tsx` 提供「分派收敛」回归断言的对照表：
 * 逐类断言这 5 类都命中了**各自的真实渲染器**（签名结构俱全）且**不再**落进
 * `PendingBlockView`。谁删掉 switch 里的某个 case，该 kind 会静默掉进 default 的占位，
 * 对照表会立刻红。`pageBreak` 按 §21.4 规则 9 永不渲染，故不在表内。
 */
export const PENDING_BLOCK_KINDS: readonly DocBlockKind[] = [
  'image',
  'table',
  'divider',
  'spacer',
  'metaFooter',
];

/** 把 `DocBlockStyle` 的可继承样式 + 定位样式合成根节点样式 */
function rootStyleOf(block: DocBlock, theme: DocTheme, positioning?: CSSProperties): CSSProperties {
  const s = block.style;
  const style: CSSProperties = {
    display: 'flow-root',
    boxSizing: 'border-box',
    fontFamily: theme.fontFamily,
    fontSize: s?.fontSize ?? theme.baseFontSize,
    lineHeight: theme.lineHeight,
    color: s?.color ?? theme.textColor,
  };
  if (s?.fontWeight !== undefined) style.fontWeight = s.fontWeight;
  if (s?.align !== undefined) style.textAlign = s.align;
  if (s?.backgroundColor !== undefined) style.backgroundColor = s.backgroundColor;
  if (s?.paddingX !== undefined || s?.paddingY !== undefined) {
    style.padding = `${s?.paddingY ?? 0}px ${s?.paddingX ?? 0}px`;
  }
  if (s?.borderWidth !== undefined && s.borderWidth > 0) {
    style.borderWidth = `${s.borderWidth}px`;
    style.borderStyle = 'solid';
    style.borderColor = s.borderColor ?? theme.dividerColor;
  }
  if (s?.borderRadius !== undefined) style.borderRadius = `${s.borderRadius}px`;
  return { ...style, ...positioning };
}

/**
 * 区块外间距：显式配置优先，否则用主题 `blockSpacing`。
 * ⚠️ 落在**内层**元素上（根是 BFC，故根 `offsetHeight` 含之）。
 */
function innerStyleOf(block: DocBlock, theme: DocTheme): CSSProperties {
  return {
    marginTop: block.style?.marginTop ?? 0,
    marginBottom: block.style?.marginBottom ?? theme.blockSpacing,
  };
}

/** 区块根节点：测量契约的 `data-block-id` 就在这里输出 */
function BlockRoot(props: {
  blockId: string;
  kind: DocBlockKind | 'unknown';
  fragmentIndex: number;
  fragmentsTotal: number;
  style: CSSProperties;
  children: ReactNode;
}): ReactElement {
  const { blockId, kind, fragmentIndex, fragmentsTotal, style, children } = props;
  return (
    <div
      className={`cbv-doc-block cbv-doc-block--${kind}`}
      data-block-id={blockId}
      data-block-kind={kind}
      data-fragment-index={fragmentIndex}
      data-fragments-total={fragmentsTotal}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * **未知 kind** 的显式占位（配置损坏 / 未来版本新增类型）：可见 + 带 `data-block-pending`。
 * 走到这里说明该 kind **没有对应的渲染器**，必须让用户与测试一眼看见，而不是静默丢块。
 */
function PendingBlockView(props: {
  blockId: string;
  kind: DocBlockKind | 'unknown';
  fragmentIndex: number;
  fragmentsTotal: number;
  style?: CSSProperties;
  innerStyle: CSSProperties;
}): ReactElement {
  const { blockId, kind, fragmentIndex, fragmentsTotal, style, innerStyle } = props;
  const label = kind === 'unknown' ? '未知区块' : getCatalogEntry(kind)?.label ?? kind;
  return (
    <BlockRoot
      blockId={blockId}
      kind={kind}
      fragmentIndex={fragmentIndex}
      fragmentsTotal={fragmentsTotal}
      style={{ ...style, display: 'flow-root', boxSizing: 'border-box' }}
    >
      <div className="cbv-doc-block__inner" style={innerStyle}>
        <span
          className="cbv-doc-pending"
          data-block-pending="true"
          style={{
            display: 'block',
            padding: '4px 8px',
            border: '1px dashed #C9CDD4',
            borderRadius: 4,
            color: '#8F959E',
            fontSize: 12,
          }}
        >
          {`【占位】不支持的区块类型：${label}`}
        </span>
      </div>
    </BlockRoot>
  );
}

/** 按 kind 取窄化后的 payload；类型不匹配（数据损坏）时返回 null 并告警 */
function payloadAs<K extends ResolvedPayload['kind']>(
  resolved: ResolvedBlock,
  kind: K,
): Extract<ResolvedPayload, { kind: K }> | null {
  if (resolved.payload.kind !== kind) {
    logWarn('doc.BlockRenderer', 'payload.kind 与 block.kind 不一致', {
      blockId: resolved.blockId,
      blockKind: resolved.kind,
      payloadKind: resolved.payload.kind,
    });
    return null;
  }
  return resolved.payload as Extract<ResolvedPayload, { kind: K }>;
}

function BlockRendererImpl(props: BlockRendererProps): ReactElement | null {
  const { resolved, fragmentIndex, fragmentsTotal, slice, theme, locale, record, fieldsById, contentWidth, style } =
    props;

  const styleTheme = styleThemeOf(theme);
  const common: DocBlockRenderProps = {
    blockId: resolved.blockId,
    fragmentIndex,
    fragmentsTotal,
    slice,
    innerStyle: innerStyleOf(resolved.block, theme),
    blockColor: resolved.block.style?.color,
    theme,
    styleTheme,
    locale,
    record,
    fieldsById,
    contentWidth,
  };
  const rootStyle = rootStyleOf(resolved.block, theme, style);
  const pendingStyle = { ...style };

  switch (resolved.kind) {
    case 'heading': {
      const payload = payloadAs(resolved, 'heading');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="heading"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <HeadingBlockView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'paragraph': {
      const payload = payloadAs(resolved, 'paragraph');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="paragraph"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <ParagraphBlockView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'richText': {
      const payload = payloadAs(resolved, 'richText');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="richText"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <RichTextView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'keyValueGrid': {
      const payload = payloadAs(resolved, 'keyValueGrid');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="keyValueGrid"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <KeyValueGridView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'fieldList': {
      const payload = payloadAs(resolved, 'fieldList');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="fieldList"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <FieldListView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'badgeRow': {
      const payload = payloadAs(resolved, 'badgeRow');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="badgeRow"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <BadgeRowView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'pageBreak':
      // §21.4 规则 9：pageBreak **永不渲染**，它只是「在此处强制结束当前页」的指令。
      // 这里刻意返回 null 并注释说明，不是「漏实现」。
      return <PageBreakView />;
    case 'image': {
      const payload = payloadAs(resolved, 'image');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="image"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <ImageView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'table': {
      const payload = payloadAs(resolved, 'table');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="table"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <TableView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'divider': {
      const payload = payloadAs(resolved, 'divider');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="divider"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <DividerView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'spacer': {
      const payload = payloadAs(resolved, 'spacer');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="spacer"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <SpacerView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    case 'metaFooter': {
      const payload = payloadAs(resolved, 'metaFooter');
      if (!payload) return null;
      return (
        <BlockRoot
          blockId={resolved.blockId}
          kind="metaFooter"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={rootStyle}
        >
          <MetaFooterView {...common} payload={payload} />
        </BlockRoot>
      );
    }
    default:
      // 未知 kind（配置损坏 / 未来版本新增类型）：显式占位，绝不静默丢块。
      return (
        <PendingBlockView
          blockId={resolved.blockId}
          kind="unknown"
          fragmentIndex={fragmentIndex}
          fragmentsTotal={fragmentsTotal}
          style={pendingStyle}
          innerStyle={common.innerStyle}
        />
      );
  }
}

/** 按 `kind` 分发的区块渲染器（`memo`：分页重排时避免整片区块重渲染） */
export const BlockRenderer = memo(BlockRendererImpl);

export default BlockRenderer;
