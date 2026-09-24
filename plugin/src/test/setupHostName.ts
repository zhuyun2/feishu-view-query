/**
 * vitest 全局 setup：伪造 `window.name`（§0.3.4 方案 ③ / team-lead 裁定 3）。
 *
 * 为什么要写这一行：
 *  `@lark-opdev/block-bitable-api` 在 **import 期**就读 `window.name`，期望宿主写入
 *  `{ blockTypeId, channel }`；读不到就抛 `Block client only running in Block host`。
 *  jsdom 默认给的是空串，因此**任何**一个测试只要真的 import 了 SDK，就会炸。
 *
 * 为什么是「无条件加固」而不是等出事再加：
 *  当前 422 个用例**零运行时加载 SDK**（哨兵实验实证），现在是安全的；但只要将来有人
 *  写了值导入的测试、或某条 import 链被改成静态求值，整个套件会瞬间崩溃。
 *  这一行是廉价的保险，对现有用例零影响（实测 30 files / 422 passed / EXIT=0）。
 *
 * ⚠️ 这里的值是**测试契约用的假值**，与真机 `blockTypeId` 无关，绝不可用作业务判据。
 *
 * ⚠️ 2026-09-23 更新：**本行已不足以让「真 import SDK 的测试」干净通过**。
 *  背景：需求 2 的「关联记录读取器」让 `useImportedDoc` 在**主套件**里也会动态 import
 *  `@/sdk/base`（进而 import 真 SDK）——原先「主套件零运行时加载 SDK」的前提不再成立。
 *  实测后果：SDK import 期向宿主发消息（`WidgetBase_getBasePermission` /
 *  `WidgetBase_registerBaseEvent` 等）在 jsdom 里被**自己**收到却无人应答 →
 *  16 个未处理 rejection → **断言全绿但 vitest 退出码 = 1**。
 *
 *  处理方式：把 `window.postMessage` 置空。这**不是**放宽错误阈值，而是**如实建模环境**
 *  ——jsdom 里根本没有宿主，这些消息本来就永远不可能被应答。与 `setupSdkSmoke.ts`
 *  （隔离 SDK 配置）用的是同一手段，保持两处一致。
 *  ⚠️ 仍然**不得**使用 `dangerouslyIgnoreUnhandledErrors`：那才是真的蒙住眼睛。
 */
window.name = JSON.stringify({ blockTypeId: 'blk_test_only', channel: 'ch_test_only' });
window.postMessage = () => undefined;

export {};
