/**
 * @author Amuin
 * @created 2026-06-25
 * @description 全局状态管理 & 共享逻辑 — 模块级 ref 单例，所有页面/组件共享同一实例。
 *              Global state & shared logic — module-level ref singleton shared across all pages/components.
 */
import { computed, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import type {
  Locale, ThemeMode, View, ServiceType, ModelRecord, DeploymentRecord, TaskRecord,
  ContainerRecord, ImportPreview, SystemCheck, NetworkSettings, ProxySettings, WorkbenchSettings, RuntimeHint
} from '../types';
import { messages, statusCopy } from '../locales';

/* ── reactive state ──────────────────────────── */
export const locale = ref<Locale>((localStorage.getItem('locale') as Locale) || 'zh-CN');
export const themeMode = ref<ThemeMode>((localStorage.getItem('themeMode') as ThemeMode) || 'light');
document.documentElement.dataset.theme = themeMode.value;
export const view = ref<View>('dashboard');
export const sidebarCollapsed = ref(false);
export const rightPanelCollapsed = ref(false);

export const models = ref<ModelRecord[]>([]);
export const modelCatalogLoading = ref(true);
let latestModelCatalogRequest = 0;
export const deployments = ref<DeploymentRecord[]>([]);
export const tasks = ref<TaskRecord[]>([]);
export const containers = ref<ContainerRecord[]>([]);
export const system = ref<SystemCheck | null>(null);
export const network = ref<NetworkSettings | null>(null);
export const proxySettings = ref<ProxySettings | null>(null);
export const workbenchSettings = ref<WorkbenchSettings | null>(null);
export const managementPort = ref(8888);

export const modelUrl = ref('');
export const importMessage = ref('');
export const importPreview = ref<ImportPreview | null>(null);

export const deployModelId = ref(localStorage.getItem('deployModelId') || '');
export const selectedContainerKey = ref('vllm');
export const selectedTaskId = ref('');
export const selectedDownloadLogId = ref('');
export const selectedLogContainer = ref('');
export const taskLog = ref('');
export const containerLog = ref('');
export const networkMessage = ref('');

export const customComponents = ref<string[]>(['pytorch']);
export const customMode = ref('resident');
export const customRestartPolicy = ref('unless-stopped');
export const customAutoRestart = ref(true);
export const customName = ref('');
export const customImage = ref('nvcr.io/nvidia/pytorch:25.04-py3');
export const customModalOpen = ref(false);
export const customTab = ref<'basics' | 'components' | 'dockerfile' | 'compose'>('basics');
export const composeYaml = ref('');
export const composeValidating = ref(false);
export const composeValidationResult = ref<{ valid: boolean; errors?: string; normalized?: string } | null>(null);
export const logCollapsed = ref(true);
export const modelListDrawerOpen = ref(false);

export const deployOpenAiModel = ref('');
export const deployContextLength = ref(4096);
export const deployGpuUtil = ref(30);
export const deployMaxSeqs = ref(4);
export const deployTensorParallel = ref(1);
export const deployGpuDeviceIds = ref<string[]>(readStoredGpuDeviceIds());
export const deployKvCacheDtype = ref('auto');
export const deployEnableAutoToolChoice = ref(false);
export const deployEnableThinking = ref(true);
export const deployToolCallParser = ref('auto');
export const deployReasoningParser = ref('auto');
export const deploySwapSpace = ref(4);
export const trtMaxBatchSize = ref(8);
export const trtMaxNumTokens = ref(4096);
export const trtKvCacheFraction = ref(0.9);
export const trtTpSize = ref(1);
export const trtPpSize = ref(1);

/* ── i18n helpers ─────────────────────────────── */
export function t(key: string): string {
  return (messages[locale.value] as Record<string, string>)[key] ?? key;
}

export function statusText(status: string): string {
  return statusCopy[locale.value][status] ?? status;
}

/* ── computed ─────────────────────────────────── */
export const readyModelList = computed(() => models.value.filter((model) => model.status.download === 'ready'));
export const modelLibraryList = computed(() => models.value);
export const readyModels = computed(() => readyModelList.value.length);
export const runtimeContainers = computed(() => containers.value.filter((item) =>
  item.category === 'system' || (!item.category && item.runtime !== 'custom')
));
export const runningServices = computed(() => containers.value.filter((item) => item.state === 'running').length);
export const runningDeployments = computed(() => deployments.value.filter((item) => item.status === 'running'));

const taskCreatedTimeValue = (task: TaskRecord) => {
  const timestamp = Date.parse(task.created_at || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
};
const compareTasksByRecentTime = (a: TaskRecord, b: TaskRecord) =>
  taskCreatedTimeValue(b) - taskCreatedTimeValue(a)
  || b.id.localeCompare(a.id);

const finishedDownloadStatuses = new Set(['succeeded', 'failed', 'canceled']);
const collapsibleFinishedDownloadStatuses = new Set(['succeeded', 'canceled']);

function finishedDownloadRank(status: string): number {
  if (status === 'succeeded') return 3;
  if (status === 'failed') return 2;
  if (status === 'canceled') return 1;
  return 0;
}

function preferFinishedDownload(candidate: TaskRecord, current: TaskRecord): boolean {
  const recentDiff = compareTasksByRecentTime(candidate, current);
  if (recentDiff !== 0) return recentDiff < 0;
  const rankDiff = finishedDownloadRank(candidate.status) - finishedDownloadRank(current.status);
  return rankDiff > 0;
}

function downloadTaskDisplayKey(task: TaskRecord): string {
  return [
    task.metadata?.target_path,
    task.metadata?.provider,
    task.metadata?.repo_id,
    task.metadata?.alias,
    task.metadata?.model_id
  ].filter(Boolean).join(':') || task.id;
}

export const visibleTasks = computed(() => {
  const latestFinishedDownload = new Map<string, string>();
  for (const task of tasks.value) {
    if (task.type !== 'download' || !collapsibleFinishedDownloadStatuses.has(task.status)) continue;
    const key = downloadTaskDisplayKey(task);
    const currentId = latestFinishedDownload.get(key);
    const current = currentId ? tasks.value.find((item) => item.id === currentId) : undefined;
    if (!current || preferFinishedDownload(task, current)) latestFinishedDownload.set(key, task.id);
  }

  const seenDeploy = new Set<string>();
  return [...tasks.value]
    .sort(compareTasksByRecentTime)
    .filter((task) => {
      if (task.type === 'download' && task.status === 'failed') return true;
      if (task.type === 'download' && collapsibleFinishedDownloadStatuses.has(task.status)) {
        return latestFinishedDownload.get(downloadTaskDisplayKey(task)) === task.id;
      }
      if (task.type !== 'deploy' || task.status !== 'succeeded') return true;
      const key = ['deploy', task.metadata?.model_id, task.metadata?.service_type, task.metadata?.openai_model].join(':');
      if (seenDeploy.has(key)) return false;
      seenDeploy.add(key);
      return true;
    });
});

export const dashboardTasks = computed(() => visibleTasks.value);
export const activeTasks = computed(() => tasks.value.filter((task) => ['queued', 'running', 'paused', 'canceling'].includes(task.status)));
export const downloadTasks = computed(() => tasks.value
  .filter((task) => task.type === 'download' && ['queued', 'running', 'paused', 'canceling'].includes(task.status))
  .sort(compareTasksByRecentTime)
);
export const customContainers = computed(() => containers.value.filter((item) =>
  item.category === 'custom'
  || (!item.category && item.runtime === 'custom' && item.name.startsWith('custom_'))
));
export const modelInstanceContainers = computed(() => containers.value.filter((item) =>
  item.category === 'model-instance'
  || (!item.category && item.runtime === 'custom' && !item.name.startsWith('custom_'))
));
export const composePlaceholder = computed(() => locale.value === 'zh-CN'
  ? `services:\n  my-service:\n    image: nvidia/cuda:12.4.0-runtime-ubuntu22.04\n    ports:\n      - "33000:8000"\n    command: sleep infinity`
  : `services:\n  my-service:\n    image: nvidia/cuda:12.4.0-runtime-ubuntu22.04\n    ports:\n      - "33000:8000"\n    command: sleep infinity`
);

export const selectedContainer = computed(() => {
  const matched = containers.value.find((item) => item.key === selectedContainerKey.value)
    ?? containers.value.find((item) => item.runtime !== 'custom')
    ?? containers.value[0];
  return matched;
});
export const selectedTask = computed(() => tasks.value.find((item) => item.id === selectedTaskId.value));
const memoryUsed = computed(() => Math.max(0, (system.value?.device?.memory?.total_bytes ?? 0) - (system.value?.device?.memory?.free_bytes ?? 0)));
export const memoryPercent = computed(() => percent(memoryUsed.value, system.value?.device?.memory?.total_bytes ?? 0));
export const cpuPercent = computed(() => Math.round(system.value?.status?.cpu_load_percent ?? 0));
const storageVolume = computed(() => system.value?.device?.storage?.volumes?.[0]);
export const storagePercent = computed(() => Math.round(storageVolume.value?.used_percent ?? 0));
export const gpuSummary = computed(() => {
  const devices = system.value?.device?.gpu?.devices ?? [];
  if (!system.value?.device?.gpu?.available) return system.value?.device?.gpu?.detail ?? t('unavailable');
  return devices.map((device) => String(device.name ?? device.id ?? 'NVIDIA GPU')).join(', ') || 'NVIDIA';
});
export const gpuPercent = computed(() => {
  const devices = system.value?.device?.gpu?.devices ?? [];
  const values = devices
    .map((device) => Number(device.utilization_gpu_percent))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
});

export const portRows = computed(() => Object.entries(system.value?.service_ports ?? {}).map(([name, info]) => ({ name, ...info })));
export const selectedDeployModel = computed(() => models.value.find((item) => item.id === deployModelId.value));
export const containerOptions = computed(() => {
  const model = selectedDeployModel.value;
  const allowed = model ? new Set((['vllm', 'trtllm', 'pytorch'] as ServiceType[]).filter((service) => model.compatibility[service]?.status !== 'unsupported')) : null;
  return containers.value
    .filter((item) => (item.category === 'system' || (!item.category && item.runtime !== 'custom')) && (!allowed || allowed.has(item.runtime as ServiceType)))
    .map((item) => ({ label: item.title + ' · ' + (item.state === 'missing' ? containerStateText(item) : item.name), value: item.key }));
});
export const modelOptions = computed(() => readyModelList.value.map((model) => ({ label: model.display_name, value: model.id })));
export const selectedDeployment = computed(() => {
  const container = selectedContainer.value;
  if (!container) return undefined;
  const modelId = deployModelId.value;
  if (modelId) {
    return runningDeployments.value.find((item) =>
      item.service_type === container.runtime &&
      (item.model_id === modelId || item.openai_models.includes(modelId))
    );
  }
  return runningDeployments.value.find((item) => item.service_type === container.runtime);
});
export const activeInferenceDeployments = computed(() => runningDeployments.value);
export const activeContainerCount = computed(() => containers.value.filter((item) => item.state === 'running').length);
export const servingModelCount = computed(() => runningDeployments.value.length);
export const createdContainerCount = computed(() => runtimeContainers.value.length);
export const managementHost = computed(() => {
  if (!network.value?.lan_access_enabled) return 'localhost';
  const lanAddr = system.value?.lan_addresses?.[0];
  if (lanAddr) return lanAddr;
  const host = window.location.hostname || '';
  if (host && !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return host;
  return host || 'localhost';
});
export const consoleAddress = computed(() => 'http://' + managementHost.value + ':' + (workbenchSettings.value?.active_management_port ?? 8888));
export const modelListSummaryUrl = computed(() => consoleAddress.value + '/v1/models');
export const publishedModelRows = computed(() => runningDeployments.value.flatMap((deployment) => {
  const names = deployment.openai_models.length ? deployment.openai_models : [deployment.runtime];
  return names.map((name) => ({
    key: deployment.deployment_id + ':' + name,
    model_name: name,
    address: inferenceEndpoint(deployment),
    call_id: name
  }));
}));
export const publicHost = computed(() => {
  if (network.value?.lan_access_enabled) {
    const lanAddr = system.value?.lan_addresses?.[0];
    if (lanAddr) return lanAddr;
  }
  const host = window.location.hostname || 'localhost';
  if (host && !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return host;
  return system.value?.lan_addresses?.[0] || host || 'localhost';
});
export const backendOrigin = computed(() => {
  const fallback = 'http://' + publicHost.value + ':8000';
  const raw = system.value?.backend_url || fallback;
  try {
    const url = new URL(raw, window.location.origin);
    if (network.value?.lan_access_enabled && ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) {
      url.hostname = publicHost.value;
    }
    return url.origin;
  } catch {
    return fallback;
  }
});
export const backendOpenAiBaseUrl = computed(() => backendOrigin.value + '/v1');
const gpuCount = computed(() => Math.max(1, system.value?.device?.gpu?.devices?.length ?? 1));
export const gpuDeviceOptions = computed(() => (system.value?.device?.gpu?.devices ?? []).map((device, fallbackIndex) => {
  const index = Number.isInteger(Number(device.index)) ? Number(device.index) : fallbackIndex;
  const id = String(device.uuid || index);
  const totalMiB = device.memory_total_mib !== null && device.memory_total_mib !== undefined ? Number(device.memory_total_mib) : NaN;
  const usedMiB = device.memory_used_mib !== null && device.memory_used_mib !== undefined ? Number(device.memory_used_mib) : NaN;
  const freeMiB = device.memory_free_mib !== null && device.memory_free_mib !== undefined && Number.isFinite(Number(device.memory_free_mib))
    ? Number(device.memory_free_mib)
    : Number.isFinite(totalMiB) && Number.isFinite(usedMiB) ? Math.max(0, totalMiB - usedMiB) : null;
  return {
    value: id,
    index,
    uuid: String(device.uuid || ''),
    name: String(device.name || 'NVIDIA GPU'),
    freeMiB,
    totalMiB: Number.isFinite(totalMiB) ? totalMiB : null,
    utilization: Number.isFinite(Number(device.utilization_gpu_percent)) ? Number(device.utilization_gpu_percent) : null
  };
}));
export const selectedGpuCount = computed(() => Math.max(1, deployGpuDeviceIds.value.length));
export const contextLimit = computed(() => selectedDeployModel.value?.inference?.context_length ?? { min: 512, max: 4096, default: 4096, step: 512, source: 'default' });
export const tensorParallelLimit = computed(() => Math.max(1, Math.min(16, deployGpuDeviceIds.value.length || gpuCount.value)));
const selectedDeployModelSearchText = computed(() => {
  const model = selectedDeployModel.value;
  return [
    model?.id,
    model?.display_name,
    model?.local.architecture,
    model?.runtime.preferred,
    ...(model?.capabilities ?? [])
  ].filter(Boolean).join(' ').toLowerCase();
});
export const recommendedToolCallParser = computed(() => {
  const text = selectedDeployModelSearchText.value;
  if (/qwen[-_ ]?3(?:[._-]?(?:5|6|8))?|qwen3[-_ ]?coder|omnicoder/.test(text)) return 'qwen3_coder';
  return 'hermes';
});
export const recommendedReasoningParser = computed(() => /qwen/.test(selectedDeployModelSearchText.value) ? 'qwen3' : '');
export const effectiveToolCallParser = computed(() => deployToolCallParser.value === 'auto'
  ? recommendedToolCallParser.value
  : deployToolCallParser.value);
export const effectiveReasoningParser = computed(() => deployReasoningParser.value === 'auto'
  ? recommendedReasoningParser.value
  : deployReasoningParser.value);

watch(gpuDeviceOptions, (options) => {
  if (!options.length) return;
  const available = new Set(options.map((option) => option.value));
  const valid = deployGpuDeviceIds.value.filter((id) => available.has(id));
  deployGpuDeviceIds.value = valid.length ? valid : [options[0].value];
  syncGpuParallelism();
}, { immediate: true });

watch(deployGpuDeviceIds, (ids) => {
  localStorage.setItem('deployGpuDeviceIds', JSON.stringify(ids));
}, { deep: true });

/* ── pure helpers ──────────────────────────────── */
export function percent(used: number, total: number) { return total ? Math.round((used / total) * 100) : 0; }
export function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
export function formatDuration(seconds = 0) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return days ? days + 'd ' + hours + 'h' : hours + 'h ' + minutes + 'm'; }
export function formatBytes(value: number) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return (value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index]; }
export function modelFormatLabel(format?: string | null): string {
  const normalized = String(format ?? '').trim().toLowerCase();
  if (!normalized) return '-';
  if (normalized === 'hf_safetensors') return '.safetensors';
  if (normalized === 'hf_bin') return '.bin';
  if (normalized === 'hf_partial') return '.safetensors / .bin';
  if (normalized === 'gguf') return '.gguf';
  if (normalized === 'trtllm_engine') return '.engine';
  if (normalized === 'audio_onnx_pt') return '.onnx / .pt';
  if (normalized === 'audio_onnx') return '.onnx';
  if (normalized === 'audio_pt') return '.pt';
  if (normalized === 'qwen3_tts') return '.safetensors';
  if (normalized.startsWith('.')) return normalized;
  return normalized;
}
export function badgeColor(status: string) { if (['compatible', 'ready', 'configured', 'running', 'succeeded'].includes(status)) return 'green'; if (['unsupported', 'incomplete', 'failed', 'missing', 'stopped', 'canceled'].includes(status)) return 'red'; if (['paused', 'canceling'].includes(status)) return 'blue'; return 'gold'; }
export function shortModelPath(path: string) { const marker = '/models/'; const index = path.lastIndexOf(marker); return index >= 0 ? '…' + path.slice(index) : path; }

export function publicBaseUrl(deployment: DeploymentRecord) { const suffix = ['vllm', 'trtllm'].includes(deployment.service_type) ? '/v1' : ''; return 'http://' + publicHost.value + ':' + deployment.public_port + suffix; }
export type DeploymentApiKind = 'embedding' | 'rerank' | 'document' | 'ground' | 'transcription' | 'speech' | 'chat';

/** Aggregated model discovery endpoint exposed by the management API. */
export function modelEndpoint(_deployment?: DeploymentRecord) { return modelListSummaryUrl.value; }

/** Runtime-local model endpoint, retained for diagnostics rather than user-facing discovery. */
export function runtimeModelEndpoint(deployment: DeploymentRecord) {
  return publicBaseUrl(deployment) + (['vllm', 'trtllm'].includes(deployment.service_type) ? '/models' : '/v1/models');
}

export function deploymentApiKind(deployment: DeploymentRecord): DeploymentApiKind {
  const declaredKind = deployment.suite?.primary_endpoint?.kind;
  if (declaredKind && ['embedding', 'rerank', 'document', 'ground', 'transcription', 'speech', 'chat'].includes(declaredKind)) return declaredKind as DeploymentApiKind;
  const model = models.value.find((item) =>
    item.id === deployment.model_id || deployment.openai_models.includes(item.id)
  );
  const searchable = [
    deployment.runtime,
    deployment.container_name,
    deployment.model_id,
    ...deployment.openai_models,
    model?.display_name,
    ...(model?.capabilities || []),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/mineru|document[-_ ]?(parse|parser|analysis)/.test(searchable)) return 'document';
  if (/locate[-_ ]?anything|visual[-_ ]?ground/.test(searchable)) return 'ground';
  if (/rerank|reranker|cross[-_ ]?encoder/.test(searchable)) return 'rerank';
  if (/embed|embedding|embeddings|feature[-_ ]?extraction/.test(searchable)) return 'embedding';
  if (/qwen3[-_ ]?tts|text[-_ ]?to[-_ ]?speech/.test(searchable)) return 'speech';
  if (/funasr[-_ ]?gateway/.test(searchable)) return 'transcription';
  return 'chat';
}

export function inferenceEndpoint(deployment: DeploymentRecord) {
  const baseUrl = publicBaseUrl(deployment);
  const declaredPath = deployment.suite?.primary_endpoint?.path;
  if (declaredPath) return baseUrl.replace(/\/$/, '') + (declaredPath.startsWith('/') ? declaredPath : '/' + declaredPath);
  const apiRoot = ['vllm', 'trtllm'].includes(deployment.service_type) ? baseUrl : baseUrl + '/v1';
  const kind = deploymentApiKind(deployment);
  if (kind === 'embedding') return apiRoot + '/embeddings';
  if (kind === 'rerank') return apiRoot + '/score';
  if (kind === 'document') return apiRoot + '/documents/parse';
  if (kind === 'ground') return apiRoot + '/ground';
  if (kind === 'speech') return apiRoot + '/audio/speech';
  if (kind === 'transcription') return baseUrl + '/transcription/transcribe';
  return apiRoot + '/chat/completions';
}

export function inferenceEndpointLabel(deployment: DeploymentRecord) {
  const kind = deploymentApiKind(deployment);
  if (kind === 'embedding') return 'Embedding API';
  if (kind === 'rerank') return 'Rerank Score API';
  if (kind === 'document') return 'Document Parse API';
  if (kind === 'ground') return 'Visual Grounding API';
  if (kind === 'speech') return 'Speech API';
  if (kind === 'transcription') return 'Transcription API';
  return 'Chat API';
}

export function chatEndpoint(deployment: DeploymentRecord) { return publicBaseUrl(deployment) + (['vllm', 'trtllm'].includes(deployment.service_type) ? '/chat/completions' : '/v1/chat/completions'); }

export function supportedContainers(model: ModelRecord, containerList: ContainerRecord[]) {
  return (['vllm', 'trtllm', 'pytorch'] as ServiceType[])
    .filter((service) => model.compatibility[service]?.status !== 'unsupported')
    .map((service) => ({ service, container: containerList.find((item) => item.runtime === service) }));
}

export function containerStateText(container?: ContainerRecord): string {
  if (!container) return t('unavailable');
  return ['vllm', 'trtllm', 'pytorch'].includes(container.runtime) && container.state === 'missing' ? t('disabled') : statusText(container.state);
}

export function containerStateColor(container?: ContainerRecord): string {
  if (!container) return 'default';
  return ['vllm', 'trtllm', 'pytorch'].includes(container.runtime) && container.state === 'missing' ? 'gold' : badgeColor(container.state);
}

export function modelStatusHelp(model: ModelRecord): string {
  if (model.status.download === 'needs_review') return t('needsReviewHelp');
  if (model.status.download === 'unsupported') return t('unsupportedHelp');
  if (model.status.download === 'incomplete') return t('incompleteHelp');
  return '';
}

export function modelAuditSummary(model: ModelRecord): string {
  const issue = model.audit?.issues?.find((item) => item.severity === 'error') ?? model.audit?.issues?.[0];
  const recommendation = model.audit?.recommendations?.find((item) => item.status === 'compatible') ?? model.audit?.recommendations?.[0];
  const memory = model.audit?.gpu_memory;
  if (issue) return issue.message;
  if (memory && ['tight', 'insufficient'].includes(memory.status)) return memory.reason;
  if (recommendation) return recommendation.runtime + ': ' + recommendation.reason;
  return '';
}

export function taskProgress(task: TaskRecord): number {
  const planProgress = task.metadata?.runtime_plan?.progress_percent;
  if (typeof planProgress === 'number') return clamp(Math.round(planProgress), 0, 100);
  if (typeof task.progress_percent === 'number') return task.progress_percent;
  if (task.type === 'deploy') {
    const stage = String(task.metadata?.runtime_plan?.current_stage ?? '');
    const status = stage ? taskRuntimePlanStageStatus(task, stage) : task.status;
    const runningProgress: Record<string, number> = { prepare: 10, pull: 30, start: 55, load: 82, health: 96 };
    const succeededProgress: Record<string, number> = { prepare: 20, pull: 45, start: 70, load: 92, health: 100 };
    if (task.status === 'succeeded') return 100;
    if (task.status === 'failed' || task.status === 'canceled') return 100;
    if (status === 'succeeded') return succeededProgress[stage] ?? 100;
    if (status === 'running') return runningProgress[stage] ?? 5;
  }
  if (task.status === 'succeeded') return 100;
  if (task.status === 'failed' || task.status === 'canceled') return 100;
  if (task.status === 'running') return 5;
  if (task.status === 'queued') return 0;
  return 0;
}

export function taskTypeText(type: string): string { return t('task' + type.slice(0, 1).toUpperCase() + type.slice(1)); }
export function runtimeHintColor(status: string): string { if (status === 'compatible') return 'green'; if (status === 'possible' || status === 'external') return 'gold'; return 'red'; }
export function taskAlias(task: TaskRecord): string { return String(task.metadata?.alias ?? task.metadata?.model_id ?? task.metadata?.repo_id ?? task.id); }
export function taskDisplayTitle(task: TaskRecord): string {
  const action = String(task.metadata?.action ?? '');
  const model = String(task.metadata?.model_id ?? task.metadata?.openai_model ?? taskAlias(task));
  if (task.type === 'download') return (locale.value === 'zh-CN' ? '下载模型' : 'Download model') + ' · ' + model;
  if (task.type === 'deploy') return (locale.value === 'zh-CN' ? '部署模型' : 'Deploy model') + ' · ' + model;
  if (action === 'start_custom_profile') return (locale.value === 'zh-CN' ? '部署模型' : 'Deploy model') + ' · ' + model;
  const target = String((locale.value === 'zh-CN' ? task.metadata?.profile_title_zh : task.metadata?.profile_title) ?? task.metadata?.profile_id ?? task.metadata?.key ?? task.metadata?.name ?? task.id);
  const labels: Record<string, string> = locale.value === 'zh-CN' ? { build_custom_image: '构建运行时', pull_image: '拉取运行时镜像', test_image: '测试运行时' } : { build_custom_image: 'Build runtime', pull_image: 'Pull runtime image', test_image: 'Test runtime' };
  return (labels[action] ?? taskTypeText(task.type)) + ' · ' + target;
}

export function taskCreatedAtText(task: TaskRecord): string {
  const date = new Date(task.created_at);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
export function taskRuntimeHints(task: TaskRecord): RuntimeHint[] { const hints = task.metadata?.runtime_hints; return Array.isArray(hints) ? hints as RuntimeHint[] : []; }
export function taskRuntimePlanStages(task: TaskRecord) {
  const stages = task.metadata?.runtime_plan?.stages;
  return Array.isArray(stages) ? stages : [];
}
export function taskRuntimePlanStageStatus(task: TaskRecord, stageId: string): string {
  return task.metadata?.runtime_plan?.stage_statuses?.[stageId] ?? (task.metadata?.runtime_plan?.current_stage === stageId ? 'running' : 'pending');
}
export function taskRuntimePlanStageColor(task: TaskRecord, stageId: string): string {
  const status = taskRuntimePlanStageStatus(task, stageId);
  if (status === 'succeeded') return 'green';
  if (status === 'running') return 'blue';
  if (status === 'failed') return 'red';
  return 'default';
}
export function taskRuntimePlanSummary(task: TaskRecord): string {
  const plan = task.metadata?.runtime_plan;
  if (!plan) return '';
  const stages = taskRuntimePlanStages(task);
  const currentStage = String(plan.current_stage ?? '');
  const current = currentStage ? stages.find((stage) => stage.id === currentStage) : undefined;
  const currentStatus = current ? taskRuntimePlanStageStatus(task, current.id) : '';
  if (currentStatus === 'running') {
    const zh = locale.value === 'zh-CN';
    if (currentStage === 'start') return zh ? '正在启动运行时 · API 尚不可用' : 'Starting runtime · API is not available yet';
    if (currentStage === 'load') return zh ? '正在加载模型权重 · API 尚不可用' : 'Loading model weights · API is not available yet';
    if (currentStage === 'health') return zh ? '模型已加载，正在验证 API · 尚未发布' : 'Model loaded; validating API · Not published yet';
  }
  const stageText = current ? current.label + ': ' + statusText(taskRuntimePlanStageStatus(task, current.id)) : stages.length ? stages.map((stage) => stage.label).join(' / ') : '';
  const ready = task.status === 'succeeded' || plan.stage_statuses?.health === 'succeeded';
  const target = ready ? String(plan.base_url ?? plan.health_url ?? '') : '';
  return [stageText, target].filter(Boolean).join(' · ');
}
export function taskTarget(task: TaskRecord): string { return String(task.metadata?.target_path ?? task.cwd); }

export function taskFileSummary(task: TaskRecord): string {
  const files = task.model_files ?? [];
  if (!files.length) return '';
  const counts = files.reduce<Record<string, number>>((acc, file) => {
    acc[file.status] = (acc[file.status] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['downloading', 'downloaded', 'failed', 'canceled', 'planned'];
  return order.filter((status) => counts[status]).map((status) => statusText(status) + ' ' + counts[status]).join(' · ');
}


function taskFileDetailLines(task: TaskRecord, limit = 5): string[] {
  const files = (task.model_files ?? [])
    .filter((file) => file.relative_path !== '.')
    .slice()
    .sort((a, b) => String(a.relative_path).localeCompare(String(b.relative_path)));
  if (!files.length) return [];
  const compactPath = (path: string) => path.replace(/^\.temp\//, '.temp/');
  const head = files.slice(0, limit).map((file) => {
    const size = typeof file.downloaded_bytes === 'number' && file.downloaded_bytes > 0 ? ' · ' + formatBytes(file.downloaded_bytes) : '';
    return '  - ' + compactPath(file.relative_path) + ' · ' + statusText(file.status) + size;
  });
  if (files.length > limit) head.push('  ... +' + (files.length - limit));
  return head;
}

export function taskSummary(task: TaskRecord): string {
  let summary = '';
  if (task.type === 'download') summary = [t('modelName') + ': ' + taskAlias(task), t('source') + ': ' + String(task.metadata?.repo_id ?? task.metadata?.provider ?? '-'), t('downloadTarget') + ': ' + shortModelPath(taskTarget(task))].join(' · ');
  else if (task.type === 'deploy') summary = [t('modelName') + ': ' + String(task.metadata?.model_id ?? '-'), t('container') + ': ' + String(task.metadata?.service_type ?? '-'), taskRuntimePlanSummary(task)].filter(Boolean).join(' · ');
  else if (task.type === 'container') {
    const action = String(task.metadata?.action ?? '');
    const name = String(task.metadata?.name ?? task.metadata?.container_name ?? task.metadata?.profile_id ?? task.metadata?.key ?? '-');
    if (action === 'start_custom_profile') {
      const model = String(task.metadata?.model_id ?? task.metadata?.openai_model ?? '-');
      const runtime = String((locale.value === 'zh-CN' ? task.metadata?.profile_title_zh : task.metadata?.profile_title) ?? task.metadata?.profile_id ?? '-');
      summary = [(locale.value === 'zh-CN' ? '模型' : 'Model') + ': ' + model, (locale.value === 'zh-CN' ? '运行时' : 'Runtime') + ': ' + runtime, t('containerName') + ': ' + name, taskRuntimePlanSummary(task)].filter(Boolean).join(' · ');
    } else {
      const image = String(task.metadata?.image ?? task.metadata?.profile_id ?? task.metadata?.key ?? '-');
      const nameLabel = action === 'build_custom_image' ? (locale.value === 'zh-CN' ? '运行时' : 'Runtime') : t('containerName');
      summary = nameLabel + ': ' + name + ' · ' + t('image') + ': ' + image;
    }
  } else summary = task.command;
  if (task.diagnostic) summary = [summary, (locale.value === 'zh-CN' ? '失败' : 'Failed') + ': ' + task.diagnostic.message].filter(Boolean).join(' · ');
  return summary;
}

export function formatTaskEventTime(value?: string): string {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function taskEventLog(task?: TaskRecord): string {
  if (!task) return t('noTaskEvents');
  const alias = taskAlias(task);
  const lines: string[] = [];
  if (task.type === 'download') {
    lines.push(formatTaskEventTime(task.created_at) + ' ' + t('eventDownloadStarted') + '：' + alias);
    const progress = taskProgress(task);
    if (task.status === 'running') lines.push(formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloading') + '：' + alias + ' · ' + progress + '% · ' + formatBytes(task.downloaded_bytes ?? 0));
    else if (task.status === 'paused') lines.push(formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadPaused') + '：' + alias);
    else if (task.status === 'queued') lines.push(formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadQueued') + '：' + alias);
    else if (task.status === 'canceling') lines.push(formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadStopping') + '：' + alias);
    else if (task.status === 'canceled' || task.status === 'failed') lines.push(formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadStopped') + '：' + alias);
    else if (task.status === 'succeeded') lines.push(formatTaskEventTime(task.finished_at ?? task.updated_at) + ' ' + t('eventDownloadCompleted') + '：' + alias);
    lines.push(t('downloadTarget') + '：' + shortModelPath(taskTarget(task)));
    const fileSummary = taskFileSummary(task);
    if (fileSummary) {
      lines.push(t('files') + '：' + fileSummary);
      lines.push(...taskFileDetailLines(task));
    }
    return lines.join('\n');
  }
  lines.push(formatTaskEventTime(task.created_at) + ' ' + taskTypeText(task.type) + '：' + taskAlias(task));
  if (task.type === 'deploy') {
    const plan = task.metadata?.runtime_plan;
    lines.push(t('modelName') + '：' + String(task.metadata?.model_id ?? '-'));
    lines.push(t('container') + '：' + String(task.metadata?.service_type ?? '-'));
    if (plan?.base_url) lines.push(t('apiAddress') + '：' + plan.base_url);
    if (plan?.health_url) lines.push('Health：' + plan.health_url);
    const stages = taskRuntimePlanStages(task);
    if (stages.length) lines.push(t('stage') + '：' + stages.map((stage) => stage.label + '(' + statusText(taskRuntimePlanStageStatus(task, stage.id)) + ')').join(' -> '));
  }
  lines.push(formatTaskEventTime(task.updated_at) + ' ' + statusText(task.status));
  if (task.diagnostic) lines.push(task.diagnostic.message);
  return lines.join('\n');
}



function stripLogDecorations(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, list) => line.trim() || (index > 0 && list[index - 1]?.trim()))
    .join('\n');
}


function logBlockStartIndexes(logs: string): number[] {
  const indexes: number[] = [];
  const pattern = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+\$\s+/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(logs))) indexes.push(match.index);
  return indexes;
}

function logBlockForTask(logs: string, task?: TaskRecord): string {
  if (!task) return logs;
  const starts = logBlockStartIndexes(logs);
  if (!starts.length) return logs;
  const targetTime = new Date(task.started_at ?? task.created_at).getTime();
  let bestStart = starts[starts.length - 1];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    const stamp = logs.slice(start + 1, start + 25);
    const time = new Date(stamp).getTime();
    if (Number.isNaN(time)) continue;
    const distance = Math.abs(time - targetTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStart = start;
    }
  }
  const blockIndex = starts.indexOf(bestStart);
  const nextStart = starts[blockIndex + 1] ?? logs.length;
  return logs.slice(bestStart, nextStart);
}

function tailLog(value: string, maxLines = 180, maxChars = 14000): string {
  const cleaned = stripLogDecorations(value);
  const tailByChars = cleaned.length > maxChars ? cleaned.slice(cleaned.length - maxChars) : cleaned;
  const lines = tailByChars.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
}


export function displayTaskLog(value = taskLog.value): string {
  return tailLog(value);
}

export function downloadEventTimeline(taskList = tasks.value): string[] {
  const events = taskList
    .filter((task) => task.type === 'download')
    .flatMap((task) => {
      const alias = taskAlias(task);
      const rows: Array<{ at: string; text: string }> = [
        { at: task.created_at, text: formatTaskEventTime(task.created_at) + ' ' + t('eventDownloadStarted') + '：' + alias }
      ];
      if (task.status === 'queued') rows.push({ at: task.updated_at, text: formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadQueued') + '：' + alias });
      if (task.status === 'running') rows.push({ at: task.updated_at, text: formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloading') + '：' + alias + ' · ' + taskProgress(task) + '% · ' + formatBytes(task.downloaded_bytes ?? 0) });
      if (task.status === 'paused') rows.push({ at: task.updated_at, text: formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadPaused') + '：' + alias });
      if (task.status === 'canceling') rows.push({ at: task.updated_at, text: formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadStopping') + '：' + alias });
      if (task.status === 'canceled' || task.status === 'failed') rows.push({ at: task.updated_at, text: formatTaskEventTime(task.updated_at) + ' ' + t('eventDownloadStopped') + '：' + alias });
      if (task.status === 'succeeded') rows.push({ at: task.finished_at ?? task.updated_at, text: formatTaskEventTime(task.finished_at ?? task.updated_at) + ' ' + t('eventDownloadCompleted') + '：' + alias });
      return rows;
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((event) => event.text);
  return events.length ? events : [t('noTaskEvents')];
}


export function isModelBusy(model: ModelRecord): boolean {
  return activeTasks.value.some((task) => task.metadata?.model_id === model.id || task.metadata?.alias === model.id || task.metadata?.alias === model.display_name);
}

export function canDeleteModel(model: ModelRecord): boolean {
  const deployed = runningDeployments.value.some((deployment) => deployment.model_id === model.id || deployment.openai_models.includes(model.id));
  return !deployed && !isModelBusy(model) && !['running', 'starting'].includes(model.status.deploy);
}

export function deploymentArgs() {
  return {
    max_model_len: finiteNumber(deployContextLength.value, 4096),
    gpu_memory_utilization: finiteNumber(deployGpuUtil.value, 30) / 100,
    max_num_seqs: finiteNumber(deployMaxSeqs.value, 4),
    tensor_parallel_size: finiteNumber(deployTensorParallel.value, 1),
    kv_cache_dtype: deployKvCacheDtype.value || 'auto',
    enable_auto_tool_choice: Boolean(deployEnableAutoToolChoice.value),
    enable_thinking: Boolean(deployEnableThinking.value),
    tool_call_parser: effectiveToolCallParser.value,
    reasoning_parser: effectiveReasoningParser.value,
    max_batch_size: finiteNumber(trtMaxBatchSize.value, 8),
    max_num_tokens: finiteNumber(trtMaxNumTokens.value, 4096),
    kv_cache_free_gpu_memory_fraction: finiteNumber(trtKvCacheFraction.value, 0.9),
    tp_size: finiteNumber(trtTpSize.value, 1),
    pp_size: finiteNumber(trtPpSize.value, 1),
    ...(deployGpuDeviceIds.value.length ? { gpu_device_ids: [...deployGpuDeviceIds.value] } : {})
  };
}

export function applyDeploymentArgs(args?: Record<string, unknown>) {
  if (!args) return;
  if (Array.isArray(args.gpu_device_ids)) deployGpuDeviceIds.value = args.gpu_device_ids.map(String);
  deployContextLength.value = finiteNumber(args.max_model_len, deployContextLength.value);
  const gpuUtilization = finiteNumber(args.gpu_memory_utilization, deployGpuUtil.value / 100);
  deployGpuUtil.value = clamp(Math.round(gpuUtilization <= 1 ? gpuUtilization * 100 : gpuUtilization), 10, 99);
  deployMaxSeqs.value = clamp(Math.round(finiteNumber(args.max_num_seqs, deployMaxSeqs.value)), 1, 256);
  deployTensorParallel.value = Math.max(1, Math.round(finiteNumber(args.tensor_parallel_size, deployTensorParallel.value)));
  deployKvCacheDtype.value = typeof args.kv_cache_dtype === 'string' ? args.kv_cache_dtype : deployKvCacheDtype.value;
  if ('enable_auto_tool_choice' in args) {
    deployEnableAutoToolChoice.value = args.enable_auto_tool_choice === true || args.enable_auto_tool_choice === 1 || args.enable_auto_tool_choice === 'true';
  }
  if ('enable_thinking' in args) {
    deployEnableThinking.value = args.enable_thinking === true || args.enable_thinking === 1 || args.enable_thinking === 'true';
  }
  if (typeof args.tool_call_parser === 'string') deployToolCallParser.value = args.tool_call_parser || 'auto';
  if (typeof args.reasoning_parser === 'string') deployReasoningParser.value = args.reasoning_parser;
  trtMaxBatchSize.value = Math.max(1, Math.round(finiteNumber(args.max_batch_size, trtMaxBatchSize.value)));
  trtMaxNumTokens.value = finiteNumber(args.max_num_tokens, trtMaxNumTokens.value);
  trtKvCacheFraction.value = clamp(finiteNumber(args.kv_cache_free_gpu_memory_fraction, trtKvCacheFraction.value), 0.1, 0.99);
  trtTpSize.value = Math.max(1, Math.round(finiteNumber(args.tp_size, trtTpSize.value)));
  trtPpSize.value = Math.max(1, Math.round(finiteNumber(args.pp_size, trtPpSize.value)));
  clampDeployParamsForModel();
}

export function syncGpuParallelism() {
  if (!deployGpuDeviceIds.value.length && gpuDeviceOptions.value.length) {
    deployGpuDeviceIds.value = [gpuDeviceOptions.value[0].value];
  }
  const count = Math.max(1, deployGpuDeviceIds.value.length);
  deployTensorParallel.value = count;
  trtTpSize.value = count;
  trtPpSize.value = 1;
}

function readStoredGpuDeviceIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('deployGpuDeviceIds') || '[]');
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function compatibilityRows(model: ModelRecord) {
  return (['vllm', 'trtllm', 'pytorch'] as const)
    .map((service) => ({ service, info: model.compatibility[service] }))
    .filter((item) => item.info);
}

export function clampDeployParamsForModel() {
  const limit = contextLimit.value;
  deployContextLength.value = clamp(deployContextLength.value || limit.default, limit.min, limit.max);
  deployTensorParallel.value = clamp(deployTensorParallel.value || 1, 1, tensorParallelLimit.value);
  trtMaxNumTokens.value = clamp(trtMaxNumTokens.value || limit.default, limit.min, limit.max);
  trtTpSize.value = clamp(trtTpSize.value || 1, 1, tensorParallelLimit.value);
}

export function paramLimitText() { const limit = contextLimit.value; return t('modelLimit') + ': ' + limit.max + ' · ' + limit.source; }

export const compatibilityGuide = computed(() => locale.value === 'zh-CN' ? [
  { format: 'HuggingFace checkpoint（.safetensors / .bin）', service: 'vLLM', note: '默认部署方式。下载完成后直接加载到 vLLM 容器即可发布 OpenAI API。需要 config.json + tokenizer + 权重文件完整。' },
  { format: 'TensorRT-LLM 引擎（.engine）', service: 'TensorRT-LLM', note: '需先用 trtllm-build 转换 HF checkpoint。适合高并发生产场景，配置比 vLLM 复杂，但吞吐更高。' },
  { format: '音频模型（Whisper / FunASR / CosyVoice）', service: '自定义 Audio', note: 'ASR / TTS 需要自定义 Audio/FunASR 运行时；默认 PyTorch 容器只是通用环境。' }
] : [
  { format: 'HuggingFace checkpoint (.safetensors / .bin)', service: 'vLLM', note: 'Default route. Download then load into the vLLM container to serve an OpenAI API. Needs config.json + tokenizer + complete weight files.' },
  { format: 'TensorRT-LLM engine (.engine)', service: 'TensorRT-LLM', note: 'Convert from HF checkpoint with trtllm-build first. Best for high-throughput production; more complex setup than vLLM.' },
  { format: 'Audio models (Whisper / FunASR / CosyVoice)', service: 'Custom Audio', note: 'ASR / TTS needs a custom Audio/FunASR runtime; the default PyTorch container is only a generic environment.' }
]);

/* ── container display helpers ─────────────────── */
export function serviceContainerColor(_container?: ContainerRecord) { return 'green'; }
export function isModelSpecificMissing(container: ContainerRecord) { return container.state === 'missing' && ['vllm', 'trtllm', 'pytorch'].includes(container.runtime); }
export function actionTargetName(container: ContainerRecord) { return container.instance_name || container.name; }
export function imageStatusColor(container?: ContainerRecord) { return container?.image_pulled ? 'green' : 'gold'; }
export function imageStatusText(container?: ContainerRecord) { return container?.image_pulled ? t('imagePulled') : t('imageMissing'); }
export function testStatusColor(status?: string) { if (status === 'passed') return 'green'; if (status === 'failed') return 'red'; if (status === 'running') return 'blue'; return 'gold'; }
export function testStatusText(status?: string) { if (status === 'passed') return t('testPassed'); if (status === 'failed') return t('testFailed'); if (status === 'running') return t('testRunning'); return t('untested'); }

/* ── deployment helpers ────────────────────────── */
export function selectDeployModel(model: ModelRecord) {
  deployModelId.value = model.id;
  localStorage.setItem('deployModelId', model.id);
  deployOpenAiModel.value = model.id;
  const preferred = containers.value.find((container) => model.compatibility[container.runtime]?.status !== 'unsupported' && container.runtime === model.runtime.preferred)
    ?? containers.value.find((container) => model.compatibility[container.runtime]?.status !== 'unsupported');
  if (preferred) selectedContainerKey.value = preferred.key;
  deployContextLength.value = model.inference?.context_length?.default ?? deployContextLength.value;
  trtMaxNumTokens.value = model.inference?.context_length?.default ?? trtMaxNumTokens.value;
  clampDeployParamsForModel();
}

export function canDeployToSelected(): boolean {
  const model = selectedDeployModel.value;
  const container = selectedContainer.value;
  return Boolean(model && container && container.runtime !== 'custom' && model.compatibility[container.runtime]?.status !== 'unsupported');
}

export function currentLoadedModel(): ModelRecord | undefined {
  const deployment = selectedDeployment.value;
  if (!deployment) return undefined;
  if (deployment.model_id) return models.value.find((item) => item.id === deployment.model_id);
  const selected = selectedDeployModel.value;
  return selected && deployment.openai_models.includes(selected.id) ? selected : undefined;
}

export function selectedRunningModelLabel(): string {
  const deployment = selectedDeployment.value;
  if (!deployment) return t('noRunningModels');
  const selected = selectedDeployModel.value;
  if (selected && deployment.openai_models.includes(selected.id)) return selected.display_name + ' -> ' + (deployment.container_name || deployment.runtime);
  if (deployment.model_id) return deployment.model_id + ' -> ' + (deployment.container_name || deployment.runtime);
  return deployment.openai_models.length ? deployment.openai_models.join(', ') + ' -> ' + (deployment.container_name || deployment.runtime) : t('noRunningModels');
}

export function deploymentIsActive(deployment?: DeploymentRecord): boolean {
  return Boolean(deployment && (deployment.status === 'running' || deployment.openai_models.length));
}

export function selectedPublicBaseUrl(): string { return selectedDeployment.value ? publicBaseUrl(selectedDeployment.value) : ''; }
export function selectedModelEndpoint(): string { return selectedDeployment.value ? modelEndpoint(selectedDeployment.value) : ''; }
export function selectedInferenceEndpoint(): string { return selectedDeployment.value ? inferenceEndpoint(selectedDeployment.value) : ''; }
export function selectedChatEndpoint(): string { return selectedDeployment.value ? chatEndpoint(selectedDeployment.value) : ''; }
export function expectedContainerName(model: ModelRecord, serviceType: ServiceType): string {
  if (serviceType === 'vllm') return 'vllm_' + model.id.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/-/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, 48);
  if (serviceType === 'trtllm') return 'trtllm-service';
  return 'pytorch-service';
}

/* ── theme / locale setters ────────────────────── */
export function setLocale(next: Locale) { locale.value = next; localStorage.setItem('locale', next); document.documentElement.lang = next; }
export function setTheme(next: ThemeMode) { themeMode.value = next; localStorage.setItem('themeMode', next); document.documentElement.dataset.theme = next; }

/* ── API ───────────────────────────────────────── */
export const adminToken = ref(localStorage.getItem('ai-stack-admin-token') ?? '');

export function setAdminToken(value: string) {
  adminToken.value = value.trim();
  if (adminToken.value) localStorage.setItem('ai-stack-admin-token', adminToken.value);
  else localStorage.removeItem('ai-stack-admin-token');
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (adminToken.value) headers.set('X-AI-Stack-Admin', adminToken.value);
  const response = await fetch('/api' + path, { ...options, headers });
  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { detail: text || response.statusText || 'Request failed' };
  }
  if (!response.ok) throw new Error((payload as any)?.error?.message ?? (payload as any)?.detail ?? response.statusText ?? 'Request failed');
  return payload as T;
}

function emptySystemCheck(): SystemCheck {
  const host = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
  return {
    management_url: 'http://' + host + ':8888',
    backend_url: '/api',
    lan_addresses: [],
    service_ports: {},
    docker: { ok: false, detail: '' }
  };
}

function fallbackCopyText(value: string): boolean {
  const textarea = document.createElement('textarea');
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  activeElement?.focus();
  return copied;
}

export async function copyText(value: string): Promise<boolean> {
  const text = String(value ?? '');
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  if (!copied) copied = fallbackCopyText(text);
  if (copied) message.success(t('copied'));
  else message.error(t('copyFailed'));
  return copied;
}

export async function refresh() {
  const modelCatalogRequest = ++latestModelCatalogRequest;
  if (!models.value.length) modelCatalogLoading.value = true;
  const modelRequest = api<{ models: ModelRecord[] }>('/models')
    .catch(() => ({ models: [] }))
    .then((payload) => {
      models.value = payload.models ?? [];
      return payload;
    })
    .finally(() => {
      if (modelCatalogRequest === latestModelCatalogRequest) modelCatalogLoading.value = false;
    });
  const [modelPayload, deploymentPayload, taskPayload, systemPayload, networkPayload, proxyPayload, workbenchPayload, containerPayload] = await Promise.all([
    modelRequest,
    api<{ deployments: DeploymentRecord[] }>('/deployments').catch(() => ({ deployments: [] })),
    api<{ tasks: TaskRecord[] }>('/tasks').catch(() => ({ tasks: [] })),
    api<SystemCheck>('/system/check').catch(() => emptySystemCheck()),
    api<NetworkSettings>('/settings/network').catch(() => null),
    api<ProxySettings>('/settings/proxy').catch(() => null),
    api<WorkbenchSettings>('/settings/workbench').catch(() => null),
    api<{ containers: ContainerRecord[] }>('/containers').catch(() => ({ containers: [] }))
  ]);
  models.value = modelPayload.models ?? [];
  deployments.value = deploymentPayload.deployments ?? [];
  tasks.value = taskPayload.tasks ?? [];
  system.value = systemPayload;
  network.value = networkPayload ?? systemPayload.network ?? null;
  proxySettings.value = proxyPayload;
  workbenchSettings.value = workbenchPayload ?? systemPayload.workbench ?? null;
  managementPort.value = workbenchSettings.value?.management_port ?? 8888;
  const newContainers = containerPayload.containers ?? [];
  // Keep previous containers if API returned empty (avoids flicker from slow Docker)
  if (newContainers.length > 0 || containers.value.length === 0) {
    containers.value = newContainers;
  }
  if ((!deployModelId.value || !selectedDeployModel.value) && readyModelList.value[0]) selectDeployModel(readyModelList.value[0]);
  if (selectedDeployModel.value && !containerOptions.value.some((item) => item.value === selectedContainerKey.value)) { const first = containerOptions.value[0]; if (first) selectedContainerKey.value = first.value; }
  if (!deployOpenAiModel.value && deployModelId.value) deployOpenAiModel.value = deployModelId.value;
  if (!selectedContainerKey.value && containerOptions.value[0]) selectedContainerKey.value = containerOptions.value[0].value;
  const selectedTaskVisible = visibleTasks.value.some((task) => task.id === selectedTaskId.value);
  if ((!selectedTaskId.value || !selectedTaskVisible) && visibleTasks.value[0]) {
    selectedTaskId.value = visibleTasks.value[0].id;
  }
}

export async function loadTaskLog(taskId = selectedTaskId.value) {
  if (!taskId) return;
  selectedTaskId.value = taskId;
  selectedLogContainer.value = '';
  containerLog.value = '';
  const payload = await api<{ logs: string }>('/tasks/' + encodeURIComponent(taskId) + '/logs');
  const task = tasks.value.find((item) => item.id === taskId);
  taskLog.value = tailLog(logBlockForTask(payload.logs, task));
}

export async function loadContainerLogs(name: string) {
  if (!name) return;
  selectedLogContainer.value = name;
  taskLog.value = '';
  const payload = await api<{ logs: string }>('/containers/' + encodeURIComponent(name) + '/logs?lines=200');
  if (selectedLogContainer.value === name) containerLog.value = payload.logs;
}

/**
 * 在文件管理器中打开模型目录。
 * Open the model folder in the system file manager.
 */
export async function openModelFolder(model: ModelRecord) {
  await api('/models/' + encodeURIComponent(model.id) + '/open-folder', { method: 'POST' });
}

/**
 * 删除本地模型（带确认弹窗）。
 * Delete a local model with confirmation dialog.
 */
export function deleteLocalModel(model: ModelRecord) {
  if (!canDeleteModel(model)) { message.warning(t('deleteBlocked')); return; }
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除模型' : 'Confirm Delete Model',
    content: [
      t('modelName') + ': ' + model.display_name,
      t('path') + ': ' + model.local.path,
      t('size') + ': ' + formatBytes(model.local.size_bytes),
      t('format') + ': ' + modelFormatLabel(model.local.format),
      t('files') + ': ' + model.local.file_count + ' files, ' + model.local.weight_files + ' weights'
    ].join('\\n'),
    okText: locale.value === 'zh-CN' ? '确认删除' : 'Confirm Delete',
    okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel',
    width: 520,
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try {
        await api('/models/' + encodeURIComponent(model.id), { method: 'DELETE' });
        message.success(t('deleted'));
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally { hide(); }
    }
  });
}
