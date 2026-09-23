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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /**
     * 真实包冒烟用例**排除**在主套件之外（team-lead 裁定 2，硬约束）：
     * 它真的 import SDK，会在 jsdom 里产生 4 个未处理 rejection，让 `npm test` 退出码变 1。
     * 它只在 `vitest.sdk.config.ts` 下运行（`npm run test:sdk`）。
     * 主套件**不得**用 `dangerouslyIgnoreUnhandledErrors` 放宽 —— 那会掩盖真正的未处理错误。
     */
    exclude: ['src/sdk/sdkPackage.smoke.test.ts'],
    /**
     * 伪造 `window.name`（team-lead 裁定 3）：新 SDK 在 import 期读它，读不到就抛
     * `Block client only running in Block host`。当前 422 个用例零运行时加载 SDK
     * （哨兵实验实证），加这一行是**无条件加固**，防的是将来有人写出值导入测试。
     * 详见 `src/test/setupHostName.ts`。
     *
     * ⚠️ 真实包的冒烟用例**不在**本配置里 —— 它在 `vitest.sdk.config.ts` 下隔离运行。
     */
    setupFiles: [fileURLToPath(new URL('./src/test/setupHostName.ts', import.meta.url))],
    restoreMocks: true,
    clearMocks: true,
  },
});
