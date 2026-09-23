/**
 * 筛选求值引擎（设计文档 §22.4）——**纯函数**。
 *
 * 硬约束（§22.4 / 主理人裁定）：
 * 1. **纯函数**：无 React / 无 DOM / 无 SDK 运行时依赖 / 无 store / 无副作用，
 *    仅值依赖 `normalize()` / `getRecordFields()` / `operatorMatrix` 的算子白名单
 *    （三者均为纯函数 / 纯常量），可在 node 下裸跑；
 * 2. **不上抛**：任何非法输入（记录为空、字段缺失、脏数据、未知算子）都收敛为布尔结果；
 * 3. **⭐ 所见即所筛**：比较一律基于 `normalize()` 产出的**语义值**（`text` / `number` /
 *    `timestamp` / `boolean` / `items` / `isEmpty`），**绝不**比较原始 `fields` 结构、
 *    原始 ID、JSON 或千分位 `display` 文本——否则会出现「屏幕上明明等于这个值却筛不到」。
 *
 * ⭐ **数据可见性优先于筛选精确性**（主理人裁定，2026-09-20 追加）：
 *    宁可让筛选**不生效**，也绝不能让记录**消失**。前者用户一眼能发现（「筛选怎么没起作用」），
 *    后者是**静默的数据丢失**——用户会以为「没有符合条件的记录」。
 *    因此引入**「条件无效（invalid）」**语义，与「不命中（noMatch）」严格区分：
 *    - 未知算子 / 条件非对象 → **无效**（配置问题，不是记录的问题）；
 *    - **算子已知但该字段类型不支持它**（类型 × 算子不匹配）→ **无效**
 *      （`isEmpty` / `isNotEmpty` 豁免——它们的语义与字段类型无关，详见 `isTypeOperatorMatch`）；
 *    - **字段元数据缺失**（字段已被删除 / 元数据尚未就绪 / 调用方未传 metas）→ **无效**
 *      （绝不能判 `noMatch`：否则该条件会把**全部记录筛光**，正是被禁止的静默数据丢失）；
 *    - 求值过程抛异常（脏数据、`normalize` 边界、字段访问异常）→ **无效**；
 *    - `evaluateFilter` **跳过**无效条件：只在**有效条件**之间做 and / or；
 *      若**可求值的条件数为 0**（含 `conditions` 为空、`enabled === false`、结构损坏、
 *      或全部条件 invalid）→ 返回 **true（= 不筛选，全部保留）**；
 *    - `applyFilterConditions` 在没有任何可求值条件时直接返回**入参原引用**。
 *    ⚠️ `isFilterActive` 只回答「筛选是否**开启**」（面向 UI 的谓词），
 *       与「某条记录是否**通过**筛选」（`evaluateFilter`）是两件事，不要混用。
 *       旧口径「空 conditions → evaluateFilter 返回 false」**已作废**。
 *
 * 已拍板的语义裁定（写死为约定，逐条有单测锁定）：
 * - `contains` **区分大小写**（可预测优先，§22.10-②）；
 * - `isNot` / `doesNotContain` 是对应算子的**朴素否定**，因此**空值记录也命中**
 *   （对齐原生「不等于（含空）」与 `highlight` 引擎的 `neq`/`notContains`，§22.10-③）；
 * - 日期 `is` 的粒度为**按本地天**（忽略时分秒，§22.10-④ / §22.4.4）；
 * - 数字比较基于 `nv.number`（非 `display`），带 `±1e-9` 容差；脏数据（`normalize` → empty）
 *   **不假装命中**，一律 false（诚实优先）。
 *
 * ⚠️ 关于「engine 是否用算子矩阵 gate 一次」（§22.13 类图有 `engine ..> operatorMatrix`）：
 *    本实现**只用矩阵做「这条配置能否被求值」的判定**（算子是否已知 + 类型 × 算子是否匹配），
 *    判定为「不能」时结论是 **invalid → 跳过**，**绝不**是「不命中 → 筛掉」；
 *    判定为「能」之后，仍按 `NormalizedValue` 的**语义种类**求值（§22.4.2 铁律），不按字段类型分派。
 *    这样既堵住「坏配置把记录筛光」，也保留了「所见即所筛」。
 */
import type { SdkRecord } from '@/sdk/port';
import type { FieldMetaLite, NormalizedValue } from '@/fields/fieldTypes';
import { normalize } from '@/fields/normalize';
import { getRecordFields } from '@/data/RecordDataSource';
import { isKnownOperator, isOperatorAllowed, operatorRequiresValue } from './operatorMatrix';
import type { FilterCondition, FilterConfig, FilterOperator } from './types';

/** 字段元数据索引（fieldId → meta） */
export type FieldMetaMap = Record<string, FieldMetaLite>;

/** 一天毫秒数（用于「次日 0 点」边界） */
const DAY_MS = 86_400_000;

/** 数值相等容差（§22.4.3：±1e-9，吸收 0.1+0.2 之类的二进制误差） */
const NUMERIC_EPSILON = 1e-9;

/** 参与「大于/小于」比较的算子子集 */
type CompareOperator = Extract<
  FilterOperator,
  'isGreater' | 'isGreaterEqual' | 'isLess' | 'isLessEqual'
>;

/* ===================== 内部工具：值解析 ===================== */

/** 有限数字；数字或可解析数字字符串，其余（对象 / 数组 / 布尔 / 空）一律 null */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 毫秒时间戳；number 直接用，字符串走 `Date.parse`（sanitize 已保证可解析） */
function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 布尔；`'true' / 'false'` 字符串与 0/1 亦容错识别（UI 只会传真正的布尔） */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

/**
 * 目标值 → 比较用的文本。
 * 数字/布尔按 `String()` 转（「数字与文本混排」时 `1234` 与 `'1234'` 视为相等）；
 * 数组按 `、` 连接（与 `normalize` 的多值文本口径一致）；其余一律 `''`。
 */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => toText(item)).join('、');
  return '';
}

/* ===================== 内部工具：日期按天 ===================== */

/** 本地时区当日 0 点的时间戳 */
function dayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 次日本地 0 点（用 `setDate` 而非 `+ DAY_MS`，可正确处理夏令时） */
function nextDayStart(ts: number): number {
  const date = new Date(ts);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 是否同一本地天（日期 `is` 的粒度 = 按天，忽略时分秒） */
function sameLocalDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}

/* ===================== 内部工具：取语义值 ===================== */

/**
 * 取某条记录在指定字段上的**语义值**（§22.4.2 唯一通道）。
 *
 * ⚠️ 本函数**刻意不吞异常**（与早期版本不同）：脏数据 / 取值器抛错必须冒泡到
 *    `evaluateConditionState`，被标记为 **invalid（条件无效 → 跳过）**，
 *    而不是「该记录不命中 → 被筛掉」——后者会让记录从结果里**静默消失**。
 *    返回 null 的情形仅限「记录为空 / 元数据缺失 / 字段不存在」= **noMatch**（§22.4.1）。
 */
function nvOf(
  record: SdkRecord | null | undefined,
  fieldId: string,
  metas: FieldMetaMap,
): NormalizedValue | null {
  if (!record || !metas || typeof metas !== 'object') return null;
  const meta = metas[fieldId];
  if (!meta) return null; // 防御兜底：正常路径下已由 isTypeOperatorMatch 门禁判为 invalid（见 evaluateConditionState）
  return normalize(getRecordFields(record)[fieldId], meta);
}

/* ===================== 算子语义 ===================== */

/**
 * `is`（等于）。
 * ⚠️ 空值**不**满足 `is`（`isNot` 因此含空值——见 `evaluateCondition`）。
 * 按语义字段分派：布尔 → 数值（±1e-9）→ 日期（按天）→ 文本（严格相等，区分大小写）。
 */
function matchIs(nv: NormalizedValue, value: unknown): boolean {
  if (nv.isEmpty) return false;
  if (typeof nv.boolean === 'boolean') return nv.boolean === toBoolean(value);
  if (typeof nv.timestamp === 'number' && Number.isFinite(nv.timestamp)) {
    const target = toTimestamp(value);
    return target !== null && sameLocalDay(nv.timestamp, target);
  }
  if (typeof nv.number === 'number' && Number.isFinite(nv.number)) {
    const target = toNumber(value);
    return target !== null && Math.abs(nv.number - target) <= NUMERIC_EPSILON;
  }
  return nv.text === toText(value);
}

/**
 * `contains`（包含，**区分大小写**）。
 * 多值语义（多选 / 成员 / 附件 / 关联）：**任一项命中即命中**（原生多选「包含」语义）；
 * 单值回落 `nv.text.includes(kw)`。
 */
function matchContains(nv: NormalizedValue, keyword: string): boolean {
  const items = nv.items;
  if (Array.isArray(items) && items.length > 0) {
    return items.some((item) => item.text.includes(keyword));
  }
  return !nv.isEmpty && nv.text.includes(keyword);
}

/**
 * 数值 / 日期比较。任一 side 非有限 → false（**诚实优先，不假装命中**）。
 * 日期类：`isGreater` = 晚于该日（次日 0 点及以后）；`isLess` = 早于该日（当日 0 点之前）。
 */
function matchCompare(nv: NormalizedValue, value: unknown, operator: CompareOperator): boolean {
  if (typeof nv.timestamp === 'number' && Number.isFinite(nv.timestamp)) {
    const target = toTimestamp(value);
    if (target === null) return false;
    const day = dayStart(target);
    switch (operator) {
      case 'isGreater':
        return nv.timestamp >= nextDayStart(target);
      case 'isGreaterEqual':
        return nv.timestamp >= day;
      case 'isLess':
        return nv.timestamp < day;
      case 'isLessEqual':
        return nv.timestamp < nextDayStart(target);
      default:
        return false;
    }
  }

  if (typeof nv.number !== 'number' || !Number.isFinite(nv.number)) return false;
  const target = toNumber(value);
  if (target === null) return false;
  switch (operator) {
    case 'isGreater':
      return nv.number > target + NUMERIC_EPSILON;
    case 'isGreaterEqual':
      return nv.number >= target - NUMERIC_EPSILON;
    case 'isLess':
      return nv.number < target - NUMERIC_EPSILON;
    case 'isLessEqual':
      return nv.number <= target + NUMERIC_EPSILON;
    default:
      return false;
  }
}

/* ===================== 对外 API ===================== */

/**
 * 单条条件的求值结果（**三态**）。
 *
 * - `'match'`   ：条件有效且记录命中；
 * - `'noMatch'` ：条件有效但记录不命中 —— **该记录可以被筛掉**；
 * - `'invalid'` ：条件**无效**（未知算子 / 条件非对象 / 求值抛异常）——
 *                 **不是记录的问题**，该条件必须被**跳过**，绝不能据此筛掉记录
 *                 （主理人裁定：数据可见性优先于筛选精确性）。
 */
export type ConditionResult = 'match' | 'noMatch' | 'invalid';

/**
 * 条件 × 字段类型是否匹配（决定该条件是「可求值」还是「无效 → 跳过」）。
 *
 * ⭐ 主理人裁定（2026-09-20）：**算子已知但字段类型不支持该算子 → `invalid`（跳过该条件），
 *    绝不是 `noMatch`**。理由：这类配置的语义不明，若当 noMatch 求值，用户会遇到
 *    「筛选条件明明没错，记录却全没了」，且无从察觉——正是被禁止的静默数据丢失。
 *    现实触发路径比「未知算子」多得多：历史遗留配置、字段类型变更、类型映射不准。
 *
 * ⚠️ **唯一豁免：`isEmpty` / `isNotEmpty` 不做类型 × 算子校验（永不判 invalid）。**
 *
 * 豁免理由（两点，缺一不可）：
 * 1. **它们不依赖字段类型语义**：`isEmpty` / `isNotEmpty` 直接由 `normalize()` 产出的
 *    `nv.isEmpty` 求值（§22.4.3），对文本 / 数字 / 日期 / 复选框 / 附件 / 成员都是同一个
 *    确定答案，且与屏幕所见一致。既然谈不上「按错误的类型语义求值」，就没有失效的理由；
 *    若强行判为 invalid，反而会让「复选框为空」这类**完全合理**的条件整条不生效。
 * 2. **值比较类算子不豁免，正因为它们依赖类型语义**：`is` 在日期上是「按天比」、
 *    在数字上是「±1e-9 数值比」、在复选框上是「布尔比」；`contains` 在多选上是
 *    「任一项命中」；`isGreater*` 在日期上是「次日 0 点」、在数字上是数值比较。
 *    一旦类型与算子不匹配，这些分支会走错语义（例如数字字段用 `contains` 去匹配千分位文本），
 *    结果既不可预测也不可解释——所以必须判为 invalid 跳过。
 *
 * 换言之：**区分标准不是「矩阵有没有列出它」，而是「这个算子的求值是否依赖字段类型语义」**。
 *
 * ⚠️ **字段元数据缺失（`!meta`）时返回 `false`（→ 条件判 invalid）**，不是 `true`。
 *    早先版本写 `return true`（= 放行给下游按 §22.4.1 处理）已被证伪：
 *    放行后该条件会继续求值 → 记录里没有这个字段 → 归一化为空 → 对 `is` 这类算子算出 `noMatch`
 *    → **全部记录被筛掉**，用户看到空白视图且无从察觉。这正是「数据可见性优先于筛选精确性」
 *    明令禁止的情形。
 *    现实触发路径：字段在插件打开期间被删除、`onDataChange` 推送的新配置指向未知字段、
 *    metas 尚未加载完成、未来的新调用方不传 metas。
 *    ⚠️ 「F1 的 sanitize 已在入口丢弃 unknownField」**不能**作为放行的理由——
 *    那只是另一层的防护；引擎自身遇到无法确定语义的条件时必须**安全失败**。
 */
function isTypeOperatorMatch(
  operator: FilterOperator,
  meta: FieldMetaLite | undefined,
): boolean {
  // 字段元数据缺失 → 类型无从判定 → 语义不可确定 → 判无效（跳过该条件，记录保留）
  if (!meta) return false;
  if (!operatorRequiresValue(operator)) return true; // isEmpty / isNotEmpty：与类型无关，豁免
  return isOperatorAllowed(meta.type, operator);
}

/* ===================== 值是否「已填写」（需值算子的第 3 道判定） ===================== */

/**
 * 值是否「为空」（仅在算子**需要值**时用于判「未填完」）。
 *
 * ⭐ 判为空的形态：`undefined` / `null` / **纯空白字符串（含 `''`）** / 空数组。
 *    ⚠️ 数字 `0`、布尔 `false`、文本 `'0'` **都不是空**——它们是有意义的**已填值**；
 *       绝不能误判为空，否则「筛 0 / 筛 false / 筛 '0'」会被当成「没填」而失效。
 */
function isBlankValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 条件是否带了**可用的值** = 「算子不需要值」**或**「需要的值已填写」。
 *
 * ⭐ 需值算子但值为空 → 返回 `false`（→ 该条件判 **`invalid` / 未生效**）。三条依据：
 * 1. **数据可见性优先于筛选精确性**（主理人裁定）：条件没填完 → 无语义 → 绝不能据此
 *    把记录筛掉；否则用户看到空白视图，只会以为「没有符合条件的记录」，察觉不到是**配置没填完**
 *    ——正是被禁止的静默数据丢失。
 * 2. **与 sanitize 同源**：`sanitize.ts` 对 `{undefined, null}` 的需值条件已按「值缺失 →
 *    条件无意义」处理（见该处 `invalidValueType` 分支）；引擎此前**没跟上**，二者漂移正是本缺陷根因。
 * 3. **判别标准是「该条件能否被求值」**：需值算子缺值 → **无可比目标** → 语义未定义，
 *    与「未知算子 / 类型 × 算子不匹配」同属 `invalid`（**跳过**），**不是**「合法但不匹配」。
 *
 * ⚠️ 返回 `false` **绝不等于「放行整个筛选」**：`invalid` 只让**这一条**被跳过，
 *    其余有效条件照常按 and / or 收窄（见 `evaluateFilter` / 单测的「判别式」）。
 *    ⚠️ 也**不要**据此把空值算子（`isEmpty` / `isNotEmpty`）判无效——它们**不需要值**，本函数对它们恒 `true`。
 */
export function isValidConditionValue(cond: FilterCondition): boolean {
  return !operatorRequiresValue(cond.operator) || !isBlankValue(cond.value);
}

/**
 * 条件是否**可求值**（静态判定，不看具体记录）——**完整判定**，`metas` **必填**。
 *
 * 语义：算子已知 **且** 字段类型 × 算子匹配（含「字段不存在 → 不可求值」）**且 值已填写**
 *      （需值算子缺值 → 语义未定义 → 不可求值，见 `isValidConditionValue`）。
 *
 * ⚠️ `metas` **刻意必填**（主理人裁定，2026-09-21）：
 *    早先版本签名是 `metas?`，不传时**静默退化**为「只校验算子是否已知」——
 *    这正是本轮消灭的「同一概念、两套判定」缺陷的**同构体**：漏传 metas 既不报错、
 *    也不编译失败，只是悄悄少做一道校验，UI 少报几个「未生效条件」（用户无从察觉）。
 *    用「可选参数」承载两种语义 = 原地保留一个能重新长回原样的通道。
 *    故改为**必填**：任何调用点漏传都会**直接编译失败**（TS2554），把问题挡在编译期。
 *    若确需「只校验算子是否已知」，请用名字明确的 [`isOperatorKnown`]——
 *    两种语义在**函数名**上分得清，**绝不**靠「传没传第二个参数」区分。
 *
 * ⭐ **判定逻辑与运行时完全同源**：内部复用 `isTypeOperatorMatch()`——
 *    「UI 显示这条条件生效」与「引擎真的会用它」必须是同一套判定，
 *    在 UI 侧另写一份校验必然漂移（§22.5.6）。
 *
 * 供 `applyFilterConditions` 在整表求值前快速判定「是否存在可参与求值的条件」，
 * 也供 UI 统计「未生效条件数」。算子白名单来自 `operatorMatrix.isKnownOperator`
 * （唯一来源 = `sanitize.ALL_FILTER_OPERATORS`）。
 */
export function isConditionValid(
  cond: FilterCondition | null | undefined,
  metas: FieldMetaMap,
): boolean {
  // `metas` 必填（编译期保证）。**不做**「缺失即 return true」的运行时兜底——那等于把必填又变回可选。
  if (!cond || typeof cond !== 'object') return false;
  if (!isKnownOperator(cond.operator)) return false;
  // 需值算子但值为空 → 语义未定义 → 不可求值（未生效）。
  // ⚠️ 别删：删了「值为空」就会被当成合法条件，`is ''` 会对**每条记录**算出 noMatch → 把数据静默筛空。
  if (!isValidConditionValue(cond)) return false;
  return isTypeOperatorMatch(cond.operator, metas[cond.fieldId]);
}

/**
 * 条件算子是否**已知**（**仅**算子白名单校验，**不看**字段元数据）。
 *
 * ⚠️ 与 [`isConditionValid`] 的分工（**两件事，不要混用**）：
 *   - `isOperatorKnown(cond)` = 「算子名字是否合法」（本谓词，无字段上下文即可判定）；
 *   - `isConditionValid(cond, metas)` = 「这条条件能否被求值」（需字段类型 × 算子匹配）。
 *   二者在**函数名**上分得清；**绝不**靠「传没传第二个参数」区分（那正是上一轮的缺陷源）。
 *   白名单唯一来源 = `operatorMatrix.isKnownOperator`（真源 = `sanitize.ALL_FILTER_OPERATORS`）。
 *
 * 典型用法：`FilterConditionRow` 区分「未知算子」与「类型不匹配」两种标红文案。
 */
export function isOperatorKnown(cond: FilterCondition | null | undefined): boolean {
  if (!cond || typeof cond !== 'object') return false;
  return isKnownOperator(cond.operator);
}

/**
 * 单条条件求值（**三态**；绝不上抛）。
 *
 * @param cond 单条条件（应已由 `sanitizeFilterConfig` 净化；未净化亦不崩）
 * @param record 记录；为 null / undefined → `'noMatch'`
 * @param metas 字段元数据索引
 */
export function evaluateConditionState(
  cond: FilterCondition | null | undefined,
  record: SdkRecord | null | undefined,
  metas: FieldMetaMap,
): ConditionResult {
  // 条件本身不可解析 / 算子未知 → 配置无效 → 跳过（**不筛掉任何记录**）
  if (!cond || typeof cond !== 'object') return 'invalid';
  if (!isKnownOperator(cond.operator)) return 'invalid';

  // ⭐ 算子已知但该字段类型不支持它 → 配置语义不明 → 无效 → 跳过（记录必须保留）
  const meta = metas && typeof metas === 'object' ? metas[cond.fieldId] : undefined;
  if (!isTypeOperatorMatch(cond.operator, meta)) return 'invalid';

  // ⭐ 需值算子但值为空（未填完）→ 语义未定义 → invalid → 跳过该条件（数据可见性优先，见 isValidConditionValue）。
  //    典型场景：新建条件行尚未填值；`is ''` 若被当合法，会对**全部记录**算出 noMatch → 静默筛空。
  if (!isValidConditionValue(cond)) return 'invalid';

  if (!record) return 'noMatch';
  let nv: NormalizedValue | null;
  try {
    nv = nvOf(record, cond.fieldId, metas);
  } catch {
    // 取值阶段抛异常（脏数据 / 取值器异常）→ 条件无效 → 跳过（记录必须保留）
    return 'invalid';
  }
  // ⚠️ 本判断**不是**「空值也判 invalid」——请勿据此把它"修"成 `'noMatch'`，那才会真弄坏语义。
  //    不变量：`nv` 为 `null` **仅当** `!record` / `!metas` / `!meta`（见上方 `nvOf`）。
  //    因为 `normalize()` 对空值（`null` / `''` / 字段键缺失 / 纯空白）返回的是
  //    `emptyValue()` **对象**（`isEmpty: true`），**永不返回 `null`**——空字段走的是**正常求值**
  //    （`is` → `noMatch` 被筛掉；`isNot` → `match` 命中，朴素否定含空值）。
  //    此处 `!record` 已在更上方 `if (!record) return 'noMatch'` 处理、`!meta` 已由
  //    `isTypeOperatorMatch` 门禁判 invalid，故本条在**正常路径下不可达**；保留它是兜底
  //    「取值失败也绝不筛掉记录」——语义不可确定即判无效（数据可见性优先于筛选精确性）。
  //    （既有单测已锁边界：空字段 + `is` → `noMatch`、空字段 + `isNot` → `match`。）
  if (!nv) return 'invalid';

  try {
    switch (cond.operator) {
      case 'isEmpty':
        return nv.isEmpty ? 'match' : 'noMatch';
      case 'isNotEmpty':
        return !nv.isEmpty ? 'match' : 'noMatch';
      case 'is':
        return matchIs(nv, cond.value) ? 'match' : 'noMatch';
      case 'isNot':
        // 朴素否定：空值记录「不等于」任何目标值 → **命中**（主理人裁定 §22.10-③）
        return !matchIs(nv, cond.value) ? 'match' : 'noMatch';
      case 'contains':
        return matchContains(nv, toText(cond.value)) ? 'match' : 'noMatch';
      case 'doesNotContain':
        // 朴素否定：空值记录「不包含」任何关键词 → **命中**
        return !matchContains(nv, toText(cond.value)) ? 'match' : 'noMatch';
      case 'isGreater':
      case 'isGreaterEqual':
      case 'isLess':
      case 'isLessEqual':
        return matchCompare(nv, cond.value, cond.operator) ? 'match' : 'noMatch';
      default:
        return 'invalid';
    }
  } catch {
    // 比较阶段抛异常 → 条件无效 → 跳过（记录必须保留）
    return 'invalid';
  }
}

/**
 * 单条条件求值（**布尔**；保持 §22.4.1 签名，供 UI / 单条件场景直接使用）。
 *
 * 语义：`true` **仅当**结果为 `'match'`；`'noMatch'` 与 `'invalid'` 都返回 `false`。
 * ⚠️ 需要「跳过无效条件」语义的调用方请用 `evaluateFilter` / `applyFilterConditions`，
 *    它们内部走三态并对 invalid 做跳过处理——直接用布尔版本会把 invalid 当不命中。
 */
export function evaluateCondition(
  cond: FilterCondition | null | undefined,
  record: SdkRecord | null | undefined,
  metas: FieldMetaMap,
): boolean {
  return evaluateConditionState(cond, record, metas) === 'match';
}

/**
 * 筛选配置是否**生效**（有至少一条条件且未被显式关闭）。
 * `enabled` 缺失视为 true（P0 恒 true；仅显式 `false` 才关闭），避免上层构造残缺对象时误判。
 */
export function isFilterActive(
  filter: FilterConfig | null | undefined,
): filter is FilterConfig {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.enabled === false) return false;
  return Array.isArray(filter.conditions) && filter.conditions.length > 0;
}

/**
 * 条件组求值（单层 and / or，不做嵌套）——回答「**这条记录是否通过筛选**」。
 *
 * ⭐ **跳过无效条件**（主理人裁定）：
 * - 只对**可求值**（`'match' | 'noMatch'`）的条件做 and / or；`'invalid'` 条件被跳过；
 * - **可求值条件数为 0 → 返回 `true`（= 不筛选，该记录保留）**。覆盖三种情形：
 *   ① `conditions` 为空（未配置）② `enabled === false` / `filter` 为空 / 结构损坏 ③ 全部条件 invalid。
 * - 因此 and 不会被一个坏条件清空、or 也不会被一个坏条件全放行。
 * - 取舍：宁可筛选**不生效**（用户一眼能发现「筛选没起作用」），
 *   也不让记录**消失**（会被误读为「没有符合条件的记录」）。
 *
 * ⚠️ 与 `isFilterActive` 的分工（**两件事，不要混用**）：
 *   - `isFilterActive(filter)` = 「筛选是否**开启**」，面向 UI（按钮高亮 / 状态行 / 是否持久化）；
 *   - `evaluateFilter(...)` = 「这条记录是否**通过**」，面向数据管道。
 *   旧口径「空 conditions → evaluateFilter 返回 false」**已作废**（架构师同步 §22.4.1）。
 */
export function evaluateFilter(
  filter: FilterConfig | null | undefined,
  record: SdkRecord | null | undefined,
  metas: FieldMetaMap,
): boolean {
  // 「没有可求值的条件」= 不筛选 = 记录通过（三种情形一视同仁）
  if (!filter || typeof filter !== 'object') return true;
  if (filter.enabled === false) return true;
  if (!Array.isArray(filter.conditions)) return true;

  const effective: ConditionResult[] = [];
  for (const cond of filter.conditions) {
    const result = evaluateConditionState(cond, record, metas);
    if (result !== 'invalid') effective.push(result);
  }
  // 全部条件无效 → 无从判断 → 不筛选（保留记录）
  if (effective.length === 0) return true;

  if (filter.conjunction === 'or') {
    return effective.some((result) => result === 'match');
  }
  return effective.every((result) => result === 'match');
}

/**
 * 主入口：对记录数组求值。
 *
 * - **无任何可求值条件 → 返回入参原引用**（便于 React memo），覆盖：
 *   ① 未配置 / 已关闭 / `conditions` 非数组 ② 全部条件的算子未知
 *   ③ **全部条件因「类型 × 算子不匹配」或「字段缺失」而无效**（D3：快速路径也带 metas）。
 * - 其余 → 返回**新数组**，仅保留命中的记录（保持原顺序；
 *   单条记录上若所有条件都无效，该记录也会被 `evaluateFilter` 判为 true 而保留）。
 */
export function applyFilterConditions<T extends SdkRecord>(
  records: readonly T[],
  filter: FilterConfig | null | undefined,
  metas: FieldMetaMap,
): T[] {
  if (!Array.isArray(records)) return [];
  if (!isFilterActive(filter)) return records as unknown as T[];
  // 没有任何一条「可求值」的条件 → 配置整体不可求值 → 不筛，原样返回
  // ⚠️ 必须传 metas：否则「全部条件类型不匹配 / 字段缺失」不会被识别为不可求值（D3）
  if (!filter.conditions.some((cond) => isConditionValid(cond, metas))) {
    return records as unknown as T[];
  }

  const matched: T[] = [];
  for (const record of records) {
    if (evaluateFilter(filter, record, metas)) matched.push(record);
  }
  return matched;
}

/** 覆盖率信息（供状态行文案；纯计算，无副作用） */
export interface FilterScope {
  /** 是否有生效的筛选条件 */
  active: boolean;
  /** 已加载记录数 */
  loaded: number;
  /** 命中记录数 */
  matched: number;
  /** 原生可见总数（`ViewStore.total`） */
  total: number;
  /** 是否仍有未加载页 */
  hasMore: boolean;
  /** 结果是否已覆盖全量：**仅当 `!hasMore`** 时为 true（§22.11 不假绿铁律） */
  fullCoverage: boolean;
}

/** 非负整数收敛（脏数据 → 0） */
function toSafeCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 计算覆盖范围（§22.11）。
 * ⚠️ `fullCoverage` 只由 `hasMore` 决定：**未加载全部时绝不允许声称全量**。
 */
export function computeFilterScope(
  filter: FilterConfig | null | undefined,
  loaded: number,
  matched: number,
  total: number,
  hasMore: boolean,
): FilterScope {
  return {
    active: isFilterActive(filter),
    loaded: toSafeCount(loaded),
    matched: toSafeCount(matched),
    total: toSafeCount(total),
    hasMore: hasMore === true,
    fullCoverage: hasMore !== true,
  };
}

/** 保留导出：日期「次日 0 点」的毫秒跨度（供上层/测试复用，避免各写一份魔数） */
export const FILTER_DAY_MS = DAY_MS;
