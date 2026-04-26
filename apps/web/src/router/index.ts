import { createRouter, createWebHistory } from 'vue-router'

const routes: any[] = [
  { path: '/', redirect: '/backtest' },
  {
    path: '/backtest',
    name: 'backtest',
    component: () => import('../views/BacktestView.vue'),
    meta: { title: '回测' },
  },
  {
    path: '/symbols',
    name: 'symbols',
    component: () => import('../views/SymbolsView.vue'),
    meta: { title: '标的' },
  },
  {
    path: '/sync',
    name: 'sync',
    component: () => import('../views/SyncView.vue'),
    meta: { title: '同步' },
  },
  {
    path: '/watchlists',
    name: 'watchlists',
    component: () => import('../views/WatchlistsView.vue'),
    meta: { title: '自选列表' },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('../views/ToolsView.vue'),
    meta: { title: '工具' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '设置' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title as string} - CryptoTrading` : 'CryptoTrading'
})

export default router
