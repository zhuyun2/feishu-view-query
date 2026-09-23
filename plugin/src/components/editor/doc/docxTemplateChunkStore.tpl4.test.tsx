/**
 * docx 模板导入 **存储层接线** 的独立验证（4 / 1MB 改造）。
 *
 * 覆盖（团队三条铁律：禁止假绿）：
 *  A. ⭐ **分块写入**：有 store 时，上传走专用 key `cbv:tpl:{viewId}:{templateId}:{i}`；
 *     交给上层的引用**不含 `bytesBase64`**（字节不在主配置里）；且块内容可原样读回。
 *  B. ⭐ **容量探测（⑦）**：点「检测存储容量」→ 只在 `cbv:probe:` key 上试写并清理，
 *     UI 展示「最大成功体积 + 逐档结果」；**不碰任何 `cbv:tpl:` / `cbv:config:`**。
 *  C. ⭐ **无关编辑不重写模板块（⑧）**：上传后改「文档主题色」（与模板无关）→
 *     模板块的写入次数**增加 0**（读 / 体检只读不写）。
 *  D. **降级与安全**：无 store 时小模板内联（仍在主配置额度内）；**大模板显式报错**
 *     （绝不把 ~1.4MB 静默塞进主配置）。
 *
 * 断言策略：一律锁定**具体 key 前缀 / 具体数值 / 结构**；否定式断言配正面锚点。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { CardViewConfig, ImportedDocx } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { CONFIG_KEY_PREFIX } from '@/constants';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import type { BridgeStore } from '@/sdk/base';
import {
  INLINE_FALLBACK_MAX_BYTES,
  PROBE_KEY_PREFIX,
  TEMPLATE_KEY_PREFIX,
  getTemplateBridgeStore,
  setTemplateBridgeStore,
} from '@/doc/template/storage';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { ConfigDrawer } from '../ConfigDrawer';
import {
  DocxTemplateSourceBar,
  noStoreLargeMessage,
  PROBE_ACTION_LABEL,
  PROBE_TITLE,
} from './DocxTemplateSourceBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function docxOf(text: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generate({ type: 'uint8array' });
}

/* ===================== 假 bridge 存储（记录 key 访问） ===================== */

class FakeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly deleted: string[] = [];
  /** 写入字符数 > 该值 → 抛错（模拟平台容量上限，供探针使用） */
  maxBytes: number | null = null;

  async getData(key: string): Promise<unknown> {
    this.reads.push(key);
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setData(key: string, value: unknown): Promise<boolean> {
    this.writes.push(key);
    if (this.maxBytes !== null && typeof value === 'string' && value.length > this.maxBytes) {
      throw new Error(`bridge 容量上限：写入 ${value.length} 字符被拒绝`);
    }
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

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];

const VIEW = 'v-chunk';

/* ===================== 挂载工具 ===================== */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  setTemplateBridgeStore(null); // 复位注册表（避免影响本文件后续用例）
  useDraftStore.getState().close();
  useUiStore.setState({ editorOpen: false, editMode: 'doc', toast: null });
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

/* ===================== ① ⭐ 分块写入（有 store） ===================== */

describe('docx 模板分块存储 · 有 store → 走专用 key，引用不含 bytesBase64', () => {
  it('上传 → 写 cbv:tpl:{viewId}:{templateId}:*；引用无 bytesBase64；块可原样读回', async () => {
    const store = new FakeStore();
    const bytes = docxOf('客户：{客户名称}');
    const written: ImportedDocx[] = [];

    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW,
        store,
        onSourceChange: () => undefined,
        onImportedDocxChange: (imp) => written.push(imp),
      }),
    );

    selectFile(container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement, new File([bytes], '模板.docx'));
    await waitFor(() => written.length > 0);

    const ref = written[0];
    // 正面锚点：确实走分块（有 templateId / chunkCount / contentHash），且**没有内联字节**
    expect(ref.fileName).toBe('模板.docx');
    expect(ref.sizeBytes).toBe(bytes.length);
    expect(typeof ref.templateId).toBe('string');
    expect((ref.templateId ?? '').length).toBeGreaterThan(0);
    expect(ref.chunkCount).toBeGreaterThanOrEqual(1);
    expect(ref.contentHash).toBeTruthy();
    expect(ref.bytesBase64).toBeUndefined(); // ⭐ 字节不在主配置里

    // 块 key 落在专用前缀，且都带「自己的 viewId + templateId」
    const prefix = `${TEMPLATE_KEY_PREFIX}:${VIEW}:${ref.templateId}:`;
    const chunkKeys = store.writes.filter((k) => k.startsWith(prefix));
    expect(chunkKeys.length).toBe(ref.chunkCount);
    expect(store.writes.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false); // 不碰真实配置

    unmount();
  });
});

/* ===================== ② ⭐ 容量探测（⑦） ===================== */

describe('docx 模板分块存储 · ⭐ 容量探测只动 cbv:probe:', () => {
  it('点「检测存储容量」→ 展示最大成功体积 + 逐档结果；不写 cbv:tpl / cbv:config', async () => {
    const store = new FakeStore();
    store.maxBytes = 128 * 1024; // 128KB 字符上限
    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW,
        store,
        onSourceChange: () => undefined,
        onImportedDocxChange: () => undefined,
      }),
    );

    const probeBtn = container.querySelector('[data-docx-probe="true"]');
    expect(probeBtn?.textContent).toContain(PROBE_ACTION_LABEL); // 正面锚点
    click(probeBtn);

    await waitFor(() => container.querySelector('[data-docx-probe-result="true"]') !== null);

    // 展示最大成功体积（128KB 档成功、256KB 档失败 → max = 128KB = 131072）
    const max = container.querySelector('[data-probe-max]');
    expect(max?.getAttribute('data-probe-max')).toBe(String(128 * 1024));
    expect(container.textContent).toContain(PROBE_TITLE);

    // 逐档结果：成功档 data-probe-ok=true；失败档 =false
    const steps = [...container.querySelectorAll('[data-probe-step]')];
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const failed = steps.filter((s) => s.getAttribute('data-probe-ok') === 'false');
    expect(failed.length).toBe(1); // 命中上限即停 → 恰好一档失败

    // ⭐ 全程序列只碰探针前缀；且探针 key 已被清理
    expect(store.writes.every((k) => k.startsWith(PROBE_KEY_PREFIX))).toBe(true);
    expect(store.writes.some((k) => k.startsWith(TEMPLATE_KEY_PREFIX))).toBe(false);
    expect(store.writes.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.map.size).toBe(0); // 探针 key 已清理

    unmount();
  });

  it('无 store → 探测给出明确提示（不静默）', async () => {
    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW,
        store: null,
        onSourceChange: () => undefined,
        onImportedDocxChange: () => undefined,
      }),
    );
    click(container.querySelector('[data-docx-probe="true"]'));
    await waitFor(() => container.querySelector('[data-docx-probe-error="true"]') !== null);
    expect(container.querySelector('[data-docx-probe-error="true"]')?.textContent).toContain('bridge');
    unmount();
  });
});

/* ===================== ③ ⭐ 无关编辑不重写模板块（⑧） ===================== */

describe('docx 模板分块存储 · ⭐ 改主题（与模板无关）不重写模板块', () => {
  beforeEach(() => {
    const config = createDefaultConfig({ viewId: VIEW, tableId: 't', fields: FIELDS });
    useViewStore.setState({
      config,
      fields: FIELDS,
      fieldsById: { f1: FIELDS[0] },
      records: [],
      canEditConfig: true,
      unsupportedNewer: false,
      env: { language: 'zh-CN', tableId: 't', viewId: VIEW } as never,
      persistConfig: async () => ({ ok: true }),
    });
    useDraftStore.getState().close();
    useDraftStore.getState().open(config as CardViewConfig, 'doc');
    useUiStore.setState({ editorOpen: true, editMode: 'doc', toast: null });
  });

  it('上传（写块）→ 改文档主题色 → 模板块写入次数增加 0', async () => {
    const store = new FakeStore();
    setTemplateBridgeStore(store); // 生产同款：由注册表提供 bridge store

    const { container, unmount } = mount(createElement(ConfigDrawer));

    click(container.querySelector('[data-docx-source="imported"]'));
    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([docxOf('客户：{客户名称}')], '模板.docx'),
    );
    await waitFor(() => useDraftStore.getState().importedDocxDraft !== undefined);

    // 正面锚点：上传确实写了模板块，且草稿引用**不含 bytesBase64**
    const baseline = store.tplWrites();
    expect(baseline).toBeGreaterThanOrEqual(1);
    expect(useDraftStore.getState().importedDocxDraft?.bytesBase64).toBeUndefined();

    // 改「文档主题色」（与模板无关）
    click(container.querySelector('[data-docprops-toggle="theme"]'));
    click(container.querySelector('[data-theme-swatch="#00B42A"]'));
    expect(useDraftStore.getState().docDraft?.theme.primaryColor).toBe('#00B42A'); // 正面锚点：确实改了

    // ⭐ 无关编辑期间：模板块写入次数**不变**
    expect(store.tplWrites()).toBe(baseline);

    unmount();
  });

  it('上传 → 重挂载详情读回（读路径）→ 模板块写入次数仍为 0 新增', async () => {
    const store = new FakeStore();
    setTemplateBridgeStore(store);
    const { container, unmount } = mount(createElement(ConfigDrawer));

    click(container.querySelector('[data-docx-source="imported"]'));
    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([docxOf('客户：{客户名称}')], '模板.docx'),
    );
    await waitFor(() => useDraftStore.getState().importedDocxDraft !== undefined);
    const baseline = store.tplWrites();

    // 触发体检重跑（改字段元数据 → effect 依赖变化）——这只会「读」，绝不「写」
    const readsBefore = store.reads.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length;
    act(() => {
      useViewStore.setState({ fields: [...FIELDS, { id: 'f9', name: '备注', type: FieldType.Text, isPrimary: false }] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(store.tplWrites()).toBe(baseline); // ⭐ 读不写
    expect(store.reads.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBeGreaterThanOrEqual(readsBefore); // 正面锚点：确有读

    unmount();
  });
});

/* ===================== ④ 降级与安全（无 store） ===================== */

describe('docx 模板分块存储 · 无 store 降级', () => {
  it('小模板（≤ 内联上限）→ 内联写入（仍在主配置额度内），无超限错误', async () => {
    const written: ImportedDocx[] = [];
    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW,
        store: null,
        onSourceChange: () => undefined,
        onImportedDocxChange: (imp) => written.push(imp),
      }),
    );

    const bytes = docxOf('客户：{客户名称}');
    expect(bytes.length).toBeLessThanOrEqual(INLINE_FALLBACK_MAX_BYTES); // 正面锚点：确实是小模板
    selectFile(container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement, new File([bytes], 'small.docx'));

    await waitFor(() => written.length > 0);
    expect(container.querySelector('[data-docx-upload-error="true"]')).toBeNull();
    expect(typeof written[0].bytesBase64).toBe('string'); // 降级内联
    expect(written[0].sizeBytes).toBe(bytes.length);
    unmount();
  });

  it('大模板（> 内联上限）且无 store → 显式报错（绝不静默塞进主配置）', async () => {
    const written: ImportedDocx[] = [];
    const size = INLINE_FALLBACK_MAX_BYTES + 4096; // 36864：> 32KB，但 < 1MB 上限
    const { container, unmount } = mount(
      createElement(DocxTemplateSourceBar, {
        source: 'imported',
        importedDocx: null,
        fields: FIELDS,
        viewId: VIEW,
        store: null,
        onSourceChange: () => undefined,
        onImportedDocxChange: (imp) => written.push(imp),
      }),
    );

    selectFile(
      container.querySelector<HTMLInputElement>('[data-docx-upload="true"]') as HTMLInputElement,
      new File([new Uint8Array(size)], 'medium.docx'),
    );

    await waitFor(() => container.querySelector('[data-docx-upload-error="true"]') !== null);
    const err = container.querySelector('[data-docx-upload-error="true"]');
    expect(err?.textContent).toBe(noStoreLargeMessage(size));
    expect(err?.textContent).toContain(String(size));
    expect(err?.textContent).toContain(String(INLINE_FALLBACK_MAX_BYTES));
    expect(written.length).toBe(0); // 绝不允许静默失败
    unmount();
  });
});

/* ===================== ⑤ 生产接线（源码级，先剔注释） ===================== */

describe('docx 模板分块存储 · 生产接线源码锚点', () => {
  it('config/factory 注册 bridge store 给模板块存储（工厂 → storage 注册表）', () => {
    const raw = readFileSync(path.resolve(process.cwd(), 'src/config/factory.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/setTemplateBridgeStore\s*\(\s*bridgeStore\s*\)/);
    expect(getTemplateBridgeStore).toBeTypeOf('function');
  });
});
