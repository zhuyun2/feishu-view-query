import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCX_MIME, DocxTemplateFillError, fillDocxTemplate, toDocxFillError } from './fill';
import { checkTemplate } from './placeholders';
import type { FieldMetaLike } from './placeholders';

/**
 * `doc/template/fill` 单测（「模板导入」第 2a 步：模板字节 + 数据 → 填好的 docx 字节）。
 *
 * 断言策略（团队铁律：**禁止假绿**）：
 *  - 一律**锁定具体内容**：解包输出后对 `word/document.xml` 的**纯文本**做精确相等断言，
 *    不用 `toBeTruthy()` / `toContain('')` 之类可恒真的断言充当语义验证；
 *  - **否定式断言必配正面锚点**：断言「占位符原文消失」的同时，必断言「填入的值出现」，
 *    防「整份渲染成空 → 目标消失 → 恒真」；
 *  - **两条链路可能同值处，fixture 必须分离**：跨 run 用例把 `{` / `字段名` / `}` 拆进 3 个
 *    `<w:r>`（朴素的「逐 run 替换」必然失败），并配一条**单 run 对照**证明测试装置本身可用；
 *  - **源码级断言先剔注释再匹配**：`fill.ts` 的注释里写着 `import('pizzip')` / `allowUnclosedTag`
 *    等字样，不剔注释的正则会骗过自己。
 *
 * ⭐ 与 `placeholders.ts` 的**契约锁定**：见 `⭐ syntax 契约` 一节——把「体检判无问题 ⇒ 填充不抛错」
 *    钉死。将来若有人删掉 `syntax: { allowUnclosedTag, allowUnopenedTag }`，该节必红。
 */

/* ===================== 现场生成最小 docx（docx 本质是 zip） ===================== */

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

/** 组装 `word/document.xml`（`<w:body>` 内注入给定片段） */
function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInner}</w:body></w:document>`
  );
}

/**
 * 现场构造一个**最小可用** .docx（`Uint8Array`）。
 * 包内必含：`[Content_Types].xml` / `_rels/.rels` / `word/_rels/document.xml.rels` / `word/document.xml`。
 */
async function buildMinimalDocx(bodyInner: string): Promise<Uint8Array> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', documentXml(bodyInner));
  return zip.generate({ type: 'uint8array' }) as Uint8Array;
}

/** 构造一个**不是 docx** 的 zip（只含一个文本文件）——用于触发 docxtemplater 的「无法识别文件类型」错误 */
async function buildNonDocxZip(): Promise<Uint8Array> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip();
  zip.file('hello.txt', 'this is not a docx');
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

/** 解包 docx 读回 `word/document.xml` 原文 */
async function readDocumentXml(bytes: Uint8Array): Promise<string> {
  const { default: PizZip } = await import('pizzip');
  const entry = new PizZip(bytes).file('word/document.xml');
  if (!entry) throw new Error('输出 docx 缺少 word/document.xml');
  return entry.asText();
}

/** `word/document.xml` → 可见纯文本（剥掉全部标签；对 run 切分不敏感） */
function plainText(xml: string): string {
  return xml.replace(/<[^>]*>/g, '');
}

/** Blob → 可见纯文本（封装：解包 + 剥标签） */
async function blobText(blob: Blob): Promise<string> {
  return plainText(await readDocumentXml(await blobToBytes(blob)));
}

/* ===================== 字段夹具（供「体检契约」用例） ===================== */

const FIELDS: FieldMetaLike[] = [
  { id: 'fld_name', name: '客户名称' },
  { id: 'fld_amount', name: '金额' },
];

/* ===================== ① 现场生成最小 docx → 填充 → 解包核对 ===================== */

describe('docx/template/fill · ① 现场生成 docx 填充', () => {
  it('单 run `{客户名称}` → 值进入 document.xml，占位符原文消失；返回 docx MIME 的 Blob', async () => {
    const bytes = await buildMinimalDocx(
      '<w:p><w:r><w:t xml:space="preserve">客户：{客户名称}</w:t></w:r></w:p>',
    );
    const blob = await fillDocxTemplate(bytes, { 客户名称: '张三' });

    // ① Blob 形态与 MIME
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(DOCX_MIME);

    // ② 解包后的纯文本精确相等（正面锚点：填入的值在；否定：原文不在）
    const text = await blobText(blob);
    expect(text).toBe('客户：张三');
    expect(text).not.toContain('{客户名称}');
    expect(text).not.toContain('客户名称');
  });

  it('接受 `ArrayBuffer` 入参（与 `Uint8Array` 等价）', async () => {
    const bytes = await buildMinimalDocx('<w:p><w:r><w:t xml:space="preserve">甲：{客户名称}</w:t></w:r></w:p>');
    // 取 `.buffer` 切片得到真正的 ArrayBuffer
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const text = await blobText(await fillDocxTemplate(buffer, { 客户名称: '李四' }));
    expect(text).toBe('甲：李四');
  });
});

/* ===================== ② 跨 run / 缺键 / 循环 ===================== */

describe('docx/template/fill · ② 经典坑：跨 run / 缺键 / 循环', () => {
  it('⭐ 跨 run 占位符：`{` / `客户名称` / `}` 分处 3 个 <w:r> → 仍被正确替换', async () => {
    const split =
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">客户：{</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">客户名称</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve">}</w:t></w:r>' +
      '</w:p>';
    const text = await blobText(await fillDocxTemplate(await buildMinimalDocx(split), { 客户名称: '王五' }));

    expect(text).toBe('客户：王五');
    // 否定式断言配正面锚点：值出现（上方 toBe 已锁），且拆散的标签三件套都消失
    expect(text).not.toContain('{');
    expect(text).not.toContain('}');
    expect(text).not.toContain('客户名称');
  });

  it('（对照）单 run 同一模板同样成功 —— 证明装置可用，跨 run 的红只可能来自「未兜底 run 切分」', async () => {
    const single = await buildMinimalDocx(
      '<w:p><w:r><w:t xml:space="preserve">客户：{客户名称}</w:t></w:r></w:p>',
    );
    expect(await blobText(await fillDocxTemplate(single, { 客户名称: '王五' }))).toBe('客户：王五');
  });

  it('⭐ 数据缺键：模板有 `{不存在}` 而 data 没有该键 → 不抛错，该处为空（其余照常填充）', async () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">甲方：{客户名称}；缺失：{不存在}；</w:t></w:r></w:p>';
    const bytes = await buildMinimalDocx(body);

    // 不抛错（正面锚点：确实产出了 Blob，而非静默返回 undefined）
    const blob = await fillDocxTemplate(bytes, { 客户名称: 'ACME' });
    expect(blob).toBeInstanceOf(Blob);

    const text = await blobText(blob);
    // 精确锁定：存在的键填空值，缺失的键留空
    expect(text).toBe('甲方：ACME；缺失：；');
    expect(text).toContain('ACME'); // 正面锚点（防「整份为空 → 恒真」）
    expect(text).not.toContain('不存在');
    expect(text).not.toContain('{');
  });

  it('⭐ 循环段 `{#明细}…{/明细}`：数组 → 展开为多份且**顺序正确**', async () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">{#明细}行:{项目};{/明细}</w:t></w:r></w:p>';
    const bytes = await buildMinimalDocx(body);
    const text = await blobText(
      await fillDocxTemplate(bytes, { 明细: [{ 项目: '甲' }, { 项目: '乙' }, { 项目: '丙' }] }),
    );

    // 展开份数 = 数组长度
    expect(text.match(/行:/g)?.length).toBe(3);
    // 精确锁定顺序（若实现倒序 / 去重，本断言必红）
    expect(text).toBe('行:甲;行:乙;行:丙;');
    expect(text.indexOf('行:甲;')).toBeLessThan(text.indexOf('行:乙;'));
    expect(text.indexOf('行:乙;')).toBeLessThan(text.indexOf('行:丙;'));
  });
});

/* ===================== ⭐ syntax 契约：未配对花括号（与 placeholders 钉死） ===================== */

describe('docx/template/fill · ⭐ syntax 契约（未配对花括号）', () => {
  it('体检判「无占位符问题」的未配对花括号模板 → 填充**不抛错**且原样保留', async () => {
    for (const literal of ['前{abc后', '前abc}后']) {
      // ① 上游体检：不产出占位符、无 unmatched / ambiguous / 循环问题（= 「没问题」）
      const health = checkTemplate(literal, FIELDS);
      expect(health.tokens).toEqual([]);
      expect(health.unmatched).toEqual([]);
      expect(health.ambiguous).toEqual([]);
      expect(health.unclosedLoops).toEqual([]);
      expect(health.unopenedLoops).toEqual([]);

      // ② 下游填充：因为传了 allowUnclosedTag/allowUnopenedTag，**不得**抛错
      const bytes = await buildMinimalDocx(
        `<w:p><w:r><w:t xml:space="preserve">${literal}</w:t></w:r></w:p>`,
      );
      const blob = await fillDocxTemplate(bytes, {});
      // 正面锚点：确实产出 Blob（不是静默 undefined），且字面文本原样保留
      expect(blob).toBeInstanceOf(Blob);
      expect(await blobText(blob)).toBe(literal);
    }
  });

  it('对照（分离两条链路）：库**默认** syntax 对同一模板会抛错 —— 证明确实是 syntax 选项救了它', async () => {
    const bytes = await buildMinimalDocx('<w:p><w:r><w:t xml:space="preserve">前{abc后</w:t></w:r></w:p>');

    // 对照组：不传 syntax 选项（默认 allowUnclosedTag/allowUnopenedTag = false）→ 编译即抛错
    const { default: PizZip } = await import('pizzip');
    const { default: Docxtemplater } = await import('docxtemplater');
    const plainZip = new PizZip(bytes);
    expect(
      () =>
        new Docxtemplater(plainZip, {
          paragraphLoop: true,
          linebreaks: true,
          nullGetter: () => '',
        }),
    ).toThrow();

    // 实验组：我们的 fillDocxTemplate（显式放开）→ 不抛错
    await expect(fillDocxTemplate(bytes, {})).resolves.toBeInstanceOf(Blob);
  });
});

/* ===================== ③ 错误可诊断（可读文案，绝不 [object Object]） ===================== */

describe('docx/template/fill · ③ 错误可诊断', () => {
  it('非 docx 的 zip → 抛 DocxTemplateFillError，message 含可读解释（非 [object Object]）', async () => {
    const bytes = await buildNonDocxZip();

    // 正面锚点：确实抛了错（不是静默返回）
    await expect(fillDocxTemplate(bytes, {})).rejects.toBeInstanceOf(DocxTemplateFillError);

    let caught: unknown;
    try {
      await fillDocxTemplate(bytes, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DocxTemplateFillError);
    const failure = caught as DocxTemplateFillError;

    // 可读：含库给出的英文解释片段
    expect(failure.message).toContain('could not be identified');
    expect(failure.message).not.toContain('[object Object]');
    // details 非空且与 message 同源（不是一句无信息量的兜底）
    expect(failure.details.length).toBeGreaterThan(0);
    expect(failure.details[0]).toContain('could not be identified');
    // 原始错误被保留在 cause 上，便于日志
    expect(failure.cause).toBeDefined();
  });

  it('未闭合循环 `{#明细}` → 抛出可读 diagnostics（含 explanation 与「位置」），绝不 [object Object]', async () => {
    const bytes = await buildMinimalDocx(
      '<w:p><w:r><w:t xml:space="preserve">{#明细}内容</w:t></w:r></w:p>',
    );

    await expect(fillDocxTemplate(bytes, { 明细: [] })).rejects.toBeInstanceOf(DocxTemplateFillError);

    let caught: unknown;
    try {
      await fillDocxTemplate(bytes, { 明细: [] });
    } catch (err) {
      caught = err;
    }
    const failure = caught as DocxTemplateFillError;

    expect(failure.message).toContain('is unclosed'); // 库给出的 explanation
    expect(failure.message).toContain('位置'); // 我们附加的 offset 定位
    expect(failure.message).not.toContain('[object Object]');
    expect(failure.details[0]).toContain('is unclosed');
    expect(String(failure)).not.toContain('[object Object]');
  });

  it('toDocxFillError 对各类非 Error 形态都不产出 [object Object]', () => {
    // ① 含 explanation 的普通对象 → 取 explanation
    const withExplanation = toDocxFillError({ properties: { explanation: 'boom reason', offset: 7 } });
    expect(withExplanation.message).toContain('boom reason');
    expect(withExplanation.message).toContain('位置 7');
    expect(withExplanation.message).not.toContain('[object Object]');

    // ② `{ code, msg }` 普通对象（SDK 常见形态）→ formatError 归一出 `code=... ...`
    const sdkLike = toDocxFillError({ code: 500, msg: 'server boom' });
    expect(sdkLike.message).toContain('code=500 server boom');

    // ③ 字符串 → 原样
    expect(toDocxFillError('plain failure').message).toContain('plain failure');

    // ④ 真正的 Error → message
    expect(toDocxFillError(new Error('real error')).message).toContain('real error');

    // 全部都不含 [object Object]
    for (const message of [withExplanation.message, sdkLike.message, toDocxFillError('x').message]) {
      expect(message).not.toContain('[object Object]');
    }
  });
});

/* ===================== ④ 源码级守卫 ===================== */

/** 去掉块注释与行注释（源码级正则必须先在无注释文本上匹配，否则注释里的同形内容会骗过断言） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ⚠️ 不用 `import.meta.url`（vitest 的 Vite 转换下不是 file: URL）；vitest 的 cwd 恒为插件根目录。
const SOURCE = stripComments(readFileSync(resolve(process.cwd(), 'src/doc/template/fill.ts'), 'utf8'));

describe('docx/template/fill · ④ 源码级守卫', () => {
  it('依赖一律**动态** import：无 `docxtemplater`/`pizzip` 的静态 import、无 require', () => {
    // 注释已剔除——文件头注释里就写着 import('pizzip') 等字样
    expect(SOURCE).not.toMatch(/from\s*['"](?:pizzip|docxtemplater)['"]/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    // 正面锚点：确实走的是动态 import()
    expect(SOURCE).toMatch(/import\(\s*['"]pizzip['"]\s*\)/);
    expect(SOURCE).toMatch(/import\(\s*['"]docxtemplater['"]\s*\)/);
  });

  it('⭐ 显式放开未配对标签：`allowUnclosedTag` / `allowUnopenedTag` 均为 true', () => {
    expect(SOURCE).toMatch(/allowUnclosedTag:\s*true/);
    expect(SOURCE).toMatch(/allowUnopenedTag:\s*true/);
  });

  it('未匹配占位符填**空串**（nullGetter 返回空字符串常量），不抛错', () => {
    expect(SOURCE).toMatch(/nullGetter\s*:\s*\(\s*\)\s*=>\s*''/);
  });

  it('错误一律经 `toDocxFillError` 包装（不透传原始错误），并复用 `formatError` 兜底', () => {
    expect(SOURCE).toMatch(/throw\s+toDocxFillError\(/);
    expect(SOURCE).not.toMatch(/\bthrow\s+err\b/);
    expect(SOURCE).toMatch(/from\s*['"]@\/utils\/errorText['"]/);
  });

  it('MIME 常量为 docx 官方类型', () => {
    expect(DOCX_MIME).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});
