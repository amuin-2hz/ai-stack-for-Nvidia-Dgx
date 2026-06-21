<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  CloudServerOutlined, CopyOutlined, DashboardOutlined, DatabaseOutlined,
  DeleteOutlined, DownloadOutlined, FileTextOutlined, EyeOutlined, FolderOpenOutlined, MenuFoldOutlined,
  MenuUnfoldOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined,
  RocketOutlined, SettingOutlined, SyncOutlined, UnorderedListOutlined
} from '@ant-design/icons-vue';
import { message, Modal, theme as antdTheme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import enUS from 'ant-design-vue/es/locale/en_US';
import type { Locale, ThemeMode, View, ServiceType, ModelRecord, ContainerRecord, DeploymentRecord, TaskRecord } from './types';
import {
  locale, themeMode, view, models, deployments, tasks, containers, system, network, workbenchSettings,
  managementPort, modelUrl, importMessage, importPreview, deployModelId,
  selectedContainerKey, selectedTaskId, selectedDownloadLogId, selectedLogContainer,
  taskLog, containerLog, networkMessage, customComponents, customMode, customRestartPolicy,
  customAutoRestart, customName, customImage, customModalOpen, customTab, composeYaml,
  composeValidating, composeValidationResult, logCollapsed, modelListDrawerOpen,
  deployOpenAiModel, deployContextLength, deployGpuUtil, deployMaxSeqs, deployTensorParallel,
  deployKvCacheDtype, deploySwapSpace, trtMaxBatchSize, trtMaxNumTokens, trtKvCacheFraction,
  trtTpSize, trtPpSize,
  t, statusText, formatDuration, formatBytes, badgeColor, shortModelPath,
  readyModelList, readyModels, runtimeContainers, runningServices, runningDeployments,
  visibleTasks, dashboardTasks, activeTasks, downloadTasks,
  modelLibraryList, customContainers, composePlaceholder, selectedContainer, selectedTask,
  memoryPercent, cpuPercent, storagePercent, gpuSummary, portRows,
  selectedDeployModel, containerOptions, modelOptions, selectedDeployment,
  activeInferenceDeployments, activeContainerCount, servingModelCount, createdContainerCount,
  managementHost, consoleAddress, modelListSummaryUrl, publishedModelRows, publicHost,
  contextLimit, tensorParallelLimit,
  publicBaseUrl, modelEndpoint, chatEndpoint, supportedContainers as getSupportedContainers,
  containerStateText, containerStateColor, modelStatusHelp, modelAuditSummary, taskProgress, taskTypeText,
  runtimeHintColor, taskAlias, taskRuntimeHints, taskFileSummary, taskSummary, taskRuntimePlanStages, taskRuntimePlanStageStatus, taskRuntimePlanStageColor, taskEventLog, downloadEventTimeline, isModelBusy,
  canDeleteModel, deploymentArgs, compatibilityRows, compatibilityGuide,
  serviceContainerColor, isModelSpecificMissing, actionTargetName,
  imageStatusColor, imageStatusText, testStatusColor, testStatusText,
  selectDeployModel, canDeployToSelected, currentLoadedModel, selectedRunningModelLabel,
  deploymentIsActive, selectedPublicBaseUrl, selectedModelEndpoint, selectedChatEndpoint,
  expectedContainerName, clampDeployParamsForModel, paramLimitText,
  setLocale, setTheme, api, copyText, refresh, loadTaskLog, loadContainerLogs,
} from './composables/useApp';

/* ── local computed ──────────────────────────── */
const antLocale = computed(() => locale.value === 'zh-CN' ? zhCN : enUS);
const isDark = computed(() => themeMode.value === 'dark');
const antTheme = computed(() => ({ algorithm: isDark.value ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm, token: { colorPrimary: '#0aa7d8', borderRadius: 6 } }));
const heroImage = computed(() => `./brand/${isDark.value ? 'hero-dark.png' : 'hero-light.png'}`);
const brandImage = computed(() => `./brand/${isDark.value ? 'amuin-light.png' : 'logo-au.png'}`);
const containerActionBusy = ref<Record<string, boolean>>({});
const containerActionKey = (container: ContainerRecord, action: string) => actionTargetName(container) + ':' + action;
const isContainerActionBusy = (container: ContainerRecord, action: string) => Boolean(containerActionBusy.value[containerActionKey(container, action)]);
const isContainerBusy = (container: ContainerRecord) => Object.keys(containerActionBusy.value).some((key) => key.startsWith(actionTargetName(container) + ':'));
const setContainerBusy = (container: ContainerRecord, action: string, busy: boolean) => {
  const key = containerActionKey(container, action);
  const next = { ...containerActionBusy.value };
  if (busy) next[key] = true;
  else delete next[key];
  containerActionBusy.value = next;
};
const deploymentPlanPreview = ref<any | null>(null);
const deploymentPlanLoading = ref(false);
const sidebarCollapsed = ref(false);
let compactSidebarQuery: MediaQueryList | null = null;
const inferredDownloadRuntime = computed(() => {
  const text = [
    modelUrl.value,
    importPreview.value?.model?.repo_id,
    importPreview.value?.model?.target_path,
    importPreview.value?.download?.command
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('.engine') || text.includes('tensorrt') || text.includes('trtllm')) return 'trtllm';
  if (['asr', 'tts', 'whisper', 'cosyvoice', 'funasr', 'fun-asr', 'qwen3-asr', 'qwen3-tts'].some((token) => text.includes(token))) return 'pytorch';
  return 'vllm';
});
const inferredDownloadLabel = computed(() => {
  if (inferredDownloadRuntime.value === 'trtllm') return '.engine';
  if (inferredDownloadRuntime.value === 'pytorch') return 'ASR / TTS';
  return '.safetensors / .bin';
});
const inferredDownloadColor = computed(() => inferredDownloadRuntime.value === 'trtllm' ? 'purple' : inferredDownloadRuntime.value === 'pytorch' ? 'green' : 'blue');

const selectedPlaygroundDeploymentId = ref('');
const selectedPlaygroundDeployment = computed(() => runningDeployments.value.find((item) => item.deployment_id === selectedPlaygroundDeploymentId.value) ?? runningDeployments.value[0]);
const playgroundPrompt = ref(locale.value === 'zh-CN' ? '用一句话介绍 AMUIN AI STACK。' : 'Introduce AMUIN AI STACK in one sentence.');
const homeRecommendation = computed(() => {
  if (!readyModels.value) return locale.value === 'zh-CN' ? '先导入或下载一个模型。' : 'Import or download a model first.';
  if (!servingModelCount.value) return locale.value === 'zh-CN' ? '选择一个就绪模型并发布为 API。' : 'Choose a ready model and publish it as an API.';
  return locale.value === 'zh-CN' ? '已有模型在运行，进入 Playground 验证效果。' : 'A model is running. Open Playground to validate it.';
});
const playgroundCurl = computed(() => {
  const deployment = selectedPlaygroundDeployment.value;
  const model = deployment?.openai_models?.[0] || deployment?.model_id || 'model';
  const url = deployment ? chatEndpoint(deployment) : 'http://localhost:30000/v1/chat/completions';
  return `curl ${url} -H "Content-Type: application/json" -d '{"model":"${model}","messages":[{"role":"user","content":"${playgroundPrompt.value}"}]}'`;
});
const playgroundSdk = computed(() => {
  const deployment = selectedPlaygroundDeployment.value;
  const model = deployment?.openai_models?.[0] || deployment?.model_id || 'model';
  const baseUrl = deployment ? publicBaseUrl(deployment) : 'http://localhost:30000/v1';
  return `from openai import OpenAI
client = OpenAI(base_url="${baseUrl}", api_key="EMPTY")
print(client.chat.completions.create(model="${model}", messages=[{"role":"user", "content":"${playgroundPrompt.value}"}]))`;
});
function publishModelFromCatalog(model: ModelRecord) { selectDeployModel(model); view.value = 'load'; }

const pageMeta = computed<{ title: string; desc: string }>(() => ({
  dashboard: { title: t('dashboard'), desc: t('pageDashboardDesc') },
  models: { title: t('models'), desc: t('pageModelsDesc') },
  load: { title: t('load'), desc: t('pageLoadDesc') },
  running: { title: t('running'), desc: t('pageRunningDesc') },
  playground: { title: t('playground'), desc: t('pagePlaygroundDesc') },
  services: { title: t('services'), desc: t('pageServicesDesc') },
  deploy: { title: t('deploy'), desc: t('pageDeployDesc') },
  tasks: { title: t('tasks'), desc: t('pageTasksDesc') },
  settings: { title: t('settings'), desc: t('pageSettingsDesc') }
}[view.value] ?? { title: t('models'), desc: t('pageModelsDesc') }));

/* ── actions ─────────────────────────────────── */
function selectView(info: { key: string }) { view.value = info.key as View; }
function toggleTheme(checked: boolean | string | number) { setTheme(checked ? 'dark' : 'light'); }
function toggleLocale(checked: boolean | string | number) { setLocale(checked ? 'en-US' : 'zh-CN'); }
function syncSidebarMode(event?: MediaQueryListEvent) { sidebarCollapsed.value = event ? event.matches : !!compactSidebarQuery?.matches; }

async function importPlan() {
  if (!modelUrl.value.trim()) return;
  importMessage.value = t('parsing'); importPreview.value = null;
  try {
    const payload = await api<import('./types').ImportPreview>('/models/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: modelUrl.value.trim(), provider: 'auto', expected_runtime: inferredDownloadRuntime.value }) });
    importPreview.value = payload; importMessage.value = [t('provider') + ': ' + payload.model?.provider, t('repo') + ': ' + payload.model?.repo_id, t('target') + ': ' + payload.model?.target_path, payload.download?.command ? t('command') + ': ' + payload.download.command : payload.message].filter(Boolean).join('\n');
  } catch (error) { importMessage.value = String(error); }
}

async function startDownload() {
  if (!modelUrl.value.trim()) return;
  importMessage.value = t('startingDownload');
  try {
    const payload = await api<any>('/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: modelUrl.value.trim(), provider: 'auto', expected_runtime: inferredDownloadRuntime.value }) });
    importMessage.value = t('downloadTaskStarted') + ': ' + payload.task.id;
    selectedDownloadLogId.value = payload.task.id; selectedTaskId.value = payload.task.id;
    await refresh(); await loadTaskLog(payload.task.id);
  } catch (error) { importMessage.value = String(error); }
}

async function controlDownloadTask(task: TaskRecord, action: 'pause' | 'resume' | 'cancel') {
  try {
    const payload = await api<{ ok: boolean; detail?: string }>('/tasks/' + encodeURIComponent(task.id) + '/' + action, { method: 'POST' });
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

async function repairTask(task: TaskRecord, action: string) {
  try {
    const runtime = String(task.metadata?.service_type ?? task.metadata?.key ?? '');
    const body: Record<string, unknown> = { action, runtime };
    if (action === 'change_port') {
      const current = containers.value.find((container) => container.runtime === runtime || container.key === runtime)?.public_port;
      const value = window.prompt(locale.value === 'zh-CN' ? '输入新的发布端口' : 'Enter new public port', current ? String(current) : '');
      if (!value) return;
      const publicPort = Number(value.trim());
      if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535) {
        message.warning(locale.value === 'zh-CN' ? '端口必须是 1024 到 65535 之间的整数' : 'Port must be an integer between 1024 and 65535');
        return;
      }
      body.public_port = publicPort;
    }
    if (action === 'change_image') {
      const current = containers.value.find((container) => container.runtime === runtime || container.key === runtime);
      const value = window.prompt(locale.value === 'zh-CN' ? '输入新的镜像标签' : 'Enter new image tag', current?.image || current?.official_image || '');
      if (!value) return;
      const image = value.trim();
      if (!image || /\s/.test(image)) {
        message.warning(locale.value === 'zh-CN' ? '镜像标签不能为空且不能包含空格' : 'Image tag cannot be empty or contain whitespace');
        return;
      }
      body.image = image;
    }
    const payload = await api<any>('/tasks/' + encodeURIComponent(task.id) + '/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (payload.executable === false) message.info(payload.detail || t('actionSucceeded'));
    else message.success(payload.detail || t('actionSucceeded'));
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); }
    else await loadTaskLog(task.id);
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

async function openModelFolder(model: ModelRecord) { await api('/models/' + encodeURIComponent(model.id) + '/open-folder', { method: 'POST' }); }

async function deleteLocalModel(model: ModelRecord) {
  if (!canDeleteModel(model)) { message.warning(t('deleteBlocked')); return; }
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除模型' : 'Confirm Delete Model',
    content: [t('modelName') + ': ' + model.display_name, t('path') + ': ' + model.local.path, t('size') + ': ' + formatBytes(model.local.size_bytes), t('format') + ': ' + model.local.format, t('files') + ': ' + model.local.file_count + ' files, ' + model.local.weight_files + ' weights'].join('\\n'),
    okText: locale.value === 'zh-CN' ? '确认删除' : 'Confirm Delete', okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel', width: 520,
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try { await api('/models/' + encodeURIComponent(model.id), { method: 'DELETE' }); message.success(t('deleted')); await refresh(); }
      catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
      finally { hide(); }
    }
  });
}


async function previewDeploymentPlan() {
  const model = selectedDeployModel.value;
  const container = selectedContainer.value;
  if (!model || !container || !canDeployToSelected()) return;
  deploymentPlanLoading.value = true;
  try {
    deploymentPlanPreview.value = await api<any>('/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: model.id, service_type: container.runtime, openai_model: deployOpenAiModel.value || model.id, args: deploymentArgs() })
    });
    message.success(locale.value === 'zh-CN' ? '运行计划已生成' : 'Runtime plan ready');
  } catch (error) {
    deploymentPlanPreview.value = null;
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    deploymentPlanLoading.value = false;
  }
}

async function deployModelTo(model: ModelRecord, container: ContainerRecord) {
  selectedContainerKey.value = container.key;
  const serviceType = container.runtime as ServiceType;
  const openaiModel = deployOpenAiModel.value || model.id;
  try {
    const payload = await api<any>('/deployments/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: model.id, service_type: serviceType, openai_model: openaiModel, args: deploymentArgs() }) });
    if (payload.status === 'already_running') message.info(t('alreadyRunning'));
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; taskLog.value = ''; await loadTaskLog(payload.task.id); message.info(t('deploymentTaskStarted')); }
    const targetName = payload.target_container_name || payload.container_name || expectedContainerName(model, serviceType);
    await refresh();
    const refreshedTarget = containers.value.find((item) => item.name === targetName || item.instance_name === targetName);
    if (refreshedTarget?.state === 'running') await loadContainerLogs(actionTargetName(refreshedTarget));
    else selectedLogContainer.value = targetName;
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}

async function deploySelectedModel() { const model = selectedDeployModel.value; const container = selectedContainer.value; if (!model || !container || !canDeployToSelected()) return; deploymentPlanPreview.value = null; await deployModelTo(model, container); }

async function unloadSelectedDeployment() { const deployment = selectedDeployment.value; if (!deployment || deployment.status !== 'running') return; await api('/deployments/' + encodeURIComponent(deployment.deployment_id) + '/stop', { method: 'POST' }); await refresh(); containerLog.value = ''; selectedLogContainer.value = ''; }

async function waitForTaskDone(taskId: string, timeoutMs = 120000): Promise<TaskRecord | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await api<TaskRecord>('/tasks/' + encodeURIComponent(taskId));
    if (['succeeded', 'failed', 'canceled'].includes(task.status)) return task;
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

async function runContainerAction(container: ContainerRecord, action: 'start' | 'stop' | 'restart') {
  if (isContainerBusy(container)) return;
  setContainerBusy(container, action, true);
  try {
    const target = actionTargetName(container);
    if (container.preset && action === 'start') {
      await saveContainerConfig(container, true);
      const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/start-test', { method: 'POST' });
      if (payload.task?.id) {
        selectedTaskId.value = payload.task.id;
        taskLog.value = '';
        await loadTaskLog(payload.task.id);
        const task = await waitForTaskDone(payload.task.id);
        if (task?.status === 'failed') { message.error(task.error || t('actionFailed')); return; }
        if (!task) { message.warning(locale.value === 'zh-CN' ? '启动任务仍在运行，请稍后查看任务日志。' : 'Start task is still running. Check task logs later.'); return; }
      }
      containerLog.value = '';
      selectedLogContainer.value = target;
      message.success(t('actionSucceeded'));
      await refresh();
      await loadContainerLogs(target);
      return;
    }
    const payload = await api<{ ok?: boolean; detail?: string }>('/containers/' + encodeURIComponent(target) + '/' + action, { method: 'POST' });
    if (payload.ok === false) { message.warning(payload.detail || t('actionFailed')); return; }
    message.success(payload.detail || t('actionSucceeded'));
    if (action === 'start' || action === 'restart') containerLog.value = '';
    selectedLogContainer.value = target;
    await refresh();
    if (action === 'start' || action === 'restart') await new Promise(r => setTimeout(r, 1500));
    await loadContainerLogs(target);
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { setContainerBusy(container, action, false); }
}

async function viewContainerLogs(container: ContainerRecord) {
  if (isContainerActionBusy(container, 'logs')) return;
  setContainerBusy(container, 'logs', true);
  try { await loadContainerLogs(actionTargetName(container)); }
  finally { setContainerBusy(container, 'logs', false); }
}

async function prepareContainerImage(container: ContainerRecord) { const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/pull-image', { method: 'POST' }); if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); } message.success(t('actionSucceeded')); await refresh(); }
async function testContainerImage(container: ContainerRecord) { const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/test-image', { method: 'POST' }); if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); } message.success(t('actionSucceeded')); await refresh(); }

async function deleteContainerConfirm(container: ContainerRecord) {
  if (!container.preset) { message.warning(locale.value === 'zh-CN' ? '仅内置容器模板支持删除' : 'Only preset container templates can be deleted'); return; }
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除容器模板' : 'Confirm Delete Container Template',
    content: locale.value === 'zh-CN' ? `即将删除容器「${container.title}（${container.name}）」：\n\n• Docker 容器\n• Docker 镜像（${container.image}）\n• 关联数据卷\n• 运行时缓存\n\n此操作不可撤销。删除后需重新拉取镜像并创建容器。` : `This will delete container "${container.title} (${container.name})":\n\n• Docker container\n• Docker image (${container.image})\n• Associated volumes\n• Runtime cache\n\nThis action cannot be undone. You will need to re-pull the image and recreate the container.`,
    okText: locale.value === 'zh-CN' ? '确认删除并清理 Docker 资源' : 'Delete & Clean Docker Resources', okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel', width: 560,
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try {
        const result = await api<{ ok: boolean; steps: string[] }>('/containers/' + encodeURIComponent(container.key), { method: 'DELETE' });
        if (result.ok) message.success(locale.value === 'zh-CN' ? '容器已删除，Docker 资源已清理' : 'Container deleted and Docker resources cleaned');
        else message.warning((locale.value === 'zh-CN' ? '部分清理失败：' : 'Partial cleanup: ') + (result.steps?.join('; ') ?? ''));
        await refresh();
      } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
      finally { hide(); }
    }
  });
}

async function createCustomContainerFromComponents() {
  try {
    const payload = await api<any>('/containers/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: customName.value, image: customImage.value, components: customComponents.value, management_mode: customMode.value, restart_policy: customRestartPolicy.value, auto_restart: customAutoRestart.value }) });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; view.value = 'tasks'; await loadTaskLog(payload.task.id); }
    customModalOpen.value = false; await refresh();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}

async function validateComposeYaml() {
  if (!composeYaml.value.trim()) { composeValidationResult.value = { valid: false, errors: locale.value === 'zh-CN' ? 'YAML 内容为空' : 'YAML content is empty' }; return; }
  composeValidating.value = true; composeValidationResult.value = null;
  try {
    const result = await api<{ valid: boolean; errors?: string; normalized?: string }>('/containers/compose/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml: composeYaml.value }) });
    composeValidationResult.value = result;
  } catch (error) { composeValidationResult.value = { valid: false, errors: error instanceof Error ? error.message : String(error) }; }
  finally { composeValidating.value = false; }
}

async function createCustomContainerFromCompose() {
  if (!composeValidationResult.value?.valid) { message.warning(locale.value === 'zh-CN' ? '请先验证 YAML 语法' : 'Please validate the YAML syntax first'); return; }
  try {
    const payload = await api<any>('/containers/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: customName.value || 'custom_compose', compose_yaml: composeYaml.value }) });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; view.value = 'tasks'; await loadTaskLog(payload.task.id); }
    customModalOpen.value = false; composeYaml.value = ''; composeValidationResult.value = null; await refresh();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}

async function deleteCustomContainerConfirm(container: ContainerRecord) {
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除自定义容器' : 'Confirm Delete Custom Container',
    content: locale.value === 'zh-CN' ? `即将删除容器「${container.name}」。此操作不可撤销。` : `This will delete container "${container.name}". This action cannot be undone.`,
    okText: locale.value === 'zh-CN' ? '确认删除' : 'Confirm Delete', okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel',
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try {
        const result = await api<{ ok: boolean; detail: string }>('/containers/custom/' + encodeURIComponent(container.name), { method: 'DELETE' });
        if (result.ok) message.success(locale.value === 'zh-CN' ? '容器已删除' : 'Container deleted');
        else message.warning(result.detail); await refresh();
      } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
      finally { hide(); }
    }
  });
}

async function saveWorkbenchSettings() {
  try {
    const payload = await api<import('./types').WorkbenchSettings>('/settings/workbench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ management_port: managementPort.value }) });
    workbenchSettings.value = payload;
    message.success(payload.requires_restart ? (locale.value === 'zh-CN' ? '已保存，重启前端服务后生效。' : 'Saved. Restart the frontend service to apply.') : t('configSaved'));
    await refresh();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}

async function saveContainerConfig(container: ContainerRecord, silent = false) {
  try {
    await api('/containers/' + encodeURIComponent(container.key) + '/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public_port: Number(container.public_port), management_mode: container.management_mode, restart_policy: container.restart_policy, auto_restart: container.auto_restart }) });
    if (!silent) { message.success(t('configSaved')); await refresh(); }
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); throw error; }
}

async function toggleLanAccess() { if (!network.value) return; networkMessage.value = t('savingNetwork'); try { const payload = await api<import('./types').NetworkSettings>('/settings/network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lan_access_enabled: !network.value.lan_access_enabled }) }); network.value = payload; networkMessage.value = payload.requires_restart ? t('savedNeedsRestart') + payload.desired_bind_address : t('savedActive'); } catch (error) { networkMessage.value = String(error); } }

/* ── lifecycle ───────────────────────────────── */
onMounted(() => {
  document.documentElement.lang = locale.value;
  document.documentElement.dataset.theme = themeMode.value;
  compactSidebarQuery = window.matchMedia('(max-width: 1320px)');
  syncSidebarMode();
  compactSidebarQuery.addEventListener('change', syncSidebarMode);
  void refresh();
  window.setInterval(() => {
    void refresh();
    if (view.value === 'tasks' && selectedTaskId.value) void loadTaskLog();
    if ((view.value === 'deploy' || view.value === 'load' || view.value === 'services') && !logCollapsed.value) {
      const logName = selectedLogContainer.value || (selectedContainer.value && selectedContainer.value.state !== 'missing' ? actionTargetName(selectedContainer.value) : '');
      if (logName) void loadContainerLogs(logName);
    }
  }, 5000);
});

onBeforeUnmount(() => {
  compactSidebarQuery?.removeEventListener('change', syncSidebarMode);
});
</script>

<template>
  <a-config-provider :locale="antLocale" :theme="antTheme">
    <main :class="['app-shell', sidebarCollapsed ? 'sidebar-collapsed' : '', isDark ? 'theme-dark' : 'theme-light']">
      <aside class="sidebar">
        <div class="brand-block">
          <img :src="brandImage" :class="['brand-mark', isDark ? 'brand-mark-wide' : '']" alt="AMUIN" />
          <div class="brand-text"><strong>{{ t('workstation') }}</strong><span>{{ t('studioName') }}</span></div>
          <a-tooltip :title="sidebarCollapsed ? (locale === 'zh-CN' ? '展开菜单' : 'Expand menu') : (locale === 'zh-CN' ? '收起菜单' : 'Collapse menu')">
            <a-button class="sidebar-toggle" size="small" type="text" @click="sidebarCollapsed = !sidebarCollapsed">
              <template #icon><MenuUnfoldOutlined v-if="sidebarCollapsed" /><MenuFoldOutlined v-else /></template>
            </a-button>
          </a-tooltip>
        </div>
        <a-menu class="side-menu" :selected-keys="[view]" mode="inline" :inline-collapsed="sidebarCollapsed" @click="selectView">
          <a-menu-item key="dashboard"><template #icon><DashboardOutlined /></template><span>{{ t('dashboard') }}</span></a-menu-item>
          <a-menu-item key="models"><template #icon><DatabaseOutlined /></template><span>{{ t('models') }}</span></a-menu-item>
          <a-menu-item key="load"><template #icon><RocketOutlined /></template><span>{{ t('load') }}</span></a-menu-item>
          <a-menu-item key="running"><template #icon><CloudServerOutlined /></template><span>{{ t('running') }}</span></a-menu-item>
          <a-menu-item key="playground"><template #icon><PlayCircleOutlined /></template><span>{{ t('playground') }}</span></a-menu-item>
          <a-menu-item key="services"><template #icon><SettingOutlined /></template><span>{{ t('services') }}</span></a-menu-item>
          <a-menu-item key="tasks"><template #icon><UnorderedListOutlined /></template><span>{{ t('tasks') }}</span></a-menu-item>
          <a-menu-item key="settings"><template #icon><SettingOutlined /></template><span>{{ t('settings') }}</span></a-menu-item>
        </a-menu>
        <div class="sidebar-status"><div class="sidebar-copyright"><span>AMUIN AI STACK</span><span>v1.1.0 · 2026.06</span></div></div>
      </aside>
      <section class="workspace">
        <div class="topbar"><span class="topbar-spacer"></span><a-space><a-switch :checked="isDark" checked-children="☽" un-checked-children="☼" @change="toggleTheme" /><a-switch :checked="locale === 'en-US'" checked-children="英" un-checked-children="中" @change="toggleLocale" /></a-space></div>
        <header class="hero"><img class="hero-bg" :src="heroImage" alt="" /><div class="hero-copy"><p>{{ t('studioName') }}</p><h1>{{ pageMeta.title }}</h1><span>{{ pageMeta.desc }}</span></div></header>

        <!-- Home -->
        <section v-if="view === 'dashboard'" class="panel-stack home-flow">
          <a-card class="glass-card home-action-card" :bordered="false">
            <div class="home-action-main">
              <div>
                <a-tag :color="system?.docker?.ok ? 'green' : 'gold'">{{ system?.docker?.ok ? t('dockerReady') : t('dockerCheck') }}</a-tag>
                <h2>{{ homeRecommendation }}</h2>
                <p class="muted-line">{{ t('consoleAddress') }}: {{ consoleAddress }}</p>
              </div>
              <a-space wrap>
                <a-button @click="view = 'models'"><template #icon><DownloadOutlined /></template>{{ locale === 'zh-CN' ? '导入模型' : 'Import Model' }}</a-button>
                <a-button type="primary" @click="view = 'load'"><template #icon><RocketOutlined /></template>{{ t('load') }}</a-button>
                <a-button :disabled="!runningDeployments.length" @click="view = 'playground'"><template #icon><PlayCircleOutlined /></template>{{ t('playground') }}</a-button>
              </a-space>
            </div>
          </a-card>
          <div class="home-stat-grid">
            <a-card class="glass-card" :bordered="false"><div class="home-stat"><span>{{ t('readyModels') }}</span><b>{{ readyModels }}</b></div></a-card>
            <a-card class="glass-card" :bordered="false"><div class="home-stat"><span>{{ locale === 'zh-CN' ? '运行中模型' : 'Running Models' }}</span><b>{{ servingModelCount }}</b></div></a-card>
            <a-card class="glass-card" :bordered="false"><div class="home-stat"><span>{{ t('gpu') }}</span><strong>{{ gpuSummary }}</strong></div></a-card>
            <a-card class="glass-card" :bordered="false"><div class="home-stat"><span>{{ t('activeContainers') }}</span><b>{{ activeContainerCount }}</b></div></a-card>
          </div>
          <div class="home-two-col">
            <a-card :title="t('publishedContainerModels')" class="glass-card" :bordered="false"><a-table size="small" :pagination="false" :data-source="publishedModelRows" :columns="[{ title: t('modelName'), dataIndex: 'model_name', key: 'model_name' }, { title: t('apiAddress'), dataIndex: 'address', key: 'address' }]" /></a-card>
            <a-card :title="t('recentTasks')" class="glass-card" :bordered="false"><a-list size="small" :data-source="dashboardTasks.slice(0, 6)"><template #renderItem="{ item }"><a-list-item class="dashboard-task-item" @click="selectedTaskId = item.id; view = 'tasks'; loadTaskLog(item.id)"><a-list-item-meta :title="taskAlias(item)" :description="taskSummary(item)" /><a-tag :color="badgeColor(item.status)">{{ statusText(item.status) }}</a-tag></a-list-item></template></a-list></a-card>
          </div>
        </section>

        <!-- Models -->
        <section v-if="view === 'models'" class="panel-stack models-split-layout">
          <div class="models-main-col">
            <a-card :bordered="false" class="glass-card"><div class="toolbar-panel model-download-toolbar"><a-input v-model:value="modelUrl" :placeholder="t('urlPlaceholder')" /><a-tag class="download-format-tag" :color="inferredDownloadColor">{{ inferredDownloadLabel }}</a-tag><a-button @click="importPlan">{{ t('checkLink') }}</a-button><a-button type="primary" @click="startDownload">{{ t('download') }}</a-button><a-button @click="refresh"><template #icon><ReloadOutlined /></template>{{ t('refresh') }}</a-button></div></a-card>
            <a-alert v-if="importMessage" type="info" show-icon><template #message><pre class="inline-pre">{{ importMessage }}</pre><div v-if="importPreview?.runtime_hints?.length" class="runtime-hints"><b>{{ t('runtimeCompatibility') }}</b><a-space wrap><a-tooltip v-for="hint in importPreview.runtime_hints" :key="hint.runtime" :title="hint.reason"><a-tag :color="runtimeHintColor(hint.status)">{{ hint.label }} · {{ statusText(hint.status) }}</a-tag></a-tooltip></a-space></div></template></a-alert>
            <div class="compact-grid models-card-grid"><a-card v-for="model in modelLibraryList" :key="model.id" class="model-card compact-card" :bordered="false"><template #title>{{ model.display_name }}</template><template #extra><a-tooltip :title="modelStatusHelp(model)"><a-tag :color="badgeColor(model.status.download)">{{ statusText(model.status.download) }}</a-tag></a-tooltip></template><div class="model-path"><span>{{ shortModelPath(model.local.path) }}</span><a-tooltip :title="t('openFolder')"><a-button size="small" shape="circle" @click="openModelFolder(model)"><template #icon><FolderOpenOutlined /></template></a-button></a-tooltip></div><div class="model-facts"><span>{{ t('format') }}: <b>{{ model.local.format }}</b></span><span>{{ t('size') }}: <b>{{ formatBytes(model.local.size_bytes) }}</b></span><span>{{ t('files') }}: <b>{{ model.local.file_count }}</b></span></div><div v-if="modelAuditSummary(model)" class="model-audit-summary">{{ modelAuditSummary(model) }}</div><div class="support-row"><span>{{ t('supportedContainers') }}:</span><a-space wrap><a-tag v-for="item in getSupportedContainers(model, containers)" :key="item.service" :color="serviceContainerColor(item.container)">{{ item.container?.name ?? item.service }}</a-tag></a-space></div><div v-if="!getSupportedContainers(model, containers).length" class="compatibility-matrix compact-support"><div v-for="row in compatibilityRows(model)" :key="row.service" class="compatibility-row"><b>{{ row.service }}</b><a-tag :color="row.info.status === 'unsupported' ? 'red' : 'green'">{{ row.info.status === 'unsupported' ? (locale === 'zh-CN' ? '不支持' : 'Unsupported') : (locale === 'zh-CN' ? '支持' : 'Supported') }}</a-tag></div></div><a-space class="card-actions model-actions"><a-button size="small" type="primary" @click="publishModelFromCatalog(model)"><template #icon><RocketOutlined /></template>{{ t('load') }}</a-button><a-button size="small" danger :disabled="!canDeleteModel(model)" @click="deleteLocalModel(model)"><template #icon><DeleteOutlined /></template>{{ t('delete') }}</a-button></a-space></a-card></div>
            <a-card class="glass-card compatibility-guide-card models-guide-bottom" :bordered="false"><template #title>{{ locale === 'zh-CN' ? '说明' : 'Guide' }}</template><div class="compat-guide-table"><div class="compat-guide-row" v-for="item in compatibilityGuide" :key="item.format"><span class="format-cell">{{ item.format }}</span><span><a-tag color="blue">{{ item.service }}</a-tag></span><span>{{ item.note }}</span></div></div></a-card>
          </div>
          <div class="models-log-col">
            <a-card class="glass-card models-log-card models-log-top" :title="locale === 'zh-CN' ? '下载任务' : 'Download Tasks'" :bordered="false">
              <a-list v-if="downloadTasks.length" size="small" :data-source="downloadTasks" class="models-task-list">
                <template #renderItem="{ item: task }"><a-list-item :class="selectedDownloadLogId === task.id ? 'selected-row' : ''" @click="selectedDownloadLogId = task.id; loadTaskLog(task.id)"><a-list-item-meta :title="taskAlias(task)" :description="[statusText(task.status), taskFileSummary(task)].filter(Boolean).join(' · ')"></a-list-item-meta><a-progress v-if="!['failed','canceled'].includes(task.status)" :percent="taskProgress(task)" size="small" :show-info="false" class="models-task-progress" /><a-space class="task-control-buttons" @click.stop><a-tooltip v-if="task.status === 'running'" :title="t('pauseTask')"><a-button size="small" @click="controlDownloadTask(task, 'pause')"><template #icon><PauseCircleOutlined /></template></a-button></a-tooltip><a-tooltip v-if="task.status === 'paused'" :title="t('resumeTask')"><a-button size="small" type="primary" @click="controlDownloadTask(task, 'resume')"><template #icon><PlayCircleOutlined /></template></a-button></a-tooltip><a-tooltip v-if="['queued','running','paused'].includes(task.status)" :title="t('cancelTask')"><a-button size="small" danger @click="controlDownloadTask(task, 'cancel')"><template #icon><DeleteOutlined /></template></a-button></a-tooltip></a-space></a-list-item></template>
              </a-list>
              <a-empty v-else :description="locale === 'zh-CN' ? '暂无下载任务' : 'No download tasks'" style="padding:12px 0" />
            </a-card>
            <a-card class="glass-card models-log-card models-log-bottom task-events-card" :title="locale === 'zh-CN' ? '任务事件' : 'Task Events'" :bordered="false">
              <div class="task-event-timeline">
                <div v-for="(line, index) in downloadEventTimeline()" :key="index" class="task-event-line">
                  <span class="task-event-dot"></span><span>{{ line }}</span>
                </div>
              </div>
            </a-card>
          </div>
        </section>

        <!-- Services -->
        <section v-if="view === 'services'" class="panel-stack services-split">
          <div class="preset-container-grid">
            <a-card v-for="container in runtimeContainers" :key="container.key" class="glass-card compact-card" :title="container.title" :bordered="false">
              <template #extra><a-space wrap><a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag><a-tag :color="imageStatusColor(container)">{{ imageStatusText(container) }}</a-tag><a-tag :color="testStatusColor(container.test_status)">{{ testStatusText(container.test_status) }}</a-tag></a-space></template>
              <div class="container-facts"><span>{{ t('containerName') }}<b>{{ container.name }}</b></span><span>{{ t('image') }}<b>{{ container.official_image || container.image || '-' }}</b></span></div>
              <div v-if="container.software_versions" class="version-tags"><b>{{ t('softwareVersions') }}</b><a-space wrap><a-tag v-for="(value, key) in container.software_versions" :key="key">{{ key }}: {{ value }}</a-tag></a-space></div>
              <div class="container-action-row">
                <b class="action-label">{{ locale === 'zh-CN' ? '环境准备：' : 'Prep:' }}</b>
                <a-button size="small" :loading="isContainerActionBusy(container, 'start')" :disabled="container.state === 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'start')">{{ t('start') }}</a-button>
                <a-button size="small" danger :loading="isContainerActionBusy(container, 'stop')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'stop')">{{ t('stop') }}</a-button>
                <a-button size="small" :loading="isContainerActionBusy(container, 'logs')" :disabled="container.state === 'missing' || isContainerBusy(container)" @click="viewContainerLogs(container)">{{ t('viewLogs') }}</a-button>
              </div>
              <div class="container-config-inline">
                <span class="config-inline-item"><label>{{ t('publishingPort') }}</label><a-input-number v-model:value="container.public_port" :min="1024" :max="65535" size="small" style="width:100px" /></span>
                <span class="config-inline-item"><label>{{ t('managementMode') }}</label><a-segmented v-model:value="container.management_mode" :options="[{ label: t('once'), value: 'once' }, { label: t('resident'), value: 'resident' }]" size="small" /></span>
                <span class="config-inline-item"><label>{{ t('restartPolicy') }}</label><a-select v-model:value="container.restart_policy" :options="[{label:'no', value:'no'}, {label:'unless-stopped', value:'unless-stopped'}, {label:'always', value:'always'}, {label:'on-failure', value:'on-failure'}]" size="small" style="width:120px" /></span>
                <a-button type="primary" size="small" @click="saveContainerConfig(container)">{{ t('saveConfig') }}</a-button>
              </div>
            </a-card>
            <div class="add-custom-zone" @click="customModalOpen = true"><div class="add-icon"><PlusOutlined /></div><div>{{ locale === 'zh-CN' ? '点击添加自定义容器' : 'Click to add a custom container' }}</div><div class="add-custom-caption">{{ locale === 'zh-CN' ? '支持组件选择和 Compose 文件两种方式' : 'Supports component selection or Compose file' }}</div></div>
          </div>
          <template v-if="customContainers.length">
            <div class="preset-container-grid">
              <a-card v-for="container in customContainers" :key="container.key" class="glass-card compact-card" :title="container.title" :bordered="false">
                <template #extra><a-space wrap><a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag></a-space></template>
                <div class="container-facts"><span>{{ t('containerName') }}<b>{{ container.name }}</b></span><span>{{ t('image') }}<b>{{ container.image || '-' }}</b></span></div>
                <a-space class="card-actions model-actions">
                  <a-button size="small" :loading="isContainerActionBusy(container, 'start')" :disabled="container.state === 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'start')">{{ t('start') }}</a-button>
                  <a-button size="small" danger :loading="isContainerActionBusy(container, 'stop')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'stop')">{{ t('stop') }}</a-button>
                  <a-button size="small" danger @click="deleteCustomContainerConfirm(container)"><template #icon><DeleteOutlined /></template>{{ locale === 'zh-CN' ? '删除' : 'Delete' }}</a-button>
                </a-space>
              </a-card>
            </div>
          </template>
          <a-modal v-model:open="customModalOpen" :title="locale === 'zh-CN' ? '新建自定义容器方案' : 'New Custom Container Plan'" :width="680" :footer="null">
            <a-tabs v-model:activeKey="customTab" type="card">
              <a-tab-pane key="components" :tab="locale === 'zh-CN' ? '组件选择' : 'Component Selection'">
                <a-form layout="vertical">
                  <a-form-item :label="t('customName')"><a-input v-model:value="customName" :placeholder="locale === 'zh-CN' ? '输入方案名称' : 'Enter plan name'" /></a-form-item>
                  <a-form-item :label="t('imageName')"><a-input v-model:value="customImage" placeholder="e.g. nvcr.io/nvidia/pytorch:25.04-py3" /></a-form-item>
                  <a-form-item :label="t('components')"><a-checkbox-group v-model:value="customComponents" :options="['cuda','pytorch','python','nodejs','modelscope','huggingface','vllm','tensorrt-llm']" /></a-form-item>
                  <a-form-item :label="t('managementMode')"><a-segmented v-model:value="customMode" :options="[{ label: t('once'), value: 'once' }, { label: t('resident'), value: 'resident' }]" /></a-form-item>
                  <a-button type="primary" block @click="createCustomContainerFromComponents">{{ t('createContainer') }}</a-button>
                </a-form>
              </a-tab-pane>
              <a-tab-pane key="compose" :tab="locale === 'zh-CN' ? 'Compose 文件' : 'Compose File'">
                <a-form layout="vertical">
                  <a-form-item :label="locale === 'zh-CN' ? 'Docker Compose YAML' : 'Docker Compose YAML'"><a-textarea v-model:value="composeYaml" :rows="14" class="compose-editor" :placeholder="composePlaceholder" /></a-form-item>
                  <a-space><a-button @click="validateComposeYaml" :loading="composeValidating">{{ locale === 'zh-CN' ? '验证语法' : 'Validate Syntax' }}</a-button><a-button type="primary" :disabled="!composeValidationResult?.valid" @click="createCustomContainerFromCompose">{{ locale === 'zh-CN' ? '创建容器' : 'Create Container' }}</a-button></a-space>
                  <div v-if="composeValidationResult" :class="['validation-result', composeValidationResult.valid ? 'success' : 'error']">{{ composeValidationResult.valid ? (locale === 'zh-CN' ? 'YAML 语法验证通过' : 'YAML syntax validated') : composeValidationResult.errors }}</div>
                </a-form>
              </a-tab-pane>
            </a-tabs>
          </a-modal>
        </section>

        <!-- Deploy -->
        <section v-if="view === 'deploy'" class="panel-stack deploy-page-layout">
          <div class="deploy-main-col">
            <div class="runtime-service-grid">
              <a-card v-for="container in containers.filter((item) => item.runtime !== 'custom')" :key="container.key" class="glass-card runtime-service-card" :title="container.title" :bordered="false">
                <template #extra><a-space wrap><a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag><a-tag :color="imageStatusColor(container)">{{ imageStatusText(container) }}</a-tag><a-tag :color="testStatusColor(container.test_status)">{{ testStatusText(container.test_status) }}</a-tag></a-space></template>
                <div class="deploy-kv-grid compact-kv">
                  <span>{{ t('containerName') }}<b>{{ container.name }}</b></span><span>{{ t('currentInstance') }}<b>{{ container.instance_name || '-' }}</b></span><span>{{ t('publishingPort') }}<b>{{ container.public_port || container.ports }}</b></span><span>{{ t('officialImage') }}<b>{{ container.official_image || container.image || '-' }}</b></span><span>{{ t('managementMode') }}<b>{{ t(container.management_mode) }} · {{ container.restart_policy || 'unless-stopped' }}</b></span><span>{{ t('runtime') }}<b>{{ container.runtime }}</b></span>
                </div>
                <div v-if="container.software_versions" class="version-tags"><b>{{ t('softwareVersions') }}</b><a-space wrap><a-tag v-for="(value, key) in container.software_versions" :key="key">{{ key }}: {{ value }}</a-tag></a-space></div>
                <div class="deploy-action-row">
                  <a-tooltip :title="t('start')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'start')" :disabled="container.state === 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'start')"><template #icon><PlayCircleOutlined /></template></a-button></a-tooltip>
                  <a-tooltip :title="t('stop')"><a-button class="runtime-action-btn" danger :loading="isContainerActionBusy(container, 'stop')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'stop')"><template #icon><PauseCircleOutlined /></template></a-button></a-tooltip>
                  <a-tooltip :title="t('restart')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'restart')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'restart')"><template #icon><SyncOutlined /></template></a-button></a-tooltip>
                  <a-tooltip :title="t('viewLogs')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'logs')" :disabled="isContainerBusy(container)" @click="viewContainerLogs(container)"><template #icon><FileTextOutlined /></template></a-button></a-tooltip>
                </div>
              </a-card>
            </div>
            <a-card :title="t('serviceLogs') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')" class="glass-card deploy-log-bottom" :bordered="false">
              <template #extra><a-space><a-button size="small" @click="selectedLogContainer ? loadContainerLogs(selectedLogContainer) : loadTaskLog()"><template #icon><ReloadOutlined /></template></a-button><a-button size="small" @click="logCollapsed = !logCollapsed">{{ logCollapsed ? t('expandLog') : t('collapseLog') }}</a-button></a-space></template>
              <pre v-if="!logCollapsed" class="message-block log-block service-log-block">{{ containerLog || taskLog || t('noTaskSelected') }}</pre>
            </a-card>
          </div>
          <div class="deploy-task-bar">
            <a-card class="glass-card" :title="locale === 'zh-CN' ? '操作日志' : 'Operation Logs'" :bordered="false" size="small">
              <template #extra><a-button size="small" @click="loadContainerLogs(selectedLogContainer)" v-if="selectedLogContainer"><template #icon><ReloadOutlined /></template></a-button></template>
              <div class="deploy-task-list">
                <a-list size="small" :data-source="visibleTasks.filter((t) => t.type === 'deploy' || t.type === 'container').slice(0, 6)">
                  <template #renderItem="{ item: task }"><a-list-item class="deploy-task-item" @click="selectedTaskId = task.id; loadTaskLog(task.id)"><a-list-item-meta :title="taskTypeText(task.type) + ' · ' + taskAlias(task)" :description="statusText(task.status)"></a-list-item-meta><a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag></a-list-item></template>
                  <template #empty><a-empty :description="locale === 'zh-CN' ? '暂无操作记录' : 'No logs'" style="padding:12px 0" :image-style="{height:'40px'}" /></template>
                </a-list>
              </div>
            </a-card>
          </div>
        </section>

        <!-- Load -->
        <section v-if="view === 'load'" class="panel-stack deploy-grid deploy-tuned">
          <a-card :title="t('deployModel')" class="glass-card deploy-list deploy-column-card" :bordered="false">
            <a-list :data-source="readyModelList" class="deploy-model-list">
              <template #renderItem="{ item: model }"><a-list-item :class="deployModelId === model.id ? 'selected-row' : ''" @click="selectDeployModel(model)"><div class="model-list-content"><span class="model-list-name">{{ model.display_name }}</span><span class="model-list-path">{{ shortModelPath(model.local.path) }}</span></div><div class="model-list-tags"><a-tag :color="badgeColor(model.status.download)">{{ statusText(model.status.download) }}</a-tag><a-tag v-if="model.local.format" color="default" style="font-family:var(--font-mono);font-size:0.68rem;margin-top:2px">{{ model.local.format }}</a-tag></div></a-list-item></template>
            </a-list>
          </a-card>
          <div class="deploy-center deploy-column-card">
            <a-card :title="t('selectedContainer')" class="glass-card deploy-compact-card" :bordered="false">
              <template #extra><a-space wrap><a-tag :color="containerStateColor(selectedContainer)">{{ selectedContainer ? containerStateText(selectedContainer) : '-' }}</a-tag><a-tag :color="imageStatusColor(selectedContainer)">{{ imageStatusText(selectedContainer) }}</a-tag><a-tag :color="testStatusColor(selectedContainer?.test_status)">{{ testStatusText(selectedContainer?.test_status) }}</a-tag></a-space></template>
              <a-select v-model:value="selectedContainerKey" :options="containerOptions" class="full-width" @change="() => { if (selectedContainer && selectedContainer.state !== 'missing') loadContainerLogs(actionTargetName(selectedContainer)) }" />
              <div v-if="selectedContainer" class="deploy-kv-grid compact-kv">
                <span>{{ t('containerName') }}<b>{{ selectedContainer.name }}</b></span><span>{{ t('currentInstance') }}<b>{{ selectedContainer.instance_name || '-' }}</b></span><span>{{ t('publishingPort') }}<b>{{ selectedContainer.public_port || selectedContainer.ports }}</b></span><span>{{ t('runningModel') }}<b>{{ selectedRunningModelLabel() }}</b></span><span>{{ t('officialImage') }}<b>{{ selectedContainer.official_image || selectedContainer.image || '-' }}</b></span><span>{{ t('managementMode') }}<b>{{ t(selectedContainer.management_mode) }} · {{ selectedContainer.restart_policy || 'unless-stopped' }}</b></span>
              </div>
            </a-card>
            <a-card :title="t('deploymentInfo')" class="glass-card deploy-compact-card deployment-info-short" :bordered="false">
              <a-empty v-if="!deploymentIsActive(selectedDeployment)" :description="t('noRunningModels')" />
              <div v-else class="deploy-kv-grid compact-kv"><span>{{ t('loadedModel') }}<b>{{ currentLoadedModel()?.display_name || selectedRunningModelLabel() }}</b></span><span>{{ t('apiAddress') }}<b>{{ selectedPublicBaseUrl() }}</b></span></div>
              <a-space class="card-actions model-actions"><a-button danger size="small" :disabled="!selectedDeployment || selectedDeployment.status !== 'running'" @click="unloadSelectedDeployment()">{{ t('unload') }}</a-button></a-space>
            </a-card>
            <a-card :title="t('log') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')" class="glass-card deploy-log" :bordered="false">
              <template #extra><a-button size="small" @click="logCollapsed = !logCollapsed">{{ logCollapsed ? t('expandLog') : t('collapseLog') }}</a-button></template>
              <pre v-if="!logCollapsed" class="message-block log-block deploy-live-log">{{ containerLog || taskLog }}</pre>
            </a-card>
          </div>
          <aside class="deploy-params deploy-column-card">
            <a-card :title="t('parameters')" class="glass-card" :bordered="false">
              <a-form layout="vertical">
                <a-form-item :label="t('openaiName')"><a-input v-model:value="deployOpenAiModel" :placeholder="deployModelId" /></a-form-item>
                <template v-if="selectedContainer?.runtime === 'vllm'">
                  <a-form-item :label="t('contextLength') + ' · ' + paramLimitText()"><div class="param-control"><a-input-number v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /><a-slider v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /></div></a-form-item>
                  <a-form-item :label="t('gpuUtil')"><div class="param-control"><a-input-number v-model:value="deployGpuUtil" :min="10" :max="99" :step="1" addon-after="%" /><a-slider v-model:value="deployGpuUtil" :min="10" :max="99" :step="1" /></div></a-form-item>
                  <a-form-item :label="t('maxSeqs')"><div class="param-control"><a-input-number v-model:value="deployMaxSeqs" :min="1" :max="256" /><a-slider v-model:value="deployMaxSeqs" :min="1" :max="256" /></div></a-form-item>
                  <a-form-item :label="t('tensorParallel')"><div class="param-control"><a-input-number v-model:value="deployTensorParallel" :min="1" :max="tensorParallelLimit" /><a-slider v-model:value="deployTensorParallel" :min="1" :max="tensorParallelLimit" /></div></a-form-item>
                  <a-form-item :label="t('kvCacheDtype')"><a-select v-model:value="deployKvCacheDtype" :options="[{label:'auto', value:'auto'}, {label:'fp8', value:'fp8'}, {label:'fp8_e5m2', value:'fp8_e5m2'}]" /></a-form-item>
                </template>
                <template v-else-if="selectedContainer?.runtime === 'trtllm'">
                  <a-form-item :label="t('trtMaxBatchSize')"><div class="param-control"><a-input-number v-model:value="trtMaxBatchSize" :min="1" :max="256" /><a-slider v-model:value="trtMaxBatchSize" :min="1" :max="256" /></div></a-form-item>
                  <a-form-item :label="t('trtMaxTokens') + ' · ' + paramLimitText()"><div class="param-control"><a-input-number v-model:value="trtMaxNumTokens" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /><a-slider v-model:value="trtMaxNumTokens" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /></div></a-form-item>
                  <a-form-item :label="t('trtKvFraction')"><div class="param-control"><a-input-number v-model:value="trtKvCacheFraction" :min="0.1" :max="0.99" :step="0.01" /><a-slider v-model:value="trtKvCacheFraction" :min="0.1" :max="0.99" :step="0.01" /></div></a-form-item>
                  <a-form-item :label="t('tensorParallel')"><div class="param-control"><a-input-number v-model:value="trtTpSize" :min="1" :max="tensorParallelLimit" /><a-slider v-model:value="trtTpSize" :min="1" :max="tensorParallelLimit" /></div></a-form-item>
                  <a-form-item :label="t('pipelineParallel')"><div class="param-control"><a-input-number v-model:value="trtPpSize" :min="1" :max="16" /><a-slider v-model:value="trtPpSize" :min="1" :max="16" /></div></a-form-item>
                </template>
                <a-space direction="vertical" class="full-width">
                  <a-button block :loading="deploymentPlanLoading" :disabled="!canDeployToSelected()" @click="previewDeploymentPlan">{{ locale === 'zh-CN' ? '预览计划' : 'Preview Plan' }}</a-button>
                  <a-button type="primary" block :disabled="!canDeployToSelected()" @click="deploySelectedModel">{{ t('loadHere') }}</a-button>
                </a-space>
                <div v-if="deploymentPlanPreview" class="deployment-plan-preview">
                  <div class="plan-preview-header"><b>{{ locale === 'zh-CN' ? '运行计划' : 'Runtime Plan' }}</b><a-tag :color="runtimeHintColor(deploymentPlanPreview.compatibility?.status || 'possible')">{{ statusText(deploymentPlanPreview.compatibility?.status || 'planned') }}</a-tag></div>
                  <a-space size="small" wrap class="task-plan-stages"><a-tooltip v-for="stage in deploymentPlanPreview.stages || []" :key="stage.id" :title="stage.detail + (stage.target ? ' · ' + stage.target : '')"><a-tag>{{ stage.label }}</a-tag></a-tooltip></a-space>
                  <div class="deploy-kv-grid compact-kv plan-preview-kv"><span>{{ t('apiAddress') }}<b>{{ deploymentPlanPreview.base_url }}</b></span><span>Health<b>{{ deploymentPlanPreview.health_url }}</b></span></div>
                  <pre class="inline-pre plan-preview-command">{{ deploymentPlanPreview.launch?.command }}</pre>
                </div>
              </a-form>
            </a-card>
          </aside>
        </section>


        <!-- Running -->
        <section v-if="view === 'running'" class="panel-stack running-grid">
          <a-card v-for="deployment in runningDeployments" :key="deployment.deployment_id" class="model-card running-card" :bordered="false">
            <template #title>{{ deployment.openai_models.join(', ') || deployment.runtime }}</template>
            <template #extra><a-tag :color="badgeColor(deployment.status)">{{ statusText(deployment.status) }}</a-tag></template>
            <div class="deploy-kv-grid compact-kv">
              <span>{{ t('runtime') }}<b>{{ deployment.service_type }}</b></span>
              <span>{{ t('port') }}<b>{{ deployment.public_port }}</b></span>
              <span>{{ t('modelListEndpoint') }}<b>{{ modelEndpoint(deployment) }}</b></span>
              <span>{{ t('chatEndpoint') }}<b>{{ chatEndpoint(deployment) }}</b></span>
            </div>
            <a-space class="card-actions model-actions" wrap>
              <a-button size="small" @click="copyText(modelEndpoint(deployment))"><template #icon><CopyOutlined /></template>/v1/models</a-button>
              <a-button size="small" @click="copyText(chatEndpoint(deployment))"><template #icon><CopyOutlined /></template>/v1/chat/completions</a-button>
              <a-button size="small" type="primary" @click="selectedPlaygroundDeploymentId = deployment.deployment_id; view = 'playground'"><template #icon><PlayCircleOutlined /></template>{{ t('playground') }}</a-button>
            </a-space>
          </a-card>
          <a-empty v-if="!runningDeployments.length" :description="t('noRunningModels')" />
        </section>

        <!-- Playground -->
        <section v-if="view === 'playground'" class="panel-stack playground-layout">
          <a-card class="glass-card" :title="t('playground')" :bordered="false">
            <a-form layout="vertical">
              <a-form-item :label="t('runningModel')"><a-select v-model:value="selectedPlaygroundDeploymentId" :options="runningDeployments.map((item) => ({ label: item.openai_models.join(', ') || item.runtime, value: item.deployment_id }))" :placeholder="t('noRunningModels')" /></a-form-item>
              <a-form-item :label="locale === 'zh-CN' ? '测试消息' : 'Test Message'"><a-textarea v-model:value="playgroundPrompt" :rows="5" /></a-form-item>
              <a-space wrap><a-button @click="copyText(playgroundCurl)"><template #icon><CopyOutlined /></template>curl</a-button><a-button @click="copyText(playgroundSdk)"><template #icon><CopyOutlined /></template>OpenAI SDK</a-button></a-space>
            </a-form>
          </a-card>
          <a-card class="glass-card" :title="locale === 'zh-CN' ? '调用示例' : 'Request Examples'" :bordered="false">
            <b>curl</b><pre class="message-block log-block playground-code">{{ playgroundCurl }}</pre>
            <b>Python</b><pre class="message-block log-block playground-code">{{ playgroundSdk }}</pre>
          </a-card>
        </section>

        <!-- Tasks -->
        <section v-if="view === 'tasks'" class="panel-stack task-grid">
          <a-card :title="t('taskMonitor')" class="glass-card" :bordered="false"><p class="muted-line">{{ t('taskHint') }}</p><a-list :data-source="visibleTasks" class="task-list"><template #renderItem="{ item: task }"><a-list-item :class="selectedTaskId === task.id ? 'selected-row' : ''" @click="selectedTaskId = task.id; loadTaskLog(task.id)"><a-list-item-meta :title="taskTypeText(task.type) + ' · ' + statusText(task.status)" :description="taskSummary(task)"><template v-if="taskRuntimePlanStages(task).length" #description><div class="task-description"><span>{{ taskSummary(task) }}</span><a-space size="small" wrap class="task-plan-stages"><a-tooltip v-for="stage in taskRuntimePlanStages(task)" :key="stage.id" :title="stage.detail + (stage.target ? ' · ' + stage.target : '')"><a-tag :color="taskRuntimePlanStageColor(task, stage.id)">{{ stage.label }} · {{ statusText(taskRuntimePlanStageStatus(task, stage.id)) }}</a-tag></a-tooltip></a-space></div></template></a-list-item-meta><a-progress v-if="!['failed','canceled'].includes(task.status)" class="task-progress" :percent="taskProgress(task)" :show-info="false" /><a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag><a-space v-if="task.type === 'download'" class="task-control-buttons task-page-controls" @click.stop><a-tooltip v-if="task.status === 'running'" :title="t('pauseTask')"><a-button size="small" @click="controlDownloadTask(task, 'pause')"><template #icon><PauseCircleOutlined /></template></a-button></a-tooltip><a-tooltip v-if="task.status === 'paused'" :title="t('resumeTask')"><a-button size="small" type="primary" @click="controlDownloadTask(task, 'resume')"><template #icon><PlayCircleOutlined /></template></a-button></a-tooltip><a-tooltip v-if="['queued','running','paused'].includes(task.status)" :title="t('cancelTask')"><a-button size="small" danger @click="controlDownloadTask(task, 'cancel')"><template #icon><DeleteOutlined /></template></a-button></a-tooltip></a-space><a-space v-if="task.diagnostic?.repair_actions?.length" class="task-control-buttons task-page-controls" @click.stop><a-tooltip v-for="action in task.diagnostic.repair_actions.slice(0, 2)" :key="action.action" :title="action.label"><a-button v-if="action.action === &quot;view_logs&quot;" size="small" @click="repairTask(task, action.action)"><template #icon><EyeOutlined /></template></a-button><a-button v-else size="small" @click="repairTask(task, action.action)">{{ action.label }}</a-button></a-tooltip></a-space></a-list-item></template></a-list></a-card>
          <a-card :title="t('taskLogs')" class="glass-card" :bordered="false"><a-space class="log-toolbar"><span>{{ selectedTask?.id ?? t('noTaskSelected') }}</span><a-button size="small" :disabled="!selectedTaskId" @click="loadTaskLog()">{{ t('refresh') }}</a-button></a-space><pre v-if="selectedTask" class="message-block task-event-block">{{ taskEventLog(selectedTask) }}</pre><pre class="message-block log-block">{{ taskLog || t('noTaskSelected') }}</pre></a-card>
        </section>

        <!-- Settings -->
        <section v-if="view === 'settings'" class="settings-panel settings-card-grid">
          <a-card :title="locale === 'zh-CN' ? '端口与控制台' : 'Port & Console'" class="glass-card settings-card" :bordered="false"><div class="settings-row-grid"><div class="settings-block"><b>{{ locale === 'zh-CN' ? '管理端口' : 'Management Port' }}</b><a-input-number v-model:value="managementPort" :min="1024" :max="65535" class="full-width" style="margin-top:8px" /><a-button type="primary" block @click="saveWorkbenchSettings" style="margin-top:8px">{{ t('saveConfig') }}</a-button></div><div class="settings-block"><b>{{ locale === 'zh-CN' ? '控制台地址' : 'Console Address' }}</b><div class="settings-summary compact-settings-summary" style="margin-top:8px"><span>{{ t('apiAddress') }}<b>{{ system?.management_url ?? 'http://localhost:8888' }}</b></span><span>{{ locale === 'zh-CN' ? '配置地址' : 'Configured URL' }}<b>{{ system?.configured_management_url ?? ('http://localhost:' + managementPort) }}</b></span><a-tag v-if="workbenchSettings?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div></div></div></a-card>
          <a-card :title="locale === 'zh-CN' ? '网络与绑定' : 'Network & Binding'" class="glass-card settings-card" :bordered="false"><template #extra><a-tag :color="network?.lan_access_enabled ? 'green' : 'gold'">{{ network?.lan_access_enabled ? t('lanEnabled') : t('localhostOnly') }}</a-tag></template><div class="settings-row-grid"><div class="settings-block"><b>{{ t('networkAccess') }}</b><p class="muted-line">{{ t('networkHint') }}</p><div class="settings-controls compact-settings-controls"><a-switch :checked="network?.lan_access_enabled" @change="toggleLanAccess" /><a-tag v-if="network?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div></div><div class="settings-block"><b>{{ locale === 'zh-CN' ? '绑定状态' : 'Bind Status' }}</b><div class="settings-summary compact-settings-summary" style="margin-top:8px"><span>{{ t('activeBind') }}<b>{{ network?.active_bind_address ?? '0.0.0.0' }}</b></span><span>{{ t('desiredBind') }}<b>{{ network?.desired_bind_address ?? '0.0.0.0' }}</b></span></div></div></div><a-alert class="plan-alert compact-plan-alert" type="info" style="margin-top:12px"><template #message><pre class="inline-pre">{{ networkMessage || t('networkIdle') }}</pre></template></a-alert></a-card>
        </section>
      </section>
    </main>
  </a-config-provider>
</template>
