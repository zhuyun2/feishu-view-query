/**
 * docx 模板导入 5b · 补充：**上传失败链路的日志出口**（[cbv:tpl.store]）。
 *
 * 背景（真机失明事故）：v1.4.0 之前 `saveImportedDocx` 失败只进 UI 红字、不打任何日志，
 * 真机（飞书 bridge）上「setData 返回非 true / 单 key 容量」这类本地复现不了的差异无从定位。
 *
 * 覆盖（团队铁律：禁止假绿；否定断言必配正面锚点）：
 *  · **端到端**：注册假 bridge store 后上传 → 写块被拒 → UI 红字文案**一字不改** +
 *    logWarn 载荷含 phase / templateId / chunkIndex / setDataReturn（区分真机根因的关键证据）；
 *  · UI 前置校验失败（非 .docx / 超限）→ logWarn 带 phase 与关键参数；
 *  · ⭐ **成功路径零日志**（防噪音回归：日志只在失败时出现）；
 *  · UI 文案回归锚点：失败文案与既有常量**逐字相等**（本改动只加日志、不动用户可见行为）。
 *
 * ⚠️ vi.mock('@/utils/log') 提升到文件顶部：本文件内组件与存储层共用同一 mock。
 */
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { ImportedDocx } from '@/config/types';
import type { BridgeStore } from '@/sdk/base';
import {
  decodeImportedDocx,
  MAX_IMPORTED_DOCX_BYTES,
  setTemplateBridgeStore,
} from '@/doc/template/storage';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldType } from '@/fields/fieldTypes';
import { logInfo, logWarn } from '@/utils/log';
import {
  DocxTemplateSourceBar,
  nonDocxMessage,
  oversizeMessage,
} from './DocxTemplateSourceBar';

/* ⭐ mock 统一日志出口（真实实现只包 console.*，mock 后才能断言载荷要素） */
vi.mock('@/utils/log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20000 });

/* ===================== 现场生成最小 docx（pizzip，与 5b 主测试同款） ===================== */

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

function docxOf(text: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generate({ type: 'uint8array' });
}

/* ===================== 挂载 / 交互工具（与 5b 主测试同款的最小集） ===================== */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  setTemplateBridgeStore(null); // 复位注册表（避免污染后续用例）
});

function mount(node: ReturnType<typeof createElement>): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return { container, unmount };
}

function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** 受控 Harness：`onImportedDocxChange` 回写本地 state（与 5b 主测试同款） */
function BarHarness(props: {
  initialImported: ImportedDocx | null;
  onImportedDocxChange: (imported: ImportedDocx) => void;
}): JSX.Element {
  const [imported, setImported] = useState<ImportedDocx | null>(props.initialImported);
  return createElement(DocxTemplateSourceBar, {
    source: 'imported',
    importedDocx: imported,
    fields: FIELDS,
    onSourceChange: () => undefined,
    onImportedDocxChange: (next) => {
      props.onImportedDocxChange(next);
      setImported(next);
    },
  });
}

function mountBar(onImportedDocxChange: (imported: ImportedDocx) => void): { container: HTMLElement; unmount: () => void } {
  return mount(createElement(BarHarness, { initialImported: null, onImportedDocxChange }));
}

/* ===================== 假 bridge store（只构造「写被拒」一种故障） ===================== */

class RejectingStore implements BridgeStore {
  readonly writes: string[] = [];

  async getData(): Promise<unknown> {
    return null;
  }

  async setData(key: string): Promise<boolean> {
    this.writes.push(key);
    return false; // 模拟真机「setData resolve 非 true」（含 false / undefined 形态）
  }

  onDataChange(): () => void {
    return () => undefined;
  }
}

/* ===================== 用例 ===================== */

describe('DocxTemplateSourceBar · 上传失败链路日志出口（[cbv:tpl.store]）', () => {
  const warnCalls = (): Array<[string, string, Record<string, unknown>?]> =>
    vi.mocked(logWarn).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;
  const infoCalls = (): Array<[string, string, Record<string, unknown>?]> =>
    vi.mocked(logInfo).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('⭐ 端到端：注册 store 后写块被拒 → UI 红字一字不改 + logWarn 含 setDataReturn（真机取证）', async () => {
    const store = new RejectingStore();
    setTemplateBridgeStore(store); // 生产路径：注册表提供 bridge store

    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar((imp) => written.push(imp));

    const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
    expect(input).not.toBeNull(); // 正面锚点：上传入口存在
    selectFile(input as HTMLInputElement, new File([docxOf('客户：{客户名称}')], 'tpl.docx'));

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);

    // ① UI 文案一字不改（只加日志、不动用户可见行为）：仍是「读取模板文件失败：写入模板块失败：第 0 块被拒绝…」
    const err = container.querySelector('[data-docx-upload-error="true"]');
    expect(err?.textContent).toContain('读取模板文件失败');
    expect(err?.textContent).toContain('第 0 块被拒绝');
    expect(err?.textContent).toContain('setData 返回 false');

    // ② 控制台痕迹：storage 层补的 logWarn，载荷含定位三要素
    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('第 0 块被拒绝');
    expect(ctx?.phase).toBe('write-chunk-rejected');
    expect(typeof ctx?.templateId).toBe('string');
    expect((ctx?.templateId as string).length).toBeGreaterThan(0);
    expect(ctx?.chunkIndex).toBe(0);
    expect(ctx?.chunkCount).toBeGreaterThanOrEqual(1);
    expect(ctx?.setDataReturn).toBe('false'); // ⭐ 区分「真机 resolve 非 true」的关键证据

    // ③ 失败绝不静默写草稿（正面锚点 + 否定）
    expect(written.length).toBe(0);
    // 正面锚点：确实尝试过写块（证明失败发生在写块环节，而非没触发上传）
    expect(store.writes.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  it('非 .docx → UI 文案与常量逐字相等 + logWarn(phase=reject-non-docx, fileName)', async () => {
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar((imp) => written.push(imp));

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([new Uint8Array(8)], 'note.txt'),
    );

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);
    // ⭐ 文案一字不改（回归锚点）
    expect(container.querySelector('[data-docx-upload-error="true"]')?.textContent).toBe(nonDocxMessage('note.txt'));

    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toBe(nonDocxMessage('note.txt'));
    expect(ctx?.phase).toBe('reject-non-docx');
    expect(ctx?.fileName).toBe('note.txt');
    expect(written.length).toBe(0); // 不写草稿

    unmount();
  });

  it('超限 → UI 文案与常量逐字相等 + logWarn(phase=oversize, sizeBytes/maxBytes)', async () => {
    const size = MAX_IMPORTED_DOCX_BYTES + 1024;
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar((imp) => written.push(imp));

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([new Uint8Array(size)], 'big.docx'),
    );

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);
    // ⭐ 文案一字不改（回归锚点）
    expect(container.querySelector('[data-docx-upload-error="true"]')?.textContent).toBe(oversizeMessage(size));

    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toBe(oversizeMessage(size));
    expect(ctx?.phase).toBe('oversize');
    expect(ctx?.sizeBytes).toBe(size);
    expect(ctx?.maxBytes).toBe(MAX_IMPORTED_DOCX_BYTES);
    expect(written.length).toBe(0);

    unmount();
  });

  it('⭐ 成功路径零日志（无 store 内联降级成功 → 不打 warn / info）', async () => {
    setTemplateBridgeStore(null); // 无 store → 小模板走内联降级（< 32KB）
    const bytes = docxOf('客户：{客户名称}');
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar((imp) => written.push(imp));

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([bytes], 'ok.docx'),
    );

    // 正面锚点：上传确实成功（写进草稿且内容正确，防止「没跑所以没日志」的假绿）
    await waitFor(() => written.length > 0);
    expect(written[0].fileName).toBe('ok.docx');
    expect(written[0].sizeBytes).toBe(bytes.length);
    expect(Array.from(decodeImportedDocx(written[0]))).toEqual(Array.from(bytes));
    expect(container.querySelector('[data-docx-upload-error="true"]')).toBeNull();

    expect(warnCalls().length).toBe(0);
    expect(infoCalls().length).toBe(0);

    unmount();
  });
});

/* 未覆盖项（诚实申报）：真机 bridge 的实际返回形态（false / undefined / 抛错）无法在 jsdom
 * 复现，本文件用 RejectingStore 只覆盖「resolve false」形态；「resolve undefined」在
 * writeImportedDocxChunks 的 `ok !== true` 分支与 false 同路（日志载荷 setDataReturn 会
 * 原样记录为 'undefined'），由 storage.test.ts 的单元级断言保证。 */
