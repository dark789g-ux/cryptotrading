<template>
  <div class="layout">
    <Sidebar />
    <main class="main-content" :class="{ collapsed: isCollapsed }">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import Sidebar from './Sidebar.vue'

// 监听侧边栏折叠状态
const isCollapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')

// 监听 storage 变化
window.addEventListener('storage', (e) => {
  if (e.key === 'sidebar-collapsed') {
    isCollapsed.value = e.newValue === 'true'
  }
})
</script>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}

.main-content {
  flex: 1;
  margin-left: 220px;
  padding: 24px;
  min-height: 100vh;
  transition: margin-left 0.2s ease;
}

.main-content.collapsed {
  margin-left: 64px;
}
</style>
