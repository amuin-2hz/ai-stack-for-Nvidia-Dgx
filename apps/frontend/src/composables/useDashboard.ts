/**
 * @author Amuin
 * @created 2026-06-25
 * @description 仪表盘（Dashboard）页面本地状态与计算属性。
 *              Dashboard page-local reactive state and computed properties.
 */
import { computed } from 'vue';
import {
  locale, t, system, dashboardTasks, taskAlias, taskSummary,
  readyModels, servingModelCount
} from './useApp';

/**
 * 管理控制台地址，优先使用系统返回的管理 URL。
 * Management console address, prefers system-reported management URL.
 */
export const dashboardConsoleAddress = computed(() =>
  system.value?.management_url || 'http://localhost:8888'
);

/**
 * Docker 状态标签颜色。
 * Docker status indicator color.
 */
export const dashboardDockerColor = computed(() => {
  if (!system.value?.docker) return 'gold';
  if (system.value.docker.ok) return 'green';
  return system.value.docker.detail ? 'red' : 'gold';
});

/**
 * Docker 状态标签文本（i18n-aware）。
 * Docker status label text.
 */
export const dashboardDockerLabel = computed(() => {
  if (!system.value?.docker) return t('dockerCheck');
  if (system.value.docker.ok) return t('dockerReady');
  return system.value.docker.detail
    ? (locale.value === 'zh-CN' ? 'Docker 异常' : 'Docker Error')
    : t('dockerCheck');
});

/**
 * 仪表盘最近任务列表（最多 8 条）。
 * Dashboard recent task list (max 8 items).
 */
export const dashboardRecentTasks = computed(() => {
  return dashboardTasks.value.slice(0, 8).map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    title: taskAlias(item),
    summary: taskSummary(item)
  }));
});

/**
 * 首页推荐操作提示（根据当前模型与服务状态动态生成）。
 * Home page recommendation hint based on current model and service state.
 */
export const homeRecommendation = computed(() => {
  if (!readyModels.value)
    return locale.value === 'zh-CN'
      ? '先导入或下载一个模型。'
      : 'Import or download a model first.';
  if (!servingModelCount.value)
    return locale.value === 'zh-CN'
      ? '选择一个就绪模型并发布为 API。'
      : 'Choose a ready model and publish it as an API.';
  return locale.value === 'zh-CN'
    ? '已有模型在运行，进入 Playground 验证效果。'
    : 'A model is running. Open Playground to validate it.';
});
