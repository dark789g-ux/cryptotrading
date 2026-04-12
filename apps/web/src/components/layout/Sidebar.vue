<template>
  <div class="sidebar" :class="{ collapsed: isCollapsed }">
    <div class="logo-section">
      <div class="logo">
        <span class="logo-icon">📊</span>
        <span v-show="!isCollapsed" class="logo-text">CryptoTrading</span>
      </div>
      <n-button quaternary circle class="collapse-btn" @click="toggleCollapse">
        <template #icon>
          <n-icon>
            <chevron-back v-if="!isCollapsed" />
            <chevron-forward v-else />
          </n-icon>
        </template>
      </n-button>
    </div>

    <div class="menu-section">
      <n-menu
        :collapsed="isCollapsed"
        :collapsed-width="64"
        :options="menuOptions"
        :value="activeKey"
        @update:value="handleMenuSelect"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NButton, NIcon } from 'naive-ui'
import {
  ChevronBack, ChevronForward,
  TrendingUpOutline, ListOutline, SyncOutline, BookmarkOutline, SettingsOutline,
} from '@vicons/ionicons5'

const route = useRoute()
const router = useRouter()

const isCollapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  localStorage.setItem('sidebar-collapsed', String(isCollapsed.value))
}

const activeKey = computed(() => route.name as string)

const renderIcon = (icon: any) => () => h(NIcon, null, { default: () => h(icon) })

const menuOptions = [
  { label: '回测', key: 'backtest', icon: renderIcon(TrendingUpOutline) },
  { label: '标的', key: 'symbols', icon: renderIcon(ListOutline) },
  { label: '同步', key: 'sync', icon: renderIcon(SyncOutline) },
  { label: '自选列表', key: 'watchlists', icon: renderIcon(BookmarkOutline) },
  { label: '设置', key: 'settings', icon: renderIcon(SettingsOutline) },
]

const handleMenuSelect = (key: string) => {
  router.push({ name: key })
}
</script>

<style scoped>
.sidebar {
  height: 100vh;
  width: 256px;
  display: flex;
  flex-direction: column;
  position: fixed;
  left: 0;
  top: 0;
  z-index: 100;
  background: var(--ember-bg);
  border-right: 1px solid var(--ember-border);
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  width: 64px;
}

/* Logo 区域 */
.logo-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--ember-border);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.logo-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.logo-text {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ember-text);
  white-space: nowrap;
}

/* 菜单区域 */
.menu-section {
  flex: 1;
  padding: 12px 0;
  overflow-y: auto;
}

:deep(.n-menu) {
  background: transparent;
}

:deep(.n-menu-item) {
  margin: 4px 8px;
  border-radius: 8px;
}

:deep(.n-menu-item-content) {
  padding: 10px 16px !important;
}

/* 激活项 — 赤陶土色左侧强调条 + 暖底色 */
:deep(.n-menu-item-content--selected) {
  background: rgba(194, 65, 12, 0.08) !important;
  color: var(--ember-primary) !important;
  border-left: 3px solid var(--ember-primary);
}

:deep(.n-menu-item-content--selected .n-menu-item-content__icon) {
  color: var(--ember-primary) !important;
}

/* 悬浮 */
:deep(.n-menu-item-content:not(.n-menu-item-content--selected):hover) {
  background: var(--ember-surface-hover) !important;
}

/* 折叠按钮 */
.collapse-btn {
  color: var(--ember-neutral);
}

.collapse-btn:hover {
  color: var(--ember-text);
}
</style>
