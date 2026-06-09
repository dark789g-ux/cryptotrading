<template>
  <div class="sidebar" :class="{ collapsed: isCollapsed }">
    <div class="logo-section">
      <div class="logo">
        <div class="logo-icon-wrap">
          <img class="logo-icon" :src="logoUrl" alt="logo" />
        </div>
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
        :expanded-keys="expandedKeys"
        @update:value="handleMenuSelect"
        @update:expanded-keys="handleExpandedKeysChange"
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
        <div class="user-card">
          <div class="user-meta">
            <div class="user-avatar-wrap">
              <n-icon><person-circle-outline /></n-icon>
            </div>
            <div class="user-text">
              <div class="user-name">{{ auth.user.value?.displayName || auth.user.value?.email }}</div>
              <div class="user-role">{{ auth.isAdmin.value ? '管理员' : '普通用户' }}</div>
            </div>
          </div>
          <n-button quaternary size="small" class="logout-btn" @click="logout">
            <template #icon><n-icon><log-out-outline /></n-icon></template>
            退出登录
          </n-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NButton, NIcon, NTooltip } from 'naive-ui'
import {
  ChevronBack, ChevronForward,
  TrendingUpOutline, ListOutline, SyncOutline, BookmarkOutline, SettingsOutline, CalculatorOutline,
  LogOutOutline, PersonCircleOutline, AnalyticsOutline, SwapHorizontalOutline, NewspaperOutline,
  StatsChartOutline, BarChartOutline,
} from '@vicons/ionicons5'
import { useSidebarCollapsed } from '../../composables/hooks/useSidebarCollapsed'
import { useAuth } from '../../composables/hooks/useAuth'
import logoUrl from '@/assets/favicon.svg?url'

const route = useRoute()
const router = useRouter()

const { isCollapsed, toggle: toggleCollapse } = useSidebarCollapsed()
const auth = useAuth()

const activeKey = computed(() => {
  const name = route.name as string
  if (name?.startsWith('daily-review')) return 'daily-review'
  // quant 子菜单：jobs / run-detail 命中各自菜单项，其余落总览
  if (name === 'quant-jobs') return 'quant-jobs'
  if (name === 'quant-runs' || name === 'quant-run-detail') return 'quant-runs'
  if (name === 'quant-scores') return 'quant-scores'
  if (name === 'quant-factors') return 'quant-factors'
  if (name === 'quant-labels') return 'quant-labels'
  if (name === 'quant-strategies') return 'quant-strategies'
  if (name === 'quant-kelly-sweep') return 'quant-kelly-sweep'
  if (name?.startsWith('quant')) return 'quant-overview'
  return name
})

const renderIcon = (icon: unknown) => () => h(NIcon, null, { default: () => h(icon as never) })

const menuOptions = computed(() => [
  { label: '策略回测', key: 'backtest', icon: renderIcon(TrendingUpOutline) },
  { label: '标的筛选', key: 'symbols', icon: renderIcon(ListOutline) },
  ...(auth.isAdmin.value ? [{ label: '数据同步', key: 'sync', icon: renderIcon(SyncOutline) }] : []),
  { label: '自选列表', key: 'watchlists', icon: renderIcon(BookmarkOutline) },
  { label: '策略条件', key: 'strategy-conditions', icon: renderIcon(AnalyticsOutline) },
  { label: '信号前向统计', key: 'signal-stats', icon: renderIcon(BarChartOutline) },
  { label: '资金流向', key: 'money-flow', icon: renderIcon(SwapHorizontalOutline) },
  { label: '每日复盘', key: 'daily-review', icon: renderIcon(NewspaperOutline) },
  // factor-registry-frontend spec：/quant/* 整树 admin-only，菜单同步隐藏
  ...(auth.isAdmin.value
    ? [
        {
          label: '量化',
          key: 'quant',
          icon: renderIcon(StatsChartOutline),
          children: [
            { label: '总览', key: 'quant-overview' },
            { label: '评分', key: 'quant-scores' },
            { label: '训练 Run', key: 'quant-runs' },
            { label: '作业队列', key: 'quant-jobs' },
            { label: '因子清单', key: 'quant-factors' },
            { label: '标签库', key: 'quant-labels' },
            { label: '策略管理', key: 'quant-strategies' },
            { label: '凯利网格搜索', key: 'quant-kelly-sweep' },
          ],
        },
      ]
    : []),
  { label: '工具', key: 'tools', icon: renderIcon(CalculatorOutline) },
  { label: '系统设置', key: 'settings', icon: renderIcon(SettingsOutline) },
])

const handleMenuSelect = (key: string) => {
  if (key === 'sync' && !auth.isAdmin.value) return
  router.push({ name: key })
}

const QUANT_CHILD_KEYS = [
  'quant-overview',
  'quant-scores',
  'quant-runs',
  'quant-jobs',
  'quant-run-detail',
  'quant-factors',
  'quant-labels',
  'quant-strategies',
  'quant-kelly-sweep',
]

const expandedKeys = ref<string[]>([])

watch(
  () => route.name,
  (name) => {
    if (typeof name === 'string' && QUANT_CHILD_KEYS.includes(name) && !expandedKeys.value.includes('quant')) {
      expandedKeys.value = [...expandedKeys.value, 'quant']
    }
  },
  { immediate: true },
)

const handleExpandedKeysChange = (keys: string[]) => {
  expandedKeys.value = keys
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
  z-index: 10;
  background: linear-gradient(180deg, #1a1c22 0%, #1e2028 60%, #1c1e26 100%);
  border-right: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);
  box-shadow:
    4px 0 24px color-mix(in srgb, var(--color-black) 30%, transparent),
    inset -1px 0 0 color-mix(in srgb, var(--color-border) 20%, transparent);
  transition: width 0.26s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 180px;
  background: radial-gradient(ellipse 120% 100% at 20% -10%,
    color-mix(in srgb, var(--color-primary) 8%, transparent) 0%,
    transparent 70%);
  pointer-events: none;
  z-index: 0;
}

.sidebar.collapsed {
  width: 64px;
}

/* ===== Logo 区域 ===== */
.logo-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 14px 17px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 35%, transparent);
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  min-width: 0;
}

.logo-icon-wrap {
  position: relative;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-icon-wrap::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  filter: blur(6px);
}

.logo-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 7px;
  position: relative;
  z-index: 1;
}

.logo-text {
  font-family: 'SF Pro Display', 'Helvetica Neue', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--color-text-on-dark);
  white-space: nowrap;
  opacity: 1;
  transition: opacity 0.2s ease, width 0.26s ease;
}

.logo-text.hidden {
  opacity: 0;
  pointer-events: none;
  width: 0;
}

/* ===== 菜单区域 ===== */
.menu-section {
  flex: 1;
  padding: 10px 0 12px;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  z-index: 1;
  scrollbar-width: none;
}

.menu-section::-webkit-scrollbar {
  display: none;
}

/* ===== 用户区域 ===== */
.user-section {
  padding: 10px 10px 14px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 35%, transparent);
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

.user-section.collapsed {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 12px 0;
}

.user-card {
  background: color-mix(in srgb, var(--color-border) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
  border-radius: 12px;
  padding: 10px 12px 8px;
}

.user-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin-bottom: 8px;
}

.user-avatar-wrap {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--color-primary) 30%, #2b2f36),
    color-mix(in srgb, var(--color-primary) 10%, #2b2f36));
  border: 1.5px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  font-size: 18px;
}

.user-text {
  min-width: 0;
  flex: 1;
}

.user-name {
  overflow: hidden;
  color: var(--color-text-on-dark);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.user-role {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 400;
  margin-top: 1px;
  letter-spacing: 0.01em;
}

.logout-btn {
  width: 100%;
  color: var(--color-text-muted) !important;
  border-radius: 8px !important;
  font-size: 12px !important;
  transition: color 0.18s ease !important;
}

.logout-btn:hover {
  color: var(--color-text-on-dark) !important;
  background: color-mix(in srgb, var(--color-error) 12%, transparent) !important;
}

.user-icon-btn {
  color: var(--color-text-muted);
  transition: color 0.18s ease;
}

.user-icon-btn:hover {
  color: var(--color-text-on-dark);
}

/* ===== 折叠按钮 ===== */
.collapse-btn {
  color: var(--color-text-muted);
  flex-shrink: 0;
  transition: color 0.18s ease, background 0.18s ease;
}

.collapse-btn:hover {
  color: var(--color-text-on-dark);
  background: color-mix(in srgb, var(--color-border) 40%, transparent) !important;
}

/* ===== n-menu 深度覆盖 ===== */
:deep(.n-menu) {
  background: transparent;
}

:deep(.n-menu-item) {
  margin: 2px 8px;
  border-radius: 10px;
  transition: all 0.18s ease;
}

:deep(.n-menu-item-content) {
  padding: 10px 14px !important;
  border-radius: 10px !important;
  transition: background 0.18s ease !important;
}

:deep(.n-menu-item-content:not(.n-menu-item-content--selected):hover) {
  background: color-mix(in srgb, var(--color-border) 50%, transparent) !important;
}

:deep(.n-menu-item-content--selected::before) {
  background-color: transparent !important;
}

:deep(.n-menu-item-content--selected) {
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--color-primary) 16%, transparent),
    color-mix(in srgb, var(--color-primary) 6%, transparent)
  ) !important;
  border-left: none !important;
  box-shadow:
    inset 2.5px 0 0 var(--color-primary),
    0 2px 12px color-mix(in srgb, var(--color-primary) 12%, transparent) !important;
}

:deep(.n-menu-item-content--selected .n-menu-item-content__icon),
:deep(.n-menu-item-content--selected .n-menu-item-content-header) {
  color: var(--color-primary) !important;
}

:deep(.n-menu-item-content__icon) {
  transition: color 0.18s ease;
}

:deep(.n-menu .n-menu-item-group-title) {
  color: var(--color-text-muted);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-left: 22px;
}

/* ===== 子菜单（量化组）弱化样式 ===== */
:deep(.n-submenu-children) {
  position: relative;
}

:deep(.n-submenu-children::before) {
  content: '';
  position: absolute;
  left: 28px;
  top: 4px;
  bottom: 4px;
  width: 1px;
  background-color: var(--color-border);
  opacity: 0.3;
  pointer-events: none;
}

:deep(.n-submenu-children .n-menu-item) {
  height: 32px;
}

:deep(.n-submenu-children .n-menu-item-content) {
  padding: 6px 14px 6px 44px !important;
  font-size: 13px;
  color: var(--color-text-muted) !important;
}

:deep(.n-submenu-children .n-menu-item-content:hover) {
  color: var(--color-text-on-dark) !important;
}

:deep(.n-submenu-children .n-menu-item-content--selected),
:deep(.n-submenu-children .n-menu-item-content--selected:hover) {
  color: var(--color-primary) !important;
}

:deep(.n-submenu-children .n-menu-item-content .n-menu-item-content-header) {
  color: inherit !important;
}
</style>
