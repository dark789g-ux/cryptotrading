import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '../composables/hooks/useAuth'

const routes: any[] = [
  { path: '/', redirect: '/backtest' },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { title: '登录', authPage: true, public: true },
  },
  {
    path: '/bootstrap',
    name: 'bootstrap',
    component: () => import('../views/auth/BootstrapView.vue'),
    meta: { title: '初始化管理员', authPage: true, public: true },
  },
  {
    path: '/invitations/:token',
    name: 'invitation-accept',
    component: () => import('../views/auth/InvitationAcceptView.vue'),
    meta: { title: '接受邀请', authPage: true, public: true },
  },
  {
    path: '/backtest',
    name: 'backtest',
    component: () => import('../views/strategy/BacktestView.vue'),
    meta: { title: '回测' },
  },
  {
    path: '/symbols',
    name: 'symbols',
    component: () => import('../views/market/SymbolsView.vue'),
    meta: { title: '标的' },
  },
  {
    path: '/sync',
    name: 'sync',
    component: () => import('../views/sync/SyncView.vue'),
    meta: { title: '同步', adminOnly: true },
  },
  {
    path: '/watchlists',
    name: 'watchlists',
    component: () => import('../views/market/WatchlistsView.vue'),
    meta: { title: '自选列表' },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('../views/system/ToolsView.vue'),
    meta: { title: '工具' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/system/SettingsView.vue'),
    meta: { title: '设置' },
  },
  {
    path: '/strategy-conditions',
    name: 'strategy-conditions',
    component: () => import('../views/strategy/StrategyConditionsView.vue'),
    meta: { title: '策略条件' },
  },
  {
    path: '/money-flow',
    name: 'money-flow',
    component: () => import('../views/market/MoneyFlowView.vue'),
    meta: { title: '资金流向' },
  },
  {
    path: '/daily-review',
    name: 'daily-review',
    component: () => import('../views/strategy/DailyReviewView.vue'),
    meta: { title: '每日复盘' },
  },
  {
    path: '/daily-review/:tradeDate',
    name: 'daily-review-detail',
    component: () => import('../views/strategy/DailyReviewDetailView.vue'),
    meta: { title: '复盘详情' },
  },
  {
    path: '/quant',
    name: 'quant-overview',
    component: () => import('../views/quant/QuantOverviewView.vue'),
    meta: { title: '量化总览', requireAdmin: true },
  },
  {
    path: '/quant/scores',
    name: 'quant-scores',
    component: () => import('../views/quant/QuantScoresView.vue'),
    meta: { title: '量化评分', requireAdmin: true },
  },
  {
    path: '/quant/runs',
    name: 'quant-runs',
    component: () => import('../views/quant/QuantRunsView.vue'),
    meta: { title: '量化训练 Run', requireAdmin: true },
  },
  {
    path: '/quant/runs/:id',
    name: 'quant-run-detail',
    component: () => import('../views/quant/QuantRunDetailView.vue'),
    meta: { title: '量化训练 Run 详情', requireAdmin: true },
  },
  {
    path: '/quant/jobs',
    name: 'quant-jobs',
    component: () => import('../views/quant/QuantJobsView.vue'),
    meta: { title: '量化作业队列', requireAdmin: true },
  },
  {
    // 占位：M4 后续里程碑落实 quality 详情页；当前 Overview 告警条 link 兜底落 Overview
    path: '/quant/quality/:date',
    name: 'quant-quality-detail',
    component: () => import('../views/quant/QuantOverviewView.vue'),
    meta: { title: '量化数据质量详情', requireAdmin: true },
  },
  {
    // factor-registry-frontend spec：因子清单（admin-only）
    path: '/quant/factors',
    name: 'quant-factors',
    component: () => import('../views/quant/QuantFactorsView.vue'),
    meta: { title: '量化因子清单', requireAdmin: true },
  },
  {
    // quant-label-management spec：标签库（admin-only，继承 /quant/* 守卫）
    path: '/quant/labels',
    name: 'quant-labels',
    component: () => import('../views/quant/QuantLabelsView.vue'),
    meta: { title: '量化标签库', requireAdmin: true },
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

  // factor-registry-frontend spec：`/quant/*` 整树受 requireAdmin 守卫
  // 非 admin 一律回首页（本 spec 不新建 ForbiddenView，YAGNI）
  if (to.meta.requireAdmin && !auth.isAdmin.value) {
    return { path: '/' }
  }

  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title as string} - CryptoTrading` : 'CryptoTrading'
})

export default router
