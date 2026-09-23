/**
 * 回归测试（工程师）——`formatError`：真机 E2E「初始化失败不可诊断」缺陷。
 *
 * 判别性自检（本项目 M2 假绿审查标准）：若故意把实现改坏（如一律返回兜底文案、
 * 或丢掉 code、或遇到循环引用抛异常），下面的断言**必须变红**。
 */
import { describe, expect, it } from 'vitest';
import { formatError } from './errorText';

class PermDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermDenied';
  }
}

describe('formatError · Error 实例', () => {
  it('标准 Error → 只返回 message（不画蛇添足加 name）', () => {
    expect(formatError(new Error('x'))).toBe('x');
  });

  it('name 非 Error 时带上 name（TypeError → "TypeError: bad"）', () => {
    const result = formatError(new TypeError('bad'));
    expect(result).toBe('TypeError: bad');
    expect(result).not.toBe('bad');
  });

  it('自定义错误子类：name 与 message 都不丢', () => {
    expect(formatError(new PermDeniedError('no scope'))).toBe('PermDenied: no scope');
  });
});

describe('formatError · 基本类型', () => {
  it('字符串原样返回', () => {
    expect(formatError('plain text')).toBe('plain text');
  });

  it('null / undefined / 数字 → 字符串化，且不抛异常', () => {
    expect(formatError(null)).toBe('null');
    expect(formatError(undefined)).toBe('undefined');
    expect(formatError(123)).toBe('123');
  });

  it('布尔与 Symbol → 返回字符串', () => {
    expect(formatError(false)).toBe('false');
    expect(typeof formatError(Symbol('sym'))).toBe('string');
  });
});

describe('formatError · SDK 风格对象（飞书拒绝 Promise 时抛的是普通对象）', () => {
  it('{ code, msg } → code=<code> <msg>', () => {
    const result = formatError({ code: 10001, msg: 'permission denied' });
    expect(result).toBe('code=10001 permission denied');
    expect(result).toContain('code=10001');
    expect(result).toContain('permission denied');
  });

  it('{ message } → message', () => {
    expect(formatError({ message: 'boom' })).toBe('boom');
  });

  it('{ error: "inner" } / { error_msg } 也能取到文案', () => {
    expect(formatError({ error: 'inner' })).toBe('inner');
    expect(formatError({ error_msg: 'nope' })).toBe('nope');
  });

  it('仅有 code 无文案 → code=<code>', () => {
    expect(formatError({ code: 'AUTH_FAIL' })).toBe('code=AUTH_FAIL');
  });

  it('无法识别的字段 → 安全序列化为 JSON（而非 [object Object]）', () => {
    expect(formatError({ a: 1 })).toBe('{"a":1}');
  });

  it('★ 本缺陷的核心：非 Error 对象不会退化成无信息兜底文案', () => {
    const result = formatError({ code: 10001, msg: 'permission denied' });
    expect(result).not.toBe('初始化失败，请重试');
    expect(result).not.toBe('[object Object]');
    expect(result.length).toBeGreaterThan(10);
  });
});

describe('formatError · 健壮性（绝不抛异常）', () => {
  it('循环引用对象 → 返回非空字符串且不抛异常', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;

    let out = '';
    expect(() => {
      out = formatError(circular);
    }).not.toThrow();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('root');
  });

  it('深层循环引用同样不抛异常', () => {
    const a: Record<string, unknown> = { level: 'a' };
    const b: Record<string, unknown> = { level: 'b' };
    a.child = b;
    b.parent = a;
    expect(() => formatError(a)).not.toThrow();
    expect(typeof formatError(a)).toBe('string');
  });

  it('含函数的对象 → 不抛异常且返回字符串', () => {
    const result = formatError({ fn: () => 1 });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('getter 抛异常的恶意对象 → 兜底不崩（不把取错误信息变成新崩溃点）', () => {
    const hostile = {
      get message(): string {
        throw new Error('hostile');
      },
    };
    let out = '';
    expect(() => {
      out = formatError(hostile);
    }).not.toThrow();
    expect(typeof out).toBe('string');
  });

  it('null 原型对象 → 不抛异常', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.foo = 'bar';
    expect(() => formatError(bare)).not.toThrow();
  });
});
