/**
 * 卡片骨架（T13 · 04 §5.1.2 #12 / 组件清单 #17 骨架块）：
 * 4 条灰度条（高 12px、圆角 4px、间距 10px），微光 1400ms 循环。
 * 用于首屏（8 张）与增量加载（底部 2 张）过渡，避免布局跳变。
 */
import { memo } from 'react';

export interface CardSkeletonProps {
  /** 用于 aria 与测试定位 */
  index?: number;
}

function CardSkeletonInner({ index = 0 }: CardSkeletonProps): JSX.Element {
  return (
    <div className="cbv-card cbv-card--skeleton" data-skeleton-index={index} aria-hidden="true">
      <span className="cbv-skeleton-bar cbv-skeleton-bar--title" />
      <span className="cbv-skeleton-bar cbv-skeleton-bar--sub" />
      <span className="cbv-skeleton-bar" />
      <span className="cbv-skeleton-bar cbv-skeleton-bar--short" />
    </div>
  );
}

export const CardSkeleton = memo(CardSkeletonInner);
CardSkeleton.displayName = 'CardSkeleton';
