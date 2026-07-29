<!--
  @author Amuin
  @created 2026-06-25
  @description 运行时服务页面：内置/自定义容器卡片网格、操作按钮与新建容器弹窗。
               Services page: preset/custom container cards, action buttons, and new container modal.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  CheckCircleOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, EyeOutlined, PlayCircleOutlined,
  PlusOutlined, ReloadOutlined, SettingOutlined, StopOutlined, UnorderedListOutlined
} from '@ant-design/icons-vue';
import {
  locale, t, models, runtimeContainers, customContainers, customModalOpen, customTab, runningDeployments,
  customName, customImage, customComponents, customMode, customRestartPolicy, composeYaml, composeValidationResult,
  imageStatusColor, imageStatusText,
  testStatusColor, testStatusText, containerLog, selectedLogContainer,
} from '../composables/useApp';
import {
  isContainerActionBusy, isContainerBusy,
  runContainerAction, viewContainerLogs, prepareContainerImage, testContainerImage,
  deleteContainerConfirm, deleteCustomContainerConfirm, deleteCustomComposeProfileConfirm, saveContainerConfig, saveContainerMetadata,
  customComposeProfiles, loadCustomComposeProfiles, selectCustomComposeProfile,
  buildCustomProfileImage, startCustomProfileRuntime, customComposeProfileVersion, customComposeProfileImageLabel,
} from '../composables/useServices';
import type { ContainerRecord } from '../types';
import type { CustomComposeProfile } from '../composables/useServices';
import HeroBanner from '../components/shared/HeroBanner.vue';
import RuntimeCard from '../components/shared/RuntimeCard.vue';
import CustomContainerModal from '../components/model/CustomContainerModal.vue';

const runtimeLogDrawerOpen = ref(false);
const metadataModalOpen = ref(false);
const metadataSaving = ref(false);
const metadataContainer = ref<ContainerRecord | null>(null);
const metadataNote = ref('');
const metadataSuitableModels = ref<string[]>([]);
const customModalMode = ref<'create' | 'edit'>('create');
const editingProfileId = ref('');
const runtimeTab = ref<'engines' | 'shared' | 'dedicated'>('engines');

type CustomRuntimeCard =
  | { kind: 'container'; key: string; container: ContainerRecord }
  | { kind: 'profile'; key: string; profile: CustomComposeProfile; linkedContainer?: ContainerRecord | null };

onMounted(() => {
  void loadCustomComposeProfiles();
});

function runtimeVersion(container: { title?: string; category?: string; software_versions?: Record<string, string>; image?: string; official_image?: string }) {
  const versions = container.software_versions ?? {};
  const first = Object.values(versions)[0];
  if (first) return first;
  const image = container.official_image || container.image || '';
  if (container.category === 'custom' && image) {
    const tag = image.includes(':') ? image.split(':').pop() || 'latest' : 'latest';
    const component = container.title?.split(/[ /]+/)[0] || 'Runtime';
    return component + ' ' + tag;
  }
  return image || '-';
}

function runtimeDeployments(container: { runtime: string }) {
  return runningDeployments.value.filter((deployment) => deployment.service_type === container.runtime);
}

function runtimeInUse(container: { runtime: string; category?: string; state?: string }) {
  if (container.category === 'custom') return container.state === 'running';
  return runtimeDeployments(container).length > 0;
}

function runtimeUsageLabel(container: { runtime: string; category?: string; state?: string }) {
  if (container.category === 'custom') {
    return container.state === 'running'
      ? (locale.value === 'zh-CN' ? '运行中' : 'Running')
      : (locale.value === 'zh-CN' ? '已停止' : 'Stopped');
  }
  if (runtimeInUse(container)) return locale.value === 'zh-CN' ? '使用中' : 'In use';
  return locale.value === 'zh-CN' ? '未使用' : 'Idle';
}

function runtimeProfileStatus(container: ContainerRecord): string {
  if (runtimeInUse(container)) return locale.value === 'zh-CN' ? '使用中' : 'In use';
  if (container.test_status === 'passed') return locale.value === 'zh-CN' ? '已验证' : 'Validated';
  if (container.image_pulled) return locale.value === 'zh-CN' ? '待验证' : 'Needs validation';
  return locale.value === 'zh-CN' ? '未安装' : 'Not installed';
}

function runtimeProfileReady(container: ContainerRecord): boolean {
  return runtimeInUse(container) || container.test_status === 'passed';
}

async function openRuntimeLogs(container: ContainerRecord) {
  await viewContainerLogs(container);
  runtimeLogDrawerOpen.value = true;
}

function openCustomRuntimeModal() {
  customModalMode.value = 'create';
  editingProfileId.value = '';
  customName.value = '';
  customImage.value = 'nvcr.io/nvidia/pytorch:25.04-py3';
  customMode.value = 'resident';
  customRestartPolicy.value = 'unless-stopped';
  customComponents.value = [];
  composeYaml.value = '';
  composeValidationResult.value = null;
  customTab.value = 'basics';
  customModalOpen.value = true;
}

function profileDisplayName(profile: CustomComposeProfile): string {
  return locale.value === 'zh-CN' ? profile.title_zh : profile.title;
}

function composeLineValue(yaml: string, key: string): string {
  const line = yaml.split('\n').find((item) => item.trim().startsWith(key + ':')) || '';
  let value = line.split(key + ':').slice(1).join(key + ':').split('#')[0].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
}

function profileContainerName(profile: CustomComposeProfile): string {
  return composeLineValue(profile.yaml, 'container_name') || 'custom_' + profile.id.replace(/-/g, '_') + '_service';
}

function containerForProfile(profile: CustomComposeProfile): ContainerRecord | null {
  const containerName = profileContainerName(profile);
  return customContainers.value.find((container) => container.name === containerName)
    ?? customContainers.value.find((container) => profileIdForContainer(container) === profile.id)
    ?? null;
}

function profileCardContainer(card: CustomRuntimeCard): ContainerRecord | null {
  return card.kind === 'container' ? card.container : (card.linkedContainer ?? containerForProfile(card.profile));
}

function profileForRuntimeCard(card: CustomRuntimeCard): CustomComposeProfile | null {
  if (card.kind === 'profile') return card.profile;
  const profileId = profileIdForContainer(card.container);
  return customComposeProfiles.value.find((profile) => profile.id === profileId) ?? null;
}

function profileImageBuilt(card: CustomRuntimeCard): boolean {
  const profile = profileForRuntimeCard(card);
  if (profile?.image_built) return true;
  const container = profileCardContainer(card);
  return Boolean(container?.image);
}

async function buildCardRuntimeImage(card: CustomRuntimeCard) {
  const profile = profileForRuntimeCard(card);
  if (profile) await buildCustomProfileImage(profile);
}

function profileIdForContainer(container: ContainerRecord): string {
  const text = [container.key, container.name, container.title].join(' ').toLowerCase();
  if (/funasr[-_ ]?gateway|custom_funasr_gateway/.test(text)) return 'funasr-gateway';
  if (/vibevoice[-_ ]?hf|custom_vibevoice_hf/.test(text)) return 'vibevoice-hf';
  if (/qwen3[-_ ]?tts|custom_qwen3_tts/.test(text)) return 'qwen3-tts';
  if (/embedding/.test(text)) return 'vllm-embedding';
  if (/rerank/.test(text)) return 'vllm-reranker';
  if (/unlimited.*ocr/.test(text)) return 'ocr-unlimited';
  if (/mineru/.test(text)) return 'mineru';
  if (/locate/.test(text)) return 'locate-anything';
  return '';
}

async function openCustomContainerEditor(container: ContainerRecord) {
  await loadCustomComposeProfiles();
  const profileId = profileIdForContainer(container);
  const profile = customComposeProfiles.value.find((item) => item.id === profileId);
  if (profile) {
    customModalMode.value = 'edit';
    editingProfileId.value = profile.id;
    selectCustomComposeProfile(profile);
    customName.value = profileDisplayName(profile);
    customTab.value = 'basics';
    customModalOpen.value = true;
    return;
  }
  customModalMode.value = 'edit';
  editingProfileId.value = '';
  customName.value = container.title || container.name.replace(/^custom[_-]*/, '');
  customImage.value = container.image || 'nvcr.io/nvidia/pytorch:25.04-py3';
  customComponents.value = [...(container.components ?? [])];
  customMode.value = container.management_mode || 'resident';
  customRestartPolicy.value = container.restart_policy || 'unless-stopped';
  composeYaml.value = '';
  composeValidationResult.value = null;
  customTab.value = 'basics';
  customModalOpen.value = true;
}

function openContainerMetadata(container: ContainerRecord) {
  metadataContainer.value = container;
  metadataNote.value = container.note ?? '';
  metadataSuitableModels.value = [...(container.suitable_models ?? [])];
  metadataModalOpen.value = true;
}

async function submitContainerMetadata() {
  if (!metadataContainer.value || metadataSaving.value) return;
  metadataSaving.value = true;
  try {
    await saveContainerMetadata(metadataContainer.value, metadataNote.value, metadataSuitableModels.value);
    metadataModalOpen.value = false;
  } finally {
    metadataSaving.value = false;
  }
}

function softwareVersionEntries(container: { software_versions?: Record<string, string> }) {
  return Object.entries(container.software_versions ?? {});
}

const customRuntimeCards = computed<CustomRuntimeCard[]>(() => {
  const cards: CustomRuntimeCard[] = customContainers.value.map((container) => ({
    kind: 'container',
    key: container.key,
    container
  }));
  const existingProfileIds = new Set(customContainers.value.map(profileIdForContainer).filter(Boolean));
  for (const profile of customComposeProfiles.value) {
    if (existingProfileIds.has(profile.id)) continue;
    cards.push({ kind: 'profile', key: 'profile:' + profile.id, profile, linkedContainer: containerForProfile(profile) });
  }
  return cards;
});

function customRuntimeIsShared(card: CustomRuntimeCard): boolean {
  const profile = profileForRuntimeCard(card);
  const container = profileCardContainer(card);
  const profileId = profile?.id || (container ? profileIdForContainer(container) : '');
  return profileId === 'funasr-gateway' || profileId === 'vibevoice-hf' || profileId === 'qwen3-tts';
}

function customRuntimeKindLabel(card: CustomRuntimeCard): string {
  const profile = profileForRuntimeCard(card);
  const container = profileCardContainer(card);
  const profileId = profile?.id || (container ? profileIdForContainer(container) : '');
  if (profileId === 'qwen3-tts') {
    return locale.value === 'zh-CN' ? 'AI Stack 托管语音服务' : 'AI Stack-managed speech service';
  }
  if (customRuntimeIsShared(card)) {
    return locale.value === 'zh-CN' ? '共享服务 · 自定义' : 'Shared service · Custom';
  }
  return locale.value === 'zh-CN' ? '专用发布方案 · 自定义' : 'Dedicated profile · Custom';
}

const sharedServiceCount = computed(() => customRuntimeCards.value.filter(customRuntimeIsShared).length);
const dedicatedProfileCount = computed(() => customRuntimeCards.value.length - sharedServiceCount.value);
const sharedRuntimeCards = computed(() => customRuntimeCards.value.filter(customRuntimeIsShared));
const dedicatedRuntimeCards = computed(() => customRuntimeCards.value.filter((card) => !customRuntimeIsShared(card)));
const activeCustomRuntimeCards = computed(() => runtimeTab.value === 'shared' ? sharedRuntimeCards.value : dedicatedRuntimeCards.value);

const runtimeTabs = computed(() => ([
  {
    key: 'engines' as const,
    label: locale.value === 'zh-CN' ? '推理引擎' : 'Inference Engines',
    count: runtimeContainers.value.length,
    description: locale.value === 'zh-CN' ? '管理镜像、版本、默认端口和环境验证，不启动空模型容器。' : 'Manage images, versions, default ports, and validation without starting empty model containers.'
  },
  {
    key: 'shared' as const,
    label: locale.value === 'zh-CN' ? '共享服务' : 'Shared Services',
    count: sharedServiceCount.value,
    description: locale.value === 'zh-CN' ? '管理可复用服务、适用模型和当前服务实例。' : 'Manage reusable services, suitable models, and current service instances.'
  },
  {
    key: 'dedicated' as const,
    label: locale.value === 'zh-CN' ? '专用方案' : 'Dedicated Profiles',
    count: dedicatedProfileCount.value,
    description: locale.value === 'zh-CN' ? '管理一模型一实例的专用发布模板。' : 'Manage one-model-per-instance publishing profiles.'
  }
] as const));

const activeRuntimeTab = computed(() => runtimeTabs.value.find((tab) => tab.key === runtimeTab.value) ?? runtimeTabs.value[0]);

function runtimeEngineModeSummary(container: ContainerRecord): string {
  if (container.runtime === 'pytorch') return locale.value === 'zh-CN' ? '通用环境 · 不直接发布' : 'Generic environment · Not directly published';
  return locale.value === 'zh-CN' ? '单模型独立实例' : 'Dedicated model instance';
}

function runtimeEngineSupportSummary(container: ContainerRecord): string {
  const components = (container.components ?? []).filter((item) => !['python', 'cuda'].includes(item));
  return components.length ? components.join(' + ') : (locale.value === 'zh-CN' ? '基础 CUDA 环境' : 'Base CUDA environment');
}

function customRuntimeModeSummary(card: CustomRuntimeCard): string {
  const profile = profileForRuntimeCard(card);
  const container = profileCardContainer(card);
  const profileId = profile?.id || (container ? profileIdForContainer(container) : '');
  if (profileId === 'qwen3-tts') return locale.value === 'zh-CN' ? '三模型统一托管' : 'Three-model managed service';
  return customRuntimeIsShared(card) ? (locale.value === 'zh-CN' ? '多模型复用服务' : 'Reusable multi-model service') : (locale.value === 'zh-CN' ? '单模型独立实例' : 'Dedicated model instance');
}

function customRuntimeComponentSummary(card: CustomRuntimeCard): string {
  const container = profileCardContainer(card);
  const components = (container?.components ?? []).filter((item) => !['python', 'cuda'].includes(item));
  if (components.length) return components.join(' + ');
  const profile = profileForRuntimeCard(card);
  if (profile) return customComposeProfileVersion(profile).replace(/\s+latest$/i, '');
  const image = container?.official_image || container?.image || '';
  return image ? image.split('/').pop()?.split(':')[0] || image : '-';
}

function customRuntimePortSummary(card: CustomRuntimeCard): string {
  const container = profileCardContainer(card);
  if (container?.public_port) return String(container.public_port);
  if (container?.ports) return container.ports;
  const profile = profileForRuntimeCard(card);
  const publicPort = profile?.yaml.match(/_PUBLIC_PORT:-([0-9]+)/)?.[1];
  return publicPort || '-';
}


function customRuntimeTitle(card: CustomRuntimeCard): string {
  const profile = profileForRuntimeCard(card);
  if (profile) return profileDisplayName(profile);
  return card.kind === 'profile'
    ? profileDisplayName(card.profile)
    : card.container.title;
}

function customRuntimeStatus(card: CustomRuntimeCard): string {
  const container = profileCardContainer(card);
  if (container) return runtimeUsageLabel(container);
  return locale.value === 'zh-CN' ? '未创建' : 'Not created';
}

function customRuntimeActive(card: CustomRuntimeCard): boolean {
  const container = profileCardContainer(card);
  return Boolean(container && runtimeInUse(container));
}

function isCardContainerBusy(card: CustomRuntimeCard): boolean {
  const container = profileCardContainer(card);
  return container ? isContainerBusy(container) : false;
}

function isCardContainerActionBusy(card: CustomRuntimeCard, action: string): boolean {
  const container = profileCardContainer(card);
  return container ? isContainerActionBusy(container, action) : false;
}

async function runCardContainerAction(card: CustomRuntimeCard, action: 'start' | 'stop' | 'restart') {
  const container = profileCardContainer(card);
  if (container) await runContainerAction(container, action);
}

async function openCardRuntimeLogs(card: CustomRuntimeCard) {
  const container = profileCardContainer(card);
  if (container) await openRuntimeLogs(container);
}

function deleteCustomRuntimeCardConfirm(card: CustomRuntimeCard) {
  const container = profileCardContainer(card);
  if (container) deleteCustomContainerConfirm(container);
  else if (card.kind === 'profile') deleteCustomComposeProfileConfirm(card.profile);
}


function openCustomProfileEditor(profile: CustomComposeProfile) {
  customModalMode.value = 'edit';
  editingProfileId.value = profile.id;
  selectCustomComposeProfile(profile);
  customName.value = profileDisplayName(profile);
  composeValidationResult.value = null;
  customTab.value = 'basics';
  customModalOpen.value = true;
}

</script>

<template>
  <section class="contentPanel runtime-layout">
    <HeroBanner :title="t('services')" :eyebrow="t('studioName')">
      <template #decor>
        <span class="runtimeBannerMeta">
          <span>{{ locale === "zh-CN" ? "推理引擎 " + runtimeContainers.length : "Inference engines " + runtimeContainers.length }}</span>
          <span>{{ locale === "zh-CN" ? "共享服务 " + sharedServiceCount + " · 专用方案 " + dedicatedProfileCount : "Shared services " + sharedServiceCount + " · Dedicated profiles " + dedicatedProfileCount }}</span>
        </span>
      </template>
    </HeroBanner>

    <section class="runtime-tab-shell">
      <div class="runtime-object-tabs" role="tablist" :aria-label="locale === 'zh-CN' ? '运行时类型' : 'Runtime types'">
        <button
          v-for="tab in runtimeTabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="runtimeTab === tab.key"
          :class="['runtime-object-tab', runtimeTab === tab.key ? 'is-active' : '']"
          @click="runtimeTab = tab.key"
        >
          <span>{{ tab.label }}</span>
          <b>{{ tab.count }}</b>
        </button>
      </div>
      <div class="runtime-tab-intro">
        <strong>{{ activeRuntimeTab.label }}</strong>
        <span>{{ activeRuntimeTab.description }}</span>
      </div>
    </section>

    <section v-if="runtimeTab !== 'engines'" class="runtime-container-section runtime-custom-section">
      <div class="runtime-section-head">
        <div class="runtime-section-title">
          <h2>{{ activeRuntimeTab.label }}</h2>
          <span>{{ activeCustomRuntimeCards.length }}</span>
        </div>
        <a-button class="runtime-create-button" type="primary" size="small" @click="openCustomRuntimeModal">
          <template #icon><PlusOutlined /></template>
          {{ locale === 'zh-CN' ? '新增方案' : 'New Profile' }}
        </a-button>
      </div>
      <div class="preset-container-grid runtime-custom-grid">
        <RuntimeCard
          v-for="card in activeCustomRuntimeCards"
          :key="card.key"
          :title="customRuntimeTitle(card)"
          :status="customRuntimeStatus(card)"
          :status-class="customRuntimeActive(card) ? 'is-active' : ''"
          :kind-label="customRuntimeKindLabel(card)"
        >
          <template #facts>
            <div class="runtime-fact">
              <span>{{ locale === 'zh-CN' ? '版本' : 'Version' }}</span>
              <strong>{{ card.kind === 'profile' ? customComposeProfileVersion(card.profile) : runtimeVersion(card.container) }}</strong>
            </div>
            <div class="runtime-fact">
              <span>{{ locale === 'zh-CN' ? '准备状态' : 'Readiness' }}</span>
              <div v-if="card.kind === 'container' && card.container.state === 'running'" class="runtime-ready-summary"><i class="runtime-ready-check">✓</i></div>
              <div v-else class="runtime-status-list"><small class="runtime-status-dot gold">{{ customRuntimeStatus(card) }}</small></div>
            </div>
            <div class="runtime-fact runtime-fact-detail">
              <span>{{ locale === 'zh-CN' ? '运行方式' : 'Execution Mode' }}</span>
              <strong>{{ customRuntimeModeSummary(card) }}</strong>
            </div>
            <div class="runtime-fact runtime-fact-detail">
              <span>{{ locale === 'zh-CN' ? '运行组件 / 默认端口' : 'Components / Default Port' }}</span>
              <strong :title="customRuntimeComponentSummary(card)">{{ customRuntimeComponentSummary(card) }}</strong>
              <small>{{ customRuntimePortSummary(card) }}</small>
            </div>
          </template>
          <template #actions>
            <template v-if="profileCardContainer(card)">
              <a-button v-if="profileCardContainer(card)?.state === 'running'" class="runtime-action-icon" size="small" shape="circle" danger :loading="isCardContainerActionBusy(card, 'stop')" :disabled="isCardContainerBusy(card)" @click="runCardContainerAction(card, 'stop')"><template #icon><StopOutlined /></template></a-button>
              <a-button v-else class="runtime-action-icon" size="small" shape="circle" :loading="isCardContainerActionBusy(card, 'start')" :disabled="isCardContainerBusy(card)" @click="runCardContainerAction(card, 'start')"><template #icon><PlayCircleOutlined /></template></a-button>
              <a-tooltip :title="profileImageBuilt(card) ? (locale === 'zh-CN' ? '镜像已构建' : 'Image built') : (locale === 'zh-CN' ? '仅构建镜像' : 'Build image only')">
                <a-button class="runtime-action-icon" size="small" shape="circle" :disabled="profileImageBuilt(card) || !profileForRuntimeCard(card)" @click="buildCardRuntimeImage(card)"><template #icon><CheckCircleOutlined v-if="profileImageBuilt(card)" /><DownloadOutlined v-else /></template></a-button>
              </a-tooltip>
              <a-button class="runtime-action-icon" size="small" shape="circle" :loading="isCardContainerActionBusy(card, 'logs')" :disabled="isCardContainerBusy(card)" @click="openCardRuntimeLogs(card)"><template #icon><EyeOutlined /></template></a-button>
              <a-button class="runtime-action-icon" size="small" shape="circle" :loading="isCardContainerActionBusy(card, 'restart')" :disabled="profileCardContainer(card)?.state !== 'running' || isCardContainerBusy(card)" @click="runCardContainerAction(card, 'restart')"><template #icon><ReloadOutlined /></template></a-button>
            </template>
            <template v-else>
              <a-tooltip :title="locale === 'zh-CN' ? '创建并启动运行时' : 'Create and start runtime'">
                <a-button class="runtime-action-icon" size="small" shape="circle" @click="card.kind === 'profile' && startCustomProfileRuntime(card.profile)"><template #icon><PlayCircleOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="profileImageBuilt(card) ? (locale === 'zh-CN' ? '镜像已构建' : 'Image built') : (locale === 'zh-CN' ? '仅构建镜像' : 'Build image only')">
                <a-button class="runtime-action-icon" size="small" shape="circle" :disabled="profileImageBuilt(card) || !profileForRuntimeCard(card)" @click="buildCardRuntimeImage(card)"><template #icon><CheckCircleOutlined v-if="profileImageBuilt(card)" /><DownloadOutlined v-else /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="locale === 'zh-CN' ? '创建容器后可查看日志' : 'Available after the container is created'">
                <a-button class="runtime-action-icon" size="small" shape="circle" disabled><template #icon><EyeOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="locale === 'zh-CN' ? '创建容器后可重启' : 'Available after the container is created'">
                <a-button class="runtime-action-icon" size="small" shape="circle" disabled><template #icon><ReloadOutlined /></template></a-button>
              </a-tooltip>
            </template>
            <a-popover v-if="card.kind === 'container'" trigger="click" placement="top">
              <template #content>
                <div class="runtime-detail-popover">
                  <span>{{ t('containerName') }}<b>{{ card.container.name }}</b></span>
                  <span>{{ t('image') }}<b>{{ card.container.image || '-' }}</b></span>
                  <span v-if="card.container.note">{{ locale === 'zh-CN' ? '备注' : 'Note' }}<b>{{ card.container.note }}</b></span>
                  <div v-if="card.container.suitable_models?.length" class="runtime-detail-models">
                    <span class="runtime-detail-models-label">{{ locale === 'zh-CN' ? '适用模型' : 'Suitable models' }}<i>{{ card.container.suitable_models.length }}</i></span>
                    <div class="runtime-detail-model-list">
                      <code v-for="modelId in card.container.suitable_models" :key="modelId">{{ modelId }}</code>
                    </div>
                  </div>
                  <a-button class="runtime-detail-edit-button" size="small" @click="openContainerMetadata(card.container)"><template #icon><EditOutlined /></template>{{ locale === 'zh-CN' ? '编辑说明与适用模型' : 'Edit notes and suitable models' }}</a-button>
                </div>
              </template>
              <a-button class="runtime-action-icon" size="small" shape="circle" :aria-label="locale === 'zh-CN' ? '详情' : 'Details'"><template #icon><UnorderedListOutlined /></template></a-button>
            </a-popover>
            <a-popover v-else trigger="click" placement="top">
              <template #content>
                <div class="runtime-detail-popover">
                  <span>{{ locale === 'zh-CN' ? '模板文件' : 'Profile file' }}<b>{{ card.profile.file }}</b></span>
                  <span>{{ t('image') }}<b>{{ customComposeProfileImageLabel(card.profile) }}</b></span>
                  <span>{{ locale === 'zh-CN' ? '说明' : 'Description' }}<b>{{ locale === 'zh-CN' ? card.profile.description_zh : card.profile.description }}</b></span>
                  <div v-if="card.profile.suitable_models?.length" class="runtime-detail-models">
                    <span class="runtime-detail-models-label">{{ locale === 'zh-CN' ? '适用模型' : 'Suitable models' }}<i>{{ card.profile.suitable_models.length }}</i></span>
                    <div class="runtime-detail-model-list">
                      <code v-for="modelId in card.profile.suitable_models" :key="modelId">{{ modelId }}</code>
                    </div>
                  </div>
                </div>
              </template>
              <a-button class="runtime-action-icon" size="small" shape="circle" :aria-label="locale === 'zh-CN' ? '详情' : 'Details'"><template #icon><UnorderedListOutlined /></template></a-button>
            </a-popover>
            <a-tooltip :title="locale === 'zh-CN' ? '编辑组件、Dockerfile 和运行配置' : 'Edit components, Dockerfile, and runtime config'">
              <a-button class="runtime-action-icon" size="small" shape="circle" @click="card.kind === 'profile' ? openCustomProfileEditor(card.profile) : openCustomContainerEditor(card.container)"><template #icon><SettingOutlined /></template></a-button>
            </a-tooltip>
          </template>
          <template #danger>
            <a-tooltip :title="profileCardContainer(card) ? (locale === 'zh-CN' ? '删除容器' : 'Delete container') : (locale === 'zh-CN' ? '删除自定义方案' : 'Delete custom profile')">
              <a-button class="runtime-action-icon runtime-delete-icon" size="small" shape="circle" danger @click="deleteCustomRuntimeCardConfirm(card)"><template #icon><DeleteOutlined /></template></a-button>
            </a-tooltip>
          </template>
        </RuntimeCard>
      </div>
    </section>

    <section v-else class="runtime-container-section runtime-default-section">
      <div class="runtime-section-head">
        <div class="runtime-section-title">
          <h2>{{ locale === 'zh-CN' ? '推理引擎' : 'Inference Engines' }}</h2>
          <span>{{ runtimeContainers.length }}</span>
        </div>
      </div>
      <div class="preset-container-grid">
        <RuntimeCard
          v-for="container in runtimeContainers"
          :key="container.key"
          :title="container.title"
          :status="runtimeProfileStatus(container)"
          :status-class="runtimeProfileReady(container) ? 'is-active' : ''"
          :kind-label="locale === 'zh-CN' ? '推理引擎 · 内置' : 'Inference engine · Built-in'"
        >
          <template #facts>
            <div class="runtime-fact">
              <span>{{ locale === 'zh-CN' ? '版本' : 'Version' }}</span>
              <strong>{{ runtimeVersion(container) }}</strong>
            </div>
            <div class="runtime-fact">
              <span>{{ locale === 'zh-CN' ? '准备状态' : 'Readiness' }}</span>
              <div v-if="container.test_status === 'passed'" class="runtime-ready-summary">
                <i class="runtime-ready-check">✓</i>
              </div>
              <div v-else class="runtime-status-list">
                <small :class="['runtime-status-dot', imageStatusColor(container)]">{{ imageStatusText(container) }}</small>
                <small v-if="container.image_pulled" :class="['runtime-status-dot', testStatusColor(container.test_status)]">{{ testStatusText(container.test_status) }}</small>
                <small v-else class="runtime-status-dot gold">{{ locale === 'zh-CN' ? '先拉取镜像' : 'Pull image first' }}</small>
              </div>
            </div>
            <div class="runtime-fact runtime-fact-detail">
              <span>{{ locale === 'zh-CN' ? '发布方式' : 'Publish Mode' }}</span>
              <strong>{{ runtimeEngineModeSummary(container) }}</strong>
            </div>
            <div class="runtime-fact runtime-fact-detail">
              <span>{{ locale === 'zh-CN' ? '运行组件 / 默认端口' : 'Components / Default Port' }}</span>
              <strong>{{ runtimeEngineSupportSummary(container) }}</strong>
              <small>{{ container.public_port || container.ports }}</small>
            </div>
          </template>
          <template #actions>
            <a-tooltip :title="locale === 'zh-CN' ? '拉取镜像' : 'Pull image'">
              <a-button class="runtime-action-icon" size="small" shape="circle" :loading="isContainerActionBusy(container, 'pull-image')" :disabled="container.image_pulled || isContainerBusy(container)" @click="prepareContainerImage(container)"><template #icon><DownloadOutlined /></template></a-button>
            </a-tooltip>
            <a-tooltip v-if="container.state === 'running'" :title="locale === 'zh-CN' ? '停止旧运行时容器' : 'Stop legacy runtime container'">
              <a-button class="runtime-action-icon" size="small" shape="circle" danger :loading="isContainerActionBusy(container, 'stop')" :disabled="isContainerBusy(container)" @click="runContainerAction(container, 'stop')"><template #icon><StopOutlined /></template></a-button>
            </a-tooltip>
            <a-tooltip v-else :title="locale === 'zh-CN' ? '验证环境，不会启动常驻服务' : 'Validate the environment without starting a resident service'">
              <a-button class="runtime-action-icon" size="small" shape="circle" :loading="isContainerActionBusy(container, 'test-image')" :disabled="!container.image_pulled || isContainerBusy(container)" @click="testContainerImage(container)"><template #icon><CheckCircleOutlined /></template></a-button>
            </a-tooltip>
            <a-tooltip :title="t('viewLogs')">
              <a-button class="runtime-action-icon" size="small" shape="circle" :loading="isContainerActionBusy(container, 'logs')" :disabled="container.state === 'missing' || isContainerBusy(container)" @click="openRuntimeLogs(container)"><template #icon><EyeOutlined /></template></a-button>
            </a-tooltip>
            <a-popover trigger="click" placement="top">
              <template #content>
                <div class="runtime-detail-popover">
                  <span>{{ t('containerName') }}<b>{{ container.name }}</b></span>
                  <span>{{ t('image') }}<b>{{ container.official_image || container.image || '-' }}</b></span>
                  <span v-if="softwareVersionEntries(container).length">{{ t('softwareVersions') }}<b class="runtime-version-list"><i v-for="[key, value] in softwareVersionEntries(container)" :key="key">{{ key }}: {{ value }}</i></b></span>
                </div>
              </template>
              <a-button class="runtime-action-icon" size="small" shape="circle" :aria-label="locale === 'zh-CN' ? '详情' : 'Details'"><template #icon><UnorderedListOutlined /></template></a-button>
            </a-popover>
            <a-popover trigger="click" placement="topRight">
              <template #content>
                <div class="runtime-config-popover">
                  <label><span>{{ t('publishingPort') }}</span><a-input-number v-model:value="container.public_port" :min="1024" :max="65535" size="small" /></label>
                  <label><span>{{ t('managementMode') }}</span><a-segmented v-model:value="container.management_mode" :options="[{ label: t('once'), value: 'once' }, { label: t('resident'), value: 'resident' }]" size="small" /></label>
                  <label><span>{{ t('restartPolicy') }}</span><a-select v-model:value="container.restart_policy" :options="[{label:'no', value:'no'}, {label:'unless-stopped', value:'unless-stopped'}, {label:'always', value:'always'}, {label:'on-failure', value:'on-failure'}]" size="small" /></label>
                  <div class="runtime-config-actions">
                    <a-button size="small" :loading="isContainerActionBusy(container, 'test-image')" :disabled="!container.image_pulled || isContainerBusy(container)" @click="testContainerImage(container)">{{ locale === 'zh-CN' ? '验证环境' : 'Validate' }}</a-button>
                    <a-button size="small" :loading="isContainerActionBusy(container, 'restart')" :disabled="container.state !== 'running' || isContainerBusy(container)" @click="runContainerAction(container, 'restart')"><template #icon><ReloadOutlined /></template>{{ t('restart') }}</a-button>
                    <a-button type="primary" size="small" @click="saveContainerConfig(container)">{{ t('saveConfig') }}</a-button>
                    <a-button danger size="small" :loading="isContainerActionBusy(container, 'delete')" :disabled="isContainerBusy(container)" @click="deleteContainerConfirm(container)"><template #icon><DeleteOutlined /></template></a-button>
                  </div>
                </div>
              </template>
              <a-button class="runtime-action-icon" size="small" shape="circle"><template #icon><SettingOutlined /></template></a-button>
            </a-popover>
          </template>
        </RuntimeCard>
      </div>
    </section>

    <a-modal
      v-model:open="metadataModalOpen"
      :title="locale === 'zh-CN' ? '容器说明' : 'Container notes'"
      :ok-text="locale === 'zh-CN' ? '保存' : 'Save'"
      :cancel-text="locale === 'zh-CN' ? '取消' : 'Cancel'"
      :confirm-loading="metadataSaving"
      @ok="submitContainerMetadata"
    >
      <div class="runtime-metadata-form">
        <label>
          <span>{{ locale === 'zh-CN' ? '备注' : 'Note' }}</span>
          <a-textarea v-model:value="metadataNote" :rows="3" :maxlength="500" />
        </label>
        <label>
          <span>{{ locale === 'zh-CN' ? '适用模型' : 'Suitable models' }}</span>
          <a-select
            v-model:value="metadataSuitableModels"
            mode="tags"
            style="width: 100%"
            :options="models.map((model) => ({ label: model.display_name, value: model.id }))"
            :placeholder="locale === 'zh-CN' ? '选择模型，也可以输入模型 ID' : 'Select models or enter a model ID'"
          />
        </label>
        <small>{{ locale === 'zh-CN' ? '此处只保存用途说明，不会创建、重建或修改 Docker 容器。' : 'This only saves usage notes. It does not create, rebuild, or modify the Docker container.' }}</small>
      </div>
    </a-modal>

    <CustomContainerModal :open="customModalOpen" :mode="customModalMode" :editing-profile-id="editingProfileId" @close="customModalOpen = false" />
    <a-drawer
      v-model:open="runtimeLogDrawerOpen"
      class="runtime-log-drawer"
      placement="bottom"
      :height="'42vh'"
      :mask-closable="true"
      :destroy-on-close="false"
      :title="t('viewLogs') + (selectedLogContainer ? ' · ' + selectedLogContainer : '')"
    >
      <pre class="runtime-log-drawer-block">{{ containerLog || (locale === 'zh-CN' ? '暂无日志输出。' : 'No logs yet.') }}</pre>
    </a-drawer>
  </section>
</template>
