/**
 * `hooks/useImportedDoc` 单测 —— 导入 docx 的**数据管线编排**（5a）。
 *
 * 覆盖（团队铁律：禁止假绿）：
 *  ① 纯函数：`xmlToPlainText` / `extractDocxText`（**跨 run 占位符必须还原**）；
 *  ② `docSource === 'blocks'`（含缺省）/ 未启用 → `idle` 且**不产出字节、不调用任何数据依赖**；
 *  ③ 合法模板 → `ready` + 字节里**含填入的字段值**（用 stub `readCellString` 控制值，断言具体文本）；
 *  ④ 三种失败各自的**明确文案**：模板缺失 / 模板非法（3 个细分支）/ 填充失败；
 *  ⑤ ⭐ **过期响应守卫**：先发起的后完成 → 最终字节仍是**后一条记录**的（判别式，断言具体文本）。
 *
 * 断言策略：否定式断言**必配正面锚点**；两条链路可能同值时 fixture 分离（A/B 值不同且互不包含）。
 * 确定性来源：注入 `readCellString` / `extractText` / `fill`（可逐拍 resolve）；`fill` 走真实
 * `fillDocxTemplate` 时用现场生成的最小 docx。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import type { DetailConfig, ImportedDocx } from '@/config/types';
import { createDefaultConfig } from '@/config/defaults';
import { FieldType, type FieldMetaLite } from '@/fields/fieldTypes';
import { encodeImportedDocx, MAX_IMPORTED_DOCX_BYTES } from '@/doc/template/storage';
import {
  extractDocxText,
  FILL_FAILED_PREFIX,
  INVALID_TEMPLATE_PREFIX,
  MISSING_TEMPLATE_MESSAGE,
  useImportedDoc,
  xmlToPlainText,
} from './useImportedDoc';
import type {
  FillDocxFn,
  UseImportedDocArgs,
  UseImportedDocDeps,
  UseImportedDocResult,
} from './useImportedDoc';

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

/** 单段落（含占位符时可跨 run） */
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

/** 解出 docx 的 `word/document.xml` 文本（断言「填了什么」用） */
function docxTextOf(bytes: Uint8Array): string {
  const zip = new PizZip(bytes);
  return zip.file('word/document.xml')?.asText() ?? '';
}

/* ===================== 夹具 ===================== */

const FIELDS: FieldMetaLite[] = [
  { id: 'f1', name: '客户名称', type: FieldType.Text, isPrimary: true },
];

const BASE_DETAIL: DetailConfig = createDefaultConfig({ viewId: 'v', tableId: 't', fields: FIELDS }).detail;

function imported(bodyInner: string, uploadedAt = 1): ImportedDocx {
  return encodeImportedDocx('t.docx', buildDocx(bodyInner), uploadedAt);
}

/** 构造详情配置（可指定 docSource / importedDocx） */
function detailWith(patch: Partial<DetailConfig>): DetailConfig {
  return { ...BASE_DETAIL, ...patch };
}

/* ===================== 挂载工具（Hook 探针） ===================== */

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

// 真实动态 import（pizzip / docxtemplater）+ FileReader 读 Blob，默认 5s 偏紧 → 放宽
beforeEach(() => {
  vi.setConfig({ testTimeout: 20000 });
});

interface HookHarness {
  rerender: (args: UseImportedDocArgs) => void;
  result: () => UseImportedDocResult;
  unmount: () => void;
}

function mountHook(initial: UseImportedDocArgs): HookHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latest: UseImportedDocResult = { source: 'blocks', status: 'idle', bytes: null, error: null };
  function Probe({ args }: { args: UseImportedDocArgs }): null {
    latest = useImportedDoc(args);
    return null;
  }

  act(() => {
    root.render(createElement(Probe, { args: initial }));
  });

  let done = false;
  const unmount = (): void => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);

  return {
    rerender: (args) => {
      act(() => {
        root.render(createElement(Probe, { args }));
      });
    },
    result: () => latest,
    unmount,
  };
}

/** 冲净微任务 + 真实计时（等动态 import / 填充落定） */
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

/* ===================== ① 纯函数 ===================== */

describe('useImportedDoc · 纯函数（docx → 纯文本）', () => {
  it('xmlToPlainText：占位符**跨 run** 也要还原；段落结束 → 换行', () => {
    const xml =
      `<w:p><w:r><w:t>{客户</w:t></w:r><w:r><w:t>名称}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>第二段</w:t></w:r></w:p>`;
    const text = xmlToPlainText(xml);
    expect(text).toContain('{客户名称}'); // ⭐ 跨 run 还原
    expect(text).toContain('第二段');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2); // 段落分隔
    // 正面锚点：确实剥掉了 XML 标签（不是原样返回）
    expect(text).not.toContain('<w:t');
  });

  it('xmlToPlainText：XML 实体被解码（&amp; 不二次解码）', () => {
    expect(xmlToPlainText(`<w:p><w:t>A&amp;B &lt;C&gt;</w:t></w:p>`)).toContain('A&B <C>');
    expect(xmlToPlainText(`<w:p><w:t>&amp;lt;</w:t></w:p>`)).toContain('&lt;');
  });

  it('extractDocxText：从真实最小 docx 里抽出占位符', async () => {
    const bytes = buildDocx(para('客户：{客户名称}'));
    const text = await extractDocxText(bytes);
    expect(text).toContain('{客户名称}');
    expect(text).toContain('客户：');
  });
});

/* ===================== ② 块路径 / 未启用 ===================== */

describe('useImportedDoc · 非导入来源 → 一律 idle（块路径不受影响）', () => {
  it('docSource 缺省（= blocks）→ idle、无字节、**数据依赖零调用**', async () => {
    const readCellString = vi.fn(async () => '不应被调用');
    const fill = vi.fn(async () => new Blob([]));
    const harness = mountHook({
      detail: detailWith({ docSource: undefined, importedDocx: undefined }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString, fill },
    });

    expect(harness.result().source).toBe('blocks'); // 正面锚点
    expect(harness.result().status).toBe('idle');
    expect(harness.result().bytes).toBeNull();
    expect(readCellString).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('显式 docSource=blocks（含模板已上传）→ 仍 idle、无字节', async () => {
    const readCellString = vi.fn(async () => '不应被调用');
    const harness = mountHook({
      detail: detailWith({ docSource: 'blocks', importedDocx: imported(para('{客户名称}')) }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString },
    });
    expect(harness.result().source).toBe('blocks');
    expect(harness.result().status).toBe('idle');
    expect(harness.result().bytes).toBeNull();
    expect(readCellString).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('docSource=imported 但未启用（抽屉关/无记录）→ idle、无字节', async () => {
    const readCellString = vi.fn(async () => '不应被调用');
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: imported(para('{客户名称}')) }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: false,
      deps: { readCellString },
    });
    expect(harness.result().source).toBe('imported'); // 正面锚点：来源已识别
    expect(harness.result().status).toBe('idle');
    expect(harness.result().bytes).toBeNull();
    expect(readCellString).not.toHaveBeenCalled();
    harness.unmount();
  });
});

/* ===================== ③ 合法模板 → ready（真实 fill） ===================== */

describe('useImportedDoc · 合法模板 → ready', () => {
  it('产出字节里含填入的字段值（stub readCellString 控制值，断言具体文本）', async () => {
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: imported(para('客户：{客户名称}')) }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => '导入值-甲' },
    });

    await poll(() => harness.result().status === 'ready');

    const bytes = harness.result().bytes;
    expect(bytes).not.toBeNull();
    expect(docxTextOf(bytes as Uint8Array)).toContain('导入值-甲');
    expect(docxTextOf(bytes as Uint8Array)).not.toContain('{客户名称}'); // 占位符已被替换
    harness.unmount();
  }, 20000);
});

/* ===================== ④ 三种失败的明确文案 ===================== */

describe('useImportedDoc · 失败必须可见（明确文案）', () => {
  it('模板缺失 → MISSING_TEMPLATE_MESSAGE', async () => {
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: undefined }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => 'x' },
    });
    expect(harness.result().status).toBe('error');
    expect(harness.result().bytes).toBeNull();
    expect(harness.result().error).toBe(MISSING_TEMPLATE_MESSAGE);
    expect(harness.result().error).toContain('未找到导入的模板');
    harness.unmount();
  });

  it('模板非法 · base64 坏 → 前缀 + 具体原因', async () => {
    const bad = { fileName: 'x.docx', bytesBase64: '!!not-base64!!', sizeBytes: 5, uploadedAt: 1 };
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: bad }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => 'x' },
    });
    expect(harness.result().status).toBe('error');
    expect(harness.result().error).toContain(INVALID_TEMPLATE_PREFIX);
    expect(harness.result().error).toContain('base64');
    harness.unmount();
  });

  it('模板非法 · 大小不一致 → 前缀 + 具体原因', async () => {
    const mismatch = { fileName: 'x.docx', bytesBase64: btoa('abc'), sizeBytes: 999, uploadedAt: 1 };
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: mismatch }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => 'x' },
    });
    expect(harness.result().status).toBe('error');
    expect(harness.result().error).toContain(INVALID_TEMPLATE_PREFIX);
    expect(harness.result().error).toContain('模板大小不一致');
    harness.unmount();
  });

  it('模板非法 · 超上限 → 前缀 + 含实际大小与上限', async () => {
    const over = encodeImportedDocx('big.docx', new Uint8Array(MAX_IMPORTED_DOCX_BYTES + 1), 1);
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: over }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => 'x' },
    });
    expect(harness.result().status).toBe('error');
    expect(harness.result().error).toContain(INVALID_TEMPLATE_PREFIX);
    expect(harness.result().error).toContain('超出上限');
    expect(harness.result().error).toContain(String(MAX_IMPORTED_DOCX_BYTES + 1));
    harness.unmount();
  });

  it('填充失败 → FILL_FAILED_PREFIX + formatError 的可读信息（非 [object Object]）', async () => {
    let fillCalls = 0;
    const fill: FillDocxFn = async () => {
      fillCalls += 1;
      throw new Error('模拟填充失败');
    };
    const harness = mountHook({
      detail: detailWith({ docSource: 'imported', importedDocx: imported(para('{客户名称}')) }),
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps: { readCellString: async () => 'x', fill },
    });

    await poll(() => harness.result().status === 'error');
    expect(harness.result().error).toContain(FILL_FAILED_PREFIX);
    expect(harness.result().error).toContain('模拟填充失败');
    expect(harness.result().error).not.toContain('[object Object]');
    expect(fillCalls).toBe(1); // 正面锚点：确实走到了填充
    harness.unmount();
  }, 20000);
});

/* ===================== ⑤ ⭐ 过期响应守卫 ===================== */

describe('useImportedDoc · ⭐ 过期响应不得覆盖新记录', () => {
  it('先发起的后完成 → 最终字节仍是后一条记录的（断言具体文本）', async () => {
    const gates = new Map<string, (value: string) => void>();
    const readCellString = (_fieldId: string, recordId: string): Promise<string> =>
      new Promise<string>((resolve) => {
        gates.set(recordId, resolve);
      });

    // 冻结抽取：让唯一的异步闸门落在 readCellString 上（时序确定）
    const deps: UseImportedDocDeps = {
      readCellString,
      extractText: async () => '{客户名称}',
    };
    // ⭐ 两条链路共用**同一个** importedDocx 对象 → 唯一变化是 recordId（隔离被测依赖）
    const docx = imported(para('共用模板 {客户名称}'));
    const detail = detailWith({ docSource: 'imported', importedDocx: docx });

    const harness = mountHook({
      detail,
      recordId: 'rA',
      fields: FIELDS,
      tableId: 't',
      enabled: true,
      deps,
    });

    await poll(() => gates.has('rA')); // A 链路挂在读取

    // 切到 B（作废 A 链路）
    harness.rerender({ detail, recordId: 'rB', fields: FIELDS, tableId: 't', enabled: true, deps });
    await poll(() => gates.has('rB'));

    // B（后发起）先完成
    await act(async () => {
      gates.get('rB')?.('值-B');
      await Promise.resolve();
    });
    await poll(() => harness.result().status === 'ready');
    expect(docxTextOf(harness.result().bytes as Uint8Array)).toContain('值-B'); // 正面锚点

    // A（先发起）后完成 —— 过期，绝不能覆盖 B
    await act(async () => {
      gates.get('rA')?.('值-A');
      await Promise.resolve();
    });
    // 静置若干拍（让过期链路彻底跑完）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(harness.result().status).toBe('ready');
    expect(docxTextOf(harness.result().bytes as Uint8Array)).toContain('值-B');
    expect(docxTextOf(harness.result().bytes as Uint8Array)).not.toContain('值-A'); // ⭐ 守卫失效 → 必红
    harness.unmount();
  }, 20000);
});

/* ===================== ⑥ 源码级：守卫与依赖数组确实写在源码里 ===================== */

describe('useImportedDoc · 源码级守卫（先剔注释再匹配）', () => {
  it('存在 runSeqRef + cancelled 双守卫、且依赖数组含 importedDocx', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/hooks/useImportedDoc.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');

    // 正面锚点：确实读到了非空源码
    expect(source).toContain('useImportedDoc');
    // 双守卫
    expect(code).toMatch(/runSeqRef\.current\s*\+=\s*1|const seq = runSeqRef\.current \+ 1/);
    expect(code).toContain('let cancelled = false');
    expect(code).toMatch(/if\s*\(!active\(\)\)\s*return/);
    // 依赖数组含 importedDocx（漏掉 → 重新上传不刷新）
    expect(code).toMatch(/\[[^\]]*\bimportedDocx\b[^\]]*\]/);
  });
});
