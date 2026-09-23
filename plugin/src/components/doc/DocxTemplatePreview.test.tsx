/**
 * `components/doc/DocxTemplatePreview` 单测 —— docx 模板预览**挂载壳**。
 *
 * 覆盖三件「用户看得见但不报错」的静默故障（见组件文件头）：
 *  ① **重复渲染不叠加**（切换字节 → 只保留新内容）；
 *  ② ⭐ **过期响应不覆盖新内容**（先发起的渲染后完成 → 最终 DOM 仍是后发起的那份）；
 *  ③ **失败有可读提示**（`onError` 拿到 `formatError` 文案 + 宿主有明确文案）。
 * 另覆盖：卸载清理（无残留）、`bytes=null` 空态。
 *
 * 断言策略（团队铁律：**禁止假绿**）：否定式断言必配正面锚点；两条链路可能同值时 fixture 分离
 * （A/B 字节内容不同且互不包含）。
 *
 * 确定性来源：
 *  - 「时序」用例注入**可控完成时序**的假渲染器（`renderInto`），逐拍 resolve；
 *  - 「集成」用例走**真实 `renderDocxInto`**（动态 import docx-preview），用 `vi.waitFor` 等其落 DOM。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { DocxBytes, RenderDocxIntoFn } from '@/doc/template/renderDocx';
import { DocxTemplatePreview } from './DocxTemplatePreview';
import type { DocxTemplatePreviewProps } from './DocxTemplatePreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ===================== 现场生成最小 docx ===================== */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * 生成最小 docx（`Uint8Array`）。
 * 用 **PizZip**（同步、返回真正的 `Uint8Array`）—— 与「docx 导入」探针做法一致。
 * ⚠️ 不用 jszip：vitest 下 `jszip` 解析到其浏览器 UMD，`generateAsync({type:'uint8array'})`
 *    会给出 `Blob`（非字节、`length` 为 0）。
 */
function buildDocx(bodyInner: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${bodyInner}</w:body></w:document>`,
  );
  return zip.generate({ type: 'uint8array' });
}

/* ===================== 挂载工具 ===================== */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  container: HTMLElement;
  /** 宿主节点（组件唯一渲染的元素）；未挂载时抛错，避免「目标消失 → 恒真」 */
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
    const element = container.querySelector<HTMLElement>('[data-docx-host="true"]');
    if (!element) throw new Error('宿主未挂载');
    return element;
  };

  const rerender = (next: DocxTemplatePreviewProps): void => {
    act(() => {
      root.render(createElement(DocxTemplatePreview, next));
    });
  };

  return { container, host, rerender, unmount };
}

/** 冲净微任务（触发组件内 async 链路的同步段落） */
async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/* ===================== ① 挂载渲染（真实 renderDocxInto） ===================== */

describe('DocxTemplatePreview · 挂载渲染（真实 renderDocxInto）', () => {
  it('给定 docx 字节 → 宿主内出现 .docx section 且文本正确', async () => {
    const { host, unmount } = mount({ bytes: buildDocx(para('模板文本-真实渲染')) });

    await vi.waitFor(
      () => {
        expect(host().querySelectorAll('section.docx').length).toBe(1);
      },
      { timeout: 5000 },
    );
    expect(host().textContent).toContain('模板文本-真实渲染');
    unmount();
  });

  it('切换字节 → 只保留新内容（不叠加、且旧内容消失）', async () => {
    const bytesOne = buildDocx(para('DOC-ONE'));
    const bytesTwo = buildDocx(para('DOC-TWO'));
    const { host, rerender, unmount } = mount({ bytes: bytesOne });

    await vi.waitFor(
      () => {
        expect(host().textContent).toContain('DOC-ONE');
      },
      { timeout: 5000 },
    );
    // 正面锚点：旧内容确实渲染过（否则「旧内容消失」可能是「压根没渲染出来」）
    expect(host().querySelectorAll('section.docx').length).toBe(1);

    rerender({ bytes: bytesTwo });
    await vi.waitFor(
      () => {
        expect(host().textContent).toContain('DOC-TWO');
      },
      { timeout: 5000 },
    );

    expect(host().querySelectorAll('section.docx').length).toBe(1); // ⭐ 不叠加
    expect(host().textContent).not.toContain('DOC-ONE'); // 旧内容必须被清掉
    unmount();
  });
});

/* ===================== ② ⭐ 过期响应守卫 ===================== */

/** 可控完成时序的假渲染器记录 */
interface FakeCall {
  label: string;
  resolve: () => void;
}

describe('DocxTemplatePreview · ⭐ 过期响应不得覆盖新内容', () => {
  it('先发起的渲染后完成 → 最终 DOM 仍是后发起的那份（断言具体文本 + 正面锚点）', async () => {
    // 用 WeakMap 绑定「字节对象 → 标签」：**不依赖 TextEncoder/TextDecoder 的跨 realm 行为**
    // （jsdom 下 `instanceof Uint8Array` / 对外来视图的 `TextDecoder.decode` 都可能失败）。
    const labels = new WeakMap<object, string>();
    const bytesA = new Uint8Array([0x41]);
    const bytesB = new Uint8Array([0x42]);
    labels.set(bytesA, 'RECORD-AAA');
    labels.set(bytesB, 'RECORD-BBB');

    const calls: FakeCall[] = [];
    const fake: RenderDocxIntoFn = (container: HTMLElement, bytes: DocxBytes) => {
      const label = labels.get(bytes as object) ?? '<unknown>';
      // 立即写入**传入的容器**（模拟 docx-preview 边解析边写 DOM）
      const node = document.createElement('p');
      node.className = 'fake-docx';
      node.textContent = label;
      container.appendChild(node);
      return new Promise<void>((resolve) => {
        calls.push({ label, resolve });
      });
    };

    const { host, rerender, unmount } = mount({ bytes: bytesA, renderInto: fake });
    expect(calls.map((call) => call.label)).toEqual(['RECORD-AAA']);

    // 切到 B（旧链路被作废）
    rerender({ bytes: bytesB, renderInto: fake });
    expect(calls.map((call) => call.label)).toEqual(['RECORD-AAA', 'RECORD-BBB']);

    // B（后发起）先完成
    await act(async () => {
      calls[1].resolve();
      await Promise.resolve();
    });
    expect(host().textContent).toContain('RECORD-BBB'); // 正面锚点
    expect(host().querySelectorAll('.fake-docx').length).toBe(1);

    // A（先发起）后完成 —— 过期，绝不能覆盖 B
    await act(async () => {
      calls[0].resolve();
      await Promise.resolve();
    });
    await flush(2);

    expect(host().textContent).toContain('RECORD-BBB');
    expect(host().textContent).not.toContain('RECORD-AAA'); // ⭐ 过期链路若覆盖 → 必红
    expect(host().querySelectorAll('.fake-docx').length).toBe(1);
    unmount();
  });
});

/* ===================== ③ 错误路径 ===================== */

describe('DocxTemplatePreview · 错误路径', () => {
  it('坏字节 → onError 收到可读文案（非 [object Object]）+ 宿主有明确文案 + 无 section 残留', async () => {
    const errors: string[] = [];
    const bad = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 255, 254]);
    const { host, unmount } = mount({ bytes: bad, onError: (message) => errors.push(message) });

    await vi.waitFor(
      () => {
        expect(host().querySelectorAll('[data-docx-error="true"]').length).toBe(1);
      },
      { timeout: 5000 },
    );

    expect(errors.length).toBe(1);
    expect(typeof errors[0]).toBe('string');
    expect(errors[0].length).toBeGreaterThan(0);
    expect(errors[0]).not.toContain('[object Object]');
    // 宿主里必须有可读文案（而不是一片空白），且包含上报给 onError 的同一文案
    expect(host().textContent).toContain('模板渲染失败');
    expect(host().textContent).toContain(errors[0]);
    expect(host().querySelectorAll('section.docx').length).toBe(0);
    unmount();
  });
});

/* ===================== ④ 卸载清理 / 空态 ===================== */

describe('DocxTemplatePreview · 卸载清理与空态', () => {
  it('卸载后宿主被清空（无残留），且卸载前确实渲染过（正面锚点）', async () => {
    const { host, unmount } = mount({ bytes: buildDocx(para('卸载前内容')) });

    await vi.waitFor(
      () => {
        expect(host().querySelectorAll('section.docx').length).toBe(1);
      },
      { timeout: 5000 },
    );

    const hostElement = host(); // 卸载后仍持有该节点引用
    expect(hostElement.innerHTML.length).toBeGreaterThan(0); // 正面锚点：卸载前有内容

    unmount();

    expect(hostElement.innerHTML).toBe('');
    expect(hostElement.querySelectorAll('section.docx').length).toBe(0);
  });

  it('bytes=null → 宿主机为空，且不触发 onError', async () => {
    const errors: string[] = [];
    const { host, unmount } = mount({ bytes: null, onError: (message) => errors.push(message) });

    await flush(2);
    expect(host().innerHTML).toBe('');
    expect(errors).toEqual([]);
    unmount();
  });
});
