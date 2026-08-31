<!--
  @author Amuin
  @created 2026-06-25
  @description 应用根组件 — 组装 Shell 布局并按 view 状态路由到各页面。
               Root component — assembles the shell layout and routes to pages by view state.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { theme as antdTheme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import enUS from 'ant-design-vue/es/locale/en_US';
import { locale, themeMode, view, sidebarCollapsed } from './composables/useApp';
import { useLifecycle } from './composables/useLifecycle';

// ── Shell 组件 ──────────────────────────────────────────────────────────
import AppTitlebar from './components/shell/AppTitlebar.vue';
import AppToolbar from './components/shell/AppToolbar.vue';
import AppSidebar from './components/shell/AppSidebar.vue';

// ── 页面组件 ────────────────────────────────────────────────────────────
import DashboardPage from './pages/DashboardPage.vue';
import SystemPage from './pages/SystemPage.vue';
import ModelsPage from './pages/ModelsPage.vue';
import ServicesPage from './pages/ServicesPage.vue';
import DeployPage from './pages/DeployPage.vue';
import LoadPage from './pages/LoadPage.vue';
import RunningPage from './pages/RunningPage.vue';
import PlaygroundPage from './pages/PlaygroundPage.vue';
import TasksPage from './pages/TasksPage.vue';
import SettingsPage from './pages/SettingsPage.vue';

/** Ant Design 国际化 locale */
const antLocale = computed(() => locale.value === 'zh-CN' ? zhCN : enUS);

/** 当前是否为深色主题 */
const isDark = computed(() => themeMode.value === 'dark');

/** Ant Design 主题配置（深色/浅色算法 + 品牌色） */
const antTheme = computed(() => ({
  algorithm: isDark.value ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
  token: { colorPrimary: '#0aa7d8', borderRadius: 6 }
}));

/** 注册应用生命周期（轮询刷新 + 侧边栏响应式折叠） */
useLifecycle();
</script>

<template>
  <a-config-provider :locale="antLocale" :theme="antTheme">
    <div :class="['desktop-shell', isDark ? 'theme-dark' : 'theme-light']">
      <AppTitlebar />
      <AppToolbar />
      <main :class="['app-shell', sidebarCollapsed ? 'sidebar-collapsed' : '']">
        <AppSidebar />
        <section class="workspace">
          <DashboardPage v-if="view === 'dashboard'" />
          <SystemPage v-if="view === 'system'" />
          <ModelsPage v-if="view === 'models'" />
          <ServicesPage v-if="view === 'services'" />
          <DeployPage v-if="view === 'deploy'" />
          <LoadPage v-if="view === 'load'" />
          <RunningPage v-if="view === 'running'" />
          <PlaygroundPage v-if="view === 'playground'" />
          <TasksPage v-if="view === 'tasks'" />
          <SettingsPage v-if="view === 'settings'" />
        </section>
      </main>
    </div>
  </a-config-provider>
</template>
