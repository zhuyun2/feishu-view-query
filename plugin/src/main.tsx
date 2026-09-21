/**
 * 入口：挂载 + SDK 初始化 + 顶层 Error Boundary（设计文档 §12 / §14）。
 * 任何渲染异常都被顶层边界捕获并展示降级 UI —— **插件不白屏**。
 */
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/tokens.css';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) {
  // 入口 HTML 缺失 #root，属构建配置错误，直接抛出以便及时暴露。
  throw new Error('未找到挂载节点 #root，请检查 public/index.html');
}

createRoot(container).render(
  <ErrorBoundary variant="app">
    <App />
  </ErrorBoundary>,
);
