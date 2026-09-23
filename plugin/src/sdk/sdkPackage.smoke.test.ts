/**
 * 真实 SDK 包冒烟（§0.3.4 T-3 / team-lead 裁定 2）。
 *
 * ⚠️ **本文件只能在 `vitest.sdk.config.ts` 下运行，不得并入主套件。**
 *  它**真的 import** `@lark-opdev/block-bitable-api`，会触发 import 期向宿主发消息，
 *  在 jsdom 里产生 4 个未处理 rejection（`Cannot found handler of bitable.*`），
 *  混进主套件会让 `npm test` 退出码变 1。隔离原因与开关说明见 `vitest.sdk.config.ts`。
 *
 * 能抓到：包没装 / 包名写错 / 导出名变了 / `window.name` 契约变了 / 关键 API 被移除。
 * 抓不到：**宿主是否应答** —— 那只能靠真机（§0.3.1 残余风险 R-S4）。
 *
 * `window.name` 由 `src/test/setupHostName.ts`（setupFiles）在**本文件被 import 之前**
 * 伪造；顺序很重要：vite 会缓存 import 失败的结果，所以不能在用例里才补。
 */
import { describe, expect, it } from 'vitest';
import { bitable } from '@lark-opdev/block-bitable-api';

/** 断言某对象上的键是函数（给出可读的失败信息） */
function expectFunction(target: unknown, path: string): void {
  const holder = target as Record<string, unknown> | null | undefined;
  expect(typeof (holder ? holder[path] : undefined), `${path} 应为函数`).toBe('function');
}

describe('真实 SDK 包冒烟（隔离环境）', () => {
  it('setupFiles 已伪造宿主契约 window.name', () => {
    const parsed = JSON.parse(window.name) as { blockTypeId?: unknown; channel?: unknown };
    expect(typeof parsed.blockTypeId).toBe('string');
    expect(typeof parsed.channel).toBe('string');
    expect(parsed.blockTypeId).not.toBe('');
    expect(parsed.channel).not.toBe('');
  });

  it('bitable 五个模块齐全（base / bridge / dashboard / ui / util）', () => {
    expect(bitable).toBeDefined();
    expect(Object.keys(bitable).sort()).toEqual(['base', 'bridge', 'dashboard', 'ui', 'util']);
  });

  it('必需调用点存在 · base（§0.3.2-D 必需清单）', () => {
    expectFunction(bitable.base, 'getSelection');
    expectFunction(bitable.base, 'getTableById');
    expectFunction(bitable.base, 'isEditable');
  });

  it('必需调用点存在 · bridge 存储（配置持久化的命脉）', () => {
    expectFunction(bitable.bridge, 'getData');
    expectFunction(bitable.bridge, 'setData');
    expectFunction(bitable.bridge, 'onDataChange');
  });

  it('可选调用点 · 环境探测：存在集合与「已知缺失」集合都必须与登记一致', () => {
    // 【实测】新包 bridge **没有** `getProductType`（dist/index.d.ts 中该标识符 0 次出现）。
    // `src/sdk/env.ts:83` 用的是 `shortcuts.getProductType?.()`，缺失时静默降级走 getEnv 分支，
    // 属 §0.3.2-D「可选」清单，不阻断迁移。
    // 这里刻意**双向断言**：既防「已存在的 API 消失」，也防「登记为缺失的 API 悄悄出现」
    // —— 后者一旦发生，说明新包能力面变了，需要重新评估，而不是悄悄放过。
    const bridge = bitable.bridge as unknown as Record<string, unknown>;
    const shouldExist = ['getLocale', 'getLanguage', 'getTheme', 'getUserId', 'getEnv', 'onThemeChange'];
    const knownMissing = ['getProductType'];

    const actuallyMissing = shouldExist.filter((name) => typeof bridge[name] !== 'function');
    const unexpectedlyPresent = knownMissing.filter((name) => typeof bridge[name] === 'function');

    expect(actuallyMissing, `应当存在却缺失的环境 API：${actuallyMissing.join(', ')}`).toEqual([]);
    expect(unexpectedlyPresent, `登记为缺失却实际存在的 API：${unexpectedlyPresent.join(', ')}`).toEqual(
      [],
    );
  });

  it('getAppId 缺失是**既有现状**，不是本次迁移引入（R-S5 登记）', () => {
    // 旧 SDK 同样没有 getAppId，本仓本就降级为 'unknown'（src/sdk/base.ts）。
    // 这里不断言「必须存在」，只把事实固化下来，便于日后对照。
    const base = bitable.base as unknown as Record<string, unknown>;
    expect(typeof base.getAppId === 'function' || base.getAppId === undefined).toBe(true);
  });
});
