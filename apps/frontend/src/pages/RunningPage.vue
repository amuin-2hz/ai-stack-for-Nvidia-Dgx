<!--
  @author Amuin
  @created 2026-06-25
  @description 运行中部署页面：展示当前运行中的模型部署卡片。
               Running deployments page: display currently running model deployment cards.
-->
<script setup lang="ts">
import { CopyOutlined, PlayCircleOutlined } from '@ant-design/icons-vue';
import {
  locale, t, view, runningDeployments,
  modelEndpoint, inferenceEndpoint, inferenceEndpointLabel, statusText, badgeColor, copyText,
} from '../composables/useApp';
import { selectedPlaygroundDeploymentId } from '../composables/usePlayground';
import HeroBanner from '../components/shared/HeroBanner.vue';

function endpointPath(deployment: any) {
  try { return new URL(inferenceEndpoint(deployment)).pathname; }
  catch { return inferenceEndpoint(deployment); }
}
</script>

<template>
  <section class="prototype-page running-layout" style="display:grid;grid-template-rows:120px auto minmax(0,1fr);height:100%;min-height:0;overflow:hidden;padding:14px 16px;gap:14px">
    <HeroBanner :title="t('running')" :eyebrow="t('studioName')" />

    <div class="panel-stack running-grid" style="overflow:auto;align-content:start">
      <a-card v-for="deployment in runningDeployments" :key="deployment.deployment_id" class="model-card running-card" :bordered="false">
        <template #title>{{ deployment.openai_models.join(', ') || deployment.runtime }}</template>
        <template #extra><a-tag :color="badgeColor(deployment.status)">{{ statusText(deployment.status) }}</a-tag></template>
        <div class="deploy-kv-grid compact-kv">
          <span>{{ t('runtime') }}<b>{{ deployment.service_type }}</b></span>
          <span>{{ t('port') }}<b>{{ deployment.public_port }}</b></span>
          <span>{{ t('modelListEndpoint') }}<b>{{ modelEndpoint(deployment) }}</b></span>
          <span>{{ inferenceEndpointLabel(deployment) }}<b>{{ inferenceEndpoint(deployment) }}</b></span>
        </div>
        <a-space class="card-actions model-actions" wrap>
          <a-button size="small" @click="copyText(modelEndpoint(deployment))"><template #icon><CopyOutlined /></template>/v1/models</a-button>
          <a-button size="small" @click="copyText(inferenceEndpoint(deployment))"><template #icon><CopyOutlined /></template>{{ endpointPath(deployment) }}</a-button>
          <a-button size="small" type="primary" @click="selectedPlaygroundDeploymentId = deployment.deployment_id; view = 'playground'"><template #icon><PlayCircleOutlined /></template>{{ t('playground') }}</a-button>
        </a-space>
      </a-card>
      <a-empty v-if="!runningDeployments.length" :description="t('noRunningModels')" />
    </div>
  </section>
</template>
