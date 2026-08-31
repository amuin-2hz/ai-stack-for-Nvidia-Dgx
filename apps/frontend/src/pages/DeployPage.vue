<!--
  @author Amuin
  @created 2026-06-25
  @description 部署页面：运行时容器卡片、服务日志与操作任务侧栏。
               Deploy page: runtime container cards, service logs, and operation task sidebar.
-->
<script setup lang="ts">
import { FileTextOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons-vue';
import {
  locale, t, containers, containerLog, taskLog, selectedLogContainer, logCollapsed,
  selectedTaskId, loadTaskLog, loadContainerLogs,
  containerStateText, containerStateColor, imageStatusColor, imageStatusText,
  testStatusColor, testStatusText, visibleTasks, taskTypeText, taskAlias, statusText, badgeColor,
} from '../composables/useApp';
import {
  isContainerActionBusy, isContainerBusy, runContainerAction, viewContainerLogs,
} from '../composables/useServices';
import HeroBanner from '../components/shared/HeroBanner.vue';
</script>

<template>
  <section class="prototype-page deploy-page-layout" style="display:grid;grid-template-rows:120px minmax(0,1fr);height:100%;min-height:0;overflow:hidden;padding:14px 16px;gap:14px">
    <HeroBanner :title="t('deploy')" :eyebrow="t('studioName')" />

    <div class="deploy-main-col">
      <!-- 运行时容器卡片 -->
      <div class="runtime-service-grid">
        <a-card v-for="container in containers.filter((item) => item.runtime !== 'custom')" :key="container.key" class="glass-card runtime-service-card" :title="container.title" :bordered="false">
          <template #extra>
            <a-space wrap>
              <a-tag :color="containerStateColor(container)">{{ containerStateText(container) }}</a-tag>
              <a-tag :color="imageStatusColor(container)">{{ imageStatusText(container) }}</a-tag>
              <a-tag :color="testStatusColor(container.test_status)">{{ testStatusText(container.test_status) }}</a-tag>
            </a-space>
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
            <a-tooltip :title="t('start')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'start')" :disabled="container.state === 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'start')"><template #icon><PlayCircleOutlined /></template></a-button></a-tooltip>
            <a-tooltip :title="t('stop')"><a-button class="runtime-action-btn" danger :loading="isContainerActionBusy(container, 'stop')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'stop')"><template #icon><PauseCircleOutlined /></template></a-button></a-tooltip>
            <a-tooltip :title="t('restart')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'restart')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'restart')"><template #icon><SyncOutlined /></template></a-button></a-tooltip>
            <a-tooltip :title="t('viewLogs')"><a-button class="runtime-action-btn" :loading="isContainerActionBusy(container, 'logs')" :disabled="isContainerBusy(container)" @click="viewContainerLogs(container)"><template #icon><FileTextOutlined /></template></a-button></a-tooltip>
          </div>
        </a-card>
      </div>

      <!-- 服务日志 -->
      <a-card :title="t('serviceLogs') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')" class="glass-card deploy-log-bottom" :bordered="false">
        <template #extra>
          <a-space>
            <a-button size="small" @click="selectedLogContainer ? loadContainerLogs(selectedLogContainer) : loadTaskLog()"><template #icon><ReloadOutlined /></template></a-button>
            <a-button size="small" @click="logCollapsed = !logCollapsed">{{ logCollapsed ? t('expandLog') : t('collapseLog') }}</a-button>
          </a-space>
        </template>
        <pre v-if="!logCollapsed" class="message-block log-block service-log-block">{{ containerLog || taskLog || t('noTaskSelected') }}</pre>
      </a-card>
    </div>

    <!-- 操作日志侧栏 -->
    <div class="deploy-task-bar">
      <a-card class="glass-card" :title="locale === 'zh-CN' ? '操作日志' : 'Operation Logs'" :bordered="false" size="small">
        <template #extra>
          <a-button size="small" @click="loadContainerLogs(selectedLogContainer)" v-if="selectedLogContainer"><template #icon><ReloadOutlined /></template></a-button>
        </template>
        <div class="deploy-task-list">
          <a-list size="small" :data-source="visibleTasks.filter((t) => t.type === 'deploy' || t.type === 'container').slice(0, 6)">
            <template #renderItem="{ item: task }">
              <a-list-item class="deploy-task-item" @click="selectedTaskId = task.id; loadTaskLog(task.id)">
                <a-list-item-meta :title="taskTypeText(task.type) + ' · ' + taskAlias(task)" :description="statusText(task.status)" />
                <a-tag :color="badgeColor(task.status)">{{ statusText(task.status) }}</a-tag>
              </a-list-item>
            </template>
            <template #empty><a-empty :description="locale === 'zh-CN' ? '暂无操作记录' : 'No logs'" style="padding:12px 0" :image-style="{height:'40px'}" /></template>
          </a-list>
        </div>
      </a-card>
    </div>
  </section>
</template>
