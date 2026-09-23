/**
 * 卡片排版编辑器（T11 / R1 冻结：**沉浸式三栏**，而非 PRD 原写的 360px 抽屉）。
 *
 * 布局：左「字段池 220px」 + 中「预览样例卡 + 槽位投放区」 + 右「属性面板 300px」；
 * 顶栏含「卡片排版 | 文档排版」模式切换 + 撤销 / 取消 / 保存。
 *
 * 交互要点：
 *  - 拖拽用 dnd-kit 的 **`PointerSensor`**（R1：**禁用 HTML5 原生 DnD**，iframe 沙箱下会失效）；
 *  - 拖拽反馈三要素：`<DragOverlay>` 幽灵 + 目标槽位高亮（`isOver`）+ 2px 插入指示线；
 *  - 编辑态点击卡片**不展开详情**（R6：卡片墙隐藏，中栏预览为 `static`）；
 *  - 未保存关闭 → **二次确认**；
 *  - 文档排版模式（M3-T10）：doc 分支接入 **`DocLayoutEditor`**（区块库 / A4 画布 / 属性面板）。
 *    ⚠️ `DocLayoutEditor` **自带 DndContext**（PointerSensor, distance 4）——doc 分支**绝不再包一层**，
 *    嵌套 DndContext 会导致拖拽静默错乱（不报错，只是拖不动 / 拖错位置）。card 分支保持自身 DndContext 不变。
 *
 * ⚠️ 与 R1 的一致性：本文以 R1 为准（三栏 220/自适应/300、顶部模式切换、dnd-kit PointerSensor）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { CardLayoutConfig, DensityConfig, DocTemplate, ImportedDocx, SlotId } from '@/config/types';
import { applyCardTemplate, type CardTemplateName, type DensityPresetName } from '@/config/presets';
import { UNSUPPORTED_NEWER_SAVE_MESSAGE } from '@/config/ConfigRepository';
import { resolveDocSource } from '@/doc/template/storage';
import { useDraftStore } from '@/state/DraftStore';
import { useUiStore } from '@/state/UiStore';
import { useViewStore } from '@/state/ViewStore';
import { selectAttributesMaxRows, selectDensityWithPreset } from '@/state/selectors';
import { logError } from '@/utils/log';
import { FieldPool } from './FieldPool';
import { SlotLanes } from './SlotLanes';
import { PreviewSampleCard } from './PreviewSampleCard';
import { PropertyPanel } from './PropertyPanel';
import { DocLayoutEditor } from './doc/DocLayoutEditor';
import { DocxTemplateSourceBar } from './doc/DocxTemplateSourceBar';
import { addFieldToSlot, findPlacement, groupFieldPool, movePlacement, removePlacement, resolveEditorClose } from './placementMath';
import { parseDragId } from './dragIds';

/**
 * §10 命名对齐：设计文档已把本组件语义定名为 **`ConfigEditor`**（沉浸式编辑器容器，
 * 不再是「抽屉」）。为兼顾既有引用与设计文档契约，此处导出 `ConfigEditor` 别名，
 * 两者指向同一实现。新代码请优先使用 `ConfigEditor`。
 */
type EditorModeUi = 'card' | 'doc';

interface ActiveDrag {
  kind: 'field' | 'placement';
  label: string;
}

export function ConfigDrawer(): JSX.Element | null {
  const editorOpen = useUiStore((state) => state.editorOpen);
  const editMode = useUiStore((state) => state.editMode);
  const closeEditor = useUiStore((state) => state.closeEditor);
  const setEditMode = useUiStore((state) => state.setEditMode);
  const showToast = useUiStore((state) => state.showToast);

  const viewConfig = useViewStore((state) => state.config);
  const fields = useViewStore((state) => state.fields);
  const canEditConfig = useViewStore((state) => state.canEditConfig);
  const unsupportedNewer = useViewStore((state) => state.unsupportedNewer);
  const persistConfig = useViewStore((state) => state.persistConfig);
  /** 当前视图 id：导入模板的分块 key 需要（`cbv:tpl:{viewId}:…`）；缺省 `''` 时仅走 legacy 内联 */
  const envViewId = useViewStore((state) => state.env?.viewId ?? '');

  const draftActive = useDraftStore((state) => state.active);
  const cardDraft = useDraftStore((state) => state.cardDraft);
  const docDraft = useDraftStore((state) => state.docDraft);
  const densityDraft = useDraftStore((state) => state.densityDraft);
  const themeDraft = useDraftStore((state) => state.themeDraft);
  const highlightDraft = useDraftStore((state) => state.highlightDraft);
  // ⭐ 「模板来源」与「导入的 docx」草稿（doc 分支：来源切换 / 上传写草稿，保存时进载荷）
  const docSourceDraft = useDraftStore((state) => state.docSourceDraft);
  const importedDocxDraft = useDraftStore((state) => state.importedDocxDraft);
  const dirty = useDraftStore((state) => state.dirty);

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const fieldsById = useMemo(() => {
    const map: Record<string, (typeof fields)[number]> = {};
    for (const field of fields) map[field.id] = field;
    return map;
  }, [fields]);

  // 打开编辑器时初始化草稿（以已保存配置为基准）
  useEffect(() => {
    if (!editorOpen) return;
    if (draftActive) return;
    if (!viewConfig) return;
    useDraftStore.getState().open(viewConfig, 'card');
  }, [editorOpen, draftActive, viewConfig]);

  const finalizeClose = useCallback((): void => {
    const draft = useDraftStore.getState();
    draft.discard();
    draft.close();
    setConfirmOpen(false);
    closeEditor();
  }, [closeEditor]);

  const requestClose = useCallback((): void => {
    if (resolveEditorClose(useDraftStore.getState().isDirty()) === 'confirm') {
      setConfirmOpen(true);
      return;
    }
    finalizeClose();
  }, [finalizeClose]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!viewConfig) return;
    if (unsupportedNewer) {
      showToast(UNSUPPORTED_NEWER_SAVE_MESSAGE);
      return;
    }
    if (!canEditConfig) {
      showToast('仅查看权限，无法保存配置');
      return;
    }
    const built = useDraftStore.getState().buildConfig(viewConfig);
    const result = await persistConfig(built);
    if (result.ok) {
      showToast('已保存');
      useDraftStore.getState().close();
      closeEditor();
      return;
    }
    if (result.reason === 'unsupported-newer-readonly') {
      showToast(UNSUPPORTED_NEWER_SAVE_MESSAGE);
      return;
    }
    if (result.tooLarge) {
      showToast(result.error ?? '配置体积超过 64KB 上限，请精简高亮规则后重试');
      return;
    }
    showToast(result.error ?? '保存失败，请重试');
  }, [viewConfig, unsupportedNewer, canEditConfig, persistConfig, showToast, closeEditor]);

  const handleUndo = useCallback((): void => {
    const ok = useDraftStore.getState().rollback();
    if (!ok) showToast('没有可撤销的操作');
  }, [showToast]);

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      const parsed = parseDragId(String(event.active.id));
      if (parsed.kind === 'field') {
        const field = fieldsById[parsed.value];
        setActiveDrag({ kind: 'field', label: field?.name ?? '字段' });
      } else if (parsed.kind === 'placement') {
        const found = cardDraft ? findPlacement(cardDraft, parsed.value) : null;
        const field = found ? fieldsById[found.placement.fieldId] : undefined;
        setActiveDrag({ kind: 'placement', label: field?.name ?? '字段' });
      }
    },
    [cardDraft, fieldsById],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setActiveDrag(null);
      const { active, over } = event;
      if (!over || !cardDraft) return;

      const activeParsed = parseDragId(String(active.id));
      const overParsed = parseDragId(String(over.id));

      let targetSlot: SlotId | null = null;
      let toIndex = -1;
      if (overParsed.kind === 'slot') {
        targetSlot = overParsed.value as SlotId;
      } else if (overParsed.kind === 'placement') {
        const found = findPlacement(cardDraft, overParsed.value);
        if (found) {
          targetSlot = found.slotId;
          toIndex = found.index;
        }
      }
      if (!targetSlot) return;

      const draftStore = useDraftStore.getState();
      draftStore.snapshot();
      if (activeParsed.kind === 'field') {
        draftStore.updateCard((layout) => addFieldToSlot(layout, activeParsed.value, targetSlot as SlotId, toIndex));
      } else if (activeParsed.kind === 'placement') {
        const found = findPlacement(cardDraft, activeParsed.value);
        if (!found) return;
        if (found.slotId === targetSlot && (toIndex === found.index || toIndex === found.index + 1)) return;
        draftStore.updateCard((layout) => movePlacement(layout, activeParsed.value, targetSlot as SlotId, toIndex));
      }
    },
    [cardDraft],
  );

  // ── 文档排版（M3-T10）：变更入口 = 草稿 doc 分支；变更前先快照以支持撤销 ──
  // ⚠️ 必须放在 `if (!editorOpen) return null;` **之前**：Hook 调用不得位于提前 return 之后，
  //    否则 editorOpen 由 true → false 时 Hook 数变化 → React 抛「Rendered fewer hooks than expected」。
  const handleDocChange = useCallback((updater: (template: DocTemplate) => DocTemplate): void => {
    useDraftStore.getState().updateDoc(updater);
  }, []);
  const handleDocBeforeChange = useCallback((): void => {
    useDraftStore.getState().snapshot();
  }, []);

  // ── 模板来源（5b）：切换来源**只改 `docSource`**，已上传的 `importedDocx` 原样保留 ──
  // ⚠️ 同样放在 `if (!editorOpen) return null;` 之前（Hook 调用不得位于提前 return 之后）。
  const handleDocSourceChange = useCallback((next: 'blocks' | 'imported'): void => {
    useDraftStore.getState().snapshot();
    useDraftStore.getState().setDocSource(next);
  }, []);
  const handleImportedDocxChange = useCallback((imported: ImportedDocx): void => {
    useDraftStore.getState().snapshot();
    useDraftStore.getState().setImportedDocx(imported);
  }, []);

  if (!editorOpen) return null;

  const layout: CardLayoutConfig | null = cardDraft;
  const density: DensityConfig | null = densityDraft;
  const theme = themeDraft;
  const groups = layout ? groupFieldPool(fields, layout) : { used: [], unused: [], unsupported: [] };

  const mode: EditorModeUi = editMode === 'doc' ? 'doc' : 'card';

  // ⭐ 「模板来源」归一：旧配置 `docSource` 缺省 → `'blocks'`（与详情侧同一处兜底 `resolveDocSource`，
  //    避免两侧对「缺省」的解释分叉）。`importedDocx` 即使是 `'blocks'` 来源也**照常传入**——
  //    这样切换来源不会丢模板（详见 DraftStore 的约束注释）。
  const docSource: 'blocks' | 'imported' = resolveDocSource({ docSource: docSourceDraft });
  const importedDocx: ImportedDocx | null = importedDocxDraft ?? null;

  const handleLayoutChange = (next: CardLayoutConfig): void => {
    useDraftStore.getState().updateCard(() => next);
  };
  const handleTemplateChange = (templateId: CardTemplateName): void => {
    useDraftStore.getState().updateCard((current) => applyCardTemplate(templateId, current));
  };
  const handleRemovePlacement = (placementId: string): void => {
    useDraftStore.getState().snapshot();
    useDraftStore.getState().updateCard((current) => removePlacement(current, placementId));
  };

  return (
    <div className="cbv-editor" role="dialog" aria-modal="true" aria-label="卡片排版编辑器" data-testid="config-drawer">
      <header className="cbv-editor__topbar">
        <span className="cbv-editor__brand">卡片排版编辑器</span>
        <div className="cbv-segmented" role="tablist" aria-label="排版模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'card'}
            className={`cbv-segmented__item${mode === 'card' ? ' cbv-segmented__item--active' : ''}`}
            onClick={() => setEditMode('card')}
          >
            卡片排版
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'doc'}
            className={`cbv-segmented__item${mode === 'doc' ? ' cbv-segmented__item--active' : ''}`}
            onClick={() => setEditMode('doc')}
          >
            文档排版
          </button>
        </div>
        <span className="cbv-toolbar__spacer" />
        {unsupportedNewer ? <span className="cbv-toolbar__count">只读模式：更高版本配置，禁止保存</span> : null}
        {dirty ? <span className="cbv-toolbar__count">未保存</span> : null}
        <button type="button" className="cbv-btn" onClick={handleUndo} disabled={!dirty}>
          撤销
        </button>
        <button type="button" className="cbv-btn" onClick={requestClose}>
          取消
        </button>
        <button
          type="button"
          className="cbv-btn cbv-btn--primary"
          onClick={() => void handleSave().catch((err: unknown) => logError('editor.save', err))}
          disabled={unsupportedNewer || !canEditConfig}
        >
          保存
        </button>
      </header>

      {mode === 'doc' ? (
        docDraft ? (
          /*
           * ⭐ 5b：「模板来源」栏（可视化排版 / 导入 docx）+ 上传 + 模板体检 —— 位于 doc 编辑区**最上方**。
           * 它是**横条**（只占垂直空间）→ 不改变画布内容宽度（`getContentBox().width` 恒等式仍成立）。
           */
          <div className="cbv-editor__doc-shell" data-doc-shell="true">
            <DocxTemplateSourceBar
              source={docSource}
              importedDocx={importedDocx}
              fields={fields}
              viewId={envViewId}
              onSourceChange={handleDocSourceChange}
              onImportedDocxChange={handleImportedDocxChange}
            />
            {/*
             * ⚠️ 关键约束：`DocLayoutEditor` 自带 dnd-kit 拖拽上下文（PointerSensor, distance 4）+ 拖拽幽灵。
             * doc 分支**绝不再包一层拖拽上下文** —— 嵌套会导致拖拽静默错乱（内层传感器捕获后外层不响应 /
             * 落点跨上下文失配），且**不会报任何错**，只是「拖不动」或「拖到错位置」。
             */}
            <DocLayoutEditor
              template={docDraft}
              fields={fields}
              onChange={handleDocChange}
              onBeforeChange={handleDocBeforeChange}
              locale="zh-CN"
            />
          </div>
        ) : (
          <div className="cbv-editor__doc-placeholder">
            <div className="cbv-state">
              <div className="cbv-state__desc">正在准备编辑器…</div>
            </div>
          </div>
        )
      ) : layout && density && theme ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="cbv-editor__body">
            <FieldPool groups={groups} onUnsupportedClick={(field) => showToast(`${field.name}：该字段类型暂不支持在卡片中呈现`)} />
            <main className="cbv-editor__center">
              <PreviewSampleCard
                layout={layout}
                fields={fields}
                theme={theme}
                locale="zh-CN"
                attributesMaxRows={selectAttributesMaxRows(density)}
              />
              <SlotLanes layout={layout} fieldsById={fieldsById} onRemovePlacement={handleRemovePlacement} />
            </main>
            <PropertyPanel
              layout={layout}
              density={density}
              theme={theme}
              highlightRules={highlightDraft}
              fields={fields}
              onLayoutChange={handleLayoutChange}
              onTemplateChange={handleTemplateChange}
              onDensityChange={(preset: DensityPresetName) =>
                useDraftStore.getState().setDensity(selectDensityWithPreset(density, preset))
              }
              onThemeChange={(next) => useDraftStore.getState().setTheme(next)}
              onHighlightChange={(rules) => useDraftStore.getState().setHighlightRules(rules)}
            />
          </div>
          <DragOverlay dropAnimation={null}>
            {activeDrag ? (
              <div className="cbv-drag-ghost" data-kind={activeDrag.kind}>
                {activeDrag.label}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="cbv-editor__doc-placeholder">
          <div className="cbv-state">
            <div className="cbv-state__desc">正在准备编辑器…</div>
          </div>
        </div>
      )}

      {confirmOpen ? (
        <div className="cbv-confirm" role="alertdialog" aria-modal="true" aria-label="放弃未保存的修改">
          <div className="cbv-confirm__box">
            <div className="cbv-state__title">放弃未保存的修改？</div>
            <div className="cbv-state__desc">你有尚未保存的排版改动，关闭后将丢失这些修改。</div>
            <div className="cbv-confirm__actions">
              <button type="button" className="cbv-btn" onClick={() => setConfirmOpen(false)}>
                继续编辑
              </button>
              <button type="button" className="cbv-btn cbv-btn--danger" onClick={finalizeClose}>
                放弃并关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 设计文档 §10 的组件名（`ConfigDrawer` 为历史名，二者指向同一实现）。 */
export const ConfigEditor = ConfigDrawer;
