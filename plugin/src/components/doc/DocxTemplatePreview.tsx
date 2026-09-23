/**
 * docx 模板预览**挂载壳**（「docx 模板导入」第三步：保真渲染的 React 侧）。
 *
 * 职责：把 `renderDocxInto`（纯渲染函数）安全地挂进 React 生命周期，并守住三件
 * 「用户看得见但不报错」的静默故障：
 *
 *  ① **重复渲染不得叠加**：docx-preview 是「注入 / 追加」型。同一容器渲染两次若不清空，
 *     会出现**两份内容叠在一起** —— 而且**不会报错**。本组件在**提交**时先清空可见宿主。
 *  ② ⭐ **过期响应守卫**：连续切换两条记录时，**先发起的渲染若后完成，绝不能覆盖后发起的结果**。
 *     本项目在 `usePagedDocument` 里用 `runSeqRef + cancelled` **双守卫**修过同类缺陷，
 *     本组件**沿用同一模式**（用户表现为「看到上一条记录的内容」，且无任何报错）。
 *     ⚠️ 但这里有额外难点：docx-preview **直接写 DOM**，仅靠「返回后再判 active」来不及
 *     （过期链路在 await 期间**已经**改过 DOM）。故本组件把每一轮渲染隔离进一个**分离的暂存容器**，
 *     只有「成功且未过期」才整体提交到可见宿主 —— 过期链路**自始至终碰不到可见 DOM**。
 *  ③ **失败要有可读提示**：不能让用户看到一片空白却不知道为什么。失败时通过 `onError` 上报
 *     （`formatError` 归一，绝不出现 `[object Object]`），并在容器里留一条明确文案。
 *
 * ⭐⭐⭐ 刻意分歧（**不要「顺手统一」**）⭐⭐⭐
 *   模板来源是 docx 时，页面几何（宽度 / 页边距）**由模板自带的 `sectPr` 决定**，
 *   **不受**详情页 `getContentBox().width` 冻结不变量约束，也**不得**塞进 `.cbv-paper` 的
 *   body（那会继承我们的宽度）。把两侧「统一」起来 = 改版用户的 Word 模板，**且不会报错**。
 */
import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { formatError } from '@/utils/errorText';
import { clearContainer, renderDocxInto } from '@/doc/template/renderDocx';
import type { DocxBytes, RenderDocxIntoFn, RenderDocxOptions } from '@/doc/template/renderDocx';

/** `DocxTemplatePreview` 入参 */
export interface DocxTemplatePreviewProps {
  /** docx 字节；`null` → 空态（清空容器、**不**上报错误） */
  bytes: DocxBytes | null;
  /** 失败出口：收到**已归一化**的可读文案（`formatError`，绝不为 `[object Object]`） */
  onError?: (message: string) => void;
  /** 注入渲染器（缺省 = 生产实现 `renderDocxInto`；测试据此**确定性控制完成时序**） */
  renderInto?: RenderDocxIntoFn;
  /**
   * 渲染选项。
   * ⚠️ 请传**稳定引用**（模块级常量），否则每次渲染都会重跑（本组件把它列入 effect 依赖）；
   * 缺省 = 拍平默认值 `{ breakPages: false, ignoreHeight: true }`。
   */
  options?: RenderDocxOptions;
  /** 附加类名（可选） */
  className?: string;
}

/**
 * docx 模板预览组件。
 *
 * 结构上渲染**一个**宿主 `div`：React 持有该元素本身，其**子节点由本组件手工注入**
 * （React 不会清理它未声明的子节点，这正是「宿主容器」模式的用法）。
 */
export function DocxTemplatePreview(props: DocxTemplatePreviewProps): ReactElement {
  const { bytes, options, className } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 渲染器（ref 持有最新值，避免因函数身份变化反复重跑主 effect） */
  const renderFnRef = useRef<RenderDocxIntoFn>(props.renderInto ?? renderDocxInto);
  /** 错误出口（同上） */
  const onErrorRef = useRef<((message: string) => void) | undefined>(props.onError);
  /** 运行序号（守卫 ①）：每次 effect 重跑自增；过期链路据此自我作废 */
  const runSeqRef = useRef(0);

  // 最新 props → ref（每次渲染后同步；无依赖数组，故不触发 exhaustive-deps）
  useEffect(() => {
    renderFnRef.current = props.renderInto ?? renderDocxInto;
    onErrorRef.current = props.onError;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 守卫 ①：作废上一轮（自增序号）
    const seq = runSeqRef.current + 1;
    runSeqRef.current = seq;
    // 守卫 ②：本轮是否被作废（重跑 / 卸载时置位）
    let cancelled = false;
    const active = (): boolean => !cancelled && runSeqRef.current === seq;

    // 空态：无字节 → 清空容器、不上报错误。
    // ⚠️ 不用 `== null`（eslint `eqeqeq` 禁止松散相等）；`!bytes` 精确覆盖 null / undefined。
    if (!bytes) {
      clearContainer(host);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      // ⭐ 隔离渲染（见文件头 ② 的难点说明）：先渲染进**分离的暂存容器**，
      //    只有「成功且未过期」才提交到可见宿主。
      const staging = document.createElement('div');
      try {
        await renderFnRef.current(staging, bytes, options);
      } catch (err) {
        if (!active()) return; // 过期链路的失败同样丢弃（不得用旧错误覆盖新内容）
        const message = formatError(err);
        clearContainer(host);
        const alert = document.createElement('div');
        alert.className = 'cbv-docx__error';
        alert.setAttribute('data-docx-error', 'true');
        alert.setAttribute('role', 'alert');
        alert.textContent = `模板渲染失败：${message}`;
        host.appendChild(alert);
        onErrorRef.current?.(message);
        return;
      }

      // ⭐ 过期响应守卫：后发起的结果已提交，本轮**不得**覆盖。
      if (!active()) return;

      // 提交：**先清空可见宿主**再移入暂存内容（否则切换记录会与旧内容叠加，且不报错）。
      clearContainer(host);
      while (staging.firstChild) host.appendChild(staging.firstChild);
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, options]);

  // 卸载清理：清空宿主，避免把已渲染内容留在仍被外部引用的节点里（无残留）。
  useEffect(() => {
    const host = hostRef.current;
    return () => {
      if (host) clearContainer(host);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={className ? `cbv-docx-host ${className}` : 'cbv-docx-host'}
      data-testid="docx-template-preview"
      data-docx-host="true"
    />
  );
}

export default DocxTemplatePreview;
