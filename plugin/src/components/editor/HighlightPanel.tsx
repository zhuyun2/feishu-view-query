/**
 * 条件高亮面板（T11 / R1 右栏；规则引擎 §6.9，**D5：单层 AND/OR，不做嵌套表达式树**）。
 *
 * 每条规则：
 *  - 目标：整卡边框 / 指定字段着色 / 标签着色；
 *  - 条件：单层 `and|or` + 若干「字段 运算符 值」；空值类运算符不需要值；
 *  - 样式：边框色（cardBorder）或文字色（field / badge）；优先级（数字小者优先）。
 */
import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import type { HighlightRule, HighlightStyle, HighlightTarget, RuleExpr, RuleOperator } from '@/config/types';
import { createId } from '@/config/defaults';

/** 语义色候选（04 §3.2）——不自创色值 */
const STYLE_SWATCHES = ['#F54A45', '#FF8800', '#34C724', '#3370FF', '#8F959E'] as const;

const OPERATORS: ReadonlyArray<{ value: RuleOperator; label: string; needsValue: boolean }> = [
  { value: 'eq', label: '等于', needsValue: true },
  { value: 'neq', label: '不等于', needsValue: true },
  { value: 'gt', label: '大于', needsValue: true },
  { value: 'gte', label: '大于等于', needsValue: true },
  { value: 'lt', label: '小于', needsValue: true },
  { value: 'lte', label: '小于等于', needsValue: true },
  { value: 'contains', label: '包含', needsValue: true },
  { value: 'notContains', label: '不包含', needsValue: true },
  { value: 'isEmpty', label: '为空', needsValue: false },
  { value: 'isNotEmpty', label: '不为空', needsValue: false },
  { value: 'before', label: '早于', needsValue: true },
  { value: 'after', label: '晚于', needsValue: true },
];

function operatorNeedsValue(operator: RuleOperator): boolean {
  return OPERATORS.find((item) => item.value === operator)?.needsValue ?? true;
}

function targetValue(target: HighlightTarget): string {
  if (target.kind === 'cardBorder') return 'cardBorder';
  return `${target.kind}:${target.fieldId}`;
}

function parseTargetValue(value: string, fallbackFieldId: string): HighlightTarget {
  if (value === 'cardBorder') return { kind: 'cardBorder' };
  if (value.startsWith('field:')) return { kind: 'field', fieldId: value.slice('field:'.length) };
  if (value.startsWith('badge:')) return { kind: 'badge', fieldId: value.slice('badge:'.length) };
  return { kind: 'field', fieldId: fallbackFieldId };
}

export interface HighlightPanelProps {
  rules: HighlightRule[];
  fields: FieldMetaLite[];
  onChange: (rules: HighlightRule[]) => void;
}

function createRule(fields: FieldMetaLite[]): HighlightRule {
  const fieldId = fields[0]?.id ?? '';
  return {
    ruleId: createId('hl'),
    name: '新规则',
    enabled: true,
    target: { kind: 'cardBorder' },
    condition: { logic: 'and', items: [{ fieldId, operator: 'isNotEmpty' }] },
    style: { borderColor: '#F54A45', borderWidth: 2 },
    priority: 10,
  };
}

function RuleEditor({
  rule,
  fields,
  onPatch,
  onRemove,
}: {
  rule: HighlightRule;
  fields: FieldMetaLite[];
  onPatch: (patch: Partial<HighlightRule>) => void;
  onRemove: () => void;
}): JSX.Element {
  const patchItems = (items: RuleExpr[]): void => onPatch({ condition: { ...rule.condition, items } });
  const patchStyle = (patch: Partial<HighlightStyle>): void => onPatch({ style: { ...rule.style, ...patch } });
  const isBorder = rule.target.kind === 'cardBorder';

  return (
    <div className="cbv-hl-rule" data-rule-id={rule.ruleId}>
      <div className="cbv-hl-rule__head">
        <input
          type="checkbox"
          checked={rule.enabled}
          aria-label="启用规则"
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        <input
          className="cbv-input cbv-hl-rule__name"
          value={rule.name}
          aria-label="规则名称"
          onChange={(event) => onPatch({ name: event.target.value })}
        />
        <button type="button" className="cbv-link-btn" onClick={onRemove} aria-label="删除规则">
          删除
        </button>
      </div>

      <div className="cbv-prop-row">
        <span className="cbv-prop-row__label">目标</span>
        <select
          className="cbv-select"
          value={targetValue(rule.target)}
          aria-label="高亮目标"
          onChange={(event) => onPatch({ target: parseTargetValue(event.target.value, fields[0]?.id ?? '') })}
        >
          <option value="cardBorder">整卡边框</option>
          {fields.map((field) => (
            <option key={`field:${field.id}`} value={`field:${field.id}`}>{`字段：${field.name}`}</option>
          ))}
          {fields.map((field) => (
            <option key={`badge:${field.id}`} value={`badge:${field.id}`}>{`标签：${field.name}`}</option>
          ))}
        </select>
      </div>

      <div className="cbv-prop-row">
        <span className="cbv-prop-row__label">满足</span>
        <div className="cbv-segmented cbv-segmented--mini">
          {(['and', 'or'] as const).map((logic) => (
            <button
              key={logic}
              type="button"
              className={`cbv-segmented__item${rule.condition.logic === logic ? ' cbv-segmented__item--active' : ''}`}
              onClick={() => onPatch({ condition: { ...rule.condition, logic } })}
            >
              {logic === 'and' ? '全部满足' : '任一满足'}
            </button>
          ))}
        </div>
      </div>

      <div className="cbv-hl-conditions">
        {rule.condition.items.map((expr, index) => {
          const needsValue = operatorNeedsValue(expr.operator);
          return (
            <div className="cbv-hl-cond" key={`${rule.ruleId}-cond-${index}`}>
              <select
                className="cbv-select"
                value={expr.fieldId}
                aria-label="条件字段"
                onChange={(event) =>
                  patchItems(
                    rule.condition.items.map((item, i) => (i === index ? { ...item, fieldId: event.target.value } : item)),
                  )
                }
              >
                {fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
              <select
                className="cbv-select"
                value={expr.operator}
                aria-label="条件运算符"
                onChange={(event) =>
                  patchItems(
                    rule.condition.items.map((item, i) =>
                      i === index ? { ...item, operator: event.target.value as RuleOperator } : item,
                    ),
                  )
                }
              >
                {OPERATORS.map((operator) => (
                  <option key={operator.value} value={operator.value}>
                    {operator.label}
                  </option>
                ))}
              </select>
              <input
                className="cbv-input"
                value={expr.value === undefined ? '' : String(expr.value)}
                aria-label="条件值"
                disabled={!needsValue}
                onChange={(event) =>
                  patchItems(
                    rule.condition.items.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                  )
                }
              />
              <button
                type="button"
                className="cbv-link-btn"
                aria-label="删除条件"
                onClick={() => patchItems(rule.condition.items.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="cbv-link-btn"
          onClick={() => patchItems([...rule.condition.items, { fieldId: fields[0]?.id ?? '', operator: 'isNotEmpty' }])}
        >
          + 添加条件
        </button>
      </div>

      <div className="cbv-prop-row">
        <span className="cbv-prop-row__label">样式</span>
        <div className="cbv-swatches">
          {STYLE_SWATCHES.map((color) => {
            const active = isBorder ? rule.style.borderColor === color : rule.style.color === color;
            return (
              <button
                key={color}
                type="button"
                className={`cbv-swatch${active ? ' cbv-swatch--active' : ''}`}
                style={{ background: color } as CSSProperties}
                aria-label={`样式色 ${color}`}
                aria-pressed={active}
                data-color={color}
                onClick={() => (isBorder ? patchStyle({ borderColor: color, borderWidth: 2 }) : patchStyle({ color }))}
              />
            );
          })}
        </div>
      </div>

      <div className="cbv-prop-row">
        <span className="cbv-prop-row__label">优先级</span>
        <input
          className="cbv-input cbv-input--num"
          type="number"
          min={0}
          max={999}
          value={rule.priority}
          aria-label="优先级"
          onChange={(event) => onPatch({ priority: Number(event.target.value) || 0 })}
        />
      </div>
    </div>
  );
}

function HighlightPanelInner({ rules, fields, onChange }: HighlightPanelProps): JSX.Element {
  return (
    <section className="cbv-prop-section" data-section="highlight">
      <div className="cbv-prop-section__title">
        条件高亮
        <button type="button" className="cbv-link-btn" onClick={() => onChange([...rules, createRule(fields)])}>
          + 添加规则
        </button>
      </div>
      {rules.length === 0 ? (
        <p className="cbv-prop-note">尚未配置高亮规则。可基于字段值让卡片边框或字段着色。</p>
      ) : (
        rules.map((rule) => (
          <RuleEditor
            key={rule.ruleId}
            rule={rule}
            fields={fields}
            onPatch={(patch) =>
              onChange(rules.map((item) => (item.ruleId === rule.ruleId ? { ...item, ...patch } : item)))
            }
            onRemove={() => onChange(rules.filter((item) => item.ruleId !== rule.ruleId))}
          />
        ))
      )}
    </section>
  );
}

export const HighlightPanel = memo(HighlightPanelInner);
HighlightPanel.displayName = 'HighlightPanel';
