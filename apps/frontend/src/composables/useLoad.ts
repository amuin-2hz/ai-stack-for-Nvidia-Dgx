/**
 * @author Amuin
 * @created 2026-06-25
 * @description 模型加载/发布（Load）页面本地状态、部署预览与发布操作。
 *              Load/Publish page-local state, deployment plan preview, and deploy actions.
 */
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { ContainerRecord, DeploymentRecord, ModelRecord, ServiceType, TaskRecord } from '../types';
import {
  locale, t, api, models, deployModelId, selectedContainerKey, selectedContainer,
  selectedDeployment, deployOpenAiModel, containerLog, taskLog,
  logCollapsed,
  containers, containerOptions, readyModelList, view,
  shortModelPath, formatBytes, modelFormatLabel,
  selectDeployModel, loadContainerLogs, actionTargetName,
  refresh, deploymentArgs, applyDeploymentArgs, selectedLogContainer,
  currentLoadedModel, publicHost, runningDeployments,
  deployContextLength, deployGpuUtil, deployMaxSeqs, deployTensorParallel, deployKvCacheDtype,
  deployGpuDeviceIds, selectedGpuCount,
  deployEnableAutoToolChoice, deployToolCallParser, deployReasoningParser,
  effectiveToolCallParser, effectiveReasoningParser, recommendedToolCallParser, recommendedReasoningParser,
  trtMaxBatchSize, trtMaxNumTokens, trtKvCacheFraction, trtTpSize, trtPpSize, contextLimit,
  canDeployToSelected,
  selectedTaskId, loadTaskLog, activeTasks, tasks, taskProgress, taskRuntimePlanSummary
} from './useApp';
import { customComposeProfiles } from './useServices';

// ── 工作面板 Tab ─────────────────────────────────────────────────────────
export const publishPanelTab = ref<'info' | 'load' | 'inference'>('info');
export const publishSelectedRuntimeKey = ref(localStorage.getItem('publishSelectedRuntimeKey') || '');
export const publishTrackedTaskId = ref(sessionStorage.getItem('publishTrackedTaskId') || '');
const publishOptimisticTask = ref<TaskRecord | null>(null);
export const publishStartPending = ref(false);
const publishObservedTaskIds = ref<string[]>([]);

// ── 当前发布模型 ─────────────────────────────────────────────────────────

/** 当前选中的待发布模型对象 */
export const publishActiveModel = computed(() =>
  models.value.find((item) => item.id === deployModelId.value) ?? null
);

export function modelNeedsAudioRuntime(model: ModelRecord | null | undefined): boolean {
  if (!model) return false;
  const caps = (model.capabilities ?? []).map((item) => item.toLowerCase());
  const text = [model.id, model.display_name, model.local.format, model.runtime.preferred, ...caps].join(' ').toLowerCase();
  return model.runtime.preferred === 'funasr-gateway' || caps.some((cap) => cap === 'asr' || cap === 'tts') || /(audio|asr|tts|funasr|fun-asr|whisper|sensevoice|cosyvoice)/.test(text);
}

export const publishRequiresAudioRuntime = computed(() =>
  modelNeedsAudioRuntime(publishActiveModel.value) && !selectedDeployment.value
);

export const publishAudioRuntimeUrl = computed(() => 'http://' + publicHost.value + ':8011');

export const publishAudioRuntimeDetail = computed(() => locale.value === 'zh-CN'
  ? (publishActiveModel.value?.runtime.preferred === 'qwen3-tts'
      ? '该模型将发布到 AI Stack 托管的 Qwen3-TTS 语音服务；平台会自动准备运行环境、加载模型并登记调用地址。'
      : '该模型将使用 FunASR Gateway 共享服务，模型权重会在首次调用时加载；默认 PyTorch 容器只是通用环境。')
  : (publishActiveModel.value?.runtime.preferred === 'qwen3-tts'
      ? 'This model is published to the AI Stack-managed Qwen3-TTS speech service. AI Stack prepares the runtime, loads the model, and registers its endpoint.'
      : 'This model uses the shared FunASR Gateway service. Weights load on first use; the default PyTorch container is only a generic environment.'));

export type PublishRuntimeOption = {
  key: string;
  title: string;
  runtime: string;
  state: string;
  detail: string;
  mode: 'dedicated' | 'shared' | 'managed';
  existing_container_name?: string;
  profile_id?: string;
};

function customContainerSupportsModel(container: ContainerRecord, modelId: string): boolean {
  if (container.category !== 'custom') return false;
  const normalizedModelId = modelId.trim().toLowerCase();
  return (container.suitable_models ?? []).some((item) => {
    const candidate = item.trim().toLowerCase();
    return candidate === '*' || candidate === normalizedModelId;
  });
}

function isSharedServiceContainer(container: ContainerRecord): boolean {
  const text = [container.key, container.name, container.title].join(' ').toLowerCase();
  return /funasr[-_ ]?gateway|vibevoice[-_ ]?hf|shared[-_ ]?service/.test(text);
}

function existingContainerRuntimeOption(container: ContainerRecord): PublishRuntimeOption {
  return {
    key: container.key,
    title: container.title || container.name,
    runtime: isSharedServiceContainer(container) ? 'shared-service' : 'dedicated-service',
    state: container.state,
    mode: isSharedServiceContainer(container) ? 'shared' : 'dedicated',
    detail: container.note || (locale.value === 'zh-CN' ? '复用此容器，不会创建新容器' : 'Reuse this container without creating another one'),
    existing_container_name: container.instance_name || container.name
  };
}

function customProfileSupportsModel(profile: { id: string; suitable_models?: string[] }, model: ModelRecord): boolean {
  const normalizedModelId = model.id.trim().toLowerCase();
  if (profile.id === model.runtime.preferred) return true;
  return (profile.suitable_models ?? []).some((item) => {
    const candidate = item.trim().toLowerCase();
    return candidate === '*' || candidate === normalizedModelId;
  });
}

export const publishRuntimeOptions = computed<PublishRuntimeOption[]>(() => {
  const model = publishActiveModel.value;
  if (!model) return [];
  const managedProfileContainerNames = new Set(
    customComposeProfiles.value.map((profile) => profile.container_name).filter(Boolean)
  );
  const reusableContainers = containers.value
    .filter((container) => customContainerSupportsModel(container, model.id))
    .filter((container) => !managedProfileContainerNames.has(container.instance_name || container.name))
    .map(existingContainerRuntimeOption);
  const customProfileOptions = customComposeProfiles.value
    .filter((profile) => customProfileSupportsModel(profile, model))
    .map((profile): PublishRuntimeOption => {
      const container = containers.value.find((item) =>
        item.name === profile.container_name || item.instance_name === profile.container_name
      );
      return {
        key: 'custom-profile:' + profile.id,
        profile_id: profile.id,
        title: locale.value === 'zh-CN' ? profile.title_zh : profile.title,
        runtime: profile.id,
        state: container?.state ?? (profile.image_built ? 'ready' : 'missing'),
        mode: profile.id === 'qwen3-tts' ? 'managed' : 'dedicated',
        detail: locale.value === 'zh-CN' ? profile.description_zh : profile.description
      };
    });
  if (modelNeedsAudioRuntime(model)) {
    const audioContainer = containers.value.find((item) =>
      item.category === 'custom'
      && /funasr[-_ ]?gateway|custom_funasr_gateway/i.test([item.key, item.name, item.title].join(' '))
    );
    if (reusableContainers.length) return reusableContainers;
    if (customProfileOptions.length) return customProfileOptions;
    if (audioContainer) return [existingContainerRuntimeOption(audioContainer)];
    return [{
      key: 'funasr-gateway',
      title: 'FunASR Gateway',
      runtime: 'funasr-gateway',
      state: 'missing',
      mode: 'shared',
      detail: locale.value === 'zh-CN'
        ? '尚未发现可复用的 FunASR Gateway 容器'
        : 'No reusable FunASR Gateway container was found'
    }];
  }
  const systemOptions = containerOptions.value.map((option) => {
    const container = containers.value.find((item) => item.key === option.value);
    return {
      key: option.value,
      title: container?.title || option.label,
      runtime: container?.runtime || option.value,
      state: container?.state ?? 'missing',
      mode: 'dedicated' as const,
      detail: model.compatibility[container?.runtime || option.value]?.reason
        || (locale.value === 'zh-CN' ? '兼容的系统运行时' : 'Compatible system runtime')
    };
  });
  return [...reusableContainers, ...customProfileOptions, ...systemOptions];
});

export const publishSelectedRuntime = computed(() => {
  const options = publishRuntimeOptions.value;
  return options.find((item) => item.key === publishSelectedRuntimeKey.value)
    ?? options.find((item) => item.key === selectedContainerKey.value)
    ?? options[0]
    ?? null;
});

export const publishSelectedModeLabel = computed(() => {
  const runtime = publishSelectedRuntime.value;
  if (!runtime) return '-';
  if (runtime.mode === 'managed') return locale.value === 'zh-CN' ? 'AI Stack 托管' : 'AI Stack managed';
  if (runtime.mode === 'shared') return locale.value === 'zh-CN' ? '共享服务' : 'Shared service';
  return locale.value === 'zh-CN' ? '独立实例' : 'Dedicated instance';
});

export const publishSelectedImpact = computed(() => {
  const runtime = publishSelectedRuntime.value;
  if (!runtime) return '';
  if (runtime.profile_id) {
    if (runtime.mode === 'managed') {
      return runtime.state === 'running'
        ? (locale.value === 'zh-CN' ? '复用 AI Stack 已运行的 Qwen3-TTS 服务并登记当前模型，不需要手工启动服务。' : 'Reuse the running AI Stack-managed Qwen3-TTS service and register this model; no manual startup is required.')
        : (locale.value === 'zh-CN' ? '由 AI Stack 自动准备 Qwen3-TTS 服务、加载模型并完成健康检查。' : 'AI Stack automatically prepares the Qwen3-TTS service, loads the model, and completes health checks.');
    }
    return runtime.state === 'missing'
      ? (locale.value === 'zh-CN' ? '构建专用镜像并启动当前模型；任务进度会立即显示在上方。' : 'Build the dedicated image and start this model; task progress appears above immediately.')
      : (locale.value === 'zh-CN' ? '使用已准备的专用运行时加载当前模型，不会尝试不兼容的通用引擎。' : 'Load this model with its prepared dedicated runtime instead of an incompatible generic engine.');
  }
  if (runtime.mode === 'shared') {
    return runtime.state === 'running'
      ? (locale.value === 'zh-CN' ? '复用当前服务，不会创建新容器；模型将在首次调用时加载。' : 'Reuse the current service without creating a container; the model loads on first use.')
      : (locale.value === 'zh-CN' ? '先启动共享服务，再复用其接口；不会启动其他推理引擎。' : 'Start the shared service, then reuse its API; other inference engines stay stopped.');
  }
  return locale.value === 'zh-CN'
    ? '创建只服务当前模型的独立实例，不会启动其他运行环境。'
    : 'Create an isolated instance for this model without starting other runtime environments.';
});

export const publishPrimaryActionLabel = computed(() => {
  const runtime = publishSelectedRuntime.value;
  if (!runtime) return locale.value === 'zh-CN' ? '加载并发布' : 'Load & Publish';
  if (runtime.mode === 'managed') return runtime.state === 'running'
    ? (locale.value === 'zh-CN' ? '发布到托管服务' : 'Publish to Managed Service')
    : (locale.value === 'zh-CN' ? 'AI Stack 加载并发布' : 'AI Stack Load & Publish');
  if (runtime.profile_id) return runtime.state === 'missing'
    ? (locale.value === 'zh-CN' ? '构建并启动' : 'Build & Start')
    : (locale.value === 'zh-CN' ? '加载并发布' : 'Load & Publish');
  if (runtime.key === 'funasr-gateway' && !runtime.existing_container_name) return locale.value === 'zh-CN' ? '检查共享服务' : 'Check Shared Service';
  if (runtime.mode === 'shared') return runtime.state === 'running' ? (locale.value === 'zh-CN' ? '使用共享服务' : 'Use Shared Service') : (locale.value === 'zh-CN' ? '启动并使用' : 'Start & Use');
  return locale.value === 'zh-CN' ? '加载并发布' : 'Load & Publish';
});

export const publishRuntimeSelectionVisible = computed(() =>
  Boolean(publishActiveModel.value && publishRuntimeOptions.value.length)
);

export function modelSupportsToolCallConfig(model: ModelRecord | null | undefined): boolean {
  if (!model) return false;
  const capabilities = new Set((model.capabilities ?? []).map((item) => item.toLowerCase()));
  const excludedCapabilities = [
    'asr', 'tts', 'speaker-verification', 'speaker-diarization',
    'embedding', 'embeddings', 'rerank', 'reranker'
  ];
  if (excludedCapabilities.some((capability) => capabilities.has(capability))) return false;
  const text = [model.id, model.display_name, model.local.format, model.runtime.preferred, ...capabilities].join(' ').toLowerCase();
  if (/(audio|asr|tts|funasr|whisper|sensevoice|cosyvoice|rerank|embed)/.test(text)) return false;
  if ([...capabilities].some((capability) => [
    'chat', 'generative', 'generation', 'text-generation', 'causal-lm', 'causallm', 'vision-language'
  ].includes(capability))) return true;
  if (capabilities.size && !capabilities.has('unknown')) return false;
  const architecture = String(model.local.architecture ?? '').toLowerCase();
  return /(causallm|conditionalgeneration|qwen|llama|mistral|gemma|deepseek|chatglm|baichuan|gpt)/.test(architecture + ' ' + text);
}

export const publishToolCallSettingsVisible = computed(() =>
  publishSelectedRuntime.value?.runtime === 'vllm'
  && modelSupportsToolCallConfig(publishActiveModel.value)
);

export const publishToolCallParserOptions = computed(() => [
  { label: t('parserAutoRecommend') + ' · ' + recommendedToolCallParser.value, value: 'auto' },
  { label: 'qwen3_coder', value: 'qwen3_coder' },
  { label: 'qwen3_xml', value: 'qwen3_xml' },
  { label: 'hermes', value: 'hermes' }
]);

export const publishReasoningParserOptions = computed(() => [
  {
    label: t('parserAutoRecommend') + ' · ' + (recommendedReasoningParser.value || t('parserDisabled')),
    value: 'auto'
  },
  { label: t('parserDisabled'), value: '' },
  { label: 'qwen3', value: 'qwen3' }
]);

function compactTokenCount(value: number): string {
  if (value >= 1024 && value % 1024 === 0) return (value / 1024) + 'K';
  return new Intl.NumberFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US').format(value);
}

const latestSuccessfulDeploymentPreset = computed(() => {
  const modelId = publishActiveModel.value?.id;
  const runtime = selectedContainer.value?.runtime;
  if (!modelId || !runtime) return null;
  return tasks.value.find((task) =>
    task.type === 'deploy'
    && task.status === 'succeeded'
    && task.metadata?.model_id === modelId
    && task.metadata?.service_type === runtime
    && task.metadata?.args
  ) ?? null;
});

const runningDeploymentPreset = computed(() => {
  const modelId = publishActiveModel.value?.id;
  const runtime = selectedContainer.value?.runtime;
  if (!modelId || !runtime) return null;
  return runningDeployments.value.find((deployment) =>
    deployment.model_id === modelId
    && deployment.service_type === runtime
    && deployment.status === 'running'
    && deployment.args
  ) ?? null;
});

const deploymentParameterPreset = computed(() => {
  const active = runningDeploymentPreset.value;
  if (active?.args) return {
    key: 'deployment:' + active.deployment_id + ':' + JSON.stringify(active.args),
    args: active.args,
    source: 'running' as const
  };
  const task = latestSuccessfulDeploymentPreset.value;
  if (task?.metadata?.args) return {
    key: 'task:' + task.id + ':' + JSON.stringify(task.metadata.args),
    args: task.metadata.args as Record<string, unknown>,
    source: 'task' as const
  };
  return null;
});

export const publishParameterSummary = computed(() => {
  const runtime = selectedContainer.value?.runtime;
  if (runtime === 'vllm') {
    let summary = (locale.value === 'zh-CN' ? '上下文 ' : 'Context ')
      + compactTokenCount(deployContextLength.value)
      + ' · ' + deployGpuUtil.value + '% · '
      + 'GPU × ' + selectedGpuCount.value + ' · '
      + (locale.value === 'zh-CN' ? '并发 ' : 'Concurrency ') + deployMaxSeqs.value;
    if (publishToolCallSettingsVisible.value) {
      summary += ' · ' + t('autoToolChoiceShort') + ' ' + (deployEnableAutoToolChoice.value ? t('on') : t('off'))
        + ' · Tool ' + effectiveToolCallParser.value
        + ' · Reasoning ' + (effectiveReasoningParser.value || t('parserDisabled'));
    }
    return summary;
  }
  if (runtime === 'trtllm') {
    return (locale.value === 'zh-CN' ? '令牌 ' : 'Tokens ')
      + compactTokenCount(trtMaxNumTokens.value)
      + ' · KV ' + Math.round(trtKvCacheFraction.value * 100) + '% · '
      + 'GPU × ' + selectedGpuCount.value + ' · '
      + (locale.value === 'zh-CN' ? '批量 ' : 'Batch ') + trtMaxBatchSize.value;
  }
  return '';
});

export const publishParameterSourceLabel = computed(() => deploymentParameterPreset.value?.source === 'running'
  ? (locale.value === 'zh-CN' ? '已恢复当前运行实例配置' : 'Restored the active runtime configuration')
  : deploymentParameterPreset.value?.source === 'task'
    ? (locale.value === 'zh-CN' ? '已恢复该模型上次成功配置' : 'Restored the last successful model configuration')
    : (locale.value === 'zh-CN' ? '首次发布使用基础值，修改后会随成功记录保留' : 'First publish uses baseline values; successful settings are retained'));

let restoredDeploymentPresetKey = '';
watch(
  [
    () => publishActiveModel.value?.id ?? '',
    () => selectedContainer.value?.runtime ?? '',
    () => deploymentParameterPreset.value?.key ?? ''
  ],
  ([modelId, runtime, presetKey]) => {
    if (!modelId || !runtime) return;
    const restoreKey = modelId + ':' + runtime + ':' + presetKey;
    if (restoreKey === restoredDeploymentPresetKey) return;
    restoredDeploymentPresetKey = restoreKey;
    if (deploymentParameterPreset.value?.args) applyDeploymentArgs(deploymentParameterPreset.value.args);
  },
  { immediate: true }
);

export function applyModelMaxContext() {
  if (selectedContainer.value?.runtime === 'trtllm') trtMaxNumTokens.value = contextLimit.value.max;
  else deployContextLength.value = contextLimit.value.max;
}

export function applyBaselineDeploymentParameters() {
  const limit = contextLimit.value;
  if (selectedContainer.value?.runtime === 'trtllm') {
    trtMaxBatchSize.value = 8;
    trtMaxNumTokens.value = limit.default;
    trtKvCacheFraction.value = 0.9;
    trtTpSize.value = selectedGpuCount.value;
    trtPpSize.value = 1;
    return;
  }
  deployContextLength.value = limit.default;
  deployGpuUtil.value = 30;
  deployMaxSeqs.value = 4;
  deployTensorParallel.value = selectedGpuCount.value;
  deployKvCacheDtype.value = 'auto';
  deployEnableAutoToolChoice.value = false;
  deployToolCallParser.value = 'auto';
  deployReasoningParser.value = 'auto';
}

export function selectPublishRuntime(key: string) {
  publishSelectedRuntimeKey.value = key;
  localStorage.setItem('publishSelectedRuntimeKey', key);
  deploymentPlanPreview.value = null;
  const runtime = publishRuntimeOptions.value.find((item) => item.key === key);
  if (runtime && !runtime.existing_container_name && !runtime.profile_id && key !== 'funasr-gateway') selectedContainerKey.value = key;
  publishPanelTab.value = 'load';
}

export const publishLoadedModel = computed(() =>
  currentLoadedModel() ?? publishActiveModel.value
);

export const publishLoadedModelName = computed(() => {
  const deployment = selectedDeployment.value;
  const model = publishLoadedModel.value;
  return model?.display_name
    || deployment?.openai_models?.[0]
    || (locale.value === 'zh-CN' ? '尚未加载模型' : 'No model loaded');
});

export const publishLoadedModelPath = computed(() => {
  const model = publishLoadedModel.value;
  return model ? shortModelPath(model.local.path) : (locale.value === 'zh-CN' ? '请选择并发布一个模型' : 'Select and publish a model');
});

export const publishLoadedModelSize = computed(() => {
  const model = publishLoadedModel.value;
  return model ? formatBytes(model.local.size_bytes) : '-';
});

export const publishLoadedRuntime = computed(() =>
  selectedDeployment.value?.service_type
  || (modelNeedsAudioRuntime(publishActiveModel.value) ? publishActiveModel.value?.runtime.preferred || 'funasr-gateway' : '')
  || selectedContainer.value?.runtime
  || publishLoadedModel.value?.runtime.preferred
  || '-'
);

export const publishLoadedApiModel = computed(() =>
  selectedDeployment.value?.openai_models?.[0]
  || deployOpenAiModel.value
  || deployModelId.value
  || '-'
);

export const publishActiveDeploymentTask = computed(() => {
  if (publishTrackedTaskId.value) {
    const refreshed = tasks.value.find((task) => task.id === publishTrackedTaskId.value);
    if (refreshed) return refreshed;
    if (publishOptimisticTask.value?.id === publishTrackedTaskId.value) return publishOptimisticTask.value;
  }
  const modelId = deployModelId.value;
  if (!modelId) return null;
  const serviceType = selectedContainer.value?.runtime;
  const openaiModel = deployOpenAiModel.value || modelId;
  const matchesSelection = (task: TaskRecord) => {
    const metadata = task.metadata ?? {};
    const isDeployment = task.type === 'deploy';
    const isCustomProfile = task.type === 'container'
      && metadata.action === 'start_custom_profile'
      && metadata.profile_id === publishSelectedRuntime.value?.profile_id;
    if (!isDeployment && !isCustomProfile) return false;
    const sameModel = metadata.model_id === modelId || metadata.openai_model === openaiModel;
    const sameRuntime = isCustomProfile || !serviceType || metadata.service_type === serviceType;
    return sameModel && sameRuntime;
  };
  return activeTasks.value.find(matchesSelection) ?? null;
});

const activeTaskStatuses = new Set(['queued', 'running', 'paused', 'canceling']);

function isPublishDeploymentTask(task: TaskRecord): boolean {
  return task.type === 'deploy'
    || (task.type === 'container' && task.metadata?.action === 'start_custom_profile');
}

function taskRuntimeAlreadyListed(task: TaskRecord): boolean {
  const metadata = task.metadata ?? {};
  const taskModel = String(metadata.model_id ?? metadata.openai_model ?? '');
  const taskContainer = String(metadata.container_name ?? metadata.name ?? '');
  return runningDeployments.value.some((deployment) => {
    if (deployment.status !== 'running') return false;
    if (taskContainer && deployment.container_name === taskContainer) return true;
    return Boolean(taskModel) && (
      deployment.model_id === taskModel
      || deployment.openai_models?.includes(taskModel)
    );
  });
}

function publishTaskTargetKey(task: TaskRecord): string {
  const metadata = task.metadata ?? {};
  return String(metadata.model_id ?? metadata.openai_model ?? metadata.container_name ?? task.id);
}

function publishTaskErrorText(task: TaskRecord): string {
  return String(task.error || task.diagnostic?.message || '');
}

function publishTaskSummary(task: TaskRecord): string {
  const error = publishTaskErrorText(task);
  if (error) return error;
  const plan = taskRuntimePlanSummary(task);
  if (plan) return plan;
  if (task.metadata?.action === 'start_custom_profile') {
    if (task.metadata?.profile_id === 'qwen3-tts') {
      return locale.value === 'zh-CN'
        ? 'AI Stack 正在准备 Qwen3-TTS 托管服务并加载模型'
        : 'AI Stack is preparing the managed Qwen3-TTS service and loading the model';
    }
    return locale.value === 'zh-CN'
      ? '正在构建并启动专用模型运行时'
      : 'Building and starting the dedicated model runtime';
  }
  return '';
}

watch(activeTasks, (next) => {
  const observed = new Set(publishObservedTaskIds.value);
  for (const task of next) {
    if (isPublishDeploymentTask(task)) observed.add(task.id);
  }
  publishObservedTaskIds.value = [...observed];
}, { immediate: true });

export type PublishTaskFeedback = {
  task: TaskRecord;
  status: string;
  isLoading: boolean;
  progress: number;
  error: string;
  summary: string;
  modelName: string;
  modelPath: string;
  modelSize: string;
  runtimeTitle: string;
};

/** All publish tasks observed by this page, kept independently until their deployment card appears. */
export const publishTaskFeedbackCards = computed<PublishTaskFeedback[]>(() => {
  const observed = new Set(publishObservedTaskIds.value);
  const candidates = tasks.value.filter((task) =>
    isPublishDeploymentTask(task)
    && (activeTaskStatuses.has(task.status) || observed.has(task.id))
    && !taskRuntimeAlreadyListed(task)
  );
  if (
    publishOptimisticTask.value
    && !taskRuntimeAlreadyListed(publishOptimisticTask.value)
    && !candidates.some((task) => task.id === publishOptimisticTask.value?.id)
  ) candidates.push(publishOptimisticTask.value);

  const newestByTarget = new Map<string, TaskRecord>();
  for (const task of [...candidates].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    const key = publishTaskTargetKey(task);
    if (!newestByTarget.has(key)) newestByTarget.set(key, task);
  }

  return [...newestByTarget.values()]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((task) => {
      const metadata = task.metadata ?? {};
      const modelId = String(metadata.model_id ?? metadata.openai_model ?? '');
      const model = models.value.find((item) => item.id === modelId);
      const profileTitle = locale.value === 'zh-CN'
        ? metadata.profile_title_zh ?? metadata.profile_title
        : metadata.profile_title ?? metadata.profile_title_zh;
      return {
        task,
        status: task.status,
        isLoading: activeTaskStatuses.has(task.status),
        progress: taskProgress(task),
        error: publishTaskErrorText(task),
        summary: publishTaskSummary(task),
        modelName: model?.display_name || String(metadata.openai_model ?? metadata.model_id ?? '-'),
        modelPath: model ? shortModelPath(model.local.path) : String(metadata.model_id ?? '-'),
        modelSize: model ? formatBytes(model.local.size_bytes) : '-',
        runtimeTitle: String(profileTitle ?? metadata.service_type ?? model?.runtime.preferred ?? '-')
      };
    });
});

export const publishTaskFeedbackVisible = computed(() => publishTaskFeedbackCards.value.length > 0);
export const publishIsLoading = computed(() => publishStartPending.value || publishTaskFeedbackCards.value.some((item) => item.isLoading));
export const publishTaskStatus = computed(() => {
  if (publishStartPending.value) return 'queued';
  const cards = publishTaskFeedbackCards.value;
  return cards.find((item) => item.isLoading)?.status ?? cards.at(-1)?.status ?? '';
});
export const publishTaskError = computed(() => publishTaskFeedbackCards.value.at(-1)?.error ?? '');
export const publishLoadingProgress = computed(() => publishTaskFeedbackCards.value.at(-1)?.progress ?? 0);
export const publishLoadingSummary = computed(() => publishTaskFeedbackCards.value.at(-1)?.summary ?? '');
export const publishActiveBaseUrl = computed(() => String(publishActiveDeploymentTask.value?.metadata?.runtime_plan?.base_url ?? ''));

function trackPublishTask(task: TaskRecord | null | undefined) {
  if (!task?.id) return;
  publishTrackedTaskId.value = task.id;
  sessionStorage.setItem('publishTrackedTaskId', task.id);
  publishOptimisticTask.value = task;
  if (!publishObservedTaskIds.value.includes(task.id)) {
    publishObservedTaskIds.value = [...publishObservedTaskIds.value, task.id];
  }
}

function clearTrackedPublishTask() {
  publishTrackedTaskId.value = '';
  publishOptimisticTask.value = null;
  sessionStorage.removeItem('publishTrackedTaskId');
}

watch(deployModelId, (next, previous) => {
  if (previous && next !== previous && !activeTaskStatuses.has(publishActiveDeploymentTask.value?.status ?? '')) {
    clearTrackedPublishTask();
  }
});

watch(view, (next, previous) => {
  const task = publishActiveDeploymentTask.value;
  if (previous === 'load' && next !== 'load' && task && !activeTaskStatuses.has(task.status)) {
    clearTrackedPublishTask();
  }
});

/** 开发者日志面板内容（优先显示容器日志，其次任务日志） */
export const publishConsoleLog = computed(() =>
  (selectedLogContainer.value ? containerLog.value : taskLog.value)
  || (locale.value === 'zh-CN' ? '暂无开发日志输出。' : 'No developer logs yet.')
);

export function clearPublishLogs() {
  selectedLogContainer.value = '';
  containerLog.value = '';
  taskLog.value = '';
}

export async function openPublishTaskLog(taskId?: string) {
  const task = taskId
    ? tasks.value.find((item) => item.id === taskId) ?? (publishOptimisticTask.value?.id === taskId ? publishOptimisticTask.value : null)
    : publishActiveDeploymentTask.value;
  if (!task) return;
  selectedTaskId.value = task.id;
  await loadTaskLog(task.id);
  logCollapsed.value = false;
}

/** Remove a finished publish record from the loaded-model workspace without deleting model files. */
export async function dismissPublishTask(taskId: string) {
  const task = tasks.value.find((item) => item.id === taskId);
  if (!task || activeTaskStatuses.has(task.status)) return;

  await api('/tasks/' + encodeURIComponent(taskId), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete_files: false })
  });

  publishObservedTaskIds.value = publishObservedTaskIds.value.filter((id) => id !== taskId);
  if (publishTrackedTaskId.value === taskId) clearTrackedPublishTask();
  if (selectedTaskId.value === taskId) {
    selectedTaskId.value = '';
    taskLog.value = '';
    logCollapsed.value = true;
  }
  await refresh();
  message.success(locale.value === 'zh-CN' ? '失败记录已移除' : 'Failed record removed');
}

/** 模型信息行（用于 Info Tab 展示） */
export const publishModelInfoRows = computed(() => {
  const model = publishActiveModel.value;
  if (!model) return [];
  const quantization = _modelQuantization(model);
  const architecture = _modelArchitecture(model);
  const capabilities = _modelCapabilities(model);
  return [
    { label: 'Model', value: model.id },
    { label: 'File', value: shortModelPath(model.local.path) },
    { label: 'Format', value: modelFormatLabel(model.local.format) },
    { label: 'Quantization', value: quantization },
    { label: locale.value === 'zh-CN' ? '框架' : 'Framework', value: architecture },
    { label: 'Capabilities', value: capabilities.join(', ') },
    { label: 'Domain', value: capabilities[0] || 'Chat' },
    { label: 'Size on disk', value: formatBytes(model.local.size_bytes) }
  ];
});

// ── 模型选择弹窗 ─────────────────────────────────────────────────────────
export const loadModelModalOpen = ref(false);
export const loadModelSearch = ref('');
export const loadModelSort = ref<'recency' | 'size' | 'downloaded'>('recency');

/**
 * 候选模型列表（支持关键词搜索与多种排序方式）。
 * Candidate model list with keyword search and sort options.
 */
export const loadModelCandidateList = computed(() => {
  const term = loadModelSearch.value.trim().toLowerCase();
  let list = readyModelList.value.filter((model) => {
    if (!term) return true;
    const haystack = [model.id, model.display_name, model.local.path, model.local.format, modelFormatLabel(model.local.format)]
      .join(' ').toLowerCase();
    return haystack.includes(term);
  });
  if (loadModelSort.value === 'size')
    list = [...list].sort((a, b) => (b.local.size_bytes || 0) - (a.local.size_bytes || 0));
  else if (loadModelSort.value === 'downloaded')
    list = [...list].sort((a, b) => {
      const statusOrder: Record<string, number> = {
        ready: 0, downloaded: 0, downloading: 1,
        incomplete: 2, needs_review: 3, missing: 4
      };
      return (statusOrder[a.status.download] ?? 99) - (statusOrder[b.status.download] ?? 99);
    });
  return list;
});

/** 从弹窗中选择模型并关闭弹窗 */
export function selectModelFromModal(model: ModelRecord) {
  selectDeployModel(model);
  clearTrackedPublishTask();
  publishSelectedRuntimeKey.value = publishRuntimeOptions.value[0]?.key
    ?? (modelNeedsAudioRuntime(model) ? 'funasr-gateway' : selectedContainerKey.value);
  localStorage.setItem('publishSelectedRuntimeKey', publishSelectedRuntimeKey.value);
  deploymentPlanPreview.value = null;
  loadModelModalOpen.value = false;
  loadModelSearch.value = '';
}

// ── 部署计划预览 ─────────────────────────────────────────────────────────
export const deploymentPlanPreview = ref<any | null>(null);
export const deploymentPlanLoading = ref(false);

/** 预览部署运行计划（调用后端生成 stages） */
export async function previewDeploymentPlan() {
  const model = models.value.find((item) => item.id === deployModelId.value);
  const container = selectedContainer.value;
  if (!model || !container || !canDeployToSelected()) return;
  deploymentPlanLoading.value = true;
  try {
    const args = deploymentArgs();
    deploymentPlanPreview.value = await api<any>('/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: model.id,
        service_type: container.runtime,
        openai_model: deployOpenAiModel.value || model.id,
        args
      })
    });
    message.success(locale.value === 'zh-CN' ? '运行计划已生成' : 'Runtime plan ready');
  } catch (error) {
    deploymentPlanPreview.value = null;
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    deploymentPlanLoading.value = false;
  }
}

/** 根据服务类型推断期望的容器名称 */
function expectedContainerName(model: ModelRecord, serviceType: ServiceType): string {
  if (serviceType === 'vllm') return 'vllm_' + model.id.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/-/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, 48);
  if (serviceType === 'trtllm') return 'trtllm-service';
  return 'pytorch-service';
}

function beginPublishTask(model: ModelRecord, runtimeTitle: string, metadata: Record<string, unknown>) {
  clearTrackedPublishTask();
  publishStartPending.value = true;
  publishOptimisticTask.value = {
    id: 'pending_publish_' + Date.now(),
    type: 'deploy',
    status: 'queued',
    command: '',
    cwd: '',
    log_path: '',
    metadata: {
      model_id: model.id,
      openai_model: deployOpenAiModel.value || model.id,
      profile_title: runtimeTitle,
      profile_title_zh: runtimeTitle,
      ...metadata
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress_percent: 0
  };
}

function finishPendingPublishTask() {
  publishStartPending.value = false;
  if (publishOptimisticTask.value?.id.startsWith('pending_publish_')) publishOptimisticTask.value = null;
}

/** 部署模型到指定容器 */
export async function deployModelTo(model: ModelRecord, container: { key: string; runtime: string; name: string }) {
  selectedContainerKey.value = container.key;
  const serviceType = container.runtime as ServiceType;
  const openaiModel = deployOpenAiModel.value || model.id;
  const args = deploymentArgs();
  beginPublishTask(model, container.name || container.runtime, { service_type: serviceType, args });
  try {
    const payload = await api<any>('/deployments/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: model.id,
        service_type: serviceType,
        openai_model: openaiModel,
        args
      })
    });
    if (payload.status === 'already_running') message.info(t('alreadyRunning'));
    if (payload.task?.id) {
      trackPublishTask(payload.task);
      selectedTaskId.value = payload.task.id;
      taskLog.value = '';
      await loadTaskLog(payload.task.id);
      message.info(t('deploymentTaskStarted'));
    }
    const targetName = payload.target_container_name || payload.container_name
      || expectedContainerName(model, serviceType);
    await refresh();
    const refreshedTarget = containers.value.find(
      (item: any) => item.name === targetName || item.instance_name === targetName
    );
    if (refreshedTarget?.state === 'running')
      await loadContainerLogs(actionTargetName(refreshedTarget));
    else
      selectedLogContainer.value = targetName;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    finishPendingPublishTask();
  }
}

/** 部署当前选中的模型 */
export async function deploySelectedModel() {
  const model = models.value.find((item) => item.id === deployModelId.value);
  const container = selectedContainer.value;
  if (!model || !container || !canDeployToSelected()) return;
  deploymentPlanPreview.value = null;
  await deployModelTo(model, container);
}

export async function activateSelectedPublishRuntime() {
  const runtime = publishSelectedRuntime.value;
  if (!runtime) return;
  if (runtime.profile_id) {
    const model = publishActiveModel.value;
    if (!model) return;
    beginPublishTask(model, runtime.title, {
      action: 'start_custom_profile',
      profile_id: runtime.profile_id,
      container_name: runtime.existing_container_name ?? ''
    });
    taskLog.value = '';
    containerLog.value = '';
    try {
      const payload = await api<any>('/containers/custom/profiles/' + encodeURIComponent(runtime.profile_id) + '/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: model.id,
          openai_model: deployOpenAiModel.value || model.id,
          ...(deployGpuDeviceIds.value.length ? { gpu_device_ids: [...deployGpuDeviceIds.value] } : {})
        })
      });
      if (payload.task?.id) {
        trackPublishTask(payload.task);
        selectedTaskId.value = payload.task.id;
        taskLog.value = '';
        await loadTaskLog(payload.task.id);
      }
      await refresh();
      message.info(locale.value === 'zh-CN'
        ? (runtime.mode === 'managed' ? 'AI Stack 托管发布任务已创建，进度显示在上方。' : '专用运行时任务已启动，正在上方显示进度。')
        : (runtime.mode === 'managed' ? 'AI Stack managed publish task created. Progress is shown above.' : 'Dedicated runtime task started. Progress is shown above.'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      finishPendingPublishTask();
    }
    return;
  }
  if (runtime.existing_container_name) {
    if (runtime.state === 'running') {
      message.success(runtime.mode === 'shared'
        ? (locale.value === 'zh-CN' ? '已选择共享服务，不会创建新容器。' : 'Shared service selected. No new container was created.')
        : (locale.value === 'zh-CN' ? '已选择现有专用实例。' : 'Existing dedicated instance selected.'));
      return;
    }
    try {
      await api('/containers/' + encodeURIComponent(runtime.existing_container_name) + '/start', { method: 'POST' });
      await refresh();
      message.success(runtime.mode === 'shared' ? (locale.value === 'zh-CN' ? '共享服务已启动' : 'Shared service started') : (locale.value === 'zh-CN' ? '专用实例已启动' : 'Dedicated instance started'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (runtime.key === 'funasr-gateway') {
    view.value = 'services';
    message.info(locale.value === 'zh-CN'
      ? '没有找到可复用的 FunASR Gateway 容器，请先检查已有容器的适用模型配置。'
      : 'No reusable FunASR Gateway container was found. Check the suitable-model settings on existing containers.');
    return;
  }
  await deploySelectedModel();
}

/** 卸载当前选中的部署 */
export async function unloadDeployment(deployment: DeploymentRecord | null | undefined) {
  if (!deployment || deployment.status !== 'running') return;
  await api('/deployments/' + encodeURIComponent(deployment.deployment_id) + '/stop', { method: 'POST' });
  await refresh();
  containerLog.value = '';
  selectedLogContainer.value = '';
}

export async function unloadSelectedDeployment() {
  await unloadDeployment(selectedDeployment.value);
}

// ── 本地模型辅助函数（避免跨 composable 循环依赖）───────────────────────

function _modelCapabilities(model: ModelRecord): string[] {
  const text = [model.id, model.display_name, model.local.format,
    model.runtime.preferred, ...(model.runtime.supported ?? [])].join(' ').toLowerCase();
  const caps = new Set<string>();
  if (/(embed|bge|e5|gte|rerank)/.test(text)) caps.add('Embedding');
  if (/(vision|vlm|ocr|document|image[-_ ]?to[-_ ]?text|qwen[-_ ]?vl|llava|internvl|minicpm[-_ ]?v|deepseek[-_ ]?vl|glm[-_ ]?4v)/.test(text)) caps.add('Vision');
  if (/(asr|whisper|funasr|speech)/.test(text)) caps.add('ASR');
  if (/(tts|cosyvoice|audio)/.test(text)) caps.add('TTS');
  if (!caps.size || /(chat|instruct|llm|qwen|llama|mistral|glm|deepseek)/.test(text)) caps.add('Chat');
  return [...caps];
}

function _modelArchitecture(model: ModelRecord): string {
  const format = model.local.format?.toLowerCase?.() || '';
  if (format === 'qwen3_tts' || model.runtime.preferred === 'qwen3-tts') return 'Qwen3-TTS';
  if (['hf_safetensors', 'hf_bin', 'hf_partial'].includes(format)) return 'Transformers';
  if (format.startsWith('audio') || model.runtime.preferred === 'funasr-gateway') return 'FunASR Gateway';
  if (model.runtime.preferred === 'pytorch') return 'PyTorch';
  if (format === 'gguf') return 'GGUF';
  if (format === 'trtllm_engine') return 'TensorRT-LLM';
  if (/^(transformers|pytorch|gguf|tensorrt-llm)$/i.test(model.local.architecture || '')) {
    return model.local.architecture || '-';
  }
  const text = [model.id, model.display_name, model.local.path, model.local.architecture].join('/').toLowerCase();
  if (/(cosyvoice|cosy-voice|funasr|fun-asr|sensevoice|sense-voice|whisper)/.test(text)) return 'PyTorch';
  if (/(qwen|llama|mistral|mixtral|gemma|deepseek|chatglm|glm|baichuan|\byi\b|yi-|phi|internvl|internlm|llava|minicpm|gpt-neox|gptj|gpt-j|gpt2|gpt-2|bert)/.test(text)) return 'Transformers';
  return '-';
}

function _modelQuantization(model: ModelRecord): string {
  const fromScan = model.local.quantization;
  if (fromScan) {
    const normalized = fromScan.toUpperCase().replace('4BIT', '4-bit').replace('8BIT', '8-bit');
    if (/^(F16|F32|FP16|FP32|BF16)$/.test(fromScan.toUpperCase())) {
      return normalized;
    }
    return locale.value === 'zh-CN' ? `${normalized} 量化` : `${normalized} quantized`;
  }
  const text = [model.id, model.display_name, model.local.path, model.local.format, modelFormatLabel(model.local.format)].join(' ');
  const matched = text.match(/\b(I?Q\d(?:_[A-Z0-9]+)*|TQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|INT[48]|FP(?:16|32)|BF16|F(?:16|32)|4BIT|8BIT|NF4|GPTQ|AWQ)\b/i);
  if (!matched) return '-';
  const normalized = matched[1].toUpperCase().replace('4BIT', '4-bit').replace('8BIT', '8-bit');
  if (/^(F16|F32|FP16|FP32|BF16)$/.test(matched[1].toUpperCase())) {
    return normalized;
  }
  return locale.value === 'zh-CN' ? `${normalized} 量化` : `${normalized} quantized`;
}
