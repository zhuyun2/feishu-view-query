/**
 * ⭐ QA2（software-qa-engineer-tpl2）**独立**验证：「docx 模板存储层」1MB / 分块 / 原子性 / 清理范围。
 *
 * 目的（为什么本文件必须存在）：本轮把模板上限 **32KB → 1MB**、并把**字节移出主配置**改存分块——
 * 这是**行为契约变了**（不是常量微调）。实现方交付的 `storage.test.ts`（27 例）与
 * `docxTemplateChunkStore.tpl4.test.tsx`（8 例）已覆盖一轮，但「同一份实现自证」不足以排除盲区。
 * 故本文件用**与实现方不同的夹具 / 手法**独立复算关键不变量，并给出**去伪（falsification）**证据：
 *
 *   ① ~1MB 分块往返**逐字节一致**（非对称夹具）；
 *   ② 超限**显式**文案（含实际值与上限数值）+ **零写入**（正面锚点：尺寸校验在写之前）；
 *   ③ 原子性：写块中途失败 → **无引用**、旧模板**仍在且可逐字节读回**；
 *   ④ 缺块 → 显式失败（含**具体块号 + 总数**），绝不静默当空模板；
 *   ⑤ 哈希不符 / 长度不符 → 两条**可互相区分**的失败（各自不含对方关键词）；
 *   ⑥ 清理只删**自己的** templateId 的块；不碰 `cbv:config` / `cbv:probe` / 别的 id；
 *   ⑦ legacy 内联（只有 `bytesBase64`）仍可读，且**不访问任何块 key**；
 *   ⑧ 分块模板 + **无 store** → 显式失败；
 *   ⑨ 读 / 探针**不产生任何模板块写入**（无关操作不重写）；
 *   ⑩ `setData` 被拒 → 显式失败（不是「写成功」）。
 *
 * 夹具与实现方刻意不同：字节用 `(i*7 + seed*29) mod 256`（实现方用 `(i*31+7)`）；
 * 分块用 `chunkChars = 8`（实现方用 `4`）；VIEW id 也不同。避免「照抄夹具」导致的同错同漏。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_KEY_PREFIX } from '@/constants';
import type { ImportedDocx } from '@/config/types';
import type { BridgeStore } from '@/sdk/base';
import {
  MAX_IMPORTED_DOCX_BYTES,
  PROBE_KEY_PREFIX,
  TEMPLATE_CHUNK_BASE64_CHARS,
  TEMPLATE_KEY_PREFIX,
  contentHashOf,
  deleteTemplateChunks,
  encodeImportedDocx,
  prepareImportedDocx,
  probeBridgeCapacity,
  probeKey,
  readImportedDocxBytes,
  saveImportedDocx,
  templateChunkKey,
  templateKeyPrefixFor,
  writeImportedDocxChunks,
} from './storage';

const VIEW = 'qa2-chunk-view';

/** 非对称、可复现的字节夹具（**刻意避开全 0 / 全同**，否则哈希 / 截断类缺陷会假绿） */
function mkBytes(n: number, seed = 3): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bytes[i] = (i * 7 + seed * 29) % 256;
  return bytes;
}

/** 记录每一次 key 访问 / 删除的假 bridge 存储（含可编程故障注入） */
class FakeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly deleted: string[] = [];
  /** setData 直接返回 false（模拟介质拒绝） */
  rejectWrites = false;
  /** 命中则 setData 抛错（模拟「写块中途失败」） */
  failOn: ((key: string, value: unknown) => boolean) | null = null;
  /** 写入字符数 > 该值 → 抛错（模拟平台容量上限，供探针） */
  maxChars: number | null = null;

  async getData(key: string): Promise<unknown> {
    this.reads.push(key);
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setData(key: string, value: unknown): Promise<boolean> {
    this.writes.push(key);
    if (this.rejectWrites) return false;
    if (this.failOn && this.failOn(key, value)) throw new Error('QA2 模拟写入中断');
    if (this.maxChars !== null && typeof value === 'string' && value.length > this.maxChars) {
      throw new Error('QA2 模拟容量上限');
    }
    if (value === null) {
      this.map.delete(key);
      this.deleted.push(key);
    } else {
      this.map.set(key, value);
    }
    return true;
  }

  onDataChange(): () => void {
    return () => undefined;
  }

  tplWrites(): number {
    return this.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length;
  }
}

/* ============================================================
 * ① ~1MB 分块往返逐字节一致
 * ============================================================ */

describe('storage(分块) · ① ~1MB 往返', () => {
  it('1048576 字节 → 写块 → 读回**逐字节一致**；引用不含 bytesBase64 且元数据具体', async () => {
    const store = new FakeStore();
    const bytes = mkBytes(MAX_IMPORTED_DOCX_BYTES, 5); // 恰好 1MB
    expect(new Set(bytes.subarray(0, 2048)).size).toBeGreaterThan(32); // 正面锚点：夹具非退化

    const prepared = prepareImportedDocx('大模板.docx', bytes, { uploadedAt: 7 });
    expect(prepared.reference.sizeBytes).toBe(MAX_IMPORTED_DOCX_BYTES);
    expect(prepared.reference.chunkSize).toBe(TEMPLATE_CHUNK_BASE64_CHARS);
    expect(prepared.reference.chunkCount).toBe(prepared.chunks.length);
    // 1MB → base64 1398104 字符 → ⌈1398104/32768⌉ = 43 块（锁定具体值）
    // ⚠️ 机械适配：块大小随真机实测（单 key 上限 64KB）由 131072 降为 32768，11 → 43；证据见 storage.ts 常量注释
    expect(prepared.reference.chunkCount).toBe(43);
    expect(prepared.reference.contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(prepared.reference.bytesBase64).toBeUndefined(); // ⭐ 字节不在主配置
    // 分块形状：除末块外每块恒为 chunkSize
    expect(prepared.chunks.slice(0, -1).every((c) => c.length === TEMPLATE_CHUNK_BASE64_CHARS)).toBe(true);
    expect(prepared.chunks[prepared.chunks.length - 1]!.length).toBeGreaterThan(0);
    expect(prepared.chunks[prepared.chunks.length - 1]!.length).toBeLessThanOrEqual(TEMPLATE_CHUNK_BASE64_CHARS);

    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);

    const prefix = templateKeyPrefixFor(VIEW, prepared.reference.templateId as string);
    expect(store.writes.filter((k) => k.startsWith(prefix)).length).toBe(prepared.reference.chunkCount);

    const read = await readImportedDocxBytes(store, VIEW, prepared.reference);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.legacy).toBe(false);
    expect(Array.from(read.bytes)).toEqual(Array.from(bytes));
  });
});

/* ============================================================
 * ② 超限显式失败（含数值）+ 零写入
 * ============================================================ */

describe('storage(分块) · ② 超限显式失败', () => {
  it('比上限多 1 字节 → 失败文案含 1048577 与 1048576；**零写入**（尺寸校验在写之前）', async () => {
    const store = new FakeStore();
    const size = MAX_IMPORTED_DOCX_BYTES + 1; // 最小越界（锁死边界判别力）
    expect(size).toBe(1_048_577);

    const res = await saveImportedDocx(store, VIEW, 'over.docx', mkBytes(size, 1));
    expect(res.ok).toBe(false);
    expect(res.reference).toBeUndefined(); // 失败不得返回引用（调用方须保持旧值）
    expect(res.error).toBeTruthy();
    expect(res.error).toContain(String(size)); // 实际值
    expect(res.error).toContain(String(MAX_IMPORTED_DOCX_BYTES)); // 上限值
    // 正面锚点：尺寸校验在最前 → 一次都没写
    expect(store.writes.length).toBe(0);
    expect(store.map.size).toBe(0);
  });

  it('恰好等于上限（1048576）→ 允许（边界含端点，防「>= 误判超限」）', async () => {
    const store = new FakeStore();
    const res = await saveImportedDocx(store, VIEW, 'max.docx', mkBytes(MAX_IMPORTED_DOCX_BYTES, 2), null, {
      templateId: 'tpl_max',
      uploadedAt: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.reference?.sizeBytes).toBe(MAX_IMPORTED_DOCX_BYTES);
  });
});

/* ============================================================
 * ③ 原子性：写块中途失败 → 无引用、旧模板仍可用
 * ============================================================ */

describe('storage(分块) · ③ 原子性（引用最后落、失败不引用）', () => {
  it('写新块中途失败 → 无引用；旧模板**未被删除且逐字节可读**', async () => {
    const store = new FakeStore();

    // 旧模板先真实就位（可读）
    const oldBytes = mkBytes(200, 9);
    const oldPrepared = prepareImportedDocx('old.docx', oldBytes, {
      chunkChars: 8,
      templateId: 'tpl_old',
      uploadedAt: 1,
    });
    const oldWritten = await writeImportedDocxChunks(store, VIEW, oldPrepared);
    expect(oldWritten.ok).toBe(true);
    const oldRef = oldPrepared.reference;
    const writesBefore = store.writes.length;

    // 新上传在第 1 块（index=1）中断
    store.failOn = (key, value) =>
      key.startsWith(templateKeyPrefixFor(VIEW, 'tpl_new')) && key.endsWith(':1') && value !== null;

    const res = await saveImportedDocx(store, VIEW, 'new.docx', mkBytes(300, 11), oldRef, {
      chunkChars: 8,
      templateId: 'tpl_new',
      uploadedAt: 2,
    });

    // 失败：无引用、无旧块删除
    expect(res.ok).toBe(false);
    expect(res.reference).toBeUndefined();
    expect(res.error).toContain('写入模板块失败');
    expect(store.deleted.some((k) => k.startsWith(templateKeyPrefixFor(VIEW, 'tpl_old')))).toBe(false);

    // ⭐ 旧模板仍可逐字节读回（用户不会打开一个「存在但残缺」的模板）
    const reread = await readImportedDocxBytes(store, VIEW, oldRef);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error('unreachable');
    expect(Array.from(reread.bytes)).toEqual(Array.from(oldBytes));

    // 正面锚点：失败前**确实尝试写了新块**（证明失败点在中途，而非没写）
    expect(store.writes.slice(writesBefore).some((k) => k.startsWith(templateKeyPrefixFor(VIEW, 'tpl_new')))).toBe(
      true,
    );
  });
});

/* ============================================================
 * ④ 缺块 → 显式失败（含块号 / 总数）
 * ============================================================ */

describe('storage(分块) · ④ 缺块显式失败', () => {
  it('删掉第 1 块 → 文案含「缺少第 1 块」与「共 10 块」（非空模板）', async () => {
    const store = new FakeStore();
    const prepared = prepareImportedDocx('m.docx', mkBytes(60, 4), {
      chunkChars: 8,
      templateId: 'tpl_m',
      uploadedAt: 1,
    });
    // 60 字节 → base64 80 字符 → 80/8 = 10 块
    expect(prepared.reference.chunkCount).toBe(10);
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);

    store.map.delete(templateChunkKey(VIEW, 'tpl_m', 1));
    const read = await readImportedDocxBytes(store, VIEW, prepared.reference);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('缺少第 1 块');
    expect(read.reason).toContain('共 10 块');

    // 对照（防「恒失败」假绿）：把块补回后必须能读出
    store.map.set(templateChunkKey(VIEW, 'tpl_m', 1), prepared.chunks[1]);
    expect((await readImportedDocxBytes(store, VIEW, prepared.reference)).ok).toBe(true);
  });
});

/* ============================================================
 * ⑤ 哈希不符 / 长度不符：两条可区分的失败
 * ============================================================ */

describe('storage(分块) · ⑤ 哈希 / 长度失败可区分', () => {
  async function writeOneChunk(): Promise<{ store: FakeStore; ref: ImportedDocx }> {
    const store = new FakeStore();
    // 6 字节 → base64 8 字符 → 单块
    const prepared = prepareImportedDocx('h.docx', mkBytes(6, 2), {
      chunkChars: 8,
      templateId: 'tpl_h',
      uploadedAt: 1,
    });
    expect(prepared.reference.chunkCount).toBe(1);
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);
    return { store, ref: prepared.reference };
  }

  it('同长度改内容 → 「哈希不符」，且**不含**「大小不一致」', async () => {
    const { store, ref } = await writeOneChunk();
    const key0 = templateChunkKey(VIEW, 'tpl_h', 0);
    const cur = store.map.get(key0) as string;
    const alt = (cur[0] === 'A' ? 'B' : 'A') + cur.slice(1); // 同长度、改首字符
    store.map.set(key0, alt);

    const read = await readImportedDocxBytes(store, VIEW, ref);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('哈希不符');
    expect(read.reason).not.toContain('大小不一致');
  });

  it('sizeBytes 与实际不符 → 「大小不一致」，且**不含**「哈希不符」', async () => {
    const { store, ref } = await writeOneChunk();
    const tampered: ImportedDocx = { ...ref, sizeBytes: ref.sizeBytes + 1 };
    const read = await readImportedDocxBytes(store, VIEW, tampered);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('大小不一致');
    expect(read.reason).not.toContain('哈希不符');
  });

  it('contentHash 与内容不符 → 「哈希不符」', async () => {
    const { store, ref } = await writeOneChunk();
    const tampered: ImportedDocx = { ...ref, contentHash: 'deadbeef' };
    const read = await readImportedDocxBytes(store, VIEW, tampered);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('哈希不符');
  });
});

/* ============================================================
 * ⑥ 清理只删自己的块
 * ============================================================ */

describe('storage(分块) · ⑥ 清理只删自己', () => {
  it('保存成功只删自己上一个 templateId 的块；别的 id / cbv:config / cbv:probe **均未被触碰**', async () => {
    const store = new FakeStore();
    // 预置「别人的」数据：另一个模板 + 真实配置 key + 探针 key
    store.map.set(templateChunkKey(VIEW, 'tpl_other', 0), 'OTHER');
    store.map.set(`${CONFIG_KEY_PREFIX}:${VIEW}`, 'CONFIG_RAW');
    store.map.set(probeKey(VIEW, 1), 'PROBE_RAW');
    // 将被清理的旧模板（真实写入 2 块，保证 key 形态与生产一致）
    const oldPrepared = prepareImportedDocx('old.docx', mkBytes(30, 3), {
      chunkChars: 8,
      templateId: 'tpl_old',
      uploadedAt: 1,
    });
    const oldWritten = await writeImportedDocxChunks(store, VIEW, oldPrepared);
    expect(oldWritten.ok).toBe(true);
    expect(oldPrepared.reference.chunkCount).toBeGreaterThanOrEqual(2);

    const previous = oldPrepared.reference;
    const res = await saveImportedDocx(store, VIEW, 'new.docx', mkBytes(40, 6), previous, {
      chunkChars: 8,
      templateId: 'tpl_new',
      uploadedAt: 2,
    });
    expect(res.ok).toBe(true);

    const ownPrefix = templateKeyPrefixFor(VIEW, 'tpl_old');
    expect(store.deleted.length).toBe(previous.chunkCount);
    expect(store.deleted.every((k) => k.startsWith(ownPrefix))).toBe(true);
    // 不含其它 id / 配置 / 探针
    expect(store.deleted.some((k) => k.includes('tpl_other'))).toBe(false);
    expect(store.deleted.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.deleted.some((k) => k.startsWith(PROBE_KEY_PREFIX))).toBe(false);
    // ⭐ 全程序列**从不写** config / probe key（否定式 + 上面已证明确实写了模板块）
    expect(store.writes.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.writes.some((k) => k.startsWith(PROBE_KEY_PREFIX))).toBe(false);
    // 未受影响的 key 仍在
    expect(store.map.get(templateChunkKey(VIEW, 'tpl_other', 0))).toBe('OTHER');
    expect(store.map.get(`${CONFIG_KEY_PREFIX}:${VIEW}`)).toBe('CONFIG_RAW');
    expect(store.map.get(probeKey(VIEW, 1))).toBe('PROBE_RAW');
    // 正面锚点：新模板已写入且可读回
    expect((await readImportedDocxBytes(store, VIEW, res.reference as ImportedDocx)).ok).toBe(true);
  });

  it('deleteTemplateChunks：空 templateId → 一个都不删', async () => {
    const store = new FakeStore();
    store.map.set(templateChunkKey(VIEW, 'a', 0), 'X');
    store.map.set(templateChunkKey(VIEW, 'b', 0), 'Y');
    expect(await deleteTemplateChunks(store, VIEW, '', 3)).toEqual([]);
    expect(store.map.get(templateChunkKey(VIEW, 'a', 0))).toBe('X');
    expect(store.map.get(templateChunkKey(VIEW, 'b', 0))).toBe('Y');
  });
});

/* ============================================================
 * ⑦ legacy 内联兼容（只有 bytesBase64）
 * ============================================================ */

describe('storage(分块) · ⑦ legacy 内联兼容', () => {
  it('仅含 bytesBase64（无分块字段）→ 正确解码，且**不访问任何块 key**', async () => {
    const store = new FakeStore();
    const legacy = encodeImportedDocx('old.docx', mkBytes(64, 7), 1);
    expect(legacy.templateId).toBeUndefined();
    expect(typeof legacy.bytesBase64).toBe('string');

    const read = await readImportedDocxBytes(store, VIEW, legacy);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.legacy).toBe(true);
    expect(Array.from(read.bytes)).toEqual(Array.from(mkBytes(64, 7)));
    // 正面锚点：legacy 无块可读 → 零访问（不是「读了但恰好为空」）
    expect(store.reads.length).toBe(0);
    expect(store.writes.length).toBe(0);
  });
});

/* ============================================================
 * ⑧ 无 store → 分块模板显式失败
 * ============================================================ */

describe('storage(分块) · ⑧ 无 store 显式失败', () => {
  it('分块引用 + store=null → 「无可用模板存储」（绝不静默空模板）', async () => {
    const prepared = prepareImportedDocx('x.docx', mkBytes(24, 1), {
      chunkChars: 8,
      templateId: 'tpl_ns',
      uploadedAt: 1,
    });
    const res = await readImportedDocxBytes(null, VIEW, prepared.reference);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('无可用模板存储');

    // 对照：写块 + 有 store → 可读（证明失败只因缺 store，不是引用本身坏）
    const store = new FakeStore();
    expect((await writeImportedDocxChunks(store, VIEW, prepared)).ok).toBe(true);
    expect((await readImportedDocxBytes(store, VIEW, prepared.reference)).ok).toBe(true);
  });
});

/* ============================================================
 * ⑨ 读 / 探针不重写模板块
 * ============================================================ */

describe('storage(分块) · ⑨ 读 / 探针不重写模板块', () => {
  it('多次读回 + 探针 → 模板块写入次数**保持不变**', async () => {
    const store = new FakeStore();
    const prepared = prepareImportedDocx('r.docx', mkBytes(50, 8), {
      chunkChars: 8,
      templateId: 'tpl_r',
      uploadedAt: 1,
    });
    expect((await writeImportedDocxChunks(store, VIEW, prepared)).ok).toBe(true);
    const baseline = store.tplWrites();
    expect(baseline).toBeGreaterThanOrEqual(2); // 正面锚点：确实写了多块

    const readsBefore = store.reads.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length;
    for (let i = 0; i < 3; i += 1) {
      expect((await readImportedDocxBytes(store, VIEW, prepared.reference)).ok).toBe(true);
    }
    expect(store.tplWrites()).toBe(baseline); // ⭐ 读不写
    expect(store.reads.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBeGreaterThan(readsBefore);

    store.maxChars = 64 * 1024;
    await probeBridgeCapacity({ store, viewId: VIEW, now: 1 });
    expect(store.tplWrites()).toBe(baseline); // ⭐ 探针不碰模板块
  });
});

/* ============================================================
 * ⑩ setData 被拒 → 显式失败
 * ============================================================ */

describe('storage(分块) · ⑩ setData 被拒显式失败', () => {
  it('setData 返回 false → 写块失败（含「被拒绝」），不返回引用', async () => {
    const store = new FakeStore();
    store.rejectWrites = true;
    const prepared = prepareImportedDocx('rej.docx', mkBytes(16, 4), {
      chunkChars: 8,
      templateId: 'tpl_rej',
      uploadedAt: 1,
    });
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error('unreachable');
    expect(written.reason).toContain('被拒绝');
  });
});

/* ============================================================
 * ⑪ 哈希工具确定性（独立复核 contentHashOf）
 * ============================================================ */

describe('storage(分块) · ⑪ contentHashOf 确定性且敏感', () => {
  it('同内容同哈希；改 1 位即变；输出 8 位十六进制', () => {
    const a = mkBytes(128, 6);
    const b = new Uint8Array(a);
    b[63] ^= 0xff;
    expect(contentHashOf(a)).toBe(contentHashOf(a));
    expect(contentHashOf(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHashOf(b)).not.toBe(contentHashOf(a));
  });
});
