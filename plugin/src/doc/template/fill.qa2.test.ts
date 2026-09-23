/**
 * QA2 独立复核 —— docx 模板填充层（`./fill`）。
 *
 * 复核的冻结设计：
 *  · 设计4 —— **跨层契约**：`checkTemplate` 判「无问题」的未配对花括号模板，
 *              `fillDocxTemplate` **不得**抛错（因为填充层传了 `allowUnclosedTag/allowUnopenedTag`）。
 *              必配**对照组**：不传该 syntax 时确实抛错（证明确实是这两个选项在起作用）。
 *  · 设计8 —— 单字段读取失败 → 该 tag 留空，其余照常（本文件做**端到端**集成：buildData → fill）。
 *  · D 段   —— **跨 run 占位符**（docx 最经典的坑）：`{` / 字段名 / `}` 分处不同 `<w:r>`。
 *
 * ⚠️ 生成测试 docx 一律用 **pizzip**（同步 `generate`）。禁用 jszip：JSZip 3.0 已移除同步
 *    `generate`，且 vitest 下 `generateAsync({type:'uint8array'})` 返回 Blob 而非字节。
 */
import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { buildTemplateData } from './buildData';
import type { CellStringReader } from './buildData';
import { fillDocxTemplate } from './fill';
import { checkTemplate } from './placeholders';
import type { FieldMetaLike } from './placeholders';

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

function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInner}</w:body></w:document>`
  );
}

/** 现场构造最小可用 docx（Uint8Array），用 pizzip 同步生成 */
function buildDocx(bodyInner: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', documentXml(bodyInner));
  return zip.generate({ type: 'uint8array' }) as Uint8Array;
}

/** `Blob` → `Uint8Array`（jsdom 下优先 `arrayBuffer()`，否则回退 `FileReader`） */
async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const maybe = blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybe.arrayBuffer === 'function') {
    return new Uint8Array(await maybe.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolveBytes, rejectBytes) => {
    const reader = new FileReader();
    reader.onload = () => resolveBytes(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => rejectBytes(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function blobText(blob: Blob): Promise<string> {
  const bytes = await blobToBytes(blob);
  const entry = new PizZip(bytes).file('word/document.xml');
  if (!entry) throw new Error('输出 docx 缺少 word/document.xml');
  return entry.asText().replace(/<[^>]*>/g, '');
}

/* ===================== 设计4：跨层 syntax 契约 ===================== */

describe('QA2 · fill · 设计4（syntax 跨层契约）', () => {
  const FIELDS: FieldMetaLike[] = [
    { id: 'fld_name', name: '客户名称' },
    { id: 'fld_amount', name: '金额' },
  ];

  it('体检判「无问题」的未配对花括号模板 → fillDocxTemplate 不抛错且字面原样保留', async () => {
    // 覆盖三种未配对形态：只有 `{`、只有 `}`、两者都有且合法标签混排
    const literals = ['前{abc后', '前abc}后', 'A{b整段无闭合', '尾部孤立}号', '前abc}后{def'];
    for (const literal of literals) {
      // ① 体检（独立断言它确实「没问题」）
      const health = checkTemplate(literal, FIELDS);
      expect(health.tokens, `literal=${literal}`).toEqual([]);
      expect(health.unmatched).toEqual([]);
      expect(health.ambiguous).toEqual([]);
      expect(health.unclosedLoops).toEqual([]);
      expect(health.unopenedLoops).toEqual([]);
      // ② 填充：不得抛错
      const blob = await fillDocxTemplate(buildDocx(`<w:p><w:r><w:t xml:space="preserve">${literal}</w:t></w:r></w:p>`), {});
      expect(blob).toBeInstanceOf(Blob);
      // 正面锚点：字面文本原样保留（不是空文档）
      expect(await blobText(blob)).toBe(literal);
    }
  });

  it('对照组（分离链路）：库**默认** syntax 对同一模板确实抛错 —— 证明是 syntax 选项在起作用', async () => {
    const bytes = buildDocx('<w:p><w:r><w:t xml:space="preserve">前{abc后</w:t></w:r></w:p>');

    // 对照组：直接构造 docxtemplater，**不传** syntax
    const { default: Docxtemplater } = await import('docxtemplater');
    expect(
      () => new Docxtemplater(new PizZip(bytes), { paragraphLoop: true, linebreaks: true, nullGetter: () => '' }),
    ).toThrow();

    // 实验组：我们的 fillDocxTemplate（显式放开）→ 不抛错
    await expect(fillDocxTemplate(bytes, {})).resolves.toBeInstanceOf(Blob);
  });
});

/* ===================== D 段：跨 run 占位符 ===================== */

describe('QA2 · fill · D 段（跨 run 占位符）', () => {
  it('`{` / 字段名 / `}` 分处 3 个 <w:r> → 正确替换为值', async () => {
    const split =
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">客户：{</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">客户名称</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">}</w:t></w:r>' +
      '</w:p>';
    const text = await blobText(await fillDocxTemplate(buildDocx(split), { 客户名称: '王五' }));

    expect(text).toBe('客户：王五');
    // 否定式断言配正面锚点：值出现（上方已锁），拆散的三件套都消失
    expect(text).not.toContain('{');
    expect(text).not.toContain('}');
    expect(text).not.toContain('客户名称');
  });

  it('更碎：`{` / 名 / 名 / `}` 分处 4 个 <w:r> → 仍正确替换', async () => {
    const split =
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">X{</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">客户</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">名称</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">}Y</w:t></w:r>' +
      '</w:p>';
    const text = await blobText(await fillDocxTemplate(buildDocx(split), { 客户名称: '赵六' }));

    expect(text).toBe('X赵六Y');
    expect(text).not.toContain('客户名称');
  });

  it('（对照）单 run 同一模板同样成功 —— 证明装置可用，跨 run 的红只可能来自「未兜底 run 切分」', async () => {
    const single = buildDocx('<w:p><w:r><w:t xml:space="preserve">客户：{客户名称}</w:t></w:r></w:p>');
    expect(await blobText(await fillDocxTemplate(single, { 客户名称: '王五' }))).toBe('客户：王五');
  });

  it('跨 run 的循环段 `{#明细}…{/明细}`：开始/结束标签各拆进两个 run → 仍展开', async () => {
    const split =
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">{#</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">明细}</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">行:{项目};</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">{/</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">明细}</w:t></w:r>' +
      '</w:p>';
    const text = await blobText(
      await fillDocxTemplate(buildDocx(split), { 明细: [{ 项目: '甲' }, { 项目: '乙' }] }),
    );
    expect(text).toBe('行:甲;行:乙;');
  });
});

/* ===================== 设计8（端到端集成）：读取失败不中断 → 填充后其余照常 ===================== */

describe('QA2 · fill · 设计8 端到端（buildData → fillDocxTemplate）', () => {
  it('中间字段读取失败 → 该占位符留空，其余字段照常填入文档', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'f_a', name: 'A' },
      { id: 'f_b', name: 'B' },
      { id: 'f_c', name: 'C' },
    ];
    const reader: CellStringReader = async (fieldId, recordId) => {
      if (fieldId === 'f_b') throw new Error('B 读取失败');
      return `${fieldId}=${recordId}`;
    };

    const { data, report } = await buildTemplateData({
      templateText: '{A} {B} {C}',
      fields,
      recordId: 'r1',
      readCellString: reader,
    });
    expect(report.failedReads.map((x) => x.tag)).toEqual(['B']);

    const body = '<w:p><w:r><w:t xml:space="preserve">A:{A} B:{B} C:{C}</w:t></w:r></w:p>';
    const text = await blobText(await fillDocxTemplate(buildDocx(body), data));

    // B 留空，A/C 照常（正面锚点）
    expect(text).toBe('A:f_a=r1 B: C:f_c=r1');
    expect(text).toContain('f_a=r1');
    expect(text).toContain('f_c=r1');
    expect(text).not.toContain('{');
  });
});
