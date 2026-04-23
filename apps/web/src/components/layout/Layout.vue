<template>
  <div class="layout">
    <Sidebar />
    <main class="main-content" :class="{ collapsed: isCollapsed }">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <keep-alive include="SymbolsView">
            <component :is="Component" />
          </keep-alive>
        </transition>
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import Sidebar from './Sidebar.vue'
import { useSidebarCollapsed } from '../../composables/useSidebarCollapsed'

const { isCollapsed } = useSidebarCollapsed()
</script>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}
.main-content {
  flex: 1;
  margin-left: 256px;
  padding: 32px;
  min-height: 100vh;
  /* 主工作区比侧栏略抬升（Dark Card 面），形成分层，不用渐变 */
  background: var(--color-surface-elevated);
  transition: margin-left 0.2s ease;
}
.main-content.collapsed {
  margin-left: 64px;
}
</style>
