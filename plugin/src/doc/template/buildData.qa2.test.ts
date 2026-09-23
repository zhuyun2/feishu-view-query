/**
 * QA2 独立复核 —— docx 模板装配层（`./buildData`）。
 *
 * 复核的冻结设计：
 *  · 设计8 —— 单字段读取失败**不中断整体**：该 tag 留空 + `failedReads`，其余照常填。
 *  · 约束   —— 只取模板用到的字段；循环行内键**恰为**解析出的 inner；
 *              重名绝不静默取首个；并发闸门；确定性。
 *
 * 另含 C 段边界：重复占位符只读一次、循环引用不存在字段、并发上限（100 字段峰值）、
 * 以及一个**缺陷举证**（见文末 `【缺陷举证】`）——字段名取 `__proto__` 时 `data` 会静默丢失该键。
 */
import { describe, expect, it } from 'vitest';
import { buildTemplateData } from './buildData';
import type { CellStringReader, LinkedRecordIdsReader } from './buildData';
import type { FieldMetaLike } from './placeholders';

/* ===================== stub ===================== */

interface ReadLog {
  fieldId: string;
  recordId: string;
  inFlight: number;
}

/** 确定性读取器：返回 `${fieldId}|${recordId}`（两条链路必然分离），记录并发峰值，可指定抛错字段 */
function makeReader(options?: { throwFor?: ReadonlySet<string>; delayMs?: number }): {
  reader: CellStringReader;
  maxInFlight: () => number;
  calls: () => ReadLog[];
} {
  const throwFor = options?.throwFor ?? new Set<string>();
  const delayMs = options?.delayMs ?? 0;
  const log: ReadLog[] = [];
  let inFlight = 0;
  let peak = 0;

  const reader: CellStringReader = async (fieldId, recordId) => {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    log.push({ fieldId, recordId, inFlight });
    try {
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
      if (throwFor.has(fieldId)) throw new Error(`读取失败：${fieldId}`);
      return `${fieldId}|${recordId}`;
    } finally {
      inFlight -= 1;
    }
  };

  return { reader, maxInFlight: () => peak, calls: () => log };
}

function makeLinkedReader(map: Record<string, string[]>): LinkedRecordIdsReader {
  return async (fieldId) => map[fieldId] ?? [];
}

/* ===================== 设计8：读取失败不中断 ===================== */

describe('QA2 · buildData · 设计8（读取失败不中断整体）', () => {
  it('**中间**字段读取抛错 → 只它留空，前后两字段都照常填好（三重断言）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'f_a', name: 'A' },
      { id: 'f_b', name: 'B' },
      { id: 'f_c', name: 'C' },
    ];
    const { reader } = makeReader({ throwFor: new Set(['f_b']) });

    const { data, report } = await buildTemplateData({
      templateText: '{A}-{B}-{C}',
      fields,
      recordId: 'rec1',
      readCellString: reader,
    });

    // 命中字段照常（正面锚点：A / C 都被填，证明整体没被打断）
    expect(data['A']).toBe('f_a|rec1');
    expect(data['C']).toBe('f_c|rec1');
    // 失败字段留空（键不存在）
    expect('B' in data).toBe(false);
    // 报告精确
    expect(report.failedReads).toEqual([{ tag: 'B', fieldId: 'f_b', reason: '读取失败：f_b' }]);
    expect(report.filled).toEqual([
      { tag: 'A', fieldId: 'f_a' },
      { tag: 'C', fieldId: 'f_c' },
    ]);
  });

  it('循环段某行某格抛错 → 该格留空、同行另一格与其余行照常（不受影响）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'f_loop', name: '明细' },
      { id: 'f_x', name: 'x' },
      { id: 'f_y', name: 'y' },
    ];
    const reader: CellStringReader = async (fieldId, recordId) => {
      if (fieldId === 'f_y' && recordId === 'r2') throw new Error('y@r2 boom');
      return `${fieldId}|${recordId}`;
    };

    const { data } = await buildTemplateData({
      templateText: '{#明细}{x}{y}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: makeLinkedReader({ f_loop: ['r1', 'r2', 'r3'] }),
    });

    const rows = data['明细'] as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ x: 'f_x|r1', y: 'f_y|r1' });
    expect(rows[1]).toEqual({ x: 'f_x|r2' }); // y 失败 → 键缺失，同行 x 仍在
    expect(rows[2]).toEqual({ x: 'f_x|r3', y: 'f_y|r3' });
  });
});

/* ===================== 契约 / 边界 ===================== */

describe('QA2 · buildData · 契约与边界', () => {
  it('同一占位符 `{a}{a}` 出现两次 → 只读一次、data 只有一个键', async () => {
    const fields: FieldMetaLike[] = [{ id: 'f_a', name: 'a' }];
    const { reader, calls } = makeReader();

    const { data } = await buildTemplateData({
      templateText: '{a}{a}',
      fields,
      recordId: 'r',
      readCellString: reader,
    });

    expect(calls().length).toBe(1);
    expect(data).toEqual({ a: 'f_a|r' });
  });

  it('循环段引用**不存在的字段** → 不抛错；行数仍等于子记录数，行内键为空', async () => {
    const fields: FieldMetaLike[] = [{ id: 'f_loop', name: '明细' }]; // 段内字段均不存在
    const { reader } = makeReader();

    const { data, report } = await buildTemplateData({
      templateText: '{#明细}{不存在的甲}{不存在的乙}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: makeLinkedReader({ f_loop: ['r1', 'r2'] }),
    });

    const rows = data['明细'] as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2); // 行数由子记录决定，与段内字段是否命中无关
    expect(rows).toEqual([{}, {}]);
    expect(report.loops).toEqual([{ tag: '明细', fieldId: 'f_loop', rows: 2 }]);
  });

  it('循环段无段内占位符 `{#明细}固定文本{/明细}` → 行数为子记录数（渲染次数正确）', async () => {
    const fields: FieldMetaLike[] = [{ id: 'f_loop', name: '明细' }];
    const { reader } = makeReader();

    const { data } = await buildTemplateData({
      templateText: '{#明细}固定文本{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: makeLinkedReader({ f_loop: ['r1', 'r2', 'r3'] }),
    });

    expect(data['明细']).toEqual([{}, {}, {}]);
  });

  it('并发上限：100 个字段 → 「同时在飞」峰值 ≤ 默认上限 6 且 > 1（非串行）', async () => {
    const fields: FieldMetaLike[] = Array.from({ length: 100 }, (_u, i) => ({
      id: `fld_${i}`,
      name: `字段${i}`,
    }));
    const { reader, maxInFlight } = makeReader({ delayMs: 5 });

    const { data } = await buildTemplateData({
      templateText: fields.map((f) => `{${f.name}}`).join(' '),
      fields,
      recordId: 'rec',
      readCellString: reader,
    });

    expect(maxInFlight()).toBeLessThanOrEqual(6);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(Object.keys(data).length).toBe(100);
  });

  it('并发上限：显式 concurrency=2，100 字段 → 峰值 ≤ 2 且 > 1', async () => {
    const fields: FieldMetaLike[] = Array.from({ length: 100 }, (_u, i) => ({
      id: `fld_${i}`,
      name: `字段${i}`,
    }));
    const { reader, maxInFlight } = makeReader({ delayMs: 5 });

    await buildTemplateData({
      templateText: fields.map((f) => `{${f.name}}`).join(' '),
      fields,
      recordId: 'rec',
      readCellString: reader,
      concurrency: 2,
    });

    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it('设计3：字段重名 → 该 tag 在 data 中**不存在** + `skippedAmbiguous`；同模板唯一字段照常填', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'dup_a', name: '同名' },
      { id: 'dup_b', name: '同名' },
      { id: 'f_u', name: '唯一' },
    ];
    const { reader, calls } = makeReader();

    const { data, report } = await buildTemplateData({
      templateText: '{同名} / {唯一}',
      fields,
      recordId: 'r1',
      readCellString: reader,
    });

    expect('同名' in data).toBe(false);
    expect(data['同名']).toBeUndefined();
    expect(report.skippedAmbiguous).toEqual(['同名']);
    // 重名字段一个都没被读（绝不偷偷挑一个）
    expect(calls().some((c) => c.fieldId === 'dup_a' || c.fieldId === 'dup_b')).toBe(false);
    // 正面锚点：唯一字段照常被填（防「整份为空 → 恒真」）
    expect(data['唯一']).toBe('f_u|r1');
    expect(report.filled).toEqual([{ tag: '唯一', fieldId: 'f_u' }]);
  });

  it('确定性：同输入连跑 3 次，`data` / `report` 深等，且内容非空（配正面锚点）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'f_name', name: '客户名称' },
      { id: 'f_loop', name: '明细' },
      { id: 'f_x', name: 'x' },
    ];
    const run = async (): Promise<Awaited<ReturnType<typeof buildTemplateData>>> => {
      const { reader } = makeReader({ delayMs: 3 });
      return buildTemplateData({
        templateText: '{客户名称}{#明细}{x}{/明细}',
        fields,
        recordId: 'main',
        readCellString: reader,
        readLinkedRecordIds: makeLinkedReader({ f_loop: ['r1', 'r2', 'r3'] }),
      });
    };

    const [a, b, c] = [await run(), await run(), await run()];

    // 正面锚点：内容确实非空（防「恒返回 {} → 三次也相等」的假绿）
    expect(a.data['客户名称']).toBe('f_name|main');
    expect((a.data['明细'] as unknown[]).length).toBe(3);

    expect(b.data).toEqual(a.data);
    expect(c.data).toEqual(a.data);
    expect(JSON.stringify(b.data)).toBe(JSON.stringify(a.data));
    expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report));
    // 键顺序也不得随完成顺序漂移
    expect(Object.keys(b.data)).toEqual(Object.keys(a.data));
  });
});

/* ===================== 缺陷举证（期望红） ===================== */

describe('QA2 · buildData · 【缺陷举证】字段名为 `__proto__` 时 data 静默丢键', () => {
  /**
   * 复现输入：fields=[{id:'f_proto', name:'__proto__'}]，template='{__proto__}'，读取器返回 'V'。
   *
   * 期望（按本层「绝不静默 / filled 必须与 data 一致」的契约）：
   *   · `report.filled` 含该 tag（已被装配）；
   *   · `data` 有**自有**属性 `__proto__`，值为 'V'。
   *
   * 实际：`buildData.ts` 用普通对象 `{}`（line 409 `const data: Record<string, unknown> = {}`）
   *   承载结果，`data['__proto__'] = 'V'` 命中 `Object.prototype` 上的 **setter**（非自有属性赋值），
   *   该赋值被**静默忽略** → `data` 里查不到这个键，而 `report.filled` 仍声称已填。
   *
   * 影响：模板里 `{__proto__}` 会被 docxtemplater 查到原型对象（而非字段值）→ 静默错误内容 / 空。
   * 严重性：与「静默填错比留空更糟」的既有原则直接冲突。
   * 备注：`constructor` / `toString` 等为**数据属性**，赋值会创建自有属性，**不受**影响（见下）。
   */
  it('【期望红】`{__proto__}` 应落入 data 自有键 —— 当前实现丢失', async () => {
    const fields: FieldMetaLike[] = [{ id: 'f_proto', name: '__proto__' }];
    const reader: CellStringReader = async () => 'V';

    const { data, report } = await buildTemplateData({
      templateText: '{__proto__}',
      fields,
      recordId: 'r',
      readCellString: reader,
    });

    // 报告层声称已装配
    expect(report.filled).toEqual([{ tag: '__proto__', fieldId: 'f_proto' }]);
    // 期望 data 里确实有这个键 —— 此处会红（setter 吞掉赋值）
    expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
    expect(data['__proto__']).toBe('V');
  });

  it('（对照，应为绿）`{constructor}` 不受影响 —— 证明缺陷**特指** `__proto__`', async () => {
    const fields: FieldMetaLike[] = [{ id: 'f_ctor', name: 'constructor' }];
    const reader: CellStringReader = async () => 'C';

    const { data } = await buildTemplateData({
      templateText: '{constructor}',
      fields,
      recordId: 'r',
      readCellString: reader,
    });

    expect(Object.prototype.hasOwnProperty.call(data, 'constructor')).toBe(true);
    expect(data['constructor']).toBe('C');
  });
});
