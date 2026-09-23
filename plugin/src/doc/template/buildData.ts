/**
 * docx 模板装配层（「模板导入」第 2b 步：**一条记录 + 字段 → 可喂给 docxtemplater 的数据对象**）。
 *
 * 数据流中的位置：
 *   docx 模板纯文本 ─┐（parseTemplate 解析出「要取哪些字段 / 循环段」）
 *   字段表          ─┤
 *   一条记录 id     ─┼─→ 【本模块】buildTemplateData()
 *   单元格读取器    ─┤        → `{ data, report }`
 *   子记录读取器    ─┘              └→ data 交给 `./fill.ts` 的 `fillDocxTemplate(bytes, data)`
 *
 * 上游：
 *  · `./placeholders.ts` —— `parseTemplate`（**唯一权威**：决定要取哪些字段与循环段）
 *  · SDK `getCellString(fieldId, recordId)` —— 平台原生「单元格显示串」
 * 下游：
 *  · `./fill.ts` 的 `fillDocxTemplate(bytes, data)` —— data 按**字段名**作 key
 *
 * ⭐ 三条硬约束（违反即功能性缺陷）：
 *  1. **读取器可注入**：本模块**绝不**直接 import SDK 的 table，也**绝不**读全局对象。
 *     `readCellString` / `readLinkedRecordIds` 一律由调用方注入（`CellStringReader` 等类型）。
 *     理由：就地注入确定性 stub，即可在**没有真实飞书环境**下把本层逻辑测到 100%——
 *     这与本项目「分页引擎把测量器做成可注入」是同一条经验。
 *  2. **循环段的键由解析结果决定**：`{#明细}a{x}b{y}{/明细}` 的行内键**恰为**解析出的
 *     `inner` 占位符名（`LoopPlaceholderToken.inner`），**不是**「字段表里的全部字段」。
 *     只取模板真正写到的名字，既省请求，也避免把无关字段塞进文档。
 *  3. **重名绝不静默取首个**：字段重名（`buildFieldIndex().duplicates`）时，该 tag **留空**
 *     并记入 `report.skippedAmbiguous`。理由（本项目既有原则）：**静默填错字段比留空更糟**——
 *     用户看到有内容就不会去核对它填的是不是对的那个字段。
 *
 * ⭐ 另外两条工程性约束：
 *  · **读取失败不中断整体**：单个字段读取抛错 → 该 tag 留空、记入 `report.failedReads`，
 *    **其余字段照常填充**。理由：**整体失败会让用户连能填的部分都看不到**。
 *  · **确定性**：同一输入恒同输出。所有结果经**预分配槽位 + 末尾按 token 顺序装配**得到，
 *    既不依赖 Promise 完成顺序，也不依赖对象键插入顺序。
 *
 * ⚠️ 纯逻辑：不得 import React / DOM；`getCellString` 只能经注入的读取器调用。
 */

import { formatError } from '@/utils/errorText';
import { buildFieldIndex, parseTemplate } from './placeholders';
import type { FieldMetaLike, PlaceholderToken } from './placeholders';

/**
 * 单元格显示串读取器（**可注入**，见文件头约束 1）。
 *
 * 真实实现即 SDK 的 `getCellString(fieldId, recordId)`；测试注入确定性 stub。
 */
export type CellStringReader = (fieldId: string, recordId: string) => Promise<string>;

/** 循环段子记录 id 读取器（**可注入**，便于测试与将来扩展，如关联字段展开） */
export type LinkedRecordIdsReader = (fieldId: string, recordId: string) => Promise<string[]>;

/** 并发上限的默认值：模板可能有「20 行 × 6 字段」级联请求，一次性打出全部会压垮 SDK */
const DEFAULT_CONCURRENCY = 6;

/** `buildTemplateData` 入参 */
export interface BuildTemplateDataArgs {
  /** 模板纯文本（用于解析出需要的字段与循环段） */
  templateText: string;
  /** 字段列表（至少要有 id / name） */
  fields: ReadonlyArray<FieldMetaLike>;
  /** 主记录 id */
  recordId: string;
  /** 单元格显示串读取器（**必须注入**；见文件头约束 1） */
  readCellString: CellStringReader;
  /**
   * 循环段：如何取子记录 id（例如关联字段的子记录）。
   *
   * **可选**：未注入时，模板里的循环段一律展开为**空数组**并在 `failedReads` 中显式报告
   * （不静默——见文件头约束 3 的同类理由）。
   */
  readLinkedRecordIds?: LinkedRecordIdsReader;
  /** 并发上限（默认 {@link DEFAULT_CONCURRENCY}；非法值回退默认） */
  concurrency?: number;
}

/** `buildTemplateData` 出参 */
export interface BuildTemplateDataResult {
  /** 喂给 `fillDocxTemplate` 的数据对象（键 = 字段名 / 循环名） */
  data: Record<string, unknown>;
  /** 装配报告：哪些填了、哪些因重名/读取失败被跳过 */
  report: {
    /** 成功装配的**顶层单值**占位符（`tag` = 字段名） */
    filled: Array<{ tag: string; fieldId: string }>;
    /** 因**字段重名**而留空的占位符名（保序、去重） */
    skippedAmbiguous: string[];
    /** 读取失败（**不影响其余字段**；保序、按 token 顺序） */
    failedReads: Array<{ tag: string; fieldId: string; reason: string }>;
    /** 循环段（`tag` = 循环名；`rows` = 展开出的行数） */
    loops: Array<{ tag: string; fieldId: string; rows: number }>;
  };
}

/* ===================== 并发闸门（信号量） ===================== */

/**
 * 计数信号量：把「同时在飞」的异步任务数**硬限制**在 `limit` 以内。
 *
 * 为什么不是简单的「分批 Promise.all」：循环段的行数在运行期才知道，分批无法静态切分；
 * 信号量能在**动态任务流**上精确限流。
 */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  /** 取得一个名额（无空位则排队） */
  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolveSlot) => {
      this.queue.push(resolveSlot);
    });
  }

  /** 归还名额（若有排队者，直接转交，避免「先加后被抢占」的瞬时超限） */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  /** 在名额约束下执行任务：`await sem.run(() => read(...))` */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

/** 归一并发上限：非有限数 / < 1 → 默认值（向下取整） */
function normalizeConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : DEFAULT_CONCURRENCY;
}

/* ===================== 解析辅助 ===================== */

/** 字段解析结果 */
type Resolved =
  | { kind: 'ok'; fieldId: string }
  | { kind: 'ambiguous' }
  | { kind: 'missing' };

/**
 * 递归收集**段内**（含嵌套段）的简单占位符名（保序、按名去重）。
 *
 * ⚠️ 本层把「段内嵌套循环」**拍平**处理：只取叶子简单占位符名作行内键。
 * 真正的多级循环（子表套子表）不在本期范围；此处保证**不丢字段**即可。
 */
function collectInnerNames(
  tokens: ReadonlyArray<PlaceholderToken>,
  out: string[],
  seen: Set<string>,
): void {
  for (const token of tokens) {
    if (token.kind === 'simple') {
      if (!seen.has(token.name)) {
        seen.add(token.name);
        out.push(token.name);
      }
      continue;
    }
    collectInnerNames(token.inner, out, seen);
  }
}

/* ===================== 装配计划节点（内部） ===================== */

/** 单值占位符节点 */
interface SimpleNode {
  kind: 'simple';
  name: string;
  fieldId: string;
  value: string | null;
  failed: boolean;
  reason: string;
}

/** 循环段行内单元格 */
interface LoopCell {
  name: string;
  fieldId: string;
  value: string | null;
  failed: boolean;
  reason: string;
}

/** 循环段节点 */
interface LoopNode {
  kind: 'loop';
  name: string;
  fieldId: string;
  /** 段内要取的字段（名称 + fieldId，保序） */
  inner: Array<{ name: string; fieldId: string }>;
  /** `[行][段内字段]` 的单元格结果（**预分配**，保证装配确定性） */
  cells: LoopCell[][];
  rowCount: number;
  loopFailed: boolean;
  loopReason: string;
}

/** 把读取结果宽化为字符串（读取器理论上返回 string；运行期兜底防 `undefined`） */
function toDisplayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 安全写入**自有**属性（装配 `data` / 循环行对象时一律走这里）。
 *
 * ⭐ 为什么**不能**用 `target[key] = value`：当 `key === '__proto__'` 时，普通赋值会命中
 * `Object.prototype` 上的 **accessor**（`__proto__` 的 setter）而非创建自有属性，赋值被
 * **静默丢弃**。后果是：`data['__proto__']` 查不到字段值（docxtemplater 会读到原型对象），
 * 而 `report.filled` 仍声称「已填」——正好踩中本项目「**静默填错比留空更糟**」的红线
 * （该缺陷由 QA2 的「缺陷举证」用例锁定，见 `buildData.qa2.test.ts`）。
 *
 * `Object.defineProperty` 一定创建/覆盖**自有**属性，且**不改变**对象的原型，
 * 因此对所有键（含 `__proto__` / `constructor` / `toString` 等）行为一致。
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/* ===================== 主入口 ===================== */

/**
 * 把「一条记录 + 字段表 + 模板」装配成可喂给 `fillDocxTemplate` 的数据对象。
 *
 * 行为（详见文件头约束）：
 *  · **单值**：`data[字段名] = await readCellString(fieldId, recordId)`；
 *  · **循环**：`data[循环名] = Array<Record<string, string>>`，每行取 `readLinkedRecordIds`
 *    得到的子记录 id，再对**段内每个 inner 占位符**取显示串（键 = 段内占位符名）；
 *  · **只取模板用到的字段**（不读无关字段）；
 *  · **重名 → 留空 + `report.skippedAmbiguous`**（不静默取首个）；
 *  · **读取失败 → 留空 + `report.failedReads`**（不中断整体）；
 *  · **并发闸门**（默认 {@link DEFAULT_CONCURRENCY}）。
 *
 * @param args 见 {@link BuildTemplateDataArgs}
 * @returns    `{ data, report }`；`data` 直接交给 `fillDocxTemplate`
 */
export async function buildTemplateData(
  args: BuildTemplateDataArgs,
): Promise<BuildTemplateDataResult> {
  const templateText = typeof args.templateText === 'string' ? args.templateText : '';
  const fields = Array.isArray(args.fields) ? args.fields : [];
  const recordId = typeof args.recordId === 'string' ? args.recordId : '';
  const readCellString = args.readCellString;
  const readLinkedRecordIds = args.readLinkedRecordIds;

  const sem = new Semaphore(normalizeConcurrency(args.concurrency));
  const index = buildFieldIndex(fields);
  const parsed = parseTemplate(templateText);

  /** 名字 → 解析结论（用字段索引；重名 → ambiguous，缺失 → missing） */
  const resolveName = (name: string): Resolved => {
    const hits = index.byName.get(name);
    if (!hits || hits.length === 0) return { kind: 'missing' };
    if (hits.length > 1) return { kind: 'ambiguous' };
    return { kind: 'ok', fieldId: hits[0].id };
  };

  const nodes: Array<SimpleNode | LoopNode> = [];
  const skippedAmbiguous: string[] = [];
  const skippedSet = new Set<string>();
  const simpleSeen = new Set<string>();
  const loopSeen = new Set<string>();

  /** 记录重名跳过（保序、去重） */
  const markAmbiguous = (name: string): void => {
    if (skippedSet.has(name)) return;
    skippedSet.add(name);
    skippedAmbiguous.push(name);
  };

  const tasks: Array<Promise<void>> = [];

  /* ---------- ① 同步走一遍 token，建计划 + 解析字段（**无 async**，顺序天然确定） ---------- */
  for (const token of parsed.tokens) {
    if (token.kind === 'simple') {
      const name = token.name;
      if (simpleSeen.has(name)) continue; // 同名简单占位符只取一次（去重读）
      simpleSeen.add(name);

      const resolved = resolveName(name);
      if (resolved.kind === 'ambiguous') {
        markAmbiguous(name);
        continue;
      }
      if (resolved.kind === 'missing') continue; // 模板没写错、字段表里也没有 → 交给体检层提示

      const node: SimpleNode = {
        kind: 'simple',
        name,
        fieldId: resolved.fieldId,
        value: null,
        failed: false,
        reason: '',
      };
      nodes.push(node);

      tasks.push(
        (async () => {
          try {
            const value = await sem.run(() => readCellString(node.fieldId, recordId));
            node.value = toDisplayString(value);
          } catch (err) {
            // 读取失败不中断整体：本 tag 留空 + 报告
            node.failed = true;
            node.reason = formatError(err);
          }
        })(),
      );
      continue;
    }

    // 循环段
    const loopName = token.name;
    if (loopSeen.has(loopName)) continue; // 同名循环段只展开一次
    loopSeen.add(loopName);

    const resolved = resolveName(loopName);
    if (resolved.kind === 'ambiguous') {
      markAmbiguous(loopName);
      continue;
    }
    if (resolved.kind === 'missing') continue;

    // ⭐ 约束 2：行内键**精确**来自解析结果的 inner（只取模板真正写到的字段）
    const innerNames: string[] = [];
    collectInnerNames(token.inner, innerNames, new Set<string>());
    const inner: Array<{ name: string; fieldId: string }> = [];
    for (const innerName of innerNames) {
      const innerResolved = resolveName(innerName);
      if (innerResolved.kind === 'ambiguous') {
        markAmbiguous(innerName);
        continue;
      }
      if (innerResolved.kind === 'missing') continue;
      inner.push({ name: innerName, fieldId: innerResolved.fieldId });
    }

    const node: LoopNode = {
      kind: 'loop',
      name: loopName,
      fieldId: resolved.fieldId,
      inner,
      cells: [],
      rowCount: 0,
      loopFailed: false,
      loopReason: '',
    };
    nodes.push(node);

    tasks.push(
      (async () => {
        // 未注入子记录读取器 → 显式报告（不静默）
        if (typeof readLinkedRecordIds !== 'function') {
          node.loopFailed = true;
          node.loopReason = '未提供子记录读取器（readLinkedRecordIds），无法展开循环段';
          return;
        }

        let ids: unknown;
        try {
          ids = await sem.run(() => readLinkedRecordIds(node.fieldId, recordId));
        } catch (err) {
          node.loopFailed = true;
          node.loopReason = formatError(err);
          return;
        }

        const childIds = Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === 'string')
          : [];
        node.rowCount = childIds.length;
        // 预分配单元格槽位：行内顺序 = inner 顺序（装配确定性）
        node.cells = childIds.map(() =>
          inner.map((item) => ({
            name: item.name,
            fieldId: item.fieldId,
            value: null,
            failed: false,
            reason: '',
          })),
        );

        const cellTasks: Array<Promise<void>> = [];
        childIds.forEach((childId, rowIdx) => {
          for (const cell of node.cells[rowIdx]) {
            cellTasks.push(
              (async () => {
                try {
                  const value = await sem.run(() => readCellString(cell.fieldId, childId));
                  cell.value = toDisplayString(value);
                } catch (err) {
                  cell.failed = true;
                  cell.reason = formatError(err);
                }
              })(),
            );
          }
        });
        await Promise.all(cellTasks);
      })(),
    );
  }

  // 并发执行全部读取（受信号量约束）
  await Promise.all(tasks);

  /* ---------- ② 末尾按 token 顺序装配（**确定性**：不依赖 Promise 完成顺序） ---------- */
  // ⚠️ 一律经 `defineOwn` 写键：字段名可能是 `__proto__`，普通赋值会被其原型 setter **静默吞掉**。
  const data: Record<string, unknown> = {};
  for (const node of nodes) {
    if (node.kind === 'simple') {
      if (!node.failed) defineOwn(data, node.name, node.value ?? '');
      continue;
    }
    // 循环：逐行组装；失败的单元格**留空**（该行不出现该键）
    const rows: Array<Record<string, string>> = node.cells.map((row) => {
      const rowObject: Record<string, string> = {};
      for (const cell of row) {
        if (!cell.failed) defineOwn(rowObject, cell.name, cell.value ?? '');
      }
      return rowObject;
    });
    defineOwn(data, node.name, rows);
  }

  const filled: Array<{ tag: string; fieldId: string }> = [];
  const loops: Array<{ tag: string; fieldId: string; rows: number }> = [];
  const failedReads: Array<{ tag: string; fieldId: string; reason: string }> = [];

  for (const node of nodes) {
    if (node.kind === 'simple') {
      // `filled` = **成功装配**（读取失败的放进 failedReads，不算 filled）
      if (node.failed) {
        failedReads.push({ tag: node.name, fieldId: node.fieldId, reason: node.reason });
      } else {
        filled.push({ tag: node.name, fieldId: node.fieldId });
      }
      continue;
    }
    loops.push({ tag: node.name, fieldId: node.fieldId, rows: node.rowCount });
    if (node.loopFailed) {
      failedReads.push({ tag: node.name, fieldId: node.fieldId, reason: node.loopReason });
    }
    for (const row of node.cells) {
      for (const cell of row) {
        if (cell.failed) {
          failedReads.push({ tag: cell.name, fieldId: cell.fieldId, reason: cell.reason });
        }
      }
    }
  }

  return { data, report: { filled, skippedAmbiguous, failedReads, loops } };
}
