/**
 * ⭐ QA 独立证伪（qa-fix-batch-a，批次A复核）—— 不复述实现者结论，只给可证伪证据。
 *
 * 覆盖主理人指定的四个证伪方向（夹具与实现方 / QA2 均不同）：
 *  ① 文本段数组解包：多选误判、对抗形态（type 缺失 / type:null / text 非字符串 / 嵌套数组 /
 *     原型污染键名）、敏感字段（token/id）绝不外泄、绝不外泄 JSON；
 *  ② 筛选回归：段数组 fixture 下 contains / is / isNot / doesNotContain（真机失效的直接回归），
 *     纯字符串路径零回归（同条件同断言双轨）；
 *  ③ AutoNumber：'0008' 前导零渲染保留、纯数字串数值算子可用、非数字编号对数值算子诚实不命中、
 *     {value:null} / 无 value → empty；
 *  ④ 模板存储：chunkCount=43 独立重算、旧 chunkSize=131072 引用向后兼容（读取逐字节一致）、
 *     写块失败文案前缀逐字保留 + WRITE_CAPACITY_HINT、失败日志四分支载荷。
 *
 * 夹具：字节用 (i*13+seed*41) mod 251（实现方 (i*31+7)、QA2 (i*7+seed*29) mod 256），
 * 段文本 / 记录 id / viewId 均另起，避免「照抄夹具」同错同漏。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldType } from '@/fields/fieldTypes';
import type { DocRenderContext, FieldMetaLite, RenderContext } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { renderCard, renderDoc, getRenderer } from '@/fields/registry';
import { defaultTheme } from '@/config/defaults';
import type { FieldDisplayOptions, ImportedDocx } from '@/config/types';
import type { SdkRecord } from '@/sdk/port';
import { getRecordId } from '@/data/RecordDataSource';
import type { FieldMetaMap } from '@/filter/engine';
import { applyFilterConditions } from '@/filter/engine';
import type { FilterCondition, FilterConfig } from '@/filter/types';
import type { BridgeStore } from '@/sdk/base';
import { logWarn } from '@/utils/log';
import {
  MAX_IMPORTED_DOCX_BYTES,
  TEMPLATE_CHUNK_BASE64_CHARS,
  WRITE_CAPACITY_HINT,
  prepareImportedDocx,
  readImportedDocxBytes,
  templateChunkKey,
  writeImportedDocxChunks,
} from '@/doc/template/storage';

/* 失败日志断言需要拦截 logWarn（vi.mock 提升到文件顶部，仅影响本文件） */
vi.mock('@/utils/log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/* ===================== 脚手架 ===================== */

const textMeta: FieldMetaLite = { id: 'qfa_text', name: '备注', type: FieldType.Text, isPrimary: false };
const urlMeta: FieldMetaLite = { id: 'qfa_url', name: '链接', type: FieldType.Url, isPrimary: false };
const autoMeta: FieldMetaLite = { id: 'qfa_auto', name: '编号', type: FieldType.AutoNumber, isPrimary: false };

const theme = defaultTheme();
const display: FieldDisplayOptions = { maxLines: 1, truncate: 'ellipsis', maxItems: 3, hideWhenEmpty: false };
function rctx(meta: FieldMetaLite): RenderContext {
  return { fieldMeta: meta, display, theme, locale: 'zh-CN' };
}
function dctx(meta: FieldMetaLite): DocRenderContext {
  return { ...rctx(meta), fragmentIndex: 0, fragmentsTotal: 1, showLabel: false, labelText: meta.name };
}
function html(node: ReactNode): string {
  if (node === null || node === undefined || node === false) return '';
  return renderToStaticMarkup(node as ReactElement);
}

function rec(recordId: string, fields: Record<string, unknown> = {}): SdkRecord {
  return { recordId, fields } as unknown as SdkRecord;
}
function ids(records: readonly SdkRecord[]): string[] {
  return records.map((r) => getRecordId(r));
}
function cond(fieldId: string, operator: FilterCondition['operator'], value?: unknown): FilterCondition {
  const c: FilterCondition = { conditionId: `qfa_${fieldId}_${operator}`, fieldId, operator };
  if (value !== undefined) c.value = value;
  return c;
}
function cfg(conditions: FilterCondition[]): FilterConfig {
  return { enabled: true, conjunction: 'and', conditions };
}

/* ============================================================
 * ① 文本段数组解包：对抗形态
 * ============================================================ */

describe('qafix-① · 文本段数组解包（真机 IOpenSegment[] 形态）', () => {
  it('字符串 type 段数组 → 拼接全部 text', () => {
    const nv = normalize(
      [
        { type: 'text', text: '甲方：腾讯' },
        { type: 'text', text: '；乙方：' },
        { type: 'text', text: '某某公司' },
      ],
      textMeta,
    );
    expect(nv).toMatchObject({ kind: 'text', text: '甲方：腾讯；乙方：某某公司', isEmpty: false });
  });

  it('数值 type 段（SDK d.ts 允许）→ 同样解包', () => {
    const nv = normalize([{ type: 1, text: '数值型type段' }], textMeta);
    expect(nv.text).toBe('数值型type段');
  });

  it('mention 段：只取 text，token / id 等敏感字段绝不进 text/display', () => {
    const nv = normalize(
      [
        { type: 'mention', text: '@张三', token: 'secret_token_9', id: 'ou_bad_id' },
        { type: 'text', text: ' 请查收' },
      ],
      textMeta,
    );
    expect(nv.text).toBe('@张三 请查收');
    expect(nv.text).not.toContain('secret_token_9');
    expect(nv.text).not.toContain('ou_bad_id');
    expect(nv.display).not.toContain('secret_token_9');
  });

  it('段数组中间夹空 text 段 → 跳过空段仍拼接其余', () => {
    const nv = normalize(
      [
        { type: 'text', text: '头部' },
        { type: 'text', text: '' },
        { type: 'text', text: '尾部' },
      ],
      textMeta,
    );
    expect(nv.text).toBe('头部尾部');
  });

  it('全部段 text 为空 → 判 empty（不编造内容）', () => {
    expect(normalize([{ type: 'text', text: '' }], textMeta).isEmpty).toBe(true);
  });
});

describe('qafix-① · 多选误判与对抗形态（绝不误拼 / 绝不外泄 JSON）', () => {
  it('多选形态 [{id,text}]（无 type）灌入文本字段 → empty，选项名不外泄', () => {
    const nv = normalize(
      [
        { id: 'optA9', text: '机密选项甲' },
        { id: 'optB7', text: '机密选项乙' },
      ],
      textMeta,
    );
    expect(nv.isEmpty).toBe(true);
    expect(nv.text).toBe('');
    expect(nv.text).not.toContain('机密选项甲');
    expect(nv.text).not.toContain('optA9');
  });

  it('多选形态带 type 字段 [{id,text,type}] → 全元素段结构，仅拼接人可见 text（id 不外泄）', () => {
    // 设计契约：全元素含 type+text 即段数组；text 是人可见文本可拼接，但 id 绝不进入 text
    const nv = normalize(
      [
        { id: 'opt_secret_1', text: '可见甲', type: 'text' },
        { id: 'opt_secret_2', text: '可见乙', type: 'text' },
      ],
      textMeta,
    );
    expect(nv.text).toBe('可见甲可见乙');
    expect(nv.text).not.toContain('opt_secret_1');
    expect(nv.text).not.toContain('opt_secret_2');
  });

  it('混合数组（段 + 多选项）→ 不认定为段数组 → empty，且不外泄任何一侧内容', () => {
    const nv = normalize([{ type: 'text', text: '半段内容' }, { id: 'optZ', text: '半选项' }], textMeta);
    expect(nv.isEmpty).toBe(true);
    expect(nv.text).not.toContain('半段内容');
    expect(nv.text).not.toContain('半选项');
  });

  it('对抗：type 存在但 text 非字符串 → 不是段 → empty（不外泄 "123"/JSON）', () => {
    const nv = normalize([{ type: 'text', text: 123 }], textMeta);
    expect(nv.isEmpty).toBe(true);
    expect(nv.text).toBe('');
  });

  it('对抗：type:null → 不是段 → empty', () => {
    expect(normalize([{ type: null, text: '空type段' }], textMeta).isEmpty).toBe(true);
  });

  it('对抗：type 为对象/布尔 → 不是段 → empty', () => {
    expect(normalize([{ type: { kind: 'text' }, text: 'x' }], textMeta).isEmpty).toBe(true);
    expect(normalize([{ type: true, text: 'x' }], textMeta).isEmpty).toBe(true);
  });

  it('对抗：嵌套数组元素 → 混合 → empty', () => {
    const nv = normalize([[{ type: 'text', text: '内层' }], { type: 'text', text: '外层' }], textMeta);
    expect(nv.isEmpty).toBe(true);
    expect(nv.text).not.toContain('内层');
  });

  it('对抗：原型污染键名（__proto__ / constructor 经 JSON 注入）→ 正常解包且污染值不外泄', () => {
    const raw = JSON.parse(
      '[{"type":"text","text":"正文内容","__proto__":"polluted_val","constructor":"evil_ctor"}]',
    ) as unknown;
    const nv = normalize(raw, textMeta);
    expect(nv.text).toBe('正文内容');
    expect(nv.text).not.toContain('polluted_val');
    expect(nv.text).not.toContain('evil_ctor');
  });

  it('对抗：元素为 null / 标量混入 → empty', () => {
    expect(normalize([null, { type: 'text', text: 'x' }], textMeta).isEmpty).toBe(true);
    expect(normalize(['纯字符串元素', { type: 'text', text: 'x' }], textMeta).isEmpty).toBe(true);
  });

  it('铁律：任何对抗形态的 text/display 都不出现 JSON 结构字符', () => {
    const forms: unknown[] = [
      [{ id: 'a', text: 'b' }],
      [{ type: 'text', text: 1 }],
      [{ type: null, text: 'x' }],
      [['nested']],
      [{ noText: true, type: 'text' }],
    ];
    for (const form of forms) {
      const nv = normalize(form, textMeta);
      expect(nv.text).not.toMatch(/[[\]{"]/);
      expect(nv.display).not.toMatch(/[[\]{"]/);
    }
  });

  it('链接字段段数组 → 拼接各段 text（、分隔）；混合形态 → empty', () => {
    const ok = normalize(
      [
        { type: 'url', text: 'https://a.example', link: 'https://a.example' },
        { type: 'url', text: '飞书文档', link: 'https://b.example' },
      ],
      urlMeta,
    );
    expect(ok.text).toBe('https://a.example、飞书文档');
    expect(ok.text).not.toContain('https://b.example'); // href 不外泄，只留人可见 text
    expect(normalize([{ type: 'url', text: 'x', link: 'y' }, { id: 'z' }], urlMeta).isEmpty).toBe(true);
  });
});

/* ============================================================
 * ② 筛选回归：段数组 fixture + 纯字符串零回归
 * ============================================================ */

const SEG_RECORDS: SdkRecord[] = [
  rec('qfaR1', { qfa_text: [{ type: 'text', text: '合同编号 HT-' }, { type: 'text', text: '2024-88' }] }),
  rec('qfaR2', { qfa_text: [{ type: 'text', text: '无关备注内容' }] }),
  rec('qfaR3', { qfa_text: '合同编号 HT-2024-99' }), // 纯字符串路径（零回归对照）
  rec('qfaR4', { qfa_text: null }), // 空值（isNot / doesNotContain 朴素否定应命中）
];
const SEG_METAS: FieldMetaMap = { qfa_text: textMeta };

describe('qafix-② · 筛选回归：段数组值（真机失效链路的直接回归）', () => {
  it('contains：段数组与纯字符串双轨命中，非命中项被排除', () => {
    expect(ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'contains', '2024')]), SEG_METAS))).toEqual([
      'qfaR1',
      'qfaR3',
    ]);
  });

  it('is：段拼接结果精确相等（区分大小写对照）', () => {
    expect(
      ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'is', '合同编号 HT-2024-88')]), SEG_METAS)),
    ).toEqual(['qfaR1']);
    expect(
      ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'is', '合同编号 ht-2024-88')]), SEG_METAS)),
    ).toEqual([]);
  });

  it('isNot：朴素否定——不匹配项与空值记录均命中', () => {
    expect(
      ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'isNot', '合同编号 HT-2024-88')]), SEG_METAS)),
    ).toEqual(['qfaR2', 'qfaR3', 'qfaR4']);
  });

  it('doesNotContain：朴素否定——不含关键词项与空值记录均命中', () => {
    expect(
      ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'doesNotContain', '合同编号')]), SEG_METAS)),
    ).toEqual(['qfaR2', 'qfaR4']);
  });

  it('纯字符串路径零回归：contains / is 行为与段数组一致', () => {
    expect(ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'contains', 'HT-2024-99')]), SEG_METAS))).toEqual(
      ['qfaR3'],
    );
    expect(
      ids(applyFilterConditions(SEG_RECORDS, cfg([cond('qfa_text', 'is', '合同编号 HT-2024-99')]), SEG_METAS)),
    ).toEqual(['qfaR3']);
  });
});

/* ============================================================
 * ③ AutoNumber：{value,status} 包装解包
 * ============================================================ */

describe('qafix-③ · AutoNumber（IOpenAutoNumber = {value:string,status}）', () => {
  it("{value:'0008'} → 文本语义：text/display 原样保留前导零，且补充 number=8", () => {
    const nv = normalize({ value: '0008', status: 'Completed' }, autoMeta);
    expect(nv).toMatchObject({ kind: 'text', text: '0008', display: '0008', number: 8, isEmpty: false });
  });

  it("渲染层：'0008' 不得渲染成 8（卡片态 + 文档态，走注册表 TextRenderer）", () => {
    expect(getRenderer(FieldType.AutoNumber).key).toBe('text');
    const nv = normalize({ value: '0008', status: 'Completed' }, autoMeta);
    const card = html(renderCard(nv, rctx(autoMeta)));
    const doc = html(renderDoc(nv, dctx(autoMeta)));
    expect(card).toContain('0008');
    expect(doc).toContain('0008');
    expect(card).not.toMatch(/>8</); // 不是「8」单独成文本节点
    expect(doc).not.toMatch(/>8</);
  });

  it("{value:'F-2024-0001'}（非纯数字）→ 文本语义，无 number 字段（数值算子将诚实不命中）", () => {
    const nv = normalize({ value: 'F-2024-0001', status: 'Completed' }, autoMeta);
    expect(nv).toMatchObject({ kind: 'text', text: 'F-2024-0001', display: 'F-2024-0001', isEmpty: false });
    expect('number' in nv).toBe(false);
  });

  it('{value:null} / 无 value 的 {status} → empty（不再静默丢整行，也不误显示）', () => {
    expect(normalize({ value: null, status: 'Running' }, autoMeta).isEmpty).toBe(true);
    expect(normalize({ status: 'Running' }, autoMeta).isEmpty).toBe(true);
    expect(normalize({ value: '   ' }, autoMeta).isEmpty).toBe(true);
  });

  it('裸标量历史形态（编辑器样例卡 number）→ 数字语义不变', () => {
    expect(normalize(1280, autoMeta)).toMatchObject({ kind: 'number', number: 1280, isEmpty: false });
  });

  it('筛选：纯数字串数值算子可用；非数字编号对数值算子诚实不命中；文本相等仍可用', () => {
    const records: SdkRecord[] = [
      rec('qfaA1', { qfa_auto: { value: '0008', status: 'Completed' } }),
      rec('qfaA2', { qfa_auto: { value: '0003', status: 'Completed' } }),
      rec('qfaA3', { qfa_auto: { value: 'QZ-009', status: 'Completed' } }),
      rec('qfaA4', { qfa_auto: { value: null, status: 'Running' } }),
    ];
    const metas: FieldMetaMap = { qfa_auto: autoMeta };
    // is 8 → 数值语义命中 '0008'
    expect(ids(applyFilterConditions(records, cfg([cond('qfa_auto', 'is', 8)]), metas))).toEqual(['qfaA1']);
    // isGreater 5 → 仅 0008；QZ-009 诚实不命中；空值不命中
    expect(ids(applyFilterConditions(records, cfg([cond('qfa_auto', 'isGreater', 5)]), metas))).toEqual(['qfaA1']);
    // is 'QZ-009' → 文本语义命中带前缀编号
    expect(ids(applyFilterConditions(records, cfg([cond('qfa_auto', 'is', 'QZ-009')]), metas))).toEqual(['qfaA3']);
    // isEmpty → {value:null} 命中
    expect(ids(applyFilterConditions(records, cfg([cond('qfa_auto', 'isEmpty')]), metas))).toEqual(['qfaA4']);
  });
});

/* ============================================================
 * ④ 模板存储：块大小 / 向后兼容 / 失败文案与日志
 * ============================================================ */

class QfaStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  /** setData 直接抛错（模拟平台 set block entity error） */
  throwOnWrite: string | null = null;
  /** setData 返回非 true（模拟真机 resolve 非 true） */
  returnValue: unknown = true;

  async getData(key: string): Promise<unknown> {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async setData(key: string, value: unknown): Promise<boolean> {
    if (this.throwOnWrite !== null) throw new Error(this.throwOnWrite);
    if (this.returnValue !== true) return this.returnValue as boolean;
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
    return true;
  }
  onDataChange(): () => void {
    return () => undefined;
  }
}

/** QA 自有字节夹具（mod 251 质数周期，刻意不同于双方） */
function qfaBytes(n: number, seed = 2): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 13 + seed * 41) % 251;
  return b;
}

const QFA_VIEW = 'qafix-view';

describe('qafix-④ · 块大小与 chunkCount 独立重算', () => {
  it('常量 = 32768 且 < 真机实测上限 65536（留至少一倍余量）', () => {
    expect(TEMPLATE_CHUNK_BASE64_CHARS).toBe(32768);
    expect(TEMPLATE_CHUNK_BASE64_CHARS * 2).toBeLessThanOrEqual(65536);
  });

  it('1MB → chunkCount=43（独立复算：⌈ceil(1048576/3)*4 / 32768⌉ = ⌈1398104/32768⌉ = 43）', () => {
    // 独立重算底数：base64 字符数 = ceil(n/3)*4
    const expectedBase64Chars = Math.ceil(MAX_IMPORTED_DOCX_BYTES / 3) * 4;
    expect(expectedBase64Chars).toBe(1398104);
    const expectedChunks = Math.ceil(expectedBase64Chars / TEMPLATE_CHUNK_BASE64_CHARS);
    expect(expectedChunks).toBe(43);
    // ±1 判别力自检：42 / 44 都不是正确答案
    expect(Math.floor(1398104 / 32768)).toBe(42);
    expect(1398104 % 32768).toBeGreaterThan(0);

    const prepared = prepareImportedDocx('qfa-big.docx', qfaBytes(MAX_IMPORTED_DOCX_BYTES, 3), { uploadedAt: 3 });
    expect(prepared.reference.chunkCount).toBe(43);
    expect(prepared.chunks.length).toBe(43);
    // 前 42 块恒为 32768 字符，末块 = 1398104 - 42*32768 = 21048
    expect(prepared.chunks.slice(0, -1).every((c) => c.length === 32768)).toBe(true);
    expect(prepared.chunks[42]!.length).toBe(1398104 - 42 * 32768);
  });
});

describe('qafix-④ · 旧 chunkSize=131072（v1.4.0）引用向后兼容', () => {
  it('引用谎报 chunkSize=131072 + 实际短块 → 读取逐字节一致（读取不消费当前常量）', async () => {
    const store = new QfaStore();
    const bytes = qfaBytes(50, 7);
    const prepared = prepareImportedDocx('qfa-legacy.docx', bytes, {
      chunkChars: 8,
      templateId: 'tpl_qfa_old',
      uploadedAt: 9,
    });
    expect(prepared.reference.chunkCount).toBeGreaterThanOrEqual(2); // 正面锚点：确实多块
    // 构造 v1.4.0 时代引用：chunkSize 是当时的 131072，其余元数据真实
    const legacyRef: ImportedDocx = { ...prepared.reference, chunkSize: 131072 };
    const written = await writeImportedDocxChunks(store, QFA_VIEW, { ...prepared, reference: legacyRef });
    expect(written.ok).toBe(true);

    const read = await readImportedDocxBytes(store, QFA_VIEW, legacyRef);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(Array.from(read.bytes)).toEqual(Array.from(bytes));
    // 反证：若读取按 chunkSize=131072 切块理解，块数对不上必失败 —— 但它成功了
    expect(legacyRef.chunkSize).toBe(131072);
    expect(legacyRef.chunkSize).not.toBe(TEMPLATE_CHUNK_BASE64_CHARS);
  });

  it('读取键只由 templateId + chunkCount 决定（与 chunkSize 无关）：人为按 chunkSize 重排 key 必然缺块失败', async () => {
    const store = new QfaStore();
    const bytes = qfaBytes(30, 4);
    const prepared = prepareImportedDocx('qfa-k.docx', bytes, {
      chunkChars: 8,
      templateId: 'tpl_qfa_k',
      uploadedAt: 1,
    });
    expect((await writeImportedDocxChunks(store, QFA_VIEW, prepared)).ok).toBe(true);
    // 删掉最后一块 → 缺块失败含块号（证明按 chunkCount 逐块读，而非按 chunkSize 推算）
    store.map.delete(templateChunkKey(QFA_VIEW, 'tpl_qfa_k', prepared.reference.chunkCount! - 1));
    const read = await readImportedDocxBytes(store, QFA_VIEW, prepared.reference);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain(`缺少第 ${prepared.reference.chunkCount! - 1} 块`);
  });
});

describe('qafix-④ · 写块失败文案（前缀逐字保留 + WRITE_CAPACITY_HINT）与日志载荷', () => {
  it('setData 抛 set block entity error → 文案 = 既有前缀 + 容量提示；warn 载荷含 templateId/块号/原因', async () => {
    const store = new QfaStore();
    store.throwOnWrite = 'set block entity error';
    const prepared = prepareImportedDocx('qfa-e.docx', qfaBytes(20, 5), {
      chunkChars: 8,
      templateId: 'tpl_qfa_e',
      uploadedAt: 1,
    });
    const written = await writeImportedDocxChunks(store, QFA_VIEW, prepared);
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error('unreachable');
    // 前缀逐字保留（别处按 token 匹配），hint 仅追加
    expect(written.reason.startsWith('写入模板块失败：set block entity error')).toBe(true);
    expect(written.reason.endsWith(WRITE_CAPACITY_HINT)).toBe(true);
    expect(written.reason).toBe(`写入模板块失败：set block entity error${WRITE_CAPACITY_HINT}`);

    const warns = vi.mocked(logWarn).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;
    expect(warns.length).toBe(1);
    const [scope, , payload] = warns[0]!;
    expect(scope).toBe('tpl.store');
    expect(payload).toMatchObject({ phase: 'write-chunk-error', templateId: 'tpl_qfa_e', chunkIndex: 0 });
    expect(typeof payload?.errorText).toBe('string');
  });

  it('setData resolve 非 true（undefined）→ 被拒分支：原样记录返回值 + hint + 载荷含 setDataReturn', async () => {
    const store = new QfaStore();
    store.returnValue = undefined;
    const prepared = prepareImportedDocx('qfa-u.docx', qfaBytes(12, 6), {
      chunkChars: 8,
      templateId: 'tpl_qfa_u',
      uploadedAt: 1,
    });
    const written = await writeImportedDocxChunks(store, QFA_VIEW, prepared);
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error('unreachable');
    expect(written.reason).toContain('写入模板块失败：第 0 块被拒绝（setData 返回 undefined）');
    expect(written.reason.endsWith(WRITE_CAPACITY_HINT)).toBe(true);

    const warns = vi.mocked(logWarn).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;
    expect(warns.length).toBe(1);
    expect(warns[0]![2]).toMatchObject({
      phase: 'write-chunk-rejected',
      templateId: 'tpl_qfa_u',
      chunkIndex: 0,
      setDataReturn: 'undefined',
    });
  });
});
