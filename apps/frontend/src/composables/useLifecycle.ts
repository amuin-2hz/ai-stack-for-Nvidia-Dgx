/**
 * @author Amuin
 * @created 2026-06-25
 * @description 应用生命周期管理：定时轮询刷新与侧边栏响应式折叠。
 *              App lifecycle: polling refresh timer & sidebar responsive collapse.
 */
import { onBeforeUnmount, onMounted } from 'vue';
import {
  view, refresh, selectedTaskId, loadTaskLog, logCollapsed,
  selectedLogContainer, selectedContainer, loadContainerLogs, actionTargetName,
  sidebarCollapsed
} from './useApp';

/** 侧边栏媒体查询（窗口 ≤1320px 时自动折叠） */
let compactSidebarQuery: MediaQueryList | null = null;

/** 轮询定时器 ID */
let refreshTimer: number | null = null;
let lastForegroundRefresh = 0;
let refreshesInFlight = 0;

/**
 * 根据媒体查询结果同步侧边栏折叠状态。
 * Sync sidebar collapsed state from media query.
 */
function syncSidebarMode(event?: MediaQueryListEvent) {
  sidebarCollapsed.value = event ? event.matches : !!compactSidebarQuery?.matches;
}

function refreshVisibleState(force = false) {
  if (refreshesInFlight === 0 || force) {
    refreshesInFlight += 1;
    void refresh().finally(() => { refreshesInFlight = Math.max(0, refreshesInFlight - 1); });
  }
  if (view.value === 'tasks' && selectedTaskId.value) void loadTaskLog();
  if ((view.value === 'deploy' || view.value === 'load' || view.value === 'services') && !logCollapsed.value) {
    const logName = selectedLogContainer.value || (selectedContainer.value && selectedContainer.value.state !== 'missing' ? actionTargetName(selectedContainer.value) : '');
    if (logName) void loadContainerLogs(logName);
  }
}

function refreshAfterForeground() {
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - lastForegroundRefresh < 750) return;
  lastForegroundRefresh = now;
  refreshVisibleState(true);
}

/**
 * 挂载生命周期：启动 5 秒轮询并监听窗口尺寸变化。
 * Mount lifecycle: start 5s polling and watch window resize.
 */
export function useLifecycle() {
  onMounted(() => {
    compactSidebarQuery = window.matchMedia('(max-width: 1320px)');
    syncSidebarMode();
    compactSidebarQuery.addEventListener('change', syncSidebarMode);

    lastForegroundRefresh = Date.now();
    refreshVisibleState();
    document.addEventListener('visibilitychange', refreshAfterForeground);
    window.addEventListener('focus', refreshAfterForeground);
    window.addEventListener('pageshow', refreshAfterForeground);
    window.addEventListener('online', refreshAfterForeground);
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshVisibleState();
    }, 5000);
  });

  onBeforeUnmount(() => {
    compactSidebarQuery?.removeEventListener('change', syncSidebarMode);
    document.removeEventListener('visibilitychange', refreshAfterForeground);
    window.removeEventListener('focus', refreshAfterForeground);
    window.removeEventListener('pageshow', refreshAfterForeground);
    window.removeEventListener('online', refreshAfterForeground);
    if (refreshTimer !== null) window.clearInterval(refreshTimer);
  });
}
