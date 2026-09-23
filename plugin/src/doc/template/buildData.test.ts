import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTemplateData } from './buildData';
import type { CellStringReader, LinkedRecordIdsReader } from './buildData';
import type { FieldMetaLike } from './placeholders';

/**
 * `doc/template/buildData` 单测（「模板导入」第 2b 步：记录 + 字段 → docxtemplater 数据对象）。
 *
 * 断言策略（团队铁律：**禁止假绿**）：
 *  - 一律**锁定具体值 / 结构**：`data['字段名']` 精确相等、`Object.keys(row)` 逐项相等、
 *    读取**调用次数**精确相等（不是「被调用过」），不用 `toBeTruthy()` 之类可恒真的断言；
 *  - **否定式断言必配正面锚点**：断言「重名的键不存在」时，同模板里另放一个**唯一**字段并断言它被填，
 *    防「整份 data 为空 → 目标不存在 → 恒真」；
 *  - **两条链路可能同值处，fixture 必须分离**：读取器按 `(fieldId, recordId)` 生成**互不相同**的值
 *    （形如 `x|r1`），使「填错行 / 填错字段 / 拿顶层记录去填子表」都能被精确值断言抓出。
 *
 * ⭐ 与上游 `placeholders.ts` 的契约：行内键**只**来自 `parseTemplate(...).tokens[].inner`——
 *    用例专门验证「模板没写的字段不会被读取」。
 */

/* ===================== 通用 stub（可注入读取器） ===================== */

/** 记录一次读取调用（用于断言调用次数 / 并发峰值） */
interface ReadLog {
  fieldId: string;
  recordId: string;
  /** 读取发起时刻「同时在飞」的任务数 */
  inFlight: number;
}

/**
 * 构造一个**确定性** `readCellString` stub：
 *  · 返回值 = `${fieldId}|${recordId}`（两条链路必然分离，便于抓「填错字段 / 错行」）；
 *  · 同时记录调用日志与并发峰值；对 `throwFor` 里命名的 fieldId 抛错。
 */
function makeReader(options?: {
  throwFor?: ReadonlySet<string>;
  delayMs?: number;
  log?: ReadLog[];
}): { reader: CellStringReader; maxInFlight: () => number; calls: () => ReadLog[] } {
  const log = options?.log ?? [];
  const throwFor = options?.throwFor ?? new Set<string>();
  const delayMs = options?.delayMs ?? 0;
  let inFlight = 0;
  let peak = 0;

  const reader: CellStringReader = async (fieldId, recordId) => {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    log.push({ fieldId, recordId, inFlight });
    try {
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
      if (throwFor.has(fieldId)) {
        throw new Error(`读取失败：${fieldId}`);
      }
      return `${fieldId}|${recordId}`;
    } finally {
      inFlight -= 1;
    }
  };

  return { reader, maxInFlight: () => peak, calls: () => log };
}

/** 记录子记录读取调用的 stub */
function makeLinkedReader(map: Record<string, string[]>): {
  reader: LinkedRecordIdsReader;
  calls: () => Array<{ fieldId: string; recordId: string }>;
} {
  const calls: Array<{ fieldId: string; recordId: string }> = [];
  const reader: LinkedRecordIdsReader = async (fieldId, recordId) => {
    calls.push({ fieldId, recordId });
    return map[fieldId] ?? [];
  };
  return { reader, calls: () => calls };
}

/**
 * 构造一个**完全由测试掌控**的 `readCellString` stub（并发断言专用，**零真实计时**）。
 *
 * 每次读取都会「停在闸门里」直到 `releaseAll()`——于是「同时在飞几条」成为**纯结构事实**：
 *  · 放行前 `parked()` = 恰好 min(并发上限, 待读任务数)；
 *  · `peak()` 记录历史最大停驻数。
 * 这样并发断言与事件循环调度 / CPU 负载**彻底解耦**（旧版用 `setTimeout` 造重叠，
 * 理论上仍受调度影响；闸门式则**由测试自己决定**何时放行）。
 */
function makeGatedReader(): {
  reader: CellStringReader;
  parked: () => number;
  peak: () => number;
  releaseAll: () => void;
} {
  const waiters: Array<() => void> = [];
  let parked = 0;
  let peak = 0;
  let open = false;

  const reader: CellStringReader = async (fieldId, recordId) => {
    if (!open) {
      parked += 1;
      if (parked > peak) peak = parked;
      await new Promise<void>((release) => waiters.push(release));
      parked -= 1;
    }
    return `${fieldId}|${recordId}`;
  };

  const releaseAll = (): void => {
    open = true;
    while (waiters.length > 0) {
      const release = waiters.shift();
      if (release) release();
    }
  };

  return { reader, parked: () => parked, peak: () => peak, releaseAll };
}

/**
 * 让出微任务队列若干轮（**不碰计时器**），确保被测代码已把首批读取全部发起并停在闸门里。
 * 轮数远大于内部 `await` 链长度，故结果是**确定**的，与机器负载无关。
 */
async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/* ===================== ① 单值占位符 ===================== */

describe('docx/template/buildData · ① 单值占位符', () => {
  it('`{客户名称}` → `data[客户名称]` **精确等于**读取器返回串', async () => {
    const fields: FieldMetaLike[] = [{ id: 'fld_name', name: '客户名称' }];
    const { reader } = makeReader();

    const { data, report } = await buildTemplateData({
      templateText: '客户：{客户名称}',
      fields,
      recordId: 'rec1',
      readCellString: reader,
    });

    expect(data).toEqual({ 客户名称: 'fld_name|rec1' });
    expect(data['客户名称']).toBe('fld_name|rec1');
    expect(report.filled).toEqual([{ tag: '客户名称', fieldId: 'fld_name' }]);
    expect(report.skippedAmbiguous).toEqual([]);
    expect(report.failedReads).toEqual([]);
  });

  it('空串返回值照常落键（不是「没读到就吞键」）', async () => {
    const fields: FieldMetaLike[] = [{ id: 'fld_empty', name: '空值' }];
    // 读取器返回空串；`data` 必须有该键且值为 ''
    const reader: CellStringReader = async () => '';
    const { data } = await buildTemplateData({
      templateText: '{空值}',
      fields,
      recordId: 'r',
      readCellString: reader,
    });
    expect('空值' in data).toBe(true);
    expect(data['空值']).toBe('');
  });
});

/* ===================== ② 只取模板用到的字段 ===================== */

describe('docx/template/buildData · ② 只取模板用到的字段', () => {
  it('字段表 10 个、模板只用 2 个 → **恰好发起 2 次**读取（断言调用次数）', async () => {
    const fields: FieldMetaLike[] = Array.from({ length: 10 }, (_unused, index) => ({
      id: `fld_${index}`,
      name: `字段${index}`,
    }));
    const { reader, calls } = makeReader();

    const { data } = await buildTemplateData({
      templateText: '{字段3} 与 {字段7}',
      fields,
      recordId: 'recX',
      readCellString: reader,
    });

    // 精确次数（不是「被调用过」）
    expect(calls().length).toBe(2);
    // 且**正是**那两个字段（不是别的字段被读）
    expect(calls().map((call) => call.fieldId).sort()).toEqual(['fld_3', 'fld_7']);
    expect(data).toEqual({ 字段3: 'fld_3|recX', 字段7: 'fld_7|recX' });
    // 未用到的字段（如 字段0）一律**不出现**在 data 里
    expect('字段0' in data).toBe(false);
  });
});

/* ===================== ③ 循环段 ===================== */

describe('docx/template/buildData · ③ 循环段', () => {
  it('`{#明细}a{x}b{y}{/明细}` + 3 子记录 → 长度 3、每行键恰为 [x,y]、**顺序与子记录一致**', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_detail', name: '明细' },
      { id: 'fld_x', name: 'x' },
      { id: 'fld_y', name: 'y' },
    ];
    const { reader } = makeReader();
    const { reader: linkedReader } = makeLinkedReader({ fld_detail: ['r1', 'r2', 'r3'] });

    const { data, report } = await buildTemplateData({
      templateText: '{#明细}a{x}b{y}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
    });

    const rows = data['明细'] as Array<Record<string, string>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(3);

    // 每行键**恰为** ['x','y']（顺序锁定；多余键 / 缺键都会红）
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['x', 'y']);
    }

    // 顺序与子记录顺序一致：值里带 recordId，能精确抓「倒序 / 错行」
    expect(rows).toEqual([
      { x: 'fld_x|r1', y: 'fld_y|r1' },
      { x: 'fld_x|r2', y: 'fld_y|r2' },
      { x: 'fld_x|r3', y: 'fld_y|r3' },
    ]);

    expect(report.loops).toEqual([{ tag: '明细', fieldId: 'fld_detail', rows: 3 }]);
  });

  it('循环段只读**段内写到的**字段（段外字段不读）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_detail', name: '明细' },
      { id: 'fld_x', name: 'x' },
      { id: 'fld_unused', name: '无关' },
    ];
    const { reader, calls } = makeReader();
    const { reader: linkedReader } = makeLinkedReader({ fld_detail: ['r1', 'r2'] });

    await buildTemplateData({
      templateText: '{#明细}{x}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
    });

    // 2 个子记录 × 1 个段内字段 = 2 次；`无关` 一次都没读
    expect(calls().length).toBe(2);
    expect(calls().map((call) => call.fieldId)).toEqual(['fld_x', 'fld_x']);
    expect(calls().some((call) => call.fieldId === 'fld_unused')).toBe(false);
  });

  it('未注入子记录读取器 → 循环展开为空数组并**显式报告**（不静默）', async () => {
    const fields: FieldMetaLike[] = [{ id: 'fld_detail', name: '明细' }];
    const { reader } = makeReader();

    const { data, report } = await buildTemplateData({
      templateText: '{#明细}{x}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      // 不注入 readLinkedRecordIds
    });

    expect(data['明细']).toEqual([]);
    expect(report.loops).toEqual([{ tag: '明细', fieldId: 'fld_detail', rows: 0 }]);
    // 正面锚点：确实报告了原因（不是静默空数组）
    expect(report.failedReads.length).toBe(1);
    expect(report.failedReads[0].fieldId).toBe('fld_detail');
    expect(report.failedReads[0].reason).toContain('readLinkedRecordIds');
  });
});

/* ===================== ④ 重名跳过 ===================== */

describe('docx/template/buildData · ④ 重名绝不静默取首个', () => {
  it('两字段同名 → `data` **没有**该键 + `report.skippedAmbiguous` 含该名（配唯一字段正面锚点）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'dup_a', name: '同名' },
      { id: 'dup_b', name: '同名' },
      { id: 'fld_unique', name: '唯一' },
    ];
    const { reader, calls } = makeReader();

    const { data, report } = await buildTemplateData({
      templateText: '{同名} / {唯一}',
      fields,
      recordId: 'rec1',
      readCellString: reader,
    });

    // 否定：重名的键**不存在**（不是「有个随机值」）
    expect('同名' in data).toBe(false);
    expect(data['同名']).toBeUndefined();
    // 报告：含该名
    expect(report.skippedAmbiguous).toEqual(['同名']);
    // 重名字段**一个都没被读**（绝不偷偷挑一个）
    expect(calls().some((call) => call.fieldId === 'dup_a' || call.fieldId === 'dup_b')).toBe(false);

    // ⭐ 正面锚点：同模板里的唯一字段**照常被填**（防「整份为空 → 恒真」）
    expect(data['唯一']).toBe('fld_unique|rec1');
    expect(report.filled).toEqual([{ tag: '唯一', fieldId: 'fld_unique' }]);
  });

  it('循环段**名**重名 → 该循环整体跳过并报告（不静默挑一个关联字段）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'loop_a', name: '明细' },
      { id: 'loop_b', name: '明细' },
    ];
    const { reader } = makeReader();
    const { reader: linkedReader, calls: linkedCalls } = makeLinkedReader({
      loop_a: ['r1'],
      loop_b: ['r1'],
    });

    const { data, report } = await buildTemplateData({
      templateText: '{#明细}{x}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
    });

    expect('明细' in data).toBe(false);
    expect(report.skippedAmbiguous).toEqual(['明细']);
    expect(report.loops).toEqual([]);
    // 两个候选关联字段都**没被读过**
    expect(linkedCalls().length).toBe(0);
  });
});

/* ===================== ⑤ 读取失败不中断整体 ===================== */

describe('docx/template/buildData · ⑤ 读取失败不中断整体', () => {
  it('一个字段读取抛错 → 该 tag 留空、`failedReads` 记录原因，**其余字段仍填好**', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_bad', name: '坏字段' },
      { id: 'fld_good', name: '好字段' },
    ];
    const { reader } = makeReader({ throwFor: new Set(['fld_bad']) });

    const { data, report } = await buildTemplateData({
      templateText: '坏：{坏字段}；好：{好字段}',
      fields,
      recordId: 'rec9',
      readCellString: reader,
    });

    // 失败字段留空（键不存在）
    expect('坏字段' in data).toBe(false);
    // ⭐ 正面锚点：其余字段**仍被填好**（整体没被打断）
    expect(data['好字段']).toBe('fld_good|rec9');

    expect(report.failedReads.length).toBe(1);
    expect(report.failedReads[0]).toEqual({
      tag: '坏字段',
      fieldId: 'fld_bad',
      reason: '读取失败：fld_bad',
    });
    // filled 只含**成功**的
    expect(report.filled).toEqual([{ tag: '好字段', fieldId: 'fld_good' }]);
  });

  it('循环段里某子记录某字段读取抛错 → 其余行 / 其余字段照常填，失败进 failedReads', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_detail', name: '明细' },
      { id: 'fld_x', name: 'x' },
      { id: 'fld_y', name: 'y' },
    ];
    // 只有 fld_y 在 **r2** 上抛错
    const reader: CellStringReader = async (fieldId, recordId) => {
      if (fieldId === 'fld_y' && recordId === 'r2') throw new Error('boom y@r2');
      return `${fieldId}|${recordId}`;
    };
    const { reader: linkedReader } = makeLinkedReader({ fld_detail: ['r1', 'r2', 'r3'] });

    const { data, report } = await buildTemplateData({
      templateText: '{#明细}{x}{y}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
    });

    const rows = data['明细'] as Array<Record<string, string>>;
    expect(rows.length).toBe(3);
    // 其余全部照常
    expect(rows[0]).toEqual({ x: 'fld_x|r1', y: 'fld_y|r1' });
    expect(rows[2]).toEqual({ x: 'fld_x|r3', y: 'fld_y|r3' });
    // 失败那一格留空（键缺失），但同行另一字段仍在
    expect(rows[1]).toEqual({ x: 'fld_x|r2' });
    expect('y' in rows[1]).toBe(false);

    expect(report.failedReads.length).toBe(1);
    expect(report.failedReads[0]).toEqual({ tag: 'y', fieldId: 'fld_y', reason: 'boom y@r2' });
  });

  it('子记录读取器抛错 → 该循环展开为空数组并报告，主记录字段不受影响', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_main', name: '主字段' },
      { id: 'fld_detail', name: '明细' },
      { id: 'fld_x', name: 'x' },
    ];
    const { reader } = makeReader();
    const failingLinked: LinkedRecordIdsReader = async () => {
      throw new Error('linked boom');
    };

    const { data, report } = await buildTemplateData({
      templateText: '{主字段}{#明细}{x}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: failingLinked,
    });

    expect(data['主字段']).toBe('fld_main|main'); // 正面锚点：主字段照常
    expect(data['明细']).toEqual([]);
    expect(report.failedReads.some((item) => item.fieldId === 'fld_detail' && item.reason === 'linked boom')).toBe(
      true,
    );
  });
});

/* ===================== ⑥ 并发上限（闸门式：时序无关） ===================== */

describe('docx/template/buildData · ⑥ 并发上限（闸门式：时序无关）', () => {
  it('6 字段 / 上限 3 → 首批停在闸门里的**恰好 3 个**（限流且非串行），峰值 = 3', async () => {
    const fields: FieldMetaLike[] = Array.from({ length: 6 }, (_unused, index) => ({
      id: `fld_${index}`,
      name: `字段${index}`,
    }));
    const { reader, parked, peak, releaseAll } = makeGatedReader();

    const pending = buildTemplateData({
      templateText: fields.map((field) => `{${field.name}}`).join(' '),
      fields,
      recordId: 'rec',
      readCellString: reader,
      concurrency: 3,
    });

    // ⭐ 关键：读取全部**停在闸门里**，此刻读「同时在飞」= 纯结构事实（与调度 / 负载无关）
    await flushMicrotasks();
    expect(parked()).toBe(3); // 精确 3：既 ≤ 上限（限流），又 > 1（非串行）

    releaseAll();
    const { data } = await pending;

    expect(peak()).toBe(3);
    expect(peak()).toBeLessThanOrEqual(3); // 绝不一次性打出全部 6 个请求
    // 结果仍然完整正确（正面锚点：6 个键都在）
    expect(Object.keys(data).length).toBe(6);
  });

  it('不传 concurrency → 默认上限 6：10 字段首批**恰好停 6 个**', async () => {
    const fields: FieldMetaLike[] = Array.from({ length: 10 }, (_unused, index) => ({
      id: `fld_${index}`,
      name: `字段${index}`,
    }));
    const { reader, parked, peak, releaseAll } = makeGatedReader();

    const pending = buildTemplateData({
      templateText: fields.map((field) => `{${field.name}}`).join(' '),
      fields,
      recordId: 'rec',
      readCellString: reader,
    });

    await flushMicrotasks();
    expect(parked()).toBe(6); // 默认上限 = 6（既不 10、也不 1）

    releaseAll();
    const { data } = await pending;

    expect(peak()).toBe(6);
    expect(Object.keys(data).length).toBe(10);
  });

  it('循环段的子记录读取同样受闸门约束：上限 2 → 5 个子记录首批**恰好停 2 个**', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_loop', name: '明细' },
      { id: 'fld_x', name: 'x' },
    ];
    const { reader, parked, releaseAll } = makeGatedReader();
    const { reader: linkedReader } = makeLinkedReader({ fld_loop: ['r1', 'r2', 'r3', 'r4', 'r5'] });

    const pending = buildTemplateData({
      templateText: '{#明细}{x}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
      concurrency: 2,
    });

    await flushMicrotasks();
    expect(parked()).toBe(2); // 5 行 × 1 字段，闸门只放 2 个进来

    releaseAll();
    const { data } = await pending;
    expect((data['明细'] as unknown[]).length).toBe(5);
  });
});

/* ===================== ⑦ 确定性 ===================== */

describe('docx/template/buildData · ⑦ 确定性', () => {
  it('同一输入跑两次 → `data` 与 `report` 深等（含循环）', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_name', name: '客户名称' },
      { id: 'fld_detail', name: '明细' },
      { id: 'fld_x', name: 'x' },
      { id: 'fld_y', name: 'y' },
    ];
    const run = async () => {
      const { reader } = makeReader({ delayMs: 3 });
      const { reader: linkedReader } = makeLinkedReader({ fld_detail: ['r1', 'r2', 'r3', 'r4'] });
      return buildTemplateData({
        templateText: '{客户名称}{#明细}a{x}b{y}{/明细}',
        fields,
        recordId: 'main',
        readCellString: reader,
        readLinkedRecordIds: linkedReader,
      });
    };

    const first = await run();
    const second = await run();

    expect(second.data).toEqual(first.data);
    expect(second.report).toEqual(first.report);
    // 深等之外，再钉一次键顺序确定性（对象键插入顺序不得随完成顺序漂移）
    expect(Object.keys(second.data)).toEqual(Object.keys(first.data));
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
  });
});

/* ===================== ⑧ 键名安全（__proto__ 不得静默丢键） ===================== */

describe('docx/template/buildData · ⑧ 键名安全', () => {
  it('字段名 `__proto__` → `data` 有该**自有**键且值正确（不静默丢）', async () => {
    const fields: FieldMetaLike[] = [{ id: 'fld_proto', name: '__proto__' }];
    const reader: CellStringReader = async () => 'V';

    const { data, report } = await buildTemplateData({
      templateText: '{__proto__}',
      fields,
      recordId: 'r',
      readCellString: reader,
    });

    // 正面锚点：报告声称已装配（旧实现此处自称已填、data 却查不到 —— 静默填错）
    expect(report.filled).toEqual([{ tag: '__proto__', fieldId: 'fld_proto' }]);
    // 自有键：普通对象赋值会被原型 setter 吞掉；`defineProperty` 不会
    expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
    expect(data['__proto__']).toBe('V');
    // 且**未**改写原型（仍指向 Object.prototype）——证明确实是定义自有键，而非换原型
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it('对照：`constructor` 同样落自有键（证明这是 `__proto__` 专属陷阱，已修）', async () => {
    const fields: FieldMetaLike[] = [{ id: 'fld_ctor', name: 'constructor' }];
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

  it('循环段行内字段名 `__proto__` → 该行同样有自有键', async () => {
    const fields: FieldMetaLike[] = [
      { id: 'fld_loop', name: '明细' },
      { id: 'fld_proto', name: '__proto__' },
    ];
    const reader: CellStringReader = async (fieldId, recordId) => `${fieldId}|${recordId}`;
    const { reader: linkedReader } = makeLinkedReader({ fld_loop: ['r1'] });

    const { data } = await buildTemplateData({
      templateText: '{#明细}{__proto__}{/明细}',
      fields,
      recordId: 'main',
      readCellString: reader,
      readLinkedRecordIds: linkedReader,
    });

    const rows = data['明细'] as Array<Record<string, string>>;
    expect(rows.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(rows[0], '__proto__')).toBe(true);
    expect(rows[0]['__proto__']).toBe('fld_proto|r1');
  });
});

/* ===================== ⑨ 源码级守卫 ===================== */

/** 去掉块注释与行注释（源码级正则必须先在无注释文本上匹配，否则注释里的同形内容会骗过断言） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ⚠️ 不用 `import.meta.url`（vitest 的 Vite 转换下不是 file: URL）；vitest 的 cwd 恒为插件根目录。
const SOURCE = stripComments(readFileSync(resolve(process.cwd(), 'src/doc/template/buildData.ts'), 'utf8'));

describe('docx/template/buildData · ⑨ 源码级守卫', () => {
  it('键写入一律经 `defineOwn`：不用 `obj[key] =`（规避 `__proto__` 原型 setter 静默丢值）', () => {
    expect(SOURCE).toMatch(/function\s+defineOwn\s*\(/);
    expect(SOURCE).toMatch(/Object\.defineProperty\s*\(/);
    // 反面锚点：装配 `data` / 行对象时**不得**再出现直写下标赋值
    expect(SOURCE).not.toMatch(/\bdata\[[^\]]+\]\s*=/);
    expect(SOURCE).not.toMatch(/rowObject\[[^\]]+\]\s*=/);
  });

  it('**绝不**直接依赖 SDK / React / DOM：读取器只能来自注入', () => {
    // 注释已剔除（文件头注释里就写着 SDK 字样）
    expect(SOURCE).not.toMatch(/from\s*['"]@lark-opdev\//);
    expect(SOURCE).not.toMatch(/block-bitable-api/);
    expect(SOURCE).not.toMatch(/from\s*['"]react['"]/);
    expect(SOURCE).not.toMatch(/\b(document|window)\s*\./);
    // 正面锚点：确实（且只）依赖这两个纯模块
    expect(SOURCE).toMatch(/from\s*['"]\.\/placeholders['"]/);
    expect(SOURCE).toMatch(/from\s*['"]@\/utils\/errorText['"]/);
  });

  it('行内键来自解析结果：显式引用 `parseTemplate` 与 `token.inner`', () => {
    expect(SOURCE).toMatch(/parseTemplate\s*\(/);
    // 只用 `inner` 决定循环段字段（`collectInnerNames` 递归消费 inner）
    expect(SOURCE).toMatch(/token\.inner/);
    expect(SOURCE).toMatch(/collectInnerNames\s*\(/);
  });

  it('并发闸门存在且默认值为 6（限流常量 + 信号量）', () => {
    expect(SOURCE).toMatch(/DEFAULT_CONCURRENCY\s*=\s*6/);
    // 正面锚点：确实用了信号量把请求包起来
    expect(SOURCE).toMatch(/new\s+Semaphore\s*\(/);
    expect(SOURCE).toMatch(/sem\.run\s*\(/);
  });

  it('读取失败**不**被吞：抛错路径写入 failedReads 且用 formatError 归一原因', () => {
    expect(SOURCE).toMatch(/failedReads\.push\s*\(/);
    expect(SOURCE).toMatch(/formatError\s*\(/);
    // 反面锚点：绝不能出现「静默 catch 空块」
    expect(SOURCE).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/);
  });

  it('重名走 skippedAmbiguous（绝无「取首个」）', () => {
    expect(SOURCE).toMatch(/skippedAmbiguous\.push\s*\(/);
    // 反面锚点：解析重名时不写 data
    expect(SOURCE).toMatch(/markAmbiguous\s*\(/);
  });
});
