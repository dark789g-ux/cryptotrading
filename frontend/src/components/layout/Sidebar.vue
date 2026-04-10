<template>
  <aside class="sidebar" :class="{ collapsed }">
    <!-- 折叠按钮 -->
    <button class="sidebar-toggle" @click="$emit('toggle')" :title="collapsed ? '展开' : '收起'">
      <ChevronLeft v-if="!collapsed" :size="18" />
      <ChevronRight v-else :size="18" />
    </button>

    <!-- Logo 区 -->
    <div class="sidebar-logo">
      <TrendingUp :size="22" class="logo-icon" />
      <span v-if="!collapsed" class="logo-text">CryptoTrading</span>
    </div>

    <!-- 导航菜单 -->
    <nav class="sidebar-nav">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :title="collapsed ? item.label : ''"
      >
        <component :is="item.icon" :size="20" class="nav-icon" />
        <span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>
  </aside>
</template>

<script setup>
import { RouterLink } from 'vue-router'
import { ChevronLeft, ChevronRight, BarChart2, History, RefreshCw, TrendingUp } from 'lucide-vue-next'

defineProps({ collapsed: Boolean })
defineEmits(['toggle'])

const navItems = [
  { to: '/symbols',  label: '标的展示', icon: BarChart2 },
  { to: '/backtest', label: '历史回测', icon: History },
  { to: '/sync',     label: '数据同步', icon: RefreshCw },
]
</script>

<style scoped>
.sidebar {
  position: fixed; top: 0; left: 0; bottom: 0;
  width: var(--sidebar-width);
  background: var(--color-sidebar-bg);
  display: flex; flex-direction: column;
  transition: width var(--transition);
  z-index: 100; overflow: hidden;
}
.sidebar.collapsed { width: var(--sidebar-collapsed-width); }

/* 折叠按钮 */
.sidebar-toggle {
  position: absolute; top: 14px; right: -12px;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--color-primary); border: none;
  color: #fff; cursor: pointer; display: flex;
  align-items: center; justify-content: center;
  box-shadow: 0 2px 6px rgba(0,0,0,.25);
  z-index: 1; transition: background var(--transition);
}
.sidebar-toggle:hover { background: var(--color-primary-dark); }

/* Logo */
.sidebar-logo {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 16px 14px;
  border-bottom: 1px solid rgba(255,255,255,.08);
  color: #fff; min-height: 60px;
}
.logo-icon { flex-shrink: 0; color: var(--color-primary); }
.logo-text { font-size: 1rem; font-weight: 700; white-space: nowrap; }

/* 导航 */
.sidebar-nav { display: flex; flex-direction: column; padding: 10px 0; flex: 1; }

.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 16px; color: rgba(255,255,255,.65);
  text-decoration: none; white-space: nowrap;
  transition: background var(--transition), color var(--transition);
  border-left: 3px solid transparent;
}
.nav-item:hover {
  background: var(--color-sidebar-hover);
  color: #fff;
}
.nav-item.router-link-active {
  background: rgba(52,152,219,.18);
  color: #fff;
  border-left-color: var(--color-primary);
}
.nav-icon { flex-shrink: 0; }
.nav-label { font-size: .9rem; }

.sidebar.collapsed .nav-item {
  justify-content: center; padding: 11px 0;
}
</style>
