/**
 * 入口：挂载 + SDK 初始化 + 顶层 Error Boundary（设计文档 §12 / §14 / §0.3.5 方案 A）。
 *
 * ⚠️ **不白屏硬约束：`App` 必须动态 import，不得改回静态 import。**
 *
 * 原因链（设计文档 §0.3.5）：`App` → `useCardViewInit` → `@/sdk/base` → SDK。
 * SDK 在 **import 期**就可能抛错（新包 `Block client only running in Block host`）。
 * 若静态 import，SDK 的求值发生在**本模块求值阶段**——处在任何 try/catch 之外——
 * `createRoot()` 永远不会被执行 → 白屏，且我们的诊断能力（在 App chunk 里）一起失效。
 *
 * 动态 `import()` 把 SDK 的求值推迟到 `await import()` 时刻，其失败是**可捕获的
 * Promise 拒绝**。已实测（隔离实验 `plugin/_sdktmp/wp5`，纯 webpack 5）：
 *   - 入口仅 2,794 bytes，SDK 全部落入独立 chunk（986,203 bytes，`initial=false`）；
 *   - 加载失败被 try/catch 捕获并渲染成诊断文本，**未出现未捕获异常**；
 *   - 对照组（静态 import）失败时入口整块崩溃、进程 exit=1，连 catch 的机会都没有。
 */
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { formatError } from '@/utils/errorText';
import { collectHostProbe, formatHostProbe } from '@/utils/hostProbe';
import './styles/tokens.css';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  // 入口 HTML 缺失 #root，属构建配置错误，直接抛出以便及时暴露。
  throw new Error('未找到挂载节点 #root，请检查 public/index.html');
}
const container: HTMLElement = rootElement;

/**
 * 兜底渲染：**纯 DOM**，不依赖 React（React 本身也可能是不可用的那一环）。
 * 与 `ErrorBoundary` 的职责不重叠——这里只处理「依赖层崩」，App 内部渲染崩由边界处理。
 *
 * 采用 **append 而非替换**：保留 `public/index.html` 内联探针（§0.3.5 方案 B）已写出的
 * 宿主环境文本，两段诊断叠加，截图信息量最大。
 */
function renderFatal(err: unknown): void {
  const panel = document.createElement('pre');
  panel.className = 'cbv-state__diag';
  panel.setAttribute('role', 'alert');
  panel.textContent = `初始化失败：${formatError(err)}\n\n${formatHostProbe(collectHostProbe())}`;
  container.appendChild(panel);
  container.dataset.cbvFatal = 'true';
}

void (async () => {
  try {
    // ⚠️ 顺序不可颠倒：先 import（此处才会求值 SDK），成功后再清掉内联探针的占位文本。
    // 若 import 失败，占位文本必须保留——它正是 bundle 未跑起来时唯一的诊断来源。
    const { default: App } = await import('./App');
    container.innerHTML = '';
    createRoot(container).render(
      <ErrorBoundary variant="app">
        <App />
      </ErrorBoundary>,
    );
  } catch (err) {
    renderFatal(err);
  }
})();
