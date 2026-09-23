/**
 * docx 模板导入 5b：编辑器「模板来源」栏 + 上传 + ⭐ **模板体检** 的独立验证。
 *
 * 覆盖（团队三条铁律：禁止假绿）：
 *  A. **分段控件**：`blocks` / `imported` 两项；点击回调带正确取值（锁定具体值，非「被调用过」）。
 *  B. ⭐ **模板体检**（上传后立即、保存之前）：
 *     · 合法模板 → `data-health-matched` **具体数值**（正向信息：体检确实跑过了）；
 *     · 未知占位符 → `unmatched` **红字**（class）且**逐个列出模板中的原文**（断言确切文案）；
 *     · 源字段重名 → `duplicateFieldNames` 红字（含字段 id）；
 *     · 未闭合循环 → `unclosedLoops` 红字（`{#x}` 缺 `{/x}`）。
 *  C. **上传校验（绝不静默）**：超限文案**含实际大小与上限数值**；非 .docx 明确文案；**均不写入草稿**；
 *     合法 .docx → 写入草稿（断言 **encode 内容**，不是「被调用过」）。
 *  D. **端到端（ConfigDrawer + DraftStore）**：
 *     · 切 imported + 上传 → 保存载荷 `docSource === 'imported'` 且 `importedDocx` **内容深等于**上传字节；
 *     · ⭐ 切回 `blocks` → `importedDocx` **仍在**（内容未被清空）；
 *     · ⭐ 编辑其它设置（改主题）→ `importedDocx` **仍在**；
 *     · ⭐ 新增横栏**不改变画布内容宽度**（恒等于 `getContentBox().width`，且纸宽仍是固定 px）。
 *
 * 断言策略：否定式断言**必配正面锚点**；源码级断言**先剔注释再匹配**。
 * ⚠️ 现场生成 docx 用 **`pizzip`**（**不用** jszip：JSZip 3 已移除同步 `generate`，
 *    且 vitest 下 `generateAsync({type:'uint8array'})` 返回 Blob 而非字节 —— 本项目已踩过的坑）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { CardViewConfig, ImportedDocx } from '@/config/types';
import type { SaveResult } from '@/config/ConfigRepository';
import { createDefaultConfig } from '@/config/defaults';
import { getContentBox, getPaperSizePx } from '@/constants/paper';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import {
  decodeImportedDocx,
  encodeImportedDocx,
  MAX_IMPORTED_DOCX_BYTES,
  validateImportedDocx,
} from '@/doc/template/storage';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { ConfigDrawer } from '../ConfigDrawer';
import {
  DocxTemplateSourceBar,
  HEALTH_TITLE,
  nonDocxMessage,
  oversizeMessage,
  SOURCE_BLOCKS_LABEL,
  SOURCE_IMPORTED_LABEL,
} from './DocxTemplateSourceBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 真实动态 import（pizzip）+ FileReader 读 Blob：默认 5s 偏紧 → 模块级放宽到 20s。
// ⚠️ 模块级设置（而非 beforeEach 内）：用例超时在 beforeEach 之前就已定档，放 beforeEach 里不生效。
vi.setConfig({ testTimeout: 20000 });

/* ===================== 现场生成最小 docx（pizzip） ===================== */

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

/** 单段落（`xml:space="preserve"` 保证花括号/空格不被裁剪） */
function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

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

/** 用一句纯文本生成一份 docx 字节 */
function docxOf(text: string): Uint8Array {
  return buildDocx(para(text));
}

/* ===================== 夹具 ===================== */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
];

/** 重名夹具：两个字段同名 `客户名称`（模板引用它必然 ambiguous + duplicate） */
const DUP_FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '客户名称', type: FieldType.Text, isPrimary: false },
];

/* ===================== 挂载 / 交互工具 ===================== */

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

function click(el: Element | null): void {
  if (!el) throw new Error('click: element not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 给 file input 塞文件并触发 change（jsdom 的 `files` 只读 → 用 defineProperty 覆盖实例） */
function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 冲净微任务（让 async 上传 / 体检落 state 并重渲染） */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 轮询直到条件成立（体检走真实动态 import，需要真实计时）。
 *  ⚠️ 超时上限刻意 < 单个用例的 5s 默认 testTimeout：一旦「本该出现的元素」消失，
 *  这里会以 `waitFor 超时` **干净地失败**，而不是把用例拖到超时后污染后续用例。 */
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

const readSrc = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/** 去掉块注释与行注释（注释里的同形内容会骗过严格正则） */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/** 体检栏是否已产出结果 */
const healthReady = (container: HTMLElement): boolean =>
  container.querySelector('[data-health-result="true"]') !== null;

/* ===================== ① 分段控件 ===================== */

describe('DocxTemplateSourceBar · 模板来源分段控件', () => {
  it('blocks：展示来源栏、隐藏上传；点击「导入 docx / 可视化排版」回传具体取值', () => {
    const seen: Array<'blocks' | 'imported'> = [];
    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'blocks',
        importedDocx: null,
        fields: FIELDS,
        onSourceChange: (next) => seen.push(next),
        onImportedDocxChange: () => undefined,
      }),
    );

    // 正面锚点：来源栏存在，且两项文案正确
    expect(container.querySelector('[data-docx-source-bar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-docx-source="blocks"]')?.textContent).toContain(SOURCE_BLOCKS_LABEL);
    expect(container.querySelector('[data-docx-source="imported"]')?.textContent).toContain(SOURCE_IMPORTED_LABEL);
    // blocks 来源不渲染上传控件与体检面板
    expect(container.querySelector('[data-docx-upload]')).toBeNull();
    expect(container.querySelector('[data-docx-health]')).toBeNull();

    click(container.querySelector('[data-docx-source="imported"]'));
    click(container.querySelector('[data-docx-source="blocks"]'));
    expect(seen).toEqual(['imported', 'blocks']); // 具体顺序 + 取值

    unmount();
  });
});

/* ===================== ② ⭐ 模板体检 ===================== */

interface BarHarnessProps {
  fields: FieldMetaLite[];
  initialSource: 'blocks' | 'imported';
  initialImported: ImportedDocx | null;
  onImportedDocxChange?: (imported: ImportedDocx) => void;
  onSourceChange?: (source: 'blocks' | 'imported') => void;
}

/** 受控 Harness：`onImportedDocxChange` 回写本地 state，使上传后的体检走真实链路 */
function BarHarness({
  fields,
  initialSource,
  initialImported,
  onImportedDocxChange,
  onSourceChange,
}: BarHarnessProps): JSX.Element {
  const [source, setSource] = useState<'blocks' | 'imported'>(initialSource);
  const [imported, setImported] = useState<ImportedDocx | null>(initialImported);
  return createElement(DocxTemplateSourceBar, {
    source,
    importedDocx: imported,
    fields,
    onSourceChange: (next) => {
      onSourceChange?.(next);
      setSource(next);
    },
    onImportedDocxChange: (next) => {
      onImportedDocxChange?.(next);
      setImported(next);
    },
  });
}

function mountBar(props: BarHarnessProps, container0?: HTMLElement): { container: HTMLElement; unmount: () => void } {
  void container0;
  return mount(createElement(BarHarness, props));
}

describe('DocxTemplateSourceBar · ⭐ 模板体检（导入那一刻就把问题摆出来）', () => {
  it('合法模板 → matched 为具体数值（正面信息：体检跑过了），且无 unmatched 红字', async () => {
    const imported = encodeImportedDocx('ok.docx', docxOf('客户：{客户名称} 金额：{金额}'), 1);
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: imported,
    });

    await waitFor(() => healthReady(container));

    // 具体数值（2 个不同字段名都被命中）
    const matched = container.querySelector('[data-health-matched]');
    expect(matched?.getAttribute('data-health-matched')).toBe('2');
    expect(matched?.textContent).toContain('匹配字段 2 个');
    // 正面锚点 + 否定式：体检面板在，且不出现 unmatched 红字
    expect(container.querySelector('[data-docx-health="true"]')).not.toBeNull();
    expect(container.querySelector('[data-health-unmatched="true"]')).toBeNull();

    unmount();
  });

  it('未知占位符 → unmatched 红字且逐个列出模板原文（断言确切文案）', async () => {
    const imported = encodeImportedDocx(
      'bad.docx',
      docxOf('客户：{客户名称} 备注：{不存在的字段}'),
      1,
    );
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: imported,
    });

    await waitFor(() => container.querySelector('[data-health-unmatched="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-unmatched="true"]');
    // ⭐ 红字（class 锚定；变异：去掉红字 class → 此断言变红）
    expect(block?.className).toContain('cbv-health__issue--error');
    // ⭐ 逐个列出模板中的**原文**
    expect(block?.textContent).toContain('{不存在的字段}');
    const item = container.querySelector('[data-health-unmatched-item="不存在的字段"]');
    expect(item?.textContent).toBe('{不存在的字段}'); // 精确原文（含花括号）
    // 对照：命中的那个仍在 matched 计数里（不是「全红」）
    expect(container.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');

    unmount();
  });

  it('源字段重名 → duplicateFieldNames 红字（含两个字段 id）', async () => {
    const imported = encodeImportedDocx('dup.docx', docxOf('客户：{客户名称}'), 1);
    const { container, unmount } = mountBar({
      fields: DUP_FIELDS,
      initialSource: 'imported',
      initialImported: imported,
    });

    await waitFor(() => container.querySelector('[data-health-duplicate="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-duplicate="true"]');
    expect(block?.className).toContain('cbv-health__issue--error');
    expect(block?.textContent).toContain('客户名称');
    expect(block?.textContent).toContain('f1');
    expect(block?.textContent).toContain('f2');
    // 重名同时导致 ambiguous（不能静默取首个）
    expect(container.querySelector('[data-health-ambiguous="true"]')).not.toBeNull();

    unmount();
  });

  it('循环未闭合 → unclosedLoops 红字（{#明细} 缺 {/明细}）', async () => {
    const imported = encodeImportedDocx('loop.docx', docxOf('{#明细}{客户名称}'), 1);
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: imported,
    });

    await waitFor(() => container.querySelector('[data-health-unclosed-loop="true"]') !== null);

    const block = container.querySelector<HTMLElement>('[data-health-unclosed-loop="true"]');
    expect(block?.className).toContain('cbv-health__issue--error');
    expect(block?.textContent).toContain('{#明细}');
    expect(block?.textContent).toContain('{/明细}');

    unmount();
  });

  it('未上传模板 → 体检面板给出引导文案（不静默留白）', () => {
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: null,
    });
    expect(container.querySelector('[data-docx-health="true"]')).not.toBeNull();
    expect(container.querySelector('[data-health-result="true"]')).toBeNull(); // 没上传就没结果（对照）
    expect(container.querySelector('[data-docx-health-idle="true"]')?.textContent).toContain('.docx');
    unmount();
  });
});

/* ===================== ③ 上传校验（绝不静默） ===================== */

describe('DocxTemplateSourceBar · 上传体积 / 类型校验（绝不静默失败）', () => {
  it('超限文件 → 明确文案且含实际大小与上限数值，且不写入草稿', async () => {
    const size = MAX_IMPORTED_DOCX_BYTES + 1024; // 33792
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: null,
      onImportedDocxChange: (imp) => written.push(imp),
    });

    const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('accept')).toBe('.docx');
    selectFile(input as HTMLInputElement, new File([new Uint8Array(size)], 'big.docx'));

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);

    const err = container.querySelector('[data-docx-upload-error="true"]');
    // ⭐ 文案 = oversizeMessage(size)（含实际大小与上限的**数值**）
    expect(err?.textContent).toBe(oversizeMessage(size));
    expect(err?.textContent).toContain(String(size));
    expect(err?.textContent).toContain(String(MAX_IMPORTED_DOCX_BYTES));
    // 绝不允许静默失败：没有写入草稿
    expect(written.length).toBe(0);

    unmount();
  });

  it('非 .docx 文件 → 明确文案（含文件名），且不写入草稿', async () => {
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: null,
      onImportedDocxChange: (imp) => written.push(imp),
    });

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([new Uint8Array(8)], 'note.txt'),
    );

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);
    expect(container.querySelector('[data-docx-upload-error="true"]')?.textContent).toBe(nonDocxMessage('note.txt'));
    expect(written.length).toBe(0);

    unmount();
  });

  it('合法 .docx → 写入草稿（encode 内容），且随后体检 matched>0', async () => {
    const bytes = docxOf('客户：{客户名称}');
    const written: ImportedDocx[] = [];
    const { container, unmount } = mountBar({
      fields: FIELDS,
      initialSource: 'imported',
      initialImported: null,
      onImportedDocxChange: (imp) => written.push(imp),
    });

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([bytes], 'tpl.docx'),
    );

    await waitFor(() => written.length > 0);
    const encoded = written[0];
    // ⭐ 断言内容（不是「被调用过」）
    expect(encoded.fileName).toBe('tpl.docx');
    expect(encoded.sizeBytes).toBe(bytes.length);
    expect(Array.from(decodeImportedDocx(encoded))).toEqual(Array.from(bytes));
    expect(validateImportedDocx(encoded).ok).toBe(true);

    // 上传后立即体检（Harness 回写 → 走真实链路）
    await waitFor(() => healthReady(container));
    expect(container.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');
    expect(container.querySelector('[data-docx-upload-error="true"]')).toBeNull();

    unmount();
  });
});

/* ===================== ④ 源码级锚点（先剔注释） ===================== */

describe('DocxTemplateSourceBar · 源码级锚点（先剔注释再匹配）', () => {
  const SRC = 'src/components/editor/doc/DocxTemplateSourceBar.tsx';

  it('体积校验 + 体检接线确实写在源码里', () => {
    const raw = readSrc(SRC);
    expect(raw.length).toBeGreaterThan(0); // 正面锚点：确实读到源码
    const code = stripComments(raw);

    // 体积上限校验（变异：删掉这段 → 「超限」用例变红）
    expect(code).toMatch(/bytes\.length\s*>\s*MAX_IMPORTED_DOCX_BYTES/);
    expect(code).toMatch(/oversizeMessage\(/);
    // 体检接线
    expect(code).toMatch(/checkTemplate\(/);
    expect(code).toMatch(/extractDocxText\(/);
    // 只接受 .docx
    expect(code).toMatch(/DOCX_NAME_PATTERN/);
  });

  it('红字样式确实存在（.cbv-health__issue--error 为红色）', () => {
    const css = readSrc('src/styles/globals.css');
    // 变异：把红字规则删掉 / 改成非红 → 此断言变红
    expect(css).toMatch(/\.cbv-health__issue--error\s*\{[^}]*color:\s*#f53f3f/i);
  });
});

/* ===================== ⑤ 端到端：ConfigDrawer + DraftStore ===================== */

const DRAWER_FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
  { id: 'f2', name: '金额', type: FieldType.Number, isPrimary: false },
  { id: 'f3', name: '状态', type: FieldType.SingleSelect, isPrimary: false },
];

function openEditor(): CardViewConfig {
  const config = createDefaultConfig({ viewId: 'v', tableId: 't', fields: DRAWER_FIELDS });
  useViewStore.setState({
    config,
    fields: DRAWER_FIELDS,
    canEditConfig: true,
    unsupportedNewer: false,
    persistConfig: async (): Promise<SaveResult> => ({ ok: true }),
  });
  useDraftStore.getState().close();
  useDraftStore.getState().open(config, 'doc');
  useUiStore.setState({ editorOpen: true, editMode: 'doc', toast: null });
  return config;
}

/** 切到「导入 docx」并上传一份合法模板；返回上传的原始字节 */
async function uploadViaUi(container: HTMLElement, fileName: string, bodyText: string): Promise<Uint8Array> {
  click(container.querySelector('[data-docx-source="imported"]'));
  expect(useDraftStore.getState().docSourceDraft).toBe('imported'); // 正面锚点：来源已切换
  const bytes = docxOf(bodyText);
  const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
  selectFile(input as HTMLInputElement, new File([bytes], fileName));
  await waitFor(() => useDraftStore.getState().importedDocxDraft !== undefined);
  return bytes;
}

describe('ConfigDrawer · 5b 端到端（来源切换 / 上传 / 保存 / 不清空）', () => {
  beforeEach(() => {
    openEditor();
  });

  it('切 imported + 上传 → 保存载荷 docSource=imported 且 importedDocx 与上传内容深等', async () => {
    const spy = vi.fn(async (_config: CardViewConfig): Promise<SaveResult> => {
      void _config;
      return { ok: true };
    });
    useViewStore.setState({ persistConfig: spy });

    const { container, unmount } = mount(createElement(ConfigDrawer));
    const bytes = await uploadViaUi(container, '模板.docx', '客户：{客户名称}');

    // 体检在保存之前已展示（matched>0）
    await waitFor(() => container.querySelector('[data-health-result="true"]') !== null);
    expect(container.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');

    click([...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存') ?? null);
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]?.[0] as CardViewConfig;
    expect(payload.detail.docSource).toBe('imported');
    const stored = payload.detail.importedDocx as ImportedDocx;
    expect(stored).toBeDefined();
    // ⭐ 断言内容（不是「被调用过」）
    expect(stored.fileName).toBe('模板.docx');
    expect(stored.sizeBytes).toBe(bytes.length);
    expect(validateImportedDocx(stored).ok).toBe(true);
    expect(Array.from(decodeImportedDocx(stored))).toEqual(Array.from(bytes));

    unmount();
  });

  it('⭐ 切回「可视化排版」→ importedDocx 仍在（内容未被清空）', async () => {
    const config = useViewStore.getState().config as CardViewConfig;
    const { container, unmount } = mount(createElement(ConfigDrawer));
    const bytes = await uploadViaUi(container, '模板.docx', '客户：{客户名称}');

    click(container.querySelector('[data-docx-source="blocks"]'));
    // 正面锚点：来源确实切回 blocks
    expect(useDraftStore.getState().docSourceDraft).toBe('blocks');
    expect(container.querySelector('[data-docx-source="blocks"]')?.getAttribute('aria-selected')).toBe('true');

    // ⭐ 模板仍在（断言具体内容未被清空）
    const draft = useDraftStore.getState();
    expect(draft.importedDocxDraft).toBeDefined();
    expect(draft.importedDocxDraft?.fileName).toBe('模板.docx');
    expect(Array.from(decodeImportedDocx(draft.importedDocxDraft as ImportedDocx))).toEqual(Array.from(bytes));

    // 保存载荷同样保留（切回来源 ≠ 清空模板）
    const built = useDraftStore.getState().buildConfig(config);
    expect(built.detail.docSource).toBe('blocks');
    expect(built.detail.importedDocx?.fileName).toBe('模板.docx');

    unmount();
  });

  it('⭐ 编辑其它设置（改主题）→ importedDocx 仍在', async () => {
    const config = useViewStore.getState().config as CardViewConfig;
    const { container, unmount } = mount(createElement(ConfigDrawer));
    const bytes = await uploadViaUi(container, '模板.docx', '客户：{客户名称}');

    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    // 正面锚点：主题确实改了
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');

    const draft = useDraftStore.getState();
    expect(draft.importedDocxDraft?.fileName).toBe('模板.docx');
    expect(Array.from(decodeImportedDocx(draft.importedDocxDraft as ImportedDocx))).toEqual(Array.from(bytes));

    const built = useDraftStore.getState().buildConfig(config);
    expect(built.detail.doc.theme.primaryColor).toBe('#00B42A');
    expect(built.detail.importedDocx?.fileName).toBe('模板.docx');

    unmount();
  });

  it('⭐ 新增横栏不改变画布内容宽度（两来源下恒等 getContentBox().width）', async () => {
    const config = useViewStore.getState().config as CardViewConfig;
    const setup = config.detail.doc.pageSetup;
    const expected = getContentBox(setup.paper, setup.orientation, setup.margin).width;
    const paperWidth = getPaperSizePx(setup.paper, setup.orientation).w;

    const { container, unmount } = mount(createElement(ConfigDrawer));

    // 来源栏在 doc 编辑区**最上方**（不滚动即可见），且在四栏之上
    const shell = container.querySelector<HTMLElement>('[data-doc-shell="true"]');
    expect(shell).not.toBeNull();
    expect(shell?.children[0]?.getAttribute('data-docx-source-bar')).toBe('true');
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();

    const readWidth = (): string | null =>
      container.querySelector('[data-content-width]')?.getAttribute('data-content-width') ?? null;
    const readPaper = (): string => container.querySelector<HTMLElement>('[data-content-width]')?.style.width ?? '';

    // blocks 来源
    expect(readWidth()).toBe(String(expected));
    expect(readPaper()).toBe(`${paperWidth}px`);

    // 切到 imported + 上传（体检面板展开）→ 内容宽度 / 纸宽**都不变**
    await uploadViaUi(container, '模板.docx', '客户：{客户名称}');
    await waitFor(() => container.querySelector('[data-health-result="true"]') !== null);

    expect(readWidth()).toBe(String(expected));
    expect(readPaper()).toBe(`${paperWidth}px`);
    // 不得用百分比 / max-width 适配（那会回流纸页 → 改变换行）
    expect(container.querySelector<HTMLElement>('[data-content-width]')?.getAttribute('style') ?? '').not.toContain('%');

    unmount();
  });

  it('导入来源下仍渲染原三栏 + 体检标题（不回归既有 doc 编辑器）', async () => {
    const { container, unmount } = mount(createElement(ConfigDrawer));
    await uploadViaUi(container, '模板.docx', '客户：{客户名称}');

    // 原三栏结构仍在（正面锚点）
    expect(container.querySelector('[data-doc-editor="true"]')).not.toBeNull();
    expect(container.querySelector('[data-doc-editor-center="true"]')).not.toBeNull();
    expect(container.querySelector('.cbv-blocklib')?.children.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-docprops-section]').length).toBe(3);
    expect(container.querySelector('[data-docx-health="true"]')?.textContent).toContain(HEALTH_TITLE);

    unmount();
  });
});

/* 未覆盖项（诚实申报）：真实浏览器里的文件选择对话框、以及横栏在极窄视口下的换行表现
 * 未做像素级断言（jsdom 无布局引擎）；内容宽度不变式只断言**自报数值**与纸宽 style。 */
