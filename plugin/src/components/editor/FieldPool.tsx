/**
 * 字段池（T11 / R1 左栏 220px）：分「已使用 / 未使用 / 不支持类型」三组，可拖入槽位。
 *
 * - 项为 dnd-kit `useDraggable`（id = `field:{fieldId}`）；
 * - 不支持类型**不可拖**，点击提示；
 * - 组内空态各有文案，避免出现空白栏。
 */
import { memo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { getFieldTypeLabel } from '@/fields/fieldTypes';
import type { FieldPoolGroups } from './placementMath';
import { fieldDragId } from './dragIds';

export interface FieldPoolProps {
  groups: FieldPoolGroups;
  /** 点击不支持字段时的提示回调 */
  onUnsupportedClick?: (field: FieldMetaLite) => void;
}

interface PoolItemProps {
  field: FieldMetaLite;
  used: boolean;
}

function PoolItem({ field, used }: PoolItemProps): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: fieldDragId(field.id),
    data: { kind: 'field', fieldId: field.id },
  });

  return (
    <div
      ref={setNodeRef}
      className={`cbv-pool-item${used ? ' cbv-pool-item--used' : ''}${isDragging ? ' cbv-pool-item--dragging' : ''}`}
      data-field-id={field.id}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`${field.name}（${getFieldTypeLabel(field.type)}）`}
    >
      <span className="cbv-pool-item__name">{field.name}</span>
      <span className="cbv-pool-item__type">{getFieldTypeLabel(field.type)}</span>
    </div>
  );
}

function PoolGroup({
  title,
  fields,
  used,
  emptyText,
}: {
  title: string;
  fields: FieldMetaLite[];
  used: boolean;
  emptyText: string;
}): JSX.Element {
  return (
    <section className="cbv-pool-group" data-group={title}>
      <header className="cbv-pool-group__title">
        {title}
        <span className="cbv-pool-group__count">{fields.length}</span>
      </header>
      {fields.length === 0 ? (
        <div className="cbv-pool-group__empty">{emptyText}</div>
      ) : (
        fields.map((field) => <PoolItem key={field.id} field={field} used={used} />)
      )}
    </section>
  );
}

function FieldPoolInner({ groups, onUnsupportedClick }: FieldPoolProps): JSX.Element {
  return (
    <aside className="cbv-editor__left" aria-label="字段池">
      <div className="cbv-editor__panel-title">字段</div>
      <PoolGroup title="已使用" fields={groups.used} used emptyText="尚未使用任何字段，可从「未使用」拖入槽位" />
      <PoolGroup title="未使用" fields={groups.unused} used={false} emptyText="所有可用字段都已使用" />
      <PoolGroup title="不支持类型" fields={groups.unsupported} used={false} emptyText="本视图没有不支持的字段" />
      {groups.unsupported.length > 0 ? (
        <div className="cbv-pool__hint">
          不支持类型的字段无法拖入；
          <button
            type="button"
            className="cbv-link-btn"
            onClick={() => onUnsupportedClick?.(groups.unsupported[0])}
          >
            查看说明
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export const FieldPool = memo(FieldPoolInner);
FieldPool.displayName = 'FieldPool';
