/**
 * 单张「连续长页」（设计文档 §21.3.4 / §21.5 / M3-T06；2026-09-21 **设计变更**）。
 *
 * ⭐ 设计变更（用户拍板）：详情从「A4 分页预览」改为「**单张连续长页**」。
 *   本组件不再渲染多张纸页、不再按 `top` **绝对定位**、不再渲染页眉/页脚/页码/分页边界。
 *   取而代之：**一个**纸页容器，宽度 = 纸张 px，**高度随内容自然增长**（不设 `height`），
 *   区块在内容盒内**顺序流式摆放**（间距已在块内自洽，见下方契约 1）。
 *
 * 结构（简化为两段）：
 * ```
 * <div.cbv-paper data-paper data-orientation>          宽 = 纸张 px；padding = pageSetup.margin
 * └── <div.cbv-paper__body data-content-box="true">    内容盒：仅显式宽 = getContentBox().width
 *     └── <BlockRenderer/> × N                         顺序流式；高度随内容增长
 * ```
 *
 * ⭐ 契约 1（**绝不**再叠加 blockSpacing）：
 *   T04/T05 已把区块外间距放进**区块内部**（内层 margin + 根 `display:flow-root` 建 BFC），
 *   因此内容盒**不得**再加 gap / margin / padding / 额外 spacer 元素来「美化间距」——
 *   否则「编辑器中排好的换行位置」与「详情里看到的」会分叉。纸页根的 `padding = pageSetup.margin`
 *   是**页边距**（纸张规格），与区块间距无关。
 *
 * ⭐ 契约 3（按 `blockId` 取区块）：
 *   逐个 `PagedItem` 用 `blocksById[item.blockId]` 取区块，并把跨页片段信息
 *   （`fragmentIndex` / `fragmentsTotal` / `slice`）**原样透传**给 `BlockRenderer`
 *   （单页长页下恒为 `fragmentIndex=0 / fragmentsTotal=1`，但透传契约保持不变）。
 *
 * ⚠️ 兼容性说明（刻意保留的惰性 props）：`totalPages` / `showHeaderFooter` / `showBoundary`
 *   在单页长页下不再被消费，仅保留在 `DocPaperProps` 以维持既有调用方与守卫测试的编译期兼容。
 */
import type { CSSProperties, ReactElement } from 'react';
import { memo } from 'react';
import type { DocTheme, PageSetup } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { SdkRecord } from '@/sdk/port';
import type { PagedItem } from '@/pagination/types';
import type { ResolvedBlock } from '@/doc/resolve';
import { getContentBox, getPaperSizePx } from '@/constants/paper';
import { BlockRenderer } from './blocks/BlockRenderer';

/** `DocPaper` 入参（§21.3.4；单页长页后 `showHeaderFooter` / `showBoundary` / `totalPages` 为惰性保留） */
export interface DocPaperProps {
  /** 0 起的页序号（单页长页恒为 0；仍输出 `data-page-index` 供定位） */
  pageIndex: number;
  /** @deprecated 单页长页后不再分页；保留仅为兼容既有调用方。 */
  totalPages: number;
  /** 本页条目（单页长页 = 全部区块，按模板顺序） */
  items: PagedItem[];
  pageSetup: PageSetup;
  theme: DocTheme;
  blocksById: Record<string, ResolvedBlock>;
  record: SdkRecord | null;
  fieldsById: Record<string, FieldMetaLite>;
  locale: string;
  /** @deprecated 单页长页不再渲染页眉/页脚；保留仅为兼容既有调用方。 */
  showHeaderFooter: boolean;
  /** @deprecated 单页长页无分页边界；保留仅为兼容既有调用方。 */
  showBoundary?: boolean;
}

/**
 * 每个条目的绝对 `top` = 其前所有条目高度之和（前缀累加）。
 * **纯函数**（**遗留**）：单页长页不再使用绝对定位；保留仅为兼容既有单测的导入。
 * @deprecated 单页长页后不再按 `top` 绝对定位。
 */
export function blockTopOffsets(items: ReadonlyArray<PagedItem>): number[] {
  const offsets: number[] = [];
  let y = 0;
  for (const item of items) {
    offsets.push(y);
    y += Math.max(0, item.height);
  }
  return offsets;
}

/**
 * 该页是否渲染**页眉**（§21.4.3）。
 * @deprecated 单页长页不再渲染页眉/页脚；保留仅为兼容既有单测的导入。
 */
export function shouldRenderHeader(setup: PageSetup, pageIndex: number): boolean {
  if (setup.header?.enabled !== true) return false;
  return setup.headerFooterScope === 'all' || pageIndex === 0;
}

/**
 * 该页是否渲染**页脚**（§21.4.3）。
 * @deprecated 单页长页不再渲染页眉/页脚；保留仅为兼容既有单测的导入。
 */
export function shouldRenderFooter(setup: PageSetup): boolean {
  return setup.footer?.enabled === true || setup.showPageNumber === true;
}

function DocPaperImpl(props: DocPaperProps): ReactElement {
  const { pageIndex, items, pageSetup, theme, blocksById, record, fieldsById, locale } = props;

  const paper = getPaperSizePx(pageSetup.paper, pageSetup.orientation);
  // ⚠️ 本处几何须与编辑器画布 DocCanvas 保持一致（同一 `constants/paper.ts` 来源，不各自硬编码尺寸）；
  //    改动请同步另一侧 —— 否则「编辑器中排好的换行位置」与「详情里看到的」会分叉，
  //    而这种分叉**不会让任何测试变红**（守卫：`docPathConsistency.test.tsx` 断言两侧内容宽度恒等 `getContentBox().width`）。
  const contentBox = getContentBox(pageSetup.paper, pageSetup.orientation, pageSetup.margin);
  const margin = pageSetup.margin;

  const rootStyle: CSSProperties = {
    position: 'relative',
    boxSizing: 'border-box',
    width: paper.w,
    // 页边距用**长手属性**表达（而非 padding 简写）：① 便于逐边断言内容盒边界；② 简写会被 CSSOM 归一化。
    paddingTop: margin.top,
    paddingRight: margin.right,
    paddingBottom: margin.bottom,
    paddingLeft: margin.left,
    background: '#fff',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
    // ⚠️ **高度自适应**：不设 height（随内容增长）；不设 overflow:hidden（内容不被裁剪）。
    fontFamily: theme.fontFamily,
    fontSize: theme.baseFontSize,
    lineHeight: theme.lineHeight,
    color: theme.textColor,
  };

  /**
   * 内容盒：**仅**显式宽 = ContentBox.width（与编辑器画布同源，决定文字换行位置）。
   * ⚠️ 不设 height（高度随内容）；**不设** gap / display:flex|grid —— 区块间距已在块内自洽（契约 1）。
   */
  const bodyStyle: CSSProperties = {
    position: 'relative',
    width: contentBox.width,
  };

  return (
    <div
      className="cbv-paper"
      data-page-index={pageIndex}
      data-paper={pageSetup.paper}
      data-orientation={pageSetup.orientation}
      data-testid={`doc-paper-${pageIndex}`}
      style={rootStyle}
    >
      <div className="cbv-paper__body" data-content-box="true" style={bodyStyle}>
        {items.map((item) => {
          const resolved = blocksById[item.blockId];
          const key = `${item.blockId}#${item.fragmentIndex}`;

          if (!resolved) {
            // 分页产物引用了一个不存在的 blockId（脏数据）→ 显式占位，绝不静默丢块。
            return (
              <div
                key={key}
                className="cbv-paper__missing"
                data-block-id={item.blockId}
                data-block-missing="true"
              >
                【缺失区块】{item.blockId}
              </div>
            );
          }

          return (
            <BlockRenderer
              key={key}
              resolved={resolved}
              fragmentIndex={item.fragmentIndex}
              fragmentsTotal={item.fragmentsTotal}
              slice={item.slice}
              theme={theme}
              locale={locale}
              record={record}
              fieldsById={fieldsById}
              contentWidth={contentBox.width}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 单张连续长页（`memo`：缩放 / 记录切换时避免整页重渲染） */
export const DocPaper = memo(DocPaperImpl);

export default DocPaper;
