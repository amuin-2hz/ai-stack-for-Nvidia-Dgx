<!--
  @author Amuin
  @created 2026-06-25
  @description 应用侧边栏导航：品牌标志、主导航菜单与页脚信息。
               App sidebar: brand logo, main navigation menu, and footer.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { locale, t, themeMode, view, sidebarCollapsed } from '../../composables/useApp';

const isDark = computed(() => themeMode.value === 'dark');
const brandImage = computed(() => `./brand/${isDark.value ? 'amuin-light.png' : 'logo-au.png'}`);
</script>

<template>
  <aside :class="['sidebar', 'sideNav', sidebarCollapsed ? 'isCollapsed' : 'isExpanded']">
    <div class="sideNavHeader">
      <span class="sideNavMiniLogo"><img :src="brandImage" alt="" /></span>
      <div class="sideNavHeaderText">
        <strong>{{ t('workstation') }}</strong>
        <span>{{ t('studioName') }}</span>
      </div>
      <span class="sideNavVersion">v1.1.1 · 2026.08</span>
    </div>
    <nav class="sideNavMenu" aria-label="主菜单">
      <button :class="['sideNavItem', view === 'dashboard' ? 'isActive' : '']" type="button" @click="view = 'dashboard'">
        <span class="sideNavIcon dashboard"></span>
        <span class="sideNavLabel">{{ t('dashboard') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'playground' ? 'isActive' : '']" type="button" @click="view = 'playground'">
        <span class="sideNavIcon modelTest"></span>
        <span class="sideNavLabel">{{ t('playground') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'load' ? 'isActive' : '']" type="button" @click="view = 'load'">
        <span class="sideNavIcon modelPublish"></span>
        <span class="sideNavLabel">{{ t('load') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'models' ? 'isActive' : '']" type="button" @click="view = 'models'">
        <span class="sideNavIcon modelLibrary"></span>
        <span class="sideNavLabel">{{ t('models') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'services' ? 'isActive' : '']" type="button" @click="view = 'services'">
        <span class="sideNavIcon runtime"></span>
        <span class="sideNavLabel">{{ t('services') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'system' ? 'isActive' : '']" type="button" @click="view = 'system'">
        <span class="sideNavIcon systemStatus"></span>
        <span class="sideNavLabel">{{ t('system') }}</span>
      </button>
      <button :class="['sideNavItem', view === 'tasks' ? 'isActive' : '']" type="button" @click="view = 'tasks'">
        <span class="sideNavIcon tasks"></span>
        <span class="sideNavLabel">{{ t('tasks') }}</span>
      </button>
    </nav>
    <div class="sideNavFooter">
      <button :class="['sideNavItem', 'sideNavFooterItem', view === 'settings' ? 'isActive' : '']" type="button" @click="view = 'settings'">
        <span class="sideNavIcon settings"></span>
        <span class="sideNavLabel">{{ t('settings') }}</span>
      </button>
    </div>
  </aside>
</template>
