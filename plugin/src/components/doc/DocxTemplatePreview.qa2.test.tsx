/**
 * QA2 独立复核 —— docx 模板预览挂载壳（`./DocxTemplatePreview`）。
 *
 * 复核的冻结设计：
 *  · 设计7 —— **过期响应守卫**。实现方声称：渲染是**直接写 DOM** 的，故用
 *    「渲染进**分离暂存容器**，仅成功且未过期才提交」；过期链路**自始至终碰不到可见 DOM**。
 *
 * 本文件的目的是去**证伪/加固**这条主张：实现方原有用例里假渲染器是「**被调用时同步写一次**」，
 * 这**无法**区分「暂存容器」与「清空后直接写宿主」两种实现（两者都能过）。本文件改用
 * 「**延迟写**」假渲染器（模拟 docx-preview 边解析边写），并**直接观察在飞期间 / 过期完成后的可见宿主**。
 *
 * 断言纪律：两条链路 fixture 分离（A/B/C 字节互不相同、内容互不包含）；否定式断言配正面锚点。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocxBytes, RenderDocxIntoFn } from '@/doc/template/renderDocx';
import { DocxTemplatePreview } from './DocxTemplatePreview';
import type { DocxTemplatePreviewProps } from './DocxTemplatePreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 挂载工具 ===================== */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  container: HTMLElement;
  host: () => HTMLElement;
  rerender: (next: DocxTemplatePreviewProps) => void;
  unmount: () => void;
}

function mount(props: DocxTemplatePreviewProps): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(DocxTemplatePreview, props));
  });

  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);

  const host = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('[data-docx-host="true"]');
    if (!el) throw new Error('宿主未挂载');
    return el;
  };
  const rerender = (next: DocxTemplatePreviewProps): void => {
    act(() => {
      root.render(createElement(DocxTemplatePreview, next));
    });
  };
  return { container, host, rerender, unmount };
}

async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/* ===================== 延迟写假渲染器 ===================== */

interface Pending {
  label: string;
  /** 本轮渲染**拿到的容器**（若实现用暂存容器，它≠可见宿主） */
  container: HTMLElement;
  /** 延迟写入：模拟 docx-preview 边解析边写 DOM */
  write: () => void;
  finish: () => void;
}

/** 构造「延迟写」假渲染器：调用时**不写**，由测试显式 `write()` 控制写 DOM 的时机 */
function makeLateWriter(labels: Map<Uint8Array, string>): { fake: RenderDocxIntoFn; pending: Pending[] } {
  const pending: Pending[] = [];
  const fake: RenderDocxIntoFn = (container: HTMLElement, bytes: DocxBytes): Promise<void> => {
    const label = labels.get(bytes as Uint8Array) ?? '?';
    return new Promise<void>((resolve) => {
      pending.push({
        label,
        container,
        write: () => {
          const p = document.createElement('p');
          p.className = 'late-write';
          p.textContent = label;
          container.appendChild(p);
        },
        finish: resolve,
      });
    });
  };
  return { fake, pending };
}

/* ===================== 设计7：过期守卫（强主张） ===================== */

describe('QA2 · DocxTemplatePreview · 设计7（过期链路不得触碰可见 DOM）', () => {
  it('暂存隔离：在飞期间可见宿主为空；过期链路 A 晚完成后仍为空（A 从未触碰可见 DOM）', async () => {
    const labels = new Map<Uint8Array, string>();
    const bytesA = new Uint8Array([0x41]);
    const bytesB = new Uint8Array([0x42]);
    labels.set(bytesA, 'REC-A');
    labels.set(bytesB, 'REC-B');
    const { fake, pending } = makeLateWriter(labels);

    const { host, rerender, unmount } = mount({ bytes: bytesA, renderInto: fake });
    expect(pending.map((p) => p.label)).toEqual(['REC-A']);
    // 进度点①：A 在飞 → 可见宿主必须为空（内容只应落在暂存容器）
    expect(host().innerHTML).toBe('');

    rerender({ bytes: bytesB, renderInto: fake });
    expect(pending.map((p) => p.label)).toEqual(['REC-A', 'REC-B']);
    // 进度点②：B 在飞 → 可见宿主仍为空
    expect(host().innerHTML).toBe('');

    // A 拿到的是**分离容器**，而非可见宿主（这是「暂存隔离」的直接证据）
    expect(pending[0].container).not.toBe(host());

    // 过期链路 A 晚完成：写入它自己的容器并 resolve
    await act(async () => {
      pending[0].write();
      pending[0].finish();
      await Promise.resolve();
    });
    await flush(3);
    // 进度点③ ⭐ 强主张：A 的内容**不得**出现在可见宿主
    expect(host().innerHTML).toBe('');
    expect(host().querySelectorAll('.late-write').length).toBe(0);

    // B（后发起）完成 → 提交
    await act(async () => {
      pending[1].write();
      pending[1].finish();
      await Promise.resolve();
    });
    await flush(3);
    expect(host().textContent).toContain('REC-B'); // 正面锚点
    expect(host().querySelectorAll('.late-write').length).toBe(1);
    expect(host().textContent).not.toContain('REC-A');
    unmount();
  });

  it('连续切换 A→B→C：只有最后发起的 C 落进可见 DOM（A/B 后完成均被作废）', async () => {
    const labels = new Map<Uint8Array, string>();
    const bytesA = new Uint8Array([1]);
    const bytesB = new Uint8Array([2]);
    const bytesC = new Uint8Array([3]);
    labels.set(bytesA, 'REC-A');
    labels.set(bytesB, 'REC-B');
    labels.set(bytesC, 'REC-C');
    const { fake, pending } = makeLateWriter(labels);

    const { host, rerender, unmount } = mount({ bytes: bytesA, renderInto: fake });
    rerender({ bytes: bytesB, renderInto: fake });
    rerender({ bytes: bytesC, renderInto: fake });
    expect(pending.map((p) => p.label)).toEqual(['REC-A', 'REC-B', 'REC-C']);
    expect(host().innerHTML).toBe('');

    // C 先完成 → 提交
    await act(async () => {
      pending[2].write();
      pending[2].finish();
      await Promise.resolve();
    });
    await flush(3);
    expect(host().textContent).toContain('REC-C');

    // A、B 随后完成 → 皆过期，不得覆盖
    await act(async () => {
      pending[0].write();
      pending[0].finish();
      await Promise.resolve();
    });
    await flush(2);
    await act(async () => {
      pending[1].write();
      pending[1].finish();
      await Promise.resolve();
    });
    await flush(2);

    expect(host().textContent).toContain('REC-C');
    expect(host().textContent).not.toContain('REC-A');
    expect(host().textContent).not.toContain('REC-B');
    expect(host().querySelectorAll('.late-write').length).toBe(1);
    unmount();
  });

  it('过期链路的**失败**同样被丢弃：不上报 onError、不覆盖新内容', async () => {
    const labels = new Map<Uint8Array, string>();
    const bytesA = new Uint8Array([0x41]);
    const bytesB = new Uint8Array([0x42]);
    labels.set(bytesA, 'REC-A');
    labels.set(bytesB, 'REC-B');
    const errors: string[] = [];

    let rejectA: ((err: unknown) => void) | null = null;
    const fake: RenderDocxIntoFn = (container: HTMLElement, bytes: DocxBytes): Promise<void> => {
      const label = labels.get(bytes as Uint8Array);
      if (label === 'REC-A') {
        return new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        });
      }
      // B：立即写入并成功
      const p = document.createElement('p');
      p.className = 'late-write';
      p.textContent = 'REC-B';
      container.appendChild(p);
      return Promise.resolve();
    };

    const { host, rerender, unmount } = mount({
      bytes: bytesA,
      onError: (m) => errors.push(m),
      renderInto: fake,
    });
    rerender({ bytes: bytesB, onError: (m) => errors.push(m), renderInto: fake });
    await flush(3);
    expect(host().textContent).toContain('REC-B'); // 正面锚点：B 已提交

    // 过期链路 A 现在失败
    await act(async () => {
      rejectA?.(new Error('A 过期失败'));
      await Promise.resolve();
    });
    await flush(3);

    expect(errors).toEqual([]); // 过期失败不得上报
    expect(host().textContent).toContain('REC-B'); // 新内容不被覆盖
    expect(host().querySelectorAll('[data-docx-error="true"]').length).toBe(0);
    unmount();
  });
});
