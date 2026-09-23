/**
 * 详情抽屉 × 「导入的 docx」集成测试（「docx 模板导入」第五步 5a）。
 *
 * 覆盖（团队铁律：禁止假绿）：
 *  ① `docSource === 'blocks'`（含**缺省**）→ 渲染**区块路径**、docx 路径产物**不存在**（双侧锚点）；
 *  ② `docSource === 'imported'` + 合法模板 → docx 路径在、**内容含填入的字段值**（stub 控制值）；
 *  ③ 三种失败各自的**明确文案**（模板缺失 / 模板非法 / 填充失败）+ 正面锚点（错误块确实挂载）；
 *  ④ ⭐ **过期响应**：切记录后旧链路更晚完成 → 最终仍是**后一条记录**的内容（断言具体文本）；
 *  ⑤ **重新上传后重渲染**：`importedDocx` 变 → 正文换成新模板的内容（漏依赖即「不报错但不刷新」）；
 *  ⑥ 源码级：正文体**不套** `.cbv-paper` 几何（刻意的分歧）。
 *
 * ⭐ fixture 分离（铁律 3）：两条路径都会渲染文本，故让它们**可见内容不同**——
 *   区块路径渲染记录字段值（`张伟`）；docx 路径渲染**模板字面量**（`模板A`）+ **stub 值**（`DOCX-值-A`）。
 *   于是「渲染了哪一条」可被判别，否定式断言（`not.toContain('张伟')`）也才有意义。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { CardViewConfig, ImportedDocx } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { encodeImportedDocx } from '@/doc/template/storage';
import { initialDrawerState, useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import type { FillDocxFn, UseImportedDocDeps } from '@/hooks/useImportedDoc';
import { DetailDrawer } from './DetailDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ============================ 现场生成最小 docx ============================ */

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

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function imported(bodyInner: string, uploadedAt = 1): ImportedDocx {
  return encodeImportedDocx('t.docx', buildDocx(bodyInner), uploadedAt);
}

/* ============================ 夹具 ============================ */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];
const FIELDS_BY_ID: Record<string, FieldMetaLite> = { f1: FIELDS[0] };

/** ⭐ 两条记录：区块路径会渲染 f1（张伟 / 李四）——用于与 docx 路径分离 */
const RECORDS = [
  { recordId: 'rA', fields: { f1: '张伟' } },
  { recordId: 'rB', fields: { f1: '李四' } },
] as never[];

const BASE = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS });

/** 构造详情配置：可指定 docSource / importedDocx（缺省 = 保真区块路径） */
function configWith(
  patch: Partial<CardViewConfig['detail']>,
  base: CardViewConfig = BASE,
): CardViewConfig {
  return { ...base, detail: { ...base.detail, ...patch } };
}

function seed(config: CardViewConfig = BASE): void {
  useViewStore.setState({
    config,
    fields: FIELDS,
    fieldsById: FIELDS_BY_ID,
    records: RECORDS,
    env: { language: 'zh-CN', tableId: 't', viewId: 'v' } as never,
  });
}

function open(recordId = 'rA'): void {
  useUiStore.setState({ drawer: { ...initialDrawerState(null), open: true, recordId } });
}

/* ============================ 挂载工具 ============================ */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  useUiStore.setState({ drawer: initialDrawerState(null) });
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

/** 挂载抽屉：`pagedDeps` 固定注入「字体立即就绪」（避免字体计时的非确定性） */
function mountDrawer(importedDeps?: UseImportedDocDeps): { container: HTMLElement; unmount: () => void } {
  return mount(
    createElement(DetailDrawer, {
      pagedDeps: { awaitFonts: () => Promise.resolve(true) },
      importedDeps,
    }),
  );
}

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 轮询等待（真实计时 + act 包裹），超时抛错 */
async function poll(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('poll 超时');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/**
 * 驱动 act 计时 `ms` 毫秒（让「过期链路」有充足时间彻底跑完）。
 * ⚠️ 过期链路的**正确**行为是「什么都不做」，因此不能用「等某个东西出现」来判定它已结束；
 *    只能给足时间，让「守卫失效」的情形**必然**在这段时间内把 A 的内容渲染出来。
 */
async function settle(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

beforeEach(() => {
  vi.setConfig({ testTimeout: 20000 }); // 真实动态 import（pizzip/docxtemplater）+ docx 渲染，5s 偏紧
  seed(BASE);
  useUiStore.setState({ drawer: initialDrawerState(null) });
});

/* ============================================================
 * ① blocks（含缺省）→ 区块路径在、docx 产物不在
 * ============================================================ */

describe('5a · docSource = blocks（含缺省）→ 区块路径完全不受影响', () => {
  it('docSource **缺省** → 1 张 .cbv-paper + 区块内容；docx 路径产物一律不存在', async () => {
    seed(BASE); // BASE.detail.docSource === undefined（旧配置）
    open('rA');
    const readCellString = vi.fn(async () => 'DOCX-不该出现');
    const { container, unmount } = mountDrawer({ readCellString });
    await flush();

    // 正面锚点：区块路径确实渲染了
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
    unmount();
  });

  it('显式 docSource=blocks（且已上传模板）→ 仍走区块路径、docx 产物不存在', async () => {
    seed(configWith({ docSource: 'blocks', importedDocx: imported(para('DOCX 模板')) }));
    open('rA');
    const readCellString = vi.fn(async () => 'DOCX-不该出现');
    const { container, unmount } = mountDrawer({ readCellString });
    await flush();

    expect(container.querySelectorAll('.cbv-paper').length).toBe(1); // 正面锚点
    expect(container.textContent).toContain('张伟');
    expect(container.querySelector('[data-docx-host="true"]')).toBeNull();
    expect(container.querySelector('[data-docx-view="true"]')).toBeNull();
    expect(readCellString).not.toHaveBeenCalled();
    unmount();
  });

  it('源码级：DetailDrawer 按 docSource 分支；imported 分支**不套** .cbv-paper', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/components/detail/DetailDrawer.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // 正面锚点：确实读到了非空源码
    expect(source).toContain('DetailDrawer');
    // 结构性：确实按 docSource 分支 + 引入 DocxTemplatePreview
    expect(code).toMatch(/resolveDocSource\s*\(/);
    expect(code).toMatch(/docSource\s*===\s*'imported'/);
    expect(code).toMatch(/<DocxTemplatePreview\b/);
    // 块路径仍在（原有结构未变）
    expect(code).toMatch(/<DocPreview\s+pagedDoc=\{paged\.pagedDoc\}/);
    // ⭐ 刻意的分歧：本文件**不得**出现 .cbv-paper（不把我们的纸张几何套给导入的 docx）
    expect(code).not.toMatch(/cbv-paper/);
  });
});

/* ============================================================
 * ② imported + 合法模板 → docx 路径在、含填入值
 * ============================================================ */

describe('5a · docSource = imported + 合法模板 → 保真渲染填充结果', () => {
  it('正文来自 docx：含模板字面量 + 填入的字段值；不含（块路径的）字段值；不套 .cbv-paper', async () => {
    seed(configWith({ docSource: 'imported', importedDocx: imported(para('模板A 客户：{客户名称}')) }));
    open('rA');
    const { container, unmount } = mountDrawer({
      readCellString: async (_fieldId, recordId) => (recordId === 'rA' ? 'DOCX-值-A' : ''),
    });

    await poll(() => (container.textContent ?? '').includes('DOCX-值-A'));

    const text = container.textContent ?? '';
    // 正面锚点（docx 路径的产物）
    expect(container.querySelector('[data-docx-view="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-docx-host="true"]').length).toBe(1);
    expect(container.querySelectorAll('section.docx').length).toBe(1);
    expect(text).toContain('模板A'); // 模板字面量（块路径不产出 → 判别「渲染了哪一条」）
    expect(text).toContain('DOCX-值-A'); // ⭐ 填入的字段值
    expect(text).not.toContain('{客户名称}'); // 占位符已被替换

    // ⭐ fixture 分离：块路径的字段值不得出现（否则说明块路径被错误渲染）
    expect(text).not.toContain('张伟');
    // 否定式：不套我们的纸张几何（配正面锚点：上面已证明 docx 路径确实挂载）
    expect(container.querySelectorAll('.cbv-paper').length).toBe(0);
    expect(container.querySelector('[data-testid="doc-preview"]')).toBeNull();
    unmount();
  }, 20000);
});

/* ============================================================
 * ③ 三种失败 → 明确文案（配正面锚点）
 * ============================================================ */

describe('5a · 失败必须可见（不留空白）', () => {
  it('模板缺失 → 明确文案 + 错误块挂载', async () => {
    seed(configWith({ docSource: 'imported', importedDocx: undefined }));
    open('rA');
    const { container, unmount } = mountDrawer();
    await flush();

    expect(container.querySelector('[data-docx-state="error"]')).not.toBeNull(); // 正面锚点
    expect(container.textContent).toContain('未找到导入的模板');
    expect(container.querySelectorAll('.cbv-paper').length).toBe(0);
    unmount();
  });

  it('模板非法（base64 坏）→ 「导入的模板无效」+ 原因', async () => {
    seed(
      configWith({
        docSource: 'imported',
        importedDocx: { fileName: 'x.docx', bytesBase64: '!!bad!!', sizeBytes: 5, uploadedAt: 1 },
      }),
    );
    open('rA');
    const { container, unmount } = mountDrawer();
    await flush();

    expect(container.querySelector('[data-docx-state="error"]')).not.toBeNull(); // 正面锚点
    expect(container.textContent).toContain('导入的模板无效');
    expect(container.textContent).toContain('base64');
    unmount();
  });

  it('填充失败 → 「模板填充失败」+ formatError 可读信息', async () => {
    seed(configWith({ docSource: 'imported', importedDocx: imported(para('{客户名称}')) }));
    open('rA');
    const fill: FillDocxFn = async () => {
      throw new Error('详情填充炸了');
    };
    const { container, unmount } = mountDrawer({ readCellString: async () => 'x', fill });

    await poll(() => (container.textContent ?? '').includes('模板填充失败'));
    expect(container.querySelector('[data-docx-state="error"]')).not.toBeNull(); // 正面锚点
    expect(container.textContent).toContain('模板填充失败');
    expect(container.textContent).toContain('详情填充炸了');
    expect(container.textContent).not.toContain('[object Object]');
    unmount();
  }, 20000);
});

/* ============================================================
 * ④ ⭐ 过期响应不得覆盖新记录
 * ============================================================ */

describe('5a · ⭐ 过期响应不得覆盖新记录（抽屉级）', () => {
  it('先发起的后完成 → 最终渲染的仍是后一条记录的内容（断言具体文本）', async () => {
    const gates = new Map<string, (value: string) => void>();
    const deps: UseImportedDocDeps = {
      readCellString: (_fieldId, recordId) =>
        new Promise<string>((resolve) => {
          gates.set(recordId, resolve);
        }),
      extractText: async () => '{客户名称}', // 冻结抽取：唯一异步闸门落在读取
    };

    seed(configWith({ docSource: 'imported', importedDocx: imported(para('共用模板 {客户名称}')) }));
    open('rA');
    const { container, unmount } = mountDrawer(deps);

    await poll(() => gates.has('rA')); // A 链路挂在读取

    // 切到 B（作废 A 链路）
    act(() => {
      useUiStore.setState((state) => ({ drawer: { ...state.drawer, recordId: 'rB' } }));
    });
    await poll(() => gates.has('rB'));

    // B（后发起）先完成 → DOM 出现 B 的值
    await act(async () => {
      gates.get('rB')?.('值-B');
      await Promise.resolve();
    });
    await poll(() => (container.textContent ?? '').includes('值-B'));
    expect(container.textContent).toContain('值-B'); // 正面锚点

    // A（先发起）后完成 —— 过期，绝不能覆盖 B
    await act(async () => {
      gates.get('rA')?.('值-A');
      await Promise.resolve();
    });
    // 给「过期链路」充足时间彻底跑完：若守卫失效，此间它会把 A 的内容渲染出来
    await settle(2000);

    expect(container.textContent).toContain('值-B');
    expect(container.textContent).not.toContain('值-A'); // ⭐ 守卫失效 → 必红
    expect(container.querySelectorAll('section.docx').length).toBe(1);
    unmount();
  }, 20000);
});

/* ============================================================
 * ⑤ 重新上传 → 重新渲染
 * ============================================================ */

describe('5a · 重新上传模板 → 详情重新渲染', () => {
  it('importedDocx 变化（同记录）→ 正文换成新模板的内容（旧内容消失）', async () => {
    const v1 = imported(para('模板一 {客户名称}'), 1);
    seed(configWith({ docSource: 'imported', importedDocx: v1 }));
    open('rA');
    const { container, unmount } = mountDrawer({ readCellString: async () => '值同' });

    await poll(() => (container.textContent ?? '').includes('模板一'));
    expect(container.textContent).toContain('值同'); // 正面锚点：确实渲染了填充结果

    // 用户重新上传（只有 importedDocx 变，其余依赖不变）
    const v2 = imported(para('模板二 {客户名称}'), 2);
    act(() => {
      useViewStore.setState({ config: configWith({ docSource: 'imported', importedDocx: v2 }) });
    });

    await poll(() => (container.textContent ?? '').includes('模板二'));
    expect(container.textContent).toContain('模板二');
    expect(container.textContent).not.toContain('模板一'); // 漏依赖 importedDocx → 此处恒红
    expect(container.querySelectorAll('section.docx').length).toBe(1);
    unmount();
  }, 20000);
});
