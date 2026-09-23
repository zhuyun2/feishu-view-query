/**
 * ⭐ QA2（software-qa-engineer-tpl2）：`buildData` **确定性**的**加固**验证。
 *
 * 动机（本项目假绿教训）：`expect(run1).toEqual(run2)` 这类「跑两次结果相同」的断言**天然易假绿**——
 * **恒返回常量的实现同样稳定**，两次也相等。故本文件在比对两次之外，**再对每次结果钉死内容锚点**
 * （逐字期望值），使「返回空对象 / 常量」的实现**必然变红**。
 *
 * 同时复现旧 flaky 关注点：读取器带真实 `setTimeout` 延迟（并发完成顺序不确定），
 * 但**装配产物**必须与完成顺序无关（预分配槽位 + 末尾按 token 顺序装配）。
 */
import { describe, expect, it } from 'vitest';
import { buildTemplateData } from './buildData';
import type { CellStringReader, LinkedRecordIdsReader } from './buildData';
import type { FieldMetaLike } from './placeholders';

/** 确定性读取器：值 = `${fieldId}|${recordId}`（两条链路必然分离，抓「填错字段 / 错行」） */
function makeReader(delayMs: number): CellStringReader {
  return async (fieldId, recordId) => {
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    return `${fieldId}|${recordId}`;
  };
}

const FIELDS: FieldMetaLike[] = [
  { id: 'fld_name', name: '客户名称' },
  { id: 'fld_detail', name: '明细' },
  { id: 'fld_x', name: 'x' },
  { id: 'fld_y', name: 'y' },
];

/** 逐字期望值（内容锚点：常量实现无法满足） */
const EXPECTED_DATA = {
  客户名称: 'fld_name|main',
  明细: [
    { x: 'fld_x|r1', y: 'fld_y|r1' },
    { x: 'fld_x|r2', y: 'fld_y|r2' },
    { x: 'fld_x|r3', y: 'fld_y|r3' },
  ],
};

async function runOnce(): Promise<Awaited<ReturnType<typeof buildTemplateData>>> {
  const linked: LinkedRecordIdsReader = async (fieldId) =>
    fieldId === 'fld_detail' ? ['r1', 'r2', 'r3'] : [];
  return buildTemplateData({
    templateText: '{客户名称}{#明细}a{x}b{y}{/明细}',
    fields: FIELDS,
    recordId: 'main',
    readCellString: makeReader(3), // 真实延迟 → 完成顺序不确定
    readLinkedRecordIds: linked,
  });
}

describe('buildData · 确定性（含内容锚点，防「跑两次相同」假绿）', () => {
  it('两次运行的 data/report 深等，且**各自逐字等于期望值**（常量实现必红）', async () => {
    const first = await runOnce();
    const second = await runOnce();

    // ① 「跑两次相同」——仅此不够（常量实现也稳定）
    expect(second.data).toEqual(first.data);
    expect(second.report).toEqual(first.report);

    // ② ⭐ 内容锚点：两次都逐字等于期望值（写死期望，杜绝恒常量通过）
    expect(first.data).toEqual(EXPECTED_DATA);
    expect(second.data).toEqual(EXPECTED_DATA);

    // ③ 反常量锚点：键集非空且恰为两者
    expect(Object.keys(first.data).sort()).toEqual(['客户名称', '明细'].sort());
    expect((first.data['明细'] as unknown[]).length).toBe(3);

    // ④ report 内容锚点
    expect(first.report.filled).toEqual([{ tag: '客户名称', fieldId: 'fld_name' }]);
    expect(first.report.loops).toEqual([{ tag: '明细', fieldId: 'fld_detail', rows: 3 }]);
    expect(first.report.failedReads).toEqual([]);
    expect(first.report.skippedAmbiguous).toEqual([]);

    // ⑤ 键顺序确定性（对象键插入顺序不得随完成顺序漂移）
    expect(Object.keys(second.data)).toEqual(Object.keys(first.data));
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
  }, 20000);
});
