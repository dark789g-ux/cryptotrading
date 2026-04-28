import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const routes: any[] = [
  { path: '/', redirect: '/backtest' },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { title: '登录', authPage: true, public: true },
  },
  {
    path: '/bootstrap',
    name: 'bootstrap',
    component: () => import('../views/BootstrapView.vue'),
    meta: { title: '初始化管理员', authPage: true, public: true },
  },
  {
    path: '/invitations/:token',
    name: 'invitation-accept',
    component: () => import('../views/InvitationAcceptView.vue'),
    meta: { title: '接受邀请', authPage: true, public: true },
  },
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
    meta: { title: '同步', adminOnly: true },
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

router.beforeEach(async (to) => {
  const auth = useAuth()
  await auth.ensureLoaded()

  if (auth.bootstrapRequired.value && to.name !== 'bootstrap') {
    return { name: 'bootstrap' }
  }

  if (!auth.bootstrapRequired.value && to.name === 'bootstrap') {
    return auth.user.value ? { name: 'backtest' } : { name: 'login' }
  }

  if (to.name === 'login' && auth.user.value) {
    const redirect = to.query.redirect
    return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : { name: 'backtest' }
  }

  if (!to.meta.public && !auth.user.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.meta.adminOnly && !auth.isAdmin.value) {
    return { name: 'backtest' }
  }

  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title as string} - CryptoTrading` : 'CryptoTrading'
})

export default router
