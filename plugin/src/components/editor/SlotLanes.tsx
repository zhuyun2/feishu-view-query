/**
 * 槽位投放区（T11 / R1 中栏下半）：四个槽位的拖放目标 + 已放置字段的可排序 chip。
 *
 * 拖拽反馈三要素（必须齐）：
 *  ① **幽灵元素**：`ConfigDrawer` 的 `<DragOverlay>`；
 *  ② **目标槽位高亮**：`useDroppable().isOver` → `cbv-slot--over`；
 *  ③ **2px 插入指示线**：拖拽目标槽位时在末尾显示 `cbv-slot__insert-line`。
 */
import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CardLayoutConfig, SlotId } from '@/config/types';
import type { FieldMetaLite } from '@/fields/fieldTypes';
import { getFieldTypeLabel } from '@/fields/fieldTypes';
import { SLOT_LABEL, SLOT_ORDER } from './placementMath';
import { placementDragId, slotDropId } from './dragIds';

export interface SlotLanesProps {
  layout: CardLayoutConfig;
  fieldsById: Record<string, FieldMetaLite>;
  onRemovePlacement: (placementId: string) => void;
}

function SortableChip({
  placementId,
  fieldId,
  label,
  fieldsById,
  onRemove,
}: {
  placementId: string;
  fieldId: string;
  label: string;
  fieldsById: Record<string, FieldMetaLite>;
  onRemove: (placementId: string) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: placementDragId(placementId),
    data: { kind: 'placement', placementId, fieldId },
  });

  const meta = fieldsById[fieldId];
  const typeLabel = meta ? getFieldTypeLabel(meta.type) : '未知';

  return (
    <span
      ref={setNodeRef}
      className={`cbv-slot-chip${isDragging ? ' cbv-slot-chip--dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-placement-id={placementId}
      {...attributes}
      {...listeners}
    >
      <span className="cbv-slot-chip__name">{label || meta?.name || fieldId}</span>
      <span className="cbv-slot-chip__type">{typeLabel}</span>
      <button
        type="button"
        className="cbv-slot-chip__remove"
        aria-label={`移除 ${label || meta?.name || fieldId}`}
        onClick={() => onRemove(placementId)}
      >
        ✕
      </button>
    </span>
  );
}

function SlotLane({
  slotId,
  layout,
  fieldsById,
  onRemovePlacement,
}: {
  slotId: SlotId;
  layout: CardLayoutConfig;
  fieldsById: Record<string, FieldMetaLite>;
  onRemovePlacement: (placementId: string) => void;
}): JSX.Element {
  const slot = layout.slots[slotId];
  const { setNodeRef, isOver } = useDroppable({ id: slotDropId(slotId), data: { kind: 'slot', slotId } });

  const placements = slot ? [...slot.placements].sort((a, b) => a.order - b.order) : [];

  return (
    <div
      ref={setNodeRef}
      className={`cbv-slot${isOver ? ' cbv-slot--over' : ''}${slot?.visible ? '' : ' cbv-slot--hidden'}`}
      data-slot-id={slotId}
    >
      <div className="cbv-slot__head">
        <span className="cbv-slot__name">{SLOT_LABEL[slotId]}</span>
        <span className="cbv-slot__count">{placements.length}</span>
      </div>
      <div className="cbv-slot__body">
        {placements.length === 0 ? (
          <span className="cbv-slot__empty">拖拽字段到此处</span>
        ) : (
          placements.map((placement) => (
            <SortableChip
              key={placement.placementId}
              placementId={placement.placementId}
              fieldId={placement.fieldId}
              label={placement.label ?? ''}
              fieldsById={fieldsById}
              onRemove={onRemovePlacement}
            />
          ))
        )}
        {isOver ? <span className="cbv-slot__insert-line" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

function SlotLanesInner({ layout, fieldsById, onRemovePlacement }: SlotLanesProps): JSX.Element {
  return (
    <div className="cbv-editor__lanes" aria-label="槽位投放区">
      <div className="cbv-editor__panel-title">槽位</div>
      {SLOT_ORDER.map((slotId) => (
        <SlotLane
          key={slotId}
          slotId={slotId}
          layout={layout}
          fieldsById={fieldsById}
          onRemovePlacement={onRemovePlacement}
        />
      ))}
    </div>
  );
}

export const SlotLanes = memo(SlotLanesInner);
SlotLanes.displayName = 'SlotLanes';
