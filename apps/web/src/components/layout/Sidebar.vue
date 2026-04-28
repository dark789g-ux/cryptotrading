<template>
  <div class="sidebar" :class="{ collapsed: isCollapsed }">
    <div class="logo-section">
      <div class="logo">
        <img class="logo-icon" :src="logoUrl" alt="logo" />
        <span class="logo-text" :class="{ hidden: isCollapsed }">CryptoTrading</span>
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

    <div class="user-section" :class="{ collapsed: isCollapsed }">
      <n-tooltip v-if="isCollapsed" placement="right">
        <template #trigger>
          <n-button quaternary circle class="user-icon-btn" @click="logout">
            <template #icon><n-icon><log-out-outline /></n-icon></template>
          </n-button>
        </template>
        退出登录
      </n-tooltip>
      <template v-else>
        <div class="user-meta">
          <n-icon class="user-avatar"><person-circle-outline /></n-icon>
          <div class="user-text">
            <div class="user-name">{{ auth.user.value?.displayName || auth.user.value?.email }}</div>
            <div class="user-role">{{ auth.isAdmin.value ? '管理员' : '普通用户' }}</div>
          </div>
        </div>
        <n-button quaternary size="small" class="logout-btn" @click="logout">
          <template #icon><n-icon><log-out-outline /></n-icon></template>
          退出
        </n-button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NButton, NIcon, NTooltip } from 'naive-ui'
import {
  ChevronBack, ChevronForward,
  TrendingUpOutline, ListOutline, SyncOutline, BookmarkOutline, SettingsOutline, CalculatorOutline,
  LogOutOutline, PersonCircleOutline,
} from '@vicons/ionicons5'
import { useSidebarCollapsed } from '../../composables/useSidebarCollapsed'
import { useAuth } from '../../composables/useAuth'
import logoUrl from '@/assets/favicon.svg?url'

const route = useRoute()
const router = useRouter()

const { isCollapsed, toggle: toggleCollapse } = useSidebarCollapsed()
const auth = useAuth()

const activeKey = computed(() => route.name as string)

const renderIcon = (icon: unknown) => () => h(NIcon, null, { default: () => h(icon as never) })

const menuOptions = computed(() => [
  { label: '策略回测', key: 'backtest', icon: renderIcon(TrendingUpOutline) },
  { label: '标的筛选', key: 'symbols', icon: renderIcon(ListOutline) },
  ...(auth.isAdmin.value ? [{ label: '数据同步', key: 'sync', icon: renderIcon(SyncOutline) }] : []),
  { label: '自选列表', key: 'watchlists', icon: renderIcon(BookmarkOutline) },
  { label: '工具', key: 'tools', icon: renderIcon(CalculatorOutline) },
  { label: '系统设置', key: 'settings', icon: renderIcon(SettingsOutline) },
])

const handleMenuSelect = (key: string) => {
  if (key === 'sync' && !auth.isAdmin.value) return
  router.push({ name: key })
}

const logout = async () => {
  await auth.logout()
  router.replace({ name: 'login' })
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
  z-index: 1;
  background: var(--color-surface-dark);
  border-right: 1px solid color-mix(in srgb, var(--color-border) 62%, transparent);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--color-black) 14%, transparent);
  transition: width 0.24s ease;
}

.sidebar.collapsed {
  width: 64px;
}

.logo-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 16px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 56%, transparent);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.logo-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 6px;
}

.logo-text {
  font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--color-text-on-dark);
  white-space: nowrap;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.logo-text.hidden {
  opacity: 0;
  pointer-events: none;
}

.menu-section {
  flex: 1;
  padding: 14px 0 18px;
  overflow-y: auto;
}

.user-section {
  padding: 14px 12px 16px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 56%, transparent);
}

.user-section.collapsed {
  display: flex;
  justify-content: center;
  padding-inline: 0;
}

.user-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin-bottom: 10px;
}

.user-avatar {
  flex-shrink: 0;
  color: var(--color-primary);
  font-size: 28px;
}

.user-text {
  min-width: 0;
}

.user-name {
  overflow: hidden;
  color: var(--color-text-on-dark);
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-role {
  color: var(--color-text-muted);
  font-size: 12px;
}

.logout-btn {
  width: 100%;
  color: var(--color-text-on-dark);
}

.user-icon-btn {
  color: var(--color-text-on-dark);
}

:deep(.n-menu) {
  background: transparent;
}

:deep(.n-menu-item) {
  margin: 4px 10px;
  border-radius: 10px;
}

:deep(.n-menu-item-content) {
  padding: 10px 16px !important;
}

:deep(.n-menu-item-content--selected) {
  border-left: 3px solid var(--color-primary);
}

.collapse-btn {
  color: var(--color-text-muted);
}

.collapse-btn:hover {
  color: var(--color-text-on-dark);
}
</style>
