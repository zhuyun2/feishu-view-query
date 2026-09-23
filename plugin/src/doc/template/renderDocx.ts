/**
 * docx 模板**保真渲染层**（「docx 模板导入」第三步：把填好的 docx 渲染成 HTML）。
 *
 * 数据流中的位置：
 *   docx 字节（模板 + 已填充的值）→ 【本模块】renderDocxInto()
 *   → 交由 `<DocxTemplatePreview/>` 挂进详情。
 *   底层依赖 `docx-preview`（Apache-2.0）把 OOXML 还原为接近 Word 的 HTML。
 *
 * ⭐⭐⭐ 刻意分歧（**不要「顺手统一」**）⭐⭐⭐
 *   详情页的既有模型是「单张连续长页」，并遵守一条冻结不变量：**内容宽度恒等于
 *   `getContentBox().width`**（决定文字换行位置）。**但导入的 docx 模板自带它自己的页面尺寸与
 *   页边距（`sectPr`）** —— 若强行套用我们的纸张几何，等于**改版用户的 Word 模板**。
 *   因此本渲染路径：
 *     · 页面宽度 / 页边距**由模板自带**，**不受** `getContentBox()` 不变量约束；
 *     · **不得**把渲染产物塞进 `.cbv-paper` 的 body 里（那会继承我们的宽度）。
 *   把两侧「统一」起来 = 改版用户模板，**且不会有任何报错** —— 改动前请先读到这里。
 *   （该说明由 `renderDocx.test.ts` 源码级守卫锁定，请勿删除。）
 *
 * ⭐ 打包约束：**必须动态 `import('docx-preview')`**（实测：静态打包让主入口 +441KiB；
 *   动态只 +434 字节）。因此本文件**不得**出现对 `docx-preview` 的静态 import
 *   （由 `renderDocx.test.ts` 源码级守卫锁定）。
 *
 * ⭐ 拍平契约：默认 `{ breakPages: false, ignoreHeight: true }` —— 实测把**含分页符**的 docx
 *   渲染成**恰好 1 个 `section.docx`**（`breakPages: true` 时为 2 个），与详情「单页长流」模型契合。
 *   判别式见 `renderDocx.test.ts`（同一份含分页符的 docx：前者 1 个 section、后者 2 个）。
 */

/** docx 字节（两种形态都接受：`ArrayBuffer` / `Uint8Array`） */
export type DocxBytes = ArrayBuffer | Uint8Array;

/** `renderDocxInto` 的渲染选项（透传给 docx-preview 的 `Partial<Options>`） */
export interface RenderDocxOptions {
  /** 是否按分页符切分为多个 `section.docx`。**默认 false**（拍平为单页长流） */
  breakPages?: boolean;
  /** 是否忽略模板中的高度约束（高度随内容自然增长）。**默认 true** */
  ignoreHeight?: boolean;
  /** 是否包裹一层 `.docx-wrapper`（docx-preview 默认 `true`）。需要「纯内联」时可传 `false` */
  inWrapper?: boolean;
}

/**
 * 拍平默认值：只把**分页符拍平**，不改动用户模板的页面几何。
 * ⚠️ 该对象是**唯一权威来源**，改动它会让「拍平判别式」用例变红。
 */
export const DEFAULT_RENDER_DOCX_OPTIONS: Readonly<
  Required<Pick<RenderDocxOptions, 'breakPages' | 'ignoreHeight'>>
> = {
  breakPages: false,
  ignoreHeight: true,
};

/**
 * 渲染器签名（供 `<DocxTemplatePreview/>` 注入）。
 * 生产实现 = `renderDocxInto`；测试注入它即可**确定性控制完成时序**（构造过期响应）。
 */
export type RenderDocxIntoFn = (
  container: HTMLElement,
  bytes: DocxBytes,
  options?: RenderDocxOptions,
) => Promise<void>;

/** 清空元素的**全部**子节点（同步、不留残留） */
export function clearContainer(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

/** 归一为 `Uint8Array`（docx-preview 内部经 jszip 读取，两种形态都兼容） */
function toUint8Array(bytes: DocxBytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * 把 docx 字节**渲染进**给定容器。
 *
 * 关键行为：
 *  1. **先清空容器**：docx-preview 是「注入 / 追加」型渲染。其 `renderAsync` 虽会在**成功收尾时**
 *     清空容器，但**渲染失败会在清空前抛出** —— 届时旧内容会残留。这里先清空，保证
 *     「失败 = 明确空白（由调用方给文案）」，而非「失败 = 仍是上一条内容」。
 *  2. **动态 import**：避免把 docx-preview 打进主入口。
 *  3. **拍平默认值**：`{ breakPages: false, ignoreHeight: true }`，可用 `options` 覆盖。
 *
 * ⚠️ 本函数**不含**「过期响应守卫」：它是一个纯粹的「渲染进容器」动作。并发切换记录时的
 *    过期保护由调用方（`<DocxTemplatePreview/>`）用 `runSeqRef + cancelled` 双守卫 + 暂存容器隔离承担。
 *
 * @param container 目标容器（会被清空并注入渲染产物）
 * @param docxBytes docx 字节（`ArrayBuffer | Uint8Array`）
 * @param options   渲染选项（缺省 = 拍平默认值）
 * @throws 当容器为空、字节为空、或 docx 解析 / 渲染失败时抛出（由调用方归一为可读文案）
 */
export async function renderDocxInto(
  container: HTMLElement,
  docxBytes: DocxBytes,
  options?: RenderDocxOptions,
): Promise<void> {
  if (!container) throw new Error('renderDocxInto: container 不能为空');
  if (!docxBytes) throw new Error('renderDocxInto: docxBytes 不能为空');

  // ① 先清空（见上文关键行为 1）。
  clearContainer(container);

  // ② 动态 import（见上文关键行为 2）。⚠️ 不得改成静态 import（会导致主入口 +441KiB）。
  const { renderAsync } = await import('docx-preview');

  // ③ 合并拍平默认值（见上文关键行为 3）。
  const merged: RenderDocxOptions = { ...DEFAULT_RENDER_DOCX_OPTIONS, ...(options ?? {}) };

  // styleContainer 传 undefined → 样式注入同一容器（模板自带样式需要留在 DOM 内）。
  await renderAsync(toUint8Array(docxBytes), container, undefined, merged);
}

export default renderDocxInto;
