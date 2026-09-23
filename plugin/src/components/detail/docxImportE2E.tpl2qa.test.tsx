/**
 * ⭐ QA2（software-qa-engineer-tpl2）**独立**端到端往返验证：「docx 模板导入」整条链路闭环。
 *
 * ⚠️⚠️ 本文件覆盖的是**内联降级路径**（无 bridge store：小模板把字节写进主配置）。
 * 为什么：本文件不注册 bridge store → 上传走的是 `encodeImportedDocx` 内联降级，**不是生产路径**。
 * 生产路径（1MB / 分块专用 key）的闭环在 `docxImportChunkedE2E.tpl2qa.test.tsx` 独立验证。
 * 两者都必要：降级路径必须仍可用（老配置 / 极端环境），但它**代表不了**生产分块路径。
 *
 * 为什么需要本文件（本项目的既有教训）：
 *   各层单测都可能全绿，但「把层接起来」的功能仍可能是坏的。本项目踩过同类坑——
 *   搜索框的过滤只接进了计数、没接进卡片墙。故本文件**不停在**「保存后载荷正确」，
 *   而是走完整闭环：
 *
 *   在编辑器上传 docx（含占位符 `{客户名称}`）
 *     → 体检通过（matched=1）
 *       → 点「保存」（走**真实** `useViewStore.persistConfig` → **真实** `LocalStorageConfigRepository.save`
 *          → 真实序列化 / checksum → 内存存储）
 *         → **新仓储**读同一份存储（`new LocalStorageConfigRepository(storage)`，模拟「重开」）
 *           → 断言 `docSource === 'imported'` 且 `importedDocx` 内容深等于上传字节
 *             → 详情渲染出的正文 **含被填入的字段值**（不是占位符原文）
 *
 * 最后一环是最容易断的一环：改动能进载荷，但重载后读不回来（或读回来是旧值）——
 * **每一层的测试都可以是全绿的**。本用例把它钉死。
 *
 * 断言策略（团队三条铁律）：
 *  ① 源码级断言锚定结构性特征，且**先剔注释再匹配**；
 *  ② **否定式断言必配正面锚点**；
 *  ③ ⭐ **两条路径都可能渲染文本 → fixture 必须让它们分离**：
 *     区块路径渲染记录字段值 `张伟`；docx 路径渲染**模板字面量** `模板R1` + 填充值 `DOCX-E2E-值`。
 *     二者**互不包含**，故「到底渲染了哪一条」可被判別，否定式断言才有意义。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { CardViewConfig, ImportedDocx } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { decodeImportedDocx, encodeImportedDocx, setTemplateBridgeStore } from '@/doc/template/storage';
import { LocalStorageConfigRepository, type StorageLike } from '@/config/LocalStorageConfigRepository';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { useDraftStore } from '@/state/DraftStore';
import type { UseImportedDocDeps } from '@/hooks/useImportedDoc';
import { ConfigDrawer } from '@/components/editor/ConfigDrawer';
import { DetailDrawer } from '@/components/detail/DetailDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 真实动态 import（pizzip / docxtemplater / docx-preview）+ FileReader：默认 5s 偏紧。
vi.setConfig({ testTimeout: 25000 });

/* ============================ 现场生成最小 docx（pizzip，**不用** jszip） ============================ */

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

function docxOf(text: string): Uint8Array {
  return buildDocx(para(text));
}

/* ============================ 内存存储 + 仓储（模拟「同文档下所有人共用」的 bridge key） ============================ */

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

const APP_ID = 'qa2-app';
const VIEW_ID = 'v-e2e';

/* ============================ 夹具：两条路径可见内容必须不同 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f1: FIELDS[0] };
/** 区块路径会渲染 f1 → `张伟`（与 docx 路径的 `模板R1` / `DOCX-E2E-值` 互不包含） */
const RECORDS = [{ recordId: 'rA', fields: { f1: '张伟' } }] as never[];

/** docx 模板里的字面量（只有上传的那份 docx 才有 → 用以判別「渲染了哪一条」） */
const DOCX_LITERAL = '模板R1';
/** 注入的单元格读取器返回值（区别于区块路径的 `张伟`） */
const CELL_VALUE = 'DOCX-E2E-值';
/** 唯一一条占位符（体检 matched 计数的依据） */
const DOCX_BODY = `${DOCX_LITERAL} 客户：{客户名称}`;

function baseConfig(): CardViewConfig {
  return createDefaultConfig({ viewId: VIEW_ID, tableId: 't', fields: FIELDS });
}

/* ============================ 挂载 / 交互工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  // 本文件走**内联降级**：显式确保注册表为 null（防跨用例污染）
  setTemplateBridgeStore(null);
  useUiStore.setState({ drawer: initialDrawerState(null), editorOpen: false, toast: null });
  useDraftStore.getState().close();
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

function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/* ============================ 编辑器驱动：真实 UI 上传 + 真实保存 ============================ */

/** 打开编辑器到「文档排版」模式（草稿以已保存配置为基准） */
function openEditorDocMode(config: CardViewConfig, repository: LocalStorageConfigRepository): void {
  const configWithAppId = config;
  useViewStore.setState({
    config: configWithAppId,
    fields: FIELDS,
    fieldsById: FIELDS_BY_ID,
    records: RECORDS,
    canEditConfig: true,
    unsupportedNewer: false,
    env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID, appId: APP_ID } as never,
    repository,
  });
  useDraftStore.getState().close();
  useDraftStore.getState().open(configWithAppId, 'doc');
  useUiStore.setState({ editorOpen: true, editMode: 'doc', toast: null });
}

/** 在真实编辑器 UI 上：切到「导入 docx」→ 上传 → 等体检结果 */
async function uploadViaUi(container: HTMLElement, fileName: string, bodyText: string): Promise<Uint8Array> {
  click(container.querySelector('[data-docx-source="imported"]'));
  expect(useDraftStore.getState().docSourceDraft).toBe('imported'); // 正面锚点：来源已切换
  const bytes = docxOf(bodyText);
  const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
  selectFile(input as HTMLInputElement, new File([bytes], fileName));
  await waitFor(() => useDraftStore.getState().importedDocxDraft !== undefined);
  return bytes;
}

function findSaveButton(container: HTMLElement): Element | null {
  return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存') ?? null;
}

/* ============================================================
 * ⭐ ① 端到端闭环：上传 → 体检 → 保存 → 新仓储重载 → 详情渲染填充值
 * ============================================================ */

describe('⭐ E2E 闭环 · 上传 docx → 保存 → 重开（新仓储读同一存储）→ 详情渲染填充值', () => {
  it('闭包逐环：体检通过 → 载荷 docSource/importedDocx 正确 → 重载后正文含填入值（非占位符原文）', async () => {
    const storage = new MemoryStorage();
    const repo1 = new LocalStorageConfigRepository(storage, APP_ID);
    const config = baseConfig();

    // 原始（区块）配置里**没有** docx 字面量 —— 用以证明后面看到的字面量只可能来自上传的 docx
    expect(JSON.stringify(config.detail.doc)).not.toContain(DOCX_LITERAL);

    /* ---- 环 1：编辑器真实 UI 上传 ---- */
    openEditorDocMode(config, repo1);
    const { container: editor, unmount: unmountEditor } = mount(createElement(ConfigDrawer));
    const bytes = await uploadViaUi(editor, '模板.docx', DOCX_BODY);

    // 环 2：体检通过（在**保存之前**就已展示）
    await waitFor(() => editor.querySelector('[data-health-result="true"]') !== null);
    expect(editor.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');

    // 草稿内容与上传字节一致（配正面锚点）
    const draftImported = useDraftStore.getState().importedDocxDraft as ImportedDocx;
    expect(draftImported.fileName).toBe('模板.docx');
    expect(Array.from(decodeImportedDocx(draftImported))).toEqual(Array.from(bytes));

    /* ---- 环 3：真实保存（真实 persistConfig → 真实 repository.save → 存储） ---- */
    click(findSaveButton(editor));
    await waitFor(() => useUiStore.getState().editorOpen === false);
    await flush();
    // 载荷确实落进存储（存储里有序列化后的配置）
    expect(storage.keys().length).toBeGreaterThan(0);
    unmountEditor();

    /* ---- 环 4：**新仓储**读同一存储（模拟「重开」） ---- */
    const repo2 = new LocalStorageConfigRepository(storage, APP_ID);
    const loaded = await repo2.load(VIEW_ID);
    expect(loaded.config).not.toBeNull();
    const savedConfig = loaded.config as CardViewConfig;

    expect(savedConfig.detail.docSource).toBe('imported');
    const reloadedDocx = savedConfig.detail.importedDocx as ImportedDocx;
    expect(reloadedDocx).toBeDefined();
    // ⭐ 断言**具体内容**（不是 toBeDefined）：重载后模板本体与上传字节逐字节一致
    expect(reloadedDocx.fileName).toBe('模板.docx');
    expect(reloadedDocx.sizeBytes).toBe(bytes.length);
    expect(Array.from(decodeImportedDocx(reloadedDocx))).toEqual(Array.from(bytes));
    const expectedEncoded = encodeImportedDocx('模板.docx', bytes, 1);
    expect(reloadedDocx.bytesBase64).toBe(expectedEncoded.bytesBase64);

    /* ---- 环 5：用「重载出来的配置」喂详情，断言正文含被填入的字段值 ---- */
    useViewStore.setState({
      config: savedConfig,
      fields: FIELDS,
      fieldsById: FIELDS_BY_ID,
      records: RECORDS,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID } as never,
    });
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA' } });

    const importedDeps: UseImportedDocDeps = { readCellString: async () => CELL_VALUE };
    const { container: drawer } = mount(
      createElement(DetailDrawer, {
        pagedDeps: { awaitFonts: () => Promise.resolve(true) },
        importedDeps,
      }),
    );

    await waitFor(() => (drawer.textContent ?? '').includes(CELL_VALUE));

    // 正面锚点：docx 路径确实挂载
    expect(drawer.querySelector('[data-docx-view="true"]')).not.toBeNull();
    expect(drawer.querySelectorAll('section.docx').length).toBe(1);
    const text = drawer.textContent ?? '';
    expect(text).toContain(DOCX_LITERAL); // 模板字面量（只来自上传的 docx）
    expect(text).toContain(CELL_VALUE); // ⭐ 被填入的字段值
    expect(text).not.toContain('{客户名称}'); // 占位符已被替换
    // fixture 分离：区块路径的字段值不得出现
    expect(text).not.toContain('张伟');
    // 否定式（配正面锚点：上面已证明 docx 路径挂载）：不套我们的纸张几何
    expect(drawer.querySelectorAll('.cbv-paper').length).toBe(0);
    expect(drawer.querySelector('[data-testid="doc-preview"]')).toBeNull();
  }, 25000);
});

/* ============================================================
 * ② 区块路径必须完全不受影响
 * ============================================================ */

describe('区块路径未受影响（docSource 缺省 / 显式 blocks）', () => {
  it('docSource **缺省** → 1 张 .cbv-paper + 区块内容；docx 路径产物一律不存在', async () => {
    const config = baseConfig(); // detail.docSource === undefined（旧配置）
    expect(config.detail.docSource).toBeUndefined(); // 正面锚点：确实是「缺省」
    useViewStore.setState({
      config,
      fields: FIELDS,
      fieldsById: FIELDS_BY_ID,
      records: RECORDS,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID } as never,
    });
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA' } });

    const readCellString = vi.fn(async () => 'DOCX-不该出现');
    const { container } = mount(
      createElement(DetailDrawer, {
        pagedDeps: { awaitFonts: () => Promise.resolve(true) },
        importedDeps: { readCellString },
      }),
    );
    await flush(12);

    // 正面锚点：区块路径确实渲染了（同时防本项目曾出现的「默认路径产出 0 张 .cbv-paper」假红）
    expect(container.querySelector('[data-testid="doc-preview"]')).not.toBeNull();
    expect(container.querySelectorAll('.cbv-paper').length).toBe(1);
    expect(container.querySelectorAll('.cbv-doc-block').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('张伟'); // 区块渲染记录字段值

    // 否定式：docx 路径的产物**不存在**
    expect(container.querySelector('[data-docx-view="true"]')).toBeNull();
    expect(container.querySelector('[data-docx-host="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="docx-template-preview"]')).toBeNull();
    expect(container.querySelector('[data-docx-state="error"]')).toBeNull();
    // 否定式：docx 数据管线根本没启动
    expect(readCellString).not.toHaveBeenCalled();
  });

  it('显式 docSource=blocks（且已上传模板）→ 仍走区块路径、docx 产物不存在', async () => {
    const config = baseConfig();
    const imported = encodeImportedDocx('t.docx', docxOf(DOCX_BODY), 1);
    const patched: CardViewConfig = {
      ...config,
      detail: { ...config.detail, docSource: 'blocks', importedDocx: imported },
    };
    expect(patched.detail.docSource).toBe('blocks'); // 正面锚点

    useViewStore.setState({
      config: patched,
      fields: FIELDS,
      fieldsById: FIELDS_BY_ID,
      records: RECORDS,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID } as never,
    });
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA' } });

    const readCellString = vi.fn(async () => 'DOCX-不该出现');
    const { container } = mount(
      createElement(DetailDrawer, {
        pagedDeps: { awaitFonts: () => Promise.resolve(true) },
        importedDeps: { readCellString },
      }),
    );
    await flush(12);

    expect(container.querySelectorAll('.cbv-paper').length).toBe(1); // 正面锚点
    expect(container.textContent).toContain('张伟');
    expect(container.querySelector('[data-docx-host="true"]')).toBeNull();
    expect(container.querySelector('[data-docx-view="true"]')).toBeNull();
    expect(readReceivedDocxLiteral(container)).toBe(false);
    expect(readCellString).not.toHaveBeenCalled();

    function readReceivedDocxLiteral(root: HTMLElement): boolean {
      return (root.textContent ?? '').includes(DOCX_LITERAL);
    }
  });
});

/* ============================================================
 * ③ 切来切去不得丢数据（含「编辑其它设置」）
 * ============================================================ */

describe('⭐ 切换来源 / 编辑其它设置 → importedDocx 仍在（断言具体内容）', () => {
  it('切到「导入 docx」再切回「可视化排版」再切回 → importedDocx 始终在；保存载荷保留', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, APP_ID);
    const config = baseConfig();
    openEditorDocMode(config, repo);
    const { container } = mount(createElement(ConfigDrawer));

    const bytes = await uploadViaUi(container, '模板.docx', DOCX_BODY);
    const expectedB64 = encodeImportedDocx('模板.docx', bytes, 1).bytesBase64;

    // 切回「可视化排版」
    click(container.querySelector('[data-docx-source="blocks"]'));
    expect(useDraftStore.getState().docSourceDraft).toBe('blocks'); // 正面锚点：来源确实切回
    // ⭐ 模板仍在（断言内容，不是 toBeDefined）
    expect(useDraftStore.getState().importedDocxDraft?.bytesBase64).toBe(expectedB64);

    // 再切回「导入 docx」→ 仍在
    click(container.querySelector('[data-docx-source="imported"]'));
    expect(useDraftStore.getState().docSourceDraft).toBe('imported');
    expect(useDraftStore.getState().importedDocxDraft?.bytesBase64).toBe(expectedB64);

    // 保存载荷同样保留（切回来源 ≠ 清空模板）
    click(findSaveButton(container));
    await waitFor(() => useUiStore.getState().editorOpen === false);
    const loaded = await new LocalStorageConfigRepository(storage, APP_ID).load(VIEW_ID);
    expect(loaded.config?.detail.docSource).toBe('imported');
    expect(loaded.config?.detail.importedDocx?.bytesBase64).toBe(expectedB64);
    expect(loaded.config?.detail.importedDocx?.fileName).toBe('模板.docx');
  }, 25000);

  it('⭐ 编辑其它设置（改文档主题色）→ importedDocx 仍在', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, APP_ID);
    const config = baseConfig();
    openEditorDocMode(config, repo);
    const { container } = mount(createElement(ConfigDrawer));

    const bytes = await uploadViaUi(container, '模板.docx', DOCX_BODY);
    const expectedB64 = encodeImportedDocx('模板.docx', bytes, 1).bytesBase64;

    // 打开「主题」属性分组 → 改主色
    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    // 正面锚点：其它设置确实改了
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A');
    // ⭐ 模板仍在
    expect(useDraftStore.getState().importedDocxDraft?.bytesBase64).toBe(expectedB64);
    expect(useDraftStore.getState().importedDocxDraft?.fileName).toBe('模板.docx');

    // 保存载荷同时含「改过的主题」与「仍在的模板」
    click(findSaveButton(container));
    await waitFor(() => useUiStore.getState().editorOpen === false);
    const loaded = await new LocalStorageConfigRepository(storage, APP_ID).load(VIEW_ID);
    expect(loaded.config?.detail.doc.theme.primaryColor).toBe('#00B42A');
    expect(loaded.config?.detail.importedDocx?.bytesBase64).toBe(expectedB64);
  }, 25000);
});

/* ============================================================
 * ④ 源码级：闭环接线确实写在源码里（先剔注释再匹配）
 * ============================================================ */

describe('源码级锚点（先剔注释再匹配）', () => {
  const SRC_DETAIL = 'src/components/detail/DetailDrawer.tsx';
  const SRC_REPO = 'src/config/migrations.ts';

  it('DetailDrawer 按 docSource 分支；imported 分支不套 .cbv-paper', () => {
    const raw = readFileSync(path.resolve(process.cwd(), SRC_DETAIL), 'utf8');
    expect(raw.length).toBeGreaterThan(0); // 正面锚点
    const code = stripComments(raw);

    expect(code).toMatch(/resolveDocSource\s*\(/);
    expect(code).toMatch(/docSource\s*===\s*'imported'/);
    expect(code).toMatch(/<DocxTemplatePreview\b/);
    expect(code).toMatch(/<DocPreview\s+pagedDoc=\{paged\.pagedDoc\}/);
    // ⭐ 刻意的分歧：本文件**不得**出现 .cbv-paper
    expect(code).not.toMatch(/cbv-paper/);
  });

  it('⭐ 重载路径（migrate/assertCardViewConfig）显式透传 docSource 与 importedDocx（否则每次读取静默抹掉）', () => {
    const code = stripComments(readFileSync(path.resolve(process.cwd(), SRC_REPO), 'utf8'));
    // 正面锚点：确实读了源码且是净化器所在文件
    expect(code).toMatch(/function\s+sanitizeImportedDocx\s*\(/);
    expect(code).toMatch(/export\s+function\s+assertCardViewConfig\s*\(/);
    // 透传点（漏掉 → 重载后 importedDocx 消失，功能静默失效）
    expect(code).toMatch(/detailSource\.docSource\s*===\s*'imported'/);
    expect(code).toMatch(/sanitizeImportedDocx\s*\(\s*detailSource\.importedDocx\s*\)/);
    expect(code).toMatch(/\.\.\.\(\s*docSource\s*!==\s*undefined\s*\?\s*\{\s*docSource\s*\}\s*:\s*\{\s*\}\s*\)/);
    expect(code).toMatch(/\.\.\.\(\s*importedDocx\s*!==\s*undefined\s*\?\s*\{\s*importedDocx\s*\}\s*:\s*\{\s*\}\s*\)/);
  });
});
