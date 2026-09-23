/**
 * ⭐ QA2（software-qa-engineer-tpl2）**独立**端到端验证：**分块（生产）路径**闭环。
 *
 * ── 为什么必须有这个文件（本轮最大盲区）──
 * 原有 `docxImportE2E.tpl2qa.test.tsx` 是绿的，但**测试环境没有注册 bridge store** →
 * 它走的是**内联降级路径**（≤32KB 把字节写进主配置），**不是生产路径**。
 * 新设计下：**有 store → 分块专用 key（1MB 级生产路径）**；无 store → 小模板内联降级 / 大模板显式报错。
 * 「绿了」只能证明降级路径没问题，**证明不了生产路径没问题**——正是本项目要防的「分层各自绿、接起来坏」。
 *
 * 本文件**注册一个 template bridge store**，让整条链路走**分块**，并复算用户可见结果不变量：
 *   上传 → 体检 → 保存（真实 persistConfig → 真实仓储）→ 换新仓储实例读回（模拟重开）→ 详情渲染。
 * **机制变了（分块），用户可见结果不能变**（正文含模板字面量 + 填入的字段值；不含占位符原文 / 区块值）。
 *
 * 断言策略（团队三条铁律）：
 *  ① 否定式断言必配正面锚点；② 两条路径可能同值时 fixture 必须分离；③ 具体值断言，不用 `toBeDefined`。
 * fixture 分离：区块路径渲染记录字段值 `张伟`；docx 路径渲染**模板字面量** `模板R2` + 填充值 `DOCX-CHUNK-值`。
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { CardViewConfig, ImportedDocx } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { CONFIG_KEY_PREFIX } from '@/constants';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import type { BridgeStore } from '@/sdk/base';
import {
  PROBE_KEY_PREFIX,
  TEMPLATE_CHUNK_BASE64_CHARS,
  TEMPLATE_KEY_PREFIX,
  encodeImportedDocx,
  readImportedDocxBytes,
  setTemplateBridgeStore,
  templateKeyPrefixFor,
} from '@/doc/template/storage';
import { LocalStorageConfigRepository, type StorageLike } from '@/config/LocalStorageConfigRepository';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { useDraftStore } from '@/state/DraftStore';
import type { UseImportedDocDeps } from '@/hooks/useImportedDoc';
import { ConfigDrawer } from '@/components/editor/ConfigDrawer';
import { DocxTemplateSourceBar } from '@/components/editor/doc/DocxTemplateSourceBar';
import { DetailDrawer } from '@/components/detail/DetailDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// 真实动态 import（pizzip / docxtemplater / docx-preview）+ FileReader + 1MB 级编码：放宽超时。
vi.setConfig({ testTimeout: 30000 });

/* ============================ 现场生成最小 docx（pizzip，不用 jszip） ============================ */

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

function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInner}</w:body></w:document>`
  );
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function docxOf(text: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', documentXml(para(text)));
  return zip.generate({ type: 'uint8array' });
}

/** 确定性、**不易压缩**的填充串（保证 docx 真的跨多个分块 → 证明走的是分块而非内联） */
function padText(n: number): string {
  let out = '';
  let x = 987654321;
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out += String.fromCharCode(33 + (x % 94));
  }
  return out;
}

function paddedDocx(text: string, padChars: number): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', documentXml(para(text)));
  zip.file('word/pad.bin', padText(padChars));
  return zip.generate({ type: 'uint8array' });
}

/* ============================ 假 bridge 存储（记录 key 访问 / 删除） ============================ */

class FakeBridgeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly deleted: string[] = [];

  async getData(key: string): Promise<unknown> {
    this.reads.push(key);
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setData(key: string, value: unknown): Promise<boolean> {
    this.writes.push(key);
    if (value === null) {
      this.map.delete(key);
      this.deleted.push(key);
    } else {
      this.map.set(key, value);
    }
    return true;
  }

  onDataChange(): () => void {
    return () => undefined;
  }

  tplWrites(): number {
    return this.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length;
  }
}

/** 内存存储（充当配置仓储的介质；与模板块的 bridge store 互相独立） */
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

const APP_ID = 'qa2-chunk-app';
const VIEW_ID = 'v-chunk-e2e';

/* ============================ 夹具：两条路径可见内容必须不同 ============================ */

const FIELDS: FieldMetaLite[] = [{ id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true }];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f1: FIELDS[0] };
/** 区块路径会渲染 f1 → `张伟`（与 docx 路径互不包含） */
const RECORDS = [{ recordId: 'rA', fields: { f1: '张伟' } }] as never[];

const DOCX_LITERAL = '模板R2';
const CELL_VALUE = 'DOCX-CHUNK-值';
const DOCX_BODY = `${DOCX_LITERAL} 客户：{客户名称}`;

function baseConfig(): CardViewConfig {
  return createDefaultConfig({ viewId: VIEW_ID, tableId: 't', fields: FIELDS });
}

/* ============================ 挂载 / 交互工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  setTemplateBridgeStore(null); // 复位注册表（避免污染本文件后续用例）
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

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function openEditorDocMode(config: CardViewConfig, repository: LocalStorageConfigRepository): void {
  useViewStore.setState({
    config,
    fields: FIELDS,
    fieldsById: FIELDS_BY_ID,
    records: RECORDS,
    canEditConfig: true,
    unsupportedNewer: false,
    env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID, appId: APP_ID } as never,
    repository,
  });
  useDraftStore.getState().close();
  useDraftStore.getState().open(config, 'doc');
  useUiStore.setState({ editorOpen: true, editMode: 'doc', toast: null });
}

async function uploadViaUi(container: HTMLElement, fileName: string, bytes: Uint8Array): Promise<void> {
  click(container.querySelector('[data-docx-source="imported"]'));
  expect(useDraftStore.getState().docSourceDraft).toBe('imported'); // 正面锚点：来源已切换
  const input = container.querySelector<HTMLInputElement>('[data-docx-upload="true"]');
  selectFile(input as HTMLInputElement, new File([bytes], fileName));
  await waitFor(() => useDraftStore.getState().importedDocxDraft !== undefined);
}

function findSaveButton(container: HTMLElement): Element | null {
  return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存') ?? null;
}

/** 存储里全部值的拼接（用于断言「主配置里没有模板字节」） */
function storedJoined(storage: MemoryStorage): string {
  return storage
    .keys()
    .map((k) => storage.getItem(k) ?? '')
    .join('\n');
}

/* ============================================================
 * ⭐ ① 分块（生产）路径闭环：上传 → 体检 → 保存 → 新仓储重载 → 详情渲染填入值
 * ============================================================ */

describe('⭐ 分块生产路径闭环 · 上传 → 保存 → 重开（新仓储）→ 详情渲染填充值', () => {
  it('走分块；主配置**不含 bytesBase64**；重载后正文含模板字面量 + 填入值（非占位符原文）', async () => {
    const store = new FakeBridgeStore();
    setTemplateBridgeStore(store); // ⭐ 关键：注册 bridge store → 走分块（生产路径）

    const storage = new MemoryStorage();
    const repo1 = new LocalStorageConfigRepository(storage, APP_ID);
    const config = baseConfig();
    expect(JSON.stringify(config.detail.doc)).not.toContain(DOCX_LITERAL); // 字面量只可能来自上传的 docx

    /* ---- 环 1：真实 UI 上传 ---- */
    openEditorDocMode(config, repo1);
    const { container: editor, unmount: unmountEditor } = mount(createElement(ConfigDrawer));
    const bytes = docxOf(DOCX_BODY);
    await uploadViaUi(editor, '模板.docx', bytes);

    /* ---- 环 2：体检通过（保存之前） ---- */
    await waitFor(() => editor.querySelector('[data-health-result="true"]') !== null);
    expect(editor.querySelector('[data-health-matched]')?.getAttribute('data-health-matched')).toBe('1');

    /* ---- 环 3：草稿引用 = **分块**（无 bytesBase64，含具体分块元数据） ---- */
    const draftRef = useDraftStore.getState().importedDocxDraft as ImportedDocx;
    expect(draftRef.fileName).toBe('模板.docx');
    expect(draftRef.sizeBytes).toBe(bytes.length);
    expect(draftRef.bytesBase64).toBeUndefined(); // ⭐ 字节不在主配置
    expect(typeof draftRef.templateId === 'string' && (draftRef.templateId ?? '').length > 0).toBe(true);
    expect(draftRef.chunkCount).toBeGreaterThanOrEqual(1);
    expect(draftRef.chunkSize).toBe(TEMPLATE_CHUNK_BASE64_CHARS);
    expect(draftRef.contentHash).toMatch(/^[0-9a-f]{8}$/);
    // 块落在**专用前缀**，且数量等于 chunkCount；全程不碰真实配置 key
    const prefix = templateKeyPrefixFor(VIEW_ID, draftRef.templateId as string);
    expect(store.writes.filter((k) => k.startsWith(prefix)).length).toBe(draftRef.chunkCount);
    expect(store.writes.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);

    /* ---- 环 4：真实保存（真实 persistConfig → 真实仓储 → 存储） ---- */
    click(findSaveButton(editor));
    await waitFor(() => useUiStore.getState().editorOpen === false);
    await flush();
    unmountEditor();

    // 主配置里**没有模板字节**（这正是本次重构的全部目的）
    const joined = storedJoined(storage);
    expect(joined.length).toBeGreaterThan(0); // 正面锚点：确实存了配置
    expect(joined).not.toContain('bytesBase64'); // ⭐
    expect(joined).toContain('templateId'); // 引用在
    expect(joined).toContain('contentHash'); // 完整性元数据在

    /* ---- 环 5：**新仓储**读同一存储（模拟重开） ---- */
    const repo2 = new LocalStorageConfigRepository(storage, APP_ID);
    const loaded = await repo2.load(VIEW_ID);
    expect(loaded.config).not.toBeNull();
    const savedConfig = loaded.config as CardViewConfig;
    expect(savedConfig.detail.docSource).toBe('imported');

    const ref = savedConfig.detail.importedDocx as ImportedDocx;
    expect(ref).toBeDefined();
    expect(ref.bytesBase64).toBeUndefined(); // ⭐ 重载后仍无内联字节
    expect(ref.templateId).toBe(draftRef.templateId); // 具体值断言
    expect(ref.chunkCount).toBe(draftRef.chunkCount);
    expect(ref.chunkSize).toBe(TEMPLATE_CHUNK_BASE64_CHARS);
    expect(ref.contentHash).toBe(draftRef.contentHash);
    expect(ref.sizeBytes).toBe(bytes.length);
    // 字节可从块拼回，且与上传逐字节一致
    const readBack = await readImportedDocxBytes(store, VIEW_ID, ref);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error('unreachable');
    expect(Array.from(readBack.bytes)).toEqual(Array.from(bytes));

    /* ---- 环 6：详情渲染（经注册表 store 读分块） ---- */
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

    expect(drawer.querySelector('[data-docx-view="true"]')).not.toBeNull(); // 正面锚点：docx 路径挂载
    expect(drawer.querySelectorAll('section.docx').length).toBe(1);
    const text = drawer.textContent ?? '';
    expect(text).toContain(DOCX_LITERAL); // 模板字面量
    expect(text).toContain(CELL_VALUE); // ⭐ 填入的字段值
    expect(text).not.toContain('{客户名称}'); // 占位符已被替换
    expect(text).not.toContain('张伟'); // fixture 分离：区块路径值不得出现
    expect(drawer.querySelectorAll('.cbv-paper').length).toBe(0); // 不套我们的纸张几何
    expect(drawer.querySelector('[data-testid="doc-preview"]')).toBeNull();
  }, 30000);
});

/* ============================================================
 * ⭐ ② 生产路径不把模板塞进主配置（跨多块模板 → 配置仍很小）
 * ============================================================ */

describe('⭐ 生产路径 · 主配置体积与模板字节解耦', () => {
  it('>1 块的模板（>120KB）→ 主配置仍很小且不含 bytesBase64；块存专用 key', async () => {
    const store = new FakeBridgeStore();
    setTemplateBridgeStore(store);

    const storage = new MemoryStorage();
    const repo = new LocalStorageConfigRepository(storage, APP_ID);
    openEditorDocMode(baseConfig(), repo);
    const { container } = mount(createElement(ConfigDrawer));

    const bytes = paddedDocx(DOCX_BODY, 150000); // 跨多个分块
    expect(bytes.length).toBeGreaterThan(120_000); // 正面锚点：模板确实很大
    await uploadViaUi(container, '大模板.docx', bytes);

    const ref = useDraftStore.getState().importedDocxDraft as ImportedDocx;
    expect(ref.bytesBase64).toBeUndefined();
    expect(ref.chunkCount).toBeGreaterThanOrEqual(2); // 确实跨多块
    expect(store.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBe(ref.chunkCount);

    click(findSaveButton(container));
    await waitFor(() => useUiStore.getState().editorOpen === false);
    await flush();

    const joined = storedJoined(storage);
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain('bytesBase64'); // ⭐ 字节不在主配置
    expect(joined).toContain('templateId');
    // ⭐ 核心：1.5×10^5 字节的模板，主配置仍是「小」的（否则每次保存都要搬运 MB 级数据）
    expect(joined.length).toBeLessThan(20_000);
  }, 30000);
});

/* ============================================================
 * ⭐ ③ 无关编辑不重写模板块（独立复核 ⑧）
 * ============================================================ */

describe('⭐ 生产路径 · 改主题（与模板无关）不重写模板块', () => {
  it('上传（写块）→ 改文档主题色 → 模板块写入次数**增加 0**', async () => {
    const store = new FakeBridgeStore();
    setTemplateBridgeStore(store);

    const config = baseConfig();
    useViewStore.setState({
      config,
      fields: FIELDS,
      fieldsById: FIELDS_BY_ID,
      records: RECORDS,
      canEditConfig: true,
      unsupportedNewer: false,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID } as never,
      persistConfig: async () => ({ ok: true }),
    });
    useDraftStore.getState().close();
    useDraftStore.getState().open(config, 'doc');
    useUiStore.setState({ editorOpen: true, editMode: 'doc', toast: null });

    const { container } = mount(createElement(ConfigDrawer));
    await uploadViaUi(container, '模板.docx', docxOf(DOCX_BODY));

    const baseline = store.tplWrites();
    expect(baseline).toBeGreaterThanOrEqual(1); // 正面锚点：上传确实写了块
    expect(useDraftStore.getState().importedDocxDraft?.bytesBase64).toBeUndefined();

    // 改「文档主题色」（与模板无关）
    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A'); // 正面锚点：确实改了

    expect(store.tplWrites()).toBe(baseline); // ⭐ 无关编辑不重写模板块
  }, 30000);
});

/* ============================================================
 * ④ legacy 内联旧配置 → 详情仍渲染（兼容）
 * ============================================================ */

describe('生产路径 · legacy 内联旧配置仍可渲染（兼容）', () => {
  it('仅含 bytesBase64（无分块字段）→ 详情正文含填入值；且**不访问任何块 key**', async () => {
    const store = new FakeBridgeStore();
    setTemplateBridgeStore(store);

    const config = baseConfig();
    const legacy = encodeImportedDocx('legacy.docx', docxOf(DOCX_BODY), 1);
    const patched: CardViewConfig = {
      ...config,
      detail: { ...config.detail, docSource: 'imported', importedDocx: legacy },
    };
    useViewStore.setState({
      config: patched,
      fields: FIELDS,
      fieldsById: FIELDS_BY_ID,
      records: RECORDS,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW_ID } as never,
    });
    useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId: 'rA' } });

    const { container } = mount(
      createElement(DetailDrawer, {
        pagedDeps: { awaitFonts: () => Promise.resolve(true) },
        importedDeps: { readCellString: async () => CELL_VALUE },
      }),
    );
    await waitFor(() => (container.textContent ?? '').includes(CELL_VALUE));

    const text = container.textContent ?? '';
    expect(text).toContain(DOCX_LITERAL);
    expect(text).toContain(CELL_VALUE);
    expect(text).not.toContain('{客户名称}');
    // 正面锚点：legacy 读取**不访问块 key**
    expect(store.reads.some((k) => k.startsWith(TEMPLATE_KEY_PREFIX))).toBe(false);
  }, 30000);
});

/* ============================================================
 * ⑤ 容量探测只动 cbv:probe:（独立复核 ⑦）
 * ============================================================ */

describe('生产路径 · 容量探测只动 cbv:probe:', () => {
  it('点「检测存储容量」→ 只写探针前缀、结束清理、不碰 cbv:tpl / cbv:config', async () => {
    const store = new FakeBridgeStore();
    const { container } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW_ID,
        store,
        onSourceChange: () => undefined,
        onImportedDocxChange: () => undefined,
      }),
    );

    const probeBtn = container.querySelector('[data-docx-probe="true"]');
    expect(probeBtn?.textContent).toContain('检测存储容量'); // 正面锚点
    click(probeBtn);

    await waitFor(
      () =>
        container.querySelector('[data-docx-probe-result="true"]') !== null ||
        container.querySelector('[data-docx-probe-error="true"]') !== null,
    );

    expect(store.writes.length).toBeGreaterThan(0); // 正面锚点：确实写了
    expect(store.writes.every((k) => k.startsWith(PROBE_KEY_PREFIX))).toBe(true);
    expect(store.writes.some((k) => k.startsWith(TEMPLATE_KEY_PREFIX))).toBe(false);
    expect(store.writes.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.map.size).toBe(0); // 探针 key 已清理
  }, 30000);

  it('无 store → 探测给出明确提示（不静默）', async () => {
    const { container } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW_ID,
        store: null,
        onSourceChange: () => undefined,
        onImportedDocxChange: () => undefined,
      }),
    );
    click(container.querySelector('[data-docx-probe="true"]'));
    await waitFor(() => container.querySelector('[data-docx-probe-error="true"]') !== null);
    expect(container.querySelector('[data-docx-probe-error="true"]')?.textContent).toContain('bridge');
  }, 30000);
});
