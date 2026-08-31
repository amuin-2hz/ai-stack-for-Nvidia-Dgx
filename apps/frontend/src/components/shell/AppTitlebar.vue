<!--
  @author Amuin
  @created 2026-06-25
  @description 应用标题栏：品牌 Logo、应用名称与窗口操作装饰按钮。
               App titlebar: brand logo, app name, and window control decorations.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { themeMode } from '../../composables/useApp';

const isDark = computed(() => themeMode.value === 'dark');
const brandImage = computed(() => `./brand/${isDark.value ? 'amuin-light.png' : 'logo-au.png'}`);
</script>

<template>
  <header class="shell-titlebar">
    <div></div>
    <div class="shell-titlegroup">
      <img :src="brandImage" alt="" />
      <strong>Amuin AI Stack</strong>
    </div>
    <div class="shell-window-actions">
      <span>─</span>
      <span>□</span>
      <span>✕</span>
    </div>
  </header>
</template>
