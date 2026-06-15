<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CopyOutlined, DeleteOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { message, Modal, theme as antdTheme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import enUS from 'ant-design-vue/es/locale/en_US';

type View = 'dashboard' | 'models' | 'services' | 'deploy' | 'load' | 'tasks' | 'settings';
type Locale = 'zh-CN' | 'en-US';
type ThemeMode = 'light' | 'dark';
type ServiceType = 'vllm' | 'trtllm' | 'audio';
type CompatInfo = { status: string; reason: string };
type ModelRecord = {
  id: string;
  display_name: string;
  local: { path: string; format: string; size_bytes: number; file_count: number; weight_files?: number; config_files?: string[]; incomplete_files?: string[] };
  runtime: { preferred: string; supported: string[] };
  inference?: { context_length?: { min: number; max: number; default: number; step: number; source: string } };
  compatibility: Record<string, CompatInfo>;
  status: { download: string; deploy: string; health: string };
};
type DeploymentRecord = { deployment_id: string; model_id?: string | null; status: string; service_type: string; runtime: string; container_name?: string; public_port: number; base_url: string; health_url: string; openai_models: string[]; warnings: string[] };
type RuntimeHint = { runtime: string; status: string; label: string; reason: string };
type TaskRecord = { id: string; type: string; status: string; command: string; cwd: string; log_path: string; metadata: Record<string, unknown>; created_at: string; updated_at: string; started_at?: string; finished_at?: string; error?: string; progress_percent?: number; downloaded_bytes?: number; target_path?: string };
type ImportPreview = { model?: { provider?: string; repo_id?: string; target_path?: string }; runtime_hints?: RuntimeHint[]; download?: { command?: string }; message?: string };
type ContainerRecord = { key: string; name: string; slot_name?: string; instance_name?: string | null; title: string; image: string; status: string; state: string; ports: string; public_port?: number; runtime: string; management_mode: string; restart_policy?: string; auto_restart?: boolean; preset: boolean; components: string[]; official_image?: string; image_pulled?: boolean; test_status?: string; software_versions?: Record<string, string> };
type NetworkSettings = { lan_access_enabled: boolean; desired_bind_address: string; active_bind_address: string; requires_restart: boolean; updated_at: string };
type WorkbenchSettings = { management_port: number; active_management_port: number; requires_restart: boolean; updated_at: string };
type DeviceInfo = { hostname?: string; vendor?: string; model?: string; os?: { name?: string; kernel?: string; arch?: string; version?: string; build?: string }; cpu?: { model?: string; cores?: number }; memory?: { total_bytes?: number; free_bytes?: number }; storage?: { available?: boolean; volumes?: Array<{ mount: string; total_bytes: number; used_bytes: number; free_bytes: number; used_percent: number }> }; gpu?: { available?: boolean; detail?: string; devices?: Array<Record<string, unknown>> } };
type SystemCheck = { management_url: string; configured_management_url?: string; backend_url: string; lan_addresses?: string[]; workbench?: WorkbenchSettings; service_ports?: Record<string, { port: number; available: boolean }>; docker?: { ok: boolean; detail: string; containers?: Array<{ name: string; status: string }> }; status?: { uptime_seconds?: number; load_average?: number[]; cpu_load_percent?: number }; device?: DeviceInfo; network?: NetworkSettings };

const copy = {
  'zh-CN': {
    studioName: 'AMUIN AI STACK', workstation: 'AI工作站', dashboard: '仪表盘', models: '模型库', services: '容器管理', deploy: '部署服务', load: '加载模型', tasks: '任务', settings: '设置',
    pageDashboardDesc: '查看机器资源、运行中的模型服务和最近任务。', pageModelsDesc: '下载、校验、打开目录和删除本地模型。', pageServicesDesc: '新建和配置可用于模型发布的运行容器。', pageDeployDesc: '拉取运行时镜像、启动测试、查看镜像和容器日志。', pageLoadDesc: '把本地模型加载到已经准备好的目标容器。', pageTasksDesc: '跟踪下载、部署、容器操作任务，并查看实时日志。', pageSettingsDesc: '配置 AMUIN AI STACK 的主机访问策略。',
    console: '控制台', consoleAddress: '控制台地址', copyAddress: '复制地址', copied: '已复制', copyFailed: '复制失败', readyModels: '就绪模型', activeServices: '活动服务', activeContainers: '活动容器', dockerReady: 'Docker 可用', dockerCheck: 'Docker 待检查', lanEnabled: '局域网开启', localhostOnly: '仅本机',
    urlPlaceholder: '粘贴 Hugging Face 或 ModelScope 模型链接', preview: '预览', download: '下载', refresh: '刷新', provider: '来源', repo: '仓库', target: '目标目录', command: '命令', parsing: '正在解析模型来源...', startingDownload: '正在启动下载任务...', downloadTaskStarted: '下载任务已启动', log: '日志',
    format: '格式', runtime: '运行时', size: '大小', files: '文件数', supportedContainers: '支持容器', path: '路径', openFolder: '打开文件夹', delete: '删除', deleteConfirm: '确认删除模型：', deleteBlocked: '运行中或任务中的模型不能删除', deleting: '正在删除模型...', deleted: '模型已删除', downloadingModel: '下载中的模型', progress: '进度', expectedRuntime: '预期运行容器', autoRuntime: '自动判断', runtimeCompatibility: '下载后预计支持', downloaded: '已下载', downloadTarget: '下载目录', taskDownload: '下载', taskDeploy: '部署', taskContainer: '容器', downloadPolicy: '默认仅下载推理必要快照文件，跳过 Git 历史、缓存和其他框架副本。', source: '来源', modelName: '模型',
    deployModel: '加载模型', container: '容器', selectedContainer: '目标容器', runningModel: '运行模型', noRunningModels: '暂无运行模型', loadHere: '部署到此容器', parameters: '参数配置', openaiName: 'OpenAI 模型名', contextLength: '上下文长度', gpuUtil: 'GPU 显存比例', maxSeqs: '最大并发序列', tensorParallel: '张量并行', kvCacheDtype: 'KV 缓存类型', swapSpace: 'CPU 交换空间(GB)', trtMaxBatchSize: '最大批量', trtMaxTokens: '最大 Token 数', trtKvFraction: 'KV 缓存显存比例', pipelineParallel: '流水线并行', collapseLog: '收起日志', expandLog: '展开日志',
    containerName: '容器名', currentInstance: '当前实例', publishingPort: '发布端口', port: '端口', image: '镜像', components: '组件', managementMode: '管理状态', restartPolicy: '重启策略', autoRestart: '自动重启', once: '仅一次', resident: '常驻', customContainer: '自定义容器方案', addCustomContainer: '新建自定义方案', customHint: '选择组件用于后续构建自定义模型发布环境；创建后会以任务方式跟踪。', createContainer: '创建容器任务', imageName: '镜像名', customName: '方案名称', saveConfig: '保存配置', configSaved: '配置已保存', configHint: '发布 IP 由右上角局域网开关控制；这里仅配置端口和生命周期策略。端口变更会在下次重建或部署时生效。', runtimeTags: '运行组件', containerOperations: '容器操作', start: '启动', stop: '停止', restart: '重启', viewLogs: '查看日志', modelRuntimeOnly: '仅展示模型发布环境，API/前端/数据库等控制平面容器已隐藏。vLLM、TensorRT-LLM 和 Audio Service 使用固定运行环境。', actionSucceeded: '操作已提交', actionFailed: '操作失败',
    taskMonitor: '任务监控', taskLogs: '任务日志', taskHint: '下载、部署和容器操作以任务记录保存；左侧看状态，右侧看日志。', createdAt: '创建时间', updatedAt: '更新时间', status: '状态', noTaskSelected: '选择一个任务查看日志',
    networkAccess: '网络访问', networkHint: '默认允许局域网访问，方便从其他设备联调这台 AI Stack 主机。', activeBind: '当前绑定', desiredBind: '目标绑定', restartRequired: '需要重启', networkIdle: '关闭局域网时绑定 127.0.0.1；开启时绑定 0.0.0.0。', savingNetwork: '正在保存网络访问策略...', savedActive: '已保存并生效。', savedNeedsRestart: '已保存。需要重启本机 Web 服务后生效：',
    deviceStatus: '主机状态', resources: '资源监控', modelRuntime: '模型运行', activityMonitor: '活动监控', containerStatus: '容器状态', publishedContainerModels: '已发布模型', viewModelList: '查看模型列表', allModelEndpoints: '模型接口列表', callId: '调用 ID', host: '主机', deviceModel: '设备型号', operatingSystem: '操作系统', cpu: 'CPU', memory: '内存', storage: '存储', gpu: 'GPU', uptime: '运行时长', dockerAccess: '容器控制', containers: '运行容器', ports: '接口端口', recentTasks: '最近任务', unavailable: '不可用', disabled: '未启用', publishEndpoints: '发布接口', modelListEndpoint: '模型列表', chatEndpoint: '聊天接口', apiAddress: '调用地址', unload: '退出加载', loadedModel: '加载模型', deploymentInfo: '部署信息', modelDetail: '模型信息', needsReviewHelp: '需要检查：模型目录缺少权重、config/tokenizer，或仍有未完成下载文件。请补齐文件或重新下载。', unsupportedHelp: '当前文件格式不能由 AMUIN 内置容器直接发布，可用外部工具或转换格式。', incompleteHelp: '下载未完成，请等待任务完成或重新下载。', alreadyRunning: '已在运行', imagePulled: '已拉取镜像', imageMissing: '未拉取镜像', testPassed: '已测试', testFailed: '测试失败', testRunning: '测试中', untested: '未测试', pullImage: '拉取镜像', startTest: '启动测试', officialImage: '官方镜像', softwareVersions: '软件版本', containerPrep: '环境准备', runtimeReady: '运行时就绪', runtimeNotReady: '运行时未就绪', serviceLogs: '服务日志', publishedModels: '已发布模型', modelLimit: '模型上限', deploymentTaskStarted: '部署任务已启动，正在查看任务日志', free: '空闲'
  },
  'en-US': {
    studioName: 'AMUIN AI STACK', workstation: 'AI Workstation', dashboard: 'Dashboard', models: 'Models', services: 'Containers', deploy: 'Deploy Service', load: 'Load Model', tasks: 'Tasks', settings: 'Settings',
    pageDashboardDesc: 'Inspect host resources, model runtimes, and recent work.', pageModelsDesc: 'Download, verify, open, and remove local models.', pageServicesDesc: 'Create and configure model publishing runtimes.', pageDeployDesc: 'Pull runtime images, run tests, and inspect runtime logs.', pageLoadDesc: 'Load a local model into a prepared target runtime.', pageTasksDesc: 'Track downloads, deployments, container work, and logs.', pageSettingsDesc: 'Configure AMUIN AI STACK host access.',
    console: 'Console', consoleAddress: 'Console Address', copyAddress: 'Copy address', copied: 'Copied', copyFailed: 'Copy failed', readyModels: 'Ready Models', activeServices: 'Active Services', activeContainers: 'Active Containers', dockerReady: 'Docker Ready', dockerCheck: 'Docker Check', lanEnabled: 'LAN On', localhostOnly: 'Local Only',
    urlPlaceholder: 'Paste Hugging Face or ModelScope model URL', preview: 'Preview', download: 'Download', refresh: 'Refresh', provider: 'Provider', repo: 'Repo', target: 'Target', command: 'Command', parsing: 'Parsing model source...', startingDownload: 'Starting download task...', downloadTaskStarted: 'Download task started', log: 'Log',
    format: 'Format', runtime: 'Runtime', size: 'Size', files: 'Files', supportedContainers: 'Supported Containers', path: 'Path', openFolder: 'Open Folder', delete: 'Delete', deleteConfirm: 'Delete model: ', deleteBlocked: 'Running or active-task models cannot be deleted', deleting: 'Deleting model...', deleted: 'Model deleted', downloadingModel: 'Downloading Model', progress: 'Progress', expectedRuntime: 'Expected Runtime', autoRuntime: 'Auto Detect', runtimeCompatibility: 'Expected Runtime Support', downloaded: 'Downloaded', downloadTarget: 'Target', taskDownload: 'Download', taskDeploy: 'Deploy', taskContainer: 'Container', downloadPolicy: 'By default only serving-essential snapshot files are downloaded; Git history, caches, and duplicate framework files are skipped.', source: 'Source', modelName: 'Model',
    deployModel: 'Load Model', container: 'Container', selectedContainer: 'Target Container', runningModel: 'Running Model', noRunningModels: 'No running models', loadHere: 'Deploy Here', parameters: 'Parameters', openaiName: 'OpenAI Model Name', contextLength: 'Context Length', gpuUtil: 'GPU Memory Ratio', maxSeqs: 'Max Sequences', tensorParallel: 'Tensor Parallel', kvCacheDtype: 'KV Cache Dtype', swapSpace: 'CPU Swap Space (GB)', trtMaxBatchSize: 'Max Batch Size', trtMaxTokens: 'Max Tokens', trtKvFraction: 'KV Cache GPU Fraction', pipelineParallel: 'Pipeline Parallel', collapseLog: 'Collapse Logs', expandLog: 'Expand Logs',
    containerName: 'Container', currentInstance: 'Current Instance', publishingPort: 'Public Port', port: 'Port', image: 'Image', components: 'Components', managementMode: 'Mode', restartPolicy: 'Restart Policy', autoRestart: 'Auto Restart', once: 'Once', resident: 'Resident', customContainer: 'Custom Runtime Plan', addCustomContainer: 'New Custom Plan', customHint: 'Choose components for a future custom publishing runtime. Creation will be tracked as a task.', createContainer: 'Create Container Task', imageName: 'Image', customName: 'Plan Name', saveConfig: 'Save Config', configSaved: 'Config saved', configHint: 'Publishing IP is controlled by the LAN switch. This panel only edits port and lifecycle policy. Port changes apply on next recreate or deployment.', runtimeTags: 'Runtime Components', containerOperations: 'Container Actions', start: 'Start', stop: 'Stop', restart: 'Restart', viewLogs: 'Logs', modelRuntimeOnly: 'Only model publishing runtimes are shown. API, frontend, database, and control-plane containers are hidden. vLLM, TensorRT-LLM, and Audio Service use fixed runtime slots.', actionSucceeded: 'Action submitted', actionFailed: 'Action failed',
    taskMonitor: 'Task Monitor', taskLogs: 'Task Logs', taskHint: 'Downloads, deployments, and container work are saved as task records. State lives on the left; logs on the right.', createdAt: 'Created', updatedAt: 'Updated', status: 'Status', noTaskSelected: 'Select a task to view logs',
    networkAccess: 'Network Access', networkHint: 'LAN access is enabled by default for testing this AI Stack host from other machines.', activeBind: 'Active Bind', desiredBind: 'Desired Bind', restartRequired: 'restart required', networkIdle: 'Disabled LAN binds to 127.0.0.1; enabled LAN binds to 0.0.0.0.', savingNetwork: 'Saving network policy...', savedActive: 'Saved and active.', savedNeedsRestart: 'Saved. Restart the local web service to apply: ',
    deviceStatus: 'Host Status', resources: 'Resource Monitor', modelRuntime: 'Model Runtime', activityMonitor: 'Activity Monitor', containerStatus: 'Container Status', publishedContainerModels: 'Published Models', viewModelList: 'View Model List', allModelEndpoints: 'Model Endpoints', callId: 'Call ID', host: 'Host', deviceModel: 'Device Model', operatingSystem: 'OS', cpu: 'CPU', memory: 'Memory', storage: 'Storage', gpu: 'GPU', uptime: 'Uptime', dockerAccess: 'Container Control', containers: 'Containers', ports: 'Ports', recentTasks: 'Recent Tasks', unavailable: 'Unavailable', disabled: 'Disabled', publishEndpoints: 'Published Endpoints', modelListEndpoint: 'Model List', chatEndpoint: 'Chat Endpoint', apiAddress: 'API URL', unload: 'Unload', loadedModel: 'Loaded Model', deploymentInfo: 'Deployment Info', modelDetail: 'Model Info', needsReviewHelp: 'Needs review: weights, config/tokenizer, or download completion files are missing. Complete the files or download again.', unsupportedHelp: 'This format cannot be served by built-in AMUIN runtimes. Use an external runtime or convert it.', incompleteHelp: 'Download is incomplete. Wait for the task to finish or download again.', alreadyRunning: 'Already Running', imagePulled: 'Image Pulled', imageMissing: 'Image Missing', testPassed: 'Tested', testFailed: 'Test Failed', testRunning: 'Testing', untested: 'Untested', pullImage: 'Pull Image', startTest: 'Run Test', officialImage: 'Official Image', softwareVersions: 'Software Versions', containerPrep: 'Environment Prep', runtimeReady: 'Runtime Ready', runtimeNotReady: 'Runtime Not Ready', serviceLogs: 'Service Logs', publishedModels: 'Published Models', modelLimit: 'Model Limit', deploymentTaskStarted: 'Deployment task started. Showing task logs.', free: 'Free'
  }
} as const;
const statusCopy: Record<Locale, Record<string, string>> = {
  'zh-CN': { ready: '就绪', configured: '已配置', running: '运行中', succeeded: '成功', failed: '失败', unsupported: '不支持', incomplete: '未完成', compatible: '兼容', possible: '可能兼容', needs_review: '需检查', not_started: '未启动', planned: '已规划', starting: '启动中', queued: '排队中', stopped: '已停止', missing: '缺失', unknown: '未知', external: '外部工具', disabled: '未启用', already_running: '已在运行' },
  'en-US': { ready: 'Ready', configured: 'Configured', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', unsupported: 'Unsupported', incomplete: 'Incomplete', compatible: 'Compatible', possible: 'Possible', needs_review: 'Needs Review', not_started: 'Not Started', planned: 'Planned', starting: 'Starting', queued: 'Queued', stopped: 'Stopped', missing: 'Missing', unknown: 'Unknown', external: 'External', disabled: 'Disabled', already_running: 'Already Running' }
};

const locale = ref<Locale>((localStorage.getItem('locale') as Locale) || 'zh-CN');
const themeMode = ref<ThemeMode>((localStorage.getItem('themeMode') as ThemeMode) || 'light');
const view = ref<View>('dashboard');
const models = ref<ModelRecord[]>([]);
const deployments = ref<DeploymentRecord[]>([]);
const tasks = ref<TaskRecord[]>([]);
const containers = ref<ContainerRecord[]>([]);
const system = ref<SystemCheck | null>(null);
const network = ref<NetworkSettings | null>(null);
const workbenchSettings = ref<WorkbenchSettings | null>(null);
const managementPort = ref(8888);
const modelUrl = ref('');
const importMessage = ref('');
const importPreview = ref<ImportPreview | null>(null);
const downloadRuntime = ref('auto');
const deployModelId = ref('');
const selectedContainerKey = ref('vllm');
const selectedTaskId = ref('');
const selectedLogContainer = ref('');
const taskLog = ref('');
const containerLog = ref('');
const networkMessage = ref('');
const customComponents = ref<string[]>(['pytorch']);
const customMode = ref('resident');
const customRestartPolicy = ref('unless-stopped');
const customAutoRestart = ref(true);
const customName = ref('');
const customImage = ref('compose-audio-service');
const customModalOpen = ref(false);
const logCollapsed = ref(false);
const modelListDrawerOpen = ref(false);
const deployOpenAiModel = ref('');
const deployContextLength = ref(4096);
const deployGpuUtil = ref(0.85);
const deployMaxSeqs = ref(16);
const deployTensorParallel = ref(1);
const deployKvCacheDtype = ref('auto');
const deploySwapSpace = ref(4);
const trtMaxBatchSize = ref(8);
const trtMaxNumTokens = ref(4096);
const trtKvCacheFraction = ref(0.9);
const trtTpSize = ref(1);
const trtPpSize = ref(1);

const antLocale = computed(() => locale.value === 'zh-CN' ? zhCN : enUS);
const isDark = computed(() => themeMode.value === 'dark');
const antTheme = computed(() => ({ algorithm: isDark.value ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm, token: { colorPrimary: '#0aa7d8', borderRadius: 6 } }));
const heroImage = computed(() => isDark.value ? '/brand/hero-dark.png' : '/brand/hero-light.png');
const brandImage = computed(() => isDark.value ? '/brand/amuin-light.png' : '/brand/logo-au.png');
const t = (key: keyof typeof copy['zh-CN'] | string) => (copy[locale.value] as Record<string, string>)[key] ?? key;
const statusText = (status: string) => statusCopy[locale.value][status] ?? status;
const pageMeta = computed(() => ({
  dashboard: { title: t('dashboard'), desc: t('pageDashboardDesc') }, models: { title: t('models'), desc: t('pageModelsDesc') }, services: { title: t('services'), desc: t('pageServicesDesc') }, deploy: { title: t('deploy'), desc: t('pageDeployDesc') }, load: { title: t('load'), desc: t('pageLoadDesc') }, tasks: { title: t('tasks'), desc: t('pageTasksDesc') }, settings: { title: t('settings'), desc: t('pageSettingsDesc') }
}[view.value]));
const readyModelList = computed(() => models.value.filter((model) => model.status.download === 'ready'));
const readyModels = computed(() => readyModelList.value.length);
const runtimeContainers = computed(() => containers.value.filter((item) => item.runtime !== 'custom'));
const runningServices = computed(() => containers.value.filter((item) => item.state === 'running').length);
const runningDeployments = computed(() => deployments.value.filter((item) => item.status === 'running' || item.openai_models.length));
const taskRank = (status: string) => status === 'running' || status === 'queued' ? 0 : status === 'failed' ? 1 : status === 'succeeded' ? 3 : 2;
const visibleTasks = computed(() => {
  const seen = new Set<string>();
  return [...tasks.value]
    .sort((a, b) => taskRank(a.status) - taskRank(b.status) || b.created_at.localeCompare(a.created_at))
    .filter((task) => {
      if (task.type !== 'deploy' || task.status !== 'succeeded') return true;
      const key = ['deploy', task.metadata?.model_id, task.metadata?.service_type, task.metadata?.openai_model].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
});
const dashboardTasks = computed(() => visibleTasks.value);
const activeTasks = computed(() => tasks.value.filter((task) => ['queued', 'running'].includes(task.status)));
const downloadTasks = computed(() => tasks.value.filter((task) => task.type === 'download' && ['queued', 'running'].includes(task.status)));
const selectedContainer = computed(() => containers.value.find((item) => item.key === selectedContainerKey.value) ?? containers.value[0]);
const selectedTask = computed(() => tasks.value.find((item) => item.id === selectedTaskId.value));
const memoryUsed = computed(() => Math.max(0, (system.value?.device?.memory?.total_bytes ?? 0) - (system.value?.device?.memory?.free_bytes ?? 0)));
const memoryPercent = computed(() => percent(memoryUsed.value, system.value?.device?.memory?.total_bytes ?? 0));
const cpuPercent = computed(() => Math.round(system.value?.status?.cpu_load_percent ?? 0));
const storageVolume = computed(() => system.value?.device?.storage?.volumes?.[0]);
const storagePercent = computed(() => Math.round(storageVolume.value?.used_percent ?? 0));
const gpuSummary = computed(() => {
  const devices = system.value?.device?.gpu?.devices ?? [];
  if (!system.value?.device?.gpu?.available) return system.value?.device?.gpu?.detail ?? t('unavailable');
  return devices.map((device) => String(device.name ?? device.id ?? 'NVIDIA GPU')).join(', ') || 'NVIDIA';
});
const portRows = computed(() => Object.entries(system.value?.service_ports ?? {}).map(([name, info]) => ({ name, ...info })));
const selectedDeployModel = computed(() => models.value.find((item) => item.id === deployModelId.value));
const containerOptions = computed(() => {
  const model = selectedDeployModel.value;
  const allowed = model ? new Set((['vllm', 'trtllm', 'audio'] as ServiceType[]).filter((service) => model.compatibility[service]?.status !== 'unsupported')) : null;
  return containers.value
    .filter((item) => item.runtime !== 'custom' && (!allowed || allowed.has(item.runtime as ServiceType)))
    .map((item) => ({ label: item.title + ' · ' + (item.state === 'missing' ? containerStateText(item) : item.name), value: item.key }));
});
const modelOptions = computed(() => readyModelList.value.map((model) => ({ label: model.display_name, value: model.id })));
const selectedDeployment = computed(() => {
  const container = selectedContainer.value;
  if (!container) return undefined;
  const modelId = deployModelId.value;
  const byModel = runningDeployments.value.find((item) => item.service_type === container.runtime && (!modelId || item.model_id === modelId || item.openai_models.includes(modelId)));
  return byModel ?? runningDeployments.value.find((item) => item.service_type === container.runtime);
});
const activeInferenceDeployments = computed(() => runningDeployments.value);
const activeContainerCount = computed(() => runtimeContainers.value.filter((item) => item.state === 'running').length);
const managementHost = computed(() => {
  if (!network.value?.lan_access_enabled) return 'localhost';
  const lanAddr = system.value?.lan_addresses?.[0];
  if (lanAddr) return lanAddr;
  const host = window.location.hostname || '';
  if (host && !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return host;
  return host || 'localhost';
});
const consoleAddress = computed(() => 'http://' + managementHost.value + ':' + (workbenchSettings.value?.active_management_port ?? 8888));
const modelListSummaryUrl = computed(() => runningDeployments.value[0] ? modelEndpoint(runningDeployments.value[0]) : 'http://' + publicHost.value + ':30000/v1/models');
const publishedModelRows = computed(() => runningDeployments.value.flatMap((deployment) => {
  const names = deployment.openai_models.length ? deployment.openai_models : [deployment.runtime];
  return names.map((name) => ({
    key: deployment.deployment_id + ':' + name,
    model_name: name,
    address: publicBaseUrl(deployment),
    call_id: name
  }));
}));
const publicHost = computed(() => {
  if (network.value?.lan_access_enabled) {
    const lanAddr = system.value?.lan_addresses?.[0];
    if (lanAddr) return lanAddr;
  }
  const host = window.location.hostname || 'localhost';
  if (host && !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return host;
  return system.value?.lan_addresses?.[0] || host || 'localhost';
});
function publicBaseUrl(deployment: DeploymentRecord) { const suffix = ['vllm', 'trtllm'].includes(deployment.service_type) ? '/v1' : ''; return 'http://' + publicHost.value + ':' + deployment.public_port + suffix; }
function modelEndpoint(deployment: DeploymentRecord) { return publicBaseUrl(deployment) + (deployment.service_type === 'audio' ? '/v1/models' : '/models'); }
function chatEndpoint(deployment: DeploymentRecord) { return publicBaseUrl(deployment) + (['vllm', 'trtllm'].includes(deployment.service_type) ? '/chat/completions' : '/v1/chat/completions'); }
const gpuCount = computed(() => Math.max(1, system.value?.device?.gpu?.devices?.length ?? 1));
const contextLimit = computed(() => selectedDeployModel.value?.inference?.context_length ?? { min: 512, max: 4096, default: 4096, step: 512, source: 'default' });
const tensorParallelLimit = computed(() => Math.max(1, Math.min(16, gpuCount.value)));
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function clampDeployParamsForModel() {
  const limit = contextLimit.value;
  deployContextLength.value = clamp(deployContextLength.value || limit.default, limit.min, limit.max);
  deployTensorParallel.value = clamp(deployTensorParallel.value || 1, 1, tensorParallelLimit.value);
  trtMaxNumTokens.value = clamp(trtMaxNumTokens.value || limit.default, limit.min, limit.max);
  trtTpSize.value = clamp(trtTpSize.value || 1, 1, tensorParallelLimit.value);
}
function paramLimitText() { const limit = contextLimit.value; return t('modelLimit') + ': ' + limit.max + ' · ' + limit.source; }
const compatibilityGuide = computed(() => locale.value === 'zh-CN' ? [
  { format: 'HF checkpoint / safetensors', service: 'vLLM', note: '默认发布路线。需要 config、tokenizer 和权重分片完整。' },
  { format: 'TensorRT-LLM engine / 已转换目录', service: 'TensorRT-LLM', note: '只适合 TensorRT-LLM；不能直接交给 vLLM。' },
  { format: 'FunASR / CosyVoice / Whisper 目录', service: 'Audio Service', note: '音频模型不进入 vLLM 或 TensorRT-LLM。' }
] : [
  { format: 'HF checkpoint / safetensors', service: 'vLLM', note: 'Default publishing route. Requires complete config, tokenizer, and weight shards.' },
  { format: 'TensorRT-LLM engine / converted directory', service: 'TensorRT-LLM', note: 'TensorRT-LLM only; do not send this directly to vLLM.' },
  { format: 'FunASR / CosyVoice / Whisper directory', service: 'Audio Service', note: 'Audio models do not go through vLLM or TensorRT-LLM.' }
]);
function compatibilityRows(model: ModelRecord) {
  return (['vllm', 'trtllm', 'audio'] as const)
    .map((service) => ({ service, info: model.compatibility[service] }))
    .filter((item) => item.info);
}

function percent(used: number, total: number) { return total ? Math.round((used / total) * 100) : 0; }
function selectView(info: { key: string }) { view.value = info.key as View; }
function setLocale(next: Locale) { locale.value = next; localStorage.setItem('locale', next); document.documentElement.lang = next; }
function setTheme(next: ThemeMode) { themeMode.value = next; localStorage.setItem('themeMode', next); document.documentElement.dataset.theme = next; }
function toggleTheme(checked: boolean | string | number) { setTheme(checked ? 'dark' : 'light'); }
function toggleLocale(checked: boolean | string | number) { setLocale(checked ? 'en-US' : 'zh-CN'); }
async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(t('copied'));
  } catch {
    message.error(t('copyFailed'));
  }
}
function formatDuration(seconds = 0) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return days ? days + 'd ' + hours + 'h' : hours + 'h ' + minutes + 'm'; }
function formatBytes(value: number) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return (value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index]; }
function badgeColor(status: string) { if (['compatible', 'ready', 'configured', 'running', 'succeeded'].includes(status)) return 'green'; if (['unsupported', 'incomplete', 'failed', 'missing', 'stopped'].includes(status)) return 'red'; return 'gold'; }
function shortModelPath(path: string) { const marker = '/models/'; const index = path.lastIndexOf(marker); return index >= 0 ? '…' + path.slice(index) : path; }
function supportedContainers(model: ModelRecord) { return (['vllm', 'trtllm', 'audio'] as ServiceType[]).filter((service) => model.compatibility[service]?.status !== 'unsupported').map((service) => ({ service, container: containers.value.find((item) => item.runtime === service) })); }
function serviceContainerColor(_container?: ContainerRecord) { return 'green'; }
function containerStateText(container: ContainerRecord) { return ['vllm', 'trtllm'].includes(container.runtime) && container.state === 'missing' ? t('disabled') : statusText(container.state); }
function containerStateColor(container: ContainerRecord) { return ['vllm', 'trtllm'].includes(container.runtime) && container.state === 'missing' ? 'gold' : badgeColor(container.state); }
function modelStatusHelp(model: ModelRecord) { if (model.status.download === 'needs_review') return t('needsReviewHelp'); if (model.status.download === 'unsupported') return t('unsupportedHelp'); if (model.status.download === 'incomplete') return t('incompleteHelp'); return ''; }
function taskProgress(task: TaskRecord) { if (typeof task.progress_percent === 'number') return task.progress_percent; if (task.status === 'succeeded') return 100; if (task.status === 'failed') return 100; if (task.status === 'running') return 5; if (task.status === 'queued') return 0; return 0; }
function taskTypeText(type: string) { return t('task' + type.slice(0, 1).toUpperCase() + type.slice(1)); }
function runtimeHintColor(status: string) { if (status === 'compatible') return 'green'; if (status === 'possible' || status === 'external') return 'gold'; return 'red'; }
function taskAlias(task: TaskRecord) { return String(task.metadata?.alias ?? task.metadata?.model_id ?? task.metadata?.repo_id ?? task.id); }
function taskRuntimeHints(task: TaskRecord): RuntimeHint[] { const hints = task.metadata?.runtime_hints; return Array.isArray(hints) ? hints as RuntimeHint[] : []; }
function taskSummary(task: TaskRecord) { if (task.type === 'download') { const parts = [t('modelName') + ': ' + taskAlias(task), t('source') + ': ' + String(task.metadata?.repo_id ?? task.metadata?.provider ?? '-'), t('downloadTarget') + ': ' + shortModelPath(taskTarget(task))]; return parts.join(' · '); } if (task.type === 'deploy') return t('modelName') + ': ' + String(task.metadata?.model_id ?? '-') + ' · ' + t('container') + ': ' + String(task.metadata?.service_type ?? '-'); if (task.type === 'container') return t('containerName') + ': ' + String(task.metadata?.name ?? '-') + ' · ' + t('image') + ': ' + String(task.metadata?.image ?? '-'); return task.command; }
function taskTarget(task: TaskRecord) { return String(task.metadata?.target_path ?? task.cwd); }
function isModelBusy(model: ModelRecord) { return activeTasks.value.some((task) => task.metadata?.model_id === model.id || task.metadata?.alias === model.id || task.metadata?.alias === model.display_name); }
function canDeleteModel(model: ModelRecord) { const deployed = runningDeployments.value.some((deployment) => deployment.model_id === model.id || deployment.openai_models.includes(model.id)); return !deployed && !isModelBusy(model) && !['running', 'starting'].includes(model.status.deploy); }
function deploymentArgs() { return { max_model_len: deployContextLength.value, gpu_memory_utilization: deployGpuUtil.value, max_num_seqs: deployMaxSeqs.value, tensor_parallel_size: deployTensorParallel.value, kv_cache_dtype: deployKvCacheDtype.value, max_batch_size: trtMaxBatchSize.value, max_num_tokens: trtMaxNumTokens.value, kv_cache_free_gpu_memory_fraction: trtKvCacheFraction.value, tp_size: trtTpSize.value, pp_size: trtPpSize.value }; }
function selectDeployModel(model: ModelRecord) { deployModelId.value = model.id; deployOpenAiModel.value = model.id; const preferred = containers.value.find((container) => model.compatibility[container.runtime]?.status !== 'unsupported' && container.runtime === model.runtime.preferred) ?? containers.value.find((container) => model.compatibility[container.runtime]?.status !== 'unsupported'); if (preferred) selectedContainerKey.value = preferred.key; deployContextLength.value = model.inference?.context_length?.default ?? deployContextLength.value; trtMaxNumTokens.value = model.inference?.context_length?.default ?? trtMaxNumTokens.value; clampDeployParamsForModel(); }
function canDeployToSelected() { const model = selectedDeployModel.value; const container = selectedContainer.value; return Boolean(model && container && container.runtime !== 'custom' && model.compatibility[container.runtime]?.status !== 'unsupported'); }
function currentLoadedModel() { const deployment = selectedDeployment.value; if (!deployment) return undefined; if (deployment.model_id) return models.value.find((item) => item.id === deployment.model_id); const selected = selectedDeployModel.value; return selected && deployment.openai_models.includes(selected.id) ? selected : undefined; }
function selectedRunningModelLabel() { const deployment = selectedDeployment.value; if (!deployment) return t('noRunningModels'); const selected = selectedDeployModel.value; if (selected && deployment.openai_models.includes(selected.id)) return selected.display_name + ' -> ' + (deployment.container_name || deployment.runtime); if (deployment.model_id) return deployment.model_id + ' -> ' + (deployment.container_name || deployment.runtime); return deployment.openai_models.length ? deployment.openai_models.join(', ') + ' -> ' + (deployment.container_name || deployment.runtime) : t('noRunningModels'); }
function deploymentIsActive(deployment?: DeploymentRecord) { return Boolean(deployment && (deployment.status === 'running' || deployment.openai_models.length)); }
function selectedPublicBaseUrl() { return selectedDeployment.value ? publicBaseUrl(selectedDeployment.value) : ''; }
function selectedModelEndpoint() { return selectedDeployment.value ? modelEndpoint(selectedDeployment.value) : ''; }
function selectedChatEndpoint() { return selectedDeployment.value ? chatEndpoint(selectedDeployment.value) : ''; }
function expectedContainerName(model: ModelRecord, serviceType: ServiceType) { if (serviceType === 'vllm') return 'vllm-service'; if (serviceType === 'trtllm') return 'trtllm-service'; return 'audio-service'; }
function isModelSpecificMissing(container: ContainerRecord) { return container.state === 'missing' && ['vllm', 'trtllm'].includes(container.runtime); }
function actionTargetName(container: ContainerRecord) { return container.instance_name || container.name; }
function imageStatusColor(container?: ContainerRecord) { return container?.image_pulled ? 'green' : 'gold'; }
function imageStatusText(container?: ContainerRecord) { return container?.image_pulled ? t('imagePulled') : t('imageMissing'); }
function testStatusColor(status?: string) { if (status === 'passed') return 'green'; if (status === 'failed') return 'red'; if (status === 'running') return 'blue'; return 'gold'; }
function testStatusText(status?: string) { if (status === 'passed') return t('testPassed'); if (status === 'failed') return t('testFailed'); if (status === 'running') return t('testRunning'); return t('untested'); }

async function api<T>(path: string, options?: RequestInit): Promise<T> { const response = await fetch('/api' + path, options); const payload = await response.json(); if (!response.ok) throw new Error(payload.detail ?? payload.error?.message ?? 'Request failed'); return payload as T; }
async function refresh() {
  const [modelPayload, deploymentPayload, taskPayload, systemPayload, networkPayload, workbenchPayload, containerPayload] = await Promise.all([
    api<{ models: ModelRecord[] }>('/models'), api<{ deployments: DeploymentRecord[] }>('/deployments'), api<{ tasks: TaskRecord[] }>('/tasks').catch(() => ({ tasks: [] })), api<SystemCheck>('/system/check'), api<NetworkSettings>('/settings/network').catch(() => null), api<WorkbenchSettings>('/settings/workbench').catch(() => null), api<{ containers: ContainerRecord[] }>('/containers').catch(() => ({ containers: [] }))
  ]);
  models.value = modelPayload.models ?? [];
  deployments.value = deploymentPayload.deployments ?? [];
  tasks.value = taskPayload.tasks ?? [];
  system.value = systemPayload;
  network.value = networkPayload ?? systemPayload.network ?? null;
  workbenchSettings.value = workbenchPayload ?? systemPayload.workbench ?? null;
  managementPort.value = workbenchSettings.value?.management_port ?? 8888;
  containers.value = containerPayload.containers ?? [];
  if (!deployModelId.value && readyModelList.value[0]) selectDeployModel(readyModelList.value[0]);
  if (selectedDeployModel.value && !containerOptions.value.some((item) => item.value === selectedContainerKey.value)) { const first = containerOptions.value[0]; if (first) selectedContainerKey.value = first.value; }
  if (!deployOpenAiModel.value && deployModelId.value) deployOpenAiModel.value = deployModelId.value;
  if (!selectedContainerKey.value && containerOptions.value[0]) selectedContainerKey.value = containerOptions.value[0].value;
  if (!selectedTaskId.value && tasks.value[0]) selectedTaskId.value = tasks.value[0].id;
}
async function importPlan() { if (!modelUrl.value.trim()) return; importMessage.value = t('parsing'); importPreview.value = null; try { const payload = await api<ImportPreview>('/models/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: modelUrl.value.trim(), provider: 'auto', expected_runtime: downloadRuntime.value }) }); importPreview.value = payload; importMessage.value = [t('provider') + ': ' + payload.model?.provider, t('repo') + ': ' + payload.model?.repo_id, t('target') + ': ' + payload.model?.target_path, payload.download?.command ? t('command') + ': ' + payload.download.command : payload.message].filter(Boolean).join('\n'); } catch (error) { importMessage.value = String(error); } }
async function startDownload() { if (!modelUrl.value.trim()) return; importMessage.value = t('startingDownload'); try { const payload = await api<any>('/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: modelUrl.value.trim(), provider: 'auto', expected_runtime: downloadRuntime.value }) }); importMessage.value = t('downloadTaskStarted') + ': ' + payload.task.id + '\n' + t('log') + ': ' + payload.task.log_path; selectedTaskId.value = payload.task.id; view.value = 'tasks'; await refresh(); await loadTaskLog(payload.task.id); } catch (error) { importMessage.value = String(error); } }
async function openModelFolder(model: ModelRecord) { await api('/models/' + encodeURIComponent(model.id) + '/open-folder', { method: 'POST' }); }
async function deleteLocalModel(model: ModelRecord) {
  if (!canDeleteModel(model)) { message.warning(t('deleteBlocked')); return; }
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除模型' : 'Confirm Delete Model',
    content: [
      t('modelName') + ': ' + model.display_name,
      t('path') + ': ' + model.local.path,
      t('size') + ': ' + formatBytes(model.local.size_bytes),
      t('format') + ': ' + model.local.format,
      t('files') + ': ' + model.local.file_count + ' files, ' + model.local.weight_files + ' weights',
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
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function deploySelectedModel() { const model = selectedDeployModel.value; const container = selectedContainer.value; if (!model || !container || !canDeployToSelected()) return; await deployModelTo(model, container); }
async function unloadSelectedDeployment() { const deployment = selectedDeployment.value; if (!deployment || deployment.status !== 'running') return; await api('/deployments/' + encodeURIComponent(deployment.deployment_id) + '/stop', { method: 'POST' }); await refresh(); containerLog.value = ''; selectedLogContainer.value = ''; }
async function loadTaskLog(taskId = selectedTaskId.value) { if (!taskId) return; const payload = await api<{ logs: string }>('/tasks/' + encodeURIComponent(taskId) + '/logs'); taskLog.value = payload.logs; }
async function loadContainerLogs(name = actionTargetName(selectedContainer.value as ContainerRecord) ?? '') { if (!name) return; selectedLogContainer.value = name; const payload = await api<{ logs: string }>('/containers/' + encodeURIComponent(name) + '/logs?lines=200'); containerLog.value = payload.logs; }
async function runContainerAction(container: ContainerRecord, action: 'start' | 'stop' | 'restart') { try { const target = actionTargetName(container); const payload = await api<{ ok?: boolean; detail?: string }>('/containers/' + encodeURIComponent(target) + '/' + action, { method: 'POST' }); if (payload.ok === false) { message.warning(payload.detail || t('actionFailed')); return; } message.success(payload.detail || t('actionSucceeded')); await refresh(); if (container.state !== 'missing') await loadContainerLogs(target); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } }
async function prepareContainerImage(container: ContainerRecord) { const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/pull-image', { method: 'POST' }); if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); } message.success(t('actionSucceeded')); await refresh(); }
async function testContainerImage(container: ContainerRecord) { const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/test-image', { method: 'POST' }); if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); } message.success(t('actionSucceeded')); await refresh(); }
async function deleteContainerConfirm(container: ContainerRecord) {
  if (!container.preset) { message.warning(locale.value === 'zh-CN' ? '仅内置容器模板支持删除' : 'Only preset container templates can be deleted'); return; }
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除容器模板' : 'Confirm Delete Container Template',
    content: locale.value === 'zh-CN'
      ? `即将删除容器「${container.title}（${container.name}）」：\n\n• Docker 容器\n• Docker 镜像（${container.image}）\n• 关联数据卷\n• 运行时缓存\n\n此操作不可撤销。删除后需重新拉取镜像并创建容器。`
      : `This will delete container "${container.title} (${container.name})":\n\n• Docker container\n• Docker image (${container.image})\n• Associated volumes\n• Runtime cache\n\nThis action cannot be undone. You will need to re-pull the image and recreate the container.`,
    okText: locale.value === 'zh-CN' ? '确认删除并清理 Docker 资源' : 'Delete & Clean Docker Resources',
    okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel',
    width: 560,
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
async function createCustomContainer() { const payload = await api<any>('/containers/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: customImage.value, components: customComponents.value, management_mode: customMode.value }) }); if (payload.task?.id) { selectedTaskId.value = payload.task.id; view.value = 'tasks'; await loadTaskLog(payload.task.id); } await refresh(); }

async function saveWorkbenchSettings() {
  try {
    const payload = await api<WorkbenchSettings>('/settings/workbench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ management_port: managementPort.value }) });
    workbenchSettings.value = payload;
    message.success(payload.requires_restart ? (locale.value === 'zh-CN' ? '已保存，重启前端服务后生效。' : 'Saved. Restart the frontend service to apply.') : t('configSaved'));
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function saveContainerConfig(container: ContainerRecord) {
  try {
    await api('/containers/' + encodeURIComponent(container.key) + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_port: Number(container.public_port), management_mode: container.management_mode, restart_policy: container.restart_policy, auto_restart: container.auto_restart })
    });
    message.success(t('configSaved'));
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

async function toggleLanAccess() { if (!network.value) return; networkMessage.value = t('savingNetwork'); try { const payload = await api<NetworkSettings>('/settings/network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lan_access_enabled: !network.value.lan_access_enabled }) }); network.value = payload; networkMessage.value = payload.requires_restart ? t('savedNeedsRestart') + payload.desired_bind_address : t('savedActive'); } catch (error) { networkMessage.value = String(error); } }

onMounted(() => { document.documentElement.lang = locale.value; document.documentElement.dataset.theme = themeMode.value; void refresh(); window.setInterval(() => { void refresh(); if (view.value === 'tasks' && selectedTaskId.value) void loadTaskLog(); if ((view.value === 'deploy' || view.value === 'load') && !logCollapsed.value) { const logName = selectedLogContainer.value || (selectedContainer.value && selectedContainer.value.state !== 'missing' ? actionTargetName(selectedContainer.value) : ''); if (logName) void loadContainerLogs(logName); } }, 5000); });
</script>

<template>
  <a-config-provider :locale="antLocale" :theme="antTheme">
    <main :class="['app-shell', isDark ? 'theme-dark' : 'theme-light']">
      <aside class="sidebar">
        <div class="brand-block">
          <img :src="brandImage" :class="['brand-mark', isDark ? 'brand-mark-wide' : '']" alt="AMUIN" />
          <div class="brand-text"><strong>{{ t('workstation') }}</strong><span>{{ t('studioName') }}</span></div>
        </div>
        <a-menu class="side-menu" :selected-keys="[view]" mode="inline" @click="selectView">
          <a-menu-item key="dashboard">{{ t('dashboard') }}</a-menu-item><a-menu-item key="models">{{ t('models') }}</a-menu-item><a-menu-item key="services">{{ t('services') }}</a-menu-item><a-menu-item key="deploy">{{ t('deploy') }}</a-menu-item><a-menu-item key="load">{{ t('load') }}</a-menu-item><a-menu-item key="tasks">{{ t('tasks') }}</a-menu-item><a-menu-item key="settings">{{ t('settings') }}</a-menu-item>
        </a-menu>
        <div class="sidebar-status"><a-tag color="cyan">{{ readyModels }} {{ t('readyModels') }}</a-tag><a-tag color="blue">{{ runningServices }} {{ t('activeServices') }}</a-tag><a-tag :color="system?.docker?.ok ? 'green' : 'gold'">{{ system?.docker?.ok ? t('dockerReady') : t('dockerCheck') }}</a-tag></div>
      </aside>
      <section class="workspace">
        <div class="topbar">
          <span class="topbar-spacer"></span>
          <a-space><a-switch :checked="isDark" checked-children="☽" un-checked-children="☼" @change="toggleTheme" /><a-switch :checked="locale === 'en-US'" checked-children="英" un-checked-children="中" @change="toggleLocale" /></a-space>
        </div>
        <header class="hero"><img class="hero-bg" :src="heroImage" alt="" /><div class="hero-copy"><p>{{ t('studioName') }}</p><h1>{{ pageMeta.title }}</h1><span>{{ pageMeta.desc }}</span></div></header>

        <section v-if="view === 'dashboard'" class="panel-stack dashboard-grid"><a-card class="glass-card endpoint-strip console-strip" :bordered="false"><div class="endpoint-strip-inner"><label>{{ t('consoleAddress') }}:</label><a-input class="console-address-input" :value="consoleAddress" disabled /><a-tooltip :title="t('copyAddress')"><a-button @click="copyText(consoleAddress)"><template #icon><CopyOutlined /></template></a-button></a-tooltip><a-tag v-if="workbenchSettings?.requires_restart" color="gold">{{ t('restartRequired') }} · {{ system?.configured_management_url }}</a-tag><a-tag class="lan-status-tag" :color="network?.lan_access_enabled ? 'green' : 'gold'">{{ network?.lan_access_enabled ? t('lanEnabled') : t('localhostOnly') }}</a-tag><a-switch :checked="network?.lan_access_enabled" @change="toggleLanAccess" /></div></a-card>
          <a-card :title="t('deviceStatus')" class="glass-card dashboard-device" :bordered="false"><a-row :gutter="[12,12]"><a-col :span="12"><a-statistic :title="t('host')" :value="system?.device?.hostname ?? t('unavailable')" /></a-col><a-col :span="12"><a-statistic :title="t('uptime')" :value="formatDuration(system?.status?.uptime_seconds)" /></a-col></a-row><a-descriptions class="dashboard-descriptions" size="small" :column="1" bordered><a-descriptions-item :label="t('deviceModel')">{{ system?.device?.model ?? t('unavailable') }}</a-descriptions-item><a-descriptions-item :label="t('operatingSystem')">{{ system?.device?.os?.name }} {{ system?.device?.os?.version }} · {{ system?.device?.os?.kernel }} · {{ system?.device?.os?.arch }}</a-descriptions-item><a-descriptions-item :label="t('gpu')">{{ gpuSummary }}</a-descriptions-item><a-descriptions-item :label="t('dockerAccess')">{{ system?.docker?.ok ? t('dockerReady') : (system?.docker?.detail ?? t('dockerCheck')) }}</a-descriptions-item></a-descriptions></a-card>
          <a-card :title="t('resources')" class="glass-card dashboard-resources" :bordered="false"><div class="resource-grid"><div><a-progress type="dashboard" :percent="cpuPercent" :width="92" /><b>{{ t('cpu') }}</b><p>{{ system?.device?.cpu?.cores ?? 0 }} cores</p></div><div><a-progress type="dashboard" :percent="memoryPercent" :width="92" /><b>{{ t('memory') }}</b><p>{{ formatBytes(memoryUsed) }} / {{ formatBytes(system?.device?.memory?.total_bytes ?? 0) }}</p></div><div><a-progress type="dashboard" :percent="storagePercent" :width="92" /><b>{{ t('storage') }}</b><p>{{ formatBytes(storageVolume?.used_bytes ?? 0) }} / {{ formatBytes(storageVolume?.total_bytes ?? 0) }}</p></div></div></a-card>
          <a-card :title="t('activityMonitor')" class="glass-card dashboard-activity" :bordered="false"><div class="activity-stats"><a-statistic :title="t('readyModels')" :value="readyModels" /><a-statistic :title="t('activeContainers')" :value="activeContainerCount" /></div></a-card>
          <a-card :title="t('containerStatus')" class="glass-card dashboard-containers" :bordered="false"><a-list class="dashboard-scroll-list fill-scroll-list compact-dashboard-list" size="small" :data-source="runtimeContainers"><template #renderItem="{ item }"><a-list-item><a-list-item-meta :title="item.title" :description="item.name" /><a-tag :color="containerStateColor(item)">{{ containerStateText(item) }}</a-tag></a-list-item></template></a-list></a-card>
          <a-card :title="t('publishedContainerModels')" class="glass-card dashboard-published" :bordered="false"><a-table class="dashboard-published-table" size="small" :pagination="false" :data-source="publishedModelRows" :columns="[{ title: t('modelName'), dataIndex: 'model_name', key: 'model_name' }, { title: t('apiAddress'), dataIndex: 'address', key: 'address' }, { title: t('callId'), dataIndex: 'call_id', key: 'call_id' }]" /></a-card>
          <a-card :title="t('recentTasks')" class="glass-card dashboard-tasks" :bordered="false"><a-list class="dashboard-scroll-list fill-scroll-list" size="small" :data-source="dashboardTasks"><template #renderItem="{ item }"><a-list-item class="dashboard-task-item" @click="selectedTaskId = item.id; view = 'tasks'; loadTaskLog(item.id)"><a-list-item-meta :title="taskTypeText(item.type) + ' · ' + statusText(item.status)" :description="taskSummary(item)" /><div class="dashboard-task-progress"><a-progress :percent="taskProgress(item)" size="small" :status="item.status === 'failed' ? 'exception' : undefined" /><span v-if="item.type === 'download'">{{ formatBytes(item.downloaded_bytes ?? 0) }}</span><a-space v-if="taskRuntimeHints(item).length" wrap><a-tag v-for="hint in taskRuntimeHints(item).slice(0, 2)" :key="hint.runtime" :color="runtimeHintColor(hint.status)">{{ hint.label }}</a-tag></a-space></div><a-tag :color="badgeColor(item.status)">{{ statusText(item.status) }}</a-tag></a-list-item></template></a-list></a-card>
          <button class="model-list-drawer-strip" type="button" @click="modelListDrawerOpen = true"><b>{{ t('viewModelList') }}</b><span>{{ modelListSummaryUrl }}</span></button>
          <a-drawer v-model:open="modelListDrawerOpen" placement="bottom" :height="360" :title="t('allModelEndpoints')"><a-list size="small" :data-source="runningDeployments"><template #renderItem="{ item }"><a-list-item><a-list-item-meta :title="item.openai_models.join(', ') || item.runtime" :description="modelEndpoint(item)" /><a-space wrap><a-tag color="blue">{{ t('modelListEndpoint') }} GET {{ modelEndpoint(item) }}</a-tag><a-tag color="cyan">{{ t('chatEndpoint') }} POST {{ chatEndpoint(item) }}</a-tag><a-tag>{{ item.openai_models.join(', ') || item.runtime }}</a-tag></a-space></a-list-item></template><template #empty><a-empty :description="t('noRunningModels')" /></template></a-list></a-drawer>
        </section>

        <section v-if="view === 'models'" class="panel-stack"><a-card :bordered="false" class="glass-card"><p class="muted-line download-policy">{{ t('downloadPolicy') }}</p><div class="toolbar-panel model-download-toolbar"><a-input v-model:value="modelUrl" :placeholder="t('urlPlaceholder')" /><a-select v-model:value="downloadRuntime" :options="[{ label: t('autoRuntime'), value: 'auto' }, { label: 'vLLM', value: 'vllm' }, { label: 'TensorRT-LLM', value: 'trtllm' }, { label: 'Audio Service', value: 'audio' }]" /><a-button @click="importPlan">{{ t('preview') }}</a-button><a-button type="primary" @click="startDownload">{{ t('download') }}</a-button><a-button @click="refresh"><template #icon><ReloadOutlined /></template>{{ t('refresh') }}</a-button></div></a-card><a-card class="glass-card compatibility-guide-card" :bordered="false"><template #title>{{ locale === 'zh-CN' ? '格式与运行环境' : 'Format and runtime fit' }}</template><p class="muted-line guide-intro">{{ locale === 'zh-CN' ? '不同环境运行的模型格式不一样。界面会在下载、模型卡片和加载模型前提示兼容、可能兼容或不支持的原因。' : 'Different runtimes require different model formats. The UI explains compatible, possible, and unsupported paths before download or load.' }}</p><div class="compat-guide-grid"><div v-for="item in compatibilityGuide" :key="item.format" class="compat-guide-item"><b>{{ item.format }}</b><a-tag color="blue">{{ item.service }}</a-tag><span>{{ item.note }}</span></div></div></a-card><a-alert v-if="importMessage" type="info" show-icon><template #message><pre class="inline-pre">{{ importMessage }}</pre><div v-if="importPreview?.runtime_hints?.length" class="runtime-hints"><b>{{ t('runtimeCompatibility') }}</b><a-space wrap><a-tooltip v-for="hint in importPreview.runtime_hints" :key="hint.runtime" :title="hint.reason"><a-tag :color="runtimeHintColor(hint.status)">{{ hint.label }} · {{ statusText(hint.status) }}</a-tag></a-tooltip></a-space></div></template></a-alert><div v-if="downloadTasks.length" class="compact-grid"><a-card v-for="task in downloadTasks" :key="task.id" class="model-card compact-card" :bordered="false"><template #title>{{ t('downloadingModel') }} · {{ taskAlias(task) }}</template><template #extra><a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag></template><p class="muted-line">{{ t('downloadTarget') }}: {{ shortModelPath(taskTarget(task)) }}</p><p class="muted-line">{{ t('downloaded') }}: {{ formatBytes(task.downloaded_bytes ?? 0) }}</p><a-progress :percent="taskProgress(task)" :status="task.status === 'failed' ? 'exception' : undefined" /><a-button size="small" block @click="selectedTaskId = task.id; view = 'tasks'; loadTaskLog(task.id)">{{ t('taskLogs') }}</a-button></a-card></div><div class="compact-grid"><a-card v-for="model in models" :key="model.id" class="model-card compact-card" :bordered="false"><template #title>{{ model.display_name }}</template><template #extra><a-tooltip :title="modelStatusHelp(model)"><a-tag :color="badgeColor(model.status.download)">{{ statusText(model.status.download) }}</a-tag></a-tooltip></template><div class="model-path"><span>{{ shortModelPath(model.local.path) }}</span><a-tooltip :title="t('openFolder')"><a-button size="small" shape="circle" @click="openModelFolder(model)"><template #icon><FolderOpenOutlined /></template></a-button></a-tooltip></div><div class="model-facts"><span>{{ t('format') }}: <b>{{ model.local.format }}</b></span><span>{{ t('size') }}: <b>{{ formatBytes(model.local.size_bytes) }}</b></span><span>{{ t('files') }}: <b>{{ model.local.file_count }}</b></span></div><div class="support-row"><span>{{ t('supportedContainers') }}:</span><a-space wrap><a-tag v-for="item in supportedContainers(model)" :key="item.service" :color="serviceContainerColor(item.container)">{{ item.container?.name ?? item.service }}</a-tag></a-space></div><div v-if="!supportedContainers(model).length" class="compatibility-matrix compact-support"><div v-for="row in compatibilityRows(model)" :key="row.service" class="compatibility-row"><b>{{ row.service }}</b><a-tag :color="row.info.status === 'unsupported' ? 'red' : 'green'">{{ row.info.status === 'unsupported' ? (locale === 'zh-CN' ? '不支持' : 'Unsupported') : (locale === 'zh-CN' ? '支持' : 'Supported') }}</a-tag></div></div><a-space class="card-actions model-actions"><a-button size="small" danger :disabled="!canDeleteModel(model)" @click="deleteLocalModel(model)"><template #icon><DeleteOutlined /></template>{{ t('delete') }}</a-button></a-space></a-card></div></section>

        <section v-if="view === 'services'" class="panel-stack"><div class="compact-grid"><a-card v-for="container in containers" :key="container.key" class="glass-card compact-card" :title="container.title" :bordered="false"><template #extra><a-space wrap><a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag><a-tag :color="imageStatusColor(container)">{{ imageStatusText(container) }}</a-tag><a-tag :color="testStatusColor(container.test_status)">{{ testStatusText(container.test_status) }}</a-tag></a-space></template><div class="container-facts"><span>{{ t('containerName') }}<b>{{ container.name }}</b></span><span>{{ t('image') }}<b>{{ container.image || '-' }}</b></span></div><a-form layout="vertical" class="container-config-form"><a-form-item :label="t('publishingPort')"><a-input-number v-model:value="container.public_port" :min="1024" :max="65535" class="full-width" /></a-form-item><a-form-item :label="t('managementMode')"><a-segmented v-model:value="container.management_mode" :options="[{ label: t('once'), value: 'once' }, { label: t('resident'), value: 'resident' }]" class="full-width" /></a-form-item><a-form-item :label="t('restartPolicy')"><a-select v-model:value="container.restart_policy" :options="[{label:'no', value:'no'}, {label:'unless-stopped', value:'unless-stopped'}, {label:'always', value:'always'}, {label:'on-failure', value:'on-failure'}]" /></a-form-item><a-button type="primary" block @click="saveContainerConfig(container)">{{ t('saveConfig') }}</a-button></a-form><a-space wrap class="tag-row"><a-tag v-for="component in container.components" :key="component">{{ component }}</a-tag></a-space></a-card><a-card class="glass-card compact-card" :title="t('customContainer')" :bordered="false"><p class="muted-line">{{ t('customHint') }}</p><a-form layout="vertical" class="custom-form"><a-form-item :label="t('imageName')"><a-input v-model:value="customImage" /></a-form-item><a-form-item :label="t('components')"><a-checkbox-group v-model:value="customComponents" :options="['cuda','pytorch','python','nodejs','modelscope','huggingface','vllm','tensorrt-llm']" /></a-form-item><a-form-item :label="t('managementMode')"><a-segmented v-model:value="customMode" :options="[{ label: t('once'), value: 'once' }, { label: t('resident'), value: 'resident' }]" class="full-width" /></a-form-item><a-button type="primary" block @click="createCustomContainer">{{ t('createContainer') }}</a-button></a-form></a-card></div></section>

                <section v-if="view === 'deploy'" class="panel-stack runtime-service-page">
          <div class="runtime-service-grid">
            <a-card v-for="container in containers.filter((item) => item.runtime !== 'custom')" :key="container.key" class="glass-card runtime-service-card" :title="container.title" :bordered="false">
              <template #extra>
                <a-space wrap><a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag><a-tag :color="imageStatusColor(container)">{{ imageStatusText(container) }}</a-tag><a-tag :color="testStatusColor(container.test_status)">{{ testStatusText(container.test_status) }}</a-tag></a-space>
              </template>
              <div class="deploy-kv-grid compact-kv">
                <span>{{ t('containerName') }}<b>{{ container.name }}</b></span>
                <span>{{ t('currentInstance') }}<b>{{ container.instance_name || '-' }}</b></span>
                <span>{{ t('publishingPort') }}<b>{{ container.public_port || container.ports }}</b></span>
                <span>{{ t('officialImage') }}<b>{{ container.official_image || container.image || '-' }}</b></span>
                <span>{{ t('managementMode') }}<b>{{ t(container.management_mode) }} · {{ container.restart_policy || 'unless-stopped' }}</b></span>
                <span>{{ t('runtime') }}<b>{{ container.runtime }}</b></span>
              </div>
              <div v-if="container.software_versions" class="version-tags">
                <b>{{ t('softwareVersions') }}</b>
                <a-space wrap><a-tag v-for="(value, key) in container.software_versions" :key="key">{{ key }}: {{ value }}</a-tag></a-space>
              </div>
              <div class="deploy-action-row">
                <b class="action-label">{{ locale === 'zh-CN' ? '操作：' : 'Actions:' }}</b>
              </div>
              <a-space class="deploy-action-row" wrap>
                <a-button size="small" type="primary" @click="prepareContainerImage(container)">{{ t('pullImage') }}</a-button>
                <a-button size="small" :disabled="!container.image_pulled" @click="testContainerImage(container)">{{ t('startTest') }}</a-button>
                <a-button size="small" :disabled="container.state === 'missing' || container.state === 'running'" @click="runContainerAction(container, 'start')">{{ t('start') }}</a-button>
                <a-button size="small" danger :disabled="container.state !== 'running'" @click="runContainerAction(container, 'stop')">{{ t('stop') }}</a-button>
                <a-button size="small" :disabled="container.state === 'missing'" @click="loadContainerLogs(actionTargetName(container))">{{ t('viewLogs') }}</a-button>
                <a-divider type="vertical" style="margin: 0 4px;" />
                <a-button size="small" danger @click="deleteContainerConfirm(container)"><template #icon><DeleteOutlined /></template>{{ locale === 'zh-CN' ? '删除模板' : 'Delete' }}</a-button>
              </a-space>
            </a-card>
          </div>
          <a-card :title="t('serviceLogs') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')" class="glass-card service-log-card" :bordered="false">
            <a-space class="log-toolbar"><span>{{ selectedTask?.id || selectedLogContainer || t('noTaskSelected') }}</span><a-button size="small" @click="selectedLogContainer ? loadContainerLogs(selectedLogContainer) : loadTaskLog()">{{ t('refresh') }}</a-button></a-space>
            <pre class="message-block log-block service-log-block">{{ containerLog || taskLog || t('noTaskSelected') }}</pre>
          </a-card>
        </section>

        <section v-if="view === 'load'" class="panel-stack deploy-grid deploy-tuned">
          <a-card :title="t('deployModel')" class="glass-card deploy-list deploy-column-card" :bordered="false">
            <a-list :data-source="readyModelList" class="deploy-model-list">
              <template #renderItem="{ item: model }">
                <a-list-item :class="deployModelId === model.id ? 'selected-row' : ''" @click="selectDeployModel(model)">
                  <a-list-item-meta :title="model.display_name" :description="shortModelPath(model.local.path)" />
                  <a-tag :color="badgeColor(model.status.download)">{{ statusText(model.status.download) }}</a-tag>
                </a-list-item>
              </template>
            </a-list>
          </a-card>

          <div class="deploy-center deploy-column-card">
            <a-card :title="t('selectedContainer')" class="glass-card deploy-compact-card" :bordered="false">
              <template #extra>
                <a-space wrap><a-tag :color="containerStateColor(selectedContainer)">{{ selectedContainer ? containerStateText(selectedContainer) : '-' }}</a-tag><a-tag :color="imageStatusColor(selectedContainer)">{{ imageStatusText(selectedContainer) }}</a-tag><a-tag :color="testStatusColor(selectedContainer?.test_status)">{{ testStatusText(selectedContainer?.test_status) }}</a-tag></a-space>
              </template>
              <a-select v-model:value="selectedContainerKey" :options="containerOptions" class="full-width" @change="() => { if (selectedContainer && selectedContainer.state !== 'missing') loadContainerLogs(actionTargetName(selectedContainer)) }" />
              <div v-if="selectedContainer" class="deploy-kv-grid compact-kv">
                <span>{{ t('containerName') }}<b>{{ selectedContainer.name }}</b></span>
                <span>{{ t('currentInstance') }}<b>{{ selectedContainer.instance_name || '-' }}</b></span>
                <span>{{ t('publishingPort') }}<b>{{ selectedContainer.public_port || selectedContainer.ports }}</b></span>
                <span>{{ t('runningModel') }}<b>{{ selectedRunningModelLabel() }}</b></span>
                <span>{{ t('officialImage') }}<b>{{ selectedContainer.official_image || selectedContainer.image || '-' }}</b></span>
                <span>{{ t('managementMode') }}<b>{{ t(selectedContainer.management_mode) }} · {{ selectedContainer.restart_policy || 'unless-stopped' }}</b></span>
              </div>
            </a-card>

            <a-card :title="t('deploymentInfo')" class="glass-card deploy-compact-card deployment-info-short" :bordered="false">
              <a-empty v-if="!deploymentIsActive(selectedDeployment)" :description="t('noRunningModels')" />
              <div v-else class="deploy-kv-grid compact-kv">
                <span>{{ t('loadedModel') }}<b>{{ currentLoadedModel()?.display_name || selectedRunningModelLabel() }}</b></span>
                <span>{{ t('apiAddress') }}<b>{{ selectedPublicBaseUrl() }}</b></span>
              </div>
              <a-space class="card-actions model-actions">
                <a-button danger size="small" :disabled="!selectedDeployment || selectedDeployment.status !== 'running'" @click="unloadSelectedDeployment">{{ t('unload') }}</a-button>
              </a-space>
            </a-card>

            <a-card :title="t('log') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')" class="glass-card deploy-log" :bordered="false">
              <a-space class="log-toolbar"><a-button size="small" @click="selectedContainer && selectedContainer.state !== 'missing' && loadContainerLogs(actionTargetName(selectedContainer))">{{ t('refresh') }}</a-button><a-button size="small" @click="logCollapsed = !logCollapsed">{{ logCollapsed ? t('expandLog') : t('collapseLog') }}</a-button></a-space>
              <pre v-if="!logCollapsed" class="message-block log-block deploy-live-log">{{ containerLog || taskLog }}</pre>
            </a-card>
          </div>

          <aside class="deploy-params deploy-column-card">
            <a-card :title="t('parameters')" class="glass-card" :bordered="false">
              <a-form layout="vertical">
                <a-form-item :label="t('openaiName')"><a-input v-model:value="deployOpenAiModel" :placeholder="deployModelId" /></a-form-item>
                <template v-if="selectedContainer?.runtime === 'vllm'">
                  <a-form-item :label="t('contextLength') + ' · ' + paramLimitText()"><div class="param-control"><a-input-number v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /><a-slider v-model:value="deployContextLength" :min="contextLimit.min" :max="contextLimit.max" :step="contextLimit.step" /></div></a-form-item>
                  <a-form-item :label="t('gpuUtil')"><div class="param-control"><a-input-number v-model:value="deployGpuUtil" :min="0.1" :max="0.99" :step="0.01" /><a-slider v-model:value="deployGpuUtil" :min="0.1" :max="0.99" :step="0.01" /></div></a-form-item>
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
                <template v-else></template>
                <a-button type="primary" block :disabled="!canDeployToSelected()" @click="deploySelectedModel">{{ t('loadHere') }}</a-button>
              </a-form>
            </a-card>
          </aside>
        </section>

<section v-if="view === 'tasks'" class="panel-stack task-grid"><a-card :title="t('taskMonitor')" class="glass-card" :bordered="false"><p class="muted-line">{{ t('taskHint') }}</p><a-list :data-source="visibleTasks" class="task-list"><template #renderItem="{ item: task }"><a-list-item :class="selectedTaskId === task.id ? 'selected-row' : ''" @click="selectedTaskId = task.id; loadTaskLog(task.id)"><a-list-item-meta :title="taskTypeText(task.type) + ' · ' + statusText(task.status)" :description="taskSummary(task)" /><a-progress class="task-progress" :percent="taskProgress(task)" :show-info="false" :status="task.status === 'failed' ? 'exception' : undefined" /><a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag></a-list-item></template></a-list></a-card><a-card :title="t('taskLogs')" class="glass-card" :bordered="false"><a-space class="log-toolbar"><span>{{ selectedTask?.id ?? t('noTaskSelected') }}</span><a-button size="small" :disabled="!selectedTaskId" @click="loadTaskLog()">{{ t('refresh') }}</a-button></a-space><pre class="message-block log-block">{{ taskLog || t('noTaskSelected') }}</pre></a-card></section>

        <section v-if="view === 'settings'" class="settings-panel settings-card-grid"><a-card :title="locale === 'zh-CN' ? '端口与控制台' : 'Port & Console'" class="glass-card settings-card" :bordered="false"><div class="settings-row-grid"><div class="settings-block"><b>{{ locale === 'zh-CN' ? '管理端口' : 'Management Port' }}</b><a-input-number v-model:value="managementPort" :min="1024" :max="65535" class="full-width" style="margin-top:8px" /><a-button type="primary" block @click="saveWorkbenchSettings" style="margin-top:8px">{{ t('saveConfig') }}</a-button></div><div class="settings-block"><b>{{ locale === 'zh-CN' ? '控制台地址' : 'Console Address' }}</b><div class="settings-summary compact-settings-summary" style="margin-top:8px"><span>{{ t('apiAddress') }}<b>{{ system?.management_url ?? 'http://localhost:8888' }}</b></span><span>{{ locale === 'zh-CN' ? '配置地址' : 'Configured URL' }}<b>{{ system?.configured_management_url ?? ('http://localhost:' + managementPort) }}</b></span><a-tag v-if="workbenchSettings?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div></div></div></a-card><a-card :title="locale === 'zh-CN' ? '网络与绑定' : 'Network & Binding'" class="glass-card settings-card" :bordered="false"><template #extra><a-tag :color="network?.lan_access_enabled ? 'green' : 'gold'">{{ network?.lan_access_enabled ? t('lanEnabled') : t('localhostOnly') }}</a-tag></template><div class="settings-row-grid"><div class="settings-block"><b>{{ t('networkAccess') }}</b><p class="muted-line">{{ t('networkHint') }}</p><div class="settings-controls compact-settings-controls"><a-switch :checked="network?.lan_access_enabled" @change="toggleLanAccess" /><a-tag v-if="network?.requires_restart" color="gold">{{ t('restartRequired') }}</a-tag></div></div><div class="settings-block"><b>{{ locale === 'zh-CN' ? '绑定状态' : 'Bind Status' }}</b><div class="settings-summary compact-settings-summary" style="margin-top:8px"><span>{{ t('activeBind') }}<b>{{ network?.active_bind_address ?? '0.0.0.0' }}</b></span><span>{{ t('desiredBind') }}<b>{{ network?.desired_bind_address ?? '0.0.0.0' }}</b></span></div></div></div><a-alert class="plan-alert compact-plan-alert" type="info" style="margin-top:12px"><template #message><pre class="inline-pre">{{ networkMessage || t('networkIdle') }}</pre></template></a-alert></a-card></section>
      </section>
    </main>
  </a-config-provider>
</template>
