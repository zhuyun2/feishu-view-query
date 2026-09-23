/**
 * 隔离的 vitest 配置：**只跑真实 SDK 包的冒烟用例**（§0.3.4 T-3 / team-lead 裁定 2）。
 *
 * 为什么必须隔离：
 *  真实包一旦被 import，会在 import 期就向「宿主」发消息（`WidgetBase_getBasePermission`、
 *  `WidgetBase_registerBaseEvent`、`Private_setClientVersion` 等），而 jsdom 里没有宿主应答，
 *  于是产生 **4 个未处理 rejection** —— vitest 会记 `Errors 4` 并把**退出码变成 1**
 *  （已实测：`_sdktmp/_run3d.txt`）。这个用例若混进主套件，会让 `npm test` 变成红。
 *
 * 因此：
 *  - 主配置 `vitest.config.ts` **显式排除**本用例文件，也**不**放宽任何错误阈值；
 *  - 本配置用 `src/test/setupSdkSmoke.ts`（含 postMessage 置空）从**源头**消除那 4 个
 *    未处理 rejection —— 实测不需要、也没有使用 `dangerouslyIgnoreUnhandledErrors`。
 *
 * 用法：`npm run test:sdk`（= `vitest run -c vitest.sdk.config.ts`）
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/sdk/sdkPackage.smoke.test.ts'],
    setupFiles: [fileURLToPath(new URL('./src/test/setupSdkSmoke.ts', import.meta.url))],
    restoreMocks: true,
    clearMocks: true,
  },
});
