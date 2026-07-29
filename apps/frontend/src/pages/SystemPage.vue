<!--
  @author Amuin
  @created 2026-06-25
  @description 系统状态页面：主机/GPU/Docker/存储状态、资源仪表、端口表与模型目录。
               System status page: host/GPU/Docker/storage, resource gauges, port table, model directory.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import {
  locale, t, system, models, readyModels, storagePercent,
  cpuPercent, memoryPercent, formatBytes, portRows, consoleAddress,
  modelListSummaryUrl, managementHost, runtimeContainers, api
} from '../composables/useApp';
import type { SystemCheck } from '../types';
import HeroBanner from '../components/shared/HeroBanner.vue';
import GaugeRing from '../components/shared/GaugeRing.vue';

/** 模型根目录推断 */
const modelRootHint = computed(() => {
  const modelPath = models.value.find((model) => model.local.path)?.local.path || '';
  if (!modelPath) return locale.value === 'zh-CN' ? '尚未发现本地模型' : 'No local models discovered yet';
  const marker = '/models/';
  const index = modelPath.indexOf(marker);
  if (index >= 0) return modelPath.slice(0, index + marker.length - 1);
  const parts = modelPath.split('/').filter(Boolean);
  if (parts.length <= 1) return modelPath;
  return (modelPath.startsWith('/') ? '/' : '') + parts.slice(0, -1).join('/');
});

const modelStorageBytes = computed(() =>
  models.value.reduce((total, model) => total + (model.local.size_bytes || 0), 0)
);

const runtimeHealthText = computed(() => {
  if (!runtimeContainers.value.length) return t('unavailable');
  const running = runtimeContainers.value.filter((container) => container.state === 'running').length;
  return running + ' / ' + runtimeContainers.value.length + ' ' + (locale.value === 'zh-CN' ? '运行中' : 'running');
});

type GpuTelemetry = {
  name?: string;
  utilization_gpu_percent?: number | null;
  temperature_celsius?: number | null;
  power_draw_watts?: number | null;
};

const primaryGpu = computed(() => (system.value?.device?.gpu?.devices?.[0] ?? null) as GpuTelemetry | null);
function telemetryNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
const gpuUtilization = computed(() => telemetryNumber(primaryGpu.value?.utilization_gpu_percent));
const gpuTemperature = computed(() => telemetryNumber(primaryGpu.value?.temperature_celsius));
const gpuPower = computed(() => telemetryNumber(primaryGpu.value?.power_draw_watts));
const componentTemperatures = computed(() => {
  const sensors = system.value?.device?.temperatures ?? [];
  const selected: typeof sensors = [];
  const sources = new Set<string>();
  for (const sensor of sensors) {
    if (sources.has(sensor.source)) continue;
    sources.add(sensor.source);
    selected.push(sensor);
    if (selected.length === 4) return selected;
  }
  for (const sensor of sensors) {
    if (selected.includes(sensor)) continue;
    selected.push(sensor);
    if (selected.length === 4) break;
  }
  return selected;
});
const thermalRows = computed(() => {
  const rows: Array<{ key: string; label: string; celsius: number; meta?: string }> = [];
  if (gpuTemperature.value !== null) {
    rows.push({
      key: 'gpu',
      label: locale.value === 'zh-CN' ? 'GPU 温度' : 'GPU Temperature',
      celsius: gpuTemperature.value,
      meta: gpuPower.value === null ? '' : gpuPower.value.toFixed(1) + ' W'
    });
  }
  rows.push(...componentTemperatures.value.map((sensor) => ({
    key: sensor.source + ':' + sensor.label,
    label: temperatureLabel(sensor),
    celsius: sensor.celsius
  })));
  return rows.slice(0, 5);
});

function thermalBarStyle(celsius: number) {
  const percent = Math.max(0, Math.min(100, celsius));
  return { '--thermal-percent': percent + '%' };
}

function hasRuntimeState(row: { state?: string }) {
  return row.state === 'running' || row.state === 'stopped' || row.state === 'missing' || row.state === 'unknown';
}

function portStatusClass(row: { state?: string; available?: boolean }) {
  if (row.state === 'running') return 'isReady';
  if (hasRuntimeState(row)) return 'isNeutral';
  return row.available ? 'isReady' : 'isBusy';
}

function portStatusText(row: { state?: string; available?: boolean }) {
  if (row.state === 'running') return locale.value === 'zh-CN' ? '运行中' : 'Running';
  if (row.state === 'stopped') return locale.value === 'zh-CN' ? '已停止' : 'Stopped';
  if (row.state === 'missing' || row.state === 'unknown') return locale.value === 'zh-CN' ? '未运行' : 'Not running';
  return row.available ? (locale.value === 'zh-CN' ? '可用' : 'Ready') : (locale.value === 'zh-CN' ? '占用' : 'In use');
}

function temperatureLabel(sensor: { label: string; source: string }): string {
  const source = sensor.source.toLowerCase();
  const label = sensor.label.trim();
  const suffix = label.match(/(\d+)$/)?.[1] || '';
  if (source === 'acpitz') {
    return locale.value === 'zh-CN'
      ? 'ACPI 热区' + (suffix ? ' ' + suffix : '')
      : 'ACPI Thermal Zone' + (suffix ? ' ' + suffix : '');
  }
  if (source === 'nvme') {
    if (/composite/i.test(label)) return locale.value === 'zh-CN' ? 'NVMe 硬盘' : 'NVMe SSD';
    return locale.value === 'zh-CN'
      ? 'NVMe 传感器' + (suffix ? ' ' + suffix : '')
      : 'NVMe Sensor' + (suffix ? ' ' + suffix : '');
  }
  if (/^(mt\d+|iwl|ath|wifi)/.test(source)) return locale.value === 'zh-CN' ? 'Wi-Fi 芯片' : 'Wi-Fi Adapter';
  if (/^(coretemp|k10temp|cpu)/.test(source)) {
    return locale.value === 'zh-CN' ? 'CPU 温度' : 'CPU Temperature';
  }
  if (/pch|chipset/.test(source)) return locale.value === 'zh-CN' ? '主板芯片组' : 'Motherboard Chipset';
  return label.replace(/[_-]+/g, ' ');
}

let telemetryTimer: number | undefined;
let telemetryRefreshing = false;

async function refreshTelemetry() {
  if (telemetryRefreshing) return;
  telemetryRefreshing = true;
  try {
    system.value = await api<SystemCheck>('/system/check');
  } finally {
    telemetryRefreshing = false;
  }
}

onMounted(() => {
  telemetryTimer = window.setInterval(() => { void refreshTelemetry(); }, 5000);
});

onBeforeUnmount(() => {
  if (telemetryTimer !== undefined) window.clearInterval(telemetryTimer);
});
</script>

<template>
  <section class="prototype-page system-status-layout">
    <HeroBanner
      :title="t('system')"
      :eyebrow="t('studioName')"
      :desc="locale === 'zh-CN' ? '面向演示场景集中展示设备资源、接口端口、本机入口和模型目录信息。' : 'Show device resources, port status, local entrances, and model directory information for demo purposes.'"
    />

    <section class="statusGrid systemStatusGrid">
      <article class="statusCard systemStatusCardResource">
        <div class="panelHeader"><h2>{{ locale === 'zh-CN' ? '资源状态' : 'Resource Status' }}</h2></div>
        <div class="resourceGrid systemResourceGrid">
          <div class="resourceItem">
            <GaugeRing :percent="cpuPercent" :size="82" />
            <strong class="resourceName">{{ t('cpu') }}</strong>
            <span class="resourceMeta">{{ system?.device?.cpu?.cores ?? 0 }} cores</span>
          </div>
          <div class="resourceItem">
            <GaugeRing :percent="memoryPercent" :size="82" />
            <strong class="resourceName">{{ t('memory') }}</strong>
            <span class="resourceMeta">{{ formatBytes(Math.max(0,(system?.device?.memory?.total_bytes??0)-(system?.device?.memory?.free_bytes??0))) }} / {{ formatBytes(system?.device?.memory?.total_bytes??0) }}</span>
          </div>
          <div class="resourceItem">
            <GaugeRing :percent="storagePercent" :size="82" />
            <strong class="resourceName">{{ t('storage') }}</strong>
            <span class="resourceMeta">{{ system?.device?.storage?.volumes?.[0]?.mount ?? '-' }}</span>
          </div>
          <div class="resourceItem">
            <GaugeRing :percent="gpuUtilization ?? 0" :size="82">
              <strong>{{ gpuUtilization === null ? '-' : Math.round(gpuUtilization) + '%' }}</strong>
            </GaugeRing>
            <strong class="resourceName">GPU</strong>
            <span class="resourceMeta">{{ primaryGpu?.name || t('unavailable') }}</span>
          </div>
          <div class="resourceItem thermalResourceItem">
            <div class="thermalHeader">
              <strong class="resourceName">{{ locale === 'zh-CN' ? '温度' : 'Temperatures' }}</strong>
              <small>{{ primaryGpu?.name || t('deviceStatus') }}</small>
            </div>
            <div v-if="thermalRows.length" class="thermalSensorList">
              <span v-for="row in thermalRows" :key="row.key" :title="row.label" :style="thermalBarStyle(row.celsius)">
                <small>{{ row.label }}</small>
                <i></i>
                <b>{{ row.celsius.toFixed(1) }}°C</b>
                <em :class="{ isEmpty: !row.meta }">{{ row.meta }}</em>
              </span>
            </div>
            <span v-else class="resourceMeta">{{ t('unavailable') }}</span>
          </div>
        </div>
      </article>

      <article class="statusCard systemPortCard">
        <div class="panelHeader"><h2>{{ locale === 'zh-CN' ? '接口端口' : 'Interface Ports' }}</h2></div>
        <div class="tablePanel systemPortTable">
          <div class="tableHeader tableRow">
            <span>{{ t('containerName') }}</span><span>{{ t('port') }}</span><span>{{ t('status') }}</span>
          </div>
          <div class="tableBody">
            <div v-for="row in portRows" :key="row.name" class="tableRow">
              <span class="portNameCell" :title="row.container_name || row.name">
                <b>{{ row.label || row.name }}</b>
                <em v-if="row.source === 'custom'">{{ locale === 'zh-CN' ? '自定义' : 'Custom' }}</em>
              </span>
              <span>{{ row.port }}<small v-if="row.internal_port"> -> {{ row.internal_port }}/{{ row.protocol }}</small></span>
              <span :class="['statusBadge', portStatusClass(row)]">
                {{ portStatusText(row) }}
              </span>
            </div>
          </div>
        </div>
      </article>

      <article class="statusCard">
        <div class="panelHeader"><h2>{{ locale === 'zh-CN' ? '本机入口' : 'Local Entrances' }}</h2></div>
        <div class="infoGrid systemInfoGrid">
          <div class="infoItem"><span class="infoLabel">{{ t('consoleAddress') }}</span><strong>{{ consoleAddress }}</strong></div>
          <div class="infoItem"><span class="infoLabel">{{ locale === 'zh-CN' ? '后端 API' : 'Backend API' }}</span><strong>{{ system?.backend_url ?? '-' }}</strong></div>
          <div class="infoItem"><span class="infoLabel">{{ t('modelListEndpoint') }}</span><strong>{{ modelListSummaryUrl }}</strong></div>
          <div class="infoItem"><span class="infoLabel">LAN</span><strong>{{ system?.lan_addresses?.join(', ') || managementHost }}</strong></div>
        </div>
      </article>

      <article class="statusCard">
        <div class="panelHeader"><h2>{{ locale === 'zh-CN' ? '模型目录' : 'Model Directory' }}</h2></div>
        <div class="infoGrid systemInfoGrid">
          <div class="infoItem"><span class="infoLabel">{{ locale === 'zh-CN' ? '推断路径' : 'Path' }}</span><strong>{{ modelRootHint }}</strong></div>
          <div class="infoItem"><span class="infoLabel">{{ t('readyModels') }}</span><strong>{{ readyModels }} / {{ models.length }}</strong></div>
          <div class="infoItem"><span class="infoLabel">{{ t('size') }}</span><strong>{{ formatBytes(modelStorageBytes) }}</strong></div>
          <div class="infoItem"><span class="infoLabel">{{ locale === 'zh-CN' ? '运行时状态' : 'Runtime Status' }}</span><strong>{{ runtimeHealthText }}</strong></div>
        </div>
      </article>
    </section>
  </section>
</template>
