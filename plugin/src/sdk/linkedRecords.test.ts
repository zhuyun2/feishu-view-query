/**
 * `sdk/linkedRecords`（关联字段只读读取层）单测。
 *
 * 断言原则（团队禁令）：每条断言都必须能被「把实现改坏」证伪 —— 只断言「有输出」的用例不写。
 * 本文件锁定四类行为：
 *  ① **形态兼容**：`recordIds`/`tableId` 与弃用别名 `record_ids`/`table_id` 都能取到；
 *  ② **不误读文本**：`{ text: 'A、B' }` 这类「只有文本」的形态**绝不**被按分隔符硬拆成 id
 *     （拆错 = 用户看到错记录，是本需求最危险的失败模式）；
 *  ③ **永不抛出 + 一条告警**：任何异常都降级为 `{recordIds:[],tableId:''}` 且**恰好一次**告警
 *     带上 fieldId 与错误文本（不静默）；
 *  ④ **零请求优先**：内存记录命中时**不打** `getCellValue`（用调用计数证伪）；
 *     内存没有该字段键时才回退**一次**请求。
 * 另加**源码级只读守卫**（§负面锚点 + 正面锚点配对）。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLinkedRecordsReader,
  extractLinkedRecordRef,
  emptyLinkedRecordRef,
} from './linkedRecords';
import type { SdkRecord } from './port';

/* ===================== ① extractLinkedRecordRef ===================== */

describe('sdk/linkedRecords · extractLinkedRecordRef（纯函数，形态兼容）', () => {
  it('标准 IOpenLink：取 recordIds + tableId', () => {
    expect(extractLinkedRecordRef({ recordIds: ['rec_1', 'rec_2'], tableId: 'tbl_t' })).toEqual({
      recordIds: ['rec_1', 'rec_2'],
      tableId: 'tbl_t',
    });
  });

  it('弃用别名 record_ids / table_id：同样取到（旧形态不能被当成空）', () => {
    expect(extractLinkedRecordRef({ record_ids: ['rec_9'], table_id: 'tbl_old' })).toEqual({
      recordIds: ['rec_9'],
      tableId: 'tbl_old',
    });
  });

  it('新旧字段同时存在 → 优先新字段（recordIds / tableId）', () => {
    const ref = extractLinkedRecordRef({
      recordIds: ['new_a'],
      record_ids: ['old_b'],
      tableId: 'tbl_new',
      table_id: 'tbl_old',
    });
    expect(ref).toEqual({ recordIds: ['new_a'], tableId: 'tbl_new' });
  });

  it('非字符串项被丢弃、重复 id 去重（保序）', () => {
    const ref = extractLinkedRecordRef({ recordIds: ['a', 1, 'a', null, 'b', ''], tableId: 't' });
    expect(ref.recordIds).toEqual(['a', 'b']);
  });

  it('⭐ 反面锚点：只有 text 的形态**绝不**被拆成 id（拆错 = 展示错记录）', () => {
    const ref = extractLinkedRecordRef({ text: '客户 A、客户 B' });
    expect(ref).toEqual({ recordIds: [], tableId: '' });
    // 双保险：任何位置都不该出现被拆出来的片段
    expect(JSON.stringify(ref)).not.toContain('客户');
  });

  it('裸字符串 / 数字 / 布尔 / null / undefined → 空引用（永不抛）', () => {
    for (const raw of ['rec_x', 42, true, null, undefined]) {
      expect(extractLinkedRecordRef(raw)).toEqual({ recordIds: [], tableId: '' });
    }
  });

  it('关联项数组：逐项抽取并合并去重（含 tableId 取首个非空）', () => {
    const ref = extractLinkedRecordRef([
      { recordIds: ['a', 'b'] },
      { record_ids: ['b', 'c'], table_id: 'tbl_z' },
    ]);
    expect(ref.recordIds).toEqual(['a', 'b', 'c']);
    expect(ref.tableId).toBe('tbl_z');
  });

  it('emptyLinkedRecordRef 每次返回**新对象**（避免共享引用被下游改写）', () => {
    const one = emptyLinkedRecordRef();
    const two = emptyLinkedRecordRef();
    expect(one).not.toBe(two);
    expect(one).toEqual(two);
  });
});

/* ===================== ② createLinkedRecordsReader ===================== */

/** 造一条「已在内存」的记录 */
function memoryRecord(recordId: string, fields: Record<string, unknown>): SdkRecord {
  return { recordId, fields } as unknown as SdkRecord;
}

describe('sdk/linkedRecords · createLinkedRecordsReader（零请求优先 / 单请求兜底）', () => {
  it('内存记录命中该字段 → 零请求返回 recordIds（用调用计数证伪，不允许打请求）', async () => {
    const getCellValue = vi.fn(async () => ({ recordIds: ['from_api'], tableId: 'api_tbl' }));
    const reader = createLinkedRecordsReader({
      record: memoryRecord('rec_main', { f_link: { recordIds: ['rec_1'], tableId: 'tbl_l' } }),
      getCellValue,
    });

    await expect(reader('f_link', 'rec_main')).resolves.toEqual({
      recordIds: ['rec_1'],
      tableId: 'tbl_l',
    });
    expect(getCellValue).not.toHaveBeenCalled();
  });

  it('内存记录**含**该字段键但值为空链 → 返回空且仍**零请求**（不当成「缺字段」）', async () => {
    const getCellValue = vi.fn(async () => ({ recordIds: ['should_not_happen'], tableId: 't' }));
    const reader = createLinkedRecordsReader({
      record: memoryRecord('rec_main', { f_link: { text: '' } }),
      getCellValue,
    });

    await expect(reader('f_link', 'rec_main')).resolves.toEqual({ recordIds: [], tableId: '' });
    expect(getCellValue).not.toHaveBeenCalled();
  });

  it('内存记录**缺**该字段键 → 回退**一次** getCellValue', async () => {
    const getCellValue = vi.fn(async () => ({ recordIds: ['rec_api'], tableId: 'tbl_api' }));
    const reader = createLinkedRecordsReader({
      record: memoryRecord('rec_main', { other: 1 }),
      getCellValue,
    });

    await expect(reader('f_link', 'rec_main')).resolves.toEqual({
      recordIds: ['rec_api'],
      tableId: 'tbl_api',
    });
    expect(getCellValue).toHaveBeenCalledTimes(1);
    expect(getCellValue).toHaveBeenCalledWith('f_link', 'rec_main');
  });

  it('recordId 与内存记录不同 → 走请求（不得用别人的字段值冒充）', async () => {
    const getCellValue = vi.fn(async () => ({ recordIds: ['rec_other'], tableId: 'tbl_o' }));
    const reader = createLinkedRecordsReader({
      record: memoryRecord('rec_main', { f_link: { recordIds: ['rec_main_link'], tableId: 'tbl' } }),
      getCellValue,
    });

    await expect(reader('f_link', 'rec_other')).resolves.toEqual({
      recordIds: ['rec_other'],
      tableId: 'tbl_o',
    });
    expect(getCellValue).toHaveBeenCalledWith('f_link', 'rec_other');
  });

  it('无内存记录 / 无 getCellValue → 空引用（正常降级，**不告警**、不抛）', async () => {
    const onWarn = vi.fn();
    const reader = createLinkedRecordsReader({ record: null, onWarn });
    await expect(reader('f_link', 'rec_1')).resolves.toEqual({ recordIds: [], tableId: '' });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('fieldId 为空 → 空引用且不打请求', async () => {
    const getCellValue = vi.fn(async () => ({ recordIds: ['x'], tableId: 't' }));
    const reader = createLinkedRecordsReader({ getCellValue });
    await expect(reader('', 'rec_1')).resolves.toEqual({ recordIds: [], tableId: '' });
    expect(getCellValue).not.toHaveBeenCalled();
  });

  it('⭐ getCellValue 抛错 → 降级为空引用 + **恰好一条**告警（带 fieldId 与错误文本），永不抛', async () => {
    const onWarn = vi.fn();
    const reader = createLinkedRecordsReader({
      getCellValue: async () => {
        throw new Error('boom-42');
      },
      onWarn,
    });

    await expect(reader('f_link', 'rec_1')).resolves.toEqual({ recordIds: [], tableId: '' });
    expect(onWarn).toHaveBeenCalledTimes(1);
    const [scope, message, ctx] = onWarn.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(scope).toBe('sdk.linkedRecords');
    expect(message).toContain('关联');
    expect(ctx.fieldId).toBe('f_link');
    expect(String(ctx.error)).toContain('boom-42');
  });

  it('读取器返回不可识别形态（只带 text）→ 空引用（不按分隔符硬拆）', async () => {
    const reader = createLinkedRecordsReader({ getCellValue: async () => ({ text: '甲、乙' }) });
    await expect(reader('f_link', 'rec_1')).resolves.toEqual({ recordIds: [], tableId: '' });
  });
});

/* ===================== ③ 源码级只读守卫 ===================== */

/** 去掉块注释与行注释（否则注释里写着的写接口名会骗过负面断言） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ⚠️ 不用 `import.meta.url`（vitest 的 Vite 转换下不是 file: URL）；vitest 的 cwd 恒为插件根目录。
const SOURCE = stripComments(
  readFileSync(resolve(process.cwd(), 'src/sdk/linkedRecords.ts'), 'utf8'),
);
const RESOLVE_SOURCE = stripComments(
  readFileSync(resolve(process.cwd(), 'src/doc/resolve.ts'), 'utf8'),
);

describe('sdk/linkedRecords · ③ 源码级只读守卫（D1 只读基线）', () => {
  it('**绝不**出现任何写接口（负面锚点，逐一列出）', () => {
    const WRITE_APIS = [
      'setCellValue',
      'setRecord',
      'setRecords',
      'addRecord',
      'addRecords',
      'deleteRecord',
      'deleteRecords',
      'setField',
      'setView',
      'createField',
      'createTable',
      'setTable',
    ];
    for (const api of WRITE_APIS) {
      expect(SOURCE, `不得出现写接口 ${api}`).not.toContain(api);
    }
  });

  it('正面锚点：确实（且只）用了这四个**读**接口', () => {
    expect(SOURCE).toMatch(/getCellValue\s*\(/);
    expect(SOURCE).toMatch(/getFieldMetaList\s*\(/);
    expect(SOURCE).toMatch(/getRecordById\s*\(/);
    expect(SOURCE).toMatch(/getTable\s*\(/);
  });

  it('SDK 只经 `import type` 与**动态** `import()` 引入（静态值导入会拖垮 jsdom 单测）', () => {
    // 负面锚点：不得出现静态 import 语句
    expect(SOURCE).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s*['"]@lark-opdev\//m);
    expect(SOURCE).not.toMatch(/^\s*import\s*['"]@lark-opdev\//m);
    // 正面锚点：`./base` 必须是动态 import
    expect(SOURCE).toMatch(/await\s+import\(\s*['"]\.\/base['"]\s*\)/);
    // 分层：`sdk/` 层不得 import 上层模块
    expect(SOURCE).not.toMatch(/from\s*['"]@\/data\//);
    expect(SOURCE).not.toMatch(/from\s*['"]@\/fields\//);
    expect(SOURCE).not.toMatch(/from\s*['"]@\/components\//);
  });

  it('`resolveBlocks` 仍是**同步**函数（关联数据只能作为纯输入注入，不得在 resolve 里发请求）', () => {
    // 负面锚点：resolve.ts 不得出现任何 SDK 读接口调用「实现」（注释已剔除）
    expect(RESOLVE_SOURCE).not.toMatch(/getCellValue\s*\(/);
    expect(RESOLVE_SOURCE).not.toMatch(/getRecordById\s*\(/);
    expect(RESOLVE_SOURCE).not.toMatch(/getFieldMetaList\s*\(/);
    // 正面锚点：它只消费注入的 `linkedRecords` Map
    expect(RESOLVE_SOURCE).toMatch(/linkedRecords/);
  });
});
