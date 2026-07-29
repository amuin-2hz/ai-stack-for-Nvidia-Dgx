<!--
  @author Amuin
  @created 2026-06-25
  @description 应用工具栏：侧边栏折叠按钮、主题切换、语言切换、下载面板与布局切换。
               App toolbar: sidebar collapse toggle, theme/language switches, downloads panel, and layout toggle.
-->
<script setup lang="ts">
import { computed, h, ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import { CloseOutlined, DeleteOutlined, DownloadOutlined, FolderOpenOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons-vue';
import type { TaskRecord } from '../../types';
import {
  locale, themeMode, view, sidebarCollapsed, rightPanelCollapsed,
  visibleTasks, selectedTaskId, loadTaskLog, taskAlias, taskProgress, taskSummary,
  statusText, formatBytes, api, refresh, t,
  setTheme, setLocale
} from '../../composables/useApp';

const isDark = computed(() => themeMode.value === 'dark');
const downloadsOpen = ref(false);
const downloadFilter = ref('');
const activeDownloadStatuses = new Set(['queued', 'running', 'paused', 'canceling']);
const finishedDownloadStatuses = new Set(['succeeded', 'failed', 'canceled']);
const recordClearDownloadStatuses = new Set(['succeeded', 'failed']);

const allDownloadTasks = computed(() =>
  visibleTasks.value.filter((task) => task.type === 'download')
);

const sortedDownloadTasks = computed(() => allDownloadTasks.value.slice().sort((a, b) => {
  const activeDelta = Number(activeDownloadStatuses.has(b.status)) - Number(activeDownloadStatuses.has(a.status));
  if (activeDelta !== 0) return activeDelta;
  return 0;
}));

const activeDownloadCount = computed(() =>
  allDownloadTasks.value.filter((task) => activeDownloadStatuses.has(task.status)).length
);

const filteredDownloadTasks = computed(() => {
  const term = downloadFilter.value.trim().toLowerCase();
  const matched = term
    ? sortedDownloadTasks.value.filter((task) => [task.id, taskAlias(task), statusText(task.status), taskSummary(task)]
      .join(' ')
      .toLowerCase()
      .includes(term))
    : sortedDownloadTasks.value;
  return matched.slice(0, 16);
});

const clearableDownloadTasks = computed(() =>
  allDownloadTasks.value.filter((task) => recordClearDownloadStatuses.has(task.status))
);

function toggleDownloads() {
  downloadsOpen.value = !downloadsOpen.value;
}

function openTask(task: TaskRecord) {
  selectedTaskId.value = task.id;
  view.value = 'tasks';
  downloadsOpen.value = false;
  void loadTaskLog(task.id);
}

function downloadMeta(task: TaskRecord) {
  const active = activeDownloadStatuses.has(task.status);
  const issue = active ? downloadIssueText(task) : '';
  if (issue) {
    const retry = task.download_retry_attempt && task.download_retry_total
      ? ' · ' + task.download_retry_attempt + '/' + task.download_retry_total
      : '';
    return downloadStatusText(task.status) + ' · ' + issue + retry;
  }
  const itemProgress = task.download_items_done && task.download_items_total
    ? task.download_items_done + '/' + task.download_items_total
    : '';
  const progressLabel = itemProgress
    ? (task.total_bytes ? taskProgress(task) + '% ' + itemProgress : itemProgress)
    : taskProgress(task) + '%';
  const showProgress = active || (['failed', 'canceled'].includes(task.status) && Boolean(task.downloaded_bytes || task.total_bytes || itemProgress));
  const progress = showProgress ? ' · ' + t('downloadOverall') + ' ' + progressLabel : '';
  const downloaded = task.downloaded_bytes ? formatBytes(task.downloaded_bytes) : '0 B';
  const total = task.total_bytes ? formatBytes(task.total_bytes) : '';
  const estimated = task.total_bytes_estimated ? t('downloadEstimated') : '';
  const size = task.downloaded_bytes || task.total_bytes ? ' · ' + (total ? downloaded + ' / ' + total + estimated : t('downloaded') + ' ' + downloaded) : '';
  const eta = task.download_eta ? ' · ' + t('downloadEta') + ' ' + task.download_eta : '';
  return downloadStatusText(task.status) + progress + size + eta;
}

function downloadTitleMeta(task: TaskRecord) {
  if (task.status !== 'running' && task.status !== 'canceling') return '';
  return downloadSpeedText(task);
}

function downloadTitleLine(task: TaskRecord) {
  const speed = downloadTitleMeta(task);
  return speed ? taskAlias(task) + '  ' + speed : taskAlias(task);
}

function downloadIssueText(task: TaskRecord) {
  if (task.download_error_code === 'proxy_unreachable') return t('downloadProxyError');
  if (task.download_error_code === 'network_unreachable') return t('downloadNetworkError');
  if (task.download_error_code === 'download_failed') return t('downloadAttemptFailed');
  return '';
}

function downloadStatusText(status: string) {
  if (status === 'succeeded') return t('downloadStatusSuccess');
  if (status === 'failed' || status === 'canceled') return t('downloadStatusFailed');
  if (status === 'paused') return t('downloadStatusPaused');
  return t('downloadStatusRunning');
}

function downloadSpeedText(task: TaskRecord) {
  const speed = Number(task.download_log_speed_bytes_per_sec ?? task.download_speed_bytes_per_sec ?? 0);
  if (!Number.isFinite(speed) || speed <= 0) return t('downloadSpeedMeasuring');
  return formatBytes(speed) + '/s';
}

function downloadActiveFileText(task: TaskRecord) {
  if (!task.download_active_file) return '';
  const name = String(task.download_active_file).split('/').pop() || task.download_active_file;
  const parts = [t('downloadCurrentFile') + ' ' + name];
  if (typeof task.download_active_file_percent === 'number') parts.push(task.download_active_file_percent + '%');
  if (typeof task.download_active_file_bytes === 'number' && task.download_active_file_bytes > 0) {
    const total = typeof task.download_active_file_total_bytes === 'number' && task.download_active_file_total_bytes > 0
      ? ' / ' + formatBytes(task.download_active_file_total_bytes)
      : '';
    parts.push(formatBytes(task.download_active_file_bytes) + total);
  }
  return ' · ' + parts.join(' ');
}

function taskModelId(task: TaskRecord) {
  return String(task.metadata?.alias ?? task.metadata?.model_id ?? '').trim();
}

function canContinueDownload(task: TaskRecord) {
  return ['failed', 'canceled'].includes(task.status)
    && Boolean(task.metadata?.provider && task.metadata?.repo_id && task.metadata?.alias);
}

async function controlDownloadTask(task: TaskRecord, action: 'pause' | 'resume' | 'cancel') {
  try {
    const payload = await api<{ ok: boolean; detail?: string }>(
      '/tasks/' + encodeURIComponent(task.id) + '/' + action,
      { method: 'POST' }
    );
    if (payload.ok === false) message.warning(payload.detail || t('taskControlFailed'));
    else message.success(payload.detail || t('actionSucceeded'));
    selectedTaskId.value = task.id;
    await refresh();
    await loadTaskLog(task.id);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function taskCleanupInfo(task: TaskRecord) {
  const target = String(task.metadata?.target_path ?? task.target_path ?? '-');
  const provider = String(task.metadata?.provider ?? '-');
  const repo = String(task.metadata?.repo_id ?? '-');
  const size = task.downloaded_bytes ? formatBytes(task.downloaded_bytes) : '-';
  return { target, provider, repo, size };
}

async function openDownloadFolder(task: TaskRecord) {
  const modelId = taskModelId(task);
  if (!modelId) {
    message.warning(t('noModelFolderAvailable'));
    return;
  }
  try {
    await api('/models/' + encodeURIComponent(modelId) + '/open-folder', { method: 'POST' });
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

async function deleteDownloadRecord(task: TaskRecord, deleteFiles = false) {
  return api<{ ok: boolean; deleted_target_path?: string }>('/tasks/' + encodeURIComponent(task.id), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete_files: deleteFiles })
  });
}

async function clearDownloadRecord(task: TaskRecord, deleteFiles = false) {
  if (activeDownloadStatuses.has(task.status)) {
    message.warning(t('cancelActiveDownloadsBeforeClearing'));
    return;
  }
  try {
    const payload = await deleteDownloadRecord(task, deleteFiles);
    if (payload.deleted_target_path) {
      message.success(t('downloadRecordAndFilesDeleted'));
    } else if (payload.ok) {
      message.success(t('downloadRecordCleared'));
    }
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function promptClearDownload(task: TaskRecord) {
  if (activeDownloadStatuses.has(task.status)) {
    message.warning(t('cancelActiveDownloadsBeforeClearing'));
    return;
  }
  const info = taskCleanupInfo(task);
  Modal.confirm({
    title: t('deleteDownloadTaskTitle'),
    content: h('div', { class: 'download-clear-confirm' }, [
      h('p', t('deleteDownloadTaskDesc')),
      h('dl', [
        h('div', [h('dt', t('modelName')), h('dd', taskAlias(task))]),
        h('div', [h('dt', t('source')), h('dd', info.provider + ' · ' + info.repo)]),
        h('div', [h('dt', t('status')), h('dd', statusText(task.status))]),
        h('div', [h('dt', t('downloaded')), h('dd', info.size)]),
        h('div', [h('dt', t('path')), h('dd', info.target)])
      ]),
      h('small', t('deleteDownloadTaskHint'))
    ]),
    okText: t('deleteDownloadTaskOk'),
    cancelText: t('cancelTask'),
    okType: 'danger',
    async onOk() {
      await clearDownloadRecord(task, true);
    }
  });
}

async function clearFinishedDownloads() {
  const targets = clearableDownloadTasks.value.slice();
  if (!targets.length) return;
  const results = await Promise.allSettled(targets.map((task) => deleteDownloadRecord(task, false)));
  const succeeded = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - succeeded;
  await refresh();
  if (failed) {
    message.warning(locale.value === 'zh-CN'
      ? '已清除 ' + succeeded + ' 条下载记录，' + failed + ' 条清除失败'
      : 'Cleared ' + succeeded + ' download records; ' + failed + ' failed');
  } else {
    message.success(locale.value === 'zh-CN'
      ? '已清除 ' + succeeded + ' 条下载记录'
      : 'Cleared ' + succeeded + ' download records');
  }
}

async function continueDownload(task: TaskRecord) {
  if (!canContinueDownload(task)) return;
  try {
    const payload = await api<any>('/tasks/' + encodeURIComponent(task.id) + '/retry', { method: 'POST' });
    message.success(t('downloadContinued') + (payload.task?.id ? ': ' + payload.task.id : ''));
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** 切换主题：checked → dark, unchecked → light */
function toggleTheme(checked: boolean | string | number) {
  setTheme(checked ? 'dark' : 'light');
}

/** 切换语言：checked → en-US, unchecked → zh-CN */
function toggleLocale(checked: boolean | string | number) {
  setLocale(checked ? 'en-US' : 'zh-CN');
}
</script>

<template>
  <section class="shell-toolbar">
    <div class="shell-toolbar-left">
      <button
        :class="['shell-sidebar-dock', sidebarCollapsed ? 'is-collapsed' : '']"
        type="button"
        :aria-label="t('sidebar')"
        @click="sidebarCollapsed = !sidebarCollapsed"
      />
    </div>
    <div class="shell-toolbar-center"></div>
    <div class="shell-toolbar-right">
      <button
        :class="['toolbarSwitchButton', isDark ? 'isChecked' : '']"
        type="button"
        :aria-pressed="isDark"
        @click="toggleTheme(isDark ? 0 : 1)"
      >
        <span class="switchLabel">{{ isDark ? t('themeDark') : t('themeLight') }}</span>
        <span class="switchTrack"><span class="switchThumb"></span></span>
      </button>
      <button
        :class="['toolbarSwitchButton', locale === 'en-US' ? 'isChecked' : '']"
        type="button"
        :aria-pressed="locale === 'en-US'"
        @click="toggleLocale(locale === 'en-US' ? 0 : 1)"
      >
        <span class="switchLabel">{{ locale === 'en-US' ? 'EN' : '中' }}</span>
        <span class="switchTrack"><span class="switchThumb"></span></span>
      </button>
      <button
        :class="['toolbarIconButton', activeDownloadCount ? 'hasBadge' : '', downloadsOpen ? 'isActive' : '']"
        type="button"
        :aria-label="t('downloadsPanelTitle')"
        :aria-expanded="downloadsOpen"
        :title="t('downloadsPanelTitle')"
        @click="toggleDownloads"
      >
        <DownloadOutlined class="toolbarSvgIcon" />
        <span v-if="activeDownloadCount" class="toolbarBadge">{{ activeDownloadCount }}</span>
      </button>
      <button
        :class="['toolbarIconButton', rightPanelCollapsed ? '' : 'isActive']"
        type="button"
        :aria-label="t('rightPanel')"
        @click="rightPanelCollapsed = !rightPanelCollapsed"
      >
        <span class="toolbarIcon">{{ rightPanelCollapsed ? '◨' : '◧' }}</span>
      </button>
    </div>

    <div v-if="downloadsOpen" class="shell-downloads-scrim" @click="downloadsOpen = false"></div>
    <section v-if="downloadsOpen" class="shell-downloads-panel" @click.stop>
      <header class="shell-downloads-head">
        <strong>{{ t('downloadsPanelTitle') }}</strong>
        <div class="shell-downloads-head-actions">
          <button class="shell-download-action" type="button" :aria-label="t('closeDownloadsPanel')" @click="downloadsOpen = false">
            <CloseOutlined />
          </button>
        </div>
      </header>

      <label class="shell-downloads-search">
        <input v-model="downloadFilter" type="text" :placeholder="t('filterDownloads')" />
      </label>

      <div class="shell-downloads-section-head">
        <span>{{ t('downloadRecords') }}</span>
        <button type="button" :disabled="!clearableDownloadTasks.length" @click="clearFinishedDownloads">
          {{ t('clearDownloadRecords') }}
        </button>
      </div>

      <div class="shell-downloads-list">
        <article v-for="task in filteredDownloadTasks" :key="task.id" :class="['shell-download-row', task.status === 'failed' ? 'isFailed' : '']">
          <span class="shell-download-glyph"><DownloadOutlined /></span>
          <button class="shell-download-row-main" type="button" :title="[downloadTitleLine(task), downloadMeta(task)].filter(Boolean).join(' · ')" @click="openTask(task)">
            <b class="shell-download-title-line">{{ downloadTitleLine(task) }}</b>
            <small class="shell-download-meta" :title="downloadMeta(task)">{{ downloadMeta(task) }}</small>
          </button>
          <div class="shell-download-row-actions">
            <button v-if="task.status === 'running'" class="shell-download-action" type="button" :aria-label="t('pauseTask')" @click="controlDownloadTask(task, 'pause')">
              <PauseCircleOutlined />
            </button>
            <button v-if="task.status === 'paused'" class="shell-download-action" type="button" :aria-label="t('resumeTask')" @click="controlDownloadTask(task, 'resume')">
              <PlayCircleOutlined />
            </button>
            <button v-if="['queued','running','paused'].includes(task.status)" class="shell-download-action" type="button" :aria-label="t('cancelTask')" @click="controlDownloadTask(task, 'cancel')">
              <DeleteOutlined />
            </button>
            <button v-if="canContinueDownload(task)" class="shell-download-action" type="button" :aria-label="t('continueDownload')" :title="t('continueDownload')" @click="continueDownload(task)">
              <PlayCircleOutlined />
            </button>
            <button class="shell-download-action" type="button" :aria-label="t('openFolder')" @click="openDownloadFolder(task)">
              <FolderOpenOutlined />
            </button>
            <button v-if="finishedDownloadStatuses.has(task.status)" class="shell-download-action" type="button" :aria-label="t('clear')" @click="promptClearDownload(task)">
              <DeleteOutlined />
            </button>
          </div>
        </article>
        <div v-if="!filteredDownloadTasks.length" class="shell-downloads-empty">
          {{ t('noDownloads') }}
        </div>
      </div>
    </section>
  </section>
</template>
