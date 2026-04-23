<template>
  <div class="layout">
    <Sidebar />
    <main class="main-shell" :class="{ collapsed: isCollapsed }">
      <div class="main-content workspace-panel">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <keep-alive include="SymbolsView">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </div>
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

.main-shell {
  flex: 1;
  min-height: 100vh;
  margin-left: 228px;
  padding: 18px 18px 18px 0;
  position: relative;
  z-index: 2;
  transition: margin-left 0.24s ease, padding 0.24s ease;
}

.main-shell.collapsed {
  margin-left: 52px;
}

.main-content {
  min-height: calc(100vh - 36px);
  overflow: hidden;
}
</style>
