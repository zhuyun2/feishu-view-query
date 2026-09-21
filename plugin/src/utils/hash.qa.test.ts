/**
 * QA 独立复核（M1 / T04）：checksum 篡改检测与极端输入。
 */
import { describe, expect, it } from 'vitest';
import { checksum, checksumOf, stableStringify, utf8ByteLength } from './hash';

describe('QA · utils/hash 篡改检测与极端输入（独立复核）', () => {
  it('篡改任意一个字符（字节）→ checksum 必变化', () => {
    const base = 'hello-world';
    const baseline = checksum(base);
    for (let i = 0; i < base.length; i += 1) {
      const mutated = `${base.slice(0, i)}${base[i] === 'z' ? 'y' : 'z'}${base.slice(i + 1)}`;
      expect(checksum(mutated), `position ${i}`).not.toBe(baseline);
    }
  });

  it('checksumOf：payload 单字节改动 → 校验值变化', () => {
    expect(checksumOf({ token: 'abcDEF' })).not.toBe(checksumOf({ token: 'abcDEg' }));
    expect(checksumOf({ n: 1 })).not.toBe(checksumOf({ n: 2 }));
    expect(checksumOf({})).not.toBe(checksumOf({ a: null }));
  });

  it('空字符串不崩（FNV-1a 初值），超长字符串不崩且格式稳定', () => {
    expect(checksum('')).toBe('811c9dc5');
    expect(checksum('')).toMatch(/^[0-9a-f]{8}$/);
    const long = 'x'.repeat(1_000_000);
    expect(checksum(long)).toMatch(/^[0-9a-f]{8}$/);
    expect(checksum(long)).toBe(checksum(long));
  });

  it('stableStringify：undefined 归一为 null / 丢弃 undefined 值 / 键序无关', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify({ a: undefined })).toBe('{}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify([{ b: 1, a: 2 }])).toBe(stableStringify([{ a: 2, b: 1 }]));
  });

  it('utf8ByteLength：空串 / 中文 / 代理对（emoji）字节数正确', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});
