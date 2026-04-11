import { createRouter, createWebHistory } from 'vue-router'
import StockList from '@/views/StockList.vue'
import StockDetail from '@/views/StockDetail.vue'
import Watchlists from '@/views/Watchlists.vue'
import Backtest from '@/views/Backtest.vue'

const routes = [
  { path: '/', name: 'StockList', component: StockList },
  { path: '/stock/:tsCode', name: 'StockDetail', component: StockDetail },
  { path: '/watchlists', name: 'Watchlists', component: Watchlists },
  { path: '/backtest', name: 'Backtest', component: Backtest },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
