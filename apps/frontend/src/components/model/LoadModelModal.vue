<!--
  @author Amuin
  @created 2026-06-25
  @description 模型选择弹窗：搜索、排序并选择要加载的模型。
               Model selection modal: search, sort, and select a model to load.
-->
<script setup lang="ts">
import { computed } from 'vue';
import {
  locale, t, formatBytes, modelFormatLabel, shortModelPath, badgeColor, statusText
} from '../../composables/useApp';
import {
  loadModelModalOpen, loadModelSearch, loadModelSort,
  loadModelCandidateList, selectModelFromModal
} from '../../composables/useLoad';

const props = defineProps<{
  open: boolean;
  selectedDeployModel: any;
}>();

const emit = defineEmits<{
  close: [];
  select: [model: any];
}>();

/** 双向绑定兼容：使用 computed get/set 包装 prop */
const localOpen = computed({
  get: () => props.open,
  set: (val) => { if (!val) emit('close'); }
});

function onSelect(model: any) {
  selectModelFromModal(model);
  emit('select', model);
}
</script>

<template>
  <a-modal
    v-model:open="localOpen"
    :title="locale === 'zh-CN' ? '选择模型' : 'Select Model'"
    :width="720"
    :footer="null"
    @cancel="emit('close')"
  >
    <a-input
      v-model:value="loadModelSearch"
      allow-clear
      :placeholder="locale === 'zh-CN' ? '搜索模型名称、路径或格式...' : 'Search model name, path, or format...'"
      style="margin-bottom:12px"
    />

    <div
      v-if="selectedDeployModel"
      class="load-model-current"
    >
      <b>
        {{ locale === 'zh-CN' ? '当前已选择' : 'Currently Selected' }}
      </b>
      <span class="load-model-current-tag">{{ selectedDeployModel.display_name }}</span>
    </div>

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="color:#63798a;font-size:.78rem;font-weight:650">
        {{ locale === 'zh-CN' ? '排序' : 'Sort' }}
      </span>
      <a-segmented
        v-model:value="loadModelSort"
        :options="[
          { label: locale === 'zh-CN' ? '最近' : 'Recency', value: 'recency' },
          { label: t('size'), value: 'size' },
          { label: locale === 'zh-CN' ? '已下载' : 'Downloaded', value: 'downloaded' }
        ]"
        size="small"
      />
    </div>

    <a-table
      :data-source="loadModelCandidateList"
      :pagination="false"
      size="small"
      row-key="id"
      :scroll="{ y: 360 }"
    >
      <template #empty>
        <a-empty :description="locale === 'zh-CN' ? '没有匹配的模型' : 'No matching models'" />
      </template>
      <a-table-column title="Model" key="model" :width="200">
        <template #default="{ record }">
          <div style="display:grid;gap:2px">
            <span style="font-weight:650;font-size:.84rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {{ record.display_name }}
            </span>
            <span style="font-size:.7rem;color:#63798a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono)">
              {{ shortModelPath(record.local.path) }}
            </span>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="Status" key="status" :width="80">
        <template #default="{ record }">
          <a-tag :color="badgeColor(record.status.download)">
            {{ statusText(record.status.download) }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column :title="t('format')" key="format" :width="90">
        <template #default="{ record }">
          <span style="font-family:var(--font-mono);font-size:.76rem">
            {{ modelFormatLabel(record.local.format) }}
          </span>
        </template>
      </a-table-column>
      <a-table-column :title="t('size')" key="size" :width="90">
        <template #default="{ record }">
          {{ formatBytes(record.local.size_bytes) }}
        </template>
      </a-table-column>
      <a-table-column key="select" :width="70">
        <template #default="{ record }">
          <a-button size="small" type="primary" @click="onSelect(record)">
            {{ locale === 'zh-CN' ? '选择' : 'Select' }}
          </a-button>
        </template>
      </a-table-column>
    </a-table>
  </a-modal>
</template>
