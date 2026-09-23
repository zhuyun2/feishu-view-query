/**
 * `doc/template/renderDocx` 单测 —— docx 模板**保真渲染层**。
 *
 * 断言策略（团队铁律：**禁止假绿**）：
 *  - 一律锁定**具体结构 / 数值**（section 计数、具体文本），不用可恒真的断言；
 *  - ⭐ **拍平行为是判别式**：同一份**含分页符**的 docx，`{breakPages:false}` → 1 个 section，
 *    `{breakPages:true}` → 2 个。**只断言「1 个 section」是弱断言**（「根本没渲染出 section」也会通过），
 *    必须两条对照；
 *  - **否定式断言配正面锚点**（如「失败后容器被清空」同时断言失败前确实渲染出了 section）；
 *  - **源码级断言先剔注释再匹配**（本文件头注释里就写着 `docx-preview` / `import`，不剔注释会骗过自己）。
 *
 * 现场生成最小 docx（zip 内含 `[Content_Types].xml` / `_rels/.rels` / `word/document.xml`），
 * 不依赖任何外部 fixture —— 与「docx 导入」探针做法一致。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { formatError } from '@/utils/errorText';
import { DEFAULT_RENDER_DOCX_OPTIONS, renderDocxInto } from './renderDocx';

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

/** 段落（`xml:space="preserve"` 保留首尾空白，便于精确文本断言） */
function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** 显式分页符 */
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInner}</w:body></w:document>`
  );
}

/**
 * 生成最小 docx（`Uint8Array`）。
 * 用 **PizZip**（同步、返回真正的 `Uint8Array`）—— 与「docx 导入」探针做法一致。
 * ⚠️ 不用 jszip：vitest 下 `jszip` 解析到其浏览器 UMD，`generateAsync({type:'uint8array'})`
 *    会给出 `Blob`（非字节、`length` 为 0），喂给 docx-preview 只会得到「corrupted zip」。
 */
function buildDocx(bodyInner: string): Uint8Array {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/document.xml', documentXml(bodyInner));
  return zip.generate({ type: 'uint8array' });
}

function newContainer(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** docx-preview 的产物标识：`<section class="docx">` —— 个数即「页数」 */
function sectionCount(element: HTMLElement): number {
  return element.querySelectorAll('section.docx').length;
}

/* ===================== ① 基本渲染 ===================== */

describe('renderDocxInto · 基本渲染', () => {
  it('最小 docx → 容器出现 .docx section，且文本包含预期文字', async () => {
    const container = newContainer();
    await renderDocxInto(container, buildDocx(para('HELLO-DOCX-客户名称')));

    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('HELLO-DOCX-客户名称');
    // 正面锚点：文字确实在 section 内部（而非散落在容器别处）
    expect(container.querySelector('section.docx')?.textContent).toContain('HELLO-DOCX-客户名称');
  });

  it('接受 ArrayBuffer（与 Uint8Array 等价）', async () => {
    const container = newContainer();
    const bytes = buildDocx(para('从 ArrayBuffer 渲染'));
    await renderDocxInto(container, bytes.buffer as ArrayBuffer);

    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('从 ArrayBuffer 渲染');
  });
});

/* ===================== ② ⭐ 拍平判别式（breakPages） ===================== */

describe('renderDocxInto · ⭐ 拍平判别式（含分页符的 docx）', () => {
  const body = para('第一页') + PAGE_BREAK + para('第二页');

  it('同一份含分页符的 docx：breakPages:false → 1 个 section；breakPages:true → 2 个', async () => {
    const bytes = buildDocx(body);

    const flat = newContainer();
    await renderDocxInto(flat, bytes, { breakPages: false, ignoreHeight: true });

    const paged = newContainer();
    await renderDocxInto(paged, bytes, { breakPages: true, ignoreHeight: true });

    // ⭐ 判别式：1 vs 2 —— 「1」单独看是弱断言（「没渲染出 section」也会通过），两条对照才有判别力
    expect(sectionCount(flat)).toBe(1);
    expect(sectionCount(paged)).toBe(2);

    // 正面锚点：两个容器都确实渲染出了文本（证明「1 个 section」不是「什么都没渲染」）
    expect(flat.textContent).toContain('第一页');
    expect(flat.textContent).toContain('第二页');
    expect(paged.textContent).toContain('第一页');
    expect(paged.textContent).toContain('第二页');
  });

  it('不传 options 时即拍平默认值 → 1 个 section（锁定默认值）', async () => {
    const container = newContainer();
    await renderDocxInto(container, buildDocx(body)); // 不传 options

    expect(sectionCount(container)).toBe(1);
    expect(container.textContent).toContain('第二页');
    expect(DEFAULT_RENDER_DOCX_OPTIONS).toEqual({ breakPages: false, ignoreHeight: true });
  });
});

/* ===================== ③ 重复渲染不叠加 ===================== */

describe('renderDocxInto · 重复渲染不叠加', () => {
  it('同一容器连续渲染两次 → 恰好 1 个 section（不是 2 个）', async () => {
    const container = newContainer();
    const bytes = buildDocx(para('只应出现一次'));

    await renderDocxInto(container, bytes);
    expect(sectionCount(container)).toBe(1); // 正面锚点：第一次确实渲染出来了

    await renderDocxInto(container, bytes);
    expect(sectionCount(container)).toBe(1); // 第二次不得叠加
    expect(container.textContent).toContain('只应出现一次');
  });
});

/* ===================== ④ 错误路径：失败必须清空 ===================== */

describe('renderDocxInto · 错误路径', () => {
  it('坏字节 → 抛出（不静默），且容器被清空（不残留上一条内容）', async () => {
    const container = newContainer();
    await renderDocxInto(container, buildDocx(para('上一条内容')));
    expect(sectionCount(container)).toBe(1); // 正面锚点：先有内容

    const bad = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    let caught: unknown = null;
    try {
      await renderDocxInto(container, bad);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(formatError(caught)).not.toBe('[object Object]');
    expect(formatError(caught).length).toBeGreaterThan(0);
    // 失败后必须已清空 —— 否则用户看到的仍是上一条内容（且不报错）
    expect(sectionCount(container)).toBe(0);
  });
});

/* ===================== ⑤ 源码级守卫 ===================== */

/** 去掉块注释与行注释（源码级正则必须先在无注释文本上匹配） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const RAW_SOURCE = readFileSync(resolve(process.cwd(), 'src/doc/template/renderDocx.ts'), 'utf8');
const SOURCE = stripComments(RAW_SOURCE);

describe('renderDocx · 源码级守卫', () => {
  it('不静态 import docx-preview（只允许动态 import()，否则主入口 +441KiB）', () => {
    // 注释已剔除 —— 本文件头注释里就写着 docx-preview / import
    expect(SOURCE).not.toMatch(/import\s+[^;]*?\sfrom\s*['"]docx-preview['"]/);
    expect(SOURCE).not.toMatch(/require\(\s*['"]docx-preview['"]\s*\)/);
    expect(SOURCE).not.toMatch(/from\s*['"]docx-preview['"]/);
    // 正面锚点：确实用了**动态** import（否则上面的负断言可能因「根本没 import」而恒真）
    expect(SOURCE).toMatch(/import\(\s*['"]docx-preview['"]\s*\)/);
  });

  it('代码内含「刻意分歧」说明（防将来被"顺手统一"，改版用户模板且不报错）', () => {
    expect(RAW_SOURCE).toContain('刻意分歧');
    expect(RAW_SOURCE).toContain('getContentBox');
  });
});
