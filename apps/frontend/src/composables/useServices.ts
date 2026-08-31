/**
 * @author Amuin
 * @created 2026-06-25
 * @description 运行时服务（Services）页面本地状态、容器操作与忙闲状态管理。
 *              Services page-local state, container operations, and busy-state management.
 */
import { ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import type { ContainerRecord, DeploymentSuite } from '../types';
export type CustomComposeProfile = {
  id: string;
  file: string;
  category?: 'shared' | 'dedicated';
  order: number;
  title: string;
  title_zh: string;
  description: string;
  description_zh: string;
  image?: string;
  image_built?: boolean;
  container_name?: string;
  suitable_models?: string[];
  runtime_declaration?: DeploymentSuite | null;
  yaml: string;
};

export type CustomProfileDockerfile = {
  id: string;
  exists: boolean;
  compose_file: string;
  dockerfile_path: string;
  image: string;
  source_dockerfile_path?: string;
  content: string;
};

function composeProfileImage(profile: CustomComposeProfile): string {
  const line = profile.yaml.split('\n').find((item) => item.trim().startsWith('image:')) || '';
  const value = line.split('image:').slice(1).join('image:').split('#')[0].trim();
  let raw = value;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  const defaultStart = raw.indexOf(':-');
  const withDefault = raw.charCodeAt(0) === 36 && raw.charCodeAt(1) === 123 && defaultStart >= 0 && raw.endsWith('}') ? raw.slice(defaultStart + 2, -1) : '';
  return withDefault || raw || '-';
}

export function customComposeProfileVersion(profile: CustomComposeProfile): string {
  const image = composeProfileImage(profile);
  const tag = image.includes(':') ? image.split(':').pop() || image : 'latest';
  const component = profile.title.split(/[ /]+/)[0] || profile.id;
  return component + ' ' + tag;
}

export function customComposeProfileImageLabel(profile: CustomComposeProfile): string {
  return composeProfileImage(profile);
}

import {
  locale, t, api, refresh, selectedTaskId, taskLog, containerLog,
  selectedLogContainer, loadTaskLog, loadContainerLogs, actionTargetName,
  containers, customComponents, customMode, customRestartPolicy, customAutoRestart,
  customName, customImage, customModalOpen, customTab, composeYaml, composeValidating,
  composeValidationResult, view
} from './useApp';
export const customComposeProfiles = ref<CustomComposeProfile[]>([]);
export const customComposeProfilesLoading = ref(false);

export async function loadCustomComposeProfiles(force = false) {
  if (customComposeProfilesLoading.value) return;
  if (!force && customComposeProfiles.value.length) return;
  customComposeProfilesLoading.value = true;
  try {
    const payload = await api<{ profiles: CustomComposeProfile[] }>('/containers/custom/profiles');
    customComposeProfiles.value = payload.profiles ?? [];
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    customComposeProfilesLoading.value = false;
  }
}

export type RuntimeExtensionCategory = 'shared' | 'dedicated';

export type RuntimeExtensionImportResult = {
  ok: boolean;
  id: string;
  category: RuntimeExtensionCategory;
  replaced: boolean;
  files: string[];
  profile: CustomComposeProfile;
};

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function importRuntimeExtension(
  file: File,
  category: RuntimeExtensionCategory,
  overwrite = false
): Promise<RuntimeExtensionImportResult> {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(locale.value === 'zh-CN' ? '导入包不能超过 8 MiB。' : 'The import package cannot exceed 8 MiB.');
  }
  const result = await api<RuntimeExtensionImportResult>('/containers/custom/profiles/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      content_base64: await fileToBase64(file),
      category,
      overwrite
    })
  });
  await loadCustomComposeProfiles(true);
  return result;
}

export function selectCustomComposeProfile(profile: CustomComposeProfile) {
  customName.value = profile.id;
  composeYaml.value = profile.yaml;
  composeValidationResult.value = null;
}

export async function loadCustomProfileDockerfile(profile: CustomComposeProfile): Promise<CustomProfileDockerfile> {
  return api<CustomProfileDockerfile>("/containers/custom/profiles/" + encodeURIComponent(profile.id) + "/dockerfile");
}

export async function saveCustomProfileDockerfile(profile: CustomComposeProfile, content: string, dockerfilePath: string) {
  const result = await api<{ ok: boolean; detail?: string; dockerfile_path: string; compose_yaml?: string; compose_updated?: boolean }>(
    "/containers/custom/profiles/" + encodeURIComponent(profile.id) + "/dockerfile",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, dockerfile_path: dockerfilePath })
    }
  );
  if (!result.ok) throw new Error(result.detail || t("actionFailed"));
  await loadCustomComposeProfiles(true);
  return result;
}

export async function saveCustomComposeProfileMetadata(
  profile: CustomComposeProfile,
  metadata: { category?: RuntimeExtensionCategory; title?: string; title_zh?: string; description?: string; description_zh?: string; suitable_models?: string[]; yaml?: string }
) {
  const result = await api<CustomComposeProfile & { ok: boolean; detail?: string }>(
    "/containers/custom/profiles/" + encodeURIComponent(profile.id),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata)
    }
  );
  if (!result.ok) throw new Error(result.detail || t("actionFailed"));
  await loadCustomComposeProfiles(true);
  return result;
}

export async function buildCustomProfileImage(profile: CustomComposeProfile) {
  const hide = message.loading(locale.value === 'zh-CN' ? '正在创建构建任务...' : 'Creating build task...', 0);
  try {
    const payload = await api<any>("/containers/custom/profiles/" + encodeURIComponent(profile.id) + "/build", { method: "POST" });
    const taskId = payload.task?.id;
    if (!taskId) throw new Error(payload.detail || (locale.value === 'zh-CN' ? '后端未返回构建任务。' : 'Backend did not return a build task.'));
    await refresh();
    selectedTaskId.value = taskId;
    view.value = "tasks";
    await loadTaskLog(taskId);
    message.success(locale.value === 'zh-CN' ? '构建任务已创建' : 'Build task created');
    return payload;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    hide();
  }
}


export async function startCustomProfileRuntime(profile: CustomComposeProfile) {
  const hide = message.loading(locale.value === 'zh-CN' ? '正在创建启动任务...' : 'Creating start task...', 0);
  try {
    const payload = await api<any>("/containers/custom/profiles/" + encodeURIComponent(profile.id) + "/start", { method: "POST" });
    const taskId = payload.task?.id;
    if (!taskId) throw new Error(payload.detail || (locale.value === 'zh-CN' ? '后端未返回启动任务。' : 'Backend did not return a start task.'));
    await refresh();
    selectedTaskId.value = taskId;
    view.value = "tasks";
    await loadTaskLog(taskId);
    message.success(locale.value === 'zh-CN' ? '启动任务已创建' : 'Start task created');
    return payload;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    hide();
  }
}



export function deleteCustomComposeProfileConfirm(profile: CustomComposeProfile) {
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除自定义 Profile' : 'Confirm Delete Custom Profile',
    content: locale.value === 'zh-CN'
      ? `即将删除「${profile.title_zh}」对应的 Compose 模板文件：${profile.file}`
      : `This will delete the Compose profile file for "${profile.title}": ${profile.file}`,
    okText: locale.value === 'zh-CN' ? '确认删除' : 'Delete',
    okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel',
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try {
        const result = await api<{ ok: boolean; detail?: string }>('/containers/custom/profiles/' + encodeURIComponent(profile.id), { method: 'DELETE' });
        if (!result.ok) throw new Error(result.detail || t('actionFailed'));
        customComposeProfiles.value = customComposeProfiles.value.filter((item) => item.id !== profile.id);
        if (customName.value === profile.id) {
          customName.value = '';
          composeYaml.value = '';
          composeValidationResult.value = null;
        }
        message.success(locale.value === 'zh-CN' ? 'Profile 已删除' : 'Profile deleted');
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally { hide(); }
    }
  });
}

// ── 容器操作忙闲状态 ─────────────────────────────────────────────────────

/** 记录每个容器每个操作的忙闲状态 */
export const containerActionBusy = ref<Record<string, boolean>>({});

/** 生成容器操作唯一键 */
export function containerActionKey(container: ContainerRecord, action: string): string {
  return actionTargetName(container) + ':' + action;
}

/** 判断指定容器的指定操作是否忙碌中 */
export function isContainerActionBusy(container: ContainerRecord, action: string): boolean {
  return Boolean(containerActionBusy.value[containerActionKey(container, action)]);
}

/** 判断指定容器是否有任意操作忙碌中 */
export function isContainerBusy(container: ContainerRecord): boolean {
  return Object.keys(containerActionBusy.value).some((key) =>
    key.startsWith(actionTargetName(container) + ':')
  );
}

/** 设置容器操作忙闲状态 */
export function setContainerBusy(container: ContainerRecord, action: string, busy: boolean) {
  const key = containerActionKey(container, action);
  const next = { ...containerActionBusy.value };
  if (busy) next[key] = true;
  else delete next[key];
  containerActionBusy.value = next;
}

// ── 容器操作 ─────────────────────────────────────────────────────────────

/** 等待任务完成（轮询，最长 120 秒） */
async function waitForTaskDone(taskId: string, timeoutMs = 120000): Promise<any | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await api<any>('/tasks/' + encodeURIComponent(taskId));
    if (['succeeded', 'failed', 'canceled'].includes(task.status)) return task;
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

/** 执行容器启停操作（start / stop / restart） */
export async function runContainerAction(container: ContainerRecord, action: 'start' | 'stop' | 'restart') {
  if (isContainerBusy(container)) return;
  setContainerBusy(container, action, true);
  try {
    const target = actionTargetName(container);
    if (container.preset && action === 'start') {
      // 内置容器需要先保存配置
      await saveContainerConfig(container, true);
      const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/start-test', { method: 'POST' });
      if (payload.task?.id) {
        selectedTaskId.value = payload.task.id;
        taskLog.value = '';
        await loadTaskLog(payload.task.id);
        const task = await waitForTaskDone(payload.task.id);
        if (task?.status === 'failed') { message.error(task.error || t('actionFailed')); return; }
        if (!task) {
          message.warning(locale.value === 'zh-CN'
            ? '启动任务仍在运行，请稍后查看任务日志。'
            : 'Start task is still running. Check task logs later.');
          return;
        }
      }
      containerLog.value = '';
      selectedLogContainer.value = target;
      message.success(t('actionSucceeded'));
      await refresh();
      await loadContainerLogs(target);
      return;
    }
    const payload = await api<{ ok?: boolean; detail?: string }>(
      '/containers/' + encodeURIComponent(target) + '/' + action,
      { method: 'POST' }
    );
    if (payload.ok === false) { message.warning(payload.detail || t('actionFailed')); return; }
    message.success(payload.detail || t('actionSucceeded'));
    if (action === 'start' || action === 'restart') containerLog.value = '';
    selectedLogContainer.value = target;
    await refresh();
    if (action === 'start' || action === 'restart') await new Promise(r => setTimeout(r, 1500));
    await loadContainerLogs(target);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    setContainerBusy(container, action, false);
  }
}

/** 查看容器日志 */
export async function viewContainerLogs(container: ContainerRecord) {
  if (isContainerActionBusy(container, 'logs')) return;
  setContainerBusy(container, 'logs', true);
  try { await loadContainerLogs(actionTargetName(container)); }
  finally { setContainerBusy(container, 'logs', false); }
}

/** 拉取容器镜像 */
export async function prepareContainerImage(container: ContainerRecord) {
  if (isContainerBusy(container)) return;
  setContainerBusy(container, 'pull-image', true);
  try {
    const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/pull-image', { method: 'POST' });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); }
    message.success(t('actionSucceeded'));
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    setContainerBusy(container, 'pull-image', false);
  }
}

/** 测试容器镜像 */
export async function testContainerImage(container: ContainerRecord) {
  if (isContainerBusy(container)) return;
  setContainerBusy(container, 'test-image', true);
  try {
    const payload = await api<any>('/containers/' + encodeURIComponent(container.key) + '/test-image', { method: 'POST' });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; await loadTaskLog(payload.task.id); }
    message.success(t('actionSucceeded'));
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    setContainerBusy(container, 'test-image', false);
  }
}

/** 保存容器配置 */
export async function saveContainerConfig(container: ContainerRecord, silent = false) {
  try {
    await api('/containers/' + encodeURIComponent(container.key) + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_port: Number(container.public_port),
        management_mode: container.management_mode,
        restart_policy: container.restart_policy,
        auto_restart: container.auto_restart
      })
    });
    if (!silent) { message.success(t('configSaved')); await refresh(); }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 保存既有自定义容器的用途说明，不修改或重建 Docker 容器。 */
export async function saveContainerMetadata(container: ContainerRecord, note: string, suitableModels: string[]) {
  await api('/containers/' + encodeURIComponent(container.key) + '/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note, suitable_models: suitableModels })
  });
  await refresh();
  message.success(locale.value === 'zh-CN' ? '容器说明已保存' : 'Container notes saved');
}

/** 删除内置容器确认 */
export function deleteContainerConfirm(container: ContainerRecord) {
  if (!container.preset) {
    message.warning(locale.value === 'zh-CN' ? '仅内置容器模板支持删除' : 'Only preset container templates can be deleted');
    return;
  }
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
      setContainerBusy(container, 'delete', true);
      try {
        const result = await api<{ ok: boolean; steps: string[] }>(
          '/containers/' + encodeURIComponent(container.key),
          { method: 'DELETE' }
        );
        if (result.ok) message.success(locale.value === 'zh-CN' ? '容器已删除，Docker 资源已清理' : 'Container deleted and Docker resources cleaned');
        else message.warning((locale.value === 'zh-CN' ? '部分清理失败：' : 'Partial cleanup: ') + (result.steps?.join('; ') ?? ''));
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setContainerBusy(container, 'delete', false);
        hide();
      }
    }
  });
}

/** 删除自定义容器确认 */
export function deleteCustomContainerConfirm(container: ContainerRecord) {
  Modal.confirm({
    title: locale.value === 'zh-CN' ? '确认删除自定义容器' : 'Confirm Delete Custom Container',
    content: locale.value === 'zh-CN'
      ? `即将删除容器「${container.name}」。此操作不可撤销。`
      : `This will delete container "${container.name}". This action cannot be undone.`,
    okText: locale.value === 'zh-CN' ? '确认删除' : 'Confirm Delete',
    okType: 'danger',
    cancelText: locale.value === 'zh-CN' ? '取消' : 'Cancel',
    onOk: async () => {
      const hide = message.loading(t('deleting'), 0);
      try {
        const result = await api<{ ok: boolean; detail: string }>(
          '/containers/custom/' + encodeURIComponent(container.name),
          { method: 'DELETE' }
        );
        if (result.ok) message.success(locale.value === 'zh-CN' ? '容器已删除' : 'Container deleted');
        else message.warning(result.detail);
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally { hide(); }
    }
  });
}

// ── 自定义容器创建 ───────────────────────────────────────────────────────

/** 通过组件选择创建自定义容器 */
export async function createCustomContainerFromComponents() {
  try {
    const payload = await api<any>('/containers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customName.value,
        image: customImage.value,
        components: customComponents.value,
        management_mode: customMode.value,
        restart_policy: customRestartPolicy.value,
        auto_restart: customAutoRestart.value
      })
    });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; view.value = 'tasks'; await loadTaskLog(payload.task.id); }
    customModalOpen.value = false;
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/** 验证 Compose YAML 语法 */
export async function validateComposeYaml() {
  if (!composeYaml.value.trim()) {
    composeValidationResult.value = {
      valid: false,
      errors: locale.value === 'zh-CN' ? 'YAML 内容为空' : 'YAML content is empty'
    };
    return;
  }
  composeValidating.value = true; composeValidationResult.value = null;
  try {
    const result = await api<{ valid: boolean; errors?: string; normalized?: string }>(
      '/containers/compose/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: composeYaml.value })
      }
    );
    composeValidationResult.value = result;
  } catch (error) {
    composeValidationResult.value = {
      valid: false,
      errors: error instanceof Error ? error.message : String(error)
    };
  } finally {
    composeValidating.value = false;
  }
}

/** 通过 Compose YAML 创建自定义容器 */
export async function createCustomContainerFromCompose(extra?: { dockerfile_content?: string; dockerfile_path?: string; components?: string[]; suitable_models?: string[] }) {
  if (!composeValidationResult.value?.valid) {
    message.warning(locale.value === 'zh-CN' ? '请先验证 YAML 语法' : 'Please validate the YAML syntax first');
    return;
  }
  try {
    const payload = await api<any>('/containers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customName.value || 'custom_compose',
        compose_yaml: composeYaml.value,
        dockerfile_content: extra?.dockerfile_content,
        dockerfile_path: extra?.dockerfile_path,
        components: extra?.components,
        suitable_models: extra?.suitable_models,
        management_mode: customMode.value,
        restart_policy: customMode.value === 'once' ? 'no' : customRestartPolicy.value,
        auto_restart: customMode.value !== 'once' && customRestartPolicy.value !== 'no'
      })
    });
    if (payload.task?.id) { selectedTaskId.value = payload.task.id; view.value = 'tasks'; await loadTaskLog(payload.task.id); }
    customModalOpen.value = false;
    composeYaml.value = '';
    composeValidationResult.value = null;
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
