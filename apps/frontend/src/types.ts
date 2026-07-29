/**
 * @author Amuin
 * @created 2026-06-25
 * @description 全局类型定义 — 模型、部署、任务、容器、系统检查等核心数据结构。
 *              Global type definitions for models, deployments, tasks, containers, system checks, etc.
 */
export type View = 'dashboard' | 'playground' | 'load' | 'models' | 'services' | 'system' | 'running' | 'deploy' | 'tasks' | 'settings';
export type Locale = 'zh-CN' | 'en-US';
export type ThemeMode = 'light' | 'dark';
export type ServiceType = 'vllm' | 'trtllm' | 'pytorch';

export type CompatInfo = { status: string; reason: string };
export type ModelAuditIssue = { code: string; severity: string; message: string };
export type ModelRuntimeRecommendation = { runtime: string; status: string; reason: string };
export type ModelGpuMemoryAudit = { status: string; required_bytes?: number | null; available_bytes?: number | null; total_bytes?: number | null; reason: string };

export type ModelRecord = {
  id: string;
  display_name: string;
  local: { path: string; format: string; architecture?: string | null; quantization?: string | null; size_bytes: number; file_count: number; weight_files?: number; config_files?: string[]; incomplete_files?: string[] };
  capabilities?: string[];
  runtime: { preferred: string; supported: string[] };
  inference?: { context_length?: { min: number; max: number; default: number; step: number; source: string } };
  compatibility: Record<string, CompatInfo>;
  audit?: { issues: ModelAuditIssue[]; recommendations: ModelRuntimeRecommendation[]; gpu_memory?: ModelGpuMemoryAudit };
  status: { download: string; deploy: string; health: string };
};

export type DeploymentRecord = {
  deployment_id: string;
  model_id?: string | null;
  status: string;
  service_type: string;
  runtime: string;
  container_name?: string;
  public_port: number;
  base_url: string;
  health_url: string;
  openai_models: string[];
  warnings: string[];
  suite?: DeploymentSuite;
};

export type DeploymentSuiteComponent = { model_id: string; role: string; required: boolean };
export type DeploymentSuite = {
  kind: "suite";
  title?: string;
  title_zh?: string;
  publish_policy: "selected" | "all_ready";
  load_policy: "lazy" | "eager";
  card_mode: "grouped" | "individual";
  health_path?: string;
  primary_endpoint?: { kind?: string; method?: string; path: string };
  components: DeploymentSuiteComponent[];
};

export type RuntimeHint = { runtime: string; status: string; label: string; reason: string };
export type RuntimePlanStage = { id: string; label: string; detail: string; target?: string };
export type TaskRuntimePlanStageStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type TaskRuntimePlan = { deployment_id?: string; base_url?: string; health_url?: string; stages?: RuntimePlanStage[]; current_stage?: string; progress_percent?: number; stage_statuses?: Record<string, TaskRuntimePlanStageStatus> };


export type ModelFileRecord = {
  model_id: string;
  relative_path: string;
  status: string;
  size_bytes?: number | null;
  downloaded_bytes?: number | null;
  task_id?: string | null;
  error?: string | null;
  updated_at: string;
};

export type TaskDiagnostic = { category: string; severity: string; stage?: string; message: string; repair_actions: Array<{ action: string; label: string; detail?: string }> };

export type TaskRecord = {
  id: string;
  type: string;
  status: string;
  command: string;
  cwd: string;
  log_path: string;
  metadata: Record<string, unknown> & { runtime_plan?: TaskRuntimePlan };
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress_percent?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  download_speed_bytes_per_sec?: number;
  download_log_speed_bytes_per_sec?: number;
  download_active_file?: string;
  download_active_file_bytes?: number;
  download_active_file_total_bytes?: number;
  download_active_file_percent?: number;
  download_elapsed?: string;
  download_eta?: string;
  download_items_done?: number;
  download_items_total?: number;
  download_retry_attempt?: number;
  download_retry_total?: number;
  download_error_code?: 'network_unreachable' | 'proxy_unreachable' | 'download_failed';
  total_bytes_estimated?: boolean;
  target_path?: string;
  model_files?: ModelFileRecord[];
  diagnostic?: TaskDiagnostic;
};

export type ImportPreview = {
  model?: { provider?: string; repo_id?: string; target_path?: string };
  runtime_hints?: RuntimeHint[];
  download?: { command?: string };
  message?: string;
};

export type ContainerRecord = {
  key: string;
  name: string;
  slot_name?: string;
  instance_name?: string | null;
  title: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  public_port?: number;
  runtime: string;
  management_mode: string;
  restart_policy?: string;
  auto_restart?: boolean;
  preset: boolean;
  components: string[];
  official_image?: string;
  image_pulled?: boolean;
  test_status?: string;
  software_versions?: Record<string, string>;
  category?: 'system' | 'custom' | 'model-instance';
  note?: string;
  suitable_models?: string[];
};

export type ProxyScope = 'all' | 'huggingface' | 'modelscope';

export type ProxySettings = {
  enabled: boolean;
  scope: ProxyScope;
  http_proxy: string;
  https_proxy: string;
  all_proxy: string;
  no_proxy: string;
  env_path: string;
  updated_at: string;
};

export type NetworkSettings = {
  lan_access_enabled: boolean;
  desired_bind_address: string;
  active_bind_address: string;
  requires_restart: boolean;
  updated_at: string;
};

export type WorkbenchSettings = {
  management_port: number;
  active_management_port: number;
  requires_restart: boolean;
  updated_at: string;
};

export type DeviceInfo = {
  hostname?: string;
  vendor?: string;
  model?: string;
  os?: { name?: string; kernel?: string; arch?: string; version?: string; build?: string };
  cpu?: { model?: string; cores?: number };
  memory?: { total_bytes?: number; free_bytes?: number };
  storage?: { available?: boolean; volumes?: Array<{ mount: string; total_bytes: number; used_bytes: number; free_bytes: number; used_percent: number }> };
  gpu?: { available?: boolean; detail?: string; devices?: Array<Record<string, unknown>> };
  temperatures?: Array<{ label: string; celsius: number; source: string }>;
};

export type SystemCheck = {
  management_url: string;
  configured_management_url?: string;
  backend_url: string;
  lan_addresses?: string[];
  workbench?: WorkbenchSettings;
  service_ports?: Record<string, {
    port: number;
    available: boolean;
    label?: string;
    source?: 'system' | 'custom';
    state?: string;
    container_name?: string;
    internal_port?: number;
    protocol?: string;
  }>;
  docker?: { ok: boolean; detail: string; version?: string; compose_version?: string; container_count?: number; containers?: Array<{ name: string; status: string }> };
  status?: { uptime_seconds?: number; load_average?: number[]; cpu_load_percent?: number };
  device?: DeviceInfo;
  network?: NetworkSettings;
};
