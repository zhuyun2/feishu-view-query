/**
 * 生产测量器：离屏 DOM 测量（设计文档 §21.3.2 / §21.4.2 / §21.10-⑦）。
 *
 * 职责边界：
 *  - 本模块是 `pagination/` 里**唯一**接触 DOM 的文件；
 *  - **不** import `components/`（离屏宿主是纯 DOM div，由本文件自建，上层把区块渲染进去即可）；
 *  - `measureBlocks()` 与 `Measurer` 接口一致，保持**同步**（一次同步读 `offsetHeight`，
 *    避免读写交替引发的强制重排）。
 *
 * 图片时序（§21.10-⑦）：图片未加载时高度未知，`measureBlocks` 是同步的无法 await，
 * 故拆成两步：
 *  ① 测量前调用 `await measurer.waitForImages(host)` —— 等 `<img>.complete`，**超时 3s 即放行**；
 *  ② 若超时后仍有图片没高度，`measureBlocks` 按「声明 width/height 属性 → 自然宽高比 → 兜底 160px」
 *     估算，绝不返回 0（返回 0 会让该块塌陷、分页结果失真）。
 */
import type { BlockMetrics, Measurer } from './types';

/** 图片加载等待上限（§21.10-⑦ 与 §13.2 的 3s 字体超时统一口径） */
export const DEFAULT_IMAGE_TIMEOUT_MS = 3000;

/** 图片既无声明尺寸又无自然宽高时的兜底高度 px */
export const DEFAULT_IMAGE_ESTIMATE_HEIGHT = 160;

/** 离屏宿主的挂载容器缺省为 document.body */
export interface OffscreenHostHandle {
  host: HTMLElement;
  /** 从文档移除宿主，释放渲染内容 */
  destroy(): void;
}

export interface DomMeasurerOptions {
  /** 图片等待上限 ms，默认 `DEFAULT_IMAGE_TIMEOUT_MS` */
  imageTimeoutMs?: number;
}

export interface DomMeasurer extends Measurer {
  /**
   * 测量前调用：等待宿主体内全部 `<img>` 完成（load/error）。
   * **超时即放行**，绝不因为一张慢图把分页卡死。
   */
  waitForImages(host: HTMLElement, timeoutMs?: number): Promise<void>;
  readonly imageTimeoutMs: number;
}

/**
 * 创建离屏宿主。
 *
 * 样式要点（缺一不可）：
 *  - `visibility:hidden` —— 不可见但**仍参与布局**（`display:none` 会让 `offsetHeight` 恒为 0）；
 *  - `position:absolute` + `left:-10000px` —— 脱离文档流并移出视口，不影响宿主页面；
 *  - `width = contentBox.width` —— 换行结果与真实纸页一致，这是测量正确的前提；
 *  - `pointer-events:none` / `aria-hidden` —— 不可交互、不进无障碍树。
 */
export function createOffscreenHost(
  width: number,
  parent?: HTMLElement | null,
): OffscreenHostHandle {
  if (typeof document === 'undefined') {
    throw new Error('createOffscreenHost 需要 DOM 环境（document 不可用）');
  }
  const host = document.createElement('div');
  host.setAttribute('data-cbv-offscreen', 'true');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'absolute',
    top: '0',
    left: '-10000px',
    visibility: 'hidden',
    pointerEvents: 'none',
    zIndex: '-1',
    width: `${Math.max(0, Math.round(width))}px`,
    boxSizing: 'border-box',
    margin: '0',
    padding: '0',
  });
  const mount = parent ?? document.body;
  mount.appendChild(host);
  return {
    host,
    destroy(): void {
      if (host.parentNode) host.parentNode.removeChild(host);
    },
  };
}

/** 读取元素高度：offsetHeight 优先，回落 getBoundingClientRect（亚像素向上取整） */
function readHeight(el: HTMLElement): number {
  const offset = el.offsetHeight;
  if (typeof offset === 'number' && offset > 0) return offset;
  const rect = el.getBoundingClientRect();
  if (rect && rect.height > 0) return Math.ceil(rect.height);
  return 0;
}

/** 宿主可用宽度：优先布局宽度，回落内联样式宽度 */
function readContainerWidth(host: HTMLElement): number {
  if (typeof host.clientWidth === 'number' && host.clientWidth > 0) return host.clientWidth;
  const declared = Number.parseFloat(host.style.width);
  return Number.isFinite(declared) && declared > 0 ? declared : 0;
}

/**
 * 图片未加载完时的高度估算（§21.10-⑦）：
 * ① 有 `width`/`height` 声明属性 → 按比例缩放到容器宽；
 * ② 否则用自然宽高比；
 * ③ 都没有 → 兜底 `DEFAULT_IMAGE_ESTIMATE_HEIGHT`。
 */
export function estimateImageHeight(root: HTMLElement, containerWidth: number): number {
  const img = root.querySelector('img');
  if (!img) return 0;
  const declaredW = Number(img.getAttribute('width'));
  const declaredH = Number(img.getAttribute('height'));
  if (containerWidth > 0 && declaredW > 0 && declaredH > 0) {
    return Math.max(1, Math.round((declaredH * containerWidth) / declaredW));
  }
  if (containerWidth > 0 && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return Math.max(1, Math.round((img.naturalHeight * containerWidth) / img.naturalWidth));
  }
  return DEFAULT_IMAGE_ESTIMATE_HEIGHT;
}

/** 把宿主内的区块根节点按 `data-block-id` 建成索引（不拼选择器，避免 id 含特殊字符出错） */
function indexRoots(host: HTMLElement): Map<string, HTMLElement> {
  const roots = new Map<string, HTMLElement>();
  const nodes = host.querySelectorAll<HTMLElement>('[data-block-id]');
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const blockId = node.getAttribute('data-block-id');
    if (blockId && !roots.has(blockId)) roots.set(blockId, node);
  }
  return roots;
}

/** 取「顶层」原子单元节点：父链上再无 `data-unit-index`，避免嵌套时重复计数 */
function collectUnitNodes(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-unit-index]'));
  const topLevel = all.filter((node) => {
    const parent = node.parentElement;
    if (!parent) return true;
    return parent.closest('[data-unit-index]') === null;
  });
  return topLevel.sort(
    (a, b) => Number(a.getAttribute('data-unit-index')) - Number(b.getAttribute('data-unit-index')),
  );
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_IMAGE_TIMEOUT_MS;
  }
  return value;
}

export function createDomMeasurer(options: DomMeasurerOptions = {}): DomMeasurer {
  const imageTimeoutMs = normalizeTimeout(options.imageTimeoutMs);

  /**
   * 等待图片完成。无待定图片时**立即** resolve（同步返回已解决的 Promise）；
   * 有待定图片时挂载 load/error 监听，并用 `setTimeout` 做超时兜底。
   */
  function waitForImages(host: HTMLElement, timeoutMs?: number): Promise<void> {
    const timeout = normalizeTimeout(timeoutMs ?? imageTimeoutMs);
    const images = Array.from(host.querySelectorAll('img'));
    const pending = images.filter((img) => img.complete !== true);
    if (pending.length === 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let remaining = pending.length;
      let finished = false;
      const detachers: Array<() => void> = [];

      function finish(): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (let i = 0; i < detachers.length; i += 1) detachers[i]();
        resolve();
      }

      const timer = setTimeout(finish, timeout);

      for (let i = 0; i < pending.length; i += 1) {
        const img = pending[i];
        const onEnd = (): void => {
          remaining -= 1;
          if (remaining <= 0) finish();
        };
        img.addEventListener('load', onEnd);
        img.addEventListener('error', onEnd);
        detachers.push(() => {
          img.removeEventListener('load', onEnd);
          img.removeEventListener('error', onEnd);
        });
      }
    });
  }

  function measureBlocks(
    host: HTMLElement,
    blocks: ReadonlyArray<{ blockId: string; kind: BlockMetrics['kind'] }>,
  ): BlockMetrics[] {
    const roots = indexRoots(host);
    const containerWidth = readContainerWidth(host);
    return blocks.map((block): BlockMetrics => {
      const root = roots.get(block.blockId);
      // 宿主里没有该区块（被 hideWhenEmpty 过滤 / 渲染异常）→ 记 0，不抛异常拖垮整批。
      if (!root) return { blockId: block.blockId, kind: block.kind, outerHeight: 0 };

      const unitNodes = collectUnitNodes(root);
      const units = unitNodes.length > 0 ? unitNodes.map(readHeight) : undefined;

      const headerNode = root.querySelector<HTMLElement>('[data-repeat-header]');
      const repeatHeaderHeight = headerNode ? readHeight(headerNode) : 0;

      let outerHeight = readHeight(root);
      if (outerHeight <= 0) outerHeight = estimateImageHeight(root, containerWidth);

      return {
        blockId: block.blockId,
        kind: block.kind,
        outerHeight,
        units,
        repeatHeaderHeight,
      };
    });
  }

  return {
    measureBlocks,
    waitForImages,
    get imageTimeoutMs(): number {
      return imageTimeoutMs;
    },
  };
}
