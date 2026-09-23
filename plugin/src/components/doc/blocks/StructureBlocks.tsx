/**
 * 结构组 / 元信息组区块渲染器：`divider` / `spacer` / `pageBreak` / `metaFooter`
 * （设计文档 §21.2-C / §21.5 / §21.8 M3-T05）。
 *
 * ⭐ 测量契约对照（`pagination/measurer.ts`）：
 *  - 四类**都不可切分** → **不输出** `data-unit-index`。
 *    ⚠️ 这条错了会致命：装箱算法一旦把原子单元数组认出来，就会认为「这块可以跨页拆开」，
 *    从而把分隔线/间距撕到页缝里。
 *  - 四类**都不输出** `data-repeat-header`（那是 `table` 续页表头的专属标记）。
 *  - `pageBreak` **不渲染任何 DOM**（§21.4 规则 9）：它只是「在此处强制结束当前页」的
 *    指令，由 `packPages` 消费。这里的 `return null` 是**刻意**的，不是漏实现。
 *
 * ⭐ 外间距仍遵循 T04 的「内层 margin + 根 `display:flow-root`」口径（契约 1）：
 *   根节点**绝不带** margin —— 测量器读 `offsetHeight`（不含 margin），
 *   若间距挂在根上，测量值会比实际占位少 N px，分页会静默越挤越错。
 */
import type { CSSProperties, ReactElement } from 'react';
import { Fragment } from 'react';
import type { ResolvedDividerPayload, ResolvedMetaFooterPayload, ResolvedSpacerPayload } from '@/doc/resolve';
import type { DocBlockRenderProps } from './BlockRenderer';

export interface DividerViewProps extends DocBlockRenderProps {
  payload: ResolvedDividerPayload;
}

export interface SpacerViewProps extends DocBlockRenderProps {
  payload: ResolvedSpacerPayload;
}

export interface MetaFooterViewProps extends DocBlockRenderProps {
  payload: ResolvedMetaFooterPayload;
}

/**
 * 11. 强制分页：**纯指令，不渲染可见 DOM**（§21.4 规则 9）。
 *
 * 渲染成 `null` 而不是一个空 `<div>`：空 div 也是有一个 offsetHeight 的盒子，
 * 会让测量器多出一个高度为 0~N 的区块条目，干扰装箱。
 */
export function PageBreakView(): null {
  return null;
}

/**
 * 9. 分隔线。
 *
 * 颜色口径（架构裁定 Q4）：分隔线颜色**沿用基类 `DocBlockBase.style.color`**，
 * 用户没配时才回落到主题的 `dividerColor`。
 * 线宽用 `borderTopWidth`、线型用 `borderTopStyle`（其余三边用**长手属性**显式置 none，
 * 避免浏览器给 `<hr>` 的默认 `border: 1px inset` 把高度也算进去）。
 */
export function DividerView(props: DividerViewProps): ReactElement {
  const { payload, innerStyle, theme, blockColor } = props;
  const thickness = Number.isFinite(payload.thickness) && payload.thickness > 0 ? Math.round(payload.thickness) : 1;
  const lineStyle: CSSProperties = {
    width: '100%',
    borderLeftStyle: 'none',
    borderRightStyle: 'none',
    borderBottomStyle: 'none',
    borderTopWidth: `${thickness}px`,
    borderTopStyle: payload.borderStyle,
    borderTopColor: blockColor ?? theme.dividerColor,
  };
  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <hr
        className="cbv-doc-divider"
        role="separator"
        data-divider-style={payload.borderStyle}
        data-divider-thickness={thickness}
        style={lineStyle}
      />
    </div>
  );
}

/**
 * 10. 间距：纯粹的垂直占位盒。
 *
 * 占位高度由**内层子元素**承担，`innerStyle` 的区块间距挂在 `.cbv-doc-block__inner` 上，
 * 两者都在 BFC 根内部，故根的 `offsetHeight` 会把它们一并计入。
 */
export function SpacerView(props: SpacerViewProps): ReactElement {
  const { payload, innerStyle } = props;
  const height = Number.isFinite(payload.height) && payload.height > 0 ? Math.round(payload.height) : 0;
  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-spacer" aria-hidden="true" data-spacer-height={height} style={{ height: `${height}px` }} />
    </div>
  );
}

/**
 * 12. 页脚元信息：创建人 / 创建时间 / 修改人 / 修改时间 / 记录 ID。
 *
 * 拼接由逐个 `<span data-meta-entry>` 产出、**项间插入 separator 文本节点**完成，
 * 而不是直接吐一个 `payload.text`：这样「哪一项缺失」「分隔符是什么」在 DOM 上都可查
 * （编辑器与测试需要按 key 定位单项）。拼接结果的 `textContent`
 * **恒等于** `entries.map(text).join(separator)`（= `payload.text`）。
 */
export function MetaFooterView(props: MetaFooterViewProps): ReactElement {
  const { payload, innerStyle, theme } = props;
  const style: CSSProperties = {
    fontSize: `${payload.fontSize}px`,
    lineHeight: theme.lineHeight,
    color: payload.muted === true ? theme.mutedColor : undefined,
  };

  return (
    <div className="cbv-doc-block__inner" style={innerStyle}>
      <div className="cbv-doc-meta-footer" data-meta-count={payload.entries.length} style={style}>
        {payload.entries.map((entry, index) => (
          <Fragment key={entry.key}>
            {index > 0 ? (
              <span className="cbv-doc-meta-footer__sep" data-meta-separator="true">
                {payload.separator}
              </span>
            ) : null}
            <span className="cbv-doc-meta-footer__entry" data-meta-entry={entry.key}>
              {entry.text}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
