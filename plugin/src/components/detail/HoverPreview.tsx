/**
 * 悬浮预览气泡（T12 / P0-15）：150ms 延迟触发的简要摘要卡片。
 *
 * - 鼠标移入气泡**不消失**（`onEnter` → 控制器取消隐藏）；
 * - 贴右缘时**翻到左侧**（`computeBubblePlacement`）；
 * - 内容为「标题 + 属性区前若干行」，**只读**、不外泄原始 ID。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StyleTheme } from '@/config/types';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { FieldValue } from '@/components/card/FieldValue';
import { recordTitleText, visiblePlacements } from '@/components/card/slotContent';
import { computeBubblePlacement } from './drawerMath';

/** 气泡内的兜底主题（模块级常量：避免在 render 内新建对象） */
const FALLBACK_THEME: StyleTheme = {
  preset: 'feishu-default',
  primaryColor: '#3370FF',
  borderRadius: 8,
  shadowLevel: 1,
  fontScale: 1,
  titleWeight: 600,
};

export interface HoverPreviewProps {
  /** 指针进入气泡（取消隐藏） */
  onEnter?: () => void;
  /** 指针离开气泡（安排隐藏） */
  onLeave?: () => void;
}

const MAX_ROWS = 4;

export function HoverPreview({ onEnter, onLeave }: HoverPreviewProps): JSX.Element | null {
  const hover = useUiStore((state) => state.hover);
  const records = useViewStore((state) => state.records);
  const fieldsById = useViewStore((state) => state.fieldsById);
  const layout = useViewStore((state) => state.config?.card ?? null);

  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 280, height: 180 });
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useLayoutEffect(() => {
    const element = bubbleRef.current;
    if (!element) return;
    const width = element.offsetWidth || size.width;
    const height = element.offsetHeight || size.height;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  }, [hover.recordId, size.width, size.height]);

  if (!hover.recordId || !hover.anchor || !layout) return null;

  const record = records.find((item) => item.recordId === hover.recordId);
  if (!record) return null;

  const placement = computeBubblePlacement({
    anchor: hover.anchor,
    bubbleWidth: size.width,
    bubbleHeight: size.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });

  const style: CSSProperties = { left: placement.left, top: placement.top };

  const attributeSlot = layout.slots.attributes;
  const placements = attributeSlot ? visiblePlacements(attributeSlot, MAX_ROWS) : [];

  return (
    <div
      ref={bubbleRef}
      className="cbv-hover-preview"
      data-side={placement.side}
      role="tooltip"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="cbv-hover-preview__title">{recordTitleText(layout, record, fieldsById)}</div>
      <div className="cbv-hover-preview__rows">
        {placements.map((placement) => {
          const meta = fieldsById[placement.fieldId];
          if (!meta) return null;
          return (
            <div className="cbv-attr-row" key={placement.placementId}>
              <span className="cbv-attr-row__label">{placement.label || meta.name}</span>
              <span className="cbv-attr-row__value">
                <FieldValue
                  placement={placement}
                  record={record}
                  fieldsById={fieldsById}
                  theme={FALLBACK_THEME}
                  locale="zh-CN"
                />
              </span>
            </div>
          );
        })}
      </div>
      <div className="cbv-hover-preview__hint">点击卡片查看详情</div>
    </div>
  );
}
