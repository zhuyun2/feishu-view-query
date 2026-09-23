/**
 * `doc/template/storage` 单测 —— docx 模板**存储层**（1MB / 分块 / 原子性）。
 *
 * 断言策略（团队铁律：**禁止假绿**）：
 *  - 一律锁定**具体值 / 结构**（字节、错误文案里的数值、逐档 ok 序列、key 前缀），不用可恒真断言；
 *  - **否定式断言配正面锚点**（如「不碰真实 key」同时断言确实写了模板块 / 探针 key）；
 *  - **两条链路可能同值时 fixture 必须分离**：「大小不一致」与「哈希不符」用**不同**篡改手法，
 *    且各自断言 reason **不含**对方关键词；
 *  - **源码级断言先剔注释再匹配**（storage.ts 头注释里就写着 `@/sdk/base` / `cbv:config`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEY_PREFIX } from '@/constants';
import { defaultDetailConfig } from '@/config/defaults';
import type { ImportedDocx } from '@/config/types';
import type { BridgeStore } from '@/sdk/base';
import { logInfo, logWarn } from '@/utils/log';
import {
  DEFAULT_PROBE_LADDER_BYTES,
  MAX_IMPORTED_DOCX_BYTES,
  PROBE_KEY_PREFIX,
  TEMPLATE_CHUNK_BASE64_CHARS,
  TEMPLATE_KEY_PREFIX,
  contentHashOf,
  decodeImportedDocx,
  deleteTemplateChunks,
  encodeImportedDocx,
  formatBytes,
  prepareImportedDocx,
  probeBridgeCapacity,
  probeKey,
  readImportedDocxBytes,
  resolveDocSource,
  saveImportedDocx,
  templateChunkKey,
  templateKeyPrefixFor,
  validateImportedDocx,
  writeImportedDocxChunks,
} from './storage';

/* ⭐ 失败链路日志出口（[cbv:tpl.store]）：mock 统一日志模块以断言载荷要素。
 * vi.mock 会被提升到文件顶部 —— 本文件所有用例共用该 mock（均不依赖真实 console）。 */
vi.mock('@/utils/log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const FIXED_NOW = 1_700_000_000_000;
const VIEW = 'view_tpl';

/** 非对称字节 fixture（覆盖 0x00 / 0xFF / 高位 / 全 0..255）——**刻意不用全 0** */
const RAW_BYTES = new Uint8Array([
  ...Array.from({ length: 256 }, (_, i) => i),
  0x00,
  0xff,
  0x00,
  0x10,
  0x7f,
  0x80,
  0xfe,
  0x01,
]);

/** 1MB 级、非对称、可复现的字节内容（`(i*31+7) mod 256`） */
function bigBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

/* ===================== 假 bridge 存储（记录每一次 key 访问 / 删除） ===================== */

class FakeBridgeStore implements BridgeStore {
  readonly map = new Map<string, unknown>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  /** 被「写 null（=清除）」删除的 key */
  readonly deleted: string[] = [];
  /** 写入字节数 > 该值 → 抛错（模拟平台容量上限） */
  maxBytes: number | null = null;
  /** 写入直接返回 false（模拟介质拒绝） */
  rejectWrites = false;
  /** 写入直接抛错（模拟介质故障） */
  throwOnWrite = false;
  /** 命中则 setData 抛错（模拟「写块中途失败」） */
  failWriteWhen: ((key: string, value: unknown) => boolean) | null = null;

  get accessed(): string[] {
    return [...this.reads, ...this.writes];
  }

  async getData(key: string): Promise<unknown> {
    this.reads.push(key);
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setData(key: string, value: unknown): Promise<boolean> {
    this.writes.push(key);
    if (this.throwOnWrite) throw new Error('bridge setData 抛错（模拟介质故障）');
    if (this.rejectWrites) return false;
    if (this.failWriteWhen && this.failWriteWhen(key, value)) {
      throw new Error('bridge 写入中断（模拟中途失败）');
    }
    if (this.maxBytes !== null && typeof value === 'string' && value.length > this.maxBytes) {
      throw new Error(`bridge 容量上限：写入 ${value.length} 字符被拒绝`);
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
}

/* ===================== ① legacy 内联编解码往返 ===================== */

describe('doc/template/storage · legacy 内联往返', () => {
  it('decode(encode(bytes)) **逐字节等于**原始 bytes（非对称内容）', () => {
    expect(new Set(RAW_BYTES).size).toBeGreaterThan(8); // 正面锚点：fixture 非退化
    const encoded = encodeImportedDocx('客户档案.docx', RAW_BYTES, FIXED_NOW);
    expect(encoded.fileName).toBe('客户档案.docx');
    expect(encoded.sizeBytes).toBe(RAW_BYTES.length);
    expect(typeof encoded.bytesBase64).toBe('string');
    // 新形态字段不应出现在 legacy 内联对象里
    expect(encoded.templateId).toBeUndefined();

    const decoded = decodeImportedDocx(encoded);
    expect(decoded.length).toBe(RAW_BYTES.length);
    expect(Array.from(decoded)).toEqual(Array.from(RAW_BYTES));
  });

  it('legacy 内联校验：合法 → ok；大小不一致 / 非法 base64 分别可区分', () => {
    const ok = encodeImportedDocx('ok.docx', RAW_BYTES, FIXED_NOW);
    expect(validateImportedDocx(ok)).toEqual({ ok: true });

    const mismatch = validateImportedDocx({ ...ok, sizeBytes: ok.sizeBytes + 5 });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('unreachable');
    expect(mismatch.reason).toContain('大小不一致');
    expect(mismatch.reason).not.toContain('超出上限');

    const badB64 = validateImportedDocx({
      fileName: 'x',
      bytesBase64: '!!!!not-base64@@@@',
      sizeBytes: 3,
      uploadedAt: FIXED_NOW,
    });
    expect(badB64.ok).toBe(false);
    if (badB64.ok) throw new Error('unreachable');
    expect(badB64.reason).toContain('base64');
  });

  it('legacy 内联超限 → 明确文案含实际大小与上限的数值', () => {
    const over = encodeImportedDocx('big.docx', bigBytes(MAX_IMPORTED_DOCX_BYTES + 4096), FIXED_NOW);
    expect(over.sizeBytes).toBe(MAX_IMPORTED_DOCX_BYTES + 4096);
    const res = validateImportedDocx(over);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('超出上限');
    expect(res.reason).toContain(String(MAX_IMPORTED_DOCX_BYTES + 4096));
    expect(res.reason).toContain(String(MAX_IMPORTED_DOCX_BYTES));
    expect(res.reason).not.toContain('大小不一致');
  });

  it('MAX = 1MB（取值锁定）', () => {
    expect(MAX_IMPORTED_DOCX_BYTES).toBe(1_048_576);
    expect(formatBytes(MAX_IMPORTED_DOCX_BYTES)).toBe('1024.0KB');
  });

  it('⭐ 块大小 = 32KB（取值锁定：真机实测单 key 上限 64KB，128KB 档报 set block entity error）', () => {
    expect(TEMPLATE_CHUNK_BASE64_CHARS).toBe(32 * 1024);
    // 每块必须显著小于真机实测的单 key 上限（65536），留至少一倍余量
    expect(TEMPLATE_CHUNK_BASE64_CHARS).toBeLessThan(64 * 1024);
  });

  it('contentHashOf：确定性且对内容敏感', () => {
    expect(contentHashOf(RAW_BYTES)).toBe(contentHashOf(RAW_BYTES));
    const other = new Uint8Array(RAW_BYTES);
    other[0] ^= 0xff;
    expect(contentHashOf(other)).not.toBe(contentHashOf(RAW_BYTES));
  });
});

/* ===================== ② ⭐ 1MB 分块往返 ===================== */

describe('doc/template/storage · ⭐ 1MB 分块往返', () => {
  it('prepared → 写块 → 读回 → **逐字节等于**原始 1MB（非对称）', async () => {
    const store = new FakeBridgeStore();
    const bytes = bigBytes(MAX_IMPORTED_DOCX_BYTES); // 1MB
    expect(new Set(bytes.subarray(0, 4096)).size).toBeGreaterThan(64); // 非退化

    const prepared = prepareImportedDocx('大模板.docx', bytes, { uploadedAt: FIXED_NOW });
    // 1MB → base64 1398104 字符 → ⌈1398104/32768⌉ = 43 块（锁定具体值 + 区间，见常量注释的真机实测证据）
    expect(prepared.reference.chunkSize).toBe(TEMPLATE_CHUNK_BASE64_CHARS);
    expect(prepared.reference.chunkSize).toBe(32 * 1024); // ⭐ 取值锁定：真机单 key 上限 64KB 的一半（变异：改回 128KB → 红）
    expect(prepared.reference.chunkCount).toBe(prepared.chunks.length);
    expect(prepared.reference.chunkCount).toBe(43); // 锁定具体值
    expect(prepared.reference.chunkCount).toBeGreaterThanOrEqual(40);
    expect(prepared.reference.chunkCount).toBeLessThanOrEqual(46);
    expect(prepared.reference.bytesBase64).toBeUndefined(); // 新引用不含内联

    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);

    const read = await readImportedDocxBytes(store, VIEW, prepared.reference);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.legacy).toBe(false);
    expect(read.bytes.length).toBe(bytes.length);
    expect(read.bytes).toEqual(bytes);
  });
});

/* ===================== ③ 分块边界 ===================== */

describe('doc/template/storage · 分块边界', () => {
  async function roundTrip(bytes: Uint8Array, chunkChars: number): Promise<Uint8Array> {
    const store = new FakeBridgeStore();
    const prepared = prepareImportedDocx('b.docx', bytes, { chunkChars, templateId: 'tpl_b', uploadedAt: 1 });
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);
    const read = await readImportedDocxBytes(store, VIEW, prepared.reference);
    if (!read.ok) throw new Error(read.reason);
    return read.bytes;
  }

  it('恰好整块 / 多一块 / 空内容 各自正确', () => {
    // chunkChars=4（base64 长度恒为 4 的倍数）
    const exact = prepareImportedDocx('x', new Uint8Array([1, 2, 3]), { chunkChars: 4, templateId: 't', uploadedAt: 1 });
    expect(exact.reference.chunkCount).toBe(1);
    expect(exact.chunks[0].length).toBe(4);

    const two = prepareImportedDocx('x', new Uint8Array([1, 2, 3, 4, 5, 6]), { chunkChars: 4, templateId: 't', uploadedAt: 1 });
    expect(two.reference.chunkCount).toBe(2);

    const three = prepareImportedDocx('x', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), { chunkChars: 4, templateId: 't', uploadedAt: 1 });
    expect(three.reference.chunkCount).toBe(3);

    const empty = prepareImportedDocx('x', new Uint8Array(0), { chunkChars: 4, templateId: 't', uploadedAt: 1 });
    expect(empty.reference.chunkCount).toBe(1);
    expect(empty.reference.sizeBytes).toBe(0);
  });

  it('边界尺寸均能往返（非对称内容）', async () => {
    const base = new Uint8Array([0x10, 0xff, 0x00, 0x7f, 0x80, 0x01, 0xfe, 0x02, 0x03]);
    expect(await roundTrip(base, 4)).toEqual(base);
    expect((await roundTrip(new Uint8Array(0), 4)).length).toBe(0);
    expect(await roundTrip(new Uint8Array([1, 2, 3]), 4)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

/* ===================== ④ ⭐ 不完整必须显式失败 ===================== */

describe('doc/template/storage · ⭐ 不完整必须显式失败（不是静默空模板）', () => {
  async function writtenStore(
    bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
  ): Promise<{ store: FakeBridgeStore; ref: ImportedDocx }> {
    const store = new FakeBridgeStore();
    const prepared = prepareImportedDocx('t.docx', bytes, { chunkChars: 4, templateId: 'tpl_x', uploadedAt: 1 });
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);
    return { store, ref: prepared.reference };
  }

  it('缺块 → 失败文案含具体块号（绝非返回空模板）', async () => {
    const { store, ref } = await writtenStore();
    store.map.delete(templateChunkKey(VIEW, 'tpl_x', 1));
    const read = await readImportedDocxBytes(store, VIEW, ref);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('缺少第 1 块');
    expect(read.reason).toContain('共 3 块');
  });

  it('哈希不符 → 失败（原因可区分于「大小不一致」）', async () => {
    const { store, ref } = await writtenStore();
    const key0 = templateChunkKey(VIEW, 'tpl_x', 0);
    const cur = store.map.get(key0) as string;
    // 同长度、不同内容 → 长度校验通过，仅哈希不符
    const alt = (cur[0] === 'A' ? 'B' : 'A') + cur.slice(1);
    store.map.set(key0, alt);
    const read = await readImportedDocxBytes(store, VIEW, ref);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('哈希不符');
    expect(read.reason).not.toContain('大小不一致');
  });

  it('sizeBytes 与实际不符 → 失败（原因可区分于「哈希不符」）', async () => {
    const { store, ref } = await writtenStore();
    const tampered: ImportedDocx = { ...ref, sizeBytes: ref.sizeBytes + 1 };
    const read = await readImportedDocxBytes(store, VIEW, tampered);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('大小不一致');
    expect(read.reason).not.toContain('哈希不符');
  });

  it('缺分块引用字段（无 templateId）→ validate 判非法且 read 明确失败，均不崩', async () => {
    const store = new FakeBridgeStore();
    const incomplete = {
      fileName: 'x.docx',
      sizeBytes: 12,
      uploadedAt: 1,
      chunkCount: 2,
      chunkSize: 4,
      contentHash: 'deadbeef',
    } as ImportedDocx;

    const v = validateImportedDocx(incomplete);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toContain('缺少内容');

    let threw = false;
    let read: Awaited<ReturnType<typeof readImportedDocxBytes>> | null = null;
    try {
      read = await readImportedDocxBytes(store, VIEW, incomplete);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(read?.ok).toBe(false);
  });
});

/* ===================== ⑤ legacy 兼容（只有 bytesBase64 的旧配置） ===================== */

describe('doc/template/storage · legacy 兼容', () => {
  it('仅含 bytesBase64、无 chunk 引用的旧配置 → 仍解出正确字节', async () => {
    const legacy = encodeImportedDocx('old.docx', RAW_BYTES, 1);
    const store = new FakeBridgeStore();
    const read = await readImportedDocxBytes(store, VIEW, legacy);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.legacy).toBe(true);
    expect(Array.from(read.bytes)).toEqual(Array.from(RAW_BYTES));
    // 正面锚点：legacy 读取**不访问任何块 key**（无分块可读）
    expect(store.reads.length).toBe(0);
  });
});

/* ===================== ⑥ ⭐ 原子性 ===================== */

describe('doc/template/storage · ⭐ 原子性（引用最后落、失败不引用）', () => {
  it('写块中途失败 → 不返回引用，且旧模板块**未被删除、仍可用**', async () => {
    const store = new FakeBridgeStore();
    const oldRef: ImportedDocx = {
      fileName: 'old.docx',
      sizeBytes: 6,
      uploadedAt: 1,
      templateId: 'tpl_old',
      chunkCount: 2,
      chunkSize: 4,
      contentHash: 'aaaaaaaa',
    };
    // 旧的块先就位
    store.map.set(templateChunkKey(VIEW, 'tpl_old', 0), 'AAAA');
    store.map.set(templateChunkKey(VIEW, 'tpl_old', 1), 'BBBB');

    // 新写入在第 2 块（index=2）中断
    store.failWriteWhen = (key, value) =>
      key.startsWith(templateKeyPrefixFor(VIEW, 'tpl_new')) && key.endsWith(':2') && value !== null;

    const res = await saveImportedDocx(
      store,
      VIEW,
      'new.docx',
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      oldRef,
      { templateId: 'tpl_new', chunkChars: 4, uploadedAt: 2 },
    );

    // 失败：无引用
    expect(res.ok).toBe(false);
    expect(res.reference).toBeUndefined();
    expect(res.error).toBeTruthy();
    // 旧块未被动（未被删、仍可读）
    expect(store.map.get(templateChunkKey(VIEW, 'tpl_old', 0))).toBe('AAAA');
    expect(store.map.get(templateChunkKey(VIEW, 'tpl_old', 1))).toBe('BBBB');
    expect(store.deleted.some((k) => k.startsWith(templateKeyPrefixFor(VIEW, 'tpl_old')))).toBe(false);
  });
});

/* ===================== ⑦ ⭐ 清理只删自己的块 ===================== */

describe('doc/template/storage · ⭐ 清理只删自己的块', () => {
  it('保存成功后删除的 key 全部带自己的 templateId 前缀；不碰其它 id / cbv:config / cbv:probe', async () => {
    const store = new FakeBridgeStore();
    // 预置：另一个模板的块 + 真实配置 key + 探针 key
    store.map.set(templateChunkKey(VIEW, 'tpl_other', 0), 'ZZZZ');
    store.map.set(`${CONFIG_KEY_PREFIX}:${VIEW}`, 'CONFIG_RAW');
    store.map.set(probeKey(VIEW, 1), 'PROBE_RAW');
    // 旧模板（将被清理）
    store.map.set(templateChunkKey(VIEW, 'tpl_old', 0), 'AAAA');
    store.map.set(templateChunkKey(VIEW, 'tpl_old', 1), 'BBBB');

    const previous: ImportedDocx = {
      fileName: 'old.docx',
      sizeBytes: 6,
      uploadedAt: 1,
      templateId: 'tpl_old',
      chunkCount: 2,
      chunkSize: 4,
      contentHash: 'aaaaaaaa',
    };

    const res = await saveImportedDocx(store, VIEW, 'new.docx', new Uint8Array([9, 8, 7, 6, 5, 4, 3]), previous, {
      templateId: 'tpl_new',
      chunkChars: 4,
      uploadedAt: 2,
    });
    expect(res.ok).toBe(true);

    // ⭐ 删除的 key 全部属于「自己的 viewId + 上一个 templateId」前缀
    const ownPrefix = templateKeyPrefixFor(VIEW, 'tpl_old');
    expect(store.deleted.length).toBe(2);
    expect(store.deleted.every((k) => k.startsWith(ownPrefix))).toBe(true);
    // 不含其它 id / 配置 / 探针
    expect(store.deleted.some((k) => k.includes('tpl_other'))).toBe(false);
    expect(store.deleted.some((k) => k.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.deleted.some((k) => k.startsWith(PROBE_KEY_PREFIX))).toBe(false);

    // 未受影响的 key 仍在
    expect(store.map.get(templateChunkKey(VIEW, 'tpl_other', 0))).toBe('ZZZZ');
    expect(store.map.get(`${CONFIG_KEY_PREFIX}:${VIEW}`)).toBe('CONFIG_RAW');
    expect(store.map.get(probeKey(VIEW, 1))).toBe('PROBE_RAW');

    // 正面锚点：新模板已写入且可读回
    const read = await readImportedDocxBytes(store, VIEW, res.reference as ImportedDocx);
    expect(read.ok).toBe(true);
  });

  it('deleteTemplateChunks 只删指定 id 的块（无 templateId → 不删任何 key）', async () => {
    const store = new FakeBridgeStore();
    store.map.set(templateChunkKey(VIEW, 'a', 0), 'X');
    store.map.set(templateChunkKey(VIEW, 'b', 0), 'Y');
    const deleted = await deleteTemplateChunks(store, VIEW, 'a', 1);
    expect(deleted).toEqual([templateChunkKey(VIEW, 'a', 0)]);
    expect(store.map.has(templateChunkKey(VIEW, 'b', 0))).toBe(true);
    // 空 id → 不删
    expect(await deleteTemplateChunks(store, VIEW, '', 3)).toEqual([]);
  });
});

/* ===================== ⑧ ⭐ 探针不碰真实 key ===================== */

describe('doc/template/storage · ⭐ 探针不碰真实 key', () => {
  it('探针全程只读写 cbv:probe:*，对 cbv:config:* / cbv:tpl:* 的访问次数为 0', async () => {
    const store = new FakeBridgeStore();
    store.maxBytes = 128 * 1024;
    await probeBridgeCapacity({ store, viewId: 'v', now: FIXED_NOW });

    expect(store.accessed.length).toBeGreaterThan(0);
    expect(store.accessed.every((key) => key.startsWith(PROBE_KEY_PREFIX))).toBe(true);
    expect(store.accessed.some((key) => key.startsWith(CONFIG_KEY_PREFIX))).toBe(false);
    expect(store.accessed.some((key) => key.startsWith(TEMPLATE_KEY_PREFIX))).toBe(false);
    // ⭐ 正面锚点：三个前缀确实两两不同（否则上面的守卫可能因前缀重叠而误判）
    expect(PROBE_KEY_PREFIX).not.toBe(CONFIG_KEY_PREFIX);
    expect(TEMPLATE_KEY_PREFIX).not.toBe(CONFIG_KEY_PREFIX);
    expect(TEMPLATE_KEY_PREFIX).not.toBe(PROBE_KEY_PREFIX);
    expect(probeKey('v', FIXED_NOW).startsWith(CONFIG_KEY_PREFIX)).toBe(false);
  });

  it('探测结束清理探针 key（配正面锚点：确实写过该 key）', async () => {
    const store = new FakeBridgeStore();
    store.maxBytes = 512 * 1024;
    const key = probeKey('v', FIXED_NOW);
    const res = await probeBridgeCapacity({ store, viewId: 'v', now: FIXED_NOW });
    expect(res.maxOkBytes).toBeGreaterThan(0);
    expect(store.writes.filter((k) => k === key).length).toBeGreaterThan(0);
    expect(store.map.has(key)).toBe(false);
  });

  it('递增探测命中上限即停止（32/64/128 成功、256 失败 → 512/1MB 未尝试）', async () => {
    const store = new FakeBridgeStore();
    store.maxBytes = 128 * 1024;
    const res = await probeBridgeCapacity({ store, viewId: 'v', now: FIXED_NOW });
    expect(res.maxOkBytes).toBe(128 * 1024);
    expect(res.results.map((r) => r.bytes)).toEqual([32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024]);
    expect(res.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(res.results.some((r) => r.bytes === 512 * 1024)).toBe(false);
    expect(res.results.some((r) => r.bytes === 1024 * 1024)).toBe(false);
  });

  it('写入被拒 / 抛错 / 无 bridge → 均不抛且记为失败', async () => {
    const reject = new FakeBridgeStore();
    reject.rejectWrites = true;
    const r1 = await probeBridgeCapacity({ store: reject, viewId: 'v', now: 1 });
    expect(r1.maxOkBytes).toBe(0);
    expect(r1.results[0].error).toContain('setData 返回 false');

    const boom = new FakeBridgeStore();
    boom.throwOnWrite = true;
    let threw = false;
    try {
      await probeBridgeCapacity({ store: boom, viewId: 'v', now: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(await probeBridgeCapacity({ store: null })).toEqual({ maxOkBytes: 0, results: [] });
    expect([...DEFAULT_PROBE_LADDER_BYTES].sort((a, b) => a - b)).toEqual([...DEFAULT_PROBE_LADDER_BYTES]);
  });
});

/* ===================== ⑨ 配置类型层 ===================== */

describe('doc/template/storage · docSource 缺省语义', () => {
  it('缺省 / undefined / null → blocks（配正面锚点：imported 仍 imported）', () => {
    expect(resolveDocSource(undefined)).toBe('blocks');
    expect(resolveDocSource(null)).toBe('blocks');
    expect(resolveDocSource({})).toBe('blocks');
    expect(resolveDocSource({ docSource: 'blocks' })).toBe('blocks');
    expect(resolveDocSource({ docSource: 'imported' })).toBe('imported');
  });

  it('默认详情配置不含 docSource / importedDocx（纯增、未改默认值）', () => {
    const detail = defaultDetailConfig();
    expect('docSource' in detail).toBe(false);
    expect('importedDocx' in detail).toBe(false);
    expect(resolveDocSource(detail)).toBe('blocks');
  });
});

/* ===================== ⑪ ⭐ 读取 / 探针绝不重写模板块 ===================== */

describe('doc/template/storage · ⭐ 读取与探针不产生任何模板块写入（⑧ 无关操作不重写）', () => {
  it('多次读回 + 探针 → cbv:tpl:* 的写入次数**保持不变**（读不写、探针不碰块）', async () => {
    const store = new FakeBridgeStore();
    const prepared = prepareImportedDocx('x.docx', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), {
      chunkChars: 4,
      templateId: 'tpl_r',
      uploadedAt: 1,
    });
    const written = await writeImportedDocxChunks(store, VIEW, prepared);
    expect(written.ok).toBe(true);
    // 正面锚点：保存确实写了多个模板块
    const tplWrites = (): number => store.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length;
    const baseline = tplWrites();
    expect(baseline).toBeGreaterThanOrEqual(2);

    // 多次「读回」= 详情侧每次打开 / 依赖变化都会重跑 → 必须 0 新增写入
    for (let i = 0; i < 3; i += 1) {
      const read = await readImportedDocxBytes(store, VIEW, prepared.reference);
      expect(read.ok).toBe(true);
    }
    expect(tplWrites()).toBe(baseline); // ⭐ 读绝不重写
    expect(store.reads.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBeGreaterThanOrEqual(3);

    // 探针也只动 cbv:probe:*，不得新增任何模板块写入
    store.maxBytes = 64 * 1024;
    await probeBridgeCapacity({ store, viewId: VIEW, now: 1 });
    expect(tplWrites()).toBe(baseline); // ⭐ 探针不碰模板块
  });

  it('分块模板 + 无 store → 显式失败（绝不返回空模板）', async () => {
    const store = new FakeBridgeStore();
    const prepared = prepareImportedDocx('x.docx', new Uint8Array([1, 2, 3]), {
      chunkChars: 4,
      templateId: 't',
      uploadedAt: 1,
    });
    const res = await readImportedDocxBytes(null, VIEW, prepared.reference);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('无可用模板存储');
    // 对照：同一个引用在有 store 时能读出（证明失败只因缺 store，而非引用本身坏）
    const ok = await readImportedDocxBytes(store, VIEW, prepared.reference);
    expect(ok.ok).toBe(false); // 未写块 → 缺块（仍需显式失败，不是空模板）
    if (ok.ok) throw new Error('unreachable');
    expect(ok.reason).toContain('缺少第 0 块');
  });
});

/* ===================== ⑩ 源码级守卫 ===================== */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const RAW_SOURCE = readFileSync(resolve(process.cwd(), 'src/doc/template/storage.ts'), 'utf8');
const SOURCE = stripComments(RAW_SOURCE);

describe('doc/template/storage · 源码级守卫', () => {
  it('模板块 / 探针都不得构造真实配置 key', () => {
    expect(SOURCE).not.toMatch(/configKey\s*\(/);
    expect(SOURCE).not.toMatch(/CONFIG_KEY_PREFIX/);
    expect(SOURCE).not.toMatch(/cbv:config/);
    // ⭐ 正面锚点：确实有专用前缀
    expect(SOURCE).toMatch(/TEMPLATE_KEY_PREFIX/);
    expect(SOURCE).toMatch(/:tpl/);
    expect(SOURCE).toMatch(/:probe/);
  });

  it('不得静态值 import @/sdk/base（只允许 import type + 动态 import()）', () => {
    expect(SOURCE).not.toMatch(/import\s*\{[^}]*\}\s*from\s*['"]@\/sdk\/base['"]/);
    expect(SOURCE).toMatch(/import\(\s*['"]@\/sdk\/base['"]\s*\)/);
  });

  it('源码含分块 / 上限依据说明（改常量须同步改注释）', () => {
    expect(RAW_SOURCE).toContain('4/3');
    expect(RAW_SOURCE).toContain('TEMPLATE_CHUNK_BASE64_CHARS');
  });
});

/* ===================== ⑫ ⭐ 失败链路日志出口（[cbv:tpl.store]，真机取证） ===================== */

/** 「写成功但读不到」的假 store：模拟 bridge 写后立读的最终一致性 / 缺块 */
class ReadMissingStore extends FakeBridgeStore {
  /** getData 对该块号恒返回 null（模拟「写入了但读回缺失」） */
  missingIndex = 1;

  async getData(key: string): Promise<unknown> {
    this.reads.push(key);
    if (key.endsWith(`:${this.missingIndex}`)) return null;
    return this.map.has(key) ? this.map.get(key) : null;
  }
}

describe('doc/template/storage · ⭐ 失败链路日志出口（[cbv:tpl.store]）', () => {
  /** 取 logWarn 的调用（[scope, message, ctx] 三元组） */
  const warnCalls = (): Array<[string, string, Record<string, unknown>?]> =>
    vi.mocked(logWarn).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;
  const infoCalls = (): Array<[string, string, Record<string, unknown>?]> =>
    vi.mocked(logInfo).mock.calls as unknown as Array<[string, string, Record<string, unknown>?]>;

  it('写块被拒（setData 返回 false）→ 一条 warn，含 templateId / chunkIndex / chunkCount / chunkChars / setDataReturn', async () => {
    const store = new FakeBridgeStore();
    store.rejectWrites = true; // setData 恒返回 false（模拟介质拒绝）
    const prepared = prepareImportedDocx('x.docx', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), {
      chunkChars: 4,
      templateId: 'tpl_log_rej',
      uploadedAt: 1,
    });
    const res = await writeImportedDocxChunks(store, VIEW, prepared);

    // 正面锚点：确实失败在第 0 块（7 字节 → base64 12 字符 → 3 块）
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('第 0 块被拒绝');
    // ⭐ 人话提示已追加（前缀保持既有形态，仅追加）
    expect(res.reason).toContain('写入模板块失败：第 0 块被拒绝');
    expect(res.reason).toContain('可能是平台单键存储上限导致，请压缩模板后重试');

    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('第 0 块被拒绝');
    expect(message).toContain('false'); // setData 返回值原样进 message
    expect(ctx?.phase).toBe('write-chunk-rejected');
    expect(ctx?.templateId).toBe('tpl_log_rej');
    expect(ctx?.chunkIndex).toBe(0);
    expect(ctx?.chunkCount).toBe(3);
    expect(ctx?.chunkChars).toBe(4);
    expect(ctx?.setDataReturn).toBe('false'); // ⭐ 区分「真机 resolve 非 true」的关键载荷
  });

  it('写块异常（setData 抛错）→ 一条 warn，含失败块号与底层原因文本', async () => {
    const store = new FakeBridgeStore();
    store.throwOnWrite = true;
    const prepared = prepareImportedDocx('x.docx', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), {
      chunkChars: 4,
      templateId: 'tpl_log_err',
      uploadedAt: 1,
    });
    const res = await writeImportedDocxChunks(store, VIEW, prepared);

    expect(res.ok).toBe(false); // 正面锚点
    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('bridge setData 抛错'); // formatError 归一后的底层原因
    expect(ctx?.phase).toBe('write-chunk-error');
    expect(ctx?.templateId).toBe('tpl_log_err');
    expect(ctx?.chunkIndex).toBe(0); // 抛错发生在写第 0 块时
    expect(ctx?.chunkCount).toBe(3);
    expect(String(ctx?.errorText)).toContain('bridge setData 抛错');
  });

  it('写后校验失败（读回缺块）→ 一条 warn，phase=verify-after-write 且含具体缺块原因', async () => {
    const store = new ReadMissingStore();
    const prepared = prepareImportedDocx('x.docx', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), {
      chunkChars: 4,
      templateId: 'tpl_log_verify',
      uploadedAt: 1,
    });
    const res = await writeImportedDocxChunks(store, VIEW, prepared);

    // 正面锚点：块确实都写进去了（失败只因读回缺第 1 块，不是写入失败）
    expect(store.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBe(3);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('缺少第 1 块');

    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('写入后校验失败');
    expect(message).toContain('缺少第 1 块');
    expect(ctx?.phase).toBe('verify-after-write');
    expect(ctx?.templateId).toBe('tpl_log_verify');
    expect(ctx?.chunkCount).toBe(3);
    expect(ctx?.sizeBytes).toBe(7);
  });

  it('超限 → 一条 warn，phase=oversize 且含实际字节数与上限', async () => {
    const store = new FakeBridgeStore();
    const size = MAX_IMPORTED_DOCX_BYTES + 4096;
    const res = await saveImportedDocx(store, VIEW, 'big.docx', bigBytes(size));

    expect(res.ok).toBe(false); // 正面锚点
    expect(res.error).toContain('超出上限');
    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain(String(size));
    expect(ctx?.phase).toBe('oversize');
    expect(ctx?.sizeBytes).toBe(size);
    expect(ctx?.maxBytes).toBe(MAX_IMPORTED_DOCX_BYTES);
  });

  it('清理旧块失败 → 逐块一条 warn（phase=cleanup-chunk-error），其余块仍被清理', async () => {
    const store = new FakeBridgeStore();
    // 只有第 1 块的「写 null（=清除）」抛错
    store.failWriteWhen = (key, value) => value === null && key.endsWith(':1');
    const deleted = await deleteTemplateChunks(store, VIEW, 'tpl_log_del', 3);

    // 正面锚点：3 块中 2 块仍被清掉（单块失败不中断）
    expect(deleted.length).toBe(2);
    expect(deleted).not.toContain(templateChunkKey(VIEW, 'tpl_log_del', 1));
    const calls = warnCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('第 1 块');
    expect(ctx?.phase).toBe('cleanup-chunk-error');
    expect(ctx?.templateId).toBe('tpl_log_del');
    expect(ctx?.chunkIndex).toBe(1);
    expect(ctx?.chunkCount).toBe(3);
  });

  it('⭐ 成功路径零日志（写块 / 读回校验 / 读模板均不打 warn / info）', async () => {
    const store = new FakeBridgeStore();
    const res = await saveImportedDocx(store, VIEW, 'ok.docx', new Uint8Array([9, 8, 7, 6, 5, 4, 3]), null, {
      templateId: 'tpl_log_ok',
      chunkChars: 4,
      uploadedAt: 2,
    });

    // 正面锚点：保存确实成功且块已写入（防止「没跑所以没日志」的假绿）
    expect(res.ok).toBe(true);
    expect(store.writes.filter((k) => k.startsWith(TEMPLATE_KEY_PREFIX)).length).toBeGreaterThanOrEqual(2);
    const read = await readImportedDocxBytes(store, VIEW, res.reference as ImportedDocx);
    expect(read.ok).toBe(true);

    expect(warnCalls().length).toBe(0);
    expect(infoCalls().length).toBe(0);
  });

  it('探针结果摘要 → 恰一条 info（含最大可写字节与逐档结论）；无 store 时不打', async () => {
    const store = new FakeBridgeStore();
    store.maxBytes = 128 * 1024; // 32/64/128 成功，256 失败即停
    const res = await probeBridgeCapacity({ store, viewId: 'v', now: FIXED_NOW });

    expect(res.maxOkBytes).toBe(128 * 1024); // 正面锚点：探测确实得出了结论
    const calls = infoCalls();
    expect(calls.length).toBe(1);
    const [scope, message, ctx] = calls[0];
    expect(scope).toBe('tpl.store');
    expect(message).toContain('容量探测完成');
    expect(message).toContain(String(128 * 1024));
    expect(message).toContain('ok');
    expect(message).toContain('fail');
    expect(ctx?.maxOkBytes).toBe(128 * 1024);
    expect(ctx?.steps).toBe(4);
    expect(warnCalls().length).toBe(0); // 探针的「档位失败」是结论不是故障，不打 warn

    // 无 store → 空结果不打 info（由 UI 文案负责告知）
    vi.clearAllMocks();
    expect(await probeBridgeCapacity({ store: null })).toEqual({ maxOkBytes: 0, results: [] });
    expect(infoCalls().length).toBe(0);
  });
});

/* ===================== ⑬ ⭐ 向后兼容：读取不依赖当前分块常量 ===================== */

describe('doc/template/storage · ⭐ 旧 chunkSize=131072（v1.4.0 时代）引用的向后兼容', () => {
  it('读取只用 chunkCount/sizeBytes/contentHash——chunkSize 谎报为 131072 仍可完整读写往返', async () => {
    const store = new FakeBridgeStore();
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    // 用 8 字符/块切块：模拟 v1.4.0 时代「单块实际长度远小于 64KB」的真实小模板
    const prepared = prepareImportedDocx('old.docx', new Uint8Array(bytes), {
      chunkChars: 8,
      templateId: 'tpl_v140',
      uploadedAt: 1,
    });
    // 正面锚点：实际块确实很短（≤ 8 字符，远小于当时的 131072 常量）
    expect(prepared.chunks.length).toBeGreaterThanOrEqual(2);
    expect(prepared.chunks.every((c) => c.length <= 8)).toBe(true);

    // 构造 v1.4.0 时代的引用形态：chunkSize=131072（当时常量），其余元数据（chunkCount/sizeBytes/contentHash）真实
    const legacyRef: ImportedDocx = { ...prepared.reference, chunkSize: 128 * 1024 };

    // ① 校验层：isCompleteReference 只要求 chunkSize 为正整数，不与当前常量比较
    expect(validateImportedDocx(legacyRef).ok).toBe(true);

    // ② 写入 + 读回校验：只按 templateId/chunkCount 定 key，不按 chunkSize 切分
    const written = await writeImportedDocxChunks(store, VIEW, { ...prepared, reference: legacyRef });
    expect(written.ok).toBe(true);

    // ③ 读取侧：按 chunkCount 逐块拼装 + sizeBytes/contentHash 校验，全程不用当前分块常量
    const read = await readImportedDocxBytes(store, VIEW, legacyRef);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(Array.from(read.bytes)).toEqual(bytes);
  });
});
