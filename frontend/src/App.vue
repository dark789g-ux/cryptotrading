<template>
  <div class="app-layout">
    <Sidebar :collapsed="sidebarCollapsed" @toggle="sidebarCollapsed = !sidebarCollapsed" />
    <main class="main-content" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
      <RouterView />
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import Sidebar from './components/layout/Sidebar.vue'

const sidebarCollapsed = ref(false)
</script>

<style>
.app-layout {
  display: flex;
  min-height: 100vh;
  background: var(--color-bg);
}
.main-content {
  flex: 1;
  margin-left: var(--sidebar-width);
  transition: margin-left var(--transition);
  min-width: 0;
  overflow: hidden;
}
.main-content.sidebar-collapsed {
  margin-left: var(--sidebar-collapsed-width);
}
</style>
