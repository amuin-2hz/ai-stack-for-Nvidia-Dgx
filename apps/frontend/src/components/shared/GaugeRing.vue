<!--
  @author Amuin
  @created 2026-06-25
  @description 可复用 SVG 环形仪表盘组件，用于展示 CPU / 内存 / 存储 / GPU 等百分比指标。
               Reusable SVG gauge ring component for displaying percentage metrics.
-->
<script setup lang="ts">
/**
 * Props:
 * - percent: 百分比数值 (0–100)
 * - size: 环形尺寸，默认 80px
 * - strokeWidth: 描边宽度，默认 6
 */
defineProps<{
  percent: number;
  size?: number;
  strokeWidth?: number;
}>();

/** 计算 SVG stroke-dashoffset：总周长 263.89 (r=42 时 2*π*42 ≈ 263.89) */
function dashOffset(percent: number): number {
  const circumference = 263.89;
  const clamped = Math.min(100, Math.max(0, percent));
  return circumference * (1 - clamped / 100);
}
</script>

<template>
  <div class="gauge-ring" :style="{ width: (size || 80) + 'px', height: (size || 80) + 'px' }">
    <svg viewBox="0 0 100 100">
      <circle class="gauge-bg" cx="50" cy="50" r="42" />
      <circle
        class="gauge-fill"
        cx="50"
        cy="50"
        r="42"
        :stroke-width="strokeWidth || 6"
        stroke-dasharray="263.89"
        :stroke-dashoffset="dashOffset(percent)"
      />
    </svg>
    <div class="gauge-inner">
      <slot>
        <strong style="font-size:.85rem">{{ Math.round(percent) }}%</strong>
      </slot>
    </div>
  </div>
</template>
