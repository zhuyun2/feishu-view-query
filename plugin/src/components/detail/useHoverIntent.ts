/**
 * `useHoverIntent`（T12）：把纯逻辑控制器 `HoverIntentController` 接到 `UiStore`。
 *
 * 控制器实例只创建一次（引用稳定，避免每次渲染重建定时器）；其回调通过
 * `useUiStore.getState()` 读取最新 action，无需依赖数组。
 */
import { useEffect, useRef } from 'react';
import { useUiStore } from '@/state/UiStore';
import { HOVER_HIDE_GRACE_MS, HOVER_INTENT_DELAY_MS, HoverIntentController } from './hoverIntent';

export function useHoverIntent(): HoverIntentController {
  const ref = useRef<HoverIntentController | null>(null);

  if (ref.current === null) {
    ref.current = new HoverIntentController(
      {
        onShow: (recordId, anchor) => useUiStore.getState().setHover(recordId, anchor),
        onHide: () => useUiStore.getState().clearHover(),
      },
      HOVER_INTENT_DELAY_MS,
      HOVER_HIDE_GRACE_MS,
    );
  }

  useEffect(() => {
    const controller = ref.current;
    return () => controller?.dispose();
  }, []);

  return ref.current;
}
