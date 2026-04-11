import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    redirect: '/backtest'
  },
  {
    path: '/backtest',
    name: 'backtest',
    component: () => import('../views/BacktestView.vue'),
    meta: { title: '回测' }
  },
  {
    path: '/symbols',
    name: 'symbols',
    component: () => import('../views/SymbolsView.vue'),
    meta: { title: '标的' }
  },
  {
    path: '/sync',
    name: 'sync',
    component: () => import('../views/SyncView.vue'),
    meta: { title: '同步' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - CryptoTrading` : 'CryptoTrading'
})

export default router
