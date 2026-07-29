<!--
  @author Amuin
  @created 2026-06-25
  @description 任务管理页面：任务统计、任务列表（含控制按钮/诊断）、详情日志与部署跳转。
               Tasks page: stats, task list with controls and diagnostics, detail log, and deploy navigation.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  ClearOutlined, CloudServerOutlined, CopyOutlined, DeleteOutlined, EyeOutlined,
  PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SettingOutlined, SyncOutlined, ToolOutlined
} from '@ant-design/icons-vue';
import type { TaskRecord } from '../types';
import {
  locale, t, selectedTaskId, selectedTask,
  loadTaskLog,
  statusText, badgeColor, taskProgress, taskSummary, taskDisplayTitle, taskCreatedAtText,
  taskEventLog, displayTaskLog, taskRuntimePlanStages, taskRuntimePlanStageStatus, taskRuntimePlanStageColor,
  visibleTasks, activeTasks, rightPanelCollapsed,
  modelEndpoint, copyText,
} from '../composables/useApp';
import {
  controlDownloadTask, retryDownloadTask, repairTask, deploymentForTask, openTaskDeployment,
} from '../composables/useTasks';
import StatCard from '../components/shared/StatCard.vue';
import HeroBanner from '../components/shared/HeroBanner.vue';

function repairActionIcon(action: string) {
  if (action === 'view_logs') return EyeOutlined;
  if (action === 'restart_runtime') return SyncOutlined;
  if (action === 'redownload_model' || action === 'check_network') return ReloadOutlined;
  if (action === 'change_port' || action === 'change_image' || action === 'reset_runtime_params') return SettingOutlined;
  if (action === 'inspect_model_files' || action === 'clear_cache') return ClearOutlined;
  return ToolOutlined;
}

const selectedTaskLogText = computed(() => {
  if (!selectedTask.value) return t('noTaskSelected');
  return displayTaskLog() || taskEventLog(selectedTask.value);
});

onMounted(() => {
  rightPanelCollapsed.value = true;
});

type TaskListTab = 'active' | 'history';

const activeTaskStatuses = new Set(['queued', 'running', 'paused', 'canceling']);
const taskListTab = ref<TaskListTab>('active');

const ongoingTasks = computed(() => visibleTasks.value.filter((task: TaskRecord) => activeTaskStatuses.has(task.status)));
const historyTasks = computed(() => visibleTasks.value.filter((task: TaskRecord) => !activeTaskStatuses.has(task.status)));
const activeTaskTabLabel = computed(() => t('taskActive') + ' ' + ongoingTasks.value.length);
const historyTaskTabLabel = computed(() => t('taskHistory') + ' ' + historyTasks.value.length);
const currentTaskList = computed(() => taskListTab.value === 'active' ? ongoingTasks.value : historyTasks.value);
const currentTaskEmptyText = computed(() => taskListTab.value === 'active' ? t('noActiveTasks') : t('noHistoryTasks'));

function taskBelongsToTab(task: TaskRecord, tab: TaskListTab) {
  return tab === 'active' ? activeTaskStatuses.has(task.status) : !activeTaskStatuses.has(task.status);
}

function selectTaskFromTab(tab: TaskListTab) {
  const list = tab === 'active' ? ongoingTasks.value : historyTasks.value;
  if (!list.length || list.some((task) => task.id === selectedTaskId.value)) return;
  selectedTaskId.value = list[0].id;
  void loadTaskLog(list[0].id);
}

function changeTaskTab(key: string | number) {
  if (key !== 'active' && key !== 'history') return;
  taskListTab.value = key;
  selectTaskFromTab(key);
}

watch([selectedTask, ongoingTasks, historyTasks], ([task]) => {
  if (task) {
    const nextTab: TaskListTab = taskBelongsToTab(task, 'active') ? 'active' : 'history';
    if (taskListTab.value !== nextTab) taskListTab.value = nextTab;
    return;
  }
  if (!ongoingTasks.value.length && historyTasks.value.length) taskListTab.value = 'history';
}, { immediate: true });
</script>

<template>
  <section :class="['prototype-page', 'tasks-layout', 'task-grid', rightPanelCollapsed ? 'right-panel-collapsed' : 'right-panel-expanded']">
    <HeroBanner
      class="taskBanner"
      :title="t('tasks')"
      :eyebrow="t('studioName')"
      :desc="locale === 'zh-CN' ? '跟踪下载、部署、容器操作任务，并查看实时日志。' : 'Track download, deployment, and container tasks with real-time logs.'"
    />

    <!-- 任务统计 -->
    <div class="task-overview">
      <StatCard :label="locale === 'zh-CN' ? '进行中' : 'Active'" :value="activeTasks.length" />
      <StatCard :label="locale === 'zh-CN' ? '失败' : 'Failed'" :value="visibleTasks.filter((t: TaskRecord) => t.status === 'failed').length" />
      <StatCard :label="t('taskDownload')" :value="visibleTasks.filter((t: TaskRecord) => t.type === 'download').length" />
      <StatCard :label="t('taskDeploy')" :value="visibleTasks.filter((t: TaskRecord) => t.type === 'deploy').length" />
    </div>

    <!-- 任务列表 -->
    <a-card :title="t('taskMonitor')" class="glass-card taskMonitorPanel" size="small" :bordered="false">
      <a-tabs class="task-panel-tabs" size="small" :active-key="taskListTab" :animated="false" @change="changeTaskTab">
        <a-tab-pane key="active" :tab="activeTaskTabLabel" />
        <a-tab-pane key="history" :tab="historyTaskTabLabel" />
      </a-tabs>
      <a-list :data-source="currentTaskList" class="task-list" :locale="{ emptyText: currentTaskEmptyText }">
        <template #renderItem="{ item: task }">
          <a-list-item
            :class="[selectedTaskId === task.id ? 'selected-row' : '', task.status === 'failed' ? 'task-failed-row' : '']"
            @click="selectedTaskId = task.id; loadTaskLog(task.id)"
          >
            <a-list-item-meta :description="taskSummary(task)">
              <template #title>
                <div class="task-title-line">
                  <strong>{{ taskDisplayTitle(task) }}</strong>
                  <time :datetime="task.created_at">{{ taskCreatedAtText(task) }}</time>
                </div>
              </template>
              <template v-if="taskRuntimePlanStages(task).length" #description>
                <div class="task-description">
                  <span>{{ taskSummary(task) }}</span>
                  <a-space size="small" wrap class="task-plan-stages">
                    <a-tooltip v-for="stage in taskRuntimePlanStages(task)" :key="stage.id" :title="stage.detail + (stage.target ? ' · ' + stage.target : '')">
                      <a-tag :color="taskRuntimePlanStageColor(task, stage.id)">{{ stage.label }} · {{ statusText(taskRuntimePlanStageStatus(task, stage.id)) }}</a-tag>
                    </a-tooltip>
                  </a-space>
                </div>
              </template>
            </a-list-item-meta>
            <a-progress v-if="!['failed','canceled'].includes(task.status)" class="task-progress" :percent="taskProgress(task)" :show-info="false" />
            <a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag>

            <!-- 下载任务控制按钮 -->
            <a-space v-if="task.type === 'download'" class="task-control-buttons task-page-controls" @click.stop>
              <a-tooltip v-if="task.status === 'running'" :title="t('pauseTask')"><a-button size="small" @click="controlDownloadTask(task, 'pause')"><template #icon><PauseCircleOutlined /></template></a-button></a-tooltip>
              <a-tooltip v-if="task.status === 'paused'" :title="t('resumeTask')"><a-button size="small" type="primary" @click="controlDownloadTask(task, 'resume')"><template #icon><PlayCircleOutlined /></template></a-button></a-tooltip>
              <a-tooltip v-if="['queued','running','paused'].includes(task.status)" :title="t('cancelTask')"><a-button size="small" danger @click="controlDownloadTask(task, 'cancel')"><template #icon><DeleteOutlined /></template></a-button></a-tooltip>
              <a-tooltip v-if="['failed','canceled'].includes(task.status)" :title="t('continueDownload')"><a-button size="small" type="primary" @click="retryDownloadTask(task)"><template #icon><ReloadOutlined /></template></a-button></a-tooltip>
            </a-space>

            <!-- 修复操作按钮 -->
            <a-space v-if="task.diagnostic?.repair_actions?.length" class="task-control-buttons task-page-controls" @click.stop>
              <a-tooltip v-for="action in task.diagnostic.repair_actions.slice(0, 2)" :key="action.action" :title="action.label">
                <a-button size="small" class="task-action-icon-button" @click="repairTask(task, action.action)">
                  <template #icon><component :is="repairActionIcon(action.action)" /></template>
                </a-button>
              </a-tooltip>
            </a-space>
          </a-list-item>
        </template>
      </a-list>
    </a-card>

    <!-- 任务详情 & 日志 -->
    <a-card v-show="!rightPanelCollapsed" :title="t('taskLogs')" class="glass-card task-detail-card taskLogPanel" size="small" :bordered="false">
      <template #extra>
        <a-tooltip :title="t('refresh')">
          <a-button size="small" :disabled="!selectedTaskId" @click="loadTaskLog()"><template #icon><ReloadOutlined /></template></a-button>
        </a-tooltip>
      </template>

      <!-- 部署跳转 -->
      <div v-if="selectedTask && deploymentForTask(selectedTask)" class="task-next-step-panel">
        <div>
          <b>{{ locale === 'zh-CN' ? '部署已可验证' : 'Deployment Ready To Validate' }}</b>
          <span>{{ deploymentForTask(selectedTask)?.openai_models.join(', ') || deploymentForTask(selectedTask)?.model_id || deploymentForTask(selectedTask)?.runtime }}</span>
        </div>
        <a-space wrap>
          <a-button size="small" @click="openTaskDeployment(selectedTask, 'running')"><template #icon><CloudServerOutlined /></template>{{ t('running') }}</a-button>
          <a-button size="small" type="primary" @click="openTaskDeployment(selectedTask, 'playground')"><template #icon><PlayCircleOutlined /></template>{{ t('playground') }}</a-button>
          <a-button size="small" @click="copyText(modelEndpoint(deploymentForTask(selectedTask)!))"><template #icon><CopyOutlined /></template>{{ t('modelListEndpoint') }}</a-button>
        </a-space>
      </div>

      <!-- 失败诊断 -->
      <div v-if="selectedTask?.diagnostic" class="task-diagnostic-panel">
        <div class="task-diagnostic-head">
          <b>{{ locale === 'zh-CN' ? '失败诊断' : 'Failure Diagnosis' }}</b>
          <a-space wrap>
            <a-tag color="red">{{ selectedTask.diagnostic.severity }}</a-tag>
            <a-tag>{{ selectedTask.diagnostic.category }}</a-tag>
            <a-tag v-if="selectedTask.diagnostic.stage" color="gold">{{ selectedTask.diagnostic.stage }}</a-tag>
          </a-space>
        </div>
        <p>{{ selectedTask.diagnostic.message }}</p>
        <a-space v-if="selectedTask.diagnostic.repair_actions?.length" wrap class="task-diagnostic-actions">
          <a-tooltip v-for="action in selectedTask.diagnostic.repair_actions" :key="action.action" :title="action.label">
            <a-button size="small" class="task-action-icon-button" :type="action.action === 'view_logs' ? 'default' : 'primary'" @click="repairTask(selectedTask, action.action)">
              <template #icon><component :is="repairActionIcon(action.action)" /></template>
            </a-button>
          </a-tooltip>
        </a-space>
      </div>

      <pre class="message-block log-block task-log-tail">{{ selectedTaskLogText }}</pre>
    </a-card>
  </section>
</template>
