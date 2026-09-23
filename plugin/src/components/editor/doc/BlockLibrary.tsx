/**
 * 区块库（左栏 220px，设计文档 §5.2 / §21.6 / M3-T08）。
 *
 * 职责：
 *  - 按 `doc/blockCatalog.ts` 的 **5 个语义分组**（文本 / 字段 / 媒体 / 结构 / 元信息）呈现
 *    **12 类**区块，组内顺序 = 目录顺序；
 *  - 每项是 dnd-kit `useDraggable`（id = `blocklib:{kind}`），拖出即产出携带
 *    **kind + 默认分页行为 +（可选）默认尺寸** 的拖拽载荷（见 `blockLibDragData`）。
 *
 * ⚠️ 为什么强调「12 类」：§21 个别处曾误写「11 类」（已在 §21.10-⑩ 更正）。
 * 区块库**漏登记一类**的后果是「该类区块根本拖不进文档」且**用户不会收到任何报错**
 * —— 属静默功能性缺陷。故 `BlockLibrary.test.tsx` 逐组断言 kind 集合并锁定总数 12。
 *
 * ⚠️ 禁 HTML5 原生 DnD（R1：iframe 沙箱下会失效）；一律走 dnd-kit `PointerSensor`（由
 * `DocLayoutEditor` 的 `<DndContext>` 提供 sensors）。
 */
import { memo, useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { BreakInside, DocBlock } from '@/config/types';
import type { BlockCatalogEntry, BlockGroup } from '@/doc/blockCatalog';
import { groupCatalog } from '@/doc/blockCatalog';
import { blockLibDragId } from '../dragIds';

/** 从区块库拖出时的载荷（`DocLayoutEditor.onDragEnd` 据此调 `defaultBlockFor(kind, fields)`） */
export interface BlockLibraryDragData {
  /** 拖拽来源判别（与 `parseDragId` 的 `blocklib` 一致） */
  kind: 'blocklib';
  /** 区块类型（= `DocBlockKind`）—— 落点决定插入位置，本字段决定「造什么块」 */
  blockKind: DocBlock['kind'];
  /** 所属分组（供属性面板/埋点分流） */
  group: BlockGroup;
  /** 中文名（拖拽幽灵文案） */
  label: string;
  /** 该区块默认分页行为（透传给 `defaultBlockFor` 的初始值参考） */
  defaultBreakInside: BreakInside;
  /** 默认尺寸提示（px）；目录未声明时为 `undefined` */
  defaultSize?: { width?: number; height?: number };
}

/**
 * 目录项 → 拖拽载荷。**纯函数**：`useDraggable({ data })` 与单测共用同一份载荷构造，
 * 避免「组件里写的载荷」与「测试断言的载荷」两套口径。
 */
export function blockLibDragData(entry: BlockCatalogEntry): BlockLibraryDragData {
  const data: BlockLibraryDragData = {
    kind: 'blocklib',
    blockKind: entry.kind,
    group: entry.group,
    label: entry.label,
    defaultBreakInside: entry.defaultBreakInside,
  };
  if (entry.defaultSize) data.defaultSize = { ...entry.defaultSize };
  return data;
}

export interface BlockLibraryProps {
  /** 只读 / 有未保存冲突等场景下禁止拖拽（缺省 false） */
  disabled?: boolean;
}

/** 单个可拖区块项 */
function LibraryItem({ entry, disabled }: { entry: BlockCatalogEntry; disabled: boolean }): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: blockLibDragId(entry.kind),
    data: blockLibDragData(entry),
    disabled,
  });

  const className =
    `cbv-blocklib__item${isDragging ? ' cbv-blocklib__item--dragging' : ''}` +
    `${disabled ? ' cbv-blocklib__item--disabled' : ''}`;

  return (
    <div
      ref={setNodeRef}
      className={className}
      data-block-kind={entry.kind}
      data-drag-kind="blocklib"
      data-drag-id={blockLibDragId(entry.kind)}
      data-break-inside={entry.defaultBreakInside}
      title={entry.description}
      aria-label={`${entry.label}：${entry.description}`}
      {...attributes}
      {...listeners}
    >
      <span className="cbv-blocklib__icon" aria-hidden="true" data-icon={entry.icon} />
      <span className="cbv-blocklib__name">{entry.label}</span>
    </div>
  );
}

/** 一个分组区块 */
function LibraryGroup({
  group,
  label,
  entries,
  disabled,
}: {
  group: BlockGroup;
  label: string;
  entries: readonly BlockCatalogEntry[];
  disabled: boolean;
}): JSX.Element {
  return (
    <section className="cbv-blocklib__group" data-block-group={group} aria-label={`${label}区块`}>
      <header className="cbv-blocklib__group-title">
        <span className="cbv-blocklib__group-name">{label}</span>
        <span className="cbv-blocklib__group-count">{entries.length}</span>
      </header>
      {entries.map((entry) => (
        <LibraryItem key={entry.kind} entry={entry} disabled={disabled} />
      ))}
    </section>
  );
}

function BlockLibraryInner({ disabled = false }: BlockLibraryProps): JSX.Element {
  // 分组视图是纯数据推导 → 只算一次
  const groups = useMemo(() => groupCatalog(), []);
  const total = useMemo(() => groups.reduce((sum, item) => sum + item.entries.length, 0), [groups]);

  return (
    <aside className="cbv-editor__left cbv-blocklib" aria-label="区块库" data-block-total={total}>
      <div className="cbv-editor__panel-title">区块库</div>
      {groups.map((item) => (
        <LibraryGroup
          key={item.group}
          group={item.group}
          label={item.label}
          entries={item.entries}
          disabled={disabled}
        />
      ))}
    </aside>
  );
}

export const BlockLibrary = memo(BlockLibraryInner);
BlockLibrary.displayName = 'BlockLibrary';

export default BlockLibrary;
