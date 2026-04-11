<template>
  <div 
    class="sidebar glass-sidebar"
    :class="{ collapsed: isCollapsed }"
  >
    <!-- Logo 区域 -->
    <div class="logo-section">
      <div class="logo">
        <span class="logo-icon">📊</span>
        <span v-show="!isCollapsed" class="logo-text">CryptoTrading</span>
      </div>
      <n-button 
        quaternary 
        circle 
        class="collapse-btn"
        @click="toggleCollapse"
      >
        <template #icon>
          <n-icon>
            <chevron-back v-if="!isCollapsed" />
            <chevron-forward v-else />
          </n-icon>
        </template>
      </n-button>
    </div>

    <!-- 导航菜单 -->
    <div class="menu-section">
      <n-menu
        :collapsed="isCollapsed"
        :collapsed-width="64"
        :options="menuOptions"
        :value="activeKey"
        @update:value="handleMenuSelect"
      />
    </div>

    <!-- 底部操作区 -->
    <div class="bottom-section">
      <n-tooltip placement="right" :disabled="!isCollapsed">
        <template #trigger>
          <n-button 
            quaternary 
            class="theme-toggle"
            @click="toggleTheme"
          >
            <template #icon>
              <n-icon size="20">
                <moon v-if="isDark" />
                <sunny v-else />
              </n-icon>
            </template>
            <span v-show="!isCollapsed" class="btn-text">
              {{ isDark ? '深色模式' : '浅色模式' }}
            </span>
          </n-button>
        </template>
        {{ isDark ? '切换到浅色' : '切换到深色' }}
      </n-tooltip>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NButton, NIcon, NTooltip } from 'naive-ui'
import { 
  ChevronBack, 
  ChevronForward, 
  Moon, 
  Sunny,
  TrendingUpOutline,
  ListOutline,
  SyncOutline
} from '@vicons/ionicons5'
import { useTheme } from '../../composables/useTheme.js'

const route = useRoute()
const router = useRouter()
const { isDark, toggleTheme } = useTheme()

// 侧边栏折叠状态
const isCollapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  localStorage.setItem('sidebar-collapsed', isCollapsed.value)
}

// 当前激活的菜单
const activeKey = computed(() => route.name)

// 渲染图标
const renderIcon = (icon) => {
  return () => h(NIcon, null, { default: () => h(icon) })
}

// 菜单配置
const menuOptions = [
  {
    label: '回测',
    key: 'backtest',
    icon: renderIcon(TrendingUpOutline)
  },
  {
    label: '标的',
    key: 'symbols',
    icon: renderIcon(ListOutline)
  },
  {
    label: '同步',
    key: 'sync',
    icon: renderIcon(SyncOutline)
  }
]

const handleMenuSelect = (key) => {
  router.push({ name: key })
}
</script>

<style scoped>
.sidebar {
  height: 100vh;
  width: 220px;
  display: flex;
  flex-direction: column;
  position: fixed;
  left: 0;
  top: 0;
  z-index: 100;
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  width: 64px;
}

.logo-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--glass-border);
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
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.collapse-btn {
  flex-shrink: 0;
}

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
  border-radius: 10px;
}

:deep(.n-menu-item-content) {
  padding: 10px 16px !important;
}

:deep(.n-menu-item-content--selected) {
  background: var(--accent-gradient) !important;
  color: white !important;
}

:deep(.n-menu-item-content--selected .n-menu-item-content__icon) {
  color: white !important;
}

:deep(.n-menu-item-content:not(.n-menu-item-content--selected):hover) {
  background: var(--bg-hover) !important;
}

.bottom-section {
  padding: 12px;
  border-top: 1px solid var(--glass-border);
}

.theme-toggle {
  width: 100%;
  justify-content: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--text-secondary);
}

.theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-text {
  font-size: 14px;
}
</style>
