<script setup lang="ts">
defineProps<{
  title: string;
  status: string;
  statusClass?: string;
  titleAttr?: string;
  kindLabel?: string;
}>();
</script>

<template>
  <article class="runtime-card" :title="titleAttr">
    <div class="runtime-card-head">
      <div class="runtime-card-title-group">
        <small v-if="kindLabel" class="runtime-card-kicker">{{ kindLabel }}</small>
        <h2>{{ title }}</h2>
      </div>
      <span :class="['runtime-usage-pill', statusClass]">{{ status }}</span>
    </div>
    <div class="runtime-card-facts">
      <slot name="facts" />
    </div>
    <div class="runtime-card-actions runtime-card-actions-split">
      <span class="runtime-card-action-group">
        <slot name="actions" />
      </span>
      <slot name="danger" />
    </div>
  </article>
</template>
