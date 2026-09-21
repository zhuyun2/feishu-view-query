import { describe, expect, it } from 'vitest';
import { checksum, checksumOf, stableStringify, utf8ByteLength } from './hash';

describe('utils/hash', () => {
  it('stableStringify 与 key 顺序无关', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('stableStringify 保持数组顺序（数组有序）', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('stableStringify 丢弃 undefined 字段', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('checksum 是确定性 8 位十六进制', () => {
    expect(checksum('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(checksum('hello')).toBe(checksum('hello'));
    expect(checksum('hello')).not.toBe(checksum('hello!'));
  });

  it('checksumOf 对同一对象稳定、对不同对象不同', () => {
    const first = { x: 1, y: [1, 2, { z: 'a' }] };
    const second = { y: [1, 2, { z: 'a' }], x: 1 };
    expect(checksumOf(first)).toBe(checksumOf(second));
    expect(checksumOf(first)).not.toBe(checksumOf({ x: 2, y: [1, 2, { z: 'a' }] }));
  });

  it('utf8ByteLength 正确处理中文多字节', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('a中')).toBe(4);
  });
});
