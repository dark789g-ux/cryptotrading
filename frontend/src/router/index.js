import { createRouter, createWebHistory } from 'vue-router'
import SymbolsView from '../views/SymbolsView.vue'
import BacktestView from '../views/BacktestView.vue'
import SyncView from '../views/SyncView.vue'

const routes = [
  { path: '/', redirect: '/symbols' },
  { path: '/symbols', component: SymbolsView, meta: { title: '标的展示' } },
  { path: '/backtest', component: BacktestView, meta: { title: '历史回测' } },
  { path: '/sync', component: SyncView, meta: { title: '数据同步' } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - CryptoTrading` : 'CryptoTrading'
})

export default router
