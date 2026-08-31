<!--
  @author Amuin
  @created 2026-06-25
  @description 模型下载弹窗：URL 输入、链接解析、下载确认与下载任务列表。
               Model download modal: URL input, link parsing, download confirmation, and task list.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { ReloadOutlined } from '@ant-design/icons-vue';
import { message } from 'ant-design-vue';
import {
  t, api, refresh, modelUrl, importMessage, importPreview,
  selectedTaskId, selectedDownloadLogId, loadTaskLog, view,
  runtimeHintColor, statusText,
  taskAlias, taskSummary, badgeColor, visibleTasks
} from '../../composables/useApp';
import { retryDownloadTask } from '../../composables/useTasks';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const downloadSubmitting = ref(false);
const defaultRuntimeIds = new Set(['vllm', 'trtllm', 'pytorch']);

/** 双向绑定兼容：使用 computed get/set 包装 prop */
const localOpen = computed({
  get: () => props.open,
  set: (val) => { if (!val) emit('close'); }
});

// ── 推断下载运行时与格式 ─────────────────────────────────────────────────

const inferredDownloadRuntime = computed(() => {
  const text = [
    modelUrl.value,
    importPreview.value?.model?.repo_id,
    importPreview.value?.model?.target_path,
    importPreview.value?.download?.command
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('.engine') || text.includes('tensorrt') || text.includes('trtllm')) return 'trtllm';
  if (['asr', 'tts', 'whisper', 'cosyvoice', 'funasr', 'fun-asr', 'qwen3-asr', 'qwen3-tts', 'speech', 'speaker', 'campplus', 'sv']
    .some((token) => text.includes(token))) return 'pytorch';
  return 'vllm';
});

const inferredDownloadLabel = computed(() => {
  if (inferredDownloadRuntime.value === 'trtllm') return '.engine';
  if (inferredDownloadRuntime.value === 'pytorch') return 'PyTorch';
  return '.safetensors / .bin';
});

const defaultRuntimeHints = computed(() =>
  (importPreview.value?.runtime_hints ?? []).filter((hint) => defaultRuntimeIds.has(String(hint.runtime)))
);

const importPreviewSummary = computed(() => {
  const model = importPreview.value?.model;
  if (!model) return '';
  return [
    t('provider') + ': ' + (model.provider ?? '-'),
    t('repo') + ': ' + (model.repo_id ?? '-'),
    t('target') + ': ' + (model.target_path ?? '-')
  ].join(' · ');
});

const recentDownloadTasks = computed(() =>
  visibleTasks.value.filter((task) => task.type === 'download').slice(0, 6)
);

// ── 操作函数 ─────────────────────────────────────────────────────────────

/** 通过 URL 解析模型导入计划 */
async function importPlan() {
  if (!modelUrl.value.trim()) return;
  importMessage.value = t('parsing');
  importPreview.value = null;
  try {
    const payload = await api<import('../../types').ImportPreview>('/models/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: modelUrl.value.trim(),
        provider: 'auto',
        expected_runtime: inferredDownloadRuntime.value
      })
    });
    importPreview.value = payload;
    importMessage.value = payload.message ?? '';
  } catch (error) {
    importMessage.value = String(error);
  }
}

/** 启动模型下载 */
async function startDownload(): Promise<boolean> {
  if (!modelUrl.value.trim() || downloadSubmitting.value) return false;
  downloadSubmitting.value = true;
  importMessage.value = t('startingDownload');
  try {
    const payload = await api<any>('/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: modelUrl.value.trim(),
        provider: 'auto',
        expected_runtime: inferredDownloadRuntime.value
      })
    });
    importMessage.value = payload.already_downloaded
      ? (t('downloadAlreadyDownloaded')) + ': ' + payload.task.id
      : payload.existing_download
        ? (payload.restart_available
          ? (t('downloadPreviousFailedOpened'))
          : (t('downloadExistingOpened'))) + ': ' + payload.task.id
        : t('downloadTaskStarted') + ': ' + payload.task.id;
    selectedDownloadLogId.value = payload.task.id;
    selectedTaskId.value = payload.task.id;
    if (payload.existing_download || payload.already_downloaded) view.value = 'tasks';
    await refresh();
    selectedDownloadLogId.value = payload.task.id;
    selectedTaskId.value = payload.task.id;
    await loadTaskLog(payload.task.id);
    return true;
  } catch (error) {
    importMessage.value = String(error);
    return false;
  } finally {
    downloadSubmitting.value = false;
  }
}

/** 确认下载并关闭弹窗 */
async function submitModelDownload() {
  if (!modelUrl.value.trim() || downloadSubmitting.value) return;
  const ok = await startDownload();
  if (ok) emit('close');
}

/** 下载任务控制（暂停/恢复/取消） */
async function controlDownloadTask(task: any, action: 'pause' | 'resume' | 'cancel') {
  try {
    const payload = await api<{ ok: boolean; detail?: string }>(
      '/tasks/' + encodeURIComponent(task.id) + '/' + action,
      { method: 'POST' }
    );
    if (payload.ok === false) message.warning(payload.detail || t('taskControlFailed'));
    else message.success(payload.detail || t('actionSucceeded'));
    selectedDownloadLogId.value = task.id;
    selectedTaskId.value = task.id;
    await refresh();
    await loadTaskLog(task.id);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** 点击任务项跳转到任务详情页 */
function navigateToTask(task: any) {
  selectedDownloadLogId.value = task.id;
  selectedTaskId.value = task.id;
  view.value = 'tasks';
  emit('close');
  loadTaskLog(task.id);
}
</script>

<template>
  <a-modal
    v-model:open="localOpen"
    :title="t('downloadModel')"
    :width="720"
    :footer="null"
    @cancel="emit('close')"
  >
    <div class="toolbar-panel model-download-toolbar">
      <label class="model-download-input-wrap">
        <a-input v-model:value="modelUrl" :placeholder="t('urlPlaceholder')" />
      </label>
      <a-button @click="importPlan">{{ t('checkLink') }}</a-button>
      <a-button type="primary" :loading="downloadSubmitting" :disabled="downloadSubmitting" @click="submitModelDownload">
        {{ t('confirmDownload') }}
      </a-button>
      <a-button @click="refresh"><template #icon><ReloadOutlined /></template>{{ t('refresh') }}</a-button>
    </div>

    <a-alert v-if="importMessage || importPreview" class="model-download-alert" type="info" show-icon>
      <template #message>
        <div v-if="importPreview" class="download-check-preview">
          <div class="download-check-row" :title="importPreviewSummary">
            {{ importPreviewSummary }}
          </div>
          <div v-if="defaultRuntimeHints.length" class="download-check-row download-check-runtime">
            <b>{{ t('runtimeCompatibility') }}:</b>
            <a-space>
              <a-tooltip v-for="hint in defaultRuntimeHints" :key="hint.runtime" :title="hint.reason">
                <a-tag :color="runtimeHintColor(hint.status)" :class="['download-runtime-tag', 'is-' + String(hint.status)]">
                  {{ hint.label }} · {{ statusText(hint.status) }}
                </a-tag>
              </a-tooltip>
            </a-space>
          </div>
          <div v-else-if="importMessage" class="download-check-row">
            {{ importMessage }}
          </div>
        </div>
        <pre v-else class="inline-pre">{{ importMessage }}</pre>
      </template>
    </a-alert>

    <section class="model-download-task-section">
      <div class="detailCardTitle">
        {{ t('downloadTasksTitle') }}
      </div>
      <a-list v-if="recentDownloadTasks.length" size="small" :data-source="recentDownloadTasks" :locale="{ emptyText: null }">
        <template #renderItem="{ item: task }">
          <a-list-item @click="navigateToTask(task)">
            <a-list-item-meta
              :title="taskAlias(task)"
              :description="taskSummary(task)"
            />
            <a-space size="small" @click.stop>
              <a-button
                v-if="task.status === 'running'"
                size="small"
                @click="controlDownloadTask(task, 'pause')"
              >{{ t('pauseTask') }}</a-button>
              <a-button
                v-if="task.status === 'paused'"
                size="small"
                type="primary"
                @click="controlDownloadTask(task, 'resume')"
              >{{ t('resumeTask') }}</a-button>
              <a-button
                v-if="['queued','running','paused'].includes(task.status)"
                size="small"
                danger
                @click="controlDownloadTask(task, 'cancel')"
              >{{ t('cancelTask') }}</a-button>
              <a-button
                v-if="['failed','canceled'].includes(task.status)"
                size="small"
                type="primary"
                @click="retryDownloadTask(task)"
              >{{ t('continueDownload') }}</a-button>
            </a-space>
            <a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag>
          </a-list-item>
        </template>
      </a-list>
      <div v-if="!recentDownloadTasks.length" class="model-download-empty">
        {{ t('noDownloads') }}
      </div>
    </section>
  </a-modal>
</template>
