/**
 * @author Amuin
 * @created 2026-06-25
 * @description 任务管理相关操作：下载控制、修复操作、部署关联与页面跳转。
 *              Task management operations: download control, repair, deployment linking, and navigation.
 */
import { message } from 'ant-design-vue';
import type { TaskRecord, DeploymentRecord } from '../types';
import {
  locale, t, api, view, refresh, selectedTaskId, selectedDownloadLogId, taskLog,
  loadTaskLog, runningDeployments, containers
} from './useApp';
import { selectedPlaygroundDeploymentId } from './usePlayground';

/**
 * 控制下载任务（暂停 / 恢复 / 取消）。
 * Control a download task (pause / resume / cancel).
 */
export async function controlDownloadTask(task: TaskRecord, action: 'pause' | 'resume' | 'cancel') {
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

/**
 * 继续失败或已取消的下载，并复用磁盘上已暂存的文件。
 * Retry a failed/canceled download while preserving staged files on disk.
 */
export async function retryDownloadTask(task: TaskRecord) {
  try {
    const payload = await api<{ task?: TaskRecord; message?: string }>(
      '/tasks/' + encodeURIComponent(task.id) + '/retry',
      { method: 'POST' }
    );
    const nextTask = payload.task ?? task;
    message.success(payload.message || t('actionSucceeded'));
    selectedDownloadLogId.value = nextTask.id;
    selectedTaskId.value = nextTask.id;
    await refresh();
    await loadTaskLog(nextTask.id);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 对失败任务执行修复操作（查看日志 / 更换端口 / 更换镜像等）。
 * Execute a repair action on a failed task (view logs / change port / change image).
 */
export async function repairTask(task: TaskRecord, action: string) {
  try {
    const runtime = String(task.metadata?.service_type ?? task.metadata?.key ?? '');
    const body: Record<string, unknown> = { action, runtime };
    if (action === 'change_port') {
      const current = containers.value.find(
        (container) => container.runtime === runtime || container.key === runtime
      )?.public_port;
      const value = window.prompt(
        locale.value === 'zh-CN' ? '输入新的发布端口' : 'Enter new public port',
        current ? String(current) : ''
      );
      if (!value) return;
      const publicPort = Number(value.trim());
      if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535) {
        message.warning(
          locale.value === 'zh-CN'
            ? '端口必须是 1024 到 65535 之间的整数'
            : 'Port must be an integer between 1024 and 65535'
        );
        return;
      }
      body.public_port = publicPort;
    }
    if (action === 'change_image') {
      const current = containers.value.find(
        (container) => container.runtime === runtime || container.key === runtime
      );
      const value = window.prompt(
        locale.value === 'zh-CN' ? '输入新的镜像标签' : 'Enter new image tag',
        current?.image || current?.official_image || ''
      );
      if (!value) return;
      const image = value.trim();
      if (!image || /\s/.test(image)) {
        message.warning(
          locale.value === 'zh-CN'
            ? '镜像标签不能为空且不能包含空格'
            : 'Image tag cannot be empty or contain whitespace'
        );
        return;
      }
      body.image = image;
    }
    const payload = await api<any>('/tasks/' + encodeURIComponent(task.id) + '/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (payload.executable === false) message.info(payload.detail || t('actionSucceeded'));
    else message.success(payload.detail || t('actionSucceeded'));
    if (payload.task?.id) {
      selectedTaskId.value = payload.task.id;
      await loadTaskLog(payload.task.id);
    } else {
      await loadTaskLog(task.id);
    }
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 根据任务元数据查找关联的运行中部署。
 * Find the running deployment associated with a task by metadata.
 */
export function deploymentForTask(task: TaskRecord): DeploymentRecord | undefined {
  const runtimePlan = task.metadata?.runtime_plan;
  const runtimePlanId = typeof runtimePlan?.deployment_id === 'string' ? runtimePlan.deployment_id : '';
  const runtimePlanBaseUrl = typeof runtimePlan?.base_url === 'string' ? runtimePlan.base_url : '';
  const modelId = typeof task.metadata?.model_id === 'string' ? task.metadata.model_id : '';
  const serviceType = typeof task.metadata?.service_type === 'string' ? task.metadata.service_type : '';
  return runningDeployments.value.find((deployment) => {
    if (runtimePlanId && deployment.deployment_id === runtimePlanId) return true;
    if (runtimePlanBaseUrl && deployment.base_url === runtimePlanBaseUrl) return true;
    if (modelId && (deployment.model_id === modelId || deployment.openai_models.includes(modelId))) {
      return !serviceType || deployment.service_type === serviceType;
    }
    return false;
  });
}

/**
 * 从任务跳转到关联部署页面。
 * Navigate from a task to its associated deployment page.
 */
export function openTaskDeployment(task: TaskRecord, targetView: 'running' | 'playground') {
  const deployment = deploymentForTask(task);
  if (!deployment) return;
  if (targetView === 'playground') selectedPlaygroundDeploymentId.value = deployment.deployment_id;
  view.value = targetView;
}
