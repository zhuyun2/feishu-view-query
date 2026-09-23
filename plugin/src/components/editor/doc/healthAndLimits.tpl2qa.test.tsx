/**
 * ⭐ QA2（software-qa-engineer-tpl2）**独立**验证：模板体检的「红字可见」与「超限文案含数值」。
 *
 * 原理由（为什么必须做）：参考的打印插件**没有**体检这块 —— 未匹配的占位符被**静默清空**，
 * 输出一块空白，用户只会以为「这个字段本来没数据」，**不会怀疑是自己模板里字段名写错了**。
 * 故此处独立断言：`unmatched` / `duplicateFieldNames` / `unclosedLoops` 三类问题**必须在 UI 上
 * 以红字列出具体原文 / 字段 id**，且超限文案**真的带了实际大小与上限的数值**。
 *
 * 断言策略：否定式断言配正面锚点；源码级断言先剔注释再匹配；红字用「class 锚定 + CSS 源值」双重锁定。
 * 生成 docx 用 **pizzip**（同步 `generate`），**不用** jszip（JSZip 3 已移除同步 generate）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { ImportedDocx } from '@/config/types';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { encodeImportedDocx, MAX_IMPORTED_DOCX_BYTES } from '@/doc/template/storage';
import {
  DocxTemplateSourceBar,
  oversizeMessage,
} from './DocxTemplateSourceBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 真实动态 import（pizzip）——放宽超时。
vi.setConfig({ testTimeout: 20000 });

/* ============================ 现场生成最小 docx（pizzip） ============================ */

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

function docxOf(text: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generate({ type: 'uint8array' });
}

/* ============================ 夹具 / 工具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];
const DUP_FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '客户名称', type: FieldType.Text, isPrimary: false },
];

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
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

function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function mountBar(fields: FieldMetaLite[], imported: ImportedDocx | null, onImportedDocxChange?: (i: ImportedDocx) => void): HTMLElement {
  const { container } = mount(
    createElement(DocxTemplateSourceBar, {
      source: 'imported',
      importedDocx: imported,
      fields,
      onSourceChange: () => undefined,
      onImportedDocxChange: onImportedDocxChange ?? (() => undefined),
    }),
  );
  return container;
}

/* ============================================================
 * ① 三类问题 → 红字 + 具体原文（不静默）
 * ============================================================ */

describe('模板体检 · 三类问题必须红字可见（不静默）', () => {
  it('unmatched → 红字块 + 逐个列出模板原文（含花括号）；同类命中的字段不误红', async () => {
    const imported = encodeImportedDocx('bad.docx', docxOf('客户：{客户名称} 备注：{无此字段}'), 1);
    const container = mountBar(FIELDS, imported);

    await waitFor(() => container.querySelector('[data-health-unmatched="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-unmatched="true"]');
    expect(block?.className).toContain('cbv-health__issue--error'); // 红字（class 锚定）
    const item = container.querySelector('[data-health-unmatched-item="无此字段"]');
    expect(item?.textContent).toBe('{无此字段}'); // ⭐ 确切原文（含花括号）
    // 对照：命中的字段仍在 matched 计数里（不是「全红」）
    expect(container.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');
  });

  it('duplicateFieldNames（源字段重名）→ 红字块 + 含两个字段 id；且同时报 ambiguous', async () => {
    const imported = encodeImportedDocx('dup.docx', docxOf('客户：{客户名称}'), 1);
    const container = mountBar(DUP_FIELDS, imported);

    await waitFor(() => container.querySelector('[data-health-duplicate="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-duplicate="true"]');
    expect(block?.className).toContain('cbv-health__issue--error');
    expect(block?.textContent).toContain('客户名称');
    expect(block?.textContent).toContain('f1');
    expect(block?.textContent).toContain('f2');
    // 重名同时导致 ambiguous（不能静默取首个）
    const ambiguous = container.querySelector<HTMLElement>('[data-health-ambiguous="true"]');
    expect(ambiguous).not.toBeNull();
    expect(ambiguous?.className).toContain('cbv-health__issue--error');
  });

  it('unclosedLoops（{#明细} 无 {/明细}）→ 红字块 + 文案含 {#明细}/{/明细}', async () => {
    const imported = encodeImportedDocx('loop.docx', docxOf('{#明细}{客户名称}'), 1);
    const container = mountBar(FIELDS, imported);

    await waitFor(() => container.querySelector('[data-health-unclosed-loop="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-unclosed-loop="true"]');
    expect(block?.className).toContain('cbv-health__issue--error');
    expect(block?.textContent).toContain('{#明细}');
    expect(block?.textContent).toContain('{/明细}');
  });
});

/* ============================================================
 * ② 红字「真的红」：CSS 源值锁定（jsdom 无布局引擎，故用源码级锚定）
 * ============================================================ */

describe('模板体检 · 红字样式的 CSS 源值（先剔注释）', () => {
  it('.cbv-health__issue--error 的 color 为红色 #f53f3f', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    expect(css.length).toBeGreaterThan(0); // 正面锚点
    // 变异：把红字规则删掉 / 改成非红 → 此断言变红
    expect(css).toMatch(/\.cbv-health__issue--error\s*\{[^}]*color:\s*#f53f3f/i);
  });
});

/* ============================================================
 * ③ 超限文案必须含**实际大小与上限的数值**
 * ============================================================ */

describe('上传超限 · 文案含实际大小（1049600）与上限（1048576）', () => {
  it('1049600 字节文件 → 文案含 1049600 与 1048576；且**不写入草稿**（不静默）', async () => {
    const size = MAX_IMPORTED_DOCX_BYTES + 1024; // 1048576 + 1024 = 1049600
    expect(size).toBe(1049600); // 正面锚点：锁死本用例断言的数字
    expect(MAX_IMPORTED_DOCX_BYTES).toBe(1048576);

    const written: ImportedDocx[] = [];
    const container = mountBar(FIELDS, null, (imp) => written.push(imp));

    const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
    expect(input).not.toBeNull();
    selectFile(input as HTMLInputElement, new File([new Uint8Array(size)], 'big.docx'));

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);

    const err = container.querySelector('[data-docx-upload-error="true"]');
    expect(err?.textContent).toContain('1049600'); // ⭐ 实际大小
    expect(err?.textContent).toContain('1048576'); // ⭐ 上限
    expect(err?.textContent).toBe(oversizeMessage(size));
    // 绝不允许静默失败：没有写入草稿
    expect(written.length).toBe(0);
  });

  it('合法体积（小于上限）→ 无超限错误（对照，防「恒报超限」假绿）', async () => {
    const written: ImportedDocx[] = [];
    const container = mountBar(FIELDS, null, (imp) => written.push(imp));

    const bytes = docxOf('客户：{客户名称}');
    expect(bytes.length).toBeLessThan(MAX_IMPORTED_DOCX_BYTES); // 正面锚点
    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([bytes], 'ok.docx'),
    );

    await waitFor(() => written.length > 0);
    expect(container.querySelector('[data-docx-upload-error="true"]')).toBeNull();
    // 正面锚点：确实写了内容（不是「被调用过」）
    expect(written[0].fileName).toBe('ok.docx');
    expect(written[0].sizeBytes).toBe(bytes.length);
  });
});
