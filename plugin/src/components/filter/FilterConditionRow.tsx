/**
 * 单条筛选条件行（设计文档 §22.5.2 / §22.5.6 F4 强制项）。
 *
 * ⭐ 本组件承载 §22.5.6 的**核心验收项**：无效条件必须被**显式告知**，不得静默忽略。
 *    背景：无效条件（未知算子 / 类型×算子不匹配 / 求值异常）会被 `evaluateFilter`
 *    直接丢弃（§22.4.5），用户看到的是**全部记录**。若 UI 不给提示，用户会以为
 *    「这就是筛选结果」——这与 §22.11.4「不得谎报覆盖全量」是同一类问题：
 *    一个防「谎报筛过了全量」，一个防「谎报筛选生效了」。
 *    二者都不能只靠引擎语义正确兜住，必须由 UI 显式告知。
 *
 * 三条硬要求（逐条对应下方实现）：
 * 1. **校验复用引擎**：`isConditionEffective()` 内部只调用 `engine.isConditionValid(cond, metas)`
 *    与 `engine.evaluateConditionState()`，**不自建**第二套校验逻辑（写两套迟早漂移）；
 * 2. **明确视觉标识**：行内标红（`.cbv-filter-row--invalid` + 内联色）+ 文案说明
 *    + `title` + `aria-invalid="true"`；
 * 3. **空值算子豁免**：`isEmpty` / `isNotEmpty` 永不判无效（§22.3.2），故永不标红
 *    —— 豁免由引擎的 `isTypeOperatorMatch` 保证，本组件不重复实现。
 *
 * 另：算子下拉**只列该字段类型允许的算子**（§22.3 规则 1）；切换字段时若当前算子
 * 不被新类型允许，自动回落到该类型第一个可用算子并**清空值**。
 */
import { getFieldTypeLabel } from '@/fields/fieldTypes';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { FieldSelect } from '@/components/common/FieldSelect';
import type { FieldSelectOption } from '@/components/common/FieldSelect';
import type { FieldMetaMap } from '@/filter/engine';
import { isFilterConditionEffective } from '@/state/selectors';
import {
  getFieldFilterNote,
  getOperatorsForType,
  getOperatorLabel,
  isFilterableFieldType,
  isKnownOperator,
  operatorRequiresValue,
  resolveOperatorForType,
} from '@/filter/operatorMatrix';
import type { FilterCondition, FilterOperator } from '@/filter/types';
import { defaultValueForKind, FilterValueInput, resolveValueInputKind } from './FilterValueInput';

/** 算子不适用于该字段类型时的行内说明文案（§22.5.6 建议文案，QA 断言锁定） */
export const INVALID_TYPE_OPERATOR_TEXT = '该条件不会生效：所选算子不适用于此字段类型';

/**
 * 需值算子「值尚未填写」时的行内说明文案（§22.5.6：未生效的**原因**必须说准）。
 * 与 `INVALID_TYPE_OPERATOR_TEXT` 分开：那种是「算子/类型不对」，这种是「值没填」——
 * 用同一句话会让用户去改算子，而真正该改的是输入值。
 */
export const INCOMPLETE_VALUE_TEXT = '该条件不会生效：尚未填写筛选值';

/** 未知算子的行内说明文案 */
export function unknownOperatorText(operator: string): string {
  return `该条件不会生效：未知算子「${operator}」`;
}

/** 「矩阵中不存在」的字段类型哨兵（用于 `getOperatorsForType` 的兜底分支） */
const UNKNOWN_FIELD_TYPE = -1;

/**
 * 该条件是否**会真正参与筛选**（UI 判红的唯一依据）。
 *
 * ⭐ 本函数**不自己算**，而是转发到 `state/selectors.isFilterConditionEffective()`——
 *    保证「条件行标红」与「状态行报未生效数」用的是**同一份**判定，
 *    两处永远不会各说各话。该判定内部只复用引擎的 `isConditionValid(cond, metas)` +
 *    `evaluateConditionState(cond, null, metas)`（传 `null` 记录时引擎仍会先完成
 *    「算子已知 + 类型×算子匹配」两道判定），故天然带上 `isEmpty` / `isNotEmpty`
 *    的豁免（§22.3.2），与 `evaluateFilter` 判定的是同一份逻辑。
 */
export function isConditionEffective(
  cond: FilterCondition | null | undefined,
  metas: FieldMetaMap,
): boolean {
  return isFilterConditionEffective(cond, metas);
}

/** 按算子重建条件（需要值时才带 `value` 键，避免把空值算子的脏 value 写回配置） */
function buildCondition(
  base: FilterCondition,
  fieldId: string,
  operator: FilterOperator,
  value: unknown,
): FilterCondition {
  const next: FilterCondition = {
    conditionId: base.conditionId,
    fieldId,
    operator,
  };
  if (operatorRequiresValue(operator) && value !== undefined) next.value = value;
  return next;
}

/**
 * 切换字段后的**回落结果**（纯函数，供 UI 与单测共用，§22.3 规则 1）：
 * - 当前算子在新类型允许集内 → 保留；否则回落到该类型**第一个**可用算子；
 * - **值一律清空**：字段都换了，旧值的形态（文本/数字/日期/布尔）对新字段无意义，
 *   留着只会出现「把文本值灌进数字字段」。
 */
export function resolveConditionOnFieldChange(
  cond: FilterCondition,
  nextFieldId: string,
  metas: FieldMetaMap,
): FilterCondition {
  const nextMeta = metas[nextFieldId];
  const nextOperator = resolveOperatorForType(nextMeta?.type ?? UNKNOWN_FIELD_TYPE, cond.operator);
  return buildCondition(cond, nextFieldId, nextOperator, undefined);
}

/**
 * 切换算子后的结果（纯函数）：
 * - 由「需值」变为「无需值」（isEmpty/isNotEmpty）→ 剥掉 value；
 * - 由「无需值」变为「需值」→ 填入该控件形态的默认值；
 * - 其余（同为需值算子）→ **保留**原值（用户改 `is` → `isNot` 时不该丢输入）。
 */
export function resolveConditionOnOperatorChange(
  cond: FilterCondition,
  nextOperator: FilterOperator,
  metas: FieldMetaMap,
): FilterCondition {
  const meta = metas[cond.fieldId];
  if (!operatorRequiresValue(nextOperator)) return buildCondition(cond, cond.fieldId, nextOperator, undefined);
  const keep = cond.value !== undefined && operatorRequiresValue(cond.operator) ? cond.value : undefined;
  const value = keep !== undefined ? keep : defaultValueForKind(resolveValueInputKind(meta, nextOperator));
  return buildCondition(cond, cond.fieldId, nextOperator, value);
}

/**
 * 新建一条条件的默认形态（纯函数）：取第一个**可筛**字段 + 该类型的第一个可用算子。
 * 无可筛字段时返回 null（调用方据此禁用「添加条件」，从源头不给不可筛条件）。
 *
 * ⭐ 需值算子的新行**不预填值**（传 `undefined`）：若预填 `''`，新行会「看起来填好了、实为空值」——
 *    引擎据 `isValidConditionValue` 判其 **未生效**（见 `engine.ts`），那么新行一出现就应**如实**
 *    显示「未生效」，且**不得隐藏任何数据**。故这里刻意留空，等用户真正输入值才生效。
 *    实现上：`buildCondition` 只在 `operatorRequiresValue(op) && value !== undefined` 时才写入 `value`，
 *    传 `undefined` ⇒ 条件对象**不带 `value` 键**（值输入框仍由 `FilterValueInput` 正常渲染）。
 *    ⚠️ `isEmpty` / `isNotEmpty` 本就不需要值，行为不变。
 */
export function createDefaultCondition(
  fields: readonly FieldMetaLite[],
  metas: FieldMetaMap,
  conditionId: string,
): FilterCondition | null {
  const first = fields.find((field) => isFilterableFieldType(field.type));
  if (!first) return null;
  const operator = resolveOperatorForType(first.type, undefined);
  return buildCondition({ conditionId, fieldId: first.id, operator }, first.id, operator, undefined);
}

export interface FilterConditionRowProps {
  /** 当前条件 */
  condition: FilterCondition;
  /** 全部字段（内部按 `isFilterableFieldType` 过滤后再进下拉，§22.3 规则 5） */
  fields: readonly FieldMetaLite[];
  /** 字段元数据索引（fieldId → meta） */
  fieldsById: FieldMetaMap;
  /** 条件变更（**整条替换**，调用方负责写回 store） */
  onChange: (next: FilterCondition) => void;
  /** 删除该条 */
  onRemove: () => void;
}

/**
 * 单条条件行：字段下拉 → 算子下拉 → 值输入 → 删除。
 *
 * ⚠️ 本组件刻意**无内部 state**（完全受控）：所有变更都以「整条新条件」回调，
 *    由 `FilterPanel` 写回 `UiStore`。这样「面板显示的」与「引擎求值的」永远同源，
 *    不会出现条件行的本地草稿与 store 不一致导致的「看起来生效其实没生效」。
 */
export function FilterConditionRow({
  condition,
  fields,
  fieldsById,
  onChange,
  onRemove,
}: FilterConditionRowProps): JSX.Element {
  const meta = fieldsById[condition.fieldId];
  const filterable = fields.filter((field) => isFilterableFieldType(field.type));
  const currentInFilterable = filterable.some((field) => field.id === condition.fieldId);

  const allowed = getOperatorsForType(meta?.type ?? UNKNOWN_FIELD_TYPE);
  // 当前算子不被该类型允许时**仍然要显示它**（否则无效条件无从暴露，UI 就静默了）；
  // 额外追加到下拉首位并标注「（不适用）」，与「只列允许的算子」不冲突：
  // 正常路径（UI 内切换字段）会先回落，走到这里的是**外部配置/历史遗留配置**。
  const operatorOptions: readonly FilterOperator[] = allowed.includes(condition.operator)
    ? allowed
    : [condition.operator, ...allowed];

  const effective = isConditionEffective(condition, fieldsById);
  /*
   * 三种「未生效」原因分别给出**准确**文案，其顺序即**提示优先级**：
   *   ① 未知算子 → ② 类型 × 算子不匹配（含字段已删除）→ ③ 值未填写。
   *
   * ⭐ 为什么 ② 必须排在 ③ 之前（团队裁定 · 2026-09-21）：
   *    类型不匹配时**填什么值都不可能生效**，用户的正确动作是**换算子**；
   *    若先提示「尚未填写筛选值」，用户会先去填值 → 填完才看到「算子不适用」→ 才去换算子。
   *    要两步才揭示真正问题，**而第一步就把人引向了无效动作**——UI 不得把用户引向无效动作。
   *
   * ⚠️ 注意「类型是否匹配」**不能**用 `!isConditionValid(cond, metas)` 判断：
   *    引擎的 `isConditionValid` 现在把**值**校验（`isValidConditionValue`）也并进去了，
   *    直接取反会把「值没填」误报成「算子不适用」——正好是我们刚修掉的那个错误。
   *    故此处复用引擎 `isTypeOperatorMatch` 的**同一组原语**（`operatorRequiresValue` +
   *    矩阵查询，二者均为 `operatorMatrix` 导出）重新组合，语义与引擎内部逐字一致；
   *    `allowed` 就是 `getOperatorsForType(meta.type)`，与 `isOperatorAllowed` 同源。
   *
   * 分支完备性：走到 ③ 时必为「算子已知 + 类型匹配 + 字段存在」，
   *    而 `effective === false` 在此时**只能**由值未填写导致（引擎同序判定），故文案必然说准。
   */
  const typeMatchesField = meta !== undefined
    && (!operatorRequiresValue(condition.operator) || allowed.includes(condition.operator));

  const invalidText = !isKnownOperator(condition.operator)
    ? unknownOperatorText(String(condition.operator))
    : !typeMatchesField
      ? INVALID_TYPE_OPERATOR_TEXT
      : INCOMPLETE_VALUE_TEXT;

  const note = meta ? getFieldFilterNote(meta.type) : null;
  const rowClassName = `cbv-filter-row${effective ? '' : ' cbv-filter-row--invalid'}`;

  /**
   * 字段下拉候选集（受控数据，交给共享的 `FieldSelect` 呈现 + 模糊查询）：
   *  - 不可筛字段一律不进候选（§22.3 规则 5）；
   *  - 但**当前字段不在候选内**（历史 / 外部配置）时必须**仍显示出来**，
   *    否则无效条件就无从暴露、UI 会静默（§22.5.6）。
   */
  const fieldOptions: FieldSelectOption[] = [];
  if (!currentInFilterable) {
    fieldOptions.push({
      value: condition.fieldId,
      label: meta ? `${meta.name || condition.fieldId}（不支持筛选）` : `${condition.fieldId}（字段已删除）`,
    });
  }
  for (const field of filterable) {
    fieldOptions.push({
      value: field.id,
      label: `${field.name}（${getFieldTypeLabel(field.type)}）`,
      hint: getFieldFilterNote(field.type) ?? undefined,
    });
  }

  return (
    <div
      className={rowClassName}
      data-testid="filter-condition-row"
      data-condition-id={condition.conditionId}
      aria-invalid={effective ? undefined : true}
      title={effective ? note ?? undefined : invalidText}
      // ⭐ 行内标红：`.cbv-filter-row--invalid` 供样式/断言使用；
      //    内联样式保证在 `globals.css` 尚未补充该选择器时**也一定看得见**（F5 收口样式）。
      style={effective ? undefined : { borderColor: '#d83931', background: '#fff2f1' }}
    >
      {/*
       * ⭐ 字段下拉换成共享的 `FieldSelect`（可搜索）：用户反馈「字段太多很难选择」。
       *    onChange **原样**走 `resolveConditionOnFieldChange` —— 切字段时算子回落 + 清空值
       *    的语义**一字未改**；`data-testid="filter-field-select"` 保持不变。
       */}
      <FieldSelect
        options={fieldOptions}
        value={condition.fieldId}
        onChange={(next) => onChange(resolveConditionOnFieldChange(condition, next, fieldsById))}
        searchable
        // ⭐ req1：显式开启「可搜索」视觉提示（浮层顶部提示行 + 触发体 🔍）——
        //    此前用户反馈「看不出字段下拉能搜」。纯视觉提示，交互/onChange 一字未改。
        searchableHint
        testId="filter-field-select"
        ariaLabel="筛选字段"
        invalid={!effective}
      />

      <select
        className="cbv-select"
        data-testid="filter-operator-select"
        aria-label="筛选算子"
        aria-invalid={effective ? undefined : true}
        value={isKnownOperator(condition.operator) ? condition.operator : ''}
        onChange={(event) => {
          const next = event.target.value;
          if (!isKnownOperator(next)) return;
          onChange(resolveConditionOnOperatorChange(condition, next, fieldsById));
        }}
      >
        {!isKnownOperator(condition.operator) ? (
          <option value="">{String(condition.operator)}（未知算子）</option>
        ) : null}
        {operatorOptions.map((operator) => (
          <option key={operator} value={operator}>
            {`${getOperatorLabel(operator, meta?.type)}${allowed.includes(operator) ? '' : '（不适用）'}`}
          </option>
        ))}
      </select>

      <FilterValueInput
        meta={meta}
        operator={condition.operator}
        value={condition.value}
        onChange={(value) => onChange(buildCondition(condition, condition.fieldId, condition.operator, value))}
      />

      {effective ? null : (
        <span className="cbv-filter-row__invalid" data-testid="filter-condition-invalid" role="alert" style={{ color: '#d83931' }}>
          {invalidText}
        </span>
      )}

      {note && effective ? (
        <span className="cbv-filter-row__note" title={note} aria-hidden="true">
          ⓘ
        </span>
      ) : null}

      <button
        type="button"
        className="cbv-btn cbv-link-btn"
        data-testid="filter-condition-remove"
        aria-label="删除条件"
        title="删除条件"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}
