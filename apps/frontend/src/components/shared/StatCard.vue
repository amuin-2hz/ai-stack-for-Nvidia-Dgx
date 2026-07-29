<!--
  @author Amuin
  @created 2026-06-25
  @description 可复用的统计卡片组件，展示标签与数值。
               Reusable stat card component displaying a label and value.
-->
<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
}>();
</script>

<template>
  <div class="statCard">
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
  </div>
</template>
