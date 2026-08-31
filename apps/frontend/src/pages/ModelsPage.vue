<!--
  @author Amuin
  @created 2026-06-25
  @description 模型库页面：侧栏导航、模型表格（筛选/排序）、详情面板与下载弹窗。
               Models page: sidebar nav, model table with filter/sort, detail panel, and download modal.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { DeleteOutlined, DownloadOutlined, FolderOpenOutlined, RocketOutlined } from '@ant-design/icons-vue';
import {
  locale, t, formatBytes, modelFormatLabel, shortModelPath,
  statusText, badgeColor, openModelFolder, deleteLocalModel, canDeleteModel,
  compatibilityRows, runtimeHintColor, modelStatusHelp,
  rightPanelCollapsed
} from '../composables/useApp';
import {
  librarySearch, activeLibraryModelId, visibleModelLibraryList, filteredModelLibraryList, activeLibraryModel,
  modelArchitecture, modelParameterScale, modelQuantization,
  modelCapabilities, publishModelFromCatalog, libraryCategory
} from '../composables/useModels';
import ModelDownloadModal from '../components/model/ModelDownloadModal.vue';
import HeroBanner from '../components/shared/HeroBanner.vue';

const modelDownloadModalOpen = ref(false);

const libraryCapabilityOptions = computed(() => [
  { value: 'Chat', label: 'Chat' },
  { value: 'Vision', label: locale.value === 'zh-CN' ? '视觉 / OCR' : 'Vision / OCR' },
  { value: 'Embedding', label: 'Embedding' },
  { value: 'Reranker', label: 'Reranker' },
  { value: 'ASR', label: 'ASR' },
  { value: 'TTS', label: 'TTS' },
  { value: 'Speaker Verification', label: locale.value === 'zh-CN' ? '声纹验证' : 'Speaker Verification' },
  { value: 'Diarization', label: locale.value === 'zh-CN' ? '说话人分离' : 'Diarization' }
]);

const compatibleRuntimeRows = computed(() =>
  activeLibraryModel.value ? compatibilityRows(activeLibraryModel.value).filter((item) => item.info.status === 'compatible') : []
);

function hasDetailValue(value: string) {
  const text = value.trim();
  return Boolean(text && text !== '-' && text !== '0 B');
}

const activeModelDetailRows = computed(() => {
  const model = activeLibraryModel.value;
  if (!model) return [];
  return [
    { label: locale.value === 'zh-CN' ? '路径' : 'Path', value: shortModelPath(model.local.path) },
    { label: locale.value === 'zh-CN' ? '大小' : 'Size', value: model.local.size_bytes ? formatBytes(model.local.size_bytes) : '' },
    { label: locale.value === 'zh-CN' ? '状态' : 'Status', value: statusText(model.status.download) },
    { label: locale.value === 'zh-CN' ? '能力' : 'Capabilities', value: modelCapabilities(model).join(', ') }
  ].filter((row) => hasDetailValue(row.value));
});

const activeRuntimeDetailRows = computed(() => {
  const model = activeLibraryModel.value;
  if (!model) return [];
  return [
    { label: locale.value === 'zh-CN' ? '推荐运行时' : 'Recommended', value: model.runtime.preferred || '' },
    { label: locale.value === 'zh-CN' ? '当前域' : 'Domain', value: modelCapabilities(model)[0] || '' }
  ].filter((row) => hasDetailValue(row.value));
});

const activeRuntimeNote = computed(() => {
  const model = activeLibraryModel.value;
  if (!model) return '';
  const statusHelp = modelStatusHelp(model);
  if (statusHelp) return statusHelp;
  const issue = model.audit?.issues?.find((item) => item.severity === 'error') ?? model.audit?.issues?.[0];
  if (issue?.message) return issue.message;
  const memory = model.audit?.gpu_memory;
  if (memory && ['tight', 'insufficient'].includes(memory.status)) return memory.reason;
  return '';
});

const modelStorageBytes = computed(() =>
  visibleModelLibraryList.value.reduce((total, m) => total + (m.local.size_bytes || 0), 0)
);

const modelRootHint = computed(() => {
  const modelPath = visibleModelLibraryList.value.find((m) => m.local.path)?.local.path || '';
  if (!modelPath) return locale.value === 'zh-CN' ? '尚未发现本地模型' : 'No local models discovered yet';
  const marker = '/models/';
  const index = modelPath.indexOf(marker);
  if (index >= 0) return modelPath.slice(0, index + marker.length - 1);
  const parts = modelPath.split('/').filter(Boolean);
  if (parts.length <= 1) return modelPath;
  return (modelPath.startsWith('/') ? '/' : '') + parts.slice(0, -1).join('/');
});

function modelTableRow(record: any) {
  return {
    onClick: () => {
      activeLibraryModelId.value = record.id;
    }
  };
}
</script>

<template>
  <section :class="['contentPanel', 'model-library-workspace', rightPanelCollapsed ? 'right-panel-collapsed' : '']">
    <!-- 左侧导航 -->
    <aside class="librarySidebar">
      <div class="librarySidebarHeader">
        <span>{{ t('studioName') }}</span>
        <h1>{{ locale === 'zh-CN' ? '我的模型' : 'My Models' }}</h1>
        <p>{{ locale === 'zh-CN' ? '将本地模型按用途归类查看，快速切换聊天、发布与加载场景。' : 'Browse local models by category and quickly switch between chat, publish, and load scenarios.' }}</p>
      </div>
      <div class="libraryNavGroup">
        <button type="button" :class="['libraryCategoryButton', libraryCategory === 'all' ? 'isActive' : '']" @click="libraryCategory = 'all'">
          <span>{{ locale === 'zh-CN' ? '全部模型' : 'All Models' }}</span>
          <strong>{{ visibleModelLibraryList.length }}</strong>
        </button>
        <button v-for="cap in libraryCapabilityOptions" :key="cap.value" type="button" :class="['libraryCategoryButton', libraryCategory === cap.value ? 'isActive' : '']" @click="libraryCategory = cap.value">
          <span>{{ cap.label }}</span>
          <strong>{{ visibleModelLibraryList.filter((m) => modelCapabilities(m).includes(cap.value)).length }}</strong>
        </button>
      </div>
      <div class="librarySidebarFooter">
        <div class="librarySidebarSync">
          <span>{{ locale === 'zh-CN' ? '已同步本地模型目录' : 'Local model directory synced' }}</span>
          <strong>{{ visibleModelLibraryList.length }}</strong>
          <small>{{ formatBytes(modelStorageBytes) }}</small>
        </div>
      </div>
    </aside>

    <!-- 主面板：工具栏 + 表格 -->
    <div class="models-main-col libraryMainPanel">
      <HeroBanner
        class="libraryBanner"
        :eyebrow="locale === 'zh-CN' ? '模型库' : 'MODEL LIBRARY'"
        :title="locale === 'zh-CN' ? '模型库' : 'Model Library'"
        :desc="locale === 'zh-CN' ? '管理本地模型与运行建议。' : 'Manage local models and runtime guidance.'"
      >
        <template #decor>
          <a-button class="libraryDownloadButton" type="primary" @click="modelDownloadModalOpen = true">
            <template #icon><DownloadOutlined /></template>
            {{ locale === 'zh-CN' ? '添加下载任务' : 'Add Download' }}
          </a-button>
        </template>
      </HeroBanner>

      <header class="libraryToolbar">
        <div class="libraryToolbarTitleGroup">
          <strong>{{ locale === 'zh-CN' ? '模型清单' : 'Model List' }}</strong>
          <span>{{ locale === 'zh-CN' ? `当前显示 ${filteredModelLibraryList.length} / 共 ${visibleModelLibraryList.length} 个模型` : `Showing ${filteredModelLibraryList.length} of ${visibleModelLibraryList.length} models` }}</span>
        </div>
        <div class="libraryToolbarActions">
          <label class="librarySearchField">
            <span class="librarySearchIcon">⌕</span>
            <input v-model="librarySearch" type="text" :placeholder="locale === 'zh-CN' ? '筛选模型...' : 'Filter models...'" />
          </label>
        </div>
      </header>

      <a-table
        :data-source="filteredModelLibraryList"
        :pagination="false" size="small" row-key="id"
        class="model-library-table"
        :scroll="{ y: 'calc(100vh - 304px)' }"
        :custom-row="modelTableRow"
        :row-class-name="(r: any) => activeLibraryModel?.id === r.id ? 'selected-library-model' : ''"
      >
        <template #empty>
          <a-empty :description="locale === 'zh-CN' ? '还没有本地模型' : 'No local models yet'">
            <a-button type="primary" @click="modelDownloadModalOpen = true">
              <template #icon><DownloadOutlined /></template>
              {{ locale === 'zh-CN' ? '添加下载任务' : 'Add Download' }}
            </a-button>
          </a-empty>
        </template>
        <a-table-column :title="locale === 'zh-CN' ? '模型ID' : 'Model ID'" key="model" :width="190">
          <template #default="{ record }">
            <div class="table-model-cell">
              <span class="table-model-name">{{ record.id }}</span>
              <span class="table-model-path">{{ shortModelPath(record.local.path) }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column :title="locale === 'zh-CN' ? '框架' : 'Framework'" key="architecture" :width="78">
          <template #default="{ record }"><span class="table-mono-chip">{{ modelArchitecture(record) }}</span></template>
        </a-table-column>
        <a-table-column :title="locale === 'zh-CN' ? '参数量' : 'Params'" key="params" :width="60">
          <template #default="{ record }"><span class="table-compact-text">{{ modelParameterScale(record) }}</span></template>
        </a-table-column>
        <a-table-column :title="locale === 'zh-CN' ? '量化规格' : 'Quantization'" key="quantization" :width="76">
          <template #default="{ record }"><span class="table-mono-chip">{{ modelQuantization(record) }}</span></template>
        </a-table-column>
        <a-table-column :title="t('size')" key="size" :width="68">
          <template #default="{ record }"><span style="font-size:.8rem">{{ formatBytes(record.local.size_bytes) }}</span></template>
        </a-table-column>
        <a-table-column :title="locale === 'zh-CN' ? '状态' : 'Status'" key="status" :width="70">
          <template #default="{ record }"><a-tag :color="badgeColor(record.status.download)">{{ statusText(record.status.download) }}</a-tag></template>
        </a-table-column>
        <a-table-column key="actions" :width="78">
          <template #default="{ record }">
            <a-space :size="4">
              <a-button size="small" @click="openModelFolder(record)"><template #icon><FolderOpenOutlined /></template></a-button>
              <a-button size="small" type="primary" :disabled="record.status.download !== 'ready'" @click="publishModelFromCatalog(record)"><template #icon><RocketOutlined /></template></a-button>
              <a-button size="small" danger :disabled="!canDeleteModel(record)" @click="deleteLocalModel(record)"><template #icon><DeleteOutlined /></template></a-button>
            </a-space>
          </template>
        </a-table-column>
      </a-table>

      <div class="model-library-footer">
        <span>{{ locale === 'zh-CN' ? '已显示' : 'Showing' }} <b>{{ filteredModelLibraryList.length }}</b> / <b>{{ visibleModelLibraryList.length }}</b> {{ locale === 'zh-CN' ? '个模型' : 'models' }}</span>
        <span>{{ locale === 'zh-CN' ? '磁盘占用' : 'Disk usage' }} <b>{{ formatBytes(modelStorageBytes) }}</b></span>
        <span>{{ locale === 'zh-CN' ? '模型目录' : 'Model root' }} <b>{{ modelRootHint }}</b></span>
      </div>
    </div>

    <!-- 详情面板 -->
    <aside v-show="!rightPanelCollapsed" class="models-log-col modelDetailPanel">
      <template v-if="activeLibraryModel">
        <!-- 区域1：模型基本信息 -->
        <div class="modelDetailSection">
          <div class="modelDetailSectionHead">
            <h3>{{ activeLibraryModel.display_name }}</h3>
            <span class="modelDetailBadge">{{ modelFormatLabel(activeLibraryModel.local.format) }}</span>
          </div>
          <div class="modelDetailKv">
            <div v-for="row in activeModelDetailRows" :key="row.label" class="modelDetailKvRow">
              <span>{{ row.label }}</span>
              <strong :title="row.value">{{ row.value }}</strong>
            </div>
          </div>
          <div class="modelDetailActions">
            <a-button size="small" type="primary" :disabled="activeLibraryModel.status.download !== 'ready'" @click="publishModelFromCatalog(activeLibraryModel)">{{ locale === 'zh-CN' ? '加载模型' : 'Load Model' }}</a-button>
            <a-button size="small" @click="openModelFolder(activeLibraryModel)">{{ locale === 'zh-CN' ? '打开目录' : 'Open Folder' }}</a-button>
          </div>
        </div>
        <!-- 区域2：运行建议 -->
        <div class="modelDetailSection">
          <div class="modelDetailSectionHead">
            <h3>{{ locale === 'zh-CN' ? '运行建议' : 'Runtime Guidance' }}</h3>
          </div>
          <div v-if="activeRuntimeDetailRows.length" class="modelDetailKv">
            <div v-for="row in activeRuntimeDetailRows" :key="row.label" class="modelDetailKvRow">
              <span>{{ row.label }}</span>
              <strong :title="row.value">{{ row.value }}</strong>
            </div>
          </div>
          <a-space wrap style="margin-top:8px">
            <a-tag v-for="item in compatibleRuntimeRows" :key="item.service" :color="runtimeHintColor(item.info.status)">
              {{ item.service }} · {{ statusText(item.info.status) }}
            </a-tag>
            <span v-if="!compatibleRuntimeRows.length" class="modelDetailEmptyInline">{{ locale === 'zh-CN' ? '暂无兼容运行时' : 'No compatible runtimes' }}</span>
          </a-space>
          <p v-if="activeRuntimeNote" class="modelDetailNote">
            {{ activeRuntimeNote }}
          </p>
        </div>
      </template>
      <template v-else>
        <div class="modelDetailSection">
          <div class="modelDetailSectionHead">
            <h3>{{ locale === 'zh-CN' ? '模型详情' : 'Model Details' }}</h3>
          </div>
          <p class="modelDetailNote">{{ locale === 'zh-CN' ? '从左侧表格中选择一个模型后，这里会显示模型信息和推荐运行时。' : 'Select a model from the table to preview metadata and recommended runtime.' }}</p>
        </div>
      </template>
    </aside>

    <!-- 下载弹窗 -->
    <ModelDownloadModal :open="modelDownloadModalOpen" @close="modelDownloadModalOpen = false" />
  </section>
</template>
