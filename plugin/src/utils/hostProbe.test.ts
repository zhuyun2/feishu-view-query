/**
 * 回归测试（工程师）——`hostProbe`：真机 E2E「所有 SDK 调用统一 timeout」的宿主取证。
 *
 * 判别性自检（本项目 M2 假绿审查标准）：每条断言都要能回答
 * 「**故意把实现改坏，这条断言会红吗？**」，不会红的已重写。
 * 例如：若把 `window.name` 的 try/catch 去掉，`③ 不抛异常` 必红；
 * 若把 `hasBlockTypeId` 写成恒 true，`② 空串` 必红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectErrorShape,
  collectHostProbe,
  formatErrorShape,
  formatHostProbe,
  judgeHostProtocol,
  type HostProbeResult,
} from './hostProbe';

const BLOCK_NAME = JSON.stringify({ blockTypeId: 'blk_6aaf898df2018cd7544bdf7c', channel: 'ch_1' });

/** 临时改写一个 window 属性，用完按原描述符恢复（jsdom 下 window.top/parent 均可重定义） */
function withWindowProp(key: string, descriptor: PropertyDescriptor, fn: () => void): void {
  const target = window as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(window, key);
  Object.defineProperty(window, key, { configurable: true, ...descriptor });
  try {
    fn();
  } finally {
    if (original) {
      Object.defineProperty(window, key, original);
    } else {
      delete target[key];
    }
  }
}

afterEach(() => {
  window.name = '';
});

describe('collectHostProbe · window.name 解析', () => {
  it('① 合法 {blockTypeId,channel} → 两个标记都为 true，且 parsed 与原文都完整保留', () => {
    window.name = BLOCK_NAME;

    const result = collectHostProbe();

    expect(result.windowNameRaw).toBe(BLOCK_NAME);
    expect(result.windowNameParsed).toEqual({
      blockTypeId: 'blk_6aaf898df2018cd7544bdf7c',
      channel: 'ch_1',
    });
    expect(result.hasBlockTypeId).toBe(true);
    expect(result.hasChannel).toBe(true);
    expect(result.windowNameParseError).toBeNull();
    // 判别式：实现若恒返回 true，则下一条必红
    expect(judgeHostProtocol(result)).toBe('iframe-block');
  });

  it('② 空串 → 无法解析，两个标记都为 false（且不误报解析错误）', () => {
    window.name = '';

    const result = collectHostProbe();

    expect(result.windowNameRaw).toBe('');
    expect(result.windowNameParsed).toBeNull();
    expect(result.hasBlockTypeId).toBe(false);
    expect(result.hasChannel).toBe(false);
    expect(result.windowNameParseError).toBeNull();
    // 判别式：实现若把 hasBlockTypeId 写死 true，本条必红
    expect(result.hasBlockTypeId).not.toBe(true);
  });

  it('③ 垃圾字符串 → 记录解析错误且函数绝不抛异常', () => {
    window.name = 'not-json';

    let result: HostProbeResult | null = null;
    expect(() => {
      result = collectHostProbe();
    }).not.toThrow();

    const probe = result as unknown as HostProbeResult;
    expect(probe.windowNameRaw).toBe('not-json');
    expect(probe.windowNameParsed).toBeNull();
    expect(typeof probe.windowNameParseError).toBe('string');
    expect((probe.windowNameParseError as string).length).toBeGreaterThan(0);
    expect(probe.hasBlockTypeId).toBe(false);
    expect(probe.hasChannel).toBe(false);
  });

  it('③b 合法 JSON 但缺字段 → 解析成功而标记仍为 false（区分"解析失败"与"字段缺失"）', () => {
    window.name = JSON.stringify({ blockTypeId: 'blk_x' }); // 缺 channel

    const result = collectHostProbe();

    expect(result.windowNameParseError).toBeNull();
    expect(result.windowNameParsed).toEqual({ blockTypeId: 'blk_x' });
    expect(result.hasBlockTypeId).toBe(true);
    expect(result.hasChannel).toBe(false);
    // 判别式：判定必须要求两个字段同时在，缺一个就不算 iframe-block
    expect(judgeHostProtocol(result)).not.toBe('iframe-block');
  });

  it('③c 合法 JSON 但 blockTypeId 是空串 → 不算有值', () => {
    window.name = JSON.stringify({ blockTypeId: '', channel: 'ch_1' });
    const result = collectHostProbe();
    expect(result.hasBlockTypeId).toBe(false);
    expect(result.hasChannel).toBe(true);
    expect(judgeHostProtocol(result)).not.toBe('iframe-block');
  });
});

describe('collectHostProbe · iframe 层级判定', () => {
  it('④ window.top 访问抛异常（跨域）→ 不抛异常，且其余字段照常采满', () => {
    window.name = BLOCK_NAME;

    withWindowProp(
      'top',
      {
        get(): unknown {
          throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame.');
        },
      },
      () => {
        let result: HostProbeResult | null = null;
        expect(() => {
          result = collectHostProbe();
        }).not.toThrow();

        const probe = result as unknown as HostProbeResult;
        // 跨域祖先存在 → 必然不是顶层
        expect(probe.isTopLevel).toBe(false);
        // 判别式：若实现用「一个 try/catch 包到底」，这里会退化成空对象 —— 故逐字段校验
        expect(probe.windowNameRaw).toBe(BLOCK_NAME);
        expect(probe.hasBlockTypeId).toBe(true);
        expect(probe.hasChannel).toBe(true);
        expect(typeof probe.href).toBe('string');
        expect(typeof probe.origin).toBe('string');
        expect(typeof probe.userAgent).toBe('string');
        expect(typeof probe.referrer).toBe('string');
        expect(judgeHostProtocol(probe)).toBe('iframe-block');
      },
    );
  });

  it('④b window.parent 访问抛异常 → 保守判为在 iframe 内，且不抛异常', () => {
    withWindowProp(
      'parent',
      {
        get(): unknown {
          throw new Error('blocked');
        },
      },
      () => {
        const result = collectHostProbe();
        expect(result.inIframe).toBe(true);
        expect(result.ancestorCount).toBe(2);
      },
    );
  });

  it('⑤ 存在父窗口（parent !== window）→ inIframe=true / ancestorCount=2', () => {
    withWindowProp('parent', { value: {} as unknown as Window & typeof globalThis }, () => {
      const result = collectHostProbe();
      expect(result.inIframe).toBe(true);
      expect(result.ancestorCount).toBe(2);
      // 判别式：在 iframe 内但 window.name 无协议字段 → 只能是「未知」，不是 iframe-block
      expect(judgeHostProtocol(result)).toBe('unknown');
    });
  });

  it('⑤b 无父窗口（默认 jsdom）→ inIframe=false / ancestorCount=1 / 判定为不在 iframe 中', () => {
    expect(window.parent === window).toBe(true); // 前置：jsdom 默认是顶层
    const result = collectHostProbe();
    expect(result.inIframe).toBe(false);
    expect(result.ancestorCount).toBe(1);
    expect(result.isTopLevel).toBe(true);
    expect(judgeHostProtocol(result)).toBe('not-in-iframe');
  });
});

describe('collectHostProbe · 恶劣宿主环境（绝不抛异常）', () => {
  it('⑥ window.name 的 getter 抛异常 → 降级为空串，其余字段照常返回', () => {
    withWindowProp(
      'name',
      {
        get(): string {
          throw new Error('hostile name');
        },
      },
      () => {
        let result: HostProbeResult | null = null;
        expect(() => {
          result = collectHostProbe();
        }).not.toThrow();

        const probe = result as unknown as HostProbeResult;
        expect(probe.windowNameRaw).toBe('');
        expect(probe.windowNameParsed).toBeNull();
        expect(probe.hasBlockTypeId).toBe(false);
        expect(typeof probe.userAgent).toBe('string');
      },
    );
  });

  it('⑦ navigator.userAgent 的 getter 抛异常 → 该字段降级为空串，不牵连其他字段', () => {
    window.name = BLOCK_NAME;
    const navDescriptor = Object.getOwnPropertyDescriptor(window, 'navigator');
    Object.defineProperty(window, 'navigator', {
      configurable: true,
      get(): unknown {
        throw new Error('hostile ua');
      },
    });
    try {
      const result = collectHostProbe();
      expect(result.userAgent).toBe('');
      // 判别式：其余字段不受影响
      expect(result.windowNameRaw).toBe(BLOCK_NAME);
      expect(result.hasBlockTypeId).toBe(true);
    } finally {
      if (navDescriptor) Object.defineProperty(window, 'navigator', navDescriptor);
    }
  });
});

describe('formatHostProbe · 可复制的诊断文本', () => {
  it('包含 window.name 原文、协议判定、iframe 结论，且「未知」与「命中」互斥', () => {
    window.name = BLOCK_NAME;
    const text = formatHostProbe(collectHostProbe());

    expect(text).toContain(BLOCK_NAME);
    expect(text).toContain('iframe-block ✓');
    expect(text).toContain('在 iframe 内    = ');
    expect(text).not.toContain('未知（需另行取证）');
    // 多行文本，供 <pre> 整段复制
    expect(text.split('\n').length).toBeGreaterThan(5);
  });

  it('不在 iframe 中时明确写出「换 SDK 无效」，避免误判', () => {
    const text = formatHostProbe(collectHostProbe());
    expect(text).toContain('不在 iframe 中');
    expect(text).toContain('换 SDK 无效');
    expect(text).not.toContain('iframe-block ✓');
  });

  it('window.name 为空时输出 (空) 占位，而不是把它当成解析成功', () => {
    window.name = '';
    const text = formatHostProbe(collectHostProbe());
    expect(text).toContain('window.name    = (空)');
    expect(text).not.toContain('iframe-block ✓');
  });
});

describe('collectErrorShape · 真机 timeout 一词来源取证', () => {
  it('字符串 "timeout"（一词）→ String(err) 与 formatError 都是它本身，不是 Error 实例', () => {
    const shape = collectErrorShape('timeout');
    expect(shape.stringified).toBe('timeout');
    expect(shape.formatted).toBe('timeout');
    expect(shape.typeOf).toBe('string');
    expect(shape.isErrorInstance).toBe(false);
  });

  it('字符串 "time out"（SDK 里的两词字面量）→ 与一词形态可区分', () => {
    const shape = collectErrorShape('time out');
    expect(shape.stringified).toBe('time out');
    expect(shape.typeOf).toBe('string');
    // 判别式：两种字面量不能混为一谈
    expect(shape.stringified).not.toBe('timeout');
  });

  it('Error 实例 → String(err) 带 "Error: " 前缀，instanceof 为 true', () => {
    const shape = collectErrorShape(new Error('boom'));
    expect(shape.isErrorInstance).toBe(true);
    expect(shape.typeOf).toBe('object');
    expect(shape.stringified).toContain('Error');
    // 判别式：String(err) 与 formatError(err) 必须不同（后者不带 name 前缀）
    expect(shape.formatted).toBe('boom');
    expect(shape.stringified).not.toBe(shape.formatted);
  });

  it('SDK 风格普通对象 → String(err) 是 [object Object]，只有 formatError 能捞出 code', () => {
    const shape = collectErrorShape({ code: 10001, msg: 'permission denied' });
    expect(shape.typeOf).toBe('object');
    expect(shape.isErrorInstance).toBe(false);
    expect(shape.stringified).toBe('[object Object]');
    expect(shape.formatted).toBe('code=10001 permission denied');
    // 判别式：这一条正是「为什么必须有 formatError」的证据
    expect(shape.stringified).not.toContain('10001');
  });

  it('toString 会抛异常的对象 → 不抛，且给出可读占位', () => {
    const hostile = {
      toString(): string {
        throw new Error('hostile toString');
      },
    };
    let shape: ReturnType<typeof collectErrorShape> | null = null;
    expect(() => {
      shape = collectErrorShape(hostile);
    }).not.toThrow();
    expect((shape as unknown as { stringified: string }).stringified).toContain('String(err) 抛异常');
  });
});

describe('formatErrorShape · 文本输出', () => {
  it('四条取证信息全部出现，且能区分 timeout 一词与两词', () => {
    const text = formatErrorShape(collectErrorShape('timeout'));
    expect(text).toContain('timeout');
    expect(text).toContain('typeof err            = string');
    expect(text).toContain('err instanceof Error  = false');
    expect(text).toContain('String(err)');

    const twoWords = formatErrorShape(collectErrorShape('time out'));
    expect(twoWords).toContain('time out');
    expect(twoWords).not.toContain('= timeout');
  });
});
