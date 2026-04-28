<template>
  <div class="layout">
    <Sidebar />
    <main class="main-shell" :class="{ collapsed: isCollapsed }">
      <div class="main-content workspace-panel">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <keep-alive :key="auth.authVersion.value" include="SymbolsView">
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
import { useAuth } from '../../composables/hooks/useAuth'
import { useSidebarCollapsed } from '../../composables/hooks/useSidebarCollapsed'

const { isCollapsed } = useSidebarCollapsed()
const auth = useAuth()
</script>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
  background: #181a20;
}

.main-shell {
  flex: 1;
  min-height: 100vh;
  margin-left: 228px;
  padding: 16px 16px 16px 0;
  position: relative;
  z-index: 2;
  transition: margin-left 0.26s cubic-bezier(0.4, 0, 0.2, 1), padding 0.26s cubic-bezier(0.4, 0, 0.2, 1);
}

.main-shell.collapsed {
  margin-left: 52px;
}

.main-content {
  height: calc(100vh - 32px);
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
</style>
