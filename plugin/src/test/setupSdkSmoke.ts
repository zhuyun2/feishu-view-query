/**
 * **仅** `vitest.sdk.config.ts` 使用的 setup：让真实 SDK 包能在 jsdom 里被 import。
 * 主配置用的是 `setupHostName.ts`（只伪造 `window.name`），不要混用。
 *
 * 为什么需要这个文件（实测结论，不是猜测）：
 *  1. `window.name`：新 SDK 在 **import 期**就读它，期望 `{ blockTypeId, channel }`，
 *     读不到就抛 `Block client only running in Block host`。
 *  2. `postMessage`：SDK import 期还会立刻向「宿主」发 3~4 条消息
 *     （`WidgetBase_getBasePermission` / `WidgetBase_registerBaseEvent` /
 *     `Private_setClientVersion`）。jsdom 里 `window.parent === window`，消息被**自己**
 *     收到却无人应答 → 4 个未处理 rejection → vitest 记 `Errors 4`、**退出码变 1**
 *     （实测：`_sdktmp/_run3d.txt`、`_sdktmp/_p4_sdk.txt`）。
 *
 * 第 2 点的处理是**在 import 之前把 postMessage 置空**：反正 jsdom 里也没有真宿主，
 * 这些消息本来就不可能有应答。这样既保住了「真的 import 真包」的验证价值，
 * 又不需要动用 `dangerouslyIgnoreUnhandledErrors` 去放宽错误阈值。
 *
 * ⚠️ 顺序不可变：setupFiles 一定早于测试文件被 import；vite 会缓存 import 失败的结果，
 * 所以绝不能把伪造挪到用例体里。
 */
window.name = JSON.stringify({ blockTypeId: 'blk_test_only', channel: 'ch_test_only' });
window.postMessage = () => undefined;

export {};
