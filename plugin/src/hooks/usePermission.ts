/**
 * 配置编辑权限（PRD P0-08 / US-4 AC3）。
 *
 * 仅具备表格/视图编辑权限的用户可进入配置态；无权限用户配置入口不可见。
 * 判定逻辑集中在 `sdk/base.canEditTable()`（能力探测 + 保守默认），本 hook 只做状态桥接。
 */
import { useEffect, useState } from 'react';
import { canEditTable } from '@/sdk/base';
import { useViewStore } from '@/state/ViewStore';
import { logError } from '@/utils/log';

export interface PermissionState {
  canEditConfig: boolean;
  loading: boolean;
  reason: string | null;
}

export function usePermission(): PermissionState {
  const canEditConfig = useViewStore((state) => state.canEditConfig);
  const setCanEditConfig = useViewStore((state) => state.setCanEditConfig);
  const tableId = useViewStore((state) => state.env?.tableId);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const canEdit = await canEditTable(tableId);
        if (cancelled) return;
        setCanEditConfig(canEdit);
        setReason(canEdit ? '具备表格编辑权限，可进入配置态' : '仅查看权限，配置入口已隐藏');
      } catch (err) {
        logError('hooks.usePermission', err);
        if (!cancelled) setReason('权限探测失败，按只读处理');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setCanEditConfig, tableId]);

  return { canEditConfig, loading, reason };
}
