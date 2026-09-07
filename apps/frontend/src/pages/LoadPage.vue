<!--
  @author Amuin
  @created 2026-06-25
  @description 模型加载/发布页面：开发者日志、API 使用面板、工作区侧栏与模型选择弹窗。
               Load/Publish page: developer logs, API usage panel, workspace sidebar, and model selector.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowsAltOutlined, CopyOutlined, DeleteOutlined, MoreOutlined, PlusOutlined, ShrinkOutlined } from '@ant-design/icons-vue';
import {
  locale, t, view, deployOpenAiModel, deployModelId,
  logCollapsed, copyText, loadContainerLogs, actionTargetName, models, modelCatalogLoading, containers, runningDeployments,
  modelListSummaryUrl, selectedDeployment,
  modelEndpoint, publicBaseUrl, deploymentApiKind, inferenceEndpoint, inferenceEndpointLabel,
  statusText, badgeColor, runtimeHintColor, canDeployToSelected,
  deployContextLength, deployGpuUtil, deployMaxSeqs, deployTensorParallel, deployKvCacheDtype,
  deployGpuDeviceIds, gpuDeviceOptions, selectedGpuCount, syncGpuParallelism,
  deployEnableAutoToolChoice, deployEnableThinking, deployToolCallParser, deployReasoningParser,
  trtMaxBatchSize, trtMaxNumTokens, trtKvCacheFraction, trtTpSize, trtPpSize,
  contextLimit, tensorParallelLimit, paramLimitText, shortModelPath, formatBytes, modelFormatLabel,
  selectedContainer, selectedContainerKey, selectedDeployModel, rightPanelCollapsed, applyDeploymentArgs
} from '../composables/useApp';
import {
  publishPanelTab, publishConsoleLog, publishModelInfoRows,
  publishLoadedModel, publishLoadedModelName,
  publishLoadedRuntime, publishLoadedApiModel,
  publishRequiresAudioRuntime, publishAudioRuntimeDetail,
  publishRuntimeOptions, publishSelectedRuntime, publishRuntimeSelectionVisible,
  publishSelectedModeLabel, publishSelectedImpact, publishPrimaryActionLabel,
  publishParameterSummary, publishParameterSourceLabel,
  publishToolCallSettingsVisible, publishToolCallParserOptions, publishReasoningParserOptions,
  publishTaskFeedbackVisible, publishTaskFeedbackCards, publishTaskStatus,
  selectPublishRuntime, activateSelectedPublishRuntime,
  applyModelMaxContext, applyBaselineDeploymentParameters,
  loadModelModalOpen, loadModelSearch, loadModelSort, loadModelCandidateList,
  selectModelFromModal, deploymentPlanPreview, deploymentPlanLoading,
  publishIsLoading,
  previewDeploymentPlan, deploySelectedModel, unloadDeployment, unloadSelectedDeployment, clearPublishLogs,
  openPublishTaskLog, dismissPublishTask,
} from '../composables/useLoad';
import { loadCustomComposeProfiles } from '../composables/useServices';

const selectedLoadedDeploymentId = ref('');
const activeLoadedDeployment = computed(() =>
  runningDeployments.value.find((deployment) => deployment.deployment_id === selectedLoadedDeploymentId.value)
  || selectedDeployment.value
  || runningDeployments.value[0]
);
const loadModelEmptyDescription = computed(() => {
  if (modelCatalogLoading.value) return locale.value === 'zh-CN' ? '正在扫描模型目录…' : 'Scanning the model directory…';
  if (!models.value.length) {
    return locale.value === 'zh-CN'
      ? '模型目录为空：/home/zhenz/ai-stack/models'
      : 'The model directory is empty: /home/zhenz/ai-stack/models';
  }
  if (loadModelSearch.value.trim()) {
    return locale.value === 'zh-CN' ? '没有匹配的模型' : 'No matching models';
  }
  return locale.value === 'zh-CN'
    ? '已发现模型，但没有完整且可发布的模型'
    : 'Models were found, but none are complete and ready to publish';
});

onMounted(() => {
  logCollapsed.value = true;
  void loadCustomComposeProfiles();
});

function openRuntimeParameters() {
  rightPanelCollapsed.value = false;
  publishPanelTab.value = 'load';
}

function formatContextValue(value: unknown) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return '-';
  return tokens >= 1024 && tokens % 1024 === 0 ? (tokens / 1024) + 'K' : tokens.toLocaleString();
}

function togglePublishLog() {
  logCollapsed.value = !logCollapsed.value;
  if (logCollapsed.value) return;
  const target = activeLoadedDeployment.value?.container_name
    || (selectedContainer.value && selectedContainer.value.state !== 'missing' ? actionTargetName(selectedContainer.value) : '');
  if (target) void loadContainerLogs(target);
}

async function togglePublishTaskLog(taskId: string) {
  if (!logCollapsed.value) {
    logCollapsed.value = true;
    return;
  }
  await openPublishTaskLog(taskId);
}
function deploymentModelName(deployment: any) {
  if (deployment.suite) return (locale.value === 'zh-CN' ? deployment.suite.title_zh : deployment.suite.title) || deployment.runtime || 'Suite';
  return deployment.openai_models?.[0] || deployment.model_id || deployment.runtime || '-';
}

function deploymentModelRecord(deployment: any) {
  const name = deploymentModelName(deployment);
  return models.value.find((item) => item.id === deployment.model_id || item.id === name);
}

function deploymentModelPath(deployment: any) {
  if (deployment.suite) return deployment.suite.components.length + (locale.value === 'zh-CN' ? ' 个套件组件 · 按需加载' : ' suite components · lazy loaded');
  const model = deploymentModelRecord(deployment);
  return model ? shortModelPath(model.local.path) : (deployment.container_name || deployment.runtime || '-');
}

function deploymentModelSize(deployment: any) {
  if (deployment.suite) {
    const ids = new Set(deployment.suite.components.map((component: any) => component.model_id));
    return formatBytes(models.value.filter((model) => ids.has(model.id)).reduce((total, model) => total + model.local.size_bytes, 0));
  }
  const model = deploymentModelRecord(deployment);
  return model ? formatBytes(model.local.size_bytes) : '-';
}

function deploymentRuntimeLabel(deployment: any) {
  return deployment.runtime || deployment.service_type || '-';
}

function deploymentModeLabel(deployment: any) {
  const runtime = String(deployment.runtime || '').toLowerCase();
  if (deployment.suite) return locale.value === 'zh-CN' ? '套件服务' : 'Suite service';
  if (runtime === 'qwen3-tts') return locale.value === 'zh-CN' ? 'AI Stack 托管' : 'AI Stack managed';
  return locale.value === 'zh-CN' ? '独立实例' : 'Dedicated instance';
}

function formatGpuMemory(mib: number | null) {
  if (mib === null || !Number.isFinite(mib)) return '-';
  return (mib / 1024).toFixed(1) + ' GB';
}

function deploymentGpuLabel(deployment: any) {
  const ids = Array.isArray(deployment.args?.gpu_device_ids) ? deployment.args.gpu_device_ids.map(String) : [];
  if (!ids.length) return locale.value === 'zh-CN' ? '全部 GPU' : 'All GPUs';
  return ids.map((id: string) => {
    const option = gpuDeviceOptions.value.find((item) => item.value === id || String(item.index) === id);
    return option ? 'GPU ' + option.index : id.slice(0, 12);
  }).join(', ');
}

function selectLoadedDeployment(deployment: any) {
  selectedLoadedDeploymentId.value = deployment.deployment_id;
  clearPublishLogs();
  if (!logCollapsed.value && deployment.container_name) void loadContainerLogs(deployment.container_name);
  const modelId = deployment.model_id || deployment.openai_models?.[0];
  if (modelId) deployModelId.value = modelId;
  const runtimeContainer = containers.value.find((item) => item.runtime === deployment.service_type);
  if (runtimeContainer) selectedContainerKey.value = runtimeContainer.key;
  applyDeploymentArgs(deployment.args);
}

watch(
  () => activeLoadedDeployment.value?.deployment_id,
  () => applyDeploymentArgs(activeLoadedDeployment.value?.args),
  { immediate: true }
);

function shellSingleQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function deploymentCurlCommand(deployment: any) {
  const kind = deploymentApiKind(deployment);
  const model = deploymentModelName(deployment);
  const curl = "curl --silent --show-error --fail-with-body --noproxy '*' --connect-timeout 5 --max-time 300 -X POST ";
  const report = " -w '\\nHTTP %{http_code} in %{time_total}s\\n'";
  if (kind === 'document') {
    return curl + shellSingleQuote(inferenceEndpoint(deployment))
      + " -F 'file=@/path/to/document.pdf' -F 'max_pages=1'" + report;
  }
  if (kind === 'transcription') {
    return curl + shellSingleQuote(inferenceEndpoint(deployment))
      + " -F 'file=@/path/to/audio.wav' -F 'preset=general' -F 'asrEngine=sensevoice' -F 'language=auto' -F 'speakerCount=auto' -F 'diarization=false'" + report;
  }
  if (kind === 'speech') {
    const payload = model.includes('voicedesign')
      ? { model, input: '欢迎使用本地语音合成服务。第一段会尽快返回，后续音频持续传输。', instructions: '沉稳、清晰、自然的中文女声', response_format: 'mp3', stream: true, stream_chunk_chars: 40 }
      : model.endsWith('-base')
        ? { model, input: '这是一段克隆音色测试。第一段返回后，后续音频继续传输。', language: 'Chinese', reference_audio: 'data:audio/wav;base64,<BASE64_AUDIO>', reference_text: '参考音频对应的准确文本', response_format: 'mp3', stream: true, stream_chunk_chars: 40 }
        : { model, input: '欢迎使用本地语音合成服务。第一段会尽快返回，后续音频持续传输。', voice: 'Vivian', language: 'Chinese', response_format: 'mp3', stream: true, stream_chunk_chars: 40 };
    return curl + shellSingleQuote(inferenceEndpoint(deployment))
      + " -H 'Content-Type: application/json' -d " + shellSingleQuote(JSON.stringify(payload))
      + " --no-buffer --output speech.mp3" + report;
  }
  const isChat = !['embedding', 'rerank', 'ground'].includes(kind);
  const payload = kind === 'embedding'
    ? { model, input: '测试文本', encoding_format: 'float' }
    : kind === 'rerank'
      ? { model, text_1: '什么是向量数据库？', text_2: '向量数据库用于相似度检索。' }
      : kind === 'ground'
        ? { image_url: 'https://example.com/image.jpg', prompt: '定位图片中的目标', generation_mode: 'hybrid' }
      : { model, messages: [{ role: 'user', content: '你好，请简短介绍你自己。' }], max_tokens: 128, stream: true };
  return curl + shellSingleQuote(inferenceEndpoint(deployment))
    + " -H 'Content-Type: application/json' -d " + shellSingleQuote(JSON.stringify(payload))
    + (isChat ? ' --no-buffer' : '') + report;
}
</script>

<template>
  <section :class="['prototype-page', 'publish-console-layout', rightPanelCollapsed ? 'right-panel-collapsed' : '']">
    <!-- 顶部工具栏 -->
    <div class="publish-topbar-prototype">
      <div class="publish-toolbar-left">
        <div :class="['publish-status-pill', (activeLoadedDeployment || publishTaskFeedbackVisible) ? 'is-running' : '']">
          <span>{{ t('publishStatus') }}: {{ publishIsLoading ? (locale === 'zh-CN' ? '加载中' : 'Loading') : activeLoadedDeployment ? t('running') : publishTaskFeedbackVisible ? statusText(publishTaskStatus) : t('publishIdle') }}</span>
          <i></i>
        </div>
        <a-button size="small" @click="view = 'settings'">{{ locale === 'zh-CN' ? '服务器设置' : 'Server Settings' }}</a-button>
        <a-button size="small" @click="copyText(modelListSummaryUrl)">mcp.json</a-button>
      </div>
      <div class="publish-toolbar-right">
        <span class="publish-toolbar-label">{{ locale === 'zh-CN' ? '发布地址' : 'Publish URL' }}:</span>
        <a-button size="small" class="publish-url-button" @click="copyText(modelListSummaryUrl)">{{ modelListSummaryUrl }}</a-button>
        <a-button size="small" @click="copyText(modelListSummaryUrl)"><template #icon><CopyOutlined /></template></a-button>
      </div>
    </div>

    <div class="publish-console-main">
      <!-- 已加载模型 -->
      <section class="publish-console-stage publish-loaded-stage">
        <div class="publish-stage-header">
          <strong>{{ locale === 'zh-CN' ? '已加载模型' : 'Loaded Models' }}</strong>
        </div>
        <div class="publish-loaded-body">
          <template v-if="runningDeployments.length">
            <div
              v-for="deployment in runningDeployments"
              :key="deployment.deployment_id"
              :class="['publish-loaded-card', activeLoadedDeployment?.deployment_id === deployment.deployment_id ? 'is-selected' : '']"
              @click="selectLoadedDeployment(deployment)"
            >
              <div class="publish-loaded-card-head">
                <a-tag color="green">READY</a-tag>
                <a-tag color="blue">{{ deploymentModeLabel(deployment) }}</a-tag>
                <button type="button" class="publish-card-arrow">›</button>
              </div>
              <div class="publish-loaded-row">
                <div class="publish-loaded-title">
                  <a-tag>{{ deploymentRuntimeLabel(deployment) }}</a-tag>
                  <span>
                    <strong>{{ deploymentModelName(deployment) }}</strong>
                    <small>{{ deploymentModelPath(deployment) }}</small>
                  </span>
                  <a-button size="small" @click.stop="copyText(inferenceEndpoint(deployment))"><template #icon><CopyOutlined /></template></a-button>
                  <a-button size="small" @click.stop="copyText(deploymentCurlCommand(deployment))">{{ locale === 'zh-CN' ? '测试 CURL' : 'Test CURL' }}</a-button>
                </div>
                <div class="publish-loaded-stats">
                  <span>{{ t('size') }} <b>{{ deploymentModelSize(deployment) }}</b></span>
                  <span>{{ t('port') }} <b>{{ deployment.public_port }}</b></span>
                  <span v-if="deployment.args?.max_model_len">{{ locale === 'zh-CN' ? '上下文' : 'Context' }} <b>{{ formatContextValue(deployment.args.max_model_len) }}</b></span>
                  <span v-if="deployment.args?.max_num_seqs">{{ locale === 'zh-CN' ? '并发' : 'Concurrency' }} <b>{{ deployment.args.max_num_seqs }}</b></span>
                  <span>{{ t('gpuTarget') }} <b>{{ deploymentGpuLabel(deployment) }}</b></span>
                  <a-button danger size="small" @click.stop="unloadDeployment(deployment)">{{ locale === 'zh-CN' ? '退出加载' : 'Eject' }}</a-button>
                </div>
              </div>
              <div v-if="deployment.suite?.components?.length" class="publish-suite-components">
                <span>{{ locale === 'zh-CN' ? '套件组件' : 'Suite components' }}</span>
                <div>
                  <a-tag v-for="component in deployment.suite.components" :key="component.model_id">
                    {{ component.role }} · {{ component.model_id }}
                  </a-tag>
                </div>
              </div>
              <div class="publish-loaded-runtime">
                <span>{{ locale === 'zh-CN' ? '运行时' : 'Runtime' }}</span>
                <a-tag color="blue">{{ deploymentRuntimeLabel(deployment) }}</a-tag>
                <small>{{ deployment.container_name || deployment.runtime }}</small>
                <span class="publish-endpoint-item">
                  <b>{{ locale === 'zh-CN' ? '模型调用地址' : 'Model endpoint' }}</b>
                  <code>{{ inferenceEndpoint(deployment) }}</code>
                  <a-button size="small" @click.stop="copyText(inferenceEndpoint(deployment))"><template #icon><CopyOutlined /></template></a-button>
                </span>
              </div>
              <div class="publish-endpoint-strip">
                <span class="publish-endpoint-item is-primary">
                  <b>{{ inferenceEndpointLabel(deployment) }} · POST</b>
                  <code>{{ inferenceEndpoint(deployment) }}</code>
                </span>
                <a-button type="primary" ghost size="small" @click.stop="copyText(deploymentCurlCommand(deployment))">
                  {{ locale === 'zh-CN' ? '复制真实测试请求' : 'Copy test request' }}
                </a-button>
              </div>
            </div>
          </template>
          <div
            v-for="feedback in publishTaskFeedbackCards"
            :key="feedback.task.id"
            class="publish-loaded-card"
          >
            <div class="publish-loaded-card-head">
              <a-tag :color="badgeColor(feedback.status)">
                {{ feedback.isLoading ? ((locale === 'zh-CN' ? '加载中 ' : 'LOADING ') + feedback.progress + '%') : statusText(feedback.status) }}
              </a-tag>
              <span v-if="feedback.status === 'failed'" class="publish-failure-note">
                {{ locale === 'zh-CN' ? '运行时未就绪' : 'Runtime not ready' }}
              </span>
              <button v-else type="button" class="publish-card-arrow">›</button>
            </div>
            <div class="publish-loaded-row">
              <div class="publish-loaded-title">
                <a-tag>{{ feedback.runtimeTitle }}</a-tag>
                <span>
                  <strong>{{ feedback.modelName }}</strong>
                  <small>{{ feedback.modelPath }}</small>
                </span>
              </div>
              <div class="publish-loaded-stats">
                <span>{{ t('size') }} <b>{{ feedback.modelSize }}</b></span>
              </div>
            </div>
            <div class="publish-load-progress">
              <a-progress :percent="feedback.progress" size="small" :show-info="false" :status="feedback.status === 'failed' ? 'exception' : undefined" />
              <span v-if="feedback.status !== 'failed'">{{ feedback.summary || (locale === 'zh-CN' ? '正在等待运行时加载模型' : 'Waiting for the runtime to load the model') }}</span>
              <div v-else class="publish-failure-actions">
                <a-tooltip :title="feedback.error || (locale === 'zh-CN' ? '打开完整任务日志' : 'Open the complete task log')">
                  <a-button size="small" @click.stop="togglePublishTaskLog(feedback.task.id)">
                    {{ logCollapsed ? (locale === 'zh-CN' ? '查看日志' : 'View log') : (locale === 'zh-CN' ? '收起日志' : 'Collapse log') }}
                  </a-button>
                </a-tooltip>
                <a-popconfirm
                  :title="locale === 'zh-CN' ? '移除这条失败记录？' : 'Remove this failed record?'"
                  :description="locale === 'zh-CN' ? '只移除任务记录，不会删除模型文件。' : 'This removes only the task record, not the model files.'"
                  :ok-text="locale === 'zh-CN' ? '移除记录' : 'Remove record'"
                  :cancel-text="locale === 'zh-CN' ? '取消' : 'Cancel'"
                  placement="topRight"
                  @confirm="dismissPublishTask(feedback.task.id)"
                >
                  <a-button danger size="small" @click.stop>
                    <template #icon><DeleteOutlined /></template>
                    {{ locale === 'zh-CN' ? '移除记录' : 'Remove record' }}
                  </a-button>
                </a-popconfirm>
              </div>
            </div>
          </div>
          <div v-if="!runningDeployments.length && !publishTaskFeedbackVisible" class="publish-loaded-empty">
            <strong>{{ locale === 'zh-CN' ? '暂未加载' : 'Not loaded yet' }}</strong>
          </div>
        </div>
      </section>

      <!-- 置顶的发布方式选择条 -->
      <section class="publish-runtime-picker">
        <div class="publish-runtime-picker-copy">
          <span>{{ locale === 'zh-CN' ? '选择发布方式' : 'Choose publish mode' }}</span>
          <strong>{{ selectedDeployModel?.display_name || (locale === 'zh-CN' ? '尚未选择模型' : 'No model selected') }}</strong>
        </div>
        <div v-if="publishRuntimeSelectionVisible" class="publish-runtime-rail">
          <button
            v-for="runtime in publishRuntimeOptions"
            :key="runtime.key"
            type="button"
            :title="runtime.detail"
            :class="['publish-runtime-option', publishSelectedRuntime?.key === runtime.key ? 'is-selected' : '']"
            @click="selectPublishRuntime(runtime.key)"
          >
            <i :class="{ running: runtime.state === 'running' }"></i>
            <span>
              <strong>{{ runtime.title }}</strong>
              <small>{{ runtime.mode === 'managed' ? (locale === 'zh-CN' ? 'AI Stack 托管' : 'AI Stack managed') : runtime.mode === 'shared' ? (locale === 'zh-CN' ? '共享服务' : 'Shared') : (locale === 'zh-CN' ? '独立实例' : 'Dedicated') }} · {{ statusText(runtime.state) }}</small>
            </span>
          </button>
        </div>
        <div v-else class="publish-runtime-placeholder">
          {{ locale === 'zh-CN' ? '选择模型后，这里会显示可用的发布方式。' : 'Available publish modes will appear after you select a model.' }}
        </div>
        <div class="publish-runtime-actions">
          <a-button class="publish-load-model-action" size="small" @click="loadModelModalOpen = true"><template #icon><PlusOutlined /></template>{{ locale === 'zh-CN' ? '加载模型' : 'Load Model' }}</a-button>
          <button
            v-if="publishParameterSummary && publishRuntimeSelectionVisible && !publishSelectedRuntime?.profile_id && !publishSelectedRuntime?.existing_container_name"
            type="button"
            class="publish-parameter-readout"
            @click="openRuntimeParameters"
          >
            <span>{{ locale === 'zh-CN' ? '调整运行参数' : 'Tune runtime' }}</span>
            <strong>{{ publishParameterSummary }}</strong>
          </button>
          <a-button
            v-if="publishRuntimeSelectionVisible && !publishSelectedRuntime?.profile_id && publishSelectedRuntime?.key !== 'funasr-gateway' && !publishSelectedRuntime?.existing_container_name"
            size="small"
            :loading="deploymentPlanLoading"
            :disabled="!canDeployToSelected()"
            @click="previewDeploymentPlan"
          >{{ t('previewPlan') }}</a-button>
          <a-button
            v-if="publishRuntimeSelectionVisible"
            type="primary"
            size="small"
            :disabled="!publishSelectedRuntime || (!publishSelectedRuntime.profile_id && !publishSelectedRuntime.existing_container_name && publishSelectedRuntime.key !== 'funasr-gateway' && !canDeployToSelected())"
            @click="activateSelectedPublishRuntime"
          >{{ publishPrimaryActionLabel }}</a-button>
        </div>
        <div v-if="publishSelectedRuntime" class="publish-binding-track">
          <span class="publish-binding-node">{{ selectedDeployModel?.display_name }}</span>
          <i>→</i>
          <span class="publish-binding-node">{{ publishSelectedRuntime.title }}</span>
          <i>→</i>
          <span class="publish-binding-node is-target">{{ publishSelectedModeLabel }}</span>
          <small>{{ publishSelectedImpact }}</small>
        </div>
      </section>

      <!-- 运行计划预览 -->
      <div v-if="deploymentPlanPreview" class="deployment-plan-preview publish-plan-preview">
        <div class="plan-preview-header">
          <b>{{ locale === 'zh-CN' ? '运行计划' : 'Runtime Plan' }}</b>
          <a-tag :color="runtimeHintColor(deploymentPlanPreview.compatibility?.status || 'possible')">
            {{ statusText(deploymentPlanPreview.compatibility?.status || 'planned') }}
          </a-tag>
        </div>
        <a-space size="small" wrap class="task-plan-stages">
          <a-tooltip v-for="stage in deploymentPlanPreview.stages || []" :key="stage.id" :title="stage.detail + (stage.target ? ' · ' + stage.target : '')">
            <a-tag>{{ stage.label }}</a-tag>
          </a-tooltip>
        </a-space>
        <div class="deploy-kv-grid compact-kv plan-preview-kv">
          <span>{{ t('apiAddress') }}<b>{{ deploymentPlanPreview.base_url }}</b></span>
          <span>{{ t('healthEndpoint') }}<b>{{ deploymentPlanPreview.health_url }}</b></span>
        </div>
        <pre class="inline-pre plan-preview-command">{{ deploymentPlanPreview.launch?.command }}</pre>
      </div>

      <!-- 开发者日志 -->
      <section :class="['publish-console-stage', 'publish-log-stage', logCollapsed ? 'is-collapsed' : 'is-expanded']">
        <div class="publish-stage-header" @click="togglePublishLog">
          <strong>{{ t('developerLogs') }}</strong>
          <div class="publish-stage-actions">
            <a-tooltip :title="logCollapsed ? t('expandLog') : t('collapseLog')"><a-button size="small" @click.stop="togglePublishLog"><template #icon><component :is="logCollapsed ? ArrowsAltOutlined : ShrinkOutlined" /></template></a-button></a-tooltip>
            <a-button size="small" @click.stop="clearPublishLogs"><template #icon><DeleteOutlined /></template></a-button>
            <a-button size="small" @click.stop="copyText(publishConsoleLog)"><template #icon><CopyOutlined /></template></a-button>
          </div>
        </div>
        <pre v-if="!logCollapsed" class="message-block log-block deploy-live-log publish-console-log">{{ publishConsoleLog }}</pre>
      </section>
    </div>

    <!-- 工作区侧栏 -->
    <aside v-show="!rightPanelCollapsed" class="publish-console-side">
      <section class="publish-console-stage publish-side-stage">
        <div class="publish-side-heading">
          <strong>{{ publishLoadedModelName }}</strong>
          <button type="button" class="chatPanelIcon"><MoreOutlined /></button>
        </div>
        <div class="publish-side-body">
          <div class="publish-mode-tabs publish-side-tabs">
            <button type="button" :class="['publish-mode-tab', publishPanelTab === 'info' ? 'is-active' : '']" @click="publishPanelTab = 'info'">{{ t('publishInfoTab') }}</button>
            <button type="button" :class="['publish-mode-tab', publishPanelTab === 'load' ? 'is-active' : '']" @click="publishPanelTab = 'load'">{{ locale === 'zh-CN' ? '参数' : 'Parameters' }}</button>
            <button type="button" :class="['publish-mode-tab', publishPanelTab === 'inference' ? 'is-active' : '']" @click="publishPanelTab = 'inference'">{{ t('publishInferenceTab') }}</button>
          </div>

          <!-- Info Tab -->
          <div v-if="publishPanelTab === 'info'" class="publish-side-panel-body">
            <div class="publish-side-card-title">
              <strong>{{ locale === 'zh-CN' ? '模型信息' : 'Model Info' }}</strong>
            </div>
            <div v-if="publishModelInfoRows.length" class="publish-info-table publish-side-info-table">
              <div v-for="row in publishModelInfoRows" :key="row.label" class="publish-info-row">
                <span>{{ row.label }}</span><strong>{{ row.value }}</strong>
              </div>
            </div>
            <a-empty v-else :description="locale === 'zh-CN' ? '请选择要发布的模型' : 'Select a model to publish'" />
            <div class="publish-api-usage-card">
              <strong>{{ t('apiUsage') }}</strong>
              <label>
                <span>{{ t('apiModelIdentifier') }}</span>
                <div class="publish-copy-field"><b>{{ publishLoadedApiModel }}</b><button type="button" @click="copyText(publishLoadedApiModel)"><CopyOutlined /></button></div>
              </label>
              <label>
                <span>{{ locale === 'zh-CN' ? '本地服务可达地址' : 'The local server is reachable at' }}</span>
                <div class="publish-copy-field"><b>{{ modelListSummaryUrl }}</b><button type="button" @click="copyText(modelListSummaryUrl)"><CopyOutlined /></button></div>
              </label>
            </div>
          </div>

          <!-- Parameters Tab -->
          <div v-else-if="publishPanelTab === 'load'" class="publish-side-panel-body">
            <div v-if="publishSelectedRuntime?.profile_id && gpuDeviceOptions.length" class="publish-gpu-router">
              <div class="publish-gpu-router-head">
                <span><strong>{{ t('gpuTarget') }}</strong><small>{{ t('gpuTargetHint') }}</small></span>
                <b>{{ selectedGpuCount }} {{ locale === 'zh-CN' ? '张卡' : 'selected' }}</b>
              </div>
              <a-checkbox-group v-model:value="deployGpuDeviceIds" class="publish-gpu-grid" @change="syncGpuParallelism">
                <a-checkbox v-for="gpu in gpuDeviceOptions" :key="gpu.value" :value="gpu.value" class="publish-gpu-card">
                  <span class="publish-gpu-index">GPU {{ gpu.index }}</span>
                  <span class="publish-gpu-copy"><strong>{{ gpu.name }}</strong><small>{{ t('free') }} {{ formatGpuMemory(gpu.freeMiB) }} / {{ formatGpuMemory(gpu.totalMiB) }} · {{ gpu.utilization === null ? '-' : Math.round(gpu.utilization) + '%' }}</small></span>
                </a-checkbox>
              </a-checkbox-group>
            </div>
            <a-alert v-if="publishSelectedRuntime?.profile_id" type="info" show-icon class="publish-audio-runtime-alert" :message="publishSelectedRuntime.mode === 'managed' ? (locale === 'zh-CN' ? '参数由 AI Stack 托管服务管理' : 'Parameters are managed by AI Stack') : (locale === 'zh-CN' ? '参数由专用运行时管理' : 'Parameters are managed by the dedicated runtime')" :description="publishSelectedRuntime.detail" />
            <a-alert v-else-if="publishRequiresAudioRuntime" type="info" show-icon class="publish-audio-runtime-alert" :message="locale === 'zh-CN' ? '参数由 FunASR Gateway 管理' : 'Parameters are managed by FunASR Gateway'" :description="publishAudioRuntimeDetail" />
            <div v-else class="publish-field-grid publish-side-field-grid">
              <label class="publish-field-block">
                <span>{{ t('openaiName') }}</span>
                <a-input v-model:value="deployOpenAiModel" :placeholder="deployModelId" />
              </label>
            </div>
            <div v-if="!publishRequiresAudioRuntime && !publishSelectedRuntime?.profile_id" class="publish-parameter-panel">
              <div class="publish-parameter-panel-head">
                <div>
                  <strong>{{ locale === 'zh-CN' ? '运行参数' : 'Runtime parameters' }}</strong>
                  <small>{{ publishParameterSourceLabel }}</small>
                </div>
                <div class="publish-parameter-presets">
                  <a-button size="small" @click="applyBaselineDeploymentParameters">{{ locale === 'zh-CN' ? '基础值' : 'Baseline' }}</a-button>
                  <a-button size="small" @click="applyModelMaxContext">{{ locale === 'zh-CN' ? '上下文拉满' : 'Max context' }}</a-button>
                </div>
              </div>
              <div v-if="publishParameterSummary" class="publish-parameter-callout">
                <strong>{{ publishParameterSummary }}</strong>
                <span>{{ locale === 'zh-CN' ? '点击发布后，这组参数会写入任务；成功配置会在下次选择此模型时自动恢复。' : 'These values are written to the publish task; successful settings are restored next time.' }}</span>
              </div>
              <div class="publish-parameter-panel-body">
                <div v-if="gpuDeviceOptions.length" class="publish-gpu-router">
                  <div class="publish-gpu-router-head">
                    <span>
                      <strong>{{ t('gpuTarget') }}</strong>
                      <small>{{ t('gpuTargetHint') }}</small>
                    </span>
                    <b>{{ selectedGpuCount }} {{ locale === 'zh-CN' ? '张卡' : 'selected' }}</b>
                  </div>
                  <a-checkbox-group v-model:value="deployGpuDeviceIds" class="publish-gpu-grid" @change="syncGpuParallelism">
                    <a-checkbox v-for="gpu in gpuDeviceOptions" :key="gpu.value" :value="gpu.value" class="publish-gpu-card">
                      <span class="publish-gpu-index">GPU {{ gpu.index }}</span>
                      <span class="publish-gpu-copy">
                        <strong>{{ gpu.name }}</strong>
                        <small>{{ t('free') }} {{ formatGpuMemory(gpu.freeMiB) }} / {{ formatGpuMemory(gpu.totalMiB) }} · {{ gpu.utilization === null ? '-' : Math.round(gpu.utilization) + '%' }}</small>
                      </span>
                    </a-checkbox>
                  </a-checkbox-group>
                  <small class="publish-gpu-parallel-hint">{{ selectedContainer?.runtime === 'trtllm' ? t('gpuParallelTrtHint') : t('gpuParallelHint') }}</small>
                </div>
                <template v-if="selectedContainer?.runtime === 'vllm'">
                  <div class="publishParamField"><label>{{ t('contextLength') + ' · ' + paramLimitText() }}</label><div class="param-control"><a-input-number v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /><a-slider v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /></div></div>
                  <div class="publishParamField"><label>{{ t('gpuUtil') }}</label><div class="param-control"><a-input-number v-model:value="deployGpuUtil" :min="10" :max="99" :step="1" addon-after="%" /><a-slider v-model:value="deployGpuUtil" :min="10" :max="99" :step="1" /></div></div>
                  <div class="publishParamField"><label>{{ t('maxSeqs') }}</label><div class="param-control"><a-input-number v-model:value="deployMaxSeqs" :min="1" :max="256" /><a-slider v-model:value="deployMaxSeqs" :min="1" :max="256" /></div></div>
                  <div class="publishParamField"><label>{{ t('tensorParallel') }}</label><div class="param-control"><a-input-number v-model:value="deployTensorParallel" :min="1" :max="tensorParallelLimit" disabled /><a-slider v-model:value="deployTensorParallel" :min="1" :max="tensorParallelLimit" disabled /></div></div>
                  <div class="publishParamField"><label>{{ t('kvCacheDtype') }}</label><a-select v-model:value="deployKvCacheDtype" :options="[{label:'auto', value:'auto'}, {label:'fp8', value:'fp8'}, {label:'fp8_e5m2', value:'fp8_e5m2'}]" /></div>
                  <section v-if="publishToolCallSettingsVisible" class="publish-tool-routing">
                    <div class="publish-tool-routing-head">
                      <span>
                        <strong>{{ t('autoToolChoice') }}</strong>
                        <small>{{ t('autoToolChoiceHint') }}</small>
                      </span>
                      <a-switch v-model:checked="deployEnableAutoToolChoice" />
                    </div>
                    <div v-if="deployEnableAutoToolChoice" class="publishParamField">
                      <label>{{ t('toolCallParser') }}</label>
                      <a-select v-model:value="deployToolCallParser" :options="publishToolCallParserOptions" />
                    </div>
                    <small v-else class="publish-tool-routing-disabled">{{ t('autoToolChoiceDisabledHint') }}</small>
                    <div class="publish-tool-routing-head">
                      <span>
                        <strong>{{ t('thinkingMode') }}</strong>
                        <small>{{ t('thinkingModeHint') }}</small>
                      </span>
                      <a-switch v-model:checked="deployEnableThinking" />
                    </div>
                    <div class="publishParamField">
                      <label>{{ t('reasoningParser') }}</label>
                      <a-select v-model:value="deployReasoningParser" :options="publishReasoningParserOptions" />
                      <small class="publish-tool-routing-hint">{{ t('reasoningParserHint') }}</small>
                    </div>
                  </section>
                </template>
                <template v-else-if="selectedContainer?.runtime === 'trtllm'">
                  <div class="publishParamField"><label>{{ t('trtMaxBatchSize') }}</label><div class="param-control"><a-input-number v-model:value="trtMaxBatchSize" :min="1" :max="256" /><a-slider v-model:value="trtMaxBatchSize" :min="1" :max="256" /></div></div>
                  <div class="publishParamField"><label>{{ t('trtMaxTokens') + ' · ' + paramLimitText() }}</label><div class="param-control"><a-input-number v-model:value="trtMaxNumTokens" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /><a-slider v-model:value="trtMaxNumTokens" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /></div></div>
                  <div class="publishParamField"><label>{{ t('trtKvFraction') }}</label><div class="param-control"><a-input-number v-model:value="trtKvCacheFraction" :min="0.1" :max="0.99" :step="0.01" /><a-slider v-model:value="trtKvCacheFraction" :min="0.1" :max="0.99" :step="0.01" /></div></div>
                  <div class="publishParamField"><label>{{ t('tensorParallel') }}</label><div class="param-control"><a-input-number v-model:value="trtTpSize" :min="1" :max="tensorParallelLimit" /><a-slider v-model:value="trtTpSize" :min="1" :max="tensorParallelLimit" /></div></div>
                  <div class="publishParamField"><label>{{ t('pipelineParallel') }}</label><div class="param-control"><a-input-number v-model:value="trtPpSize" :min="1" :max="16" /><a-slider v-model:value="trtPpSize" :min="1" :max="16" /></div></div>
                </template>
              </div>
            </div>
          </div>

          <!-- Inference Tab -->
          <div v-else class="publish-side-panel-body">
            <div class="publish-endpoint-grid publish-side-endpoint-grid">
              <div class="publish-endpoint-cell"><span>{{ t('runningModel') }}</span><strong>{{ activeLoadedDeployment ? deploymentModelName(activeLoadedDeployment) : '-' }}</strong></div>
              <div class="publish-endpoint-cell"><span>{{ t('apiAddress') }}</span><strong>{{ activeLoadedDeployment ? publicBaseUrl(activeLoadedDeployment) : '-' }}</strong></div>
              <div class="publish-endpoint-cell"><span>{{ t('modelListEndpoint') }}</span><strong>{{ activeLoadedDeployment ? modelEndpoint(activeLoadedDeployment) : '-' }}</strong></div>
              <div class="publish-endpoint-cell"><span>{{ t('inferenceEndpoint') }}</span><strong>{{ activeLoadedDeployment ? inferenceEndpoint(activeLoadedDeployment) : '-' }}</strong></div>
            </div>
            <div class="publish-side-model-meta">
              <strong>{{ t('inferenceStatus') }}</strong>
              <span>{{ activeLoadedDeployment ? statusText(activeLoadedDeployment.status) : (locale === 'zh-CN' ? '暂无运行中的推理服务' : 'No active inference service') }}</span>
            </div>
          </div>
        </div>
      </section>
    </aside>

    <!-- 模型选择弹窗 -->
    <a-modal v-model:open="loadModelModalOpen" :title="locale === 'zh-CN' ? '选择模型' : 'Select Model'" :width="720" :footer="null">
      <a-input v-model:value="loadModelSearch" allow-clear :placeholder="locale === 'zh-CN' ? '搜索模型名称、路径或格式...' : 'Search model name, path, or format...'" style="margin-bottom:12px" />
      <div v-if="selectedDeployModel" class="load-model-current">
        <b>{{ locale === 'zh-CN' ? '当前已选择' : 'Currently Selected' }}</b>
        <span class="load-model-current-tag">{{ selectedDeployModel.display_name }}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="color:#63798a;font-size:.78rem;font-weight:650">{{ locale === 'zh-CN' ? '排序' : 'Sort' }}</span>
        <a-segmented v-model:value="loadModelSort" :options="[{ label: locale === 'zh-CN' ? '最近' : 'Recency', value: 'recency' }, { label: t('size'), value: 'size' }, { label: locale === 'zh-CN' ? '已下载' : 'Downloaded', value: 'downloaded' }]" size="small" />
      </div>
      <a-table :data-source="loadModelCandidateList" :loading="modelCatalogLoading && !models.length" :pagination="false" size="small" row-key="id" :scroll="{ y: 360 }">
        <template #empty><a-empty :description="loadModelEmptyDescription" /></template>
        <a-table-column :title="t('modelName')" key="model" :width="200">
          <template #default="{ record }">
            <div style="display:grid;gap:2px">
              <span style="font-weight:650;font-size:.84rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ record.display_name }}</span>
              <span style="font-size:.7rem;color:#63798a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono)">{{ shortModelPath(record.local.path) }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column :title="t('status')" key="status" :width="80">
          <template #default="{ record }"><a-tag :color="badgeColor(record.status.download)">{{ statusText(record.status.download) }}</a-tag></template>
        </a-table-column>
        <a-table-column :title="t('format')" key="format" :width="90">
          <template #default="{ record }"><span style="font-family:var(--font-mono);font-size:.76rem">{{ modelFormatLabel(record.local.format) }}</span></template>
        </a-table-column>
        <a-table-column :title="t('size')" key="size" :width="90">
          <template #default="{ record }">{{ formatBytes(record.local.size_bytes) }}</template>
        </a-table-column>
        <a-table-column key="select" :width="70">
          <template #default="{ record }"><a-button size="small" type="primary" @click="selectModelFromModal(record)">{{ locale === 'zh-CN' ? '选定' : 'Select' }}</a-button></template>
        </a-table-column>
      </a-table>
    </a-modal>
  </section>
</template>
